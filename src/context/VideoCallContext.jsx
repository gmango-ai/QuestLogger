import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { logCallEvent } from "../components/video/livekitDiagnostics";

// Owns the *one* active LiveKit room call across the whole app session.
// The call is mounted exactly once at AppLayout (via PersistentVideoCall)
// on a stable host node that's re-parented (not remounted), so navigating
// between /office and /pomodoro / settings / etc. doesn't drop the call.
//
// State:
//   call         — { roomId, displayName } | null. Truthy = call alive.
//   stageEl      — the DOM element on the current page where the call
//                  should visually "live" (e.g. RoomVideoStage's
//                  container). When set, PersistentVideoCall appends its
//                  host node inside this element. When null, it falls back
//                  to a bottom-right PiP.
//
// Why a context (vs Redux/Zustand/etc): this is a single-pair state
// + setStageEl callback; context with React state is the smallest
// thing that fits.

const VideoCallContext = createContext(null);

// ── Active-call persistence (auto-rejoin) ────────────────────────────────────
// The provider lives inside the authenticated tree, so it remounts when auth is
// lost then regained (e.g. a re-login in the same tab after an auth-server
// wobble). We stash the active call in sessionStorage so that remount can rejoin
// automatically instead of stranding the user. Only a real teardown (endCall) or
// closing the tab clears it — a bare unmount (the logout path) leaves it intact.
const ACTIVE_CALL_KEY = "ql_active_call";
const RESTORE_MAX_AGE_MS = 30 * 60 * 1000; // don't rejoin a stale/abandoned call

// In-session auto-rejoin (a mid-call media drop). Bounded so a genuinely-down
// room can't reconnect-storm: exponential backoff, capped tries per outage. The
// counter resets whenever a call sticks (becomes active) or connectivity returns.
const AUTO_REJOIN_MAX_TRIES = 5;
const AUTO_REJOIN_BASE_DELAY_MS = 1000; // 1s, 2s, 4s, 8s, 16s …
const AUTO_REJOIN_MAX_DELAY_MS = 30 * 1000;

function persistActiveCall(c) {
  try {
    if (!c?.roomId) return;
    sessionStorage.setItem(ACTIVE_CALL_KEY, JSON.stringify({
      roomId: c.roomId,
      displayName: c.displayName || "",
      mode: c.mode || "join",
      listen: c.listen !== false,
      ts: Date.now(),
    }));
  } catch { /* private mode / storage disabled — auto-rejoin just won't fire */ }
}
function clearPersistedActiveCall() {
  try { sessionStorage.removeItem(ACTIVE_CALL_KEY); } catch { /* */ }
}
function loadPersistedActiveCall() {
  try {
    const raw = sessionStorage.getItem(ACTIVE_CALL_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.roomId || Date.now() - (s.ts || 0) > RESTORE_MAX_AGE_MS) return null;
    // Rejoin with camera OFF + mic MUTED. An auto-restore happens without a user
    // gesture (a reload, or a recovered login), so silently turning the camera on
    // would be a privacy surprise. The user reconnects + hears the room (listen),
    // then unmutes/enables when ready — Zoom-style "you're back, turn on when set".
    return {
      roomId: s.roomId,
      displayName: s.displayName || "",
      mode: s.mode || "join",
      choices: { videoEnabled: false, audioEnabled: false },
      listen: s.listen !== false,
    };
  } catch { return null; }
}

export function VideoCallProvider({ children }) {
  // Restore an in-flight call on mount (auto-rejoin after a recovered logout).
  const [call, setCall] = useState(loadPersistedActiveCall);
  const [stageEl, setStageElRaw] = useState(null);
  // Pop-out (Document PiP) state. The actual window/host management lives in
  // PersistentVideoCall (it owns the re-parentable host + needs a user gesture),
  // which registers its open/close here so the call control bar can drive it
  // without prop-drilling through VideoCall → LiveKitCall → the bar.
  const [poppedOut, setPoppedOut] = useState(false);
  const [canPopOut, setCanPopOut] = useState(false);
  // Mobile "fullscreen": PersistentVideoCall re-parents the call host to a
  // fixed inset-0 overlay. CSS-only, so it works where the Fullscreen API
  // doesn't (iPhone WKWebView).
  const [maximized, setMaximized] = useState(false);
  // Drive mode stages the call video but supplies its OWN giant controls, so it
  // asks the persistent call to render chromeless (no LiveKit control bar).
  const [hideChrome, setHideChrome] = useState(false);
  const popoutApiRef = useRef({ open: null, close: null });
  const registerPopout = useCallback((api) => { popoutApiRef.current = api || { open: null, close: null }; }, []);
  const popOut = useCallback(() => { popoutApiRef.current.open?.(); }, []);
  const popIn = useCallback(() => { popoutApiRef.current.close?.(); }, []);
  // Mirror `call` into a ref so the stable (deps-free) start/end callbacks can
  // read the current room for logging without taking `call` as a dep (which
  // would change their identity and re-fire RoomVideoStage's effects).
  const callRef = useRef(null);
  callRef.current = call;

  // ── In-session auto-rejoin ──────────────────────────────────────────────
  // The persisted `ql_active_call` marker was only read at MOUNT, so a mid-
  // session media drop (network blip / LiveKit reconnect that gives up) left the
  // user stranded until a reload. This watcher rejoins in-session: on an
  // involuntary drop, and on `online` / becoming visible, if a fresh marker
  // still exists (a user leave / kick cleared it) and no call is active, it
  // restarts the call — camera-off + mic-muted, matching loadPersistedActiveCall.
  const rejoinTimerRef = useRef(null);
  const rejoinTriesRef = useRef(0);
  const clearRejoinTimer = () => {
    if (rejoinTimerRef.current) { clearTimeout(rejoinTimerRef.current); rejoinTimerRef.current = null; }
  };
  // Ref-held so the stable (deps-free) callbacks + event listeners always call
  // the latest closure (which reads the current startCall) without re-binding.
  const attemptRejoinRef = useRef(null);
  attemptRejoinRef.current = (trigger) => {
    if (callRef.current) { rejoinTriesRef.current = 0; return; } // already back
    // A hidden tab throttles timers and can't usefully connect media — wait for
    // it to foreground (the visibilitychange listener re-attempts then).
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const restore = loadPersistedActiveCall(); // null → user left / kicked / stale
    if (!restore) { rejoinTriesRef.current = 0; clearRejoinTimer(); return; }
    if (rejoinTriesRef.current >= AUTO_REJOIN_MAX_TRIES) return;
    rejoinTriesRef.current += 1;
    logCallEvent("auto-rejoin", { roomId: restore.roomId, trigger, attempt: rejoinTriesRef.current });
    startCall(restore.roomId, restore.displayName, {
      mode: restore.mode,
      choices: restore.choices,
      listen: restore.listen,
    });
  };
  const scheduleRejoinRef = useRef(null);
  scheduleRejoinRef.current = (trigger) => {
    if (rejoinTimerRef.current || callRef.current) return;
    if (rejoinTriesRef.current >= AUTO_REJOIN_MAX_TRIES) return;
    if (!loadPersistedActiveCall()) return; // nothing (recoverable) to rejoin
    const delay = Math.min(AUTO_REJOIN_MAX_DELAY_MS, AUTO_REJOIN_BASE_DELAY_MS * 2 ** rejoinTriesRef.current);
    rejoinTimerRef.current = setTimeout(() => {
      rejoinTimerRef.current = null;
      attemptRejoinRef.current?.(trigger);
    }, delay);
  };

  // A call became active → the reconnect (or fresh join) stuck; reset the budget.
  useEffect(() => {
    if (call) { rejoinTriesRef.current = 0; clearRejoinTimer(); }
  }, [call]);

  // Rejoin on connectivity/foreground recovery. `online` gets a fresh try budget
  // (a new outage deserves the full backoff ladder). Cleared on unmount so a
  // pending timer never fires into a torn-down (logged-out) provider.
  useEffect(() => {
    const onOnline = () => { rejoinTriesRef.current = 0; attemptRejoinRef.current?.("online"); };
    const onVisible = () => { if (document.visibilityState === "visible") attemptRejoinRef.current?.("visible"); };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  useEffect(() => () => clearRejoinTimer(), []);

  // If we mounted with a restored call (auth-loss → re-login rejoin), leave a
  // breadcrumb so the reconnect is distinguishable from a fresh user-initiated
  // join in the call diagnostics.
  useEffect(() => {
    if (callRef.current) logCallEvent("restore", { roomId: callRef.current.roomId, mode: callRef.current.mode });
    // Mount-only: this fires once for the initial (possibly restored) call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // opts.mode: "join" (publish camera/mic) | "spectate" (subscribe-only —
  // see everyone without publishing). opts.choices: device prefs from the
  // pre-join card ({ videoEnabled, audioEnabled, videoDeviceId, audioDeviceId }).
  // opts.listen: whether a spectator HEARS the call. Defaults true; a silent
  // auto-preview passes false so walking up to a room doesn't blast its audio
  // (and can't feed back through a nearby participant's mic). Ignored once you
  // publish — joining always hears.
  const startCall = useCallback((roomId, displayName, opts = {}) => {
    if (!roomId) return;
    const prev = callRef.current;
    // "switch" = carry-over into a different room (a fresh connection); "start" =
    // first join. Either way the VideoCall re-keys on roomId and reconnects.
    logCallEvent(prev && prev.roomId !== roomId ? "switch" : "start", {
      roomId,
      from: prev?.roomId || null,
      mode: opts.mode || "join",
    });
    const next = {
      roomId,
      displayName: displayName || "",
      mode: opts.mode || "join",
      choices: opts.choices || null,
      listen: opts.listen !== false,
    };
    setCall(next);
    persistActiveCall(next);
  }, []);

  // reason — a short string for WHY the call is ending (user leave, sync-session
  // room cleared, etc.). Logged so a teardown that wasn't a user action stands
  // out as a candidate for the "force disconnect" bug.
  const endCall = useCallback((reason) => {
    const prev = callRef.current;
    if (prev) logCallEvent("end", { roomId: prev.roomId, reason: reason || "unspecified" });
    // A DELIBERATE or TERMINAL end (user leaves, room cleared, kicked, duplicate
    // identity — all tagged ≠ "livekit-disconnected") clears the auto-rejoin
    // marker so we don't fight it. "livekit-disconnected" is a recoverable
    // transient drop — and it also fires when the tree unmounts on logout — so it
    // must NOT clear the marker, or a recovered login / the watcher couldn't
    // rejoin. (A bare unmount never calls endCall at all.)
    const recoverable = reason === "livekit-disconnected";
    if (!recoverable) clearPersistedActiveCall();
    setCall(null);
    setStageElRaw(null);
    setPoppedOut(false);
    setMaximized(false);
    setHideChrome(false);
    // Involuntary drop with the marker intact → kick off the bounded, backoff
    // auto-rejoin (reconnects camera-off + mic-muted via loadPersistedActiveCall).
    if (recoverable) scheduleRejoinRef.current?.("dropped");
  }, []);

  // Patch the live call without re-creating it — used to flip a spectator
  // into a publisher ("Join in") without changing the room/identity.
  const updateCall = useCallback((partial) => {
    logCallEvent("update", partial);
    setCall((c) => (c ? { ...c, ...partial } : c));
    const cur = callRef.current;
    if (cur) persistActiveCall({ ...cur, ...partial });
  }, []);

  // Stable identity for the setter so RoomVideoStage's useEffect
  // doesn't re-fire on every parent render.
  const setStageEl = useCallback((el) => setStageElRaw(el), []);

  const value = useMemo(
    () => ({
      call, stageEl, startCall, endCall, updateCall, setStageEl,
      poppedOut, setPoppedOut, canPopOut, setCanPopOut, popOut, popIn, registerPopout,
      maximized, setMaximized, hideChrome, setHideChrome,
    }),
    [call, stageEl, startCall, endCall, updateCall, setStageEl,
      poppedOut, canPopOut, popOut, popIn, registerPopout, maximized, hideChrome],
  );

  return (
    <VideoCallContext.Provider value={value}>
      {children}
    </VideoCallContext.Provider>
  );
}

export function useVideoCall() {
  const ctx = useContext(VideoCallContext);
  if (!ctx) throw new Error("useVideoCall must be used within a VideoCallProvider");
  return ctx;
}
