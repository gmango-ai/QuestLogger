import { useCallback, useEffect, useReducer, useRef } from "react";
import { sortParentsFirst } from "./frame";

// ─── Whiteboard undo / redo ────────────────────────────────────────
//
// Multiplayer-safe history. Two design rules make this work alongside the
// realtime sync (see useWhiteboardSync):
//
//   1. History is ENTITY-SCOPED, not whole-board. Each undo step records the
//      before/after of only the nodes/edges that changed, keyed by id. Undo
//      restores those entities by id (merge, not array-replace), so it can
//      never delete a teammate's concurrently-added node.
//   2. REMOTE changes fold into the baseline (onRemoteApply) and never become
//      one of MY undo steps — I can only undo what I did.
//
// Capture is debounced so a continuous gesture (drag, type, resize burst)
// collapses into ONE step. Because undo/redo go through the same setNodes/
// setEdges as any edit, they auto-persist (autosave) and auto-sync (broadcast)
// with no extra plumbing.

const HISTORY_DEBOUNCE_MS = 450;
const MAX_DEPTH = 100;

// Per-user UI flags never describe the shared graph — mirror useWhiteboardSync
// so our diffs match exactly what gets broadcast/persisted (no phantom steps
// from a selection toggle).
function stripLocal(o) {
  const { selected, dragging, resizing, ...rest } = o;
  return rest;
}
const cleanJson = (o) => JSON.stringify(stripLocal(o));

// Baseline map: id → { json, ent } of clean entities.
function baseFrom(list) {
  const m = new Map();
  for (const o of list || []) m.set(o.id, { json: cleanJson(o), ent: stripLocal(o) });
  return m;
}

// Diff a current entity list against a baseline → [{ id, before, after }]
// where before/after are clean entities or null (null = absent).
function diffEntities(list, base) {
  const entries = [];
  const seen = new Set();
  for (const o of list) {
    seen.add(o.id);
    const j = cleanJson(o);
    const b = base.get(o.id);
    if (!b) entries.push({ id: o.id, before: null, after: stripLocal(o) });
    else if (b.json !== j) entries.push({ id: o.id, before: b.ent, after: stripLocal(o) });
  }
  for (const [id, b] of base) {
    if (!seen.has(id)) entries.push({ id, before: b.ent, after: null });
  }
  return entries;
}

const isPlainObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Restore ONLY the fields this step changed (before→after) onto the CURRENT live
// entity `cur`, taking the values from `target` (the chosen side). Recurses one
// level into plain-object values (`data`, `style`), so a peer's concurrent edit
// to a DIFFERENT field — or a different sub-field of `data` — of the same node
// survives an undo/redo instead of being clobbered by a whole-entity restore.
// (Deeper-than-one-level nesting still restores wholesale — rare on this graph.)
export function restoreFields(cur, before, after, target) {
  const next = { ...cur };
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (jsonEq(before[k], after[k])) continue; // unchanged by this step → keep cur's (a peer may own it)
    const tv = target ? target[k] : undefined;
    if (tv === undefined) { delete next[k]; continue; }
    if (isPlainObj(before[k]) && isPlainObj(after[k]) && isPlainObj(next[k]) && isPlainObj(tv)) {
      const sub = { ...next[k] };
      const subKeys = new Set([...Object.keys(before[k]), ...Object.keys(after[k])]);
      for (const sk of subKeys) {
        if (jsonEq(before[k][sk], after[k][sk])) continue;
        if (tv[sk] === undefined) delete sub[sk]; else sub[sk] = tv[sk];
      }
      next[k] = sub;
    } else {
      next[k] = tv;
    }
  }
  next.selected = true;
  return next;
}

// Apply a transaction's reverts to a live entity list, restoring the chosen
// side. Restored entities are selected so the change is visible.
//   • MODIFIED (before & after both present) → field-level merge onto the live
//     entity (preserves concurrent peer edits to other fields).
//   • ADD/REMOVE (before or after null) → whole-entity set/delete, as before.
export function applyReverts(list, entries, side, sortParents) {
  const map = new Map(list.map((x) => [x.id, x]));
  for (const e of entries) {
    const target = e[side];
    if (e.before != null && e.after != null) {
      const cur = map.get(e.id);
      map.set(e.id, cur ? restoreFields(cur, e.before, e.after, target) : { ...target, selected: true });
    } else if (target == null) {
      map.delete(e.id);
    } else {
      map.set(e.id, { ...target, selected: true });
    }
  }
  const out = [...map.values()];
  return sortParents ? sortParentsFirst(out) : out;
}

export function useWhiteboardHistory({ nodes, edges, setNodes, setEdges, enabled }) {
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const edgesRef = useRef(edges); edgesRef.current = edges;

  const baseN = useRef(new Map());
  const baseE = useRef(new Map());
  const past = useRef([]);    // [{ nodes:[entries], edges:[entries] }]
  const future = useRef([]);
  const primed = useRef(false);
  const timer = useRef(null);
  const pending = useRef(false); // an uncommitted local edit is in flight
  const skip = useRef(false);    // suppress capture for our own undo/redo writes
  const rebase = useRef(false);  // absorb a runSilent() change into the baseline
  const [, bump] = useReducer((x) => x + 1, 0);

  // Re-baseline from a known state and drop history (board load / switch).
  const prime = useCallback((nList, eList) => {
    baseN.current = baseFrom(nList);
    baseE.current = baseFrom(eList);
    past.current = [];
    future.current = [];
    pending.current = false;
    bump();
  }, []);

  // Move the baseline to a transaction's chosen side.
  const rebaseTo = useCallback((txn, side) => {
    for (const e of txn.nodes) {
      if (e[side] == null) baseN.current.delete(e.id);
      else baseN.current.set(e.id, { json: cleanJson(e[side]), ent: e[side] });
    }
    for (const e of txn.edges) {
      if (e[side] == null) baseE.current.delete(e.id);
      else baseE.current.set(e.id, { json: cleanJson(e[side]), ent: e[side] });
    }
  }, []);

  // Commit any uncommitted local diff as one step. Returns true if it did.
  const capture = useCallback(() => {
    const nDiff = diffEntities(nodesRef.current, baseN.current);
    const eDiff = diffEntities(edgesRef.current, baseE.current);
    if (!nDiff.length && !eDiff.length) return false;
    const txn = { nodes: nDiff, edges: eDiff };
    past.current.push(txn);
    if (past.current.length > MAX_DEPTH) past.current.shift();
    future.current = [];
    rebaseTo(txn, "after"); // baseline now reflects current
    bump();
    return true;
  }, [rebaseTo]);

  // Run a node/edge mutation WITHOUT recording an entity history step. Lets an
  // external step (raster + nodes together, e.g. clear-all or a region move)
  // own the whole undo in one press. The next capture effect ABSORBS the change
  // into the baseline (rebase) rather than capturing it — so it also can't leak
  // into a later unrelated step.
  const runSilent = useCallback((fn) => {
    rebase.current = true;
    fn();
  }, []);

  // Push a non-entity ("external") undo step — used by the raster paint layer,
  // whose pixels aren't nodes/edges. Carries its own undo()/redo() closures.
  // Any pending entity edit is captured first so the interleaved order of pen
  // nodes and brush strokes is preserved in one stack.
  const pushExternalStep = useCallback((step) => {
    if (!step) return;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    pending.current = false;
    capture();
    past.current.push({ external: step });
    if (past.current.length > MAX_DEPTH) past.current.shift();
    future.current = [];
    bump();
  }, [capture]);

  // Remote peer ops: absorb into the baseline so they never become MY undo
  // steps. Called from useWhiteboardSync.applyOps (local user's changes never
  // pass through here).
  const onRemoteApply = useCallback((p) => {
    if (!p) return;
    if (p.nodeOps?.length) for (const n of p.nodeOps) baseN.current.set(n.id, { json: cleanJson(n), ent: stripLocal(n) });
    if (p.removedNodes?.length) for (const id of p.removedNodes) baseN.current.delete(id);
    if (p.edgeOps?.length) for (const e of p.edgeOps) baseE.current.set(e.id, { json: cleanJson(e), ent: stripLocal(e) });
    if (p.removedEdges?.length) for (const id of p.removedEdges) baseE.current.delete(id);
  }, []);

  // Debounced capture on local state changes. Primes (no step) on first run.
  useEffect(() => {
    if (!enabled) return undefined;
    if (!primed.current) {
      prime(nodesRef.current, edgesRef.current);
      primed.current = true;
      return undefined;
    }
    if (skip.current) { skip.current = false; return undefined; } // our own undo/redo
    if (rebase.current) {
      // runSilent() change → fold it into the baseline (don't capture, and don't
      // clear the stacks) so it neither becomes its own step nor leaks into the
      // next captured edit. Its undo is owned by an external step.
      rebase.current = false;
      baseN.current = baseFrom(nodesRef.current);
      baseE.current = baseFrom(edgesRef.current);
      return undefined;
    }
    if (!pending.current) { pending.current = true; bump(); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      pending.current = false;
      if (!capture()) bump();
    }, HISTORY_DEBOUNCE_MS);
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [nodes, edges, enabled, prime, capture]);

  // Re-prime for a new board (enabled flips false during load).
  useEffect(() => {
    if (enabled) return;
    primed.current = false;
    past.current = [];
    future.current = [];
    pending.current = false;
    bump();
  }, [enabled]);

  const undo = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    pending.current = false;
    capture(); // fold any in-flight edit into its own step first
    const txn = past.current.pop();
    if (!txn) { bump(); return; }
    future.current.push(txn);
    if (txn.external) { try { txn.external.undo(); } catch { /* */ } bump(); return; }
    if (txn.nodes.length) setNodes((nds) => applyReverts(nds, txn.nodes, "before", true));
    if (txn.edges.length) setEdges((eds) => applyReverts(eds, txn.edges, "before", false));
    rebaseTo(txn, "before");
    skip.current = true;
    bump();
  }, [capture, rebaseTo, setNodes, setEdges]);

  const redo = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    pending.current = false;
    capture(); // a new edit invalidates redo (capture clears the future stack)
    const txn = future.current.pop();
    if (!txn) { bump(); return; }
    past.current.push(txn);
    if (txn.external) { try { txn.external.redo(); } catch { /* */ } bump(); return; }
    if (txn.nodes.length) setNodes((nds) => applyReverts(nds, txn.nodes, "after", true));
    if (txn.edges.length) setEdges((eds) => applyReverts(eds, txn.edges, "after", false));
    rebaseTo(txn, "after");
    skip.current = true;
    bump();
  }, [capture, rebaseTo, setNodes, setEdges]);

  const canUndo = past.current.length > 0 || pending.current;
  const canRedo = future.current.length > 0;

  return { undo, redo, canUndo, canRedo, onRemoteApply, pushExternalStep, runSilent };
}
