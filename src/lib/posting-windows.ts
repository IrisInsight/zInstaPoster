import { zonedParts, zonedTimeToUtc } from "@/lib/time";

/**
 * Posting windows come from tenant config, in the shape the practice
 * described them: "Wed 12:00", "Thu 09:00", "any weekday 19:00-21:00".
 * They are guidance, never a gate — picking a discouraged slot is allowed.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
type Day = (typeof DAYS)[number];

export interface PostingWindows {
  preferred?: string[];
  avoid?: string[];
}

interface ParsedWindow {
  days: Day[];
  hour: number;
  minute: number;
  label: string;
}

function dayFrom(token: string): Day | undefined {
  const needle = token.slice(0, 3).toLowerCase();
  return DAYS.find((d) => d.toLowerCase() === needle);
}

const WEEKDAYS: Day[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];

export function parseWindows(windows: string[] = []): ParsedWindow[] {
  const parsed: ParsedWindow[] = [];
  for (const raw of windows) {
    const label = raw;
    const text = raw.trim();
    const range = text.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
    const single = text.match(/(\d{1,2}):(\d{2})/);

    let days: Day[] = [];
    if (/weekday/i.test(text)) days = [...WEEKDAYS];
    else if (/weekend/i.test(text)) days = ["Sat", "Sun"];
    else {
      for (const token of text.split(/[\s,]+/)) {
        const day = dayFrom(token);
        if (day) days.push(day);
      }
    }
    if (days.length === 0) days = [...WEEKDAYS];

    if (range) {
      // Offer the start of the range; the whole range is still selectable.
      parsed.push({
        days,
        hour: Number(range[1]),
        minute: Number(range[2]),
        label,
      });
    } else if (single) {
      parsed.push({
        days,
        hour: Number(single[1]),
        minute: Number(single[2]),
        label,
      });
    }
  }
  return parsed;
}

export interface WindowSuggestion {
  at: Date;
  label: string;
}

/** The next few compliant posting slots, soonest first. */
export function nextWindows(input: {
  windows: PostingWindows;
  timeZone: string;
  from?: Date;
  count?: number;
}): WindowSuggestion[] {
  const from = input.from ?? new Date();
  const count = input.count ?? 4;
  const parsed = parseWindows(input.windows.preferred);
  if (parsed.length === 0) return [];

  const avoid = new Set(
    (input.windows.avoid ?? [])
      .map((d) => dayFrom(d))
      .filter((d): d is Day => Boolean(d)),
  );

  const suggestions: WindowSuggestion[] = [];
  for (let offset = 0; offset < 21 && suggestions.length < count; offset++) {
    const dayStart = new Date(from.getTime() + offset * 86_400_000);
    const parts = zonedParts(dayStart, input.timeZone);
    const weekday = parts.weekday as Day;
    if (avoid.has(weekday)) continue;

    for (const window of parsed) {
      if (!window.days.includes(weekday)) continue;
      const at = zonedTimeToUtc(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: window.hour,
          minute: window.minute,
        },
        input.timeZone,
      );
      // Only future slots, with a couple of minutes of headroom.
      if (at.getTime() <= from.getTime() + 120_000) continue;
      suggestions.push({ at, label: window.label });
    }
  }

  return suggestions
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, count);
}

/** Non-blocking guidance for a slot the human picked themselves. */
export function windowAdvice(input: {
  at: Date;
  windows: PostingWindows;
  timeZone: string;
}): { tone: "preferred" | "neutral" | "discouraged"; message: string } | null {
  const parts = zonedParts(input.at, input.timeZone);
  const weekday = parts.weekday as Day;

  const avoid = (input.windows.avoid ?? [])
    .map((d) => dayFrom(d))
    .filter((d): d is Day => Boolean(d));
  if (avoid.includes(weekday)) {
    const names = avoid.map((d) => `${d}${d.endsWith("s") ? "" : "s"}`);
    return {
      tone: "discouraged",
      message: `${names.join(" and ")} underperform at every hour for this account.`,
    };
  }

  for (const window of parseWindows(input.windows.preferred)) {
    if (!window.days.includes(weekday)) continue;
    if (Math.abs(parts.hour * 60 + parts.minute - (window.hour * 60 + window.minute)) <= 120) {
      return {
        tone: "preferred",
        message: `Inside this account's preferred window (${window.label}).`,
      };
    }
  }
  return {
    tone: "neutral",
    message: "Outside the preferred windows, but nothing argues against it.",
  };
}
