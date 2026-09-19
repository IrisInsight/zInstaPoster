"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import type { ReviewSlide } from "./types";

/**
 * The fidelity check: these are the rendered JPEGs that will be published, not
 * a CSS approximation of them. The lightbox swipes the way Instagram does.
 */
export function CarouselPane({
  slides,
  selectedId,
  onSelect,
}: {
  slides: ReviewSlide[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [lightbox, setLightbox] = useState<number | null>(null);

  useEffect(() => {
    if (lightbox === null) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightbox(null);
      if (event.key === "ArrowRight")
        setLightbox((i) => Math.min((i ?? 0) + 1, slides.length - 1));
      if (event.key === "ArrowLeft") setLightbox((i) => Math.max((i ?? 0) - 1, 0));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightbox, slides.length]);

  return (
    <div>
      <div className="grid grid-cols-2 gap-2.5 2xl:grid-cols-4">
        {slides.map((slide, index) => (
          <figure key={slide.id} className="min-w-0">
            <button
              type="button"
              onClick={() => setLightbox(index)}
              onFocus={() => onSelect(slide.id)}
              className={`relative block w-full overflow-hidden rounded-md border bg-[var(--color-canvas)] transition ${
                selectedId === slide.id
                  ? "border-[var(--color-flame)] ring-1 ring-[var(--color-flame)]"
                  : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]"
              }`}
              style={{ aspectRatio: "4 / 5" }}
            >
              {slide.renderedUrl ? (
                <img
                  src={slide.renderedUrl}
                  alt={slide.altText || `Slide ${slide.position}`}
                  className="size-full object-cover"
                />
              ) : (
                <span className="pulse flex size-full items-center justify-center text-[11px] text-[var(--color-faint)]">
                  rendering…
                </span>
              )}
              <span className="absolute left-1.5 top-1.5 rounded bg-black/65 px-1.5 py-[1px] text-[10px] font-medium text-white tabular">
                {slide.position}
              </span>
            </button>
            <figcaption className="mt-1 flex items-center justify-between gap-1 text-[10.5px] text-[var(--color-faint)]">
              <button
                type="button"
                onClick={() => onSelect(slide.id)}
                className="truncate uppercase tracking-wide hover:text-[var(--color-ink)]"
              >
                {slide.type}
              </button>
              <span className="tabular shrink-0">
                {slide.width}×{slide.height}
                {slide.bytes ? ` · ${Math.round(slide.bytes / 1024)}KB` : ""}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>

      {lightbox !== null && slides[lightbox] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightbox(null)}
        >
          <div
            className="relative flex max-h-full flex-col items-center"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={slides[lightbox].renderedUrl ?? ""}
              alt={slides[lightbox].altText}
              className="max-h-[82vh] rounded-sm object-contain shadow-2xl"
            />
            <div className="mt-3 flex items-center gap-3">
              <NavButton
                label="Previous"
                disabled={lightbox === 0}
                onClick={() => setLightbox(Math.max(0, lightbox - 1))}
              >
                ←
              </NavButton>
              <div className="flex items-center gap-1.5">
                {slides.map((slide, index) => (
                  <span
                    key={slide.id}
                    className={`size-1.5 rounded-full ${
                      index === lightbox ? "bg-white" : "bg-white/35"
                    }`}
                  />
                ))}
              </div>
              <NavButton
                label="Next"
                disabled={lightbox === slides.length - 1}
                onClick={() =>
                  setLightbox(Math.min(slides.length - 1, lightbox + 1))
                }
              >
                →
              </NavButton>
            </div>
            <p className="mt-2 max-w-[520px] text-center text-[11.5px] text-white/70">
              {slides[lightbox].altText}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function NavButton({
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
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-white/25 px-2.5 py-1 text-[14px] text-white disabled:opacity-30"
    >
      {children}
    </button>
  );
}
