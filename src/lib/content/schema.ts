import { z } from "zod";
import type { TemplateDefinition } from "@/lib/tenants";

/**
 * Slide copy schemas, one per slide type, keyed the same way the tenant
 * template's `structure` array names them. A new tenant with a different
 * template composes a different schema out of the same registry.
 */

export const hookCopySchema = z.object({
  headline: z
    .string()
    .describe("One symptom in the reader's own words. Never a service name."),
  script_line: z.string().describe("A short handwritten-script line beneath the headline."),
  photo_prompt: z
    .string()
    .describe(
      "A photo brief for an image model: who is in frame, the light, the wardrobe. No text, no logos, no clinical settings.",
    ),
});

export const causeCopySchema = z.object({
  headline: z.string(),
  sub: z.string(),
  items: z
    .array(z.object({ label: z.string(), text: z.string() }))
    .describe("One line per driver. This is the slide people save."),
});

export const protocolCopySchema = z.object({
  headline: z.string(),
  cards: z.array(z.object({ title: z.string(), text: z.string() })),
  disclaimer: z
    .string()
    .describe("Copied verbatim from the tenant disclaimers. Never paraphrased."),
});

export const ctaCopySchema = z.object({
  headline: z.string(),
  body: z.string(),
  trust_points: z.array(z.string()),
});

const SLIDE_SCHEMAS = {
  hook: hookCopySchema,
  cause: causeCopySchema,
  protocol: protocolCopySchema,
  cta: ctaCopySchema,
} as const;

export type SlideTypeName = keyof typeof SLIDE_SCHEMAS;

export function isKnownSlideType(value: string): value is SlideTypeName {
  return value in SLIDE_SCHEMAS;
}

/**
 * Builds the output schema for one template.
 *
 * Slides are an array of a union of per-slide-type variants rather than a
 * tuple: a Zod tuple serialises to `items: false`, which the structured-output
 * schema validator rejects. The count and ordering are asserted after parsing
 * instead — see assertMatchesTemplate.
 */
function slideVariant(type: string) {
  const copySchema = isKnownSlideType(type)
    ? SLIDE_SCHEMAS[type]
    : z.object({ headline: z.string() });
  return z.object({
    position: z.number().int().describe("1-based position in the carousel."),
    // A single-value enum rather than z.literal: a literal serialises to a
    // bare `const`, which has no `type` and is rejected.
    type: z.enum([type]).describe(`Always "${type}".`),
    alt_text: z
      .string()
      .describe(
        "Describes what is on the slide for a screen reader. Max 1000 characters.",
      ),
    copy: copySchema,
  });
}

export function carouselSchemaFor(template: TemplateDefinition) {
  const types = [...new Set(template.structure)];
  const variants = types.map(slideVariant);
  const slideSchema =
    variants.length === 1
      ? variants[0]
      : z.union(
          variants as unknown as readonly [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
        );

  return z.object({
    title: z.string().describe("Six words or fewer, for the queue list."),
    kicker: z
      .string()
      .describe("The category label repeated on every slide, e.g. 'Men's Health'."),
    comment_keyword: z
      .string()
      .describe("A single uppercase word for the comment-keyword call to action."),
    caption: z
      .string()
      .describe("The Instagram caption. Under 2200 characters, at most 5 hashtags."),
    slides: z
      .array(slideSchema)
      .describe(
        `Exactly ${template.slides} slides, in this order: ${template.structure.join(", ")}.`,
      ),
  });
}

/**
 * The schema cannot express "these types, in this order", so the shape the
 * template asked for is checked here after parsing.
 */
export function assertMatchesTemplate(
  carousel: { slides: { position: number; type: string }[] },
  template: TemplateDefinition,
): void {
  const got = carousel.slides.map((s) => s.type);
  if (got.length !== template.slides) {
    throw new Error(
      `The model returned ${got.length} slides; template "${template.structure.join("/")}" needs ${template.slides}.`,
    );
  }
  if (got.join(",") !== template.structure.join(",")) {
    throw new Error(
      `The model returned slides in the order ${got.join(", ")}; the template is ${template.structure.join(", ")}.`,
    );
  }
}

export type GeneratedCarousel = {
  title: string;
  kicker: string;
  comment_keyword: string;
  caption: string;
  slides: {
    position: number;
    type: string;
    alt_text: string;
    copy: Record<string, unknown>;
  }[];
};
