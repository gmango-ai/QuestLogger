# Call Layout Redesign — Implementation Plan

Status: **planning** · Owner: TBD · Created 2026-08-09 · Branch of origin: prototype (uncommitted artifact)

Port the validated interactive prototype of the redesigned video-call layout + control
surface into the real app (`src/components/video/`), **at feature parity, behind a
dark-launch flag, without disrupting the live call**.

- Prototype (design source of truth): the "Stage" call-layout artifact
  (`claude.ai/code/artifact/ad7df589-…`, v14). It is a single self-contained HTML file;
  every layout decision lives in a pure `computeLayout()` and the controls are plain
  state — deliberately structured so the logic ports 1:1 into pure modules here.
- Background / design decisions: see the `call-layout-redesign-prototype` memory.

---

## 1. Guiding principles

1. **Pure-logic-first, with jsdom for the rendered surface.** Tests run under Vitest
   with `environment: "node"` as the **default** (fast, no DOM) — so the *layout brain*
   still lives in **pure functions** we unit-test in node, mirroring the prototype's
   pure `computeLayout`. But jsdom + React Testing Library are now wired in (added
   2026-08-10): any file with a `@vitest-environment jsdom` docblock renders real
   components against a DOM. Use node/pure for layout math and decisions; use jsdom for
   what only shows up in the rendered output (fallbacks, conditional chrome, a11y,
   event handlers). Keep components thin regardless — the pure planner still owns the
   decisions; the jsdom tests just verify they reach the DOM.
2. **The safe seam is `AdaptiveStage` + `layoutSolver` + a new pure planner.**
   `src/components/video/AdaptiveStage.jsx` is already pure/prop-driven and
   `layoutSolver.js` has no external imports. The redesigned layout is a **sibling
   renderer swapped into `Stage`'s return** (`LiveKitCall.jsx` ~line 2487) behind a flag —
   leaving all LiveKit hook wiring, contexts, and `ClusterParticipantTile` untouched.
3. **Preserve two things that keep the call stable:**
   - **`refKey`-stable tile identity** (`identity:source`) — the React `key` that keeps
     `<video>` elements attached across layout changes. The new renderer MUST reuse it.
   - **Focus priority** — `personal pin > admin global pin > screen share > featured
     speaker > fallback` (`Stage`, `LiveKitCall.jsx` ~2340-2383). The new planner must
     reproduce it; it is characterization-tested (below).
4. **Do NOT reimplement the audio cluster.** The prototype's "merge audio with room /
   companion" model was built to mirror `useRoomCluster.js` exactly (leader/mic/sink,
   `pickMicSource`/`pickAudioSink`, the `ATTR_*` attributes). Reuse the existing hook and
   `RoomClusterButton`; only the *new* feedback-detection banner is additive.
5. **Dark-launch behind a flag; old and new render side by side; instant rollback.**
   There is no feature-flag service — use the established Vite-env + `?query` override +
   `PREF` (localStorage) pattern (the retired video-provider A/B test is the precedent).
6. **Lock current behavior with characterization tests BEFORE touching shared code.**
   `bun run build` + `bun run test` are the ONLY CI nets (no typecheck, no lint). Keep the
   characterization tests green through every phase.

---

## 2. Prototype → real-code mapping

| Prototype concept | Where it lands in the real app |
|---|---|
| `computeLayout()` (the layout brain) | **New pure module** `src/components/video/callLayout.js` → `planStage(input) → { rects, sections }`. Unit-tested in node. |
| Grid **auto-becomes Showcase** when someone is pinned | `planStage` grid branch: `pins.length` ⇒ pinned row(s) big on top + grid below. Replaces the manual "Pinned/Showcase" layout mode. |
| **Presentation** = showcase + ONE rail (pinned + divider + pool) | `planStage` presentation branch. Consumes focus + pinned + rest. |
| Multiple **screen shares** as priority items in the pinned rail, swappable | `planStage` share branch; screens (real `Track.Source.ScreenShare` tracks) rank above pinned people. |
| Bare **Fullscreen** toggle + pull-up drawer | Stage-level `fullscreenId` state + a `<FullscreenDrawer>`; the fill-screen theater path already exists (`FloatingParticipants`) as a reference. |
| Tiles **grow in from the right** | Handled by `AdaptiveStage`'s existing transform transition; add an enter transform on newly-shown tiles. |
| "**Everyone else**" cell → roster to pin off-screen people | Reuse the new participants panel (below); the overflow cell opens it. |
| **In-room audio merge** + companion menu + role badges | **Reuse** `useRoomCluster` + `RoomClusterButton` + `clusterRolesOf`. No new logic. |
| **Feedback-detection banner** (NEW; real app has none) | **New pure module** `src/components/video/feedbackDetect.js` + a banner component. See §4. |
| **Settings dialog** (Audio / Video / Effects, Google-style) | New `<CallSettingsDialog>`; reuse existing device pickers, `BackgroundEffects`, Krisp toggle, mirror/fit/float. |
| **Participants right-side panel** (org/guests, status, Pin/Mute, Mute all) | Refactor `PeoplePanel` into a side sheet; reuse `livekitModerate` + `pin_policy` gating. |
| **Reactions** | **Reuse** `EmoteBar` + `EmoteOverlay` (already wired via the `emote` ref bridge). |
| Fullscreen button; ⤢ per tile; Esc | Stage state + control-bar button; reuse `MoreMenu` slot. |

---

## 3. New pure modules (create first, test first)

### 3.1 `src/components/video/callLayout.js` — the layout planner
A pure port of the prototype's `computeLayout`. **No React, no DOM.**

```
planStage({
  mode,            // "grid" | "presentation"
  tiles,           // string keys (refKey) in stable order
  pinned,          // string[] of keys pinned "for everyone"/personally (priority order)
  screens,         // string[] of active screen-share keys (priority, rank above pinned people)
  focusKey,        // the resolved focus (from the existing priority chain)
  speakingKey,     // active speaker key (for surface-into-grid)
  fullscreenKey,   // non-null ⇒ bare fullscreen of this key
  width, height,   // stage px
  gridCap,         // desired cells (auto or 4/6/9/12)
  gap, aspect,
}) => {
  rects: Map<key, {x,y,w,h}>,     // big tiles (reuse solveLayout/bestGrid internally)
  sections: [                      // rails/rows rendered as card strips (not big tiles)
    { role: "pinned"|"rest", items: key[], orient: "v"|"h", region: {x,y,w,h}, divider?: {...} }
  ],
  overflow: key[],                 // "everyone else" set (for the composite cell / roster)
}
```

Reuses `bestGrid`/`solveLayout` for the grid + focus math (already characterization-tested)
so we don't fork that logic. Everything new (auto-showcase-on-pin, single-rail grouping,
screen priority, fullscreen) is a thin arrangement layer on top.

**Tests (`callLayout.test.js`, write alongside the module):**
- grid, no pins ⇒ even grid; `overflow` = tiles beyond `gridCap-1`.
- grid, ≥1 pin ⇒ pinned row region above a grid region; pinned never in `overflow`.
- presentation ⇒ one focus rect + a single `rest` section whose items are `pinned ++ [divider] ++ pool`.
- screens present ⇒ screens sort before pinned people in the section.
- fullscreenKey set ⇒ single rect filling the stage, empty `sections`.
- focus priority honored (screenshare/globalPin/personalPin/featured) — mirror the
  characterization matrix from `rankTiles`.

### 3.2 `src/components/video/feedbackDetect.js` — echo/feedback heuristic (NEW)
The real app has **no acoustic feedback detection** today (confirmed: cluster membership
is asserted manually via the "I'm in this room" toggle / device beacon). This module is a
*design proposal* — a conservative, purely-signal-based heuristic that flags likely echo,
so the UI can prompt "Merge audio with room."

```
detectFeedbackRisk(members, localIdentity, { micMuted }) => {
  atRisk: boolean,
  peers: identity[],   // co-located candidates to name in the banner
  reason: "same-room-unmerged" | null,
}
```

- `members`: LiveKit participants (`{identity, attributes}`), same shape as `useRoomCluster`.
- Heuristic v1 (no audio): risk when **you are unmuted, not in a cluster, and another
  participant advertises the same-room signal** (same `roomDevice` cluster nearby, or a
  future proximity attribute). It intentionally reuses `ATTR_CLUSTER`/`ATTR_ROOM_DEVICE`
  so it composes with `useRoomCluster` and never fires once you've merged.
- Extensible seam for a later audio-correlation detector, but v1 ships zero audio work.

**Tests (`feedbackDetect.test.js`):** unmuted + co-located peer + not merged ⇒ atRisk with
peers listed; muted ⇒ not at risk; already in cluster ⇒ not at risk; solo ⇒ not at risk.

---

## 4. Flag scaffold (Phase 0, zero behavior change)

`src/components/video/layoutFlag.js`:
```js
const FORCE = (import.meta.env.VITE_LAYOUT_V2 || "").toLowerCase();   // "1"|"on" to force new
function urlOverride() {
  return new URLSearchParams(location.search).get("layout")?.toLowerCase() || ""; // ?layout=v2|v1
}
export function useLayoutV2(roomId) {
  // precedence: URL override > env force > per-device PREF opt-in > deterministic roomId bucket (0% at first)
}
```
- Layer 1: `?layout=v2` / `?layout=v1` URL override (dev + support).
- Layer 2: `VITE_LAYOUT_V2` env force (staging/preview).
- Layer 3: a `PREF.layoutV2` per-device opt-in via `callPrefs.js` (`loadPref`/`savePref`),
  with a one-time-reset guard exactly like the existing `ql_lk_layout_reset_grid` idiom.
- Layer 4 (rollout): deterministic `hash(roomId) % 100 < ROLL_PCT`, starting at 0.

`Stage` renders `useLayoutV2(roomId) ? <AdaptiveStageV2 …/> : <AdaptiveStage …/>`. Default = old.

---

## 5. Phased plan

Each phase is independently shippable and revertible (flag off ⇒ old path).

### Phase 0 — Safety net (this deliverable + flag)
- **Done:** characterization tests locking `bestGrid`, `solveLayout`, `rankTiles`, `capFor`
  (`layoutSolver.test.js`, `tileChrome.rank.test.js`). Existing `audioGate.test.js` already
  locks `pickMicSource`/`pickAudioSink`/`clusterRolesOf`, and `tileChrome.grid.test.js`
  locks `orderTilesStable`/`surfaceOverflowSpeakers`.
- **Done:** jsdom + React Testing Library wired in so we can test *rendered* components,
  not just pure logic. Added `jsdom`, `@testing-library/react`, `@testing-library/dom`
  (devDeps); `vitest.config.js` now sets `esbuild.jsx: "automatic"` (so JSX renders
  without an explicit React import) and includes `src/**/*.test.jsx`; node stays the
  default env, jsdom is opted into per-file via a `@vitest-environment jsdom` docblock.
  First jsdom test: `tileChrome.dom.test.jsx` (camera-off initial/photo + error
  fallback, `(You)` self-suffix, mic-off icon, connection-dot tooltip).
- Add `layoutFlag.js` (no-op default). No UI change.
- **Verify:** `bun run test` green (356 tests, 36 files), `bun run build` clean.
- **Rollback:** delete the flag file; nothing else touched.

### Phase 1 — Pure planner
- Write `callLayout.js` (`planStage`) + `callLayout.test.js`. Not wired to any UI.
- **Verify:** unit tests green; `bun run build` clean (unused export is fine).
- **Rollback:** delete module; no consumers.

### Phase 2 — `AdaptiveStageV2` renderer (flag-gated)
- New `AdaptiveStageV2.jsx`: consumes `planStage` output; absolutely-positions tiles at
  their rects with the same transform transition + `key={refKey}` as `AdaptiveStage`;
  renders card-strip sections. Reuse `ClusterParticipantTile` verbatim for tile content.
- Wire into `Stage` behind `useLayoutV2`. Implement **Grid (auto-Showcase-on-pin)** and
  **Presentation (single rail)** first.
- **Verify:** flip `?layout=v2`, click-through grid ↔ presentation, pin/unpin, active-speaker
  surface, join/leave glide; `?layout=v1` still identical to today. Manual QA checklist §6.
- **Rollback:** flag off.

### Phase 3 — Fullscreen + drawer + multi-screen
- Stage `fullscreenId` state + `<FullscreenDrawer>` (screens + participants); map to real
  screen-share tracks; screen-priority in the pinned rail; ⤢ per tile + control-bar toggle.
- **Verify:** share 1–3 screens, swap showcase, fullscreen a screen/camera, drawer switch, Esc.
- **Rollback:** flag off (v2 only).

### Phase 4 — Settings dialog + participants panel + reactions
- `<CallSettingsDialog>` (Audio/Video/Effects tabs) reusing existing device pickers +
  `BackgroundEffects` + Krisp + mirror/fit/float. Opened from mic/cam carets.
- Refactor `PeoplePanel` → right-side sheet with org/guests grouping, status line,
  per-row Pin/Mute (existing `livekitModerate` + `pin_policy` gating) + Mute all.
- Reactions: reuse `EmoteBar`/`EmoteOverlay` unchanged.
- **Verify:** device switching, effects preview, moderation actions still hit
  `livekit-moderate` and remain leader/`pin_policy` gated; guests/org split renders.
- **Rollback:** these can ship to BOTH layouts (they're control-surface, not stage) — gate
  each independently so they don't block the stage rollout.

### Phase 5 — In-room audio UX + feedback banner
- Reuse `useRoomCluster` for the companion menu/badges (already the prototype's model).
- Add `feedbackDetect.js` + banner (from §3.2), wired to `useCluster().members`.
- **Verify:** banner appears only for the unmerged-unmuted-co-located case; "Merge" calls
  the existing `joinRoom`/`startRoom`; dismiss works; never fires once merged.
- **Rollback:** banner is additive; hide behind its own sub-flag if noisy.

### Phase 6 — Rollout & cleanup
- Internal opt-in (PREF) → staging env force → `ROLL_PCT` 10→50→100 via roomId hash →
  flip default → **remove old `AdaptiveStage` path + flag** once stable for N days.
- Keep all characterization tests; retire any that only described the deleted path.

---

## 6. Test strategy

**Two layers now: pure node tests for the layout brain, jsdom tests for the rendered
surface — plus build + manual QA.**

1. **Characterization tests (regression net) — DONE / to keep green:**
   - `layoutSolver.test.js` (new): `bestGrid` degeneracy, cell-fits-box, ~16:9, cols choice,
     area-monotonic; `solveLayout` empty/zero, one-rect-per-tile, focus area, dual-focus
     precedence, lone-focus fill, ignores-missing-focus.
   - `tileChrome.rank.test.js` (new): `rankTiles` full tier order (screenshare > globalPin >
     pinnedTrackKey > featured/speaking > cam-on > cam-off), speaker-as-featured, stable +
     non-mutating; `capFor` non-positive→99, grows-with-space, respects min-width.
   - `tileChrome.dom.test.jsx` (new, **jsdom**): renders `CameraOffAvatar` +
     `TileNamePill` — initial vs photo, image-error fallback, `(You)` self-suffix,
     mic-off icon presence, weak/lost connection-dot tooltip.
   - `tileChrome.grid.test.js` (existing): `orderTilesStable` + `surfaceOverflowSpeakers`.
   - `audioGate.test.js` (existing): `pickMicSource` / `pickAudioSink` / `clusterRolesOf` +
     `computeMicLive` / `shouldHearRoomAudio`.
2. **New pure-module tests:** `callLayout.test.js`, `feedbackDetect.test.js` (specs in §3).
3. **Component/DOM tests (jsdom):** `AdaptiveStageV2` and the new control surfaces get
   `*.dom.test.jsx` files — add the `@vitest-environment jsdom` docblock, import
   `render`/`screen`/`fireEvent`/`cleanup` from `@testing-library/react`, `afterEach(cleanup)`
   (RTL auto-cleanup is off because Vitest globals are off). What to assert: a11y roles are
   flaky for decorative nodes (`alt=""` imgs have no `img` role — query the element), so
   assert on visible text + `container.querySelector` for chrome. Layout-measuring
   components (`AdaptiveStage`/`V2`) read `ResizeObserver`/`clientWidth` — jsdom reports 0,
   so pass explicit sizes / stub `ResizeObserver` when you need positioned tiles; otherwise
   keep sizing in the pure planner and test *that*.
4. **Component seam:** components stay thin and delegate to the pure modules; a `vi.mock`
   of `@livekit/components-react` + `livekit-client` is required for any test that imports
   a module pulling those in at top-level (see the header of `tileChrome.rank.test.js` /
   `tileChrome.dom.test.jsx`).
5. **Integration net:** `bun run build` catches import/JSX/syntax breaks (the only build
   gate — no tsc/lint). Run before every merge.
6. **Manual QA checklist (per phase), run in a real call with `?layout=v2`:**
   grid ↔ presentation switch · pin/unpin (personal + global) · active-speaker surfacing ·
   join/leave glide · screen share (1 and multi) · fullscreen toggle + drawer + Esc ·
   settings (mic/cam/speaker switch, blur/bg, mirror/fit/float) · reactions float ·
   people panel (org/guests, status, pin, mute, mute-all, moderation gating) · in-room
   merge + role badges + feedback banner · **and `?layout=v1` unchanged** each time.

---

## 7. Risks & mitigations

- **`<video>` re-attach flicker** → new renderer MUST keep `key={refKey}`; covered by manual QA.
- **Focus-priority drift** → planner reproduces the chain; guarded by `rankTiles` + new
  `callLayout` tests.
- **Audio cluster is subtle** → do NOT touch `useRoomCluster`; only add the additive banner.
  `audioGate.test.js` remains the guard.
- **142 KB `LiveKitCall.jsx`** → extract into modules incrementally; the stage swap is a
  one-line branch, control-surface pieces are new files — minimize churn in the giant file.
- **Perf of absolute-positioned transitions** → reuse `AdaptiveStage`'s proven approach.
- **No CI typecheck/lint** → rely on tests + build; keep logic pure so it's testable.

## 8. Rollback & cleanup
Flag off → old renderer, instantly. Each phase reverts independently. Final cleanup (Phase
6) removes the old `AdaptiveStage` branch and the flag once the new path is default-stable.

---

## Appendix — current pure APIs (verified 2026-08-09)

- `layoutSolver.bestGrid(n,w,h,aspect,gap) → {cols,tileW,tileH,area}` (pure).
- `layoutSolver.solveLayout({tiles,focusKey,focusKeys,width,height,gap,aspect,ratios}) → Map<key,{x,y,w,h}>` (pure).
- `tileChrome.rankTiles(tracks,{featuredId,speaking[],globalPinId,pinnedTrackKey}) → track[]` (pure; `speaking` is a participant array).
- `tileChrome.orderTilesStable(tracks,{globalPinId,pinnedTrackKey,sortBy}) → track[]` (pure; no speaking tier).
- `tileChrome.surfaceOverflowSpeakers(visible,overflow,{speakingIds:Set,…}) → track[]` (pure).
- `tileChrome.capFor(w,h,minW,aspect,gap) → int` (pure).
- `useRoomCluster.pickMicSource(members) → identity|null`, `.pickAudioSink(members,micId) → identity|null`,
  `.clusterRolesOf(participants) → Map<identity,{inRoom,isMicSource,isAudioSink,isDevice}>` (pure).
- Attributes: `cluster`, `clusterLeaderId`, `speakerOverride` (`"manual"` | ms-timestamp | ``), `roomDevice="1"`, `clusterSink`, `clusterSinkOff="1"`.
- Moderation: `livekitModerate.{kickFromCall,muteParticipantTrack,setRoomPin,clearRoomPin}` (server-enforced; client gate `isHost && !isSelf` / `canPin` from `pin_policy`).
- Commands: `bun run test` (vitest), `bun run build` (vite). No typecheck/lint.
