import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  assertMatchesTemplate,
  carouselSchemaFor,
} from "@/lib/content/schema";
import type { TenantConfig } from "@/lib/tenants";

/**
 * The copy model is driven by a structured-output schema built from tenant
 * config. An invalid schema is rejected before the request is sent, which the
 * first live run discovered the hard way: a Zod tuple serialises to
 * `items: false` and a Zod literal to a bare `const`, and neither carries a
 * `type`. This test builds the schema for every shipped template and asserts
 * the SDK accepts it.
 */

const configs: TenantConfig[] = [
  JSON.parse(await readFile("tenants/precision-vitality.json", "utf8")),
  JSON.parse(await readFile("docs/example-tenant-senior-living.json", "utf8")),
];

test("every shipped template produces a schema the SDK accepts", () => {
  for (const config of configs) {
    for (const [name, template] of Object.entries(config.templates)) {
      assert.doesNotThrow(
        () => zodOutputFormat(carouselSchemaFor(template)),
        `${config.slug}/${name} produced an invalid output schema`,
      );
    }
  }
});

test("the generated schema accepts a well-formed carousel", () => {
  const template = configs[0].templates.symptom_carousel;
  const schema = carouselSchemaFor(template);
  const carousel = {
    title: "Fine lines",
    kicker: "Healthy Aging",
    comment_keyword: "SKIN",
    caption: "Fine lines are not only a skin problem. #healthyaging",
    slides: [
      {
        position: 1,
        type: "hook",
        alt_text: "Healthy Aging: fine lines",
        copy: {
          headline: "Fine lines showing up faster?",
          script_line: "It is rarely just your skin.",
          photo_prompt: "Woman, 40s, natural window light.",
        },
      },
      {
        position: 2,
        type: "cause",
        alt_text: "Skin is an output",
        copy: {
          headline: "Skin is an output.",
          sub: "Most of it is driven a layer down.",
          items: [{ label: "Hormones", text: "Thinner dermis, less collagen." }],
        },
      },
      {
        position: 3,
        type: "protocol",
        alt_text: "What may help",
        copy: {
          headline: "What may help",
          cards: [{ title: "Start with data", text: "Labs before protocols." }],
          disclaimer: "Compounded medications are not reviewed by the FDA.",
        },
      },
      {
        position: 4,
        type: "cta",
        alt_text: "Book a consult",
        copy: {
          headline: "Start with a free 15-minute consult.",
          body: "A no-pressure conversation.",
          trust_points: ["Telehealth across California"],
        },
      },
    ],
  };

  const parsed = schema.safeParse(carousel);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 1));
  assert.doesNotThrow(() => assertMatchesTemplate(carousel, template));
});

test("slides in the wrong order or count are caught after parsing", () => {
  const template = configs[0].templates.symptom_carousel;
  assert.throws(
    () =>
      assertMatchesTemplate(
        {
          slides: [
            { position: 1, type: "hook" },
            { position: 2, type: "protocol" },
            { position: 3, type: "cause" },
            { position: 4, type: "cta" },
          ],
        },
        template,
      ),
    /order hook, protocol, cause, cta/,
  );

  assert.throws(
    () =>
      assertMatchesTemplate(
        { slides: [{ position: 1, type: "hook" }] },
        template,
      ),
    /returned 1 slides/,
  );
});
