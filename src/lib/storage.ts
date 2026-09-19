import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * Rendered slides need a PUBLIC, non-expiring https URL: Instagram fetches the
 * image itself at publish time, unauthenticated. A signed or expiring URL is a
 * publish failure waiting to happen.
 *
 *  - BLOB_READ_WRITE_TOKEN set → Vercel Blob, public access.
 *  - otherwise               → the local disk driver, served unauthenticated
 *                              from /api/media/… so dev matches production.
 */

export interface StoredObject {
  url: string;
  pathname: string;
  bytes: number;
  contentType: string;
}

export type StorageDriver = "vercel-blob" | "local";

export function storageDriver(): StorageDriver {
  return env.blobToken ? "vercel-blob" : "local";
}

function localRoot(): string {
  return path.resolve(process.cwd(), env.localStorageDir);
}

export async function putObject(
  pathname: string,
  body: Buffer,
  contentType: string,
): Promise<StoredObject> {
  if (storageDriver() === "vercel-blob") {
    const { put } = await import("@vercel/blob");
    const result = await put(pathname, body, {
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

  const target = path.join(localRoot(), pathname);
  if (!target.startsWith(localRoot() + path.sep)) {
    throw new Error("Refusing to write outside the storage root.");
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
  await writeFile(`${target}.type`, contentType, "utf8");
  return {
    url: `${env.appBaseUrl}/api/media/${pathname}`,
    pathname,
    bytes: body.byteLength,
    contentType,
  };
}

export async function getLocalObject(
  pathname: string,
): Promise<{ body: Buffer; contentType: string } | undefined> {
  const target = path.join(localRoot(), pathname);
  if (!target.startsWith(localRoot() + path.sep)) return undefined;
  try {
    await stat(target);
  } catch {
    return undefined;
  }
  const [body, type] = await Promise.all([
    readFile(target),
    readFile(`${target}.type`, "utf8").catch(() => "application/octet-stream"),
  ]);
  return { body, contentType: type.trim() };
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
