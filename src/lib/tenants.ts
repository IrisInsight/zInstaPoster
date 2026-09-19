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

export interface SlideSpec {
  has_photo?: boolean;
  photo_slot?: { x: number; y: number; w: number; h: number };
  background?: string;
  elements: string[];
  items?: { min: number; max: number };
  cards?: { count: number };
  headline_max_words?: number;
  rule?: string;
}

export interface TemplateDefinition {
  slides: number;
  structure: string[];
  slide_specs: Record<string, SlideSpec>;
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
  disclaimers: Record<string, string>;
  footer: { left: string; right: string; contact: string };
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
