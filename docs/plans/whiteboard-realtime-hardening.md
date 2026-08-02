# Whiteboard realtime hardening + call resilience

**Status:** planned · **Owner:** Jacob · **Created:** 2026-08-01

## Context

During the 2026-07-31 weekly retro the whole team edited one shared whiteboard
at once. That is legitimate, desirable load — but it browned out the (Micro)
database and cascaded into the video call, ejecting people with no way to rejoin.

Evidence (from Supabase logs, incident window 2026-07-31 20:45–20:50 UTC):
- **216 `PATCH /whiteboards` to a single board** (`7c875697…`) in ~5 min — 108× HTTP 504 + 108× HTTP 500.
- **128× Postgres `57014` "canceling statement due to statement timeout".**
- Cascade: the call's lifeline queries timed out — `sync_session_participants` (76× 504), `heartbeat_sync_session`, `sync_sessions`, `user_presence`, `sync_tick_if_due`.
- Result: `syncSession` went null → the carry-over effect called `endCall("sync-session-room-cleared")` on a media-healthy call (`PersistentVideoCall.jsx:154`); the minute-cron `sweep_abandoned_sync_sessions` hard-deletes a session on a 120s heartbeat gap and NULLs the room invite code, so rejoin returned "Session not found"; and the persisted `ql_active_call` marker is only read at provider mount, so no in-session auto-rejoin fired.

### Root cause, precisely
1. **Trigger:** the persistence layer scales with load. Every client independently writes the **entire board snapshot** every 1.2s (`useWhiteboardPersistence.js:96-123`) plus a ~120KB base64 thumbnail — so N editors = N × full-board writes to one row. On failure the saver re-sends the whole board on the next keystroke (no backoff/cap).
2. **Amplifier:** `whiteboards` has `replica identity full` **and** is in the `supabase_realtime` publication, but nothing subscribes (collab uses broadcast, not `postgres_changes`) — so every write pays 2–3× its size in WAL + logical decode for nothing.
3. **Blast radius:** the call is coupled to the sync-session row and tears down / can't rejoin the moment that row looks gone.

### What is already efficient (do NOT change)
Live collaboration rides a Supabase **broadcast** channel (`wb:${boardId}`, `useWhiteboardSync.js`) sending **diffs** (`ops`, `cursor`, `viewport`, `paint`). Broadcast is ephemeral — it never touches Postgres. New joiners get initial state peer-to-peer via `sync-req`, already answered by a single client (lowest client-id, `useWhiteboardSync.js:203-207`). **Realtime interaction is not the problem and stays exactly as-is.**

## Goals / Non-goals

**Goals**
- Keep realtime multi-user editing identical (everyone sees everyone write, live).
- Make concurrent persistence cost ~O(1) instead of O(editors × board size × frequency).
- Ensure a DB/network hiccup can never again eject the whole team from a call.

**Non-goals**
- Changing the broadcast/live-editing protocol.
- Op-based/CRDT persistence (listed as a future option, not required now).
- Relying on the compute upgrade as the fix (it's headroom; the fix is architectural).

## Baseline → target (metrics to beat)

| Metric (12-person retro) | Today (measured) | Target |
|---|---|---|
| `PATCH /whiteboards` writers | N (all editors) | **1** (elected persister) |
| `PATCH /whiteboards` / min on one board | ~40+ (216 / 5 min) | **≤ ~6** (1 writer, idle-based) |
| Per-write payload | full snapshot + ~120KB thumbnail on row | snapshot only; thumbnail in Storage |
| Postgres `57014` during retro | 128 | **0** |
| Call ejections during retro | ≥1 | **0** |

---

## Workstreams

Each change is independent and shippable on its own. Order in "Ship plan" below.

### WS1 — DB: drop the dead realtime publication + replica identity  *(safe, DB-only, biggest per-write win)*
- **New migration** `supabase/migrations/2026XXXXXXXXXX_whiteboards_drop_realtime_publication.sql`:
  ```sql
  alter publication supabase_realtime drop table public.whiteboards;
  alter table public.whiteboards replica identity default;
  ```
- Rationale: nothing subscribes to `whiteboards` via `postgres_changes` (grep-confirmed; collab is broadcast). Removes full-old+new-row WAL + logical decode on every write.
- **Apply via MCP `apply_migration`** (not `db push` — unreliable on this shared multi-branch DB; see memory). Never edit an already-applied migration; this is a new timestamped file.
- **Acceptance:** `select * from pg_publication_tables where pubname='supabase_realtime' and tablename='whiteboards'` returns 0 rows; `select relreplident from pg_class where relname='whiteboards'` = `d`. No app behavior change.

### WS2 — Single-writer persistence  *(the core fix)*
- **`useWhiteboardSync.js`**: expose an `isPersister` boolean. The persister = the client whose `meId.current` is the min of `{ meId } ∪ members.ids` (reuse the exact election already used for `sync-req` at `:203-207`). Recompute on every `presence:sync`. Return it alongside `members`.
- **`useWhiteboardPersistence.js`**: accept `canPersist` (= `isPersister && !readOnly`). In the debounced save effect (`:96-123`) and the `beforeunload`/unmount flush (`:132-149`), **only call `saveSnapshot`/thumbnail when `canPersist`**. Non-persisters still track `nodes/edges` (for local + broadcast) but issue **zero** DB writes.
- **`WhiteboardPage.jsx`**: thread `isPersister` from `useWhiteboardSync` (`:663`) into `useWhiteboardPersistence` (`:1399`).
- **Leader handoff:** when the persister leaves, `presence:sync` fires on remaining clients → a new min → new persister. It already holds full state (received all ops). Force a checkpoint shortly after becoming persister (mark dirty / run the save once) so the DB reflects recent edits.
- **Edge cases to handle:** (a) solo editor is always the persister (min of a 1-set is self) — normal single-user save preserved; (b) `enabled === false`/embedded/non-synced boards keep today's behavior (treat as persister); (c) a brief no-persister window during handoff is acceptable — state lives in every client + broadcast.
- **Acceptance:** with 3 browser tabs on one board, only ONE issues `PATCH /whiteboards` (verify via a temporary `[wb-persist]` console log + network panel); close that tab → another tab takes over within one presence tick and its edits persist.

### WS3 — Idle-based checkpoint cadence  *(fewer writes from the one writer)*
- **`useWhiteboardPersistence.js`**: raise `SAVE_DEBOUNCE_MS` (1200 → e.g. 4000) and add a **max-wait checkpoint** (force a save at most every ~15s of continuous editing) so long sessions still checkpoint without per-burst writes. Always flush on last-participant-leave / unmount (persister only).
- Rationale: realtime is broadcast-driven; the DB snapshot only needs to be fresh enough for cold-load when no peers are present.
- **Acceptance:** during continuous editing, the persister writes on the order of once per several seconds, not per 1.2s burst; final state after everyone stops is correct on reload.

### WS4 — Thumbnail off the hot row → Storage  *(smaller writes, decoupled from content)*
- Reuse the existing **`whiteboard-images`** bucket (`20260622130000_whiteboard_images_bucket.sql`; public, 8MB, jpeg/png/webp). Write the preview to `thumb/<boardId>.jpg`.
- **`WhiteboardPage.jsx`** (`scheduleThumbnail`/`generateThumbnail` ~`:2567-2604`): generate + upload **persister-only**, on **idle/blur** (not 5s after every save). Store the returned public URL.
- **DB:** the `whiteboards.thumbnail` column becomes the Storage URL (short text), not a ~120KB data URL. Card render (`whiteboard-invite-only` thumbnails) reads the URL — verify the card component handles a URL (it already renders a data URL `src`; a Storage URL works the same). New migration only if a column comment/type change is wanted (text already holds a URL — no schema change needed).
- **Acceptance:** a save writes only the snapshot to the row; the thumbnail is a small URL; cards still show previews; no ~120KB blobs in `PATCH /whiteboards`.

### WS5 — Retry cap + backoff on save  *(kill the self-amplifier)*
- **`useWhiteboardPersistence.js`**: on `saveSnapshot` error, apply exponential backoff and a max-consecutive-failure cutoff; surface a non-blocking "offline — will retry" state instead of re-firing the full write on the next keystroke. Pause the thumbnail upload while content saves are failing. Gate the `beforeunload` flush so it doesn't pile onto a saturated DB.
- **Acceptance:** with the network throttled/failing, a single persister does not exceed a bounded retry rate (no per-keystroke re-send); it recovers and saves once writes succeed.

### WS6 — Realtime trims  *(optional; reduces Realtime bandwidth/CPU, not DB)*
- **`useWhiteboardSync.js`**: throttle `viewport` broadcasts the way `cursor` already is (`pushCursor` trailing throttle ~`:267`+); confirm `ops` stay diff-only. `sync-req` is already single-responder — leave it.
- **Acceptance:** cursor/viewport broadcast rate is capped (~20–30/s max) under vigorous panning; no functional change.

### WS7 — Companion: call-side resilience  *(cheap insurance; the actual thing that ejected the team)*
Even after WS1–WS5 remove this trigger, keep any future DB/network blip from dropping the whole meeting:
- **`PersistentVideoCall.jsx`** (`:112-158`, the carry-over effect): when `curRoom` becomes null, **do not `endCall` while `Room.state === 'connected'`.** Treat session loss as advisory — try `start_or_join_room_session` for `call.roomId` and keep the call. Only hard-end on explicit user leave or a confirmed LiveKit `onDisconnected`.
- **`sweep_abandoned_sync_sessions`** (new migration superseding `20260618150000`): (a) skip sessions whose room still has LiveKit-connected participants (consult LiveKit or a webhook-maintained count); (b) widen grace 120s → ≥5min (match the presence sweep already raised in `20260709235727`); (c) **soft-end** (`status='ended'` + short retention) instead of hard DELETE; (d) keep `invite_code` until LiveKit confirms empty.
- **`SyncSessionContext.jsx`** (`onVisible`, ~`:339`): call `heartbeatSyncSession` **before** rehydrate so a foregrounded healthy call re-stamps liveness immediately.
- **In-session auto-rejoin** (`VideoCallContext.jsx`): consume the `ql_active_call` marker on a reconnect/`resume`/`visibilitychange` watcher (not only at mount) with bounded backoff.
- **Security (fold in):** `revoke execute on function sweep_abandoned_sync_sessions, reconcile_room_session from anon, authenticated;` (currently callable by anyone).
- **Acceptance:** see Verification §C.

---

## Ship plan (order)

1. **WS1** (migration) + **WS2** (single-writer) — together kill the brownout. Ship first.
2. **WS3** + **WS5** — cadence + retry safety (same PR as WS2 or immediately after).
3. **WS4** — thumbnail → Storage.
4. **WS7** — call-side resilience + sweep + security (separate PR; DB migration + client).
5. **WS6** — realtime trims (nice-to-have).

Branch off `staging`. Each PR: `npm run build` + `npm test` green before merge.

---

## Verification & testing

Three layers: **unit/correctness**, **load/resource (proves the root fix)**, and the **real retro** as the final proof.

### A. Correctness (per change; local, 2–3 browser tabs)
1. **Single-writer (WS2):** open one board in 3 tabs (or 3 profiles). Add a temporary `console.info('[wb-persist] save by', meId, 'isPersister', isPersister)` in the save path. Edit from every tab. **Expect:** only ONE tab logs saves + issues `PATCH /whiteboards` (Network panel); all tabs see all edits live. Close the persister tab → a different tab starts saving within one presence tick; reload a fresh tab → latest edits are present (handoff didn't lose data).
2. **Realtime unchanged:** in the multi-tab test, type in each tab and confirm sub-second propagation of text/nodes/cursors to the others (broadcast intact).
3. **Cadence (WS3):** hold down continuous editing; confirm saves are spaced (~4s/idle + ≤15s max-wait), and the final state persists on reload after edits stop.
4. **Thumbnail (WS4):** after an idle, confirm the thumbnail is uploaded to `whiteboard-images/thumb/<id>.jpg`, the row's `thumbnail` is a short URL (not a data URL), and the board card still renders a preview.
5. **Retry cap (WS5):** DevTools → throttle to offline mid-edit; confirm the persister backs off (bounded retries, "will retry" state) and does not re-send per keystroke; restore network → one successful save catches up.
6. **Solo/regression:** single-user board still autosaves and reloads correctly; read-only viewers never write; embedded/non-synced boards unchanged.
7. **Unit tests:** add tests for the persister-election helper (min-id over a members set, incl. self-only) and the retry/backoff state machine.

### B. Load / resource — proves the brownout is fixed
Reproduce retro-scale load and confirm DB cost collapses. **Run against an isolated DB, not shared prod** — create a Supabase preview branch (MCP `create_branch`) or run off-hours on staging (staging shares the physical DB — see memory), then tear the branch down.

- **B1. Concurrent-editor simulation (script).** Write `scripts/wb-loadtest.mjs` (Node + `@supabase/supabase-js`): spin up **N=15** clients that (a) subscribe to `wb:${boardId}`, (b) drive an edit every ~1–2s for 5 min (mutating nodes → triggers the persistence path), mirroring the retro. Point it at the branch DB.
  - **Measure before vs after WS1+WS2+WS3:**
    - `PATCH /whiteboards` count/min (from `get_logs('edge'|'api')` or a client counter): expect **~N× → ~1×**.
    - Postgres statement timeouts: `select count(*) ... 57014` in `get_logs('postgres')` during the run → **0** (was 128 in the incident).
    - `pg_stat_statements`: total_time + calls for the `whiteboards` UPDATE before/after (reset with `select pg_stat_statements_reset()` around each run).
  - **Concurrent call-liveness probe:** during the load run, in a loop call `heartbeat_sync_session` + select `sync_session_participants` and record latency/timeouts. **Expect:** no 504/57014 on those (was 76× 504 in the incident) — proves the whiteboard load no longer starves the call.
- **B2. DB migration took (WS1):** post-migration, run the two `pg_publication_tables` / `relreplident` checks in §WS1 acceptance.
- **B3. Payload check (WS4):** confirm the average `PATCH /whiteboards` body size dropped (no base64 thumbnail) — inspect a captured request or `pg_stat_statements` rows read/written.

### C. Call resilience (WS7)
1. **Connected-call survives session loss:** in a live 2-person call, force the sync-session row to disappear (delete it on the branch DB, or simulate `syncSession=null`). **Expect:** the call stays up (LiveKit connected) and the session is re-established — no `endCall("sync-session-room-cleared")`.
2. **Sweep is LiveKit-aware:** with 2 participants LiveKit-connected but heartbeats stale > grace, run `sweep_abandoned_sync_sessions`. **Expect:** the session is NOT deleted; invite_code intact.
3. **Rejoin after a real end:** soft-end a session, then rejoin by the original invite code. **Expect:** succeeds (no "Session not found").
4. **Security:** from an unauthenticated context (anon key), `POST /rest/v1/rpc/sweep_abandoned_sync_sessions` and `/rpc/reconcile_room_session` → **expect 403 / permission denied**.
5. **In-session auto-rejoin:** kill network >30s in a call, restore → call auto-reconnects (no drop to green room).

### D. The real retro (final proof)
Before next week's retro, enable extra observability (a PostHog/console event on every `saveSnapshot` with `isPersister`, and on every `endCall` reason). Run the retro, then confirm from logs: **0× 57014**, `PATCH /whiteboards` writers = 1 for the retro board, **0 call ejections**. This is the definitive "root issue fixed" gate.

---

## Rollback
- WS1 migration is reversible: `alter publication supabase_realtime add table public.whiteboards; alter table public.whiteboards replica identity full;` (only if a `postgres_changes` subscriber is ever added — none today).
- WS2–WS6 are client code — revert the PR; behavior returns to all-clients-persist.
- WS7 sweep migration: keep the old function body in the new migration's comment for quick restore.

## Risks
- **Data durability under single-writer:** if the persister crashes without a flush, ≤ one checkpoint interval of edits could miss the DB — but every other client still holds full state + a new persister checkpoints. Mitigated by on-last-leave flush + reasonable max-wait. Real loss only if ALL clients close within one interval.
- **Handoff gap:** brief no-persister window during leader change — acceptable (state is in-memory + broadcast; new persister checkpoints immediately).
- **Shared multi-branch DB:** load-test on a preview branch, not staging/prod. Apply migrations via MCP `apply_migration`.

## Future (not in this pass)
- Op-based / incremental persistence (append ops to a child table keyed by node id) so a write is proportional to the change — the schema header already flags this as "Phase 2."
