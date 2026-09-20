"use client";

/* eslint-disable @next/next/no-img-element */
import type { PipelineStep } from "@/lib/content/pipeline";

export interface StepState {
  id: PipelineStep;
  label: string;
  status: "waiting" | "running" | "done" | "error";
  detail?: string;
}

/**
 * Generation takes 20–60 seconds. A spinner makes that feel hung, so each step
 * completes visibly and the copy appears as it is written.
 */
export function GeneratingPanel({
  steps,
  headlines,
  slides,
  template,
  inferred,
  error,
  onCancel,
}: {
  steps: StepState[];
  headlines: string[];
  slides: (string | null)[];
  /** The template the pipeline resolved, once it has. */
  template?: string | null;
  /** True when the model picked it rather than the person. */
  inferred?: boolean;
  error: string | null;
  onCancel: () => void;
}) {
  const count = slides.length;
  return (
    <div className="fade-up">
      <h1 className="text-[17px] font-semibold tracking-tight">
        {error ? "Generation stopped" : "Generating"}
      </h1>
      <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">
        {error
          ? "Nothing was published. Fix the problem and run it again."
          : `${count === 1 ? "One slide" : `${count} slides`}, written, photographed, rendered and checked.`}
      </p>
      {!error && template && (
        <p className="mt-1 text-[11.5px] text-[var(--color-faint)]">
          Template: {template.replace(/_/g, " ")}
          {inferred ? " — inferred from the prompt" : ""}
        </p>
      )}

      <ol className="mt-5 space-y-px overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
        {steps.map((step) => (
          <li
            key={step.id}
            className="relative flex items-center gap-3 overflow-hidden border-b border-[var(--color-line)] px-3.5 py-3 last:border-b-0"
          >
            <StepIcon status={step.status} />
            <span
              className={`text-[13.5px] ${
                step.status === "waiting"
                  ? "text-[var(--color-faint)]"
                  : step.status === "error"
                    ? "text-[var(--color-danger)]"
                    : "text-[var(--color-ink)]"
              }`}
            >
              {step.label}
            </span>
            {step.detail && (
              <span className="ml-auto text-[11.5px] text-[var(--color-muted)]">
                {step.detail}
              </span>
            )}
            {step.status === "running" && (
              <span className="sweep pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-[var(--color-line)]" />
            )}
          </li>
        ))}
      </ol>

      {headlines.filter(Boolean).length > 0 && (
        <div className="mt-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-faint)]">
            Copy coming in
          </p>
          <ul className="mt-2 space-y-1.5">
            {headlines.map((headline, index) =>
              headline ? (
                <li key={index} className="fade-up flex gap-2 text-[13.5px]">
                  <span className="tabular w-4 shrink-0 text-[var(--color-faint)]">
                    {index + 1}
                  </span>
                  <span>{headline}</span>
                </li>
              ) : null,
            )}
          </ul>
        </div>
      )}

      {slides.some(Boolean) && (
        <div className="mt-4 flex gap-2">
          {slides.map((url, index) => (
            <div
              key={index}
              // A single card is one thumbnail, not one stretched across the
              // panel, so the slot keeps a carousel slide's width.
              className="relative w-1/4 shrink-0 overflow-hidden rounded-[3px] border border-[var(--color-line)] bg-[var(--color-canvas)]"
              style={{ aspectRatio: "4 / 5" }}
            >
              {url ? (
                <img src={url} alt="" className="fade-up size-full object-cover" />
              ) : (
                <div className="pulse size-full" />
              )}
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-md border border-[#efc0b8] bg-[var(--color-danger-soft)] px-3 py-2 font-mono text-[12px] leading-snug text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={onCancel}
        className="mt-4 rounded-md border border-[var(--color-line)] px-3 py-1.5 text-[13px] text-[var(--color-muted)] hover:bg-[var(--color-canvas)]"
      >
        {error ? "Start over" : "Cancel"}
      </button>
    </div>
  );
}

function StepIcon({ status }: { status: StepState["status"] }) {
  if (status === "done") {
    return (
      <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-[var(--color-ok)]">
        <path
          d="M3 8.5l3.2 3.2L13 5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "error") {
    return (
      <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-[var(--color-danger)]">
        <path
          d="M4 4l8 8M12 4l-8 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (status === "running") {
    return (
      <span className="size-4 shrink-0 rounded-full border-2 border-[var(--color-flame)] border-t-transparent motion-safe:animate-spin" />
    );
  }
  return (
    <span className="size-4 shrink-0 rounded-full border border-dashed border-[var(--color-line-strong)]" />
  );
}
