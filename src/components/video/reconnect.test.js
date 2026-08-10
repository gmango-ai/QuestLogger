import { describe, it, expect } from "vitest";
import { endReasonForDisconnect } from "./PersistentVideoCall";

// endReasonForDisconnect maps a LiveKit DisconnectReason to the endCall reason,
// which is what decides whether the auto-rejoin marker survives:
//   • a TERMINAL reason → "livekit-<reason>" → endCall CLEARS the marker → no rejoin
//   • anything else      → "livekit-disconnected" → marker KEPT → bounded auto-rejoin
// Getting this wrong is the difference between "a network blip silently ejects me
// forever" and "hitting Leave keeps reconnecting me against my will", so pin it.
describe("endReasonForDisconnect — terminal vs recoverable", () => {
  it("a user pressing Leave (client_initiated) is terminal — must NOT auto-rejoin", () => {
    expect(endReasonForDisconnect("client_initiated")).toBe("livekit-client_initiated");
  });

  it.each([
    "duplicate_identity", // signed in elsewhere — that session wins
    "participant_removed", // moderation kick
    "room_deleted",
    "room_closed",
    "user_rejected",
  ])("%s is terminal (distinct tag → marker cleared)", (reason) => {
    expect(endReasonForDisconnect(reason)).toBe(`livekit-${reason}`);
    expect(endReasonForDisconnect(reason)).not.toBe("livekit-disconnected");
  });

  it.each([
    "signal_close",   // signalling dropped — a transient network drop
    "server_shutdown",
    "state_mismatch",
    "unknown",
    undefined,        // LiveKit sometimes reports no reason
  ])("%s is recoverable → 'livekit-disconnected' (marker kept, eligible to rejoin)", (reason) => {
    expect(endReasonForDisconnect(reason)).toBe("livekit-disconnected");
  });
});
