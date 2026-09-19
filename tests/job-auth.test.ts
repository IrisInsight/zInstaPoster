import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

/**
 * Job endpoints publish to Instagram. They are reachable on the public
 * internet, so an unauthenticated request must never get through in
 * production, and a QStash signature must actually verify rather than merely
 * be present.
 */

// NODE_ENV is typed read-only; the verifier reads it at call time.
(process.env as Record<string, string>).NODE_ENV = "production";
process.env.CRON_SECRET = "top-secret";
process.env.QSTASH_CURRENT_SIGNING_KEY = "sig_current";
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_next";
process.env.AUTH_SECRET = "test-secret";

const { authorizeJobRequest } = await import("@/lib/scheduler/verify");

const URL_UNDER_TEST = "https://app.test/api/jobs/publish";

function request(headers: Record<string, string>, body = "{}"): Request {
  return new Request(URL_UNDER_TEST, { method: "POST", headers, body });
}

/** Builds the JWT shape Upstash signs its deliveries with. */
function qstashToken(
  key: string,
  body: string,
  overrides: Record<string, unknown> = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url",
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: "Upstash",
      sub: URL_UNDER_TEST,
      exp: now + 300,
      nbf: now,
      body: createHash("sha256").update(body).digest("base64url"),
      ...overrides,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

test("an unauthenticated job request is refused in production", async () => {
  const result = await authorizeJobRequest(request({}), "{}");
  assert.equal(result.ok, false);
});

test("a wrong shared secret is refused", async () => {
  const result = await authorizeJobRequest(
    request({ "x-cron-secret": "not-the-secret" }),
    "{}",
  );
  assert.equal(result.ok, false);
});

test("the shared secret is accepted as a header or a bearer token", async () => {
  assert.deepEqual(
    await authorizeJobRequest(request({ "x-cron-secret": "top-secret" }), "{}"),
    { ok: true, via: "secret" },
  );
  assert.deepEqual(
    await authorizeJobRequest(
      request({ authorization: "Bearer top-secret" }),
      "{}",
    ),
    { ok: true, via: "secret" },
  );
});

test("a valid QStash signature is accepted against either signing key", async () => {
  const body = JSON.stringify({ postId: "abc" });
  for (const key of ["sig_current", "sig_next"]) {
    const result = await authorizeJobRequest(
      request({ "upstash-signature": qstashToken(key, body) }, body),
      body,
    );
    assert.deepEqual(result, { ok: true, via: "qstash" }, `key ${key}`);
  }
});

test("a forged or stale QStash signature is refused", async () => {
  const body = JSON.stringify({ postId: "abc" });

  // Signed with a key we do not know.
  assert.equal(
    (
      await authorizeJobRequest(
        request({ "upstash-signature": qstashToken("attacker", body) }, body),
        body,
      )
    ).ok,
    false,
  );

  // Correctly signed, but the body was swapped afterwards.
  assert.equal(
    (
      await authorizeJobRequest(
        request({ "upstash-signature": qstashToken("sig_current", body) }, body),
        JSON.stringify({ postId: "a-different-post" }),
      )
    ).ok,
    false,
  );

  // Expired.
  assert.equal(
    (
      await authorizeJobRequest(
        request(
          {
            "upstash-signature": qstashToken("sig_current", body, {
              exp: Math.floor(Date.now() / 1000) - 60,
            }),
          },
          body,
        ),
        body,
      )
    ).ok,
    false,
  );

  // Signed for a different endpoint.
  assert.equal(
    (
      await authorizeJobRequest(
        request(
          {
            "upstash-signature": qstashToken("sig_current", body, {
              sub: "https://app.test/api/jobs/sweep",
            }),
          },
          body,
        ),
        body,
      )
    ).ok,
    false,
  );
});

test("a signature header without configured keys is refused, not ignored", async () => {
  const previous = {
    current: process.env.QSTASH_CURRENT_SIGNING_KEY,
    next: process.env.QSTASH_NEXT_SIGNING_KEY,
  };
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  try {
    const result = await authorizeJobRequest(
      request({ "upstash-signature": "a.b.c", "x-cron-secret": "top-secret" }),
      "{}",
    );
    assert.equal(result.ok, false, "a signed request must not fall back to the secret");
  } finally {
    process.env.QSTASH_CURRENT_SIGNING_KEY = previous.current;
    process.env.QSTASH_NEXT_SIGNING_KEY = previous.next;
  }
});
