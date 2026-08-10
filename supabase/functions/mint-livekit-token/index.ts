// mint-livekit-token
//
// Returns a freshly-signed LiveKit access token for the calling user so
// the browser can join a room without us shipping the LiveKit API secret
// to the client.
//
// Auth: requires a Supabase user JWT. The participant identity is always
// the authenticated uid — a client can supply a display name + room but
// cannot impersonate.
//
// Guests: an anonymous-auth user (invited via a room share link) may ONLY mint
// a token for a room it holds a live room_guests grant for. This both enables
// external guests AND closes the prior hole where any anonymous JWT could mint a
// full-publish token for any room. Guests keep full A/V grants (they're meeting
// participants); the "call only" scoping is enforced by RLS, not the token.
//
// Body:
//   { room: string, display_name?: string, ttl_seconds?: number }
//
// Response:
//   { token: string, exp: number }     // exp = unix seconds
//
// Secrets (set via `supabase secrets set`):
//   LIVEKIT_API_KEY      — LiveKit API key (the "ID")
//   LIVEKIT_API_SECRET   — LiveKit API secret

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { signLiveKitToken } from "../_shared/livekit-jwt.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const LIVEKIT_API_KEY = Deno.env.get("LIVEKIT_API_KEY") ?? "";
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return json(500, {
      error:
        "LiveKit secrets missing. Set LIVEKIT_API_KEY, LIVEKIT_API_SECRET via `supabase secrets set`.",
    });
  }

  // Auth — the user JWT comes in via the Authorization header.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(401, { error: "Missing bearer token" });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userResult, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userResult?.user) {
    console.error("[mint-livekit-token] auth failed", userErr);
    return json(401, { error: "Invalid session" });
  }
  const user = userResult.user;

  let body: { room?: string; display_name?: string; ttl_seconds?: number } = {};
  try {
    if (req.headers.get("Content-Length") !== "0") {
      body = await req.json();
    }
  } catch {
    // fall through to validation below
  }

  const room = (body.room || "").toString().trim();
  if (!room) {
    return json(400, { error: "room is required" });
  }

  // Guest gate. An anonymous user must hold a live room_guests grant for the
  // requested room (minted by resolve_room_by_guest_token). "guest reads own
  // grant" RLS lets the caller read its own row, so this is authoritative — a
  // guest can't pivot to a room it wasn't invited to, and a bare anonymous
  // session with no grant can't mint anything.
  let guestTtlCap: number | null = null;
  if (user.is_anonymous) {
    const roomId = room.replace(/^mangodoro-/, "");
    if (roomId === room) {
      return json(403, { error: "Guests can only join a room via an invite link" });
    }
    const { data: grant } = await supabase
      .from("room_guests")
      .select("expires_at")
      .eq("user_id", user.id)
      .eq("room_id", roomId)
      .maybeSingle();
    if (!grant) {
      return json(403, { error: "No valid guest invite for this room" });
    }
    if (grant.expires_at) {
      const secs = Math.floor(
        (new Date(grant.expires_at as string).getTime() - Date.now()) / 1000,
      );
      if (secs <= 0) {
        return json(403, { error: "This guest invite has expired" });
      }
      guestTtlCap = secs;
    }
  }

  // A device account may only get a token for ITS OWN pinned room. org_devices
  // is service-role-write only and "device reads self" RLS lets the caller read
  // its own row, so this is authoritative (unlike self-editable user_metadata).
  const { data: device } = await supabase
    .from("org_devices")
    .select("room_id")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .maybeSingle();
  if (device && room !== `mangodoro-${device.room_id}`) {
    return json(403, { error: "A device can only join its own room" });
  }

  // Cap the TTL (1m–12h). The client re-mints on re-entry anyway.
  let ttl = Math.min(
    Math.max(60, body.ttl_seconds ?? 6 * 60 * 60),
    12 * 60 * 60,
  );
  // A guest token never outlives its grant.
  if (guestTtlCap != null) {
    ttl = Math.min(ttl, guestTtlCap);
  }

  try {
    const { token, exp } = await signLiveKitToken({
      apiKey: LIVEKIT_API_KEY,
      apiSecret: LIVEKIT_API_SECRET,
      identity: user.id,
      name: (body.display_name || user.user_metadata?.name || user.email || "Mangodoro user")
        .toString()
        .slice(0, 80),
      room,
      ttlSeconds: ttl,
    });
    return json(200, { token, exp });
  } catch (e) {
    console.error("[mint-livekit-token] signing failed", e);
    return json(500, { error: "Could not mint LiveKit token" });
  }
});
