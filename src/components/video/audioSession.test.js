import { describe, it, expect, beforeAll } from "vitest";

// The two behaviours the user cares about — call audio surviving a Picture-in-
// Picture / pop-out re-parent, and the whiteboard timer music playing/stopping
// without cutting the call — are ultimately browser behaviours we can't fully
// reproduce in node. But both rest on invariants in getAudioContext() /
// getLkRoomOptions() whose violation is the ONLY realistic way they regress:
//
//  • PiP survival: the call mixes ALL remote audio through ONE Web Audio graph on
//    the shared AudioContext (webAudioMix is an OBJECT, not the boolean `true`),
//    so there are no per-track <audio> DOM elements to pause when the call host
//    is re-parented.
//  • Timer coexistence: every audio feature (call mix, pomodoro/ambience chimes,
//    whiteboard timer) shares that ONE never-closed AudioContext — passing an
//    object (vs boolean) stops LiveKit from close()-ing it on call teardown, and
//    the singleton keeps the app well under the browser's ~6-context cap and on a
//    single audio session, so a chime can't knock out the call.
//
// A minimal AudioContext stub lets us assert those invariants in the node env.

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.sampleRate = 48000;
    this.destination = {};
    this.closed = false;
    FakeAudioContext.instances += 1;
  }
  resume() { this.state = "running"; return Promise.resolve(); }
  createBuffer() { return {}; }
  createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {} }; }
  createGain() { return { gain: { value: 0 }, connect() {} }; }
  close() { this.closed = true; this.state = "closed"; return Promise.resolve(); }
}
FakeAudioContext.instances = 0;

beforeAll(() => {
  globalThis.window = globalThis.window || {};
  globalThis.window.AudioContext = FakeAudioContext;
});

describe("shared AudioContext — one, stable, resumable, never closed", () => {
  it("is a singleton: repeated getAudioContext() calls return the SAME instance", async () => {
    const { getAudioContext } = await import("../../lib/audioContext");
    const a = getAudioContext();
    const b = getAudioContext();
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    // Exactly one context exists app-wide — the whole point (browser ~6 cap, one
    // audio session shared with the LiveKit call).
    expect(FakeAudioContext.instances).toBe(1);
  });

  it("resumes a context the browser parked in 'suspended' (autoplay recovery)", async () => {
    const { getAudioContext } = await import("../../lib/audioContext");
    const c = getAudioContext();
    c.state = "suspended";
    const c2 = getAudioContext();
    expect(c2).toBe(c);
    expect(c2.state).toBe("running");
  });

  it("getAudioContext never close()s the shared context (chimes + call keep working)", async () => {
    const { getAudioContext, warmupAudioContext } = await import("../../lib/audioContext");
    const c = getAudioContext();
    await warmupAudioContext();
    getAudioContext();
    expect(c.closed).toBe(false);
  });
});

describe("LiveKit room options — webAudioMix keeps call audio PiP-immune + on the shared session", () => {
  it("mixes remote audio through the shared AudioContext (object form, not boolean `true`)", async () => {
    const { getAudioContext } = await import("../../lib/audioContext");
    const { getLkRoomOptions } = await import("./livekitConnect");
    const opts = getLkRoomOptions();
    // Regression guard for BOTH scenarios: an object with our shared context means
    // (a) no per-track <audio> elements to pause on re-parent → survives PiP, and
    // (b) LiveKit won't close() our context on teardown → timer/chimes keep working.
    expect(opts.webAudioMix).not.toBe(true);
    expect(typeof opts.webAudioMix).toBe("object");
    expect(opts.webAudioMix.audioContext).toBe(getAudioContext());
  });

  it("returns a STABLE cached options object (so the Room isn't recreated each render)", async () => {
    const { getLkRoomOptions } = await import("./livekitConnect");
    expect(getLkRoomOptions()).toBe(getLkRoomOptions());
  });
});
