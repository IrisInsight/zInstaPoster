"use client";

import type { ComplianceReport, Finding } from "@/lib/compliance/types";

/**
 * Persistent, never a modal, never behind a tab. Compliance state has to be
 * visible without interaction — that is the whole point of the panel.
 */
export function CompliancePanel({ report }: { report: ComplianceReport | null }) {
  if (!report) {
    return (
      <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3">
        <p className="text-[12.5px] text-[var(--color-muted)]">
          Compliance has not run on this post yet.
        </p>
      </section>
    );
  }

  const blocking = report.findings.filter((f) => f.severity === "blocking");
  const warnings = report.findings.filter((f) => f.severity === "warning");

  return (
    <section
      className={`rounded-lg border ${
        blocking.length > 0
          ? "border-[#efc0b8] bg-[var(--color-danger-soft)]"
          : warnings.length > 0
            ? "border-[#e8d6a8] bg-[var(--color-warn-soft)]"
            : "border-[#bcd8c6] bg-[var(--color-ok-soft)]"
      }`}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <Dot
          tone={
            blocking.length > 0 ? "danger" : warnings.length > 0 ? "warn" : "ok"
          }
        />
        <h2 className="text-[13px] font-semibold">
          {blocking.length > 0
            ? `${blocking.length} blocking ${blocking.length === 1 ? "error" : "errors"}`
            : warnings.length > 0
              ? `${report.passed} checks passed · ${warnings.length} to look at`
              : `${report.passed} checks passed.`}
        </h2>
        <span className="ml-auto font-mono text-[10.5px] text-[var(--color-muted)]">
          {report.ruleset}
        </span>
      </header>

      {report.findings.length > 0 && (
        <ul className="border-t border-black/5">
          {[...blocking, ...warnings].map((finding, index) => (
            <FindingRow key={`${finding.ruleId}-${index}`} finding={finding} />
          ))}
        </ul>
      )}

      {blocking.length > 0 && (
        <p className="border-t border-black/5 px-3 py-2 text-[11.5px] text-[var(--color-danger)]">
          Approval is disabled until every blocking error is resolved.
        </p>
      )}
    </section>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  const blocking = finding.severity === "blocking";
  return (
    <li className="border-b border-black/5 px-3 py-2.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <Dot tone={blocking ? "danger" : "warn"} className="mt-[5px]" />
        <div className="min-w-0 flex-1">
          <p
            className={`text-[12.5px] font-medium ${
              blocking ? "text-[var(--color-danger)]" : "text-[var(--color-warn)]"
            }`}
          >
            {finding.message}
          </p>
          <p className="mt-0.5 text-[12px] leading-snug text-[var(--color-ink)]/80">
            {finding.reason}
          </p>
          {finding.fix && (
            <p className="mt-0.5 text-[12px] leading-snug text-[var(--color-ink)]/70">
              {finding.fix}
            </p>
          )}
          {finding.excerpt && (
            <p className="mt-1 rounded border border-black/10 bg-white/60 px-1.5 py-1 font-mono text-[11px] leading-snug text-[var(--color-muted)]">
              {finding.excerpt}
            </p>
          )}
          <div className="mt-1 flex items-center gap-2">
            <span className="rounded border border-black/10 bg-white/50 px-1.5 py-[1px] font-mono text-[10px] text-[var(--color-muted)]">
              {finding.ruleId}
            </span>
            <span className="text-[10.5px] uppercase tracking-wide text-[var(--color-faint)]">
              {finding.location.label}
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}

function Dot({
  tone,
  className = "",
}: {
  tone: "ok" | "warn" | "danger";
  className?: string;
}) {
  const colors = {
    ok: "bg-[var(--color-ok)]",
    warn: "bg-[var(--color-warn)]",
    danger: "bg-[var(--color-danger)]",
  };
  return <span className={`size-2 shrink-0 rounded-full ${colors[tone]} ${className}`} />;
}
