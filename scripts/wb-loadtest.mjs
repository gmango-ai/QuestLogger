#!/usr/bin/env node
/*
 * ============================================================================
 * wb-loadtest.mjs — concurrent whiteboard editing load-test harness
 * ============================================================================
 *
 * WHAT THIS DOES
 * --------------
 * Simulates a weekly-retro-style session where N people edit ONE whiteboard at
 * the same time, to measure the Supabase/Postgres write load produced by the
 * board's snapshot-persistence path.
 *
 * It mirrors the real app path exactly:
 *   - persistence:  supabase.from('whiteboards').update({ snapshot }).eq('id', BOARD_ID)
 *                   (see src/lib/whiteboard.js -> saveSnapshot; the editor
 *                    debounces this every ~1200ms in
 *                    src/components/whiteboard/useWhiteboardPersistence.js)
 *   - realtime:     supabase.channel(`wb:${BOARD_ID}`,
 *                     { config: { broadcast: { self:false }, presence: { key } } })
 *                   with presence tracking (see
 *                    src/components/whiteboard/useWhiteboardSync.js)
 *
 * Two modes let you compare BEFORE vs AFTER the write-reduction fix:
 *   - default (all-write):  every simulated client PATCHes the whole board each
 *                           tick — models today's brown-out behaviour.
 *   - --single-writer:      only the elected client (the lowest presence key,
 *                           the same election the app uses for sync-req) PATCHes
 *                           — models the fix (one persister per board).
 *
 * ============================================================================
 *  !!  WARNING — READ BEFORE RUNNING  !!
 * ============================================================================
 * This tool INTENTIONALLY hammers the `whiteboards` table with concurrent
 * writes. It WILL degrade a database.
 *
 *   >> RUN IT ONLY AGAINST A DISPOSABLE, ISOLATED SUPABASE PREVIEW BRANCH. <<
 *   >> NEVER point it at shared prod or staging (this repo uses ONE shared  <<
 *   >> DB across branches — see MEMORY: "Supabase migrations & shared DB"). <<
 *
 * Spin up an isolated branch first (Supabase dashboard -> Branches, or the
 * `create_branch` MCP tool), seed a throwaway board there, and use THAT
 * branch's URL + anon/service key + board id below. Delete the branch after.
 *
 * ============================================================================
 * AUTH REQUIREMENT
 * ============================================================================
 * Writing `whiteboards` is gated by RLS — an ANONYMOUS client generally CANNOT
 * update a board, so anon runs will just tally 401/403 failures (still a valid
 * "does RLS hold under load" signal, but not a write-load measurement).
 *
 * Provide authenticated users one of two ways:
 *   1. WB_USERS  = path to a JSON file with credentials. Either shape works:
 *          [ { "email": "a@x.com", "password": "..." }, ... ]
 *      or  { "users": [ { "email": "a@x.com", "password": "..." }, ... ] }
 *      Client i signs in as users[i % users.length]. Fewer users than N is
 *      fine — extra clients reuse users (models one person / many tabs).
 *   2. SUPABASE_ACCESS_TOKEN = a single user JWT shared by every client
 *      (quick smoke test; all writes attributed to one user).
 *   If neither is set, clients run anon (expect RLS failures).
 *
 * ============================================================================
 * HOW TO RUN
 * ============================================================================
 *   # BEFORE (every client writes ~ today):
 *   SUPABASE_URL="https://<preview-ref>.supabase.co" \
 *   SUPABASE_ANON_KEY="<preview anon or service key>" \
 *   BOARD_ID="<throwaway board uuid>" \
 *   WB_USERS="./scratch/wb-users.json" \
 *   N=15 DURATION_SEC=300 EDIT_INTERVAL_MS=1500 \
 *     node scripts/wb-loadtest.mjs
 *
 *   # AFTER (only the elected client writes ~ the fix):
 *   ... same env ... node scripts/wb-loadtest.mjs --single-writer
 *
 * CLI flags override env: --n=15 --duration=300 --interval=1500
 *   --board=<uuid> --url=<...> --key=<...> --single-writer --help
 *
 * ============================================================================
 * WATCHING POSTGRES DURING/AFTER THE RUN
 * ============================================================================
 * The signal you care about is statement timeouts (Postgres error 57014) and
 * time spent in the whiteboards UPDATE. Run these against the SAME preview
 * branch (SQL editor / psql / the `execute_sql` MCP tool):
 *
 *   -- Count statement-timeout cancellations during the window:
 *   -- (57014 = "canceling statement due to statement timeout")
 *   -- This harness ALSO tallies 57014 itself (see the SUMMARY block), but the
 *   -- server log is the ground truth:
 *   --   Dashboard -> Logs -> Postgres, filter for '57014' / 'statement timeout'
 *
 *   -- Reset stats right before the run:
 *   SELECT pg_stat_statements_reset();
 *
 *   -- After the run, inspect the whiteboards UPDATE hot path:
 *   SELECT calls, total_exec_time, mean_exec_time, max_exec_time, rows, query
 *   FROM   pg_stat_statements
 *   WHERE  query ILIKE '%update%whiteboards%'
 *   ORDER  BY total_exec_time DESC
 *   LIMIT  20;
 *
 *   -- Live contention while it runs (lock waits on the board row):
 *   SELECT pid, state, wait_event_type, wait_event,
 *          now() - query_start AS runtime, left(query, 80) AS query
 *   FROM   pg_stat_activity
 *   WHERE  query ILIKE '%whiteboards%' AND state <> 'idle'
 *   ORDER  BY runtime DESC;
 *
 * (pg_stat_statements must be enabled: CREATE EXTENSION IF NOT EXISTS
 *  pg_stat_statements; — it is on by default on Supabase.)
 * ============================================================================
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import process from "node:process";

// ── tiny CLI/env config layer ────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
function argVal(name) {
  const pref = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}
function cfg(cliName, envName, fallback) {
  const v = argVal(cliName) ?? process.env[envName];
  return v === undefined || v === "" ? fallback : v;
}

if (hasFlag("help") || hasFlag("h")) {
  // The top-of-file comment is the full manual; print the essentials.
  console.log(
    [
      "wb-loadtest — concurrent whiteboard write load test.",
      "",
      "Env:  SUPABASE_URL  SUPABASE_ANON_KEY (or service key)  BOARD_ID",
      "      N=15  DURATION_SEC=300  EDIT_INTERVAL_MS=1500",
      "      WB_USERS=<creds.json>  or  SUPABASE_ACCESS_TOKEN=<jwt>",
      "Flags: --single-writer  --n=  --duration=  --interval=  --board=",
      "       --url=  --key=  --help",
      "",
      "!! Run ONLY against an isolated Supabase preview branch — never prod/staging.",
      "See the comment block at the top of this file for full details.",
    ].join("\n"),
  );
  process.exit(0);
}

const SUPABASE_URL = cfg("url", "SUPABASE_URL");
const SUPABASE_KEY = cfg("key", "SUPABASE_ANON_KEY") || process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOARD_ID = cfg("board", "BOARD_ID");
const N = Math.max(1, parseInt(cfg("n", "N", "15"), 10) || 15);
const DURATION_SEC = Math.max(1, parseInt(cfg("duration", "DURATION_SEC", "300"), 10) || 300);
const EDIT_INTERVAL_MS = Math.max(50, parseInt(cfg("interval", "EDIT_INTERVAL_MS", "1500"), 10) || 1500);
const SINGLE_WRITER = hasFlag("single-writer");
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || "";
const WB_USERS_PATH = process.env.WB_USERS || "";

function die(msg) {
  console.error(`\n[wb-loadtest] FATAL: ${msg}\n`);
  process.exit(1);
}

if (!SUPABASE_URL) die("SUPABASE_URL is required (env or --url=).");
if (!SUPABASE_KEY) die("SUPABASE_ANON_KEY (or service key) is required (env or --key=).");
if (!BOARD_ID) die("BOARD_ID is required (env or --board=).");

// Loud safety confirmation about which host is being targeted.
let hostLabel = SUPABASE_URL;
try { hostLabel = new URL(SUPABASE_URL).host; } catch { /* keep raw */ }

// ── load credential list, if any ─────────────────────────────────────────
function loadUsers() {
  if (!WB_USERS_PATH) return [];
  let raw;
  try {
    raw = readFileSync(WB_USERS_PATH, "utf8");
  } catch (e) {
    die(`could not read WB_USERS file "${WB_USERS_PATH}": ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    die(`WB_USERS file "${WB_USERS_PATH}" is not valid JSON: ${e.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.users;
  if (!Array.isArray(list) || list.length === 0) {
    die(`WB_USERS file must be an array of {email,password} (or { "users": [...] }).`);
  }
  for (const u of list) {
    if (!u || !u.email || !u.password) {
      die(`each WB_USERS entry needs both "email" and "password".`);
    }
  }
  return list;
}
const USERS = loadUsers();

const AUTH_MODE = USERS.length ? "password-list" : ACCESS_TOKEN ? "access-token" : "anon";

// ── shared tallies ───────────────────────────────────────────────────────
const stats = {
  attempts: 0,
  ok: 0,
  fail: 0,
  byStatus: {},   // http status code -> count
  byErrCode: {},  // postgres/postgrest error code -> count
  timeouts: 0,    // convenience counter for 57014 statement timeouts
  authFailures: 0,
};
function bump(map, key) { map[key] = (map[key] || 0) + 1; }

// One shared handle so shutdown() can clean everything up.
const clients = []; // { idx, key, sb, channel, snapshot, isLeader, authed, userLabel, timer }
let running = false;
let startedAt = 0;
let durationTimer = null;
let progressTimer = null;
let shuttingDown = false;

// ── snapshot model (kept small, like a real retro board) ─────────────────
function randId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}
function makeBaseSnapshot(seed) {
  // A handful of sticky notes laid out in a grid — the durable snapshot shape
  // the editor stores is exactly { nodes, edges }.
  const nodes = [];
  for (let i = 0; i < 8; i++) {
    nodes.push({
      id: `n-${seed}-${i}`,
      type: "sticky",
      position: { x: (i % 4) * 180, y: Math.floor(i / 4) * 140 },
      data: { text: `note ${i}`, color: "#fde68a" },
    });
  }
  return { nodes, edges: [] };
}
function mutateSnapshot(snap, tick) {
  // Small, realistic edit: nudge a random node; occasionally add one (bounded).
  if (snap.nodes.length) {
    const n = snap.nodes[Math.floor(Math.random() * snap.nodes.length)];
    n.position = {
      x: Math.round(n.position.x + (Math.random() * 20 - 10)),
      y: Math.round(n.position.y + (Math.random() * 20 - 10)),
    };
    n.data = { ...n.data, text: `note ${n.id} v${tick}` };
  }
  if (tick % 20 === 0 && snap.nodes.length < 60) {
    snap.nodes.push({
      id: randId("n"),
      type: "sticky",
      position: { x: Math.round(Math.random() * 800), y: Math.round(Math.random() * 600) },
      data: { text: "new", color: "#bfdbfe" },
    });
  }
  return snap;
}

// ── one PATCH, mirroring saveSnapshot() in src/lib/whiteboard.js ──────────
async function persist(sb, snapshot) {
  stats.attempts += 1;
  try {
    const res = await sb.from("whiteboards").update({ snapshot }).eq("id", BOARD_ID);
    const status = res?.status ?? 0;
    bump(stats.byStatus, String(status));
    if (res?.error) {
      stats.fail += 1;
      const code = res.error.code || "unknown";
      bump(stats.byErrCode, code);
      if (code === "57014") stats.timeouts += 1;
    } else {
      stats.ok += 1;
    }
  } catch (e) {
    // Network/transport level failure — never let one write crash the run.
    stats.fail += 1;
    bump(stats.byErrCode, "exception");
    bump(stats.byStatus, "0");
    if (e && /timeout/i.test(e.message || "")) stats.timeouts += 1;
  }
}

// ── per-client sign-in ────────────────────────────────────────────────────
async function authenticate(sb, idx) {
  if (AUTH_MODE === "password-list") {
    const u = USERS[idx % USERS.length];
    const { data, error } = await sb.auth.signInWithPassword({
      email: u.email,
      password: u.password,
    });
    if (error || !data?.session) {
      stats.authFailures += 1;
      console.warn(`[client ${idx}] auth FAILED for ${u.email}: ${error?.message || "no session"}`);
      return { authed: false, userLabel: `${u.email} (auth-failed)` };
    }
    // Make sure realtime uses the user JWT too (presence/broadcast RLS).
    try { sb.realtime.setAuth(data.session.access_token); } catch { /* */ }
    return { authed: true, userLabel: u.email };
  }
  if (AUTH_MODE === "access-token") {
    try { sb.realtime.setAuth(ACCESS_TOKEN); } catch { /* */ }
    return { authed: true, userLabel: "shared-access-token" };
  }
  return { authed: false, userLabel: "anon" };
}

// ── preflight: can we even see the board? (handle missing board) ──────────
async function preflight(sb) {
  const { data, error } = await sb.from("whiteboards").select("id").eq("id", BOARD_ID).maybeSingle();
  if (error) {
    // Could be RLS (permission) rather than truly-missing; warn, don't abort.
    console.warn(`[wb-loadtest] preflight read returned an error (${error.code || "?"}): ${error.message}`);
    console.warn("[wb-loadtest] continuing — if this is a permissions error, expect the writes to fail too.");
    return;
  }
  if (!data) {
    die(`board "${BOARD_ID}" not found (or not readable) on ${hostLabel}. Seed a throwaway board on your preview branch first.`);
  }
}

// ── channel + presence wiring, mirroring useWhiteboardSync.js ─────────────
function attachChannel(client) {
  const { sb, key } = client;
  const ch = sb.channel(`wb:${BOARD_ID}`, {
    config: { broadcast: { self: false }, presence: { key } },
  });
  client.channel = ch;

  // Track presence to compute the "leader" (lowest presence key), exactly the
  // election the app uses to pick a single sync-req responder.
  ch.on("presence", { event: "sync" }, () => {
    try {
      const state = ch.presenceState();
      const keys = Object.keys(state);
      if (keys.length) {
        const min = keys.reduce((a, b) => (a < b ? a : b));
        client.isLeader = min === key;
      }
    } catch { /* */ }
  });

  return new Promise((resolve) => {
    let settled = false;
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        try { ch.track({ name: `LoadBot ${client.idx}`, color: "#64748b" }); } catch { /* */ }
        if (!settled) { settled = true; resolve(true); }
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn(`[client ${client.idx}] channel status: ${status}`);
        if (!settled) { settled = true; resolve(false); }
      }
    });
    // Don't hang forever if realtime never settles.
    setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 10000);
  });
}

// ── the per-client edit loop ──────────────────────────────────────────────
function scheduleEdits(client) {
  let tick = 0;
  const loop = () => {
    if (!running) return;
    tick += 1;
    mutateSnapshot(client.snapshot, tick);

    // Keep the realtime channel realistically busy (cheap cursor ping) so
    // presence/leader stays live — this is NOT the DB path we're measuring.
    try {
      client.channel?.send({
        type: "broadcast",
        event: "cursor",
        payload: { id: client.key, x: Math.random() * 1000, y: Math.random() * 700 },
      });
    } catch { /* */ }

    // Who persists?
    //  - all-write (default): everyone PATCHes -> models today's brown-out.
    //  - --single-writer:     only the elected leader PATCHes -> models the fix.
    const shouldWrite = SINGLE_WRITER ? client.isLeader : true;
    if (shouldWrite) {
      // fire-and-forget; persist() tallies its own success/failure
      persist(client.sb, client.snapshot);
    }

    // Re-arm with a little jitter so N clients don't fire on the exact same ms.
    const jitter = Math.round((Math.random() - 0.5) * EDIT_INTERVAL_MS * 0.2);
    client.timer = setTimeout(loop, Math.max(50, EDIT_INTERVAL_MS + jitter));
  };
  // Stagger initial fire across the interval so join isn't a thundering herd.
  client.timer = setTimeout(loop, Math.round(Math.random() * EDIT_INTERVAL_MS));
}

// ── summary + shutdown ────────────────────────────────────────────────────
function printSummary() {
  const wallSec = startedAt ? (Date.now() - startedAt) / 1000 : 0;
  const perMin = wallSec > 0 ? (stats.attempts / wallSec) * 60 : 0;
  const okPerMin = wallSec > 0 ? (stats.ok / wallSec) * 60 : 0;
  const writers = SINGLE_WRITER
    ? clients.filter((c) => c.isLeader).length
    : clients.filter((c) => c.authed || AUTH_MODE === "anon").length;

  const line = "═".repeat(60);
  console.log(`\n${line}`);
  console.log("  wb-loadtest SUMMARY");
  console.log(line);
  console.log(`  Target host        : ${hostLabel}`);
  console.log(`  Board id           : ${BOARD_ID}`);
  console.log(`  Mode               : ${SINGLE_WRITER ? "SINGLE-WRITER (fix)" : "ALL-WRITE (today)"}`);
  console.log(`  Auth mode          : ${AUTH_MODE}`);
  console.log(`  Clients (N)        : ${N}   (active writers this run: ${writers})`);
  console.log(`  Edit interval      : ${EDIT_INTERVAL_MS} ms`);
  console.log(`  Wall clock         : ${wallSec.toFixed(1)} s`);
  console.log("  " + "-".repeat(56));
  console.log(`  PATCH attempts     : ${stats.attempts}`);
  console.log(`  PATCH successes    : ${stats.ok}`);
  console.log(`  PATCH failures     : ${stats.fail}`);
  console.log(`  Auth failures      : ${stats.authFailures}`);
  console.log(`  Statement timeouts : ${stats.timeouts}   (Postgres 57014)`);
  console.log(`  PATCH / min        : ${perMin.toFixed(1)}   (attempts)`);
  console.log(`  Successful / min   : ${okPerMin.toFixed(1)}`);
  console.log("  " + "-".repeat(56));
  console.log(`  By HTTP status     : ${JSON.stringify(stats.byStatus)}`);
  console.log(`  By error code      : ${JSON.stringify(stats.byErrCode)}`);
  console.log(line + "\n");
}

async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  running = false;
  console.log(`\n[wb-loadtest] shutting down (${reason})…`);
  if (durationTimer) clearTimeout(durationTimer);
  if (progressTimer) clearInterval(progressTimer);
  for (const c of clients) {
    if (c.timer) clearTimeout(c.timer);
  }
  // Unsubscribe/remove every channel so we don't leave realtime sockets open.
  await Promise.all(
    clients.map(async (c) => {
      try { if (c.channel) await c.sb.removeChannel(c.channel); } catch { /* */ }
      try { await c.sb.auth.signOut(); } catch { /* */ }
    }),
  );
  printSummary();
  process.exit(code);
}

process.on("SIGINT", () => shutdown("SIGINT / Ctrl-C"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log("[wb-loadtest] configuration");
  console.log(`  host         : ${hostLabel}`);
  console.log(`  board        : ${BOARD_ID}`);
  console.log(`  N clients    : ${N}`);
  console.log(`  duration     : ${DURATION_SEC}s`);
  console.log(`  interval     : ${EDIT_INTERVAL_MS}ms`);
  console.log(`  mode         : ${SINGLE_WRITER ? "SINGLE-WRITER (fix)" : "ALL-WRITE (today)"}`);
  console.log(`  auth         : ${AUTH_MODE}`);
  console.log("");
  console.log("  !! Make sure this host is a DISPOSABLE preview branch, not prod/staging. !!\n");

  if (AUTH_MODE === "anon") {
    console.warn("[wb-loadtest] running ANON — whiteboards RLS will likely reject writes; expect failures.\n");
  }

  // Build clients (each an independent supabase-js instance, its own socket).
  for (let i = 0; i < N; i++) {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: true },
      // Give each client a globally-unique realtime socket by not sharing state.
    });
    // Presence key: random+sortable, mirrors the app's per-tab client id used
    // for leader election (lowest key wins).
    const key = `wbload-${String(i).padStart(3, "0")}-${Math.random().toString(36).slice(2, 8)}`;
    clients.push({
      idx: i,
      key,
      sb,
      channel: null,
      snapshot: makeBaseSnapshot(i),
      isLeader: false,
      authed: false,
      userLabel: "anon",
      timer: null,
    });
  }

  // Authenticate every client (best-effort; failures are tallied, not fatal).
  await Promise.all(
    clients.map(async (c) => {
      const { authed, userLabel } = await authenticate(c.sb, c.idx);
      c.authed = authed;
      c.userLabel = userLabel;
    }),
  );
  const authedCount = clients.filter((c) => c.authed).length;
  if (AUTH_MODE !== "anon" && authedCount === 0) {
    die("no client could authenticate — check WB_USERS / SUPABASE_ACCESS_TOKEN.");
  }
  console.log(`[wb-loadtest] authenticated ${authedCount}/${N} clients.`);

  // Preflight the board with the first client that has any auth.
  const probe = clients.find((c) => c.authed) || clients[0];
  await preflight(probe.sb);

  // Subscribe all channels + track presence.
  const subOk = await Promise.all(clients.map((c) => attachChannel(c)));
  console.log(`[wb-loadtest] subscribed ${subOk.filter(Boolean).length}/${N} realtime channels.`);

  // Give presence a moment to converge so leader election is stable before we
  // start writing (matters for --single-writer).
  await new Promise((r) => setTimeout(r, 1500));
  if (SINGLE_WRITER) {
    const leaders = clients.filter((c) => c.isLeader).length;
    console.log(`[wb-loadtest] single-writer mode: ${leaders} elected writer(s).`);
  }

  // GO.
  running = true;
  startedAt = Date.now();
  console.log(`\n[wb-loadtest] running for ${DURATION_SEC}s — Ctrl-C to stop early.\n`);
  for (const c of clients) scheduleEdits(c);

  // Interim progress every 15s.
  progressTimer = setInterval(() => {
    const wallSec = (Date.now() - startedAt) / 1000;
    const perMin = wallSec > 0 ? (stats.attempts / wallSec) * 60 : 0;
    console.log(
      `[wb-loadtest] t+${wallSec.toFixed(0)}s  attempts=${stats.attempts} ok=${stats.ok} ` +
        `fail=${stats.fail} timeouts=${stats.timeouts} (~${perMin.toFixed(0)} PATCH/min)`,
    );
  }, 15000);

  // Stop after the configured duration.
  durationTimer = setTimeout(() => shutdown(`duration ${DURATION_SEC}s elapsed`), DURATION_SEC * 1000);
}

main().catch((e) => {
  console.error(`[wb-loadtest] unexpected error: ${e?.stack || e}`);
  shutdown("fatal error", 1);
});
