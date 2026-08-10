import { memo, useMemo, useState } from "react";
import { ViewportPortal } from "@xyflow/react";
import { MessageSquare, X } from "lucide-react";
import { nodeAbsPos } from "./frame";

// Dot-voting: a tally badge floating above each node's top-right corner. Shown
// on any node that has votes, plus the selected node (as a "vote" affordance so
// you can cast the first one). Votes are a per-user map in node.data.votes
// (`{ userId: 1 }`), so they sync + persist like any node data and each person
// can add/remove only their own. One overlay covers every node type.
// memo: props (nodes, myId, onToggle, dark) are referentially stable across the
// editor's frequent re-renders, so this skips re-rendering + the full node scan
// unless the nodes array actually changes.
export const VotesOverlay = memo(function VotesOverlay({ nodes, myId, onToggle, dark }) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const show = nodes.filter(
    (n) => n.type !== "zone" && n.type !== "frame" &&
      (n.selected || (n.data?.votes && Object.keys(n.data.votes).length))
  );
  if (!show.length) return null;
  return (
    <ViewportPortal>
      {show.map((n) => {
        const abs = nodeAbsPos(n, byId);
        const w = n.width || n.measured?.width || 0;
        const votes = n.data?.votes || {};
        const count = Object.keys(votes).length;
        const mine = !!(myId && votes[myId]);
        return (
          <div
            key={`vote-${n.id}`}
            // Just OUTSIDE the right edge near the top — clear of the Inspector
            // (above) and the corner resize handles. pointerEvents:auto opts back
            // in (the viewport-portal layer is none, so clicks pass through it).
            style={{ position: "absolute", left: abs.x + w + 8, top: abs.y + 2, zIndex: 30, pointerEvents: "auto" }}
          >
            <button
              type="button"
              className="nodrag"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onToggle(n.id); }}
              title={count ? `${count} vote${count === 1 ? "" : "s"} — click to ${mine ? "remove" : "add"} yours` : "Vote"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 12, fontWeight: 800, lineHeight: 1,
                padding: "3px 8px", borderRadius: 9999, cursor: "pointer",
                background: mine ? "var(--color-accent)" : dark ? "rgba(15,23,42,.86)" : "#fff",
                color: mine ? "#fff" : dark ? "#e2e8f0" : "#334155",
                border: `1.5px solid ${mine ? "var(--color-accent)" : dark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.12)"}`,
                boxShadow: "0 4px 10px -4px rgba(0,0,0,.4)",
                opacity: count === 0 && !mine ? 0.7 : 1,
              }}
            >
              <span style={{ fontSize: 13 }}>👍</span>
              {count > 0 && <span>{count}</span>}
            </button>
          </div>
        );
      })}
    </ViewportPortal>
  );
});

// Short relative timestamp for comments ("just now" / "5m" / "2h" / "3d").
function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - (ts || 0)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Comment indicator badges (top-left of each node), mirroring the vote badges.
// Shown on any node with comments + the selected node (to start a thread).
// Clicking toggles the thread open for that node. Comments live in
// data.comments so they sync + persist like any node data.
export const CommentsOverlay = memo(function CommentsOverlay({ nodes, openId, onOpen, dark }) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const show = nodes.filter(
    (n) => n.type !== "zone" && n.type !== "frame" &&
      (n.selected || (n.data?.comments && n.data.comments.length))
  );
  if (!show.length) return null;
  return (
    <ViewportPortal>
      {show.map((n) => {
        const abs = nodeAbsPos(n, byId);
        const count = n.data?.comments?.length || 0;
        const open = openId === n.id;
        const lit = open || count > 0;
        return (
          <div
            key={`cmt-${n.id}`}
            // Just OUTSIDE the left edge near the top — clear of the Inspector
            // (above) and the corner resize handles. pointerEvents:auto opts back
            // in (the viewport-portal layer is none, so clicks pass through it).
            style={{ position: "absolute", left: abs.x - 8, top: abs.y + 2, transform: "translate(-100%,0)", zIndex: 30, pointerEvents: "auto" }}
          >
            <button
              type="button"
              className="nodrag wb-comment-badge"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onOpen(open ? null : n.id); }}
              title={count ? `${count} comment${count === 1 ? "" : "s"}` : "Comment"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 12, fontWeight: 800, lineHeight: 1,
                padding: "3px 8px", borderRadius: 9999, cursor: "pointer",
                background: open ? "var(--color-accent)" : dark ? "rgba(15,23,42,.86)" : "#fff",
                color: open ? "#fff" : lit ? (dark ? "#e2e8f0" : "#334155") : "#94a3b8",
                border: `1.5px solid ${open ? "var(--color-accent)" : dark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.12)"}`,
                boxShadow: "0 4px 10px -4px rgba(0,0,0,.4)",
                opacity: lit ? 1 : 0.7,
              }}
            >
              <MessageSquare style={{ width: 13, height: 13 }} />
              {count > 0 && <span>{count}</span>}
            </button>
          </div>
        );
      })}
    </ViewportPortal>
  );
});

// Thread popover (rendered in a NodeToolbar anchored to the node): the comment
// list + an input. You can delete your own comments. Enter sends, Shift+Enter
// newlines.
export function CommentThread({ comments, myId, onAdd, onDelete, onClose, dark }) {
  const [text, setText] = useState("");
  const submit = () => { const t = text.trim(); if (!t) return; onAdd(t); setText(""); };
  const surface = dark ? "var(--color-surface)" : "#fff";
  const border = dark ? "var(--color-border)" : "rgb(226,232,240)";
  const txt = dark ? "#e2e8f0" : "#334155";
  const muted = "#94a3b8";
  return (
    <div
      className="nodrag nowheel wb-comment-thread"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{ width: 264, background: surface, border: `1px solid ${border}`, borderRadius: 14, boxShadow: "0 18px 40px -16px rgba(0,0,0,.5)", overflow: "hidden", color: txt }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", borderBottom: `1px solid ${border}` }}>
        <span style={{ fontSize: 12, fontWeight: 800 }}>Comments</span>
        <button type="button" onClick={onClose} title="Close" style={{ display: "flex", color: muted }}><X style={{ width: 14, height: 14 }} /></button>
      </div>
      <div style={{ maxHeight: 240, overflowY: "auto", padding: comments.length ? "4px 10px" : 0 }}>
        {comments.length === 0 && <div style={{ padding: "14px 10px", fontSize: 12, color: muted }}>No comments yet — start the thread.</div>}
        {comments.map((c) => (
          <div key={c.id} style={{ padding: "6px 0" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{c.author || "Guest"}</span>
              <span style={{ fontSize: 10, color: muted }}>{timeAgo(c.ts)}</span>
              {c.authorId && c.authorId === myId && (
                <button type="button" onClick={() => onDelete(c.id)} title="Delete" style={{ marginLeft: "auto", color: muted, display: "flex" }}>
                  <X style={{ width: 12, height: 12 }} />
                </button>
              )}
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.35, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{c.text}</div>
          </div>
        ))}
      </div>
      <div style={{ padding: 8, borderTop: `1px solid ${border}`, display: "flex", gap: 6, alignItems: "flex-end" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={1}
          placeholder="Add a comment…"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          className="nowheel"
          style={{ flex: 1, resize: "none", maxHeight: 90, fontSize: 12.5, padding: "6px 8px", borderRadius: 8, border: `1px solid ${border}`, background: dark ? "rgba(255,255,255,.04)" : "#fff", color: txt, outline: "none" }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim()}
          style={{ fontSize: 12, fontWeight: 700, padding: "6px 10px", borderRadius: 8, background: "var(--color-accent)", color: "#fff", border: "none", opacity: text.trim() ? 1 : 0.5, cursor: text.trim() ? "pointer" : "default" }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

// Floating raster+node region selection (rendered inside <ViewportPortal>, i.e.
// flow space). Shows the lifted paint pixels at rect+offset with a marching-ants
// border; dragging it moves the whole selection (raster + picked pen strokes).
// The Delete/Done controls live in a separate screen-space panel.
export function AreaSelectionFloating({ sel }) {
  const { rect, raster, dx, dy, box } = sel;
  const b = box || rect; // the single selection box, tight to the content
  return (
    <>
      {/* Lifted paint pixels render at the region they were read from; the box
          below bounds them + any picked nodes. */}
      {raster && (
        <div
          style={{ position: "absolute", left: rect.x + dx, top: rect.y + dy, width: rect.w, height: rect.h, pointerEvents: "none" }}
          ref={(el) => {
            if (el && raster && raster.parentNode !== el) {
              raster.style.width = "100%";
              raster.style.height = "100%";
              raster.style.display = "block";
              el.appendChild(raster);
            }
          }}
        />
      )}
      {/* Single selection box — the visual border AND the drag hit target, so the
          interactable area matches exactly what you see. pointerEvents:auto is
          REQUIRED (the .react-flow__viewport portal host sets it to none). */}
      <div
        className="wb-area-overlay"
        style={{ position: "absolute", left: b.x + dx, top: b.y + dy, width: b.w, height: b.h, cursor: "move", touchAction: "none", pointerEvents: "auto", border: "1.5px dashed var(--color-accent)", background: "color-mix(in srgb, var(--color-accent) 8%, transparent)", borderRadius: 10 }}
      />
    </>
  );
}
