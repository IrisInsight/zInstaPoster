import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { sign, verifyPassword, verifySignature } from "@/lib/crypto";
import { appUser, getDb, tenant, userTenant } from "@/lib/db";
import { env } from "@/lib/env";
import type { Actor } from "@/lib/posts/state-machine";

/**
 * A small, known set of users. Signed cookie sessions, scrypt password
 * hashes, no third-party identity provider to keep in sync.
 *
 * Everything that changes a post's state takes an Actor derived from here, so
 * "a human approved this" is a fact about the session, not a parameter a
 * caller can assert.
 */

const COOKIE = "zip_session";
const MAX_AGE_SECONDS = 60 * 60 * 12;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantIds: string[];
}

function encode(payload: { sub: string; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode(token: string): { sub: string; exp: number } | null {
  const [body, signature] = token.split(".");
  if (!body || !signature || !verifySignature(body, signature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function signIn(
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const db = await getDb();
  const [user] = await db
    .select()
    .from(appUser)
    .where(eq(appUser.email, email.trim().toLowerCase()));
  if (!user || !verifyPassword(password, user.passwordHash)) return null;

  const token = encode({
    sub: user.id,
    exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS,
  });
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return toSessionUser(user.id);
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

async function toSessionUser(userId: string): Promise<SessionUser | null> {
  const db = await getDb();
  const [user] = await db.select().from(appUser).where(eq(appUser.id, userId));
  if (!user) return null;
  const memberships = await db
    .select()
    .from(userTenant)
    .where(eq(userTenant.userId, user.id));
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantIds: memberships.map((m) => m.tenantId),
  };
}

export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  const payload = decode(token);
  if (!payload) return null;
  return toSessionUser(payload.sub);
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }
  return user as SessionUser;
}

export function actorFor(user: SessionUser): Actor {
  return { type: "human", id: user.id, label: `${user.name} <${user.email}>` };
}

export async function assertTenantAccess(
  user: SessionUser,
  tenantId: string,
): Promise<void> {
  if (!user.tenantIds.includes(tenantId)) {
    throw new Error("You do not have access to that tenant.");
  }
}

export async function tenantsForUser(user: SessionUser) {
  const db = await getDb();
  const rows = await db.select().from(tenant);
  return rows.filter((t) => user.tenantIds.includes(t.id));
}
