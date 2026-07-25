import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTeam } from "../context/TeamContext";
import { useApp } from "../context/AppContext";
import { useTheme } from "../context/ThemeContext";
import { Button } from "@/components/ui/button";
import {
  Plus, ScrollText, Lightbulb, PenLine, Archive, RotateCcw, Trash2, Settings, Globe,
} from "lucide-react";
import { SkeletonCard } from "../components/Skeleton";
import {
  listTeamWhiteboards,
  archiveWhiteboard,
  unarchiveWhiteboard,
  deleteWhiteboard,
  TEMPLATES,
} from "../lib/whiteboard";
import NewWhiteboardModal from "../components/NewWhiteboardModal";
import WhiteboardSettingsModal from "../components/whiteboard/WhiteboardSettingsModal";

const TEMPLATE_ICON = {
  weekly_review: ScrollText,
  brainstorm: Lightbulb,
  blank: PenLine,
};
const TEMPLATE_ACCENT = {
  weekly_review: { dark: "text-amber-400 bg-amber-500/15", light: "text-amber-600 bg-amber-50" },
  brainstorm:    { dark: "text-violet-400 bg-violet-500/15", light: "text-violet-600 bg-violet-50" },
  blank:         { dark: "text-slate-400 bg-slate-500/15", light: "text-slate-600 bg-slate-100" },
};

export default function WhiteboardsListPage() {
  const { activeTeamId, isAdmin } = useTeam();
  const { session } = useApp();
  const userId = session?.user?.id;
  const { theme } = useTheme();
  const dark = theme === "dark";
  const navigate = useNavigate();

  const [boards, setBoards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [scopeTab, setScopeTab] = useState("org"); // "org" | "personal"
  const [settingsBoard, setSettingsBoard] = useState(null);

  const reload = useCallback(async () => {
    if (!activeTeamId) { setBoards([]); setLoading(false); return; }
    const { data } = await listTeamWhiteboards(activeTeamId, { includeArchived: true, ownerId: userId, includeShared: true });
    setBoards(data || []);
    setLoading(false);
  }, [activeTeamId, userId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    reload().finally(() => { if (cancelled) return; });
    return () => { cancelled = true; };
  }, [reload]);

  // Active/Archived counts for the CURRENTLY SELECTED scope tab, so the badge
  // never contradicts the grid.
  const counts = useMemo(() => {
    let active = 0, archived = 0;
    for (const b of boards) {
      const inScope = scopeTab === "org" ? b.scope === "org" : b.scope === "personal";
      if (!inScope) continue;
      if (b.archived_at) archived++; else active++;
    }
    return { active, archived };
  }, [boards, scopeTab]);

  // On first load, if there are no Org boards but there ARE personal/shared
  // ones, open the Personal tab so the user doesn't land on an empty Org tab.
  const initialTabDone = useRef(false);
  useEffect(() => {
    if (loading || initialTabDone.current || !boards.length) return;
    initialTabDone.current = true;
    const hasOrgActive = boards.some((b) => b.scope === "org" && !b.archived_at);
    const hasPersonalActive = boards.some((b) => b.scope !== "org" && !b.archived_at);
    if (!hasOrgActive && hasPersonalActive) setScopeTab("personal");
  }, [loading, boards]);

  // Per-scope counts within the current Active/Archived filter (for the tab badges).
  const scopeCounts = useMemo(() => {
    let org = 0, personal = 0;
    for (const b of boards) {
      if (showArchived ? !b.archived_at : b.archived_at) continue;
      if (b.scope === "org") org++; else personal++;
    }
    return { org, personal };
  }, [boards, showArchived]);

  const visible = useMemo(
    () => boards.filter((b) => {
      const archivedMatch = showArchived ? !!b.archived_at : !b.archived_at;
      const scopeMatch = scopeTab === "org" ? b.scope === "org" : b.scope !== "org";
      return archivedMatch && scopeMatch;
    }),
    [boards, showArchived, scopeTab],
  );

  async function handleArchive(board) {
    const { error } = await archiveWhiteboard(board.id);
    if (error) return;
    setBoards((prev) => prev.map((b) => (b.id === board.id ? { ...b, archived_at: new Date().toISOString() } : b)));
  }
  async function handleUnarchive(board) {
    const { error } = await unarchiveWhiteboard(board.id);
    if (error) return;
    setBoards((prev) => prev.map((b) => (b.id === board.id ? { ...b, archived_at: null } : b)));
  }
  async function handleDelete(board) {
    if (!window.confirm(`Permanently delete "${board.title}"? This can't be undone.`)) return;
    const { error } = await deleteWhiteboard(board.id);
    if (error) return;
    setBoards((prev) => prev.filter((b) => b.id !== board.id));
  }

  function onCreated(board) {
    setBoards((prev) => [board, ...prev]);
    navigate(`/whiteboards/${board.id}`);
  }

  const tabCls = (active) =>
    `inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-full transition-colors ${
      active
        ? "bg-[var(--color-accent)] text-white"
        : dark
          ? "text-slate-400 hover:text-slate-200 hover:bg-[var(--color-surface-raised)]"
          : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
    }`;

  return (
    <main className="px-4 pt-6 pb-24 max-w-[1200px] mx-auto space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className={`text-2xl font-bold ${dark ? "text-slate-100" : "text-slate-800"}`}>
            Whiteboards
          </h1>
          <p className={`text-xs mt-0.5 ${dark ? "text-slate-400" : "text-slate-500"}`}>
            Collaborative canvases for your team. Pick a template, drop in stickies, draw, sketch.
          </p>
        </div>
        <Button onClick={() => setShowNewModal(true)} disabled={!activeTeamId} data-tour="whiteboards-new">
          <Plus className="w-4 h-4 mr-1.5" />
          New whiteboard
        </Button>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <button type="button" className={tabCls(scopeTab === "org")} onClick={() => setScopeTab("org")}>
          Org <span className="opacity-70">{scopeCounts.org}</span>
        </button>
        <button type="button" className={tabCls(scopeTab === "personal")} onClick={() => setScopeTab("personal")}>
          Personal <span className="opacity-70">{scopeCounts.personal}</span>
        </button>
        <span className={`mx-1 self-center w-px h-4 ${dark ? "bg-white/10" : "bg-slate-200"}`} />
        <button type="button" className={tabCls(!showArchived)} onClick={() => setShowArchived(false)}>
          Active <span className="opacity-70">{counts.active}</span>
        </button>
        <button type="button" className={tabCls(showArchived)} onClick={() => setShowArchived(true)}>
          Archived <span className="opacity-70">{counts.archived}</span>
        </button>
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0,1,2,3].map((i) => <SkeletonCard key={i} className="h-32" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          dark={dark}
          archived={showArchived}
          onCreate={() => setShowNewModal(true)}
          disabled={!activeTeamId}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((b) => (
            <BoardCard
              key={b.id}
              board={b}
              dark={dark}
              isAdmin={isAdmin}
              userId={userId}
              onSettings={() => setSettingsBoard(b)}
              onArchive={() => handleArchive(b)}
              onUnarchive={() => handleUnarchive(b)}
              onDelete={() => handleDelete(b)}
            />
          ))}
        </div>
      )}

      <NewWhiteboardModal
        open={showNewModal}
        onClose={() => setShowNewModal(false)}
        teamId={activeTeamId}
        initialScope={scopeTab}
        onCreated={onCreated}
      />

      {settingsBoard && (
        <WhiteboardSettingsModal
          board={settingsBoard}
          dark={dark}
          onClose={() => setSettingsBoard(null)}
          onChanged={reload}
        />
      )}
    </main>
  );
}

function BoardCard({ board, dark, isAdmin, userId, onSettings, onArchive, onUnarchive, onDelete }) {
  const tpl = TEMPLATES[board.template_key] || TEMPLATES.blank;
  const Icon = TEMPLATE_ICON[tpl.key] || PenLine;
  const acc = TEMPLATE_ACCENT[tpl.key] || TEMPLATE_ACCENT.blank; // deprecated templates (e.g. retro) → blank
  const accent = dark ? acc.dark : acc.light;
  const archived = !!board.archived_at;
  const updated = friendly(board.updated_at);
  const isOwner = ["personal", "public"].includes(board.scope) && board.owner_id === userId;
  const canManage = board.owner_id === userId || (board.scope === "org" && isAdmin);
  // Only render (and raise above the stretched link) the actions row when it
  // actually holds a control — otherwise it steals whole-card clicks.
  const showActions = !board.shared && ((canManage && !archived) || isAdmin || isOwner);
  const badge = board.shared
    ? { label: "Shared", cls: dark ? "bg-emerald-500/15 text-emerald-300" : "bg-emerald-50 text-emerald-600" }
    : board.scope === "public"
      ? { label: "Public", cls: dark ? "bg-sky-500/15 text-sky-300" : "bg-sky-50 text-sky-600" }
      : board.scope === "personal"
        ? (board.memberCount > 0
            ? { label: "Invite-only", cls: "bg-[var(--color-accent-light)] text-[var(--color-accent)]" }
            : { label: "Personal", cls: dark ? "bg-slate-700 text-slate-300" : "bg-slate-100 text-slate-500" })
        : null;

  return (
    <div
      className={`relative cursor-pointer rounded-2xl border p-4 flex flex-col gap-3 group transition-colors ${
        dark
          ? "bg-[var(--color-surface)] border-[var(--color-border-light)] hover:border-[var(--color-accent)]/40"
          : "bg-white border-slate-200 hover:border-[var(--color-accent)]/40 shadow-sm"
      } ${archived ? "opacity-70" : ""}`}
    >
      {/* Preview (bleeds to the top edges). Under the stretched link, so a click
          still opens the board. Falls back to the template icon. */}
      <div className={`-mx-4 -mt-4 h-28 overflow-hidden rounded-t-2xl border-b flex items-center justify-center ${dark ? "bg-[var(--color-surface-raised)] border-[var(--color-border-light)]" : "bg-slate-50 border-slate-100"}`}>
        {board.thumbnail
          ? <img src={board.thumbnail} alt="" loading="lazy" className="w-full h-full object-contain" />
          : <Icon className="w-8 h-8 opacity-25" />}
      </div>
      <div className="flex items-start gap-2">
        <div className={`p-1.5 rounded-md ${accent}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          {/* Stretched link — makes the WHOLE card open the board; actions below
              sit above it via z-10. */}
          <Link
            to={`/whiteboards/${board.id}`}
            className={`text-sm font-bold hover:underline truncate block after:absolute after:inset-0 after:content-[''] ${dark ? "text-slate-100" : "text-slate-800"}`}
          >
            {board.title || "Untitled whiteboard"}
          </Link>
          <p className={`text-[11px] flex items-center gap-1.5 ${dark ? "text-slate-500" : "text-slate-400"}`}>
            {badge && (
              <span className={`px-1.5 py-px rounded-full text-[9px] font-bold uppercase tracking-wider ${badge.cls}`}>
                {badge.label}
              </span>
            )}
            <span className="truncate">{tpl.name} · updated {updated}</span>
          </p>
        </div>
      </div>
      {board.goal && (
        <p className={`text-[12px] line-clamp-2 ${dark ? "text-slate-300" : "text-slate-600"}`}>
          {board.goal}
        </p>
      )}
      {showActions && (
      <div className="relative z-10 flex items-center gap-2 mt-auto cursor-default">
        {canManage && !board.shared && !archived && (
          <button
            type="button"
            onClick={onSettings}
            title="Whiteboard settings — sharing & scope"
            className={`text-xs font-semibold px-2.5 py-1 rounded-md inline-flex items-center gap-1 ${dark ? "text-slate-300 hover:bg-white/5" : "text-slate-600 hover:bg-slate-100"}`}
          >
            <Settings className="w-3.5 h-3.5" /> Settings
          </button>
        )}
        {(isAdmin || isOwner) && !board.shared && (
          <div className="ml-auto flex gap-1 opacity-100 pointer-events-auto sm:opacity-0 sm:pointer-events-none sm:group-hover:opacity-100 sm:group-hover:pointer-events-auto transition-opacity">
            {archived ? (
              <button
                type="button"
                onClick={onUnarchive}
                title="Restore"
                className={`p-1.5 rounded-md ${dark ? "text-slate-400 hover:bg-[var(--color-surface-raised)]" : "text-slate-500 hover:bg-slate-100"}`}
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onArchive}
                title="Archive"
                className={`p-1.5 rounded-md ${dark ? "text-slate-400 hover:bg-[var(--color-surface-raised)]" : "text-slate-500 hover:bg-slate-100"}`}
              >
                <Archive className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={onDelete}
              title="Delete"
              className={`p-1.5 rounded-md ${dark ? "text-slate-400 hover:text-red-400 hover:bg-red-500/10" : "text-slate-500 hover:text-red-600 hover:bg-red-50"}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function EmptyState({ dark, archived, onCreate, disabled }) {
  return (
    <div className={`rounded-2xl border border-dashed p-10 text-center ${
      dark ? "border-[var(--color-border)] bg-[var(--color-surface)]" : "border-slate-200 bg-white"
    }`}>
      <p className={`text-sm ${dark ? "text-slate-300" : "text-slate-700"} font-semibold`}>
        {archived ? "No archived whiteboards yet." : "No whiteboards yet."}
      </p>
      <p className={`text-xs mt-1 ${dark ? "text-slate-500" : "text-slate-500"}`}>
        {archived
          ? "Boards you archive will show up here."
          : "Start with a Weekly Review, brainstorm freely, or a blank canvas."}
      </p>
      {!archived && (
        <Button onClick={onCreate} disabled={disabled} className="mt-4">
          <Plus className="w-4 h-4 mr-1.5" />
          New whiteboard
        </Button>
      )}
    </div>
  );
}

function friendly(iso) {
  if (!iso) return "just now";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
