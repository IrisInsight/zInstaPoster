import { actorFor, assertTenantAccess, currentUser } from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant-context";
import { generatePost, type PipelineEvent } from "@/lib/content/pipeline";
import { inferTemplate } from "@/lib/content/claude";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Streams pipeline progress as newline-delimited SSE frames. The UI shows each
 * step completing and the headlines arriving, because a 20–60 second spinner
 * reads as a hang.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return new Response("Not signed in.", { status: 401 });

  const context = await getTenantContext(user);
  if (!context) return new Response("No tenant.", { status: 400 });
  await assertTenantAccess(user, context.active.id);

  const body = (await request.json()) as {
    prompt?: string;
    template?: string;
    igAccountId?: string | null;
    reference?: string | null;
  };
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return new Response("A prompt is required.", { status: 400 });

  // An explicit pick from the compose screen wins; otherwise the model infers
  // it from the prompt, and falls back to the tenant's primary template.
  const templateName =
    body.template && context.config.templates?.[body.template]
      ? body.template
      : (await inferTemplate({ tenant: context.config, prompt })).template;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: PipelineEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The client went away mid-generation; the post is still written.
        }
      };

      try {
        await generatePost({
          tenant: context.config,
          tenantId: context.active.id,
          templateName,
          prompt,
          reference: body.reference ?? null,
          igAccountId: body.igAccountId ?? null,
          actor: actorFor(user),
          emit: send,
          signal: request.signal,
        });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
