import { eq } from "drizzle-orm";
import { sendAlert } from "@/lib/alerts";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getDb, igAccount, type IgAccount } from "@/lib/db";
import { recordAudit, systemActor } from "@/lib/audit";
import { InstagramApiError, REFRESH_MIN_AGE_HOURS } from "./client";
import { refreshLongLivedToken } from "./oauth";

/**
 * Token lifecycle.
 *
 * Refresh runs on a schedule well before expiry, not at expiry, and a failure
 * alerts a human — a silent failure means publishing stops and nobody notices
 * until a post does not go up.
 */

/** Refresh once a token is inside this many days of expiry. */
export const REFRESH_WINDOW_DAYS = 14;
/** Under this many days remaining, the UI shows the account as alarming. */
export const ALARM_WINDOW_DAYS = 7;

export function decryptToken(account: Pick<IgAccount, "accessToken">): string {
  return decryptSecret(account.accessToken);
}

export function daysUntilExpiry(account: Pick<IgAccount, "tokenExpiresAt">): number | null {
  if (!account.tokenExpiresAt) return null;
  return (account.tokenExpiresAt.getTime() - Date.now()) / 86_400_000;
}

export function tokenHealth(account: Pick<IgAccount, "tokenExpiresAt" | "status">): {
  level: "ok" | "warning" | "critical";
  daysLeft: number | null;
} {
  const daysLeft = daysUntilExpiry(account);
  if (account.status === "expired" || account.status === "revoked") {
    return { level: "critical", daysLeft };
  }
  if (daysLeft === null) return { level: "warning", daysLeft };
  if (daysLeft <= 0) return { level: "critical", daysLeft };
  if (daysLeft <= ALARM_WINDOW_DAYS) return { level: "critical", daysLeft };
  if (daysLeft <= REFRESH_WINDOW_DAYS) return { level: "warning", daysLeft };
  return { level: "ok", daysLeft };
}

export function isRefreshable(account: Pick<IgAccount, "lastRefreshedAt" | "createdAt">): boolean {
  const anchor = account.lastRefreshedAt ?? account.createdAt;
  const ageHours = (Date.now() - anchor.getTime()) / 3_600_000;
  return ageHours >= REFRESH_MIN_AGE_HOURS;
}

export async function storeToken(input: {
  accountId: string;
  accessToken: string;
  expiresAt: Date;
}): Promise<void> {
  const db = await getDb();
  await db
    .update(igAccount)
    .set({
      accessToken: encryptSecret(input.accessToken),
      tokenExpiresAt: input.expiresAt,
      lastRefreshedAt: new Date(),
      lastRefreshError: null,
      status: "connected",
    })
    .where(eq(igAccount.id, input.accountId));
}

export interface RefreshOutcome {
  accountId: string;
  username: string;
  status: "refreshed" | "skipped" | "failed";
  detail: string;
  expiresAt?: Date;
}

export async function refreshAccountToken(
  account: IgAccount,
  options: { force?: boolean } = {},
): Promise<RefreshOutcome> {
  const db = await getDb();
  const daysLeft = daysUntilExpiry(account);

  if (!options.force && daysLeft !== null && daysLeft > REFRESH_WINDOW_DAYS) {
    return {
      accountId: account.id,
      username: account.username,
      status: "skipped",
      detail: `${daysLeft.toFixed(1)} days remaining, outside the ${REFRESH_WINDOW_DAYS}-day window`,
    };
  }

  if (!isRefreshable(account)) {
    return {
      accountId: account.id,
      username: account.username,
      status: "skipped",
      detail: `Token is under ${REFRESH_MIN_AGE_HOURS}h old and cannot be refreshed yet`,
    };
  }

  try {
    const current = decryptToken(account);
    const refreshed = await refreshLongLivedToken(current);
    await storeToken({
      accountId: account.id,
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
    });
    await recordAudit({
      tenantId: account.tenantId,
      actor: systemActor("token-refresh"),
      action: "token.refreshed",
      payload: {
        username: account.username,
        expiresAt: refreshed.expiresAt.toISOString(),
      },
    });
    return {
      accountId: account.id,
      username: account.username,
      status: "refreshed",
      detail: `Valid until ${refreshed.expiresAt.toISOString()}`,
      expiresAt: refreshed.expiresAt,
    };
  } catch (error) {
    const message =
      error instanceof InstagramApiError ? error.verbatim : String(error);
    const authError =
      error instanceof InstagramApiError ? error.isAuthError : false;

    await db
      .update(igAccount)
      .set({
        lastRefreshError: message.slice(0, 2000),
        status: authError ? "expired" : "error",
      })
      .where(eq(igAccount.id, account.id));

    await recordAudit({
      tenantId: account.tenantId,
      actor: systemActor("token-refresh"),
      action: "token.refresh_failed",
      payload: { username: account.username, error: message.slice(0, 2000) },
    });

    // This is the alert that keeps publishing alive.
    await sendAlert({
      severity: "critical",
      title: `Instagram token refresh failed for @${account.username}`,
      body: [
        authError
          ? "The token is no longer valid. The account owner has to reconnect before anything can publish."
          : "The refresh call failed. Publishing will stop when the current token expires.",
        daysLeft !== null ? `Days until expiry: ${daysLeft.toFixed(1)}.` : "",
        message.slice(0, 500),
      ]
        .filter(Boolean)
        .join(" "),
      context: {
        accountId: account.id,
        username: account.username,
        tenantId: account.tenantId,
        expiresAt: account.tokenExpiresAt?.toISOString(),
      },
    });

    return {
      accountId: account.id,
      username: account.username,
      status: "failed",
      detail: message.slice(0, 500),
    };
  }
}

/** Sweeps every account. Run this on a schedule well before expiry. */
export async function refreshAllTokens(options: { force?: boolean } = {}): Promise<
  RefreshOutcome[]
> {
  const db = await getDb();
  const accounts = await db.select().from(igAccount);
  const outcomes: RefreshOutcome[] = [];
  for (const account of accounts) {
    outcomes.push(await refreshAccountToken(account, options));
  }

  const failed = outcomes.filter((o) => o.status === "failed");
  if (failed.length > 1) {
    await sendAlert({
      severity: "critical",
      title: `${failed.length} Instagram token refreshes failed`,
      body: failed.map((f) => `@${f.username}: ${f.detail}`).join(" | "),
    });
  }
  return outcomes;
}

/** Marks accounts whose tokens have lapsed, so the UI stops pretending. */
export async function markExpiredAccounts(): Promise<number> {
  const db = await getDb();
  const accounts = await db.select().from(igAccount);
  let changed = 0;
  for (const account of accounts) {
    const daysLeft = daysUntilExpiry(account);
    if (daysLeft !== null && daysLeft <= 0 && account.status !== "expired") {
      await db
        .update(igAccount)
        .set({ status: "expired" })
        .where(eq(igAccount.id, account.id));
      changed += 1;
      await sendAlert({
        severity: "critical",
        title: `Instagram token expired for @${account.username}`,
        body: "Publishing for this account is stopped until the owner reconnects.",
        context: { accountId: account.id, tenantId: account.tenantId },
      });
    }
  }
  return changed;
}
