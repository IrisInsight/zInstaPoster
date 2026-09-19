import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { env } from "@/lib/env";

/**
 * AES-256-GCM at rest for Instagram access tokens.
 *
 * Ciphertext layout: v1.<iv b64url>.<authTag b64url>.<ciphertext b64url>
 * The version prefix exists so the key can be rotated without guessing at
 * what an old row contains.
 */

const VERSION = "v1";

function key(): Buffer {
  const raw = env.tokenEncryptionKey;
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32",
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 32) return decoded;
  // Accept a non-base64 passphrase too, but stretch it rather than truncating.
  return scryptSync(raw, "zinstaposter-token-encryption", 32);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error("Unrecognised ciphertext format for stored token.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Last 4 characters of a token, for display. Never render more than this. */
export function tokenHint(plaintext: string): string {
  return `…${plaintext.slice(-4)}`;
}

export function sign(value: string, secret = env.authSecret): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function verifySignature(
  value: string,
  signature: string,
  secret = env.authSecret,
): boolean {
  const expected = Buffer.from(sign(value, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Constant-time string comparison, for secrets supplied by a caller. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
