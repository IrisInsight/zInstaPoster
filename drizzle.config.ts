import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL;

export default {
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  ...(url
    ? { dbCredentials: { url } }
    : { driver: "pglite" as const, dbCredentials: { url: "./.pglite" } }),
} satisfies Config;
