import { useEffect, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import { Volume2 } from "lucide-react";
import { getAudioContext } from "../../lib/audioContext";
import { logAudioEvent } from "./livekitDiagnostics";

// Autoplay-recovery safety net for the call's remote audio.
//
// Browsers block audio playback that isn't tied to a user gesture. With
// webAudioMix (see livekitConnect.getLkRoomOptions) all remote audio is mixed
// through one AudioContext, so a block manifests as a SUSPENDED context / LiveKit
// reporting `room.canPlaybackAudio === false` — most often after the call host is
// re-parented into a fresh document (Document-PiP pop-out), on the native iOS
// WKWebView, or when a participant starts talking while the tab was backgrounded.
// Nothing else in the app recovers from this, so a blocked call just stays silent.
//
// This component:
//   • tracks `room.canPlaybackAudio` via RoomEvent.AudioPlaybackStatusChanged,
//   • shows a single tap-to-enable affordance while blocked, and
//   • ALSO recovers on the next pointer gesture anywhere in the call's own
//     document (so a user who clicks anything — not just the pill — gets sound
//     back). It resumes both LiveKit's playback (room.startAudio) and the shared
//     AudioContext (getAudioContext resumes a suspended one).
//
// Mounted once inside <LiveKitRoom> on every call surface (member call + kiosk),
// so it travels with the re-parented call host into the PiP window.
export default function AudioUnblocker() {
  const room = useRoomContext();
  const [blocked, setBlocked] = useState(false);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!room) return undefined;
    const sync = () => setBlocked(room.canPlaybackAudio === false);
    sync();
    room.on(RoomEvent.AudioPlaybackStatusChanged, sync);
    return () => room.off(RoomEvent.AudioPlaybackStatusChanged, sync);
  }, [room]);

  async function recover() {
    // Resume the shared Web Audio context (getAudioContext resumes if suspended)
    // then let LiveKit re-attempt playback. Order matters: startAudio needs a
    // running context to actually produce sound under webAudioMix.
    getAudioContext();
    try {
      await room?.startAudio();
      logAudioEvent("unblocked", { via: "gesture" });
    } catch {
      /* still blocked — the affordance stays until the next status change */
    }
  }

  // Recover on ANY gesture in the document this component lives in. In a
  // Document-PiP window that document is the pop-out's, not the opener's, so bind
  // to the element's ownerDocument rather than the main `window`.
  useEffect(() => {
    if (!room || !blocked) return undefined;
    const doc = btnRef.current?.ownerDocument || (typeof document !== "undefined" ? document : null);
    if (!doc) return undefined;
    const onGesture = () => { recover(); };
    doc.addEventListener("pointerdown", onGesture, { capture: true });
    return () => doc.removeEventListener("pointerdown", onGesture, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, blocked]);

  if (!blocked) return null;

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={recover}
      aria-label="Enable call audio"
      className="absolute top-2 left-1/2 -translate-x-1/2 z-[140] flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--color-accent,#2563eb)] text-white text-xs font-semibold shadow-lg hover:brightness-110 active:brightness-95"
    >
      <Volume2 className="w-3.5 h-3.5" /> Tap to enable sound
    </button>
  );
}
