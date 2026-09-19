import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { nextWindows, parseWindows, windowAdvice } from "@/lib/posting-windows";
import {
  formatInZone,
  fromLocalInputValue,
  toLocalInputValue,
  zonedParts,
  zonedTimeToUtc,
} from "@/lib/time";

const tenantConfig = JSON.parse(
  await readFile("tenants/precision-vitality.json", "utf8"),
);
const windows = tenantConfig.compliance_rules.posting_windows;
const TZ = tenantConfig.timezone as string; // America/Los_Angeles

test("wall-clock time in the tenant zone round-trips through UTC", () => {
  // 7pm on a summer date in Los Angeles is 02:00 UTC the next day.
  const summer = zonedTimeToUtc(
    { year: 2026, month: 7, day: 15, hour: 19, minute: 0 },
    TZ,
  );
  assert.equal(summer.toISOString(), "2026-07-16T02:00:00.000Z");

  // 7pm in January is 03:00 UTC — the offset changes, the input does not.
  const winter = zonedTimeToUtc(
    { year: 2026, month: 1, day: 15, hour: 19, minute: 0 },
    TZ,
  );
  assert.equal(winter.toISOString(), "2026-01-16T03:00:00.000Z");

  const parts = zonedParts(summer, TZ);
  assert.equal(parts.hour, 19);
  assert.equal(parts.day, 15);
});

test("the schedule input value survives a round trip", () => {
  const instant = new Date("2026-11-04T02:30:00.000Z"); // 18:30 PST
  const local = toLocalInputValue(instant, TZ);
  assert.equal(local, "2026-11-03T18:30");
  assert.equal(fromLocalInputValue(local, TZ).toISOString(), instant.toISOString());
});

test("the tenant's own window strings parse", () => {
  const parsed = parseWindows(windows.preferred);
  assert.deepEqual(
    parsed.map((w) => `${w.days.join("/")} ${w.hour}:${String(w.minute).padStart(2, "0")}`),
    [
      "Wed 12:00",
      "Wed 18:00",
      "Thu 9:00",
      "Mon/Tue/Wed/Thu/Fri 19:00",
    ],
  );
});

test("suggested slots are in the future, in order, and never on an avoided day", () => {
  const from = new Date("2026-09-14T17:00:00.000Z"); // Monday 10:00 PDT
  const suggestions = nextWindows({ windows, timeZone: TZ, from, count: 5 });

  assert.ok(suggestions.length > 0);
  for (const [index, suggestion] of suggestions.entries()) {
    assert.ok(suggestion.at.getTime() > from.getTime(), "future only");
    if (index > 0) {
      assert.ok(
        suggestion.at.getTime() >= suggestions[index - 1].at.getTime(),
        "soonest first",
      );
    }
    const weekday = zonedParts(suggestion.at, TZ).weekday;
    assert.ok(
      !["Fri", "Sat"].includes(weekday),
      `${formatInZone(suggestion.at, TZ)} falls on ${weekday}, which this tenant avoids`,
    );
  }

  // The first offer on a Monday morning is that evening's weekday window.
  const first = zonedParts(suggestions[0].at, TZ);
  assert.equal(first.weekday, "Mon");
  assert.equal(first.hour, 19);
});

test("advice guides without blocking", () => {
  const friday = zonedTimeToUtc(
    { year: 2026, month: 9, day: 18, hour: 19, minute: 0 },
    TZ,
  );
  const discouraged = windowAdvice({ at: friday, windows, timeZone: TZ });
  assert.equal(discouraged?.tone, "discouraged");
  assert.match(discouraged?.message ?? "", /underperform/);

  const wednesday = zonedTimeToUtc(
    { year: 2026, month: 9, day: 16, hour: 12, minute: 0 },
    TZ,
  );
  assert.equal(windowAdvice({ at: wednesday, windows, timeZone: TZ })?.tone, "preferred");

  const tuesdayMorning = zonedTimeToUtc(
    { year: 2026, month: 9, day: 15, hour: 8, minute: 0 },
    TZ,
  );
  assert.equal(
    windowAdvice({ at: tuesdayMorning, windows, timeZone: TZ })?.tone,
    "neutral",
  );
});

test("a tenant with different windows gets different suggestions, from config alone", () => {
  const seniorLiving = {
    preferred: ["Tue 10:00", "any weekend 14:00"],
    avoid: ["Monday"],
  };
  const from = new Date("2026-09-14T17:00:00.000Z"); // Monday
  const suggestions = nextWindows({
    windows: seniorLiving,
    timeZone: "America/Chicago",
    from,
    count: 3,
  });
  const days = suggestions.map((s) => zonedParts(s.at, "America/Chicago").weekday);
  assert.ok(!days.includes("Mon"));
  assert.ok(days.includes("Tue") || days.includes("Sat") || days.includes("Sun"));
});
