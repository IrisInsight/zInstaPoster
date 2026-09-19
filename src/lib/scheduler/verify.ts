import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Job endpoints are internal. Two ways in, both required to be explicit:
 *   - QStash's signed request (verified against both signing keys), or
 *   - the shared CRON_SECRET header, for the local driver and manual runs.
 */

export async function authorizeJobRequest(
  request: Request,
  rawBody: string,
): Promise<{ ok: true; via: "qstash" | "secret" } | { ok: false; reason: string }> {
  const signature = request.headers.get("upstash-signature");
  if (signature) {
    const keys = [env.qstashCurrentSigningKey, env.qstashNextSigningKey].filter(
      (k): k is string => Boolean(k),
    );
    if (keys.length === 0) {
      return { ok: false, reason: "QStash signature present but no signing keys configured." };
    }
    for (const key of keys) {
      if (verifyQstash(signature, rawBody, key, request.url)) {
        return { ok: true, via: "qstash" };
      }
    }
    return { ok: false, reason: "QStash signature did not verify." };
  }

  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (env.cronSecret && provided) {
    const a = Buffer.from(provided);
    const b = Buffer.from(env.cronSecret);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return { ok: true, via: "secret" };
    }
  }
  if (!env.cronSecret && !env.isProduction) {
    // Local development with nothing configured: allow, but say so.
    return { ok: true, via: "secret" };
  }
  return { ok: false, reason: "Missing or invalid job credentials." };
}

/** Upstash signs a JWT whose body claim is a SHA-256 of the request body. */
function verifyQstash(
  token: string,
  body: string,
  signingKey: string,
  url: string,
): boolean {
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !signatureB64) return false;

  const expected = createHmac("sha256", signingKey)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureB64);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as { exp?: number; nbf?: number; sub?: string; body?: string };
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now > payload.exp) return false;
    if (payload.nbf && now < payload.nbf - 60) return false;
    if (payload.sub && new URL(payload.sub).pathname !== new URL(url).pathname) {
      return false;
    }
    if (payload.body) {
      // The body claim is a base64 SHA-256 of the raw request body.
      const sha = createHash("sha256").update(body).digest("base64url");
      if (sha.replace(/=+$/, "") !== payload.body.replace(/[=]+$/, "").replace(/\+/g, "-").replace(/\//g, "_")) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
