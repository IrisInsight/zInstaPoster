import { env } from "@/lib/env";

/**
 * Instagram API with Instagram Login.
 *
 * Verified against Meta's current documentation:
 *   authorize          https://www.instagram.com/oauth/authorize
 *   code → short token POST https://api.instagram.com/oauth/access_token
 *   short → long token GET  https://graph.instagram.com/access_token
 *                           ?grant_type=ig_exchange_token
 *   refresh            GET  https://graph.instagram.com/refresh_access_token
 *                           ?grant_type=ig_refresh_token
 *   graph calls        https://graph.instagram.com/{version}/...
 *
 * Long-lived tokens last ~60 days, can be refreshed once they are at least 24
 * hours old, and die permanently if 60 days pass without a refresh.
 *
 * Every graph call is version-pinned. v20.0 sunset on 2026-09-24 and an
 * unversioned call silently follows Meta's default, which is not a thing to
 * discover in production.
 */

export const GRAPH_HOST = "https://graph.instagram.com";
export const OAUTH_HOST = "https://api.instagram.com";
export const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";

/** Confirmed TTL for a long-lived token, in days. */
export const LONG_LIVED_TOKEN_DAYS = 60;
/** A long-lived token can only be refreshed once it is this old. */
export const REFRESH_MIN_AGE_HOURS = 24;

export class InstagramApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly fbtraceId?: string;
  readonly raw: unknown;

  constructor(input: {
    message: string;
    status: number;
    code?: number;
    subcode?: number;
    fbtraceId?: string;
    raw: unknown;
  }) {
    super(input.message);
    this.name = "InstagramApiError";
    this.status = input.status;
    this.code = input.code;
    this.subcode = input.subcode;
    this.fbtraceId = input.fbtraceId;
    this.raw = input.raw;
  }

  /** Meta's own text, verbatim — what the post detail screen shows on failure. */
  get verbatim(): string {
    return typeof this.raw === "string"
      ? this.raw
      : JSON.stringify(this.raw, null, 2);
  }

  /** An expired, revoked or invalidated token. The account must reconnect. */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === 190 || this.code === 102;
  }

  get isRateLimit(): boolean {
    return this.status === 429 || this.code === 4 || this.code === 32 || this.code === 613;
  }
}

async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function throwIfError(response: Response, body: unknown): void {
  if (response.ok) return;
  const error = (body as { error?: Record<string, unknown> })?.error ?? {};
  throw new InstagramApiError({
    message:
      typeof error.message === "string"
        ? error.message
        : `Instagram API returned ${response.status}`,
    status: response.status,
    code: typeof error.code === "number" ? error.code : undefined,
    subcode:
      typeof error.error_subcode === "number" ? error.error_subcode : undefined,
    fbtraceId:
      typeof error.fbtrace_id === "string" ? error.fbtrace_id : undefined,
    raw: body,
  });
}

/** Version-pinned GET against the graph host. */
export async function graphGet<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${GRAPH_HOST}/${env.metaApiVersion}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { method: "GET", cache: "no-store" });
  const body = await parse(response);
  throwIfError(response, body);
  return body as T;
}

/** Version-pinned POST against the graph host, form-encoded as Meta expects. */
export async function graphPost<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = `${GRAPH_HOST}/${env.metaApiVersion}/${path.replace(/^\//, "")}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    cache: "no-store",
  });
  const body = await parse(response);
  throwIfError(response, body);
  return body as T;
}

/**
 * The OAuth token endpoints are not version-prefixed — they live outside the
 * graph versioning scheme. Kept separate so nobody "fixes" that later.
 */
export async function tokenRequest<T>(
  url: string,
  init: { method: "GET" | "POST"; params: Record<string, string> },
): Promise<T> {
  const target = new URL(url);
  let response: Response;
  if (init.method === "GET") {
    for (const [key, value] of Object.entries(init.params)) {
      target.searchParams.set(key, value);
    }
    response = await fetch(target, { method: "GET", cache: "no-store" });
  } else {
    response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(init.params).toString(),
      cache: "no-store",
    });
  }
  const body = await parse(response);
  throwIfError(response, body);
  return body as T;
}

export interface IgProfile {
  user_id?: string;
  id?: string;
  username: string;
  account_type?: string;
  profile_picture_url?: string;
  media_count?: number;
}

export async function fetchProfile(accessToken: string): Promise<IgProfile> {
  return graphGet<IgProfile>("me", {
    fields: "user_id,username,account_type,profile_picture_url,media_count",
    access_token: accessToken,
  });
}

export interface PublishingLimit {
  config?: { quota_total?: number; quota_duration?: number };
  quota_usage?: number;
}

/** Today's publish count against the 100-per-rolling-24h cap. */
export async function fetchPublishingLimit(input: {
  igUserId: string;
  accessToken: string;
}): Promise<PublishingLimit> {
  const response = await graphGet<{ data?: PublishingLimit[] }>(
    `${input.igUserId}/content_publishing_limit`,
    { fields: "config,quota_usage", access_token: input.accessToken },
  );
  return response.data?.[0] ?? {};
}
