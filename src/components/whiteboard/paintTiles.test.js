import { describe, it, expect } from "vitest";
import { createPaintStore, evictTile, planTileFlush } from "./paintTiles";

// Fake tile — evictTile / planTileFlush only touch { key, dirty, canvas }.
const tile = (key, dirty = true) => ({ key, dirty, canvas: { width: 1024, height: 1024 } });

describe("planTileFlush — upload vs delete/evict split", () => {
  it("uploads a normal painted (dirty, not cleared) tile", () => {
    const { uploads, evict } = planTileFlush([tile("0_0")], null, () => false);
    expect(uploads.map((t) => t.key)).toEqual(["0_0"]);
    expect(evict).toEqual([]);
  });

  it("evicts a cleared tile that has no ink", () => {
    const cleared = new Set(["0_0"]);
    const { uploads, evict } = planTileFlush([tile("0_0")], cleared, () => false);
    expect(uploads).toEqual([]);
    expect(evict).toEqual(["0_0"]);
  });

  it("UPLOADS a cleared tile that still has ink (undo re-drew it) — never wrongly deleted", () => {
    const cleared = new Set(["0_0"]);
    const { uploads, evict } = planTileFlush([tile("0_0")], cleared, () => true);
    expect(uploads.map((t) => t.key)).toEqual(["0_0"]);
    expect(evict).toEqual([]);
  });

  it("an empty tile NOT marked cleared is uploaded, never evicted — protects an in-flight undo restore", () => {
    // `restore` removes its keys from clearedKeys, so a tile whose image redraw
    // hasn't landed yet (still empty) can't be mistaken for an empty clear.
    const { uploads, evict } = planTileFlush([tile("0_0")], new Set(["9_9"]), () => false);
    expect(uploads.map((t) => t.key)).toEqual(["0_0"]);
    expect(evict).toEqual([]);
  });

  it("skips non-dirty tiles and clears the dirty flag on processed ones", () => {
    const dirty = tile("1_1", true);
    const clean = tile("2_2", false);
    const { uploads } = planTileFlush([dirty, clean], null, () => false);
    expect(uploads.map((t) => t.key)).toEqual(["1_1"]);
    expect(dirty.dirty).toBe(false); // processed
    expect(clean.dirty).toBe(false); // untouched (was already false)
  });

  it("only scans emptiness for cleared tiles (hasInk not called for uncleared)", () => {
    let calls = 0;
    planTileFlush([tile("0_0"), tile("1_0")], new Set(["1_0"]), () => { calls += 1; return false; });
    expect(calls).toBe(1); // only the cleared tile is scanned
  });
});

describe("evictTile — releases the tile + its backing store", () => {
  it("removes the tile from the store and zeroes its canvas", () => {
    const store = createPaintStore();
    const t = tile("3_3");
    store.tiles.set("3_3", t);
    expect(evictTile(store, "3_3")).toBe(true);
    expect(store.tiles.has("3_3")).toBe(false);
    expect(t.canvas.width).toBe(0);
    expect(t.canvas.height).toBe(0);
  });

  it("returns false for an unknown key", () => {
    expect(evictTile(createPaintStore(), "nope")).toBe(false);
  });
});
