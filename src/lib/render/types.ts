import type { TenantConfig } from "@/lib/tenants";

export type SlideType =
  | "hook"
  | "cause"
  | "protocol"
  | "cta"
  | "myth"
  | "correction"
  | "statement";

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

export interface MythCopy {
  kicker: string;
  headline: string;
}

export interface CorrectionCopy {
  kicker: string;
  headline: string;
  body: string;
  disclaimer?: string;
}

export interface StatementCopy {
  kicker: string;
  statement: string;
  attribution?: string;
  disclaimer?: string;
}

export type SlideCopy =
  | HookCopy
  | CauseCopy
  | ProtocolCopy
  | CtaCopy
  | MythCopy
  | CorrectionCopy
  | StatementCopy;

export interface SlideInput {
  position: number;
  type: SlideType;
  copy: Record<string, unknown>;
  /** Public https URL or data: URI for the slide's photo. */
  photoUrl?: string | null;
  photoPrompt?: string | null;
  /** The post's template. Decides photo slots and the labels a slide carries. */
  template?: string;
}

export interface RenderRequest {
  tenant: TenantConfig;
  slide: SlideInput;
}
