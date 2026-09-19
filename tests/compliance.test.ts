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
