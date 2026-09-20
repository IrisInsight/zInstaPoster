/**
 * Seeding, as a function rather than a script.
 *
 * It runs in two places — `npm run db:seed` locally and the deploy bootstrap
 * against the production database — and those two must not drift, so the logic
 * lives here and both callers import it.
 *
 * Every step is idempotent: tenants upsert, the seat is reused if present, and
 * the carousels are skipped entirely once the tenant has any posts. Running it
 * on every deploy is therefore safe.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq, inArray, isNull } from "drizzle-orm";
import { appUser, getDb, post, slide, tenant, userTenant } from "@/lib/db";
import { readTenantFiles, splitTenantConfig, tenantConfigFromRow } from "@/lib/tenants";
import { recordAudit, systemActor } from "@/lib/audit";
import { fillPhotos, renderPost, runCompliance } from "@/lib/content/pipeline";
import { closeBrowser } from "@/lib/render/browser";

export interface SeedOptions {
  /** The name recorded in the audit trail as the approver. */
  seatName?: string;
  /** Rendering is the slow, Chromium-dependent part. */
  render?: boolean;
  /**
   * When rendering fails, keep the seeded content instead of aborting.
   * A deploy is better off with un-illustrated posts than with no database.
   */
  continueOnRenderError?: boolean;
  log?: (line: string) => void;
}

export interface SeedResult {
  tenantsCreated: number;
  tenantsUpdated: number;
  postsCreated: number;
  postsSkipped: number;
  pendingApproval: number;
  /** Render failures, by carousel slug. Empty when every render succeeded. */
  renderErrors: { slug: string; error: string }[];
}

export interface RenderMissingResult {
  postsRendered: number;
  pendingApproval: number;
  errors: { postId: string; error: string }[];
}

/**
 * Renders posts whose slides never got images.
 *
 * Seeding skips a tenant that already has posts, so a run where rendering
 * failed would otherwise leave the queue permanently empty of pictures: the
 * rows are there, which is exactly what stops the seed from trying again.
 * This is the repair path, and it is what makes re-running the bootstrap
 * fill in what a previous one could not.
 */
export async function renderMissing(options: SeedOptions = {}): Promise<RenderMissingResult> {
  const log = options.log ?? (() => {});
  const result: RenderMissingResult = { postsRendered: 0, pendingApproval: 0, errors: [] };

  const db = await getDb();
  const unrendered = await db
    .select({ postId: slide.postId })
    .from(slide)
    .where(isNull(slide.renderedUrl));
  const postIds = [...new Set(unrendered.map((row) => row.postId))];
  if (postIds.length === 0) return result;

  // Only content still awaiting a decision. A published post is immutable and
  // a rejected one should not quietly come back with fresh images.
  const targets = await db
    .select()
    .from(post)
    .where(inArray(post.id, postIds));

  for (const row of targets) {
    if (row.status !== "draft" && row.status !== "pending_approval") continue;

    const [owner] = await db.select().from(tenant).where(eq(tenant.id, row.tenantId));
    if (!owner) continue;

    try {
      const config = tenantConfigFromRow(owner);
      const slides = await db.select().from(slide).where(eq(slide.postId, row.id));
      await fillPhotos({ tenant: config, postId: row.id, slides });
      await renderPost({ tenant: config, postId: row.id });
      const report = await runCompliance({ tenant: config, postId: row.id });
      result.postsRendered += 1;

      if (row.status === "draft" && report.approvable) {
        await db
          .update(post)
          .set({ status: "pending_approval", updatedAt: new Date() })
          .where(eq(post.id, row.id));
        await recordAudit({
          tenantId: row.tenantId,
          postId: row.id,
          actor: systemActor("seed"),
          action: "post.pending_approval",
          payload: { from: "draft", to: "pending_approval", checksPassed: report.passed },
        });
        result.pendingApproval += 1;
      }
      log(
        `render  filled   ${row.title}  ${report.passed}/${report.checksRun} checks passed, ${
          report.approvable ? "awaiting approval" : "blocked"
        }`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ postId: row.id, error: message });
      log(`render  FAILED   ${row.title}  ${message}`);
    }
  }

  await closeBrowser();
  return result;
}

export async function seedDatabase(options: SeedOptions = {}): Promise<SeedResult> {
  const log = options.log ?? (() => {});
  const seatName = options.seatName ?? process.env.SEED_USER_NAME ?? "Practice Owner";
  const render = options.render ?? process.env.SEED_RENDER !== "false";
  const continueOnRenderError = options.continueOnRenderError ?? false;

  const result: SeedResult = {
    tenantsCreated: 0,
    tenantsUpdated: 0,
    postsCreated: 0,
    postsSkipped: 0,
    pendingApproval: 0,
    renderErrors: [],
  };

  const db = await getDb();
  const configs = await readTenantFiles();

  for (const config of configs) {
    const columns = splitTenantConfig(config);
    const [existing] = await db
      .select()
      .from(tenant)
      .where(eq(tenant.slug, config.slug));
    if (existing) {
      await db.update(tenant).set(columns).where(eq(tenant.id, existing.id));
      result.tenantsUpdated += 1;
      log(`tenant  updated  ${config.slug}`);
    } else {
      await db.insert(tenant).values(columns);
      result.tenantsCreated += 1;
      log(`tenant  created  ${config.slug}`);
    }
  }

  const [pv] = await db
    .select()
    .from(tenant)
    .where(eq(tenant.slug, "precision-vitality"));

  const existingUsers = await db.select().from(appUser).limit(1);
  let user = existingUsers[0];
  if (!user) {
    [user] = await db
      .insert(appUser)
      .values({ name: seatName, role: "owner" })
      .returning();
    log(`user    created  "${user.name}"`);
  } else {
    log(`user    exists   "${user.name}"`);
  }
  log(
    `access  sign in with the ACCESS_CODE from the environment${
      process.env.ACCESS_CODE ? "" : ' (unset, so the development default "zinstaposter")'
    }`,
  );

  for (const t of await db.select().from(tenant)) {
    await db
      .insert(userTenant)
      .values({ userId: user.id, tenantId: t.id })
      .onConflictDoNothing();
  }

  const seeds = JSON.parse(
    await readFile(
      path.join(process.cwd(), "content", "precision-vitality-carousels.json"),
      "utf8",
    ),
  ) as {
    /** The template a carousel uses unless it names its own. */
    template?: string;
    carousels: {
      slug: string;
      kicker: string;
      caption: string;
      template?: string;
      slides: Record<string, unknown>[];
    }[];
  };

  const existingPosts = await db.select().from(post).where(eq(post.tenantId, pv.id));
  if (existingPosts.length > 0) {
    result.postsSkipped = existingPosts.length;
    log(`posts   skipped  ${existingPosts.length} already present`);
    return result;
  }

  for (const carousel of seeds.carousels) {
    const [created] = await db
      .insert(post)
      .values({
        tenantId: pv.id,
        template: carousel.template ?? seeds.template ?? "symptom_carousel",
        status: "draft",
        title: titleFor(carousel.slug),
        prompt: `Seed content — ${carousel.slug}`,
        caption: carousel.caption,
        altTexts: carousel.slides.map((s) => s.alt_text as string),
        createdBy: "seed",
      })
      .returning();
    result.postsCreated += 1;

    const rows = await db
      .insert(slide)
      .values(
        carousel.slides.map((raw) => ({
          postId: created.id,
          position: raw.position as number,
          type: raw.type as string,
          copy: { ...raw, kicker: carousel.kicker } as Record<string, unknown>,
          altText: (raw.alt_text as string) ?? "",
          photoPrompt: (raw.photo_prompt as string) ?? null,
          width: 1080,
          height: 1350,
        })),
      )
      .returning();

    await recordAudit({
      tenantId: pv.id,
      postId: created.id,
      actor: systemActor("seed"),
      action: "post.seeded",
      payload: { slug: carousel.slug },
    });

    if (!render) {
      log(`post    created  ${carousel.slug}`);
      continue;
    }

    try {
      const config = tenantConfigFromRow(pv);
      await fillPhotos({ tenant: config, postId: created.id, slides: rows });
      await renderPost({ tenant: config, postId: created.id });
      const report = await runCompliance({ tenant: config, postId: created.id });
      if (report.approvable) {
        await db
          .update(post)
          .set({ status: "pending_approval", updatedAt: new Date() })
          .where(eq(post.id, created.id));
        await recordAudit({
          tenantId: pv.id,
          postId: created.id,
          actor: systemActor("seed"),
          action: "post.pending_approval",
          payload: { from: "draft", to: "pending_approval", checksPassed: report.passed },
        });
        result.pendingApproval += 1;
      }
      log(
        `post    created  ${carousel.slug}  ${report.passed}/${report.checksRun} checks passed, ${
          report.approvable ? "awaiting approval" : "blocked"
        }`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.renderErrors.push({ slug: carousel.slug, error: message });
      log(`post    UNRENDERED  ${carousel.slug}  ${message}`);
      if (!continueOnRenderError) {
        await closeBrowser();
        throw error;
      }
    }
  }

  if (render) await closeBrowser();
  return result;
}

function titleFor(slug: string): string {
  return slug
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
