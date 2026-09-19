export type Severity = "blocking" | "warning";

/** Where a finding was found, so the UI can point at it. */
export interface FindingLocation {
  field: "caption" | "slide" | "photo_prompt" | "post";
  slidePosition?: number;
  label: string;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  /** One line, shown as the finding headline. */
  message: string;
  /** Why the rule exists — the citation. Comes from tenant config. */
  reason: string;
  /** What to do about it. */
  fix?: string;
  location: FindingLocation;
  /** The matched text, for highlighting. */
  excerpt?: string;
}

export interface ComplianceReport {
  ruleset: string;
  evaluatedAt: string;
  checksRun: number;
  passed: number;
  findings: Finding[];
  /** True when nothing blocking was found. The approve button reads this. */
  approvable: boolean;
}

/** The document a ruleset is evaluated against. */
export interface ComplianceSubject {
  caption: string;
  slides: {
    position: number;
    type: string;
    /** Every human-visible string on the slide, in reading order. */
    text: string[];
    photoPrompt?: string | null;
    hasPhoto: boolean;
  }[];
}

export interface RuleDefinition {
  id: string;
  /** Name of a predicate in the registry. */
  check: string;
  /** Prose description of the test, for humans reading tenant config. */
  test?: string;
  reason: string;
  fix?: string;
  message?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RuleSet {
  ruleset: string;
  blocking: RuleDefinition[];
  warnings: RuleDefinition[];
  required_caption_elements?: string[];
  posting_windows?: {
    preferred?: string[];
    avoid?: string[];
  };
}

export interface PredicateContext {
  rule: RuleDefinition;
  subject: ComplianceSubject;
  severity: Severity;
}

export type Predicate = (ctx: PredicateContext) => Finding[];
