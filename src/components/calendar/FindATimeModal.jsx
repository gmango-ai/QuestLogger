import { useState, useEffect, useMemo, useRef } from "react";
import { X, Users, Clock, ChevronLeft, ChevronRight, Loader2, CalendarPlus, ArrowRight, Settings2 } from "lucide-react";
import Modal from "../Modal";
import { Button } from "@/components/ui/button";
import { supabase } from "../../supabase";
import { useApp } from "../../context/AppContext";
import { useTeam } from "../../context/TeamContext";
import { getProfiles } from "../../lib/profiles";
import { fetchMeetingsInRange } from "../../lib/calendar";
import { computeAvailability, firstDayWithSlot, addDays } from "../../lib/findATime";
import { createScheduledMeeting } from "../../lib/scheduledMeetings";
import { browserTimezone, tzAbbrev } from "../../lib/timezone";

// "Find a time" — see attendees' availability and get suggested open slots.
// Slots are the PRIMARY surface (a grid doesn't fit the modal); a collapsible
// detail view shows per-person busy timelines. Availability = each person's work
// hours + OOO + in-app meetings (Phase 1). Google free/busy plugs in later via
// the `freebusy` prop. Every suggestion is honest about who is/isn't accounted
// for so it never silently implies "all free".

const DURATIONS = [15, 30, 45, 60, 90];
const fmtDur = (d) => (d % 60 === 0 ? `${d / 60}h` : d < 60 ? `${d}m` : `${Math.floor(d / 60)}h ${d % 60}m`);
const todayLocal = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in viewer tz
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDay = (dateStr) => new Date(`${dateStr}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const parseEmails = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const pct = (v, lo, hi) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));

export default function FindATimeModal({ teamId, rooms, dark, onClose, onScheduled, onMoreOptions }) {
  const { session, googleToken, googleTokenExpiry, createCalendarEvent } = useApp();
  const { teamMembers } = useTeam();
  const viewerTz = useMemo(() => browserTimezone() || "UTC", []);
  const selfId = session?.user?.id;
  const selfEmail = session?.user?.email || null;
  const hasGoogle = !!googleToken && Date.now() < googleTokenExpiry;

  const others = useMemo(
    () => (teamMembers || []).filter((m) => m.user_id && m.user_id !== selfId),
    [teamMembers, selfId],
  );

  const [attendeeIds, setAttendeeIds] = useState(() => new Set());
  const [externalEmails, setExternalEmails] = useState("");
  const [date, setDate] = useState(todayLocal);
  const [duration, setDuration] = useState(30);
  const [profiles, setProfiles] = useState({});
  const [meetings, setMeetings] = useState([]);
  const [freebusy, setFreebusy] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [nextAvail, setNextAvail] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [slot, setSlot] = useState(null); // chosen slot → inline finalize
  const [title, setTitle] = useState("Meeting");
  const [addGoogle, setAddGoogle] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setAddGoogle(hasGoogle); }, [hasGoogle]);

  const generalRoom = useMemo(() => {
    const rs = rooms || [];
    // Room kind 'department' was renamed to 'general' (migration 20260615000000);
    // prefer the guaranteed "General" room, then any general room, then anything.
    return rs.find((r) => r.kind === "general" && (r.name || "").toLowerCase() === "general")
      || rs.find((r) => r.kind === "general") || rs[0] || null;
  }, [rooms]);

  const nameFor = (id) => {
    if (id === selfId) return "You";
    const m = others.find((o) => o.user_id === id);
    return m?.name || profiles[id]?.display_name || "Teammate";
  };

  // Profiles (availability fields) for self + all teammates.
  useEffect(() => {
    const ids = [selfId, ...others.map((m) => m.user_id)].filter(Boolean);
    if (!ids.length) return undefined;
    let cancel = false;
    getProfiles(ids).then((map) => { if (!cancel) setProfiles(map || {}); });
    return () => { cancel = true; };
  }, [others, selfId]);

  // Meetings for a 14-day window from the chosen date (covers next-available).
  useEffect(() => {
    if (!teamId) return undefined;
    let cancel = false;
    const startISO = new Date(`${addDays(date, -1)}T00:00:00Z`).toISOString();
    const endISO = new Date(`${addDays(date, 15)}T00:00:00Z`).toISOString();
    fetchMeetingsInRange(teamId, startISO, endISO).then(({ data }) => { if (!cancel) setMeetings(data || []); });
    return () => { cancel = true; };
  }, [teamId, date]);

  // Google free/busy for opted-in attendees (Phase 2). Debounced; degrades
  // silently to the work-hours/in-app core if the fn is unconfigured or errors.
  const idsKey = useMemo(() => [selfId, ...[...attendeeIds].sort()].filter(Boolean).join(","), [selfId, attendeeIds]);
  const fbRef = useRef();
  useEffect(() => {
    if (!teamId || !idsKey) { setFreebusy({}); return undefined; }
    let cancel = false;
    clearTimeout(fbRef.current);
    fbRef.current = setTimeout(() => {
      const user_ids = idsKey.split(",");
      const timeMin = new Date(`${date}T00:00:00Z`).toISOString();
      const timeMax = new Date(`${addDays(date, 14)}T00:00:00Z`).toISOString();
      supabase.functions.invoke("calendar-freebusy", { body: { team_id: teamId, user_ids, timeMin, timeMax } })
        .then(({ data }) => { if (!cancel) setFreebusy(data?.busy || {}); })
        .catch(() => { if (!cancel) setFreebusy({}); });
    }, 500);
    return () => { cancel = true; clearTimeout(fbRef.current); };
  }, [teamId, idsKey, date]);

  // Attendees = organizer (you) + selected teammates + external emails.
  const attendees = useMemo(() => {
    const list = [];
    if (selfId) list.push({ userId: selfId, email: selfEmail, profile: profiles[selfId] || { timezone: viewerTz } });
    for (const id of attendeeIds) list.push({ userId: id, profile: profiles[id] || {} });
    for (const em of parseEmails(externalEmails)) list.push({ email: em, isExternal: true });
    return list;
  }, [selfId, selfEmail, attendeeIds, externalEmails, profiles, viewerTz]);

  // Debounced availability compute (keeps last result visible while recomputing).
  const debRef = useRef();
  useEffect(() => {
    setLoading(true);
    clearTimeout(debRef.current);
    debRef.current = setTimeout(() => {
      const evaluate = (d) => computeAvailability({ attendees, meetings, freebusy, dateStr: d, durationMin: duration, stepMin: 30, viewerTz, maxSlots: 8 });
      const res = evaluate(date);
      setResult(res);
      setNextAvail(
        !res.suggestedSlots.length && res.coverage.hasWorkWindows
          ? firstDayWithSlot({ startDateStr: addDays(date, 1), maxDays: 13, evaluate })
          : null,
      );
      setLoading(false);
    }, 400);
    return () => clearTimeout(debRef.current);
  }, [attendees, meetings, freebusy, date, duration, viewerTz]);

  const toggle = (id) => setAttendeeIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allSelected = others.length > 0 && attendeeIds.size === others.length;
  const toggleAll = () => setAttendeeIds(allSelected ? new Set() : new Set(others.map((m) => m.user_id)));

  async function scheduleSlot() {
    if (!slot || creating) return;
    if (!generalRoom) { setError("This team has no room to host the meeting."); return; }
    if (!title.trim()) { setError("Give the meeting a title."); return; }
    setCreating(true); setError("");
    const start = new Date(slot.start), end = new Date(slot.end);
    const emails = parseEmails(externalEmails);
    let googleEventId = null, googleHtmlLink = null;
    if (addGoogle && hasGoogle) {
      const ev = await createCalendarEvent({ summary: title.trim(), start, end, attendees: emails, location: generalRoom.name });
      if (!ev) { setCreating(false); return; } // token re-consent redirect underway
      googleEventId = ev.id; googleHtmlLink = ev.htmlLink;
    }
    const { error: saveErr } = await createScheduledMeeting({
      room_id: generalRoom.id, team_id: teamId, created_by: selfId,
      title: title.trim(), description: null,
      starts_at: start.toISOString(), ends_at: end.toISOString(),
      auto_record: false, priority: 1,
      attendee_ids: [...attendeeIds], attendee_emails: emails,
      google_event_id: googleEventId, google_html_link: googleHtmlLink,
    });
    setCreating(false);
    if (saveErr) { setError(saveErr.message || "Could not schedule the meeting."); return; }
    onScheduled?.(); onClose?.();
  }

  const field = dark ? "bg-[var(--color-surface-2,#1e293b)] border-[var(--color-border)] text-slate-100" : "bg-white border-slate-300 text-slate-900";
  const labelCls = `block text-xs font-semibold mb-1 ${dark ? "text-slate-300" : "text-slate-600"}`;
  const chip = (src) => src === "calendar"
    ? { cls: dark ? "text-emerald-300" : "text-emerald-600", label: "calendar" }
    : src === "workhours"
      ? { cls: dark ? "text-amber-300" : "text-amber-600", label: "work hours" }
      : { cls: dark ? "text-slate-500" : "text-slate-400", label: "no data" };

  const cov = result?.coverage;
  const internalCount = cov?.total ?? 0;
  const accounted = cov ? cov.calendar + cov.workhours : 0;

  // Bounds for the detail timeline (union of work windows, else 8am–8pm viewer).
  const detailBounds = useMemo(() => {
    if (!result) return null;
    const works = Object.values(result.perPerson).map((p) => p.work).filter(Boolean);
    if (works.length) return { start: Math.min(...works.map((w) => w.start)), end: Math.max(...works.map((w) => w.end)) };
    return { start: new Date(`${date}T08:00:00`).getTime(), end: new Date(`${date}T20:00:00`).getTime() };
  }, [result, date]);

  return (
    <Modal open onClose={onClose} labelledBy="find-a-time-title">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-md flex flex-col overflow-hidden rounded-2xl border shadow-xl max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2rem)] ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}
      >
        {/* Header */}
        <div className={`shrink-0 flex items-center justify-between gap-2 px-5 py-4 border-b ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
          <h2 id="find-a-time-title" className={`flex items-center gap-2 text-base font-bold ${dark ? "text-slate-100" : "text-slate-900"}`}>
            <Clock className="w-4 h-4 text-[var(--color-accent)]" /> Find a time
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className={`p-1.5 rounded-lg ${dark ? "text-slate-400 hover:text-slate-200 hover:bg-white/5" : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Attendees */}
          <div>
            <label className={labelCls}><Users className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />Who</label>
            <div className={`rounded-lg border max-h-32 overflow-y-auto ${field}`}>
              {others.length === 0 ? (
                <p className="px-3 py-2 text-xs opacity-60">No teammates to check.</p>
              ) : (
                <>
                  <label className={`flex items-center gap-2 px-3 py-1.5 text-sm border-b ${dark ? "border-white/5" : "border-slate-100"}`}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-[var(--color-accent)]" />
                    Everyone ({others.length})
                  </label>
                  {others.map((m) => {
                    const src = result?.perPerson?.[m.user_id]?.source;
                    const c = chip(src);
                    const tz = profiles[m.user_id]?.timezone;
                    return (
                      <label key={m.user_id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                        <input type="checkbox" checked={attendeeIds.has(m.user_id)} onChange={() => toggle(m.user_id)} className="accent-[var(--color-accent)]" />
                        <span className="truncate">{m.name || profiles[m.user_id]?.display_name || "Teammate"}</span>
                        {attendeeIds.has(m.user_id) && src && (
                          <span className={`ml-auto text-[10px] font-semibold ${c.cls}`} title={`Availability from ${c.label}`}>{c.label}</span>
                        )}
                        {tz && !attendeeIds.has(m.user_id) && (
                          <span className="ml-auto text-[10px] opacity-50 shrink-0">{tzAbbrev(tz) || tz.split("/").pop()}</span>
                        )}
                      </label>
                    );
                  })}
                </>
              )}
            </div>
            <input
              value={externalEmails}
              onChange={(e) => setExternalEmails(e.target.value)}
              placeholder="External guest emails (comma-separated)"
              className={`w-full rounded-lg border px-3 py-2 text-sm mt-2 ${field}`}
            />
            {parseEmails(externalEmails).length > 0 && (
              <p className={`text-[11px] mt-1 ${dark ? "text-slate-500" : "text-slate-400"}`}>
                Invited, but availability unknown — external guests aren't included in the free-time math.
              </p>
            )}
          </div>

          {/* Date + duration */}
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setDate((d) => addDays(d, -1))} disabled={date <= todayLocal()} aria-label="Previous day"
              className={`p-1.5 rounded-lg border ${field} disabled:opacity-40`}><ChevronLeft className="w-4 h-4" /></button>
            <input type="date" value={date} min={todayLocal()} onChange={(e) => setDate(e.target.value || todayLocal())} className={`flex-1 rounded-lg border px-3 py-2 text-sm ${field}`} />
            <button type="button" onClick={() => setDate((d) => addDays(d, 1))} aria-label="Next day"
              className={`p-1.5 rounded-lg border ${field}`}><ChevronRight className="w-4 h-4" /></button>
          </div>
          <div>
            <label className={labelCls}>Duration</label>
            <div className="flex flex-wrap gap-1.5">
              {DURATIONS.map((d) => (
                <button key={d} type="button" onClick={() => setDuration(d)} aria-pressed={duration === d}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    duration === d ? "bg-[var(--color-accent)] border-transparent text-white"
                      : dark ? "border-[var(--color-border)] text-slate-300 hover:bg-white/5" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                  {fmtDur(d)}
                </button>
              ))}
            </div>
          </div>

          {/* Coverage note */}
          {cov && internalCount > 0 && (cov.workhours > 0 || cov.none > 0) && (
            <p className={`text-[11px] flex items-start gap-1 ${dark ? "text-amber-300/80" : "text-amber-700"}`}>
              <span aria-hidden>⚠</span>
              {cov.none > 0
                ? `${cov.none} of ${internalCount} have no availability on file — suggestions may miss their conflicts.`
                : `Using work hours + in-app meetings${cov.calendar ? "" : " (no live calendars connected)"}. Real calendar conflicts outside the app aren't shown.`}
            </p>
          )}

          {/* Suggested slots — the primary surface */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={labelCls} style={{ marginBottom: 0 }}>Suggested times · {fmtDay(date)}</label>
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin opacity-60" />}
            </div>

            {!cov?.hasWorkWindows ? (
              <p className={`text-xs rounded-lg border border-dashed px-3 py-3 ${dark ? "border-[var(--color-border)] text-slate-400" : "border-slate-200 text-slate-500"}`}>
                No work hours on file for these people, so we can't suggest times. Ask them to set working hours in Settings, or open the availability detail below.
              </p>
            ) : result?.suggestedSlots?.length ? (
              <ul className="space-y-1.5">
                {result.suggestedSlots.map((s) => (
                  <li key={s.start}>
                    <button type="button" onClick={() => { setSlot(s); setError(""); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${
                        slot?.start === s.start ? "border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]" : dark ? "border-[var(--color-border)] hover:bg-white/5" : "border-slate-200 hover:bg-slate-50"}`}>
                      <span className={`text-sm font-semibold ${dark ? "text-slate-100" : "text-slate-800"}`}>{fmtTime(s.start)}–{fmtTime(s.end)}</span>
                      {internalCount > 1 && (
                        <span className={`ml-auto text-[10px] font-semibold ${cov.none === 0 ? (dark ? "text-emerald-300" : "text-emerald-600") : (dark ? "text-amber-300" : "text-amber-600")}`}>
                          {cov.none === 0 ? `all ${internalCount} free` : `${accounted} of ${internalCount}`}
                        </span>
                      )}
                      {s.offHoursFor?.length > 0 && (
                        <span className="text-[10px] text-orange-400" title={`Outside work hours for ${s.offHoursFor.map(nameFor).join(", ")}`}>off-hours</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className={`text-xs rounded-lg border border-dashed px-3 py-3 ${dark ? "border-[var(--color-border)] text-slate-400" : "border-slate-200 text-slate-500"}`}>
                No openings on {fmtDay(date)}.
                {nextAvail && (
                  <button type="button" onClick={() => setDate(nextAvail.dateStr)} className="ml-1 font-semibold text-[var(--color-accent)] inline-flex items-center gap-0.5">
                    Next available: {fmtDay(nextAvail.dateStr)} {fmtTime(nextAvail.slot.start)} <ArrowRight className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Collapsible availability detail (secondary) */}
          {result && internalCount > 0 && detailBounds && (
            <div>
              <button type="button" onClick={() => setShowDetail((v) => !v)} className={`text-xs font-semibold ${dark ? "text-slate-300" : "text-slate-600"}`}>
                {showDetail ? "Hide" : "Show"} availability detail
              </button>
              {showDetail && (
                <div className="mt-2 space-y-2">
                  {attendees.filter((a) => !a.isExternal).map((a) => {
                    const p = result.perPerson[a.userId];
                    const busy = (p?.busy || []).map((b) => ({ start: Math.max(b.start, detailBounds.start), end: Math.min(b.end, detailBounds.end) })).filter((b) => b.end > b.start);
                    const label = `${nameFor(a.userId)}: ${p?.free?.length ? p.free.map((f) => `${fmtTime(f.start)}–${fmtTime(f.end)}`).join(", ") : "no free time"}`;
                    return (
                      <div key={a.userId} aria-label={label}>
                        <div className="flex items-center justify-between text-[11px] mb-0.5">
                          <span className={dark ? "text-slate-300" : "text-slate-600"}>{nameFor(a.userId)}</span>
                          <span className={chip(p?.source).cls + " font-semibold"}>{chip(p?.source).label}</span>
                        </div>
                        <div className={`relative h-2.5 rounded ${dark ? "bg-slate-700/40" : "bg-slate-100"}`} title={label}>
                          {p?.work && (
                            <div className="absolute inset-y-0 rounded bg-emerald-500/25"
                              style={{ left: `${pct(p.work.start, detailBounds.start, detailBounds.end)}%`, right: `${100 - pct(p.work.end, detailBounds.start, detailBounds.end)}%` }} />
                          )}
                          {busy.map((b, i) => (
                            <div key={i} className="absolute inset-y-0 rounded bg-rose-500/70"
                              style={{ left: `${pct(b.start, detailBounds.start, detailBounds.end)}%`, right: `${100 - pct(b.end, detailBounds.start, detailBounds.end)}%` }} />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  <p className={`text-[10px] ${dark ? "text-slate-500" : "text-slate-400"}`}>
                    Times in your timezone ({tzAbbrev(viewerTz) || viewerTz}). <span className="text-emerald-500">green</span> = work hours · <span className="text-rose-500">red</span> = busy.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer — inline finalize when a slot is picked */}
        <div className={`shrink-0 border-t px-5 py-3 space-y-2 ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
          {error && <p className={`text-xs font-medium ${dark ? "text-red-400" : "text-red-600"}`}>{error}</p>}
          {slot ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Meeting title"
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm ${field}`} />
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className={dark ? "text-slate-400" : "text-slate-500"}>
                  {fmtDay(date)} · {fmtTime(slot.start)}–{fmtTime(slot.end)} · in {generalRoom?.name || "—"}
                </span>
                <label className={`flex items-center gap-1 ${hasGoogle ? "" : "opacity-40"}`}>
                  <input type="checkbox" checked={addGoogle} disabled={!hasGoogle} onChange={(e) => setAddGoogle(e.target.checked)} className="accent-[var(--color-accent)]" />
                  Google
                </label>
              </div>
              <div className="flex items-center justify-between gap-2">
                <button type="button" onClick={() => onMoreOptions?.({ start: new Date(slot.start), attendeeIds: [...attendeeIds], externalEmails: parseEmails(externalEmails), duration })}
                  className={`text-xs inline-flex items-center gap-1 ${dark ? "text-slate-400 hover:text-slate-200" : "text-slate-500 hover:text-slate-700"}`}>
                  <Settings2 className="w-3.5 h-3.5" /> More options
                </button>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" onClick={() => setSlot(null)}>Back</Button>
                  <Button type="button" onClick={scheduleSlot} disabled={creating || !generalRoom}>
                    {creating ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <CalendarPlus className="w-4 h-4 mr-1.5" />}
                    Schedule
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
