import { useEffect, useMemo, useState } from "react";
import { X, Loader2, Trash2, UserPlus, Users, User as UserIcon, Globe, Link2, Check } from "lucide-react";
import Modal from "../Modal";
import { Button } from "@/components/ui/button";
import { useApp } from "../../context/AppContext";
import { useTeam } from "../../context/TeamContext";
import { getProfiles } from "../../lib/profiles";
import {
  setWhiteboardScope, listWhiteboardMembers, inviteToWhiteboard, removeWhiteboardMember,
} from "../../lib/whiteboard";

// Owner settings for a whiteboard: change its scope (Personal / Team / Public)
// and — for a personal board — manage who's invited. Public boards expose a
// read-only /w/:id link anyone can open.
const SCOPES = [
  { key: "personal", label: "Personal", Icon: UserIcon, sub: "Private to you · invite specific people" },
  { key: "org", label: "Team", Icon: Users, sub: "Everyone on the team can view & edit" },
  { key: "public", label: "Public", Icon: Globe, sub: "Anyone with the link can view (read-only)" },
];

export default function WhiteboardSettingsModal({ board, dark, onClose, onChanged }) {
  const { session } = useApp();
  const { teamMembers, activeTeamId } = useTeam();
  const selfId = session?.user?.id;
  const whiteboardId = board?.id;

  const [scope, setScope] = useState(board?.scope || "personal");
  const [savingScope, setSavingScope] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const others = useMemo(
    () => (teamMembers || []).filter((m) => m.user_id && m.user_id !== selfId),
    [teamMembers, selfId],
  );
  const [memberIds, setMemberIds] = useState([]);
  const [profiles, setProfiles] = useState({});
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => { setScope(board?.scope || "personal"); }, [board?.scope]);

  useEffect(() => {
    if (scope !== "personal") { setMemberIds([]); return; }
    let cancel = false;
    listWhiteboardMembers(whiteboardId).then(({ data }) => { if (!cancel) setMemberIds((data || []).map((r) => r.user_id)); });
    return () => { cancel = true; };
  }, [whiteboardId, scope]);

  useEffect(() => {
    const ids = [...new Set([...memberIds, ...others.map((m) => m.user_id)])].filter(Boolean);
    if (ids.length) getProfiles(ids).then((map) => setProfiles(map || {}));
  }, [memberIds, others]);

  const nameFor = (id) => profiles[id]?.display_name || others.find((o) => o.user_id === id)?.name || "Teammate";
  const memberSet = useMemo(() => new Set(memberIds), [memberIds]);
  const addable = others.filter((m) => !memberSet.has(m.user_id));
  const publicUrl = typeof window !== "undefined" ? `${window.location.origin}/w/${whiteboardId}` : `/w/${whiteboardId}`;
  const toggle = (id) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function refreshMembers() {
    const { data } = await listWhiteboardMembers(whiteboardId);
    setMemberIds((data || []).map((r) => r.user_id));
  }

  async function changeScope(next) {
    if (next === scope || savingScope) return;
    // Moving to Team needs an explicit team — never let the RPC fall back to an
    // arbitrary one (which would drop the board into the wrong org).
    if (next === "org" && !activeTeamId) { setError("Select a team first to move this board to the team."); return; }
    setSavingScope(true); setError("");
    const { data, error: e } = await setWhiteboardScope(whiteboardId, next, next === "org" ? activeTeamId : null);
    setSavingScope(false);
    if (e) { setError(e.message || "Could not change the board's scope."); return; }
    setScope(data?.scope || next);
    onChanged?.(data);
  }
  async function addSelected() {
    if (!selected.size || busy) return;
    setBusy(true); setError("");
    const { error: e } = await inviteToWhiteboard(whiteboardId, [...selected]);
    setBusy(false);
    if (e) { setError(e.message || "Could not share."); return; }
    setSelected(new Set()); await refreshMembers(); onChanged?.();
  }
  async function removeMember(id) {
    if (busy) return;
    setBusy(true); setError("");
    const { error: e } = await removeWhiteboardMember(whiteboardId, id);
    setBusy(false);
    if (e) { setError(e.message || "Could not remove."); return; }
    await refreshMembers(); onChanged?.();
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy automatically — select the link and copy it manually.");
    }
  }

  const field = dark ? "bg-[var(--color-surface-2,#1e293b)] border-[var(--color-border)] text-slate-100" : "bg-white border-slate-300 text-slate-900";
  const labelCls = `block text-xs font-semibold mb-1 ${dark ? "text-slate-300" : "text-slate-600"}`;

  return (
    <Modal open onClose={onClose} labelledBy="wb-settings-title">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-md flex flex-col overflow-hidden rounded-2xl border shadow-xl max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2rem)] ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}
      >
        <div className={`shrink-0 flex items-center justify-between gap-2 px-5 py-4 border-b ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
          <div className="min-w-0">
            <h2 id="wb-settings-title" className={`text-base font-bold ${dark ? "text-slate-100" : "text-slate-900"}`}>Whiteboard settings</h2>
            <p className={`text-[11px] truncate ${dark ? "text-slate-400" : "text-slate-500"}`}>{board?.title || "Untitled whiteboard"}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={`p-1.5 rounded-lg ${dark ? "text-slate-400 hover:text-slate-200 hover:bg-white/5" : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Scope */}
          <div>
            <label className={labelCls}>Who can access {savingScope && <Loader2 className="inline w-3 h-3 animate-spin ml-1" />}</label>
            <div className="mt-1.5 space-y-1.5">
              {SCOPES.map(({ key, label, Icon, sub }) => {
                const active = scope === key;
                return (
                  <button key={key} type="button" disabled={savingScope || (key === "org" && !activeTeamId)} onClick={() => changeScope(key)}
                    className={`w-full flex items-center gap-3 p-2.5 rounded-xl border text-left transition-colors disabled:opacity-60 ${
                      active ? "border-[var(--color-accent)] bg-[var(--color-accent-light)]" : dark ? "border-[var(--color-border)] hover:border-[var(--color-accent)]/60" : "border-slate-200 hover:border-[var(--color-accent)]/60"}`}>
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${active ? "bg-[var(--color-accent)] text-white" : dark ? "bg-[var(--color-surface-raised)] text-slate-300" : "bg-slate-100 text-slate-600"}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-bold ${dark ? "text-slate-100" : "text-slate-800"}`}>{label}</p>
                      <p className={`text-[11px] ${dark ? "text-slate-500" : "text-slate-500"}`}>{sub}</p>
                    </div>
                    {active && <Check className="w-4 h-4 text-[var(--color-accent)] shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Public link */}
          {scope === "public" && (
            <div>
              <label className={labelCls}><Link2 className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />Public link</label>
              <div className="flex items-center gap-2">
                <input readOnly value={publicUrl} onClick={(e) => e.target.select()} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-mono truncate ${field}`} />
                <Button type="button" variant="outline" onClick={copyLink}>{copied ? "Copied" : "Copy"}</Button>
              </div>
              <p className={`text-[11px] mt-1 ${dark ? "text-amber-300/80" : "text-amber-700"}`}>Anyone with this link can view the board — no sign-in required. It's read-only; only you can edit.</p>
            </div>
          )}

          {/* Members (personal only) */}
          {scope === "personal" && (
            <div>
              <label className={labelCls}>Invited people</label>
              <div className={`rounded-lg border divide-y ${field} ${dark ? "divide-white/5" : "divide-slate-100"}`}>
                <div className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="truncate">You</span>
                  <span className={`ml-auto text-[10px] font-semibold ${dark ? "text-slate-500" : "text-slate-400"}`}>owner</span>
                </div>
                {memberIds.length === 0 ? (
                  <div className="px-3 py-2 text-xs opacity-60">Private — no one else has access yet.</div>
                ) : memberIds.map((id) => (
                  <div key={id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="truncate">{nameFor(id)}</span>
                    <button type="button" onClick={() => removeMember(id)} disabled={busy} title="Remove access"
                      className={`ml-auto p-1 rounded-md ${dark ? "text-slate-400 hover:text-red-400 hover:bg-red-500/10" : "text-slate-500 hover:text-red-600 hover:bg-red-50"}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              {addable.length > 0 && (
                <>
                  <div className={`mt-2 rounded-lg border max-h-32 overflow-y-auto ${field}`}>
                    {addable.map((m) => (
                      <label key={m.user_id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer">
                        <input type="checkbox" checked={selected.has(m.user_id)} onChange={() => toggle(m.user_id)} className="accent-[var(--color-accent)]" />
                        <span className="truncate" title={nameFor(m.user_id)}>{nameFor(m.user_id)}</span>
                      </label>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-end">
                    <Button type="button" onClick={addSelected} disabled={busy || selected.size === 0}>
                      {busy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <UserPlus className="w-4 h-4 mr-1.5" />}
                      Invite{selected.size ? ` (${selected.size})` : ""}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {error && <p className={`text-xs font-medium ${dark ? "text-red-400" : "text-red-600"}`}>{error}</p>}
        </div>

        <div className={`shrink-0 border-t px-5 py-3 flex justify-end ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
          <Button type="button" variant="ghost" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
