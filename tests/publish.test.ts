import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before, beforeEach } from "node:test";
import { eq } from "drizzle-orm";
import { useTestDatabase } from "./helpers/db.ts";

await useTestDatabase();

const { getDb, igAccount, post, slide, tenant, auditLog, publishAttempt } =
  await import("@/lib/db");
const {
  publishPostById,
  assertPublishable,
  waitForContainer,
  PublishError,
  PUBLISH_BUDGET_MS,
  INTERACTIVE_PUBLISH_BUDGET_MS,
} = await import("@/lib/instagram/publish");
const { sweepDuePosts, STUCK_PUBLISHING_MS } = await import("@/lib/scheduler");
const { encryptSecret } = await import("@/lib/crypto");
const { splitTenantConfig } = await import("@/lib/tenants");

const tenantConfig = JSON.parse(
  await readFile("tenants/precision-vitality.json", "utf8"),
);

interface Call {
  url: string;
  method: string;
  body: Record<string, string>;
}

let calls: Call[] = [];
/** Container ids in the order Instagram handed them out. */
let createdIds: string[] = [];
let containerStatus = "FINISHED";
/**
 * How long Instagram takes to fetch an image after the container is created.
 * With this set, a container reports IN_PROGRESS until the clock passes it —
 * which is the whole race: creating a container is not the same as the media
 * being ready to publish.
 */
let processingMs = 0;
let readyAt: Record<string, number> = {};
let childrenOf: Record<string, string[]> = {};
/** The clock the fake measures processing against. */
let graphClock = () => Date.now();
/** Per-container overrides, so one slide can lag behind the rest. */
let statusByContainer: Record<string, string> = {};
let failOn: string | null = null;
/** How many times media_publish answers "the media is not ready". */
let notReadyTimes = 0;

/** The graph path is /{version}/{id}, so the id is the last segment. */
function containerIdFrom(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
}

/** A fake clock the fake sleep advances, so a budget can be spent instantly. */
function fakeClock() {
  let now = Date.now();
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    elapsedSince: (start: number) => now - start,
  };
}

const realFetch = globalThis.fetch;

/** A stand-in for the Instagram graph API that records what we sent it. */
function installFakeGraph() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body: Record<string, string> = {};
    if (typeof init?.body === "string") {
      for (const [k, v] of new URLSearchParams(init.body)) body[k] = v;
    }
    for (const [k, v] of new URL(url).searchParams) body[k] = v;
    calls.push({ url, method, body });

    if (failOn && url.includes(failOn)) {
      return new Response(
        JSON.stringify({
          error: {
            message: "The image is not accessible.",
            code: 9004,
            error_subcode: 2207052,
            fbtrace_id: "Abc123",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    // Order matters: a status or permalink read is a GET on the container or
    // media id, whose path also contains "media".
    if (url.includes("content_publishing_limit")) {
      return Response.json({
        data: [{ config: { quota_total: 100 }, quota_usage: 3 }],
      });
    }
    if (body.fields?.includes("status_code")) {
      const id = containerIdFrom(url);
      const processing = (readyAt[id] ?? 0) > graphClock();
      const status =
        statusByContainer[id] ?? (processing ? "IN_PROGRESS" : containerStatus);
      return Response.json({
        status_code: status,
        ...(status === "ERROR"
          ? { status: "Error: the image could not be downloaded" }
          : {}),
      });
    }
    if (body.fields?.includes("permalink")) {
      return Response.json({ permalink: "https://www.instagram.com/p/XYZ/" });
    }
    if (url.includes("/media_publish")) {
      // What Meta does, and the whole reason this flow polls: publishing a
      // container whose media has not finished processing — or a carousel with
      // one child still downloading — is 9007 / 2207027, not a queued publish.
      const creationId = body.creation_id ?? "";
      const notReady = [creationId, ...(childrenOf[creationId] ?? [])].some(
        (id) => (readyAt[id] ?? 0) > graphClock(),
      );
      if (notReady) notReadyTimes = Math.max(notReadyTimes, 1);
      if (notReadyTimes > 0) {
        notReadyTimes -= 1;
        return new Response(
          JSON.stringify({
            error: {
              message: "The media is not ready for publishing.",
              code: 9007,
              error_subcode: 2207027,
              fbtrace_id: "Abc123",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return Response.json({ id: "media-987" });
    }
    if (url.endsWith("/media") || url.includes("/media?")) {
      const id = `container-${calls.length}`;
      createdIds.push(id);
      if (body.children) {
        // A carousel parent fetches nothing itself, so it reports FINISHED as
        // soon as it exists — including while a child is still downloading.
        // That is exactly why polling the container being published is not
        // enough, and why the failure only showed up under load.
        childrenOf[id] = body.children.split(",");
        readyAt[id] = graphClock();
      } else {
        readyAt[id] = graphClock() + processingMs;
      }
      return Response.json({ id });
    }
    return Response.json({});
  }) as typeof fetch;
}

before(() => installFakeGraph());

async function makePost(
  overrides: { approvedBy?: string | null; status?: string; slides?: number } = {},
) {
  const db = await getDb();
  const existing = await db.select().from(tenant);
  const tenantRow =
    existing[0] ??
    (
      await db
        .insert(tenant)
        .values(splitTenantConfig(tenantConfig))
        .returning()
    )[0];

  const accounts = await db.select().from(igAccount);
  const account =
    accounts[0] ??
    (
      await db
        .insert(igAccount)
        .values({
          tenantId: tenantRow.id,
          igUserId: "17841400000000000",
          username: "precisionvitality",
          accessToken: encryptSecret("long-lived-token"),
          tokenExpiresAt: new Date(Date.now() + 40 * 86_400_000),
          lastRefreshedAt: new Date(Date.now() - 86_400_000 * 2),
          status: "connected",
        })
        .returning()
    )[0];

  const [created] = await db
    .insert(post)
    .values({
      tenantId: tenantRow.id,
      igAccountId: account.id,
      status: overrides.status ?? "approved",
      title: "Brain fog",
      caption: "Brain fog gets treated as a mood problem.\n\n#brainfog",
      approvedBy:
        overrides.approvedBy === undefined
          ? "Nurse P <np@example.com>"
          : overrides.approvedBy,
      approvedAt: new Date(),
      createdBy: "test",
    })
    .returning();

  const count = overrides.slides ?? 4;
  await db.insert(slide).values(
    Array.from({ length: count }, (_, index) => index + 1).map((position) => ({
      postId: created.id,
      position,
      type:
        count === 1
          ? "statement"
          : (["hook", "cause", "protocol", "cta"][position - 1] ?? "cause"),
      copy: { headline: `Slide ${position}` },
      altText: `Slide ${position} alt text`,
      renderedUrl: `https://blob.example.com/posts/${created.id}/slides/${position}.jpg`,
      width: 1080,
      height: 1350,
    })),
  );

  return { postId: created.id, accountId: account.id, tenantId: tenantRow.id };
}

beforeEach(() => {
  calls = [];
  createdIds = [];
  containerStatus = "FINISHED";
  statusByContainer = {};
  failOn = null;
  notReadyTimes = 0;
  processingMs = 0;
  readyAt = {};
  childrenOf = {};
  graphClock = () => Date.now();
});

function indexOfCall(match: (call: Call) => boolean): number {
  return calls.findIndex(match);
}

function polledAt(containerId: string): number {
  return indexOfCall(
    (c) =>
      Boolean(c.body.fields?.includes("status_code")) &&
      containerIdFrom(c.url) === containerId,
  );
}

test("a single card publishes as one image, not a carousel of one", async () => {
  const { postId } = await makePost({ slides: 1 });
  const result = await publishPostById({ postId, actorLabel: "test" });
  assert.equal(result.status, "published", result.error);

  assert.equal(
    calls.filter((c) => c.body.is_carousel_item === "true").length,
    0,
    "a one-slide post has no carousel children",
  );
  assert.equal(
    calls.filter((c) => c.body.media_type === "CAROUSEL").length,
    0,
    "and no parent container — Instagram rejects a carousel of one",
  );

  // The caption and alt text ride on the image container itself, because
  // there is no parent to hang them on.
  const container = calls.find((c) => c.body.image_url);
  assert.ok(container, "an image container is created");
  assert.match(container.body.caption, /Brain fog/);
  assert.ok(container.body.alt_text, "alt text is still sent");

  const publish = calls.find((c) => c.url.includes("/media_publish"));
  assert.ok(publish, "media_publish is called");
  assert.equal(publish.body.creation_id, "container-1");
});

test("publishes a carousel in three steps, at fire time", async () => {
  const { postId } = await makePost();
  const result = await publishPostById({ postId, actorLabel: "test" });
  assert.equal(result.status, "published", result.error);
  assert.equal(result.mediaId, "media-987");

  const children = calls.filter((c) => c.body.is_carousel_item === "true");
  assert.equal(children.length, 4, "one child container per slide");
  for (const child of children) {
    assert.match(child.url, /\/v\d+\.\d+\//, "graph calls must be version-pinned");
    assert.match(child.body.image_url, /^https:\/\//);
    assert.ok(child.body.alt_text, "alt text is sent for accessibility");
  }

  const parent = calls.find((c) => c.body.media_type === "CAROUSEL");
  assert.ok(parent, "a parent carousel container is created");
  assert.equal(parent.body.children.split(",").length, 4);
  assert.match(parent.body.caption, /Brain fog/);

  const publish = calls.find((c) => c.url.includes("/media_publish"));
  assert.ok(publish, "media_publish is called");
  assert.ok(publish.body.creation_id, "publish references the parent container");

  const statusPoll = calls.find((c) => c.body.fields?.includes("status_code"));
  assert.ok(statusPoll, "the container is polled before publishing");

  const db = await getDb();
  const [row] = await db.select().from(post);
  assert.equal(row.status, "published");
  assert.equal(row.publishedMediaId, "media-987");
  assert.equal(row.permalink, "https://www.instagram.com/p/XYZ/");

  const attempts = await db.select().from(publishAttempt);
  assert.equal(attempts.at(-1)?.succeeded, "true");

  const trail = await db.select().from(auditLog);
  const actions = trail.map((t) => t.action);
  assert.ok(actions.includes("post.publishing"));
  assert.ok(actions.includes("post.published"));
});

test("every container is polled to FINISHED, children before the parent", async () => {
  // Meta error 9007 / 2207027 — "The media is not ready for publishing" — is
  // media_publish reaching a container that has not finished processing. A
  // parent can report FINISHED while a child is still downloading, so polling
  // only the container being published is not enough.
  const { postId } = await makePost();
  const result = await publishPostById({ postId, actorLabel: "test" });
  assert.equal(result.status, "published", result.error);

  const parentPost = calls.find((c) => c.body.media_type === "CAROUSEL");
  assert.ok(parentPost);
  const childIds = parentPost.body.children.split(",");
  assert.equal(childIds.length, 4);

  const parentIndex = indexOfCall((c) => c.body.media_type === "CAROUSEL");
  for (const childId of childIds) {
    const polled = polledAt(childId);
    assert.ok(polled >= 0, `child ${childId} is never polled`);
    assert.ok(
      polled < parentIndex,
      `child ${childId} is polled only after the parent is created`,
    );
  }

  const parentId = createdIds.at(-1) as string;
  const parentPolled = polledAt(parentId);
  const publishIndex = indexOfCall((c) => c.url.includes("/media_publish"));
  assert.ok(parentPolled > parentIndex, "the parent is polled after it exists");
  assert.ok(
    parentPolled < publishIndex,
    "the parent is polled before it is published",
  );
});

test("a carousel whose images take time to process publishes, rather than racing", async () => {
  // The reported failure, reproduced: nine carousels back to back, and one of
  // them called media_publish while a child was still downloading. Here the
  // fake graph behaves the way Meta does — publishing a carousel with an
  // unready child is 9007 / 2207027 — so this test fails against a flow that
  // does not poll every container.
  const { postId } = await makePost();
  const clock = fakeClock();
  const start = clock.now();
  graphClock = clock.now;
  processingMs = 90_000;

  const result = await publishPostById({
    postId,
    actorLabel: "scheduler",
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(result.status, "published", result.error);
  const publishes = calls.filter((c) => c.url.includes("/media_publish"));
  assert.equal(publishes.length, 1, "no 9007, so no retry was needed");

  // Waiting on the first child is waiting on all of them: Instagram fetches
  // the images in parallel, so a four-slide carousel costs one image's wait,
  // not four.
  assert.ok(
    clock.now() - start <= 2 * processingMs,
    `four slides at 90s each took ${(clock.now() - start) / 1000}s`,
  );
  const db = await getDb();
  const [row] = await db.select().from(post).where(eq(post.id, postId));
  assert.equal(row.status, "published");
});

test("nine carousels back to back all publish", async () => {
  // Intermittent in production because it depends on how long Instagram takes
  // with each image. Here every carousel meets a different processing time,
  // including ones that straddle the poll interval.
  for (const delay of [0, 1_000, 59_000, 60_000, 61_000, 90_000, 120_000, 180_000, 240_000]) {
    calls = [];
    createdIds = [];
    readyAt = {};
    childrenOf = {};
    notReadyTimes = 0;
    const { postId } = await makePost();
    const clock = fakeClock();
    graphClock = clock.now;
    processingMs = delay;

    const result = await publishPostById({
      postId,
      actorLabel: "scheduler",
      sleep: clock.sleep,
      now: clock.now,
    });
    assert.equal(
      result.status,
      "published",
      `a carousel whose images took ${delay}ms: ${result.error}`,
    );
    assert.equal(
      calls.filter((c) => c.url.includes("/media_publish")).length,
      1,
      `one publish call for a ${delay}ms carousel`,
    );
  }
});

test("a slide that never finishes stops the publish before anything goes out", async () => {
  const { postId } = await makePost();
  const clock = fakeClock();
  statusByContainer["container-2"] = "IN_PROGRESS";

  const result = await publishPostById({
    postId,
    actorLabel: "test",
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stillProcessing, true);
  assert.match(result.error ?? "", /Slide 2 was still processing/);
  assert.equal(
    calls.filter((c) => c.url.includes("/media_publish")).length,
    0,
    "nothing is published while a slide is still processing",
  );

  const db = await getDb();
  const [row] = await db.select().from(post).where(eq(post.id, postId));
  assert.equal(row.status, "failed", "the post is never left in publishing");
  assert.match(row.failureReason ?? "", /Slide 2/);
  assert.match(row.failureReason ?? "", /Nothing was published/);
});

test("a slide Instagram rejects names the slide and records Meta's reason", async () => {
  const { postId } = await makePost();
  statusByContainer["container-3"] = "ERROR";

  const result = await publishPostById({
    postId,
    actorLabel: "test",
    sleep: async () => {},
  });

  assert.equal(result.status, "failed");
  assert.notEqual(result.stillProcessing, true, "an ERROR is terminal");
  const db = await getDb();
  const [row] = await db.select().from(post).where(eq(post.id, postId));
  assert.match(row.failureReason ?? "", /image could not be downloaded/);
  assert.equal(
    calls.filter((c) => c.url.includes("/media_publish")).length,
    0,
  );
});

test("an expired child is terminal, and says so", async () => {
  const { postId } = await makePost();
  statusByContainer["container-1"] = "EXPIRED";
  const result = await publishPostById({
    postId,
    actorLabel: "test",
    sleep: async () => {},
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /expired before it could be published/);
  assert.notEqual(result.stillProcessing, true);
});

test("the publish gives up inside its own budget instead of being killed", async () => {
  // The flow has to end on its own terms: a function killed mid-poll leaves
  // the post parked in `publishing`, which only the sweep can clear.
  assert.ok(
    PUBLISH_BUDGET_MS < STUCK_PUBLISHING_MS,
    "a publish must finish before the sweep would call it stuck",
  );

  const { postId } = await makePost();
  const clock = fakeClock();
  const start = clock.now();
  containerStatus = "IN_PROGRESS";

  const result = await publishPostById({
    postId,
    actorLabel: "test",
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stillProcessing, true);
  assert.ok(
    clock.elapsedSince(start) <= PUBLISH_BUDGET_MS,
    `spent ${clock.elapsedSince(start)}ms of a ${PUBLISH_BUDGET_MS}ms budget`,
  );
  assert.equal(
    calls.filter((c) => c.url.includes("/media_publish")).length,
    0,
  );
});

test("a publish someone is waiting on checks once and does not hold the request", async () => {
  // Post now and Retry run in a server action the platform kills at a timeout
  // we do not control, so they publish on a budget too short to sleep on.
  const { postId } = await makePost();
  const clock = fakeClock();
  const start = clock.now();
  containerStatus = "IN_PROGRESS";

  const result = await publishPostById({
    postId,
    actorLabel: "someone pressing Post now",
    sleep: clock.sleep,
    now: clock.now,
    budgetMs: INTERACTIVE_PUBLISH_BUDGET_MS,
  });

  assert.ok(
    INTERACTIVE_PUBLISH_BUDGET_MS < PUBLISH_BUDGET_MS,
    "a person waiting on a request gets less time than the job does",
  );
  assert.equal(result.status, "failed");
  assert.equal(result.stillProcessing, true, "the caller can hand this to the job");
  assert.equal(clock.elapsedSince(start), 0, "an interactive publish never sleeps");
  assert.equal(
    calls.filter((c) => c.body.fields?.includes("status_code")).length,
    1,
    "each container is checked once, and the first one that is not ready ends it",
  );
});

test("a 'not ready' publish is re-read and retried once, not failed", async () => {
  // Every container reached FINISHED, and media_publish still says the media
  // is not ready: Instagram's own view of a carousel is eventually consistent.
  // Nothing was published, so the same creation_id can go again.
  const { postId } = await makePost();
  const clock = fakeClock();
  notReadyTimes = 1;

  const result = await publishPostById({
    postId,
    actorLabel: "test",
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(result.status, "published", result.error);
  const publishes = calls.filter((c) => c.url.includes("/media_publish"));
  assert.equal(publishes.length, 2, "one retry, not a loop");
  assert.equal(
    publishes[0].body.creation_id,
    publishes[1].body.creation_id,
    "the retry publishes the same container",
  );
  const parentId = createdIds.at(-1) as string;
  const polls = calls.filter(
    (c) =>
      Boolean(c.body.fields?.includes("status_code")) &&
      containerIdFrom(c.url) === parentId,
  );
  assert.ok(polls.length >= 2, "the container is re-read before the retry");
});

test("a 'not ready' publish that stays not ready fails without publishing twice", async () => {
  const { postId } = await makePost();
  const clock = fakeClock();
  notReadyTimes = 5;

  const result = await publishPostById({
    postId,
    actorLabel: "test",
    sleep: clock.sleep,
    now: clock.now,
  });

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /not ready for publishing/);
  assert.match(result.error ?? "", /fbtrace_id/, "Meta's own body is recorded");
  assert.equal(
    result.stillProcessing,
    true,
    "nothing was published, so this is worth running again",
  );
  assert.equal(
    calls.filter((c) => c.url.includes("/media_publish")).length,
    2,
    "the retry is not a loop",
  );
});

test("a post parked in publishing is swept back to failed and retries cleanly", async () => {
  // What a killed publish leaves behind. The sweep is the only thing that can
  // clear it, and Retry has to be able to pick it up from there.
  const { postId } = await makePost();
  const db = await getDb();
  await db
    .update(post)
    .set({
      status: "publishing",
      updatedAt: new Date(Date.now() - STUCK_PUBLISHING_MS - 60_000),
    })
    .where(eq(post.id, postId));

  const swept = await sweepDuePosts();
  assert.ok(
    swept.some((r) => r.postId === postId && r.status === "stuck-marked-failed"),
    JSON.stringify(swept),
  );

  const [recovered] = await db.select().from(post).where(eq(post.id, postId));
  assert.equal(recovered.status, "failed");
  assert.match(recovered.failureReason ?? "", /stopped before it finished/);

  // Retry is publishNowAction, which is publishPostById from `failed`.
  calls = [];
  const retried = await publishPostById({ postId, actorLabel: "Retry" });
  assert.equal(retried.status, "published", retried.error);

  const [after] = await db.select().from(post).where(eq(post.id, postId));
  assert.equal(after.status, "published");
  assert.equal(after.failureReason, null, "the old failure is cleared");
  assert.equal(
    calls.filter((c) => c.url.includes("/media_publish")).length,
    1,
    "the retry publishes once",
  );
});

test("a post that no person approved cannot publish", async () => {
  const { postId } = await makePost({ approvedBy: null });
  await assert.rejects(
    () => publishPostById({ postId, actorLabel: "test" }),
    /never been approved by a person/,
  );
  assert.equal(calls.length, 0, "no API call is made for an unapproved post");
});

test("a Meta error is stored verbatim and the post is marked failed", async () => {
  const { postId } = await makePost();
  failOn = "/media";
  const result = await publishPostById({ postId, actorLabel: "test" });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /not accessible/);

  const db = await getDb();
  const rows = await db.select().from(post);
  const row = rows.find((r) => r.id === postId);
  assert.equal(row?.status, "failed");
  assert.match(row?.failureReason ?? "", /fbtrace_id/);
});

test("an expired container is reported as an expired container", async () => {
  containerStatus = "EXPIRED";
  await assert.rejects(
    () =>
      waitForContainer({
        containerId: "container-1",
        accessToken: "t",
        sleep: async () => {},
        maxAttempts: 2,
      }),
    /expired before it could be published/,
  );
});

test("a still-processing container gives up after the polling budget", async () => {
  containerStatus = "IN_PROGRESS";
  let slept = 0;
  await assert.rejects(
    () =>
      waitForContainer({
        containerId: "container-1",
        accessToken: "t",
        sleep: async () => {
          slept += 1;
        },
        maxAttempts: 5,
      }),
    /still processing after 5 minutes/,
  );
  assert.equal(slept, 4, "polls once a minute, five times");
});

test("preflight rejects the failure modes that fail silently at Meta", () => {
  const base = {
    post: { status: "approved", caption: "ok", approvedBy: "a person" },
    slides: [1, 2, 3, 4].map((position) => ({
      position,
      renderedUrl: `https://blob.example.com/${position}.jpg`,
      altText: "alt",
      width: 1080,
      height: 1350,
    })),
  };
  assert.doesNotThrow(() => assertPublishable(base));

  assert.throws(
    () =>
      assertPublishable({
        ...base,
        slides: base.slides.map((s, i) =>
          i === 2 ? { ...s, width: 1080, height: 1080 } : s,
        ),
      }),
    /differing dimensions/,
  );

  assert.throws(
    () =>
      assertPublishable({
        ...base,
        slides: base.slides.map((s, i) =>
          i === 0 ? { ...s, renderedUrl: "http://localhost:3000/a.jpg" } : s,
        ),
      }),
    /public https URLs/,
  );

  // One slide is a single image post, not a malformed carousel.
  assert.doesNotThrow(() =>
    assertPublishable({ ...base, slides: base.slides.slice(0, 1) }),
  );
  assert.throws(
    () => assertPublishable({ ...base, slides: [] }),
    /this post has 0/,
  );
  assert.throws(
    () =>
      assertPublishable({
        ...base,
        slides: Array.from({ length: 11 }, (_, i) => ({
          ...base.slides[0],
          position: i + 1,
        })),
      }),
    /this post has 11/,
  );

  assert.throws(
    () =>
      assertPublishable({
        ...base,
        post: { ...base.post, caption: "x".repeat(2201) },
      }),
    /2200/,
  );

  assert.throws(
    () => assertPublishable({ ...base, post: { ...base.post, approvedBy: null } }),
    /never been approved/,
  );
  assert.ok(new PublishError("x") instanceof Error);
});

test("two publish attempts for one post cannot both go through", async () => {
  const { postId } = await makePost();
  const [first, second] = await Promise.allSettled([
    publishPostById({ postId, actorLabel: "scheduler" }),
    publishPostById({ postId, actorLabel: "someone pressing Post now" }),
  ]);

  const outcomes = [first, second].map((r) =>
    r.status === "fulfilled" ? r.value.status : "rejected",
  );
  assert.ok(
    outcomes.includes("published"),
    `one attempt should publish, got ${outcomes.join(" and ")}`,
  );

  // Exactly one carousel reaches Instagram, whichever attempt won.
  const publishes = calls.filter((c) => c.url.includes("/media_publish"));
  assert.equal(publishes.length, 1, "media_publish must be called once");

  const db = await getDb();
  const attempts = await db
    .select()
    .from(publishAttempt)
    .where(eq(publishAttempt.postId, postId));
  assert.equal(
    attempts.filter((a) => a.succeeded === "true").length,
    1,
    "one successful publish is recorded",
  );
});

test.after(() => {
  globalThis.fetch = realFetch;
});
