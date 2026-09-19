import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { actorFor, currentUser } from "@/lib/auth";
import { encryptSecret, verifySignature } from "@/lib/crypto";
import { getDb, igAccount } from "@/lib/db";
import { fetchProfile, InstagramApiError } from "@/lib/instagram/client";
import {
  exchangeCodeForShortLivedToken,
  exchangeForLongLivedToken,
} from "@/lib/instagram/oauth";

export const runtime = "nodejs";

function back(request: Request, params: Record<string, string>): Response {
  const url = new URL("/accounts", request.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return Response.redirect(url);
}

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.redirect(new URL("/login", request.url));

  const url = new URL(request.url);
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (error) return back(request, { error });

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back(request, { error: "Instagram did not return a code." });

  const store = await cookies();
  const expected = store.get("zip_oauth_state")?.value;
  store.delete("zip_oauth_state");
  if (!expected || expected !== state) {
    return back(request, { error: "The connection attempt expired. Try again." });
  }

  const [tenantId, nonce, signature] = state.split(".");
  if (!verifySignature(`${tenantId}.${nonce}`, signature ?? "")) {
    return back(request, { error: "That connection request could not be verified." });
  }
  if (!user.tenantIds.includes(tenantId)) {
    return back(request, { error: "You do not have access to that tenant." });
  }

  try {
    const short = await exchangeCodeForShortLivedToken(code);
    const long = await exchangeForLongLivedToken(short.accessToken);
    const profile = await fetchProfile(long.accessToken);
    const igUserId = profile.user_id ?? profile.id ?? short.userId;

    const db = await getDb();
    const [existing] = await db
      .select()
      .from(igAccount)
      .where(eq(igAccount.igUserId, igUserId));

    const values = {
      tenantId,
      igUserId,
      username: profile.username,
      accountType: profile.account_type ?? null,
      profilePictureUrl: profile.profile_picture_url ?? null,
      accessToken: encryptSecret(long.accessToken),
      tokenExpiresAt: long.expiresAt,
      lastRefreshedAt: new Date(),
      lastRefreshError: null,
      status: "connected",
    };

    if (existing) {
      await db.update(igAccount).set(values).where(eq(igAccount.id, existing.id));
    } else {
      await db.insert(igAccount).values(values);
    }

    await recordAudit({
      tenantId,
      actor: actorFor(user),
      action: existing ? "account.reconnected" : "account.connected",
      payload: {
        username: profile.username,
        accountType: profile.account_type,
        expiresAt: long.expiresAt.toISOString(),
      },
    });

    return back(request, { connected: profile.username });
  } catch (err) {
    const message =
      err instanceof InstagramApiError ? err.message : String(err);
    return back(request, { error: message });
  }
}
