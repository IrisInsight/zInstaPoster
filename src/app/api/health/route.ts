import { count, isNotNull } from "drizzle-orm";
import { appUser, getDb, mediaObject, post, slide, tenant } from "@/lib/db";
import { env } from "@/lib/env";
import { isJpeg, jpegDimensions } from "@/lib/render/renderer";
import { storageDriver } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Reports whether this deployment can actually publish.
 *
 * The failure this exists to catch is the quiet one. Instagram fetches every
 * slide from its own servers, over the public internet, with no credentials —
 * so a slide URL that needs a cookie, or redirects, or serves the wrong bytes,
 * looks perfectly fine in the browser and fails at publish time with an error
 * from Meta that says nothing about the cause. The check here is the same
 * fetch Meta makes: no cookies, no headers, straight at the public URL, and
 * the returned bytes parsed as a JPEG to confirm the dimensions.
 *
 * Deliberately unauthenticated, and deliberately narrow because of it: counts
 * and image dimensions only. No captions, no titles, no names, no
 * configuration beyond the base URL that every slide URL already discloses.
 */

interface MediaCheck {
  url: string;
  ok: boolean;
  status?: number;
  contentType?: string | null;
  bytes?: number;
  isJpeg?: boolean;
  width?: number;
  height?: number;
  error?: string;
}

/** Fetches a slide exactly as Instagram would: unauthenticated, from outside. */
async function checkMedia(url: string, expected: { width: number; height: number }): Promise<MediaCheck> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return { url, ok: false, status: response.status, contentType: response.headers.get("content-type") };
    }
    const body = Buffer.from(await response.arrayBuffer());
    const dimensions = jpegDimensions(body);
    const jpeg = isJpeg(body);
    return {
      url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: body.byteLength,
      isJpeg: jpeg,
      width: dimensions?.width,
      height: dimensions?.height,
      ok:
        jpeg &&
        dimensions?.width === expected.width &&
        dimensions?.height === expected.height,
    };
  } catch (error) {
    return { url, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Is this deployment reachable by something that is not signed in?
 *
 * Vercel Authentication sits in front of a *.vercel.app deployment, ahead of
 * any route, so `/api/media/…` can be perfectly unauthenticated in this
 * codebase and still answer 401 to Instagram. The app cannot see that from a
 * browser session that is already past the wall, so it asks from outside: a
 * plain fetch of its own public login page, no cookies, no headers.
 */
async function checkPublicAccess(): Promise<{
  url: string;
  status?: number;
  blocked: boolean;
  note?: string;
}> {
  const url = `${env.appBaseUrl}/login`;
  try {
    const response = await fetch(url, { cache: "no-store", redirect: "manual" });
    const blocked = response.status === 401 || response.status === 403;
    return {
      url,
      status: response.status,
      blocked,
      note: blocked
        ? "Deployment protection is answering instead of the app. Instagram cannot fetch slide images, so every publish will fail. Turn off Vercel Authentication, or serve the app from a custom domain."
        : undefined,
    };
  } catch (error) {
    return {
      url,
      blocked: true,
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET(request: Request): Promise<Response> {
  const requested = Number(new URL(request.url).searchParams.get("slides"));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 20) : 4;

  const deployment = {
    vercelEnv: process.env.VERCEL_ENV ?? null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    appBaseUrl: env.appBaseUrl,
    storageDriver: storageDriver(),
    databaseConfigured: Boolean(env.databaseUrl),
  };

  const publicAccess = await checkPublicAccess();

  try {
    const db = await getDb();

    const [[tenants], [users], [media], [slides], [rendered], byStatus] = await Promise.all([
      db.select({ n: count() }).from(tenant),
      db.select({ n: count() }).from(appUser),
      db.select({ n: count() }).from(mediaObject),
      db.select({ n: count() }).from(slide),
      db.select({ n: count() }).from(slide).where(isNotNull(slide.renderedUrl)),
      db.select({ status: post.status, n: count() }).from(post).groupBy(post.status),
    ]);

    const sample = await db
      .select({ url: slide.renderedUrl, width: slide.width, height: slide.height })
      .from(slide)
      .where(isNotNull(slide.renderedUrl))
      .limit(limit);

    const checked = await Promise.all(
      sample.map((row) =>
        checkMedia(row.url as string, { width: row.width, height: row.height }),
      ),
    );

    const posts = Object.fromEntries(byStatus.map((row) => [row.status, row.n]));
    const mediaOk = checked.length > 0 && checked.every((check) => check.ok);

    return Response.json(
      {
        ok: rendered.n > 0 && mediaOk && !publicAccess.blocked,
        deployment,
        publicAccess,
        database: {
          reachable: true,
          tenants: tenants.n,
          users: users.n,
          posts,
          slides: { total: slides.n, rendered: rendered.n },
          mediaObjects: media.n,
        },
        media: { checked, allOk: mediaOk },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        deployment,
        publicAccess,
        database: {
          reachable: false,
          error: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
