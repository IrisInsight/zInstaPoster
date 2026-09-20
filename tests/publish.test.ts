import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before, beforeEach } from "node:test";
import { eq } from "drizzle-orm";
import { useTestDatabase } from "./helpers/db.ts";

await useTestDatabase();

const { getDb, igAccount, post, slide, tenant, auditLog, publishAttempt } =
  await import("@/lib/db");
const { publishPostById, assertPublishable, waitForContainer, PublishError } =
  await import("@/lib/instagram/publish");
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
let containerStatus = "FINISHED";
let failOn: string | null = null;

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
      return Response.json({ status_code: containerStatus });
    }
    if (body.fields?.includes("permalink")) {
      return Response.json({ permalink: "https://www.instagram.com/p/XYZ/" });
    }
    if (url.includes("/media_publish")) {
      return Response.json({ id: "media-987" });
    }
    if (url.endsWith("/media") || url.includes("/media?")) {
      return Response.json({ id: `container-${calls.length}` });
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
  containerStatus = "FINISHED";
  failOn = null;
});

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
