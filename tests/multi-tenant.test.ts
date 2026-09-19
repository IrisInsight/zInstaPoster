import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluate, predicateNames } from "@/lib/compliance/engine";
import type { ComplianceSubject, RuleSet } from "@/lib/compliance/types";

/**
 * The rules engine has to be data-driven, because tenants 2–15 are senior
 * living communities with a Fair Housing ruleset, not a medical one. These
 * tests run a completely different ruleset through the same engine with no
 * code path of its own.
 */

const medical: RuleSet = JSON.parse(
  await readFile("tenants/precision-vitality.json", "utf8"),
).compliance_rules;

const seniorLiving: RuleSet = JSON.parse(
  await readFile("docs/example-tenant-senior-living.json", "utf8"),
).compliance_rules;

function subject(caption: string, photoPrompt?: string): ComplianceSubject {
  return {
    caption,
    slides: [
      {
        position: 1,
        type: "hook",
        text: ["Is it time to talk about moving?"],
        photoPrompt: photoPrompt ?? null,
        hasPhoto: Boolean(photoPrompt),
      },
      { position: 2, type: "cause", text: ["What to look for on a tour"], hasPhoto: false },
    ],
  };
}

test("both rulesets only name predicates the engine actually has", () => {
  for (const ruleSet of [medical, seniorLiving]) {
    for (const rule of [...ruleSet.blocking, ...ruleSet.warnings]) {
      assert.ok(
        predicateNames.includes(rule.check),
        `${ruleSet.ruleset}/${rule.id} names unknown check "${rule.check}"`,
      );
    }
  }
});

test("the two rulesets are genuinely different rules, not the same list renamed", () => {
  const a = new Set(medical.blocking.map((r) => r.id));
  const b = new Set(seniorLiving.blocking.map((r) => r.id));
  const shared = [...a].filter((id) => b.has(id));
  assert.deepEqual(shared, ["hashtag-cap"], "only the platform limit is shared");
});

test("Fair Housing preference language blocks a senior living post", () => {
  const report = evaluate(
    seniorLiving,
    subject(
      "A warm Christian community perfect for traditional families. Book a tour.",
    ),
  );
  const ids = report.findings.filter((f) => f.severity === "blocking").map((f) => f.ruleId);
  assert.ok(ids.includes("fair-housing-no-preference-language"), ids.join(","));
  assert.equal(report.approvable, false);
});

test("an age claim without the HOPA qualification blocks, with it passes", () => {
  const bare = evaluate(seniorLiving, subject("Now leasing, 55+ living. Book a tour."));
  assert.ok(
    bare.findings.some((f) => f.ruleId === "hopa-age-claim-requires-qualification"),
  );

  const qualified = evaluate(
    seniorLiving,
    subject(
      "Now leasing, 55+ living. This community qualifies under the Housing for Older Persons Act. Book a tour.",
    ),
  );
  assert.ok(
    !qualified.findings.some(
      (f) => f.ruleId === "hopa-age-claim-requires-qualification",
    ),
  );
});

test("a photo of a person needs this tenant's own disclosure line, not the medical one", () => {
  const withMedicalLine = evaluate(
    seniorLiving,
    subject(
      "Come see the courtyard. Book a tour. Images are models, not patients.",
      "A resident reading by a window, warm afternoon light.",
    ),
  );
  assert.ok(
    withMedicalLine.findings.some((f) => f.ruleId === "resident-photo-release-required"),
    "the medical disclosure does not satisfy a senior living rule",
  );

  const correct = evaluate(
    seniorLiving,
    subject(
      "Come see the courtyard. Book a tour. Photography does not depict current residents.",
      "A resident reading by a window, warm afternoon light.",
    ),
  );
  assert.ok(
    !correct.findings.some((f) => f.ruleId === "resident-photo-release-required"),
  );
});

test("medical rules do not leak into the senior living tenant", () => {
  const report = evaluate(
    seniorLiving,
    subject("Our chef prepares every meal. No compounded anything here. Book a tour."),
  );
  const ids = report.findings.map((f) => f.ruleId);
  assert.ok(!ids.includes("no-fda-approved-compounded"));
  assert.ok(!ids.includes("model-disclosure-required"));
});

test("the same caption is judged differently by each tenant", () => {
  const caption =
    "Perfect for traditional families. Our protocol cures fatigue. Book a tour.";
  const medicalReport = evaluate(medical, subject(caption));
  const seniorReport = evaluate(seniorLiving, subject(caption));

  const medicalIds = medicalReport.findings.map((f) => f.ruleId);
  const seniorIds = seniorReport.findings.map((f) => f.ruleId);

  assert.ok(medicalIds.includes("no-outcome-claims"));
  assert.ok(!medicalIds.includes("fair-housing-no-preference-language"));
  assert.ok(seniorIds.includes("fair-housing-no-preference-language"));
});
