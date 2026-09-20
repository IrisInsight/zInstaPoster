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
  assert.ok(ids.includes("second-person-condition-framing"), ids.join(","));
});

test("the scope warning reads an offer of therapy, not a hormone", () => {
  // The practice has to be able to say what estradiol does — it is half of why
  // a testosterone number reads the way it does. What needs a human to confirm
  // scope is offering the therapy, not naming the hormone.
  for (const carousel of seeds.carousels) {
    const report = evaluate(rules, subjectFrom(carousel));
    assert.ok(
      !report.findings.some((f) => f.ruleId === "scope-check-female-hormones"),
      `${carousel.slug} names female hormones as mechanisms and lab values, not as an offer`,
    );
  }

  const offers = [
    "Ask about HRT.",
    "We start estrogen therapy once the panel is back.",
    "We prescribe bioidentical estradiol.",
    "Our menopause program starts with a panel.",
  ];
  for (const offer of offers) {
    const carousel = structuredClone(seeds.carousels[5]); // testosterone-number
    carousel.caption += `\n\n${offer}`;
    const report = evaluate(rules, subjectFrom(carousel));
    assert.ok(
      report.findings.some((f) => f.ruleId === "scope-check-female-hormones"),
      offer,
    );
  }
});

test("a thyroid lab value is not an outcome claim", () => {
  // From a live myth_buster generation: "reverse T3" is a thyroid lab value,
  // and the word "reverse" inside it blocked approval on copy that claims
  // nothing. The caption around the two reported lines is reconstructed; the
  // lines themselves — "reverse T3" and the binding sentence — are verbatim.
  const post = {
    template: "myth_buster",
    slug: "normal-tsh",
    caption: [
      "A normal TSH does not mean the thyroid question is answered.",
      "",
      "TSH is a pituitary signal. Free T4, free T3 and reverse T3 are what the tissue actually sees, and the three can disagree with a TSH sitting mid-range. Estrogen exposure and liver status both shift binding, so the same total can sit over very different free levels.",
      "",
      "That is why the panel comes before anyone talks about a protocol.",
      "",
      "Comment THYROID and I will send you the full list of what we test.",
      "",
      "Free 15-minute consult — link in bio. Telehealth across California, in-person in Yorba Linda.",
      "",
      "#thyroid #thyroidhealth #hormonehealth #yorbalinda #functionalmedicine",
    ].join("\n"),
    slides: [
      {
        position: 1,
        type: "myth",
        headline: "A normal TSH means the thyroid is fine.",
      },
      {
        position: 2,
        type: "correction",
        headline: "TSH is a pituitary signal, not a thyroid measurement.",
        body: "TSH says what the pituitary is asking for. Free T4, free T3 and reverse T3 say what the tissue is getting. Estrogen exposure and liver status both shift binding, so the same TSH can sit over very different free levels.",
        disclaimer: "",
      },
    ],
  };

  const report = evaluate(rules, subjectFrom(post));
  assert.deepEqual(
    report.findings.map((f) => `${f.ruleId}: ${f.message}`),
    [],
    "nothing in this post is a claim, an offer, or a missing element",
  );
  assert.equal(report.approvable, true);
});

test("an exempt term does not exempt the word inside it", () => {
  // "reverse T3" is allowed by name. Everything else "reverse" can do is not.
  const claims = [
    "This protocol reverses hair loss.",
    "We can reverse hypothyroidism.",
    "A peptide that erases fine lines.",
    "It fixes the cortisol curve.",
    "This eliminates brain fog.",
  ];
  for (const claim of claims) {
    const carousel = structuredClone(seeds.carousels[5]);
    carousel.slides[1].body += ` ${claim}`;
    const report = evaluate(rules, subjectFrom(carousel));
    assert.ok(
      report.findings.some(
        (f) => f.ruleId === "no-outcome-claims" && f.severity === "blocking",
      ),
      claim,
    );
    assert.equal(report.approvable, false, claim);
  }
});

test("a banned word that is not claiming anything does not block", () => {
  // The rule exists to stop the practice promising an outcome. A word sitting
  // in a noun phrase, or inside a negation, is not promising one.
  const notClaims = [
    "There is no cure for this, and anyone selling one is not being straight with you.",
    "The fix is simple: measure first.",
    "A cortisol curve can run in reverse.",
    "A protocol does not cure anything on its own.",
  ];
  for (const line of notClaims) {
    const carousel = structuredClone(seeds.carousels[5]);
    carousel.slides[1].body += ` ${line}`;
    const report = evaluate(rules, subjectFrom(carousel));
    assert.ok(
      !report.findings.some((f) => f.ruleId === "no-outcome-claims"),
      line,
    );
  }

  // "guaranteed" is banned wherever it appears, claim or not — only the
  // mandated disclaimer wording is allowed to carry it.
  const carousel = structuredClone(seeds.carousels[5]);
  carousel.slides[1].body += " Results are guaranteed.";
  assert.ok(
    evaluate(rules, subjectFrom(carousel)).findings.some(
      (f) => f.ruleId === "no-outcome-claims",
    ),
  );
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
