import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Each test file gets its own throwaway PGlite database, migrated from the
 * same SQL the production database uses.
 */
export async function useTestDatabase(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "zip-test-"));
  process.env.PGLITE_DIR = dir;
  delete process.env.DATABASE_URL;
  process.env.TOKEN_ENCRYPTION_KEY ??= "dGVzdC1rZXktMzItYnl0ZXMtZm9yLXRlc3RpbmchIQ==";
  process.env.AUTH_SECRET ??= "test-secret";
  process.env.APP_BASE_URL ??= "https://zip.test";

  const { getDb } = await import("@/lib/db");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const db = await getDb();
  await migrate(db as never, {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
}
