import { useEffect, useMemo, useState } from "react";
import EmojiTextField from "../EmojiTextField";
import { CalendarPlus, X, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import Modal from "../Modal";
import { useApp } from "../../context/AppContext";
import { useTeam } from "../../context/TeamContext";
import { getProfiles } from "../../lib/profiles";
import { createScheduledMeeting, updateScheduledMeeting, deleteScheduledMeeting } from "../../lib/scheduledMeetings";
import MeetingTimezones from "../calendar/MeetingTimezones";

// Book a meeting into this room, optionally mirrored to the creator's Google
// Calendar (foreground OAuth token — same pattern as the Sheets/Docs export).

const DURATIONS = [15, 30, 45, 60, 90];
const fmtDur = (d) => (d % 60 === 0 ? `${d / 60}h` : d < 60 ? `${d}m` : `${Math.floor(d / 60)}h ${d % 60}m`);

function defaultDate() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (local-ish; good enough for a picker default)
}
function defaultTime() {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isoTime(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// `room` = fixed room (office flow). `rooms` + no `room` = calendar flow with a
// room picker. `initialStart` prefills from a slot; `meeting` (row) = edit mode.
export default function ScheduleMeetingModal({ room, rooms, teamId, dark, initialStart, initialAttendeeIds, initialExternalEmails, initialDuration, initialRoomId, meeting, onClose, onCreated, onDeleted }) {
  const { session, googleToken, googleTokenExpiry, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } = useApp();
  const hasGoogle = !!googleToken && Date.now() < googleTokenExpiry;
  const editing = !!meeting;

  // Any room can host a scheduled meeting (teams often meet in general rooms).
  const roomOptions = room ? [] : (rooms || []);
  const [roomId, setRoomId] = useState(meeting?.room_id || room?.id || initialRoomId || roomOptions[0]?.id || "");
  const effRoom = room || (rooms || []).find((r) => r.id === roomId) || null;

  const startInit = meeting ? new Date(meeting.starts_at) : (initialStart || null);
  const durInit = meeting ? Math.max(5, Math.round((new Date(meeting.ends_at) - new Date(meeting.starts_at)) / 60000)) : (initialDuration || 30);

  const [title, setTitle] = useState(meeting?.title || (effRoom?.name ? `${effRoom.name} meeting` : "Meeting"));
  const [description, setDescription] = useState(meeting?.description || "");
  const [date, setDate] = useState(startInit ? isoDate(startInit) : defaultDate);
  const [time, setTime] = useState(startInit ? isoTime(startInit) : defaultTime);
  const [duration, setDuration] = useState(durInit);
  const [autoRecord, setAutoRecord] = useState(!!meeting?.auto_record);
  const [priority, setPriority] = useState(meeting?.priority ?? 1);
  const [addToCalendar, setAddToCalendar] = useState(editing ? !!meeting?.google_event_id : hasGoogle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // ── attendees + timezone preview ──
  const { teamMembers } = useTeam();
  const otherMembers = (teamMembers || []).filter((m) => m.user_id && m.user_id !== session?.user?.id);
  const [attendeeIds, setAttendeeIds] = useState(() => new Set(meeting?.attendee_ids || initialAttendeeIds || []));
  const [externalEmails, setExternalEmails] = useState((meeting?.attendee_emails || initialExternalEmails || []).join(", "));
  const [memberProfiles, setMemberProfiles] = useState({});

  useEffect(() => {
    const ids = otherMembers.map((m) => m.user_id);
    if (!ids.length) return;
    getProfiles(ids).then((map) => setMemberProfiles(map || {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamMembers]);

  const startPreview = useMemo(() => {
    const d = new Date(`${date}T${time}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [date, time]);
  const attendeeZones = useMemo(() => {
    const map = new Map();
    attendeeIds.forEach((id) => {
      const tz = memberProfiles[id]?.timezone;
      if (!tz) return;
      if (!map.has(tz)) map.set(tz, []);
      map.get(tz).push(memberProfiles[id]?.display_name || "Teammate");
    });
    return [...map.entries()].map(([tz, names]) => ({ tz, label: names.join(", ") }));
  }, [attendeeIds, memberProfiles]);

  const toggleAttendee = (id) => setAttendeeIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allSelected = otherMembers.length > 0 && attendeeIds.size === otherMembers.length;
  const toggleAll = () => setAttendeeIds(allSelected ? new Set() : new Set(otherMembers.map((m) => m.user_id)));
  const memberName = (m) => m.name || memberProfiles[m.user_id]?.display_name || "Teammate";

  const field = dark
    ? "bg-[var(--color-surface-2,#1e293b)] border-[var(--color-border)] text-slate-100"
    : "bg-white border-slate-300 text-slate-900";
  const labelCls = `block text-xs font-semibold mb-1 ${dark ? "text-slate-300" : "text-slate-600"}`;

  async function submit(e) {
    e?.preventDefault?.();
    if (busy) return;
    if (!title.trim()) { setError("Give the meeting a title"); return; }
    if (!effRoom) { setError("Pick a meeting room"); return; }
    const start = new Date(`${date}T${time}`);
    if (Number.isNaN(start.getTime())) { setError("Pick a valid date and time"); return; }
    const end = new Date(start.getTime() + duration * 60 * 1000);
    const emails = externalEmails.split(",").map((s) => s.trim()).filter(Boolean);

    setBusy(true); setError("");
    let googleEventId = meeting?.google_event_id || null;
    let googleHtmlLink = meeting?.google_html_link || null;
    if (addToCalendar && hasGoogle) {
      if (googleEventId) {
        // Existing event — patch it in place.
        await updateCalendarEvent(googleEventId, { start, end, summary: title.trim(), description: description.trim() });
      } else {
        const ev = await createCalendarEvent({
          summary: title.trim(), description: description.trim() || undefined,
          start, end, attendees: emails, location: effRoom?.name,
        });
        // ev is null if the token needed re-consent (a redirect is under way).
        if (!ev) { setBusy(false); return; }
        googleEventId = ev.id;
        googleHtmlLink = ev.htmlLink;
      }
    }

    const payload = {
      room_id: effRoom.id,
      title: title.trim(),
      description: description.trim() || null,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      auto_record: autoRecord,
      priority,
      attendee_ids: [...attendeeIds],
      attendee_emails: emails,
      google_event_id: googleEventId,
      google_html_link: googleHtmlLink,
    };
    const { error: saveErr } = editing
      ? await updateScheduledMeeting(meeting.id, payload)
      : await createScheduledMeeting({ ...payload, team_id: teamId, created_by: session.user.id });
    setBusy(false);
    if (saveErr) { setError(saveErr.message || "Could not save the meeting"); return; }
    onCreated?.();
    onClose?.();
  }

  async function remove() {
    if (!editing || busy) return;
    setBusy(true);
    if (meeting.google_event_id) await deleteCalendarEvent(meeting.google_event_id);
    const { error: delErr } = await deleteScheduledMeeting(meeting.id);
    setBusy(false);
    if (delErr) { setError(delErr.message || "Could not delete the meeting"); return; }
    (onDeleted || onCreated)?.();
    onClose?.();
  }

  return (
    <Modal open onClose={onClose} labelledBy="schedule-meeting-title">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-md flex flex-col overflow-hidden rounded-2xl border shadow-xl max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2rem)] ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}
      >
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          {/* Sticky header — always visible so the dialog reads clearly. */}
          <div className={`shrink-0 flex items-center justify-between gap-2 px-5 py-4 border-b ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
            <h2 id="schedule-meeting-title" className={`flex items-center gap-2 text-base font-bold ${dark ? "text-slate-100" : "text-slate-900"}`}>
              <CalendarPlus className="w-4 h-4 text-[var(--color-accent)]" /> {editing ? "Edit meeting" : "Schedule a meeting"}
            </h2>
            <button type="button" onClick={onClose} aria-label="Close" className={`p-1.5 rounded-lg ${dark ? "text-slate-400 hover:text-slate-200 hover:bg-white/5" : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"}`}>
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Scrollable body — the form fields grow here, never clipping the
              header/footer on short or mobile viewports. */}
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {!room && (
            <div>
              <label className={labelCls}>Room</label>
              {roomOptions.length ? (
                <select value={roomId} onChange={(e) => setRoomId(e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-sm ${field}`}>
                  {roomOptions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              ) : (
                <p className={`text-xs ${dark ? "text-slate-400" : "text-slate-500"}`}>No rooms yet — create one in the office first.</p>
              )}
            </div>
          )}
          <div>
            <label className={labelCls}>Title</label>
            <EmojiTextField value={title} onChange={(e) => setTitle(e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-sm ${field}`} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-sm ${field}`} />
            </div>
            <div>
              <label className={labelCls}>Time</label>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`w-full rounded-lg border px-3 py-2 text-sm ${field}`} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Duration</label>
            <div className="flex flex-wrap gap-1.5">
              {(DURATIONS.includes(duration) ? DURATIONS : [...DURATIONS, duration].sort((a, b) => a - b)).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDuration(d)}
                  aria-pressed={duration === d}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    duration === d
                      ? "bg-[var(--color-accent)] border-transparent text-white"
                      : dark ? "border-[var(--color-border)] text-slate-300 hover:bg-white/5" : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {fmtDur(d)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className={labelCls}>Attendees</label>
            <div className={`rounded-lg border max-h-32 overflow-y-auto ${field}`}>
              {otherMembers.length === 0 ? (
                <p className="px-3 py-2 text-xs opacity-60">No teammates to invite.</p>
              ) : (
                <>
                  <label className={`flex items-center gap-2 px-3 py-1.5 text-sm border-b ${dark ? "border-white/5" : "border-slate-100"}`}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-[var(--color-accent)]" />
                    Everyone ({otherMembers.length})
                  </label>
                  {otherMembers.map((m) => (
                    <label key={m.user_id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      <input type="checkbox" checked={attendeeIds.has(m.user_id)} onChange={() => toggleAttendee(m.user_id)} className="accent-[var(--color-accent)]" />
                      <span className="truncate">{memberName(m)}</span>
                      {memberProfiles[m.user_id]?.timezone && (
                        <span className="ml-auto text-[10px] opacity-50 shrink-0">{memberProfiles[m.user_id].timezone.split("/").pop().replace("_", " ")}</span>
                      )}
                    </label>
                  ))}
                </>
              )}
            </div>
            <input
              value={externalEmails}
              onChange={(e) => setExternalEmails(e.target.value)}
              placeholder="External guest emails (comma-separated)"
              className={`w-full rounded-lg border px-3 py-2 text-sm mt-2 ${field}`}
            />
            {startPreview && (
              <div className="mt-2">
                <MeetingTimezones start={startPreview} attendeeZones={attendeeZones} dark={dark} fieldCls={field} />
              </div>
            )}
          </div>
          <div>
            <label className={labelCls}>Notes (optional)</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={`w-full rounded-lg border px-3 py-2 text-sm ${field}`} />
          </div>

          <div>
            <label className={labelCls}>Priority</label>
            <div className="flex gap-1.5">
              {[[0, "Low"], [1, "Normal"], [2, "High"]].map(([v, lbl]) => (
                <button key={v} type="button" onClick={() => setPriority(v)} aria-pressed={priority === v}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    priority === v
                      ? "bg-[var(--color-accent)] border-transparent text-white"
                      : dark ? "border-[var(--color-border)] text-slate-300 hover:bg-white/5" : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <label className={`flex items-center gap-2 text-sm ${dark ? "text-slate-300" : "text-slate-700"}`}>
            <input type="checkbox" checked={autoRecord} onChange={(e) => setAutoRecord(e.target.checked)} className="accent-[var(--color-accent)]" />
            Record & summarize this meeting
          </label>
          <label className={`flex items-center gap-2 text-sm ${hasGoogle ? "" : "opacity-50"} ${dark ? "text-slate-300" : "text-slate-700"}`}>
            <input type="checkbox" checked={addToCalendar} disabled={!hasGoogle} onChange={(e) => setAddToCalendar(e.target.checked)} className="accent-[var(--color-accent)]" />
            Add to my Google Calendar {hasGoogle ? "" : "(connect Google in Settings)"}
          </label>

          </div>

          {/* Sticky footer — primary actions stay pinned and reachable. */}
          <div className={`shrink-0 border-t px-5 py-3 space-y-2 ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
            {error && <p className={`text-xs font-medium ${dark ? "text-red-400" : "text-red-600"}`}>{error}</p>}
            <div className="flex items-center justify-between gap-2">
              {editing ? (
                <Button type="button" variant="ghost" onClick={remove} disabled={busy} className={dark ? "text-red-400" : "text-red-600"}>
                  <Trash2 className="w-4 h-4 mr-1.5" /> Delete
                </Button>
              ) : <span />}
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                <Button type="submit" disabled={busy}>
                  {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <CalendarPlus className="w-4 h-4 mr-1.5" />}
                  {editing ? "Save changes" : "Schedule"}
                </Button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </Modal>
  );
}
