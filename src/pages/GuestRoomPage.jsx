import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../supabase";
import { useTheme } from "../context/ThemeContext";
import { AppContext } from "../context/AppContext";
import { TeamContext } from "../context/TeamContext";
import { SyncSessionContext } from "../context/SyncSessionContext";
import { VideoCallProvider } from "../context/VideoCallContext";
import VideoCall from "../components/video/VideoCall";
import { WhiteboardBoard } from "./WhiteboardPage";
import JoinShell, { JoinNotice } from "../components/JoinShell";
import { signInAsGuest } from "../lib/auth";
import { fetchRoomActiveSession, resolveRoomByGuestToken } from "../lib/rooms";
import {
  joinSyncSession,
  leaveSyncSession,
  heartbeatSyncSession,
} from "../lib/syncSession";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogIn, Video, PenLine, DoorOpen, User } from "lucide-react";

// Guest room page at /office/guest/:token — renders OUTSIDE the app's auth gate
// (see App.jsx). An invited outsider signs in anonymously, redeems the token for
// a room_guests grant, JOINS the room's active session (join-only — a guest never
// starts one, which would spam the team a "focus session started" notification),
// then gets a stripped shell: the room's LiveKit call + its attached whiteboard,
// and nothing else (no nav, chat, other rooms, member lists, or time tracking).
//
// The call/whiteboard components call useApp()/useTeam()/useSyncSession()/
// useVideoCall() unconditionally, so we supply stub contexts (a REAL anon session
// for AppContext — the whiteboard needs auth.uid() + a display name to edit) and
// wrap the real VideoCallProvider (it's self-contained and provides every value
// the call control bar reads). ThemeProvider is already global.

const GUEST_TEAM = { isAdmin: false, isOwner: false, activeTeamId: null, rooms: [], teamMembers: [] };
const GUEST_SYNC = { syncSession: null };

const FATAL_MESSAGES = {
  invalid: "This invite link is invalid.",
  expired: "This invite link has expired.",
  revoked: "This invite link has been turned off.",
  guests_disabled: "Guest access is turned off for this room.",
  not_authenticated: "Could not start a guest session. Please try again.",
};

const HEARTBEAT_MS = 20_000; // keep last_seen_at fresh (server grace is 120s)
const WAIT_POLL_MS = 4_000; // how often to check whether the host has started

export default function GuestRoomPage() {
  const { token } = useParams();
  const { theme } = useTheme();
  const dark = theme === "dark";

  const [session, setSession] = useState(undefined); // supabase auth session
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); // inline (retryable) error
  const [fatal, setFatal] = useState(""); // dead-link message (terminal)
  const [room, setRoom] = useState(null); // { room_id, room_name, team_id }
  const [sessionRow, setSessionRow] = useState(null); // active sync_session once joined
  const [phase, setPhase] = useState("form"); // form | waiting | in | left
  const [view, setView] = useState("call"); // call | board

  const whiteboardId = sessionRow?.whiteboard_id || null;

  // Watch auth so a returning guest (refresh) keeps its anon session, and so the
  // stub AppContext always has the live session object.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  // Pre-fill the name from a prior anon session's user_settings.
  useEffect(() => {
    if (!session?.user?.id || name) return;
    supabase.from("user_settings").select("name").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => { if (data?.name) setName(data.name); });
  }, [session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Join the room's active session if there is one; otherwise wait for the host.
  const attemptJoin = useCallback(async (roomObj, displayName) => {
    const rid = roomObj?.room_id;
    if (!rid) return false;
    const { data: active } = await fetchRoomActiveSession(rid);
    if (!active?.join_code) {
      setPhase("waiting");
      return false;
    }
    const { data, error: joinErr } = await joinSyncSession(active.join_code, displayName);
    if (joinErr) {
      // room_entry_denied here would mean the grant vanished (revoked/expired).
      setError(joinErr.message === "room_entry_denied"
        ? "Your invite is no longer valid."
        : (joinErr.message || "Could not join the room."));
      setPhase("waiting");
      return false;
    }
    setSessionRow(data?.session || active);
    setPhase("in");
    return true;
  }, []);

  // The main "Join" action from the name form.
  async function enter() {
    const clean = (name || "").trim();
    if (!clean) { setError("Please enter your name."); return; }
    setBusy(true); setError(""); setFatal("");

    // 1. Ensure an anonymous session (idempotent — reuse an existing one).
    let liveSession = session;
    if (!liveSession) {
      const { error: authErr, data } = await signInAsGuest(clean);
      if (authErr) { setError(authErr.message || "Could not start a guest session."); setBusy(false); return; }
      liveSession = data?.session || null;
      if (liveSession) setSession(liveSession);
    }

    // 2. Redeem the token → room_guests grant.
    const { data: resolved, error: resErr } = await resolveRoomByGuestToken(token, clean);
    if (resErr) {
      const code = resErr.code || "";
      if (FATAL_MESSAGES[code]) setFatal(FATAL_MESSAGES[code]);
      else setError(resErr.message || "Could not open this invite.");
      setBusy(false);
      return;
    }
    setRoom(resolved);

    // 3. Join now, or drop into the waiting room.
    await attemptJoin(resolved, clean);
    setBusy(false);
  }

  // While waiting, poll for the host starting the session.
  useEffect(() => {
    if (phase !== "waiting" || !room) return;
    const id = setInterval(() => { attemptJoin(room, name.trim()); }, WAIT_POLL_MS);
    return () => clearInterval(id);
  }, [phase, room, name, attemptJoin]);

  // While in the room: heartbeat (stay counted as live) + refresh the session so
  // a mid-meeting whiteboard link/unlink is picked up and a host-ended session
  // sends us back to the waiting room.
  useEffect(() => {
    if (phase !== "in" || !sessionRow?.id || !room) return;
    let cancelled = false;
    const tick = async () => {
      heartbeatSyncSession(sessionRow.id);
      const { data: active } = await fetchRoomActiveSession(room.room_id);
      if (cancelled) return;
      if (!active) { setPhase("waiting"); return; }
      // If the host restarted (new session id), re-join it. If the rejoin FAILS
      // (revoked grant, full room, transient error), drop back to the waiting
      // room instead of pointing the shell at a session we're not a participant
      // of (which would break whiteboard RLS + heartbeats while looking connected).
      if (active.id !== sessionRow.id && active.join_code) {
        const { error: rejoinErr } = await joinSyncSession(active.join_code, name.trim());
        if (cancelled) return;
        if (rejoinErr) { setPhase("waiting"); return; }
      }
      setSessionRow((prev) => (prev && prev.whiteboard_id === active.whiteboard_id && prev.id === active.id ? prev : active));
    };
    const id = setInterval(tick, HEARTBEAT_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [phase, sessionRow?.id, room, name]); // eslint-disable-line react-hooks/exhaustive-deps

  // If the linked board is removed (host unlinks it) while the guest is on the
  // Whiteboard tab, fall back to the call so the shell never shows a blank pane.
  useEffect(() => {
    if (view === "board" && !whiteboardId) setView("call");
  }, [view, whiteboardId]);

  const handleLeave = useCallback(async () => {
    if (sessionRow?.id) { try { await leaveSyncSession(sessionRow.id); } catch { /* best-effort */ } }
    setPhase("left");
  }, [sessionRow?.id]);

  // ── Render: terminal / lobby states use the shared centered JoinShell ──
  if (session === undefined) return <JoinShell loading />;

  if (fatal) {
    return (
      <JoinShell>
        <h1 className="text-xl font-bold mb-2">Invite unavailable</h1>
        <JoinNotice>{fatal}</JoinNotice>
        <p className={`text-sm mb-4 ${dark ? "text-slate-400" : "text-slate-500"}`}>
          Ask whoever invited you for a fresh link.
        </p>
        <Link to="/login" className="text-sm underline text-[var(--color-accent)]">Sign in instead</Link>
      </JoinShell>
    );
  }

  if (phase === "left") {
    return (
      <JoinShell>
        <h1 className="text-xl font-bold mb-2">You left the room</h1>
        <p className={`text-sm mb-4 ${dark ? "text-slate-400" : "text-slate-500"}`}>
          Thanks for joining{room?.room_name ? ` ${room.room_name}` : ""}.
        </p>
        <div className="space-y-2">
          <Button onClick={() => setPhase("waiting")} variant="outline" className="w-full">Rejoin</Button>
          <Link to="/login" className="block text-center text-sm underline text-[var(--color-accent)]">Sign in for full access</Link>
        </div>
      </JoinShell>
    );
  }

  if (phase === "waiting") {
    return (
      <JoinShell>
        <h1 className="text-xl font-bold mb-1">{room?.room_name || "Room"}</h1>
        <p className={`text-sm mb-4 ${dark ? "text-slate-400" : "text-slate-500"}`}>
          Waiting for the host to start the meeting… you'll join automatically.
        </p>
        {error && <JoinNotice>{error}</JoinNotice>}
        <div className="flex items-center gap-2 text-sm text-[var(--color-accent)]">
          <span className="inline-block w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse" />
          Connecting when the room opens
        </div>
        <button onClick={handleLeave} className={`mt-4 text-xs ${dark ? "text-slate-500 hover:text-slate-300" : "text-slate-400 hover:text-slate-600"}`}>
          Leave
        </button>
      </JoinShell>
    );
  }

  if (phase === "form") {
    return (
      <JoinShell>
        <h1 className="text-xl font-bold mb-1">Join the room</h1>
        <p className={`text-sm mb-4 ${dark ? "text-slate-400" : "text-slate-500"}`}>
          You've been invited as a guest. Enter a name to join the call and shared whiteboard.
        </p>
        <div className="mb-3">
          <label className={`text-[10px] font-semibold uppercase tracking-wider ${dark ? "text-slate-400" : "text-slate-500"}`}>
            Your display name
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 60))}
            placeholder="Required"
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !busy) enter(); }}
            className={`mt-1 ${dark ? "bg-[var(--color-surface-raised)] border-[var(--color-border)] text-slate-100" : ""}`}
          />
        </div>
        {error && <JoinNotice>{error}</JoinNotice>}
        <Button onClick={enter} disabled={busy || !name.trim()} className="w-full">
          <User className="w-4 h-4 mr-1.5" />
          {busy ? "Joining…" : "Join as guest"}
        </Button>
        <Link to="/login" className={`block text-center text-xs mt-3 ${dark ? "text-slate-500 hover:text-slate-300" : "text-slate-400 hover:text-slate-600"}`}>
          Have an account? Sign in
        </Link>
      </JoinShell>
    );
  }

  // ── phase === "in": the stripped guest shell ──
  const appVal = { session, settings: { name } };
  const segBtn = (active) =>
    `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition ${
      active
        ? "bg-[var(--color-accent)] text-white"
        : dark ? "text-slate-300 hover:bg-white/5" : "text-slate-600 hover:bg-slate-100"
    }`;

  return (
    <AppContext.Provider value={appVal}>
      <TeamContext.Provider value={GUEST_TEAM}>
        <SyncSessionContext.Provider value={GUEST_SYNC}>
          <VideoCallProvider>
            <div className={`fixed inset-0 flex flex-col ${dark ? "bg-[var(--color-bg)] text-slate-100" : "bg-slate-50 text-slate-800"}`}>
              <header className={`flex items-center gap-3 px-3 h-12 shrink-0 border-b ${dark ? "border-[var(--color-border)] bg-[var(--color-surface)]" : "border-slate-200 bg-white"}`}>
                <span className="font-semibold truncate">{room?.room_name || "Room"}</span>
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-accent)]/15 text-[var(--color-accent)]">Guest</span>
                <div className="flex items-center gap-1 ml-2">
                  <button className={segBtn(view === "call")} onClick={() => setView("call")}>
                    <Video className="w-4 h-4" /> Call
                  </button>
                  {whiteboardId && (
                    <button className={segBtn(view === "board")} onClick={() => setView("board")}>
                      <PenLine className="w-4 h-4" /> Whiteboard
                    </button>
                  )}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <Link to="/login" className={`hidden sm:inline text-xs ${dark ? "text-slate-400 hover:text-slate-200" : "text-slate-500 hover:text-slate-700"}`}>
                    <LogIn className="w-3.5 h-3.5 inline mr-1" />Sign in for full access
                  </Link>
                  <Button size="sm" variant="destructive" onClick={handleLeave}>
                    <DoorOpen className="w-4 h-4 mr-1" /> Leave
                  </Button>
                </div>
              </header>

              <div className="relative flex-1 min-h-0">
                {/* Both mounted; toggled with CSS so the call/whiteboard stay
                    connected when switching views. */}
                <div className={view === "call" ? "absolute inset-0" : "hidden"}>
                  <VideoCall
                    roomId={room.room_id}
                    displayName={name}
                    publish
                    listen
                    choices={{ videoEnabled: false, audioEnabled: false }}
                    onLeft={handleLeave}
                  />
                </div>
                {whiteboardId && (
                  <div
                    className={view === "board" ? "absolute inset-0" : "hidden"}
                    style={{ "--nav-h": "0px", "--top-inset": "0px", "--bottom-inset": "0px" }}
                  >
                    <WhiteboardBoard boardId={whiteboardId} embedded readOnly={false} />
                  </div>
                )}
              </div>
            </div>
          </VideoCallProvider>
        </SyncSessionContext.Provider>
      </TeamContext.Provider>
    </AppContext.Provider>
  );
}
