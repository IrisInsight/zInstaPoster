import assert from "node:assert/strict";
import test from "node:test";
import { secretsMatch } from "@/lib/crypto";

/**
 * Access is a single shared code. These cover the properties that matter for
 * something that is the whole of an app's front door.
 */

test("the code comparison rejects near misses and is length-safe", () => {
  assert.equal(secretsMatch("correct-horse", "correct-horse"), true);
  assert.equal(secretsMatch("correct-horse", "correct-hors"), false);
  assert.equal(secretsMatch("correct-horse", "correct-horsf"), false);
  assert.equal(secretsMatch("correct-horse", "Correct-Horse"), false);
  assert.equal(secretsMatch("", ""), true);
  assert.equal(secretsMatch("a", ""), false, "differing lengths must not throw");
  assert.equal(secretsMatch("", "a"), false);
});

test("the audit label names the seat, not a person it cannot identify", async () => {
  const { actorFor } = await import("@/lib/auth");
  const actor = actorFor({
    id: "u1",
    email: null,
    name: "Practice Owner",
    role: "owner",
    tenantIds: [],
  });
  assert.deepEqual(actor, {
    type: "human",
    id: "u1",
    label: "Practice Owner",
  });
  assert.ok(
    !actor.label.includes("@"),
    "a shared code cannot attribute an approval to an email address",
  );
});

test("a production deployment cannot run without a code", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousCode = process.env.ACCESS_CODE;
  (process.env as Record<string, string>).NODE_ENV = "production";
  delete process.env.ACCESS_CODE;
  try {
    const { env } = await import("@/lib/env");
    assert.throws(() => env.accessCode, /ACCESS_CODE is required in production/);
  } finally {
    (process.env as Record<string, string>).NODE_ENV = previousEnv ?? "test";
    if (previousCode !== undefined) process.env.ACCESS_CODE = previousCode;
  }
});

test("development falls back to a known code so an empty .env still runs", async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousCode = process.env.ACCESS_CODE;
  (process.env as Record<string, string>).NODE_ENV = "development";
  delete process.env.ACCESS_CODE;
  try {
    const { env } = await import("@/lib/env");
    assert.equal(env.accessCode, "zinstaposter");
  } finally {
    (process.env as Record<string, string>).NODE_ENV = previousEnv ?? "test";
    if (previousCode !== undefined) process.env.ACCESS_CODE = previousCode;
  }
});
