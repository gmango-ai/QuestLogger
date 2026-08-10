import { supabase } from "../supabase";
import { getShareableBaseUrl } from "./platform";

export async function listRooms(teamId) {
  if (!teamId) return { data: [], error: null };
  // Pull room_teams in the same query so the client can decide
  // visibility without an N+1 fetch.
  const { data, error } = await supabase
    .from("rooms")
    .select(`
      id, team_id, name, kind, color, entry_policy, pin_policy, knock_enabled, whiteboard_locked, created_by, created_at, archived_at,
      layout_x, layout_y, layout_w, layout_h, max_duration_minutes,
      room_teams ( org_team_id )
    `)
    .eq("team_id", teamId)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  return { data: data || [], error };
}

// v2 (updated 2026-06-27): kinds are `general` (was `department`),
// `meeting`, and `private`. Private rooms are created with an enforced
// `code` entry policy and a server-seeded shareable PIN (viewable in Room
// settings) — they're locked but immediately usable. Other kinds default
// to the `open` policy. Meeting rooms accept a maxDurationMinutes that
// auto-closes the sync_session via the server-side sweeper. Layout coords
// are optional; when omitted the server scans for the first open w×h slot
// in the team's grid and uses that.
export async function createRoomV2(teamId, {
  name, kind, color = "#14b8a6", orgTeamIds = [], layout, maxDurationMinutes, userId,
}) {
  const trimmed = (name || "").trim();
  if (!trimmed) return { error: { message: "Room name is required" } };
  if (!["general", "meeting", "private"].includes(kind)) {
    return { error: { message: "Invalid room kind" } };
  }
  if (maxDurationMinutes != null && kind !== "meeting") {
    return { error: { message: "Only meeting rooms can have a max duration" } };
  }
  const { data, error } = await supabase.rpc("create_room_v2", {
    p_team_id: teamId,
    p_name: trimmed,
    p_kind: kind,
    p_org_team_ids: orgTeamIds,
    // null layout coords → server auto-places in the first open cell.
    p_layout_x: layout?.x ?? null,
    p_layout_y: layout?.y ?? null,
    p_layout_w: layout?.w ?? 4,
    p_layout_h: layout?.h ?? 2,
    p_color: color,
    p_max_duration_minutes: maxDurationMinutes ?? null,
  });
  return {
    data: data
      ? {
          id: data, name: trimmed, kind, color, created_by: userId,
          entry_policy: kind === "private" ? "code" : "open",
        }
      : null,
    error,
  };
}

export async function setRoomColor(roomId, color) {
  const { error } = await supabase.rpc("set_room_color", {
    p_room_id: roomId,
    p_color: color,
  });
  return { error };
}

// Meeting-only. Pass `null` for "no limit". Server enforces both the
// meeting-only invariant and the "admin or creator" permission check.
export async function setRoomMaxDuration(roomId, minutes) {
  const { error } = await supabase.rpc("set_room_max_duration", {
    p_room_id: roomId,
    p_minutes: minutes == null ? null : Number(minutes),
  });
  return { error };
}

export async function updateRoomLayout(roomId, { x, y, w, h }) {
  const { error } = await supabase.rpc("update_room_layout", {
    p_room_id: roomId,
    p_x: x,
    p_y: y,
    p_w: w,
    p_h: h,
  });
  return { error };
}

export async function updateRoomGating(roomId, orgTeamIds) {
  const { error } = await supabase.rpc("update_room_gating", {
    p_room_id: roomId,
    p_org_team_ids: orgTeamIds || [],
  });
  return { error };
}

export async function archiveRoomV2(roomId) {
  const { error } = await supabase.rpc("archive_room_v2", { p_room_id: roomId });
  return { error };
}

export async function renameRoomV2(roomId, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return { error: { message: "Room name is required" } };
  const { error } = await supabase.rpc("rename_room", {
    p_room_id: roomId,
    p_name: trimmed,
  });
  return { error };
}

export async function archiveRoom(roomId) {
  const { error } = await supabase
    .from("rooms")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", roomId);
  return { error };
}

export async function renameRoom(roomId, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return { error: { message: "Room name is required" } };
  const { data, error } = await supabase
    .from("rooms")
    .update({ name: trimmed })
    .eq("id", roomId)
    .select()
    .single();
  return { data, error };
}

// ── Room privacy (entry policy + access code) ──────────────────────
// `entry_policy` is a non-secret column on the room ('open' | 'code').
// The code itself lives in room_secrets, readable only by the room's
// managers (owner / admin / gating-team lead) via RLS.

export async function setRoomEntryPolicy(roomId, policy) {
  const { error } = await supabase.rpc("set_room_entry_policy", {
    p_room_id: roomId,
    p_policy: policy,
  });
  return { error };
}

// Who may pin a participant into everyone's view:
// 'admins' | 'leaders' | 'both' | 'everyone'. Server enforces the manager check.
export async function setRoomPinPolicy(roomId, policy) {
  const { error } = await supabase.rpc("set_room_pin_policy", {
    p_room_id: roomId,
    p_policy: policy,
  });
  return { error };
}

// Pass null / "" to clear the code. Server enforces the manager check and
// stores the PIN uppercased + trimmed.
export async function setRoomAccessCode(roomId, code) {
  const { error } = await supabase.rpc("set_room_access_code", {
    p_room_id: roomId,
    p_code: code ?? "",
  });
  return { error };
}

// Change a room's type: 'general' | 'meeting' | 'private'. Server enforces the
// manager check (owner / admin / gating-team lead), requires org admin to make
// a room 'general', and keeps the coupled columns consistent — clears the
// meeting-only max duration when leaving 'meeting', and locks + seeds a
// shareable code when a room becomes 'private'.
export async function setRoomKind(roomId, kind) {
  const { error } = await supabase.rpc("set_room_kind", {
    p_room_id: roomId,
    p_kind: kind,
  });
  return { error };
}

// Whether a code room accepts knocks while occupied. Server enforces the
// manager check (owner / admin / gating-team lead).
export async function setRoomKnockEnabled(roomId, enabled) {
  const { error } = await supabase.rpc("set_room_knock_enabled", {
    p_room_id: roomId,
    p_enabled: !!enabled,
  });
  return { error };
}

// Lock the shared-whiteboard feature to managers only. Default false =
// anyone in the room may attach / swap / detach the board. Server enforces the
// manager check (owner / admin / gating-team lead).
export async function setRoomWhiteboardLock(roomId, locked) {
  const { error } = await supabase.rpc("set_room_whiteboard_lock", {
    p_room_id: roomId,
    p_locked: !!locked,
  });
  return { error };
}

// ── Knock-to-enter ─────────────────────────────────────────────────
// When held at the lock gate (occupied code room, no code), a user can knock
// to ask the people inside to let them in. request_room_entry pings every live
// occupant; any of them calls decide_room_entry to approve/deny. An approved
// knock then admits the caller through can_enter_room for ~5 minutes.

export async function requestRoomEntry(roomId) {
  const { data, error } = await supabase.rpc("request_room_entry", {
    p_room_id: roomId,
  });
  return { data: data ?? null, error };
}

export async function decideRoomEntry(requestId, approve) {
  const { error } = await supabase.rpc("decide_room_entry", {
    p_request_id: requestId,
    p_approve: !!approve,
  });
  return { error };
}

// Returns the room's current PIN, or null if none set / not permitted.
// RLS on room_secrets returns a row only to the room's managers, so a
// non-manager silently gets null.
export async function getRoomAccessCode(roomId) {
  if (!roomId) return { data: null, error: null };
  const { data, error } = await supabase
    .from("room_secrets")
    .select("code")
    .eq("room_id", roomId)
    .maybeSingle();
  return { data: data?.code ?? null, error };
}

// Returns the active sync_session row for a room (if any). Used when the
// UI needs to decide between "Join this room's running session" and
// "Start a new session here".
export async function fetchRoomActiveSession(roomId) {
  if (!roomId) return { data: null, error: null };
  const { data, error } = await supabase
    .from("sync_sessions")
    .select("*")
    .eq("room_id", roomId)
    .eq("status", "active")
    .maybeSingle();
  return { data, error };
}

// ── External guest links ───────────────────────────────────────────
// A tokenized share link that lets an outside person (not a team member) join
// a room's call + attached whiteboard as an anonymous guest. Creating a link
// implicitly enables guests for the room; links are reusable, expiring, and
// revocable. Manager-only (owner / admin / gating-team lead) — enforced server
// side. See migrations 20260809200000_room_guests_core / _room_guest_rpcs.

// Absolute, shareable URL for a guest token (handles native → production origin).
export function guestLinkUrl(token) {
  return `${getShareableBaseUrl()}/office/guest/${token}`;
}

// Mint a link. `expiresAt` is an ISO string / Date (default 7 days server-side);
// `label` is an optional human note ("Acme kickoff"). Returns { id, token,
// expires_at } plus a ready-to-share `url`.
export async function createGuestLink(roomId, { expiresAt = null, label = null } = {}) {
  const { data, error } = await supabase.rpc("create_guest_link", {
    p_room_id: roomId,
    p_expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    p_label: label,
  });
  if (error) return { error };
  return { data: { ...data, url: guestLinkUrl(data.token) } };
}

export async function revokeGuestLink(linkId) {
  const { error } = await supabase.rpc("revoke_guest_link", { p_link_id: linkId });
  return { error };
}

// List a room's active (non-revoked) guest links. RLS returns rows only to the
// room's managers, so a non-manager silently gets an empty list.
export async function listGuestLinks(roomId) {
  if (!roomId) return { data: [], error: null };
  const { data, error } = await supabase
    .from("room_guest_links")
    .select("id, token, label, expires_at, revoked_at, created_at")
    .eq("room_id", roomId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  return {
    data: (data || []).map((r) => ({ ...r, url: guestLinkUrl(r.token) })),
    error,
  };
}

// Ensure a room has a guest join link for a meeting: reuse an existing one if
// given, else mint a fresh one. Fails SOFT — returns nulls when the scheduler
// isn't a room manager (create_guest_link raises) so scheduling never breaks
// over a missing invite link; the meeting just syncs without an auto-join URL.
export async function ensureGuestJoinLink(roomId, { existingId = null, existingUrl = null, label = null } = {}) {
  if (existingUrl) return { id: existingId, url: existingUrl };
  if (!roomId) return { id: null, url: null };
  const { data, error } = await createGuestLink(roomId, { label });
  if (error || !data) return { id: null, url: null };
  return { id: data.id, url: data.url };
}

// Build a calendar event's { description, location } so external attendees get a
// one-click join link. With a join URL: location = the URL (Google renders it as
// a clickable join link, and the app's joinUrlOf treats an https location as a
// join button), and the room name + link are appended to the description.
export function buildMeetingCalendarFields({ description = "", roomName = "", joinUrl = null } = {}) {
  const base = (description || "").trim();
  if (!joinUrl) {
    return { description: base || undefined, location: roomName || undefined };
  }
  const desc = [base, roomName ? `Room: ${roomName}` : null, `Join the room: ${joinUrl}`]
    .filter(Boolean)
    .join("\n\n");
  return { description: desc, location: joinUrl };
}

// Redeem a guest token (the caller must already have an anonymous session).
// Mints a room_guests grant and returns { room_id, room_name, team_id }.
// Surfaces server-side rejections (invalid / expired / revoked / guests_disabled)
// as an { error } with a `code` for the landing page to branch on.
export async function resolveRoomByGuestToken(token, displayName = "") {
  const { data, error } = await supabase.rpc("resolve_room_by_guest_token", {
    p_token: token,
    p_display_name: displayName,
  });
  if (error) return { error };
  if (data?.error) return { error: { code: data.error, message: data.error } };
  return { data };
}
