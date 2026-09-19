import { getLocalObject, storageDriver } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The local storage driver's public face.
 *
 * Deliberately unauthenticated: Instagram fetches slide URLs itself at publish
 * time, over the public internet, with no credentials. A signed or gated URL
 * here would work in the browser and fail at publish, which is the worst kind
 * of bug to find in production.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  if (storageDriver() !== "local") {
    return new Response("Not found", { status: 404 });
  }
  const { path } = await params;
  const object = await getLocalObject(path.join("/"));
  if (!object) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(object.body), {
    headers: {
      "content-type": object.contentType,
      "content-length": String(object.body.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
