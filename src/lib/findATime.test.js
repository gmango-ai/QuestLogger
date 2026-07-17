import { describe, it, expect } from "vitest";
import {
  zonedWindowToAbsolute, weekdayOf, addDays,
  mergeIntervals, subtractIntervals, intersectAll,
  scheduleForDate, workWindowForDate, isOutOfOfficeOn, inAppBusyForPerson,
  computeAvailability, firstDayWithSlot,
} from "./findATime";

const iso = (...utcArgs) => new Date(Date.UTC(...utcArgs)).toISOString();
const allDays = (start, end) =>
  Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { start, end, loc: null }]));

describe("zonedWindowToAbsolute", () => {
  it("treats UTC literally", () => {
    expect(zonedWindowToAbsolute("2026-07-20", "09:00", "UTC")).toBe(Date.UTC(2026, 6, 20, 9, 0));
  });
  it("applies EDT in summer (UTC-4)", () => {
    expect(zonedWindowToAbsolute("2026-07-20", "09:00", "America/New_York")).toBe(Date.UTC(2026, 6, 20, 13, 0));
  });
  it("applies EST in winter (UTC-5)", () => {
    expect(zonedWindowToAbsolute("2026-01-20", "09:00", "America/New_York")).toBe(Date.UTC(2026, 0, 20, 14, 0));
  });
  it("handles half-hour zones (Asia/Kolkata +5:30)", () => {
    expect(zonedWindowToAbsolute("2026-07-20", "09:00", "Asia/Kolkata")).toBe(Date.UTC(2026, 6, 20, 3, 30));
  });
  it("is correct right after spring-forward (EDT)", () => {
    // US DST begins 2026-03-08; by 09:00 the zone is EDT (UTC-4).
    expect(zonedWindowToAbsolute("2026-03-08", "09:00", "America/New_York")).toBe(Date.UTC(2026, 2, 8, 13, 0));
  });
  it("is correct right after fall-back (EST)", () => {
    // US DST ends 2026-11-01; by 09:00 the zone is EST (UTC-5).
    expect(zonedWindowToAbsolute("2026-11-01", "09:00", "America/New_York")).toBe(Date.UTC(2026, 10, 1, 14, 0));
  });
  it("returns a finite instant even in the spring-forward gap", () => {
    expect(Number.isFinite(zonedWindowToAbsolute("2026-03-08", "02:30", "America/New_York"))).toBe(true);
  });
});

describe("date helpers", () => {
  it("weekdayOf is tz-independent", () => {
    expect(weekdayOf("2026-07-20")).toBe(1); // Monday
    expect(weekdayOf("2026-07-19")).toBe(0); // Sunday
  });
  it("addDays crosses month boundaries", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

describe("interval algebra", () => {
  it("merges overlapping/adjacent intervals", () => {
    expect(mergeIntervals([{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 25, end: 30 }]))
      .toEqual([{ start: 0, end: 20 }, { start: 25, end: 30 }]);
  });
  it("subtracts busy and clips to the window (busy straddling the edge)", () => {
    // window 100..200, busy 50..120 (starts before window) and 180..250 (ends after)
    expect(subtractIntervals([{ start: 100, end: 200 }], [{ start: 50, end: 120 }, { start: 180, end: 250 }]))
      .toEqual([{ start: 120, end: 180 }]);
  });
  it("intersects across multiple free lists", () => {
    const a = [{ start: 0, end: 100 }];
    const b = [{ start: 50, end: 150 }];
    const c = [{ start: 60, end: 80 }, { start: 90, end: 200 }];
    expect(intersectAll([a, b, c])).toEqual([{ start: 60, end: 80 }, { start: 90, end: 100 }]);
  });
});

describe("workWindowForDate + scheduleForDate (three-state)", () => {
  const tz = "UTC";
  it("returns an absolute window for a configured day", () => {
    const p = { timezone: tz, work_schedule: allDays("09:00", "17:00") };
    expect(workWindowForDate(p, "2026-07-20")).toEqual({ start: Date.UTC(2026, 6, 20, 9), end: Date.UTC(2026, 6, 20, 17) });
  });
  it("treats an absent day (non-empty schedule) as day off → null", () => {
    const p = { timezone: tz, work_schedule: { "1": { start: "09:00", end: "17:00" } } };
    expect(scheduleForDate(p, "2026-07-19")).toBeNull(); // Sunday absent
    expect(workWindowForDate(p, "2026-07-19")).toBeNull();
  });
  it("treats no schedule at all as unknown → undefined", () => {
    expect(scheduleForDate({ timezone: tz }, "2026-07-20")).toBeUndefined();
  });
  it("falls back to legacy work_start/work_end/work_days", () => {
    const p = { timezone: tz, work_start: "08:00", work_end: "16:00", work_days: [1, 2, 3, 4, 5] };
    expect(workWindowForDate(p, "2026-07-20")).toEqual({ start: Date.UTC(2026, 6, 20, 8), end: Date.UTC(2026, 6, 20, 16) });
    expect(workWindowForDate(p, "2026-07-19")).toBeNull(); // Sunday not a work day
  });
  it("splits an overnight window across midnight into one continuous interval", () => {
    const p = { timezone: tz, work_schedule: allDays("22:00", "06:00") };
    expect(workWindowForDate(p, "2026-07-20")).toEqual({ start: Date.UTC(2026, 6, 20, 22), end: Date.UTC(2026, 6, 21, 6) });
  });
});

describe("isOutOfOfficeOn", () => {
  it("matches an inclusive ooo_range", () => {
    const p = { ooo_ranges: [{ start: "2026-07-20", end: "2026-07-25" }] };
    expect(isOutOfOfficeOn(p, "2026-07-20")).toBe(true);
    expect(isOutOfOfficeOn(p, "2026-07-25")).toBe(true);
    expect(isOutOfOfficeOn(p, "2026-07-26")).toBe(false);
  });
  it("matches the legacy ooo_start/ooo_end", () => {
    const p = { ooo_start: "2026-07-20", ooo_end: "2026-07-21" };
    expect(isOutOfOfficeOn(p, "2026-07-21")).toBe(true);
    expect(isOutOfOfficeOn(p, "2026-07-22")).toBe(false);
  });
});

describe("inAppBusyForPerson", () => {
  const meetings = [
    { created_by: "creator", attendee_ids: [], attendee_emails: [], starts_at: iso(2026, 6, 20, 10), ends_at: iso(2026, 6, 20, 11) },
    { created_by: "someone", attendee_ids: ["invitee"], attendee_emails: [], starts_at: iso(2026, 6, 20, 12), ends_at: iso(2026, 6, 20, 13) },
    { created_by: "someone", attendee_ids: [], attendee_emails: ["Guest@Example.com"], starts_at: iso(2026, 6, 20, 14), ends_at: iso(2026, 6, 20, 15) },
  ];
  it("matches creator", () => {
    expect(inAppBusyForPerson({ userId: "creator" }, meetings)).toEqual([{ start: Date.UTC(2026, 6, 20, 10), end: Date.UTC(2026, 6, 20, 11) }]);
  });
  it("matches internal attendee id", () => {
    expect(inAppBusyForPerson({ userId: "invitee" }, meetings)).toEqual([{ start: Date.UTC(2026, 6, 20, 12), end: Date.UTC(2026, 6, 20, 13) }]);
  });
  it("matches an email-invited teammate (case-insensitive)", () => {
    expect(inAppBusyForPerson({ userId: "x", email: "guest@example.com" }, meetings)).toEqual([{ start: Date.UTC(2026, 6, 20, 14), end: Date.UTC(2026, 6, 20, 15) }]);
  });
});

describe("computeAvailability", () => {
  const base = { timezone: "UTC", work_schedule: allDays("09:00", "17:00") };
  const date = "2026-07-20";
  const A = { userId: "a", profile: { ...base } };
  const B = { userId: "b", profile: { ...base } };

  it("suggests mutual slots and avoids a busy block", () => {
    const meetings = [{ created_by: "a", attendee_ids: [], attendee_emails: [], starts_at: iso(2026, 6, 20, 10), ends_at: iso(2026, 6, 20, 11) }];
    const { suggestedSlots } = computeAvailability({
      attendees: [A, B], meetings, dateStr: date, durationMin: 60, stepMin: 60, viewerTz: "UTC",
    });
    const starts = suggestedSlots.map((s) => s.start);
    expect(starts).toContain(Date.UTC(2026, 6, 20, 9));   // 9–10 free
    expect(starts).not.toContain(Date.UTC(2026, 6, 20, 10)); // 10–11 A busy
    expect(starts).toContain(Date.UTC(2026, 6, 20, 11));  // 11–12 free
    expect(suggestedSlots.length).toBeLessThanOrEqual(8);
  });

  it("excludes external emails from the mutual-free math", () => {
    const ext = { email: "ext@x.com", isExternal: true };
    const { excludedExternals, suggestedSlots } = computeAvailability({
      attendees: [A, ext], dateStr: date, durationMin: 60, stepMin: 60, viewerTz: "UTC",
    });
    expect(excludedExternals).toHaveLength(1);
    expect(suggestedSlots.length).toBeGreaterThan(0); // ext doesn't zero it out
  });

  it("returns no slots when an attendee is OOO all day", () => {
    const Booo = { userId: "b", profile: { ...base, ooo_ranges: [{ start: date, end: date }] } };
    const { suggestedSlots } = computeAvailability({
      attendees: [A, Booo], dateStr: date, durationMin: 60, stepMin: 60, viewerTz: "UTC",
    });
    expect(suggestedSlots).toHaveLength(0);
  });

  it("reports coverage by source", () => {
    const { coverage } = computeAvailability({
      attendees: [A, B], freebusy: { a: [] }, dateStr: date, durationMin: 60, stepMin: 60, viewerTz: "UTC",
    });
    expect(coverage).toMatchObject({ total: 2, calendar: 1, workhours: 1, none: 0 });
  });

  it("firstDayWithSlot scans forward past an OOO day", () => {
    const Booo = { userId: "b", profile: { ...base, ooo_ranges: [{ start: date, end: date }] } };
    const found = firstDayWithSlot({
      startDateStr: date, maxDays: 5,
      evaluate: (d) => computeAvailability({ attendees: [A, Booo], dateStr: d, durationMin: 60, stepMin: 60, viewerTz: "UTC" }),
    });
    expect(found).not.toBeNull();
    expect(found.dateStr).toBe(addDays(date, 1)); // OOO only on `date`
  });
});

describe("computeAvailability — safety gates (adversarial regressions)", () => {
  const date = "2026-07-20";

  it("suggests nothing when no attendee has work hours (no fabricated 3am slots)", () => {
    const A = { userId: "a", profile: { timezone: "UTC" } };
    const B = { userId: "b", profile: { timezone: "UTC" } };
    const { suggestedSlots, coverage } = computeAvailability({
      attendees: [A, B], dateStr: date, durationMin: 60, stepMin: 60, viewerTz: "UTC", maxSlots: 24,
    });
    expect(suggestedSlots).toHaveLength(0);
    expect(coverage.hasWorkWindows).toBe(false);
    expect(coverage.none).toBe(2);
  });

  it("does not fabricate zero-length slots for durationMin 0", () => {
    const A = { userId: "a", profile: { timezone: "UTC", work_schedule: allDays("09:00", "17:00") } };
    const { suggestedSlots } = computeAvailability({
      attendees: [A], dateStr: date, durationMin: 0, stepMin: 60, viewerTz: "UTC",
    });
    expect(suggestedSlots).toHaveLength(0);
  });

  it("returns no overlap for non-overlapping timezones (NY vs Kolkata 9–5)", () => {
    const ny = { userId: "ny", profile: { timezone: "America/New_York", work_schedule: allDays("09:00", "17:00") } };
    const kol = { userId: "kol", profile: { timezone: "Asia/Kolkata", work_schedule: allDays("09:00", "17:00") } };
    const { mutualFree, suggestedSlots } = computeAvailability({
      attendees: [ny, kol], dateStr: date, durationMin: 30, stepMin: 30, viewerTz: "UTC",
    });
    expect(mutualFree).toHaveLength(0);
    expect(suggestedSlots).toHaveLength(0);
  });

  it("aligns slots to the viewer's local step grid in a half-hour zone", () => {
    const A = { userId: "a", profile: { timezone: "Asia/Kolkata", work_schedule: allDays("09:00", "17:00") } };
    const kolMidnight = zonedWindowToAbsolute(date, "00:00", "Asia/Kolkata");
    const { suggestedSlots } = computeAvailability({
      attendees: [A], dateStr: date, durationMin: 60, stepMin: 60, viewerTz: "Asia/Kolkata",
    });
    expect(suggestedSlots.length).toBeGreaterThan(0);
    for (const s of suggestedSlots) expect((s.start - kolMidnight) % (60 * 60 * 1000)).toBe(0);
  });
});
