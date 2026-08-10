import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../context/ThemeContext";
import { track, isMobileClient } from "../../lib/analytics";
import LiveKitCall from "./LiveKitCall";
import EmoteOverlay from "../emotes/EmoteOverlay";

// Wrapper for a single room's LiveKit call.
//
// Renders LiveKitCall and owns the cross-cutting concerns:
//   • the shared "couldn't load the call" error UI
//   • the EmoteOverlay (reactions float over the call)
//   • PostHog instrumentation — attempt / connected / failed / ended,
//     tagged with provider + platform + duration.
//
// roomId          — the Mangodoro room id (stable for this component's
//                   life; PersistentVideoCall keys us by roomId).
// displayName     — what other participants see.
// onJoined/onLeft — fired when the local participant joins / leaves.
export default function VideoCall({ roomId, displayName, compact, publish, listen, choices, chromeless, hideControls, onJoinIn, onJoined, onLeft, onError }) {
  const { theme } = useTheme();
  const dark = theme === "dark";
  const [error, setError] = useState(null);

  // Kept as a stable tag on the PostHog call events (all calls are LiveKit now).
  const provider = "livekit";

  // Analytics lifecycle — refs so we don't re-render on timing bookkeeping.
  const attemptAtRef = useRef(0);
  const connectedAtRef = useRef(0);
  // The emote overlay owns the reaction channel + particle fountain; the
  // LiveKit toolbar's reaction buttons drive it through this stable API
  // (start = tap-or-hold-to-charge-burst; subscribeCharge = glow updates).
  const emoteRef = useRef(null);
  const emoteApiRef = useRef(null);
  if (!emoteApiRef.current) {
    emoteApiRef.current = {
      start: (glyph, ev, key) => emoteRef.current?.start?.(glyph, ev, key),
      pick: (glyph) => emoteRef.current?.pick?.(glyph),
      subscribeCharge: (cb) => emoteRef.current?.subscribeCharge?.(cb) ?? (() => {}),
      subscribeRecents: (cb) => emoteRef.current?.subscribeRecents?.(cb) ?? (() => {}),
    };
  }

  useEffect(() => {
    if (!roomId) return;
    const isMobile = isMobileClient();
    attemptAtRef.current = Date.now();
    connectedAtRef.current = 0;
    setError(null);
    track("video_call_attempt", { provider, room_id: roomId, is_mobile: isMobile });

    return () => {
      // Only count a "session" if we actually connected.
      if (connectedAtRef.current) {
        track("video_call_ended", {
          provider,
          room_id: roomId,
          is_mobile: isMobile,
          duration_s: Math.round((Date.now() - connectedAtRef.current) / 1000),
        });
      }
    };
  }, [roomId, provider]);

  const handleJoined = () => {
    if (!connectedAtRef.current) {
      connectedAtRef.current = Date.now();
      track("video_call_connected", {
        provider,
        room_id: roomId,
        is_mobile: isMobileClient(),
        ms_to_connect: attemptAtRef.current ? Date.now() - attemptAtRef.current : null,
      });
    }
    onJoined?.();
  };

  // Capture WHY a call dropped (the LiveKit DisconnectReason) so we can see it
  // for real prod sessions in PostHog — a disconnect that isn't our own leave
  // (e.g. duplicate_identity, join_failure) is the "bounced back to green room"
  // bug. Then bubble up so the call actually tears down.
  const handleLeft = (reason, report) => {
    if (connectedAtRef.current && reason && reason !== "client_initiated") {
      track("video_call_disconnected", {
        provider,
        room_id: roomId,
        is_mobile: isMobileClient(),
        reason,
        duration_s: Math.round((Date.now() - connectedAtRef.current) / 1000),
        // The lead-up captured by <ConnectionDiagnostics> so PostHog can
        // separate network drops from kicks:
        // a drop after reconnect attempts / a quality collapse / going offline is
        // the member's connection; a clean drop at full quality is server-side.
        reconnects: report?.reconnects ?? null,
        last_quality: report?.lastQuality ?? null,
        was_online: report?.env?.online ?? null,
        visibility: report?.env?.visibility ?? null,
        effective_type: report?.env?.effectiveType ?? null,
      });
    }
    // Forward the human-readable disconnect reason (+ report) so the call host
    // can tell a terminal drop (kick / duplicate identity / room gone) from a
    // recoverable network drop and decide whether to auto-rejoin.
    onLeft?.(reason, report);
  };

  const handleError = (message, recoverable) => {
    track("video_call_failed", {
      provider,
      room_id: roomId,
      is_mobile: isMobileClient(),
      error: message,
    });
    // Recoverable (a connect-time token/room failure during a brownout): hand it
    // to the host to route through the auto-rejoin ladder — do NOT show the
    // terminal "Couldn't load the call" card, which would strand the user with no
    // retry. Only a PERMANENT error (e.g. LiveKit not configured) shows the card.
    if (recoverable) { onError?.(message, true); return; }
    setError(message);
    onError?.(message, false);
  };

  return (
    <div className="relative w-full h-full">
      {error ? (
        <div className={`w-full h-full rounded-xl border flex items-center justify-center text-center p-6 ${
          dark ? "border-[var(--color-border)] bg-[var(--color-surface)] text-slate-300" : "border-slate-200 bg-white text-slate-600"
        }`}>
          <div>
            <p className="text-sm font-semibold mb-1">Couldn't load the call</p>
            <p className={`text-xs ${dark ? "text-slate-500" : "text-slate-400"}`}>{error}</p>
          </div>
        </div>
      ) : (
        <>
          <LiveKitCall
            roomId={roomId}
            displayName={displayName}
            compact={compact}
            hideControls={hideControls}
            publish={publish}
            listen={listen}
            choices={choices}
            chromeless={chromeless}
            onJoinIn={onJoinIn}
            emote={emoteApiRef.current}
            onJoined={handleJoined}
            onLeft={handleLeft}
            onError={handleError}
          />
          {/* Reaction particles, scoped by roomId so everyone sees each
              other's emotes over the video. The trigger lives in the call
              toolbar, so the overlay's own bar stays hidden. */}
          {roomId && (
            <EmoteOverlay
              ref={emoteRef}
              channelKey={`room:${roomId}`}
              barPosition="hidden"
              senderName={displayName}
            />
          )}
        </>
      )}
    </div>
  );
}
