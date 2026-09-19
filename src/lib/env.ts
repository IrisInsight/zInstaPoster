/**
 * Typed environment access.
 *
 * Everything here is app-level. Per-account Instagram tokens are deliberately
 * absent: they rotate on a ~60-day cycle and live encrypted in the database.
 */

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function required(name: string): string {
  const value = optional(name);
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

export const env = {
  get appBaseUrl(): string {
    return (
      optional("APP_BASE_URL") ??
      (optional("VERCEL_PROJECT_PRODUCTION_URL")
        ? `https://${optional("VERCEL_PROJECT_PRODUCTION_URL")}`
        : "http://localhost:3000")
    );
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },

  // ── Meta / Instagram ──────────────────────────────────────────────────
  get metaAppId(): string | undefined {
    return optional("META_APP_ID");
  },
  get metaAppSecret(): string | undefined {
    return optional("META_APP_SECRET");
  },
  /**
   * Pinned explicitly. v20.0 sunset 2026-09-24; never call unversioned.
   */
  get metaApiVersion(): string {
    return optional("META_API_VERSION") ?? "v25.0";
  },
  get metaOAuthRedirectUri(): string {
    return (
      optional("META_OAUTH_REDIRECT_URI") ??
      `${env.appBaseUrl}/api/auth/instagram/callback`
    );
  },

  // ── Model providers ───────────────────────────────────────────────────
  get anthropicApiKey(): string | undefined {
    return optional("ANTHROPIC_API_KEY");
  },
  get anthropicModel(): string {
    return optional("ANTHROPIC_MODEL") ?? "claude-opus-5";
  },
  get geminiApiKey(): string | undefined {
    return optional("GEMINI_API_KEY");
  },
  get geminiImageModel(): string {
    return optional("GEMINI_IMAGE_MODEL") ?? "gemini-3-pro-image";
  },

  // ── Database ──────────────────────────────────────────────────────────
  get databaseUrl(): string | undefined {
    return optional("DATABASE_URL");
  },
  get pgliteDir(): string {
    return optional("PGLITE_DIR") ?? "./.pglite";
  },
  get tokenEncryptionKey(): string | undefined {
    return optional("TOKEN_ENCRYPTION_KEY");
  },

  // ── Storage ───────────────────────────────────────────────────────────
  get blobToken(): string | undefined {
    return optional("BLOB_READ_WRITE_TOKEN");
  },

  // ── Scheduler ─────────────────────────────────────────────────────────
  get qstashToken(): string | undefined {
    return optional("QSTASH_TOKEN");
  },
  get qstashCurrentSigningKey(): string | undefined {
    return optional("QSTASH_CURRENT_SIGNING_KEY");
  },
  get qstashNextSigningKey(): string | undefined {
    return optional("QSTASH_NEXT_SIGNING_KEY");
  },
  get cronSecret(): string | undefined {
    return optional("CRON_SECRET");
  },

  // ── Auth ──────────────────────────────────────────────────────────────
  /**
   * The access code. It is the only thing standing between the public internet
   * and the app, so it is required in production and should be long.
   */
  get accessCode(): string {
    const code = optional("ACCESS_CODE");
    if (code) return code;
    if (env.isProduction) {
      throw new Error("ACCESS_CODE is required in production.");
    }
    // Development fallback so the app runs with an empty .env.
    return "zinstaposter";
  },

  get authSecret(): string {
    const secret = optional("AUTH_SECRET");
    if (secret) return secret;
    if (env.isProduction) {
      throw new Error("AUTH_SECRET is required in production.");
    }
    // Stable, obviously-insecure development fallback so `next dev` runs with
    // an empty .env. Never reachable in production.
    return "dev-only-insecure-auth-secret-do-not-use-in-production";
  },

  // ── Alerting ──────────────────────────────────────────────────────────
  get alertWebhookUrl(): string | undefined {
    return optional("ALERT_WEBHOOK_URL");
  },
  get resendApiKey(): string | undefined {
    return optional("RESEND_API_KEY");
  },
  get alertEmailTo(): string | undefined {
    return optional("ALERT_EMAIL_TO");
  },
  get alertEmailFrom(): string {
    return optional("ALERT_EMAIL_FROM") ?? "zinstaposter@resend.dev";
  },
} as const;

/** Chromium executable override, used by the renderer in local/dev runs. */
export function chromiumExecutableOverride(): string | undefined {
  return optional("CHROMIUM_EXECUTABLE_PATH");
}
