import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTheme } from "../../context/ThemeContext";
import { useApp } from "../../context/AppContext";
import { useSyncSession } from "../../context/SyncSessionContext";
import { useVideoCall } from "../../context/VideoCallContext";
import { Button } from "@/components/ui/button";
import { Menu, Lock, Bell, Loader2 } from "lucide-react";
import { supabase } from "../../supabase";
import { requestRoomEntry } from "../../lib/rooms";
import { useBodyScrollLock } from "../../hooks/useBodyScrollLock";
import { useWidgetDrawer } from "../../context/WidgetDrawerContext";
import RoomView from "./RoomView";
import HallwayView from "./HallwayView";
import OfficeOverlay from "./OfficeOverlay";

const LAST_ROOM_KEY = "ql_office_last_room";

function lastRoomFor(teamId) {
  if (!teamId) return null;
  try {
    const raw = localStorage.getItem(LAST_ROOM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.[teamId] || null;
  } catch { return null; }
}

function rememberRoomFor(teamId, roomId) {
  if (!teamId || !roomId) return;
  try {
    const raw = localStorage.getItem(LAST_ROOM_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    parsed[teamId] = roomId;
    localStorage.setItem(LAST_ROOM_KEY, JSON.stringify(parsed));
  } catch { /* storage disabled */ }
}

// Top-level office layout.
//
//   Left rail   — widgets sidebar (tasks, etc.). Toggleable.
//   Main pane   — Hallway when URL is /office (no roomId), RoomView
//                 when /office/r/:roomId. No more "auto-redirect to
//                 last room"; the hallway is a real destination, not
//                 a brief in-between state.
//   Overlay     — modal triggered from the room name in RoomView's
//                 header. Switch rooms or leave to hallway.
//
// The earlier office-shell shape had the rooms list as the persistent
// left sidebar and a 3-state Map/List/Hide toggle for it. The user
// pushed back: rooms aren't something you stare at constantly, and
// the segmented control was more chrome than the decision deserved.
// Now rooms live in the on-demand overlay; the left rail is for
// utility widgets that DO need to be glance-able.
export default function OfficeShell({
  activeTeam, rooms, lockedRooms, sessionByRoomId, orgTeams,
  onlineCount, canEdit, busy, onJoin, onStart, onEnterRoom, onEditOffice,
  onEditRoom, canEditRoom,
}) {
  const { theme } = useTheme();
  const dark = theme === "dark";
  const navigate = useNavigate();
  const { session } = useApp();
  const currentUserId = session?.user?.id;
  const { roomId } = useParams();
  const [overlayOpen, setOverlayOpen] = useState(false);
  // The widgets rail is gone — widgets now live in the app-wide slide-over
  // drawer (shared context). The in-room toggle just opens/closes it.
  const { toggle: toggleWidgets } = useWidgetDrawer();

  // Resolve the active room from URL. We deliberately do NOT auto-
  // redirect when the URL is bare /office — that path now lands the
  // user in the hallway. /office/r/:id stays in that room.
  //
  // Look the room up across BOTH visible and locked (department-gated) rooms:
  // a dept-locked room can't be entered, but we still resolve it so the shell
  // can render the knock gate instead of bouncing to the hallway.
  const allRooms = [...(rooms || []), ...(lockedRooms || [])];
  const resolvedRoomId = (roomId && allRooms.some((r) => r.id === roomId)) ? roomId : null;
  const selectedRoom = resolvedRoomId ? allRooms.find((r) => r.id === resolvedRoomId) : null;
  const activeSession = selectedRoom ? (sessionByRoomId?.get(selectedRoom.id) || null) : null;

  // Only pin the page while we're INSIDE a room — that layout is a fixed
  // 100dvh flex shell with its own inner scroll areas. The hallway (below) is
  // a normal document-flow page that scrolls the body; locking it there makes
  // any content past the viewport unreachable.
  useBodyScrollLock(!!selectedRoom);

  // Auto-open into the room the user is already in.
  // When the user lands on bare /office and they have an active sync
  // session bound to a visible room, jump straight into that room —
  // they're "in" it from the system's POV, so showing the hallway is
  // misleading. Fires once per mount via a ref so the user can still
  // click "Hallway" to leave intentionally without being yanked back.
  const { syncSession, leaveSession } = useSyncSession();
  const { call, endCall } = useVideoCall();
  const autoOpenedRef = useRef(false);

  // Is the selected room locked FOR ME right now? A code-gated room is
  // "open until occupied": once someone is inside, anyone who isn't the
  // owner and isn't already in this room's session is held at a code gate
  // and can't even see the room until they enter the code. An empty code
  // room is open — the first person in just walks in.
  const inThisRoomSession = !!syncSession?.room_id && !!selectedRoom
    && syncSession.room_id === selectedRoom.id;
  const isRoomOwner = !!selectedRoom?.created_by && selectedRoom.created_by === currentUserId;
  // Managers (owner / org admin / gating-team lead) can always enter: the
  // server's can_enter_room admits them, so the client must NOT strand them at
  // a gate (and knocking would be rejected — they don't need to). canEditRoom
  // mirrors that exact predicate, so reuse it as the bypass.
  const canManageRoom = isRoomOwner || !!(selectedRoom && canEditRoom?.(selectedRoom));
  // Two lock kinds end at the same knock gate:
  //   • code lock — an occupied code room I'm not in / can't manage.
  //   • dept lock — a department-gated room I'm not a member of (it lives in
  //     lockedRooms). Either way I'm held until admitted or I can manage it.
  const isDeptLockedForMe = !!selectedRoom && (lockedRooms || []).some((r) => r.id === selectedRoom.id);
  const codeLocked = selectedRoom?.entry_policy === "code"
    && !!activeSession && !inThisRoomSession && !canManageRoom;
  const deptLocked = isDeptLockedForMe && !inThisRoomSession && !canManageRoom;
  const roomLocked = codeLocked || deptLocked;
  // Names of the org_teams gating a dept-locked room — shown in the gate copy.
  const gatingLabel = deptLocked
    ? (selectedRoom?.room_teams || [])
        .map((rt) => (orgTeams || []).find((t) => t.id === rt.org_team_id)?.name)
        .filter(Boolean)
        .join(", ")
    : "";

  // Explicit leave. Connection-aware model: incidental navigation never
  // leaves a room (you keep heartbeating, so you stay "in" it until your
  // last tab closes and the sweeper reaps you). Leaving is a deliberate
  // act — the room header's Leave button and the overlay's "Leave to
  // hallway" both route here, which removes the user from the session
  // (across all their tabs) and drops them in the hallway.
  const handleLeaveRoom = async () => {
    // Leaving is deliberate — tear the room's video call down too so the
    // PiP doesn't linger after you've left. (The session-bound teardown
    // in PersistentVideoCall only fires when a session was tracking the
    // room; ending here covers the call regardless.)
    if (call) endCall("user-leave-room");
    await leaveSession();
    navigate("/office");
  };
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (resolvedRoomId) {
      // Either we're already in a room URL, or the URL has a roomId
      // we don't recognize; either way, don't auto-redirect.
      autoOpenedRef.current = true;
      return;
    }
    const activeRoomId = syncSession?.room_id;
    if (!activeRoomId) return; // No session, or session not bound to a room
    const visible = (rooms || []).some((r) => r.id === activeRoomId);
    if (!visible) return; // Session for a room they can't see — leave them in the hallway
    autoOpenedRef.current = true;
    navigate(`/office/r/${activeRoomId}`, { replace: true });
  }, [resolvedRoomId, syncSession?.room_id, rooms, navigate]);

  // Persist last-visited room so we can highlight it in the hallway
  // ("you were here recently"). Doesn't change navigation behavior.
  useEffect(() => {
    if (resolvedRoomId && activeTeam?.id) rememberRoomFor(activeTeam.id, resolvedRoomId);
  }, [resolvedRoomId, activeTeam?.id]);

  // Auto-bind the user's sync session to the room they ENTER.
  //
  //   Enter a room  → if an active session exists for it, join. If not,
  //                   start one (private rooms still go through the
  //                   code prompt via onStart).
  //   Leave a room  → NOT handled here. Connection-aware model: leaving
  //                   is explicit (handleLeaveRoom) or implicit via
  //                   staleness — navigating away keeps you heartbeating,
  //                   so you stay in the room until your last tab closes
  //                   and the sweeper reaps the empty room. Switching to
  //                   another room just rebinds the session; the old
  //                   room's last_seen goes stale and drops off on its
  //                   own (read-time liveness + sweep).
  //
  // boundRoomRef de-dupes the effect across re-renders triggered by
  // sessionByRoomId / syncSession updates — we only want to act on
  // actual URL transitions, not whenever the realtime list refreshes.
  // Code-gated rooms are skipped on auto-entry for non-managers: we don't
  // want the code prompt appearing (or a live session auto-joined) just
  // because the user typed/opened a URL. They click Start/Join to enter.
  const boundRoomRef = useRef(null);
  const inFlightRef = useRef(false);
  useEffect(() => {
    const target = resolvedRoomId || null;
    const bound = boundRoomRef.current;
    if (target === bound) return;
    if (inFlightRef.current) return;

    const currentSessionRoom = syncSession?.room_id || null;

    inFlightRef.current = true;
    (async () => {
      try {
        if (target) {
          // If we're already in this room's session (cross-device
          // rehydrate landed us here), do nothing — we're aligned.
          if (currentSessionRoom !== target) {
            const active = sessionByRoomId?.get(target) || null;
            const room = (rooms || []).find((r) => r.id === target)
              || (lockedRooms || []).find((r) => r.id === target);
            const ownerOfRoom = !!room?.created_by && room.created_by === currentUserId;
            const managerOfRoom = ownerOfRoom || !!(room && canEditRoom?.(room));
            const deptLockedRoom = (lockedRooms || []).some((r) => r.id === target);
            const codeLockedOut = room?.entry_policy === "code" && !!active && !managerOfRoom;
            if (deptLockedRoom && !managerOfRoom) {
              // Department-gated room I'm not in: held at the knock gate.
              // Don't auto-join — the user knocks there to be let in.
            } else if (codeLockedOut) {
              // Occupied code room and I'm not the owner: held at the gate.
              // Don't auto-join — the render shows the lock gate and the
              // user enters the code there. (An EMPTY code room is open, so
              // it falls through and auto-starts: first one in, no code.)
            } else if (active) {
              await onJoin?.(room);
            } else if (room) {
              await onStart?.(room);
            }
          }
        }
        boundRoomRef.current = target;
      } finally {
        inFlightRef.current = false;
      }
    })();
    // We intentionally depend ONLY on the URL room id. sessionByRoomId
    // and syncSession changes are captured at fire-time via closure;
    // re-running on every realtime tick would re-trigger join cycles
    // when nothing actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedRoomId]);

  // ── HALLWAY ── contained, native app page. No widgets rail and no
  // full-bleed shell: the hallway sits in the same centered column on
  // the app's global gradient background as every other page. The rail
  // + two-pane workspace only appear once you step into a room (below).
  if (!selectedRoom) {
    return (
      <main className="max-w-[1100px] mx-auto px-4 sm:px-6 pt-6 pb-24">
        <HallwayView
          activeTeam={activeTeam}
          rooms={rooms}
          lockedRooms={lockedRooms}
          sessionByRoomId={sessionByRoomId}
          onlineCount={onlineCount}
          canEdit={canEdit}
          busy={busy}
          onEnterRoom={(id) => navigate(`/office/r/${id}`)}
          onEditOffice={onEditOffice}
        />
      </main>
    );
  }

  // ── IN A ROOM ── two-pane workspace: the widgets rail (pomodoro,
  // tasks, …) earns its place here, alongside the room's chat / video /
  // timer. This is the one surface in the app with a side rail, by design.
  //
  // Root height fills exactly below the global nav: subtract the nav bar
  // (--nav-h, which is taller on mobile where the header is two rows) and the
  // top safe-area inset. The old flat `100vh - 64px` was ~50px too tall on
  // Dynamic Island phones, which pushed the room's bottom "add panels" dock off
  // screen. env() is 0 on desktop.
  return (
    <div className={`relative flex h-[calc(100dvh-var(--nav-h)-var(--top-inset)-var(--bottom-inset))] w-full ${
      dark ? "bg-[var(--color-bg)]" : "bg-slate-50"
    }`}>
      {/* The widgets rail was retired: widgets are now the app-wide slide-over
          drawer (WidgetDrawer, mounted in App), reachable here via the room
          header's widgets toggle and the nav's widgets button. */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile header (widgets drawer toggle + room name) — only for the
            lock gate, which has no header of its own. When RoomView shows, its
            own header carries the widgets toggle + room name (no duplicate). */}
        {roomLocked && (
          <div className={`md:hidden flex items-center gap-2 px-3 py-2 border-b ${
            dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"
          }`}>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleWidgets}
              className="h-10 w-10 sm:h-8 sm:w-8"
              aria-label="Open widgets"
            >
              <Menu className="w-5 h-5 sm:w-4 sm:h-4" />
            </Button>
            <p className={`text-sm font-semibold truncate ${dark ? "text-slate-100" : "text-slate-800"}`}>
              {selectedRoom?.name || "Hallway"}
            </p>
          </div>
        )}

        {roomLocked ? (
          <RoomLockGate
            room={selectedRoom}
            busy={busy}
            dark={dark}
            codeRoom={selectedRoom?.entry_policy === "code" && !!activeSession}
            deptLocked={deptLocked}
            gatingLabel={gatingLabel}
            onEnter={(code) => onEnterRoom?.(selectedRoom, code)}
            onBack={() => navigate("/office")}
          />
        ) : (
          <RoomView
            room={selectedRoom}
            activeSession={activeSession}
            orgTeams={orgTeams}
            busy={busy}
            onJoin={() => onJoin?.(selectedRoom)}
            onStart={() => onStart?.(selectedRoom)}
            onOpenRoomSwitcher={() => setOverlayOpen(true)}
            onLeaveRoom={handleLeaveRoom}
            onEditRoom={onEditRoom}
            canEditRoom={canEditRoom?.(selectedRoom)}
          />
        )}
      </div>

      <OfficeOverlay
        open={overlayOpen}
        onClose={() => setOverlayOpen(false)}
        rooms={rooms}
        lockedRooms={lockedRooms}
        sessionByRoomId={sessionByRoomId}
        selectedRoomId={resolvedRoomId}
        onLeaveToHallway={handleLeaveRoom}
      />
    </div>
  );
}

// Lock gate shown in place of the room view when a code-gated room is
// occupied and the viewer isn't the owner / already inside. You can't see
// the room's chat / video / timer until you enter the code. onEnter returns
// a promise<boolean>; a falsy result keeps the gate open with an error.
//
// When the room accepts knocks (room.knock_enabled), a held-out user can knock
// instead of entering the code: requestRoomEntry pings the occupants, and we
// subscribe to our own request row — an approval auto-enters via onEnter(null)
// (can_enter_room honors the fresh grant), a denial / no-answer offers a retry.
const KNOCK_TIMEOUT_MS = 120000;

function RoomLockGate({ room, onEnter, onBack, busy, dark, codeRoom = false, deptLocked = false, gatingLabel = "" }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // 'idle' (code entry) → 'waiting' → 'denied' | 'timeout'
  const [phase, setPhase] = useState("idle");
  const [requestId, setRequestId] = useState(null);

  // onEnter is a fresh closure each parent render; keep it in a ref so the
  // realtime subscription effect doesn't tear down/resubscribe every render.
  const onEnterRef = useRef(onEnter);
  useEffect(() => { onEnterRef.current = onEnter; }, [onEnter]);

  const knockable = !!room?.knock_enabled;
  const working = submitting || busy;

  async function submit() {
    const clean = code.trim().toUpperCase();
    if (!clean || working) return;
    setSubmitting(true);
    setErr("");
    const ok = await onEnter?.(clean);
    setSubmitting(false);
    if (!ok) setErr("Incorrect or expired code.");
  }

  async function startKnock() {
    if (working) return;
    setErr("");
    setSubmitting(true);
    const { data, error } = await requestRoomEntry(room.id);
    setSubmitting(false);
    if (error || !data) { setErr(error?.message || "Couldn't knock — try again."); return; }
    setRequestId(data);
    setPhase("waiting");
  }

  // Watch our own request row until it resolves or the knock is cancelled.
  useEffect(() => {
    if (!requestId) return;
    const channel = supabase.channel(`knock:${requestId}`);
    channel.on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "room_knock_requests", filter: `id=eq.${requestId}` },
      async (payload) => {
        const status = payload.new?.status;
        if (status === "approved") {
          const ok = await onEnterRef.current?.(null);
          if (!ok) { setRequestId(null); setPhase("idle"); setErr("You were let in, but entry failed — try the code."); }
          // On success the parent swaps RoomView in over this gate.
        } else if (status === "denied") {
          setRequestId(null);
          setPhase("denied");
        }
      }
    );
    channel.subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [requestId]);

  useEffect(() => {
    if (phase !== "waiting" || !requestId) return;
    const timer = setTimeout(() => setPhase("timeout"), KNOCK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, requestId]);

  const card = (children) => (
    <div className="flex-1 min-h-0 flex items-center justify-center p-6">
      <div
        className={`w-full max-w-sm rounded-2xl border p-6 text-center ${
          dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"
        }`}
      >
        {children}
      </div>
    </div>
  );

  const iconBubble = (Icon, tone = "amber") => (
    <div
      className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full ${
        tone === "amber"
          ? dark ? "bg-amber-500/15 text-amber-300" : "bg-amber-50 text-amber-600"
          : dark ? "bg-teal-500/15 text-teal-300" : "bg-teal-50 text-teal-600"
      }`}
    >
      <Icon className="w-5 h-5" />
    </div>
  );

  const title = (text) => (
    <h2 className={`text-lg font-bold ${dark ? "text-slate-100" : "text-slate-800"}`}>{text}</h2>
  );
  const sub = (text) => (
    <p className={`text-xs mt-1 mb-4 ${dark ? "text-slate-400" : "text-slate-500"}`}>{text}</p>
  );

  if (phase === "waiting") {
    return card(
      <>
        <div
          className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full ${
            dark ? "bg-teal-500/15 text-teal-300" : "bg-teal-50 text-teal-600"
          }`}
        >
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
        {title(`Knocking on ${room?.name}…`)}
        {sub("Waiting for someone inside to let you in.")}
        <Button variant="outline" size="sm" className="w-full" onClick={() => { setPhase("idle"); setRequestId(null); }}>
          Cancel
        </Button>
      </>
    );
  }

  if (phase === "denied" || phase === "timeout") {
    return card(
      <>
        {iconBubble(Lock)}
        {title(phase === "denied" ? "Knock declined" : "No answer")}
        {sub(phase === "denied"
          ? "Someone inside declined your request."
          : "Nobody answered your knock.")}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={onBack}>
            Back to hallway
          </Button>
          <Button size="sm" className="flex-1" onClick={() => { setErr(""); setRequestId(null); setPhase("idle"); }}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  return card(
    <>
      {iconBubble(Lock)}
      {title(`${room?.name} is locked`)}
      {sub(deptLocked
        ? `This room is for ${gatingLabel || "another team"}. Knock to ask to be let in.`
        : "Someone's working in here. Enter the access code to join them.")}

      {codeRoom ? (
        <>
          <input
            autoFocus
            value={code}
            onChange={(e) => { setCode(e.target.value.toUpperCase().slice(0, 16)); setErr(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="ACCESS CODE"
            className={`w-full px-3 py-2 rounded-lg border text-center text-sm font-mono uppercase tracking-[0.3em] ${
              dark ? "bg-[var(--color-surface-raised)] border-[var(--color-border)] text-slate-100" : "bg-white border-slate-200 text-slate-800"
            }`}
          />
          {err && (
            <p className={`text-xs mt-2 ${dark ? "text-red-400" : "text-red-600"}`}>{err}</p>
          )}
          <div className="flex gap-2 mt-4">
            <Button variant="outline" size="sm" className="flex-1" onClick={onBack} disabled={working}>
              Back to hallway
            </Button>
            <Button size="sm" className="flex-1" onClick={submit} disabled={!code.trim() || working}>
              {working ? "Entering…" : "Enter room"}
            </Button>
          </div>
          {knockable && (
            <button
              type="button"
              onClick={startKnock}
              disabled={working}
              className={`mt-3 inline-flex items-center justify-center gap-1.5 w-full text-xs font-medium ${
                dark ? "text-teal-300 hover:text-teal-200" : "text-teal-600 hover:text-teal-700"
              } disabled:opacity-50`}
            >
              <Bell className="w-3.5 h-3.5" />
              Knock to ask to be let in
            </button>
          )}
        </>
      ) : (
        <>
          {err && (
            <p className={`text-xs mb-2 ${dark ? "text-red-400" : "text-red-600"}`}>{err}</p>
          )}
          <div className="flex gap-2 mt-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={onBack} disabled={working}>
              Back to hallway
            </Button>
            {knockable && (
              <Button size="sm" className="flex-1" onClick={startKnock} disabled={working}>
                <Bell className="w-3.5 h-3.5 mr-1.5" />
                {working ? "Knocking…" : "Knock"}
              </Button>
            )}
          </div>
          {!knockable && (
            <p className={`text-[11px] mt-3 ${dark ? "text-slate-500" : "text-slate-400"}`}>
              This room isn’t accepting knocks right now.
            </p>
          )}
        </>
      )}
    </>
  );
}
