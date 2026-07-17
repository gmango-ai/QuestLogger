// Find-a-time availability engine — pure, dependency-free, unit-tested.
//
// Given a set of attendees (each with a profile: timezone + work_schedule/OOO),
// their in-app meetings, optional Google free/busy blocks, a calendar date, and
// a meeting duration, it computes each person's free time and the mutual open
// slots where everyone is available.
//
// CORRECTNESS INVARIANTS (all verified by the adversarial review):
//   • All interval math is on ABSOLUTE epoch milliseconds — DST-safe. Timezones
//     are touched in exactly one place: zonedWindowToAbsolute (wall-clock → ms).
//   • scheduled_meetings + Google busy blocks are already UTC — never re-zoned.
//   • work_schedule keys are STRINGS "0".."6"; three-state semantics matching
//     src/lib/timezone.js scheduleForToday (entry → window; absent-but-non-empty
//     → day off; empty/none → unknown, NOT "always free").
//   • OOO blocks the whole day in the person's OWN timezone; honors ooo_ranges
//     AND legacy ooo_start/ooo_end.
//   • Intervals are CLIPPED to the query window, never filtered by start (busy
//     blocks can straddle day/window edges).

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------------------------------------------------------------------------
// Timezone conversion (the ONLY zone-aware math in this module)
// ---------------------------------------------------------------------------

// How far ahead of UTC is `tz` at the instant `utcMs`, in milliseconds?
// Derived by asking Intl what wall-clock `utcMs` shows in `tz` and diffing.
// Minute-precision (works for half-hour zones like Asia/Kolkata +5:30).
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const m = {};
  for (const p of parts) m[p.type] = p.value;
  const hour = m.hour === "24" ? "00" : m.hour; // some engines emit 24 at midnight
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +hour, +m.minute, +m.second);
  return asUTC - utcMs;
}

// Absolute epoch ms for wall-clock `hm` ("HH:MM") on calendar date `dateStr`
// ("YYYY-MM-DD") in IANA zone `tz`. Two-pass offset probe so it's correct across
// DST transitions and fractional-hour offsets. In the spring-forward gap (a
// wall-clock that doesn't exist) it resolves consistently to the post-jump
// instant — acceptable and defined; 09:00 work starts never hit the gap.
export function zonedWindowToAbsolute(dateStr, hm, tz) {
  const [y, mo, d] = String(dateStr).split("-").map(Number);
  const [hh, mm] = String(hm).split(":").map(Number);
  if ([y, mo, d, hh, mm].some((n) => Number.isNaN(n))) return NaN;
  if (!tz) return Date.UTC(y, mo - 1, d, hh, mm); // treat as UTC if no zone
  const guess = Date.UTC(y, mo - 1, d, hh, mm);   // pretend wall-clock is UTC
  const off1 = tzOffsetMs(guess, tz);
  let result = guess - off1;
  const off2 = tzOffsetMs(result, tz);            // refine near DST boundaries
  if (off2 !== off1) result = guess - off2;
  return result;
}

// Weekday (0=Sun..6=Sat) of a calendar date string — tz-independent (a given
// calendar date is the same weekday everywhere).
export function weekdayOf(dateStr) {
  const [y, mo, d] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

// dateStr + n calendar days → "YYYY-MM-DD".
export function addDays(dateStr, n) {
  const [y, mo, d] = String(dateStr).split("-").map(Number);
  const t = Date.UTC(y, mo - 1, d) + n * DAY_MS;
  const dt = new Date(t);
  const p = (x) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

function hmToMin(hm) {
  const [h, m] = String(hm).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// Interval algebra — intervals are { start, end } in epoch ms, start < end.
// ---------------------------------------------------------------------------

export function mergeIntervals(list) {
  const xs = (list || [])
    .filter((i) => i && i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const cur of xs) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ start: cur.start, end: cur.end });
  }
  return out;
}

function clipToWindow(list, win) {
  const out = [];
  for (const i of list || []) {
    const s = Math.max(i.start, win.start);
    const e = Math.min(i.end, win.end);
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}

// Free gaps inside `windows` after removing `busy`. Both clipped to each window
// so a busy block that starts the day before still subtracts correctly.
export function subtractIntervals(windows, busy) {
  const merged = mergeIntervals(busy);
  const out = [];
  for (const win of windows || []) {
    if (win.end <= win.start) continue;
    let cursor = win.start;
    for (const b of clipToWindow(merged, win)) {
      if (b.start > cursor) out.push({ start: cursor, end: b.start });
      cursor = Math.max(cursor, b.end);
    }
    if (cursor < win.end) out.push({ start: cursor, end: win.end });
  }
  return out;
}

function intersectTwo(a, b) {
  const out = [];
  let i = 0, j = 0;
  const A = mergeIntervals(a), B = mergeIntervals(b);
  while (i < A.length && j < B.length) {
    const s = Math.max(A[i].start, B[j].start);
    const e = Math.min(A[i].end, B[j].end);
    if (e > s) out.push({ start: s, end: e });
    if (A[i].end < B[j].end) i++; else j++;
  }
  return out;
}

export function intersectAll(lists) {
  if (!lists || !lists.length) return [];
  return lists.reduce((acc, cur) => intersectTwo(acc, cur));
}

// ---------------------------------------------------------------------------
// Per-person availability from a profile
// ---------------------------------------------------------------------------

// Schedule entry for a specific date, mirroring timezone.js scheduleForToday:
//   { start, end, loc } → a work day,  null → day off,  undefined → unknown.
export function scheduleForDate(profile, dateStr) {
  const wd = weekdayOf(dateStr);
  const sched = profile?.work_schedule;
  if (sched && typeof sched === "object" && Object.keys(sched).length) {
    return sched[String(wd)] || null;
  }
  const ws = profile?.work_start, we = profile?.work_end, days = profile?.work_days;
  if (!ws && !we && (!days || !days.length)) return undefined;
  if (Array.isArray(days) && days.length && !days.includes(wd)) return null;
  if (ws || we) return { start: ws, end: we, loc: null };
  return undefined;
}

// The person's work window on `dateStr` as an absolute-ms interval, or null if
// day-off/unknown/degenerate. Handles overnight windows (end <= start) by
// resolving the end on the next calendar day — one continuous interval.
export function workWindowForDate(profile, dateStr) {
  const entry = scheduleForDate(profile, dateStr);
  if (!entry || !entry.start || !entry.end) return null;
  const tz = profile?.timezone || "UTC";
  const startMin = hmToMin(entry.start), endMin = hmToMin(entry.end);
  if (startMin == null || endMin == null || startMin === endMin) return null;
  const start = zonedWindowToAbsolute(dateStr, entry.start, tz);
  const overnight = endMin <= startMin;
  const end = overnight
    ? zonedWindowToAbsolute(addDays(dateStr, 1), entry.end, tz)
    : zonedWindowToAbsolute(dateStr, entry.end, tz);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return { start, end };
}

// Does `dateStr` (a calendar day) fall within any OOO range for this person?
// Inclusive date-string compare — tz-independent since OOO is stored as local
// calendar dates. Honors ooo_ranges AND legacy ooo_start/ooo_end.
export function isOutOfOfficeOn(profile, dateStr) {
  const ranges = Array.isArray(profile?.ooo_ranges) ? profile.ooo_ranges : [];
  for (const r of ranges) {
    if (!r || (!r.start && !r.end)) continue;
    if ((!r.start || dateStr >= r.start) && (!r.end || dateStr <= r.end)) return true;
  }
  const s = profile?.ooo_start, e = profile?.ooo_end;
  if (!s && !e) return false;
  if (s && dateStr < s) return false;
  if (e && dateStr > e) return false;
  return true;
}

// In-app busy blocks for a person from team-readable scheduled_meetings.
// A person is busy if they created the meeting, are an internal attendee, OR
// their email is in attendee_emails (email-invited teammates count too).
export function inAppBusyForPerson({ userId, email }, meetings) {
  const lowEmail = email ? String(email).toLowerCase() : null;
  const out = [];
  for (const m of meetings || []) {
    const mine =
      (userId && m.created_by === userId) ||
      (userId && Array.isArray(m.attendee_ids) && m.attendee_ids.includes(userId)) ||
      (lowEmail && Array.isArray(m.attendee_emails) &&
        m.attendee_emails.some((e) => String(e).toLowerCase() === lowEmail));
    if (!mine) continue;
    const s = Date.parse(m.starts_at), e = Date.parse(m.ends_at);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push({ start: s, end: e });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// attendees: [{ userId, email, profile, isExternal }]
//   - internal teammates have a profile; external emails have isExternal:true.
// meetings:  team-readable scheduled_meetings rows for the day.
// freebusy:  { [userId]: [{start:ISO|ms, end:ISO|ms}] } from the edge fn (opt).
// Returns { perPerson, suggestedSlots, excludedExternals, coverage }.
export function computeAvailability({
  attendees = [],
  meetings = [],
  freebusy = {},
  dateStr,
  durationMin = 30,
  stepMin = 30,
  viewerTz = "UTC",
  maxSlots = 8,
}) {
  const internal = attendees.filter((a) => !a.isExternal && a.userId);
  const excludedExternals = attendees.filter((a) => a.isExternal || !a.userId);

  const toMs = (v) => (typeof v === "number" ? v : Date.parse(v));
  const fbFor = (id) =>
    (freebusy && freebusy[id] ? freebusy[id] : [])
      .map((b) => ({ start: toMs(b.start), end: toMs(b.end) }))
      .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);

  // Known work windows first, to derive day bounds for unconstrained people.
  // If NOBODY has a work-hours window we have no notion of "reasonable hours",
  // so we must NOT fabricate a full 24h day and suggest 3 AM slots — instead we
  // emit no suggestions and let the UI say "no work hours available".
  const windows = internal.map((a) => workWindowForDate(a.profile, dateStr));
  const known = windows.filter(Boolean);
  const hasFrame = known.length > 0;
  const dayBounds = hasFrame
    ? { start: Math.min(...known.map((w) => w.start)), end: Math.max(...known.map((w) => w.end)) }
    : null;

  const perPerson = {};
  const freeLists = [];
  for (let idx = 0; idx < internal.length; idx++) {
    const a = internal[idx];
    const win = windows[idx];
    const hasFb = Object.prototype.hasOwnProperty.call(freebusy || {}, a.userId);
    const scheduleKnown = win != null || scheduleForDate(a.profile, dateStr) === null;
    const source = hasFb ? "calendar" : scheduleKnown ? "workhours" : "none";

    const busy = mergeIntervals([...inAppBusyForPerson(a, meetings), ...fbFor(a.userId)]);

    let free;
    if (isOutOfOfficeOn(a.profile, dateStr)) {
      free = []; // OOO all day
    } else if (win) {
      free = subtractIntervals([win], busy);
    } else if (scheduleForDate(a.profile, dateStr) === null) {
      free = []; // configured day off
    } else {
      // Unknown schedule: bound to the day (only when SOME attendee anchors a
      // real work window) and subtract whatever busy we know. With no frame at
      // all, we can't place them → contribute nothing rather than "always free".
      free = hasFrame ? subtractIntervals([dayBounds], busy) : [];
    }

    perPerson[a.userId] = { source, work: win || null, busy, free };
    // Every attendee constrains the intersection by their own free time.
    // Unknown-schedule people already have free = dayBounds − busy, so they
    // widen to the day bounds without being treated as "always free" globally.
    freeLists.push(free);
  }

  const mutualFree = internal.length && hasFrame ? intersectAll(freeLists) : [];

  // Slice mutual-free windows into duration-long slots aligned to the viewer's
  // local step grid (clean :00/:15/:30 times), earliest-first, capped. Guarded
  // on a real work-hours frame + a positive duration/step so we never emit
  // fabricated or zero-length slots.
  const durMs = durationMin * 60 * 1000;
  const stepMs = stepMin * 60 * 1000;
  const viewerMidnight = zonedWindowToAbsolute(dateStr, "00:00", viewerTz);
  const suggestedSlots = [];
  for (const w of (durationMin > 0 && stepMin > 0 ? mutualFree : [])) {
    let t = viewerMidnight + Math.ceil((w.start - viewerMidnight) / stepMs) * stepMs;
    if (t < w.start) t += stepMs;
    for (; t + durMs <= w.end; t += stepMs) {
      if (suggestedSlots.length >= maxSlots) break;
      const slotStart = t, slotEnd = t + durMs;
      const offHoursFor = internal
        .filter((a) => {
          const win2 = perPerson[a.userId]?.work;
          return win2 && (slotStart < win2.start || slotEnd > win2.end);
        })
        .map((a) => a.userId);
      suggestedSlots.push({ start: slotStart, end: slotEnd, offHoursFor });
    }
    if (suggestedSlots.length >= maxSlots) break;
  }

  const coverage = {
    total: internal.length,
    calendar: internal.filter((a) => perPerson[a.userId]?.source === "calendar").length,
    workhours: internal.filter((a) => perPerson[a.userId]?.source === "workhours").length,
    none: internal.filter((a) => perPerson[a.userId]?.source === "none").length,
    externals: excludedExternals.length,
    // False when no attendee has any work-hours window → the UI should prompt
    // for work hours instead of showing (absent) suggestions as "all free".
    hasWorkWindows: hasFrame,
  };

  return { perPerson, mutualFree, suggestedSlots, excludedExternals, coverage };
}

// Scan forward up to `maxDays` for the first date (from dateStr) that yields at
// least one suggested slot. Returns { dateStr, slot } or null. Caller supplies a
// fetcher for that day's meetings/freebusy (kept out so this stays pure-ish).
export function firstDayWithSlot({ startDateStr, maxDays = 14, evaluate }) {
  for (let i = 0; i < maxDays; i++) {
    const d = addDays(startDateStr, i);
    const res = evaluate(d);
    if (res && res.suggestedSlots && res.suggestedSlots.length) {
      return { dateStr: d, slot: res.suggestedSlots[0], result: res };
    }
  }
  return null;
}

export { WEEKDAYS };
