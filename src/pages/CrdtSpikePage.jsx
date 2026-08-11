// SPIKE ONLY — proof-of-concept for docs/plans/whiteboard-crdt-local-first.md.
// A minimal sticky-note board bound to a Yjs doc, synced over the existing
// Supabase broadcast channel, cached locally with y-indexeddb, with awareness
// cursors and a single-writer Storage snapshot. NOT production; a public route
// (/spike/crdt/:boardId?) so it's testable in two tabs without login.
//
// Success criteria (see the plan): (1) two tabs edit the SAME sticky's text at
// once and both land; (2) offline edits merge on reconnect; (3) instant load
// from IndexedDB; (4) DB snapshot round-trips (cold load); (5) small delta
// payloads; (6) transport stays under the broadcast size limit.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import { supabase } from "../supabase";
import { SupabaseYjsProvider } from "../spike/crdtProvider";
import { saveYjsSnapshot, loadYjsSnapshot } from "../spike/crdtSnapshot";
import { bindTextarea } from "../spike/crdtTextBinding";

const COLORS = ["#ef4444", "#f97316", "#22c55e", "#0ea5e9", "#a855f7", "#ec4899"];
const rid = () => Math.random().toString(36).slice(2, 9);

// The board's Y.Map<id, Y.Text> passed via context so node.data stays PLAIN.
// (Putting a Y.Text — which holds circular refs back to the doc — directly in
// node.data breaks React Flow v12's internal node processing and the node never
// renders. Keep node.data serializable; look the CRDT type up by id here.)
const TextsCtx = createContext(null);

// A sticky node whose textarea is bound to its Y.Text (character-level merge).
function StickyNode({ data }) {
  const ref = useRef(null);
  const texts = useContext(TextsCtx);
  const yText = texts?.get(data.id);
  useEffect(() => {
    if (!ref.current || !yText) return undefined;
    return bindTextarea(yText, ref.current);
  }, [yText]);
  return (
    <div style={{ width: 180, height: 120, background: "#fef9c3", border: "1px solid #eab308", borderRadius: 8, boxShadow: "0 2px 6px rgba(0,0,0,.15)", padding: 6 }}>
      <div style={{ fontSize: 9, color: "#a16207", marginBottom: 2 }}>#{data.id}</div>
      <textarea
        ref={ref}
        className="nodrag"
        style={{ width: "100%", height: 88, resize: "none", border: "none", background: "transparent", outline: "none", fontSize: 13, fontFamily: "inherit" }}
        placeholder="type here…"
      />
    </div>
  );
}
const NODE_TYPES = { sticky: StickyNode };

function SpikeInner() {
  const { boardId = "default" } = useParams();
  const me = useMemo(() => ({ name: `guest-${rid().slice(0, 4)}`, color: COLORS[Math.floor(Math.random() * COLORS.length)] }), []);

  const docRef = useRef(null);
  const textsRef = useRef(null);
  const posRef = useRef(null);
  const awarenessRef = useRef(null);
  const providerRef = useRef(null);
  const idbRef = useRef(null);
  const uidRef = useRef(null);
  const draggingRef = useRef(new Set());

  const [nodes, setNodes] = useState([]);
  const [textsMap, setTextsMap] = useState(null); // Y.Map<id,Y.Text> for the node context
  const [metrics, setMetrics] = useState({ sent: 0, recv: 0, bytesSent: 0, bytesRecv: 0, peers: 1 });
  const [synced, setSynced] = useState(false);
  const [online, setOnline] = useState(true);
  const [isPersister, setIsPersister] = useState(true);
  const [peers, setPeers] = useState([]);
  const [snapInfo, setSnapInfo] = useState("");
  const [idbLoadedMs, setIdbLoadedMs] = useState(null);

  // Build the xyflow node list from the CRDT maps. Keeps a stable data.yText ref
  // so position updates never remount the textarea (which would drop focus).
  const rebuild = useCallback(() => {
    const texts = textsRef.current;
    const pos = posRef.current;
    if (!texts) return;
    const list = [];
    texts.forEach((_yText, id) => {
      const p = pos.get(id) || { x: 40, y: 40 };
      // data stays PLAIN (just the id); the Y.Text is resolved in StickyNode via
      // context. See TextsCtx above.
      list.push({ id, type: "sticky", position: { x: p.x, y: p.y }, data: { id } });
    });
    setNodes(list);
  }, []);

  // Update only positions from remote (don't clobber a node we're dragging).
  const applyRemotePositions = useCallback(() => {
    const pos = posRef.current;
    setNodes((prev) => prev.map((n) => {
      if (draggingRef.current.has(n.id)) return n;
      const p = pos.get(n.id);
      return p && (p.x !== n.position.x || p.y !== n.position.y) ? { ...n, position: { x: p.x, y: p.y } } : n;
    }));
  }, []);

  const recomputePersister = useCallback(() => {
    const aw = awarenessRef.current;
    const doc = docRef.current;
    if (!aw || !doc) return;
    const ids = [...aw.getStates().keys(), doc.clientID];
    setIsPersister(doc.clientID === Math.min(...ids));
    setPeers([...aw.getStates().entries()].filter(([cid]) => cid !== doc.clientID).map(([cid, s]) => ({ cid, ...(s.user || {}), cursor: s.cursor })));
  }, []);

  // ── connect / reconnect the broadcast provider (also used by the offline toggle) ──
  const connect = useCallback(() => {
    if (providerRef.current) return;
    const provider = new SupabaseYjsProvider(docRef.current, `crdt-spike:${boardId}`, {
      awareness: awarenessRef.current,
      onSynced: () => setSynced(true),
      onChange: (m) => { setMetrics({ ...m }); recomputePersister(); },
    });
    providerRef.current = provider;
    setOnline(true);
  }, [boardId, recomputePersister]);

  const disconnect = useCallback(() => {
    providerRef.current?.destroy();
    providerRef.current = null;
    setOnline(false);
    setSynced(false);
  }, []);

  // ── one-time doc + persistence + provider setup ──
  // StrictMode-safe: everything is created + wired SYNCHRONOUSLY (no async-gated
  // provider), and cleanup tears it all down, so the dev double-mount can't
  // cross-wire two docs.
  useEffect(() => {
    let disposed = false;
    const doc = new Y.Doc();
    const texts = doc.getMap("texts");
    const pos = doc.getMap("positions");
    const awareness = new Awareness(doc);
    awareness.setLocalStateField("user", me);
    docRef.current = doc;
    textsRef.current = texts;
    posRef.current = pos;
    awarenessRef.current = awareness;
    setTextsMap(texts); // feed StickyNode's context

    // node add/remove → rebuild list; position change → move; text handled by binding.
    texts.observe(rebuild);
    pos.observe(applyRemotePositions);
    awareness.on("update", recomputePersister);

    const idb = new IndexeddbPersistence(`crdt-spike-${boardId}`, doc);
    idbRef.current = idb;
    const t0 = performance.now();
    idb.whenSynced.then(() => {
      if (disposed) return;
      setIdbLoadedMs(Math.round(performance.now() - t0));
      rebuild(); // reflect any locally-cached state
    });

    connect(); // synchronous provider — deterministic under StrictMode

    // Cold-load from the DB snapshot (best-effort; needs auth). Merges idempotently.
    supabase.auth.getSession().then(async ({ data }) => {
      if (disposed) return;
      uidRef.current = data?.session?.user?.id || null;
      if (!uidRef.current) return;
      try {
        const r = await loadYjsSnapshot(uidRef.current, boardId, doc);
        if (!disposed && r.loaded) { setSnapInfo(`loaded ${r.bytes}B from DB`); rebuild(); }
      } catch { /* best-effort */ }
    });

    rebuild();
    recomputePersister();

    return () => {
      disposed = true;
      providerRef.current?.destroy();
      providerRef.current = null;
      try { textsRef.current?.unobserve(rebuild); } catch { /* */ }
      try { posRef.current?.unobserve(applyRemotePositions); } catch { /* */ }
      try { awareness.off("update", recomputePersister); awareness.destroy(); } catch { /* */ }
      try { idb.destroy(); } catch { /* */ }
      try { doc.destroy(); } catch { /* */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  // Single-writer snapshot: only the lowest-clientID present persists, every 5s.
  useEffect(() => {
    const iv = setInterval(async () => {
      if (!isPersister || !uidRef.current || !docRef.current) return;
      const r = await saveYjsSnapshot(uidRef.current, boardId, docRef.current);
      if (!r.error) setSnapInfo(`saved ${r.bytes}B to DB (writer)`);
    }, 5000);
    return () => clearInterval(iv);
  }, [isPersister, boardId]);

  const onNodesChange = useCallback((changes) => {
    setNodes((prev) => applyNodeChanges(changes, prev));
    const pos = posRef.current;
    for (const c of changes) {
      if (c.type !== "position" || !c.position) continue;
      if (c.dragging) draggingRef.current.add(c.id); else draggingRef.current.delete(c.id);
      pos.set(c.id, { x: c.position.x, y: c.position.y });
    }
  }, []);

  const addSticky = useCallback(() => {
    const doc = docRef.current;
    const id = rid();
    doc.transact(() => {
      const t = new Y.Text();
      textsRef.current.set(id, t);
      t.insert(0, "New note");
      posRef.current.set(id, { x: 60 + Math.random() * 300, y: 60 + Math.random() * 200 });
    });
  }, []);

  const onPaneMouseMove = useCallback((e) => {
    const aw = awarenessRef.current;
    if (!aw) return;
    const r = e.currentTarget.getBoundingClientRect();
    aw.setLocalStateField("cursor", { x: e.clientX - r.left, y: e.clientY - r.top });
  }, []);

  const kb = (n) => (n > 9999 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div style={{ width: "100%", height: "100%" }} onMouseMove={onPaneMouseMove}>
        <TextsCtx.Provider value={textsMap}>
          <ReactFlow nodes={nodes} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} fitView proOptions={{ hideAttribution: true }}>
            <Background />
            <Controls />
          </ReactFlow>
        </TextsCtx.Provider>
        {/* awareness cursors (screen coords) */}
        {peers.filter((p) => p.cursor).map((p) => (
          <div key={p.cid} style={{ position: "absolute", left: p.cursor.x, top: p.cursor.y, pointerEvents: "none", zIndex: 50 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: p.color || "#888" }} />
            <div style={{ fontSize: 10, background: p.color || "#888", color: "#fff", padding: "0 4px", borderRadius: 3 }}>{p.name}</div>
          </div>
        ))}
      </div>

      {/* HUD */}
      <div style={{ position: "absolute", top: 10, left: 10, zIndex: 100, background: "rgba(15,23,42,.92)", color: "#e2e8f0", font: "12px/1.5 ui-monospace, monospace", padding: "10px 12px", borderRadius: 8, width: 280 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>CRDT spike — board: {boardId}</div>
        <div>me: <span style={{ color: me.color }}>{me.name}</span> · peers: {peers.length}</div>
        <div>synced: {synced ? "✅" : "…"} · writer(single): {isPersister ? "✅ me" : "another"}</div>
        <div>idb load: {idbLoadedMs == null ? "…" : `${idbLoadedMs}ms`}</div>
        <div>msgs ↑{metrics.sent} ↓{metrics.recv} · bytes ↑{kb(metrics.bytesSent)} ↓{kb(metrics.bytesRecv)}</div>
        <div>snapshot: {snapInfo || "—"}</div>
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <button onClick={addSticky} style={btn}>+ sticky</button>
          <button onClick={online ? disconnect : connect} style={{ ...btn, background: online ? "#16a34a" : "#dc2626" }}>{online ? "online" : "OFFLINE"}</button>
          <button
            onClick={async () => { const r = await saveYjsSnapshot(uidRef.current, boardId, docRef.current); setSnapInfo(r.error ? r.error.message : `saved ${r.bytes}B`); }}
            style={btn}
          >save
          </button>
        </div>
        <div style={{ marginTop: 6, opacity: 0.7 }}>Open this URL in 2 tabs. Edit the same note; toggle OFFLINE, edit, go online → merges.</div>
      </div>
    </div>
  );
}

const btn = { fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "none", background: "#334155", color: "#fff", cursor: "pointer" };

export default function CrdtSpikePage() {
  return (
    <ReactFlowProvider>
      <SpikeInner />
    </ReactFlowProvider>
  );
}
