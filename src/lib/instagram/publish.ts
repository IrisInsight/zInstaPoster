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
 *   parent     POST /{ig-user-id}/media   media_type=CAROUSEL children=…
 *   publish    POST /{ig-user-id}/media_publish  creation_id=…
 *   poll       GET  /{container-id}?fields=status_code
 *
 * Containers expire after 24 hours, so none of this happens at approval time.
 */

export const MIN_CAROUSEL_ITEMS = 2;
export const MAX_CAROUSEL_ITEMS = 10;
export const MAX_CAPTION_CHARS = 2200;
export const MAX_ALT_TEXT_CHARS = 1000;
/** 100 published posts per rolling 24h per account. A carousel counts as one. */
export const DAILY_PUBLISH_LIMIT = 100;

const POLL_INTERVAL_MS = 60_000;
const POLL_MAX_ATTEMPTS = 5;

export class PublishError extends Error {
  readonly verbatim: string;
  constructor(message: string, verbatim?: string) {
    super(message);
    this.name = "PublishError";
    this.verbatim = verbatim ?? message;
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
  if (count < MIN_CAROUSEL_ITEMS || count > MAX_CAROUSEL_ITEMS) {
    throw new PublishError(
      `A carousel needs between ${MIN_CAROUSEL_ITEMS} and ${MAX_CAROUSEL_ITEMS} slides; this post has ${count}.`,
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
}

export async function publishCarousel(
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

  try {
    // 1. One child container per slide.
    for (const s of ordered) {
      const child = await graphPost<{ id: string }>(`${igUserId}/media`, {
        image_url: s.renderedUrl as string,
        is_carousel_item: "true",
        ...(s.altText ? { alt_text: s.altText } : {}),
        access_token: accessToken,
      });
      containerIds.push(child.id);
    }

    // 2. The parent carousel container.
    const parent = await graphPost<{ id: string }>(`${igUserId}/media`, {
      media_type: "CAROUSEL",
      children: containerIds.join(","),
      caption: input.post.caption,
      access_token: accessToken,
    });
    containerIds.push(parent.id);

    // 3. Wait for the parent to finish, then publish it.
    await waitForContainer({
      containerId: parent.id,
      accessToken,
      sleep,
    });

    const published = await graphPost<{ id: string }>(
      `${igUserId}/media_publish`,
      { creation_id: parent.id, access_token: accessToken },
    );

    const permalink = await fetchPermalink(published.id, accessToken);
    return { mediaId: published.id, permalink, containerIds };
  } catch (error) {
    if (error instanceof InstagramApiError) {
      throw new PublishError(error.message, error.verbatim);
    }
    throw error;
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
}): Promise<ContainerStatus> {
  const sleep = input.sleep ?? defaultSleep;
  const maxAttempts = input.maxAttempts ?? POLL_MAX_ATTEMPTS;

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
      throw new PublishError(
        `Instagram could not process the carousel: ${body.status ?? "ERROR"}`,
        JSON.stringify(body),
      );
    }
    if (status === "EXPIRED") {
      throw new PublishError(
        "The media container expired before it could be published. Containers are only valid for 24 hours.",
        JSON.stringify(body),
      );
    }
    if (attempt < maxAttempts - 1) await sleep(POLL_INTERVAL_MS);
  }
  throw new PublishError(
    `The carousel was still processing after ${maxAttempts} minutes.`,
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
}): Promise<{ status: "published" | "failed"; mediaId?: string; error?: string }> {
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
    const result = await publishCarousel({
      post: current,
      account,
      slides,
      sleep: input.sleep,
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

    await db
      .update(post)
      .set({
        status: "failed",
        failureReason: verbatim.slice(0, 4000),
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
    return { status: "failed", error: verbatim };
  }
}
