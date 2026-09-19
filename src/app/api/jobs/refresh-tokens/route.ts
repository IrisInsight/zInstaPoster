import { markExpiredAccounts, refreshAllTokens } from "@/lib/instagram/tokens";
import { authorizeJobRequest } from "@/lib/scheduler/verify";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Token refresh sweep. Run this daily — well before expiry, never at expiry.
 * Failures alert a human from inside refreshAllTokens; this endpoint just
 * reports what happened.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  const auth = await authorizeJobRequest(request, raw);
  if (!auth.ok) return new Response(auth.reason, { status: 401 });

  const force = new URL(request.url).searchParams.get("force") === "true";
  const outcomes = await refreshAllTokens({ force });
  const expired = await markExpiredAccounts();

  return Response.json({
    refreshed: outcomes.filter((o) => o.status === "refreshed").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    markedExpired: expired,
    outcomes,
  });
}

export const GET = POST;
