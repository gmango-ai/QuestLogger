import { memo, createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import { Handle, Position, NodeResizer, useReactFlow } from "@xyflow/react";
import { nodeAbsPos, sortParentsFirst } from "./frame";
import { Target, ChevronDown, Building2, User, Star, X, Plus, CalendarClock, Check } from "lucide-react";
import { useParams } from "react-router-dom";
import { useTeam } from "../../context/TeamContext";
import { useApp } from "../../context/AppContext";
import { useTheme } from "../../context/ThemeContext";
import { setGoal, clearGoalNode, GOAL_TIMEFRAMES, timeframeToParams } from "../../lib/goals";
import { fontStack } from "../../lib/whiteboardFonts";
import FullEmojiPicker from "../emotes/FullEmojiPicker";
import EmojiTextField from "../EmojiTextField";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

// Markdown rendering for node display text. gfm = bold/italic, lists, links,
// tables, task checkboxes; breaks = a single newline stays a line break (so
// existing multi-line notes don't suddenly collapse into one paragraph).
const MD_PLUGINS = [remarkGfm, remarkBreaks];
const MD_COMPONENTS = {
  // Links open in a new tab and must NOT start a node drag or bubble into the
  // "click to edit" handler on the node body.
  a: ({ node, ...props }) => (
    <a
      {...props}
      className="nodrag"
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
    />
  ),
};

// Flip the Nth `- [ ]`/`- [x]` task marker in the source text. Document order
// (what react-markdown renders) matches the regex's left-to-right order, so the
// index lines up.
function toggleTask(text, index) {
  if (!text) return text;
  let i = 0;
  return text.replace(/^(\s*[-*+]\s+)\[([ xX])\]/gm, (m, lead, mark) =>
    i++ === index ? `${lead}[${mark === " " ? "x" : " "}]` : m,
  );
}

// Markdown components with INTERACTIVE task checkboxes: clicking one toggles
// the matching marker in the source and writes it back via onChange (so it
// syncs + persists like any text edit). The per-render counter assigns each
// checkbox its document-order index. stopPropagation keeps a tick from
// selecting / editing the node, and `nodrag` keeps it from starting a drag.
function taskListComponents(value, onChange) {
  const cb = { i: 0 };
  return {
    ...MD_COMPONENTS,
    input: ({ type, checked }) => {
      if (type !== "checkbox") return null;
      const idx = cb.i++;
      return (
        <input
          type="checkbox"
          className="nodrag wb-task"
          checked={!!checked}
          onChange={() => onChange?.(toggleTask(value, idx))}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      );
    },
  };
}

// Full emoji picker for sticky reactions — lazy so its chunk only loads
// when someone opens it.

// Preferred sticky colour (per device) — new stickies (toolbar + frame
// double-click) use it; changing a sticky's colour updates it.
const STICKY_COLOR_KEY = "ql_wb_sticky_color";
export function preferredStickyColor() {
  try { return localStorage.getItem(STICKY_COLOR_KEY) || "yellow"; } catch { return "yellow"; }
}
export function setPreferredStickyColor(c) {
  try { localStorage.setItem(STICKY_COLOR_KEY, c); } catch { /* */ }
}

// Preferred flowchart shape (per device) — the toolbar's shape button drops it
// with ONE click (no dropdown); the caret opens the full catalogue and updates
// it. Lets you lay down a chain of the same shape fast.
const SHAPE_KEY = "ql_wb_shape";
export function preferredShape() {
  try { return localStorage.getItem(SHAPE_KEY) || "process"; } catch { return "process"; }
}
export function setPreferredShape(k) {
  try { localStorage.setItem(SHAPE_KEY, k); } catch { /* */ }
}

let _sid = 1;
function freshStickyId() { return `sticky-${Date.now().toString(36)}-${_sid++}`; }

// Current user's short display name, for stamping authorship.
function useMyName() {
  const { session, settings } = useApp() || {};
  return settings?.name || session?.user?.user_metadata?.name || session?.user?.email?.split("@")[0] || "";
}

const QUICK_REACTIONS = ["👍", "❤️", "🎉", "🔥"];

// Selection accent — follows the user's theme accent (var(--color-accent)) so
// the whole selection treatment (ring, resize handles, shape outline) matches
// the active theme instead of a fixed orange.
const SELECT = "var(--color-accent)";
const SELECT_FILL = "color-mix(in srgb, var(--color-accent) 6%, transparent)";
// Selection = a THICKER version of the item's own outline; items without an
// outline (sticky, text) fall back to the theme accent. Resize handles + guide
// lines take that same colour.
const resizer = (color) => ({ lineStyle: { borderColor: color }, handleStyle: { background: color, border: "2px solid #fff" } });

// Readable text colour (near-black / near-white) for a solid background, so
// labels stay legible on any fill — a white default, a dark-theme surface, or a
// user-picked swatch. Non-hex inputs fall back to dark text.
function readableText(bg) {
  if (typeof bg !== "string" || bg[0] !== "#") return "#0f172a";
  let h = bg.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return "#0f172a";
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#0f172a" : "#f1f5f9";
}

// Vertical text placement (data.vAlign) → flexbox alignment for the text box.
function vAlignFlex(v) {
  return v === "top" ? "flex-start" : v === "bottom" ? "flex-end" : "center";
}


// Nodes that should open straight into edit mode (just created via the
// toolbar or a quick-add pull). Tracked outside node data so the flag
// never persists to the snapshot or syncs to peers.
const PENDING_EDIT = new Set();
// Edit-on-create is DISABLED (user preference): newly created nodes no longer
// open straight into text edit. This is a no-op so the create sites don't need
// touching; use requestNodeEdit (Enter on a selected node) to start typing.
export function markNodeForEdit(_id) { /* disabled — see requestNodeEdit */ }
// Ask an ALREADY-MOUNTED node to open text edit (Enter on a selected node). A
// window event because the target EditableText owns its own `editing` state.
export function requestNodeEdit(id) {
  if (id) window.dispatchEvent(new CustomEvent("wb:edit-node", { detail: { id } }));
}

// Node-level rich-text styling (whole-node, not per-selection markdown). Spread
// into a node's text style so italic / underline / strikethrough / kerning /
// line-height follow the data. Undefined keys are omitted so they don't clobber
// a node's own defaults (e.g. its base lineHeight when data.lineHeight is unset).
export function richTextStyle(data) {
  const deco = [data?.underline && "underline", data?.strikethrough && "line-through"].filter(Boolean).join(" ");
  const s = {};
  if (data?.italic) s.fontStyle = "italic";
  if (deco) s.textDecoration = deco;
  if (data?.lineHeight != null) s.lineHeight = data.lineHeight;
  if (data?.letterSpacing != null) s.letterSpacing = `${data.letterSpacing}px`;
  return s;
}

// The textarea currently being edited registers a "wrap the selection in
// markdown" handler here, so a toolbar button (Inspector B / I) can format the
// LIVE selection without stealing focus. Returns false when nothing is being
// edited (the caller can then fall back to toggling the whole node's text).
const activeEditor = { current: null };
export function wrapActiveSelection(marker) {
  if (!activeEditor.current) return false;
  activeEditor.current(marker);
  return true;
}

// Shared text editor used inside the sticky / text / shape nodes.
// Stops propagating wheel + pointerdown so the canvas doesn't pan under
// the cursor mid-edit. Opens immediately for freshly-created nodes
// (markNodeForEdit) and on a single click once the node is selected.
function EditableText({ value, onChange, placeholder, className, style, nodeId, selected, markdown, wrap }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const textareaRef = useRef(null);
  // Live-collab: while typing we push throttled text updates to the node (which
  // the realtime sync then broadcasts) so peers see edits as they happen, not
  // only on blur. draftRef feeds the throttle the latest text; sentRef tracks
  // what the node already has (skip redundant pushes); editStartRef lets Escape
  // revert to the text as it was when editing began (live pushes moved `value`).
  const draftRef = useRef(draft); draftRef.current = draft;
  const sentRef = useRef(value || "");
  const editStartRef = useRef(value || "");
  const liveTimer = useRef(null);
  const flushLive = useCallback(() => {
    liveTimer.current = null;
    const v = draftRef.current;
    if (v !== sentRef.current) { sentRef.current = v; onChange?.(v); }
  }, [onChange]);
  const scheduleLive = useCallback(() => {
    if (liveTimer.current == null) liveTimer.current = setTimeout(flushLive, 140);
  }, [flushLive]);

  // Fresh nodes (markNodeForEdit) open straight into edit. Consume the
  // flag in an effect — NOT the state initializer — so the delete side
  // effect is StrictMode-safe (state survives its simulated remount).
  useEffect(() => {
    if (nodeId && PENDING_EDIT.has(nodeId)) { PENDING_EDIT.delete(nodeId); setEditing(true); }
  }, [nodeId]);

  // Enter on a selected node (requestNodeEdit) opens edit — edit-on-create is off,
  // so this is how you start typing in an existing node.
  useEffect(() => {
    if (!nodeId) return;
    const onReq = (e) => { if (e.detail?.id === nodeId) setEditing(true); };
    window.addEventListener("wb:edit-node", onReq);
    return () => window.removeEventListener("wb:edit-node", onReq);
  }, [nodeId]);

  // Mirror external value into the draft ONLY when not editing — while editing,
  // the local draft is the source of truth, so an echo of our own push (or a
  // remote edit) can't yank the cursor or revert in-flight characters.
  useEffect(() => {
    if (!editing) setDraft(value || "");
    sentRef.current = value || "";
  }, [value, editing]);
  useEffect(() => {
    if (editing && textareaRef.current) {
      editStartRef.current = value || ""; // snapshot for Escape-revert
      const el = textareaRef.current;
      el.focus();
      el.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  // Cancel a pending push on unmount so a late timer can't fire post-cleanup.
  useEffect(() => () => { if (liveTimer.current) clearTimeout(liveTimer.current); }, []);

  // Register a selection-wrapper while editing so the Inspector B / I buttons
  // can markdown-format the live selection (their mouse-down keeps our focus).
  useEffect(() => {
    if (!editing) return undefined;
    const fn = (marker) => {
      const el = textareaRef.current;
      if (!el) return;
      const s = el.selectionStart ?? 0, e = el.selectionEnd ?? 0;
      const val = el.value, sel = val.slice(s, e), ml = marker.length;
      let next, selStart, selEnd;
      if (sel.length >= 2 * ml && sel.startsWith(marker) && sel.endsWith(marker)) {
        const inner = sel.slice(ml, sel.length - ml); // already wrapped → toggle off
        next = val.slice(0, s) + inner + val.slice(e);
        selStart = s; selEnd = s + inner.length;
      } else {
        next = val.slice(0, s) + marker + sel + marker + val.slice(e);
        selStart = s + ml; selEnd = e + ml;
      }
      setDraft(next.slice(0, 1000));
      scheduleLive();
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        t.focus();
        try { t.setSelectionRange(selStart, selEnd); } catch { /* */ }
      });
    };
    activeEditor.current = fn;
    return () => { if (activeEditor.current === fn) activeEditor.current = null; };
  }, [editing]);

  const commit = useCallback(() => {
    if (liveTimer.current) { clearTimeout(liveTimer.current); liveTimer.current = null; }
    if (draft !== value) onChange?.(draft);
    sentRef.current = draft;
    setEditing(false);
  }, [draft, value, onChange]);

  if (!editing) {
    return (
      <div
        className={`${markdown ? "wb-md" : "whitespace-pre-wrap break-words"} ${className || ""}`}
        style={style}
        onClick={() => { if (selected) setEditing(true); }}
        onDoubleClick={() => setEditing(true)}
      >
        {!value ? (
          <span style={{ opacity: 0.45, fontStyle: "italic" }}>
            {placeholder || "Double-click to edit…"}
          </span>
        ) : markdown ? (
          <ReactMarkdown remarkPlugins={MD_PLUGINS} components={taskListComponents(value, onChange)}>
            {value}
          </ReactMarkdown>
        ) : (
          value
        )}
      </div>
    );
  }

  // A textarea has a cols-based intrinsic WIDTH, which blows up an auto-width
  // node (text) the moment you start editing. So we overlay the textarea on an
  // invisible SIZER with identical typography + wrapping: the grid cell sizes
  // to the sizer (= the text), and the textarea fills it. Editing now hugs the
  // content exactly like display does — in both width and height — for free.
  return (
    // wrap (fixed-width text box): fill the node's pinned width so the hidden
    // sizer wraps at that width instead of growing to max-content while editing.
    <div style={{ display: "grid", width: wrap ? "100%" : undefined }}>
      <div
        aria-hidden
        className={className}
        style={{
          ...style,
          gridArea: "1 / 1",
          visibility: "hidden",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          margin: 0,
          padding: 0,
          minWidth: "1ch",
          pointerEvents: "none",
        }}
      >
        {(draft || placeholder || " ") + "​"}
      </div>
      <EmojiTextField
        multiline
        ref={textareaRef}
        value={draft}
        rows={1}
        cols={1}
        onChange={(e) => { setDraft(e.target.value.slice(0, 1000)); scheduleLive(); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (liveTimer.current) { clearTimeout(liveTimer.current); liveTimer.current = null; }
            const orig = editStartRef.current;
            if (orig !== value) onChange?.(orig); // undo any live pushes
            sentRef.current = orig;
            setDraft(orig);
            setEditing(false);
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { commit(); }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        // `nodrag`/`nowheel` are the canonical React Flow opt-outs: with them the
        // canvas won't start a node drag (or pan/zoom) on a pointer-down inside
        // the textarea, so click-drag SELECTS text instead of moving the node.
        // (stopPropagation alone can't stop d3-drag's capture-phase listener.)
        className={`nodrag nowheel resize-none border-none outline-none bg-transparent overflow-hidden ${className || ""}`}
        style={{ ...style, gridArea: "1 / 1", width: "100%", height: "100%", margin: 0, padding: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      />
    </div>
  );
}

// Shared hook: a stable text-changer for the current node. Wraps
// useReactFlow().setNodes so each node component stays small.
function useNodeTextUpdater(id) {
  const { setNodes } = useReactFlow();
  return useCallback((text) => {
    setNodes((nds) => nds.map((n) => (
      n.id === id ? { ...n, data: { ...n.data, text } } : n
    )));
  }, [id, setNodes]);
}

// Patch arbitrary data fields on the current node.
function useNodeDataPatcher(id) {
  const { setNodes } = useReactFlow();
  return useCallback((patch) => {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  }, [id, setNodes]);
}

// One connection handle per side. With ConnectionMode.Loose on the
// canvas these act as both source and target, and a connection follows
// the DRAG DIRECTION (so the arrow points where you dragged). The prior
// design stacked an invisible target handle over each source handle,
// which made drags start on the target and reversed the arrow.
// Provided by WhiteboardPage: quickConnect(fromNodeId, side) drops a connected
// shape on that side. Powers the shape's directional "create connected node"
// arrows. Null when unavailable (e.g. the read-only kiosk).
export const QuickConnectContext = createContext(null);

// The id of the board these nodes belong to. GoalNode needs the *real* board id
// to key its goal upsert (source_board, source_node); reading it from the route
// (useParams) is wrong when the board is embedded in a room panel, where the
// route has no :whiteboardId — a null board id defeats the upsert's dedupe and
// creates a duplicate goal on every save. Provided by WhiteboardEditor.
export const BoardIdContext = createContext(null);

// Directional arrows around a shape (shown on hover/select). They are real
// React Flow connection Handles, so ONE affordance does both gestures:
//   • CLICK  → drops a connected, parent-matching shape on that side.
//   • DRAG   → pull a connector out; drop on empty canvas (new node where you
//              release) or onto an existing node (connect them). Press 1–9 mid-
//              drag to choose the new shape.
// They replace the tiny edge dots on shapes (same t/r/b/l ids, so all the
// connection logic — onConnectStart/End, ghost, routing — is unchanged).
// Coarse pointer (touch): fingers need a bigger target, and the arrows sit
// farther out to clear the fingertip. Desktop keeps the compact 20px dots.
const NODE_TOUCH =
  typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
const ARROW_SZ = NODE_TOUCH ? 32 : 20;
const ARROW_OFF = NODE_TOUCH ? -40 : -24;
const QUICK_ARROWS = [
  ["t", "▲", Position.Top, { top: ARROW_OFF, left: "50%", transform: "translateX(-50%)" }],
  ["r", "▶", Position.Right, { right: ARROW_OFF, top: "50%", transform: "translateY(-50%)" }],
  ["b", "▼", Position.Bottom, { bottom: ARROW_OFF, left: "50%", transform: "translateX(-50%)" }],
  ["l", "◀", Position.Left, { left: ARROW_OFF, top: "50%", transform: "translateY(-50%)" }],
];
function QuickConnectArrows({ id, color }) {
  const api = useContext(QuickConnectContext);
  const onHover = api?.onHover;
  const connect = api?.connect;
  const pickedShape = api?.pickedShape;
  return (
    <>
      {QUICK_ARROWS.map(([side, glyph, position, pos]) => (
        <Handle
          key={side}
          type="source"
          position={position}
          id={side}
          className="wb-quick-arrow nodrag nopan"
          title="Click to add a connected shape, or drag to place it · press 1–9 to pick its shape"
          onMouseEnter={() => onHover?.(true)}
          onMouseLeave={() => onHover?.(false)}
          onClick={(e) => { e.stopPropagation(); connect?.(id, side); }}
          style={{
            width: ARROW_SZ, height: ARROW_SZ,
            display: "flex", alignItems: "center", justifyContent: "center",
            borderRadius: 9999, fontSize: NODE_TOUCH ? 13 : 9, lineHeight: 1, color: "#fff",
            background: color, border: "1.5px solid #fff",
            boxShadow: "0 1px 3px rgba(0,0,0,.3)", cursor: "crosshair", zIndex: 8, ...pos,
          }}
        >
          {/* Pre-picked shape (via number keys) previews here; else a direction
              arrow. pointer-events off so the Handle beneath owns the gesture. */}
          {pickedShape ? (
            <svg width={NODE_TOUCH ? 18 : 12} height={NODE_TOUCH ? 14 : 9} viewBox="0 0 12 9" style={{ display: "block", pointerEvents: "none" }}>
              <ShapeSvg shape={pickedShape} w={12} h={9} fill="none" stroke="#fff" sw={1.2} />
            </svg>
          ) : (
            <span style={{ pointerEvents: "none" }}>{glyph}</span>
          )}
        </Handle>
      ))}
    </>
  );
}


// ─── StickyNote ───────────────────────────────────────────────────

// Legacy named sticky colors (still on old notes). New notes store a hex
// directly; stickyHex() resolves either form to a hex.
export const STICKY_BG = {
  yellow: "#fde68a", pink: "#fbcfe8", blue: "#bfdbfe", green: "#bbf7d0",
  purple: "#ddd6fe", orange: "#fed7aa", coral: "#fecaca", slate: "#e2e8f0",
};
export function stickyHex(c) {
  return STICKY_BG[c] || c || STICKY_BG.yellow;
}
// Curated "white range" of sticky pastels for the toolbar + inspector.
export const STICKY_PALETTE = [
  "#c4b5fd", "#ddd6fe", "#e9d5ff", "#f5d0fe", "#fbcfe8", "#fce7f3",
  "#fecaca", "#fed7aa", "#fde68a", "#fef08a", "#d9f99d", "#bbf7d0",
  "#a7f3d0", "#99f6e4", "#a5f3fc", "#bae6fd", "#bfdbfe", "#c7d2fe",
  "#e2e8f0", "#cbd5e1", "#f1f5f9", "#e7e5e4", "#d6d3d1", "#fafaf9",
];

// Reusable emoji-reaction strip for a node. Overhangs the node's bottom-left:
// chips for existing reactions (click a chip to take one back), a quick-react
// bar + full emoji picker when the node is selected, and a "⋯" popover listing
// all reactions once they overflow. Reactions live on data.reactions
// ({ emoji: count }) so they sync + persist like any node data. Sticky notes
// render an equivalent strip inline; image nodes use this shared one.
function NodeReactions({ id, data, selected, style }) {
  const { theme } = useTheme();
  const dark = theme === "dark";
  const patch = useNodeDataPatcher(id);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false); // "view all reactions" popover
  const reactions = data?.reactions || {};
  const react = (emoji) => patch({ reactions: { ...reactions, [emoji]: (reactions[emoji] || 0) + 1 } });
  const unreact = (emoji) => {
    const next = { ...reactions, [emoji]: (reactions[emoji] || 0) - 1 };
    if (next[emoji] <= 0) delete next[emoji];
    patch({ reactions: next });
  };
  const shown = Object.entries(reactions).filter(([, c]) => c > 0);
  const stop = (e) => e.stopPropagation();
  const chipStyle = { display: "inline-flex", alignItems: "center", gap: 2, background: "#171430", color: "#fff", fontSize: 8, fontWeight: 700, lineHeight: 1, borderRadius: 5, padding: "2px 5px", border: `1.5px solid ${SELECT}`, boxShadow: "0 3px 8px -3px rgba(0,0,0,.5)", cursor: "pointer" };
  const MAX_CHIPS = 3;
  // Nothing to render when collapsed with no reactions yet.
  if (!selected && shown.length === 0) return null;
  return (
    <div className="nodrag" onPointerDown={stop}
      style={{ position: "absolute", left: 10, top: "calc(100% - 14px)", zIndex: 20, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, ...style }}>
      {shown.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {shown.slice(0, MAX_CHIPS).map(([e, c]) => (
            <button key={e} type="button" onClick={() => unreact(e)} title="Click to remove a reaction" style={chipStyle}>
              <span style={{ fontSize: 10 }}>{e}</span>
              <span>+{c}</span>
            </button>
          ))}
          {shown.length > MAX_CHIPS && (
            <button type="button" onClick={() => setAllOpen((v) => !v)} title="View all reactions"
              style={{ ...chipStyle, fontWeight: 800, padding: "2px 6px" }}>⋯</button>
          )}
        </div>
      )}
      {allOpen && (
        <>
          <div className="nodrag" onPointerDown={(e) => { stop(e); setAllOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
          <div className="nodrag nowheel" onPointerDown={stop}
            style={{ zIndex: 60, maxHeight: 150, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2, minWidth: 92, background: "#171430", border: `1.5px solid ${SELECT}`, borderRadius: 9, padding: 5, boxShadow: "0 12px 26px -8px rgba(0,0,0,.6)" }}>
            {shown.map(([e, c]) => (
              <button key={e} type="button" onClick={() => unreact(e)} title="Click to remove a reaction"
                style={{ display: "flex", alignItems: "center", gap: 6, color: "#fff", fontSize: 11, fontWeight: 700, padding: "3px 5px", borderRadius: 5, cursor: "pointer" }}>
                <span style={{ fontSize: 15 }}>{e}</span>
                <span>+{c}</span>
                <X style={{ width: 11, height: 11, marginLeft: "auto", opacity: 0.55 }} />
              </button>
            ))}
          </div>
        </>
      )}
      {selected && (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 1, background: "#171430", borderRadius: 9, padding: "2px 5px", border: "2px solid rgba(255,255,255,.16)", boxShadow: "0 5px 12px -4px rgba(0,0,0,.5)" }}>
          {QUICK_REACTIONS.map((e) => (
            <button key={e} type="button" onClick={() => react(e)} title={`React ${e}`} style={{ fontSize: 14, lineHeight: 1, padding: "1px 2px" }}>{e}</button>
          ))}
          <button type="button" onClick={() => setEmojiOpen((v) => !v)} title="More emojis" aria-label="More emojis"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: 9999, color: "#fff" }}>
            <Plus style={{ width: 12, height: 12 }} />
          </button>
        </div>
      )}
      {emojiOpen && (
        <>
          <div className="nodrag" onPointerDown={(e) => { stop(e); setEmojiOpen(false); }} style={{ position: "fixed", inset: 0, zIndex: 50 }} />
          <div className="nodrag nowheel" onPointerDown={stop} style={{ zIndex: 60, borderRadius: 12, overflow: "hidden", boxShadow: "0 16px 36px -16px rgba(0,0,0,.5)" }}>
            <FullEmojiPicker dark={dark} height={360} onPick={(g) => { react(g); setEmojiOpen(false); }} />
          </div>
        </>
      )}
    </div>
  );
}

export const StickyNode = memo(function StickyNode({ id, data, selected }) {
  const setText = useNodeTextUpdater(id);
  const { setNodes } = useReactFlow();
  // Grow the note's height to fit its text so nothing clips (width stays
  // user-controlled, like shapes). Pad covers the 16/12 padding + author line.
  const growRef = useAutoHeight(id, 28 + (data?.author ? 20 : 0) + 6);
  // Legacy notes were created without an explicit size; give them one (square,
  // from their measured box) so the resizer has real dimensions to work from.
  useEffect(() => {
    setNodes((nds) => {
      let changed = false;
      const next = nds.map((n) => {
        if (n.id === id && (n.width == null || n.height == null)) {
          changed = true;
          const s = n.measured?.width || 144;
          return { ...n, width: s, height: s };
        }
        return n;
      });
      return changed ? next : nds;
    });
  }, [id, setNodes]);
  const bg = stickyHex(data?.color);
  // Ink contrasts with the note colour (dark on a pastel, light on a deep hue);
  // the author line is the same ink, dimmed.
  const ink = readableText(bg);
  const authorInk = ink === "#0f172a" ? "rgba(40,28,8,.55)" : "rgba(255,255,255,.72)";
  const author = data?.author || "";
  const stop = (e) => e.stopPropagation();
  const remove = () => setNodes((nds) => nds.filter((n) => n.id !== id));
  return (
    <div
      className="wb-sticky"
      style={{
        // Fills the node box so it resizes (size normalised on mount below);
        // small floor only guards the first frame before that runs.
        width: "100%", height: "100%", minWidth: 96, minHeight: 96, position: "relative",
        background: bg, color: ink,
        borderRadius: 3,
        boxShadow: selected
          ? `0 0 0 2px ${SELECT}, 0 16px 28px -12px rgba(0,0,0,.45), 0 3px 7px -2px rgba(0,0,0,.22)`
          : "0 14px 26px -12px rgba(0,0,0,.4), 0 3px 7px -3px rgba(0,0,0,.18)",
        display: "flex", flexDirection: "column",
        padding: "16px 16px 12px",
        fontFamily: "inherit",
      }}
    >
      {/* Free resize; the height also auto-grows to fit the text (see growRef).
          No connection handles. */}
      <NodeResizer isVisible={selected && !data?.locked} minWidth={120} minHeight={120} {...resizer(SELECT)} />
      {selected && (
        <button type="button" className="nodrag" onPointerDown={stop} onClick={remove} title="Delete"
          style={{ position: "absolute", top: 6, right: 6, opacity: 0.4, display: "flex", color: ink }}>
          <X style={{ width: 13, height: 13 }} />
        </button>
      )}

      {/* Note text — vertical placement, alignment + colour are per-note. The
          inner growRef box is content-height so it can be measured for grow. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: vAlignFlex(data?.vAlign), justifyContent: "center", overflow: "hidden" }}>
        <div ref={growRef} style={{ width: "100%", minWidth: 0 }}>
          <EditableText
            value={data?.text}
            onChange={setText}
            placeholder="Type a note…"
            nodeId={id}
            selected={selected}
            markdown
            style={{ fontSize: data?.fontSize ?? 16, fontWeight: data?.fontWeight ?? 600, lineHeight: 1.25, width: "100%", textAlign: data?.textAlign || "center", color: data?.textColor || ink, fontFamily: fontStack(data?.fontFamily), ...richTextStyle(data) }}
          />
        </div>
      </div>

      {/* Author, bottom-right. */}
      {author && (
        <div style={{ alignSelf: "flex-end", fontSize: 11, fontWeight: 500, color: authorInk, maxWidth: "90%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {author}
        </div>
      )}

      {/* Emoji reactions — overhang the bottom-left edge (shared with images). */}
      <NodeReactions id={id} data={data} selected={selected} />
    </div>
  );
});

// ─── TextNode ──────────────────────────────────────────────────────

// Padding presets for a text node's background chip (data.pad).
const TEXT_PAD = { none: "0px", sm: "8px 14px", md: "16px 26px", lg: "30px 44px" };

// A slim drag strip on a text node's right edge that PINS its width (data.w) so
// the text wraps to that width and the height auto-fits. Width-only by design:
// it never sets a node height, so React Flow keeps measuring the wrapped content
// (exact fit, both growing and shrinking). Double-click releases the width back
// to auto-hug. Zoom-aware so the edge tracks the cursor 1:1. nodrag/nowheel +
// stopPropagation keep the canvas from panning or moving the node mid-drag.
function WidthHandle({ id, rootRef }) {
  const { setNodes, getViewport } = useReactFlow();
  const onPointerDown = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startW = rootRef.current?.offsetWidth || 180;
    const zoom = getViewport().zoom || 1;
    const move = (ev) => {
      const w = Math.max(80, Math.round(startW + (ev.clientX - startX) / zoom));
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, w } } : n)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const release = (e) => {
    e.stopPropagation();
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, w: undefined } } : n)));
  };
  return (
    <div
      className="nodrag nowheel"
      onPointerDown={onPointerDown}
      onDoubleClick={release}
      title="Drag to set width · double-click to auto-fit"
      style={{
        position: "absolute", top: 6, bottom: 6, right: -5, width: 8,
        cursor: "ew-resize", borderRadius: 4, background: SELECT, opacity: 0.55, zIndex: 6,
      }}
    />
  );
}

// Bottom drag strip that PINS a text node's height (data.h) — the box then has a
// fixed height and clips overflow (with a reveal control). Mirrors WidthHandle;
// double-click releases the height back to auto-hug. Pair with WidthHandle to
// shape the box in both dimensions.
function HeightHandle({ id, rootRef }) {
  const { setNodes, getViewport } = useReactFlow();
  const onPointerDown = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const startY = e.clientY;
    const startH = rootRef.current?.offsetHeight || 100;
    const zoom = getViewport().zoom || 1;
    const move = (ev) => {
      const h = Math.max(40, Math.round(startH + (ev.clientY - startY) / zoom));
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, h } } : n)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const release = (e) => {
    e.stopPropagation();
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, h: undefined } } : n)));
  };
  return (
    <div
      className="nodrag nowheel"
      onPointerDown={onPointerDown}
      onDoubleClick={release}
      title="Drag to set height · double-click to auto-fit"
      style={{
        position: "absolute", left: 6, right: 6, bottom: -5, height: 8,
        cursor: "ns-resize", borderRadius: 4, background: SELECT, opacity: 0.55, zIndex: 6,
      }}
    />
  );
}

export const TextNode = memo(function TextNode({ id, data, selected }) {
  const setText = useNodeTextUpdater(id);
  const { setNodes } = useReactFlow();
  const rootRef = useRef(null);
  const contentRef = useRef(null);
  const [overflowing, setOverflowing] = useState(false);
  // Optional background turns a text node into a label / chip / callout. When a
  // fill is set the default text colour auto-contrasts against it (like sticky
  // and shape do); radius + padding round the chip.
  const fill = data?.fill || null;
  const radius = data?.radius ?? 8;
  const textColor = data?.textColor || (fill ? readableText(fill) : "var(--color-text)");
  // Box modes: a text node hugs its content by DEFAULT (grows as you type). Drag
  // the RIGHT handle to pin a width (data.w) — text wraps to it, height auto-fits.
  // Drag the BOTTOM handle to pin a height (data.h) — the box is then fixed and
  // clips overflow, with a "show all" reveal. Double-click a handle to release.
  const fixedW = typeof data?.w === "number" && data.w > 0;
  const fixedH = typeof data?.h === "number" && data.h > 0;

  // Detect clipped overflow so we can flag it + offer a reveal.
  useEffect(() => {
    if (!fixedH) { setOverflowing(false); return; }
    const el = contentRef.current;
    if (!el) return;
    setOverflowing(el.scrollHeight - el.clientHeight > 2);
  }, [fixedH, data?.h, data?.w, data?.text, data?.fontSize]);

  const revealAll = (e) => {
    e.stopPropagation();
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, h: undefined } } : n)));
  };

  return (
    <div
      ref={rootRef}
      style={{
        position: "relative",
        width: fixedW ? data.w : undefined,
        minWidth: fixedW ? undefined : 180,
        padding: fill ? (TEXT_PAD[data?.pad] || TEXT_PAD.md) : "8px 12px",
        background: fill || (selected ? SELECT_FILL : "transparent"),
        borderRadius: radius,
        boxShadow: selected ? `0 0 0 2px ${SELECT}` : (fill ? "0 6px 16px -8px rgba(0,0,0,.35)" : "none"),
        color: textColor,
      }}
    >
      {/* Text is a label, not a flowchart box — no connection handles (you draw
          edges between shapes, not from text). */}
      <div
        ref={contentRef}
        style={fixedH ? { height: data.h, overflow: "hidden" } : undefined}
      >
        <EditableText
          value={data?.text}
          onChange={setText}
          placeholder="Type some text…"
          nodeId={id}
          selected={selected}
          markdown
          wrap={fixedW || fixedH}
          style={{ fontSize: data?.fontSize ?? 16, fontWeight: data?.fontWeight ?? 700, lineHeight: 1.3, textAlign: data?.textAlign || "left", color: textColor, fontFamily: fontStack(data?.fontFamily), ...richTextStyle(data) }}
        />
      </div>
      {/* Clipped-overflow affordance: a "…" while idle, a "show all" (releases
          the pinned height so it auto-fits) when selected. */}
      {fixedH && overflowing && (
        selected ? (
          <button
            type="button"
            className="nodrag"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={revealAll}
            title="Show all text (auto-fit height)"
            style={{
              position: "absolute", right: 4, bottom: 3, zIndex: 7,
              fontSize: 10, fontWeight: 700, lineHeight: 1,
              padding: "2px 6px", borderRadius: 9999,
              background: SELECT, color: "#fff", border: "none", cursor: "pointer",
            }}
          >
            … show all
          </button>
        ) : (
          <span
            aria-hidden
            style={{
              position: "absolute", right: 6, bottom: 2, zIndex: 7,
              fontWeight: 800, opacity: 0.55, pointerEvents: "none", color: textColor,
            }}
          >
            …
          </span>
        )
      )}
      {selected && !data?.locked && <WidthHandle id={id} rootRef={rootRef} />}
      {selected && !data?.locked && <HeightHandle id={id} rootRef={rootRef} />}
    </div>
  );
});

// ─── Flowchart shapes (SVG) ───────────────────────────────────────
//
// One SVG-backed node renders the whole flowchart catalogue. data.shape
// picks the geometry; it's drawn at the node's real pixel size (tracked
// via ResizeObserver) so nothing distorts at any aspect ratio. Legacy
// "rect"/"ellipse"/"diamond" node types map to a sensible shape.

export const SHAPES = [
  { key: "process", label: "Process" },
  { key: "rounded", label: "Rounded" },
  { key: "diamond", label: "Decision" },
  { key: "terminator", label: "Start / End" },
  { key: "parallelogram", label: "Data" },
  { key: "hexagon", label: "Preparation" },
  { key: "document", label: "Document" },
  { key: "cylinder", label: "Database" },
  { key: "ellipse", label: "Ellipse" },
  { key: "triangle", label: "Triangle" },
];

const LEGACY_SHAPE = { rect: "process", ellipse: "ellipse", diamond: "diamond" };

// SVG children for a shape drawn within w×h (stroke inset by sw so it's
// never clipped). Used both by the node and the toolbar/inspector previews.
export function ShapeSvg({ shape, w, h, fill, stroke, sw = 2, dash, cap }) {
  // fill/stroke go through `style` (not attributes) so a CSS var like the
  // theme accent — var(--color-accent) — resolves; attributes don't parse var().
  const p = { strokeWidth: sw, strokeLinejoin: "round", strokeDasharray: dash || undefined, strokeLinecap: cap || undefined, style: { fill, stroke } };
  const x0 = sw / 2, y0 = sw / 2, x1 = w - sw / 2, y1 = h - sw / 2, cx = w / 2, cy = h / 2;
  switch (shape) {
    case "ellipse":
      return <ellipse cx={cx} cy={cy} rx={(w - sw) / 2} ry={(h - sw) / 2} {...p} />;
    case "rounded":
      return <rect x={x0} y={y0} width={w - sw} height={h - sw} rx={14} ry={14} {...p} />;
    case "terminator":
      return <rect x={x0} y={y0} width={w - sw} height={h - sw} rx={(h - sw) / 2} ry={(h - sw) / 2} {...p} />;
    case "diamond":
      return <polygon points={`${cx},${y0} ${x1},${cy} ${cx},${y1} ${x0},${cy}`} {...p} />;
    case "triangle":
      return <polygon points={`${cx},${y0} ${x1},${y1} ${x0},${y1}`} {...p} />;
    case "parallelogram": {
      const s = Math.min(w * 0.22, h * 0.5);
      return <polygon points={`${x0 + s},${y0} ${x1},${y0} ${x1 - s},${y1} ${x0},${y1}`} {...p} />;
    }
    case "hexagon": {
      const s = Math.min(w * 0.2, h * 0.5);
      return <polygon points={`${x0 + s},${y0} ${x1 - s},${y0} ${x1},${cy} ${x1 - s},${y1} ${x0 + s},${y1} ${x0},${cy}`} {...p} />;
    }
    case "document": {
      const wob = Math.min(h * 0.16, 22);
      return <path d={`M${x0},${y0} H${x1} V${h - wob} C${w * 0.72},${h + wob * 0.5} ${w * 0.28},${h - wob * 2.4} ${x0},${h - wob} Z`} {...p} />;
    }
    case "cylinder": {
      const ry = Math.min(h * 0.16, 16);
      return (
        <>
          <path d={`M${x0},${ry} V${h - ry} A${(w - sw) / 2},${ry} 0 0 0 ${x1},${h - ry} V${ry}`} {...p} />
          <ellipse cx={cx} cy={ry} rx={(w - sw) / 2} ry={ry} {...p} />
        </>
      );
    }
    case "process":
    default:
      return <rect x={x0} y={y0} width={w - sw} height={h - sw} {...p} />;
  }
}

function useNodeSize(initial) {
  const ref = useRef(null);
  const [size, setSize] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width && r.height) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

// Grow a fixed-size node's HEIGHT so its text never clips. Returns a ref to put
// on a CONTENT-sized element (one that wraps at the node's width but is only as
// tall as its text) — measuring that, not the node-filling box, means the node
// growing can't re-trigger the observer, so there's no feedback loop. Grow-only:
// it raises the node to fit the content but never shrinks it, so you can still
// resize freely — you just can't drag it shorter than the text inside.
function useAutoHeight(id, pad = 0) {
  const ref = useRef(null);
  const { setNodes } = useReactFlow();
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = () => {
      const needed = Math.ceil(el.scrollHeight + pad);
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const cur = n.height ?? n.measured?.height ?? 0;
          return needed > cur + 0.5 ? { ...n, height: needed } : n;
        }),
      );
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => ro.disconnect();
  }, [id, pad, setNodes]);
  return ref;
}

export const ShapeNode = memo(function ShapeNode({ id, type, data, selected }) {
  const setText = useNodeTextUpdater(id);
  const { theme } = useTheme();
  const [ref, size] = useNodeSize({ w: 180, h: 100 });
  // Grow the shape's height to fit its text (markdown can run tall) so content
  // never clips. Width stays user-controlled; ~22px covers the 10px×2 padding.
  const growRef = useAutoHeight(id, 22);
  const shape = data?.shape || LEGACY_SHAPE[type] || "process";
  // Default fill follows the theme (a dark surface in dark mode instead of a
  // glaring white box); a user-picked fill is respected. Text auto-contrasts.
  const fill = data?.fill || (theme === "dark" ? "#1e293b" : "#ffffff");
  // Outline keeps its own colour; selecting just THICKENS it (no accent swap).
  const stroke = data?.stroke || "#0ea5e9";
  // User-set border width (default 2) + a touch of emphasis when selected.
  const baseSw = data?.strokeWidth ?? 2;
  const sw = selected ? baseSw + 1.5 : baseSw;
  // Border style → dasharray (scaled to the width so it reads at any weight).
  const dash =
    data?.strokeDash === "dashed" ? `${sw * 2.5} ${sw * 1.8}`
    : data?.strokeDash === "dotted" ? `${sw * 0.1} ${sw * 2}`
    : undefined;
  const cap = data?.strokeDash === "dotted" ? "round" : undefined;
  const textColor = readableText(fill);
  return (
    <div ref={ref} style={{ width: "100%", height: "100%", position: "relative" }}>
      <NodeResizer
        isVisible={selected && !data?.locked}
        minWidth={70} minHeight={50}
        {...resizer(stroke)}
      />
      <svg
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        style={{ position: "absolute", inset: 0, overflow: "visible", display: "block" }}
      >
        <ShapeSvg shape={shape} w={size.w} h={size.h} fill={fill} stroke={stroke} sw={sw} dash={dash} cap={cap} />
      </svg>
      {/* Arrow handles ARE the connect points now (click = add, drag = place). */}
      <QuickConnectArrows id={id} color={stroke} />
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: vAlignFlex(data?.vAlign), justifyContent: "center", padding: "10px 14px" }}>
        <div ref={growRef} style={{ width: "100%", minWidth: 0 }}>
          <EditableText
            value={data?.text}
            onChange={setText}
            placeholder=""
            nodeId={id}
            selected={selected}
            markdown
            style={{ fontSize: data?.fontSize ?? 13, fontWeight: data?.fontWeight ?? 600, textAlign: data?.textAlign || "center", color: data?.textColor || textColor, fontFamily: fontStack(data?.fontFamily), ...richTextStyle(data) }}
          />
        </div>
      </div>
    </div>
  );
});

// ─── GoalNode (first-class, linkable to a department or person) ────

export const GoalNode = memo(function GoalNode({ id, data, selected }) {
  const setText = useNodeTextUpdater(id);
  const patch = useNodeDataPatcher(id);
  const { theme } = useTheme();
  const { orgTeams = [], teamMembers = [], activeTeamId } = useTeam() || {};
  const { whiteboardId: routeBoardId } = useParams();
  const ctxBoardId = useContext(BoardIdContext);
  // Prefer the board id from context (correct in both the standalone route and
  // the embedded room panel). Fall back to the route param only if context is
  // somehow absent. A missing board id would break the goal upsert's dedupe.
  const whiteboardId = ctxBoardId || routeBoardId;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tfOpen, setTfOpen] = useState(false);
  const linked = data?.linkType && data?.linkId;
  const linkColor = data?.linkColor || "#f59e0b";
  const goalActive = !!data?.goalActive;
  const timeframe = data?.timeframe || "none";
  const body = (data?.text || "").trim();
  // Theme-aware surfaces so the goal card reads in dark mode (the amber header
  // banner + accent border stay; only the body/card chrome flips).
  const dark = theme === "dark";
  const surface = dark ? "#1e293b" : "#ffffff";
  const text = dark ? "#e2e8f0" : "#0f172a";
  const muted = dark ? "#94a3b8" : "#64748b";
  const divider = dark ? "rgba(255,255,255,.10)" : "rgba(0,0,0,.07)";
  const popBorder = dark ? "rgba(255,255,255,.14)" : "#e2e8f0";

  // Auto-sync to the goals list: a goal node is a goal. Once it has a linked
  // owner + text, it's added to the owner's goals list (debounced); clearing
  // the text or unlinking removes it. lastSyncRef prevents redundant writes +
  // a re-sync loop when we patch goalActive back into node data.
  const lastSyncRef = useRef("");
  useEffect(() => {
    if (!activeTeamId) return;
    // Never write a goal without a board id — the (source_board, source_node)
    // upsert can't dedupe on a NULL board, so it would insert a fresh duplicate
    // on every save/remount (the meeting-context duplicate-goal bug).
    if (!whiteboardId) return;
    const sig = linked && body ? `${data.linkType}:${data.linkId}:${timeframe}:${body}` : "";
    if (sig === lastSyncRef.current) return;
    const t = setTimeout(async () => {
      if (sig) {
        const { horizon, weekStart } = timeframeToParams(timeframe);
        const { error } = await setGoal({
          teamId: activeTeamId, ownerType: data.linkType, ownerId: data.linkId,
          ownerName: data.linkName, ownerColor: data.linkColor, body,
          boardId: whiteboardId, nodeId: id, horizon, weekStart,
        });
        if (!error) { lastSyncRef.current = sig; if (!data?.goalActive) patch({ goalActive: true }); }
      } else if (lastSyncRef.current) {
        await clearGoalNode({ boardId: whiteboardId, nodeId: id });
        lastSyncRef.current = "";
        if (data?.goalActive) patch({ goalActive: false });
      }
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeamId, data?.linkType, data?.linkId, body, timeframe, whiteboardId, id]);

  const tfLabel = GOAL_TIMEFRAMES.find((t) => t.key === timeframe)?.label || "Ongoing";
  return (
    <div
      style={{
        width: "100%", height: "100%", display: "flex", flexDirection: "column",
        background: surface, borderRadius: 14,
        border: `${selected ? 4 : 2}px solid #f59e0b`,
        boxShadow: selected ? "0 12px 28px -14px rgba(0,0,0,.4)" : "0 8px 20px -12px rgba(0,0,0,.3)",
        color: text,
      }}
    >
      <NodeResizer isVisible={selected && !data?.locked} minWidth={200} minHeight={120} {...resizer("#f59e0b")} />
      {/* No connection handles — goals aren't edge endpoints. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", background: "linear-gradient(120deg,#f59e0b,#f97316)", color: "#fff", borderRadius: "12px 12px 0 0" }}>
        <Target style={{ width: 14, height: 14 }} />
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".12em" }}>GOAL</span>
        {/* Auto-saved status — a goal node is added to the owner's goals list
            as soon as it's linked + has text. No manual "set" step. */}
        <span
          title={goalActive ? "Saved to the goals list" : "Link an owner + add text to add this to the goals list"}
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 800, color: "#fff", opacity: goalActive ? 1 : 0.6, padding: "1px 6px", borderRadius: 9999, background: goalActive ? "rgba(255,255,255,.25)" : "transparent" }}
        >
          {goalActive ? <Check style={{ width: 12, height: 12 }} /> : <Star style={{ width: 12, height: 12 }} fill="none" />}
          {goalActive ? "In goals" : "Goal"}
        </span>
      </div>
      <div style={{ flex: 1, padding: 10, minHeight: 0 }}>
        <EditableText value={data?.text} onChange={setText} placeholder="Write the goal…" nodeId={id} selected={selected} style={{ fontSize: 14, fontWeight: data?.fontWeight ?? 600, lineHeight: 1.3, ...richTextStyle(data) }} />
      </div>
      <div className="nodrag" style={{ position: "relative", padding: "6px 10px", borderTop: `1px solid ${divider}`, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => { setPickerOpen((v) => !v); setTfOpen(false); }}
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: linked ? "#fff" : muted, background: linked ? linkColor : "transparent", padding: linked ? "2px 8px" : 0, borderRadius: 9999 }}
        >
          {data?.linkType === "user" ? <User style={{ width: 12, height: 12 }} /> : <Building2 style={{ width: 12, height: 12 }} />}
          {linked ? data.linkName : "Link to a team or person"}
          <ChevronDown style={{ width: 11, height: 11, opacity: 0.6 }} />
        </button>

        {/* Timeframe — Ongoing / This week / Next week / month / … */}
        <button
          type="button"
          onClick={() => { setTfOpen((v) => !v); setPickerOpen(false); }}
          title="When is this goal for?"
          style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: muted, background: dark ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.04)", padding: "2px 8px", borderRadius: 9999 }}
        >
          <CalendarClock style={{ width: 12, height: 12 }} />
          {tfLabel}
          <ChevronDown style={{ width: 11, height: 11, opacity: 0.6 }} />
        </button>
        {tfOpen && (
          <div className="nowheel" style={{ position: "absolute", bottom: 34, right: 8, zIndex: 40, width: 150, background: surface, border: `1px solid ${popBorder}`, borderRadius: 12, boxShadow: "0 16px 36px -16px rgba(0,0,0,.45)", padding: 4 }}>
            {GOAL_TIMEFRAMES.map((t) => (
              <button key={t.key} type="button" onClick={() => { patch({ timeframe: t.key }); setTfOpen(false); }}
                style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", padding: "4px 8px", borderRadius: 8, fontSize: 12, color: text, fontWeight: t.key === timeframe ? 700 : 500 }}>
                {t.key === timeframe ? <Check style={{ width: 12, height: 12, color: "#f59e0b" }} /> : <span style={{ width: 12 }} />}
                {t.label}
              </button>
            ))}
          </div>
        )}
        {pickerOpen && (
          <div className="nowheel" style={{ position: "absolute", bottom: 34, left: 8, zIndex: 40, width: 196, maxHeight: 220, overflowY: "auto", background: surface, border: `1px solid ${popBorder}`, borderRadius: 12, boxShadow: "0 16px 36px -16px rgba(0,0,0,.45)", padding: 4 }}>
            {orgTeams.length > 0 && <div style={{ fontSize: 9, fontWeight: 800, color: muted, textTransform: "uppercase", letterSpacing: ".08em", padding: "4px 8px 2px" }}>Departments</div>}
            {orgTeams.map((t) => (
              <button key={t.id} type="button" onClick={() => { patch({ linkType: "department", linkId: t.id, linkName: t.name, linkColor: t.color || "#f59e0b" }); setPickerOpen(false); }}
                style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", padding: "4px 8px", borderRadius: 8, fontSize: 12, color: text }}>
                <span style={{ width: 8, height: 8, borderRadius: 9999, background: t.color || "#94a3b8", flexShrink: 0 }} />
                {t.name}
              </button>
            ))}
            {teamMembers.length > 0 && <div style={{ fontSize: 9, fontWeight: 800, color: muted, textTransform: "uppercase", letterSpacing: ".08em", padding: "6px 8px 2px" }}>People</div>}
            {teamMembers.map((m) => (
              <button key={m.user_id} type="button" onClick={() => { patch({ linkType: "user", linkId: m.user_id, linkName: m.name || "Member", linkColor: "#64748b" }); setPickerOpen(false); }}
                style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", padding: "4px 8px", borderRadius: 8, fontSize: 12, color: text }}>
                <User style={{ width: 12, height: 12, color: muted }} />
                {m.name || "Member"}
              </button>
            ))}
            {linked && (
              <button type="button" onClick={() => { patch({ linkType: null, linkId: null, linkName: null, linkColor: null }); setPickerOpen(false); }}
                style={{ width: "100%", textAlign: "left", padding: "4px 8px", marginTop: 2, borderRadius: 8, fontSize: 12, color: "#ef4444", fontWeight: 600 }}>
                Clear link
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── FrameNode (resizable, labelled container / section) ──────────
//
// A first-class container you drop sticky notes / cards into to group
// them — the building block for retro columns, kanban lanes, etc. Sits
// behind content (created with a low zIndex) so nodes layer on top; the
// header is editable.

export const FrameNode = memo(function FrameNode({ id, data, selected }) {
  const setText = useNodeTextUpdater(id);
  const { setNodes, screenToFlowPosition } = useReactFlow();
  const myName = useMyName();
  // The frame's colour comes from the inspector's Fill control (data.fill);
  // `tint` drives the border + floating label, and the faint interior is
  // derived from it (legacy data.tint/data.bg still honoured).
  const tint = data?.fill || data?.tint || "#0ea5e9";
  const bg = data?.bg || `color-mix(in srgb, ${tint} 8%, transparent)`;
  // Floating label chrome: background is transparent by default, can follow the
  // frame tint, or be a custom colour (data.labelBg = "none" | "tint" | hex).
  // Title size follows the inspector's text-size control; it defaults to the
  // normal (Medium) size and can be bumped to X-Large for a big heading.
  const labelFill = data?.labelBg === "tint" ? tint : (data?.labelBg && data.labelBg !== "none" ? data.labelBg : null);
  const labelInk = labelFill ? readableText(labelFill) : tint;
  const titleSize = data?.fontSize ?? 20;
  const addSticky = (e) => {
    e.stopPropagation();
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setNodes((nds) => {
      const byId = new Map(nds.map((n) => [n.id, n]));
      const fAbs = byId.get(id) ? nodeAbsPos(byId.get(id), byId) : { x: 0, y: 0 };
      const sticky = {
        id: freshStickyId(),
        type: "sticky",
        parentId: id,
        // No extent:"parent" — the note belongs to the frame but stays
        // free to drag out (soft container).
        position: { x: p.x - fAbs.x - 72, y: p.y - fAbs.y - 72 },
        width: 144, height: 144, // explicit size → resizable
        data: { text: "", color: preferredStickyColor(), author: myName },
        selected: true,
      };
      const deselected = nds.map((n) => (n.selected ? { ...n, selected: false } : n));
      return sortParentsFirst([...deselected, sticky]);
    });
  };
  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <NodeResizer isVisible={selected && !data?.locked} minWidth={160} minHeight={140} {...resizer(tint)} />
      {/* Label floats just ABOVE the frame's top-left (Lucidchart/Lucidspark
          style) — outside the clipped box so it's never cut off. */}
      <div style={{ position: "absolute", left: 2, bottom: "calc(100% + 5px)", display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 360, ...(labelFill ? { background: labelFill, padding: "2px 10px", borderRadius: 8 } : null) }}>
        {data?.icon && <span style={{ fontSize: titleSize, lineHeight: 1 }}>{data.icon}</span>}
        <EditableText value={data?.text ?? data?.label} onChange={setText} placeholder="Section title" nodeId={id} selected={selected} style={{ fontSize: titleSize, fontWeight: 800, color: labelInk, lineHeight: 1.15, overflowWrap: "anywhere" }} />
      </div>
      {/* The frame box — bordered, faint fill, clips its contents. No connection
          handles (frames aren't edge endpoints). Double-click to add a sticky. */}
      <div style={{ width: "100%", height: "100%", borderRadius: 18, border: `${selected ? 4 : 2}px solid ${tint}`, background: bg, overflow: "hidden" }}
        onDoubleClick={addSticky} title="Double-click to add a sticky note" />
    </div>
  );
});

// ─── ZoneNode ─────────────────────────────────────────────────────

export const ZoneNode = memo(function ZoneNode({ data }) {
  return (
    <div
      style={{
        width: "100%", height: "100%",
        background: data?.bg || "#f1f5f9",
        border: `2px solid ${data?.border || "#e2e8f0"}`,
        borderRadius: 22,
        pointerEvents: "none",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "16px 18px",
        }}
      >
        <div
          style={{
            width: 36, height: 36, borderRadius: 11, flexShrink: 0,
            background: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: data?.tint || "#0f172a",
            fontSize: 18,
            boxShadow: "0 1px 2px rgba(15,23,42,.08)",
          }}
        >
          {data?.icon || "·"}
        </div>
        <span
          style={{
            fontSize: 19, fontWeight: 800, letterSpacing: "-.01em",
            color: "#3a2a10",
          }}
        >
          {data?.label || "Zone"}
        </span>
      </div>
    </div>
  );
});

// ─── ImageNode ─────────────────────────────────────────────────────
// An embedded image. The bytes live in Supabase Storage (whiteboard-images
// bucket); the node only carries the public URL (data.src) + path, so the
// snapshot and realtime ops stay tiny. Resizes with a locked aspect ratio and
// connects like any other node (FourHandles + free anchors).
export const ImageNode = memo(function ImageNode({ id, data, selected }) {
  const { setNodes } = useReactFlow();
  const src = data?.src;
  const stop = (e) => e.stopPropagation();
  const remove = () => setNodes((nds) => nds.filter((n) => n.id !== id));
  return (
    // Outer wrapper is NOT clipped so the reaction strip can overhang the bottom
    // edge; only the inner image surface rounds + clips its pixels.
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div
        style={{
          width: "100%", height: "100%",
          // Transparent surface so PNG/WebP alpha shows the board through (not a
          // dark box); opaque photos are unaffected. The selection ring stays,
          // but the resting drop-shadow is dropped so a cut-out image doesn't get
          // a shadow rectangle around its transparent bounds.
          borderRadius: 6, overflow: "hidden", background: "transparent",
          boxShadow: selected ? `0 0 0 2px ${SELECT}, 0 16px 28px -12px rgba(0,0,0,.5)` : "none",
        }}
      >
        {src ? (
          <img
            src={src}
            alt={data?.alt || ""}
            draggable={false}
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", pointerEvents: "none", userSelect: "none" }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: 12, padding: 8, textAlign: "center" }}>
            Image unavailable
          </div>
        )}
      </div>
      <NodeResizer isVisible={selected && !data?.locked} minWidth={48} minHeight={48} keepAspectRatio {...resizer(SELECT)} />
      {/* No connection handles — images aren't edge endpoints (NON_CONNECTABLE). */}
      {selected && (
        <button
          type="button" className="nodrag" onPointerDown={stop} onClick={remove} title="Delete"
          style={{ position: "absolute", top: 6, right: 6, display: "flex", color: "#fff", background: "rgba(0,0,0,.45)", borderRadius: 6, padding: 3 }}
        >
          <X style={{ width: 13, height: 13 }} />
        </button>
      )}
      {/* Emoji reactions pinned to the image — chips overhang the bottom edge. */}
      <NodeReactions id={id} data={data} selected={selected} />
    </div>
  );
});

// ─── Freehand pen ─────────────────────────────────────────────────
//
// Each pen stroke is its OWN node (type "draw") so it persists, syncs,
// undoes and z-orders exactly like everything else — no separate drawing
// layer. Points are stored relative to the node's box. The node's `style`
// carries pointerEvents:"none" (set at creation) so a stroke laid over other
// nodes is click-through everywhere except the line itself.

// Smooth a list of [x,y] points into an SVG path (quadratic curves through
// the midpoints — the classic cheap freehand smoothing). Shared by the live
// preview on the page and the committed node.
export function strokePath(pts) {
  if (!pts || !pts.length) return "";
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]} L${pts[0][0] + 0.1},${pts[0][1]}`;
  if (pts.length === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0]},${pts[i][1]} ${mx},${my}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}

// perfect-freehand outline points → a filled SVG path (quadratics through the
// midpoints of the outline polygon). Standard getSvgPathFromStroke helper.
function outlineToPath(stroke) {
  if (!stroke.length) return "";
  const d = stroke.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...stroke[0], "Q"],
  );
  d.push("Z");
  return d.join(" ");
}

// How much the pen "width" preset (2/4/8) scales into a perfect-freehand nib
// diameter — pressure then thins it down from there.
export const PEN_NIB_SCALE = 2.2;

// Variable-width freehand outline from pressure points ([x,y,pressure]). Shared
// by the live preview and the committed DrawNode so they match exactly.
export function strokeOutlinePath(pts, { width = 4, last = true } = {}) {
  if (!pts || !pts.length) return "";
  const stroke = getStroke(pts, {
    size: Math.max(1, width) * PEN_NIB_SCALE,
    thinning: 0.6,
    smoothing: 0.55,
    streamline: 0.5,
    simulatePressure: false, // real Pencil pressure rides in the 3rd tuple slot
    last,
  });
  return outlineToPath(stroke);
}

export const DrawNode = memo(function DrawNode({ id, data, width, height, selected }) {
  const { setNodes } = useReactFlow();
  const remove = () => setNodes((nds) => nds.filter((n) => n.id !== id));
  const pts = data?.points || [];
  const color = data?.color || "#0f172a";
  const sw = data?.strokeWidth ?? 3;
  const opacity = data?.opacity ?? 1;
  const pressure = !!data?.pressure;
  const w = width || data?.w || 1;
  const h = height || data?.h || 1;
  const d = strokePath(pts);
  const lineProps = {
    d, fill: "none", strokeLinecap: "round", strokeLinejoin: "round",
  };
  // Pressure strokes render as a filled variable-width outline; legacy/flat
  // strokes keep the cheap constant-width stroked path.
  const outline = pressure ? strokeOutlinePath(pts, { width: sw }) : null;
  return (
    // pointerEvents:none on the box (also set via node.style) → click-through;
    // the stroke paths opt back in so the line stays grabbable/selectable.
    <div style={{ width: "100%", height: "100%", position: "relative", pointerEvents: "none" }}>
      <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
        {/* Fat invisible hit line (uses the centerline) so a thin stroke is easy to grab. */}
        <path {...lineProps} stroke="transparent" strokeWidth={Math.max(sw + 14, 18)} style={{ pointerEvents: "stroke", cursor: "move" }} />
        {outline ? (
          <>
            {selected && (
              <path d={outline} fill="none" stroke={SELECT} strokeOpacity={0.35} strokeWidth={6} strokeLinejoin="round" style={{ pointerEvents: "none" }} />
            )}
            <path d={outline} fill={color} fillOpacity={opacity} style={{ pointerEvents: "fill", cursor: "move" }} />
          </>
        ) : (
          <>
            {selected && (
              <path {...lineProps} stroke={SELECT} strokeOpacity={0.3} strokeWidth={sw + 8} style={{ pointerEvents: "none" }} />
            )}
            <path {...lineProps} stroke={color} strokeWidth={sw} strokeOpacity={opacity} style={{ pointerEvents: "stroke", cursor: "move" }} />
          </>
        )}
      </svg>
      {selected && (
        <button
          type="button" className="nodrag" onPointerDown={(e) => e.stopPropagation()} onClick={remove} title="Delete"
          style={{ position: "absolute", top: -12, right: -12, display: "flex", color: "#fff", background: "rgba(15,23,42,.82)", borderRadius: 9999, padding: 3, pointerEvents: "auto" }}
        >
          <X style={{ width: 12, height: 12 }} />
        </button>
      )}
    </div>
  );
});

export const NODE_TYPES = {
  sticky: StickyNode,
  text: TextNode,
  shape: ShapeNode,
  goal: GoalNode,
  frame: FrameNode,
  image: ImageNode,
  draw: DrawNode,
  // Legacy aliases — old snapshots store these node types.
  rect: ShapeNode,
  ellipse: ShapeNode,
  diamond: ShapeNode,
  zone: ZoneNode,
};
