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

// Live collaboration is delivered over the realtime BROADCAST channel, so the DB
// write is only a durability CHECKPOINT (for cold-load when no peers are present)
// — it does not need to fire per edit-burst. Save on a longer idle debounce, with
// a hard max-wait so a long continuous session still checkpoints.
const SAVE_DEBOUNCE_MS = 4000;
const MAX_SAVE_WAIT_MS = 15000;
// On save failure, back off (capped) instead of re-sending the whole board on the
// next keystroke — that self-sustaining re-send is what turned a slow write into
// a storm during the retro.
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

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
  // Single-writer election (from useWhiteboardSync): only the elected persister
  // writes the board to the DB; everyone else edits live over broadcast and
  // relies on the persister for durability. Defaults true so a non-synced /
  // solo / embedded board always persists.
  canPersist = true,
}) {
  const lastSavedRef = useRef("");
  const saveTimerRef = useRef(null);
  const seededRef = useRef(false);
  // Cadence + backoff bookkeeping.
  const pendingSinceRef = useRef(0);   // when the current unsaved run began (for max-wait)
  const backoffUntilRef = useRef(0);   // don't attempt a save before this time
  const failuresRef = useRef(0);
  // Live state read by the (possibly delayed / retry) save timer so it never
  // writes stale data regardless of which render's closure fires it.
  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const edgesRef = useRef(edges); edgesRef.current = edges;
  const canPersistRef = useRef(canPersist); canPersistRef.current = canPersist;

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

  // ── single-writer, idle-checkpointed save ──
  // Only the elected persister writes to the DB; everyone else's edits are already
  // shared live over broadcast, so N concurrent editors cost one write stream, not
  // N full-board writes (the retro-brownout fix). The persister saves on an idle
  // debounce with a max-wait ceiling, and backs off on failure instead of
  // re-sending the whole board on the next keystroke.
  //
  // Reads live state from refs so a delayed / retry timer never writes stale data.
  useEffect(() => {
    if (readOnly || !board?.id || loading) return undefined;

    // Not the persister: our edits propagate live via broadcast and the persister
    // durably saves them — issue ZERO DB writes here.
    if (!canPersist) {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      pendingSinceRef.current = 0;
      setSaveState("saved");
      return undefined;
    }

    async function flushSave() {
      saveTimerRef.current = null;
      if (readOnly || !board?.id || !canPersistRef.current) return;
      const snap = { nodes: nodesRef.current, edges: edgesRef.current };
      const serialized = JSON.stringify(snap);
      if (serialized === lastSavedRef.current) {
        pendingSinceRef.current = 0;
        setSaveState("saved");
        return;
      }
      setSaveState("saving");
      const { error: err } = await saveSnapshot(board.id, snap);
      if (err) {
        failuresRef.current = Math.min(failuresRef.current + 1, 12);
        backoffUntilRef.current = Date.now() + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** failuresRef.current);
        setSaveState("dirty");
        setError(err.message || "Couldn't save changes — retrying…");
        scheduleSave(); // keep pendingSinceRef so the max-wait ceiling still applies
        return;
      }
      failuresRef.current = 0;
      backoffUntilRef.current = 0;
      pendingSinceRef.current = 0;
      lastSavedRef.current = serialized;
      setSaveState("saved");
      onSaved?.(); // a real change landed → let the editor refresh the thumbnail
    }

    function scheduleSave() {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const now = Date.now();
      if (!pendingSinceRef.current) pendingSinceRef.current = now;
      const saveAt = Math.max(
        Math.min(now + SAVE_DEBOUNCE_MS, pendingSinceRef.current + MAX_SAVE_WAIT_MS),
        backoffUntilRef.current,
      );
      saveTimerRef.current = setTimeout(flushSave, Math.max(0, saveAt - now));
    }

    setSaveState("dirty");
    scheduleSave();
    return () => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    };
  }, [nodes, edges, board?.id, loading, canPersist]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load every Google font in use (including fonts that arrive from peers via
  // sync). ensureGoogleFont is idempotent and a no-op for the built-in presets.
  useEffect(() => {
    for (const n of nodes) ensureGoogleFont(n.data?.fontFamily);
  }, [nodes]);

  // Flush pending edits on unmount / tab close — persister only. This also covers
  // the "last participant leaves" case: whoever is the persister at that moment
  // writes the final state (a new persister that just took over on handoff will
  // have re-checkpointed via the save effect above). Reads refs so it always
  // flushes the latest state.
  useEffect(() => {
    if (readOnly) return undefined;
    function flush() {
      if (!canPersistRef.current || !board?.id) return;
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      const snap = { nodes: nodesRef.current, edges: edgesRef.current };
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
  }, [board?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}
