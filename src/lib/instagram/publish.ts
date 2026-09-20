import { and, eq, gte, inArray } from "drizzle-orm";
import { recordAudit, systemActor } from "@/lib/audit";
import {
  getDb,
  igAccount,
  post,
  publishAttempt,
  slide,
  type IgAccount,
  type Post,
} from "@/lib/db";
import { isPubliclyFetchable } from "@/lib/storage";
import { InstagramApiError, fetchPublishingLimit, graphGet, graphPost } from "./client";
import { decryptToken } from "./tokens";

/**
 * The publish flow, run as ONE job at fire time:
 *
 *   per slide  POST /{ig-user-id}/media   image_url=… is_carousel_item=true
 *   per slide  GET  /{child-id}?fields=status_code   until FINISHED
 *   parent     POST /{ig-user-id}/media   media_type=CAROUSEL children=…
 *   parent     GET  /{parent-id}?fields=status_code  until FINISHED
 *   publish    POST /{ig-user-id}/media_publish  creation_id=…
 *
 * Creating a container only registers the request: Instagram then fetches the
 * image, and until it has, the container is IN_PROGRESS. Publishing one that
 * has not reached FINISHED fails with 9007 / 2207027, "The media is not ready
 * for publishing" — so every container is polled, children included. A parent
 * can report FINISHED while a child is still downloading, which is why polling
 * only the container being published is not enough.
 *
 * A one-slide post is not a carousel of one — Instagram rejects that — so it
 * skips the children and publishes a single image container directly.
 *
 * Containers expire after 24 hours, so none of this happens at approval time.
 */

/** A post is one image, or a carousel of 2–10. There is nothing in between. */
export const MIN_MEDIA_ITEMS = 1;
export const MIN_CAROUSEL_ITEMS = 2;
export const MAX_CAROUSEL_ITEMS = 10;
export const MAX_CAPTION_CHARS = 2200;
export const MAX_ALT_TEXT_CHARS = 1000;
/** 100 published posts per rolling 24h per account. A carousel counts as one. */
export const DAILY_PUBLISH_LIMIT = 100;

/** Meta's own guidance for container polling: once a minute, up to five. */
const POLL_INTERVAL_MS = 60_000;
const POLL_MAX_ATTEMPTS = 5;

/**
 * Wall-clock budget for one publish, containers and all.
 *
 * Ten containers at five minutes each is fifty minutes, which is longer than
 * the job's own lifetime: the platform would kill the function mid-poll and
 * leave the post parked in `publishing` until the sweep found it. The flow
 * gives up on its own terms first, so the post lands in `failed` with a reason
 * a person can act on. It has to stay comfortably under both the publish
 * route's maxDuration and the sweep's STUCK_PUBLISHING_MS.
 */
export const PUBLISH_BUDGET_MS = 8 * 60 * 1000;

/**
 * The budget for a publish a person is waiting on — Post now, or Retry.
 *
 * Those run inside a server action, which the platform kills at a timeout we
 * do not control, and a kill is what parks a post in `publishing`. So an
 * interactive publish checks every container once and, if Instagram is still
 * processing, hands the post to the background job rather than holding the
 * request open for minutes.
 */
export const INTERACTIVE_PUBLISH_BUDGET_MS = 50 * 1000;

export class PublishError extends Error {
  readonly verbatim: string;
  /**
   * The containers were still processing when we ran out of time. Nothing was
   * published and nothing is wrong with the post — the same publish, tried
   * again, is expected to work.
   */
  readonly stillProcessing: boolean;
  constructor(
    message: string,
    verbatim?: string,
    options: { stillProcessing?: boolean } = {},
  ) {
    super(message);
    this.name = "PublishError";
    this.verbatim = verbatim ?? message;
    this.stillProcessing = options.stillProcessing ?? false;
  }
}

export interface PublishResult {
  mediaId: string;
  permalink?: string;
  containerIds: string[];
}

interface Sleep {
  (ms: number): Promise<void>;
}

const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Everything that must be true before we touch the API. Checked up front so a
 * bad post fails loudly here instead of half-way through container creation.
 */
export function assertPublishable(input: {
  post: Pick<Post, "status" | "caption" | "approvedBy">;
  slides: { position: number; renderedUrl: string | null; altText: string; width: number; height: number }[];
}): void {
  if (!input.post.approvedBy) {
    throw new PublishError(
      "This post has never been approved by a person. Publishing is blocked.",
    );
  }
  const count = input.slides.length;
  if (count < MIN_MEDIA_ITEMS || count > MAX_CAROUSEL_ITEMS) {
    throw new PublishError(
      `A post needs one slide, or between ${MIN_CAROUSEL_ITEMS} and ${MAX_CAROUSEL_ITEMS} for a carousel; this post has ${count}.`,
    );
  }
  if (input.post.caption.length > MAX_CAPTION_CHARS) {
    throw new PublishError(
      `The caption is ${input.post.caption.length} characters; Instagram's limit is ${MAX_CAPTION_CHARS}.`,
    );
  }

  const dimensions = new Set<string>();
  for (const s of input.slides) {
    if (!s.renderedUrl) {
      throw new PublishError(`Slide ${s.position} has not been rendered.`);
    }
    if (!isPubliclyFetchable(s.renderedUrl)) {
      throw new PublishError(
        `Slide ${s.position} is at ${s.renderedUrl}, which Instagram cannot fetch. Slide URLs must be public https URLs.`,
      );
    }
    if (s.altText.length > MAX_ALT_TEXT_CHARS) {
      throw new PublishError(
        `Slide ${s.position} alt text is ${s.altText.length} characters; the limit is ${MAX_ALT_TEXT_CHARS}.`,
      );
    }
    dimensions.add(`${s.width}x${s.height}`);
  }
  if (dimensions.size > 1) {
    throw new PublishError(
      `Slides have differing dimensions (${[...dimensions].join(", ")}). Instagram crops every slide to the first one's aspect ratio.`,
    );
  }
}

export async function publishCount24h(igAccountId: string): Promise<number> {
  const db = await getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(publishAttempt)
    .where(
      and(
        eq(publishAttempt.igAccountId, igAccountId),
        eq(publishAttempt.succeeded, "true"),
        gte(publishAttempt.createdAt, since),
      ),
    );
  return rows.length;
}

/** Remaining quota, preferring Meta's own number when the API answers. */
export async function remainingQuota(account: IgAccount): Promise<{
  used: number;
  total: number;
  source: "meta" | "local";
}> {
  try {
    const limit = await fetchPublishingLimit({
      igUserId: account.igUserId,
      accessToken: decryptToken(account),
    });
    if (typeof limit.quota_usage === "number") {
      return {
        used: limit.quota_usage,
        total: limit.config?.quota_total ?? DAILY_PUBLISH_LIMIT,
        source: "meta",
      };
    }
  } catch {
    // Fall through to the local count — this is a display value, not a gate.
  }
  return {
    used: await publishCount24h(account.id),
    total: DAILY_PUBLISH_LIMIT,
    source: "local",
  };
}

export interface PublishInput {
  post: Post;
  account: IgAccount;
  slides: {
    position: number;
    renderedUrl: string | null;
    altText: string;
    width: number;
    height: number;
  }[];
  sleep?: Sleep;
  /** Wall-clock budget for the whole flow. Defaults to PUBLISH_BUDGET_MS. */
  budgetMs?: number;
  /** The clock the budget is measured on. Injectable so tests need not wait. */
  now?: () => number;
}

/**
 * Milliseconds left of the budget. Every wait in the flow asks this before it
 * sleeps, so one slow container cannot spend the time the rest of the post
 * needs.
 */
function budgetFrom(input: {
  budgetMs?: number;
  now?: () => number;
}): () => number {
  const clock = input.now ?? Date.now;
  const end = clock() + (input.budgetMs ?? PUBLISH_BUDGET_MS);
  return () => end - clock();
}

export async function publishMedia(
  input: PublishInput,
): Promise<PublishResult> {
  const sleep = input.sleep ?? defaultSleep;
  const ordered = [...input.slides].sort((a, b) => a.position - b.position);
  assertPublishable({ post: input.post, slides: ordered });

  const used = await publishCount24h(input.account.id);
  if (used >= DAILY_PUBLISH_LIMIT) {
    throw new PublishError(
      `@${input.account.username} has published ${used} times in the last 24 hours; Instagram's limit is ${DAILY_PUBLISH_LIMIT}.`,
    );
  }

  const accessToken = decryptToken(input.account);
  const igUserId = input.account.igUserId;
  const containerIds: string[] = [];
  const single = ordered.length === 1;
  const remaining = budgetFrom(input);
  const wait = (containerId: string, label: string) =>
    waitForContainer({ containerId, accessToken, sleep, remaining, label });

  try {
    if (single) {
      // A single image carries the caption and alt text itself: there is no
      // parent to hang them on.
      const only = ordered[0];
      const container = await graphPost<{ id: string }>(`${igUserId}/media`, {
        image_url: only.renderedUrl as string,
        caption: input.post.caption,
        ...(only.altText ? { alt_text: only.altText } : {}),
        access_token: accessToken,
      });
      containerIds.push(container.id);
      await wait(container.id, "The image");
    } else {
      // 1. One child container per slide.
      const childIds: string[] = [];
      for (const s of ordered) {
        const child = await graphPost<{ id: string }>(`${igUserId}/media`, {
          image_url: s.renderedUrl as string,
          is_carousel_item: "true",
          ...(s.altText ? { alt_text: s.altText } : {}),
          access_token: accessToken,
        });
        childIds.push(child.id);
        containerIds.push(child.id);
      }

      // 2. Every child has to reach FINISHED before the parent can reference
      //    it. Instagram fetches the images in parallel, so waiting on the
      //    first child is usually waiting on all of them.
      for (const [index, childId] of childIds.entries()) {
        await wait(childId, `Slide ${ordered[index].position}`);
      }

      // 3. The parent carousel container, itself polled before it is
      //    published: a parent reports FINISHED once it has been accepted,
      //    which is not the same thing as being ready to publish.
      const parent = await graphPost<{ id: string }>(`${igUserId}/media`, {
        media_type: "CAROUSEL",
        children: childIds.join(","),
        caption: input.post.caption,
        access_token: accessToken,
      });
      containerIds.push(parent.id);
      await wait(parent.id, "The carousel");
    }

    // 4. Publish the container everything else was building towards.
    const creationId = containerIds[containerIds.length - 1];
    const published = await publishContainer({
      igUserId,
      creationId,
      accessToken,
      sleep,
      remaining,
    });

    const permalink = await fetchPermalink(published.id, accessToken);
    return { mediaId: published.id, permalink, containerIds };
  } catch (error) {
    if (error instanceof InstagramApiError) {
      // "The media is not ready" survived the retry above. Nothing was
      // published and the post itself is fine, so it is worth another run.
      throw new PublishError(error.message, error.verbatim, {
        stillProcessing: error.isMediaNotReady,
      });
    }
    throw error;
  }
}

/**
 * media_publish, with one retry for the one error that is worth retrying.
 *
 * Every container was polled to FINISHED before this is called, so 9007 /
 * 2207027 should not happen — but Instagram's own view of a carousel is
 * eventually consistent, and the error means nothing was published. Re-reading
 * the container and trying once more costs a minute and turns the whole post
 * from failed into published. Any other error is the caller's to report.
 */
async function publishContainer(input: {
  igUserId: string;
  creationId: string;
  accessToken: string;
  sleep: Sleep;
  remaining: () => number;
}): Promise<{ id: string }> {
  try {
    return await graphPost<{ id: string }>(`${input.igUserId}/media_publish`, {
      creation_id: input.creationId,
      access_token: input.accessToken,
    });
  } catch (error) {
    const notReady =
      error instanceof InstagramApiError && error.isMediaNotReady;
    if (!notReady || input.remaining() <= POLL_INTERVAL_MS) throw error;

    await input.sleep(POLL_INTERVAL_MS);
    await waitForContainer({
      containerId: input.creationId,
      accessToken: input.accessToken,
      sleep: input.sleep,
      remaining: input.remaining,
      label: "The post",
    });
    return graphPost<{ id: string }>(`${input.igUserId}/media_publish`, {
      creation_id: input.creationId,
      access_token: input.accessToken,
    });
  }
}

type ContainerStatus =
  | "EXPIRED"
  | "ERROR"
  | "FINISHED"
  | "IN_PROGRESS"
  | "PUBLISHED";

export async function waitForContainer(input: {
  containerId: string;
  accessToken: string;
  sleep?: Sleep;
  maxAttempts?: number;
  /** Milliseconds left for the whole publish, when one is being tracked. */
  remaining?: () => number;
  /** What this container is, for an error a person has to act on. */
  label?: string;
}): Promise<ContainerStatus> {
  const sleep = input.sleep ?? defaultSleep;
  const maxAttempts = input.maxAttempts ?? POLL_MAX_ATTEMPTS;
  const remaining = input.remaining ?? (() => Number.POSITIVE_INFINITY);
  const what = input.label ?? "The media container";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const body = await graphGet<{
      status_code?: ContainerStatus;
      status?: string;
    }>(input.containerId, {
      fields: "status_code,status",
      access_token: input.accessToken,
    });
    const status = body.status_code ?? "IN_PROGRESS";

    if (status === "FINISHED" || status === "PUBLISHED") return status;
    if (status === "ERROR") {
      // Meta's `status` carries the reason — an unreachable image, a format it
      // rejected. It is the only description of the failure there will be.
      throw new PublishError(
        `${what} could not be processed by Instagram: ${body.status ?? "ERROR"}`,
        JSON.stringify(body),
      );
    }
    if (status === "EXPIRED") {
      throw new PublishError(
        `${what} expired before it could be published. Containers are only valid for 24 hours.`,
        JSON.stringify(body),
      );
    }
    if (attempt < maxAttempts - 1) {
      // Stop on our own terms while there is still time to record why.
      if (remaining() <= POLL_INTERVAL_MS) {
        throw new PublishError(
          `${what} was still processing when this publish ran out of time. Nothing was published.`,
          undefined,
          { stillProcessing: true },
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new PublishError(
    `${what} was still processing after ${maxAttempts} minutes. Nothing was published.`,
    undefined,
    { stillProcessing: true },
  );
}

async function fetchPermalink(
  mediaId: string,
  accessToken: string,
): Promise<string | undefined> {
  try {
    const body = await graphGet<{ permalink?: string }>(mediaId, {
      fields: "permalink",
      access_token: accessToken,
    });
    return body.permalink;
  } catch {
    return undefined;
  }
}

/**
 * Publishes a post by id and moves it through the state machine, recording
 * every step. This is what the scheduler job and the Post now button both call.
 */
export async function publishPostById(input: {
  postId: string;
  actorLabel: string;
  sleep?: Sleep;
  budgetMs?: number;
  now?: () => number;
}): Promise<{
  status: "published" | "failed";
  mediaId?: string;
  error?: string;
  /** Instagram had not finished processing. Nothing was published. */
  stillProcessing?: boolean;
}> {
  const db = await getDb();
  const [current] = await db.select().from(post).where(eq(post.id, input.postId));
  if (!current) throw new PublishError(`No post ${input.postId}.`);

  if (!current.approvedBy) {
    throw new PublishError(
      "This post has never been approved by a person. Publishing is blocked.",
    );
  }
  if (current.status === "published") {
    return { status: "published", mediaId: current.publishedMediaId ?? undefined };
  }
  if (!["approved", "scheduled", "failed"].includes(current.status)) {
    throw new PublishError(
      `A post with status "${current.status}" cannot be published.`,
    );
  }
  if (!current.igAccountId) {
    throw new PublishError("This post has no Instagram account selected.");
  }

  const [account] = await db
    .select()
    .from(igAccount)
    .where(
      and(
        eq(igAccount.id, current.igAccountId),
        eq(igAccount.tenantId, current.tenantId),
      ),
    );
  if (!account) {
    throw new PublishError(
      "The connected account no longer exists, or does not belong to this tenant.",
    );
  }

  const slides = await db
    .select()
    .from(slide)
    .where(eq(slide.postId, current.id))
    .orderBy(slide.position);

  // Claim the post before doing anything irreversible. A scheduled job firing
  // at the same moment as someone pressing Post now would otherwise both pass
  // the status check above and publish the carousel twice.
  const [claimed] = await db
    .update(post)
    .set({ status: "publishing", failureReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(post.id, current.id),
        inArray(post.status, ["approved", "scheduled", "failed"]),
      ),
    )
    .returning();
  if (!claimed) {
    const [latest] = await db.select().from(post).where(eq(post.id, current.id));
    if (latest?.status === "published") {
      return { status: "published", mediaId: latest.publishedMediaId ?? undefined };
    }
    throw new PublishError(
      "Another publish attempt for this post is already in flight.",
    );
  }

  await recordAudit({
    tenantId: current.tenantId,
    postId: current.id,
    actor: systemActor(input.actorLabel),
    action: "post.publishing",
    payload: { igAccount: account.username },
  });

  try {
    const result = await publishMedia({
      post: current,
      account,
      slides,
      sleep: input.sleep,
      budgetMs: input.budgetMs,
      now: input.now,
    });

    await db
      .update(post)
      .set({
        status: "published",
        publishedMediaId: result.mediaId,
        permalink: result.permalink ?? null,
        publishedAt: new Date(),
        failureReason: null,
        scheduledFor: null,
        scheduleJobId: null,
        updatedAt: new Date(),
      })
      .where(eq(post.id, current.id));
    await db.insert(publishAttempt).values({
      igAccountId: account.id,
      postId: current.id,
      succeeded: "true",
      mediaId: result.mediaId,
    });
    await recordAudit({
      tenantId: current.tenantId,
      postId: current.id,
      actor: systemActor(input.actorLabel),
      action: "post.published",
      payload: { mediaId: result.mediaId, permalink: result.permalink },
    });
    return { status: "published", mediaId: result.mediaId };
  } catch (error) {
    const verbatim =
      error instanceof PublishError
        ? error.verbatim
        : error instanceof InstagramApiError
          ? error.verbatim
          : String(error);
    // A publish that ran out of time never called media_publish. The post is
    // failed either way — nothing may sit in `publishing` once this returns —
    // but the caller can tell "try again" from "this post is wrong".
    const stillProcessing =
      error instanceof PublishError && error.stillProcessing;
    const message = error instanceof Error ? error.message : verbatim;
    // What a person reads on the post: our sentence first, because Meta's body
    // for an expired container is the single word EXPIRED, then Meta's own
    // text, because that is the only record of what it objected to.
    const reason =
      verbatim === message ? message : `${message}\n\n${verbatim}`;

    await db
      .update(post)
      .set({
        status: "failed",
        failureReason: reason.slice(0, 4000),
        updatedAt: new Date(),
      })
      .where(eq(post.id, current.id));
    await db.insert(publishAttempt).values({
      igAccountId: account.id,
      postId: current.id,
      succeeded: "false",
      error: verbatim.slice(0, 2000),
    });
    await recordAudit({
      tenantId: current.tenantId,
      postId: current.id,
      actor: systemActor(input.actorLabel),
      action: "post.publish_failed",
      payload: { error: verbatim.slice(0, 2000) },
    });
    return { status: "failed", error: reason, stillProcessing };
  }
}
