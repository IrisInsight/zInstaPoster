import { eq } from "drizzle-orm";
import { env } from "@/lib/env";

/**
 * Rendered slides need a PUBLIC, non-expiring https URL: Instagram fetches the
 * image itself at publish time, unauthenticated. A signed or expiring URL is a
 * publish failure waiting to happen.
 *
 *  - BLOB_READ_WRITE_TOKEN set → Vercel Blob, public access, served by its CDN.
 *  - otherwise                 → the database, served from /api/media/… by this
 *                                app, which is a public https URL like any
 *                                other. Slower and not on a CDN, but it needs
 *                                no second service, and it behaves the same in
 *                                development as in production.
 */

export interface StoredObject {
  url: string;
  pathname: string;
  bytes: number;
  contentType: string;
}

export type StorageDriver = "vercel-blob" | "database";

export function storageDriver(): StorageDriver {
  return env.blobToken ? "vercel-blob" : "database";
}

export async function putObject(
  pathname: string,
  body: Buffer,
  contentType: string,
): Promise<StoredObject> {
  const clean = pathname.replace(/^\/+/, "");

  if (storageDriver() === "vercel-blob") {
    const { put } = await import("@vercel/blob");
    const result = await put(clean, body, {
      access: "public",
      contentType,
      token: env.blobToken,
      addRandomSuffix: false,
      allowOverwrite: true,
      // Meta fetches this at publish time; it must not be cached as a 404 or
      // expire before then.
      cacheControlMaxAge: 31_536_000,
    });
    return {
      url: result.url,
      pathname: result.pathname,
      bytes: body.byteLength,
      contentType,
    };
  }

  const { getDb, mediaObject } = await import("@/lib/db");
  const db = await getDb();
  const row = {
    pathname: clean,
    contentType,
    bytes: body.byteLength,
    data: body.toString("base64"),
  };
  await db
    .insert(mediaObject)
    .values(row)
    .onConflictDoUpdate({ target: mediaObject.pathname, set: row });

  return {
    url: `${env.appBaseUrl.replace(/\/+$/, "")}/api/media/${clean}`,
    pathname: clean,
    bytes: body.byteLength,
    contentType,
  };
}

export async function getObject(
  pathname: string,
): Promise<{ body: Buffer; contentType: string } | undefined> {
  const { getDb, mediaObject } = await import("@/lib/db");
  const db = await getDb();
  const [row] = await db
    .select()
    .from(mediaObject)
    .where(eq(mediaObject.pathname, pathname.replace(/^\/+/, "")));
  if (!row) return undefined;
  return {
    body: Buffer.from(row.data, "base64"),
    contentType: row.contentType,
  };
}

/**
 * Meta fetches slide URLs over the public internet. A localhost URL will never
 * resolve for them, so the publish path checks this before creating containers
 * rather than after a container silently errors.
 */
export function isPubliclyFetchable(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname;
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    return host.includes(".");
  } catch {
    return false;
  }
}
