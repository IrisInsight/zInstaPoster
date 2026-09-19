/**
 * Prepares the production database, as part of the build.
 *
 *   npm run db:bootstrap        # locally, against whatever DATABASE_URL is set
 *   vercel-build                # automatically, on every production deploy
 *
 * It exists because the database is only reachable from inside the
 * deployment: migrating from a laptop means handing the production connection
 * string to every developer, and a one-shot HTTP endpoint that rebuilds the
 * schema is a permanent hole in an app whose whole point is that nothing
 * publishes without a human. The build already holds the credentials it
 * needs, runs once per deploy, and fails loudly where the failure is read.
 *
 * Both steps are idempotent, so re-running it on every deploy is a no-op once
 * the database is current.
 */
import { closeDb } from "@/lib/db";
import { env } from "@/lib/env";
import { migrateToLatest } from "@/lib/db/migrate";
import { renderMissing, seedDatabase } from "@/lib/seed";

/**
 * Preview deployments share the production DATABASE_URL, so migrating from
 * one would change production's schema from an unreviewed branch.
 */
function shouldRun(): { run: boolean; reason: string } {
  const vercelEnv = process.env.VERCEL_ENV;
  if (!process.env.DATABASE_URL) {
    return {
      run: false,
      reason:
        "DATABASE_URL is not set. Nothing to bootstrap — local development uses the embedded PGlite database, which npm run db:push handles.",
    };
  }
  if (vercelEnv && vercelEnv !== "production") {
    return {
      run: false,
      reason: `VERCEL_ENV is "${vercelEnv}". Only production deploys bootstrap, because previews share the production connection string.`,
    };
  }
  return { run: true, reason: "" };
}

async function main() {
  const { run, reason } = shouldRun();
  if (!run) {
    console.log(`bootstrap  skipped  ${reason}`);
    return;
  }

  // Slide URLs are baked into the database at render time and handed to Meta
  // months later. Seeding a deployment with localhost URLs would look fine in
  // every screen and fail only at publish, so refuse before writing any.
  if (process.env.VERCEL && new URL(env.appBaseUrl).hostname === "localhost") {
    throw new Error(
      "APP_BASE_URL resolved to localhost on a Vercel build. Rendered slides would be stored with URLs Instagram cannot fetch. Set APP_BASE_URL to the deployment's public origin.",
    );
  }

  console.log("bootstrap  migrating");
  const outcome = await migrateToLatest();
  console.log(
    `bootstrap  migrated  ${outcome.host}${outcome.pooled ? "  (pooled connection)" : ""}`,
  );

  console.log("bootstrap  seeding");
  const seeded = await seedDatabase({
    // A Chromium failure should not cost the deployment. The posts are still
    // correct without their renders, /api/health reports exactly which slides
    // are missing, and re-running the seed fills them in.
    continueOnRenderError: true,
    log: (line) => console.log(`           ${line}`),
  });

  console.log(
    `bootstrap  seeded  ${seeded.tenantsCreated} tenants created, ${seeded.tenantsUpdated} updated, ` +
      `${seeded.postsCreated} posts created, ${seeded.postsSkipped} already present, ` +
      `${seeded.pendingApproval} awaiting approval`,
  );

  // Seeding skips a tenant that already has posts, so anything a previous
  // deploy failed to render is repaired here rather than staying blank.
  const repaired = await renderMissing({ log: (line) => console.log(`           ${line}`) });
  if (repaired.postsRendered > 0 || repaired.errors.length > 0) {
    console.log(
      `bootstrap  rendered  ${repaired.postsRendered} post(s) that had no images, ` +
        `${repaired.pendingApproval} moved to awaiting approval, ${repaired.errors.length} failed`,
    );
  }

  const renderErrors = [
    ...seeded.renderErrors.map((f) => `${f.slug}: ${f.error}`),
    ...repaired.errors.map((f) => `${f.postId}: ${f.error}`),
  ];
  if (renderErrors.length > 0) {
    console.error(
      `\nbootstrap  ${renderErrors.length} post(s) could not be rendered. ` +
        "They exist but have no slide images, so they stay in draft:",
    );
    for (const failure of renderErrors) {
      console.error(`           ${failure}`);
    }
    console.error("");
  }
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("\nbootstrap  FAILED");
    console.error(error);
    await closeDb();
    // A non-zero exit fails the build, which is the point: a deployment whose
    // schema did not apply would fail later, at publish time, in the dark.
    process.exit(1);
  });
