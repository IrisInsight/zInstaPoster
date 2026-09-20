import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { useTestDatabase } from "./helpers/db.ts";

await useTestDatabase();

const { getDb, post, tenant } = await import("@/lib/db");
const { splitTenantConfig } = await import("@/lib/tenants");
const {
  sweepDuePosts,
  STUCK_PUBLISHING_MS,
  SWEEP_PUBLISH_BUDGET_MS,
  schedulerDriver,
} = await import("@/lib/scheduler");

const tenantConfig = JSON.parse(
  await readFile("tenants/precision-vitality.json", "utf8"),
);

async function tenantId(): Promise<string> {
  const db = await getDb();
  const rows = await db.select().from(tenant);
  if (rows[0]) return rows[0].id;
  const [created] = await db
    .insert(tenant)
    .values(splitTenantConfig(tenantConfig))
    .returning();
  return created.id;
}

test("the local driver is chosen when QStash is not configured", () => {
  assert.equal(schedulerDriver(), "local");
});

test("a post stuck in publishing is failed by the sweep, not left hanging", async () => {
  const db = await getDb();
  const id = await tenantId();
  const [stuck] = await db
    .insert(post)
    .values({
      tenantId: id,
      status: "publishing",
      title: "Stuck",
      caption: "x",
      approvedBy: "Nurse P",
      approvedAt: new Date(),
      updatedAt: new Date(Date.now() - STUCK_PUBLISHING_MS - 60_000),
    })
    .returning();

  const results = await sweepDuePosts();
  assert.ok(results.some((r) => r.postId === stuck.id));

  const [after] = await db.select().from(post);
  assert.equal(after.status, "failed");
  assert.match(after.failureReason ?? "", /stopped before it finished/);
  assert.match(
    after.failureReason ?? "",
    /check the account before retrying/,
    "the operator is told not to assume it did not publish",
  );
});

test("a post that only just started publishing is left alone", async () => {
  const db = await getDb();
  const id = await tenantId();
  await db.delete(post);
  const [recent] = await db
    .insert(post)
    .values({
      tenantId: id,
      status: "publishing",
      title: "In flight",
      caption: "x",
      approvedBy: "Nurse P",
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  await sweepDuePosts();
  const [after] = await db.select().from(post);
  assert.equal(after.status, "publishing", `${recent.id} should still be in flight`);
});

test("a sweep out of time leaves due posts scheduled rather than failing them", async () => {
  // The sweep can find several due posts at once and each publish has its own
  // budget. Spending the sweep's own lifetime on the first of them is how a
  // post ends up parked in `publishing` — the state this endpoint exists to
  // clear — so anything it cannot start stays `scheduled` for the next run.
  const db = await getDb();
  const id = await tenantId();
  await db.delete(post);
  for (const title of ["First", "Second"]) {
    await db.insert(post).values({
      tenantId: id,
      status: "scheduled",
      title,
      caption: "x",
      approvedBy: "Nurse P",
      approvedAt: new Date(),
      scheduledFor: new Date(Date.now() - 60_000),
    });
  }

  const results = await sweepDuePosts(new Date(), { budgetMs: 0 });
  assert.equal(results.length, 2);
  assert.ok(
    results.every((r) => r.status === "deferred"),
    JSON.stringify(results),
  );

  const rows = await db.select().from(post);
  assert.ok(
    rows.every((r) => r.status === "scheduled"),
    "a deferred post is still due, not failed",
  );
  assert.ok(
    SWEEP_PUBLISH_BUDGET_MS < 10 * 60 * 1000,
    "one sweep has to finish inside its own maxDuration",
  );
});
