import { describe, it, expect } from "vitest";
import { bestGrid, solveLayout } from "./layoutSolver";

// Characterization tests: lock the CURRENT behavior of the pure layout math so the
// call-layout redesign (a new planner that reuses/replaces these) can't silently
// change how tiles are sized or where the focus goes. See docs/plans/call-layout-redesign.md.

describe("bestGrid", () => {
  it("degenerates safely for non-positive input", () => {
    expect(bestGrid(0, 1000, 600, 16 / 9, 8)).toEqual({ cols: 1, tileW: 0, tileH: 0 });
    expect(bestGrid(4, 0, 600, 16 / 9, 8)).toEqual({ cols: 1, tileW: 0, tileH: 0 });
    expect(bestGrid(4, 1000, 0, 16 / 9, 8)).toEqual({ cols: 1, tileW: 0, tileH: 0 });
  });

  it("returns {cols,tileW,tileH,area}, keeps ~16:9 cells, and fits inside the box", () => {
    const g = bestGrid(4, 1000, 600, 16 / 9, 8);
    expect(g.cols).toBeGreaterThanOrEqual(1);
    expect(g.tileW).toBeGreaterThan(0);
    expect(g.tileH).toBeGreaterThan(0);
    expect(g.area).toBeGreaterThan(0);
    expect(g.tileW / g.tileH).toBeCloseTo(16 / 9, 1);
    const rows = Math.ceil(4 / g.cols);
    expect(g.cols * g.tileW + (g.cols - 1) * 8).toBeLessThanOrEqual(1000 + 0.5);
    expect(rows * g.tileH + (rows - 1) * 8).toBeLessThanOrEqual(600 + 0.5);
  });

  it("uses one column for a single tile and two columns for four in a wide box", () => {
    expect(bestGrid(1, 1000, 600, 16 / 9, 8).cols).toBe(1);
    expect(bestGrid(4, 1200, 500, 16 / 9, 8).cols).toBe(2);
  });

  it("never shrinks the chosen tile when more area is available", () => {
    const small = bestGrid(6, 800, 500, 16 / 9, 8);
    const big = bestGrid(6, 1600, 1000, 16 / 9, 8);
    expect(big.area).toBeGreaterThanOrEqual(small.area);
  });
});

describe("solveLayout", () => {
  const isRect = (r) => ["x", "y", "w", "h"].every((k) => typeof r[k] === "number");
  const area = (r) => r.w * r.h;

  it("returns an empty map for empty tiles or a zero-size box", () => {
    expect(solveLayout({ tiles: [], width: 800, height: 600 }).size).toBe(0);
    expect(solveLayout({ tiles: ["a"], width: 0, height: 600 }).size).toBe(0);
    expect(solveLayout({ tiles: ["a"], width: 800, height: 0 }).size).toBe(0);
  });

  it("places one {x,y,w,h} rect per tile key", () => {
    const m = solveLayout({ tiles: ["a", "b", "c"], width: 900, height: 600 });
    expect(m.size).toBe(3);
    for (const k of ["a", "b", "c"]) {
      expect(m.has(k)).toBe(true);
      expect(isRect(m.get(k))).toBe(true);
      expect(m.get(k).w).toBeGreaterThan(0);
    }
  });

  it("gives a single focus tile more area than the rest", () => {
    const m = solveLayout({ tiles: ["a", "b", "c"], focusKey: "a", width: 1600, height: 500 });
    expect(area(m.get("a"))).toBeGreaterThan(area(m.get("b")));
    expect(area(m.get("a"))).toBeGreaterThan(area(m.get("c")));
  });

  it("lets focusKeys (dual) win over focusKey and makes both foci large", () => {
    const m = solveLayout({ tiles: ["a", "b", "c"], focusKey: "c", focusKeys: ["a", "b"], width: 1600, height: 500 });
    expect(area(m.get("a"))).toBeGreaterThan(area(m.get("c")));
    expect(area(m.get("b"))).toBeGreaterThan(area(m.get("c")));
  });

  it("fills most of the stage for a lone focus tile", () => {
    const m = solveLayout({ tiles: ["a"], focusKey: "a", width: 800, height: 600 });
    expect(area(m.get("a"))).toBeGreaterThan(0.5 * 800 * 600);
  });

  it("ignores a focus key that is not among the tiles (falls back to an even grid)", () => {
    const m = solveLayout({ tiles: ["a", "b"], focusKey: "zzz", width: 800, height: 600 });
    expect(Math.abs(area(m.get("a")) - area(m.get("b")))).toBeLessThan(1);
  });
});
