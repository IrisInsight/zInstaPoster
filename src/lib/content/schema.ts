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

const slideEnvelope = z.object({
  position: z.number().int(),
  type: z.string(),
  alt_text: z
    .string()
    .describe("Describes what is on the slide for a screen reader. Max 1000 characters."),
});

/**
 * Builds the output schema for one template. Every slide is emitted as a
 * position/type/alt_text envelope plus the copy fields for that slide type.
 */
export function carouselSchemaFor(template: TemplateDefinition) {
  const slideSchemas = template.structure.map((type, index) => {
    const copySchema = isKnownSlideType(type)
      ? SLIDE_SCHEMAS[type]
      : z.object({ headline: z.string() });
    return slideEnvelope.extend({
      position: z.literal(index + 1),
      type: z.literal(type),
      copy: copySchema,
    });
  });

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
    slides: z.tuple(
      slideSchemas as unknown as [z.ZodTypeAny, ...z.ZodTypeAny[]],
    ),
  });
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
