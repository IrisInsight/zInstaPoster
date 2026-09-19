import { publishPostById } from "@/lib/instagram/publish";
import { authorizeJobRequest } from "@/lib/scheduler/verify";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * The scheduled publish job. All three Instagram steps run here, at fire time,
 * because a media container expires 24 hours after it is created — nothing can
 * be prepared in advance at approval time.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  const auth = await authorizeJobRequest(request, raw);
  if (!auth.ok) return new Response(auth.reason, { status: 401 });

  let postId: string | undefined;
  try {
    postId = (JSON.parse(raw) as { postId?: string }).postId;
  } catch {
    return new Response("Invalid JSON body.", { status: 400 });
  }
  if (!postId) return new Response("postId is required.", { status: 400 });

  try {
    const result = await publishPostById({
      postId,
      actorLabel: `scheduler (${auth.via})`,
    });
    return Response.json(result, { status: result.status === "failed" ? 500 : 200 });
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
