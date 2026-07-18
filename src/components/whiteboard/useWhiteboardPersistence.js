import { useEffect, useRef } from "react";
import {
  fetchWhiteboardById,
  saveSnapshot,
  templateSnapshotFor,
  isEmptySnapshot,
} from "../../lib/whiteboard";
import { declampNodes } from "./frame";
import { ensureGoogleFont } from "../../lib/whiteboardFonts";
import { loadViewport } from "./wbStorage";

const SAVE_DEBOUNCE_MS = 1200;

// Board lifecycle persistence for the whiteboard editor, extracted from
// WhiteboardPage.jsx: load metadata + snapshot (seeding a template when empty),
// debounced snapshot save on every node/edge change, Google-font loading for
// synced content, and a flush on unmount / tab close. Pure side-effects — the
// three bookkeeping refs (seed / last-saved / debounce timer) live in here.
export function useWhiteboardPersistence({
  boardId, embedded, rf,
  nodes, edges, setNodes, setEdges,
  board, setBoard, loading, setLoading, setError, setSaveState,
  setTitleDraft, setGoalDraft, readOnly = false, onSaved,
}) {
  const lastSavedRef = useRef("");
  const saveTimerRef = useRef(null);
  const seededRef = useRef(false);

  // ── load board metadata + snapshot, seed template if empty ──
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!boardId) return;
      setLoading(true);
      setError("");
      const { data, error: err } = await fetchWhiteboardById(boardId);
      if (cancelled) return;
      if (err || !data) {
        setError(err?.message || "Whiteboard not found.");
        setBoard(null);
        setLoading(false);
        return;
      }
      setBoard(data);
      setTitleDraft(data.title || "");
      setGoalDraft(data.goal || "");
      // Snapshot OR template seed.
      let snap = data.snapshot;
      if (!snap || isEmptySnapshot(snap)) {
        if (readOnly) {
          snap = { nodes: [], edges: [] }; // never seed a template for a read-only viewer
        } else if (!seededRef.current) {
          seededRef.current = true;
          snap = templateSnapshotFor(data.template_key);
        } else {
          snap = { nodes: [], edges: [] };
        }
      }
      // Strip any legacy extent:"parent" clamp so children dragged in from
      // older boards/templates aren't trapped in their frame.
      const loadedNodes = declampNodes(snap.nodes || []);
      const loadedEdges = snap.edges || [];
      setNodes(loadedNodes);
      setEdges(loadedEdges);
      // Stamp our baseline from the (declamped) state we actually set so the
      // first save-tick doesn't round-trip — the board re-saves clean on the
      // next real edit.
      lastSavedRef.current = JSON.stringify({
        nodes: loadedNodes,
        edges: loadedEdges,
      });
      setLoading(false);
      // Restore this board's saved pan/zoom (full-page only); a first visit or
      // an embedded board falls back to fit-to-view. Deferred so layout settles.
      const savedVp = embedded ? null : loadViewport(data.id);
      setTimeout(() => {
        try {
          if (savedVp) rf.setViewport(savedVp, { duration: 0 });
          else rf.fitView({ padding: 0.15, duration: 0 });
        } catch {
          /* */
        }
      }, 60);
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  // ── debounced save on every node / edge change ──
  // We collapse rapid edits into a single network call. The save is
  // gated on the serialized snapshot diff so things like cursor moves
  // that don't change state don't burn writes.
  useEffect(() => {
    if (readOnly) return; // read-only viewers never write
    if (!board?.id) return;
    if (loading) return;
    setSaveState("dirty");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      const snap = { nodes, edges };
      const serialized = JSON.stringify(snap);
      if (serialized === lastSavedRef.current) {
        setSaveState("saved");
        return;
      }
      setSaveState("saving");
      const { error: err } = await saveSnapshot(board.id, snap);
      if (err) {
        setError(err.message || "Couldn't save changes.");
        setSaveState("dirty");
        return;
      }
      lastSavedRef.current = serialized;
      setSaveState("saved");
      onSaved?.(); // a real change landed → let the editor refresh the thumbnail
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [nodes, edges, board?.id, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load every Google font in use (including fonts that arrive from peers via
  // sync). ensureGoogleFont is idempotent and a no-op for the built-in presets.
  useEffect(() => {
    for (const n of nodes) ensureGoogleFont(n.data?.fontFamily);
  }, [nodes]);

  // Flush pending edits on unmount / tab close.
  useEffect(() => {
    if (readOnly) return undefined;
    function flush() {
      if (!saveTimerRef.current || !board?.id) return;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      const snap = { nodes, edges };
      const serialized = JSON.stringify(snap);
      if (serialized === lastSavedRef.current) return;
      saveSnapshot(board.id, snap);
      lastSavedRef.current = serialized;
    }
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [board?.id, nodes, edges]); // eslint-disable-line react-hooks/exhaustive-deps
}
