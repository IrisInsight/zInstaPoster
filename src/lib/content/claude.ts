import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { rulesAsPromptGuidance } from "@/lib/compliance/engine";
import { env } from "@/lib/env";
import type { TenantConfig } from "@/lib/tenants";
import {
  assertMatchesTemplate,
  carouselSchemaFor,
  type GeneratedCarousel,
} from "./schema";

let client: Anthropic | undefined;

function anthropic(): Anthropic {
  if (!env.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set, so slide copy cannot be generated.",
    );
  }
  client ??= new Anthropic({ apiKey: env.anthropicApiKey });
  return client;
}

export function copyGenerationAvailable(): boolean {
  return Boolean(env.anthropicApiKey);
}

function systemPrompt(tenant: TenantConfig, templateName: string): string {
  const template = tenant.templates[templateName];
  const specs = Object.entries(template.slide_specs)
    .map(([name, spec]) => {
      const bits = [`slide "${name}"`];
      if (spec.rule) bits.push(spec.rule);
      if (spec.items) bits.push(`${spec.items.min}–${spec.items.max} items`);
      if (spec.cards) bits.push(`exactly ${spec.cards.count} cards`);
      if (spec.headline_max_words)
        bits.push(`headline ≤ ${spec.headline_max_words} words`);
      return `- ${bits.join(" — ")}`;
    })
    .join("\n");

  return [
    `You write Instagram carousel copy for ${tenant.name}, a ${tenant.vertical} in ${tenant.footer?.contact ?? tenant.locale}.`,
    "",
    "Voice: plain, specific, clinical without being cold. Short sentences. No hype, no emoji, no exclamation marks.",
    "Write about mechanisms, never outcomes. The reader should finish the carousel understanding why a symptom happens and what would be measured.",
    "",
    `Template "${templateName}" — ${template.slides} slides in order: ${template.structure.join(" → ")}.`,
    specs,
    "",
    "Caption requirements:",
    "- Under 2,200 characters.",
    "- At most 5 hashtags, on the final line.",
    "- Include a comment-keyword call to action using the keyword you chose.",
    "- Include the free 15-minute consult line.",
    tenant.disclaimers?.model
      ? `- When the hook photo shows a person, include this line verbatim: "${tenant.disclaimers.model}"`
      : "",
    "",
    "Disclaimers — copy one of these verbatim onto the protocol slide. Never paraphrase them:",
    ...Object.entries(tenant.disclaimers ?? {}).map(
      ([key, value]) => `- ${key}: ${value}`,
    ),
    "Use the compounded disclaimer whenever a compounded product, peptide or bioidentical hormone is named anywhere in the carousel; otherwise use the general one.",
    "",
    "Compliance rules. These are enforced in code after you write, and a violation blocks the post from reaching a human reviewer:",
    rulesAsPromptGuidance(tenant.compliance_rules),
    "",
    "Photo prompts describe stock-style photography of people who are not patients. Never describe a clinical setting, a uniform, a medical device, text, or a logo.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Picks a template from the prompt when the tenant has more than one.
 *
 * The picker in the compose screen is an override, not a required step: with a
 * single template this never calls the API, and if the call fails the tenant's
 * primary template is used rather than blocking the generation.
 */
export async function inferTemplate(input: {
  tenant: TenantConfig;
  prompt: string;
}): Promise<{ template: string; inferred: boolean }> {
  const names = Object.keys(input.tenant.templates ?? {});
  if (names.length === 0) throw new Error(`Tenant ${input.tenant.slug} has no templates.`);
  if (names.length === 1 || !copyGenerationAvailable()) {
    return { template: names[0], inferred: false };
  }

  const described = names
    .map((name) => {
      const template = input.tenant.templates[name];
      const rules = Object.values(template.slide_specs)
        .map((spec) => spec.rule)
        .filter(Boolean)
        .join(" ");
      return `- ${name}: ${template.structure.join(" → ")}. ${rules}`;
    })
    .join("\n");

  try {
    const message = await anthropic().messages.create({
      model: env.anthropicModel,
      max_tokens: 1000,
      system: [
        {
          type: "text",
          text: [
            "Pick the template that best fits a post request.",
            "Answer with the template name alone. No punctuation, no explanation.",
            "Templates:",
            described,
          ].join("\n"),
        },
      ],
      messages: [{ role: "user", content: input.prompt }],
    });
    const answer = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .toLowerCase();
    const match = names.find((name) => answer.includes(name.toLowerCase()));
    return match ? { template: match, inferred: true } : { template: names[0], inferred: false };
  } catch {
    return { template: names[0], inferred: false };
  }
}

export interface GenerateCopyOptions {
  tenant: TenantConfig;
  templateName: string;
  prompt: string;
  reference?: string | null;
  /** Called with raw text deltas so the UI can show copy arriving. */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export async function generateCarouselCopy(
  options: GenerateCopyOptions,
): Promise<GeneratedCarousel> {
  const { tenant, templateName, prompt, reference } = options;
  const template = tenant.templates[templateName];
  if (!template) {
    throw new Error(`Tenant ${tenant.slug} has no template "${templateName}".`);
  }

  const schema = carouselSchemaFor(template);
  const userContent = [
    `Write one ${templateName} carousel about: ${prompt}`,
    reference ? `\nSource material to work from:\n${reference}` : "",
  ]
    .join("\n")
    .trim();

  const stream = anthropic().messages.stream(
    {
      model: env.anthropicModel,
      max_tokens: 16000,
      system: [
        {
          type: "text",
          text: systemPrompt(tenant, templateName),
          // The system prompt is identical for every post for this tenant.
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userContent }],
      output_config: { format: zodOutputFormat(schema) },
    },
    { signal: options.signal },
  );

  if (options.onDelta) {
    stream.on("text", (delta) => options.onDelta?.(delta));
  }

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(
      "The copy model declined this request. Rewrite the prompt and try again.",
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Copy generation was truncated before it finished.");
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `Copy generation returned a shape we cannot use: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
  }

  const carousel = parsed.data as GeneratedCarousel;
  // The schema cannot pin slide order, so the template's shape is asserted here.
  carousel.slides.sort((a, b) => a.position - b.position);
  assertMatchesTemplate(carousel, template);
  return carousel;
}

/**
 * Rewrites one field on one slide, used by the review screen's inline edits
 * when a human asks for an alternative rather than typing it themselves.
 */
export async function rewriteField(input: {
  tenant: TenantConfig;
  instruction: string;
  current: string;
  context: string;
}): Promise<string> {
  const message = await anthropic().messages.create({
    model: env.anthropicModel,
    max_tokens: 2000,
    system: [
      {
        type: "text",
        text: [
          `You are editing one field of an Instagram carousel for ${input.tenant.name}.`,
          "Return only the replacement text. No quotes, no preamble, no explanation.",
          "Mechanisms, never outcomes. Keep roughly the same length.",
          rulesAsPromptGuidance(input.tenant.compliance_rules),
        ].join("\n"),
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          `Context: ${input.context}`,
          `Current text: ${input.current}`,
          `Change requested: ${input.instruction}`,
        ].join("\n"),
      },
    ],
  });
  if (message.stop_reason === "refusal") {
    throw new Error("The model declined this edit.");
  }
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
