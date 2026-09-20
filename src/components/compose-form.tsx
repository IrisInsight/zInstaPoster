"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { GeneratingPanel, type StepState } from "./generating-panel";
import type { PipelineEvent, PipelineStep } from "@/lib/content/pipeline";

const PLACEHOLDER =
  "Make a post about why a normal TSH doesn't mean a normal thyroid.";

const STEPS: { id: PipelineStep; label: string }[] = [
  { id: "writing_copy", label: "Writing copy" },
  { id: "generating_photo", label: "Generating photo" },
  { id: "rendering_slides", label: "Rendering slides" },
  { id: "running_compliance", label: "Running compliance checks" },
];

export interface TemplateOption {
  name: string;
  slides: number;
  /** Fewer than `slides` when the template's last slides are optional. */
  minSlides: number;
  useWhen: string;
}

function slideCount({ minSlides, slides }: TemplateOption): string {
  if (slides === 1) return "1 slide";
  return minSlides === slides
    ? `${slides} slides`
    : `${minSlides}–${slides} slides`;
}

export function ComposeForm({
  tenantName,
  templates,
  accounts,
  copyAvailable,
  photoAvailable,
}: {
  tenantName: string;
  templates: TemplateOption[];
  accounts: { id: string; username: string; status: string }[];
  copyAvailable: boolean;
  photoAvailable: boolean;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  // Empty means "let the model infer it". With one template there is
  // nothing to infer, so it is preselected.
  const [template, setTemplate] = useState(
    templates.length === 1 ? templates[0].name : "",
  );
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepState[]>(
    STEPS.map((s) => ({ ...s, status: "waiting" })),
  );
  const [headlines, setHeadlines] = useState<string[]>([]);
  const [resolved, setResolved] = useState<TemplateOption | null>(null);
  const [slides, setSlides] = useState<(string | null)[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const picked = templates.find((t) => t.name === template) ?? null;
  // Until the pipeline says which template it resolved, lay out slots for the
  // one that was picked; with nothing picked, the longest template it could be.
  const expectedSlides =
    resolved?.slides ??
    picked?.slides ??
    Math.max(...templates.map((t) => t.slides), 1);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || running) return;

    setRunning(true);
    setError(null);
    setHeadlines([]);
    setResolved(picked);
    setSlides(Array.from({ length: expectedSlides }, () => null));
    setSteps(STEPS.map((s) => ({ ...s, status: "waiting" })));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          template: template || null,
          igAccountId: accountId || null,
          reference: reference || null,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(await response.text());
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as PipelineEvent;
          handle(event);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message);
        setSteps((prev) =>
          prev.map((s) => (s.status === "running" ? { ...s, status: "error" } : s)),
        );
      }
      setRunning(false);
    }
  }

  function handle(event: PipelineEvent) {
    switch (event.type) {
      case "template": {
        const match = templates.find((t) => t.name === event.name);
        setResolved(
          match ?? {
            name: event.name,
            slides: event.slides,
            minSlides: event.slides,
            useWhen: "",
          },
        );
        setSlides((prev) => {
          const next = Array.from({ length: event.slides }, () => null as string | null);
          prev.forEach((url, index) => {
            if (index < next.length) next[index] = url;
          });
          return next;
        });
        break;
      }
      case "step":
        setSteps((prev) =>
          prev.map((s) =>
            s.id === event.step
              ? {
                  ...s,
                  status: event.status === "start" ? "running" : "done",
                  detail: event.detail ?? s.detail,
                }
              : s,
          ),
        );
        break;
      case "copy":
        setHeadlines((prev) => {
          const next = [...prev];
          next[event.position - 1] = event.headline;
          return next;
        });
        break;
      case "slide":
        setSlides((prev) => {
          const next = [...prev];
          // The writer can return fewer slides than the template's maximum,
          // and a picked template can be overridden — grow to fit either way.
          while (next.length < event.position) next.push(null);
          next[event.position - 1] = event.url;
          return next;
        });
        break;
      case "done":
        router.push(`/posts/${event.postId}/review`);
        break;
      case "error":
        setError(event.message);
        setSteps((prev) =>
          prev.map((s) => (s.status === "running" ? { ...s, status: "error" } : s)),
        );
        setRunning(false);
        break;
    }
  }

  if (running || steps.some((s) => s.status !== "waiting")) {
    return (
      <GeneratingPanel
        steps={steps}
        headlines={headlines}
        slides={slides}
        template={resolved?.name ?? null}
        inferred={resolved !== null && resolved.name !== template}
        error={error}
        onCancel={() => {
          abortRef.current?.abort();
          setRunning(false);
          setResolved(null);
          setSlides([]);
          setSteps(STEPS.map((s) => ({ ...s, status: "waiting" })));
        }}
      />
    );
  }

  return (
    <form onSubmit={submit}>
      <h1 className="text-[17px] font-semibold tracking-tight">New post</h1>
      <p className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">
        {tenantName} · one prompt, a whole post, reviewed before anything
        publishes.
      </p>

      {!copyAvailable && (
        <p className="mt-3 rounded-md border border-[#e8d6a8] bg-[var(--color-warn-soft)] px-3 py-2 text-[12.5px] text-[var(--color-warn)]">
          ANTHROPIC_API_KEY is not set, so copy cannot be generated. Set it in the
          environment and restart.
        </p>
      )}
      {copyAvailable && !photoAvailable && (
        <p className="mt-3 rounded-md border border-[#e8d6a8] bg-[var(--color-warn-soft)] px-3 py-2 text-[12.5px] text-[var(--color-warn)]">
          GEMINI_API_KEY is not set. Slides that carry a photo will render with a
          placeholder instead.
        </p>
      )}

      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder={PLACEHOLDER}
        rows={6}
        autoFocus
        className="mt-4 w-full resize-y rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-3 text-[15px] leading-relaxed placeholder:text-[var(--color-faint)]"
      />

      <button
        type="button"
        onClick={() => setShowOptions((v) => !v)}
        className="mt-2 text-[12.5px] text-[var(--color-muted)] underline decoration-dotted underline-offset-2"
      >
        {showOptions ? "Hide options" : "Template, account, reference"}
      </button>

      {showOptions && (
        <div className="fade-up mt-2 grid gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 sm:grid-cols-2">
          <label className="text-[12px] font-medium text-[var(--color-muted)]">
            Template
            <select
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--color-line)] px-2 py-1.5 text-[13.5px] text-[var(--color-ink)]"
            >
              {templates.length > 1 && (
                <option value="">Infer from the prompt</option>
              )}
              {templates.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name.replace(/_/g, " ")} · {slideCount(t)}
                </option>
              ))}
            </select>
            <span className="mt-1 block font-normal text-[11px] text-[var(--color-faint)]">
              {picked?.useWhen ||
                "Inferred from the prompt when it can be. This is an override."}
            </span>
          </label>

          <label className="text-[12px] font-medium text-[var(--color-muted)]">
            Target account
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--color-line)] px-2 py-1.5 text-[13.5px] text-[var(--color-ink)]"
            >
              <option value="">Decide later</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                  {a.status === "connected" ? "" : ` (${a.status})`}
                </option>
              ))}
            </select>
          </label>

          <label className="text-[12px] font-medium text-[var(--color-muted)] sm:col-span-2">
            Reference this
            <textarea
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              rows={3}
              placeholder="Paste source material — a study abstract, a page from the site, a transcript."
              className="mt-1 w-full resize-y rounded-md border border-[var(--color-line)] px-2 py-1.5 text-[13px] font-normal text-[var(--color-ink)] placeholder:text-[var(--color-faint)]"
            />
          </label>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-md border border-[#efc0b8] bg-[var(--color-danger-soft)] px-3 py-2 text-[12.5px] text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={!prompt.trim() || !copyAvailable}
          className="rounded-md bg-[var(--color-ink)] px-4 py-2 text-[13.5px] font-medium text-white disabled:opacity-40"
        >
          Generate
        </button>
        <span className="text-[12px] text-[var(--color-faint)]">
          20–60 seconds. Nothing publishes without a human approving it.
        </span>
      </div>
    </form>
  );
}
