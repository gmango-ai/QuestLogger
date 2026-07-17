import { useEffect, useMemo, useRef, useState } from "react";
import { Clock, AlarmClock, Plus } from "lucide-react";
import { supabase } from "../../supabase";
import { extendRoomSession } from "../../lib/syncSession";

// How long before auto-close we escalate from a quiet chip to a loud "wrap up
// or extend" warning.
const WARN_SECONDS = 120;
// How much a single "Extend" tap buys.
const EXTEND_MINUTES = 15;

// Countdown for meeting-room sessions. Reads expires_at off the session row and
// ticks once a second. Two jobs beyond just showing the clock:
//   • when time is nearly up it turns into a loud warning with an Extend button
//     so the meeting doesn't drop out from under everyone without notice;
//   • when the clock hits zero it asks the server to sweep — the realtime end
//     then drops every participant out of the room.
export default function MeetingCountdown({ expiresAt, sessionId, dark }) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  // Optimistic expiry from a just-succeeded extend, so the countdown jumps
  // forward immediately instead of waiting for the realtime round-trip. We take
  // whichever of prop / optimistic is later, so it never rewinds.
  const [extendedTo, setExtendedTo] = useState(null);
  const sweptRef = useRef(false);

  const effectiveExpiry = useMemo(() => {
    const a = expiresAt ? new Date(expiresAt).getTime() : NaN;
    const b = extendedTo ? new Date(extendedTo).getTime() : NaN;
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.max(a, b);
    if (Number.isFinite(a)) return a;
    if (Number.isFinite(b)) return b;
    return NaN;
  }, [expiresAt, extendedTo]);

  useEffect(() => {
    sweptRef.current = false;
    setErr(false);
  }, [sessionId, effectiveExpiry]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = Number.isFinite(effectiveExpiry)
    ? Math.max(0, Math.ceil((effectiveExpiry - now) / 1000))
    : null;

  // Once we cross zero, fire the server-side sweep exactly once. Has to be in
  // an effect, not during render — and not chained as `.catch`, because
  // Supabase's PostgrestBuilder is thenable but not a real Promise.
  useEffect(() => {
    if (remaining !== 0 || sweptRef.current) return;
    sweptRef.current = true;
    (async () => {
      try { await supabase.rpc("sweep_expired_sync_sessions"); } catch { /* */ }
    })();
  }, [remaining]);

  async function handleExtend() {
    if (busy || !sessionId) return;
    setBusy(true);
    setErr(false);
    const { data, error } = await extendRoomSession(sessionId, EXTEND_MINUTES);
    setBusy(false);
    if (error) { setErr(true); return; }
    if (data?.expires_at) setExtendedTo(data.expires_at);
  }

  if (remaining == null) return null;

  const hh = Math.floor(remaining / 3600);
  const mm = Math.floor((remaining % 3600) / 60);
  const ss = remaining % 60;
  const label = hh > 0
    ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${mm}:${String(ss).padStart(2, "0")}`;

  const ended = remaining === 0;
  const warning = remaining > 0 && remaining <= WARN_SECONDS;

  // Closing — the sweep is (about to be) firing; nothing to extend anymore.
  if (ended) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${
          dark ? "bg-red-500/15 text-red-300" : "bg-red-50 text-red-600"
        }`}
        title="Room closing…"
      >
        <Clock className="w-3 h-3 opacity-80" />
        Closing…
      </span>
    );
  }

  // Wrap-up warning — loud, with a one-tap extend.
  if (warning) {
    return (
      <div
        role="status"
        className={`inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold px-2 py-1 rounded-lg border ${
          dark
            ? "bg-amber-500/15 text-amber-200 border-amber-500/30"
            : "bg-amber-50 text-amber-800 border-amber-200"
        }`}
        title="This meeting is about to auto-close — wrap up or extend it."
      >
        <span className="inline-flex items-center gap-1">
          <AlarmClock className="w-3.5 h-3.5 animate-pulse" />
          Ends in <span className="font-mono tabular-nums">{label}</span>
        </span>
        <button
          type="button"
          onClick={handleExtend}
          disabled={busy}
          className={`shrink-0 inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md text-[11px] font-bold transition-colors disabled:opacity-60 ${
            dark ? "bg-amber-500/25 text-amber-100 hover:bg-amber-500/40" : "bg-amber-600 text-white hover:bg-amber-700"
          }`}
        >
          <Plus className="w-3 h-3" />
          {busy ? "Extending…" : `${EXTEND_MINUTES} min`}
        </button>
        {err && (
          <span className={dark ? "text-red-300" : "text-red-600"}>Couldn’t extend</span>
        )}
      </div>
    );
  }

  // Plenty of time left — quiet chip.
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${
        dark ? "bg-[var(--color-surface-raised)] text-slate-300" : "bg-slate-100 text-slate-600"
      }`}
      title="Time left before the room closes"
    >
      <Clock className="w-3 h-3 opacity-80" />
      {label}
    </span>
  );
}
