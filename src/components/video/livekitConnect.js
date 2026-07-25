// Connection rate-limiting for LiveKit, shared by every <LiveKitRoom> we mount.
//
// Why this exists: a failed or churning connection used to spam the backend.
// LiveKit Cloud rate-limits connection *attempts* per project; when it 429s, the
// client's DefaultReconnectPolicy retries through every region with tiny delays,
// and StrictMode double-mounts + Vite HMR remounts pile fresh connects on top.
// The result is a wall of `429 Too Many Requests` and wasted token-mint calls.
//
// Two guards:
//   1. A custom reconnect policy with real exponential backoff + a hard cap, so
//      one failure can't turn into a cross-region flood.
//   2. A client-side throttle (connectDelayFor / markConnectAttempt) so we never
//      *initiate* a connection to the same room more than once per window —
//      absorbing StrictMode/HMR remounts and rapid rejoin loops.
//
// Both objects are module constants so passing them to <LiveKitRoom options=…>
// doesn't change identity between renders (which would recreate the Room).

import { getAudioContext } from "../../lib/audioContext";

// Capped exponential backoff. context.retryCount starts at 0 for the first
// retry. Return null to stop retrying — after ~6 tries (~30s of backoff) we give
// up rather than hammer. Active calls still get robust reconnection; this only
// stops the tight loop.
export const LK_RECONNECT_POLICY = {
  nextRetryDelayInMs(context) {
    if (context.retryCount >= 6) return null;
    const base = Math.min(8000, 600 * 2 ** context.retryCount);
    // Jitter so N clients reconnecting together don't sync into a thundering herd.
    return base + Math.random() * 400;
  },
};

// Stable RoomOptions carrying the policy + Web Audio mixing. Pass the SAME
// object (via getLkRoomOptions(), which caches) to <LiveKitRoom options=…> so
// the Room isn't recreated on every render.
//
// webAudioMix mixes ALL remote audio through ONE Web Audio graph instead of a
// per-track set of <audio> DOM elements. That is the crux of the audio
// hardening: there are no per-track elements to pause when the call host is
// re-parented (in-app PiP, Document-PiP pop-out, page navigation), and it is
// LiveKit's documented remedy for autoplay-blocked playback. We route it through
// the app's single shared AudioContext (lib/audioContext.js) so the whole app
// stays at ONE context (well under the browser's ~6 cap) with a single resume()
// point for autoplay recovery. Passing an OBJECT (not the boolean `true`) is
// deliberate: LiveKit only close()s the AudioContext it manages when webAudioMix
// is a boolean, so handing it our shared context leaves that context alive across
// call teardown (the pomodoro/ambience chimes keep working). Falls back to the
// boolean form if Web Audio is unavailable.
let _roomOptions = null;
export function getLkRoomOptions() {
  if (_roomOptions) return _roomOptions;
  const ctx = getAudioContext();
  _roomOptions = {
    reconnectPolicy: LK_RECONNECT_POLICY,
    webAudioMix: ctx ? { audioContext: ctx } : true,
  };
  return _roomOptions;
}

// The initial join retries at most twice; on failure the app bounces back to the
// green room, which is a cleaner recovery than silently retrying forever.
export const LK_CONNECT_OPTIONS = {
  maxRetries: 2,
};

// Don't initiate a connection to the same room more often than this.
const MIN_CONNECT_INTERVAL = 2500;
const lastConnectAt = new Map();

// Milliseconds to wait before it's OK to (re)connect to this room. 0 = go now.
export function connectDelayFor(roomName) {
  const last = lastConnectAt.get(roomName) || 0;
  return Math.max(0, MIN_CONNECT_INTERVAL - (Date.now() - last));
}

// Record that we just kicked off a connection to this room.
export function markConnectAttempt(roomName) {
  lastConnectAt.set(roomName, Date.now());
}

// ── Global circuit breaker ──────────────────────────────────────────
// A failed connect (most importantly a 429 from LiveKit Cloud's rate limiter)
// must not be retried immediately — the SDK already fans a single connect across
// every region, so an instant retry compounds the rate limit. After ANY connect
// error we arm an app-wide cooldown; the connect path waits it out before the
// next attempt to ANY room. This backs off the whole project, not just one room.
const CONNECT_COOLDOWN_MS = 20000;
let cooldownUntil = 0;

// Call from <LiveKitRoom onError>. Arms the cooldown.
export function noteConnectFailure() {
  cooldownUntil = Date.now() + CONNECT_COOLDOWN_MS;
}

// Milliseconds remaining before a new connection may be initiated. 0 = clear.
export function connectCooldownMs() {
  return Math.max(0, cooldownUntil - Date.now());
}
