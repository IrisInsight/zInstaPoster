/**
 * Seeds tenants from tenants/*.json, a starting user, and the five shipped
 * Precision Vitality carousels as real posts so the queue is not empty on a
 * fresh install.
 *
 *   npm run db:seed
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { hashPassword } from "@/lib/crypto";
import { appUser, closeDb, getDb, post, slide, tenant, userTenant } from "@/lib/db";
import { readTenantFiles, splitTenantConfig, tenantConfigFromRow } from "@/lib/tenants";
import { recordAudit, systemActor } from "@/lib/audit";
import { fillPhotos, renderPost, runCompliance } from "@/lib/content/pipeline";
import { closeBrowser } from "@/lib/render/browser";

const SEED_EMAIL = process.env.SEED_USER_EMAIL ?? "owner@precision-vitality.com";
const SEED_PASSWORD = process.env.SEED_USER_PASSWORD ?? "zinstaposter";
/** SEED_RENDER=false skips rendering, which is the slow part. */
const RENDER = process.env.SEED_RENDER !== "false";

async function main() {
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
      console.log(`tenant  updated  ${config.slug}`);
    } else {
      await db.insert(tenant).values(columns);
      console.log(`tenant  created  ${config.slug}`);
    }
  }

  const [pv] = await db
    .select()
    .from(tenant)
    .where(eq(tenant.slug, "precision-vitality"));

  let [user] = await db.select().from(appUser).where(eq(appUser.email, SEED_EMAIL));
  if (!user) {
    [user] = await db
      .insert(appUser)
      .values({
        email: SEED_EMAIL,
        name: "Practice Owner",
        passwordHash: hashPassword(SEED_PASSWORD),
        role: "owner",
      })
      .returning();
    console.log(`user    created  ${SEED_EMAIL} / ${SEED_PASSWORD}`);
  } else {
    console.log(`user    exists   ${SEED_EMAIL}`);
  }

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
    carousels: {
      slug: string;
      kicker: string;
      caption: string;
      slides: Record<string, unknown>[];
    }[];
  };

  const existingPosts = await db.select().from(post).where(eq(post.tenantId, pv.id));
  if (existingPosts.length > 0) {
    console.log(`posts   skipped  ${existingPosts.length} already present`);
    return;
  }

  for (const carousel of seeds.carousels) {
    const [created] = await db
      .insert(post)
      .values({
        tenantId: pv.id,
        template: "symptom_carousel",
        status: "draft",
        title: titleFor(carousel.slug),
        prompt: `Seed content — ${carousel.slug}`,
        caption: carousel.caption,
        altTexts: carousel.slides.map((s) => s.alt_text as string),
        createdBy: "seed",
      })
      .returning();

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

    if (RENDER) {
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
      }
      console.log(
        `post    created  ${carousel.slug}  ${report.passed}/${report.checksRun} checks passed, ${
          report.approvable ? "awaiting approval" : "blocked"
        }`,
      );
    } else {
      console.log(`post    created  ${carousel.slug}`);
    }
  }

  if (RENDER) await closeBrowser();
}

function titleFor(slug: string): string {
  return slug
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
