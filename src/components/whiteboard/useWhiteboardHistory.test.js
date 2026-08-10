import { describe, it, expect } from "vitest";
import { applyReverts, restoreFields } from "./useWhiteboardHistory";

// Undo/redo is multiplayer-safe: it must never clobber a teammate's concurrent
// edit to the SAME node. The bug was a whole-entity restore — undoing MY change
// to one field of a node also reverted a peer's change to another field. These
// tests pin the field-level restore that fixes it, with a legacy reference that
// proves the whole-entity approach exhibited the bug.

// The previous whole-entity restore, for contrast.
function legacyApplyReverts(list, entries, side) {
  const map = new Map(list.map((x) => [x.id, x]));
  for (const e of entries) {
    const target = e[side];
    if (target == null) map.delete(e.id);
    else map.set(e.id, { ...target, selected: true });
  }
  return [...map.values()];
}

describe("applyReverts — single-user undo/redo still works", () => {
  it("undo restores the field I changed", () => {
    const entry = { id: "x", before: { id: "x", position: { x: 0, y: 0 }, data: { text: "t" } }, after: { id: "x", position: { x: 5, y: 5 }, data: { text: "t" } } };
    const live = [{ id: "x", position: { x: 5, y: 5 }, data: { text: "t" } }];
    const [n] = applyReverts(live, [entry], "before", false);
    expect(n.position).toEqual({ x: 0, y: 0 });
    expect(n.selected).toBe(true);
  });

  it("redo re-applies it", () => {
    const entry = { id: "x", before: { id: "x", position: { x: 0, y: 0 }, data: { text: "t" } }, after: { id: "x", position: { x: 5, y: 5 }, data: { text: "t" } } };
    const live = [{ id: "x", position: { x: 0, y: 0 }, data: { text: "t" } }];
    const [n] = applyReverts(live, [entry], "after", false);
    expect(n.position).toEqual({ x: 5, y: 5 });
  });

  it("undo of an ADD removes the node; undo of a DELETE restores it whole", () => {
    const added = { id: "a", before: null, after: { id: "a", position: { x: 1, y: 1 } } };
    expect(applyReverts([{ id: "a", position: { x: 1, y: 1 } }], [added], "before", false)).toHaveLength(0);
    const deleted = { id: "d", before: { id: "d", position: { x: 2, y: 2 }, data: { text: "k" } }, after: null };
    const [restored] = applyReverts([], [deleted], "before", false);
    expect(restored).toMatchObject({ id: "d", position: { x: 2, y: 2 }, data: { text: "k" } });
  });
});

describe("applyReverts — concurrent peer edit survives an undo (#3)", () => {
  // I moved node X (position). Concurrently a PEER edited X's text; the live node
  // therefore has my position AND the peer's text.
  const myMove = {
    id: "x",
    before: { id: "x", position: { x: 0, y: 0 }, data: { text: "orig", locked: false } },
    after: { id: "x", position: { x: 5, y: 5 }, data: { text: "orig", locked: false } },
  };
  const liveWithPeerText = [{ id: "x", position: { x: 5, y: 5 }, data: { text: "PEER", locked: false } }];

  it("BUG: the whole-entity restore wipes the peer's text back to 'orig'", () => {
    const [n] = legacyApplyReverts(liveWithPeerText, [myMove], "before");
    expect(n.data.text).toBe("orig"); // teammate's edit lost
  });

  it("FIX: undoing my move reverts ONLY position; the peer's text survives", () => {
    const [n] = applyReverts(liveWithPeerText, [myMove], "before", false);
    expect(n.position).toEqual({ x: 0, y: 0 }); // my change undone
    expect(n.data.text).toBe("PEER");           // peer's change kept
  });

  it("FIX: a nested-data change (lock) undoes without wiping a peer's other data field", () => {
    // I toggled data.locked false→true; peer changed data.text. Live has both.
    const myLock = {
      id: "y",
      before: { id: "y", data: { text: "orig", locked: false } },
      after: { id: "y", data: { text: "orig", locked: true } },
    };
    const live = [{ id: "y", data: { text: "PEER", locked: true } }];
    const [n] = applyReverts(live, [myLock], "before", false);
    expect(n.data.locked).toBe(false); // my lock undone
    expect(n.data.text).toBe("PEER");  // peer's text kept (whole-entity/whole-data restore would lose this)
  });

  it("falls back to a whole restore if the node was concurrently deleted", () => {
    const [n] = applyReverts([], [myMove], "before", false);
    expect(n).toMatchObject({ id: "x", position: { x: 0, y: 0 } });
  });
});

describe("restoreFields — leaves keys this step did not change", () => {
  it("keeps a key present only on the live entity (peer-added field)", () => {
    const cur = { id: "n", position: { x: 5, y: 5 }, peerField: "keep" };
    const before = { id: "n", position: { x: 0, y: 0 } };
    const after = { id: "n", position: { x: 5, y: 5 } };
    const out = restoreFields(cur, before, after, before);
    expect(out.position).toEqual({ x: 0, y: 0 });
    expect(out.peerField).toBe("keep");
  });
});
