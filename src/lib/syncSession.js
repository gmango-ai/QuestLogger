import { supabase } from "../supabase";

// How long a participant's last_seen_at stays "live" before we treat
// them as gone. Foreground clients heartbeat every 20s (see
// SyncSessionContext), so a live tab is never stale; this window only
// trips for occupants whose tab has been closed/suspended for >2 min.
// Keep in sync with the `interval '120 seconds'` used server-side in
// reconcile_room_session / the sweep.
export const PRESENCE_GRACE_MS = 120_000;

export async function createSyncSession(userId, displayName = "", opts = {}) {
  // Generate a 6-char uppercase alphanumeric join code.
  // Use base32-ish padding so it's always exactly 6 chars (avoiding accidental
  // short codes from base36 of small bytes).
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // omit confusable 0/O/1/I
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const code = Array.from(bytes, (b) => chars[b % chars.length]).join("");

  // Allow the caller to set team_id / room_id / visibility / control_mode
  // atomically at INSERT time — avoids a race where teammates query before
  // the follow-up update lands and never see the session in discovery.
  const teamId = opts.teamId ?? null;
  const roomId = opts.roomId ?? null;
  const visibility = opts.visibility ?? (teamId ? "team" : "invite_only");

  let session;
  if (roomId) {
    // Room sessions go through an atomic, advisory-locked RPC that does
    // reconcile + find-or-create in one transaction. This removes the
    // start-vs-start race on sync_sessions_one_active_per_room: concurrent
    // starts (or a double-fire) queue on the per-room lock, so the loser
    // gets back the existing session to JOIN instead of a 23505. The
    // returned row may therefore be a session someone else just started —
    // we join it below with ITS join_code, not our generated one.
    const { data, error } = await supabase.rpc("start_or_join_room_session", {
      p_room_id: roomId,
      p_join_code: code,
      p_team_id: teamId,
      p_visibility: visibility,
      p_control_mode: "leader",
      p_durations: opts.durations ?? null,
      p_auto_transition: opts.autoTransition ?? null,
      // Room privacy: server verifies this against the room's entry policy
      // before creating/returning the session. null for open rooms.
      p_access_code: opts.accessCode ?? null,
    });
    if (error) return { error };
    session = Array.isArray(data) ? data[0] : data;
    if (!session?.join_code) return { error: { message: "Could not start or join the room session." } };
  } else {
    // Non-room (ad-hoc / invite-only) session: no per-room constraint, plain insert.
    const insertRow = {
      leader_id: userId,
      controller_id: userId,
      join_code: code,
      team_id: teamId,
      room_id: null,
      visibility,
      control_mode: "leader",
    };
    if (opts.durations) insertRow.durations = opts.durations;
    if (opts.autoTransition !== undefined) insertRow.auto_transition = opts.autoTransition;
    const { data, error } = await supabase
      .from("sync_sessions")
      .insert(insertRow)
      .select()
      .single();
    if (error) return { error };
    session = data;
  }

  // Add self as participant via the security-definer RPC (idempotent).
  // Bypasses participant-insert RLS, which can otherwise silently fail for
  // the creator. Uses the resolved session's code — for a room start-or-join
  // that may be the session someone else just created.
  const { error: joinErr } = await supabase.rpc("join_sync_session", {
    p_join_code: session.join_code,
    p_display_name: displayName,
    p_access_code: opts.accessCode ?? null,
  });
  if (joinErr) {
    // Only clean up a session we definitely created ourselves. A room
    // session left participant-less is a ghost that the next
    // start_or_join_room_session / sweep reconciles away, so we leave it.
    if (!roomId) await supabase.from("sync_sessions").delete().eq("id", session.id);
    return { error: joinErr };
  }

  return { data: session };
}

export async function joinSyncSession(joinCode, displayName = "", accessCode = null) {
  const { data, error } = await supabase.rpc("join_sync_session", {
    p_join_code: joinCode.trim().toUpperCase(),
    p_display_name: displayName,
    // Room privacy: verified server-side for room sessions. null for
    // ad-hoc / open rooms.
    p_access_code: accessCode ?? null,
  });
  if (error) return { error };
  if (data?.error) return { error: { message: data.error } };
  return { data };
}

export async function leaveSyncSession(sessionId) {
  const { data, error } = await supabase.rpc("leave_sync_session", {
    p_session_id: sessionId,
  });
  if (error) return { error };
  if (data?.error) return { error: { message: data.error } };
  return { data };
}

// Leader-only hard delete via RPC. Hard-deleting the row lets the
// BEFORE DELETE trigger unlock the linked private room (if any) and
// the cascade on sync_session_participants clears participants in one
// atomic step. The previous version did a soft `status = 'ended'`
// update which left orphan rows + permanently-locked private rooms.
export async function endSyncSession(sessionId) {
  const { error } = await supabase.rpc("end_sync_session", {
    p_session_id: sessionId,
  });
  return { error };
}

// Server-authoritative cross-device rehydration. Returns the active
// session row for the calling user, or null when they're not currently
// participating in any session. Used on cold loads so a user who
// joined on device A automatically shows up synced on device B without
// having to manually re-enter the join code.
// Push out a meeting room's auto-close time by p_minutes. Any active
// participant may extend (server-enforced). Returns the updated session row so
// the caller can optimistically reflect the new expires_at before realtime
// catches up.
export async function extendRoomSession(sessionId, minutes = 15) {
  const { data, error } = await supabase.rpc("extend_room_session", {
    p_session_id: sessionId,
    p_minutes: minutes,
  });
  if (error) return { error };
  return { data: Array.isArray(data) ? data[0] : data };
}

export async function findMyActiveSyncSession() {
  const { data, error } = await supabase.rpc("find_my_active_sync_session");
  if (error) return { error };
  // RPC returns SETOF — supabase-js gives back an array; we asked the
  // function to LIMIT 1 so at most one row.
  return { data: Array.isArray(data) ? (data[0] || null) : (data || null) };
}

// Attach / detach a whiteboard to the active session — leader-only on the
// server (see 20260619160000_sync_session_whiteboard).
export async function linkWhiteboardToSession(sessionId, whiteboardId) {
  const { error } = await supabase.rpc("link_whiteboard_to_session", {
    p_session_id: sessionId,
    p_whiteboard_id: whiteboardId,
  });
  return { error };
}
export async function unlinkWhiteboardFromSession(sessionId) {
  const { error } = await supabase.rpc("unlink_whiteboard_from_session", {
    p_session_id: sessionId,
  });
  return { error };
}

// Meeting timer — leader-only controls. The timer state lives on
// sync_sessions and is broadcast to everyone via realtime; per-client
// math turns started_at + duration into a live countdown.
export async function startMeetingTimer(sessionId, durationSeconds, track) {
  const { error } = await supabase.rpc("start_meeting_timer", {
    p_session_id: sessionId,
    p_duration_seconds: durationSeconds,
    p_track: track ?? null,
  });
  return { error };
}
export async function pauseMeetingTimer(sessionId) {
  const { error } = await supabase.rpc("pause_meeting_timer", { p_session_id: sessionId });
  return { error };
}
export async function resumeMeetingTimer(sessionId) {
  const { error } = await supabase.rpc("resume_meeting_timer", { p_session_id: sessionId });
  return { error };
}
export async function stopMeetingTimer(sessionId) {
  const { error } = await supabase.rpc("stop_meeting_timer", { p_session_id: sessionId });
  return { error };
}

export async function fetchSyncSession(sessionId) {
  const { data, error } = await supabase
    .from("sync_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();
  return { data, error };
}

export async function refreshMySyncAvatar() {
  const { error } = await supabase.rpc("refresh_my_sync_avatar");
  return { error };
}

export async function kickSyncParticipant(sessionId, userId) {
  const { data, error } = await supabase.rpc("kick_sync_participant", {
    p_session_id: sessionId,
    p_user_id: userId,
  });
  if (error) return { error };
  if (data?.error) return { error: { message: data.error } };
  return { data };
}

export async function transferSyncLeader(sessionId, newLeaderId) {
  const { data, error } = await supabase.rpc("transfer_sync_leader", {
    p_session_id: sessionId,
    p_new_leader_id: newLeaderId,
  });
  if (error) return { error };
  if (data?.error) return { error: { message: data.error } };
  return { data };
}

export async function fetchSyncParticipants(sessionId) {
  const { data, error } = await supabase
    .from("sync_session_participants")
    .select("*")
    // Deterministic base order so the list doesn't reshuffle when a row is
    // updated (presence/status change). joined_at is the natural order;
    // user_id is a never-changing tiebreaker. The client re-sorts per the
    // user's chosen key (lib/participantSort), but this keeps every consumer
    // — including ones that don't re-sort — stable.
    .order("joined_at", { ascending: true })
    .order("user_id", { ascending: true })
    .eq("session_id", sessionId)
    .is("left_at", null);
  return { data: data || [], error };
}

// Stamp the caller's liveness for a session. Called on a steady cadence
// while a session is active so the server can tell who is *actually*
// present (vs. a ghost row left behind by a closed tab). Read-time
// liveness filtering and the empty-room sweeper key off last_seen_at.
// Fire-and-forget: a missed beat is harmless, the next one re-stamps.
export async function heartbeatSyncSession(sessionId) {
  const { error } = await supabase.rpc("heartbeat_sync_session", {
    p_session_id: sessionId,
  });
  return { error };
}

function takeControlErrorMessage(error) {
  const code = error?.code || "";
  const status = error?.status || error?.statusCode;
  const message = error?.message || "";

  if (
    code === "PGRST202"
    || status === 404
    || /function.*not found/i.test(message)
  ) {
    return "Take control is not available yet. Apply the Supabase migration 20260611120000_sync_controller.sql (Dashboard → SQL, or run supabase db push).";
  }

  // Prod hit this when 20260611120000 was applied but 20260611150000 was not:
  // take_sync_control updates controller_id, which the guard trigger treated as
  // metadata even though the caller is not yet the controller.
  if (/Only the leader may change session metadata/i.test(message)) {
    return "Take control needs a database update. Apply migration 20260611150000_fix_sync_controller_trigger.sql in Supabase (SQL Editor or supabase db push), then try again.";
  }

  return message || "Could not take control";
}

export async function takeSyncControl(sessionId) {
  const { data, error } = await supabase.rpc("take_sync_control", {
    p_session_id: sessionId,
  });
  if (error) return { error: { message: takeControlErrorMessage(error) } };
  if (data?.error) return { error: { message: data.error } };
  return { data };
}

export async function setSyncControlMode(sessionId, mode) {
  const { data, error } = await supabase.rpc("set_sync_control_mode", {
    p_session_id: sessionId,
    p_mode: mode,
  });
  if (error) return { error };
  if (data?.error) return { error: { message: data.error } };
  return { data };
}

export async function setSyncVisibility(sessionId, visibility) {
  const { data, error } = await supabase.rpc("set_sync_visibility", {
    p_session_id: sessionId,
    p_visibility: visibility,
  });
  if (error) return { error };
  if (data?.error) return { error: { message: data.error } };
  return { data };
}

// Active team sessions — leaders' display names come from user_settings;
// RLS for those is satisfied by the team_members policy on user_settings.
// Each row carries an `occupants` array so the rooms grid can render
// avatar stacks without a second request per tile.
export async function listActiveTeamSessions(teamId) {
  if (!teamId) return { data: [], error: null };
  const { data, error } = await supabase
    .from("sync_sessions")
    .select("*")
    .eq("team_id", teamId)
    .eq("status", "active")
    .eq("visibility", "team")
    .order("created_at", { ascending: false });
  if (error || !data?.length) return { data: data || [], error };

  // Join participants client-side.
  const sessionIds = data.map((s) => s.id);
  const { data: parts } = await supabase
    .from("sync_session_participants")
    .select("session_id, user_id, last_seen_at")
    .in("session_id", sessionIds)
    .is("left_at", null);

  // Read-time liveness: only count occupants seen within the grace
  // window. A participant row with left_at = null but a stale
  // last_seen_at is a ghost (closed tab), so it must not inflate the
  // hallway count or keep an abandoned room looking occupied.
  const liveCutoff = Date.now() - PRESENCE_GRACE_MS;
  const liveParts = (parts || []).filter((p) => {
    const seen = p.last_seen_at ? new Date(p.last_seen_at).getTime() : 0;
    return seen >= liveCutoff;
  });

  // Pull profiles for everyone we'll render (every leader + every live participant).
  const profileIds = [
    ...new Set([
      ...data.map((s) => s.leader_id),
      ...liveParts.map((p) => p.user_id),
    ]),
  ];
  // Identity (name + avatar) comes from `profiles` — readable by any co-member
  // (user_settings is only fetched as a name/avatar fallback). Availability now
  // comes from user_presence at render time (usePresenceById), not from here.
  let profileMap = new Map();
  if (profileIds.length) {
    const [{ data: profs }, { data: settings }] = await Promise.all([
      supabase.from("profiles").select("user_id, display_name, avatar_url").in("user_id", profileIds),
      supabase.from("user_settings").select("user_id, name, avatar_url").in("user_id", profileIds),
    ]);
    const profById = new Map((profs || []).map((r) => [r.user_id, r]));
    const setById = new Map((settings || []).map((r) => [r.user_id, r]));
    profileMap = new Map(profileIds.map((id) => {
      const p = profById.get(id);
      const s = setById.get(id);
      return [id, {
        name: p?.display_name || s?.name || "",
        avatar_url: p?.avatar_url || s?.avatar_url || "",
      }];
    }));
  }

  // Group live participants by session for the avatar stack.
  const occupantsBySession = new Map();
  for (const p of liveParts) {
    const list = occupantsBySession.get(p.session_id) || [];
    const prof = profileMap.get(p.user_id);
    list.push({
      user_id: p.user_id,
      name: prof?.name || "Team member",
      avatar_url: prof?.avatar_url || "",
    });
    occupantsBySession.set(p.session_id, list);
  }

  return {
    // Drop sessions with no live occupant: they're abandoned ghosts, so
    // the room should read as empty ("Start a session"), not occupied.
    // The next start reconciles the ghost away (createSyncSession).
    data: data
      .map((s) => ({
        ...s,
        leader_name: profileMap.get(s.leader_id)?.name || "Team member",
        leader_avatar: profileMap.get(s.leader_id)?.avatar_url || "",
        participant_count: (occupantsBySession.get(s.id) || []).length,
        occupants: occupantsBySession.get(s.id) || [],
      }))
      .filter((s) => s.occupants.length > 0),
    error: null,
  };
}

export async function getSyncSessionPreview(joinCode) {
  const { data, error } = await supabase.rpc("get_sync_session_preview", {
    p_join_code: joinCode.trim().toUpperCase(),
  });
  if (error) return { error };
  if (data?.error) return { error: { message: data.error } };
  return { data };
}

