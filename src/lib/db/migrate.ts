/**
 * Applies drizzle/*.sql to a real Postgres, in journal order.
 *
 * `drizzle-kit push` diffs the schema and is the right tool at a laptop; a
 * deployment applies the reviewed SQL instead, so what runs against the
 * production database is the same statements that were committed and can be
 * read back later.
 *
 * Two details matter against Neon:
 *
 *  - DDL goes over a direct connection. The pooled URL runs through PgBouncer
 *    in transaction mode, where migrations can fail in ways that are painful
 *    to diagnose, so DATABASE_URL_UNPOOLED is preferred when it is present.
 *  - An advisory lock serialises concurrent deploys. Two builds finishing at
 *    the same time would otherwise race on the migrations table.
 */
import { env } from "@/lib/env";

/** Any 64-bit constant; it only has to be the same in every deploy. */
const MIGRATION_LOCK_KEY = 4_027_180_915;

export interface MigrationOutcome {
  /** The host that was migrated, for the log. Credentials are never included. */
  host: string;
  pooled: boolean;
}

/** The direct connection when Neon exposes one, else whatever is configured. */
export function migrationUrl(): string {
  const unpooled = process.env.DATABASE_URL_UNPOOLED;
  if (unpooled && unpooled.length > 0) return unpooled;
  const url = env.databaseUrl;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set, so there is no database to migrate. The embedded PGlite database is for local development only.",
    );
  }
  return url;
}

export async function migrateToLatest(): Promise<MigrationOutcome> {
  const url = migrationUrl();
  const [{ drizzle }, { migrate }, postgres] = await Promise.all([
    import("drizzle-orm/postgres-js"),
    import("drizzle-orm/postgres-js/migrator"),
    import("postgres"),
  ]);

  // One connection: the advisory lock is held on the session that takes it.
  const client = postgres.default(url, { prepare: false, max: 1 });
  try {
    await client`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    } finally {
      await client`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await client.end({ timeout: 5 });
  }

  const parsed = new URL(url);
  return { host: parsed.host, pooled: parsed.host.includes("-pooler") };
}
