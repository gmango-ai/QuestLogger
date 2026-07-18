import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Panel,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  reconnectEdge,
  useReactFlow,
  MarkerType,
  ConnectionMode,
  SelectionMode,
  NodeToolbar,
  Position,
  getNodesBounds,
  ViewportPortal,
  useViewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft,
  Loader2,
  Maximize,
  Target,
  Pencil,
  Archive,
  Download,
  Crop,
  Type,
  Frame,
  ImagePlus,
  Trash2,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  StretchHorizontal,
  StretchVertical,
  ChevronDown,
  Smile,
  Timer,
  Undo2,
  Redo2,
  Map as MapIcon,
  LayoutTemplate,
  Wand2,
  Paintbrush,
  Eraser,
  Lasso,
  Check,
  MessageSquare,
  MoreHorizontal,
  StickyNote,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import { useTheme } from "../context/ThemeContext";
import { useTeam } from "../context/TeamContext";
import { Button } from "@/components/ui/button";
import { Skeleton } from "../components/Skeleton";
import {
  setWhiteboardGoal,
  setWhiteboardTitle,
  archiveWhiteboard,
  TEMPLATES,
} from "../lib/whiteboard";
import {
  NODE_TYPES,
  SHAPES,
  preferredShape,
  setPreferredShape,
  QuickConnectContext,
  ShapeSvg,
  preferredStickyColor,
  setPreferredStickyColor,
  STICKY_PALETTE,
  stickyHex,
  markNodeForEdit,
  strokePath,
  strokeOutlinePath,
  PEN_NIB_SCALE,
} from "../components/whiteboard/nodes";
import {
  nodeAbsPos,
  sortParentsFirst,
  frameAt,
} from "../components/whiteboard/frame";
import { useApp } from "../context/AppContext";
import {
  EDGE_TYPES,
  ConnectShapeContext,
  AreaSelectedEdgesContext,
  EdgeMarkerDefs,
  ConnectionLine,
  connectedNodePlacement,
  siblingPlacement,
  nodeRect,
  snappedAnchor,
  SIDE_POS,
  ANCHOR_TO_HANDLE,
  NON_CONNECTABLE,
} from "../components/whiteboard/edges";
import { useWhiteboardSync } from "../components/whiteboard/useWhiteboardSync";
import { useWhiteboardHistory } from "../components/whiteboard/useWhiteboardHistory";
import { useWhiteboardClipboard } from "../components/whiteboard/useWhiteboardClipboard";
import { useWhiteboardPersistence } from "../components/whiteboard/useWhiteboardPersistence";
import { useWhiteboardKeyboard } from "../components/whiteboard/useWhiteboardKeyboard";
import { useWhiteboardInspector } from "../components/whiteboard/useWhiteboardInspector";
import { useWhiteboardRegionSelect } from "../components/whiteboard/useWhiteboardRegionSelect";
import { usePalmRejection } from "../components/whiteboard/usePalmRejection";
import { recognizeStroke, SHAPE_KIND_TO_NODE } from "../components/whiteboard/wbShapeRecognition";
import WhiteboardShortcuts from "../components/whiteboard/WhiteboardShortcuts";
import { uploadWhiteboardImage } from "../lib/whiteboardImage";
import TextPanel from "../components/whiteboard/TextPanel";
import {
  snapToGrid,
  nodeSnaps,
  getAlignmentGuides,
  getResizeGuides,
  alignDistance,
  HelperLines,
} from "../components/whiteboard/snapping";
import {
  CollabCursors,
  PresenceStack,
  LocalLaser,
  LaserTrail,
  BrushCursor,
} from "../components/whiteboard/CollabCursors";
import Inspector from "../components/whiteboard/Inspector";
import { DropUpContext } from "../components/whiteboard/toolbarUI";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";
import PaintLayer from "../components/whiteboard/PaintLayer";
import { segmentTileKeys } from "../components/whiteboard/paintTiles";
import SaveTemplateModal from "../components/whiteboard/SaveTemplateModal";
import EmoteOverlay from "../components/emotes/EmoteOverlay";
import WhiteboardTimer from "../components/whiteboard/WhiteboardTimer";
import {
  touchCentroid, touchSpread, screenPolyPath,
  freshId, collectCloneSources, duplicateInternalEdges,
} from "../components/whiteboard/wbUtil";
import {
  saveViewport,
  loadTextStyle, saveTextStyle, loadPenStyle, savePenStyle, PEN_COLORS, PEN_WIDTHS,
  loadBrushStyle, saveBrushStyle, activeBrushSize, BRUSH_TEXTURES, BRUSH_SIZE_PRESETS,
  loadLaserColor, saveLaserColor,
} from "../components/whiteboard/wbStorage";
import {
  WB_TOUCH, TAP_GESTURE_MS, TAP_GESTURE_SLOP,
  TOOL_BTN_SIZE, TOOL_GROUP_CLS, BOTTOM_PANEL_GAP, PAINT_TOOLBAR_STACK_H,
  TOUCH_INSPECTOR_FALLBACK_H, CARET_CLS, DEFAULTS,
} from "../components/whiteboard/wbConstants";
import {
  FitViewButton, ToolbarDivider, ToolButton, ShapePreview, ShapesMenu,
  ToolChevron, ToolPopover, PaletteGrid, ColorButton, StickyTool, TextTool,
  PenTool, LaserTool, MaybeFlyoutPortal, PaintToolbar,
} from "../components/whiteboard/WhiteboardToolbar";
import {
  VotesOverlay, CommentsOverlay, CommentThread, AreaSelectionFloating,
} from "../components/whiteboard/wbOverlays";

const DEFAULT_EDGE_OPTIONS = {
  type: "editable",
  markerEnd: { type: MarkerType.ArrowClosed, color: "#0ea5e9" },
  style: { stroke: "#0ea5e9", strokeWidth: 2 },
};

const NO_LINES = { vertical: null, horizontal: null }; // stable empty guide state

// Map a grabbed handle (by id or position) back to the SOURCE handle on
// that side, so a drag-created edge leaves from the side you pulled from.
// Each side carries both a source ("t"/"r"/"b"/"l") and target
// ("tt"/"rt"/"bt"/"lt") handle.
const SIDE_FROM_ID = {
  t: "t",
  tt: "t",
  r: "r",
  rt: "r",
  b: "b",
  bt: "b",
  l: "l",
  lt: "l",
};
const SIDE_FROM_POS = { top: "t", right: "r", bottom: "b", left: "l" };
// Fallback entry side: opposite the side the edge left the source from.
const OPPOSITE_TARGET = { t: "b", r: "l", b: "t", l: "r" };
// Pen auto-shape: how long the pen must hold still on a recognisable stroke
// before the snap-preview (ghost + haptic) arms. A lift while armed snaps.
const SHAPE_HOLD_MS = 350;

// The live "lift to keep this" ghost drawn while an auto-shape hold is armed.
// Rendered in FLOW space (inside a ViewportPortal); non-scaling strokes keep a
// constant on-screen weight at any zoom. `preview` is a recognizeStroke result
// (+ an `edge` flag for lines that will connect two nodes).
function ShapeGhost({ preview, color }) {
  const common = { stroke: color, strokeWidth: 2.5, vectorEffect: "non-scaling-stroke", fill: color, fillOpacity: 0.14, strokeLinejoin: "round" };
  if (preview.kind === "line") {
    const { from, to, edge } = preview;
    return (
      <g>
        <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={color} strokeWidth={2.5} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
        {edge && [from, to].map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={4} fill={color} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    );
  }
  const { x, y, w, h } = preview.rect;
  const cx = x + w / 2, cy = y + h / 2;
  if (preview.kind === "ellipse") return <ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2} {...common} />;
  if (preview.kind === "triangle") return <polygon points={`${cx},${y} ${x + w},${y + h} ${x},${y + h}`} {...common} />;
  if (preview.kind === "diamond") return <polygon points={`${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`} {...common} />;
  return <rect x={x} y={y} width={w} height={h} rx={6} {...common} />;
}

// The number/letter "stamp" ghost — the armed node shown under the cursor before
// a click drops it. Sized to the node's DEFAULTS so it matches exactly. Rendered
// in FLOW space (inside a ViewportPortal). `at` is the top-left in flow coords.
function PlacementGhost({ placing, at }) {
  const { w, h } = DEFAULTS[placing.type] || DEFAULTS.shape;
  const wrap = { position: "absolute", left: at.x, top: at.y, width: w, height: h, pointerEvents: "none", opacity: 0.85, zIndex: 7 };
  if (placing.type === "shape") {
    return (
      <div style={wrap}>
        <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
          <ShapeSvg shape={placing.extra?.shape} w={w} h={h} fill="rgba(14,165,233,0.14)" stroke="#0ea5e9" sw={2} dash="6 5" />
        </svg>
      </div>
    );
  }
  if (placing.type === "sticky") {
    return <div style={{ ...wrap, background: placing.extra?.color || "#fde68a", borderRadius: 6, boxShadow: "0 6px 18px -6px rgba(0,0,0,.35)" }} />;
  }
  // goal / frame → a dashed accent outline at the node's footprint.
  return <div style={{ ...wrap, border: "2px dashed #0ea5e9", borderRadius: placing.type === "goal" ? 14 : 8, background: "rgba(14,165,233,0.08)" }} />;
}

// Broadcasts the live viewport (throttled by `push`) on ANY change — user
// pan/zoom AND programmatic zoom (⌘ +/−/0, fit) that ReactFlow's onMove doesn't
// report — so followers mirror everything. Paused while I'm FOLLOWING someone
// (I'm mirroring, not leading, so I don't echo their viewport back). A leaf
// component: only IT re-renders per frame, not the whole editor.
function ViewportBroadcaster({ push, paused }) {
  const { x, y, zoom } = useViewport();
  useEffect(() => {
    if (!paused) push({ x, y, zoom });
  }, [x, y, zoom, paused, push]);
  return null;
}

export default function WhiteboardPage() {
  const { whiteboardId } = useParams();
  return <WhiteboardBoard boardId={whiteboardId} />;
}

// Reusable board: the full editor wrapped in its own ReactFlowProvider so
// it can be dropped into the /whiteboards route (above) OR a room panel
// tile. `embedded` trims page-only chrome (back link, archive, full-
// viewport height) so it fits inside an arbitrary container.
// Region capture: a full-cover overlay that lets you drag a box over the canvas
// to export just that area as a PNG (a "snip" tool). It grabs the drag itself —
// so nodes don't move and the canvas doesn't pan — and exits on release. The two
// corners convert through screenToFlowPosition, so the captured bounds are in
// flow space regardless of the current pan/zoom. A dashed box dims everything
// outside the selection while dragging.
function RegionCapture({ toFlow, onComplete, onCancel, dark }) {
  const [box, setBox] = useState(null); // client-space rect for the visual
  const startRef = useRef(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const down = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    startRef.current = { x: e.clientX, y: e.clientY };
    draggingRef.current = true;
    setBox({ l: e.clientX, t: e.clientY, w: 0, h: 0 });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ }
  };
  const move = (e) => {
    if (!draggingRef.current) return;
    const s = startRef.current;
    setBox({ l: Math.min(s.x, e.clientX), t: Math.min(s.y, e.clientY), w: Math.abs(e.clientX - s.x), h: Math.abs(e.clientY - s.y) });
  };
  const up = (e) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const s = startRef.current;
    setBox(null);
    let a, b;
    try {
      a = toFlow({ x: Math.min(s.x, e.clientX), y: Math.min(s.y, e.clientY) });
      b = toFlow({ x: Math.max(s.x, e.clientX), y: Math.max(s.y, e.clientY) });
    } catch { onCancel(); return; }
    const bounds = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
    if (bounds.width < 8 || bounds.height < 8) { onCancel(); return; } // a click, not a drag
    onComplete(bounds);
  };

  return (
    <div
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      style={{ position: "absolute", inset: 0, zIndex: 50, cursor: "crosshair", background: "transparent", touchAction: "none" }}
    >
      {box && (
        <div
          style={{
            position: "fixed", left: box.l, top: box.t, width: box.w, height: box.h,
            border: "2px dashed #38bdf8", background: "rgba(56,189,248,0.10)",
            boxShadow: "0 0 0 9999px rgba(15,23,42,0.30)", pointerEvents: "none",
          }}
        />
      )}
      <div
        style={{
          position: "absolute", top: 14, left: "50%", transform: "translateX(-50%)",
          background: dark ? "rgba(2,6,23,0.92)" : "rgba(15,23,42,0.88)", color: "#fff",
          fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 9999,
          pointerEvents: "none", whiteSpace: "nowrap", zIndex: 51,
        }}
      >
        Drag to capture a region · Esc to cancel
      </div>
    </div>
  );
}

export function WhiteboardBoard({ boardId, embedded = false, readOnly = false }) {
  return (
    <ReactFlowProvider>
      <WhiteboardEditor boardId={boardId} embedded={embedded} readOnly={readOnly} />
    </ReactFlowProvider>
  );
}

function WhiteboardEditor({ boardId, embedded = false, readOnly = false }) {
  const { theme } = useTheme();
  const { isAdmin, activeTeamId } = useTeam();
  const navigate = useNavigate();
  const dark = theme === "dark";

  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Keep the loading UI up for a minimum window so the spinner doesn't flicker
  // on very fast fetches. Only gates the visual — data-ready logic still uses
  // the real `loading` flag.
  const [minLoadElapsed, setMinLoadElapsed] = useState(false);
  useEffect(() => {
    setMinLoadElapsed(false);
    const t = setTimeout(() => setMinLoadElapsed(true), 350);
    return () => clearTimeout(t);
  }, [boardId]);
  const showLoading = loading || !minLoadElapsed;
  // When embedded in a small room tile, shed the heavier chrome (minimap,
  // goal banner, badges) so the canvas stays usable.
  const mainRef = useRef(null);
  const [compact, setCompact] = useState(false);
  // Whether the title bar's extra tools (reactions / timer / minimap / export /
  // capture / template) are shown. Auto-collapses when the board gets small so
  // the bar stays a single row; a toggle reveals them (they wrap to a second
  // row when the board is narrow).
  const [toolsOpen, setToolsOpen] = useState(true);
  // Left drawing toolbar: collapsible, wraps to 2 columns when the board is
  // small, and a "Q" keyboard shortcut pops a floating quick-tool palette.
  const [toolbarOpen, setToolbarOpen] = useState(true);
  const [palette, setPalette] = useState(null); // {x,y} viewport pos, or null

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  // Alignment-guide lines shown while dragging a single node (see ./snapping).
  const [helperLines, setHelperLines] = useState(NO_LINES);
  const helperShownRef = useRef(false);

  // Inline header edit state.
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [goalEditing, setGoalEditing] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  // Toggle for the floating emote reaction bar (per device). Peers'
  // emotes still render when off — only your bar is hidden.
  const [emoteBarOn, setEmoteBarOn] = useState(() => {
    try {
      return localStorage.getItem("ql_wb_emote_bar") !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("ql_wb_emote_bar", emoteBarOn ? "1" : "0");
    } catch {
      /* */
    }
  }, [emoteBarOn]);

  // View toggles — hide the countdown timer / minimap (remembered locally).
  const [showTimer, setShowTimer] = useState(() => {
    try { return localStorage.getItem("ql_wb_timer") !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("ql_wb_timer", showTimer ? "1" : "0"); } catch { /* */ }
  }, [showTimer]);
  const [showMinimap, setShowMinimap] = useState(() => {
    try { return localStorage.getItem("ql_wb_minimap") !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("ql_wb_minimap", showMinimap ? "1" : "0"); } catch { /* */ }
  }, [showMinimap]);
  const [saveTplOpen, setSaveTplOpen] = useState(false); // "Save as template" dialog

  // Measured height of the bottom toolbar (it can wrap to two rows on narrow
  // phones) — the paint toolbar and the emote bar stack above it by this.
  const toolbarRO = useRef(null);
  const [toolbarH, setToolbarH] = useState(44);
  const toolbarRef = useCallback((el) => {
    toolbarRO.current?.disconnect();
    toolbarRO.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight || 44;
      setToolbarH(h);
      // Portaled flyouts + the mobile inspector read this to clear the bar.
      document.documentElement.style.setProperty("--wb-toolbar-clear", `${15 + h + 8}px`);
    });
    ro.observe(el);
    toolbarRO.current = ro;
  }, []);
  // Measure the floating top-left title card (1 row on desktop, wraps to 2 on
  // narrow phones) → `--wb-topbar-offset`, the top inset that keeps top-center
  // overlays (align bar, follow banner…) clear of it. top-3 (12px) + card + gap.
  const topbarRO = useRef(null);
  const topbarRef = useCallback((el) => {
    topbarRO.current?.disconnect();
    topbarRO.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      document.documentElement.style.setProperty("--wb-topbar-offset", `${12 + (el.offsetHeight || 44) + 10}px`);
    });
    ro.observe(el);
    topbarRO.current = ro;
  }, []);
  const touchInspectorRO = useRef(null);
  const [touchInspectorH, setTouchInspectorH] = useState(TOUCH_INSPECTOR_FALLBACK_H);
  const touchInspectorRef = useCallback((el) => {
    touchInspectorRO.current?.disconnect();
    touchInspectorRO.current = null;
    if (!el) return;
    const update = () => setTouchInspectorH(el.offsetHeight || TOUCH_INSPECTOR_FALLBACK_H);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    touchInspectorRO.current = ro;
  }, []);

  // Draw modes: one finger draws, two fingers navigate. Once d3-zoom accepts
  // a touchstart (needed for pinch) it pans on ANY one-finger drag, stealing
  // strokes — so single-touch events are stopped in capture before its pane
  // listeners see them. Two-finger events pass through (pinch-zoom/pan), and
  // the pen/brush/laser handlers use POINTER events, which are unaffected.
  const blockSingleTouchInDraw = (e) => {
    if (!WB_TOUCH) return;
    const drawMode = tool === "pen" || tool === "brush" || tool === "laser" || tool === "lasso";
    // Also block one-finger pan while a floating selection is active, so a
    // finger-drag MOVES the selection (handled by the pointer handlers) and a
    // tap deselects — instead of d3-zoom stealing the touch to pan the canvas.
    // Two-finger touches still pass through for pinch-zoom/pan.
    if (!drawMode && !areaSelRef.current) return;
    if (e.touches.length === 1) e.stopPropagation();
  };

  // Two/three-finger tap = undo/redo (iPad convention). Start a candidate on a
  // 2- or 3-finger touch; cancel it the moment the centroid or spread drifts
  // (that's a pan/pinch, not a tap); fire on a quick clean release. Passive —
  // never preventDefault, so pinch-zoom/pan navigation is untouched.
  const onWbTouchStart = (e) => {
    if (!WB_TOUCH) return;
    const n = e.touches.length;
    if (strokePidRef.current != null || n < 2 || n > 3) { tapGestureRef.current = null; return; }
    const c = touchCentroid(e.touches);
    const g = tapGestureRef.current;
    if (g && !g.canceled) g.max = Math.max(g.max, n); // a 3rd finger joined a 2-finger start
    else tapGestureRef.current = { max: n, t: Date.now(), c, spread: touchSpread(e.touches, c), canceled: false };
  };
  const onWbTouchMove = (e) => {
    const g = tapGestureRef.current;
    if (!g || g.canceled) return;
    const c = touchCentroid(e.touches);
    if (Math.hypot(c.x - g.c.x, c.y - g.c.y) > TAP_GESTURE_SLOP) { g.canceled = true; return; }
    if (Math.abs(touchSpread(e.touches, c) - g.spread) > TAP_GESTURE_SLOP) g.canceled = true;
  };
  const onWbTouchEnd = (e) => {
    const g = tapGestureRef.current;
    if (!g) return;
    if (e.touches.length > 0) return; // wait until every finger lifts
    tapGestureRef.current = null;
    if (g.canceled || Date.now() - g.t > TAP_GESTURE_MS) return;
    if (g.max === 2 && canUndo) { undo(); navigator.vibrate?.(8); }
    else if (g.max === 3 && canRedo) { redo(); navigator.vibrate?.(8); }
  };

  // The editor is a fixed-viewport surface — lock body scrolling while it's
  // mounted (shared with Messages/Office) so iOS rubber-banding can't reveal
  // the page padding below the canvas or shove content under the tab bar.
  useBodyScrollLock(!embedded);

  // Kill the iOS Apple-Pencil text-selection / callout gesture that otherwise
  // fires mid-stroke and chops handwriting into fragments ("hello" → "[le]").
  // It's driven by the TOUCH event's default action, and React's touch
  // listeners are passive (preventDefault is ignored there) — so we attach a
  // NON-passive native listener on the canvas and preventDefault while a draw
  // tool is active. Scoped away from the toolbars (they keep their scroll), and
  // it never stops propagation, so drawing (pointer events), pinch-zoom, and the
  // two/three-finger tap-undo all still fire.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return undefined;
    const onTouch = (e) => {
      const tool = toolRef.current;
      if (tool !== "pen" && tool !== "brush" && tool !== "laser" && tool !== "lasso") return;
      const tgt = e.target;
      if (tgt instanceof Element && tgt.closest(".react-flow__panel")) return; // leave toolbars alone
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", onTouch, { passive: false });
    el.addEventListener("touchmove", onTouch, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouch);
      el.removeEventListener("touchmove", onTouch);
    };
  }, []);

  // The Pencil can still create a text selection while drawing, which pops the
  // iOS Copy/Look-Up callout (harmless but ugly). Collapse any selection the
  // moment it forms while a draw tool is active, so the menu has nothing to show.
  useEffect(() => {
    const onSel = () => {
      const tool = toolRef.current;
      if (tool !== "pen" && tool !== "brush" && tool !== "laser") return;
      const sel = window.getSelection?.();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  // Default style seeded into new text nodes (persisted per device). A ref keeps
  // the latest for the stable double-click-create handler.
  const [textStyle, setTextStyleRaw] = useState(loadTextStyle);
  const textStyleRef = useRef(textStyle);
  textStyleRef.current = textStyle;
  const setTextStyle = useCallback((next) => { setTextStyleRaw(next); saveTextStyle(next); }, []);

  // Track the board's own size (only when embedded) to toggle compact chrome.
  useEffect(() => {
    if (!embedded) {
      setCompact(false);
      return;
    }
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setCompact(r.width < 760 || r.height < 520);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [embedded, board?.id, loading]);

  // Follow compactness: collapse the extra title-bar tools when the board turns
  // small, re-open them when it grows. Only fires on a compact *change*, so a
  // manual toggle in between is kept until the next threshold crossing.
  useEffect(() => { setToolsOpen(!compact); }, [compact]);

  // Escape closes the quick-tool palette (separate from the board key handler so
  // it isn't gated on board focus and reads fresh palette state).
  useEffect(() => {
    if (!palette) return undefined;
    const onEsc = (e) => { if (e.key === "Escape") setPalette(null); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [palette]);

  const [saveState, setSaveState] = useState("idle"); // idle | dirty | saving | saved

  const rf = useReactFlow();
  const connectingRef = useRef(null);
  const connectKeyRef = useRef(null); // keydown handler active during a connect drag
  const [connecting, setConnecting] = useState(false); // a connect drag is in progress
  const [pickedShape, setPickedShape] = useState(null); // shape chosen via 1–9 mid-drag
  // "Stamp a node": a key arms a node ({type, extra}) that ghosts under the
  // cursor, then a click places it. 1–9/0 → shapes; N sticky, G goal, F frame.
  // placingRef mirrors the state for the pointer handlers; placeNodeRef holds
  // the (later-defined) placement fn; ghostFlow is the ghost's top-left in FLOW
  // coords, tracked live from the cursor. pendingImageAtRef carries the drop
  // point for the I-key image picker (async, so it can't ride the ghost).
  const [placing, setPlacing] = useState(null);
  const placingRef = useRef(null);
  placingRef.current = placing;
  const placeNodeRef = useRef(null);
  const pendingImageAtRef = useRef(null);
  const [ghostFlow, setGhostFlow] = useState(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false); // "?" cheatsheet
  const { session, settings } = useApp();
  const myName =
    settings?.name ||
    session?.user?.user_metadata?.name ||
    session?.user?.email?.split("@")[0] ||
    "";

  // Read-only (e.g. the public /w/:id viewer) never joins the realtime channel:
  // it renders the snapshot statically and must not send/apply broadcast ops.
  const collabEnabled = !loading && !!board?.id && !readOnly;

  // ── undo / redo (entity-scoped, multiplayer-safe). Set up BEFORE sync so it
  // can hand sync its onRemoteApply seam (peer edits fold into the baseline
  // and never become my undo steps). See useWhiteboardHistory.
  const { undo, redo, canUndo, canRedo, onRemoteApply, pushExternalStep, runSilent } = useWhiteboardHistory({
    nodes,
    edges,
    setNodes,
    setEdges,
    enabled: collabEnabled,
  });

  // ── live collaboration: broadcast node/edge diffs + cursors on top of
  // the snapshot-of-record, plus presence. See useWhiteboardSync.
  // Raster paint layer (tiled). Peer strokes arrive as vectors and rasterise
  // locally via the layer's imperative handle. onPaint is stable so it doesn't
  // churn the sync channel subscription.
  const paintRef = useRef(null);
  const onPaint = useCallback((p) => paintRef.current?.apply(p), []);
  // Raster-brush undo: while a stroke runs, snapshot the PRE-paint pixels of
  // each tile it enters (once). On release we commit an external history step
  // (before → undo, after → redo). Local strokes only; see Phase 5 in the plan.
  const paintUndoRef = useRef(null);
  // Region-op patches from peers apply through applyPaintOps (set below). A ref
  // breaks the hook cycle (sync needs onPaintPatch; applyPaintOps needs the
  // sync's pushPaintPatch).
  const applyPaintOpsRef = useRef(null);
  const onPaintPatch = useCallback((ops) => applyPaintOpsRef.current?.(ops, false), []);

  const { peers, members, viewports, pushCursor, pushViewport, pushPaint, pushPaintPatch, myColor } = useWhiteboardSync({
    boardId: board?.id,
    enabled: collabEnabled,
    nodes,
    edges,
    setNodes,
    setEdges,
    name: myName,
    onRemoteApply,
    onPaint,
    onPaintPatch,
  });

  // ── Follow / presentation: mirror another person's viewport ──
  const [followingId, setFollowingId] = useState(null);
  const followingIdRef = useRef(null);
  followingIdRef.current = followingId;
  const followMember = useCallback((id) => setFollowingId((cur) => (cur === id ? null : id)), []);
  // Apply the followed peer's viewport whenever it changes (smoothly).
  useEffect(() => {
    if (!followingId) return;
    const vp = viewports[followingId];
    if (!vp) return;
    try { rf.setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom }, { duration: 120 }); } catch { /* */ }
  }, [followingId, viewports, rf]);
  // Auto-stop following if that person leaves.
  useEffect(() => {
    if (followingId && !members.some((m) => m.id === followingId)) setFollowingId(null);
  }, [followingId, members]);
  // A user-initiated pan/zoom (event is non-null; programmatic follow passes
  // null) drops me out of follow mode.
  const onViewportMoveStart = useCallback((e) => { if (e && followingIdRef.current != null) setFollowingId(null); }, []);
  const followingMember = followingId ? members.find((m) => m.id === followingId) : null;

  // Apply an ordered list of raster region ops to the LOCAL paint layer (used
  // when a peer's patch arrives). Op shapes:
  //   { clearall:true }             — wipe the whole layer
  //   { clear: rect }               — clear a flow-rect
  //   { lift: {src, dst} }          — MOVE: recompute pixels from THIS client's
  //                                   own tiles (readRegion(src)) → clear src →
  //                                   stamp at dst (no pixels on the wire)
  //   { stamp: {rect, canvas|img} } — draw a region image (undo carries a PNG)
  const applyPaintOps = useCallback((ops) => {
    const pr = paintRef.current;
    for (const op of ops) {
      if (op.clearall) pr?.clearAll();
      else if (op.clear) pr?.clearRegion(op.clear, op.clip);
      else if (op.lift) { const r = pr?.readRegion(op.lift.src, op.lift.clip); pr?.clearRegion(op.lift.src, op.lift.clip); if (r) pr?.stampRegion(r, op.lift.dst); }
      else if (op.stamp) {
        if (op.stamp.canvas) pr?.stampRegion(op.stamp.canvas, op.stamp.rect);
        else if (op.stamp.img) { const im = new Image(); im.onload = () => paintRef.current?.stampRegion(im, op.stamp.rect); im.src = op.stamp.img; }
      }
    }
  }, []);
  applyPaintOpsRef.current = applyPaintOps;
  // Broadcast region ops to peers (no local apply — the caller already mutated
  // its own tiles). Canvas stamps are encoded to PNG dataURLs for the wire.
  const broadcastPaintOps = useCallback((ops) => {
    if (!ops?.length) return;
    const wire = ops.map((op) => (op.stamp?.canvas
      ? { stamp: { rect: op.stamp.rect, img: op.stamp.canvas.toDataURL("image/png") } }
      : op));
    pushPaintPatch(wire);
  }, [pushPaintPatch]);

  // Active canvas tool: "select" (default), "laser" (ephemeral presenting
  // pointer) or "pen" (freehand draw). Laser/pen gate node interaction so you
  // can gesture/draw over the board without disturbing it.
  const [tool, setTool] = useState("select");
  const toolRef = useRef(tool);
  toolRef.current = tool;

  // Pen colour + width (persisted per device). A ref so the pointer handlers
  // read the latest without re-subscribing.
  const [penStyle, setPenStyle] = useState(loadPenStyle);
  const penStyleRef = useRef(penStyle);
  penStyleRef.current = penStyle;
  useEffect(() => { savePenStyle(penStyle); }, [penStyle]);

  // In-progress freehand stroke (FLOW coords) + its rAF-batched live preview.
  const drawingRef = useRef(null);
  const drawRafRef = useRef(0);
  const [drawPath, setDrawPath] = useState(null);
  // Last SIGNIFICANT pen movement (pos + ts) — lets finishStroke detect a
  // deliberate end-pause ("hold to snap to a shape") vs a stroke still in motion.
  const penMoveRef = useRef({ pos: null, ts: 0 });
  // Auto-shape hold PREVIEW: while the pen holds still on a recognisable stroke,
  // we show a ghost of the clean result + a haptic pulse BEFORE you lift, so the
  // snap is confirmed, not a gamble. shapePreview drives the ghost; the ref lets
  // the pointer handlers read/gate it; the timer debounces "held still".
  const [shapePreview, setShapePreview] = useState(null);
  const shapePreviewRef = useRef(null);
  const shapeHoldTimerRef = useRef(0);
  const clearShapePreview = useCallback(() => {
    if (shapeHoldTimerRef.current) { clearTimeout(shapeHoldTimerRef.current); shapeHoldTimerRef.current = 0; }
    if (shapePreviewRef.current) { shapePreviewRef.current = null; setShapePreview(null); }
  }, []);
  // Called on every pen move: drop any stale preview and (re)arm a hold timer.
  // When the pen then holds still for SHAPE_HOLD_MS on a recognisable stroke, the
  // ghost + haptic fire — telling you a lift will snap. Any further move re-arms.
  const armShapePreview = useCallback(() => {
    if (shapeHoldTimerRef.current) clearTimeout(shapeHoldTimerRef.current);
    if (shapePreviewRef.current) { shapePreviewRef.current = null; setShapePreview(null); }
    shapeHoldTimerRef.current = setTimeout(() => {
      shapeHoldTimerRef.current = 0;
      const pts = drawingRef.current?.points;
      const shape = pts && recognizeStroke(pts);
      if (!shape) return;
      // For a line, decide up front whether it will become an EDGE (both ends
      // over connectable nodes), so the ghost can show that intent.
      let edge = false;
      if (shape.kind === "line") {
        const M = 12;
        const hit = (pt) => rf.getNodes().find((n) => {
          if (NON_CONNECTABLE.has(n.type)) return false;
          const r = nodeRect(rf.getInternalNode(n.id) || n); // absolute rect (framed shapes)
          return r && pt.x >= r.x - M && pt.x <= r.x + r.w + M && pt.y >= r.y - M && pt.y <= r.y + r.h + M;
        });
        const a = hit(shape.from), b = hit(shape.to);
        edge = !!(a && b && a.id !== b.id);
      }
      const preview = { ...shape, edge };
      shapePreviewRef.current = preview;
      setShapePreview(preview);
      navigator.vibrate?.(15);
    }, SHAPE_HOLD_MS);
  }, [rf]);

  // Ephemeral laser-ink trail (FLOW coords, timestamped) drawn while the laser
  // button is held — fades on its own, persists nothing. See LaserTrail.
  const laserInkRef = useRef([]);
  const laserDrawingRef = useRef(false);
  // Drives the local laser dot's visibility — it only shows while pressing.
  const [laserPressing, setLaserPressing] = useState(false);

  // Raster brush settings (persisted) + the in-progress paint stroke. Local
  // points rasterise immediately; broadcasts go out in ~70ms batches.
  const [brushStyle, setBrushStyle] = useState(loadBrushStyle);
  const brushStyleRef = useRef(brushStyle);
  brushStyleRef.current = brushStyle;
  useEffect(() => { saveBrushStyle(brushStyle); }, [brushStyle]);

  // Laser dot/ink colour: a chosen colour, or my cursor colour by default.
  const [laserColor, setLaserColor] = useState(loadLaserColor);
  useEffect(() => { saveLaserColor(laserColor); }, [laserColor]);
  const effectiveLaserColor = laserColor || myColor;
  const laserColorRef = useRef(effectiveLaserColor);
  laserColorRef.current = effectiveLaserColor;
  const paintStrokeIdRef = useRef(null);
  const paintBrushRef = useRef(null);
  const paintBatchRef = useRef([]);
  const paintLastFlushRef = useRef(0);
  const flushPaint = useCallback(() => {
    const id = paintStrokeIdRef.current;
    const pts = paintBatchRef.current;
    if (!id || !pts.length) return;
    paintBatchRef.current = [];
    pushPaint({ id, brush: paintBrushRef.current, pts });
  }, [pushPaint]);

  // Last pointer position in FLOW coords — so paste lands under the cursor.
  const lastPtRef = useRef(null);
  const lastClientRef = useRef(null); // last cursor position in SCREEN coords
  // The single pointer that owns the current pen/laser/brush stroke. A second
  // finger landing mid-stroke means navigation (pinch) — abort the stroke so
  // it doesn't zigzag between the two fingers.
  const strokePidRef = useRef(null);
  // In-flight multi-finger tap-gesture candidate (2=undo, 3=redo). See the
  // onWbTouch* handlers.
  const tapGestureRef = useRef(null);
  // "pen" | "touch" | "mouse" of the pointer that owns the active stroke — lets
  // us tell a resting palm (touch) apart from the drawing Pencil.
  const strokeTypeRef = useRef(null);
  // Pointer classification + palm rejection (Apple-Pencil-first). Owns the
  // touch-map + stylus refs; reads the shared strokeTypeRef for penActive.
  const { trackTouches, classifyPointer, pointerForce, penActive, lastPenTsRef, stylusSeenRef } =
    usePalmRejection({ strokeTypeRef });

  // ── Region select (marquee / lasso / floating selection) ──
  // Extracted into useWhiteboardRegionSelect. Called here — above the pen/brush
  // pointer handlers below — so the refs it owns (areaDragRef, lassoRef, …) are
  // in scope for those (out-of-scope, untouched) handlers, and below penActive
  // (passed in) so its eager evaluation doesn't hit a TDZ.
  const {
    marqueeRect,
    areaBox,
    areaSel,
    lassoPath,
    areaDragRef,
    areaMoveRef,
    lassoRef,
    areaSelRef,
    moveAreaRef,
    commitAreaRef,
    finalizeAreaRef,
    finalizeLassoRef,
    setAreaBox,
    setLassoPath,
    marqueePointerDown,
    marqueePointerMove,
    marqueePointerUp,
    onEditorClickCapture,
    deleteAreaSelection,
    commitAreaSelection,
    cancelAreaSelection,
  } = useWhiteboardRegionSelect({
    rf,
    paintRef,
    setNodes,
    setEdges,
    runSilent,
    pushExternalStep,
    broadcastPaintOps,
    tool,
    toolRef,
    penActive,
  });
  // Edge ids inside the current floating selection → highlighted via context so
  // marquee/lasso'd connectors visibly join the group (local-only, no sync).
  const areaSelEdgeIds = useMemo(
    () => new Set((areaSel?.edges || []).map((e) => e.id)),
    [areaSel],
  );

  const cancelActiveStroke = useCallback(() => {
    strokePidRef.current = null;
    strokeTypeRef.current = null;
    if (laserDrawingRef.current) {
      laserDrawingRef.current = false;
      setLaserPressing(false);
      const lp = lastPtRef.current;
      if (lp) pushCursor(lp.x, lp.y, false, false, laserColorRef.current);
    }
    if (paintStrokeIdRef.current) {
      const id = paintStrokeIdRef.current;
      // Two fingers = navigate. Erase the stray dab/partial stroke the first
      // finger painted before the pinch was recognised by restoring the tiles
      // we snapshotted at stroke start; if we have no snapshot, just close it.
      const u = paintUndoRef.current;
      paintUndoRef.current = null;
      paintStrokeIdRef.current = null;
      paintBatchRef.current = [];
      paintRef.current?.apply({ id, brush: paintBrushRef.current, pts: [], end: true }, true);
      if (u && u.before.size) paintRef.current?.restore(u.before);
    }
    if (drawingRef.current) {
      drawingRef.current = null;
      if (drawRafRef.current) { cancelAnimationFrame(drawRafRef.current); drawRafRef.current = 0; }
      setDrawPath(null);
    }
    clearShapePreview();
  }, [pushCursor, clearShapePreview]);

  // Live pen-preview path: variable-width outline when pressure is on, else the
  // cheap constant-width centerline. Matches how DrawNode renders the committed
  // stroke so the preview doesn't jump on release.
  const previewPath = useCallback((pts) => {
    const ps = penStyleRef.current;
    return ps.pressure ? strokeOutlinePath(pts, { width: ps.width, last: false }) : strokePath(pts);
  }, []);

  // Live marquee highlight: as the region box grows, mark the nodes it currently
  // covers `selected` so they light up in real time (the "responsive" feel) — and
  // the align + bulk-edit toolbars, both keyed off `selected`, come alive too.
  // Only re-issues setNodes when the covered SET changes (cheap on big boards).
  const marqueeHiliteRef = useRef("");
  const liveHighlightMarquee = useCallback((sx0, sy0, sx1, sy1, base) => {
    let a, b;
    try {
      a = rf.screenToFlowPosition({ x: Math.min(sx0, sx1), y: Math.min(sy0, sy1) });
      b = rf.screenToFlowPosition({ x: Math.max(sx0, sx1), y: Math.max(sy0, sy1) });
    } catch { return; }
    const rx = a.x, ry = a.y, rw = Math.max(1, b.x - a.x), rh = Math.max(1, b.y - a.y);
    const hit = new Set(base || []); // Shift → keep the pre-drag selection, union on
    for (const n of rf.getNodes()) {
      if (n.type === "zone") continue;
      const inode = rf.getInternalNode(n.id);
      const pos = inode?.internals?.positionAbsolute || n.position;
      const w = n.measured?.width ?? n.width ?? 0;
      const h = n.measured?.height ?? n.height ?? 0;
      if (pos.x < rx + rw && pos.x + w > rx && pos.y < ry + rh && pos.y + h > ry) hit.add(n.id);
    }
    const key = [...hit].sort().join(",");
    if (key === marqueeHiliteRef.current) return; // covered set unchanged
    marqueeHiliteRef.current = key;
    setNodes((nds) => nds.map((n) => {
      const sel = hit.has(n.id);
      return n.selected === sel ? n : { ...n, selected: sel };
    }));
  }, [rf, setNodes]);

  const onWbPointerMove = useCallback(
    (e) => {
      lastClientRef.current = { x: e.clientX, y: e.clientY };
      if (e.pointerType === "pen") { lastPenTsRef.current = Date.now(); stylusSeenRef.current = true; }
      if (areaDragRef.current && e.pointerId === areaDragRef.current.pid) {
        const d = areaDragRef.current;
        if (!d.armed) {
          // Below the threshold it's still a click (which must deselect) — only
          // a real drag opens the box + captures the pointer.
          if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
          d.armed = true;
          setAreaBox({ x0: d.x0, y0: d.y0, x1: e.clientX, y1: e.clientY });
          try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* */ }
        } else {
          setAreaBox((bx) => (bx ? { ...bx, x1: e.clientX, y1: e.clientY } : bx));
        }
        liveHighlightMarquee(d.x0, d.y0, e.clientX, e.clientY, d.base);
        return;
      }
      if (areaMoveRef.current && e.pointerId === areaMoveRef.current.pid) {
        const m = areaMoveRef.current;
        try { const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }); moveAreaRef.current?.(m.baseDx + (p.x - m.sx), m.baseDy + (p.y - m.sy)); } catch { /* */ }
        return;
      }
      if (lassoRef.current && e.pointerId === lassoRef.current.pid) {
        const l = lassoRef.current;
        const last = l.pts[l.pts.length - 1];
        if (!last || Math.abs(e.clientX - last[0]) + Math.abs(e.clientY - last[1]) > 2) {
          l.pts.push([e.clientX, e.clientY]);
          setLassoPath(screenPolyPath(l.pts));
        }
        return;
      }
      try {
        const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        lastPtRef.current = { x: p.x, y: p.y };
        // Laser dot (mine + peers') shows only while pressing, so broadcast the
        // laser flag tied to the press, not just the mode.
        pushCursor(p.x, p.y, laserDrawingRef.current, laserDrawingRef.current, laserColorRef.current);
        // Only the stroke-owning pointer extends it — a stray second finger
        // must not feed points in.
        const owns = strokePidRef.current === null || strokePidRef.current === e.pointerId;
        // Laser ink: append while the button is held (the trail fades itself).
        if (owns && laserDrawingRef.current) {
          const arr = laserInkRef.current;
          const last = arr[arr.length - 1];
          if (!last || Math.abs(p.x - last.x) + Math.abs(p.y - last.y) > 1) {
            arr.push({ x: p.x, y: p.y, t: Date.now() });
          }
        }
        // Raster brush: rasterise locally each move; batch the broadcast.
        if (owns && paintStrokeIdRef.current) {
          const u = paintUndoRef.current;
          // Drain coalesced samples (a fast drag / Pencil fires many between
          // rAFs) so the stroke lays down a dense, continuous line instead of a
          // few far-apart points that read as separate blobs.
          const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
          const samples = evs && evs.length ? evs : [e];
          const newPts = [];
          let ref = u ? u.prev : null;
          for (const ev of samples) {
            let q = p;
            if (ev !== e) { try { q = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY }); } catch { continue; } }
            if (!ref || Math.abs(q.x - ref[0]) + Math.abs(q.y - ref[1]) > 0.75) { newPts.push([q.x, q.y]); ref = [q.x, q.y]; }
          }
          if (newPts.length) {
            if (u) {
              // Snapshot any newly-entered tile before this stroke paints it.
              for (const pt of newPts) {
                paintRef.current?.snapshot(segmentTileKeys(u.prev[0], u.prev[1], pt[0], pt[1], u.size), u.before);
                u.prev = pt;
              }
            }
            paintRef.current?.apply({ id: paintStrokeIdRef.current, brush: paintBrushRef.current, pts: newPts }, true);
            for (const pt of newPts) paintBatchRef.current.push(pt);
            const now = Date.now();
            if (now - paintLastFlushRef.current > 70) { paintLastFlushRef.current = now; flushPaint(); }
          }
        }
        const dr = owns ? drawingRef.current : null;
        if (dr) {
          // Drain coalesced samples (a Pencil fires many between rAFs) so the
          // stroke keeps every point + its pressure, not just the last one.
          const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
          const samples = evs && evs.length ? evs : [e];
          let added = false;
          for (const ev of samples) {
            let q = p;
            if (ev !== e) { try { q = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY }); } catch { continue; } }
            const last = dr.points[dr.points.length - 1];
            // Drop near-duplicate samples so the path stays light.
            if (!last || Math.abs(q.x - last[0]) + Math.abs(q.y - last[1]) > 1.2) {
              dr.points.push([q.x, q.y, pointerForce(ev)]);
              added = true;
              const pm = penMoveRef.current;
              if (!pm.pos || Math.hypot(q.x - pm.pos[0], q.y - pm.pos[1]) > 6) { pm.pos = [q.x, q.y]; pm.ts = Date.now(); }
            }
          }
          if (added) {
            // The pen moved → re-arm the auto-shape hold timer (drops any ghost
            // that was showing, since the stroke changed).
            armShapePreview();
            if (!drawRafRef.current) {
              drawRafRef.current = requestAnimationFrame(() => {
                drawRafRef.current = 0;
                setDrawPath(previewPath(drawingRef.current?.points || []));
              });
            }
          }
        }
      } catch {
        /* */
      }
    },
    [rf, pushCursor, flushPaint, previewPath, pointerForce, armShapePreview, liveHighlightMarquee]
  );

  // Pen down: begin a stroke. Capture-phase so it wins over the (disabled in
  // pen mode) ReactFlow pane/node handlers, and works when starting over a
  // node. Only fires inside the canvas, never over the toolbar/controls.
  const onWbPointerDownCapture = useCallback(
    (e) => {
      const ptype = classifyPointer(e);
      if (ptype === "pen") { lastPenTsRef.current = Date.now(); stylusSeenRef.current = true; }
      const mode = toolRef.current;
      // Dragging the floating region selection to MOVE it. Captured on <main>
      // (reliable) rather than the overlay itself (which sits in the transformed
      // ViewportPortal). Works for pen + touch.
      if (areaSelRef.current && !areaMoveRef.current && e.button === 0 && e.target instanceof Element) {
        let p = null; try { p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }); } catch { /* */ }
        const s = areaSelRef.current;
        // Hit-test the selection box directly (not the DOM overlay — this runs in
        // capture phase before it), shifted by the live move offset. A press
        // INSIDE the box moves the selection.
        const r = s.box || s.rect;
        const inBox = p && r && p.x >= r.x + s.dx && p.x <= r.x + r.w + s.dx && p.y >= r.y + s.dy && p.y <= r.y + r.h + s.dy;
        if (inBox) {
          areaMoveRef.current = { pid: e.pointerId, sx: p.x, sy: p.y, baseDx: s.dx, baseDy: s.dy };
          try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* */ }
          e.preventDefault();
          return;
        }
        if (e.target.closest(".react-flow__panel")) return; // toolbar handles its own
        // Press OFF the selection: drop the old one where it is, and — on the
        // empty pane — arm a fresh marquee so a drag immediately starts a NEW
        // selection instead of only clearing the previous one.
        commitAreaRef.current?.();
        if (mode === "select" && !WB_TOUCH && e.target.closest(".react-flow__pane") &&
            !e.target.closest(".react-flow__node") && !e.target.closest(".react-flow__edge") && !e.target.closest(".react-flow__handle")) {
          areaDragRef.current = { pid: e.pointerId, x0: e.clientX, y0: e.clientY, armed: false };
        }
        return;
      }
      // Lasso tool: draw a freeform selection path.
      if (mode === "lasso") {
        if (e.button !== 0) return;
        const at = e.target;
        if (!(at instanceof Element) || !at.closest(".react-flow") || at.closest(".react-flow__panel")) return;
        lassoRef.current = { pid: e.pointerId, pts: [[e.clientX, e.clientY]] };
        setLassoPath(screenPolyPath(lassoRef.current.pts));
        try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* */ }
        e.preventDefault();
        return;
      }
      // Select tool on DESKTOP: dragging the empty pane draws our region box. It
      // marks the nodes it covers `selected` live (see onWbPointerMove) + lifts
      // brush paint on release. Only start on the EMPTY pane; node/edge/handle
      // presses fall through to RF (select + drag). Touch uses the long-press
      // marquee (marqueePointerDown, handled separately).
      if (mode === "select" && !WB_TOUCH) {
        if (areaSelRef.current || e.button !== 0) return;
        const at = e.target;
        if (
          !(at instanceof Element) ||
          !at.closest(".react-flow__pane") ||
          at.closest(".react-flow__node") ||
          at.closest(".react-flow__edge") ||
          at.closest(".react-flow__handle")
        ) return;
        // ARM a potential region-drag but don't capture / preventDefault yet — a
        // plain click on the empty pane must fall through to RF so it clears the
        // selection (deselect). The box opens once the pointer moves past a small
        // threshold (see onWbPointerMove).
        // Shift → ADD to the current selection: snapshot what's already selected
        // so the marquee unions onto it (nodes + edges) instead of replacing.
        const additive = e.shiftKey;
        areaDragRef.current = {
          pid: e.pointerId, x0: e.clientX, y0: e.clientY, armed: false,
          base: additive ? new Set(rf.getNodes().filter((n) => n.selected).map((n) => n.id)) : null,
          baseEdges: additive ? new Set(rf.getEdges().filter((ed) => ed.selected).map((ed) => ed.id)) : null,
        };
        marqueeHiliteRef.current = ""; // fresh drag → recompute the live highlight
        return;
      }
      if ((mode !== "pen" && mode !== "laser" && mode !== "brush") || e.button !== 0) return;
      const t = e.target;
      if (!(t instanceof Element) || !t.closest(".react-flow") || t.closest(".react-flow__panel")) return;
      // Palm rejection, grace-window (NOT sticky): a finger/palm touch is
      // ignored only while the Pencil is actively in use (a pen stroke is live,
      // or a pen event landed within PEN_GRACE_MS). When the Pencil is away,
      // fingers draw normally. A Pencil landing mid finger-stroke takes over
      // (below), covering the palm-touched-first case.
      if (ptype === "touch" && penActive()) return;
      // In laser / brush mode, ⌘/Ctrl+drag pans (handled by ReactFlow), so the
      // left-drag stays free for the laser ink / brush — don't capture it.
      if ((mode === "laser" || mode === "brush") && (e.ctrlKey || e.metaKey)) return;
      if (strokePidRef.current != null) {
        if (ptype === "pen" && strokeTypeRef.current !== "pen") {
          // Pencil landed while a finger/palm stroke was going (palm touched
          // first) — the Pencil wins: drop that stroke and start a pen one.
          cancelActiveStroke();
        } else if (ptype === strokeTypeRef.current) {
          cancelActiveStroke(); // same-class second pointer = pinch → navigate
          return;
        } else {
          return; // touch during a pen stroke = resting palm → ignore, keep drawing
        }
      }
      let p;
      try { p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }); } catch { return; }
      if (mode === "pen") {
        drawingRef.current = { points: [[p.x, p.y, pointerForce(e)]] };
        penMoveRef.current = { pos: [p.x, p.y], ts: Date.now() };
        clearShapePreview();
        setDrawPath(previewPath(drawingRef.current.points));
      } else if (mode === "laser") {
        laserDrawingRef.current = true;
        setLaserPressing(true);
        laserInkRef.current = [{ x: p.x, y: p.y, t: Date.now() }];
        pushCursor(p.x, p.y, true, true, laserColorRef.current);
      } else {
        // brush: open a paint stroke, rasterise the first dab, start streaming.
        const bs = brushStyleRef.current;
        const brush = {
          color: bs.erase ? "#000000" : bs.color,
          size: activeBrushSize(bs),
          opacity: bs.erase ? 1 : bs.opacity,
          mode: bs.erase ? "eraser" : "brush",
          texture: bs.erase ? "smooth" : bs.texture,
        };
        const id = freshId("pt");
        paintStrokeIdRef.current = id;
        paintBrushRef.current = brush;
        paintBatchRef.current = [[p.x, p.y]];
        paintLastFlushRef.current = Date.now();
        // Snapshot the tiles under the first dab BEFORE painting them (undo).
        paintUndoRef.current = { size: brush.size, prev: [p.x, p.y], before: new Map() };
        paintRef.current?.snapshot(segmentTileKeys(p.x, p.y, p.x, p.y, brush.size), paintUndoRef.current.before);
        paintRef.current?.apply({ id, brush, pts: [[p.x, p.y]] }, true);
      }
      strokePidRef.current = e.pointerId;
      strokeTypeRef.current = ptype;
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* */ }
      e.preventDefault();
    },
    [rf, pushCursor, cancelActiveStroke, penActive, previewPath, classifyPointer, pointerForce, clearShapePreview]
  );

  // Pen up: commit the stroke as a draw node (bbox-relative points). Tiny taps
  // are dropped. The node carries pointerEvents:none so it's click-through
  // except along the line (see DrawNode).
  // Snap a recognized stroke to a clean shape / edge / straight line. Returns
  // true when it consumed the stroke (so finishStroke skips the freehand node).
  const snapRecognized = useCallback((shape) => {
    if (shape.kind === "line") {
      // Line whose ends land on two connectable shapes → an edge; otherwise a
      // cleaned straight stroke.
      const M = 12;
      const hit = (pt) => rf.getNodes().find((n) => {
        if (NON_CONNECTABLE.has(n.type)) return false;
        const r = nodeRect(rf.getInternalNode(n.id) || n); // absolute rect (framed shapes)
        return r && pt.x >= r.x - M && pt.x <= r.x + r.w + M && pt.y >= r.y - M && pt.y <= r.y + r.h + M;
      });
      const a = hit(shape.from), b = hit(shape.to);
      if (a && b && a.id !== b.id) {
        const sa = snappedAnchor(nodeRect(a), shape.from.x, shape.from.y);
        const ta = snappedAnchor(nodeRect(b), shape.to.x, shape.to.y);
        setEdges((eds) => addEdge({
          source: a.id, sourceHandle: ANCHOR_TO_HANDLE[sa.side],
          target: b.id, targetHandle: ANCHOR_TO_HANDLE[ta.side],
          data: { sourceAnchor: sa, targetAnchor: ta },
          ...DEFAULT_EDGE_OPTIONS,
        }, eds));
        navigator.vibrate?.(12);
        return true;
      }
      const { color, width, opacity = 1 } = penStyleRef.current;
      const pad = Math.max(width, 4);
      const minX = Math.min(shape.from.x, shape.to.x) - pad, minY = Math.min(shape.from.y, shape.to.y) - pad;
      const maxX = Math.max(shape.from.x, shape.to.x) + pad, maxY = Math.max(shape.from.y, shape.to.y) + pad;
      const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
      const rel = [[shape.from.x - minX, shape.from.y - minY, 0.5], [shape.to.x - minX, shape.to.y - minY, 0.5]];
      const node = { id: freshId("draw"), type: "draw", position: { x: minX, y: minY }, width: w, height: h, style: { pointerEvents: "none" }, data: { points: rel, color, strokeWidth: width, w, h, opacity, pressure: false } };
      setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat(node));
      navigator.vibrate?.(12);
      return true;
    }
    // Closed shape → a clean shape node at the recognised bbox, in the pen colour.
    const nodeShape = SHAPE_KIND_TO_NODE[shape.kind];
    if (!nodeShape) return false;
    const { color } = penStyleRef.current;
    const r = shape.rect;
    const node = {
      id: freshId("shape"),
      type: "shape",
      position: { x: r.x, y: r.y },
      width: Math.max(20, r.w),
      height: Math.max(20, r.h),
      selected: true,
      data: { shape: nodeShape, text: "", stroke: color },
    };
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat(node));
    navigator.vibrate?.(12);
    return true;
  }, [rf, setNodes, setEdges]);

  const finishStroke = useCallback(() => {
    const dr = drawingRef.current;
    drawingRef.current = null;
    if (drawRafRef.current) { cancelAnimationFrame(drawRafRef.current); drawRafRef.current = 0; }
    setDrawPath(null);
    if (!dr || dr.points.length < 2) return;
    const pts = dr.points;
    // Auto-shape: if the hold-preview armed (the ghost you saw while holding),
    // lifting snaps to exactly that. No preview → keep the freehand stroke.
    const armed = shapePreviewRef.current;
    clearShapePreview();
    if (armed && snapRecognized(armed)) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    const { color, width, opacity = 1, pressure = true } = penStyleRef.current;
    // A pressure stroke's nib grows to ~width*PEN_NIB_SCALE, so pad the bbox by
    // that half-width to avoid clipping the fattest part of the outline.
    const pad = Math.max(pressure ? (width * PEN_NIB_SCALE) / 2 : width, 4);
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    if (w < 4 && h < 4) return; // discard a stray dot
    // Preserve the pressure (3rd slot) so the committed node renders identically.
    const rel = pts.map(([x, y, pr]) => [Math.round((x - minX) * 10) / 10, Math.round((y - minY) * 10) / 10, pr ?? 0.5]);
    const node = {
      id: freshId("draw"),
      type: "draw",
      position: { x: minX, y: minY },
      width: w,
      height: h,
      style: { pointerEvents: "none" },
      data: { points: rel, color, strokeWidth: width, w, h, opacity, pressure },
    };
    // Don't auto-select — keep the pen flowing for the next stroke.
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat(node));
  }, [setNodes, snapRecognized, clearShapePreview]);

  const onWbPointerUp = useCallback(
    (e) => {
      // Floating-selection move finished.
      if (areaMoveRef.current && e.pointerId === areaMoveRef.current.pid) {
        areaMoveRef.current = null;
        try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* */ }
        return;
      }
      // Lasso path finished → select inside the polygon + lift clipped paint.
      if (lassoRef.current && e.pointerId === lassoRef.current.pid) {
        const l = lassoRef.current;
        lassoRef.current = null;
        setLassoPath(null);
        try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* */ }
        finalizeLassoRef.current?.(l.pts);
        return;
      }
      // Region-select box finished → lift the enclosed strokes + paint.
      if (areaDragRef.current && e.pointerId === areaDragRef.current.pid) {
        const d = areaDragRef.current;
        areaDragRef.current = null;
        // Never armed = a plain click, not a drag: do nothing so RF's pane click
        // clears the selection (deselect). We never captured/preventDefault'd it.
        if (!d.armed) return;
        setAreaBox(null);
        try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* */ }
        // via ref — finalizeAreaSelection is defined later in the component; a
        // direct dep here would be a render-time TDZ (blank screen).
        finalizeAreaRef.current?.(d.x0, d.y0, e.clientX, e.clientY, d.base, d.baseEdges);
        return;
      }
      // Only the stroke-owning pointer ends it.
      if (strokePidRef.current != null && e.pointerId !== strokePidRef.current) return;
      strokePidRef.current = null;
      strokeTypeRef.current = null;
      if (laserDrawingRef.current) {
        laserDrawingRef.current = false;
        setLaserPressing(false);
        try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* */ }
        // Released: drop the laser flag so my dot + peers' hide; the ink trail
        // fades out on its own.
        const lp = lastPtRef.current;
        if (lp) pushCursor(lp.x, lp.y, false, false, laserColorRef.current);
        return;
      }
      if (paintStrokeIdRef.current) {
        const id = paintStrokeIdRef.current;
        try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* */ }
        // Flush the tail + tell peers the stroke ended; close it locally too.
        pushPaint({ id, brush: paintBrushRef.current, pts: paintBatchRef.current, end: true });
        paintBatchRef.current = [];
        paintRef.current?.apply({ id, brush: paintBrushRef.current, pts: [], end: true }, true);
        paintStrokeIdRef.current = null;
        // Commit the raster undo step now that the tiles hold the finished
        // stroke: before = the snapshot we took, after = the current pixels.
        const u = paintUndoRef.current;
        paintUndoRef.current = null;
        if (u && u.before.size) {
          const before = u.before;
          const after = paintRef.current?.snapshot(before.keys(), new Map());
          if (after) pushExternalStep({
            undo: () => paintRef.current?.restore(before),
            redo: () => paintRef.current?.restore(after),
          });
        }
        return;
      }
      if (!drawingRef.current) return;
      try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* */ }
      finishStroke();
    },
    [finishStroke, pushCursor, pushPaint, pushExternalStep]
  );

  // On a tool switch, push one cursor update reflecting the new mode so peers
  // flip my arrow ↔ laser immediately (even if I've stopped moving).
  useEffect(() => {
    const p = lastPtRef.current;
    // Switching tools never shows a laser dot now — it only appears on press.
    if (p) pushCursor(p.x, p.y, false, false, laserColorRef.current);
  }, [tool, pushCursor]);

  // Keyboard shortcuts are wired below, after copy/cut/clone refs exist
  // (useWhiteboardKeyboard) — a global keydown listener, so call position is
  // behavior-neutral.

  // ── board persistence: load/seed + debounced save + flush + font-load ──
  useWhiteboardPersistence({
    boardId, embedded, rf,
    nodes, edges, setNodes, setEdges,
    board, setBoard, loading, setLoading, setError, setSaveState,
    setTitleDraft, setGoalDraft, readOnly,
  });

  // ── handlers ──
  // Connection completion is handled entirely in onConnectEnd (so we can
  // attach to ANY point on a node, not just its 4 handles). onConnect is a
  // no-op to avoid a second, handle-snapped edge being created.
  const onConnect = useCallback(() => {}, []);

  const onConnectStart = useCallback((evt, params) => {
    const e = evt && "touches" in evt ? evt.touches[0] : evt;
    // Remember where the pull began so onConnectEnd can tell a click
    // (auto-place a sibling) from a drag (drop where released).
    connectingRef.current = { ...params, sx: e?.clientX, sy: e?.clientY, shape: null };
    setConnecting(true);
    setPickedShape(null);
    // While dragging out a connector, press 1–9 / 0 to choose the NEW node's
    // shape (in the toolbar catalogue's order: 1 Process, 3 Decision, …). The
    // last number pressed wins — it updates the live ghost and is applied on
    // release. A legend appears during the drag so the mapping is visible.
    const onKey = (ke) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (!connectingRef.current || !/^[0-9]$/.test(ke.key)) return;
      const idx = ke.key === "0" ? 9 : Number(ke.key) - 1;
      const s = SHAPES[idx];
      if (s) { connectingRef.current.shape = s.key; setPickedShape(s.key); ke.preventDefault(); }
    };
    connectKeyRef.current = onKey;
    window.addEventListener("keydown", onKey);
  }, []);

  // Pull a connector from a node and either DRAG onto empty canvas (the new
  // node spawns where you drop) or just CLICK the handle (it auto-places a
  // sibling beside the parent — FigJam quick-add). Either way the new node
  // is "similar to the parent": same type/shape/size/fill, so flows stay
  // visually consistent. Placement uses the SAME helper as the live preview
  // so the ghost always matches the result.
  //
  // We use connectionState.fromNode rather than gating on handleType:
  // each side carries overlapping source+target handles (target on top,
  // for drop-to-connect), so a pull can start on either — what matters
  // is only WHICH node it came from.
  const onConnectEnd = useCallback(
    (event, connectionState) => {
      const started = connectingRef.current;
      connectingRef.current = null;
      if (connectKeyRef.current) {
        window.removeEventListener("keydown", connectKeyRef.current);
        connectKeyRef.current = null;
      }
      setConnecting(false);
      setPickedShape(null);
      const srcNode = connectionState?.fromNode;
      const fromNodeId = srcNode?.id ?? started?.nodeId;
      if (!fromNodeId) return;
      const fromHandle = connectionState?.fromHandle;
      const sourceHandle =
        SIDE_FROM_ID[fromHandle?.id] ??
        SIDE_FROM_ID[started?.handleId] ??
        SIDE_FROM_POS[fromHandle?.position] ??
        "r";
      const ev = "changedTouches" in event ? event.changedTouches[0] : event;
      if (ev?.clientX == null) return;
      let pos;
      try {
        pos = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
      } catch {
        return;
      }

      // What node did we release over? (skip containers; small margin so a
      // drop right on the border still counts.) Use the INTERNAL node for the
      // absolute rect — a getNodes() node inside a frame carries a position
      // RELATIVE to its frame, so nodeRect(n) would place it wrong and the drop
      // would never land on a framed shape.
      const M2 = 8;
      const absRect = (n) => nodeRect(rf.getInternalNode(n.id) || n);
      const overNode = rf.getNodes().find((n) => {
        if (NON_CONNECTABLE.has(n.type)) return false;
        const r = absRect(n);
        return (
          r &&
          pos.x >= r.x - M2 &&
          pos.x <= r.x + r.w + M2 &&
          pos.y >= r.y - M2 &&
          pos.y <= r.y + r.h + M2
        );
      });

      // Released over ANOTHER node → connect to it. Both ends are YOUR choice:
      // the source leaves from the side you pulled from, and the target attaches
      // at the perimeter point you dropped on (snapped to the nearest tidy spot,
      // matching the options shown during the drag).
      if (overNode && overNode.id !== fromNodeId) {
        const sSide = SIDE_POS[sourceHandle] || "right"; // the side you pulled from
        const sourceAnchor = { side: sSide, t: 0.5, auto: true };
        const targetAnchor = snappedAnchor(absRect(overNode), pos.x, pos.y);
        setEdges((eds) =>
          addEdge(
            {
              source: fromNodeId,
              sourceHandle,
              target: overNode.id,
              targetHandle: ANCHOR_TO_HANDLE[targetAnchor.side],
              data: { sourceAnchor, targetAnchor },
              ...DEFAULT_EDGE_OPTIONS,
            },
            eds
          )
        );
        return;
      }

      // New node mirrors the parent (fall back to a default process box).
      const isShapeParent = ["shape", "rect", "ellipse", "diamond"].includes(
        srcNode?.type
      );
      const size = {
        w: srcNode?.measured?.width ?? srcNode?.width ?? DEFAULTS.shape.w,
        h: srcNode?.measured?.height ?? srcNode?.height ?? DEFAULTS.shape.h,
      };
      const newData = {
        text: "",
        // A number pressed mid-drag wins, then a hover pre-pick, then the parent.
        shape: started?.shape || pickedShape || (isShapeParent && srcNode?.data?.shape) || "process",
        ...(srcNode?.data?.fill ? { fill: srcNode.data.fill } : {}),
        ...(srcNode?.data?.stroke ? { stroke: srcNode.data.stroke } : {}),
        ...(srcNode?.data?.fontSize ? { fontSize: srcNode.data.fontSize } : {}),
      };

      // Quick-add vs drag-to-place. A "click" isn't decided by movement
      // distance (unreliable for a tap on a handle) but by whether you
      // RELEASED on/near the parent rather than dragging away. That makes
      // quick-add fire reliably on every side — including straight under the
      // node, which the distance check used to miss.
      const hasGeom = srcNode?.position != null;
      const sx0 = srcNode?.position?.x ?? 0;
      const sy0 = srcNode?.position?.y ?? 0;
      const M = 30; // generous — a click on the OUTSIDE arrow still counts as quick-add
      const nearParent =
        hasGeom &&
        pos.x >= sx0 - M &&
        pos.x <= sx0 + size.w + M &&
        pos.y >= sy0 - M &&
        pos.y <= sy0 + size.h + M;
      let place;
      if (hasGeom && nearParent) {
        place = siblingPlacement(
          { x: sx0, y: sy0, w: size.w, h: size.h },
          sourceHandle,
          size
        );
      } else if (hasGeom) {
        const center = { x: sx0 + size.w / 2, y: sy0 + size.h / 2 };
        place = connectedNodePlacement(center, pos.x, pos.y, size);
      } else {
        place = {
          x: pos.x - size.w / 2,
          y: pos.y - size.h / 2,
          side: sourceHandle ? OPPOSITE_TARGET[sourceHandle] : "l",
        };
      }

      // Snap the new node to the grid so it lines up with everything else.
      place = { ...place, x: snapToGrid(place.x), y: snapToGrid(place.y) };

      // Context-aware: if a node already sits where the new one would land, just
      // connect to IT instead of dropping a duplicate.
      const zonePad = 0.4;
      const zone = {
        x: place.x - size.w * zonePad, y: place.y - size.h * zonePad,
        w: size.w * (1 + 2 * zonePad), h: size.h * (1 + 2 * zonePad),
      };
      const nearby = rf.getNodes().find((n) => {
        if (n.id === fromNodeId || NON_CONNECTABLE.has(n.type)) return false;
        const r = nodeRect(rf.getInternalNode(n.id) || n); // absolute rect (framed shapes)
        return r && r.x < zone.x + zone.w && r.x + r.w > zone.x && r.y < zone.y + zone.h && r.y + r.h > zone.y;
      });
      if (nearby) {
        setEdges((eds) => {
          if (eds.some((e) =>
            (e.source === fromNodeId && e.target === nearby.id) ||
            (e.source === nearby.id && e.target === fromNodeId)
          )) return eds;
          return addEdge({
            source: fromNodeId, sourceHandle, target: nearby.id, targetHandle: place.side,
            data: { sourceAnchor: { side: SIDE_POS[sourceHandle] || "right", t: 0.5, auto: true } },
            ...DEFAULT_EDGE_OPTIONS,
          }, eds);
        });
        return;
      }

      const newId = freshId("shape");
      markNodeForEdit(newId); // open the new node straight into text edit
      // Auto-select the new node (and deselect the rest) so its inspector
      // pops immediately — pull, drop, restyle.
      setNodes((nds) =>
        nds
          .map((n) => (n.selected ? { ...n, selected: false } : n))
          .concat({
            id: newId,
            type: "shape",
            position: { x: place.x, y: place.y },
            width: size.w,
            height: size.h,
            data: newData,
            selected: true,
          })
      );
      setEdges((eds) =>
        addEdge(
          {
            source: fromNodeId,
            sourceHandle,
            target: newId,
            targetHandle: place.side,
            // Lock the SOURCE to the side you pulled from; the new node's end
            // floats and just faces it (complementSide), so the edge leaves
            // where you pulled and the far end receives it on its near side.
            data: {
              sourceAnchor: { side: SIDE_POS[sourceHandle] || "right", t: 0.5, auto: true },
            },
            ...DEFAULT_EDGE_OPTIONS,
          },
          eds
        )
      );
    },
    [rf, setNodes, setEdges, pickedShape]
  );

  // Click an arrow → quick-add a connected shape on that side (drag is handled
  // by React Flow's connection → onConnectEnd; connectOnClick is off so a click
  // doesn't enter click-to-connect mode). Same picked-shape + context-aware
  // (connect-to-existing) rules as the drag path.
  const quickAddConnected = useCallback((fromNodeId, sourceHandle) => {
    const srcNode = rf.getNodes().find((n) => n.id === fromNodeId);
    if (!srcNode) return;
    const isShapeParent = ["shape", "rect", "ellipse", "diamond"].includes(srcNode.type);
    const size = {
      w: srcNode.measured?.width ?? srcNode.width ?? DEFAULTS.shape.w,
      h: srcNode.measured?.height ?? srcNode.height ?? DEFAULTS.shape.h,
    };
    const newData = {
      text: "",
      shape: pickedShape || (isShapeParent && srcNode.data?.shape) || "process",
      ...(srcNode.data?.fill ? { fill: srcNode.data.fill } : {}),
      ...(srcNode.data?.stroke ? { stroke: srcNode.data.stroke } : {}),
      ...(srcNode.data?.fontSize ? { fontSize: srcNode.data.fontSize } : {}),
    };
    const sx0 = srcNode.position?.x ?? 0;
    const sy0 = srcNode.position?.y ?? 0;
    let place = siblingPlacement({ x: sx0, y: sy0, w: size.w, h: size.h }, sourceHandle, size);
    place = { ...place, x: snapToGrid(place.x), y: snapToGrid(place.y) };
    const sourceAnchor = { side: SIDE_POS[sourceHandle] || "right", t: 0.5, auto: true };

    // If a node already sits where the new one would land, connect to it.
    const pad = 0.5;
    const zone = {
      x: place.x - size.w * pad, y: place.y - size.h * pad,
      w: size.w * (1 + 2 * pad), h: size.h * (1 + 2 * pad),
    };
    const existing = rf.getNodes().find((n) => {
      if (n.id === fromNodeId || NON_CONNECTABLE.has(n.type)) return false;
      const r = nodeRect(rf.getInternalNode(n.id) || n); // absolute rect (framed shapes)
      return r && r.x < zone.x + zone.w && r.x + r.w > zone.x && r.y < zone.y + zone.h && r.y + r.h > zone.y;
    });
    if (existing) {
      setEdges((eds) => {
        if (eds.some((e) =>
          (e.source === fromNodeId && e.target === existing.id) ||
          (e.source === existing.id && e.target === fromNodeId)
        )) return eds;
        return addEdge({
          source: fromNodeId, sourceHandle, target: existing.id, targetHandle: place.side,
          data: { sourceAnchor }, ...DEFAULT_EDGE_OPTIONS,
        }, eds);
      });
      setPickedShape(null);
      return;
    }

    const newId = freshId("shape");
    markNodeForEdit(newId);
    setNodes((nds) =>
      nds
        .map((n) => (n.selected ? { ...n, selected: false } : n))
        .concat({
          id: newId, type: "shape",
          position: { x: place.x, y: place.y },
          width: size.w, height: size.h, data: newData, selected: true,
        })
    );
    setEdges((eds) =>
      addEdge({
        source: fromNodeId, sourceHandle, target: newId, targetHandle: place.side,
        data: { sourceAnchor }, ...DEFAULT_EDGE_OPTIONS,
      }, eds)
    );
    setPickedShape(null);
  }, [rf, setNodes, setEdges, pickedShape]);

  // Hover a shape's quick-connect arrow → 1–9/0 pre-picks the shape a click will
  // create (and lights it in the legend). Mirrors the during-drag number-select.
  const [hoveringArrow, setHoveringArrow] = useState(false);
  const onArrowHover = useCallback((v) => {
    setHoveringArrow(v);
    if (!v) setPickedShape(null); // leaving clears the pending pick
  }, []);
  useEffect(() => {
    if (!hoveringArrow) return undefined;
    const onKey = (ke) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (!/^[0-9]$/.test(ke.key)) return;
      const idx = ke.key === "0" ? 9 : Number(ke.key) - 1;
      const s = SHAPES[idx];
      if (s) { setPickedShape(s.key); ke.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hoveringArrow]);
  const quickConnectApi = useMemo(
    () => ({ connect: quickAddConnected, onHover: onArrowHover, pickedShape }),
    [quickAddConnected, onArrowHover, pickedShape]
  );

  // A key arms a node to "stamp" (a ghost follows the cursor; a click places it):
  // 1–9/0 → shapes, N sticky, G goal, F frame, I image (opens the picker, then
  // drops at the cursor). Skipped while hovering a connect arrow — there the
  // numbers pick the shape the arrow will create. Same guards as the board keys.
  useEffect(() => {
    const onKey = (ke) => {
      if (hoveringArrow) return;
      if (ke.metaKey || ke.ctrlKey || ke.altKey || ke.shiftKey) return; // Shift+1 = fit view, not a stamp
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const board = mainRef.current;
      if (!board || !(board.matches(":hover") || board.contains(el))) return;
      let armed = null;
      if (/^[0-9]$/.test(ke.key)) {
        const s = SHAPES[ke.key === "0" ? 9 : Number(ke.key) - 1];
        if (s) armed = { type: "shape", extra: { shape: s.key } };
      } else {
        switch (ke.key.toLowerCase()) {
          case "n": armed = { type: "sticky", extra: { color: preferredStickyColor() } }; break;
          case "g": armed = { type: "goal", extra: {} }; break;
          case "f": armed = { type: "frame", extra: {} }; break;
          case "i": {
            // Image needs a file first — remember where the cursor is, then open
            // the picker; the input's onChange drops it there.
            ke.preventDefault();
            const c = lastClientRef.current;
            try { pendingImageAtRef.current = c ? rf.screenToFlowPosition({ x: c.x, y: c.y }) : null; } catch { pendingImageAtRef.current = null; }
            fileInputRef.current?.click();
            return;
          }
          default: return;
        }
      }
      if (!armed) return;
      ke.preventDefault();
      setTool("select");
      setPlacing(armed);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hoveringArrow]);

  // While a node is armed: the ghost tracks the cursor (rAF-throttled) and Esc
  // cancels. The actual placement happens on pointer-down (see the capture
  // handler on the editor div).
  useEffect(() => {
    if (!placing) { setGhostFlow(null); return undefined; }
    const size = DEFAULTS[placing.type] || DEFAULTS.shape;
    let raf = 0;
    const place = (cx, cy) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try {
          const f = rf.screenToFlowPosition({ x: cx, y: cy });
          setGhostFlow({ x: f.x - size.w / 2, y: f.y - size.h / 2 });
        } catch { /* */ }
      });
    };
    const onMove = (e) => { lastClientRef.current = { x: e.clientX, y: e.clientY }; place(e.clientX, e.clientY); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); setPlacing(null); } };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", onKey);
    const seed = lastClientRef.current;
    if (seed) place(seed.x, seed.y);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [placing, rf]);

  // Esc stops following someone (before the board's other Esc handlers run).
  useEffect(() => {
    if (!followingId) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setFollowingId(null); };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [followingId]);

  // "?" toggles the keyboard-shortcuts cheatsheet. Not board-hover-gated (so it
  // also closes while the overlay covers the board); skipped while typing.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "?") return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      setShortcutsOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drag an edge endpoint onto a different node to re-route it.
  const onReconnect = useCallback(
    (oldEdge, newConnection) => {
      setEdges((eds) => reconnectEdge(oldEdge, newConnection, eds));
    },
    [setEdges]
  );

  // Snap-aware node changes. Grid snapping is done here PER NODE (not via the
  // global snapToGrid prop) so it can be skipped for sticky notes and any node
  // with snapping toggled off. Alignment guides run for a single dragged
  // content node. We snap the drag-END change too (dragging:false) so the
  // position holds on release instead of settling back to React Flow's raw spot.
  const onNodesChangeSnap = useCallback(
    (changes) => {
      const all = rf.getNodes();
      const byId = new Map(all.map((n) => [n.id, n]));
      // A resize emits `dimensions` changes flagged with `resizing` (true while
      // dragging a handle, false on release) — distinct from the unflagged
      // `dimensions` changes React Flow fires when it MEASURES a node, which we
      // must NOT snap (that would fight auto-sized nodes). Track the ids being
      // resized so we also snap the position a top/left handle moves.
      const isResize = (c) =>
        c.type === "dimensions" && c.dimensions && c.resizing != null;
      const resizingIds = new Set(changes.filter(isResize).map((c) => c.id));
      // Grid-snap dragged AND resized nodes that participate in snapping.
      for (const c of changes) {
        if (isResize(c)) {
          const n = byId.get(c.id);
          if (n && nodeSnaps(n))
            c.dimensions = {
              width: snapToGrid(c.dimensions.width),
              height: snapToGrid(c.dimensions.height),
            };
        } else if (
          c.type === "position" &&
          c.position &&
          (c.dragging != null || resizingIds.has(c.id))
        ) {
          const n = byId.get(c.id);
          if (n && nodeSnaps(n))
            c.position = {
              x: snapToGrid(c.position.x),
              y: snapToGrid(c.position.y),
            };
        }
      }
      // Alignment guides for a single dragged content node (not frame/zone).
      const drags = changes.filter(
        (c) => c.type === "position" && c.position && c.dragging != null
      );
      if (drags.length === 1) {
        const node = byId.get(drags[0].id);
        const w = node?.measured?.width ?? node?.width ?? 0;
        const h = node?.measured?.height ?? node?.height ?? 0;
        if (
          node &&
          node.type !== "frame" &&
          node.type !== "zone" &&
          nodeSnaps(node) &&
          w &&
          h
        ) {
          const parentAbs = node.parentId
            ? nodeAbsPos(byId.get(node.parentId), byId)
            : { x: 0, y: 0 };
          const dragRect = {
            x: parentAbs.x + drags[0].position.x,
            y: parentAbs.y + drags[0].position.y,
            w,
            h,
          };
          const others = [];
          for (const n of all) {
            if (n.id === node.id || n.id === node.parentId || n.type === "zone")
              continue;
            const r = nodeRect(n);
            if (r) others.push(r);
          }
          const g = getAlignmentGuides(
            dragRect,
            others,
            alignDistance(rf.getViewport().zoom)
          );
          if (g.x != null)
            drags[0].position = { ...drags[0].position, x: g.x - parentAbs.x };
          if (g.y != null)
            drags[0].position = { ...drags[0].position, y: g.y - parentAbs.y };
          // Guides only while live-dragging; on release just snap + clear.
          const live = drags[0].dragging === true;
          if (live && (g.vertical || g.horizontal)) {
            setHelperLines({ vertical: g.vertical, horizontal: g.horizontal });
            helperShownRef.current = true;
          } else if (helperShownRef.current) {
            setHelperLines(NO_LINES);
            helperShownRef.current = false;
          }
        } else if (helperShownRef.current) {
          setHelperLines(NO_LINES);
          helperShownRef.current = false;
        }
      } else if (helperShownRef.current) {
        setHelperLines(NO_LINES);
        helperShownRef.current = false;
      }

      // Resize alignment: snap the moving edge(s) of a single resized, top-level
      // node to other nodes' edges/centres + matching width/height, drawing the
      // same guides as drag. Runs AFTER the drag block so it owns the guide lines
      // during a resize. Aspect-locked (image), no-snap (sticky), frame and zone
      // nodes are skipped.
      const resizeChange = resizingIds.size === 1 ? changes.find(isResize) : null;
      const rzNode = resizeChange ? byId.get(resizeChange.id) : null;
      if (
        rzNode &&
        !rzNode.parentId &&
        rzNode.type !== "zone" &&
        rzNode.type !== "frame" &&
        rzNode.type !== "image" &&
        nodeSnaps(rzNode)
      ) {
        const oldW = rzNode.measured?.width ?? rzNode.width ?? 0;
        const oldH = rzNode.measured?.height ?? rzNode.height ?? 0;
        const oldX = rzNode.position?.x ?? 0;
        const oldY = rzNode.position?.y ?? 0;
        const cp = changes.find((c) => c.type === "position" && c.id === resizeChange.id);
        const newW = resizeChange.dimensions.width;
        const newH = resizeChange.dimensions.height;
        const newX = cp?.position?.x ?? oldX;
        const newY = cp?.position?.y ?? oldY;
        // A left/top handle moves x/y; a right/bottom handle changes only size.
        const edges = {
          left: Math.abs(newX - oldX) > 0.01,
          top: Math.abs(newY - oldY) > 0.01,
        };
        edges.right = !edges.left && Math.abs(newW - oldW) > 0.01;
        edges.bottom = !edges.top && Math.abs(newH - oldH) > 0.01;
        const others = [];
        for (const n of all) {
          if (n.id === rzNode.id || n.type === "zone") continue;
          const r = nodeRect(n);
          if (r) others.push(r);
        }
        const g = getResizeGuides(
          { x: newX, y: newY, w: newW, h: newH },
          edges,
          others,
          alignDistance(rf.getViewport().zoom)
        );
        resizeChange.dimensions = { width: g.w, height: g.h };
        if (cp && (g.x !== newX || g.y !== newY)) cp.position = { x: g.x, y: g.y };
        const live = resizeChange.resizing === true;
        if (live && (g.vertical || g.horizontal)) {
          setHelperLines({ vertical: g.vertical, horizontal: g.horizontal });
          helperShownRef.current = true;
        } else if (helperShownRef.current) {
          setHelperLines(NO_LINES);
          helperShownRef.current = false;
        }
      }
      onNodesChange(changes);
    },
    [rf, onNodesChange]
  );

  // Frame containers: when a node is dropped inside a frame, adopt it as a
  // child (so it moves with the frame); when dragged out, release it.
  const onNodeDragStop = useCallback(
    (_evt, node) => {
      altCloningRef.current = false; // re-arm alt-drag clone for the next drag
      if (helperShownRef.current) {
        setHelperLines(NO_LINES);
        helperShownRef.current = false;
      }
      if (!node || node.type === "frame" || node.type === "zone") return;
      setNodes((nds) => {
        const byId = new Map(nds.map((n) => [n.id, n]));
        const cur = byId.get(node.id);
        if (!cur) return nds;
        const abs = nodeAbsPos(cur, byId);
        const center = {
          x: abs.x + (cur.width || 0) / 2,
          y: abs.y + (cur.height || 0) / 2,
        };
        const hit = frameAt(center, nds, byId, node.id);
        let changed = false;
        const next = nds.map((n) => {
          if (n.id !== node.id) return n;
          if (hit && n.parentId !== hit.frame.id) {
            changed = true;
            // Adopt into the frame WITHOUT extent:"parent" — it moves with the
            // frame but stays free to drag back out.
            return {
              ...n,
              parentId: hit.frame.id,
              extent: undefined,
              position: { x: abs.x - hit.fp.x, y: abs.y - hit.fp.y },
            };
          }
          if (!hit && n.parentId) {
            changed = true;
            return {
              ...n,
              parentId: undefined,
              extent: undefined,
              position: abs,
            };
          }
          return n;
        });
        return changed ? sortParentsFirst(next) : nds;
      });
    },
    [setNodes]
  );

  const addNodeAtCenter = useCallback(
    // `atClient` (optional {x,y} in screen coords) drops the node under the
    // cursor — used by drag-from-toolbar. Omitted → near the visible center.
    // `opts.edit === false` places it WITHOUT opening the inline editor (the
    // number/letter "stamp" flow — you're placing, not labelling yet).
    (type, extra = {}, atClient = null, opts = {}) => {
      const size = DEFAULTS[type] || { w: 180, h: 100 };
      // Drop the new node near the visible center so the user sees it
      // appear without having to pan (or at the drop point when dragged).
      let centerWorld = { x: 200, y: 200 };
      try {
        if (atClient) {
          centerWorld = rf.screenToFlowPosition({ x: atClient.x, y: atClient.y });
        } else {
          const vp = rf.getViewport();
          // screen-center → world coords using viewport math
          const el = document.querySelector(".react-flow");
          if (el) {
            const r = el.getBoundingClientRect();
            centerWorld = rf.screenToFlowPosition({
              x: r.left + r.width / 2,
              y: r.top + r.height / 2,
            });
          } else {
            centerWorld = { x: -vp.x / vp.zoom + 200, y: -vp.y / vp.zoom + 200 };
          }
        }
      } catch {
        /* */
      }
      const sized = [
        "shape",
        "goal",
        "frame",
        "rect",
        "ellipse",
        "diamond",
        "sticky",
      ].includes(type);
      const node = {
        id: freshId(type),
        type,
        position: {
          x: centerWorld.x - size.w / 2,
          y: centerWorld.y - size.h / 2,
        },
        data:
          type === "sticky"
            ? {
                text: "",
                color: extra.color || preferredStickyColor(),
                author: myName,
              }
            : { text: "", ...extra },
        ...(sized ? { width: size.w, height: size.h } : {}),
        ...(type === "frame" ? { zIndex: -1 } : {}),
      };
      if (opts.edit !== false) markNodeForEdit(node.id); // opens straight into edit unless stamped
      setNodes((nds) =>
        nds
          .map((n) => (n.selected ? { ...n, selected: false } : n))
          .concat({ ...node, selected: true })
      );
    },
    [rf, setNodes, myName]
  );

  // Place the armed "stamp" node at a screen point (no auto-edit), then disarm.
  // Stored in a ref so the pointer-down capture handler (defined earlier) can
  // call it without a forward reference.
  const placePendingNode = useCallback((client) => {
    const p = placingRef.current;
    if (!p) return false;
    addNodeAtCenter(p.type, p.extra, client, { edit: false });
    setPlacing(null);
    return true;
  }, [addNodeAtCenter]);
  placeNodeRef.current = placePendingNode;

  // Upload an image to Storage, then drop an image node (sized to the image's
  // aspect ratio, capped) at the visible center. The node holds only the URL,
  // so it syncs/saves like any other node and is undoable.
  const fileInputRef = useRef(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const addImageNode = useCallback(
    async (file, at) => {
      if (!file) return;
      const uid = session?.user?.id;
      if (!uid) { setError("Sign in to add images."); return; }
      setUploadingImage(true);
      const { data, error: err } = await uploadWhiteboardImage(file, uid, board?.id);
      setUploadingImage(false);
      if (err || !data) { setError(err?.message || "Couldn't upload image."); return; }
      // Initial display box: cap the longest edge, keep the image's ratio.
      const MAX_EDGE = 320;
      const nw = data.width || DEFAULTS.image.w, nh = data.height || DEFAULTS.image.h;
      const s = Math.min(1, MAX_EDGE / Math.max(nw, nh));
      const w = Math.max(48, Math.round(nw * s)), h = Math.max(48, Math.round(nh * s));
      // Drop/paste position if given, else the visible centre.
      let center = at;
      if (!center) {
        center = { x: 200, y: 200 };
        try {
          const el = document.querySelector(".react-flow");
          if (el) {
            const r = el.getBoundingClientRect();
            center = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }
        } catch { /* */ }
      }
      const node = {
        id: freshId("image"),
        type: "image",
        position: { x: center.x - w / 2, y: center.y - h / 2 },
        width: w,
        height: h,
        data: { src: data.url, path: data.path, alt: file.name || "" },
      };
      setNodes((nds) =>
        nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat({ ...node, selected: true })
      );
    },
    [session?.user?.id, board?.id, rf, setNodes]
  );

  // Drag an image file from Finder onto the canvas → upload + place at the drop.
  const onWbDragOver = useCallback((e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);
  const onWbDrop = useCallback(
    (e) => {
      const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      let at;
      try { at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }); } catch { /* */ }
      addImageNode(file, at);
    },
    [rf, addImageNode]
  );

  // Paste: an image in the clipboard becomes an image node; otherwise paste the
  // in-app node clipboard. Cmd/Ctrl+V lives here (not the keydown handler) since
  // only the paste event exposes clipboard contents.
  useEffect(() => {
    function onPaste(e) {
      if (readOnly) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const boardEl = mainRef.current;
      if (!boardEl || !(boardEl.matches(":hover") || boardEl.contains(el))) return;
      const items = e.clipboardData?.items;
      const imgItem = items && [...items].find((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (imgItem) {
        const file = imgItem.getAsFile();
        if (file) { e.preventDefault(); addImageNode(file, lastPtRef.current); return; }
      }
      e.preventDefault();
      pasteRef.current?.(lastPtRef.current);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addImageNode, readOnly]);

  // Double-click empty canvas → drop a text node at the cursor, ready to type.
  // Gated to the pane itself so double-clicking a node still just edits it.
  const onPaneDoubleClick = useCallback(
    (e) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.classList.contains("react-flow__pane")) return;
      let pos;
      try {
        pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      } catch {
        return;
      }
      const size = DEFAULTS.text;
      const id = freshId("text");
      markNodeForEdit(id); // open straight into edit
      setNodes((nds) =>
        nds
          .map((n) => (n.selected ? { ...n, selected: false } : n))
          .concat({
            id,
            type: "text",
            position: { x: pos.x - size.w / 2, y: pos.y - size.h / 2 },
            data: { text: "", ...textStyleRef.current },
            selected: true,
          })
      );
    },
    [rf, setNodes]
  );

  // Drop all selection (nodes + edges) without deleting anything — used by the
  // quick palette's centre "X" to bail back to a clean select state.
  const clearSelection = useCallback(() => {
    setNodes((nds) => (nds.some((n) => n.selected) ? nds.map((n) => (n.selected ? { ...n, selected: false } : n)) : nds));
    setEdges((eds) => (eds.some((e) => e.selected) ? eds.map((e) => (e.selected ? { ...e, selected: false } : e)) : eds));
  }, [setNodes, setEdges]);

  const deleteSelected = useCallback(() => {
    const selectedNodeIds = new Set(
      nodes.filter((n) => n.selected).map((n) => n.id)
    );
    const selectedEdgeIds = new Set(
      edges.filter((e) => e.selected).map((e) => e.id)
    );
    if (!selectedNodeIds.size && !selectedEdgeIds.size) return;
    setNodes((nds) =>
      nds.filter((n) => !selectedNodeIds.has(n.id) && n.type !== "zone")
    );
    setEdges((eds) =>
      eds.filter(
        (e) =>
          !selectedEdgeIds.has(e.id) &&
          !selectedNodeIds.has(e.source) &&
          !selectedNodeIds.has(e.target)
      )
    );
  }, [nodes, edges, setNodes, setEdges]);

  // Clear all drawings — pen strokes (draw nodes) + raster brush ink — leaving
  // notes, shapes, images, frames. Both halves are wiped in ONE undoable step
  // (runSilent keeps the node removal from becoming its own step; the external
  // step restores nodes + raster together).
  const clearAllDrawings = useCallback(() => {
    const removed = rf.getNodes().filter((n) => n.type === "draw");
    const keys = paintRef.current?.allTileKeys?.() || [];
    const before = paintRef.current?.snapshot(keys, new Map());
    if (!removed.length && !(before && before.size)) return; // nothing to clear
    if (!window.confirm("Clear all drawings on this board? Notes and shapes stay. You can undo this.")) return;
    const apply = () => runSilent(() => {
      setNodes((nds) => nds.filter((n) => n.type !== "draw"));
      paintRef.current?.clearAll();
      broadcastPaintOps([{ clearall: true }]); // peers wipe live
    });
    apply();
    pushExternalStep({
      undo: () => runSilent(() => {
        setNodes((nds) => nds.filter((n) => n.type !== "draw").concat(removed));
        if (before) paintRef.current?.restore(before); // local only — peers get raster back on reload
      }),
      redo: apply,
    });
  }, [rf, setNodes, pushExternalStep, runSilent, broadcastPaintOps]);

  // Clone nodes (pulling in any framed children + edges fully inside the
  // selection), offset a touch and left selected. Powers ⌘/Ctrl-click on a
  // node and ⌘/Ctrl-D on the selection. Offset is grid-aligned so clones stay
  // tidy.
  const cloneNodes = useCallback((ids, dx = 32, dy = 32) => {
    const { src, idMap } = collectCloneSources(rf.getNodes(), ids);
    if (!src.length) return;
    const clones = src.map((n) => {
      const childOfCloned = n.parentId && idMap.has(n.parentId);
      const next = { ...n, id: idMap.get(n.id), data: { ...n.data }, selected: true };
      if (childOfCloned) {
        next.parentId = idMap.get(n.parentId);          // re-parent to the cloned frame
        next.position = { ...n.position };               // relative to parent → keep
      } else {
        next.position = { x: n.position.x + dx, y: n.position.y + dy };
      }
      return next;
    });
    setNodes((nds) =>
      nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat(clones)
    );
    setEdges((eds) => duplicateInternalEdges(eds, idMap));
  }, [rf, setNodes, setEdges]);
  // Ref so the keydown handler (subscribed once) can call the latest clone fn.
  const cloneRef = useRef(null);
  cloneRef.current = cloneNodes;

  // Toggle MY dot-vote on a node (per-user map in data.votes). Syncs/persists
  // like any node edit; clears the key (and the whole map when empty) to keep
  // data lean. See VotesOverlay.
  const toggleVote = useCallback((nodeId) => {
    const myId = session?.user?.id;
    if (!myId) return;
    setNodes((nds) => nds.map((n) => {
      if (n.id !== nodeId) return n;
      const votes = { ...(n.data?.votes || {}) };
      if (votes[myId]) delete votes[myId]; else votes[myId] = 1;
      return { ...n, data: { ...n.data, votes: Object.keys(votes).length ? votes : undefined } };
    }));
  }, [session?.user?.id, setNodes]);

  // Node comments (data.comments — synced/persisted like any node data). One
  // thread open at a time, anchored to the node via NodeToolbar.
  const [openCommentId, setOpenCommentId] = useState(null);
  const addComment = useCallback((nodeId, text) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id !== nodeId) return n;
      const c = { id: freshId("c"), authorId: session?.user?.id, author: myName, text, ts: Date.now() };
      return { ...n, data: { ...n.data, comments: [...(n.data?.comments || []), c] } };
    }));
  }, [session?.user?.id, myName, setNodes]);
  const deleteComment = useCallback((nodeId, commentId) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id !== nodeId) return n;
      const comments = (n.data?.comments || []).filter((c) => c.id !== commentId);
      return { ...n, data: { ...n.data, comments: comments.length ? comments : undefined } };
    }));
  }, [setNodes]);
  // Auto-close the comment thread on click-away (anywhere but the thread or a
  // comment badge — the badge handles its own toggle/switch) and on Escape.
  useEffect(() => {
    if (!openCommentId) return undefined;
    const onDown = (e) => {
      const t = e.target;
      if (t instanceof Element && (t.closest(".wb-comment-thread") || t.closest(".wb-comment-badge"))) return;
      setOpenCommentId(null);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpenCommentId(null); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [openCommentId]);

  // Alt/Option-drag = clone: at drag start, drop a copy of the dragged node(s)
  // in place (unselected) and let the ORIGINALS keep dragging — so you pull a
  // clean duplicate out while the copy left behind KEEPS all the connections
  // (the original position looks untouched). Guarded so we clone once per drag.
  const altCloningRef = useRef(false);
  const onNodeDragStartClone = useCallback((event, node) => {
    const alt = event?.altKey ?? event?.sourceEvent?.altKey;
    if (!alt || altCloningRef.current) return;
    altCloningRef.current = true;
    const all = rf.getNodes();
    const ids = node.selected
      ? all.filter((n) => n.selected && n.type !== "zone").map((n) => n.id)
      : [node.id];
    const { src, idMap } = collectCloneSources(all, ids);
    if (!src.length) return;
    const clones = src.map((n) => {
      const next = { ...n, id: idMap.get(n.id), data: { ...n.data }, selected: false, dragging: false };
      if (n.parentId && idMap.has(n.parentId)) next.parentId = idMap.get(n.parentId);
      next.position = { ...n.position }; // SAME spot — the copy stays put
      return next;
    });
    setNodes((nds) => nds.concat(clones));
    setEdges((eds) => {
      // Internal edges (both ends cloned): give the stay-put clones their own
      // copy so the clone group keeps its wiring, and leave the originals' copy
      // intact so the dragged-out duplicate stays internally connected too.
      const copies = eds
        .filter((e) => idMap.has(e.source) && idMap.has(e.target))
        .map((e) => ({
          ...e, id: freshId("e"), selected: false,
          source: idMap.get(e.source), target: idMap.get(e.target),
          data: e.data ? { ...e.data } : e.data,
        }));
      // External edges (one end cloned): re-point that end onto the clone that
      // stays put, so the ORIGINAL spot keeps its connections and the copy you
      // drag away comes out clean. (This is the fix: edges no longer follow the
      // node you're dragging.)
      const rewired = eds.map((e) => {
        const s = idMap.has(e.source);
        const t = idMap.has(e.target);
        if (s === t) return e; // internal (both) or untouched (neither) — leave as-is
        return {
          ...e,
          source: s ? idMap.get(e.source) : e.source,
          target: t ? idMap.get(e.target) : e.target,
        };
      });
      return rewired.concat(copies);
    });
  }, [rf, setNodes, setEdges]);

  // ── copy / cut / paste (in-app clipboard; works across boards/tabs) ──
  const { copyRef, cutRef, pasteRef } = useWhiteboardClipboard({ rf, setNodes, setEdges, deleteSelected });

  // Keyboard shortcuts — placed here so copy/cut/clone refs already exist
  // (registers a global keydown listener; call position is behavior-neutral).
  // ⌘/Ctrl-click a node to drop a clone of it right next to it.
  const onNodeClick = useCallback((e, node) => {
    if ((e.metaKey || e.ctrlKey) && node.type !== "zone") {
      e.preventDefault();
      e.stopPropagation();
      cloneNodes([node.id]);
      return;
    }
    // Touch: guarantee one tap = selected. RF's own tap selection has been
    // flaky on mobile (took a second tap); force it from the click.
    if (WB_TOUCH && node.type !== "zone" && !node.selected) {
      setNodes((nds) => nds.map((n) => (n.id === node.id ? { ...n, selected: true } : n.selected ? { ...n, selected: false } : n)));
    }
  }, [cloneNodes, setNodes]);

  // ── selection inspector ──
  // Selection-derived state + node-mutating callbacks extracted verbatim into
  // useWhiteboardInspector; the <Inspector .../> JSX render stays below.
  const {
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
  } = useWhiteboardInspector({ nodes, edges, setNodes });

  // Keyboard shortcuts. Placed BELOW the inspector so its callbacks
  // (reorderSelected / bumpSelectedFontSize) are declared before this hook reads
  // them (see the TDZ-on-hook-extraction lesson). Effect-only, so position-safe.
  useWhiteboardKeyboard({
    rf, undo, redo, toolRef, setTool, setPalette,
    copyRef, cutRef, cloneRef,
    cancelAreaSelection, deleteAreaSelection, areaSelRef,
    reorderSelected, bumpSelectedFontSize,
    mainRef, lastClientRef, readOnly,
  });
  const bottomStackOffset = 15 + toolbarH + BOTTOM_PANEL_GAP;
  const brushStackH = tool === "brush" ? PAINT_TOOLBAR_STACK_H : 0;
  const touchInspectorBottom = bottomStackOffset + brushStackH;
  const touchInspectorStackH = touchInspectorVisible ? touchInspectorH + BOTTOM_PANEL_GAP : 0;
  const emoteBarOffset = toolbarH + 11 + brushStackH + touchInspectorStackH;
  useEffect(() => {
    if (!touchInspectorVisible) return;
    // Portaled inspector dropdowns read this to open just above the bar.
    document.documentElement.style.setProperty(
      "--wb-inspector-clear",
      `${touchInspectorBottom + touchInspectorH + 8}px`,
    );
  }, [touchInspectorVisible, touchInspectorBottom, touchInspectorH]);

  // Title / goal / archive — same flow as the prior page, just leaning
  // on the existing setters in lib/whiteboard.
  async function handleSaveTitle() {
    if (!board || readOnly) return;
    const next = titleDraft.trim() || "Untitled whiteboard";
    const { error: err } = await setWhiteboardTitle(board.id, next);
    if (err) {
      setError(err.message || "Couldn't save title.");
      return;
    }
    setBoard((b) => (b ? { ...b, title: next } : b));
    setTitleEditing(false);
  }
  async function handleSaveGoal() {
    if (!board || readOnly) return;
    const next = goalDraft.trim();
    const { error: err } = await setWhiteboardGoal(board.id, next);
    if (err) {
      setError(err.message || "Couldn't save goal.");
      return;
    }
    setBoard((b) => (b ? { ...b, goal: next } : b));
    setGoalEditing(false);
  }
  async function handleArchive() {
    if (!board) return;
    if (
      !window.confirm(
        "Archive this whiteboard? It'll disappear from the list — you can restore later."
      )
    )
      return;
    const { error: err } = await archiveWhiteboard(board.id);
    if (err) {
      setError(err.message || "Couldn't archive.");
      return;
    }
    navigate("/whiteboards");
  }

  // Render a flow-coordinate region to a PNG and download it. We capture React
  // Flow's viewport element with an overridden transform that frames `bounds` (so
  // the export covers that area, not just what's on screen). html-to-image clones
  // the node, so the live view isn't disturbed. Shared by the whole-board export
  // (bounds = all nodes) and the region-capture tool (bounds = the dragged box).
  const exportPng = useCallback(async (bounds, pad = 48) => {
    const el = mainRef.current?.querySelector(".react-flow__viewport");
    if (!el) return;
    if (!bounds || !bounds.width || !bounds.height) { setError("Nothing to export yet."); return; }
    // Up to 2x for crisp small regions; scale down big ones to cap ~4000px.
    const zoom = Math.min(2, 4000 / Math.max(bounds.width, bounds.height));
    const w = Math.ceil(bounds.width * zoom + pad * 2);
    const h = Math.ceil(bounds.height * zoom + pad * 2);
    try {
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(el, {
        backgroundColor: dark ? "#0f172a" : "#fbf6ee",
        width: w,
        height: h,
        pixelRatio: 1,
        cacheBust: true,
        style: {
          width: `${w}px`,
          height: `${h}px`,
          transform: `translate(${pad - bounds.x * zoom}px, ${pad - bounds.y * zoom}px) scale(${zoom})`,
        },
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `${(board?.title || "whiteboard").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "whiteboard"}.png`;
      a.click();
    } catch (e) {
      setError(`Export failed: ${e?.message || "unknown error"}`);
    }
  }, [dark, board?.title]);

  // Whole-board export: frame the bounding box of every node.
  const handleExportPng = useCallback(() => {
    exportPng(getNodesBounds(rf.getNodes()), 48);
  }, [exportPng, rf]);

  const template = useMemo(
    () => (board?.template_key ? TEMPLATES[board.template_key] : null),
    [board?.template_key]
  );

  // ── early returns ──
  const frameCls = embedded
    ? "w-full h-full p-4 space-y-3"
    // Phones: edge-to-edge — the editor is viewport-height, so any page
    // padding overflows below the canvas as a dead band / pushes content
    // under the tab bar. The card look starts at sm.
    : "max-w-[1400px] mx-auto sm:px-4 sm:pt-6 sm:pb-6 sm:space-y-3";
  if (showLoading) {
    // Fill the same viewport the loaded canvas will occupy (no jump from a
    // narrow framed skeleton to a full-screen board), with a canvas-like dotted
    // backdrop + a centered spinner so it clearly reads as "loading the board".
    const dotColor = dark ? "rgba(148,163,184,0.16)" : "rgba(15,23,42,0.07)";
    return (
      <main
        className={`relative w-full overflow-hidden ${
          embedded ? "h-full" : "h-[calc(100dvh-var(--nav-h)-var(--top-inset)-var(--bottom-inset))]"
        } ${dark ? "bg-[var(--color-bg)]" : "bg-slate-50"}`}
        aria-busy="true"
        aria-label="Loading whiteboard"
      >
        <div
          className="absolute inset-0"
          style={{ backgroundImage: `radial-gradient(${dotColor} 1.4px, transparent 1.4px)`, backgroundSize: "22px 22px" }}
        />
        {!embedded && (
          <div className="absolute top-4 left-4 right-4 flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-lg" />
            <Skeleton className="h-6 w-44 rounded-md" />
          </div>
        )}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-7 h-7 animate-spin text-[var(--color-accent)]" />
          <p className={`text-sm font-medium ${dark ? "text-slate-400" : "text-slate-500"}`}>Loading whiteboard…</p>
        </div>
      </main>
    );
  }
  if (!board) {
    return (
      <main className={frameCls}>
        {!embedded && (
          <Link
            to="/whiteboards"
            className="inline-flex items-center gap-1 text-sm text-[var(--color-accent)]"
          >
            <ArrowLeft className="w-4 h-4" /> Back to whiteboards
          </Link>
        )}
        <p className={`text-sm ${dark ? "text-slate-400" : "text-slate-500"}`}>
          {error || "Whiteboard not found, or you don't have access."}
        </p>
      </main>
    );
  }

  const saveLabel =
    saveState === "saved"
      ? "Saved"
      : saveState === "saving"
      ? "Saving…"
      : saveState === "dirty"
      ? "Unsaved"
      : "";

  return (
    <main
      ref={mainRef}
      // Subtract the nav bar (--nav-h; taller on mobile's two-row header) AND
      // both safe-area insets. Without the top env() the canvas is ~59px too tall on Dynamic
      // Island phones (top timer ribbon hides under the nav, bottom emote
      // island falls below the fold). The bottom env() keeps the bottom
      // controls (emote bar, zoom controls) clear of the home-indicator /
      // gesture area so taps there don't trigger an OS swipe. env() = 0 on
      // desktop, so it's a no-op there.
      className={`relative w-full overflow-hidden ${
        tool === "pen" ? "wb-pen wb-draw " : tool === "brush" ? "wb-paint wb-draw " : tool === "laser" ? "wb-laser wb-draw " : tool === "lasso" ? "wb-draw " : ""
      }${
        embedded
          ? "h-full"
          : "h-[calc(100dvh-var(--nav-h)-var(--top-inset)-var(--bottom-inset))]"
      }`}
      onPointerMove={onWbPointerMove}
      onPointerDownCapture={(e) => {
        // "Stamp a shape" armed → this click drops it, nothing else.
        if (placingRef.current) { e.preventDefault(); e.stopPropagation(); placeNodeRef.current?.({ x: e.clientX, y: e.clientY }); return; }
        marqueePointerDown(e); onWbPointerDownCapture(e);
      }}
      onPointerMoveCapture={marqueePointerMove}
      onPointerUpCapture={marqueePointerUp}
      onPointerCancelCapture={marqueePointerUp}
      // Capture phase: track touches (native stylus/force) + run the tap-gesture
      // recognizer BEFORE d3-zoom's pane listeners can stopPropagation, then the
      // single-touch draw guard.
      onTouchStartCapture={(e) => { trackTouches(e); onWbTouchStart(e); blockSingleTouchInDraw(e); }}
      onTouchMoveCapture={(e) => { trackTouches(e); onWbTouchMove(e); blockSingleTouchInDraw(e); }}
      onTouchEndCapture={(e) => { trackTouches(e); onWbTouchEnd(e); }}
      onTouchCancelCapture={(e) => { trackTouches(e); tapGestureRef.current = null; }}
      onClickCapture={onEditorClickCapture}
      onPointerUp={onWbPointerUp}
      onPointerCancel={onWbPointerUp}
    >
      <EdgeMarkerDefs />
      {marqueeRect && (
        <div
          className="fixed z-[60] pointer-events-none rounded-sm"
          style={{
            left: Math.min(marqueeRect.x0, marqueeRect.x1),
            top: Math.min(marqueeRect.y0, marqueeRect.y1),
            width: Math.abs(marqueeRect.x1 - marqueeRect.x0),
            height: Math.abs(marqueeRect.y1 - marqueeRect.y0),
            border: "1.5px dashed var(--color-accent)",
            background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
          }}
        />
      )}
      {/* Lasso live path (screen coords). */}
      {lassoPath && (
        <svg className="fixed inset-0 z-[60] pointer-events-none" width="100%" height="100%" style={{ left: 0, top: 0 }}>
          <path d={lassoPath} fill="color-mix(in srgb, var(--color-accent) 12%, transparent)" stroke="var(--color-accent)" strokeWidth={1.5} strokeDasharray="5 3" strokeLinejoin="round" />
        </svg>
      )}
      {/* Region-select drag box (screen coords, like the marquee). */}
      {areaBox && (
        <div
          className="fixed z-[60] pointer-events-none rounded-sm"
          style={{
            left: Math.min(areaBox.x0, areaBox.x1),
            top: Math.min(areaBox.y0, areaBox.y1),
            width: Math.abs(areaBox.x1 - areaBox.x0),
            height: Math.abs(areaBox.y1 - areaBox.y0),
            border: "1.5px dashed var(--color-accent)",
            background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
          }}
        />
      )}
      {/* The embedded (room) board now shows the full title-bar toolbar
          (export / capture / save-template / reactions), at parity with the
          full page — so the old standalone top-right PNG button is gone. */}
      <QuickConnectContext.Provider value={quickConnectApi}>
      <ConnectShapeContext.Provider value={pickedShape}>
      <AreaSelectedEdgesContext.Provider value={areaSelEdgeIds}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChangeSnap}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        connectOnClick={false}
        onReconnect={onReconnect}
        onNodeDragStart={onNodeDragStartClone}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onDoubleClick={tool === "select" && !readOnly ? onPaneDoubleClick : undefined}
        onMoveEnd={(_, vp) => { if (!embedded) saveViewport(board?.id, vp); }}
        onDragOver={onWbDragOver}
        onDrop={readOnly ? undefined : onWbDrop}
        zoomOnDoubleClick={false}
        connectionMode={ConnectionMode.Loose}
        connectionLineComponent={ConnectionLine}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        // A user-initiated pan/zoom (non-null event) drops me out of following
        // someone else. (My own viewport is broadcast by ViewportBroadcaster,
        // which also catches programmatic keyboard zoom that onMove misses.)
        onMoveStart={onViewportMoveStart}
        // Laser mode is point-only: no selecting, dragging, or connecting — so
        // you can gesture over the board without disturbing it.
        // Node drag is off while a floating region selection is active — the
        // selection overlay owns the move then.
        nodesDraggable={tool === "select" && !areaSel && !readOnly}
        nodesConnectable={tool === "select" && !readOnly}
        elementsSelectable={tool === "select" && !readOnly}
        // Region select is folded into the select tool: desktop left-drag on the
        // pane draws OUR box (onWbPointerDownCapture), which now marks the nodes it
        // covers `selected` LIVE (so they highlight as it passes, and the align +
        // bulk-edit toolbars — both keyed off `selected` — light up), and lifts any
        // brush paint into a floating selection on release. Touch uses the
        // long-press marquee. So RF's own drag-select stays OFF (it would double up).
        selectionOnDrag={false}
        selectionMode={SelectionMode.Partial}
        // Shift adds to selection, freeing ⌘/Ctrl for the click-to-clone quick action.
        multiSelectionKeyCode="Shift"
        // Disable RF's own Shift-drag box-select — our custom marquee owns the
        // drag (incl. Shift-to-ADD), so RF's native selector must not double up.
        selectionKeyCode={null}
        // Zoom way out for big boards (default floor is 0.5); a bit more in too.
        minZoom={0.1}
        maxZoom={3}
        // Desktop: left-drag is reserved (marquee in select, draw in pen), so
        // panning is middle/right-drag — plus the activation key below. Touch:
        // in select mode one-finger drag pans; every other tool keeps the
        // finger for its own gesture (pen/laser/brush strokes).
        panOnDrag={WB_TOUCH && tool === "select" ? true : [1, 2]}
        // Trackpad: two-finger scroll pans, pinch zooms (ctrl/⌘+scroll too);
        // hold Space to drag-pan. Left-drag still marquee-selects.
        panOnScroll
        zoomOnScroll={false}
        // Touch draw modes: single-finger touches never reach d3 (see the
        // onTouchStartCapture block on the container), so one finger draws
        // while two-finger gestures still pinch-zoom/pan the canvas.
        zoomOnPinch
        // Hold to pan with a left-drag: Space everywhere; in laser/brush mode
        // also ⌘/Ctrl so you can move the canvas while the left button draws.
        panActivationKeyCode={tool === "laser" || tool === "brush" ? ["Space", "Control", "Meta"] : "Space"}
        // NB: no `fitView` prop — React Flow re-fits when nodes re-initialize
        // (which finishing a pen stroke triggers), yanking the viewport mid-draw.
        // Initial fit / saved-viewport restore is done explicitly in
        // useWhiteboardPersistence after load.
        proOptions={{ hideAttribution: true }}
        style={{ background: dark ? "#0f172a" : "#fbf6ee" }}
      >
        <Background
          gap={26}
          size={1.6}
          color={dark ? "rgba(255,255,255,.06)" : "rgba(120,80,20,.14)"}
        />
        {/* Tiled raster paint layer (collaborative; strokes sync as vectors,
            tiles persist to Storage). High z so paint sits over nodes/images. */}
        <PaintLayer ref={paintRef} boardId={board?.id} enabled={collabEnabled} zIndex={900} />
        {/* Floating region selection (raster + picked pen strokes) + controls. */}
        {areaSel && (
          <>
            <ViewportPortal>
              <div style={{ position: "absolute", left: 0, top: 0, zIndex: 950 }}>
                <AreaSelectionFloating sel={areaSel} />
              </div>
            </ViewportPortal>
            <Panel
              position="top-center"
              style={{ marginTop: "var(--wb-topbar-offset, 66px)" }}
              className={`flex items-center gap-1.5 px-2 py-1.5 rounded-2xl border shadow-lg ${
                dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"
              }`}
            >
              <span className={`text-[11px] font-semibold px-1 ${dark ? "text-slate-300" : "text-slate-600"}`}>Drag to move</span>
              <button
                type="button"
                onClick={deleteAreaSelection}
                title="Delete selection"
                className={`${WB_TOUCH ? "h-10 px-3" : "h-8 px-2.5"} rounded-lg flex items-center gap-1 text-[12px] font-semibold transition-colors ${dark ? "text-rose-300 hover:bg-rose-500/15" : "text-rose-600 hover:bg-rose-50"}`}
              >
                <Trash2 className="w-4 h-4" /> Delete
              </button>
              <button
                type="button"
                onClick={commitAreaSelection}
                title="Place selection"
                className={`${WB_TOUCH ? "h-10 px-3" : "h-8 px-2.5"} rounded-lg flex items-center gap-1 text-[12px] font-semibold transition-colors ${dark ? "bg-sky-500/25 text-sky-200 hover:bg-sky-500/35" : "bg-sky-100 text-sky-700 hover:bg-sky-200"}`}
              >
                <Check className="w-4 h-4" /> Done
              </button>
            </Panel>
          </>
        )}
        {(helperLines.vertical || helperLines.horizontal) && (
          <HelperLines
            vertical={helperLines.vertical}
            horizontal={helperLines.horizontal}
          />
        )}
        {/* No floating <Controls> — pinch/scroll zoom, and fit-view lives in
            the top chrome card. */}
        {/* Hidden on phones (hidden sm:block) — the minimap eats scarce screen
            on mobile and duplicates the top bar's fit-view. Embedded room
            tiles keep it (staging enables it there). */}
        {(!compact || embedded) && showMinimap && <MiniMap pannable zoomable position="bottom-right" className="hidden sm:block" />}
        <CollabCursors peers={peers} />
        <PresenceStack members={members} viewports={viewports} followingId={followingId} onFollow={followMember} dark={dark} />
        {collabEnabled && <ViewportBroadcaster push={pushViewport} paused={!!followingId} />}

        {/* Dot-voting tally badges (per-node, multiplayer). */}
        <VotesOverlay nodes={nodes} myId={session?.user?.id} onToggle={toggleVote} dark={dark} />

        {/* Comment indicator badges (per-node, multiplayer). */}
        <CommentsOverlay nodes={nodes} openId={openCommentId} onOpen={setOpenCommentId} dark={dark} />

        {/* My own fading laser-ink trail (flow space). */}
        {tool === "laser" && <LaserTrail pointsRef={laserInkRef} color={effectiveLaserColor} />}

        {/* Live preview of the freehand stroke in progress (flow space). Fades
            back while an auto-shape ghost is armed, so the clean shape reads. */}
        {drawPath && (
          <ViewportPortal>
            <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", zIndex: 6, opacity: shapePreview ? 0.3 : 1 }}>
              {penStyle.pressure ? (
                <path d={drawPath} fill={penStyle.color} fillOpacity={penStyle.opacity ?? 1} />
              ) : (
                <path
                  d={drawPath}
                  fill="none"
                  stroke={penStyle.color}
                  strokeOpacity={penStyle.opacity ?? 1}
                  strokeWidth={penStyle.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </ViewportPortal>
        )}

        {/* Auto-shape "lift to keep" ghost — the clean shape/edge a lift will
            snap to, shown live while the pen holds still (flow space). */}
        {shapePreview && (
          <ViewportPortal>
            <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", zIndex: 7 }}>
              <ShapeGhost preview={shapePreview} color={penStyle.color} />
            </svg>
          </ViewportPortal>
        )}

        {/* "Stamp a node": the armed node ghosts under the cursor (flow space,
            so it's sized/positioned exactly as it'll be placed). Click to drop. */}
        {placing && ghostFlow && (
          <ViewportPortal>
            <PlacementGhost placing={placing} at={ghostFlow} />
          </ViewportPortal>
        )}
        {placing && (
          <Panel position="bottom-center" className={`pointer-events-none select-none mb-20 rounded-full px-3 py-1 text-xs font-medium shadow-lg ${dark ? "bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)]" : "bg-slate-900 text-white"}`}>
            Click to place · Esc to cancel
          </Panel>
        )}

        {/* "Following X" banner — mirroring a collaborator's viewport. */}
        {followingMember && (
          <Panel position="bottom-center" className="mb-20">
            <div className="flex items-center gap-2 rounded-full pl-3 pr-1.5 py-1 text-xs font-medium shadow-lg text-white" style={{ background: followingMember.color || "#0ea5e9" }}>
              <span className="inline-block w-2 h-2 rounded-full bg-white/90 animate-pulse" />
              Following {followingMember.name || "Guest"}
              <button type="button" onClick={() => setFollowingId(null)} className="ml-1 rounded-full bg-black/25 hover:bg-black/40 px-2 py-0.5 text-[11px] font-semibold">
                Stop · Esc
              </button>
            </div>
          </Panel>
        )}

        {/* Paint toolbar — brush/eraser, colour, size, opacity (brush mode). */}
        {tool === "brush" && <PaintToolbar dark={dark} style={brushStyle} setStyle={setBrushStyle} bottomOffset={bottomStackOffset} />}

        {/* (Undo/redo live in the top-bar group; 2/3-finger tap gestures still
            work via onWbTouch*.) */}

        {/* Multi-select toolbar: bulk same-type editor (top, edits the whole
            selection at once) + align/distribute (below, needs 2+ TOP-LEVEL
            nodes for their bounding boxes). */}
        {(multiCount >= 2 || bulkSelection) && !areaBox && (
          <Panel
            position="top-center"
            style={{ marginTop: "var(--wb-topbar-offset, 66px)" }}
            className="flex flex-col items-center gap-1"
          >
            {/* Bulk editor: same controls as a single node, applied to every
                selected node of the shared family (patchNodeData fans out). NO
                overflow wrapper — it would clip the Dropdown flyouts, which open
                downward outside the bar (the "popovers don't show" bug). */}
            {bulkSelection && !WB_TOUCH && (
              <Inspector wrapBar node={bulkSelection.rep} patchNodeData={patchNodeData} setLocked={setSelectedLocked} onReorder={reorderSelected} setOpacity={setSelectedOpacity} />
            )}
            {multiCount >= 2 && (
            <div
              className={`flex items-center gap-0.5 px-1.5 py-1 rounded-xl border shadow-lg ${
                dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"
              }`}
            >
            {[
              ["left", AlignStartVertical, "Align left"],
              ["centerH", AlignCenterVertical, "Align centers (horizontal)"],
              ["right", AlignEndVertical, "Align right"],
              null,
              ["top", AlignStartHorizontal, "Align top"],
              ["middleV", AlignCenterHorizontal, "Align middles (vertical)"],
              ["bottom", AlignEndHorizontal, "Align bottom"],
              null,
              ["distH", AlignHorizontalDistributeCenter, "Distribute horizontally"],
              ["distV", AlignVerticalDistributeCenter, "Distribute vertically"],
              null,
              ["matchW", StretchHorizontal, "Match width"],
              ["matchH", StretchVertical, "Match height"],
            ].map((item, i) => {
              if (!item) return <div key={`d${i}`} className={`w-px h-5 mx-0.5 ${dark ? "bg-white/10" : "bg-slate-200"}`} />;
              const [op, Icon, title] = item;
              return (
                <button
                  key={op}
                  type="button"
                  title={title}
                  onClick={() => arrange(op)}
                  className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
                    dark ? "text-slate-300 hover:bg-white/10" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </button>
              );
            })}
            </div>
            )}
          </Panel>
        )}

        {/* Bottom-left so collapsing the toolbar keeps it anchored to the left
            edge instead of drifting to centre. Capped to the FLOW CONTAINER
            width (100% — a React Flow Panel is positioned within it), so an
            embedded room panel scrolls the rail instead of clipping it; w-max
            sizes to content up to that cap. */}
        {!readOnly && (
        <Panel position="bottom-left" className="w-max max-w-[calc(100%-16px)]">
          <div
            ref={toolbarRef}
            className={`wb-scroll-x flex flex-row flex-nowrap items-center gap-1 sm:gap-0.5 p-1.5 sm:p-1 rounded-2xl border shadow-sm w-max max-w-full overflow-x-auto ${
              dark
                ? "bg-[var(--color-surface)] border-[var(--color-border)]"
                : "bg-white border-slate-200"
            }`}
          >
          {/* Collapse the toolbar (press Q for the quick-tool palette). */}
          <button
            type="button"
            onClick={() => setToolbarOpen((v) => !v)}
            title={toolbarOpen ? "Hide toolbar · press Q for quick tools" : "Show toolbar"}
            aria-label={toolbarOpen ? "Hide toolbar" : "Show toolbar"}
            aria-pressed={toolbarOpen}
            className={`${TOOL_BTN_SIZE} shrink-0 rounded-xl inline-flex items-center justify-center transition-colors ${
              dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"
            }`}
          >
            {toolbarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </button>
          {toolbarOpen && <ToolbarDivider dark={dark} />}
          {toolbarOpen && (
          <div className="flex flex-row flex-nowrap items-center gap-1 sm:gap-0.5">
          <StickyTool
            dark={dark}
            onAdd={(hex) =>
              addNodeAtCenter("sticky", hex ? { color: hex } : {})
            }
            onDropAt={(x, y, hex) =>
              addNodeAtCenter("sticky", hex ? { color: hex } : {}, { x, y })
            }
          />
          <TextTool
            dark={dark}
            prefs={textStyle}
            setPrefs={setTextStyle}
            onAdd={() => addNodeAtCenter("text", textStyleRef.current)}
          />
          <ToolbarDivider dark={dark} />
          <ShapesMenu
            dark={dark}
            onPick={(shape) => addNodeAtCenter("shape", { shape })}
            onDropAt={(x, y, shape) => addNodeAtCenter("shape", { shape }, { x, y })}
          />
          <ToolButton
            title="Add goal"
            tone="amber"
            dark={dark}
            onClick={() => addNodeAtCenter("goal")}
          >
            <Target className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            title="Add frame / section"
            tone="neutral"
            dark={dark}
            onClick={() => addNodeAtCenter("frame")}
          >
            <Frame className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            title={uploadingImage ? "Uploading image…" : "Add image"}
            tone="neutral"
            dark={dark}
            onClick={() => !uploadingImage && fileInputRef.current?.click()}
          >
            <ImagePlus className={`w-4 h-4 ${uploadingImage ? "animate-pulse opacity-60" : ""}`} />
          </ToolButton>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ""; // allow re-picking the same file
              const at = pendingImageAtRef.current; // set by the I-key shortcut
              pendingImageAtRef.current = null;
              if (f) addImageNode(f, at || undefined);
            }}
          />
          <ToolbarDivider dark={dark} />
          <PenTool
            dark={dark}
            active={tool === "pen"}
            style={penStyle}
            setStyle={setPenStyle}
            onToggle={() => setTool((t) => (t === "pen" ? "select" : "pen"))}
          />
          <ToolButton
            title={tool === "brush" ? "Brush (on) — Esc to exit" : "Brush — raster paint (options in the top bar)"}
            tone="sky"
            dark={dark}
            active={tool === "brush"}
            onClick={() => setTool((t) => (t === "brush" ? "select" : "brush"))}
          >
            <Paintbrush className="w-4 h-4" />
          </ToolButton>
          <LaserTool
            dark={dark}
            active={tool === "laser"}
            color={effectiveLaserColor}
            setColor={setLaserColor}
            onToggle={() => setTool((t) => (t === "laser" ? "select" : "laser"))}
          />
          <ToolButton
            title={tool === "lasso" ? "Lasso (on) — draw a shape to select; drag to move or ⌫ to delete" : "Lasso — freeform select strokes + paint"}
            dark={dark}
            active={tool === "lasso"}
            onClick={() => setTool((t) => (t === "lasso" ? "select" : "lasso"))}
          >
            <Lasso className="w-4 h-4" />
          </ToolButton>
          <ToolbarDivider dark={dark} />
          <ToolButton
            title="Delete selected"
            tone="red"
            dark={dark}
            onClick={deleteSelected}
          >
            <Trash2 className="w-4 h-4" />
          </ToolButton>
          </div>
          )}
          </div>
        </Panel>
        )}

        {/* Node inspector (shape/fill/border/text) hovers above the
              selected node, like the edge toolbar. Edges use their own
              floating contextual toolbar (rendered on the edge itself). */}
        {selectedNode && singleSelection && !WB_TOUCH && !areaBox && (
          <NodeToolbar
            nodeId={selectedNode.id}
            isVisible
            // Text nodes put the format panel BELOW so opening the font/size
            // menus doesn't cover the text you're editing. Everything else keeps
            // the toolbar above.
            position={selectedNode.type === "text" ? Position.Bottom : Position.Top}
            // Frames carry a floating label above their top edge — push the
            // toolbar above THAT (like the edge toolbar clears the line) so it
            // never overlaps the title.
            offset={selectedNode.type === "frame" ? (selectedNode.data?.fontSize ?? 20) + 28 : 14}
            align="center"
          >
            <Inspector node={selectedNode} patchNodeData={patchNodeData} setLocked={setSelectedLocked} onReorder={reorderSelected} setOpacity={setSelectedOpacity} />
          </NodeToolbar>
        )}

        {/* Touch: the hovering NodeToolbar is fiddly on a phone — a static
            bar above the main toolbar instead, with taller targets and
            flyouts opening upward. */}
        {touchInspectorVisible && (
          <Panel position="bottom-left" className="w-max max-w-[calc(100%-16px)] z-40" style={{ bottom: touchInspectorBottom }}>
            <div ref={touchInspectorRef} className="flex items-center gap-1.5 max-w-full">
              {/* The pill scrolls (capped to the flow container so a room panel
                  doesn't clip it); the trash stays pinned outside it. */}
              <div className="wb-scroll-x overflow-x-auto rounded-xl max-w-[calc(100%-56px)] [&_button]:min-h-11 [&_.lucide]:w-5 [&_.lucide]:h-5">
                <DropUpContext.Provider value={true}>
                  <Inspector wrapBar node={selectedNode} patchNodeData={patchNodeData} setLocked={setSelectedLocked} onReorder={reorderSelected} setOpacity={setSelectedOpacity} />
                </DropUpContext.Provider>
              </div>
              <button
                type="button"
                onClick={deleteSelected}
                aria-label="Delete selected"
                className="w-12 h-12 shrink-0 rounded-xl flex items-center justify-center text-red-400 shadow-2xl active:bg-white/10"
                style={{ background: "#1f2937", border: "1px solid rgba(255,255,255,.08)" }}
              >
                <Trash2 className="w-6 h-6" />
              </button>
            </div>
          </Panel>
        )}

        {/* Comment thread popover, anchored to the right of the open node. */}
        {openCommentId && (() => {
          const cn = nodes.find((n) => n.id === openCommentId);
          if (!cn) return null;
          return (
            <NodeToolbar nodeId={openCommentId} isVisible position={Position.Right} align="start" offset={12}>
              <CommentThread
                comments={cn.data?.comments || []}
                myId={session?.user?.id}
                onAdd={(t) => addComment(openCommentId, t)}
                onDelete={(cid) => deleteComment(openCommentId, cid)}
                onClose={() => setOpenCommentId(null)}
                dark={dark}
              />
            </NodeToolbar>
          );
        })()}
      </ReactFlow>
      </AreaSelectedEdgesContext.Provider>
      </ConnectShapeContext.Provider>
      </QuickConnectContext.Provider>

      {/* "?" keyboard-shortcuts cheatsheet (top-level overlay). */}
      <WhiteboardShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} dark={dark} />

      {/* Shape-number legend — shown while dragging a connector or hovering a
          quick-connect arrow, so people know which number makes which shape.
          The current pick is highlighted. Desktop only — it's a keyboard hint
          (1–9), useless without a keyboard. */}
      {!WB_TOUCH && (connecting || hoveringArrow) && (
        <div
          className={`absolute left-1/2 -translate-x-1/2 bottom-4 z-40 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border shadow-lg pointer-events-none ${
            dark ? "bg-[var(--color-surface)]/95 border-[var(--color-border)]" : "bg-white/95 border-slate-200"
          }`}
        >
          <span className={`text-[10px] font-semibold uppercase tracking-wide mr-0.5 ${dark ? "text-slate-500" : "text-slate-400"}`}>
            Press
          </span>
          {SHAPES.map((s, i) => {
            const num = i === 9 ? 0 : i + 1;
            const on = pickedShape === s.key;
            return (
              <span
                key={s.key}
                title={`${num} · ${s.label}`}
                className={`flex flex-col items-center gap-0.5 px-1 py-0.5 rounded-md ${
                  on ? "bg-[var(--color-accent)]/15" : ""
                }`}
              >
                <span className={`text-[9px] font-bold leading-none ${on ? "text-[var(--color-accent)]" : dark ? "text-slate-400" : "text-slate-500"}`}>
                  {num}
                </span>
                <ShapePreview shape={s.key} w={20} h={13} />
              </span>
            );
          })}
        </div>
      )}

      {/* Region capture ("snip") overlay — drag a box to export it as a PNG. */}
      {tool === "capture" && !readOnly && (
        <RegionCapture
          dark={dark}
          toFlow={(p) => rf.screenToFlowPosition(p)}
          onComplete={(b) => { setTool("select"); exportPng(b, 12); }}
          onCancel={() => setTool("select")}
        />
      )}

      {/* Quick-tool palette — popped by pressing "Q" at the cursor. A compact
          floating tool picker; new nodes spawn right where the palette sits (the
          cursor). The centre is an "X" that clears the selection and drops back
          to select mode. Works even when the left toolbar is collapsed. */}
      {palette && !readOnly && (
        <>
          <div className="fixed inset-0 z-[59]" onClick={() => setPalette(null)} aria-hidden />
          <div
            style={{ left: palette.x, top: palette.y }}
            className={`fixed z-[60] -translate-x-1/2 -translate-y-1/2 grid grid-cols-3 gap-1 p-2 rounded-2xl border shadow-2xl ${
              dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"
            }`}
            role="menu"
            aria-label="Quick tools"
          >
            {[
              { label: "Frame", icon: <Frame className="w-4 h-4" />, run: () => addNodeAtCenter("frame", {}, palette) },
              { label: "Sticky note", icon: <StickyNote className="w-4 h-4" />, run: () => addNodeAtCenter("sticky", {}, palette) },
              { label: "Text", icon: <Type className="w-4 h-4" />, run: () => addNodeAtCenter("text", textStyleRef.current, palette) },
              { label: "Goal", icon: <Target className="w-4 h-4" />, run: () => addNodeAtCenter("goal", {}, palette) },
              { label: "Clear selection", icon: <X className="w-5 h-5" />, center: true, run: () => { setTool("select"); clearSelection(); } },
              { label: "Image", icon: <ImagePlus className="w-4 h-4" />, run: () => fileInputRef.current?.click() },
              { label: "Pen", icon: <Pencil className="w-4 h-4" />, run: () => setTool("pen") },
              { label: "Brush", icon: <Paintbrush className="w-4 h-4" />, run: () => setTool("brush") },
              { label: "Shape", icon: <ShapePreview shape={preferredShape()} w={22} h={15} />, run: () => addNodeAtCenter("shape", { shape: preferredShape() }, palette) },
            ].map(({ label, icon, run, center }) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                title={label}
                aria-label={label}
                onClick={() => { run(); setPalette(null); }}
                className={`w-10 h-10 rounded-xl inline-flex items-center justify-center transition-colors ${
                  center
                    ? (dark ? "text-rose-300 hover:bg-rose-500/15 ring-1 ring-rose-500/30" : "text-rose-500 hover:bg-rose-50 ring-1 ring-rose-200")
                    : (dark ? "text-slate-300 hover:bg-white/10" : "text-slate-600 hover:bg-slate-100")
                }`}
              >
                {icon}
              </button>
            ))}
          </div>
        </>
      )}

      {/* My own laser glow (screen space) — tracks in laser mode, shows on press. */}
      <LocalLaser active={tool === "laser"} show={laserPressing} color={effectiveLaserColor} />
      {/* Photoshop-style brush ring while painting (replaces the crosshair). */}
      <BrushCursor active={tool === "brush"} size={activeBrushSize(brushStyle)} color={brushStyle.color} erase={brushStyle.erase} />

      {/* Breadcrumb / board chrome — a floating card pinned top-left. Holds
            back-nav, title, template badge, save state, the reactions-bar
            toggle, and archive. The inner row flex-wraps on narrow phones (see
            below) so it folds to two rows instead of overflowing. */}
      <div className="absolute left-3 top-3 z-40 flex flex-col gap-2 items-start max-w-[calc(100%-24px)] touch-none">
        <div
          ref={topbarRef}
          // flex-wrap so the toolbar folds onto a second row on narrow phones
          // instead of overflowing the canvas (every child is shrink-0). The
          // outer max-w-[calc(100%-24px)] caps the row width so the wrap fires.
          className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 rounded-2xl border shadow-md"
          style={{
            background: dark ? "var(--color-surface)" : "#fff",
            borderColor: dark ? "var(--color-border)" : "rgb(226,232,240)",
          }}
        >
          {!embedded && (
            <>
              <Link
                to="/whiteboards"
                title="Back to whiteboards"
                className={`inline-flex items-center gap-1 text-xs shrink-0 ${
                  dark
                    ? "text-slate-400 hover:text-slate-200"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                <ArrowLeft className="w-4 h-4" />
              </Link>
              <div
                className={`hidden sm:block w-px h-4 ${
                  dark ? "bg-[var(--color-border)]" : "bg-slate-200"
                }`}
              />
            </>
          )}
          {titleEditing ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value.slice(0, 120))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveTitle();
                  else if (e.key === "Escape") {
                    setTitleDraft(board.title);
                    setTitleEditing(false);
                  }
                }}
                className={`rounded-md border px-2 py-0.5 text-sm font-bold w-44 ${
                  dark
                    ? "bg-[var(--color-surface-raised)] border-[var(--color-border)] text-slate-100"
                    : "bg-white border-slate-300 text-slate-800"
                }`}
              />
              <Button size="sm" onClick={handleSaveTitle} className="h-7">
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setTitleDraft(board.title);
                  setTitleEditing(false);
                }}
                className="h-7"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <span
              className={`text-sm font-bold inline-flex items-center gap-1.5 cursor-text max-w-[220px] ${
                dark ? "text-slate-100" : "text-slate-800"
              }`}
              onDoubleClick={() => { if (!readOnly) setTitleEditing(true); }}
              title="Double-click to rename"
            >
              <span className="truncate">{board.title}</span>
              <button
                type="button"
                onClick={() => { if (!readOnly) setTitleEditing(true); }}
                className={`opacity-50 hover:opacity-100 shrink-0 ${
                  dark ? "text-slate-300" : "text-slate-500"
                }`}
                title="Rename"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </span>
          )}
          {template && !compact && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-accent-light)] text-[var(--color-accent)] shrink-0">
              {template.name}
            </span>
          )}
          {saveLabel && (
            <span
              className={`text-[11px] shrink-0 ${
                dark ? "text-slate-500" : "text-slate-400"
              }`}
            >
              {saveLabel}
            </span>
          )}
          <div
            className={`hidden sm:block w-px h-4 ${
              dark ? "bg-[var(--color-border)]" : "bg-slate-200"
            }`}
          />
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            title="Undo (⌘Z / two-finger tap)"
            aria-label="Undo"
            className={`${WB_TOUCH ? "w-9 h-9" : "w-7 h-7"} rounded-full inline-flex items-center justify-center transition-colors shrink-0 ${
              !canUndo
                ? dark ? "text-slate-600 cursor-not-allowed" : "text-slate-300 cursor-not-allowed"
                : dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"
            }`}
          >
            <Undo2 className={WB_TOUCH ? "w-5 h-5" : "w-4 h-4"} />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canRedo}
            title="Redo (⌘⇧Z / three-finger tap)"
            aria-label="Redo"
            className={`${WB_TOUCH ? "w-9 h-9" : "w-7 h-7"} rounded-full inline-flex items-center justify-center transition-colors shrink-0 ${
              !canRedo
                ? dark ? "text-slate-600 cursor-not-allowed" : "text-slate-300 cursor-not-allowed"
                : dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"
            }`}
          >
            <Redo2 className={WB_TOUCH ? "w-5 h-5" : "w-4 h-4"} />
          </button>
          <FitViewButton dark={dark} />
          {/* Collapse / reveal the extra tools. Keeps the bar to one row on a
              small board; when open they wrap to a second row if narrow. */}
          <button
            type="button"
            onClick={() => setToolsOpen((v) => !v)}
            title={toolsOpen ? "Hide tools" : "Show tools"}
            aria-label={toolsOpen ? "Hide tools" : "Show tools"}
            aria-pressed={toolsOpen}
            className={`w-7 h-7 rounded-full inline-flex items-center justify-center transition-colors shrink-0 ${
              toolsOpen
                ? "text-[var(--color-accent)] bg-[var(--color-accent-light)]"
                : dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"
            }`}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {toolsOpen && (
            <>
              <div
                className={`hidden sm:block w-px h-4 ${
                  dark ? "bg-[var(--color-border)]" : "bg-slate-200"
                }`}
              />
              <button
                type="button"
                onClick={() => setEmoteBarOn((v) => !v)}
                title={emoteBarOn ? "Hide reactions bar" : "Show reactions bar"}
                aria-label={
                  emoteBarOn ? "Hide reactions bar" : "Show reactions bar"
                }
                aria-pressed={emoteBarOn}
                className={`w-7 h-7 rounded-full inline-flex items-center justify-center transition-colors shrink-0 ${
                  emoteBarOn
                    ? "text-[var(--color-accent)] bg-[var(--color-accent-light)]"
                    : dark
                    ? "text-slate-400 hover:bg-white/10"
                    : "text-slate-500 hover:bg-slate-100"
                }`}
              >
                <Smile className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setShowTimer((v) => !v)}
                title={showTimer ? "Hide timer" : "Show timer"}
                aria-label={showTimer ? "Hide timer" : "Show timer"}
                aria-pressed={showTimer}
                className={`w-7 h-7 rounded-full inline-flex items-center justify-center transition-colors shrink-0 ${
                  showTimer
                    ? "text-[var(--color-accent)] bg-[var(--color-accent-light)]"
                    : dark
                    ? "text-slate-400 hover:bg-white/10"
                    : "text-slate-500 hover:bg-slate-100"
                }`}
              >
                <Timer className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setShowMinimap((v) => !v)}
                title={showMinimap ? "Hide minimap" : "Show minimap"}
                aria-label={showMinimap ? "Hide minimap" : "Show minimap"}
                aria-pressed={showMinimap}
                className={`w-7 h-7 rounded-full inline-flex items-center justify-center transition-colors shrink-0 ${
                  showMinimap
                    ? "text-[var(--color-accent)] bg-[var(--color-accent-light)]"
                    : dark
                    ? "text-slate-400 hover:bg-white/10"
                    : "text-slate-500 hover:bg-slate-100"
                }`}
              >
                <MapIcon className="w-4 h-4" />
              </button>
              {!readOnly && (
            <button
              type="button"
              onClick={() => setTool((t) => (t === "capture" ? "select" : "capture"))}
              title="Capture a region as PNG"
              aria-label="Capture a region as PNG"
              aria-pressed={tool === "capture"}
              className={`w-7 h-7 rounded-full inline-flex items-center justify-center transition-colors shrink-0 ${
                tool === "capture"
                  ? "text-[var(--color-accent)] bg-[var(--color-accent-light)]"
                  : dark
                  ? "text-slate-400 hover:bg-white/10"
                  : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              <Crop className="w-4 h-4" />
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              onClick={handleExportPng}
              title="Export as PNG"
              aria-label="Export as PNG"
              className={`w-7 h-7 rounded-full inline-flex items-center justify-center transition-colors shrink-0 ${
                dark
                  ? "text-slate-400 hover:bg-white/10"
                  : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              <Download className="w-4 h-4" />
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              onClick={() => setSaveTplOpen(true)}
              title="Save as template"
              aria-label="Save as template"
              className={`w-7 h-7 rounded-full inline-flex items-center justify-center transition-colors shrink-0 ${
                dark
                  ? "text-slate-400 hover:bg-white/10"
                  : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              <LayoutTemplate className="w-4 h-4" />
            </button>
          )}
          {!readOnly && (
            <button
              type="button"
              onClick={clearAllDrawings}
              title="Clear all drawings (pen + brush)"
              aria-label="Clear all drawings"
              className={`w-7 h-7 rounded-full inline-flex items-center justify-center transition-colors shrink-0 ${
                dark
                  ? "text-slate-400 hover:bg-white/10"
                  : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              <Eraser className="w-4 h-4" />
            </button>
          )}
          {isAdmin && !embedded && (
            <button
              type="button"
              onClick={handleArchive}
              title="Archive whiteboard"
              aria-label="Archive whiteboard"
              className={`w-7 h-7 rounded-full inline-flex items-center justify-center transition-colors shrink-0 ${
                dark
                  ? "text-slate-400 hover:bg-white/10"
                  : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              <Archive className="w-4 h-4" />
            </button>
          )}
            </>
          )}
        </div>
        {error && (
          <div
            className={`text-xs font-medium px-3 py-1.5 rounded-lg shadow ${
              dark ? "bg-red-500/15 text-red-400" : "bg-red-50 text-red-600"
            }`}
          >
            {error}
          </div>
        )}
        {/* Shared board countdown — stacked in the nav column (below the
              breadcrumb) so the two never overlap. It used to sit in the
              centered hero row and collided with the nav on narrow boards. */}
        {showTimer && <WhiteboardTimer boardId={board.id} dark={dark} />}

        <SaveTemplateModal
          open={saveTplOpen}
          onClose={() => setSaveTplOpen(false)}
          getSnapshot={() => ({ nodes, edges })}
          teamId={activeTeamId}
          ownerId={session?.user?.id}
          defaultName={board?.title}
        />
      </div>

      {/* Top overlay — Weekly Review's signature goal banner (when the
            template opts in), pinned top-center over the canvas. The focus
            timer now lives in the nav column (above), so this row holds the
            goal banner alone. pointer-events:none on the wrapper so clicks
            pass through except on the chip itself. */}
      {template?.hasGoal && !compact && (
        <div
          className="absolute left-1/2 -translate-x-1/2 z-30 flex items-stretch max-w-[calc(100%-32px)] touch-none"
          style={{ pointerEvents: "none", top: "var(--wb-topbar-offset, 66px)" }}
        >
          <div
            className="flex items-center gap-3 pl-3 pr-4 py-2 rounded-2xl shadow-md min-w-0 max-w-[520px]"
            style={{
              background:
                "linear-gradient(120deg, #f97316, #fb7a1a 70%, #ea580c)",
              boxShadow: "0 16px 34px -18px rgba(249,115,22,.65)",
              pointerEvents: "auto",
            }}
          >
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-white/20">
              <Target className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[8.5px] font-bold tracking-[0.13em] uppercase text-white/85">
                  Goal for next week
                </span>
                {!goalEditing && !readOnly && (
                  <button
                    type="button"
                    onClick={() => {
                      setGoalDraft(board.goal || "");
                      setGoalEditing(true);
                    }}
                    className="text-white/75 hover:text-white"
                    title="Edit goal"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
              </div>
              {goalEditing ? (
                <div className="mt-1 flex items-center gap-2">
                  <input
                    autoFocus
                    value={goalDraft}
                    onChange={(e) => setGoalDraft(e.target.value.slice(0, 280))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveGoal();
                      else if (e.key === "Escape") {
                        setGoalDraft(board.goal || "");
                        setGoalEditing(false);
                      }
                    }}
                    placeholder="Write your team goal…"
                    className="flex-1 bg-white/15 rounded-md px-2 py-1 text-sm text-white placeholder-white/60 outline-none focus:bg-white/25"
                  />
                  <button
                    type="button"
                    onClick={handleSaveGoal}
                    className="h-7 px-2.5 rounded-md bg-white text-orange-700 text-xs font-bold"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setGoalDraft(board.goal || "");
                      setGoalEditing(false);
                    }}
                    className="h-7 px-2.5 rounded-md bg-white/15 text-white text-xs font-bold"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <p className="mt-0.5 text-[14px] font-bold tracking-tight text-white truncate max-w-[470px]">
                  {board.goal || "Click edit to set a goal…"}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Floating-emote layer scoped to this whiteboard. Same scope
            key on every client → emotes broadcast peer-to-peer. The bar
            is toggleable; peers' emotes still render when it's hidden. */}
      <EmoteOverlay
        channelKey={`whiteboard:${board.id}`}
        enabled={!readOnly}
        barPosition={!readOnly && emoteBarOn ? "bottom-center" : "hidden"}
        // Sit just above whatever's stacked at bottom-center: the measured
        // toolbar (panel margin 15 + height + gap), plus any paint/inspector
        // bars stacked above it.
        barOffset={emoteBarOffset}
      />
    </main>
  );
}
