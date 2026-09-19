import { cookies } from "next/headers";
import { currentUser } from "@/lib/auth";
import { randomToken, sign } from "@/lib/crypto";
import { authorizeUrl, oauthConfigured } from "@/lib/instagram/oauth";
import { getTenantContext } from "@/lib/tenant-context";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.redirect(new URL("/login", request.url));
  if (!oauthConfigured()) {
    return new Response(
      "META_APP_ID and META_APP_SECRET are not set, so no account can be connected.",
      { status: 400 },
    );
  }

  const context = await getTenantContext(user);
  if (!context) return new Response("No tenant.", { status: 400 });

  // The state is signed and bound to the tenant, so the callback knows which
  // tenant the returning account belongs to without trusting the query string.
  const nonce = randomToken(16);
  const payload = `${context.active.id}.${nonce}`;
  const state = `${payload}.${sign(payload)}`;

  const store = await cookies();
  store.set("zip_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  return Response.redirect(authorizeUrl(state));
}
