import { sweepDuePosts } from "@/lib/scheduler";
import { authorizeJobRequest } from "@/lib/scheduler/verify";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Safety net for the scheduler: publishes anything whose scheduled time has
 * passed but whose job never fired. Idempotent.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  const auth = await authorizeJobRequest(request, raw);
  if (!auth.ok) return new Response(auth.reason, { status: 401 });

  const results = await sweepDuePosts();
  return Response.json({ swept: results.length, results });
}

export const GET = POST;
