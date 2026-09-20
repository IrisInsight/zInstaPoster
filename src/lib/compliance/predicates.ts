import type {
  Finding,
  FindingLocation,
  Predicate,
  PredicateContext,
} from "./types";

/**
 * Generic, parameterised predicates.
 *
 * Nothing in this file knows about medicine, Fair Housing, or any particular
 * tenant. A ruleset in tenant config names a predicate and supplies its
 * params; adding a senior-living tenant means writing config, not code.
 */

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive literal match that respects word boundaries only where the
 * phrase actually starts/ends with a word character — so "from $" and "FDA-approved"
 * both behave.
 */
function literalPattern(phrase: string): RegExp {
  const body = escape(phrase);
  const left = /^\w/.test(phrase) ? "\\b" : "";
  const right = /\w$/.test(phrase) ? "\\b" : "";
  return new RegExp(`${left}${body}${right}`, "gi");
}

function strings(params: Record<string, unknown> | undefined, key: string): string[] {
  const value = params?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function num(
  params: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const value = params?.[key];
  return typeof value === "number" ? value : fallback;
}

/**
 * Regex flags for a rule's own patterns. Most rules want case-insensitive
 * matching, but some depend on case — a comment-keyword CTA is only a keyword
 * because it is uppercase — so the rule decides.
 */
function flags(
  params: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const value = params?.flags;
  return typeof value === "string" ? value : fallback;
}

/**
 * Suppression window. A rule can carry `except_patterns`: when the text around
 * a hit matches one of them, the hit is dropped. This is what keeps
 * "Treatment ... is not guaranteed" — mandated disclaimer language — from
 * tripping a ban on the word "guaranteed".
 */
function suppressed(
  params: Record<string, unknown> | undefined,
  text: string,
  index: number,
  length: number,
): boolean {
  const exceptions = strings(params, "except_patterns");
  if (exceptions.length === 0) return false;
  const window = num(params, "except_window", 40);
  const slice = text.slice(
    Math.max(0, index - window),
    Math.min(text.length, index + length + window),
  );
  return exceptions.some((source) => new RegExp(source, "i").test(slice));
}

/** Every searchable text region of the subject, with its location. */
function regions(
  ctx: PredicateContext,
  opts: { includePhotoPrompts?: boolean } = {},
): { text: string; location: FindingLocation }[] {
  const out: { text: string; location: FindingLocation }[] = [
    { text: ctx.subject.caption, location: { field: "caption", label: "Caption" } },
  ];
  for (const s of ctx.subject.slides) {
    out.push({
      text: s.text.join("\n"),
      location: {
        field: "slide",
        slidePosition: s.position,
        label: `Slide ${s.position}`,
      },
    });
    if (opts.includePhotoPrompts && s.photoPrompt) {
      out.push({
        text: s.photoPrompt,
        location: {
          field: "photo_prompt",
          slidePosition: s.position,
          label: `Slide ${s.position} photo prompt`,
        },
      });
    }
  }
  return out;
}

function finding(
  ctx: PredicateContext,
  location: FindingLocation,
  message: string,
  excerpt?: string,
): Finding {
  return {
    ruleId: ctx.rule.id,
    severity: ctx.severity,
    message: ctx.rule.message ?? message,
    reason: ctx.rule.reason,
    fix: ctx.rule.fix,
    location,
    excerpt,
  };
}

function context(text: string, index: number, length: number, pad = 48): string {
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + length + pad);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${
    end < text.length ? "…" : ""
  }`;
}

/** Any of `phrases` appears anywhere. */
const bannedPhrases: Predicate = (ctx) => {
  const phrases = strings(ctx.rule.params, "phrases");
  const findings: Finding[] = [];
  for (const region of regions(ctx)) {
    for (const phrase of phrases) {
      const re = literalPattern(phrase);
      let match: RegExpExecArray | null;
      while ((match = re.exec(region.text))) {
        if (
          !suppressed(ctx.rule.params, region.text, match.index, match[0].length)
        ) {
          findings.push(
            finding(
              ctx,
              region.location,
              `“${match[0]}” appears in ${region.location.label.toLowerCase()}.`,
              context(region.text, match.index, match[0].length),
            ),
          );
        }
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return findings;
};

/** Any of `patterns` (regular expressions) matches. */
const patternMatch: Predicate = (ctx) => {
  const patterns = strings(ctx.rule.params, "patterns");
  const includePhotoPrompts = ctx.rule.params?.include_photo_prompts === true;
  const findings: Finding[] = [];
  for (const region of regions(ctx, { includePhotoPrompts })) {
    const patternFlags = flags(ctx.rule.params, "gi");
    for (const source of patterns) {
      const re = new RegExp(source, patternFlags.includes("g") ? patternFlags : `${patternFlags}g`);
      let match: RegExpExecArray | null;
      while ((match = re.exec(region.text))) {
        if (
          !suppressed(ctx.rule.params, region.text, match.index, match[0].length)
        ) {
          findings.push(
            finding(
              ctx,
              region.location,
              `Matched in ${region.location.label.toLowerCase()}: “${match[0]
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 60)}”.`,
              context(region.text, match.index, match[0].length),
            ),
          );
        }
        if (match.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return findings;
};

/**
 * Any `phrases` term within `window` characters of any `near` term.
 * This is the shape of most drug-promotion rules: the words are fine
 * separately and a violation together.
 */
const phraseProximity: Predicate = (ctx) => {
  const phrases = strings(ctx.rule.params, "phrases");
  const near = strings(ctx.rule.params, "near");
  const window = num(ctx.rule.params, "window", 200);
  const findings: Finding[] = [];

  for (const region of regions(ctx)) {
    const hits: { term: string; index: number; length: number }[] = [];
    const anchors: { term: string; index: number }[] = [];
    for (const phrase of phrases) {
      const re = literalPattern(phrase);
      let m: RegExpExecArray | null;
      while ((m = re.exec(region.text))) {
        hits.push({ term: m[0], index: m.index, length: m[0].length });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
    if (hits.length === 0) continue;
    for (const term of near) {
      const re = literalPattern(term);
      let m: RegExpExecArray | null;
      while ((m = re.exec(region.text))) {
        anchors.push({ term: m[0], index: m.index });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
    for (const hit of hits) {
      const anchor = anchors.find(
        (a) => Math.abs(a.index - hit.index) <= window,
      );
      if (!anchor) continue;
      findings.push(
        finding(
          ctx,
          region.location,
          `“${hit.term}” appears within ${window} characters of “${anchor.term}”.`,
          context(region.text, hit.index, hit.length, 80),
        ),
      );
    }
  }
  return findings;
};

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A required line must be present in the caption.
 * `when: "photo_of_person"` only requires it when a slide carries a photo whose
 * prompt names a person — the heuristic is listed in `person_terms` so a tenant
 * can widen or narrow it without a code change.
 */
const requiredCaptionLine: Predicate = (ctx) => {
  const line =
    typeof ctx.rule.params?.line === "string"
      ? (ctx.rule.params.line as string)
      : typeof ctx.rule.required_line === "string"
        ? (ctx.rule.required_line as string)
        : "";
  if (!line) return [];

  const when = (ctx.rule.params?.when as string) ?? "always";
  if (when === "photo_of_person") {
    const personTerms = strings(ctx.rule.params, "person_terms");
    const depicts = ctx.subject.slides.some((s) => {
      if (!s.hasPhoto) return false;
      const prompt = (s.photoPrompt ?? "").toLowerCase();
      return personTerms.some((term) =>
        new RegExp(`\\b${escape(term.toLowerCase())}`, "i").test(prompt),
      );
    });
    if (!depicts) return [];
  } else if (when === "photo_present") {
    if (!ctx.subject.slides.some((s) => s.hasPhoto)) return [];
  }

  if (normalise(ctx.subject.caption).includes(normalise(line))) return [];
  return [
    finding(
      ctx,
      { field: "caption", label: "Caption" },
      `Caption is missing the required line: “${line}”`,
    ),
  ];
};

/** Caption must contain at most `max` hashtags. */
const maxHashtags: Predicate = (ctx) => {
  const max = num(ctx.rule.params, "max", 5);
  const tags = ctx.subject.caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? [];
  if (tags.length <= max) return [];
  return [
    finding(
      ctx,
      { field: "caption", label: "Caption" },
      `${tags.length} hashtags in the caption. The cap is ${max}.`,
      tags.map((t) => t.trim()).join(" "),
    ),
  ];
};

/** Caption must contain at least one of `patterns`. Used for CTA elements. */
const requiresOneOf: Predicate = (ctx) => {
  const patterns = strings(ctx.rule.params, "patterns");
  const patternFlags = flags(ctx.rule.params, "i");
  const present = patterns.some((p) =>
    new RegExp(p, patternFlags).test(ctx.subject.caption),
  );
  if (present) return [];
  return [
    finding(
      ctx,
      { field: "caption", label: "Caption" },
      ctx.rule.message ?? `Caption is missing a required element.`,
    ),
  ];
};

/**
 * When any of `triggers` appears anywhere in the post, one of the named slide
 * types must carry `disclaimer_text`. Compounded-product disclaimers work this
 * way. `slide_types` lists every slide that may carry it — which slide that is
 * depends on the template, so a rule that named only one would pass a post
 * simply for using a different template.
 */
const conditionalDisclaimer: Predicate = (ctx) => {
  const triggers = strings(ctx.rule.params, "triggers");
  const named = strings(ctx.rule.params, "slide_types");
  const slideTypes = named.length
    ? named
    : [(ctx.rule.params?.slide_type as string) ?? "protocol"];
  const text =
    typeof ctx.rule.params?.disclaimer_text === "string"
      ? (ctx.rule.params.disclaimer_text as string)
      : "";
  if (!text) return [];

  const haystack = [
    ctx.subject.caption,
    ...ctx.subject.slides.flatMap((s) => s.text),
  ].join("\n");
  const triggered = triggers.some((t) => literalPattern(t).test(haystack));
  if (!triggered) return [];

  const slides = ctx.subject.slides.filter((s) => slideTypes.includes(s.type));
  if (slides.length === 0) {
    // The trigger fired and there is nowhere for the disclaimer to appear.
    // Passing here would mean deleting the slide removes the requirement.
    return [
      finding(
        ctx,
        { field: "post", label: "Post" },
        `A ${triggers.length === 1 ? triggers[0] : "restricted"} product is named but this post has no ${slideTypes.join(" or ")} slide to carry the required disclaimer.`,
      ),
    ];
  }
  const carries = slides.some((s) =>
    normalise(s.text.join(" ")).includes(normalise(text)),
  );
  if (carries) return [];
  return [
    finding(
      ctx,
      {
        field: "slide",
        slidePosition: slides[0].position,
        label: `Slide ${slides[0].position}`,
      },
      `A compounded product is named but slide ${slides[0].position} is missing the required disclaimer.`,
    ),
  ];
};

export const predicates: Record<string, Predicate> = {
  banned_phrases: bannedPhrases,
  pattern_match: patternMatch,
  phrase_proximity: phraseProximity,
  required_caption_line: requiredCaptionLine,
  max_hashtags: maxHashtags,
  requires_one_of: requiresOneOf,
  conditional_disclaimer: conditionalDisclaimer,
};

export const predicateNames = Object.keys(predicates);
