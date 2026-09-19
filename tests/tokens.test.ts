import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { beforeEach } from "node:test";
import { useTestDatabase } from "./helpers/db.ts";

await useTestDatabase();

// Alerts go to a webhook we can watch, so "a failure alerts a human" is a
// property the tests can actually assert.
const alerts: { severity: string; title: string; body: string; text: string }[] = [];
process.env.ALERT_WEBHOOK_URL = "https://alerts.test/hook";

const { getDb, igAccount, tenant, auditLog } = await import("@/lib/db");
const { decryptSecret, encryptSecret } = await import("@/lib/crypto");
const { splitTenantConfig } = await import("@/lib/tenants");
const tokens = await import("@/lib/instagram/tokens");

const tenantConfig = JSON.parse(
  await readFile("tenants/precision-vitality.json", "utf8"),
);

let refreshShouldFail: "auth" | "network" | null = null;
let refreshCalls = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();

  if (url.startsWith("https://alerts.test/hook")) {
    alerts.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("ok");
  }

  if (url.includes("refresh_access_token")) {
    refreshCalls += 1;
    if (refreshShouldFail === "auth") {
      return new Response(
        JSON.stringify({
          error: {
            message: "Error validating access token: Session has expired.",
            code: 190,
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (refreshShouldFail === "network") {
      return new Response("upstream unavailable", { status: 503 });
    }
    assert.match(url, /grant_type=ig_refresh_token/);
    return Response.json({
      access_token: "refreshed-token",
      token_type: "bearer",
      expires_in: 5_183_944,
    });
  }
  return Response.json({});
}) as typeof fetch;

async function makeAccount(overrides: {
  expiresInDays: number;
  lastRefreshedHoursAgo?: number;
}) {
  const db = await getDb();
  const rows = await db.select().from(tenant);
  const t =
    rows[0] ??
    (await db.insert(tenant).values(splitTenantConfig(tenantConfig)).returning())[0];
  await db.delete(igAccount);
  const [account] = await db
    .insert(igAccount)
    .values({
      tenantId: t.id,
      igUserId: "1784140000000",
      username: "precisionvitality",
      accessToken: encryptSecret("current-token"),
      tokenExpiresAt: new Date(Date.now() + overrides.expiresInDays * 86_400_000),
      lastRefreshedAt: new Date(
        Date.now() - (overrides.lastRefreshedHoursAgo ?? 48) * 3_600_000,
      ),
      status: "connected",
    })
    .returning();
  return account;
}

beforeEach(() => {
  alerts.length = 0;
  refreshShouldFail = null;
  refreshCalls = 0;
});

test("a token well inside its life is left alone", async () => {
  const account = await makeAccount({ expiresInDays: 45 });
  const outcome = await tokens.refreshAccountToken(account);
  assert.equal(outcome.status, "skipped");
  assert.equal(refreshCalls, 0);
});

test("a token under 24 hours old is not refreshed yet", async () => {
  const account = await makeAccount({
    expiresInDays: 3,
    lastRefreshedHoursAgo: 2,
  });
  const outcome = await tokens.refreshAccountToken(account);
  assert.equal(outcome.status, "skipped");
  assert.match(outcome.detail, /under 24h old/);
  assert.equal(refreshCalls, 0);
});

test("a token inside the refresh window is refreshed and re-encrypted", async () => {
  const account = await makeAccount({ expiresInDays: 10 });
  const outcome = await tokens.refreshAccountToken(account);
  assert.equal(outcome.status, "refreshed", outcome.detail);
  assert.equal(refreshCalls, 1);

  const db = await getDb();
  const [row] = await db.select().from(igAccount);
  assert.equal(decryptSecret(row.accessToken), "refreshed-token");
  assert.notEqual(row.accessToken, "refreshed-token", "stored ciphertext, not plaintext");
  assert.ok(row.tokenExpiresAt && row.tokenExpiresAt.getTime() > Date.now() + 55 * 86_400_000);
  assert.equal(row.lastRefreshError, null);

  const trail = await db.select().from(auditLog);
  assert.ok(trail.some((t) => t.action === "token.refreshed"));
});

test("a failed refresh alerts a human and does not fail silently", async () => {
  const account = await makeAccount({ expiresInDays: 10 });
  refreshShouldFail = "network";
  const outcome = await tokens.refreshAccountToken(account);
  assert.equal(outcome.status, "failed");

  assert.equal(alerts.length, 1, "exactly one alert is raised");
  assert.equal(alerts[0].severity, "critical");
  assert.match(alerts[0].title, /token refresh failed for @precisionvitality/);

  const db = await getDb();
  const [row] = await db.select().from(igAccount);
  assert.equal(row.status, "error");
  assert.ok(row.lastRefreshError);
});

test("an invalidated token marks the account expired so the UI stops pretending", async () => {
  const account = await makeAccount({ expiresInDays: 10 });
  refreshShouldFail = "auth";
  const outcome = await tokens.refreshAccountToken(account);
  assert.equal(outcome.status, "failed");

  const db = await getDb();
  const [row] = await db.select().from(igAccount);
  assert.equal(row.status, "expired");
  assert.match(alerts[0].body, /reconnect/i);
});

test("token health drives the countdown the accounts screen shows", async () => {
  assert.equal(
    tokens.tokenHealth({
      tokenExpiresAt: new Date(Date.now() + 40 * 86_400_000),
      status: "connected",
    }).level,
    "ok",
  );
  assert.equal(
    tokens.tokenHealth({
      tokenExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      status: "connected",
    }).level,
    "warning",
  );
  // Anything under 7 days is visibly alarming.
  assert.equal(
    tokens.tokenHealth({
      tokenExpiresAt: new Date(Date.now() + 5 * 86_400_000),
      status: "connected",
    }).level,
    "critical",
  );
  assert.equal(
    tokens.tokenHealth({ tokenExpiresAt: null, status: "connected" }).level,
    "warning",
  );
});

test("a lapsed token is marked expired by the sweep, with an alert", async () => {
  await makeAccount({ expiresInDays: -1 });
  const changed = await tokens.markExpiredAccounts();
  assert.equal(changed, 1);
  assert.equal(alerts.at(-1)?.severity, "critical");
});
