import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../supabase";
import { sortParentsFirst } from "./frame";

// ─── Real-time whiteboard collaboration ────────────────────────────
//
// We keep the whiteboard SNAPSHOT (whiteboards.snapshot) as the durable
// system-of-record (see lib/whiteboard.js) and layer a board-scoped
// Realtime BROADCAST channel on top for live editing — no schema change.
//
// What travels on the channel:
//   • "ops"      — per-entity node/edge diffs (changed + removed by id),
//                  merged by id so two people editing different things
//                  never stomp each other.
//   • "cursor"   — throttled cursor position in FLOW coords.
//   • "sync-req" — a joiner asks for the current live state; the lowest
//                  client-id already present answers (single responder),
//                  catching the joiner up to edits not yet snapshotted.
//   • presence   — who's in the room (for the avatar stack).

const OPS_THROTTLE_MS = 55;
const CURSOR_THROTTLE_MS = 45;
const CURSOR_TTL_MS = 6000;

const PEER_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#22c55e", "#14b8a6",
  "#0ea5e9", "#6366f1", "#a855f7", "#ec4899", "#10b981",
];
function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length];
}

// Per-user UI state that must never sync between peers (my selection /
// drag must not yank yours). Everything else describes the shared graph.
function stripLocal(o) {
  const { selected, dragging, resizing, ...rest } = o;
  return rest;
}
const idJson = (o) => JSON.stringify(stripLocal(o));

// Single-writer election: is `meId` the lowest client-id among everyone present
// (self + the other members)? Exactly one client is the persister at a time; a
// lone editor (no other members) is always it. Pure + exported for testing.
export function isPersisterId(meId, memberIds) {
  return (memberIds || []).every((id) => meId < id);
}

export function useWhiteboardSync({ boardId, enabled, nodes, edges, setNodes, setEdges, name, onRemoteApply, onPaint, onPaintPatch }) {
  const meId = useRef("");
  if (!meId.current) {
    meId.current = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `c-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
  const myColor = useMemo(() => colorFor(meId.current), []);
  const myName = name || "Guest";

  const chanRef = useRef(null);
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const edgesRef = useRef(edges); edgesRef.current = edges;

  // Baseline of what we've already told peers, keyed by id, so we only
  // broadcast (and never echo) genuine local diffs.
  const sentNodes = useRef(new Map());
  const sentEdges = useRef(new Map());
  const primed = useRef(false);
  const presence = useRef(new Set([meId.current]));

  // Remote cursors update at pointer-move frequency. Keeping them in React state
  // re-rendered the entire WhiteboardEditor on every peer's every move — the
  // meeting lag. Instead hold them in a ref-backed store with imperative
  // subscribers: CollabCursors folds each snapshot into its own rAF loop and
  // only React-renders when the SET of peers changes, so idle cursor motion
  // costs zero editor renders. setPeers keeps its functional-updater contract.
  const peersRef = useRef({});               // id → { x, y, name, color, ts }
  const cursorListeners = useRef(new Set());
  const setPeers = useCallback((updater) => {
    const next = typeof updater === "function" ? updater(peersRef.current) : updater;
    if (next === peersRef.current) return;   // updater signalled "no change"
    peersRef.current = next;
    for (const cb of cursorListeners.current) { try { cb(next); } catch { /* */ } }
  }, []);
  const subscribeCursors = useCallback((cb) => {
    cursorListeners.current.add(cb);
    cb(peersRef.current);                     // prime with current state
    return () => { cursorListeners.current.delete(cb); };
  }, []);
  const [members, setMembers] = useState([]);  // [{ id, name, color }] (others)
  const [viewports, setViewports] = useState({}); // id → { x, y, zoom, ts } (for follow)

  // ── outgoing: broadcast local node/edge diffs ──
  const flushOps = useCallback(() => {
    const ch = chanRef.current;
    if (!ch) return;
    const nodeOps = [], removedNodes = [], seenN = new Set();
    for (const n of nodesRef.current) {
      seenN.add(n.id);
      const j = idJson(n);
      if (sentNodes.current.get(n.id) !== j) { nodeOps.push(stripLocal(n)); sentNodes.current.set(n.id, j); }
    }
    for (const id of [...sentNodes.current.keys()]) {
      if (!seenN.has(id)) { removedNodes.push(id); sentNodes.current.delete(id); }
    }
    const edgeOps = [], removedEdges = [], seenE = new Set();
    for (const e of edgesRef.current) {
      seenE.add(e.id);
      const j = idJson(e);
      if (sentEdges.current.get(e.id) !== j) { edgeOps.push(stripLocal(e)); sentEdges.current.set(e.id, j); }
    }
    for (const id of [...sentEdges.current.keys()]) {
      if (!seenE.has(id)) { removedEdges.push(id); sentEdges.current.delete(id); }
    }
    if (nodeOps.length || removedNodes.length || edgeOps.length || removedEdges.length) {
      try { ch.send({ type: "broadcast", event: "ops", payload: { from: meId.current, nodeOps, removedNodes, edgeOps, removedEdges } }); } catch { /* */ }
    }
  }, []);

  const opsTimer = useRef(null);
  const scheduleOps = useCallback(() => {
    if (opsTimer.current) return;
    opsTimer.current = setTimeout(() => { opsTimer.current = null; flushOps(); }, OPS_THROTTLE_MS);
  }, [flushOps]);

  useEffect(() => {
    if (!enabled) return;
    if (!primed.current) {
      // Both peers loaded the same snapshot — record it as already-known
      // so we don't blast the whole board on entry. New joiners are caught
      // up via sync-req instead.
      sentNodes.current = new Map(nodesRef.current.map((n) => [n.id, idJson(n)]));
      sentEdges.current = new Map(edgesRef.current.map((e) => [e.id, idJson(e)]));
      primed.current = true;
      return;
    }
    scheduleOps();
  }, [nodes, edges, enabled, scheduleOps]);

  // ── incoming: merge remote ops by id (preserving my local UI state) ──
  const applyOps = useCallback((p) => {
    if (!p || p.from === meId.current) return;
    // A resync answer carries `to` (the joiner). Broadcast reaches every peer,
    // so ignore a full-board dump addressed to someone else — otherwise it
    // clobbers established peers' concurrent edits + locks (frame-lock loss).
    if (p.to && p.to !== meId.current) return;
    // Let undo/redo history absorb peer changes into its baseline so they
    // never become one of MY undo steps (see useWhiteboardHistory).
    onRemoteApply?.(p);
    if (p.nodeOps?.length || p.removedNodes?.length) {
      setNodes((nds) => {
        let next = nds;
        if (p.nodeOps?.length) {
          const byId = new Map(p.nodeOps.map((n) => [n.id, n]));
          const have = new Set(nds.map((n) => n.id));
          next = next.map((n) => byId.has(n.id) ? { ...byId.get(n.id), selected: n.selected, dragging: n.dragging } : n);
          for (const n of p.nodeOps) if (!have.has(n.id)) next = next.concat(n);
          for (const n of p.nodeOps) sentNodes.current.set(n.id, idJson(n));
          next = sortParentsFirst(next); // keep frames before their children
        }
        if (p.removedNodes?.length) {
          const rm = new Set(p.removedNodes);
          next = next.filter((n) => !rm.has(n.id));
          for (const id of p.removedNodes) sentNodes.current.delete(id);
        }
        return next;
      });
    }
    if (p.edgeOps?.length || p.removedEdges?.length) {
      setEdges((eds) => {
        let next = eds;
        if (p.edgeOps?.length) {
          const byId = new Map(p.edgeOps.map((e) => [e.id, e]));
          const have = new Set(eds.map((e) => e.id));
          next = next.map((e) => byId.has(e.id) ? { ...byId.get(e.id), selected: e.selected } : e);
          for (const e of p.edgeOps) if (!have.has(e.id)) next = next.concat(e);
          for (const e of p.edgeOps) sentEdges.current.set(e.id, idJson(e));
        }
        if (p.removedEdges?.length) {
          const rm = new Set(p.removedEdges);
          next = next.filter((e) => !rm.has(e.id));
          for (const id of p.removedEdges) sentEdges.current.delete(id);
        }
        return next;
      });
    }
  }, [setNodes, setEdges, onRemoteApply]);

  // ── channel lifecycle ──
  useEffect(() => {
    if (!enabled || !boardId) return;
    const ch = supabase.channel(`wb:${boardId}`, {
      config: { broadcast: { self: false }, presence: { key: meId.current } },
    });
    chanRef.current = ch;

    ch.on("broadcast", { event: "ops" }, (m) => applyOps(m.payload));

    ch.on("broadcast", { event: "cursor" }, (m) => {
      const c = m.payload;
      if (!c || c.id === meId.current) return;
      setPeers((prev) => ({ ...prev, [c.id]: { x: c.x, y: c.y, name: c.name, color: c.color, laser: !!c.laser, ink: !!c.ink, laserColor: c.laserColor, ts: Date.now() } }));
    });

    // Live viewport (pan+zoom) of each peer — powers "follow" (mirror someone's
    // view) and marks who's actively navigating.
    ch.on("broadcast", { event: "viewport" }, (m) => {
      const v = m.payload;
      if (!v || v.id === meId.current) return;
      setViewports((prev) => ({ ...prev, [v.id]: { x: v.x, y: v.y, zoom: v.zoom, ts: Date.now() } }));
    });

    // Raster paint strokes (tiled paint layer): vectors in, rasterised locally.
    ch.on("broadcast", { event: "paint" }, (m) => {
      const p = m.payload;
      if (!p || p.from === meId.current) return;
      onPaint?.(p);
    });

    // Raster REGION ops (move/delete/clear-all): an ordered ops list applied to
    // the local paint layer. Moves recompute pixels from the peer's own tiles;
    // undo carries region PNGs. See applyPaintOps in WhiteboardPage.
    ch.on("broadcast", { event: "paintpatch" }, (m) => {
      const p = m.payload;
      if (!p || p.from === meId.current) return;
      onPaintPatch?.(p.ops);
    });

    ch.on("broadcast", { event: "sync-req" }, (m) => {
      const from = m.payload?.from;
      if (!from || from === meId.current) return;
      // Single responder: the lowest client-id present (excluding the
      // joiner) answers with the full live state.
      const others = [...presence.current].filter((x) => x !== from);
      const minId = others.length ? others.reduce((a, b) => (a < b ? a : b)) : meId.current;
      if (minId !== meId.current) return;
      try {
        // Address the full-board dump to the JOINER only (`to`). Broadcast can't
        // target a single peer, so every established peer also receives this —
        // but applyOps drops any op addressed to someone else. Without this, a
        // stale responder's whole-board copy overwrites everyone's live state
        // (last-writer-wins), silently reverting concurrent edits and locks
        // (draggable:false + data.locked flip back together) → the frame-lock
        // loss. A join/reconnect fires sync-req often in this brownout-prone app.
        ch.send({ type: "broadcast", event: "ops", payload: {
          from: meId.current,
          to: from,
          nodeOps: nodesRef.current.map(stripLocal),
          edgeOps: edgesRef.current.map(stripLocal),
          removedNodes: [], removedEdges: [],
        } });
      } catch { /* */ }
    });

    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState();
      const ids = new Set([meId.current]);
      const list = [];
      for (const key of Object.keys(state)) {
        const metas = state[key];
        const meta = (metas && metas[metas.length - 1]) || {};
        ids.add(key);
        if (key !== meId.current) list.push({ id: key, name: meta.name, color: meta.color });
      }
      presence.current = ids;
      setMembers(list);
      // Drop cursors + viewports for anyone who left.
      setPeers((prev) => {
        const next = {};
        for (const id of Object.keys(prev)) if (ids.has(id)) next[id] = prev[id];
        return next;
      });
      setViewports((prev) => {
        const next = {};
        for (const id of Object.keys(prev)) if (ids.has(id)) next[id] = prev[id];
        return next;
      });
    });

    ch.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      try { ch.track({ name: myName, color: myColor }); } catch { /* */ }
      try { ch.send({ type: "broadcast", event: "sync-req", payload: { from: meId.current } }); } catch { /* */ }
    });

    return () => {
      try { supabase.removeChannel(ch); } catch { /* */ }
      chanRef.current = null;
      primed.current = false;
      sentNodes.current = new Map();
      sentEdges.current = new Map();
      presence.current = new Set([meId.current]);
      setPeers({});
      setMembers([]);
      setViewports({});
    };
  }, [enabled, boardId, applyOps, myName, myColor, onPaint, onPaintPatch]);

  // ── outgoing cursor (throttled, trailing) ──
  // `laser` rides along on the same channel: when set, peers render the
  // cursor as a glowing laser dot instead of the arrow. `ink` means the laser
  // button is held — peers buffer those positions into a fading trail. Both
  // are ephemeral (for pointing things out / underlining while presenting).
  const cursorTimer = useRef(null);
  const pendingCursor = useRef(null);
  const pushCursor = useCallback((x, y, laser, ink, laserColor) => {
    pendingCursor.current = { x, y, laser: !!laser, ink: !!ink, laserColor };
    if (cursorTimer.current) return;
    cursorTimer.current = setTimeout(() => {
      cursorTimer.current = null;
      const ch = chanRef.current, c = pendingCursor.current;
      if (ch && c) {
        try { ch.send({ type: "broadcast", event: "cursor", payload: { id: meId.current, x: c.x, y: c.y, name: myName, color: myColor, laser: c.laser, ink: c.ink, laserColor: c.laserColor } }); } catch { /* */ }
      }
    }, CURSOR_THROTTLE_MS);
  }, [myName, myColor]);

  // ── outgoing viewport (throttled, trailing) — so followers can mirror it ──
  const vpTimer = useRef(null);
  const pendingVp = useRef(null);
  const pushViewport = useCallback((vp) => {
    pendingVp.current = vp;
    if (vpTimer.current) return;
    vpTimer.current = setTimeout(() => {
      vpTimer.current = null;
      const ch = chanRef.current, v = pendingVp.current;
      if (ch && v) {
        try { ch.send({ type: "broadcast", event: "viewport", payload: { id: meId.current, x: v.x, y: v.y, zoom: v.zoom } }); } catch { /* */ }
      }
    }, 70);
  }, []);

  // ── outgoing paint strokes (raster paint layer) ──
  // Fire-and-forget: each chunk carries the brush + the new points, so a
  // dropped chunk just means a tiny gap in a peer's render, not corruption.
  const pushPaint = useCallback((payload) => {
    const ch = chanRef.current;
    if (!ch) return;
    try { ch.send({ type: "broadcast", event: "paint", payload: { ...payload, from: meId.current } }); } catch { /* */ }
  }, []);

  // Broadcast a raster region-op patch (ordered ops list) to peers.
  const pushPaintPatch = useCallback((ops) => {
    const ch = chanRef.current;
    if (!ch || !ops?.length) return;
    try { ch.send({ type: "broadcast", event: "paintpatch", payload: { from: meId.current, ops } }); } catch { /* */ }
  }, []);

  // Prune stale cursors (peer idle / dropped without a presence leave).
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      const cutoff = Date.now() - CURSOR_TTL_MS;
      setPeers((prev) => {
        let changed = false;
        const next = {};
        for (const id of Object.keys(prev)) {
          if (prev[id].ts >= cutoff) next[id] = prev[id]; else changed = true;
        }
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(t);
  }, [enabled]);

  // Single-writer election: exactly ONE client persists the board to the DB (the
  // others broadcast their edits live and rely on this one for durability), so N
  // concurrent editors cost one write stream instead of N full-board writes — the
  // fix for the retro brownout. The persister is the lowest client-id present,
  // the SAME election already used to answer a joiner's sync-req above. When
  // realtime is disabled (solo / embedded / non-synced board) `members` stays
  // empty, so a lone editor is always the persister and saves normally.
  const isPersister = useMemo(
    () => isPersisterId(meId.current, members.map((m) => m.id)),
    [members],
  );

  return { subscribeCursors, members, viewports, pushCursor, pushViewport, pushPaint, pushPaintPatch, myColor, meId: meId.current, isPersister };
}
