// Shared classifier for LiveKit disconnect reasons (the human-readable names
// LiveKitCall's onDisconnected forwards). Used by both the persistent member
// call and the guest room page so they agree on what "don't come back" means.

// TERMINAL reasons — the call must NOT auto-rejoin after them. A plain network /
// transient drop (or no reason at all) is recoverable and keeps the rejoin path.
export const LK_TERMINAL_DISCONNECTS = new Set([
  "client_initiated",    // user hit Leave in the call control bar
  "duplicate_identity",  // signed in elsewhere — that session wins, don't fight it
  "participant_removed", // moderation kick
  "room_deleted",
  "room_closed",
  "user_rejected",
]);

// True when a disconnect reason means "don't come back" (user left, kicked, room
// gone, or signed in elsewhere). A transient drop / undefined reason → false.
export function isTerminalDisconnect(reason) {
  return LK_TERMINAL_DISCONNECTS.has(reason);
}

// Map a LiveKit disconnect reason to the endCall reason. Terminal reasons get a
// distinct tag (≠ "livekit-disconnected") so callers clear the rejoin marker;
// everything else stays "livekit-disconnected" (recoverable → eligible to rejoin,
// and the string that also fires on a logout unmount).
export function endReasonForDisconnect(reason) {
  return isTerminalDisconnect(reason) ? `livekit-${reason}` : "livekit-disconnected";
}
