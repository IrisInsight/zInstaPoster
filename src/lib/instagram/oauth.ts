import { env, required } from "@/lib/env";
import {
  AUTHORIZE_URL,
  GRAPH_HOST,
  LONG_LIVED_TOKEN_DAYS,
  OAUTH_HOST,
  tokenRequest,
} from "./client";

/**
 * Instagram Login, not Facebook Login for Business: no Facebook Page in the
 * chain. The Meta app stays in development mode and each account is added as
 * an Instagram Tester, which is why no App Review is needed.
 */
export const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
] as const;

export function authorizeUrl(state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", required("META_APP_ID"));
  url.searchParams.set("redirect_uri", env.metaOAuthRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

interface ShortLivedResponse {
  access_token: string;
  user_id: number | string;
  permissions?: string[];
}

export async function exchangeCodeForShortLivedToken(
  code: string,
): Promise<{ accessToken: string; userId: string }> {
  const body = await tokenRequest<ShortLivedResponse>(
    `${OAUTH_HOST}/oauth/access_token`,
    {
      method: "POST",
      params: {
        client_id: required("META_APP_ID"),
        client_secret: required("META_APP_SECRET"),
        grant_type: "authorization_code",
        redirect_uri: env.metaOAuthRedirectUri,
        // Meta appends #_ to the code on the redirect; sending it back fails.
        code: code.replace(/#_$/, ""),
      },
    },
  );
  return { accessToken: body.access_token, userId: String(body.user_id) };
}

export interface LongLivedToken {
  accessToken: string;
  expiresAt: Date;
  expiresInSeconds: number;
}

export async function exchangeForLongLivedToken(
  shortLivedToken: string,
): Promise<LongLivedToken> {
  const body = await tokenRequest<{
    access_token: string;
    token_type: string;
    expires_in: number;
  }>(`${GRAPH_HOST}/access_token`, {
    method: "GET",
    params: {
      grant_type: "ig_exchange_token",
      client_secret: required("META_APP_SECRET"),
      access_token: shortLivedToken,
    },
  });
  return toLongLived(body.access_token, body.expires_in);
}

export async function refreshLongLivedToken(
  longLivedToken: string,
): Promise<LongLivedToken> {
  const body = await tokenRequest<{
    access_token: string;
    token_type: string;
    expires_in: number;
  }>(`${GRAPH_HOST}/refresh_access_token`, {
    method: "GET",
    params: {
      grant_type: "ig_refresh_token",
      access_token: longLivedToken,
    },
  });
  return toLongLived(body.access_token, body.expires_in);
}

function toLongLived(accessToken: string, expiresIn: number): LongLivedToken {
  // Trust what the API returns; fall back to the documented 60 days only when
  // the field is missing.
  const seconds =
    typeof expiresIn === "number" && expiresIn > 0
      ? expiresIn
      : LONG_LIVED_TOKEN_DAYS * 24 * 60 * 60;
  return {
    accessToken,
    expiresInSeconds: seconds,
    expiresAt: new Date(Date.now() + seconds * 1000),
  };
}

export function oauthConfigured(): boolean {
  return Boolean(env.metaAppId && env.metaAppSecret);
}
