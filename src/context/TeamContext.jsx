import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from "react";
import { supabase } from "../supabase";
import {
  formatDuration, formatMoney, formatMonthLabel, weekStart, weekRangeLabel,
  toDisplayTime, downloadFile, unpaidBreakMins,
} from "../lib/utils";
import { listActiveTeamSessions } from "../lib/syncSession";
import { listRooms } from "../lib/rooms";
import { listOrgTeams, listMyOrgTeams, listOrgTeamMembershipsForOrg } from "../lib/orgTeam";
import { setMemberHR as setMemberHRRpc } from "../lib/hr";
import { useVisibilityPausedInterval } from "../hooks/useVisibilityPausedInterval";
import {
  listTeamSounds, addTeamSound as addTeamSoundRpc,
  renameTeamSound as renameTeamSoundRpc, removeTeamSound as removeTeamSoundRpc,
} from "../lib/teamSound";

// Exported so a provider-less surface (e.g. the public /w/:id whiteboard viewer)
// can supply a minimal stand-in value instead of the full TeamProvider.
export const TeamContext = createContext(null);

export function TeamProvider({ session, children }) {
  const [teams, setTeams] = useState([]);
  // Default org = the "home" org to open to when there's no remembered
  // selection yet (first load / new device). It must NOT override an
  // explicit switch: once you switchTeam, ql_active_team is remembered and
  // wins on the next load, so a reload/relaunch keeps the org you're
  // actually in. (Previously the default was read FIRST and clobbered the
  // current selection on every reload — the "wrong org" bug.)
  const [defaultTeamId, setDefaultTeamIdState] = useState(() =>
    localStorage.getItem("ql_default_team") || null
  );
  const [activeTeamId, setActiveTeamId] = useState(() =>
    localStorage.getItem("ql_active_team") ||
    localStorage.getItem("ql_default_team") ||
    null
  );
  const [teamMembers, setTeamMembers] = useState([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [activeTeamSessions, setActiveTeamSessions] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [teamSounds, setTeamSounds] = useState([]);
  const [orgTeams, setOrgTeams] = useState([]);
  const [myOrgTeamIds, setMyOrgTeamIds] = useState(new Set());
  const [myOrgTeamLeadIds, setMyOrgTeamLeadIds] = useState(new Set());
  // Map<userId, Array<{id, name, color, role}>>: which org_teams each
  // person belongs to. Powers <MemberIdentity /> so every sync session,
  // retro, and room card can render team chips off shared state.
  const [teamsByUserId, setTeamsByUserId] = useState(new Map());
  // Map<org_team_id, member count> — derived from the same query that
  // builds teamsByUserId, so we avoid the previous N+1 per-team fetch.
  const [orgTeamMemberCounts, setOrgTeamMemberCounts] = useState(new Map());

  const userId = session?.user?.id;
  // Read the latest activeTeamId without retriggering loadTeams.
  const activeTeamIdRef = useRef(activeTeamId);
  activeTeamIdRef.current = activeTeamId;
  // Guards a single retry when a cold/warm-up load comes back WITHOUT the
  // team we remember being in — whether empty or a partial subset (RLS not
  // warm yet). Reset once we get a result we trust.
  const coldRetriedRef = useRef(false);

  // ── Load teams ──────────────────────────────────────────────
  // Important: this callback intentionally does NOT depend on activeTeamId.
  // The previous version did, which caused the load effect to re-fire on
  // every active-team change and could race with an in-flight initial load
  // — sometimes the racing fetch returned 0 rows (auth not yet warm),
  // which cleared the user's persisted active team and left the UI empty.
  const loadTeams = useCallback(async () => {
    if (!userId) return;
    setTeamLoading(true);
    const { data, error } = await supabase
      .from("team_members")
      .select("team_id, role, is_owner, teams(id, name, invite_code, created_by, created_at, icon_url, color, office_vibe, sounds_admin_only, channels_auto_join)")
      .eq("user_id", userId);
    setTeamLoading(false);

    // Network / auth / RLS error: bail without clobbering state. A follow-up
    // load (focus, auth refresh, manual retry) can recover.
    if (error) {
      console.warn("loadTeams:", error.message);
      return;
    }

    const loaded = (data || [])
      .map((m) => (m.teams ? { ...m.teams, role: m.role, isOwner: !!m.is_owner } : null))
      .filter(Boolean);

    // Auth race-guard. On a fresh refresh / cold load the access token
    // sometimes isn't warm yet — RLS evaluates auth.uid() to null and returns
    // 0 rows, or a partial subset, before it settles. If the team we REMEMBER
    // being in isn't in the result, treat it as a possibly-transient miss and
    // retry once before trusting it. Without this we'd either flip to "no
    // teams yet" (empty) or silently switch the user to loaded[0] and
    // overwrite ql_active_team (partial result) — the "wrong org" bug.
    const current = activeTeamIdRef.current;
    const currentMissing = current && !loaded.find((t) => t.id === current);
    if (currentMissing && !coldRetriedRef.current) {
      coldRetriedRef.current = true;
      setTimeout(() => loadTeams(), 600);
      return;
    }
    // Past the guard: the remembered team is present, there's no remembered
    // team, or we already retried once — trust this result now.
    coldRetriedRef.current = false;

    setTeams(loaded);

    if (loaded.length === 0) {
      // Genuinely no teams (after the retry) — drop the stale pointer.
      if (current) {
        setActiveTeamId(null);
        localStorage.removeItem("ql_active_team");
      }
      return;
    }
    // Clean up a stale default-org pointer (e.g. user left that team).
    const storedDefault = localStorage.getItem("ql_default_team");
    if (storedDefault && !loaded.find((t) => t.id === storedDefault)) {
      localStorage.removeItem("ql_default_team");
      setDefaultTeamIdState(null);
    }
    // Auto-select if we have none, or if the stored one is no longer valid.
    if (!current || !loaded.find((t) => t.id === current)) {
      const next = loaded[0].id;
      setActiveTeamId(next);
      localStorage.setItem("ql_active_team", next);
    }
  }, [userId]);

  useEffect(() => { loadTeams(); }, [loadTeams]);

  // Self-heal: re-fetch teams when the tab regains focus or when supabase
  // refreshes/restores the auth token. Covers the laptop-lid case where
  // the initial load fired before the access token was warm.
  useEffect(() => {
    if (!userId) return;
    function onVisible() { if (!document.hidden) loadTeams(); }
    document.addEventListener("visibilitychange", onVisible);
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") loadTeams();
    });
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      subscription.unsubscribe();
    };
  }, [userId, loadTeams]);

  // ── Load members when active team changes ──────────────────
  // Uses a security-definer RPC because `user_settings` RLS only exposes
  // co-member rows to team admins. A direct join-to-user_settings returned
  // nothing for regular members, so member names + avatars never showed.
  const loadMembers = useCallback(async () => {
    const teamId = activeTeamId;
    if (!teamId) { setTeamMembers([]); return; }
    const { data, error } = await supabase.rpc("get_team_member_profiles", {
      p_team_id: teamId,
    });
    if (error) { console.warn("loadMembers:", error.message); return; }
    if (activeTeamIdRef.current !== teamId) return;
    setTeamMembers(data || []);
  }, [activeTeamId]);

  useEffect(() => { loadMembers(); }, [loadMembers]);

  // Realtime: refresh the member list whenever someone joins or leaves
  // the active team. user_settings updates (name / avatar / status) are
  // patched in place from the payload instead.
  // Guard against the team switching after the channel was subscribed:
  // a late event firing from the old channel would otherwise call into
  // the (newly-rebuilt) loadMembers with the *new* team, applying the
  // old team's data to the new team's UI for a tick.
  useEffect(() => {
    if (!activeTeamId) return;
    const teamIdAtSub = activeTeamId;
    const channel = supabase
      .channel(`team-members:${activeTeamId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "team_members", filter: `team_id=eq.${activeTeamId}` },
        () => {
          if (activeTeamIdRef.current !== teamIdAtSub) return;
          loadMembers();
          loadTeams();
        },
      )
      .on(
        // Unfiltered — user_settings has no team key to filter on. Patch
        // the one changed member in place rather than re-running the full
        // get_team_member_profiles RPC on every org-wide settings update
        // (presence flips, clock ticks — many per minute on a busy team).
        // Membership add/remove is covered by the filtered team_members
        // listener above. Defaults mirror the RPC's coalesces.
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "user_settings" },
        (payload) => {
          if (activeTeamIdRef.current !== teamIdAtSub) return;
          const row = payload.new;
          if (!row?.user_id) return;
          setTeamMembers((prev) => {
            const i = prev.findIndex((m) => m.user_id === row.user_id);
            if (i === -1) return prev; // not in this team — ignore
            const next = [...prev];
            next[i] = {
              ...next[i],
              name: row.name || "Team member",
              avatar_url: row.avatar_url || "",
              status: row.status || "",
              status_updated_at: row.status_updated_at ?? null,
              sticky_color: row.sticky_color || "#fde68a",
            };
            return next;
          });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [activeTeamId, loadMembers, loadTeams]);

  // ── Active team pomodoro sessions ──────────────────────────
  const loadActiveTeamSessions = useCallback(async () => {
    const teamId = activeTeamId;
    if (!teamId) { setActiveTeamSessions([]); return; }
    const { data } = await listActiveTeamSessions(teamId);
    if (activeTeamIdRef.current !== teamId) return;
    setActiveTeamSessions(data || []);
  }, [activeTeamId]);

  useEffect(() => { loadActiveTeamSessions(); }, [loadActiveTeamSessions]);

  // ── Rooms ──────────────────────────────────────────────────
  // Guard against a stale write: a slow in-flight fetch for the org we
  // just switched away from must not land after (and clobber) the new
  // org's rooms. Without this, switching orgs — or the double team-set
  // on initial load when loadTeams auto-selects a different team — can
  // leave the floor plan showing the previous org under the new org's
  // name until the next refetch.
  const loadRoomsForActiveTeam = useCallback(async () => {
    const teamId = activeTeamId;
    if (!teamId) { setRooms([]); return; }
    const { data } = await listRooms(teamId);
    if (activeTeamIdRef.current !== teamId) return;
    setRooms(data || []);
  }, [activeTeamId]);

  useEffect(() => { loadRoomsForActiveTeam(); }, [loadRoomsForActiveTeam]);

  // ── Team sounds (shared with all team members) ─────────────
  const loadTeamSoundsForActive = useCallback(async () => {
    const teamId = activeTeamId;
    if (!teamId) { setTeamSounds([]); return; }
    const { data } = await listTeamSounds(teamId);
    if (activeTeamIdRef.current !== teamId) return;
    setTeamSounds(data || []);
  }, [activeTeamId]);

  useEffect(() => { loadTeamSoundsForActive(); }, [loadTeamSoundsForActive]);

  // Realtime so a new upload from another admin shows up everywhere
  // without a refresh.
  useEffect(() => {
    if (!activeTeamId) return;
    const teamIdAtSub = activeTeamId;
    const channel = supabase
      .channel(`team-sounds:${activeTeamId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "team_sounds", filter: `team_id=eq.${activeTeamId}` },
        () => {
          if (activeTeamIdRef.current !== teamIdAtSub) return;
          loadTeamSoundsForActive();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [activeTeamId, loadTeamSoundsForActive]);

  const addTeamSound = useCallback(async (file, name) => {
    const teamId = activeTeamIdRef.current;
    if (!teamId || !userId) return { error: { message: "Not signed in" } };
    const res = await addTeamSoundRpc({ teamId, file, userId, name });
    if (!res.error && res.data) setTeamSounds((prev) => [...prev, res.data]);
    return res;
  }, [userId]);

  const renameTeamSound = useCallback(async (soundId, name) => {
    const res = await renameTeamSoundRpc(soundId, name);
    if (!res.error && res.data) {
      setTeamSounds((prev) => prev.map((s) => s.id === res.data.id ? res.data : s));
    }
    return res;
  }, []);

  const removeTeamSound = useCallback(async (sound) => {
    const res = await removeTeamSoundRpc(sound);
    if (!res.error) setTeamSounds((prev) => prev.filter((s) => s.id !== sound.id));
    return res;
  }, []);

  // Permission helpers — the page UI consults these rather than checking
  // role + flag inline at every render. RLS still enforces; this is for UX.
  // We resolve activeTeam + isAdmin inline because the memoized versions
  // further down in this provider aren't in scope yet at this point.
  const activeTeamForFlag = teams.find((t) => t.id === activeTeamId) || null;
  const isAdminForFlag = activeTeamForFlag?.role === "admin";
  const teamSoundsAdminOnly = activeTeamForFlag?.sounds_admin_only !== false; // default true
  const canUploadTeamSound = !!activeTeamForFlag && (isAdminForFlag || !teamSoundsAdminOnly);
  const canManageTeamSound = useCallback((sound) => {
    if (!sound) return false;
    if (isAdminForFlag) return true;
    return sound.created_by === userId;
  }, [isAdminForFlag, userId]);

  // Realtime: refresh rooms when any change to this team's rooms lands.
  useEffect(() => {
    if (!activeTeamId) return;
    const teamIdAtSub = activeTeamId;
    const channel = supabase
      .channel(`team-rooms:${activeTeamId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms", filter: `team_id=eq.${activeTeamId}` },
        () => {
          if (activeTeamIdRef.current !== teamIdAtSub) return;
          loadRoomsForActiveTeam();
        },
      )
      .on(
        // Gating changes — a room being restricted to a team, or that
        // restriction lifted — must refresh visibility for every viewer.
        "postgres_changes",
        { event: "*", schema: "public", table: "room_teams" },
        () => {
          if (activeTeamIdRef.current !== teamIdAtSub) return;
          loadRoomsForActiveTeam();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [activeTeamId, loadRoomsForActiveTeam]);

  // ── Org teams (sub-teams within an org) ────────────────────
  // These are the real "Team" entities — SWE, PM, HR, etc. —
  // replacing the deprecated tag-on-team_member shape. Membership
  // gates room/retro access.
  const loadOrgTeamsForActive = useCallback(async () => {
    const teamId = activeTeamId;
    if (!teamId) {
      setOrgTeams([]);
      setMyOrgTeamIds(new Set());
      setMyOrgTeamLeadIds(new Set());
      setTeamsByUserId(new Map());
      setOrgTeamMemberCounts(new Map());
      return;
    }
    // Per-slice error handling: one failed fetch must not reject the whole
    // Promise.all (or clear the other slices) and leave the org UI stuck.
    // A slice that errors keeps its previous state; the rest still apply.
    const settle = (p, label) => p.then(
      (res) => {
        if (res?.error) console.warn(`loadOrgTeamsForActive ${label}:`, res.error.message);
        return res;
      },
      (e) => {
        console.warn(`loadOrgTeamsForActive ${label}:`, e?.message || e);
        return { data: null, error: e };
      },
    );
    const [listRes, mineRes, membershipsRes] = await Promise.all([
      settle(listOrgTeams(teamId), "teams"),
      userId ? settle(listMyOrgTeams(teamId, userId), "mine") : Promise.resolve({ data: [] }),
      settle(listOrgTeamMembershipsForOrg(teamId), "memberships"),
    ]);
    // Bail if the user switched orgs while these were in flight — applying
    // them now would bleed the previous org's teams into the new one.
    if (activeTeamIdRef.current !== teamId) return;
    const list = listRes.error ? null : (listRes.data || []);
    const mine = mineRes.error ? null : (mineRes.data || []);
    const allMemberships = membershipsRes.error ? null : (membershipsRes.data || []);
    if (list) setOrgTeams(list);
    if (mine) {
      setMyOrgTeamIds(new Set(mine.map((r) => r.org_team_id)));
      setMyOrgTeamLeadIds(new Set(mine.filter((r) => r.role === "lead").map((r) => r.org_team_id)));
    }

    // Build the userId → teams map from a single allMemberships query
    // joined against the team list we just fetched. Needs both slices.
    if (list && allMemberships) {
      const teamById = new Map(list.map((t) => [t.id, t]));
      const next = new Map();
      const counts = new Map();
      for (const m of allMemberships) {
        const team = teamById.get(m.org_team_id);
        if (!team) continue; // team archived; skip
        const arr = next.get(m.user_id) || [];
        arr.push({ id: team.id, name: team.name, color: team.color, role: m.role });
        next.set(m.user_id, arr);
        counts.set(team.id, (counts.get(team.id) || 0) + 1);
      }
      setTeamsByUserId(next);
      setOrgTeamMemberCounts(counts);
    }
  }, [activeTeamId, userId]);

  useEffect(() => {
    setOrgTeams([]);
    setMyOrgTeamIds(new Set());
    setMyOrgTeamLeadIds(new Set());
    setTeamsByUserId(new Map());
    setOrgTeamMemberCounts(new Map());
  }, [activeTeamId]);

  useEffect(() => { loadOrgTeamsForActive(); }, [loadOrgTeamsForActive]);

  // Realtime: pick up changes to either the team list or my memberships.
  useEffect(() => {
    if (!activeTeamId) return;
    const teamIdAtSub = activeTeamId;
    const channel = supabase
      .channel(`org-teams:${activeTeamId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "org_teams", filter: `org_id=eq.${activeTeamId}` },
        () => {
          if (activeTeamIdRef.current !== teamIdAtSub) return;
          loadOrgTeamsForActive();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "org_team_members" },
        () => {
          if (activeTeamIdRef.current !== teamIdAtSub) return;
          loadOrgTeamsForActive();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [activeTeamId, loadOrgTeamsForActive]);

  // Realtime: refresh when team sessions change.
  useEffect(() => {
    if (!activeTeamId) return;
    const teamIdAtSub = activeTeamId;

    // Participant rows now also change on every heartbeat (~20s per
    // connected user, org-wide on this unfiltered subscription — the
    // table has no team key to filter on server-side), so coalesce that
    // handler into a short trailing debounce — a burst of heartbeats
    // collapses into one reload — and skip it while the tab is hidden
    // (the visibility-paused poll below catches up on return). Session
    // start/stop/end (sync_sessions, team-filtered, low volume) stays
    // immediate so join/leave still feels snappy.
    let partDebounce = null;
    const reloadOnParticipantChange = () => {
      if (activeTeamIdRef.current !== teamIdAtSub) return;
      if (document.hidden) return;
      if (partDebounce) clearTimeout(partDebounce);
      partDebounce = setTimeout(loadActiveTeamSessions, 1500);
    };

    const channel = supabase
      .channel(`team-sessions:${activeTeamId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sync_sessions", filter: `team_id=eq.${activeTeamId}` },
        () => {
          if (activeTeamIdRef.current !== teamIdAtSub) return;
          loadActiveTeamSessions();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sync_session_participants" },
        reloadOnParticipantChange,
      )
      .subscribe();
    return () => {
      if (partDebounce) clearTimeout(partDebounce);
      supabase.removeChannel(channel);
    };
  }, [activeTeamId, loadActiveTeamSessions]);

  // Lightweight polling fallback every 30s; also re-evaluates read-time
  // liveness so an abandoned room drops off the hallway on its own.
  // Pauses while the tab is hidden, firing once on return to visible.
  useVisibilityPausedInterval(loadActiveTeamSessions, 30000, { enabled: !!activeTeamId });

  // ── Team CRUD ──────────────────────────────────────────────
  const createTeam = useCallback(async (name) => {
    const { data, error } = await supabase
      .from("teams")
      .insert({ name, created_by: userId })
      .select()
      .single();
    if (error) return { error };
    // auto-add self as admin
    await supabase.from("team_members").insert({
      team_id: data.id,
      user_id: userId,
      role: "admin",
    });
    await loadTeams();
    setActiveTeamId(data.id);
    localStorage.setItem("ql_active_team", data.id);
    return { data };
  }, [userId, loadTeams]);

  const joinTeam = useCallback(async (inviteCode) => {
    const { data, error } = await supabase.rpc("join_team_by_code", {
      code: inviteCode.trim().toLowerCase(),
    });
    if (error) return { error };
    await loadTeams();
    if (data) {
      setActiveTeamId(data);
      localStorage.setItem("ql_active_team", data);
    }
    return { data };
  }, [loadTeams]);

  const leaveTeam = useCallback(async (teamId) => {
    await supabase
      .from("team_members")
      .delete()
      .eq("team_id", teamId)
      .eq("user_id", userId);
    await loadTeams();
  }, [userId, loadTeams]);

  const switchTeam = useCallback((teamId) => {
    setActiveTeamId(teamId);
    localStorage.setItem("ql_active_team", teamId || "");
  }, []);

  const setDefaultTeam = useCallback((teamId) => {
    if (teamId) {
      localStorage.setItem("ql_default_team", teamId);
      setDefaultTeamIdState(teamId);
    } else {
      localStorage.removeItem("ql_default_team");
      setDefaultTeamIdState(null);
    }
  }, []);

  // ── Admin functions ────────────────────────────────────────
  const removeMember = useCallback(async (teamId, memberId) => {
    await supabase
      .from("team_members")
      .delete()
      .eq("team_id", teamId)
      .eq("user_id", memberId);
    await loadMembers();
  }, [loadMembers]);

  const changeMemberRole = useCallback(async (teamId, memberId, newRole) => {
    await supabase
      .from("team_members")
      .update({ role: newRole })
      .eq("team_id", teamId)
      .eq("user_id", memberId);
    await loadMembers();
  }, [loadMembers]);

  // ── Ownership (owner-only) ────────────────────────────────────
  // grant_team_owner promotes a member to co-owner; revoke_team_owner
  // demotes back to admin (last-owner guard server-side);
  // transfer_team_ownership swaps in one atomic step.
  const grantTeamOwner = useCallback(async (teamId, memberId) => {
    const { error } = await supabase.rpc("grant_team_owner", {
      p_team_id: teamId,
      p_user_id: memberId,
    });
    if (!error) {
      await loadMembers();
      await loadTeams();
    }
    return { error };
  }, [loadMembers, loadTeams]);
  const revokeTeamOwner = useCallback(async (teamId, memberId) => {
    const { error } = await supabase.rpc("revoke_team_owner", {
      p_team_id: teamId,
      p_user_id: memberId,
    });
    if (!error) {
      await loadMembers();
      await loadTeams();
    }
    return { error };
  }, [loadMembers, loadTeams]);
  const transferTeamOwnership = useCallback(async (teamId, newOwnerId) => {
    const { error } = await supabase.rpc("transfer_team_ownership", {
      p_team_id: teamId,
      p_new_owner_id: newOwnerId,
    });
    if (!error) {
      await loadMembers();
      await loadTeams();
    }
    return { error };
  }, [loadMembers, loadTeams]);

  // Admin: update a member's HR fields (salary vs hourly, rate, target).
  const updateMemberHR = useCallback(async (teamId, memberId, patch) => {
    const { error } = await setMemberHRRpc(teamId, memberId, patch);
    if (!error) await loadMembers();
    return { error };
  }, [loadMembers]);

  // Patch team metadata (name, icon_url, color, office_vibe). Admin-only by RLS.
  const updateTeam = useCallback(async (teamId, patch) => {
    const allowed = {};
    if (patch.name !== undefined) allowed.name = patch.name;
    if (patch.icon_url !== undefined) allowed.icon_url = patch.icon_url;
    if (patch.color !== undefined) allowed.color = patch.color;
    if (patch.office_vibe !== undefined) allowed.office_vibe = patch.office_vibe;
    if (patch.sounds_admin_only !== undefined) allowed.sounds_admin_only = patch.sounds_admin_only;
    if (patch.channels_auto_join !== undefined) allowed.channels_auto_join = patch.channels_auto_join;
    if (Object.keys(allowed).length === 0) return { data: null };
    const { data, error } = await supabase
      .from("teams")
      .update(allowed)
      .eq("id", teamId)
      .select()
      .single();
    if (!error) await loadTeams();
    return { data, error };
  }, [loadTeams]);

  const regenerateInviteCode = useCallback(async (teamId) => {
    const newCode = [...crypto.getRandomValues(new Uint8Array(6))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const { error } = await supabase
      .from("teams")
      .update({ invite_code: newCode })
      .eq("id", teamId);
    if (!error) await loadTeams();
    return { error };
  }, [loadTeams]);

  const deleteTeam = useCallback(async (teamId) => {
    const { error } = await supabase.from("teams").delete().eq("id", teamId);
    if (!error) await loadTeams();
    return { error };
  }, [loadTeams]);

  // ── Timesheet fetching ─────────────────────────────────────
  // useCallback (stable identity): the admin timesheet page lists this in a
  // fetch effect's deps. As a plain function it was recreated every render, so
  // the effect re-ran on every render → refetch → setMemberData → re-render →
  // loop (the page kept reloading and resetting). It only uses `supabase` and
  // its args, so empty deps are correct.
  const fetchMemberEntries = useCallback(async (teamId, monthStr) => {
    // monthStr = "YYYY-MM"
    const startDate = `${monthStr}-01`;
    const endMonth = new Date(startDate + "T12:00:00");
    endMonth.setMonth(endMonth.getMonth() + 1);
    endMonth.setDate(0); // last day of month
    const endDate = `${endMonth.getFullYear()}-${String(endMonth.getMonth() + 1).padStart(2, "0")}-${String(endMonth.getDate()).padStart(2, "0")}`;

    // get team member IDs
    const { data: members } = await supabase
      .from("team_members")
      .select("user_id")
      .eq("team_id", teamId);
    if (!members?.length) return [];
    const memberIds = members.map((m) => m.user_id);

    // fetch entries
    const { data: entries } = await supabase
      .from("entries")
      .select("*")
      .in("user_id", memberIds)
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: true });

    // fetch names + avatars
    const { data: settingsData } = await supabase
      .from("user_settings")
      .select("user_id, name, avatar_url")
      .in("user_id", memberIds);
    const settingsMap = new Map((settingsData || []).map((s) => [s.user_id, s]));

    // fetch projects — include `color` so the admin timesheet view
    // can tint each entry row by its primary project.
    const { data: projectsData } = await supabase
      .from("projects")
      .select("id, name, color, user_id")
      .in("user_id", memberIds);
    const projectMap = new Map((projectsData || []).map((p) => [p.id, p]));

    // group by member
    const byMember = {};
    for (const e of (entries || [])) {
      const normalized = { ...e, start: e.start?.slice(0, 5) || "", end: e.end_time?.slice(0, 5) || "" };
      if (!byMember[e.user_id]) byMember[e.user_id] = [];
      byMember[e.user_id].push(normalized);
    }

    return memberIds.map((uid) => ({
      userId: uid,
      name: settingsMap.get(uid)?.name || "Team Member",
      avatar_url: settingsMap.get(uid)?.avatar_url || "",
      entries: byMember[uid] || [],
      projectMap,
    }));
  }, []);

  // ── Team export: CSV ───────────────────────────────────────
  const exportTeamCSV = useCallback(async (teamId, monthStr) => {
    const memberData = await fetchMemberEntries(teamId, monthStr);
    const team = teams.find((t) => t.id === teamId);
    const csv = (val) => { const s = String(val ?? ""); return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s; };
    const row = (...cells) => cells.map(csv).join(",");
    const rows = [];
    rows.push(csv(`${team?.name || "Team"} Timesheet – ${formatMonthLabel(monthStr)}`));
    rows.push("");
    rows.push(row("Member", "Date", "Start", "End", "Project", "Billable", "Unpaid Break (mins)", "Hours Worked", "Description"));
    for (const member of memberData) {
      for (const e of member.entries) {
        const bm = unpaidBreakMins(e);
        const projectName = (e.project_ids || []).map((id) => member.projectMap.get(id)?.name).filter(Boolean).join(", ");
        rows.push(row(
          member.name,
          e.date,
          toDisplayTime(e.start),
          toDisplayTime(e.end),
          projectName,
          e.billable === false ? "No" : "Yes",
          bm > 0 ? bm : "",
          formatDuration(e.minutes),
          e.description || "",
        ));
      }
    }
    downloadFile(
      new Blob([rows.join("\n")], { type: "text/csv" }),
      `${(team?.name || "team").toLowerCase().replace(/\s+/g, "_")}_${monthStr}.csv`,
    );
  }, [fetchMemberEntries, teams]);

  // ── Team export: XLSX (multi-sheet) ────────────────────────
  const exportTeamXLSX = useCallback(async (teamId, monthStr) => {
    const memberData = await fetchMemberEntries(teamId, monthStr);
    const team = teams.find((t) => t.id === teamId);
    const { default: ExcelJS } = await import("exceljs");

    const NAVY = "FF1F3864", BLUE = "FF4472C4", WHITE = "FFFFFFFF", LIGHT = "FFF0F4FA";
    const navyFill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    const blueFill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    const lightFill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
    const whiteFont = { color: { argb: WHITE }, bold: true, name: "Calibri", size: 11 };
    const boldFont = { bold: true, name: "Calibri", size: 11 };
    const baseFont = { name: "Calibri", size: 11 };
    const thinBorder = { style: "thin", color: { argb: "FFD0D7E3" } };
    const cellBorder = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
    const styleAll = (r, style) => r.eachCell({ includeEmpty: true }, (cell) => Object.assign(cell, { style }));

    const wb = new ExcelJS.Workbook();

    // Summary sheet
    const summary = wb.addWorksheet("Summary");
    summary.columns = [{ width: 30 }, { width: 20 }, { width: 20 }];
    const titleRow = summary.addRow([`${team?.name || "Team"} – ${formatMonthLabel(monthStr)}`]);
    summary.mergeCells(titleRow.number, 1, titleRow.number, 3);
    titleRow.height = 24;
    titleRow.getCell(1).style = { font: { bold: true, size: 14, name: "Calibri" }, alignment: { horizontal: "center", vertical: "middle" } };
    summary.addRow([]);
    const hdr = summary.addRow(["Member", "Total Hours", "Total Entries"]);
    hdr.height = 20;
    styleAll(hdr, { fill: navyFill, font: whiteFont, border: cellBorder, alignment: { vertical: "middle" } });

    for (const member of memberData) {
      const totalMins = member.entries.reduce((a, e) => a + (e.minutes || 0), 0);
      const r = summary.addRow([member.name, formatDuration(totalMins), member.entries.length]);
      r.height = 18;
      styleAll(r, { font: baseFont, border: cellBorder, alignment: { vertical: "middle" } });
    }

    // Per-member sheets
    for (const member of memberData) {
      if (!member.entries.length) continue;
      const sheetName = (member.name || "Member").slice(0, 31);
      const ws = wb.addWorksheet(sheetName);
      const cols = [20, 12, 12, 18, 10, 22, 16, 38];
      ws.columns = cols.map((width) => ({ width }));
      const numCols = cols.length;
      const merge = (r) => ws.mergeCells(r.number, 1, r.number, numCols);

      const mTitle = ws.addRow([`${member.name} – ${formatMonthLabel(monthStr)}`]);
      merge(mTitle); mTitle.height = 24;
      mTitle.getCell(1).style = { font: { bold: true, size: 14, name: "Calibri" }, alignment: { horizontal: "center", vertical: "middle" } };
      ws.addRow([]).height = 6;

      const headerRow = ws.addRow(["Date", "Start", "End", "Project", "Billable", "Unpaid Break (mins)", "Hours Worked", "Description"]);
      headerRow.height = 20;
      styleAll(headerRow, { fill: navyFill, font: whiteFont, border: cellBorder, alignment: { vertical: "middle" } });

      // Group by week
      const wkMap = new Map();
      for (const e of member.entries) {
        const wk = weekStart(e.date);
        if (!wkMap.has(wk)) wkMap.set(wk, []);
        wkMap.get(wk).push(e);
      }

      let grandMins = 0;
      for (const [wkStr, wkEntries] of wkMap) {
        const wkLabel = weekRangeLabel(wkStr);
        const weekMins = wkEntries.reduce((a, e) => a + (e.minutes || 0), 0);
        const wkRow = ws.addRow([wkLabel, "", "", "", "", "", formatDuration(weekMins), ""]);
        wkRow.height = 22;
        styleAll(wkRow, { fill: navyFill, font: whiteFont, border: cellBorder, alignment: { vertical: "middle" } });

        // Group by day
        const byDay = new Map();
        for (const e of wkEntries) {
          if (!byDay.has(e.date)) byDay.set(e.date, []);
          byDay.get(e.date).push(e);
        }
        for (const [date, dayEntries] of byDay) {
          const dayMins = dayEntries.reduce((a, e) => a + (e.minutes || 0), 0);
          const dayLabel = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
          const dayRow = ws.addRow([dayLabel, "", "", "", "", "", formatDuration(dayMins), ""]);
          dayRow.height = 18;
          styleAll(dayRow, { fill: lightFill, font: boldFont, border: cellBorder, alignment: { vertical: "middle" } });
          for (const e of dayEntries) {
            const bm = unpaidBreakMins(e);
            const projectName = (e.project_ids || []).map((id) => member.projectMap.get(id)?.name).filter(Boolean).join(", ");
            const entryRow = ws.addRow([
              "", toDisplayTime(e.start), toDisplayTime(e.end), projectName,
              e.billable === false ? "No" : "Yes", bm > 0 ? bm : "",
              formatDuration(e.minutes), e.description || "",
            ]);
            entryRow.height = 16;
            styleAll(entryRow, { font: baseFont, border: cellBorder, alignment: { vertical: "middle" } });
          }
          grandMins += dayMins;
        }
        ws.addRow([]).height = 8;
      }
      const totalRow = ws.addRow(["TOTAL", "", "", "", "", "", formatDuration(grandMins), ""]);
      totalRow.height = 20;
      styleAll(totalRow, { font: boldFont, border: cellBorder, alignment: { vertical: "middle" } });
    }

    const buffer = await wb.xlsx.writeBuffer();
    downloadFile(
      new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      `${(team?.name || "team").toLowerCase().replace(/\s+/g, "_")}_${monthStr}.xlsx`,
    );
  }, [fetchMemberEntries, teams]);

  // ── Active team helpers ────────────────────────────────────
  const activeTeam = teams.find((t) => t.id === activeTeamId) || null;
  const isAdmin = activeTeam?.role === "admin";
  const isOwner = !!activeTeam?.isOwner;

  // Filter rooms by team gating for the current viewer.
  //  * Admins always see every room.
  //  * Rooms with no room_teams rows are org-wide → visible to all members.
  //  * Rooms with gating rows are visible only when the viewer's
  //    org_team memberships intersect the gating set.
  // Realtime: see the team-rooms channel above — both `rooms` and
  // `room_teams` changes trigger loadRoomsForActiveTeam, so this
  // memo re-derives the moment gating shifts.
  const visibleRooms = useMemo(() => {
    if (!rooms || rooms.length === 0) return rooms;
    if (isAdmin) return rooms;
    return rooms.filter((r) => {
      const gating = r.room_teams || [];
      if (gating.length === 0) return true;
      return gating.some((rt) => myOrgTeamIds.has(rt.org_team_id));
    });
  }, [rooms, isAdmin, myOrgTeamIds]);

  // Rooms gated to org_teams the viewer is NOT a member of. Surfaced
  // in the hallway / office overlay as locked tiles so people can see
  // what exists across the office without being able to enter. Admins
  // never have locked rooms (they bypass gating).
  const lockedRooms = useMemo(() => {
    if (!rooms || rooms.length === 0) return [];
    if (isAdmin) return [];
    return rooms.filter((r) => {
      const gating = r.room_teams || [];
      if (gating.length === 0) return false;
      return !gating.some((rt) => myOrgTeamIds.has(rt.org_team_id));
    });
  }, [rooms, isAdmin, myOrgTeamIds]);

  // Room ids gated to a department the viewer is NOT a member of — computed for
  // EVERYONE, admins included. Non-admins can't enter these (they're their
  // lockedRooms, click-blocked). Admins DO bypass the block (they can still
  // enter for management), but the UI uses this set to badge those rooms as
  // locked so the gating stays visible — an admin shouldn't think a department
  // room is open to all just because they personally can walk in.
  const restrictedRoomIds = useMemo(() => {
    const s = new Set();
    for (const r of rooms || []) {
      const gating = r.room_teams || [];
      if (gating.length === 0) continue;
      if (!gating.some((rt) => myOrgTeamIds.has(rt.org_team_id))) s.add(r.id);
    }
    return s;
  }, [rooms, myOrgTeamIds]);

  // Stable value identity: consumers of useTeam() only re-render when
  // something they read actually changed, not on every provider render.
  // Every referenced binding is either state, a memo, or a useCallback —
  // all listed in the deps below.
  const value = useMemo(() => ({
    teams, activeTeam, activeTeamId, teamMembers, teamLoading, isAdmin, isOwner,
    defaultTeamId, setDefaultTeam,
    loadTeams, loadMembers, switchTeam,
    createTeam, joinTeam, leaveTeam, deleteTeam, updateTeam,
    removeMember, changeMemberRole, regenerateInviteCode, updateMemberHR,
    grantTeamOwner, revokeTeamOwner, transferTeamOwnership,
    fetchMemberEntries, exportTeamCSV, exportTeamXLSX,
    activeTeamSessions, loadActiveTeamSessions,
    rooms, visibleRooms, lockedRooms, restrictedRoomIds, loadRoomsForActiveTeam,
    teamSounds, loadTeamSoundsForActive, addTeamSound, renameTeamSound, removeTeamSound,
    teamSoundsAdminOnly, canUploadTeamSound, canManageTeamSound,
    orgTeams, myOrgTeamIds, myOrgTeamLeadIds, teamsByUserId, orgTeamMemberCounts, loadOrgTeamsForActive,
  }), [
    teams, activeTeam, activeTeamId, teamMembers, teamLoading, isAdmin, isOwner,
    defaultTeamId, setDefaultTeam,
    loadTeams, loadMembers, switchTeam,
    createTeam, joinTeam, leaveTeam, deleteTeam, updateTeam,
    removeMember, changeMemberRole, regenerateInviteCode, updateMemberHR,
    grantTeamOwner, revokeTeamOwner, transferTeamOwnership,
    fetchMemberEntries, exportTeamCSV, exportTeamXLSX,
    activeTeamSessions, loadActiveTeamSessions,
    rooms, visibleRooms, lockedRooms, restrictedRoomIds, loadRoomsForActiveTeam,
    teamSounds, loadTeamSoundsForActive, addTeamSound, renameTeamSound, removeTeamSound,
    teamSoundsAdminOnly, canUploadTeamSound, canManageTeamSound,
    orgTeams, myOrgTeamIds, myOrgTeamLeadIds, teamsByUserId, orgTeamMemberCounts, loadOrgTeamsForActive,
  ]);

  return (
    <TeamContext.Provider value={value}>
      {children}
    </TeamContext.Provider>
  );
}

export function useTeam() {
  const ctx = useContext(TeamContext);
  if (!ctx) throw new Error("useTeam must be used within TeamProvider");
  return ctx;
}

// Non-throwing variant for components that legitimately render OUTSIDE a
// TeamProvider — e.g. the read-only device kiosk, which mounts member panels
// (RoomChatPanel) without the full member context stack. Returns null there;
// callers guard with `|| {}`.
export function useTeamOptional() {
  return useContext(TeamContext);
}
