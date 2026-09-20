import { predicates } from "./predicates";
import type {
  ComplianceReport,
  ComplianceSubject,
  Finding,
  RuleDefinition,
  RuleSet,
  Severity,
} from "./types";

export * from "./types";
export { predicates, predicateNames } from "./predicates";

/**
 * Runs a tenant's ruleset over a post.
 *
 * Compliance is enforced here, in code, against the model's output — the rules
 * are also fed to the model as prompt guidance, but prompt guidance is not
 * enforcement.
 */
export function evaluate(
  ruleSet: RuleSet,
  subject: ComplianceSubject,
): ComplianceReport {
  const findings: Finding[] = [];
  const rules: { rule: RuleDefinition; severity: Severity }[] = [
    ...(ruleSet.blocking ?? []).map((rule) => ({
      rule,
      severity: "blocking" as const,
    })),
    ...(ruleSet.warnings ?? []).map((rule) => ({
      rule,
      severity: "warning" as const,
    })),
  ];

  let passed = 0;
  for (const { rule, severity } of rules) {
    const predicate = predicates[rule.check];
    if (!predicate) {
      // A ruleset naming a predicate that does not exist is a configuration
      // bug, and silently passing would be the worst possible failure mode.
      findings.push({
        ruleId: rule.id,
        severity: "blocking",
        message: `Rule "${rule.id}" names unknown check "${rule.check}".`,
        reason:
          "This tenant's ruleset cannot be fully evaluated, so the post cannot be cleared.",
        fix: "Fix the tenant configuration, or remove the rule.",
        location: { field: "post", label: "Ruleset" },
      });
      continue;
    }
    const result = predicate({ rule, subject, severity });
    if (result.length === 0) passed += 1;
    findings.push(...dedupe(result));
  }

  return {
    ruleset: ruleSet.ruleset ?? "unknown",
    evaluatedAt: new Date().toISOString(),
    checksRun: rules.length,
    passed,
    findings,
    approvable: !findings.some((f) => f.severity === "blocking"),
  };
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.ruleId}|${f.location.label}|${f.excerpt ?? f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export function blockingFindings(report: ComplianceReport): Finding[] {
  return report.findings.filter((f) => f.severity === "blocking");
}

export function warningFindings(report: ComplianceReport): Finding[] {
  return report.findings.filter((f) => f.severity === "warning");
}

/**
 * The rules, rendered for a model prompt. Guidance only — every generation is
 * re-validated by evaluate() before it can reach pending_approval.
 */
export function rulesAsPromptGuidance(ruleSet: RuleSet): string {
  const line = (r: RuleDefinition, severity: string) => {
    const params = r.params ?? {};
    const detail: string[] = [];
    if (Array.isArray(params.phrases))
      detail.push(`never write: ${(params.phrases as string[]).join(", ")}`);
    if (Array.isArray(params.claim_verbs))
      detail.push(
        `never claim: ${(params.claim_verbs as string[]).join(", ")}`,
      );
    // The exempt terms matter as much as the banned words: a model told only
    // what it may not write will avoid naming a lab value it is free to name.
    if (Array.isArray(params.allow_terms))
      detail.push(
        `these terms are fine: ${(params.allow_terms as string[]).join(", ")}`,
      );
    if (Array.isArray(r.allowed_phrasing))
      detail.push(
        `prefer: ${(r.allowed_phrasing as string[]).join(", ")}`,
      );
    if (typeof params.line === "string")
      detail.push(`required line: "${params.line}"`);
    if (typeof params.max === "number")
      detail.push(`maximum: ${params.max}`);
    return `- [${severity}] ${r.id}: ${r.test ?? r.reason}${
      detail.length ? ` (${detail.join("; ")})` : ""
    }`;
  };
  return [
    `Ruleset: ${ruleSet.ruleset}`,
    "Blocking rules — output violating any of these is rejected:",
    ...(ruleSet.blocking ?? []).map((r) => line(r, "blocking")),
    "Advisory rules — avoid where the copy still works:",
    ...(ruleSet.warnings ?? []).map((r) => line(r, "warning")),
  ].join("\n");
}
