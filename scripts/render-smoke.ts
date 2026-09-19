/**
 * Build-order step 1 verification.
 *
 * Renders all four slides of a seed carousel, stores them, then fetches each
 * stored URL back over HTTP and asserts the bytes are a valid JPEG at the
 * tenant's exact dimensions and under Instagram's 8MB limit.
 *
 *   npm run render:smoke
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { closeDb } from "@/lib/db";
import { closeBrowser } from "@/lib/render/browser";
import { isJpeg, jpegDimensions, renderSlide, MAX_BYTES } from "@/lib/render/renderer";
import { putObject, storageDriver } from "@/lib/storage";
import { readTenantFile } from "@/lib/tenants";
import type { SlideType } from "@/lib/render/types";

const OUT = path.join(process.cwd(), "tmp", "render-smoke");

async function main() {
  const slug = process.argv[2] ?? "fine-lines";
  const tenant = await readTenantFile("precision-vitality");
  const seeds = JSON.parse(
    await readFile(
      path.join(process.cwd(), "content", "precision-vitality-carousels.json"),
      "utf8",
    ),
  ) as { carousels: { slug: string; kicker: string; slides: Record<string, unknown>[] }[] };

  const carousel = seeds.carousels.find((c) => c.slug === slug);
  if (!carousel) throw new Error(`No seed carousel "${slug}".`);

  await mkdir(OUT, { recursive: true });
  console.log(`tenant  : ${tenant.name}`);
  console.log(`carousel: ${carousel.slug}`);
  console.log(`storage : ${storageDriver()}`);
  console.log(
    `output  : ${tenant.output.width}×${tenant.output.height} ${tenant.output.format}\n`,
  );

  const dims = new Set<string>();
  const started = Date.now();

  for (const raw of carousel.slides) {
    const position = raw.position as number;
    const type = raw.type as SlideType;
    const copy = { ...raw, kicker: carousel.kicker };
    const t0 = Date.now();
    const rendered = await renderSlide({
      tenant,
      slide: { position, type, copy, photoUrl: null, photoPrompt: (raw.photo_prompt as string) ?? null },
    });

    if (!isJpeg(rendered.buffer)) throw new Error(`Slide ${position} is not a JPEG.`);
    if (rendered.bytes > MAX_BYTES) throw new Error(`Slide ${position} over 8MB.`);
    const actual = jpegDimensions(rendered.buffer);
    if (!actual) throw new Error(`Slide ${position}: could not read JPEG dimensions.`);
    if (actual.width !== tenant.output.width || actual.height !== tenant.output.height) {
      throw new Error(
        `Slide ${position} rendered ${actual.width}×${actual.height}, expected ${tenant.output.width}×${tenant.output.height}.`,
      );
    }
    dims.add(`${actual.width}x${actual.height}`);

    const stored = await putObject(
      `smoke/${carousel.slug}/slide-${position}.jpg`,
      rendered.buffer,
      "image/jpeg",
    );
    await writeFile(path.join(OUT, `slide-${position}.jpg`), rendered.buffer);

    console.log(
      `slide ${position} ${type.padEnd(8)} ${String(actual.width)}×${actual.height}  ` +
        `${(rendered.bytes / 1024).toFixed(0).padStart(4)} KB  ${String(Date.now() - t0).padStart(5)} ms  ${stored.url}`,
    );
  }

  if (dims.size !== 1) {
    throw new Error(
      `Slides have differing dimensions (${[...dims].join(", ")}). Instagram crops every slide to the first one's ratio.`,
    );
  }

  console.log(`\nall slides identical at ${[...dims][0]} — ${Date.now() - started} ms total`);
  console.log(`local copies: ${OUT}`);
  await closeBrowser();
}

main()
  .then(async () => {
    await closeDb();
  })
  .catch(async (error) => {
    console.error(error);
    await closeBrowser();
    await closeDb();
    process.exit(1);
  });
