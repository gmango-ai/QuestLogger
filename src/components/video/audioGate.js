// Pure audio-gate decisions for the in-room ("I'm in this room") call — both the
// OUTGOING mic and the INCOMING room audio. Lifted out of PublishController /
// ClusterAudioRenderer so the anti-echo / anti-permanent-mute / anti-silence
// rules are unit-testable deterministically — no live LiveKit room and no two
// physical devices. A two-device scenario is just a sequence of calls at chosen
// timestamps.

export const ENTRY_FAILOPEN_MS = 6000;   // mirrors ClusterAudioRenderer's entry release
export const FOUNDER_SETTLE_MS = 1200;   // attribute-propagation window for co-located founders

// ── Outgoing mic ────────────────────────────────────────────────────────────
// Returns true when the local participant's microphone should be LIVE (publishing
// audio into the room). Wired into PublishController's mic-gating effect.
//
// Two fixes over the previous inline `wantAudio` expression (audioGate.test.js
// keeps a `legacyMicWant` reference to prove the buggy-vs-fixed contrast):
//   • #7 companion-mode PERMANENT MUTE — if the founding/join cluster write is
//     lost, the cluster attribute never lands, so `cluster` stays null and the
//     entry hold never releases → muted for the whole call. FAIL-OPEN after
//     ENTRY_FAILOPEN_MS. (Mirrors the incoming-audio side, which already does this.)
//   • #8 co-located ECHO — two simultaneous founders each become their own solo
//     mic source and both unmute until their attributes merge. FOUNDER SETTLE:
//     hold a fresh self-founded solo cluster's mic until a peer appears
//     (memberCount > 1) or FOUNDER_SETTLE_MS elapses.
export function computeMicLive({
  publish,
  micMuted,
  cluster = null,
  isMicSource = false,
  memberCount = 1,
  inRoom = false,
  clustered = false,
  entryHoldPending = false,
  entryStartedAt = null,
  foundedAt = null,
  now = 0,
  entryFailOpenMs = ENTRY_FAILOPEN_MS,
  founderSettleMs = FOUNDER_SETTLE_MS,
} = {}) {
  if (!publish || micMuted) return false;

  if (!cluster) {
    let hold = entryHoldPending || (inRoom && !clustered);
    if (hold && entryStartedAt != null && now - entryStartedAt >= entryFailOpenMs) hold = false;
    return !hold;
  }

  if (!isMicSource) return false;

  if (foundedAt != null && memberCount <= 1 && now - foundedAt < founderSettleMs) return false;

  return true;
}

// ── Incoming room audio ─────────────────────────────────────────────────────
// Returns true when the call's incoming audio should PLAY for this client. This
// is the single "muted" gate behind <RoomAudioRenderer> — the behaviour-preserving
// extraction of ClusterAudioRenderer's logic, so it can be regression-tested.
//
// `hold` is the resolved pre-cluster entry hold (entryHoldPending || (holdForEntry
// && !entered)); ClusterAudioRenderer already fails that open after ~6s so a
// listener is never left permanently silent.
//
// Deliberately depends ONLY on call/cluster state — never on whether the call is
// in Picture-in-Picture, popped out, or whether the whiteboard timer is playing.
// Those must not be able to flip this gate (that's what keeps call audio steady
// across PiP re-parenting and while the timer chimes).
export function shouldHearRoomAudio({ publish = true, listen = true, deafened = false, cluster = null, isAudioSink = false, hold = false }) {
  const isFollower = (!!cluster && !isAudioSink) || (hold && !cluster);
  return (publish || listen) && !deafened && !isFollower;
}
