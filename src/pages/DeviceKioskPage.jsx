import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, DoorOpen, Power, Moon, CalendarClock, Lock, LockOpen, LayoutTemplate, Trash2 } from "lucide-react";
import { supabase } from "../supabase";
import { markIntentionalSignOut } from "../lib/sessionRecovery";
import { applyAccent } from "../lib/accent";
import { playNotify, uiSoundsEnabled } from "../lib/uiSounds";
import { currentDeviceRoom, setDeviceRoom, currentDeviceSleep, deviceSetSleep } from "../lib/orgDevices";
import { isAsleep, nextWakeAt, nextSleepAt, clockLabel } from "../lib/deviceSchedule";
import LogoMark from "../components/LogoMark";
import RoomLayout from "../components/office/roomLayout/RoomLayout";
import LayoutBar from "../components/office/roomLayout/LayoutBar";
import { useRoomLayout } from "../components/office/roomLayout/useRoomLayout";
import { DEVICE_PANELS, DEVICE_PANEL_IDS } from "../components/office/roomLayout/devicePanels";
import { DEVICE_PRESETS, DEVICE_DEFAULT_PRESET } from "../components/office/roomLayout/devicePresets";
import { panelsIn } from "../components/office/roomLayout/layoutTree";
import { useRoomCallPresence } from "../components/video/useRoomCallPresence";
import { useAnnounceDisplay } from "../hooks/useOfficeDisplays";

// Self-ticking wall clock — its own component so the per-second tick re-renders
// only this, not the whole kiosk (which would churn the video/whiteboard panels).
function WallClock() {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="text-right leading-none">
      <div className="text-xl font-bold tabular-nums text-white/95" style={{ fontFamily: "'Parkinsans', sans-serif" }}>
        {clock.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-white/55 mt-0.5">
        {clock.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}
      </div>
    </div>
  );
}

// Page-level imminent-meeting alert. A wall display's edge over a personal
// notification: the whole room gets nudged at once. Shows a prominent banner
// while the room's next meeting is inside the lead window (until a beat after it
// starts) and chimes as it crosses the 5-min / 1-min / start marks so a
// heads-down room looks up. The chime reuses the app's notification cue (which
// auto-unlocks on the first pointer/keydown — a paired display gets that at
// pairing / tap-to-wake) and honours the per-device UI-sound toggle. Crossing
// detection (prev vs now) fires each mark exactly once and never retro-fires a
// mark already past when the kiosk mounts.
const MEETING_CHIME_MARKS = [5, 1, 0]; // minutes before start
const BANNER_LEAD_MIN = 10; // show the banner this far ahead
const BANNER_TRAIL_MIN = 2; // keep it up this long after start

function minsUntil(iso, nowMs) {
  return (new Date(iso).getTime() - nowMs) / 60000;
}

function MeetingAlert({ meetings }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const prevRef = useRef(new Map()); // meetingId -> last minutes-until (for crossings)
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const upcoming = useMemo(
    () => (meetings || [])
      .filter((m) => new Date(m.ends_at).getTime() > nowMs)
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()),
    [meetings, nowMs],
  );

  // Chime on threshold crossings since the last tick (seed on first sight → no
  // chime for a meeting already mid-window when the kiosk loads).
  useEffect(() => {
    const soundsOn = uiSoundsEnabled();
    for (const m of upcoming) {
      const mu = minsUntil(m.starts_at, nowMs);
      const prev = prevRef.current.get(m.id);
      if (soundsOn && prev != null) {
        for (const mark of MEETING_CHIME_MARKS) {
          if (prev > mark && mu <= mark) { playNotify(); break; }
        }
      }
      prevRef.current.set(m.id, mu);
    }
  }, [nowMs, upcoming]);

  const banner = upcoming.find((m) => {
    const mu = minsUntil(m.starts_at, nowMs);
    return mu <= BANNER_LEAD_MIN && mu >= -BANNER_TRAIL_MIN;
  });
  if (!banner) return null;
  const mu = minsUntil(banner.starts_at, nowMs);
  const label = mu <= 0 ? "Starting now" : mu < 1 ? "Starting in under a minute" : `Starting in ${Math.round(mu)} min`;
  const urgent = mu <= 1;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
      <div
        className={`flex items-center gap-3 rounded-2xl px-5 py-3 shadow-2xl ring-1 backdrop-blur bg-slate-900/85 ${
          urgent ? "ring-[var(--color-accent)] animate-pulse" : "ring-white/15"
        }`}
      >
        <span
          className="shrink-0 grid place-items-center w-9 h-9 rounded-full text-slate-900"
          style={{ background: "var(--color-accent)" }}
        >
          <CalendarClock className="w-5 h-5" />
        </span>
        <span className="flex flex-col leading-tight min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--color-accent)" }}>
            {label}
          </span>
          <span className="text-[15px] font-semibold text-white truncate max-w-[46vw]">{banner.title || "Meeting"}</span>
        </span>
      </div>
    </div>
  );
}

// Save / apply / delete named layouts (per-device). Save the current arrangement
// under a name, then switch between them — useful for a kiosk that shows
// different things at different times (a "meeting" layout vs an "ambient" one).
function LayoutsMenu({ layouts, onApply, onSave, onDelete }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const save = () => { const n = name.trim(); if (!n) return; onSave(n); setName(""); };
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Saved layouts"
        className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-full bg-white/10 hover:bg-white/15 text-[12px] font-semibold text-white/80 transition-colors"
      >
        <LayoutTemplate className="w-3.5 h-3.5" /> <span className="hidden lg:inline">Layouts</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-40 w-60 p-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
            <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/45">Saved layouts</div>
            {layouts.length === 0 ? (
              <p className="px-1 py-1 text-[12px] text-white/40">None saved yet.</p>
            ) : (
              <ul className="mb-1">
                {layouts.map((n) => (
                  <li key={n} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => { onApply(n); setOpen(false); }}
                      className="flex-1 min-w-0 text-left px-2 py-1.5 rounded-lg text-[12px] text-white/85 hover:bg-white/10 truncate"
                    >
                      {n}
                    </button>
                    <button type="button" onClick={() => onDelete(n)} title={`Delete "${n}"`} className="p-1 rounded text-white/30 hover:text-rose-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="h-px bg-white/10 my-1" />
            <form onSubmit={(e) => { e.preventDefault(); save(); }} className="flex items-center gap-1.5 px-1 pt-1">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Save current as…"
                className="flex-1 min-w-0 rounded-md bg-white/10 px-2 py-1.5 text-[12px] text-white outline-none placeholder:text-white/35"
              />
              <button type="submit" disabled={!name.trim()} className="px-2 py-1.5 rounded-md text-[12px] font-semibold text-white disabled:opacity-40" style={{ background: "var(--color-accent)" }}>
                Save
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

// Room switcher for a MOVABLE device — switch which room this kiosk shows.
// `rooms` comes from RLS: a movable device reads all its org's rooms, a fixed
// one reads only its pinned room, so if there's nothing else to switch to we
// render nothing (non-movable devices never see a switcher).
function RoomSwitcher({ currentRoomId, currentName, rooms, onSwitch }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = (rooms || []).filter((r) => r.id !== currentRoomId);
  if (others.length === 0) return null;
  const pick = async (id) => {
    setBusy(true);
    await onSwitch(id);
    setBusy(false);
    setOpen(false);
  };
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-full bg-white/10 hover:bg-white/15 text-[12px] font-semibold text-white/90 transition-colors disabled:opacity-50"
        title="Switch this device to another room"
      >
        <DoorOpen className="w-3.5 h-3.5" />
        <span className="max-w-[140px] truncate">{currentName || "Room"}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-40 w-56 max-h-[60vh] overflow-auto p-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
            <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/50">Move this device to…</div>
            {others.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => pick(r.id)}
                className="w-full text-left px-2.5 py-1.5 rounded-lg text-[12px] text-white/85 hover:bg-white/10"
              >
                {r.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Sleep screen — shown when the kiosk is off the clock (outside its scheduled
// hours, or manually put offline). The call + polling are torn down (the main
// content unmounts), so it's just a dim wall clock. Tap anywhere to wake.
function SleepScreen({ roomName, backAt, onWake }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);
  return (
    <button
      type="button"
      onClick={onWake}
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-3 bg-black text-white select-none"
    >
      <div className="text-7xl font-bold tabular-nums text-white/25" style={{ fontFamily: "'Parkinsans', sans-serif" }}>
        {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </div>
      <div className="flex items-center gap-2 text-white/40">
        <Moon className="w-4 h-4" />
        <span className="text-sm">{roomName} · offline{backAt ? ` until ${backAt}` : ""}</span>
      </div>
      <div className="mt-4 text-[11px] uppercase tracking-[0.2em] text-white/25">Tap to wake</div>
    </button>
  );
}

// Paired-device kiosk. Now a configurable room display: the same modular BSP
// layout members use (RoomLayout + useRoomLayout) but with the DEVICE panel set
// (portal video, read-only chat, embedded whiteboard, timer, presence) and
// device-local persistence. You can't leave the room — there's no leave; you
// arrange panels and unpair. Read-only throughout (device RLS is SELECT-only).
export default function DeviceKioskPage({ session }) {
  const meta = session?.user?.user_metadata || {};
  const deviceName = meta.name || "Device";
  const userId = session?.user?.id || null;

  // Live pinned room (authoritative — survives a room switch, unlike the JWT's
  // user_metadata.room_id). Seed from the JWT for a fast first paint, confirm via
  // current_device_room().
  const [roomId, setRoomId] = useState(meta.room_id || null);
  const [room, setRoom] = useState(null);
  const [sess, setSess] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [presenceById, setPresenceById] = useState(() => new Map()); // room occupants' live status
  const [meetings, setMeetings] = useState([]); // this room's upcoming scheduled meetings
  const [roster, setRoster] = useState([]); // whole-org roster (identity + status + location)
  const [rooms, setRooms] = useState([]); // org rooms readable here (>1 ⇒ movable)
  // Locked = presentation mode: hide the per-panel top bars + arranging controls
  // for a clean wall display. Persisted so a paired kiosk stays locked.
  const [locked, setLocked] = useState(() => {
    try { return localStorage.getItem("ql_device_locked") === "1"; } catch { return false; }
  });
  const toggleLocked = () => setLocked((v) => {
    const next = !v;
    try { localStorage.setItem("ql_device_locked", next ? "1" : "0"); } catch { /* */ }
    return next;
  });

  // Sleep schedule + manual override. `asleep` is re-derived on a tick so the
  // kiosk auto-sleeps/wakes at the schedule boundaries without a reload. Until
  // the first fetch lands we don't know the schedule, so treat that as asleep —
  // better to hold the call/polling off for a beat than to mount the full portal
  // for a device that should already be off the clock.
  const [sched, setSched] = useState(null);
  const [schedLoaded, setSchedLoaded] = useState(false);
  const [, setSleepTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data } = await currentDeviceSleep();
      if (!alive) return;
      setSched(data);
      setSchedLoaded(true);
    };
    load();
    const poll = setInterval(load, 60000); // pick up admin schedule edits; keeps ticking while asleep
    return () => { alive = false; clearInterval(poll); };
  }, []);
  useEffect(() => {
    const id = setInterval(() => setSleepTick((n) => (n + 1) % 1e9), 30000);
    return () => clearInterval(id);
  }, []);
  // Hold the portal off until the schedule is known: a device that should be
  // asleep would otherwise mount the call + subscriptions for the fetch window.
  const asleep = !schedLoaded || isAsleep(sched);

  // Broadcast this display's presence on the room's call-presence channel so a
  // member sees "Room display on" in the pre-join, before joining — the kiosk
  // publishes to LiveKit but was otherwise invisible until you joined. Only while
  // awake (roomId → null when asleep drops it from presence). Marked isDevice so
  // it's surfaced separately and never counted as a person "in call".
  // The kiosk stays ON the call-presence channel while awake (so the pre-join /
  // hallway badges see "Room display on"), but only CONNECTS the LiveKit media
  // when a human is actually in the call — no publishing camera/mic 24/7.
  const callPresence = useRoomCallPresence({
    roomId: asleep ? null : roomId,
    userId,
    displayName: `${room?.name || deviceName} display`,
    mode: "join",
    isDevice: true,
  });
  // isAnyoneInCall is humans-only (excludes this device). Linger ~20s after the
  // last person leaves before disconnecting, so a brief drop/rejoin doesn't churn
  // the LiveKit connection (which LiveKit Cloud rate-limits).
  const rawInCall = callPresence.isAnyoneInCall;
  const [someoneInCall, setSomeoneInCall] = useState(false);
  useEffect(() => {
    if (rawInCall) { setSomeoneInCall(true); return undefined; }
    const t = setTimeout(() => setSomeoneInCall(false), 20000);
    return () => clearTimeout(t);
  }, [rawInCall]);

  // Announce this display org-wide (rooms.team_id == the device's org) so the
  // hallway floor plan can badge which rooms have a live display — one shared
  // channel, no per-room subscriptions. Only while awake.
  useAnnounceDisplay({
    orgId: room?.team_id,
    roomId,
    deviceKey: userId,
    enabled: !asleep,
  });

  const goOffline = async () => {
    const until = nextWakeAt(sched);
    setSched((s) => ({ ...(s || {}), asleep_until: until.toISOString(), awake_until: null }));
    await deviceSetSleep(until, null);
  };
  const wake = async () => {
    const until = nextSleepAt(sched);
    setSched((s) => ({ ...(s || {}), awake_until: until.toISOString(), asleep_until: null }));
    await deviceSetSleep(null, until);
  };

  // Confirm the live room + load switch targets, and re-poll so an admin's
  // remote reassign is picked up. RLS does the gating: a fixed device only ever
  // sees its one room here, so RoomSwitcher renders nothing for it.
  useEffect(() => {
    let alive = true;
    const sync = async () => {
      const { data: live } = await currentDeviceRoom();
      if (alive && live) setRoomId(live);
      const { data: rs } = await supabase.from("rooms").select("id, name").order("name");
      if (alive) setRooms(rs || []);
    };
    sync();
    const poll = setInterval(sync, 20000);
    return () => { alive = false; clearInterval(poll); };
  }, []);

  const handleSwitch = async (newRoomId) => {
    const { error } = await setDeviceRoom(newRoomId);
    if (!error) setRoomId(newRoomId); // re-points session query, layout key, portal
  };

  // Kiosk is always dark with the default accent (no member theme to inherit).
  useEffect(() => {
    document.documentElement.classList.add("dark");
    applyAccent("teal", true);
    return () => document.documentElement.classList.remove("dark");
  }, []);

  // Room + active session (incl. its linked whiteboard) + participants, kept
  // live by realtime; RLS scopes everything to this device's pinned room.
  useEffect(() => {
    if (!roomId) return undefined;
    let alive = true;

    supabase.from("rooms").select("id, name, team_id").eq("id", roomId).maybeSingle()
      .then(({ data }) => { if (alive) setRoom(data); });

    // Asleep → don't subscribe or poll the session (and the call is unmounted
    // below). We still loaded the room name above so the sleep screen can show it.
    if (asleep) return () => { alive = false; };

    const loadSession = async () => {
      const { data } = await supabase
        .from("sync_sessions")
        .select("id, mode, is_running, remaining_seconds, ends_at, status, whiteboard_id")
        .eq("room_id", roomId)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!alive) return;
      setSess(data || null);
      if (data) {
        const { data: parts } = await supabase
          .from("sync_session_participants")
          .select("user_id, display_name, avatar_url, joined_at")
          .eq("session_id", data.id)
          .is("left_at", null)
          .order("joined_at", { ascending: true });
        if (alive) setParticipants(parts || []);
      } else {
        setParticipants([]);
      }
    };

    // Live status for the room's occupants. RLS ("device reads its room
    // presence") scopes this to users whose location_room_id is this device's
    // room, so an unfiltered select returns exactly the room's people — merged
    // by user_id into the "Who's here" roster. A full refetch on any change
    // reconciles arrivals/departures (a "left" update re-points location away
    // and RLS then hides it, so we lean on the refetch + poll, not the event).
    const loadPresence = async () => {
      const { data } = await supabase
        .from("user_presence")
        .select("user_id, availability, activity_label, activity_private, override_availability, override_expires_at, invisible");
      if (!alive) return;
      const m = new Map();
      for (const row of data || []) m.set(row.user_id, row);
      setPresenceById(m);
    };

    // This room's upcoming meetings (RLS "device reads its room meetings" scopes
    // to room_id = the device's room). Include ones that started up to 30 min ago
    // so an in-progress meeting still shows; drop long-past rows.
    const loadMeetings = async () => {
      const since = new Date(Date.now() - 30 * 60000).toISOString();
      const { data } = await supabase
        .from("scheduled_meetings")
        .select("id, title, starts_at, ends_at, room_id")
        .eq("room_id", roomId)
        .gte("starts_at", since)
        .order("starts_at", { ascending: true })
        .limit(8);
      if (alive) setMeetings(data || []);
    };

    // Whole-org roster (everyone's identity + status + location) via the
    // device_team_roster RPC. Org-wide presence isn't RLS-subscribable for a
    // device, so this is poll-only (the RPC bypasses RLS server-side).
    const loadRoster = async () => {
      const { data } = await supabase.rpc("device_team_roster");
      if (alive) setRoster(data || []);
    };

    loadSession();
    loadPresence();
    loadMeetings();
    loadRoster();

    const ch = supabase
      .channel(`kiosk:${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "sync_sessions", filter: `room_id=eq.${roomId}` }, loadSession)
      .on("postgres_changes", { event: "*", schema: "public", table: "sync_session_participants" }, loadSession)
      .on("postgres_changes", { event: "*", schema: "public", table: "user_presence", filter: `location_room_id=eq.${roomId}` }, loadPresence)
      .on("postgres_changes", { event: "*", schema: "public", table: "scheduled_meetings", filter: `room_id=eq.${roomId}` }, loadMeetings)
      .subscribe();
    const poll = setInterval(() => { loadSession(); loadPresence(); loadMeetings(); loadRoster(); }, 30000); // self-heal if a realtime event is missed
    return () => { alive = false; supabase.removeChannel(ch); clearInterval(poll); };
  }, [roomId, asleep]);

  // Device-local modular layout (own preset set + storage key prefix).
  const { tree, presetId, applyPreset, reset, setRatio, movePanel, addPanelAt, moveToRoot, addAtRoot, closePanel, togglePanel,
    savedLayouts, saveLayout, applyLayout, deleteLayout } =
    useRoomLayout(roomId, DEVICE_PANEL_IDS, {
      presets: DEVICE_PRESETS,
      defaultPreset: DEVICE_DEFAULT_PRESET,
      keyPrefix: "ql_device_layout",
    });

  const activePanels = panelsIn(tree);
  // Every panel type, for the "Add to view" menu (rooms-style) — replaces the
  // old quick-toggle buttons.
  const addPanels = DEVICE_PANEL_IDS.map((id) => ({ id, title: DEVICE_PANELS[id].title, Icon: DEVICE_PANELS[id].icon }));

  // Memoized so the per-second WallClock tick (separate component) never churns
  // the layout — ctx identity changes only on real room/session/participant data.
  const ctx = useMemo(() => ({
    room: room || { id: roomId },
    userId,
    displayName: `${room?.name || deviceName} · Portal`,
    dark: true,
    sess,
    participants,
    presenceById,
    meetings,
    roster,
    currentRoomId: roomId,
    someoneInCall,
    whiteboardId: sess?.whiteboard_id || null,
  }), [room, roomId, userId, deviceName, sess, participants, presenceById, meetings, roster, someoneInCall]);

  const unpair = async () => { markIntentionalSignOut(); await supabase.auth.signOut(); };

  if (!roomId) {
    return (
      <main className="min-h-[100dvh] flex items-center justify-center bg-[var(--color-bg)] text-slate-300">
        <div className="text-center">
          <p className="text-lg font-semibold">{deviceName}</p>
          <p className="mt-2 text-slate-500">This device isn't paired to a room.</p>
        </div>
      </main>
    );
  }

  if (asleep) {
    if (!schedLoaded) {
      // Schedule still loading — don't mount the portal OR the interactive sleep
      // screen (no "Tap to wake" until we actually know the device's hours).
      return (
        <main className="min-h-[100dvh] flex items-center justify-center bg-black text-white/40 select-none">
          <div className="text-sm">{deviceName}</div>
        </main>
      );
    }
    const back = sched?.asleep_until ? new Date(sched.asleep_until) : nextWakeAt(sched);
    return <SleepScreen roomName={room?.name || deviceName} backAt={clockLabel(back)} onWake={wake} />;
  }

  return (
    <main className="relative h-[100dvh] flex flex-col bg-[var(--color-bg)] text-slate-100 overflow-hidden select-none">
      <header className="shrink-0 flex items-center justify-between gap-3 px-5 py-2.5 border-b border-[var(--color-border)]">
        <span className="inline-flex items-center gap-2.5 min-w-0">
          <span className="text-[var(--color-accent)] shrink-0"><LogoMark size={24} /></span>
          <span className="text-lg font-semibold text-white/95 truncate">{room?.name || deviceName}</span>
          {participants.length > 0 && (
            <span className="ml-1 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs text-white/85 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> {participants.length} here
            </span>
          )}
        </span>
        <div className="flex items-center gap-3 shrink-0">
          {!locked && <RoomSwitcher currentRoomId={roomId} currentName={room?.name} rooms={rooms} onSwitch={handleSwitch} />}
          {/* Arranging controls only while UNLOCKED: an "Add to view" menu
              (rooms-style) instead of the old quick-toggle buttons; drag a
              panel's header to move it. */}
          {!locked && (
            <LayoutBar
              addMenu
              addPanels={addPanels}
              activePanels={activePanels}
              onTogglePanel={togglePanel}
              onReset={reset}
              accent="var(--color-accent)"
              dark
            />
          )}
          {!locked && (
            <LayoutsMenu layouts={savedLayouts} onApply={applyLayout} onSave={saveLayout} onDelete={deleteLayout} />
          )}
          <button
            type="button"
            onClick={toggleLocked}
            title={locked ? "Unlock the layout (show panel bars + controls)" : "Lock the layout (hide panel bars for a clean display)"}
            aria-pressed={locked}
            className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-full bg-white/10 hover:bg-white/15 text-[12px] font-semibold text-white/80 transition-colors"
          >
            {locked ? <LockOpen className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
            <span className="hidden lg:inline">{locked ? "Unlock" : "Lock"}</span>
          </button>
          <WallClock />
          <button
            type="button"
            onClick={goOffline}
            title="Put this display offline (ends the call until it wakes on schedule or you tap it)"
            className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-full bg-white/10 hover:bg-white/15 text-[12px] font-semibold text-white/80 transition-colors"
          >
            <Power className="w-3.5 h-3.5" /> Go offline
          </button>
          <button type="button" onClick={unpair} className="text-[11px] text-white/45 hover:text-white/80 transition-colors">
            Unpair
          </button>
        </div>
      </header>

      <MeetingAlert meetings={meetings} />

      <div className="flex-1 min-h-0 p-3 overflow-hidden">
        <RoomLayout
          tree={tree}
          ctx={ctx}
          panels={DEVICE_PANELS}
          dark
          locked={locked}
          onRatioChange={setRatio}
          onMove={movePanel}
          onAddAt={addPanelAt}
          onMoveToRoot={moveToRoot}
          onAddAtRoot={addAtRoot}
          onClose={closePanel}
        />
      </div>
    </main>
  );
}
