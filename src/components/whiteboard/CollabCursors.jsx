import { useEffect, useRef, useState } from "react";
import { ViewportPortal, useViewport, Panel } from "@xyflow/react";

// Remote cursors arrive throttled (~45ms) so rendering them raw makes them
// jump. We ease each cursor toward its latest target every animation frame
// (exponential smoothing) with a small velocity lead so it tracks motion
// without lagging — and write the transform to the DOM directly so a moving
// cursor never re-renders React. Positions are in FLOW space and counter-
// scaled by zoom so cursors stay a constant on-screen size (FigJam style).

const SMOOTH = 0.32;   // 0..1 — higher snaps faster, lower glides more
const LEAD = 0.6;      // how far to project along recent velocity
const LEAD_CLAMP = 36; // cap the lead so fast flicks don't overshoot

// A glowing laser dot, centred on the cursor point. Used for both remote
// peers (inside the flow-space cursor wrapper) and the local pointer. The
// soft outer glow uses the peer's colour so you can tell who's pointing.
function LaserDot({ color = "#ef4444", name }) {
  return (
    <>
      <div
        style={{
          position: "absolute", left: -15, top: -15, width: 30, height: 30,
          borderRadius: "50%", pointerEvents: "none",
          background: `radial-gradient(circle, ${color} 0%, ${color}66 38%, transparent 72%)`,
          opacity: 0.9,
        }}
      />
      <div
        style={{
          position: "absolute", left: -4, top: -4, width: 8, height: 8,
          borderRadius: "50%", background: "#fff",
          boxShadow: `0 0 8px 3px ${color}`,
        }}
      />
      {name && (
        <div
          style={{
            position: "absolute", left: 13, top: 9,
            background: color, color: "#fff", fontSize: 10, fontWeight: 700,
            padding: "1px 6px", borderRadius: 6, whiteSpace: "nowrap",
            boxShadow: "0 1px 3px rgba(0,0,0,.25)",
          }}
        >
          {name}
        </div>
      )}
    </>
  );
}

const TRAIL_TTL = 900; // ms a laser-ink point lives before it fully fades

// A fading "laser ink" line in FLOW space. Reads timestamped points from a ref
// (so the writer mutates without forcing a render) and animates the fade on its
// own rAF. Stroke weight counter-scales with zoom so it stays constant on
// screen. Used for both my own ink and each peer's (buffered from their cursor
// stream). Returns null until there are ≥2 live points.
export function LaserTrail({ pointsRef, color = "#ef4444" }) {
  const { zoom } = useViewport();
  const [, force] = useState(0);
  useEffect(() => {
    let raf;
    const tick = () => {
      const now = Date.now();
      const pts = pointsRef.current;
      const had = pts.length;
      while (pts.length && now - pts[0].t > TRAIL_TTL) pts.shift();
      if (pts.length || had) force((n) => (n + 1) & 0xffff);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pointsRef]);
  const pts = pointsRef.current;
  if (!pts || pts.length < 2) return null;
  const now = Date.now();
  const sw = 3 / (zoom || 1);
  return (
    <ViewportPortal>
      <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", zIndex: 1002 }}>
        {pts.slice(1).map((b, i) => {
          const a = pts[i];
          const op = Math.max(0, 1 - (now - b.t) / TRAIL_TTL);
          if (op <= 0) return null;
          return (
            <line
              key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
              opacity={op * 0.9}
            />
          );
        })}
      </svg>
    </ViewportPortal>
  );
}

export function CollabCursors({ subscribe }) {
  const { zoom } = useViewport();
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const inkRefs = useRef({});   // id → { current: [{x,y,t}] } stable ref per peer

  const targets = useRef({});   // id → { x, y, vx, vy, name, color }
  const anim = useRef({});      // id → { x, y } (rendered, smoothed)
  const els = useRef({});       // id → DOM node
  const [ids, setIds] = useState([]);
  const idsKey = useRef("");

  // Fold incoming peer positions into targets + velocity estimates. Driven by an
  // imperative subscription (not a prop) so a peer moving their cursor never
  // re-renders the editor; we only React-render here when the SET of peers or
  // their laser-ness changes (swap the arrow ↔ laser-dot markup).
  useEffect(() => {
    if (!subscribe) return undefined;
    const fold = (snapshot) => {
    const next = snapshot || {};
    const keys = Object.keys(next);
    for (const id of keys) {
      const prev = targets.current[id];
      const p = next[id];
      const vx = prev ? p.x - prev.x : 0;
      const vy = prev ? p.y - prev.y : 0;
      targets.current[id] = {
        x: p.x, y: p.y, name: p.name, color: p.color, laser: p.laser, laserColor: p.laserColor,
        // smooth the velocity so a single jittery sample doesn't fling it
        vx: prev ? prev.vx * 0.5 + vx * 0.5 : 0,
        vy: prev ? prev.vy * 0.5 + vy * 0.5 : 0,
      };
      if (!anim.current[id]) anim.current[id] = { x: p.x, y: p.y };
      // Buffer laser-ink positions into a per-peer trail (fades via LaserTrail).
      if (p.ink) {
        const ref = inkRefs.current[id] || (inkRefs.current[id] = { current: [] });
        ref.current.push({ x: p.x, y: p.y, t: Date.now() });
      }
    }
    for (const id of Object.keys(targets.current)) {
      if (!next[id]) { delete targets.current[id]; delete anim.current[id]; delete inkRefs.current[id]; }
    }
    // Re-render when the set OR anyone's laser-ness changes (so the markup
    // swaps between the arrow and the glowing laser dot).
    const key = keys.map((id) => id + (next[id]?.laser ? "!" : "")).sort().join(",");
    if (key !== idsKey.current) { idsKey.current = key; setIds(keys); }
    };
    return subscribe(fold);
  }, [subscribe]);

  // One rAF loop drives every cursor's transform imperatively.
  useEffect(() => {
    let raf;
    const tick = () => {
      const s = 1 / (zoomRef.current || 1);
      for (const id of Object.keys(targets.current)) {
        const t = targets.current[id];
        const a = anim.current[id] || (anim.current[id] = { x: t.x, y: t.y });
        const lx = Math.max(-LEAD_CLAMP, Math.min(LEAD_CLAMP, t.vx * LEAD));
        const ly = Math.max(-LEAD_CLAMP, Math.min(LEAD_CLAMP, t.vy * LEAD));
        a.x += (t.x + lx - a.x) * SMOOTH;
        a.y += (t.y + ly - a.y) * SMOOTH;
        const el = els.current[id];
        if (el) el.style.transform = `translate(${a.x}px, ${a.y}px) scale(${s})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      {/* Each peer's fading laser-ink trail (buffered from their cursor). */}
      {ids.map((id) => {
        const ref = inkRefs.current[id] || (inkRefs.current[id] = { current: [] });
        const t = targets.current[id];
        return <LaserTrail key={`trail-${id}`} pointsRef={ref} color={t?.laserColor || t?.color || "#ef4444"} />;
      })}
      <ViewportPortal>
        {ids.map((id) => {
          const p = targets.current[id] || { color: "#64748b" };
          return (
            <div
              key={id}
              ref={(el) => { if (el) els.current[id] = el; else delete els.current[id]; }}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              transformOrigin: "0 0",
              pointerEvents: "none",
              zIndex: 1000,
              willChange: "transform",
            }}
          >
            {p.laser ? (
              <LaserDot color={p.laserColor || p.color} name={p.name} />
            ) : (
              <>
                <svg width="22" height="22" viewBox="0 0 24 24" style={{ display: "block", filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,.35))" }}>
                  <path d="M5 3 L19.5 11.5 L12.5 12.8 L9.4 19.6 Z" fill={p.color} stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
                {p.name && (
                  <div
                    style={{
                      marginLeft: 15,
                      marginTop: -6,
                      background: p.color,
                      color: "#fff",
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "1px 7px",
                      borderRadius: 7,
                      whiteSpace: "nowrap",
                      boxShadow: "0 1px 3px rgba(0,0,0,.25)",
                    }}
                  >
                    {p.name}
                  </div>
                )}
              </>
            )}
            </div>
          );
        })}
      </ViewportPortal>
    </>
  );
}

// My own laser glow, in SCREEN space, following the OS pointer directly (no
// network round-trip, so it tracks tightly). `active` keeps it mounted +
// tracking the pointer while laser mode is on; `show` reveals the dot only
// while pressing — so it appears instantly at the right spot the moment you
// click (position is already tracked) and hides otherwise.
export function LocalLaser({ active, show, color = "#ef4444" }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!active) return;
    const move = (e) => {
      const el = ref.current;
      if (el) el.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [active]);
  if (!active) return null;
  return (
    <div
      ref={ref}
      style={{
        position: "fixed", left: 0, top: 0, pointerEvents: "none", zIndex: 55,
        willChange: "transform", transform: "translate(-9999px, -9999px)",
        opacity: show ? 1 : 0, transition: "opacity .08s ease",
      }}
    >
      <LaserDot color={color} />
    </div>
  );
}

// A Photoshop-style brush ring that follows the OS pointer in SCREEN space and
// shows the true painted size (brush size in flow units × zoom). Replaces the
// crosshair while the brush is active; greys + matches the brush colour, and
// reads as an eraser outline when erasing.
export function BrushCursor({ active, size, color = "#0ea5e9", erase }) {
  const { zoom } = useViewport();
  const ref = useRef(null);
  useEffect(() => {
    if (!active) return;
    const move = (e) => {
      const el = ref.current;
      if (el) el.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [active]);
  if (!active) return null;
  const d = Math.max(4, size * (zoom || 1));
  return (
    <div
      ref={ref}
      style={{ position: "fixed", left: 0, top: 0, pointerEvents: "none", zIndex: 60, transform: "translate(-9999px, -9999px)" }}
    >
      <div
        style={{
          position: "absolute", left: -d / 2, top: -d / 2, width: d, height: d,
          borderRadius: "50%",
          border: erase ? "1.5px dashed #94a3b8" : `1.5px solid ${color}`,
          boxShadow: "0 0 0 1px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.5)",
        }}
      />
      {/* a centre dot so a tiny brush is still locatable */}
      <div style={{ position: "absolute", left: -1, top: -1, width: 2, height: 2, borderRadius: "50%", background: erase ? "#94a3b8" : color }} />
    </div>
  );
}

// Stacked avatars of everyone else currently on the board.
// Avatar stack of everyone else on the board. Hover an avatar for the name;
// click to FOLLOW that person's viewport (click again to stop). A green dot
// marks who's actively navigating; the followed avatar gets an accent ring.
export function PresenceStack({ members, viewports = {}, followingId, onFollow, dark }) {
  const [hovered, setHovered] = useState(null);
  if (!members?.length) return null;
  const shown = members.slice(0, 6);
  const extra = members.length - shown.length;
  const now = Date.now();
  return (
    <Panel position="top-right" className="flex items-center pointer-events-none">
      <div className="flex items-center -space-x-2 pointer-events-auto">
        {shown.map((m) => {
          const active = viewports[m.id] && now - viewports[m.id].ts < 8000;
          const following = followingId === m.id;
          return (
            <div
              key={m.id}
              className="relative"
              onMouseEnter={() => setHovered(m.id)}
              onMouseLeave={() => setHovered((h) => (h === m.id ? null : h))}
            >
              <button
                type="button"
                onClick={() => onFollow?.(m.id)}
                aria-label={`${m.name || "Guest"} — click to follow`}
                className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-bold border-2 transition-transform hover:scale-110 focus:outline-none ${dark ? "border-[var(--color-surface)]" : "border-white"} ${following ? "ring-2 ring-offset-1 ring-[var(--color-accent)]" : ""}`}
                style={{ background: m.color || "#64748b" }}
              >
                {(m.name || "?").trim().charAt(0).toUpperCase() || "?"}
              </button>
              {active && !following && (
                <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border border-white pointer-events-none" />
              )}
              {hovered === m.id && (
                <div className={`absolute top-full right-0 mt-1.5 whitespace-nowrap rounded-lg px-2 py-1 text-[11px] font-semibold shadow-lg z-10 pointer-events-none ${dark ? "bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)]" : "bg-slate-900 text-white"}`}>
                  {m.name || "Guest"}
                  <span className="opacity-60 font-normal"> · {following ? "following" : "click to follow"}</span>
                </div>
              )}
            </div>
          );
        })}
        {extra > 0 && (
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold border-2 ${dark ? "border-[var(--color-surface)] bg-slate-600 text-white" : "border-white bg-slate-200 text-slate-600"}`}>
            +{extra}
          </div>
        )}
      </div>
    </Panel>
  );
}
