import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { closeBrowser, getBrowser } from "@/lib/render/browser";
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

interface SeedCarousel {
  slug: string;
  kicker: string;
  template?: string;
  slides: Record<string, unknown>[];
}

function carouselFor(template: string): SeedCarousel {
  const match = seeds.carousels.find((c: SeedCarousel) => c.template === template);
  assert.ok(match, `no seed carousel for template "${template}"`);
  return match;
}

function slideInput(raw: Record<string, unknown>, from: SeedCarousel = carousel) {
  return {
    position: raw.position as number,
    type: raw.type as SlideType,
    copy: { ...raw, kicker: from.kicker },
    photoUrl: null,
    photoPrompt: (raw.photo_prompt as string) ?? null,
    template: from.template ?? seeds.template,
  };
}

/**
 * What the fit script settled on, once the page has been through the same wait
 * the renderer uses. `used` is how much of the fitted column the copy occupies
 * — the difference between a slide that fills its frame and one that floats in
 * the middle of it.
 */
async function fittedSizes(request: {
  tenant: TenantConfig;
  slide: ReturnType<typeof slideInput>;
}): Promise<{ fitted: number[]; used: number; clipped: string[] }> {
  const html = await slideHtml(request);
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: {
      width: request.tenant.output.width,
      height: request.tenant.output.height,
    },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction(
      () => document.documentElement.getAttribute("data-fitted") === "true",
      undefined,
      { timeout: 15_000 },
    );
    return await page.evaluate(() => {
      const fitted = Array.from(
        document.querySelectorAll<HTMLElement>("[data-fit]"),
      ).map((el) => Math.round(parseFloat(getComputedStyle(el).fontSize)));

      const column = document.querySelector<HTMLElement>(".grow");
      const children = column
        ? (Array.from(column.children) as HTMLElement[]).map((c) =>
            c.getBoundingClientRect(),
          )
        : [];
      const height = column?.getBoundingClientRect().height ?? 0;
      const content = children.length
        ? Math.max(...children.map((r) => r.bottom)) -
          Math.min(...children.map((r) => r.top))
        : 0;

      const slide = document.querySelector<HTMLElement>(".slide")!;
      const frame = slide.getBoundingClientRect();
      const clipped: string[] = [];
      slide.querySelectorAll<HTMLElement>("h1,p,span").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height === 0) return;
        if (
          r.top < frame.top - 1 ||
          r.bottom > frame.bottom + 1 ||
          r.left < frame.left - 1 ||
          r.right > frame.right + 1
        ) {
          clipped.push(`${el.tagName} ${Math.round(r.top)}..${Math.round(r.bottom)}`);
        }
      });

      return { fitted, used: height ? content / height : 0, clipped };
    });
  } finally {
    await context.close();
  }
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

test("every template's slides render at the tenant's one set of dimensions", async () => {
  const sizes = new Set<string>();
  for (const template of ["myth_buster", "single_card"]) {
    const seed = carouselFor(template);
    for (const raw of seed.slides) {
      const rendered = await renderSlide({ tenant, slide: slideInput(raw, seed) });
      assert.ok(isJpeg(rendered.buffer), `${seed.slug} ${raw.type} is not a JPEG`);
      assert.ok(rendered.bytes < MAX_BYTES);
      const dims = jpegDimensions(rendered.buffer);
      assert.deepEqual(dims, {
        width: tenant.output.width,
        height: tenant.output.height,
      });
      sizes.add(`${dims?.width}x${dims?.height}`);
    }
  }
  assert.equal(sizes.size, 1, "a slide is 1080×1350 whatever template it came from");
});

test("a myth statement far longer than the model would write still fits", async () => {
  const seed = carouselFor("myth_buster");
  const long = {
    ...seed.slides[0],
    headline:
      "If your testosterone number came back inside the reference range then whatever you are feeling is not hormonal and there is nothing further to test",
  };
  const rendered = await renderSlide({ tenant, slide: slideInput(long, seed) });
  assert.deepEqual(jpegDimensions(rendered.buffer), {
    width: tenant.output.width,
    height: tenant.output.height,
  });
});

test("the myth slide marks the myth as one, and quotes it", async () => {
  const seed = carouselFor("myth_buster");
  const myth = seed.slides[0];
  const html = await slideHtml({ tenant, slide: slideInput(myth, seed) });

  const label = tenant.templates.myth_buster.slide_specs.myth.label;
  const statement = myth.headline as string;

  // Quoted, as something the reader has been told — not the practice's line.
  assert.ok(
    html.includes(`“${statement}”`),
    "the statement is set in quotation marks",
  );

  // The label is a filled badge, not a corner kicker: it carries the slide's
  // one solid fill and type an order of magnitude larger than a kicker's.
  const badge = html.match(new RegExp(`<span[^>]*>${label}</span>`))?.[0] ?? "";
  assert.ok(badge, `no element prints the ${label} label`);
  assert.ok(
    badge.includes(`background:${tenant.brand_tokens.color.navy}`),
    "the label is filled, not floated",
  );
  const size = Number(badge.match(/font-size:(\d+(?:\.\d+)?)px/)?.[1]);
  assert.ok(size >= 28, `the label is ${size}px, which is kicker-sized`);
});

test("a myth that arrives already quoted is not quoted twice", async () => {
  const seed = carouselFor("myth_buster");
  const html = await slideHtml({
    tenant,
    slide: slideInput(
      { ...seed.slides[0], headline: "“A normal TSH means the thyroid is fine.”" },
      seed,
    ),
  });
  assert.ok(html.includes("“A normal TSH means the thyroid is fine.”"));
  assert.ok(!/““|””/.test(html), "no doubled quotation marks");
});

test("myth buster copy is set large enough to fill the frame", async () => {
  // The fit picks the largest size that fits, measured in the face the slide
  // is actually set in — a size chosen against the fallback serif put the myth
  // statement at 62px inside a box with room for 150.
  const seed = carouselFor("myth_buster");
  const sizes = await Promise.all(
    seed.slides.map((raw: Record<string, unknown>) =>
      fittedSizes({ tenant, slide: slideInput(raw, seed) }),
    ),
  );

  const [myth, correction] = sizes;
  assert.ok(myth.fitted[0] >= 140, `myth statement rendered at ${myth.fitted[0]}px`);
  assert.ok(
    myth.used > 0.85,
    `the myth statement fills ${Math.round(myth.used * 100)}% of its column`,
  );

  assert.ok(correction.fitted[0] >= 90, `correction headline at ${correction.fitted[0]}px`);
  assert.ok(correction.fitted[1] >= 30, `correction body at ${correction.fitted[1]}px`);
  assert.ok(
    correction.used > 0.7,
    `the correction fills ${Math.round(correction.used * 100)}% of its column`,
  );
});

test("copy far longer than the model would write is sized down, never clipped", async () => {
  const seed = carouselFor("myth_buster");
  const cases: Record<string, unknown>[] = [
    {
      ...seed.slides[0],
      headline:
        "If your thyroid stimulating hormone came back inside the reference range then whatever it is you are feeling is not hormonal and there is nothing further worth testing for",
    },
    // One word wide enough to outgrow the column at the maximum size. It has
    // to be set smaller, not broken in half.
    { ...seed.slides[0], headline: "Hypothyroidism is overdiagnosed." },
    {
      ...seed.slides[1],
      headline:
        "TSH is a pituitary signal, not a thyroid measurement, and one value cannot answer the question.",
      body: "TSH says what the pituitary is asking for, not what the tissue is getting. Free T4, free T3 and reverse T3 are the values that say whether the hormone is arriving and being converted. Estrogen exposure and liver status both shift binding, so the same TSH can sit over very different free levels, and antibodies can be positive years before any of it moves.",
      disclaimer: tenant.disclaimers.compounded,
    },
  ];

  for (const raw of cases) {
    const result = await fittedSizes({ tenant, slide: slideInput(raw, seed) });
    assert.deepEqual(result.clipped, [], `slide ${raw.type} overflowed the frame`);
    for (const size of result.fitted) {
      assert.ok(size > 0, "every fitted element got a size");
    }
  }
});

test("the script line is set in the display face, not the script one", async () => {
  const html = await slideHtml({ tenant, slide: slideInput(carousel.slides[0]) });
  // Parisienne stays embedded and available; nothing on a slide is set in it.
  const markup = html.slice(html.indexOf("</style>"));
  assert.ok(
    !/Parisienne/.test(markup),
    "no slide element may be set in Parisienne",
  );
  assert.match(html, /@font-face\{font-family:'Parisienne'/, "the face stays loaded");

  const scriptLine = markup.match(/<p[^>]*data-fit="48,28"[^>]*>/)?.[0] ?? "";
  assert.match(scriptLine, /Cormorant Garamond/);
  assert.match(scriptLine, /font-style:italic/);
  assert.match(scriptLine, /font-size:48px/, "the size range is unchanged");
  assert.ok(
    scriptLine.includes(tenant.brand_tokens.color.gold_text),
    "the colour is unchanged",
  );
});

test("a single card scrims the photo so the statement stays readable", async () => {
  const seed = carouselFor("single_card");
  const html = await slideHtml({
    tenant,
    slide: {
      ...slideInput(seed.slides[0], seed),
      photoUrl: "https://blob.example.com/photo.jpg",
    },
  });
  assert.match(html, /linear-gradient\(180deg, rgba\(23,57,92/);
  assert.ok(html.includes("https://blob.example.com/photo.jpg"));
  assert.ok(
    html.includes(tenant.footer.contact),
    "the brand footer is on the card",
  );
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
