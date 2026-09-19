"use client";

import { useMemo, useState, useTransition } from "react";
import { saveCaptionAction } from "@/app/actions/posts";

const MAX_CHARS = 2200;
const MAX_HASHTAGS = 5;

export function CaptionEditor({
  postId,
  initial,
  onSaved,
}: {
  postId: string;
  initial: string;
  onSaved: (message: string) => void;
}) {
  const [caption, setCaption] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const dirty = caption !== initial;

  const hashtags = useMemo(
    () => caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0,
    [caption],
  );
  const overLength = caption.length > MAX_CHARS;
  const overTags = hashtags > MAX_HASHTAGS;

  return (
    <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
      <header className="flex items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
          Caption
        </h2>
        <span
          className={`tabular ml-auto text-[11.5px] ${
            overLength ? "font-semibold text-[var(--color-danger)]" : "text-[var(--color-faint)]"
          }`}
        >
          {caption.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
        </span>
        <span
          className={`tabular rounded px-1.5 py-[1px] text-[11.5px] ${
            overTags
              ? "bg-[var(--color-danger-soft)] font-semibold text-[var(--color-danger)]"
              : "text-[var(--color-faint)]"
          }`}
        >
          {hashtags} / {MAX_HASHTAGS} hashtags
        </span>
      </header>

      <textarea
        value={caption}
        onChange={(event) => setCaption(event.target.value)}
        rows={12}
        spellCheck
        className="w-full resize-y px-3 py-2.5 text-[13.5px] leading-relaxed outline-none"
      />

      <footer className="flex items-center gap-2 border-t border-[var(--color-line)] px-3 py-2">
        <button
          type="button"
          disabled={!dirty || pending}
          onClick={() =>
            startTransition(async () => {
              const result = await saveCaptionAction(postId, caption);
              if (result.ok) {
                setError(null);
                onSaved(result.message ?? "Caption saved.");
              } else {
                setError(result.error ?? "Could not save the caption.");
              }
            })
          }
          className="rounded-md border border-[var(--color-line-strong)] px-2.5 py-1 text-[12.5px] font-medium disabled:opacity-40"
        >
          {pending ? "Saving…" : dirty ? "Save caption" : "Saved"}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => setCaption(initial)}
            className="text-[12px] text-[var(--color-muted)] underline decoration-dotted underline-offset-2"
          >
            Revert
          </button>
        )}
        {error && (
          <span className="text-[11.5px] text-[var(--color-danger)]">{error}</span>
        )}
      </footer>
    </section>
  );
}
