import Link from "next/link";
import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant-context";
import { getDb, igAccount } from "@/lib/db";
import { tokenHealth } from "@/lib/instagram/tokens";
import { oauthConfigured } from "@/lib/instagram/oauth";
import { remainingQuota } from "@/lib/instagram/publish";
import { alertingConfigured } from "@/lib/alerts";
import { formatInZone, relativeTime } from "@/lib/time";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const user = await requireUser();
  const context = await getTenantContext(user);
  const params = await searchParams;
  if (!context) return null;

  const db = await getDb();
  const accounts = await db
    .select()
    .from(igAccount)
    .where(eq(igAccount.tenantId, context.active.id));

  const withHealth = await Promise.all(
    accounts.map(async (account) => ({
      account,
      health: tokenHealth(account),
      quota: await remainingQuota(account).catch(() => ({
        used: 0,
        total: 100,
        source: "local" as const,
      })),
    })),
  );

  return (
    <div className="mx-auto max-w-[900px]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">Accounts</h1>
          <p className="text-[12.5px] text-[var(--color-muted)]">
            {context.active.name} · Instagram Login, app in development mode,
            API {env.metaApiVersion}
          </p>
        </div>
        <Link
          href="/api/auth/instagram/start"
          prefetch={false}
          className={`rounded-md px-3 py-1.5 text-[13px] font-medium text-white ${
            oauthConfigured()
              ? "bg-[var(--color-ink)]"
              : "pointer-events-none bg-[var(--color-line-strong)]"
          }`}
        >
          Connect account
        </Link>
      </div>

      {params.connected && (
        <Banner tone="ok">Connected @{params.connected}.</Banner>
      )}
      {params.error && <Banner tone="danger">{params.error}</Banner>}
      {!oauthConfigured() && (
        <Banner tone="warn">
          META_APP_ID and META_APP_SECRET are not set, so no account can be
          connected yet. The redirect URI to register is{" "}
          <code className="font-mono">{env.metaOAuthRedirectUri}</code>.
        </Banner>
      )}
      {!alertingConfigured() && (
        <Banner tone="warn">
          No alerting is configured. A silent token-refresh failure stops
          publishing and nobody finds out. Set ALERT_WEBHOOK_URL, or RESEND_API_KEY
          with ALERT_EMAIL_TO.
        </Banner>
      )}

      {withHealth.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-line-strong)] bg-[var(--color-surface)] px-6 py-12 text-center">
          <p className="text-[14px] font-medium">No account connected</p>
          <p className="mx-auto mt-1 max-w-[460px] text-[13px] text-[var(--color-muted)]">
            The account must be public, Business or Creator, and added as an
            Instagram Tester on the Meta app before it can accept the invite.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {withHealth.map(({ account, health, quota }) => (
            <article
              key={account.id}
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3.5"
            >
              <div className="flex items-start gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={account.profilePictureUrl ?? "/brand/mark.svg"}
                  alt=""
                  className="size-10 shrink-0 rounded-full border border-[var(--color-line)] object-cover"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[14px] font-semibold">@{account.username}</h2>
                    <span className="rounded border border-[var(--color-line)] px-1.5 py-[1px] text-[10.5px] uppercase tracking-wide text-[var(--color-muted)]">
                      {account.accountType ?? "unknown"}
                    </span>
                    <StatusDot status={account.status} />
                  </div>

                  <dl className="mt-2 grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2">
                    <Row
                      label="Last refreshed"
                      value={
                        account.lastRefreshedAt
                          ? `${formatInZone(account.lastRefreshedAt, context.config.timezone)} · ${relativeTime(account.lastRefreshedAt)}`
                          : "never"
                      }
                    />
                    <Row
                      label="Token expires"
                      value={
                        account.tokenExpiresAt
                          ? formatInZone(account.tokenExpiresAt, context.config.timezone)
                          : "unknown"
                      }
                      tone={health.level}
                    />
                    <Row
                      label="Countdown"
                      value={
                        health.daysLeft === null
                          ? "unknown"
                          : health.daysLeft <= 0
                            ? "expired"
                            : `${health.daysLeft.toFixed(1)} days`
                      }
                      tone={health.level}
                    />
                    <Row
                      label="Published today"
                      value={`${quota.used} / ${quota.total}${quota.source === "local" ? " (local count)" : ""}`}
                      tone={quota.used >= quota.total ? "critical" : "ok"}
                    />
                  </dl>

                  {account.lastRefreshError && (
                    <p className="mt-2 rounded border border-[#efc0b8] bg-[var(--color-danger-soft)] px-2 py-1.5 font-mono text-[11.5px] leading-snug text-[var(--color-danger)]">
                      {account.lastRefreshError}
                    </p>
                  )}
                </div>

                <Link
                  href="/api/auth/instagram/start"
                  prefetch={false}
                  className="shrink-0 rounded-md border border-[var(--color-line-strong)] px-2.5 py-1 text-[12.5px] font-medium"
                >
                  Reconnect
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}

      <p className="mt-4 text-[11.5px] leading-relaxed text-[var(--color-muted)]">
        Tokens are stored encrypted in the database, never in environment
        variables, and are refreshed on a schedule well before the ~60 day
        expiry. A refresh failure alerts a human immediately.
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warning" | "critical";
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-[110px] shrink-0 text-[var(--color-faint)]">{label}</dt>
      <dd
        className={`tabular ${
          tone === "critical"
            ? "font-semibold text-[var(--color-danger)]"
            : tone === "warning"
              ? "font-medium text-[var(--color-warn)]"
              : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const tone =
    status === "connected"
      ? "bg-[var(--color-ok)]"
      : status === "expiring"
        ? "bg-[var(--color-warn)]"
        : "bg-[var(--color-danger)]";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--color-muted)]">
      <span className={`size-1.5 rounded-full ${tone}`} />
      {status}
    </span>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "danger";
  children: React.ReactNode;
}) {
  const styles = {
    ok: "border-[#bcd8c6] bg-[var(--color-ok-soft)] text-[var(--color-ok)]",
    warn: "border-[#e8d6a8] bg-[var(--color-warn-soft)] text-[var(--color-warn)]",
    danger: "border-[#efc0b8] bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  };
  return (
    <p className={`mb-3 rounded-md border px-3 py-2 text-[12.5px] ${styles[tone]}`}>
      {children}
    </p>
  );
}
