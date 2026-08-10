// Infinite tiled raster paint engine.
//
// The board is infinite, so the paint layer is a sparse grid of fixed-size
// bitmap TILES, materialised only where someone paints. Flow space is carved
// into TILE_UNITS-wide squares; each tile is a TILE_PX bitmap (PX_PER_UNIT
// pixels per flow unit). A brush stroke is rasterised onto whichever tiles it
// crosses — drawing in flow coordinates and letting each tile canvas clip what
// falls outside it, so we never need exact tile/stroke intersection tests.
//
// Sync is by STROKE VECTORS, not pixels: the page broadcasts a stroke's points
// + brush params, and every client runs this same rasteriser, so the bitmap
// result is identical everywhere while the wire stays tiny.

export const TILE_UNITS = 512;   // tile size in flow units
export const PX_PER_UNIT = 2;    // bitmap resolution (2 = crisp at up to ~2x zoom)
export const TILE_PX = TILE_UNITS * PX_PER_UNIT;

const tileKey = (tx, ty) => `${tx}_${ty}`;

// A store holds the live tiles + per-stroke sessions. onCreate fires when a new
// tile is materialised so the React layer can mount its canvas.
export function createPaintStore(onCreate) {
  return { tiles: new Map(), strokes: new Map(), onCreate };
}

// Drop a stroke session's per-tile scratch (two TILE_PX² canvases each) + sprite,
// zeroing the canvases so their backing store is released promptly rather than
// waiting for GC. The baked pixels already live on the real tile, so this is safe.
function releaseStrokeSession(session) {
  if (!session) return;
  for (const st of session.tiles.values()) {
    st.wctx = null;
    if (st.dry) { st.dry.width = 0; st.dry.height = 0; }
    if (st.wet) { st.wet.width = 0; st.wet.height = 0; }
  }
  session.tiles.clear();
  session.sprite = null;
}

// Reap stroke sessions whose `end` chunk never arrived — a dropped broadcast or a
// peer who left mid-stroke would otherwise leak its scratch canvases for the whole
// session. Idle-timed (well past the ~70ms flush cadence): a late continuation of
// an already-reaped stroke just starts a fresh session (a harmless tiny seam).
export function reapStaleStrokes(store, maxIdleMs = 8000) {
  if (!store || !store.strokes || !store.strokes.size) return;
  const now = performance.now();
  for (const [id, session] of store.strokes) {
    if (now - (session.lastTouched || 0) > maxIdleMs) {
      releaseStrokeSession(session);
      store.strokes.delete(id);
    }
  }
}

// Materialise a tile without drawing (used when loading a persisted PNG in).
export function ensureTile(store, tx, ty) {
  return getOrCreateTile(store, tx, ty);
}

function getOrCreateTile(store, tx, ty) {
  const key = tileKey(tx, ty);
  let tile = store.tiles.get(key);
  if (tile) return tile;
  const canvas = document.createElement("canvas");
  canvas.width = TILE_PX;
  canvas.height = TILE_PX;
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  const ctx = canvas.getContext("2d");
  tile = { key, tx, ty, canvas, ctx, dirty: false };
  store.tiles.set(key, tile);
  store.onCreate?.(tile);
  return tile;
}

// ── Wet-layer stroke model ──────────────────────────────────────────────────
// A stroke must read as ONE mark at its chosen opacity — not a pile of
// overlapping stamps that darken where they cross (which is what you get when
// each dab/segment composites straight onto the tile at globalAlpha < 1: round
// caps overlap, holding still builds up, translucent strokes turn opaque).
//
// So a stroke is drawn to a per-tile WET scratch canvas at FULL opacity (round
// caps and overlaps just stay opaque — no build-up), over a DRY snapshot of the
// tile taken before the stroke touched it. Every frame the visible tile is
// recomposited: dry, then the wet layer flattened onto it ONCE at the stroke's
// opacity (source-over for paint, destination-out for the eraser). Textured
// brushes still build their grain/spray up inside the wet layer, so their look
// is preserved while the overall stroke opacity is applied exactly once.

// Set up a WET context to draw in FLOW coordinates at full opacity. The stroke
// opacity + eraser compositing are applied later when the wet layer is flattened
// onto the tile (see recompose), so wet drawing is always opaque source-over.
function paintInto(ctx, ox, oy, brush) {
  ctx.setTransform(PX_PER_UNIT, 0, 0, PX_PER_UNIT, -ox * PX_PER_UNIT, -oy * PX_PER_UNIT);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = brush.size;
  ctx.strokeStyle = brush.color;
  ctx.fillStyle = brush.color;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

// Get (or lazily create) the wet+dry scratch for one tile of the active stroke.
// `dry` is a copy of the tile's pixels the moment the stroke first reached it;
// `wet` accumulates only this stroke's ink at full opacity. Registers the key in
// `touched` so the caller recomposites it after drawing.
function strokeTile(store, session, tx, ty, touched) {
  const key = tileKey(tx, ty);
  touched.add(key);
  let st = session.tiles.get(key);
  if (st) return st;
  const tile = getOrCreateTile(store, tx, ty);
  const dry = document.createElement("canvas");
  dry.width = TILE_PX; dry.height = TILE_PX;
  dry.getContext("2d").drawImage(tile.canvas, 0, 0);
  const wet = document.createElement("canvas");
  wet.width = TILE_PX; wet.height = TILE_PX;
  st = { tile, dry, wet, wctx: wet.getContext("2d") };
  session.tiles.set(key, st);
  return st;
}

// Repaint a tile REGION from its dry snapshot + the wet layer flattened once at
// the stroke's opacity. This is what makes overlaps/holding not darken. Only the
// rect that changed this frame is recomposited (a full 1024² clear+2 blits per
// pointer move is the airbrush's mobile bottleneck); the tile outside the rect
// still holds the correct dry pixels since we never cleared them.
function recompose(st, opacity, mode, rx, ry, rw, rh) {
  if (rw <= 0 || rh <= 0) return;
  const ctx = st.tile.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(rx, ry, rw, rh);
  ctx.drawImage(st.dry, rx, ry, rw, rh, rx, ry, rw, rh);
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = mode === "eraser" ? "destination-out" : "source-over";
  ctx.drawImage(st.wet, rx, ry, rw, rh, rx, ry, rw, rh);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  st.tile.dirty = true;
}

function tileRange(minX, minY, maxX, maxY) {
  return {
    t0x: Math.floor(minX / TILE_UNITS), t1x: Math.floor(maxX / TILE_UNITS),
    t0y: Math.floor(minY / TILE_UNITS), t1y: Math.floor(maxY / TILE_UNITS),
  };
}

// Keys of every tile a segment a→b of the given brush size can touch (its bbox
// padded by the radius). Used by the undo layer to snapshot the right tiles
// before a stroke paints them. `size` is padded generously so textured brushes
// that spray slightly past the nib are fully covered.
// Keys of every tile a flow-space rect overlaps — for snapshotting a region
// before a select/move/delete.
export function regionTileKeys({ x, y, w, h }) {
  const keys = [];
  const t0x = Math.floor(x / TILE_UNITS), t1x = Math.floor((x + w) / TILE_UNITS);
  const t0y = Math.floor(y / TILE_UNITS), t1y = Math.floor((y + h) / TILE_UNITS);
  for (let ty = t0y; ty <= t1y; ty++) for (let tx = t0x; tx <= t1x; tx++) keys.push(tileKey(tx, ty));
  return keys;
}

export function segmentTileKeys(ax, ay, bx, by, size, set = new Set()) {
  const r = size * 0.75;
  const { t0x, t1x, t0y, t1y } = tileRange(
    Math.min(ax, bx) - r, Math.min(ay, by) - r,
    Math.max(ax, bx) + r, Math.max(ay, by) + r,
  );
  for (let ty = t0y; ty <= t1y; ty++) for (let tx = t0x; tx <= t1x; tx++) set.add(tileKey(tx, ty));
  return set;
}

// ── Deterministic randomness for textured brushes ──────────────────────────
// Textured brushes (pencil grain, airbrush spray) place dots at pseudo-random
// spots. Sync broadcasts stroke VECTORS, not pixels, so every client must draw
// the SAME dots — seed a PRNG from the stroke id + point index (both on the
// wire) and local + remote agree pixel-for-pixel.
function hashSeed(id, i) {
  let h = (2166136261 ^ i) >>> 0;
  for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stamp one filled dot of radius r at (x,y) into the wet layer of every tile it
// touches, at `alpha` (its texture weight — stroke opacity is applied later).
// The building block for the textured brushes.
function stampDot(store, session, x, y, r, brush, alpha, touched) {
  const { t0x, t1x, t0y, t1y } = tileRange(x - r, y - r, x + r, y + r);
  for (let ty = t0y; ty <= t1y; ty++) {
    for (let tx = t0x; tx <= t1x; tx++) {
      const st = strokeTile(store, session, tx, ty, touched);
      const ctx = st.wctx;
      paintInto(ctx, tx * TILE_UNITS, ty * TILE_UNITS, brush);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// "#rrggbb" → "rgba(r,g,b,0)" for a transparent radial-gradient edge stop.
function transparentEdge(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "rgba(0,0,0,0)";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0)`;
}

// A cached soft-dab SPRITE for the stroke — the airbrush stamps thousands of
// these, and building a fresh radialGradient per dab is the airbrush's main CPU
// cost. Colour + radius are constant for a stroke, so render the feathered dab
// ONCE (at device resolution) and reuse it. Cheap `drawImage` replaces the
// per-dab gradient + fill.
function airSprite(session, brush, r) {
  const cur = session.sprite;
  if (cur && cur.r === r && cur.color === brush.color) return cur.canvas;
  const px = Math.max(2, Math.ceil(2 * r * PX_PER_UNIT));
  const c = document.createElement("canvas");
  c.width = px; c.height = px;
  const g = c.getContext("2d");
  const mid = px / 2;
  const grad = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
  grad.addColorStop(0, brush.color);
  grad.addColorStop(0.35, brush.color);
  grad.addColorStop(1, transparentEdge(brush.color));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(mid, mid, mid, 0, Math.PI * 2);
  g.fill();
  session.sprite = { canvas: c, r, color: brush.color };
  return c;
}

// One soft round dab — opaque core feathering to a transparent edge — into the
// wet layer, stamped from the cached sprite. The airbrush building block.
function softDab(store, session, x, y, r, brush, alpha, touched) {
  if (r <= 0) return;
  const sprite = airSprite(session, brush, r);
  const { t0x, t1x, t0y, t1y } = tileRange(x - r, y - r, x + r, y + r);
  for (let ty = t0y; ty <= t1y; ty++) {
    for (let tx = t0x; tx <= t1x; tx++) {
      const st = strokeTile(store, session, tx, ty, touched);
      const ctx = st.wctx;
      paintInto(ctx, tx * TILE_UNITS, ty * TILE_UNITS, brush);
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, x - r, y - r, 2 * r, 2 * r);
    }
  }
}

// Airbrush: dense soft dabs along the segment at low alpha — a feathered,
// build-up spray with a soft edge (not a grainy texture). Deterministic.
function airbrushSegment(store, session, ax, ay, bx, by, brush, touched) {
  const R = brush.size / 2;
  const dist = Math.hypot(bx - ax, by - ay);
  const spacing = Math.max(0.5, R * 0.3);
  const n = Math.max(1, Math.round(dist / spacing));
  for (let s = 0; s <= n; s++) {
    const t = n ? s / n : 0;
    softDab(store, session, ax + (bx - ax) * t, ay + (by - ay) * t, R, brush, 0.08, touched);
  }
}

// Pencil: a graphite line — dense fine grains across the nib, centre-weighted
// with random gaps (the "tooth" of the paper) and per-grain alpha variation.
function pencilSegment(store, session, ax, ay, bx, by, brush, rng, touched) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 0.001;
  const step = Math.max(0.4, brush.size * 0.05); // tight spacing → continuous line
  const n = Math.max(1, Math.round(len / step));
  const nx = -dy / len, ny = dx / len; // unit normal
  const half = brush.size / 2;
  const grainR = Math.max(0.4, brush.size * 0.06);
  const grains = Math.max(4, Math.round(brush.size * 0.7));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const cx = ax + dx * t, cy = ay + dy * t;
    for (let g = 0; g < grains; g++) {
      if (rng() < 0.12) continue; // light paper tooth — a few gaps, not a dotted line
      const u = rng() + rng() - 1; // centre-weighted across the nib (~triangular)
      const off = u * half;
      stampDot(store, session, cx + nx * off, cy + ny * off, grainR, brush, 0.22 + rng() * 0.45, touched);
    }
  }
}

// Draw a single round dab into the wet layer (stroke start / a tap).
function dab(store, session, x, y, brush, touched) {
  const r = brush.size / 2;
  const { t0x, t1x, t0y, t1y } = tileRange(x - r, y - r, x + r, y + r);
  for (let ty = t0y; ty <= t1y; ty++) {
    for (let tx = t0x; tx <= t1x; tx++) {
      const st = strokeTile(store, session, tx, ty, touched);
      const ctx = st.wctx;
      paintInto(ctx, tx * TILE_UNITS, ty * TILE_UNITS, brush);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Draw a stroke segment a→b into the wet layer of every tile it can touch. A
// single stroked polyline join → no per-segment cap doubling.
function segment(store, session, ax, ay, bx, by, brush, touched) {
  const r = brush.size / 2;
  const { t0x, t1x, t0y, t1y } = tileRange(
    Math.min(ax, bx) - r, Math.min(ay, by) - r,
    Math.max(ax, bx) + r, Math.max(ay, by) + r,
  );
  for (let ty = t0y; ty <= t1y; ty++) {
    for (let tx = t0x; tx <= t1x; tx++) {
      const st = strokeTile(store, session, tx, ty, touched);
      const ctx = st.wctx;
      paintInto(ctx, tx * TILE_UNITS, ty * TILE_UNITS, brush);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }
}

// Rasterise a stroke chunk: { id, brush, pts:[[x,y]...], end? }. Connects to the
// stroke's previous point (tracked by id) so streamed chunks join seamlessly.
// Local and remote strokes both flow through here for identical results.
//
// Each stroke keeps a SESSION: per-tile wet+dry scratch (see strokeTile). New
// ink lands in the wet layer at full opacity, then every touched tile is
// recomposited (dry + wet flattened once at the stroke's opacity) so overlaps
// and holding don't darken. The session is dropped on `end`, leaving the baked
// result on the tiles.
export function applyPaintChunk(store, chunk) {
  if (!chunk || !chunk.brush) return;
  const pts = chunk.pts || [];
  const brush = chunk.brush;
  // Erasing is always a clean round stroke; texture only applies to painting.
  const texture = brush.mode === "eraser" ? "smooth" : (brush.texture || "smooth");
  const opacity = brush.opacity ?? 1;
  let session = store.strokes.get(chunk.id);
  if (!session) { session = { prev: null, i: 0, tiles: new Map() }; store.strokes.set(chunk.id, session); }
  session.lastTouched = performance.now(); // for reapStaleStrokes (dropped-end leak)
  let prev = session.prev;
  let i = session.i;
  const touched = new Set();
  // Track the flow-space bbox of ink laid down this call, so we recomposite only
  // the region that changed (not the whole tile).
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  const grow = (x, y) => { if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; };
  for (const [x, y] of pts) {
    if (prev) grow(prev[0], prev[1]);
    grow(x, y);
    if (texture === "airbrush") {
      airbrushSegment(store, session, prev ? prev[0] : x, prev ? prev[1] : y, x, y, brush, touched);
    } else if (texture === "pencil") {
      const rng = mulberry32(hashSeed(chunk.id, i)); // deterministic per point
      pencilSegment(store, session, prev ? prev[0] : x, prev ? prev[1] : y, x, y, brush, rng, touched);
    } else {
      if (prev) segment(store, session, prev[0], prev[1], x, y, brush, touched);
      else dab(store, session, x, y, brush, touched);
    }
    prev = [x, y];
    i++;
  }
  const pad = brush.size; // covers the nib half-width + any grain/spray scatter
  for (const key of touched) {
    const st = session.tiles.get(key);
    if (!st) continue;
    const us = key.indexOf("_");
    const ox = parseInt(key.slice(0, us), 10) * TILE_UNITS;
    const oy = parseInt(key.slice(us + 1), 10) * TILE_UNITS;
    const rx = Math.max(0, Math.floor((Math.max(bx0 - pad, ox) - ox) * PX_PER_UNIT));
    const ry = Math.max(0, Math.floor((Math.max(by0 - pad, oy) - oy) * PX_PER_UNIT));
    const rr = Math.min(TILE_PX, Math.ceil((Math.min(bx1 + pad, ox + TILE_UNITS) - ox) * PX_PER_UNIT));
    const rb = Math.min(TILE_PX, Math.ceil((Math.min(by1 + pad, oy + TILE_UNITS) - oy) * PX_PER_UNIT));
    recompose(st, opacity, brush.mode, rx, ry, rr - rx, rb - ry);
  }
  if (chunk.end) { releaseStrokeSession(session); store.strokes.delete(chunk.id); }
  else { session.prev = prev; session.i = i; }
}
