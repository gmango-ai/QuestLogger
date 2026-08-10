import { describe, it, expect } from "vitest";
import { isPersisterId, stripLocal } from "./useWhiteboardSync";

// Single-writer election: exactly one client (the lowest client-id present)
// persists the board to the DB. This is the retro-brownout fix — N concurrent
// editors must collapse to ONE writer.
describe("isPersisterId — single-writer election", () => {
  it("a lone editor (no other members) is always the persister", () => {
    expect(isPersisterId("c-5", [])).toBe(true);
  });

  it("the lowest client-id present is the persister", () => {
    expect(isPersisterId("a", ["b", "c", "d"])).toBe(true);
  });

  it("a non-lowest client is NOT the persister", () => {
    expect(isPersisterId("m", ["a", "z"])).toBe(false);
    expect(isPersisterId("z", ["a", "b"])).toBe(false);
  });

  it("exactly one of N members is the persister (no ties, no gaps)", () => {
    const ids = ["d1f8", "a3c0", "9bb2", "f100", "0aa1"];
    const winners = ids.filter((me) => isPersisterId(me, ids.filter((x) => x !== me)));
    expect(winners).toEqual(["0aa1"]); // the single lexicographically-lowest id
    expect(winners).toHaveLength(1);
  });

  it("handles UUID-shaped ids deterministically", () => {
    const a = "11111111-1111-1111-1111-111111111111";
    const b = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(isPersisterId(a, [b])).toBe(true);
    expect(isPersisterId(b, [a])).toBe(false);
  });
});

// What's broadcast to peers must carry the SHARED graph but drop per-user UI
// state. The critical invariant: a node's lock (draggable:false + data.locked)
// MUST survive the strip — dropping `draggable` was the frame-lock-loss bug,
// where a synced/resync'd node came back movable.
describe("stripLocal — broadcast payload keeps shared state, drops local UI state", () => {
  it("drops selected / dragging / resizing", () => {
    const out = stripLocal({ id: "n1", selected: true, dragging: true, resizing: true, type: "shape" });
    expect(out).not.toHaveProperty("selected");
    expect(out).not.toHaveProperty("dragging");
    expect(out).not.toHaveProperty("resizing");
    expect(out).toMatchObject({ id: "n1", type: "shape" });
  });

  it("PRESERVES a locked node's lock (draggable:false + data.locked) — frame-lock guard", () => {
    const locked = { id: "frame1", type: "frame", draggable: false, data: { locked: true, label: "Plan" }, selected: true, dragging: false };
    const out = stripLocal(locked);
    expect(out.draggable).toBe(false);      // the actual drag-block must sync
    expect(out.data).toEqual({ locked: true, label: "Plan" }); // and the resizer-hide flag
    expect(out).not.toHaveProperty("selected");
  });

  it("PRESERVES geometry + identity (position / measured / parentId / width / height)", () => {
    const node = { id: "n2", type: "sticky", position: { x: 10, y: 20 }, width: 200, height: 120, parentId: "f1", measured: { width: 200, height: 120 }, data: { text: "hi" } };
    expect(stripLocal(node)).toEqual(node); // nothing shared was dropped
  });

  it("does not mutate the input", () => {
    const node = { id: "n3", selected: true, data: { locked: true } };
    stripLocal(node);
    expect(node.selected).toBe(true); // original untouched
  });
});
