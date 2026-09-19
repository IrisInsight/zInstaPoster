"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { scheduleAction, unscheduleAction } from "@/app/actions/posts";
import type { WindowSuggestion } from "./types";

/** A small popover, not a page. Timezone is always stated. */
export function SchedulePopover({
  postId,
  timezone,
  suggestions,
  scheduledFor,
  disabled,
  onDone,
}: {
  postId: string;
  timezone: string;
  suggestions: WindowSuggestion[];
  scheduledFor: string | null;
  disabled: boolean;
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() =>
    scheduledFor
      ? toLocalInput(new Date(scheduledFor), timezone)
      : suggestions[0]
        ? toLocalInput(new Date(suggestions[0].at), timezone)
        : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const advice = value ? adviceFor(value) : null;
  const zoneLabel = zoneAbbr(timezone);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-[13px] font-medium disabled:opacity-40"
      >
        {scheduledFor ? "Reschedule" : "Schedule"}
      </button>

      {open && (
        <div className="fade-up absolute bottom-full right-0 z-40 mb-2 w-[330px] rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-3 shadow-lg">
          <div className="flex items-baseline justify-between">
            <h3 className="text-[13px] font-semibold">Schedule this post</h3>
            <span className="text-[11px] text-[var(--color-muted)]">{zoneLabel}</span>
          </div>

          {suggestions.length > 0 && (
            <div className="mt-2">
              <p className="text-[10.5px] uppercase tracking-wide text-[var(--color-faint)]">
                Next compliant windows
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.at}
                    type="button"
                    onClick={() =>
                      setValue(toLocalInput(new Date(suggestion.at), timezone))
                    }
                    className="rounded border border-[var(--color-line)] px-1.5 py-1 text-[11.5px] hover:bg-[var(--color-canvas)]"
                  >
                    {formatIn(new Date(suggestion.at), timezone)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="mt-3 block text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted)]">
            Date and time ({zoneLabel})
            <input
              type="datetime-local"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="mt-1 w-full rounded border border-[var(--color-line)] px-2 py-1.5 text-[13px] text-[var(--color-ink)]"
            />
          </label>

          {advice && (
            <p
              className={`mt-2 rounded px-2 py-1.5 text-[11.5px] ${
                advice.tone === "discouraged"
                  ? "bg-[var(--color-warn-soft)] text-[var(--color-warn)]"
                  : advice.tone === "preferred"
                    ? "bg-[var(--color-ok-soft)] text-[var(--color-ok)]"
                    : "bg-[var(--color-canvas)] text-[var(--color-muted)]"
              }`}
            >
              {advice.message}
            </p>
          )}

          {error && (
            <p className="mt-2 text-[11.5px] text-[var(--color-danger)]">{error}</p>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={!value || pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await scheduleAction({
                    postId,
                    localDateTime: value,
                  });
                  if (result.ok) {
                    setOpen(false);
                    setError(null);
                    onDone(result.message ?? "Scheduled.");
                  } else {
                    setError(result.error ?? "Could not schedule.");
                  }
                })
              }
              className="rounded-md bg-[var(--color-ink)] px-2.5 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-40"
            >
              {pending ? "Scheduling…" : "Confirm"}
            </button>
            {scheduledFor && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await unscheduleAction(postId);
                    if (result.ok) {
                      setOpen(false);
                      onDone("Schedule cleared.");
                    } else {
                      setError(result.error ?? "Could not clear the schedule.");
                    }
                  })
                }
                className="text-[12px] text-[var(--color-muted)] underline decoration-dotted underline-offset-2"
              >
                Clear schedule
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  function adviceFor(local: string) {
    const parsed = parseLocal(local, timezone);
    if (!parsed) return null;
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
    }).format(parsed);
    if (weekday === "Fri" || weekday === "Sat") {
      return {
        tone: "discouraged" as const,
        message: "Fridays and Saturdays underperform at every hour. Not blocked.",
      };
    }
    const match = suggestions.find(
      (s) => Math.abs(new Date(s.at).getTime() - parsed.getTime()) < 45 * 60 * 1000,
    );
    if (match) {
      return {
        tone: "preferred" as const,
        message: `Inside a preferred window (${match.label}).`,
      };
    }
    return {
      tone: "neutral" as const,
      message: "Outside the preferred windows, but nothing argues against it.",
    };
  }
}

function toLocalInput(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`;
}

/** Mirrors the server-side conversion so the advice matches what gets stored. */
function parseLocal(value: string, timeZone: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  const naive = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  let ts = naive;
  for (let i = 0; i < 3; i++) {
    ts = naive - offsetMs(new Date(ts), timeZone);
  }
  return new Date(ts);
}

function offsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) -
    date.getTime()
  );
}

function formatIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function zoneAbbr(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(new Date());
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}
