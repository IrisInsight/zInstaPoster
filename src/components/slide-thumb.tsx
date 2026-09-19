/* eslint-disable @next/next/no-img-element */

export function SlideThumb({
  url,
  position,
  className = "",
  pending,
}: {
  url: string | null;
  position: number;
  className?: string;
  pending?: boolean;
}) {
  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-[3px] border border-[var(--color-line)] bg-[var(--color-canvas)] ${className}`}
      style={{ aspectRatio: "4 / 5" }}
    >
      {url ? (
        <img
          src={url}
          alt={`Slide ${position}`}
          loading="lazy"
          className="size-full object-cover"
        />
      ) : (
        <div
          className={`flex size-full items-center justify-center text-[10px] uppercase tracking-wide text-[var(--color-faint)] ${
            pending ? "pulse" : ""
          }`}
        >
          {pending ? "" : position}
        </div>
      )}
    </div>
  );
}
