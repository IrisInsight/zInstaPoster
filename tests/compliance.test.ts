import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluate } from "@/lib/compliance/engine";
import type { ComplianceSubject } from "@/lib/compliance/types";

const tenant = JSON.parse(
  await readFile("tenants/precision-vitality.json", "utf8"),
);
const rules = tenant.compliance_rules;
const seeds = JSON.parse(
  await readFile("content/precision-vitality-carousels.json", "utf8"),
);

function subjectFrom(carousel: any): ComplianceSubject {
  return {
    caption: carousel.caption,
    slides: carousel.slides.map((s: any) => ({
      position: s.position,
      type: s.type,
      text: [
        s.headline,
        s.statement,
        s.attribution,
        s.script_line,
        s.sub,
        s.body,
        ...(s.items ?? []).flatMap((i: any) => [i.label, i.text]),
        ...(s.cards ?? []).flatMap((c: any) => [c.title, c.text]),
        ...(s.trust_points ?? []),
        s.disclaimer,
      ].filter(Boolean),
      photoPrompt: s.photo_prompt ?? null,
      hasPhoto: Boolean(s.photo_prompt),
    })),
  };
}

test("shipped seed carousels clear every blocking rule", () => {
  for (const carousel of seeds.carousels) {
    const report = evaluate(rules, subjectFrom(carousel));
    const blocking = report.findings.filter((f) => f.severity === "blocking");
    assert.deepEqual(
      blocking.map((f) => `${f.ruleId}: ${f.message}`),
      [],
      `${carousel.slug} should be approvable`,
    );
    assert.equal(report.approvable, true);
  }
});

test("seed carousels raise the advisory warnings they should", () => {
  const report = evaluate(rules, subjectFrom(seeds.carousels[2])); // low-libido
  const ids = report.findings.filter((f) => f.severity === "warning").map((f) => f.ruleId);
  assert.ok(ids.includes("scope-check-female-hormones"), ids.join(","));
});

test("FDA-approved near a compounded product blocks", () => {
  const carousel = structuredClone(seeds.carousels[0]);
  carousel.caption = carousel.caption.replace(
    "A topical works on the surface.",
    "Our FDA-approved compounded peptide works on the surface.",
  );
  const report = evaluate(rules, subjectFrom(carousel));
  const ids = report.findings.filter((f) => f.severity === "blocking").map((f) => f.ruleId);
  assert.ok(ids.includes("no-fda-approved-compounded"), ids.join(","));
  assert.equal(report.approvable, false);
});

test("outcome claims, price ranges and hashtag overflow block", () => {
  const carousel = structuredClone(seeds.carousels[1]);
  carousel.caption =
    carousel.caption.replace("#menshealth", "#menshealth #extra #another") +
    "\nThis protocol cures low testosterone, starting at $199.";
  const report = evaluate(rules, subjectFrom(carousel));
  const ids = new Set(
    report.findings.filter((f) => f.severity === "blocking").map((f) => f.ruleId),
  );
  assert.ok(ids.has("no-outcome-claims"), [...ids].join(","));
  assert.ok(ids.has("no-price-ranges"), [...ids].join(","));
  assert.ok(ids.has("hashtag-cap"), [...ids].join(","));
});

test("a photo of a person without the disclosure line blocks", () => {
  const carousel = structuredClone(seeds.carousels[0]);
  carousel.caption = carousel.caption.replace(
    "\n\nImages are models, not patients.",
    "",
  );
  const report = evaluate(rules, subjectFrom(carousel));
  const ids = report.findings.filter((f) => f.severity === "blocking").map((f) => f.ruleId);
  assert.ok(ids.includes("model-disclosure-required"), ids.join(","));
});

test("a compounded product without the slide disclaimer blocks", () => {
  const carousel = structuredClone(seeds.carousels[0]);
  carousel.slides[2].disclaimer = "";
  const report = evaluate(rules, subjectFrom(carousel));
  const ids = report.findings.filter((f) => f.severity === "blocking").map((f) => f.ruleId);
  assert.ok(ids.includes("compounded-disclaimer-required"), ids.join(","));
});

test("a patient testimonial blocks", () => {
  const carousel = structuredClone(seeds.carousels[3]);
  carousel.caption +=
    "\n\n“I have never felt better in my entire adult life, truly life changing” — Karen, Yorba Linda";
  const report = evaluate(rules, subjectFrom(carousel));
  const ids = report.findings.filter((f) => f.severity === "blocking").map((f) => f.ruleId);
  assert.ok(ids.includes("no-testimonials-without-authorization"), ids.join(","));
});

test("deleting the protocol slide does not delete the disclaimer requirement", () => {
  // The rule exists so a compounded product is never named without the FDA
  // disclaimer. If the absence of the slide made the rule pass, deleting the
  // slide would be a way around it.
  const carousel = structuredClone(seeds.carousels[0]);
  carousel.caption = carousel.caption.replace(
    "A topical works on the surface.",
    "Our compounded peptide formula works on the surface.",
  );
  carousel.slides = carousel.slides.filter((s: any) => s.type !== "protocol");
  const report = evaluate(rules, subjectFrom(carousel));
  const ids = report.findings.filter((f) => f.severity === "blocking").map((f) => f.ruleId);
  assert.ok(ids.includes("compounded-disclaimer-required"), ids.join(","));
  assert.equal(report.approvable, false);
});

test("the disclaimer requirement follows the template, not the protocol slide", () => {
  // A myth buster has no protocol slide. The slide that carries the FDA
  // disclaimer is the correction — naming a peptide without it still blocks,
  // and the same post with it clears.
  const carousel = structuredClone(
    seeds.carousels.find((c: any) => c.template === "myth_buster"),
  );
  carousel.slides[1].body += " A compounded peptide may be part of that plan.";

  const bare = evaluate(rules, subjectFrom(carousel));
  const ids = bare.findings.filter((f) => f.severity === "blocking").map((f) => f.ruleId);
  assert.ok(ids.includes("compounded-disclaimer-required"), ids.join(","));

  carousel.slides[1].disclaimer = tenant.disclaimers.compounded;
  const carried = evaluate(rules, subjectFrom(carousel));
  assert.deepEqual(
    carried.findings
      .filter((f) => f.severity === "blocking")
      .map((f) => `${f.ruleId}: ${f.message}`),
    [],
  );
  assert.equal(carried.approvable, true);
});

test("a single card carries its own disclaimer", () => {
  const carousel = structuredClone(
    seeds.carousels.find((c: any) => c.template === "single_card"),
  );
  carousel.caption += "\n\nAsk about compounded peptide therapy.";

  const bare = evaluate(rules, subjectFrom(carousel));
  assert.ok(
    bare.findings.some((f) => f.ruleId === "compounded-disclaimer-required"),
    "one slide is still a slide that has to carry the disclaimer",
  );

  carousel.slides[0].disclaimer = tenant.disclaimers.compounded;
  const carried = evaluate(rules, subjectFrom(carousel));
  assert.equal(carried.approvable, true);
});

test("a rule that depends on case is matched with case", () => {
  // The comment-keyword CTA is only a keyword because it is uppercase, so the
  // rule must not be satisfied by the word "comment" followed by lowercase.
  const carousel = structuredClone(seeds.carousels[0]);
  carousel.caption = carousel.caption.replace(
    "Comment SKIN and I will send you the panel we run before we recommend anything.",
    "Comment below and I will send you the panel we run before we recommend anything.",
  );
  const report = evaluate(rules, subjectFrom(carousel));
  const ids = report.findings.filter((f) => f.severity === "warning").map((f) => f.ruleId);
  assert.ok(ids.includes("caption-comment-keyword-cta"), ids.join(","));

  // The shipped caption, with a real keyword, does not raise it.
  const original = evaluate(rules, subjectFrom(seeds.carousels[0]));
  assert.ok(
    !original.findings.some((f) => f.ruleId === "caption-comment-keyword-cta"),
  );
});

test("an unknown check name blocks rather than silently passing", () => {
  const broken = {
    ruleset: "test",
    blocking: [{ id: "bogus", check: "does_not_exist", reason: "n/a" }],
    warnings: [],
  };
  const report = evaluate(broken as any, subjectFrom(seeds.carousels[0]));
  assert.equal(report.approvable, false);
  assert.match(report.findings[0].message, /unknown check/);
});
