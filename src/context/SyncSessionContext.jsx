import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { supabase } from "../supabase";
import { useApp } from "./AppContext";
import {
  leaveSyncSession,
  endSyncSession,
  fetchSyncParticipants,
  transferSyncLeader,
  kickSyncParticipant,
  takeSyncControl,
  findMyActiveSyncSession,
  heartbeatSyncSession,
  PRESENCE_GRACE_MS,
} from "../lib/syncSession";
import { notifySessionJoined, notifySessionCleared } from "../sync/joinSession";

const SYNC_SESSION_KEY = "ql_sync_session";

/** Fields owned by SyncSessionCoordinator — pomodoro timer fields come from PomodoroEngine. */
const METADATA_FIELDS = [
  "leader_id",
  "controller_id",
  "status",
  "visibility",
  "join_code",
  "team_id",
  "room_id",
  "retro_id",
  "whiteboard_id",
  "expires_at",
  // Meeting timer — server time + duration; clients compute remaining locally.
  "meeting_timer_started_at",
  "meeting_timer_duration_seconds",
  "meeting_timer_elapsed_at_pause_seconds",
  "meeting_timer_paused",
  "meeting_timer_track",
];

function mergeSessionMetadata(prev, row) {
  if (!prev) return row;
  const merged = { ...prev };
  for (const key of METADATA_FIELDS) {
    if (row[key] !== undefined) merged[key] = row[key];
  }
  return merged;
}

// Exported so a stripped-down surface (e.g. the external-guest room page, which
// renders the call + whiteboard outside AuthenticatedApp) can supply a stub
// value — LiveKitCall's ConferenceLayout calls useSyncSession() unconditionally.
export const SyncSessionContext = createContext(null);

export function SyncSessionProvider({ session, children }) {
  const { settings } = useApp();
  const [syncSession, setSyncSession] = useState(null);
  const [syncParticipants, setSyncParticipants] = useState([]);
  const [presenceMap, setPresenceMap] = useState({});
  // Latest display name without retriggering the presence-channel effect
  // below — a rename mid-session must not tear down and re-subscribe the
  // channel + heartbeat (which flaps presence for the whole room).
  const displayNameRef = useRef(settings?.name);
  displayNameRef.current = settings?.name;
  // Current active session id, ref-mirrored so the visibility handler can
  // re-stamp liveness without re-subscribing when the session changes.
  const syncSessionIdRef = useRef(null);
  syncSessionIdRef.current = syncSession?.id || null;

  const clearLocalSession = useCallback(() => {
    setSyncSession(null);
    setSyncParticipants([]);
    setPresenceMap({});
    notifySessionCleared();
  }, []);

  // Guards a single retry when rehydrate finds a stored session id but
  // the lookup returns nothing — protects against the cold-load auth
  // race that would otherwise notifySessionCleared() and yank the user
  // out of an active session on refresh.
  const rehydrateRetriedRef = useRef(false);
  // De-dupes concurrent rehydrate calls. Without this, mount + visibility
  // + broadcast events fired in quick succession would each kick off a
  // find_my_active_sync_session RPC, and a cross-tab broadcast loop with
  // the Electron menubar popover could escalate into hundreds of POSTs.
  const rehydrateInFlightRef = useRef(false);

  // Tries, in order:
  //   1) The session id stashed in localStorage (fast path for reloads).
  //   2) The server-side find_my_active_sync_session RPC — picks up
  //      sessions started on another device or in another tab so the
  //      user lands already-synced on a fresh device.
  //
  // On a successful server-side discovery we backfill localStorage so
  // subsequent reloads take the fast path.
  const rehydrateSyncSessionFromStorage = useCallback(async () => {
    if (rehydrateInFlightRef.current) return;
    rehydrateInFlightRef.current = true;
    let retryScheduled = false;
    try {
      const adoptSession = async (row) => {
        rehydrateRetriedRef.current = false;
        setSyncSession(row);
        try {
          localStorage.setItem(SYNC_SESSION_KEY, JSON.stringify({ sessionId: row.id }));
        } catch { /* storage disabled */ }
        const { data: p } = await fetchSyncParticipants(row.id);
        setSyncParticipants(p || []);
      };

      const tryServerDiscover = async () => {
        const { data } = await findMyActiveSyncSession();
        if (data?.id) {
          await adoptSession(data);
          return true;
        }
        return false;
      };

      // Local-only clear. We intentionally do NOT call
      // notifySessionCleared() here: this path runs when rehydrate
      // *discovered* there's no active session, not when the user
      // *ended* one. Broadcasting "sync-changed" caused a cross-tab
      // loop with the Electron menubar popover where every tab's
      // "I didn't find anything" finding caused every other tab to
      // re-rediscover, escalating into hundreds of find_my_active
      // RPCs per minute. Real session-end paths still broadcast via
      // clearLocalSession.
      const clearLocallyOnly = () => {
        rehydrateRetriedRef.current = false;
        try { localStorage.removeItem(SYNC_SESSION_KEY); } catch { /* */ }
        setSyncSession(null);
        setSyncParticipants([]);
        setPresenceMap({});
      };

      const stored = localStorage.getItem(SYNC_SESSION_KEY);
      let sessionId = null;
      if (stored) {
        try {
          ({ sessionId } = JSON.parse(stored));
        } catch {
          // Malformed JSON: fall through to server discovery rather than
          // wiping outright — they may still have an active session.
          sessionId = null;
        }
      }

      if (sessionId) {
        const { data, error } = await supabase
          .from("sync_sessions")
          .select("*")
          .eq("id", sessionId)
          .eq("status", "active")
          .maybeSingle();
        if (data) {
          await adoptSession(data);
          return;
        }
        // Stored hint missed. Could be: session ended, OR cold-load RLS
        // race (token not warm yet). Retry once after a beat before
        // committing to the "no session" path. The in-flight latch stays
        // held across the wait — a visibility flap or broadcast landing
        // inside the 600ms window must not start a parallel run (each
        // would fire its own find_my_active_sync_session).
        if (!error && !rehydrateRetriedRef.current) {
          rehydrateRetriedRef.current = true;
          retryScheduled = true;
          setTimeout(() => {
            rehydrateInFlightRef.current = false;
            rehydrateSyncSessionFromStorage();
          }, 600);
          return;
        }
      }

      // No local hint, or the local hint was definitively stale. Ask the
      // server whether this user is in any active session anywhere.
      const found = await tryServerDiscover();
      if (found) return;
      clearLocallyOnly();
    } finally {
      if (!retryScheduled) rehydrateInFlightRef.current = false;
    }
  }, []);

  // Run on mount AND any time the signed-in user id changes (cold sign-in,
  // account switch) so a freshly authenticated device immediately picks
  // up any sync session the user is already a participant in.
  useEffect(() => {
    rehydrateSyncSessionFromStorage();
  }, [rehydrateSyncSessionFromStorage, session?.user?.id]);

  // Re-check the server when the tab returns to the foreground. Mobile
  // PWAs and backgrounded laptops can miss realtime events; a focus
  // refresh covers the "I joined on my phone, switched back to my
  // laptop, expected to be already in" case.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      // Re-stamp liveness BEFORE any rehydrate/reload. A backgrounded tab's
      // heartbeat timers get throttled/paused; on foreground we must tell the
      // server "still here" immediately, or a foregrounded-but-healthy call
      // could be swept (its last_seen_at gone stale) in the window before the
      // next heartbeat tick — and a swept row would then eject the whole room.
      const id = syncSessionIdRef.current;
      if (id) heartbeatSyncSession(id);
      rehydrateSyncSessionFromStorage();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [rehydrateSyncSessionFromStorage]);

  useEffect(() => {
    let channel;
    try {
      channel = new BroadcastChannel("pomodoro");
      channel.onmessage = (ev) => {
        if (ev.data?.type === "sync-changed") rehydrateSyncSessionFromStorage();
      };
    } catch {
      /* unsupported */
    }
    return () => channel?.close();
  }, [rehydrateSyncSessionFromStorage]);

  const joinSession = useCallback(
    async (sess, { openPomodoro } = {}) => {
      setSyncSession(sess);
      notifySessionJoined(sess);
      const { data: p } = await fetchSyncParticipants(sess.id);
      setSyncParticipants(p || []);
      if (openPomodoro) openPomodoro();
    },
    []
  );

  useEffect(() => {
    function onJoined(ev) {
      const sess = ev.detail?.session;
      if (sess?.id) {
        setSyncSession(sess);
        fetchSyncParticipants(sess.id).then(({ data: p }) => setSyncParticipants(p || []));
      }
    }
    window.addEventListener("ql-sync-session-joined", onJoined);
    return () => window.removeEventListener("ql-sync-session-joined", onJoined);
  }, []);

  useEffect(() => {
    if (!syncSession?.id || !session?.user?.id) return;
    const sessionId = syncSession.id;
    const userId = session.user.id;

    const refetch = async () => {
      const { data: myRow } = await supabase
        .from("sync_session_participants")
        .select("left_at")
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .maybeSingle();
      if (myRow?.left_at) {
        clearLocalSession();
        return;
      }

      const { data: p } = await fetchSyncParticipants(sessionId);
      const list = p || [];
      setSyncParticipants(list);

      const meMissing = !list.some((row) => row.user_id === userId);
      if (meMissing && syncSession.join_code && myRow == null) {
        await supabase.rpc("join_sync_session", {
          p_join_code: syncSession.join_code,
          p_display_name: displayNameRef.current || "",
        });
        const { data: p2 } = await fetchSyncParticipants(sessionId);
        setSyncParticipants(p2 || []);
      }
    };

    const channel = supabase.channel(`sync-presence:${sessionId}`);

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      const map = {};
      for (const key of Object.keys(state)) {
        for (const p of state[key]) {
          map[p.user_id] = true;
        }
      }
      setPresenceMap(map);
      refetch();
    });
    channel.on("presence", { event: "join" }, refetch);
    channel.on("presence", { event: "leave" }, refetch);

    channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "sync_session_participants",
        filter: `session_id=eq.${sessionId}`,
      },
      refetch
    );

    channel.on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "sync_sessions",
        filter: `id=eq.${sessionId}`,
      },
      (payload) => {
        const row = payload.new;
        if (!row) return;
        if (row.status === "ended") {
          clearLocalSession();
          return;
        }
        setSyncSession((prev) => mergeSessionMetadata(prev, row));
      }
    );

    // Session row was hard-deleted (last-leaver cleanup, leader end, or
    // meeting-room auto-expiry). Drop local state so the UI bails out
    // cleanly instead of waiting on the 15s refetch poll.
    channel.on(
      "postgres_changes",
      {
        event: "DELETE",
        schema: "public",
        table: "sync_sessions",
        filter: `id=eq.${sessionId}`,
      },
      () => clearLocalSession()
    );

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ user_id: userId });
        // Stamp liveness immediately on connect so the server knows this
        // tab is present without waiting for the first heartbeat tick.
        heartbeatSyncSession(sessionId);
      }
    });

    const pollId = setInterval(refetch, 15000);

    // Heartbeat. last_seen_at is the server's signal for "who is
    // actually present right now" — read-time liveness filtering, the
    // empty-room sweeper, leader reassignment, and video teardown all
    // key off it. A steady 20s cadence sits comfortably inside the
    // staleness grace window even if a few beats are dropped (e.g. a
    // briefly-backgrounded tab whose timers get throttled).
    const heartbeatId = setInterval(() => heartbeatSyncSession(sessionId), 20000);

    return () => {
      clearInterval(pollId);
      clearInterval(heartbeatId);
      supabase.removeChannel(channel);
    };
  }, [syncSession?.id, syncSession?.join_code, session?.user?.id, clearLocalSession]);

  const leaveSession = useCallback(async () => {
    if (syncSession) {
      await leaveSyncSession(syncSession.id);
    }
    clearLocalSession();
  }, [syncSession, clearLocalSession]);

  const endSession = useCallback(async () => {
    if (syncSession) {
      await endSyncSession(syncSession.id);
    }
    clearLocalSession();
  }, [syncSession, clearLocalSession]);

  const transferLeader = useCallback(
    async (newLeaderId) => {
      if (!syncSession) return;
      const { data, error } = await transferSyncLeader(syncSession.id, newLeaderId);
      if (error) {
        console.warn("transfer leader:", error.message);
        return;
      }
      if (data?.session) {
        setSyncSession((prev) =>
          prev ? { ...prev, ...mergeSessionMetadata(prev, data.session) } : data.session
        );
      }
      fetchSyncParticipants(syncSession.id).then(({ data: p }) => setSyncParticipants(p || []));
    },
    [syncSession]
  );

  const takeControl = useCallback(async (sessionId) => {
    const { data, error } = await takeSyncControl(sessionId);
    if (error) {
      console.warn("take control:", error.message);
      return { error };
    }
    if (data?.session) {
      setSyncSession((prev) =>
        prev ? { ...prev, ...mergeSessionMetadata(prev, data.session) } : data.session
      );
    }
    return { error: null };
  }, []);

  const kickParticipant = useCallback(
    async (userIdToKick) => {
      if (!syncSession) return;
      const { error } = await kickSyncParticipant(syncSession.id, userIdToKick);
      if (error) {
        console.warn("kick participant:", error.message);
        return;
      }
      fetchSyncParticipants(syncSession.id).then(({ data: p }) => setSyncParticipants(p || []));
    },
    [syncSession]
  );

  // Is the current leader actually present (fresh heartbeat)? Mirrors the
  // server's claim_session_lead gate so the UI can offer leader-only
  // controls (start the meeting timer, attach a retro) to a present
  // member when the leader has gone away — instead of leaving the room
  // stuck behind an absent host. Recomputes as participant rows refresh
  // (heartbeat ~20s, poll 15s), so it tracks the 120s grace closely.
  const leaderPresent = useMemo(() => {
    const leaderId = syncSession?.leader_id;
    if (!leaderId) return false;
    const row = syncParticipants.find((p) => p.user_id === leaderId);
    if (!row || row.left_at) return false;
    const seen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    return Date.now() - seen < PRESENCE_GRACE_MS;
  }, [syncSession?.leader_id, syncParticipants]);

  const value = useMemo(
    () => ({
      syncSession,
      syncParticipants,
      presenceMap,
      leaderPresent,
      joinSession,
      leaveSession,
      endSession,
      transferLeader,
      kickParticipant,
      takeControl,
    }),
    [
      syncSession,
      syncParticipants,
      presenceMap,
      leaderPresent,
      joinSession,
      leaveSession,
      endSession,
      transferLeader,
      kickParticipant,
      takeControl,
    ]
  );

  return (
    <SyncSessionContext.Provider value={value}>{children}</SyncSessionContext.Provider>
  );
}

export function useSyncSession() {
  const ctx = useContext(SyncSessionContext);
  if (!ctx) {
    throw new Error("useSyncSession must be used within SyncSessionProvider");
  }
  return ctx;
}
