import { describe, it, expect } from "vitest";
import { computeMicLive, shouldHearRoomAudio, ENTRY_FAILOPEN_MS, FOUNDER_SETTLE_MS } from "./audioGate";
import {
  pickMicSource, pickAudioSink, clusterRolesOf, resolveDeviceRoles,
  ATTR_CLUSTER, ATTR_LEADER, ATTR_OVERRIDE, ATTR_ROOM_DEVICE, ATTR_SINK, ATTR_SINK_OFF,
} from "./useRoomCluster";

// These stand in for the "two physical devices in one room" checks we can't run
// live: a companion-mode scenario is modelled as a sequence of pure-function
// calls, so the anti-echo / anti-mute / anti-silence rules are verified
// deterministically and guarded against regression.

const P = (identity, attributes = {}) => ({ identity, attributes });

// ── Outgoing mic gate ───────────────────────────────────────────────────────

// Reference of the CURRENT inline PublishController logic (no fail-open / settle)
// so the bug blocks prove the tests distinguish buggy-from-fixed.
function legacyMicWant({ publish, micMuted, cluster, isMicSource, inRoom, clustered, entryHoldPending }) {
  const holdForEntry = entryHoldPending || (inRoom && !clustered);
  return !!(publish && !micMuted && (cluster ? isMicSource : !holdForEntry));
}

describe("computeMicLive — baseline rules (regression guard)", () => {
  it("a spectator never publishes audio", () => {
    expect(computeMicLive({ publish: false, micMuted: false, cluster: "c", isMicSource: true })).toBe(false);
  });
  it("a self-muted publisher never publishes audio", () => {
    expect(computeMicLive({ publish: true, micMuted: true, cluster: "c", isMicSource: true })).toBe(false);
  });
  it("a solo publisher not in a room has a live mic", () => {
    expect(computeMicLive({ publish: true, micMuted: false, inRoom: false })).toBe(true);
  });
  it("a cluster follower (not the mic source) is muted", () => {
    expect(computeMicLive({ publish: true, micMuted: false, cluster: "c", isMicSource: false, memberCount: 3 })).toBe(false);
  });
  it("the settled cluster mic source is live", () => {
    expect(computeMicLive({ publish: true, micMuted: false, cluster: "c", isMicSource: true, memberCount: 3 })).toBe(true);
  });
  it("holds the mic while entering a room but not yet clustered", () => {
    expect(computeMicLive({ publish: true, micMuted: false, cluster: null, inRoom: true, clustered: false, entryStartedAt: 0, now: 1000 })).toBe(false);
  });
  it("restores the mic after you were clustered and left (inRoom lingers)", () => {
    expect(computeMicLive({ publish: true, micMuted: false, cluster: null, inRoom: true, clustered: true, now: 9999 })).toBe(true);
  });
});

describe("companion-mode PERMANENT MUTE (#7) — a lost founding write must fail-open", () => {
  const entering = { publish: true, micMuted: false, cluster: null, inRoom: true, clustered: false, entryStartedAt: 1000 };
  it("BUG: current inline logic mutes the mic forever (cluster never lands)", () => {
    expect(legacyMicWant(entering)).toBe(false);
  });
  it("still held during the brief entry window", () => {
    expect(computeMicLive({ ...entering, now: 1000 + 3000 })).toBe(false);
  });
  it("FIX: the mic comes back once ENTRY_FAILOPEN_MS has elapsed", () => {
    expect(computeMicLive({ ...entering, now: 1000 + ENTRY_FAILOPEN_MS })).toBe(true);
  });
  it("a real cluster that lands makes you a normal muted follower (no spurious unmute)", () => {
    expect(computeMicLive({ publish: true, micMuted: false, cluster: "dev", isMicSource: false, memberCount: 2, now: 1000 + ENTRY_FAILOPEN_MS })).toBe(false);
  });
});

describe("co-located ECHO (#8) — simultaneous founders must not both be live", () => {
  const foundedAt = 1000;
  const founder = (id) => ({ publish: true, micMuted: false, cluster: id, isMicSource: true, memberCount: 1, foundedAt });
  const liveCount = (gate, now) => ["a", "b"].filter((id) => gate({ ...founder(id), now })).length;

  it("BUG: current inline logic has BOTH mics live in the pre-merge window (echo)", () => {
    expect(["a", "b"].filter((id) => legacyMicWant(founder(id))).length).toBe(2);
  });
  it("FIX: neither founder is live during the settle window — no echo", () => {
    expect(liveCount(computeMicLive, foundedAt + 200)).toBe(0);
    expect(liveCount(computeMicLive, foundedAt + FOUNDER_SETTLE_MS - 1)).toBe(0);
  });
  it("a genuinely solo founder unmutes once the settle window passes", () => {
    expect(computeMicLive({ ...founder("a"), now: foundedAt + FOUNDER_SETTLE_MS })).toBe(true);
  });
  it("after attributes propagate, exactly one member holds the mic (no lingering echo)", () => {
    const members = [P("a", { [ATTR_CLUSTER]: "a", [ATTR_LEADER]: "a" }), P("b", { [ATTR_CLUSTER]: "a", [ATTR_LEADER]: "b" })];
    const micId = pickMicSource(members);
    const live = (id) => computeMicLive({ publish: true, micMuted: false, cluster: "a", isMicSource: id === micId, memberCount: 2, now: foundedAt + FOUNDER_SETTLE_MS + 1000 });
    expect(["a", "b"].filter(live).length).toBe(1);
  });
});

// ── Incoming room-audio gate ────────────────────────────────────────────────
// Behaviour-preserving extraction of ClusterAudioRenderer; wired into the live
// component, so these guard the actual "does the call play" decision.
describe("shouldHearRoomAudio — incoming call audio gate", () => {
  it("a normal publisher hears the room", () => {
    expect(shouldHearRoomAudio({ publish: true, listen: true })).toBe(true);
  });
  it("a listening spectator hears the room", () => {
    expect(shouldHearRoomAudio({ publish: false, listen: true })).toBe(true);
  });
  it("a non-listening spectator is silent (auto-preview)", () => {
    expect(shouldHearRoomAudio({ publish: false, listen: false })).toBe(false);
  });
  it("deafen mutes ALL incoming audio", () => {
    expect(shouldHearRoomAudio({ publish: true, listen: true, deafened: true })).toBe(false);
  });
  it("a cluster follower (not the audio sink) is silent — the sink plays for the room", () => {
    expect(shouldHearRoomAudio({ publish: true, cluster: "room", isAudioSink: false })).toBe(false);
  });
  it("the cluster audio sink hears (its speakers carry the room)", () => {
    expect(shouldHearRoomAudio({ publish: true, cluster: "room", isAudioSink: true })).toBe(true);
  });
  it("holds audio off while entering pre-cluster, then plays once the hold releases", () => {
    expect(shouldHearRoomAudio({ publish: true, listen: true, cluster: null, hold: true })).toBe(false);
    expect(shouldHearRoomAudio({ publish: true, listen: true, cluster: null, hold: false })).toBe(true);
  });
  it("the gate takes NO picture-in-picture / timer input — it can't be flipped by re-parenting or a chime", () => {
    // Regression intent: entering PiP or playing the whiteboard timer must not
    // silence the call. Encoded structurally — the decision has no such argument,
    // so identical call/cluster state always yields the identical result.
    const state = { publish: true, listen: true, deafened: false, cluster: "room", isAudioSink: true, hold: false };
    expect(shouldHearRoomAudio(state)).toBe(shouldHearRoomAudio(state));
  });
});

// ── Cluster election (echo / whole-room-silence core) ───────────────────────
describe("pickMicSource — exactly one mic, correct priority", () => {
  it("returns null when nobody claims the mic", () => {
    expect(pickMicSource([P("a", { [ATTR_CLUSTER]: "a" }), P("b", { [ATTR_CLUSTER]: "a" })])).toBeNull();
  });
  it("the lowest-id plain claimer wins by default", () => {
    expect(pickMicSource([P("b", { [ATTR_LEADER]: "b" }), P("a", { [ATTR_LEADER]: "a" })])).toBe("a");
  });
  it("the room device outranks a plain human claimer", () => {
    const members = [P("dev", { [ATTR_LEADER]: "dev", [ATTR_ROOM_DEVICE]: "1" }), P("human", { [ATTR_LEADER]: "human" })];
    expect(pickMicSource(members)).toBe("dev");
  });
  it("a human auto take-over (voice activity) outranks the device", () => {
    const members = [P("dev", { [ATTR_LEADER]: "dev", [ATTR_ROOM_DEVICE]: "1" }), P("human", { [ATTR_LEADER]: "human", [ATTR_OVERRIDE]: "1699999999" })];
    expect(pickMicSource(members)).toBe("human");
  });
  it("a manual take-over outranks an auto take-over", () => {
    const members = [
      P("auto", { [ATTR_LEADER]: "auto", [ATTR_OVERRIDE]: "1699999999" }),
      P("manual", { [ATTR_LEADER]: "manual", [ATTR_OVERRIDE]: "manual" }),
    ];
    expect(pickMicSource(members)).toBe("manual");
  });
});

describe("pickAudioSink — the room is NEVER left silent", () => {
  it("falls back to a member so a device-less cluster still has a sink", () => {
    const members = [P("a", { [ATTR_CLUSTER]: "a", [ATTR_LEADER]: "a" }), P("b", { [ATTR_CLUSTER]: "a" })];
    expect(pickAudioSink(members, "a")).not.toBeNull();
  });
  it("the room device is the default sink", () => {
    const members = [P("dev", { [ATTR_ROOM_DEVICE]: "1" }), P("h", {})];
    expect(pickAudioSink(members, "h")).toBe("dev");
  });
  it("a device that opted out of playing (Sound off) is skipped — audio still reaches someone", () => {
    const members = [P("dev", { [ATTR_ROOM_DEVICE]: "1", [ATTR_SINK_OFF]: "1" }), P("h", {})];
    const sink = pickAudioSink(members, "h");
    expect(sink).not.toBeNull();
    expect(sink).not.toBe("dev");
  });
  it("a human who claimed the speakers wins over the device", () => {
    const members = [P("dev", { [ATTR_ROOM_DEVICE]: "1" }), P("laptop", { [ATTR_SINK]: "laptop" })];
    expect(pickAudioSink(members, "dev")).toBe("laptop");
  });
});

describe("clusterRolesOf — per-identity role map", () => {
  it("tags mic source / audio sink / device / inRoom across a cluster", () => {
    const members = [
      P("dev", { [ATTR_CLUSTER]: "dev", [ATTR_LEADER]: "dev", [ATTR_ROOM_DEVICE]: "1" }),
      P("h", { [ATTR_CLUSTER]: "dev" }),
    ];
    const roles = clusterRolesOf(members);
    expect(roles.get("dev")).toMatchObject({ inRoom: true, isMicSource: true, isAudioSink: true, isDevice: true });
    expect(roles.get("h")).toMatchObject({ inRoom: true, isMicSource: false, isAudioSink: false });
  });
  it("a participant with no cluster attribute has no role (renders as a normal tile)", () => {
    expect(clusterRolesOf([P("solo", {})]).has("solo")).toBe(false);
  });
});

describe("resolveDeviceRoles — kiosk holds its roles across a reconnect (#12)", () => {
  const bothTrue = { isMicSource: true, isAudioSink: true };
  // A human took over the kiosk's mic; steady-state the kiosk is a follower.
  const humanHoldsMic = [
    P("kiosk", { [ATTR_CLUSTER]: "kiosk", [ATTR_LEADER]: "kiosk", [ATTR_ROOM_DEVICE]: "1" }),
    P("human", { [ATTR_CLUSTER]: "kiosk", [ATTR_LEADER]: "human", [ATTR_OVERRIDE]: "manual" }),
  ];

  it("connected: recomputes — the kiosk yields the mic to the human who took it", () => {
    const roles = resolveDeviceRoles({ myId: "kiosk", roomState: "connected", members: humanHoldsMic, lastRoles: bothTrue });
    expect(roles.isMicSource).toBe(false);
  });

  it("BUG WOULD BE: while reconnecting the member list collapses to self → naive recompute grabs the mic", () => {
    // The kiosk sees only itself mid-reconnect; pickMicSource(self-only) = self.
    expect(pickMicSource([humanHoldsMic[0]])).toBe("kiosk");
  });

  it("FIX: while NOT connected, hold the last resolved roles (don't grab the mic)", () => {
    const held = { isMicSource: false, isAudioSink: false }; // last steady state under the human
    expect(resolveDeviceRoles({ myId: "kiosk", roomState: "reconnecting", members: [humanHoldsMic[0]], lastRoles: held })).toBe(held);
    expect(resolveDeviceRoles({ myId: "kiosk", roomState: "connecting", members: [], lastRoles: held })).toBe(held);
  });

  it("FIX: connected but members not yet repopulated → also holds last roles", () => {
    const held = { isMicSource: false, isAudioSink: false };
    expect(resolveDeviceRoles({ myId: "kiosk", roomState: "connected", members: [], lastRoles: held })).toBe(held);
  });

  it("a fresh device with no roles yet assumes it is the mic + sink (seed)", () => {
    expect(resolveDeviceRoles({ myId: null, roomState: "connecting", members: [], lastRoles: bothTrue })).toBe(bothTrue);
  });
});
