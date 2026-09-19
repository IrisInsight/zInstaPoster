import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * One database, two drivers.
 *
 *  - DATABASE_URL set  → postgres.js against Neon/Supabase (production).
 *  - DATABASE_URL unset → PGlite, an in-process Postgres, under .pglite/.
 *
 * The second one exists so `npm run dev` works with an empty .env and the
 * vertical slice is genuinely runnable without provisioning anything.
 */

type Database = Awaited<ReturnType<typeof create>>;

/** Held so a script can shut the connection down cleanly before exiting. */
let closer: (() => Promise<void>) | undefined;

async function create() {
  // PGlite writes to a directory on disk, which does not exist on a serverless
  // filesystem. Falling back to it in production turns a missing setting into
  // an unreadable runtime error, so say what is actually wrong instead.
  if (env.isProduction && !env.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. The embedded database is for local development only; a deployment needs a Postgres connection string.",
    );
  }

  if (env.databaseUrl) {
    const [{ drizzle }, postgres] = await Promise.all([
      import("drizzle-orm/postgres-js"),
      import("postgres"),
    ]);
    const client = postgres.default(env.databaseUrl, {
      prepare: false,
      max: 5,
    });
    closer = async () => {
      await client.end({ timeout: 5 });
    };
    return drizzle(client, { schema });
  }

  const [{ drizzle }, { PGlite }] = await Promise.all([
    import("drizzle-orm/pglite"),
    import("@electric-sql/pglite"),
  ]);
  const client = new PGlite(env.pgliteDir);
  closer = async () => {
    await client.close();
  };
  return drizzle(client, { schema });
}

declare global {
  // eslint-disable-next-line no-var
  var __zip_db: Promise<Database> | undefined;
}

/** Cached across hot reloads; PGlite allows a single writer per directory. */
export function getDb(): Promise<Database> {
  globalThis.__zip_db ??= create();
  return globalThis.__zip_db;
}

/**
 * Closes the connection. PGlite is a single-writer embedded Postgres: a
 * process that exits without closing leaves the data directory locked, and
 * the next process to open it fails. Every script calls this before exiting.
 */
export async function closeDb(): Promise<void> {
  const pending = globalThis.__zip_db;
  globalThis.__zip_db = undefined;
  if (!pending) return;
  await pending.catch(() => undefined);
  await closer?.().catch(() => undefined);
  closer = undefined;
}

export { schema };
export * from "./schema";
