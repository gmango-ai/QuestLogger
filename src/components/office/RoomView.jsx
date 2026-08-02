import { useState, useEffect, useMemo } from "react";
import { useTheme } from "../../context/ThemeContext";
import { useApp } from "../../context/AppContext";
import { useSyncSession } from "../../context/SyncSessionContext";
import { Button } from "@/components/ui/button";
import {
  Hash, Briefcase, MessageSquare, Lock, Globe,
  LogIn, LogOut, Play, ChevronDown, Settings,
  Copy, Check, CalendarPlus,
} from "lucide-react";
import { getRoomAccessCode } from "../../lib/rooms";
import ScheduleMeetingModal from "./ScheduleMeetingModal";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import KnockRequests from "./KnockRequests";
import RoomLayout from "./roomLayout/RoomLayout";
import LayoutBar from "./roomLayout/LayoutBar";
import { useRoomLayout } from "./roomLayout/useRoomLayout";
import { PANEL_IDS, ROOM_PANELS, QUICK_PANEL_IDS } from "./roomLayout/panels";
import { panelsIn } from "./roomLayout/layoutTree";
import { useRoomPanelActivity } from "./roomLayout/useRoomPanelActivity";
import { useRoomWeb } from "./roomLayout/useRoomWeb";
import WebPanel, { parseEmbed } from "./roomLayout/WebPanel";

const KIND_ICON = {
  general: Hash,
  department: Briefcase,
  meeting: MessageSquare,
  private: Lock,
};
const KIND_LABEL = {
  general: "General",
  department: "Department",
  meeting: "Meeting",
  private: "Private",
};

function RoomSessionAction({ room, activeSession, busy, onJoin, onStart, currentSyncSession }) {
  const inThisRoomSession = !!currentSyncSession && currentSyncSession.room_id === room.id;
  // The pomodoro clock moved to the nav bar (glanceable on every page), so the
  // room header no longer duplicates it — when you're already in this room's
  // session there's no session action to show here.
  if (inThisRoomSession) return null;
  if (activeSession) {
    const n = activeSession.occupants?.length || 0;
    return (
      <Button onClick={onJoin} disabled={busy} size="sm" className="rounded-full">
        <LogIn className="w-3.5 h-3.5 mr-1.5" />
        Join {n > 0 ? `(${n})` : ""}
      </Button>
    );
  }
  return (
    <Button onClick={onStart} disabled={busy} size="sm" variant="outline" className="rounded-full">
      <Play className="w-3.5 h-3.5 mr-1.5" />
      Start a session
    </Button>
  );
}

export default function RoomView({
  room, activeSession, orgTeams, busy, onJoin, onStart,
  onOpenRoomSwitcher, onLeaveRoom,
  onEditRoom, canEditRoom,
}) {
  const { theme } = useTheme();
  const { session } = useApp();
  const { syncSession: currentSyncSession } = useSyncSession();
  const dark = theme === "dark";

  // Modular panel layout (per-user, per-room). Replaces the old fixed
  // view modes — see ./roomLayout. Panels = video, chat, whiteboard.
  const { tree, reset, setRatio, movePanel, addPanel, addPanelAt, moveToRoot, addAtRoot, closePanel, togglePanel } = useRoomLayout(room?.id, PANEL_IDS);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  // Access code for a code-gated room — fetched only for managers (RLS on
  // room_secrets returns nothing to anyone else), so it can be grabbed and
  // shared straight from the header.
  const [accessCode, setAccessCode] = useState("");
  const [codeCopied, copyCode] = useCopyToClipboard();
  const isCodeRoom = room?.entry_policy === "code";
  useEffect(() => {
    if (!isCodeRoom || !canEditRoom || !room?.id) { setAccessCode(""); return; }
    let cancelled = false;
    getRoomAccessCode(room.id).then(({ data }) => { if (!cancelled) setAccessCode(data || ""); });
    return () => { cancelled = true; };
  }, [room?.id, isCodeRoom, canEditRoom]);
  async function copyAccessCode() {
    if (!accessCode) return;
    await copyCode(accessCode);
  }

  if (!room) return null;

  // Quick-toggle data for the header: which panels exist + their icon/title.
  const activePanels = panelsIn(tree);
  // Curated one-click toggles (video/chat/whiteboard); the rest live in "Add".
  const quickPanels = QUICK_PANEL_IDS.map((id) => ({
    id, title: ROOM_PANELS[id].title, Icon: ROOM_PANELS[id].icon,
  }));
  // Full set for the "Add" menu — every fixed panel incl. the widget views.
  const addPanels = PANEL_IDS.map((id) => ({
    id, title: ROOM_PANELS[id].title, Icon: ROOM_PANELS[id].icon,
  }));

  // Whiteboard link flows through the sync session (session.whiteboard_id),
  // mirroring the old retro link. Anyone in the room may attach/swap it — it's a
  // shared surface; the server gates on session participation, not leadership —
  // UNLESS a manager has locked the whiteboard for this room, in which case only
  // room managers can change it (the RPC enforces this too).
  const displayName = session?.user?.user_metadata?.name || session?.user?.email || "Guest";
  const inThisRoomSession = !!currentSyncSession && currentSyncSession.room_id === room.id;
  const linkedWhiteboardId = inThisRoomSession ? (currentSyncSession.whiteboard_id || null) : null;
  const whiteboardLocked = room.whiteboard_locked === true;
  const canLinkWhiteboard = inThisRoomSession && (!whiteboardLocked || canEditRoom);

  // Activity on CLOSED panels → header-toggle badges (people in the call /
  // editing the board, unread chat) so you can tell what's live without opening
  // each panel.
  const activity = useRoomPanelActivity({
    roomId: room.id,
    userId: session?.user?.id,
    whiteboardId: linkedWhiteboardId,
    videoOpen: activePanels.includes("video"),
    chatOpen: activePanels.includes("chat"),
    whiteboardOpen: activePanels.includes("whiteboard"),
  });
  const panelBadges = {
    video: activity.video > 0 ? { count: activity.video, live: true } : null,
    chat: activity.chat > 0 ? { count: activity.chat } : null,
    whiteboard: activity.whiteboard > 0 ? { count: activity.whiteboard, live: true } : null,
  };
  const panelCtx = {
    room,
    userId: session?.user?.id,
    displayName,
    dark,
    whiteboardId: linkedWhiteboardId,
    canLink: canLinkWhiteboard,
    sess: currentSyncSession, // for the Pomodoro view (DeviceTimerPanel)
  };

  // ── Shared website views ─────────────────────────────────────
  // Room-shared set of web tiles (everyone sees the same sites) + their URLs.
  // Each web instance becomes a real layout tile (panel id "web:<id>"); the
  // layout tree is reconciled below so a site added by anyone appears for all.
  const { webs, playback: webPlayback, addWeb, removeWeb, setWebUrl, sendPlayback } = useRoomWeb(room.id, session?.user?.id);

  // Dynamic panel registry = the fixed panels + one entry per shared web view.
  const panels = useMemo(() => {
    const map = { ...ROOM_PANELS };
    for (const w of webs) {
      const label = parseEmbed(w.url)?.kind === "youtube" ? "YouTube" : (() => {
        try { return new URL(w.url.includes("://") ? w.url : `https://${w.url}`).hostname.replace(/^www\./, ""); }
        catch { return "Web"; }
      })();
      map[`web:${w.id}`] = {
        id: `web:${w.id}`,
        title: label,
        icon: Globe,
        min: 320,
        render: () => (
          <WebPanel
            url={w.url}
            onSetUrl={(u) => setWebUrl(w.id, u)}
            dark={dark}
            playback={webPlayback[w.id]}
            onPlayback={(p) => sendPlayback(w.id, p)}
            meId={session?.user?.id}
          />
        ),
      };
    }
    return map;
  }, [webs, webPlayback, setWebUrl, sendPlayback, dark, session?.user?.id]);

  // Reconcile the layout tree with the shared web set: add a tile for each web
  // that isn't shown yet, and drop tiles whose web was removed. Idempotent, so
  // it converges and stops (no loop). A web closed from its tile header calls
  // removeWeb (below), which broadcasts and clears it for everyone.
  const desiredWebPanels = useMemo(() => webs.map((w) => `web:${w.id}`), [webs]);
  useEffect(() => {
    const present = panelsIn(tree).filter((p) => p.startsWith("web:"));
    desiredWebPanels.forEach((id) => { if (!present.includes(id)) addPanel(id); });
    present.forEach((id) => { if (!desiredWebPanels.includes(id)) closePanel(id); });
  }, [desiredWebPanels, tree, addPanel, closePanel]);

  // Closing a web tile (its header X / drag-to-toolbox) should remove the SHARED
  // web, not just hide it locally — so wrap closePanel to route web ids to
  // removeWeb (which broadcasts), and pass everything else through.
  const handleClosePanel = (panelId) => {
    if (typeof panelId === "string" && panelId.startsWith("web:")) removeWeb(panelId.slice(4));
    else closePanel(panelId);
  };

  const Icon = KIND_ICON[room.kind] || Hash;
  const accent = room.color || "#14b8a6";
  const gatingTeams = (room.room_teams || [])
    .map((rt) => (orgTeams || []).find((t) => t.id === rt.org_team_id))
    .filter(Boolean);

  return (
    <div className="flex flex-col h-full min-h-0">
      <header
        className={`@container px-4 sm:px-6 py-3 border-b shrink-0 ${
          dark ? "border-[var(--color-border)]" : "border-slate-200"
        }`}
        style={{ background: `linear-gradient(180deg, ${accent}12, transparent)` }}
      >
        {/* Stack the controls below the identity until the header container is
            wide enough for both clusters to share one row without clipping. */}
        <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center @xl:gap-3">
          {/* Identity — room name, switcher. Grows to fill and truncates. */}
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            {/* Leave room — the first control you reach, sitting immediately
                before the room name. (The old widgets toggle here was retired:
                the app-wide widget drawer is reached from the nav's widgets
                button, so a room-local toggle was redundant.) */}
            {onLeaveRoom && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onLeaveRoom}
                title="Leave room"
                aria-label="Leave room"
                className={`h-10 w-10 sm:h-8 sm:w-8 shrink-0 ${
                  dark
                    ? "text-slate-400 hover:text-rose-300 hover:bg-rose-500/10"
                    : "text-slate-500 hover:text-rose-600 hover:bg-rose-50"
                }`}
              >
                <LogOut className="w-5 h-5 sm:w-4 sm:h-4" />
              </Button>
            )}

            {/* Room identity — clickable. Opens the office overlay so
                the user can switch rooms or leave to the hallway. The button
                hugs the room name (not the full bar width) so it reads as a
                tappable name, not a giant empty target; the name still
                truncates past a max width so a long name can't blow out the
                header. */}
            <button
              type="button"
              onClick={onOpenRoomSwitcher}
              className={`flex items-center gap-3 min-w-0 text-left rounded-lg -m-1 p-1 transition-colors ${
                dark ? "hover:bg-[var(--color-surface-raised)]/60" : "hover:bg-slate-100/60"
              }`}
              title="Switch room"
            >
              <div
                className="p-2 rounded-xl shrink-0"
                style={{ background: `${accent}22`, color: accent }}
              >
                <Icon className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <h1 className={`text-lg font-bold truncate max-w-[10rem] sm:max-w-[16rem] inline-flex items-center gap-1.5 ${
                  dark ? "text-slate-100" : "text-slate-800"
                }`}>
                  {room.name}
                  <ChevronDown className={`w-3.5 h-3.5 shrink-0 opacity-60 ${dark ? "text-slate-400" : "text-slate-500"}`} />
                </h1>
                <p className={`text-[10px] uppercase tracking-wider ${dark ? "text-slate-500" : "text-slate-400"}`}>
                  {KIND_LABEL[room.kind] || room.kind}
                  {room.entry_policy === "code" && (
                    <span className={`ml-2 ${dark ? "text-amber-300" : "text-amber-600"}`}>
                      · Locked
                    </span>
                  )}
                </p>
              </div>
            </button>

            {/* Access code chip — managers can grab + share the room's
                code without opening settings. Click copies to clipboard.
                Only rendered when a code exists (RLS hides it from
                non-managers, so this never leaks). */}
            {isCodeRoom && canEditRoom && accessCode && (
              <button
                type="button"
                onClick={copyAccessCode}
                title="Copy access code — share it to let people in"
                aria-label={`Room access code ${accessCode}. Click to copy.`}
                className={`inline-flex items-center gap-1.5 shrink-0 h-8 px-2.5 rounded-lg border text-xs font-mono tracking-widest transition-colors ${
                  dark
                    ? "bg-[var(--color-surface-raised)] border-[var(--color-border)] text-amber-200 hover:border-amber-400/50"
                    : "bg-amber-50 border-amber-200 text-amber-700 hover:border-amber-300"
                }`}
              >
                <Lock className="w-3 h-3 opacity-70" />
                <span>{accessCode}</span>
                {codeCopied
                  ? <Check className="w-3.5 h-3.5" />
                  : <Copy className="w-3.5 h-3.5 opacity-70" />}
              </button>
            )}

            {gatingTeams.length > 0 && (
              <div className="hidden xl:flex flex-wrap items-center gap-1.5">
                {gatingTeams.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                    style={{ background: `${t.color}22`, color: dark ? "#fff" : t.color, border: `1px solid ${t.color}55` }}
                  >
                    <span className="w-1 h-1 rounded-full" style={{ background: t.color }} />
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Controls row — session status + add-view + settings/leave.
              Hugs the right on both mobile (second row) and desktop. Drops to
              a second row when the bar is too narrow for one row. */}
          <div className="flex items-center gap-2 @xl:gap-3 justify-end shrink-0">
            <RoomSessionAction
              room={room}
              activeSession={activeSession}
              busy={busy}
              onJoin={onJoin}
              onStart={onStart}
              currentSyncSession={currentSyncSession}
            />

            {/* Add-view lives here (just before settings); the quick panel
                toggles + arrange collapse away on mobile, leaving only Add. */}
            <LayoutBar
              addMenu
              onReset={reset}
              accent={accent}
              dark={dark}
              panels={quickPanels}
              addPanels={addPanels}
              activePanels={activePanels}
              badges={panelBadges}
              onTogglePanel={togglePanel}
              onAddWeb={() => addWeb("")}
            />

            {/* Schedule a meeting into this room (any room can host one). */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setScheduleOpen(true)}
              title="Schedule a meeting"
              aria-label="Schedule a meeting"
              className={`h-10 w-10 sm:h-8 sm:w-8 shrink-0 ${
                dark ? "text-slate-400 hover:text-slate-100" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              <CalendarPlus className="w-5 h-5 sm:w-4 sm:h-4" />
            </Button>

            {/* Settings + Leave — pinned to the far right. Larger touch
                targets on mobile. */}
            {canEditRoom && onEditRoom && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onEditRoom(room)}
                title="Room settings"
                aria-label="Room settings"
                className={`h-10 w-10 sm:h-8 sm:w-8 shrink-0 ${
                  dark ? "text-slate-400 hover:text-slate-100" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <Settings className="w-5 h-5 sm:w-4 sm:h-4" />
              </Button>
            )}
          </div>
        </div>
      </header>

      {scheduleOpen && (
        <ScheduleMeetingModal
          room={room}
          teamId={room.team_id}
          dark={dark}
          onClose={() => setScheduleOpen(false)}
          onCreated={() => setScheduleOpen(false)}
        />
      )}

      {/* Knock requests — people held at the lock gate asking to be let in.
          Only occupants see these (RLS-scoped); any of them can admit. */}
      <KnockRequests roomId={room.id} enabled={inThisRoomSession} dark={dark} />

      {/* Body — a modular tiling layout. Pick a preset from the header,
          drag the dividers to resize. Tiles are absolutely positioned
          from the layout tree so panels (incl. the live video call) are
          repositioned, never remounted. */}
      <div className="flex-1 min-h-0 p-4 overflow-hidden">
        <RoomLayout
          tree={tree}
          ctx={panelCtx}
          panels={panels}
          onRatioChange={setRatio}
          arranging={false}
          onMove={movePanel}
          onAddAt={addPanelAt}
          onMoveToRoot={moveToRoot}
          onAddAtRoot={addAtRoot}
          onClose={handleClosePanel}
        />
      </div>
    </div>
  );
}
