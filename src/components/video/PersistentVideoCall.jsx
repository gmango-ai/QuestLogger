import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Car, Maximize2, PhoneOff, PictureInPicture2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useVideoCall } from "../../context/VideoCallContext";
import { useSyncSession } from "../../context/SyncSessionContext";
import { useApp } from "../../context/AppContext";
import { useTheme } from "../../context/ThemeContext";
import { cloneDocStyles, copyRootCustomProps } from "../pomodoro/PomodoroPipParts";
import { audioMediaSnapshot, logAudioEvent, logCallEvent } from "./livekitDiagnostics";
import { getAudioContext } from "../../lib/audioContext";
import { createSyncSession } from "../../lib/syncSession";
import VideoCall from "./VideoCall";

// LiveKit disconnect reasons (human names from LiveKitCall's onDisconnected)
// that are TERMINAL — the call must NOT auto-rejoin after them. A plain network
// / transient drop maps to "livekit-disconnected", which keeps the auto-rejoin
// marker so VideoCallContext's watcher can reconnect. These clear it.
const LK_TERMINAL_DISCONNECTS = new Set([
  "client_initiated",    // user hit Leave in the call control bar
  "duplicate_identity",  // signed in elsewhere — that session wins, don't fight it
  "participant_removed", // moderation kick
  "room_deleted",
  "room_closed",
  "user_rejected",
]);
// Map a LiveKit disconnect reason to the endCall reason. Terminal reasons get a
// distinct tag (≠ "livekit-disconnected") so endCall clears the rejoin marker;
// everything else stays "livekit-disconnected" (recoverable → eligible to
// auto-rejoin, and the string that also fires on a logout unmount).
export function endReasonForDisconnect(reason) {
  return LK_TERMINAL_DISCONNECTS.has(reason) ? `livekit-${reason}` : "livekit-disconnected";
}

// Re-parenting the call host — between the page stage, the floating PiP, and the
// Document-PiP window — pauses its media elements. Crucially that includes the
// RoomAudioRenderer's <audio> (remote mic + shared/screen-share audio), not just
// <video>: moving ANY media element across documents (or, for video, even
// between parents) stops playback. Resume ALL of them, or a popped-out user goes
// silent while still subscribed. Logs a before/after snapshot so a stuck-silent
// call is visible in the console.
function resumeHostMedia(host, where) {
  if (!host) return;
  // With webAudioMix the remote call audio flows through the shared AudioContext,
  // not the moved <audio> elements — so resume that context too (it can be parked
  // in "suspended" after a background/re-parent). getAudioContext() resumes it.
  getAudioContext();
  const before = audioMediaSnapshot(host);
  try {
    host.querySelectorAll("video, audio").forEach((el) => {
      const p = el.play?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    });
  } catch {
    /* */
  }
  if (before.audio > 0) {
    // Report after a tick so play() has had a chance to take effect.
    setTimeout(() => logAudioEvent(where, { before, after: audioMediaSnapshot(host) }), 300);
  }
}

// Persistent container for the active room call. Lives at the AppLayout level so
// it never unmounts when the user navigates — the LiveKit connection stays up.
//
// Positioning: we portal the call into a STABLE host <div> that we physically
// move between two parents:
//   • Stage mode — appended INSIDE the page's stageEl (RoomVideoStage's tile),
//     position:absolute inset-0, so the call fills that tile and SCROLLS NATIVELY
//     with the page.
//   • PiP mode  — appended to <body>, position:fixed bottom-right, a floating
//     window with a back-to-room + leave-call header.
//
// Re-parenting the host node is safe for LiveKit <video> elements — moving the
// node keeps the RTC + <video> live.

const PIP_CSS =
  "position:fixed;bottom:16px;right:16px;width:320px;height:200px;z-index:120;" +
  "border-radius:12px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.5);" +
  "background:#0f172a;border:1px solid rgb(51,65,85);";
// On phones the floating video window is unusable (covers the page, controls
// too small to hit), so the host parks offscreen-invisible — audio keeps
// playing — and a compact "in call" pill below carries the actions instead.
const PIP_HIDDEN_CSS =
  "position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0;" +
  "pointer-events:none;overflow:hidden;";
const IS_TOUCH =
  typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
const STAGE_CSS = "position:absolute;inset:0;z-index:20;";
// Maximized: the host covers the viewport (below the drive overlay's z-200,
// above nav/PiP). Safe-area padding keeps the stage out of the notch.
const MAX_CSS =
  "position:fixed;inset:0;z-index:130;background:#0f172a;box-sizing:border-box;" +
  "padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);";

export default function PersistentVideoCall() {
  const { call, startCall, endCall, updateCall, markConnected, stageEl, poppedOut, setPoppedOut, setCanPopOut, registerPopout, maximized, hideChrome } = useVideoCall();
  const { syncSession, joinSession } = useSyncSession();
  const { session } = useApp();
  const { theme } = useTheme();
  const dark = theme === "dark";
  const navigate = useNavigate();
  const inPiP = !stageEl && !maximized;

  // Pop-out: move the call host into an OS-level Document Picture-in-Picture
  // window that floats above other apps. Chromium/Electron only (same API the
  // pomodoro pop-out uses). Moving the host node keeps the RTC + <video> live.
  // `poppedOut` lives in VideoCallContext so the (deeply-nested) call control bar
  // can drive it; we register the open/close implementation there below.
  const pipWinRef = useRef(null);
  const canPopOut =
    typeof window !== "undefined" &&
    "documentPictureInPicture" in window;

  // Stable host node: created once, moved between parents, never unmounted — so
  // the portaled <VideoCall> survives navigation.
  const hostRef = useRef(null);
  if (hostRef.current === null && typeof document !== "undefined") {
    hostRef.current = document.createElement("div");
  }

  // Collapse the call UI to compact when it's rendered in a tight area — PiP, or
  // the shrunk "others" corner of the pre-join — so the toolbar never overflows.
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => setSmall(host.clientWidth > 0 && host.clientWidth < 380));
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Continuous resume backstop: resumeHostMedia() only nudges elements present at
  // re-parent time, so a <video>/<audio> the call adds LATER (a participant joins,
  // unmutes, or undeafens) while the host lives in a floating/PiP/pop-out slot
  // would stay paused. Watch the host for added media and resume it. With
  // webAudioMix the remote audio no longer depends on these elements playing, so
  // this is mainly for video tiles + belt-and-suspenders, but it closes the gap.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof MutationObserver === "undefined") return undefined;
    const resume = (el) => {
      const p = el.play?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    };
    const mo = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.tagName === "VIDEO" || node.tagName === "AUDIO") resume(node);
          else node.querySelectorAll?.("video, audio").forEach(resume);
        });
      }
    });
    mo.observe(host, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  const compact = inPiP || small;

  // Whether the LiveKit media is actually connected — set from the call host's
  // onJoined / onLeft (which bubble from LiveKitCall's onConnected /
  // onDisconnected). This is the "is media healthy?" signal the carry-over effect
  // needs: a transient reconnect keeps this true (LiveKit fires Reconnected, not
  // Disconnected), so it only flips false on a genuine terminal drop.
  const connectedRef = useRef(false);

  // Last-known metadata of a live sync session — captured while syncSession is
  // truthy so we can re-create the row (with the right team + visibility) if it
  // vanishes out from under a still-connected call. Ref-updated during render
  // (same pattern as callRef in VideoCallContext) so it's always current without
  // re-firing effects.
  const lastSessionMetaRef = useRef(null);
  if (syncSession?.room_id) {
    lastSessionMetaRef.current = {
      roomId: syncSession.room_id,
      teamId: syncSession.team_id ?? null,
      visibility: syncSession.visibility ?? null,
    };
  }

  // Re-establish the sync-session row for the room we're still connected to,
  // after the row vanished (a DB brownout / a false-positive sweep) while the
  // LiveKit media stayed up. Idempotent: start_or_join_room_session (via
  // createSyncSession) reconciles + find-or-creates under a per-room advisory
  // lock, so it JOINs an existing row or creates a fresh one. Kept in a ref so
  // the carry-over effect can call the latest closure without taking these as
  // deps. Best-effort: on failure we log and leave the call up — the session
  // machinery (rehydrate/realtime) keeps trying — rather than ending the call.
  const reestablishInFlightRef = useRef(false);
  const reestablishRef = useRef(null);
  reestablishRef.current = async () => {
    const c = call;
    if (!c?.roomId || reestablishInFlightRef.current) return;
    reestablishInFlightRef.current = true;
    logCallEvent("session-reestablish", { roomId: c.roomId });
    try {
      const meta = lastSessionMetaRef.current;
      const { data, error } = await createSyncSession(session?.user?.id, c.displayName, {
        teamId: meta?.teamId ?? null,
        roomId: c.roomId,
        visibility: meta?.visibility ?? "team",
      });
      if (!error && data) joinSession(data);
      else console.warn(`[call] sync-session re-establish failed (room ${c.roomId}):`, error?.message || "no data returned");
    } catch (e) {
      console.warn(`[call] sync-session re-establish threw (room ${c.roomId}):`, e?.message || e);
    } finally {
      reestablishInFlightRef.current = false;
    }
  };

  // Bind the call's lifetime to the room's sync session, and handle carry-over:
  // when you move from one room to another while in a call, the call FOLLOWS you
  // (re-joins the new room) rather than ending — the only "auto-join" path.
  //
  // The session row VANISHING (curRoom null) is NOT the same as a real exit. A
  // DB/network hiccup can null syncSession (a timed-out query, or a false-
  // positive sweep) while the LiveKit media is perfectly healthy — the old code
  // tore the whole call down here, ejecting the team. So: if media is still
  // connected we treat the vanished row as advisory and re-establish it instead
  // of ending. A genuine exit ends the call through the explicit user-leave paths
  // or LiveKit's onDisconnected (onLeft), never from here-while-connected.
  const prevSessionRoomRef = useRef(syncSession?.room_id || null);
  useEffect(() => {
    const prevRoom = prevSessionRoomRef.current;
    const curRoom = syncSession?.room_id || null;
    prevSessionRoomRef.current = curRoom;
    if (call && prevRoom && curRoom !== prevRoom && call.roomId === prevRoom) {
      if (curRoom) {
        startCall(curRoom, call.displayName, { mode: call.mode, choices: call.choices, listen: call.listen });
      } else if (connectedRef.current) {
        // Media still up → the row vanished under a stationary call (brownout /
        // sweep), not a real exit. Keep the call; re-establish the session row.
        reestablishRef.current?.();
      } else {
        // Media is also gone (LiveKit already down) → this is a genuine teardown.
        // Tag it so it's unmistakable in the log.
        endCall("sync-session-room-cleared");
      }
    }
  }, [syncSession?.room_id, call, startCall, endCall]);

  // Place the host inside the stage (scrolls natively) or floating PiP. Skipped
  // while popped out — the pop-out window owns the host node then, and this
  // effect re-claims it when the window closes (poppedOut flips false).
  useLayoutEffect(() => {
    if (poppedOut) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;
    // Call ended: detach the host. In maximized mode it's a position:fixed
    // inset-0 overlay — leaving it attached (now empty, since the portal
    // renders null) covered the whole screen and stranded the user on a black
    // "call" screen after tapping Leave while fullscreen.
    if (!call) { try { host.remove(); } catch { /* */ } return undefined; }
    // appendChild MOVES the node (auto-detaching it from its old parent), so we
    // don't remove it on cleanup — doing so would yank the host straight back out
    // of the pop-out window the instant `poppedOut` flips (which showed a blank
    // window). Final teardown is handled by the unmount-only effect below.
    if (maximized) {
      host.style.cssText = MAX_CSS;
      document.body.appendChild(host);
    } else if (stageEl) {
      host.style.cssText = STAGE_CSS;
      stageEl.appendChild(host);
    } else {
      host.style.cssText = IS_TOUCH ? PIP_HIDDEN_CSS : PIP_CSS;
      document.body.appendChild(host);
    }
    // Resume BOTH video and audio — a re-parent (incl. returning from a Document
    // PiP pop-out) pauses the <audio> too, which would leave the call silent.
    resumeHostMedia(host, "reparent");
    return undefined;
  }, [stageEl, call, poppedOut, maximized]);

  // Detach the host only when this component truly unmounts (sign-out).
  useEffect(() => () => { try { hostRef.current?.remove(); } catch { /* */ } }, []);

  // Open / close the Document PiP window (open must run from a user gesture).
  async function openPopOut() {
    const dpi = typeof window !== "undefined" ? window.documentPictureInPicture : null;
    const host = hostRef.current;
    if (!dpi?.requestWindow || !host) return;
    try {
      const pipWin = await dpi.requestWindow({ width: 400, height: 300, disallowReturnToOpener: false });
      pipWinRef.current = pipWin;
      cloneDocStyles(pipWin.document);
      copyRootCustomProps(pipWin.document);
      pipWin.document.documentElement.classList.toggle("dark", dark);
      const b = pipWin.document.body;
      pipWin.document.documentElement.style.height = "100%";
      b.style.margin = "0";
      b.style.height = "100%";
      b.style.overflow = "hidden";
      b.style.background = "#0f172a";
      host.style.cssText = "position:absolute;inset:0;";
      b.appendChild(host);
      // Moving media across documents pauses it — nudge BOTH video AND audio back
      // to play, or the pop-out is silent even though remote audio is subscribed.
      resumeHostMedia(host, "popout");
      setPoppedOut(true);
      pipWin.addEventListener("pagehide", () => {
        pipWinRef.current = null;
        setPoppedOut(false); // the re-parent effect above pulls the host back in
      });
    } catch { /* user dismissed / unsupported / already open */ }
  }
  function closePopOut() {
    try { pipWinRef.current?.close(); } catch { /* */ }
    pipWinRef.current = null;
    setPoppedOut(false);
  }
  // The call ending while popped out closes the window; theme changes re-mirror.
  useEffect(() => { if (!call && pipWinRef.current) closePopOut(); }, [call]);
  useEffect(() => {
    const w = pipWinRef.current;
    if (!w?.document?.documentElement) return;
    w.document.documentElement.classList.toggle("dark", dark);
    copyRootCustomProps(w.document);
  }, [dark, poppedOut]);

  // Publish the pop-out controls + support flag to the context so the call
  // control bar (nested inside VideoCall) can trigger them. Register stable
  // wrappers that read the latest handlers via refs.
  const openRef = useRef(null); openRef.current = openPopOut;
  const closeRef = useRef(null); closeRef.current = closePopOut;
  useEffect(() => {
    registerPopout({ open: () => openRef.current?.(), close: () => closeRef.current?.() });
    return () => registerPopout(null);
  }, [registerPopout]);
  useEffect(() => { setCanPopOut(canPopOut); }, [canPopOut, setCanPopOut]);

  if (!call) return null;
  if (!hostRef.current) return null;

  const content = (
    <>
      {/* The actual call. key=roomId so changing rooms re-mounts it (carry-over
          into a new room is a fresh connection). */}
      <VideoCall
        key={call.roomId}
        roomId={call.roomId}
        displayName={call.displayName}
        compact={compact}
        // The floating PiP has its own thin header (back-to-room + leave); the
        // full control bar only renders when a page stages the call. Drive mode
        // stages the video but supplies its own giant controls (hideChrome).
        hideControls={inPiP || hideChrome}
        publish={call.mode !== "spectate"}
        listen={call.listen !== false}
        choices={call.choices}
        // While spectating, the call fills the tile but its own control bar is
        // suppressed — the Lobby (RoomVideoStage) overlays the only dock, with
        // Join / Watch / settings. Avoids two stacked bottom bars.
        chromeless={call.mode === "spectate"}
        onJoinIn={() => updateCall({ mode: "join" })}
        // A real media connection stuck → reset the auto-rejoin backoff budget.
        onJoined={() => { connectedRef.current = true; markConnected(); }}
        // A genuine LiveKit disconnect (or explicit Leave) is the ONLY media-side
        // teardown. Forward the reason so a terminal drop (kick / duplicate /
        // room gone) clears the rejoin marker while a plain network drop keeps it
        // (→ VideoCallContext's watcher reconnects).
        onLeft={(reason) => { connectedRef.current = false; endCall(endReasonForDisconnect(reason)); }}
        // A RECOVERABLE connect-time failure (token mint / room error during a
        // brownout) before we ever connected: route it through the recoverable
        // teardown so the rejoin ladder retries with backoff instead of dead-
        // ending on VideoCall's terminal "Couldn't load the call" card. Only when
        // media never connected — a post-connect error is handled by onLeft.
        onError={(_msg, recoverable) => {
          if (recoverable && !connectedRef.current) endCall("livekit-disconnected");
        }}
      />

      {/* In-app PiP chrome: a thin header with back-to-room + leave. (Pop-out
          lives in the call control bar's More menu now.) Hidden once popped out —
          that header lives in the OS window then. */}
      {inPiP && !poppedOut && !IS_TOUCH && (
        <div className="absolute top-0 left-0 right-0 flex items-center justify-between gap-2 px-2 py-1 bg-slate-900/80 backdrop-blur-sm text-white text-[11px] font-semibold pointer-events-none">
          <span className="truncate pointer-events-none">In call</span>
          <div className="flex items-center gap-1 pointer-events-auto">
            <button
              type="button"
              onClick={() => navigate(`/office/r/${call.roomId}`)}
              aria-label="Back to room"
              title="Back to room"
              className="p-1 rounded hover:bg-white/10"
            >
              <Maximize2 className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => endCall("user-leave-pip")}
              aria-label="Leave call"
              title="Leave call"
              className="p-1 rounded hover:bg-red-500/40"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <>
      {createPortal(content, hostRef.current)}
      {/* Mobile stand-in for the hidden floating window: the call is
          audio-only in the background; this pill is how you get back to it
          (room stage / drive mode) or hang up. */}
      {inPiP && !poppedOut && IS_TOUCH && (
        <div
          className="fixed inset-x-3 z-[120]"
          style={{ bottom: "calc(var(--bottom-inset) + 5.5rem)" }}
        >
          <div className="flex items-center gap-2 rounded-2xl border border-slate-700 bg-slate-900/95 text-white shadow-2xl px-4 py-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shrink-0" aria-hidden />
            <span className="flex-1 min-w-0 text-sm font-semibold truncate">In call</span>
            <button
              type="button"
              onClick={() => navigate("/drive")}
              aria-label="Drive mode"
              className="flex items-center justify-center w-11 h-11 rounded-xl active:bg-white/10"
            >
              <Car className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => navigate(`/office/r/${call.roomId}`)}
              aria-label="Back to room"
              className="flex items-center justify-center w-11 h-11 rounded-xl active:bg-white/10"
            >
              <Maximize2 className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => endCall("user-leave-pip")}
              aria-label="Leave call"
              className="flex items-center justify-center w-11 h-11 rounded-xl text-red-400 active:bg-red-500/20"
            >
              <PhoneOff className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
      {/* While popped out the host lives in the OS window, so the app's slot is
          empty — leave a small card to bring it back. */}
      {poppedOut && (
        <div className="fixed bottom-4 right-4 z-[120] w-[220px] rounded-xl border border-slate-700 bg-slate-900/95 text-white shadow-2xl p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold mb-1">
            <PictureInPicture2 className="w-3.5 h-3.5" /> Call popped out
          </div>
          <p className="text-[11px] text-slate-400 mb-2">Your call is in a floating window.</p>
          <button
            type="button"
            onClick={closePopOut}
            className="w-full px-2 py-1.5 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white text-xs font-semibold"
          >
            Return to app
          </button>
        </div>
      )}
    </>
  );
}
