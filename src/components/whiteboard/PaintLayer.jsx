import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ViewportPortal } from "@xyflow/react";
import { createPaintStore, applyPaintChunk, ensureTile, reapStaleStrokes, evictTile, tileHasInk, planTileFlush, TILE_UNITS, TILE_PX, PX_PER_UNIT } from "./paintTiles";
import { listPaintTiles, uploadPaintTile, deletePaintTiles } from "../../lib/whiteboardPaint";

const FLUSH_DELAY_MS = 2000; // idle time before dirty tiles are saved to Storage

// Renders the tiled raster paint layer inside the flow viewport. Each live tile
// is a persistent <canvas> (held by the store) that this component adopts into
// a positioned wrapper — so panning/zooming is free (the viewport transform
// scales it) and the pixels survive a tile scrolling in and out of the tree.
//
// Drawing is imperative: the page (and incoming peer strokes) call apply(chunk)
// via the ref; new tiles bump a counter so their canvas mounts. Locally-drawn
// tiles are flushed to Storage on an idle debounce; on open the board's tiles
// are listed and drawn back in. Pointer-events are off so the layer never
// blocks the canvas underneath.
function TileView({ tile }) {
  return (
    <div
      style={{
        position: "absolute",
        left: tile.tx * TILE_UNITS,
        top: tile.ty * TILE_UNITS,
        width: TILE_UNITS,
        height: TILE_UNITS,
        pointerEvents: "none",
      }}
      ref={(el) => { if (el && tile.canvas.parentNode !== el) el.appendChild(tile.canvas); }}
    />
  );
}

const PaintLayer = forwardRef(function PaintLayer({ boardId, enabled, zIndex = 5 }, ref) {
  const [, force] = useState(0);
  const bump = useCallback(() => force((n) => (n + 1) & 0xffff), []);
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = createPaintStore(bump);

  const boardRef = useRef(boardId);
  boardRef.current = boardId;
  const flushTimer = useRef(0);

  // Save every dirty tile as a PNG (debounced). Idempotent upsert — last write
  // wins, and since every client renders identical pixels they converge. Tiles a
  // clear op wiped (store.clearedKeys) that are now empty are instead DELETED from
  // Storage + evicted from memory, so blank tiles don't accumulate for the whole
  // session or re-materialise on reload. The emptiness check runs only for those
  // cleared tiles, so normal painting never pays a scan; and it's content-based
  // at flush time, so an undo that re-drew a cleared tile is uploaded, not deleted.
  const doFlush = useCallback(() => {
    flushTimer.current = 0;
    const bId = boardRef.current;
    if (!bId) return;
    const store = storeRef.current;
    const { uploads, evict } = planTileFlush(store.tiles.values(), store.clearedKeys, tileHasInk);
    store.clearedKeys = null;
    for (const tile of uploads) {
      // toBlob throws on a tainted canvas — guard so one bad tile can't abort
      // the whole flush (crossOrigin loads should keep it untainted anyway).
      try {
        tile.canvas.toBlob((blob) => { if (blob) uploadPaintTile(bId, tile.key, blob); }, "image/png");
      } catch { /* */ }
    }
    if (evict.length) {
      deletePaintTiles(bId, evict).catch(() => { /* best-effort */ });
      for (const key of evict) evictTile(store, key);
      bump();
    }
  }, [bump]);
  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(doFlush, FLUSH_DELAY_MS);
  }, [doFlush]);

  useImperativeHandle(ref, () => ({
    // `local` strokes are mine → schedule a save; remote strokes are persisted
    // by their own author, so they only need rasterising.
    apply: (chunk, local) => {
      applyPaintChunk(storeRef.current, chunk);
      if (local) scheduleFlush();
    },
    // Undo support: capture the current pixels of the given tile keys into a
    // map (key → PNG dataURL, or null if the tile doesn't exist yet = empty).
    // Skips keys already present so a stroke only records each tile's PRE-state
    // once. Guarded against tainted canvases.
    snapshot: (keys, into) => {
      const map = into || new Map();
      for (const key of keys) {
        if (map.has(key)) continue;
        const tile = storeRef.current.tiles.get(key);
        let url = null;
        if (tile) { try { url = tile.canvas.toDataURL("image/png"); } catch { url = null; } }
        map.set(key, url);
      }
      return map;
    },
    // Restore tiles to a snapshot (undo/redo). null = wipe the tile back to
    // empty. Marks dirty + schedules a save so the restore persists.
    restore: (map) => {
      if (!map) return;
      for (const [key, url] of map) {
        // This tile is being RESTORED (undo of a clear), not cleared — drop it
        // from clearedKeys so a flush that lands before the async image redraw
        // can't mistake it for an empty clear and delete+evict it (losing the
        // undo). It re-uploads with real pixels once the image lands.
        if (storeRef.current.clearedKeys) storeRef.current.clearedKeys.delete(key);
        const [tx, ty] = key.split("_").map(Number);
        const tile = ensureTile(storeRef.current, tx, ty);
        const ctx = tile.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, TILE_PX, TILE_PX);
        tile.dirty = true;
        if (url) {
          const img = new Image();
          img.onload = () => {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            ctx.clearRect(0, 0, TILE_PX, TILE_PX);
            ctx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
            bump();
          };
          img.src = url;
        }
      }
      bump();
      scheduleFlush();
    },
    // Keys of every live tile — used to snapshot the whole layer before a clear.
    allTileKeys: () => [...storeRef.current.tiles.keys()],
    // Wipe every tile (Clear-all drawings). Undo is handled by the caller via
    // snapshot()/restore() of allTileKeys().
    clearAll: () => {
      const store = storeRef.current;
      store.clearedKeys = store.clearedKeys || new Set();
      for (const tile of store.tiles.values()) {
        const ctx = tile.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, TILE_PX, TILE_PX);
        tile.dirty = true;
        store.clearedKeys.add(tile.key); // flush will evict any that stay empty
      }
      bump();
      scheduleFlush();
    },
    // ── Region select (move/delete raster paint) ──────────────────────────
    // Composite the pixels inside a flow-space rect into a fresh canvas (device
    // px). The lifted raster selection. null-safe on empty tiles. `clip` (array
    // of flow-space {x,y}, a polygon) restricts the lift to a lasso shape.
    readRegion: ({ x, y, w, h }, clip) => {
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(w * PX_PER_UNIT));
      out.height = Math.max(1, Math.round(h * PX_PER_UNIT));
      const octx = out.getContext("2d");
      if (clip && clip.length >= 3) {
        octx.beginPath();
        clip.forEach((p, i) => {
          const cx = (p.x - x) * PX_PER_UNIT, cy = (p.y - y) * PX_PER_UNIT;
          if (i) octx.lineTo(cx, cy); else octx.moveTo(cx, cy);
        });
        octx.closePath();
        octx.clip(); // only the polygon interior gets composited
      }
      const t0x = Math.floor(x / TILE_UNITS), t1x = Math.floor((x + w) / TILE_UNITS);
      const t0y = Math.floor(y / TILE_UNITS), t1y = Math.floor((y + h) / TILE_UNITS);
      for (let ty = t0y; ty <= t1y; ty++) for (let tx = t0x; tx <= t1x; tx++) {
        const tile = storeRef.current.tiles.get(`${tx}_${ty}`);
        if (!tile) continue;
        const ox = tx * TILE_UNITS, oy = ty * TILE_UNITS;
        const ix0 = Math.max(x, ox), iy0 = Math.max(y, oy);
        const ix1 = Math.min(x + w, ox + TILE_UNITS), iy1 = Math.min(y + h, oy + TILE_UNITS);
        if (ix1 <= ix0 || iy1 <= iy0) continue;
        octx.drawImage(
          tile.canvas,
          (ix0 - ox) * PX_PER_UNIT, (iy0 - oy) * PX_PER_UNIT, (ix1 - ix0) * PX_PER_UNIT, (iy1 - iy0) * PX_PER_UNIT,
          (ix0 - x) * PX_PER_UNIT, (iy0 - y) * PX_PER_UNIT, (ix1 - ix0) * PX_PER_UNIT, (iy1 - iy0) * PX_PER_UNIT,
        );
      }
      return out;
    },
    // Clear the pixels inside a flow-space rect (lift/delete). With `clip` (a
    // flow-space polygon) only the polygon interior is cleared — clearRect can't
    // be clipped, so we erase with a destination-out polygon fill instead.
    clearRegion: ({ x, y, w, h }, clip) => {
      const poly = clip && clip.length >= 3 ? clip : null;
      const t0x = Math.floor(x / TILE_UNITS), t1x = Math.floor((x + w) / TILE_UNITS);
      const t0y = Math.floor(y / TILE_UNITS), t1y = Math.floor((y + h) / TILE_UNITS);
      const store = storeRef.current;
      store.clearedKeys = store.clearedKeys || new Set();
      for (let ty = t0y; ty <= t1y; ty++) for (let tx = t0x; tx <= t1x; tx++) {
        const tile = store.tiles.get(`${tx}_${ty}`);
        if (!tile) continue;
        store.clearedKeys.add(tile.key); // may have become empty → flush checks + evicts
        const ctx = tile.ctx;
        ctx.setTransform(PX_PER_UNIT, 0, 0, PX_PER_UNIT, -tx * TILE_UNITS * PX_PER_UNIT, -ty * TILE_UNITS * PX_PER_UNIT);
        if (poly) {
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = "destination-out";
          ctx.beginPath();
          poly.forEach((p, i) => { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
          ctx.closePath();
          ctx.fill();
          ctx.globalCompositeOperation = "source-over";
        } else {
          ctx.clearRect(x, y, w, h);
        }
        tile.dirty = true;
      }
      bump();
      scheduleFlush();
    },
    // Draw a lifted region canvas onto the tiles at a (possibly moved) flow rect.
    stampRegion: (src, { x, y, w, h }) => {
      if (!src) return;
      const t0x = Math.floor(x / TILE_UNITS), t1x = Math.floor((x + w) / TILE_UNITS);
      const t0y = Math.floor(y / TILE_UNITS), t1y = Math.floor((y + h) / TILE_UNITS);
      for (let ty = t0y; ty <= t1y; ty++) for (let tx = t0x; tx <= t1x; tx++) {
        const tile = ensureTile(storeRef.current, tx, ty);
        const ox = tx * TILE_UNITS, oy = ty * TILE_UNITS;
        const ix0 = Math.max(x, ox), iy0 = Math.max(y, oy);
        const ix1 = Math.min(x + w, ox + TILE_UNITS), iy1 = Math.min(y + h, oy + TILE_UNITS);
        if (ix1 <= ix0 || iy1 <= iy0) continue;
        const ctx = tile.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(
          src,
          (ix0 - x) * PX_PER_UNIT, (iy0 - y) * PX_PER_UNIT, (ix1 - ix0) * PX_PER_UNIT, (iy1 - iy0) * PX_PER_UNIT,
          (ix0 - ox) * PX_PER_UNIT, (iy0 - oy) * PX_PER_UNIT, (ix1 - ix0) * PX_PER_UNIT, (iy1 - iy0) * PX_PER_UNIT,
        );
        tile.dirty = true;
      }
      bump();
      scheduleFlush();
    },
    store: storeRef.current,
  }), [scheduleFlush, bump]);

  // Flush any pending save on unmount.
  useEffect(() => () => { if (flushTimer.current) { clearTimeout(flushTimer.current); doFlush(); } }, [doFlush]);

  // Reap stroke sessions whose `end` never arrived (a dropped broadcast / a peer
  // who left mid-stroke) so their per-tile scratch canvases can't leak for the
  // whole board session. Cheap idle sweep; the baked pixels are already on-tile.
  useEffect(() => {
    const t = setInterval(() => reapStaleStrokes(storeRef.current), 5000);
    return () => clearInterval(t);
  }, []);

  // Load persisted tiles for this board on open. Skip a tile that's been
  // painted locally since (don't clobber fresh edits). crossOrigin keeps the
  // canvas untainted so toBlob() can still re-save it.
  useEffect(() => {
    if (!enabled || !boardId) return undefined;
    let cancelled = false;
    listPaintTiles(boardId).then((tiles) => {
      if (cancelled) return;
      for (const t of tiles) {
        const existing = storeRef.current.tiles.get(t.key);
        if (existing && existing.dirty) continue;
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          if (cancelled) return;
          const ex2 = storeRef.current.tiles.get(t.key);
          if (ex2 && ex2.dirty) return;
          const tile = ensureTile(storeRef.current, t.tx, t.ty);
          const ctx = tile.ctx;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = "source-over";
          ctx.clearRect(0, 0, TILE_PX, TILE_PX);
          ctx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
          bump();
        };
        img.src = t.url;
      }
    });
    return () => { cancelled = true; };
  }, [enabled, boardId, bump]);

  const tiles = [...storeRef.current.tiles.values()];
  return (
    <ViewportPortal>
      <div style={{ position: "absolute", left: 0, top: 0, zIndex }}>
        {tiles.map((tile) => <TileView key={tile.key} tile={tile} />)}
      </div>
    </ViewportPortal>
  );
});

export default PaintLayer;
