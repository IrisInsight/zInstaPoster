import type { TenantConfig } from "@/lib/tenants";

export type SlideType = "hook" | "cause" | "protocol" | "cta";

export interface HookCopy {
  kicker: string;
  headline: string;
  script_line: string;
}

export interface CauseCopy {
  kicker: string;
  headline: string;
  sub: string;
  items: { label: string; text: string }[];
}

export interface ProtocolCopy {
  kicker: string;
  headline: string;
  cards: { title: string; text: string }[];
  disclaimer: string;
}

export interface CtaCopy {
  kicker: string;
  headline: string;
  body: string;
  trust_points: string[];
}

export type SlideCopy = HookCopy | CauseCopy | ProtocolCopy | CtaCopy;

export interface SlideInput {
  position: number;
  type: SlideType;
  copy: Record<string, unknown>;
  /** Public https URL or data: URI for the hook photo. */
  photoUrl?: string | null;
  photoPrompt?: string | null;
}

export interface RenderRequest {
  tenant: TenantConfig;
  slide: SlideInput;
}
