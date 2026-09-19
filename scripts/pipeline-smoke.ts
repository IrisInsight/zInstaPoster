/**
 * Build-order step 2 verification: the whole content pipeline, end to end.
 *
 * With ANTHROPIC_API_KEY set it generates a fresh carousel from a prompt.
 * Without one it re-runs photo → render → compliance over a seeded post, so
 * the parts that do not need a model key are still exercised.
 *
 *   npm run pipeline:smoke -- "why a normal TSH doesn't mean a normal thyroid"
 */
import { eq } from "drizzle-orm";
import { closeDb, getDb, post, slide, tenant } from "@/lib/db";
import { copyGenerationAvailable } from "@/lib/content/claude";
import { photoGenerationAvailable } from "@/lib/content/gemini";
import {
  fillPhotos,
  generatePost,
  renderPost,
  runCompliance,
  type PipelineEvent,
} from "@/lib/content/pipeline";
import { closeBrowser } from "@/lib/render/browser";
import { isJpeg, jpegDimensions, MAX_BYTES } from "@/lib/render/renderer";
import { isPubliclyFetchable, storageDriver } from "@/lib/storage";
import { systemActor } from "@/lib/audit";
import { tenantConfigFromRow } from "@/lib/tenants";

function log(event: PipelineEvent) {
  switch (event.type) {
    case "step":
      console.log(
        `  ${event.status === "start" ? "→" : "✓"} ${event.step}${
          event.detail ? `  ${event.detail}` : ""
        }`,
      );
      break;
    case "copy":
      console.log(`     slide ${event.position}: ${event.headline}`);
      break;
    case "slide":
      console.log(`     slide ${event.position} → ${event.url}`);
      break;
    case "error":
      console.error(`  ✗ ${event.message}`);
      break;
  }
}

async function main() {
  const prompt =
    process.argv.slice(2).join(" ") ||
    "Why a normal TSH does not mean a normal thyroid";

  const db = await getDb();
  const [row] = await db
    .select()
    .from(tenant)
    .where(eq(tenant.slug, "precision-vitality"));
  if (!row) throw new Error("Seed the database first: npm run db:seed");
  const config = tenantConfigFromRow(row);

  console.log(`tenant  : ${config.name}`);
  console.log(`storage : ${storageDriver()}`);
  console.log(`copy    : ${copyGenerationAvailable() ? "Claude" : "unavailable (no ANTHROPIC_API_KEY)"}`);
  console.log(`photos  : ${photoGenerationAvailable() ? "Gemini" : "placeholder (no GEMINI_API_KEY)"}`);
  console.log();

  let postId: string;

  if (copyGenerationAvailable()) {
    console.log(`generating from prompt: "${prompt}"`);
    const created = await generatePost({
      tenant: config,
      tenantId: row.id,
      templateName: "symptom_carousel",
      prompt,
      actor: systemActor("pipeline-smoke"),
      emit: log,
    });
    postId = created.id;
  } else {
    const [seeded] = await db
      .select()
      .from(post)
      .where(eq(post.tenantId, row.id))
      .limit(1);
    if (!seeded) throw new Error("No seeded post to work from. Run npm run db:seed.");
    postId = seeded.id;
    console.log(`re-running the pipeline over seeded post "${seeded.title}"`);
    const rows = await db.select().from(slide).where(eq(slide.postId, postId));
    await fillPhotos({ tenant: config, postId, slides: rows, emit: log });
    await renderPost({ tenant: config, postId, emit: log });
    await runCompliance({ tenant: config, postId, emit: log });
  }

  const [finished] = await db.select().from(post).where(eq(post.id, postId));
  const slides = await db
    .select()
    .from(slide)
    .where(eq(slide.postId, postId))
    .orderBy(slide.position);

  console.log("\nverifying every slide is something Instagram will accept");
  const dimensions = new Set<string>();
  for (const s of slides) {
    if (!s.renderedUrl) throw new Error(`Slide ${s.position} has no rendered URL.`);
    const response = await fetch(s.renderedUrl);
    if (!response.ok) {
      throw new Error(`Slide ${s.position} URL returned ${response.status}.`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";

    if (!type.startsWith("image/jpeg")) {
      throw new Error(`Slide ${s.position} is served as ${type}; Meta rejects non-JPEG.`);
    }
    if (!isJpeg(buffer)) throw new Error(`Slide ${s.position} is not a valid JPEG.`);
    if (buffer.byteLength > MAX_BYTES) {
      throw new Error(`Slide ${s.position} is over Instagram's 8MB limit.`);
    }
    const dims = jpegDimensions(buffer);
    if (!dims) throw new Error(`Slide ${s.position}: unreadable JPEG header.`);
    dimensions.add(`${dims.width}x${dims.height}`);

    console.log(
      `  slide ${s.position} ${s.type.padEnd(8)} ${dims.width}×${dims.height}  ` +
        `${String(Math.round(buffer.byteLength / 1024)).padStart(4)} KB  ` +
        `${isPubliclyFetchable(s.renderedUrl) ? "public https" : "LOCAL ONLY — Meta cannot fetch this"}`,
    );
  }

  if (dimensions.size !== 1) {
    throw new Error(
      `Slides differ in size (${[...dimensions].join(", ")}). Instagram crops every slide to the first one's ratio.`,
    );
  }

  const report = finished.complianceReport as {
    passed: number;
    checksRun: number;
    approvable: boolean;
    findings: { severity: string; ruleId: string; message: string }[];
  } | null;

  console.log(`\ncompliance: ${report?.passed}/${report?.checksRun} checks passed`);
  for (const finding of report?.findings ?? []) {
    console.log(`  [${finding.severity}] ${finding.ruleId}: ${finding.message}`);
  }
  console.log(`\npost ${postId} is ${finished.status}`);
  console.log(
    report?.approvable
      ? "awaiting a human approval — nothing publishes on its own"
      : "blocked until the findings above are resolved",
  );

  await closeBrowser();
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await closeBrowser();
    await closeDb();
    process.exit(1);
  });
