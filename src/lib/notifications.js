import { supabase } from "../supabase";

// Notification type registry — single source of truth for the Settings UI
// (per-type toggles) and the default channel set. Mirrors the SQL defaults in
// notif_type_default_channels (migration 20260623170000). All types default
// enabled; they differ only in default channels.
export const NOTIFICATION_TYPES = [
  { type: "session_started", label: "Teammate started focusing", description: "Someone on your team starts a focus session.", channels: ["inapp", "desktop"] },
  { type: "follow_focus", label: "Someone you follow is focusing", description: "A person you follow starts a focus session.", channels: ["inapp", "desktop"] },
  { type: "mention", label: "Mentions", description: "You're @mentioned in room chat or a whiteboard comment.", channels: ["inapp", "desktop"] },
  { type: "room_joined", label: "Someone joined your room", description: "A teammate joins a room you're in.", channels: ["inapp"] },
  { type: "channel", label: "Channel messages", description: "A new message in one of your team channels.", channels: ["inapp"] },
  { type: "knock", label: "Someone wants to join your room", description: "A teammate knocks to be let into a locked room you're in.", channels: ["inapp", "desktop"] },
  { type: "lunch_start", label: "Teammate went to lunch", description: "Someone on your team heads out to lunch.", channels: ["inapp"] },
  { type: "lunch_return", label: "Back from lunch", description: "A teammate is back from lunch.", channels: ["inapp"] },
  { type: "lunch_reminder", label: "Lunch reminder", description: "A nudge at your own scheduled lunch time.", channels: ["inapp", "desktop"] },
  { type: "reminder", label: "Wellbeing & break reminders", description: "Hydration, movement, eye rest and other nudges you turn on.", channels: ["inapp", "desktop"] },
  { type: "reminder_daily", label: "Daily log reminder", description: "A nudge if you haven't logged hours by your reminder time.", channels: ["inapp", "desktop"] },
  { type: "whiteboard_invite", label: "Whiteboard shares", description: "A teammate shares an invite-only whiteboard with you.", channels: ["inapp", "desktop"] },
];

export const typeMeta = (type) => NOTIFICATION_TYPES.find((t) => t.type === type) || null;
export const typeLabel = (type) => typeMeta(type)?.label || type;

// Client emit is locked down to two narrow RPCs (the generic emit_notification
// is server/trigger-only): a SELF nudge (recipient/actor forced to you, type
// allowlisted) and a MENTION (type/actor forced, recipient must share a team).
export async function emitSelfNotification(args) {
  const { error, data } = await supabase.rpc("emit_self_notification", {
    p_type: args.type,
    p_title: args.title,
    p_body: args.body ?? null,
    p_payload: args.payload ?? {},
    p_dedupe_key: args.dedupeKey ?? null,
    p_dedupe_window_minutes: args.dedupeWindowMinutes ?? 60,
  });
  if (error) { console.warn("emit_self_notification:", error.message); return null; }
  return data;
}

export async function emitMention(args) {
  const { error, data } = await supabase.rpc("emit_mention", {
    p_recipient: args.recipient,
    p_title: args.title,
    p_body: args.body ?? null,
    p_payload: args.payload ?? {},
    p_entity_type: args.entityType ?? null,
    p_entity_id: args.entityId ?? null,
    p_dedupe_key: args.dedupeKey ?? null,
  });
  if (error) { console.warn("emit_mention:", error.message); return null; }
  return data;
}

export async function listNotifications(limit = 40) {
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) { console.warn("listNotifications:", error.message); return []; }
  return data || [];
}

export async function markRead(id) {
  if (!id) return;
  await supabase.from("notification_deliveries").update({ read_at: new Date().toISOString(), state: "read" }).eq("id", id).is("read_at", null);
}

export async function markAllRead() {
  await supabase.from("notification_deliveries").update({ read_at: new Date().toISOString(), state: "read" }).is("read_at", null);
}

// Clear (delete) — RLS scopes both to the caller's own rows.
export async function clearNotification(id) {
  if (!id) return;
  await supabase.from("notification_deliveries").delete().eq("id", id);
}

export async function clearAllNotifications() {
  // `.not("id", "is", null)` matches every own row (delete needs a filter); RLS
  // restricts it to the caller.
  await supabase.from("notification_deliveries").delete().not("id", "is", null);
}

// ── Follows ("notify me when [X] starts focusing") ──
export async function listFollows(kind = "focus_start") {
  const { data } = await supabase.from("notification_follows").select("target_user_id, kind").eq("kind", kind);
  return (data || []).map((r) => r.target_user_id);
}

export async function followUser(followerId, targetUserId, kind = "focus_start") {
  if (!followerId || !targetUserId) return { error: null };
  const { error } = await supabase
    .from("notification_follows")
    .upsert({ follower_user_id: followerId, target_user_id: targetUserId, kind }, { onConflict: "follower_user_id,target_user_id,kind", ignoreDuplicates: true });
  return { error };
}

export async function unfollowUser(targetUserId, kind = "focus_start") {
  if (!targetUserId) return { error: null };
  const { error } = await supabase.from("notification_follows").delete().eq("target_user_id", targetUserId).eq("kind", kind);
  return { error };
}

// ── Per-type preferences (sparse overrides; absence = default-enabled) ──
export async function listPreferences() {
  const { data } = await supabase.from("notification_preferences").select("type, enabled");
  const map = {};
  (data || []).forEach((r) => { map[r.type] = r.enabled; });
  return map; // { [type]: enabled }
}

export async function setPreferenceEnabled(userId, type, enabled) {
  if (!userId || !type) return;
  await supabase.from("notification_preferences").upsert(
    { user_id: userId, type, enabled, channels: typeMeta(type)?.channels || ["inapp", "desktop"], updated_at: new Date().toISOString() },
    { onConflict: "user_id,type" }
  );
}
