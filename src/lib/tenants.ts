import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { RuleSet } from "@/lib/compliance/engine";

export interface BrandTokens {
  color: Record<string, string>;
  font: { display: string; body: string; script: string };
  contrast_notes?: string[];
}

export interface OutputSpec {
  width: number;
  height: number;
  aspect: string;
  format: "jpeg";
  color_space: string;
  max_bytes: number;
}

export interface PhotoSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SlideSpec {
  has_photo?: boolean;
  photo_slot?: PhotoSlot;
  background?: string;
  elements: string[];
  items?: { min: number; max: number };
  cards?: { count: number };
  headline_max_words?: number;
  /** The fixed word the template prints on the slide, e.g. "Myth". */
  label?: string;
  /**
   * A slide the writer may leave out. Only trailing slides can be optional:
   * a template is a prefix of its own structure, never a gap in the middle.
   */
  optional?: boolean;
  rule?: string;
}

export interface TemplateDefinition {
  slides: number;
  structure: string[];
  /** One line on what this template is for. Shown in the picker, and it is
   *  what the model reads when it infers a template from a prompt. */
  use_when?: string;
  slide_specs: Record<string, SlideSpec>;
}

const DEFAULT_PHOTO_SLOT: PhotoSlot = { x: 0, y: 0, w: 1080, h: 560 };

/**
 * Where a slide's photo goes. Named per slide type, because the slide that
 * carries the photograph is the hook in one template and the whole card in
 * another.
 */
export function photoSlotFor(
  template: TemplateDefinition | undefined,
  slideType: string,
): PhotoSlot {
  const spec = template?.slide_specs?.[slideType];
  if (spec?.photo_slot) return spec.photo_slot;
  const anySlot = Object.values(template?.slide_specs ?? {}).find(
    (s) => s.photo_slot,
  )?.photo_slot;
  return anySlot ?? DEFAULT_PHOTO_SLOT;
}

/**
 * The shortest run a template accepts. Trailing slides marked `optional` may
 * be dropped — a myth buster is two slides, or three when the consult card
 * earns its place.
 */
export function minimumSlides(template: TemplateDefinition): number {
  let count = template.structure.length;
  for (let i = template.structure.length - 1; i >= 0; i--) {
    if (!template.slide_specs?.[template.structure[i]]?.optional) break;
    count -= 1;
  }
  return Math.max(1, count);
}

export interface TenantConfig {
  slug: string;
  name: string;
  vertical: string;
  website: string;
  booking_url: string;
  locale: string;
  timezone: string;
  brand_tokens: BrandTokens;
  output: OutputSpec;
  compliance_rules: RuleSet;
  templates: Record<string, TemplateDefinition>;
  /** The template a post falls back to when nothing else picks one. */
  primary_template?: string;
  disclaimers: Record<string, string>;
  footer: { left: string; right: string; contact: string };
}

/**
 * The tenant's default template.
 *
 * Not "the first key": templates round-trip through a jsonb column, and
 * Postgres does not preserve key order. Which template a post gets by default
 * is not something to leave to that.
 */
export function primaryTemplate(tenant: TenantConfig): string {
  const names = Object.keys(tenant.templates ?? {});
  if (names.length === 0) throw new Error(`Tenant ${tenant.slug} has no templates.`);
  return tenant.primary_template && names.includes(tenant.primary_template)
    ? tenant.primary_template
    : names[0];
}

const TENANTS_DIR = path.join(process.cwd(), "tenants");

/** Reads the seed files. The database is the runtime source of truth. */
export async function readTenantFiles(): Promise<TenantConfig[]> {
  const files = await readdir(TENANTS_DIR);
  const configs: TenantConfig[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const raw = await readFile(path.join(TENANTS_DIR, file), "utf8");
    configs.push(JSON.parse(raw) as TenantConfig);
  }
  return configs.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function readTenantFile(slug: string): Promise<TenantConfig> {
  const raw = await readFile(path.join(TENANTS_DIR, `${slug}.json`), "utf8");
  return JSON.parse(raw) as TenantConfig;
}

/** Rebuilds the full config object from the columns it was split across. */
export function tenantConfigFromRow(row: {
  slug: string;
  name: string;
  vertical: string;
  timezone: string;
  brandTokens: unknown;
  complianceRules: unknown;
  templateSet: unknown;
  config: unknown;
}): TenantConfig {
  const rest = (row.config ?? {}) as Partial<TenantConfig>;
  return {
    ...rest,
    slug: row.slug,
    name: row.name,
    vertical: row.vertical,
    timezone: row.timezone,
    brand_tokens: row.brandTokens as BrandTokens,
    compliance_rules: row.complianceRules as RuleSet,
    templates: row.templateSet as Record<string, TemplateDefinition>,
  } as TenantConfig;
}

export function splitTenantConfig(config: TenantConfig) {
  const {
    brand_tokens,
    compliance_rules,
    templates,
    slug,
    name,
    vertical,
    timezone,
    ...rest
  } = config;
  return {
    slug,
    name,
    vertical,
    timezone,
    brandTokens: brand_tokens,
    complianceRules: compliance_rules,
    templateSet: templates,
    config: rest,
  };
}

export const DEFAULT_OUTPUT: OutputSpec = {
  width: 1080,
  height: 1350,
  aspect: "4:5",
  format: "jpeg",
  color_space: "srgb",
  max_bytes: 8 * 1024 * 1024,
};
