# Whiteboard local-first + CRDT (Yjs) — design & spike plan

**Status:** proposed · **Owner:** Jacob · **Created:** 2026-08-02 · **Prereq:** builds on `whiteboard-realtime-hardening.md` (single-writer persistence, already shipped)

## Context & goals

The retro brownout is already fixed (single-writer persistence + dropped realtime WAL tax + call resilience). This is the **next tier**. All four goals were requested, and one architecture delivers all four:

1. **Further cut DB cost/load** — persist/transmit **deltas**, not whole-board snapshots.
2. **Scale to bigger teams/boards** — incremental updates instead of O(board) per edit.
3. **True conflict-free editing** — concurrent edits to the *same* element never stomp; offline edits merge on reconnect.
4. **Offline + instant load** — boards open instantly from a local cache and keep working with no/flaky connection.

Today's model is **last-write-wins**: live edits broadcast per-entity `ops` (merged by id — so different elements don't stomp, but the *same* element does), the persister writes the **whole `{nodes,edges}` snapshot**, board content is **fetched from the DB on every open** (no local cache), and there is **no offline / reconnect reconciliation**. That's the right model for what it is; these four goals need a CRDT + local-first layer.

## Recommendation: Yjs over the existing Supabase broadcast channel

A **CRDT** is the only thing that gives real "auto conflict management." **Yjs** is the mature standard, and — critically — it maps onto infrastructure we already have:

- **Conflict-free merge** (goal 3): Yjs resolves concurrent edits deterministically, including same-object edits, with no server coordination.
- **Binary deltas** (goals 1+2): Yjs updates are small incremental byte payloads — "chunks, not lines" — and they ride the **existing `wb:<boardId>` Supabase broadcast channel** via a thin custom provider (replaces the hand-rolled `ops`/`sync`/`sync-req` events). No new backend.
- **Local cache** (goal 4): **`y-indexeddb`** persists the doc locally → instant load + offline editing + refresh survival, with zero backend work.
- **Durability**: keep a **single-writer periodic snapshot** of the Yjs doc to the DB (reuse the `isPersister` election we just built). Cold-load reads that snapshot when no peers are present.

**Build vs adopt:** self-hosting Yjs over Supabase broadcast reuses our stack and adds no vendor. If the self-hosted transport proves fragile at scale (see risks), the fallback is a hosted CRDT (Liveblocks / y-sweet / PartyKit) — same Yjs data model, different transport, but a new vendor + cost + data leaving Supabase. **Recommend self-host first; the spike de-risks it.**

## Target architecture

```
        ┌──────────────── each client ────────────────┐
        │  xyflow nodes/edges (React state)            │
        │        ▲  observe            │ onNodesChange │
        │        │                     ▼               │
        │     ─── Y.Doc (board CRDT) ───               │
        │      /        │            \                 │
        │ y-indexeddb   │        awareness             │  cursors / selection /
        │ (local cache) │      (y-protocols)           │  viewport / presence
        │               ▼                              │
        │    Supabase broadcast provider  ◄────────────┼──► peers (wb:<id> channel)
        │               │ (single-writer)              │
        └───────────────┼──────────────────────────────┘
                        ▼
             whiteboards.yjs_state  (periodic snapshot, DB durability)
```

## Data model (Yjs doc ↔ xyflow)

- One **`Y.Doc` per board**. Structure:
  - `nodes: Y.Map<nodeId → Y.Map>` — each node's **shared** props (position, size, data/text, style, z, parent). A `Y.Map` per node so two people editing *different* props of the same node both land.
  - `edges: Y.Map<edgeId → Y.Map>` — shared edge props (endpoints, waypoints, style).
  - Z-order: a **fractional index** field (or a `Y.Array<id>`) so reorders are conflict-free.
- **Transient per-session fields stay in local React state, NEVER in Yjs**: `selected`, `dragging`, `resizing` (already stripped by `stripLocal` today) — plus hover/edit-focus. Selection/drag are *awareness*, not shared graph.
- **xyflow binding** (the main technical work): a two-way bridge — observe the Y.Doc → `setNodes/setEdges`; `onNodesChange/onEdgesChange` → mutate the Y.Doc inside a transaction. Debounce position writes during a drag to one transaction on drag-end (or throttle) so a drag isn't thousands of tiny updates.

## What replaces what (component change map)

| Today | Under Yjs |
|---|---|
| `useWhiteboardSync.js` `ops`/`sync`/`sync-req` events + `applyOps` id-merge | Yjs update messages over a **`SupabaseBroadcastProvider`**; delete the hand-rolled op merge |
| `cursor`/`viewport`/`presence` events, `CollabCursors`, presence roster | **`y-protocols/awareness`** over the channel (cursors, selection, viewport, presence, laser) |
| `useWhiteboardPersistence` full-snapshot save | Single-writer **Yjs snapshot** save (`Y.encodeStateAsUpdateV2`) on the same idle/checkpoint cadence; keep the `isPersister` election, backoff, flush |
| `useWhiteboardHistory` (custom undo/redo) | **`Y.UndoManager`** (scoped to your own edits — better for multiplayer). Raster undo already separate — keep it |
| `wbStorage` viewport cache | Augment with **`y-indexeddb`** for full board state |
| **Raster paint** (`PaintLayer`, `paintTiles.js`, `paint`/`paintpatch` events, Storage tiles) | **UNCHANGED** — pixels don't belong in a CRDT; it already syncs via its own ephemeral events + Storage tiles. Leave it out of the Y.Doc |

Features that must keep working (verify in the real build, not the spike): edges + A* routing (`edges.jsx`/`routing.js`), frames (`frame.js`), snapping, shape recognition (`wbShapeRecognition`), images (Storage-backed nodes), clipboard, palm rejection, keyboard, inspector, templates.

## Persistence, cold-load & migration

- **New column** `whiteboards.yjs_state bytea` (or a Storage object `yjs/<board>.bin` if docs get large; or an append-only `whiteboard_updates` table if we want server-side history). **Decision needed** (see open questions).
- **Write**: the single writer snapshots the doc on the idle/checkpoint cadence we built. This is a delta/compacted state, not the whole JSON — smaller writes (goals 1+2).
- **Cold-load order**: `y-indexeddb` (instant, local) → if empty, the DB `yjs_state` snapshot → then peer sync (Yjs state-vector exchange catches up to live). If no peers and no snapshot, seed empty.
- **Migration of existing boards** (200+ exist with `{nodes,edges}` JSON): on first open under the new path, **seed a fresh Y.Doc from the JSON snapshot**, then write `yjs_state` going forward. Lazy (no big backfill). Keep the JSON `snapshot` column populated by a periodic export for back-compat / server-side reads (list cards, room tiles) until everything reads Yjs. **Dual-write during transition.**

## Offline & instant load

- `y-indexeddb` loads the last local doc instantly (no DB round-trip) → board is interactive immediately.
- Edits while offline mutate the local doc; on reconnect the provider exchanges state vectors and **Yjs merges both directions** with no stomping (goal 4 + 3).
- Awareness (cursors) simply drops offline peers via its timeout.

## The SPIKE (bounded PoC — validate before committing)

Behind a `?crdt=1` flag (or a feature flag) on **one** board, implement the **thin vertical slice**, not feature parity:

- A `Y.Doc` with just `nodes` as sticky-notes (text + position), `y-indexeddb`, a minimal `SupabaseBroadcastProvider` (send/apply `Y.Update`, initial sync via state vectors), and `awareness` for cursors.
- A minimal xyflow binding for those sticky nodes (observe → setNodes; drag/edit → Y transaction).
- The single-writer Yjs snapshot to a throwaway `yjs_state` (or scratch table).

**Success criteria (measure + demo):**
1. Two tabs edit the **same** sticky's text at once → both converge, no stomp. (LWW today would stomp.)
2. Tab goes offline, edits, comes back → merges cleanly.
3. Reload with network off → board loads instantly from IndexedDB.
4. Single-writer snapshot round-trips: close all tabs, reopen cold → state restored from the DB snapshot.
5. **Numbers**: update payload sizes (expect small deltas), DB write frequency (expect ≪ full-snapshot), and Yjs bundle size added to the whiteboard chunk.
6. Broadcast transport holds: confirm initial-sync + steady-state updates fit under the Supabase broadcast **payload size limit** (verify the limit; chunk or fetch-snapshot-from-DB if a big initial sync exceeds it).

**Explicitly NOT in the spike:** edges/routing, images, paint, undo, full feature parity, migration of real boards. Those are the real build, only if the spike passes.

## Risks & mitigations

- **xyflow ↔ Yjs binding is the main technical risk** — keeping transient fields local, debouncing drag writes, avoiding echo loops (apply-remote must not re-emit local ops). Mitigate: prove it in the spike on sticky notes first; use transaction origins to distinguish local vs remote.
- **Supabase broadcast payload limits** — a large initial sync may exceed the per-message cap. Mitigate: load initial state from the DB snapshot + only *deltas* over broadcast; chunk large updates. Verify the actual limit early.
- **Big-bang risk across a large feature surface** — do NOT rewrite everything at once. Phase behind a flag; keep the old path until parity is proven.
- **Migration correctness** for existing boards — lazy seed + dual-write + a migration test on a copy of a real (dense) board.
- **Doc growth / GC** — Yjs history grows; use `encodeStateAsUpdateV2` + periodic compaction; store a compacted snapshot, not the full update log, in the DB.
- **Bundle size** — Yjs + providers are tens of KB; lazy-load with the already-lazy whiteboard chunk.
- **Undo semantics change** — `Y.UndoManager` undoes only your edits (usually desirable, but a behavior change); validate with users.
- **Raster paint stays separate** — do not try to CRDT pixels; keep the Storage-tile model.

## Sequencing / phases

1. **Spike** (above) — feasibility + numbers + the broadcast-limit answer. *Go/no-go gate.*
2. **Core binding** — full node/edge Y.Doc model + xyflow two-way binding + awareness (retire `ops`/`cursor`/`viewport`/`presence`). Behind the flag.
3. **Persistence + migration** — `yjs_state`, single-writer snapshot, lazy seed from JSON, dual-write JSON for back-compat reads.
4. **Undo** via `Y.UndoManager`; keep raster paint as-is; feature-parity pass (edges/routing/images/shapes/clipboard/frames).
5. **Cutover** — dogfood behind flag → default on → delete the old sync/persistence path + the JSON dual-write once all readers use Yjs.

## Open decisions (need your call)

1. **Transport**: self-host Yjs over Supabase broadcast (recommended, no vendor) vs a hosted CRDT (Liveblocks / y-sweet / PartyKit — less infra, but cost + a vendor + data leaves Supabase).
2. **Snapshot storage**: `whiteboards.yjs_state bytea` (simple) vs a Storage object (better for large docs) vs an append-only `whiteboard_updates` table (server-side history, more infra).
3. **Keep the `{nodes,edges}` JSON** as an export/back-compat format indefinitely, or fully replace once all readers move to Yjs?

## Spike results (built 2026-08-02/03) — GO

Built at `/spike/crdt/:boardId?` (public route, no login) — sticky notes on a Y.Doc:
`src/pages/CrdtSpikePage.jsx`, `src/spike/crdtProvider.js` (Yjs over Supabase
broadcast + awareness), `src/spike/crdtSnapshot.js`, `src/spike/crdtTextBinding.js`.
Verified live in two Chrome tabs:

- ✅ **Conflict-free same-element editing (goal 3)** — the headline. Tab1 went
  OFFLINE and prepended `"A:"` while tab2 (online) appended `" :B"` to the SAME
  note; on reconnect BOTH tabs converged to **`"A:New note :B"`** — both edits
  preserved (LWW would have dropped one). This is the whole reason to adopt a CRDT.
- ✅ **Offline → reconnect merge (goal 4)** — same test; the offline edit merged in
  cleanly via the Yjs state-vector handshake over the broadcast channel.
- ✅ **Instant local load (goal 4)** — y-indexeddb loads in **6–7ms**.
- ✅ **Yjs over the existing Supabase broadcast channel** — cross-tab doc sync worked
  with no new backend; **small deltas** (join handshake ~84B, add-node ~76B, edits
  in the low hundreds of bytes — goals 1+2).
- ✅ **Single-writer election reused** — the lowest-clientID tab was the snapshot
  writer; the other correctly showed "another".

**One real gotcha found (important for the real build):** putting a `Y.Text` (which
holds circular refs back to the doc) directly in a React Flow `node.data` **breaks
React Flow v12** — the node silently never renders. Fix: keep `node.data` PLAIN
(just the id) and resolve the CRDT type in the node component via context. The real
xyflow↔Yjs binding must follow this rule everywhere.

**Not covered / caveats:**
- **DB snapshot cold-load** unverified here (the public route is unauthed, so the
  Storage snapshot is a no-op) — re-test logged-in.
- **Awareness peer-count converges only on activity** — the simplified provider
  doesn't do the full awareness query/reply handshake, so a just-joined peer shows
  `peers: 0` until someone moves. The real build should use the standard awareness
  protocol messages.
- **Broadcast payload limit** not stress-tested — small updates are fine; a large
  initial sync must come from the DB snapshot, not broadcast (as the plan says).

**Recommendation: GO** — the risky hypotheses (CRDT-over-our-broadcast, offline
merge, instant load, the xyflow binding) all hold. Proceed to Phase 2 (full
node/edge binding + awareness protocol) per the sequencing above. Spike code is
isolated behind `/spike/crdt` and touches no production whiteboard code.

## Verification (for the real build)

- **Convergence**: scripted multi-client tests — concurrent same-node edits, offline→online reconnect, N-editor fan-in — assert all clients converge to the same doc.
- **Migration**: seed a Y.Doc from a copy of a real dense board; assert round-trip fidelity vs the JSON snapshot.
- **Load**: adapt `scripts/wb-loadtest.mjs` to drive Yjs updates over the channel; confirm DB writes ≪ today and no statement timeouts under retro-scale load.
- **Offline**: airplane-mode edit → reconnect → merged; cold reload with network off → loads from IndexedDB.
- **Bundle**: confirm the added Yjs weight is lazy-loaded and acceptable.
- **Feature parity**: the full whiteboard feature checklist (edges/routing, images, paint, shapes, frames, clipboard, undo) passes behind the flag before cutover.
