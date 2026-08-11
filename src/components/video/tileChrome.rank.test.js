import { describe, it, expect, vi } from "vitest";

// tileChrome.jsx imports React + LiveKit at module top-level; stub them so the pure
// helpers import under the node test env (same pattern as tileChrome.grid.test.js).
vi.mock("@livekit/components-react", () => ({
  ParticipantTile: () => null,
  useIsSpeaking: () => false,
  useConnectionQualityIndicator: () => ({ quality: "excellent" }),
}));
vi.mock("livekit-client", () => ({
  Track: { Source: { Camera: "camera", ScreenShare: "screen_share", Microphone: "microphone" } },
  ConnectionQuality: { Excellent: "excellent", Good: "good", Poor: "poor", Unknown: "unknown" },
}));

import { rankTiles, capFor } from "./tileChrome";

// Characterization tests for the tile ranking + grid-cap the redesigned layout depends on.
// rankTiles decides focus/ordering; capFor decides grid overflow. Both must not regress.

const cam = (id, muted = false) => ({
  source: "camera",
  participant: { identity: id, name: id, joinedAt: new Date() },
  publication: { isMuted: muted },
});
const screen = (id) => ({
  source: "screen_share",
  participant: { identity: id, name: id, joinedAt: new Date() },
  publication: { isMuted: false },
});

describe("rankTiles tiering", () => {
  it("orders screenshare > globalPin > pinnedTrackKey > featured/speaking > cam-on > cam-off", () => {
    const a = cam("a");
    const b = cam("b", true); // cam-off
    const c = cam("c");
    const d = cam("d");
    const s = screen("scr");
    const g = cam("g");
    const out = rankTiles([a, b, c, d, s, g], {
      featuredId: "c",
      speaking: [{ identity: "c" }],
      globalPinId: "g",
      pinnedTrackKey: "d:camera",
    });
    expect(out[0]).toBe(s); // screenshare
    expect(out[1]).toBe(g); // admin global pin
    expect(out[2]).toBe(d); // personal/pinned track
    expect(out[3]).toBe(c); // featured + speaking
    expect(out[out.length - 1]).toBe(b); // cam-off sinks to the bottom
  });

  it("treats an active speaker like a featured tile", () => {
    const a = cam("a");
    const b = cam("b");
    const out = rankTiles([a, b], { speaking: [{ identity: "b" }] });
    expect(out[0]).toBe(b);
  });

  it("is a stable, non-mutating sort within a tier", () => {
    const a = cam("a");
    const b = cam("b");
    const c = cam("c");
    const input = [c, a, b];
    const out = rankTiles(input, {});
    expect(out).toEqual([c, a, b]); // all cam-on: original order preserved
    expect(input).toEqual([c, a, b]); // input untouched
  });
});

describe("capFor", () => {
  it("returns 99 for a non-positive box", () => {
    expect(capFor(0, 0)).toBe(99);
    expect(capFor(-10, 500)).toBe(99);
  });

  it("returns a positive integer that grows with available space", () => {
    const small = capFor(600, 400);
    const big = capFor(1600, 1000);
    expect(Number.isInteger(small)).toBe(true);
    expect(small).toBeGreaterThanOrEqual(1);
    expect(big).toBeGreaterThanOrEqual(small);
  });

  it("caps fewer tiles when a larger minimum tile width is required", () => {
    const looseMin = capFor(1200, 800, 100);
    const tightMin = capFor(1200, 800, 300);
    expect(looseMin).toBeGreaterThanOrEqual(tightMin);
  });
});
