"use client";

/* eslint-disable @next/next/no-img-element */
import { useState, useTransition } from "react";
import {
  deleteSlideAction,
  regeneratePhotoAction,
  reorderSlidesAction,
  saveSlideAction,
  selectPhotoAction,
} from "@/app/actions/posts";
import type { PhotoOption, ReviewSlide } from "./types";

const MAX_ALT = 1000;

export function SlideEditor({
  postId,
  slides,
  slide,
  photoOptions,
  photoAvailable,
  editable,
  onSelect,
  onChanged,
}: {
  postId: string;
  slides: ReviewSlide[];
  slide: ReviewSlide;
  photoOptions: PhotoOption[];
  photoAvailable: boolean;
  editable: boolean;
  onSelect: (id: string) => void;
  onChanged: (message: string) => void;
}) {
  const [copy, setCopy] = useState<Record<string, unknown>>(slide.copy);
  const [altText, setAltText] = useState(slide.altText);
  const [photoPrompt, setPhotoPrompt] = useState(slide.photoPrompt ?? "");
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    JSON.stringify(copy) !== JSON.stringify(slide.copy) || altText !== slide.altText;

  function field(key: string, value: unknown) {
    setCopy((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <section className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-line)] px-3 py-2">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--color-muted)]">
          Slides
        </h2>
        <div className="ml-auto flex items-center gap-1">
          {slides.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect(s.id)}
              className={`rounded px-2 py-[3px] text-[11.5px] ${
                s.id === slide.id
                  ? "bg-[var(--color-ink)] text-white"
                  : "border border-[var(--color-line)] text-[var(--color-muted)] hover:bg-[var(--color-canvas)]"
              }`}
            >
              {s.position}
            </button>
          ))}
        </div>
      </header>

      <div className="space-y-3 px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="rounded border border-[var(--color-line)] px-1.5 py-[1px] text-[10.5px] uppercase tracking-wide text-[var(--color-muted)]">
            {slide.type}
          </span>
          {editable && (
            <div className="ml-auto flex items-center gap-1">
              <MoveButton
                label="Move earlier"
                disabled={slide.position === 1 || pending}
                onClick={() => move(-1)}
              >
                ↑
              </MoveButton>
              <MoveButton
                label="Move later"
                disabled={slide.position === slides.length || pending}
                onClick={() => move(1)}
              >
                ↓
              </MoveButton>
              <button
                type="button"
                disabled={slides.length <= 2 || pending}
                title={
                  slides.length <= 2
                    ? "A carousel needs at least 2 slides"
                    : "Delete this slide"
                }
                onClick={() =>
                  startTransition(async () => {
                    const result = await deleteSlideAction(postId, slide.id);
                    handle(result, "Slide deleted.");
                  })
                }
                className="rounded border border-[var(--color-line)] px-1.5 py-[2px] text-[11px] text-[var(--color-danger)] disabled:opacity-30"
              >
                Delete
              </button>
            </div>
          )}
        </div>

        {slide.photoPrompt !== null && (
          <div className="rounded-md border border-[var(--color-line)] p-2.5">
            <div className="flex gap-2.5">
              <div
                className="w-32 shrink-0 overflow-hidden rounded border border-[var(--color-line)] bg-[var(--color-canvas)]"
                style={{ aspectRatio: "16 / 9" }}
              >
                {slide.photoUrl ? (
                  <img src={slide.photoUrl} alt="" className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center text-[10px] text-[var(--color-faint)]">
                    no photo
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
                  Photo prompt
                </label>
                <textarea
                  value={photoPrompt}
                  onChange={(event) => setPhotoPrompt(event.target.value)}
                  rows={3}
                  disabled={!editable}
                  className="mt-1 w-full resize-y rounded border border-[var(--color-line)] px-2 py-1.5 text-[12.5px] leading-snug disabled:bg-[var(--color-canvas)]"
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!editable || !photoPrompt.trim() || busy === "photo"}
                    onClick={() => {
                      setBusy("photo");
                      startTransition(async () => {
                        const result = await regeneratePhotoAction({
                          postId,
                          slideId: slide.id,
                          prompt: photoPrompt,
                        });
                        setBusy(null);
                        handle(result, "New photo generated.");
                      });
                    }}
                    className="rounded-md border border-[var(--color-line-strong)] px-2 py-1 text-[12px] font-medium disabled:opacity-40"
                  >
                    {busy === "photo" ? "Generating…" : "Regenerate"}
                  </button>
                  {!photoAvailable && (
                    <span className="text-[11px] text-[var(--color-warn)]">
                      No image model configured — placeholder only.
                    </span>
                  )}
                </div>
              </div>
            </div>

            {photoOptions.length > 1 && (
              <div className="mt-2.5">
                <p className="text-[10.5px] uppercase tracking-wide text-[var(--color-faint)]">
                  Recent generations
                </p>
                <div className="mt-1 flex gap-1.5">
                  {photoOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      title={option.prompt}
                      disabled={!editable || pending || option.selected}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await selectPhotoAction({
                            postId,
                            slideId: slide.id,
                            generationId: option.id,
                          });
                          handle(result, "Photo selected.");
                        })
                      }
                      className={`h-12 w-20 shrink-0 overflow-hidden rounded border ${
                        option.selected
                          ? "border-[var(--color-flame)] ring-1 ring-[var(--color-flame)]"
                          : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]"
                      }`}
                    >
                      <img src={option.url} alt="" className="size-full object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <CopyFields copy={copy} onChange={field} disabled={!editable} />

        <div>
          <div className="flex items-center gap-2">
            <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
              Alt text
            </label>
            <span
              className={`tabular ml-auto text-[11px] ${
                altText.length > MAX_ALT
                  ? "font-semibold text-[var(--color-danger)]"
                  : "text-[var(--color-faint)]"
              }`}
            >
              {altText.length} / {MAX_ALT}
            </span>
          </div>
          <textarea
            value={altText}
            onChange={(event) => setAltText(event.target.value)}
            rows={2}
            disabled={!editable}
            className="mt-1 w-full resize-y rounded border border-[var(--color-line)] px-2 py-1.5 text-[12.5px] leading-snug disabled:bg-[var(--color-canvas)]"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!editable || !dirty || pending}
            onClick={() =>
              startTransition(async () => {
                const result = await saveSlideAction({
                  postId,
                  slideId: slide.id,
                  copy,
                  altText,
                });
                handle(result, `Slide ${slide.position} re-rendered.`);
              })
            }
            className="rounded-md border border-[var(--color-line-strong)] px-2.5 py-1 text-[12.5px] font-medium disabled:opacity-40"
          >
            {pending ? "Re-rendering…" : dirty ? "Save and re-render slide" : "Saved"}
          </button>
          {error && (
            <span className="text-[11.5px] text-[var(--color-danger)]">{error}</span>
          )}
        </div>
      </div>
    </section>
  );

  function move(direction: 1 | -1) {
    const order = [...slides].sort((a, b) => a.position - b.position).map((s) => s.id);
    const index = order.indexOf(slide.id);
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    startTransition(async () => {
      const result = await reorderSlidesAction(postId, order);
      handle(result, "Slides reordered.");
    });
  }

  function handle(result: { ok: boolean; error?: string; message?: string }, fallback: string) {
    if (result.ok) {
      setError(null);
      onChanged(result.message ?? fallback);
    } else {
      setError(result.error ?? "Something went wrong.");
    }
  }
}

function MoveButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-[var(--color-line)] px-1.5 py-[2px] text-[11px] text-[var(--color-muted)] disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/** Renders whatever copy fields the slide type actually has. */
function CopyFields({
  copy,
  onChange,
  disabled,
}: {
  copy: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled: boolean;
}) {
  const scalarKeys = ["kicker", "headline", "script_line", "sub", "body", "disclaimer"];
  return (
    <div className="space-y-2.5">
      {scalarKeys
        .filter((key) => typeof copy[key] === "string")
        .map((key) => (
          <Field
            key={key}
            label={key.replace(/_/g, " ")}
            value={copy[key] as string}
            rows={key === "disclaimer" || key === "sub" || key === "body" ? 3 : 2}
            disabled={disabled}
            onChange={(value) => onChange(key, value)}
          />
        ))}

      {Array.isArray(copy.items) && (
        <ListFields
          label="Items"
          entries={copy.items as { label: string; text: string }[]}
          keys={["label", "text"]}
          disabled={disabled}
          onChange={(next) => onChange("items", next)}
        />
      )}
      {Array.isArray(copy.cards) && (
        <ListFields
          label="Cards"
          entries={copy.cards as { title: string; text: string }[]}
          keys={["title", "text"]}
          disabled={disabled}
          onChange={(next) => onChange("cards", next)}
        />
      )}
      {Array.isArray(copy.trust_points) && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
            Trust points
          </p>
          <div className="mt-1 space-y-1">
            {(copy.trust_points as string[]).map((point, index) => (
              <input
                key={index}
                value={point}
                disabled={disabled}
                onChange={(event) => {
                  const next = [...(copy.trust_points as string[])];
                  next[index] = event.target.value;
                  onChange("trust_points", next);
                }}
                className="w-full rounded border border-[var(--color-line)] px-2 py-1 text-[12.5px] disabled:bg-[var(--color-canvas)]"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  rows,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  rows: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
        {label}
      </span>
      <textarea
        value={value}
        rows={rows}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full resize-y rounded border border-[var(--color-line)] px-2 py-1.5 text-[12.5px] leading-snug disabled:bg-[var(--color-canvas)]"
      />
    </label>
  );
}

function ListFields({
  label,
  entries,
  keys,
  disabled,
  onChange,
}: {
  label: string;
  entries: Record<string, string>[];
  keys: string[];
  disabled: boolean;
  onChange: (next: Record<string, string>[]) => void;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
        {label}
      </p>
      <div className="mt-1 space-y-1.5">
        {entries.map((entry, index) => (
          <div
            key={index}
            className="rounded border border-[var(--color-line)] p-1.5"
          >
            {keys.map((key) => (
              <input
                key={key}
                value={entry[key] ?? ""}
                disabled={disabled}
                placeholder={key}
                onChange={(event) => {
                  const next = entries.map((e, i) =>
                    i === index ? { ...e, [key]: event.target.value } : e,
                  );
                  onChange(next);
                }}
                className={`w-full rounded px-1.5 py-1 text-[12.5px] ${
                  key === keys[0] ? "font-medium" : "text-[var(--color-muted)]"
                } disabled:bg-[var(--color-canvas)]`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
