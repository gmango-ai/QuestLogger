import { useMemo, useCallback } from "react";
import { sortParentsFirst } from "./frame";
import { WB_TOUCH } from "./wbConstants";

// ── selection inspector ──
// Selection-derived state + the callbacks that mutate the selected node(s),
// extracted verbatim from WhiteboardEditor. The JSX <Inspector .../> render
// stays in WhiteboardPage; this hook only computes what it shows.
export function useWhiteboardInspector({ nodes, edges, setNodes }) {
  const selectedNode = useMemo(
    () => nodes.find((n) => n.selected && n.type !== "zone") || null,
    [nodes]
  );
  // Only show the per-item inspector for a SINGLE selection — a marquee
  // multi-select shouldn't stack toolbars over the canvas.
  const singleSelection = useMemo(() => {
    let c = 0;
    for (const n of nodes) if (n.selected && n.type !== "zone") { if (++c > 1) return false; }
    for (const e of edges) if (e.selected) { if (++c > 1) return false; }
    return c === 1;
  }, [nodes, edges]);
  const selectedEdge = useMemo(
    () => (selectedNode ? null : edges.find((e) => e.selected) || null),
    [edges, selectedNode]
  );
  // Top-level selected nodes (framed children skipped — their coords are
  // parent-relative). 2+ surfaces the align/distribute toolbar.
  const multiCount = useMemo(
    () => nodes.filter((n) => n.selected && n.type !== "zone" && !n.parentId).length,
    [nodes]
  );
  // Bulk edit: 2+ selected nodes that share ONE editable family (all shapes, all
  // stickies, …) → surface the same Inspector as a single node, but every edit
  // applies to the whole selection (patchNodeData & friends already fan out over
  // n.selected). `rep` is the first, read for the displayed values. Mixed types
  // → null (no shared control set). Framed children count — colour/font edits
  // don't care about parentId.
  const bulkSelection = useMemo(() => {
    const fam = (n) => (["shape", "rect", "ellipse", "diamond"].includes(n.type) ? "shape" : n.type);
    const sel = nodes.filter((n) => n.selected && n.type !== "zone");
    if (sel.length < 2) return null;
    const f = fam(sel[0]);
    return sel.every((n) => fam(n) === f) ? { family: f, rep: sel[0], count: sel.length } : null;
  }, [nodes]);
  const touchInspectorVisible = !!(selectedNode && singleSelection && WB_TOUCH);

  // Align / distribute the selected top-level nodes by their bounding boxes.
  const arrange = useCallback(
    (op) => {
      setNodes((nds) => {
        // Exclude locked nodes — align/distribute/match-size must not move or
        // resize a node the user pinned (draggable:false + data.locked).
        const sel = nds.filter((n) => n.selected && n.type !== "zone" && !n.parentId && !n.data?.locked && n.draggable !== false);
        if (sel.length < 2) return nds;
        const rs = sel.map((n) => ({
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          w: n.measured?.width ?? n.width ?? 0,
          h: n.measured?.height ?? n.height ?? 0,
        }));
        const minX = Math.min(...rs.map((r) => r.x));
        const maxR = Math.max(...rs.map((r) => r.x + r.w));
        const minY = Math.min(...rs.map((r) => r.y));
        const maxB = Math.max(...rs.map((r) => r.y + r.h));
        const cX = (minX + maxR) / 2, cY = (minY + maxB) / 2;
        const pos = new Map();
        for (const r of rs) {
          let { x, y } = r;
          if (op === "left") x = minX;
          else if (op === "right") x = maxR - r.w;
          else if (op === "centerH") x = cX - r.w / 2;
          else if (op === "top") y = minY;
          else if (op === "bottom") y = maxB - r.h;
          else if (op === "middleV") y = cY - r.h / 2;
          pos.set(r.id, { x, y });
        }
        if (op === "distH" || op === "distV") {
          const horiz = op === "distH";
          const sorted = [...rs].sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
          const span = horiz ? maxR - minX : maxB - minY;
          const used = sorted.reduce((s, r) => s + (horiz ? r.w : r.h), 0);
          const gap = (span - used) / (sorted.length - 1);
          let cursor = horiz ? minX : minY;
          for (const r of sorted) {
            pos.set(r.id, horiz ? { x: cursor, y: r.y } : { x: r.x, y: cursor });
            cursor += (horiz ? r.w : r.h) + gap;
          }
        }
        // Match-size: set every selected node's width / height to the largest.
        const size = new Map();
        if (op === "matchW" || op === "matchH") {
          const dim = op === "matchW" ? "w" : "h";
          const target = Math.max(...rs.map((r) => r[dim]));
          for (const r of rs) size.set(r.id, op === "matchW" ? { width: target } : { height: target });
        }
        return nds.map((n) => {
          if (size.has(n.id)) return { ...n, ...size.get(n.id) };
          if (pos.has(n.id)) return { ...n, position: { ...n.position, ...pos.get(n.id) } };
          return n;
        });
      });
    },
    [setNodes]
  );

  const patchNodeData = useCallback(
    (patch) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.selected && n.type !== "zone"
            ? { ...n, data: { ...n.data, ...patch } }
            : n
        )
      );
    },
    [setNodes]
  );

  // Nudge the font size of every selected text/shape/sticky by `delta` px,
  // clamped, each from its OWN current size (so a mixed selection stays
  // proportional). Defaults match TextPanel: 16 for text/sticky, 13 for shapes.
  const bumpSelectedFontSize = useCallback(
    (delta) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (!n.selected || !["text", "sticky", "shape"].includes(n.type)) return n;
          const base = n.data?.fontSize ?? (n.type === "shape" ? 13 : 16);
          const next = Math.max(8, Math.min(200, base + delta));
          return next === n.data?.fontSize ? n : { ...n, data: { ...n.data, fontSize: next } };
        })
      );
    },
    [setNodes]
  );

  // Lock / unlock the selected node(s). React Flow's per-node `draggable:false`
  // stops the move; the resizer is hidden via data.locked in each node. Both
  // persist (snapshot + sync), so a lock is shared with everyone on the board.
  const setSelectedLocked = useCallback(
    (locked) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.selected && n.type !== "zone"
            ? { ...n, draggable: locked ? false : undefined, data: { ...n.data, locked } }
            : n
        )
      );
    },
    [setNodes]
  );

  // Per-node opacity via React Flow's node.style (persists + syncs). 1 clears it.
  const setSelectedOpacity = useCallback(
    (opacity) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.selected && n.type !== "zone"
            ? { ...n, style: { ...(n.style || {}), opacity: opacity >= 1 ? undefined : opacity } }
            : n
        )
      );
    },
    [setNodes]
  );

  // Z-order: stacking follows array order (later = on top). Move the selection
  // to the end (front) or start (back); sortParentsFirst is a stable sort so it
  // only re-pins frames ahead of their children, keeping the new order. Persists
  // in the snapshot; live-syncs on the next reload (order isn't a per-entity op).
  const reorderSelected = useCallback(
    (toFront) => {
      setNodes((nds) => {
        const selIds = new Set(nds.filter((n) => n.selected && n.type !== "zone").map((n) => n.id));
        if (!selIds.size) return nds;
        const sel = nds.filter((n) => selIds.has(n.id));
        const rest = nds.filter((n) => !selIds.has(n.id));
        return sortParentsFirst(toFront ? [...rest, ...sel] : [...sel, ...rest]);
      });
    },
    [setNodes]
  );

  return {
    selectedNode,
    singleSelection,
    selectedEdge,
    multiCount,
    bulkSelection,
    touchInspectorVisible,
    arrange,
    patchNodeData,
    bumpSelectedFontSize,
    setSelectedLocked,
    setSelectedOpacity,
    reorderSelected,
  };
}
