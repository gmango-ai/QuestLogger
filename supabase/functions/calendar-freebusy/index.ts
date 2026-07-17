// calendar-freebusy: return teammates' busy/free blocks for the "Find a time"
// scheduler. For each requested user who (a) shares the given team with the
// caller and (b) has opted in (user_settings.share_freebusy_with_team), we read
// their stored Google refresh token with the service role, mint an access
// token, and query their PRIMARY calendar's freeBusy. Returns busy TIME RANGES
// ONLY — never event titles, details, or tokens.
//
// Security posture (see the adversarial security review):
//   • Caller must present a valid user JWT AND be a member of `team_id`.
//   • Only members of `team_id` are ever queried; others are never touched.
//   • A teammate is queried ONLY if they opted in. The caller is always allowed
//     to read THEIR OWN calendar (reading your own busy needs no opt-in).
//   • We NEVER delete another user's token on failure — a bad/expired token just
//     demotes that user to "unavailable" for this response.
//   • Hard caps on user count + window, plus a soft per-caller rate limit.
//   • Response collapses notMember / not-opted-in / no-token / failed into one
//     `unavailable` bucket so it can't enumerate who has Google connected.
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (same as google-token).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";

const MAX_USERS = 30;
const MAX_WINDOW_DAYS = 14;
const CONCURRENCY = 6;
const RATE_MAX = 20;          // per caller
const RATE_WINDOW_MS = 60_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // JWT-gated; CORS only relaxes browser reads
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

// Best-effort in-memory rate limit (per warm isolate). The hard caps below are
// the real bound; this just blunts a tight client loop.
const rateLog = new Map<string, number[]>();
function rateLimited(callerId: string): boolean {
  const now = Date.now();
  const arr = (rateLog.get(callerId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateLog.set(callerId, arr);
  return arr.length > RATE_MAX;
}

async function accessTokenFor(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
      }),
    });
    const tok = await res.json().catch(() => ({}));
    if (!res.ok || !tok.access_token) return null; // incl. invalid_grant — do NOT delete another user's token
    return tok.access_token as string;
  } catch {
    return null;
  }
}

async function busyFor(accessToken: string, timeMin: string, timeMax: string): Promise<{ start: string; end: string }[] | null> {
  try {
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin, timeMax, items: [{ id: "primary" }] }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const busy = data?.calendars?.primary?.busy;
    return Array.isArray(busy) ? busy.map((b: { start: string; end: string }) => ({ start: b.start, end: b.end })) : [];
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return json(503, { error: "not_configured" });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return json(401, { error: "missing bearer token" });

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userResult, error: userError } = await userClient.auth.getUser();
  if (userError || !userResult.user) return json(401, { error: "invalid auth" });
  const callerId = userResult.user.id;

  if (rateLimited(callerId)) return json(429, { error: "rate_limited" });

  let body: { team_id?: string; user_ids?: string[]; timeMin?: string; timeMax?: string };
  try { body = await req.json(); } catch { return json(400, { error: "invalid json" }); }
  const teamId = body?.team_id;
  const userIds = Array.isArray(body?.user_ids) ? [...new Set(body.user_ids.filter(Boolean))] : [];
  const timeMin = body?.timeMin, timeMax = body?.timeMax;
  if (!teamId || !userIds.length || !timeMin || !timeMax) return json(400, { error: "missing params" });
  if (userIds.length > MAX_USERS) return json(400, { error: "too_many_users" });
  const min = Date.parse(timeMin), max = Date.parse(timeMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return json(400, { error: "bad_window" });
  if (max - min > MAX_WINDOW_DAYS * 86400_000) return json(400, { error: "window_too_large" });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Authz: caller must belong to the team.
  const { data: callerMem } = await admin
    .from("team_members").select("user_id").eq("team_id", teamId).eq("user_id", callerId).maybeSingle();
  if (!callerMem) return json(403, { error: "not_a_team_member" });

  // Only members of this team are ever queried.
  const { data: members } = await admin
    .from("team_members").select("user_id").eq("team_id", teamId).in("user_id", userIds);
  const memberIds = new Set((members || []).map((m: { user_id: string }) => m.user_id));
  if (!memberIds.size) return json(200, { busy: {}, unavailable: userIds });

  // Opted-in members (+ the caller is always allowed to read their own calendar).
  const { data: optedRows } = await admin
    .from("user_settings").select("user_id").eq("share_freebusy_with_team", true).in("user_id", [...memberIds]);
  const optedIds = new Set((optedRows || []).map((r: { user_id: string }) => r.user_id));
  if (memberIds.has(callerId)) optedIds.add(callerId);
  if (!optedIds.size) return json(200, { busy: {}, unavailable: userIds });

  // Tokens for opted-in members.
  const { data: tokRows } = await admin
    .from("google_oauth_tokens").select("user_id, refresh_token").in("user_id", [...optedIds]);
  const targets = (tokRows || []).filter((t: { refresh_token: string | null }) => t.refresh_token) as { user_id: string; refresh_token: string }[];

  const busy: Record<string, { start: string; end: string }[]> = {};
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(async (t) => {
      const at = await accessTokenFor(t.refresh_token);
      if (!at) return { id: t.user_id, busy: null as null | { start: string; end: string }[] };
      return { id: t.user_id, busy: await busyFor(at, timeMin, timeMax) };
    }));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.busy) busy[r.value.id] = r.value.busy;
    }
  }

  // Everything we couldn't return busy for → one opaque bucket (no enumeration
  // of who has Google connected vs opted in vs not a member).
  const unavailable = userIds.filter((id) => !(id in busy));
  return json(200, { busy, unavailable });
});
