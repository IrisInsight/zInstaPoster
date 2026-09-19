import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { closeBrowser } from "@/lib/render/browser";
import {
  isJpeg,
  jpegDimensions,
  MAX_BYTES,
  renderSlide,
} from "@/lib/render/renderer";
import { slideHtml } from "@/lib/render/templates";
import type { TenantConfig } from "@/lib/tenants";
import type { SlideType } from "@/lib/render/types";

/**
 * The renderer is the piece every Instagram constraint lands on: JPEG only,
 * under 8MB, and every slide at identical dimensions because Instagram crops
 * slides 2..n to the first one's aspect ratio.
 */

const tenant: TenantConfig = JSON.parse(
  await readFile("tenants/precision-vitality.json", "utf8"),
);
const seeds = JSON.parse(
  await readFile("content/precision-vitality-carousels.json", "utf8"),
);
const carousel = seeds.carousels[0];

function slideInput(raw: Record<string, unknown>) {
  return {
    position: raw.position as number,
    type: raw.type as SlideType,
    copy: { ...raw, kicker: carousel.kicker },
    photoUrl: null,
    photoPrompt: (raw.photo_prompt as string) ?? null,
  };
}

test("every slide renders as a JPEG at the tenant's exact dimensions", async () => {
  const sizes = new Set<string>();
  for (const raw of carousel.slides) {
    const rendered = await renderSlide({ tenant, slide: slideInput(raw) });

    assert.equal(rendered.contentType, "image/jpeg");
    assert.ok(isJpeg(rendered.buffer), `slide ${raw.position} is not a JPEG`);
    assert.ok(rendered.bytes < MAX_BYTES);

    const dims = jpegDimensions(rendered.buffer);
    assert.deepEqual(dims, {
      width: tenant.output.width,
      height: tenant.output.height,
    });
    sizes.add(`${dims?.width}x${dims?.height}`);
  }
  assert.equal(sizes.size, 1, "all slides must share one aspect ratio");
});

test("a headline far longer than the model would write still fits the frame", async () => {
  const long = {
    ...carousel.slides[0],
    headline:
      "Fine lines and creping along the jaw and neck showing up far faster than they used to, and no cream is touching them",
    script_line:
      "It is rarely just your skin, and the reason is usually one layer down",
  };
  const rendered = await renderSlide({ tenant, slide: slideInput(long) });
  const dims = jpegDimensions(rendered.buffer);
  assert.deepEqual(dims, {
    width: tenant.output.width,
    height: tenant.output.height,
  });
  assert.ok(rendered.bytes < MAX_BYTES);
});

test("slide markup carries the tenant's brand, embedded fonts and no tool branding", async () => {
  const html = await slideHtml({ tenant, slide: slideInput(carousel.slides[2]) });

  assert.match(html, /@font-face/);
  assert.match(html, /data:font\/ttf;base64/, "fonts are embedded, not fetched");
  assert.ok(
    !/fonts\.googleapis|fonts\.gstatic/.test(html),
    "a render must not depend on a font CDN",
  );

  assert.ok(html.includes(tenant.brand_tokens.color.navy));
  assert.ok(html.includes(tenant.brand_tokens.color.cream));

  // The tool's own mark must never appear on tenant output.
  assert.ok(!/zInstaPoster|flame|E8563A/i.test(html));

  // Legal text is rendered verbatim from config, never paraphrased by a model.
  assert.ok(html.includes("not reviewed by the U.S. Food and Drug Administration"));
});

test("copy is escaped rather than interpolated into markup", async () => {
  const hostile = {
    ...carousel.slides[1],
    headline: '<script>alert("x")</script> & more',
  };
  const html = await slideHtml({ tenant, slide: slideInput(hostile) });
  assert.ok(!html.includes("<script>alert"), "no raw script tag from copy");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp; more/);
});

test("a width outside Instagram's range is refused before Chromium starts", async () => {
  const oversized: TenantConfig = {
    ...tenant,
    output: { ...tenant.output, width: 2000 },
  };
  await assert.rejects(
    () => renderSlide({ tenant: oversized, slide: slideInput(carousel.slides[0]) }),
    /outside Instagram's 320–1440px range/,
  );
});

after(async () => {
  await closeBrowser();
});
