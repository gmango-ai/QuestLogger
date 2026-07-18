import { useEffect } from "react";
import { requestNodeEdit } from "./nodes";

// Whiteboard keyboard shortcuts:
// • Tool switch (single letter, Figma-style): V/S select, P pen, B brush,
//   L laser, O lasso — press the active tool's key again (or Esc) to drop back
//   to select.
// • ⌘/Ctrl +/−/0 zoom, Shift+1 fits, arrows pan (when nothing's selected —
//   otherwise React Flow nudges the selected node), undo/redo, copy/cut, ⌘D
//   duplicate, "Q" quick-palette.
// • ⌘] / ⌘[ bring the selection to front / send to back.
// • ⌘⇧. / ⌘⇧, grow / shrink the selected text/shape/sticky font.
// • Esc drops to select / cancels a region selection; Delete on a floating
//   region selection.
// Gated to when the board is hovered/focused and you're not typing, so it
// doesn't hijack keys for the rest of the app (e.g. an embedded room). The
// dependency array is intentionally [rf, undo, redo] (the other callbacks are
// stable or read through refs).
export function useWhiteboardKeyboard({
  rf, undo, redo, toolRef, setTool, setPalette,
  copyRef, cutRef, cloneRef,
  cancelAreaSelection, deleteAreaSelection, areaSelRef,
  reorderSelected, bumpSelectedFontSize,
  mainRef, lastClientRef, readOnly = false,
}) {
  useEffect(() => {
    function onKey(e) {
      const el = document.activeElement;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      )
        return;
      const board = mainRef.current;
      if (!board || !(board.matches(":hover") || board.contains(el))) return;
      // Read-only (public viewer): allow ONLY navigation — no tool switch,
      // node edit, undo/redo, copy/cut/clone, reorder, or font changes.
      if (readOnly) {
        const modRO = e.metaKey || e.ctrlKey;
        if (modRO && (e.key === "=" || e.key === "+")) { e.preventDefault(); rf.zoomIn({ duration: 150 }); }
        else if (modRO && e.key === "-") { e.preventDefault(); rf.zoomOut({ duration: 150 }); }
        else if (modRO && e.key === "0") { e.preventDefault(); rf.zoomTo(1, { duration: 150 }); }
        else if (e.shiftKey && e.key === "1") { e.preventDefault(); rf.fitView({ padding: 0.15, duration: 200 }); }
        else if (e.key.startsWith("Arrow")) {
          const step = e.shiftKey ? 200 : 60;
          const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
          if (d) { e.preventDefault(); const vp = rf.getViewport(); rf.setViewport({ x: vp.x + d[0], y: vp.y + d[1], zoom: vp.zoom }); }
        }
        return;
      }
      // A floating region selection intercepts Esc (cancel) + Delete/Backspace.
      if (areaSelRef.current) {
        if (e.key === "Escape") { e.preventDefault(); cancelAreaSelection(); setTool("select"); return; }
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteAreaSelection(); return; }
      }
      // Enter opens text edit on the SINGLE selected node (edit-on-create is off,
      // so this is how you start typing). The input guard above means Enter while
      // already editing types a newline instead of reaching here.
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const sel = rf.getNodes().filter((n) => n.selected && n.type !== "zone");
        if (sel.length === 1) { e.preventDefault(); requestNodeEdit(sel[0].id); return; }
      }
      // Escape drops back to the select tool (exit laser mode).
      if (e.key === "Escape") { setTool("select"); return; }
      // "Q" pops the quick-tool palette at the cursor (so items spawn where you
      // are) — works even when the left toolbar is collapsed. Falls back to the
      // board centre if we haven't seen the pointer yet.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "q") {
        e.preventDefault();
        const r = mainRef.current?.getBoundingClientRect();
        const at = lastClientRef.current || (r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 200, y: 200 });
        setPalette((p) => (p ? null : at));
        return;
      }
      // Single-key tool switch (Figma-style). Pressing the active tool's own key
      // again toggles back to select, so one key both picks AND drops a tool.
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = { v: "select", s: "select", p: "pen", b: "brush", l: "laser", o: "lasso" }[e.key.toLowerCase()];
        if (t) {
          e.preventDefault();
          setTool(toolRef.current === t && t !== "select" ? "select" : t);
          return;
        }
      }
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (k === "y" || (k === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (mod && k === "c") {
        // Only swallow the key if we actually copied nodes — otherwise let
        // the browser copy selected text as usual.
        if (copyRef.current?.()) e.preventDefault();
      } else if (mod && k === "x") {
        if (cutRef.current?.()) e.preventDefault();
      } else if (mod && e.key === "]") {
        e.preventDefault(); // (also suppresses browser fwd-nav)
        reorderSelected?.(true); // bring to front
      } else if (mod && e.key === "[") {
        e.preventDefault(); // (also suppresses browser back-nav)
        reorderSelected?.(false); // send to back
      } else if (mod && (e.key === ">" || (e.shiftKey && e.key === "."))) {
        e.preventDefault();
        bumpSelectedFontSize?.(2);
      } else if (mod && (e.key === "<" || (e.shiftKey && e.key === ","))) {
        e.preventDefault();
        bumpSelectedFontSize?.(-2);
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        rf.zoomIn({ duration: 150 });
      } else if (mod && e.key === "-") {
        e.preventDefault();
        rf.zoomOut({ duration: 150 });
      } else if (mod && e.key === "0") {
        e.preventDefault();
        rf.zoomTo(1, { duration: 150 });
      } else if (mod && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        const sel = rf
          .getNodes()
          .filter((n) => n.selected && n.type !== "zone")
          .map((n) => n.id);
        if (sel.length) cloneRef.current?.(sel);
      } else if (e.shiftKey && e.key === "1") {
        e.preventDefault();
        rf.fitView({ padding: 0.15, duration: 200 });
      } else if (e.key.startsWith("Arrow")) {
        if (rf.getNodes().some((n) => n.selected)) return; // let RF move the node
        const step = e.shiftKey ? 200 : 60;
        const d = {
          ArrowLeft: [step, 0],
          ArrowRight: [-step, 0],
          ArrowUp: [0, step],
          ArrowDown: [0, -step],
        }[e.key];
        if (!d) return;
        e.preventDefault();
        const vp = rf.getViewport();
        rf.setViewport({ x: vp.x + d[0], y: vp.y + d[1], zoom: vp.zoom });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rf, undo, redo, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps
}
