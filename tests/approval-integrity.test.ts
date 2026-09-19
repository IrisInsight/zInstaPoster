import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { eq } from "drizzle-orm";
import { useTestDatabase } from "./helpers/db.ts";

await useTestDatabase();

const { getDb, igAccount, photoGeneration, post, slide, tenant } = await import(
  "@/lib/db"
);
const { encryptSecret } = await import("@/lib/crypto");
const { splitTenantConfig } = await import("@/lib/tenants");
const service = await import("@/lib/posts/service");
const { editInvalidatesApproval } = await import("@/lib/posts/state-machine");

/**
 * Everything here is about one property: what a person approved is what gets
 * published. Each test names a way that could stop being true.
 */

const human = { type: "human" as const, id: "u1", label: "Alice <alice@example.com>" };
const other = { type: "human" as const, id: "u2", label: "Bob <bob@example.com>" };

const tenantConfig = JSON.parse(
  await readFile("tenants/precision-vitality.json", "utf8"),
);
const seeds = JSON.parse(
  await readFile("content/precision-vitality-carousels.json", "utf8"),
);

async function tenantRow(slug = "precision-vitality") {
  const db = await getDb();
  const rows = await db.select().from(tenant);
  const existing = rows.find((r) => r.slug === slug);
  if (existing) return existing;
  const [created] = await db
    .insert(tenant)
    .values({ ...splitTenantConfig(tenantConfig), slug })
    .returning();
  return created;
}

/** A post seeded from real content, carrying a real human approval. */
async function approvedPost(carouselIndex = 0) {
  const db = await getDb();
  const t = await tenantRow();
  const carousel = seeds.carousels[carouselIndex];

  const [created] = await db
    .insert(post)
    .values({
      tenantId: t.id,
      status: "draft",
      title: carousel.slug,
      caption: carousel.caption,
      createdBy: "test",
    })
    .returning();

  const slides = await db
    .insert(slide)
    .values(
      carousel.slides.map((raw: Record<string, unknown>) => ({
        postId: created.id,
        position: raw.position as number,
        type: raw.type as string,
        copy: { ...raw, kicker: carousel.kicker },
        altText: (raw.alt_text as string) ?? "",
        photoPrompt: (raw.photo_prompt as string) ?? null,
        renderedUrl: `https://blob.example.com/${created.id}/${raw.position}.jpg`,
      })),
    )
    .returning();

  await service.recomputeCompliance(created.id);
  await service.submitForApproval({ postId: created.id, actor: human });
  await service.approvePost({ postId: created.id, actor: human });
  return { postId: created.id, tenantId: t.id, slides };
}

async function statusOf(postId: string) {
  const db = await getDb();
  const [row] = await db.select().from(post).where(eq(post.id, postId));
  return { status: row.status, approvedBy: row.approvedBy };
}

test("an approval is withdrawn by any edit, whatever state the post is in", async () => {
  // The property, stated directly: it is the approval that matters, not a
  // hand-maintained list of statuses.
  for (const status of ["approved", "scheduled", "failed", "publishing"] as const) {
    assert.equal(
      editInvalidatesApproval({ status, approvedBy: "Alice" }),
      true,
      `${status} with an approval on it must invalidate`,
    );
  }
  assert.equal(
    editInvalidatesApproval({ status: "draft", approvedBy: null }),
    false,
  );
  assert.equal(
    editInvalidatesApproval({ status: "published", approvedBy: "Alice" }),
    false,
    "a published post is history, not a draft",
  );
});

test("editing a failed post withdraws the approval before it can be retried", async () => {
  const db = await getDb();
  const { postId } = await approvedPost(0);

  // The publish attempt failed; the approval is still on the row.
  await db
    .update(post)
    .set({ status: "failed", failureReason: "Instagram said no." })
    .where(eq(post.id, postId));
  assert.equal((await statusOf(postId)).approvedBy, human.label);

  await service.updateCaption({
    postId,
    caption: "A different caption nobody has read.",
    actor: other,
  });

  const after = await statusOf(postId);
  assert.equal(after.approvedBy, null, "Bob's edit must not inherit Alice's approval");
  assert.equal(after.status, "pending_approval");

  const trail = await service.auditTrail(postId);
  assert.ok(trail.some((e) => e.action === "post.approval_withdrawn"));
});

test("reordering, deleting or re-photographing slides withdraws the approval", async () => {
  const db = await getDb();

  // Reorder.
  {
    const { postId, slides } = await approvedPost(1);
    const order = [...slides].sort((a, b) => a.position - b.position).map((s) => s.id);
    await service.reorderSlides({
      postId,
      order: [order[1], order[0], order[2], order[3]],
      actor: human,
    });
    assert.equal((await statusOf(postId)).approvedBy, null, "reorder");
  }

  // Delete.
  {
    const { postId } = await approvedPost(2);
    const rows = await db.select().from(slide).where(eq(slide.postId, postId));
    await service.deleteSlide({ postId, slideId: rows[1].id, actor: human });
    assert.equal((await statusOf(postId)).approvedBy, null, "delete");
  }

  // Swap the hook photo.
  {
    const { postId } = await approvedPost(3);
    const rows = await db.select().from(slide).where(eq(slide.postId, postId));
    const hook = rows.find((r) => r.photoPrompt) ?? rows[0];
    const [generation] = await db
      .insert(photoGeneration)
      .values({
        slideId: hook.id,
        prompt: "a different photo",
        url: "https://blob.example.com/other.jpg",
        provider: "gemini",
      })
      .returning();
    await service.selectPhoto({
      postId,
      slideId: hook.id,
      generationId: generation.id,
      actor: human,
    });
    assert.equal((await statusOf(postId)).approvedBy, null, "photo swap");
  }
});

test("a slide from another post cannot be deleted or reordered into this one", async () => {
  const db = await getDb();
  const mine = await approvedPost(0);
  const theirs = await approvedPost(1);
  const theirSlides = await db
    .select()
    .from(slide)
    .where(eq(slide.postId, theirs.postId));

  await assert.rejects(
    () =>
      service.deleteSlide({
        postId: mine.postId,
        slideId: theirSlides[0].id,
        actor: human,
      }),
    /does not belong to this post/,
  );
  const stillThere = await db
    .select()
    .from(slide)
    .where(eq(slide.postId, theirs.postId));
  assert.equal(stillThere.length, theirSlides.length, "their slides are untouched");

  const mySlides = await db
    .select()
    .from(slide)
    .where(eq(slide.postId, mine.postId));
  await assert.rejects(
    () =>
      service.reorderSlides({
        postId: mine.postId,
        order: [mySlides[0].id, mySlides[1].id],
        actor: human,
      }),
    /does not match this post's slides/,
    "a partial order would strand slides at negative positions",
  );
  const positions = (
    await db.select().from(slide).where(eq(slide.postId, mine.postId))
  )
    .map((s) => s.position)
    .sort((a, b) => a - b);
  assert.deepEqual(positions, [1, 2, 3, 4]);
});

test("a photo generation from another slide cannot be selected", async () => {
  const db = await getDb();
  const mine = await approvedPost(0);
  const theirs = await approvedPost(1);
  const [theirSlide] = await db
    .select()
    .from(slide)
    .where(eq(slide.postId, theirs.postId));
  const [generation] = await db
    .insert(photoGeneration)
    .values({
      slideId: theirSlide.id,
      prompt: "their photo",
      url: "https://blob.example.com/theirs.jpg",
      provider: "gemini",
    })
    .returning();

  const [mySlide] = await db
    .select()
    .from(slide)
    .where(eq(slide.postId, mine.postId));
  await assert.rejects(
    () =>
      service.selectPhoto({
        postId: mine.postId,
        slideId: mySlide.id,
        generationId: generation.id,
        actor: human,
      }),
    /no longer exists/,
  );
});

test("photo history is scoped to the post that owns the slide", async () => {
  const db = await getDb();
  const mine = await approvedPost(0);
  const theirs = await approvedPost(1);
  const [theirSlide] = await db
    .select()
    .from(slide)
    .where(eq(slide.postId, theirs.postId));
  await db.insert(photoGeneration).values({
    slideId: theirSlide.id,
    prompt: "their brief",
    url: "https://blob.example.com/theirs.jpg",
    provider: "gemini",
  });

  assert.deepEqual(
    await service.photoHistory({ postId: mine.postId, slideId: theirSlide.id }),
    [],
    "another post's slide returns nothing",
  );
  assert.equal(
    (await service.photoHistory({ postId: theirs.postId, slideId: theirSlide.id }))
      .length,
    1,
  );
});

test("the queue never returns a tenant the user is not a member of", async () => {
  const db = await getDb();
  const mine = await tenantRow();
  const [stranger] = await db
    .insert(tenant)
    .values({ ...splitTenantConfig(tenantConfig), slug: "someone-else" })
    .returning();
  await db.insert(post).values({
    tenantId: stranger.id,
    status: "published",
    title: "Not yours",
    caption: "private",
    createdBy: "them",
  });

  const asked = await service.listQueue({
    tenantIds: [mine.id],
    tenantId: stranger.id,
  });
  assert.deepEqual(asked, [], "asking for another tenant by id returns nothing");

  const all = await service.listQueue({ tenantIds: [mine.id], tenantId: "all" });
  assert.ok(all.length > 0);
  assert.ok(
    all.every((row) => row.post.tenantId === mine.id),
    "the default scope is the user's own tenants",
  );
});

test("a published post cannot be unscheduled back into a publishable state", async () => {
  const db = await getDb();
  const { postId } = await approvedPost(0);
  await db
    .update(post)
    .set({
      status: "published",
      publishedMediaId: "media-1",
      publishedAt: new Date(),
      scheduledFor: new Date(),
    })
    .where(eq(post.id, postId));

  await assert.rejects(
    () => service.unschedulePost({ postId, actor: human }),
    /has no schedule to clear/,
  );
  assert.equal((await statusOf(postId)).status, "published");
});

test("unscheduling a scheduled post returns it to approved, and only a human can", async () => {
  const { postId } = await approvedPost(0);
  await service.schedulePost({
    postId,
    at: new Date(Date.now() + 3_600_000),
    actor: human,
  });
  assert.equal((await statusOf(postId)).status, "scheduled");

  await service.unschedulePost({ postId, actor: human });
  const after = await statusOf(postId);
  assert.equal(after.status, "approved");
  assert.equal(after.approvedBy, human.label, "the approval itself survives");
});

test("regenerating the hook photo withdraws the approval and is refused when published", async () => {
  const db = await getDb();
  const { postId } = await approvedPost(4);
  const rows = await db.select().from(slide).where(eq(slide.postId, postId));
  const hook = rows.find((r) => r.photoPrompt) ?? rows[0];

  // The generator is stubbed: what is under test is the guard and the
  // withdrawal around it, not the image model.
  let approvalAtGenerationTime: string | null = "not reached";
  await service.regenerateSlidePhoto({
    postId,
    slideId: hook.id,
    prompt: "a completely different photo",
    actor: human,
    generate: async () => {
      approvalAtGenerationTime = (await statusOf(postId)).approvedBy;
      return "https://blob.example.com/new-photo.jpg";
    },
  });

  assert.equal(
    approvalAtGenerationTime,
    null,
    "the approval is withdrawn before the new photo is generated, not after",
  );
  const after = await statusOf(postId);
  assert.equal(after.approvedBy, null, "the approval must not survive a new cover photo");
  assert.equal(after.status, "pending_approval");

  await db
    .update(post)
    .set({ status: "published", publishedMediaId: "m-1" })
    .where(eq(post.id, postId));
  await assert.rejects(
    () =>
      service.regenerateSlidePhoto({
        postId,
        slideId: hook.id,
        prompt: "another one",
        actor: human,
        generate: async () => {
          throw new Error("the generator must never run on a published post");
        },
      }),
    /cannot be edited/,
  );
});

test("a failed delete does not destroy the slide on the way out", async () => {
  const db = await getDb();
  const { postId } = await approvedPost(0);
  const before = await db.select().from(slide).where(eq(slide.postId, postId));
  await db
    .update(post)
    .set({ status: "published", publishedMediaId: "m-2" })
    .where(eq(post.id, postId));

  await assert.rejects(
    () => service.deleteSlide({ postId, slideId: before[1].id, actor: human }),
    /cannot be edited/,
  );

  const after = await db.select().from(slide).where(eq(slide.postId, postId));
  assert.equal(after.length, before.length, "the slide is still there");
  assert.deepEqual(
    after.map((s) => s.position).sort((a, b) => a - b),
    [1, 2, 3, 4],
    "and the positions have no gap",
  );
});

test("a published post cannot be edited at all", async () => {
  const db = await getDb();
  const { postId } = await approvedPost(0);
  await db
    .update(post)
    .set({ status: "published", publishedMediaId: "media-1" })
    .where(eq(post.id, postId));

  await assert.rejects(
    () => service.updateCaption({ postId, caption: "rewriting history", actor: human }),
    /cannot be edited/,
  );

  // The same guard covers a publish already in flight.
  await db.update(post).set({ status: "publishing" }).where(eq(post.id, postId));
  await assert.rejects(
    () => service.updateCaption({ postId, caption: "mid-flight edit", actor: human }),
    /cannot be edited/,
  );
});

test("an account from another tenant cannot be attached to a post", async () => {
  const db = await getDb();
  const mine = await tenantRow();
  const [stranger] = await db
    .select()
    .from(tenant)
    .where(eq(tenant.slug, "someone-else"));

  const [theirAccount] = await db
    .insert(igAccount)
    .values({
      tenantId: stranger.id,
      igUserId: "1784140000999",
      username: "not-yours",
      accessToken: encryptSecret("their-token"),
      tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      status: "connected",
    })
    .returning();

  const { postId } = await approvedPost(0);
  await db
    .update(post)
    .set({ igAccountId: theirAccount.id })
    .where(eq(post.id, postId));

  const { publishPostById } = await import("@/lib/instagram/publish");
  await assert.rejects(
    () => publishPostById({ postId, actorLabel: "test" }),
    /does not belong to this tenant/,
    "even if the id is written directly, publishing refuses it",
  );
  void mine;
});
