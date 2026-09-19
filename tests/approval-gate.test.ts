import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { useTestDatabase } from "./helpers/db.ts";

await useTestDatabase();

const { assertTransition, TRANSITIONS } = await import(
  "@/lib/posts/state-machine"
);
const { getDb, post, slide, tenant } = await import("@/lib/db");
const { splitTenantConfig } = await import("@/lib/tenants");
const service = await import("@/lib/posts/service");

const human = { type: "human" as const, id: "u1", label: "Nurse P <np@example.com>" };
const system = { type: "system" as const, label: "pipeline" };

const tenantConfig = JSON.parse(
  await readFile("tenants/precision-vitality.json", "utf8"),
);
const seeds = JSON.parse(
  await readFile("content/precision-vitality-carousels.json", "utf8"),
);

test("only a human can approve, and only from pending_approval", () => {
  assert.doesNotThrow(() =>
    assertTransition({ from: "pending_approval", to: "approved", actor: human }),
  );
  assert.throws(
    () =>
      assertTransition({ from: "pending_approval", to: "approved", actor: system }),
    /Only a person/,
  );
  assert.throws(
    () => assertTransition({ from: "draft", to: "approved", actor: human }),
    /cannot go from draft to approved/,
  );
});

test("nothing reaches publishing without a recorded human approval", () => {
  assert.throws(
    () =>
      assertTransition({
        from: "approved",
        to: "publishing",
        actor: system,
        approvedBy: null,
      }),
    /never been approved by a person/,
  );
  assert.doesNotThrow(() =>
    assertTransition({
      from: "scheduled",
      to: "publishing",
      actor: system,
      approvedBy: "Nurse P",
    }),
  );
});

test("blocking compliance findings stop approval and submission", () => {
  for (const to of ["pending_approval", "approved"] as const) {
    assert.throws(
      () =>
        assertTransition({
          from: to === "approved" ? "pending_approval" : "draft",
          to,
          actor: human,
          hasBlockingFindings: true,
        }),
      /blocking compliance errors/,
    );
  }
});

test("there is no transition into publishing that skips approved or scheduled", () => {
  assert.deepEqual(TRANSITIONS.publishing.from.sort(), [
    "approved",
    "failed",
    "scheduled",
  ]);
  assert.deepEqual(TRANSITIONS.published.from, ["publishing"]);
});

test("approval is withdrawn when an approved post is edited", async () => {
  const db = await getDb();
  const [t] = await db
    .insert(tenant)
    .values(splitTenantConfig(tenantConfig))
    .returning();

  const carousel = seeds.carousels[0];
  const [created] = await db
    .insert(post)
    .values({
      tenantId: t.id,
      status: "draft",
      title: "Fine lines",
      caption: carousel.caption,
      createdBy: "test",
    })
    .returning();
  await db.insert(slide).values(
    carousel.slides.map((raw: Record<string, unknown>) => ({
      postId: created.id,
      position: raw.position as number,
      type: raw.type as string,
      copy: { ...raw, kicker: carousel.kicker },
      altText: (raw.alt_text as string) ?? "",
      photoPrompt: (raw.photo_prompt as string) ?? null,
    })),
  );

  const report = await service.recomputeCompliance(created.id);
  assert.equal(report.approvable, true, JSON.stringify(report.findings, null, 1));

  await service.submitForApproval({ postId: created.id, actor: human });
  const approved = await service.approvePost({ postId: created.id, actor: human });
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, human.label);

  // Editing after approval sends it back: someone has to look again.
  await service.updateCaption({
    postId: created.id,
    caption: `${carousel.caption}\n\nOne more line.`,
    actor: human,
  });
  const [after] = await db.select().from(post);
  assert.equal(after.status, "pending_approval");
  assert.equal(after.approvedBy, null);

  const trail = await service.auditTrail(created.id);
  const actions = trail.map((t) => t.action);
  assert.ok(actions.includes("post.approved"));
  assert.ok(actions.includes("post.caption_edited"));
  assert.equal(
    trail.find((t) => t.action === "post.approved")?.actor,
    human.label,
    "the audit log records who approved it",
  );
});

test("a caption edit that breaks a rule blocks re-approval", async () => {
  const db = await getDb();
  const [existing] = await db.select().from(post);

  await service.updateCaption({
    postId: existing.id,
    caption: "This protocol cures fine lines. #a #b #c #d #e #f",
    actor: human,
  });
  const report = await service.recomputeCompliance(existing.id);
  assert.equal(report.approvable, false);
  await assert.rejects(
    () => service.approvePost({ postId: existing.id, actor: human }),
    /blocking compliance errors|Compliance errors appeared/,
  );
});
