import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../context/ThemeContext";
import { useApp } from "../context/AppContext";
import { useTeam } from "../context/TeamContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Check, Users, User as UserIcon, UserPlus } from "lucide-react";
import Modal from "./Modal";
import {
  createWhiteboard,
  listWhiteboardTemplates,
  fetchTemplateSnapshot,
  inviteToWhiteboard,
} from "../lib/whiteboard";

// Modal for creating a new whiteboard. Start blank, or seed from one of your
// saved templates (personal or team). Personal boards can invite specific
// teammates right away (view + edit + a notification). `initialScope` lets the
// caller default the scope (e.g. the Personal tab opens it on "personal").

export default function NewWhiteboardModal({ open, onClose, teamId, initialScope, onCreated }) {
  const { theme } = useTheme();
  const { session } = useApp();
  const { teamMembers } = useTeam();
  const dark = theme === "dark";
  const selfId = session?.user?.id;
  const others = useMemo(
    () => (teamMembers || []).filter((m) => m.user_id && m.user_id !== selfId),
    [teamMembers, selfId],
  );

  const [title, setTitle] = useState("");
  const [choice, setChoice] = useState("blank"); // "blank" | template id
  const [scope, setScope] = useState("org"); // "org" (team) | "personal"
  const [invitees, setInvitees] = useState(() => new Set());
  const [templates, setTemplates] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Reset the form ONLY on the closed→open transition, so an external
  // activeTeamId refresh (team auto-switch on token refresh / tab focus) while
  // the modal is open can't wipe a typed name / template / invitee selection.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTitle(""); setChoice("blank");
      // Prefer the caller's scope (the active tab); fall back to team if available.
      setScope(initialScope === "personal" ? "personal" : (teamId ? "org" : "personal"));
      setInvitees(new Set());
      setBusy(false); setError("");
    }
    wasOpen.current = open;
  }, [open, initialScope, teamId]);

  // Templates load per team, independent of the field reset.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    listWhiteboardTemplates(teamId).then(({ data }) => { if (alive) setTemplates(data || []); });
    return () => { alive = false; };
  }, [open, teamId]);

  if (!open) return null;

  const toggleInvitee = (id) => setInvitees((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return; // guard Enter-key double-submit (button disable alone doesn't block form submit)
    if (scope === "org" && !teamId) { setError("Pick a team first."); return; }
    setBusy(true); setError("");
    let snapshot = null;
    if (choice !== "blank") {
      const { data: snap, error: snapErr } = await fetchTemplateSnapshot(choice);
      if (snapErr) { setBusy(false); setError(snapErr.message || "Could not load that template."); return; }
      snapshot = snap;
    }
    const { data, error: err } = await createWhiteboard({
      teamId,
      scope,
      title: title.trim() || "Whiteboard",
      createdBy: selfId,
      snapshot,
    });
    if (err || !data) { setBusy(false); setError(err?.message || "Could not create whiteboard."); return; }
    // Best-effort: invite the chosen teammates (they get a notification). The
    // board is already created, so an invite failure never blocks it.
    if (scope === "personal" && invitees.size) {
      // Prune to current teammates in case the roster changed while open.
      const validIds = [...invitees].filter((id) => others.some((o) => o.user_id === id));
      if (validIds.length) {
        const { error: invErr } = await inviteToWhiteboard(data.id, validIds);
        if (invErr) console.warn("NewWhiteboard invite:", invErr.message);
      }
    }
    setBusy(false);
    onCreated?.(data);
    onClose?.();
  }

  const field = dark ? "bg-[var(--color-surface-2,#1e293b)] border-[var(--color-border)] text-slate-100" : "bg-white border-slate-300 text-slate-900";
  const labelCls = `text-[10px] font-semibold uppercase tracking-wider ${dark ? "text-slate-400" : "text-slate-500"}`;

  function Card({ active, onClick, Icon, name, sub }) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-colors ${
          active
            ? "border-[var(--color-accent)] bg-[var(--color-accent-light)]"
            : dark
              ? "border-[var(--color-border)] hover:border-[var(--color-accent)]/60"
              : "border-slate-200 hover:border-[var(--color-accent)]/60"
        }`}
      >
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
          active ? "bg-[var(--color-accent)] text-white" : dark ? "bg-[var(--color-surface-raised)] text-slate-300" : "bg-slate-100 text-slate-600"
        }`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-bold truncate ${dark ? "text-slate-100" : "text-slate-800"}`}>{name}</p>
          <p className={`text-[11px] ${dark ? "text-slate-500" : "text-slate-500"}`}>{sub}</p>
        </div>
        {active && <Check className="w-4 h-4 text-[var(--color-accent)] shrink-0" />}
      </button>
    );
  }

  return (
    <Modal onClose={onClose} labelledBy="new-wb-title">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative w-full max-w-md flex flex-col overflow-hidden rounded-2xl border max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2rem)] ${
          dark ? "bg-[var(--color-surface)] border-[var(--color-border)] shadow-2xl shadow-black/40" : "bg-white border-slate-200 shadow-xl"
        }`}
      >
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
          {/* Header */}
          <div className="shrink-0 px-5 sm:px-6 pt-5 sm:pt-6 pb-3 relative">
            <h2 id="new-wb-title" className={`text-lg font-bold ${dark ? "text-slate-100" : "text-slate-800"}`}>New whiteboard</h2>
            <p className={`text-xs mt-0.5 ${dark ? "text-slate-400" : "text-slate-500"}`}>
              Start blank or from a saved template. You can rename it later.
            </p>
            <button
              type="button"
              onClick={onClose}
              className={`absolute top-3 right-3 p-1.5 rounded-lg ${dark ? "hover:bg-[var(--color-surface-raised)] text-slate-400" : "hover:bg-slate-100 text-slate-500"}`}
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 pb-2 space-y-4">
            <div>
              <label htmlFor="wb-title" className={labelCls}>Name</label>
              <Input id="wb-title" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} placeholder="Whiteboard" className="mt-1.5" autoFocus />
            </div>

            <div>
              <label className={labelCls}>Save to</label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Card active={scope === "org"} onClick={() => teamId && setScope("org")} Icon={Users} name="Team" sub={teamId ? "Everyone on the team" : "Join a team first"} />
                <Card active={scope === "personal"} onClick={() => setScope("personal")} Icon={UserIcon} name="Personal" sub="Private · you can invite people" />
              </div>
            </div>

            <div>
              <label htmlFor="wb-template" className={labelCls}>Start from</label>
              <select
                id="wb-template"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                className={`mt-1.5 w-full rounded-lg border px-3 py-2 text-sm ${field}`}
              >
                <option value="blank">Blank board</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} · {t.scope === "org" ? "Team" : "Personal"} template</option>
                ))}
              </select>
            </div>

            {/* Invite (personal boards only) */}
            {scope === "personal" && (
              <div>
                <label className={`${labelCls} inline-flex items-center gap-1.5`}><UserPlus className="w-3.5 h-3.5" /> Invite people (optional)</label>
                <p className={`text-[11px] mt-0.5 ${dark ? "text-slate-400" : "text-slate-500"}`}>
                  Invited teammates get view + edit access and a notification.
                </p>
                {others.length === 0 ? (
                  <p className="text-xs opacity-60 mt-1.5">No teammates to invite.</p>
                ) : (
                  <div className={`mt-1.5 rounded-lg border max-h-36 overflow-y-auto ${field}`}>
                    {others.map((m) => (
                      <label key={m.user_id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer">
                        <input type="checkbox" checked={invitees.has(m.user_id)} onChange={() => toggleInvitee(m.user_id)} className="accent-[var(--color-accent)]" />
                        <span className="truncate" title={m.name || "Teammate"}>{m.name || "Teammate"}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className={`text-xs font-medium px-3 py-1.5 rounded-lg ${dark ? "bg-red-500/15 text-red-400" : "bg-red-50 text-red-600"}`}>
                {error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className={`shrink-0 px-5 sm:px-6 py-4 border-t flex items-center justify-end gap-2 ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || (scope === "org" && !teamId)}>
              {busy ? "Creating…" : (scope === "personal" && invitees.size ? `Create & invite (${invitees.size})` : "Create whiteboard")}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
