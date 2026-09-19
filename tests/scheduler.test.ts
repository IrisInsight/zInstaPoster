import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { useTestDatabase } from "./helpers/db.ts";

await useTestDatabase();

const { getDb, post, tenant } = await import("@/lib/db");
const { splitTenantConfig } = await import("@/lib/tenants");
const { sweepDuePosts, STUCK_PUBLISHING_MS, schedulerDriver } = await import(
  "@/lib/scheduler"
);

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
