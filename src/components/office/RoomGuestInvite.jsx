import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check, Mail, Share2, Trash2, Plus, UserPlus, ExternalLink } from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { createGuestLink, listGuestLinks, revokeGuestLink } from "../../lib/rooms";

// Self-contained "invite an external guest" section for RoomSettingsModal.
// Manages its own list of guest links (create / copy / share / email / revoke)
// with instant actions — it does NOT participate in the modal's Save button.
// Manager-only actions are enforced server-side (the create/revoke RPCs), and
// listGuestLinks RLS returns rows only to managers, so a non-manager just sees
// an empty, no-op section.
export default function RoomGuestInvite({ room, dark, onError }) {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const [copied, copy] = useCopyToClipboard();

  const roomId = room?.id;
  const roomName = room?.name || "the room";
  const canShare = typeof navigator !== "undefined" && !!navigator.share;

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    setLoading(true);
    listGuestLinks(roomId).then(({ data }) => {
      if (!cancelled) { setLinks(data || []); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [roomId]);

  async function handleCreate() {
    setBusy(true);
    const { data, error } = await createGuestLink(roomId, {});
    setBusy(false);
    if (error) { onError?.(error.message || "Could not create an invite link."); return; }
    // Prepend the new link (with its url/expiry) to the list.
    setLinks((prev) => [
      { id: data.id, token: data.token, url: data.url, expires_at: data.expires_at, label: null, created_at: new Date().toISOString() },
      ...prev,
    ]);
    copy(data.url, data.id); // copy the fresh link immediately for convenience
  }

  async function handleRevoke(linkId) {
    setBusy(true);
    const { error } = await revokeGuestLink(linkId);
    setBusy(false);
    if (error) { onError?.(error.message || "Could not revoke the link."); return; }
    setLinks((prev) => prev.filter((l) => l.id !== linkId));
  }

  function handleShare(url) {
    try { navigator.share({ title: `Join ${roomName}`, url }); } catch { /* dismissed */ }
  }

  function handleEmail(url) {
    const subject = encodeURIComponent(`Join ${roomName}`);
    const body = encodeURIComponent(
      `Hi,\n\nYou're invited to join "${roomName}" — click to join the video call and shared whiteboard:\n\n${url}\n\nNo account needed; just enter your name.`,
    );
    const to = encodeURIComponent(emailDraft.trim());
    window.open(`mailto:${to}?subject=${subject}&body=${body}`, "_blank", "noopener");
  }

  const labelCls = `text-[10px] font-semibold uppercase tracking-wider ${dark ? "text-slate-400" : "text-slate-500"}`;
  const fmtExpiry = (iso) => {
    if (!iso) return "never expires";
    const d = new Date(iso);
    return `expires ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  };

  return (
    <div className="mb-4">
      <label className={labelCls}>
        <UserPlus className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
        External guests
      </label>
      <p className={`text-[11px] mt-0.5 mb-2 ${dark ? "text-slate-400" : "text-slate-500"}`}>
        Share a link so someone outside your team can join this room's call and whiteboard — no account needed.
      </p>

      {loading ? (
        <div className={`text-xs ${dark ? "text-slate-500" : "text-slate-400"}`}>Loading…</div>
      ) : links.length === 0 ? (
        <Button size="sm" onClick={handleCreate} disabled={busy}>
          <Plus className="w-4 h-4 mr-1.5" /> Create invite link
        </Button>
      ) : (
        <div className="space-y-2">
          {links.map((l) => (
            <div
              key={l.id}
              className={`rounded-lg border p-2 ${dark ? "bg-[var(--color-bg)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}
            >
              <div className="flex items-center gap-1.5">
                <code className={`flex-1 min-w-0 truncate text-[11px] font-mono ${dark ? "text-slate-300" : "text-slate-600"}`}>
                  {l.url}
                </code>
                <button
                  type="button"
                  title="Copy link"
                  onClick={() => copy(l.url, l.id)}
                  className={`p-1.5 rounded-md ${dark ? "hover:bg-white/10 text-slate-300" : "hover:bg-slate-100 text-slate-600"}`}
                >
                  {copied === l.id ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
                {canShare && (
                  <button
                    type="button"
                    title="Share"
                    onClick={() => handleShare(l.url)}
                    className={`p-1.5 rounded-md ${dark ? "hover:bg-white/10 text-slate-300" : "hover:bg-slate-100 text-slate-600"}`}
                  >
                    <Share2 className="w-4 h-4" />
                  </button>
                )}
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open link"
                  className={`p-1.5 rounded-md ${dark ? "hover:bg-white/10 text-slate-300" : "hover:bg-slate-100 text-slate-600"}`}
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
                <button
                  type="button"
                  title="Revoke link"
                  onClick={() => handleRevoke(l.id)}
                  disabled={busy}
                  className={`p-1.5 rounded-md ${dark ? "hover:bg-red-500/15 text-slate-400 hover:text-red-400" : "hover:bg-red-50 text-slate-400 hover:text-red-500"}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className={`mt-1 px-0.5 text-[10px] ${dark ? "text-slate-500" : "text-slate-400"}`}>
                {fmtExpiry(l.expires_at)}
              </div>
            </div>
          ))}

          {/* Email a guest — opens the manager's own mail client (no server send). */}
          <div className={`rounded-lg border p-2 flex flex-wrap items-center gap-2 ${dark ? "bg-[var(--color-bg)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}>
            <input
              type="email"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              placeholder="guest@example.com"
              className={`flex-1 min-w-[160px] bg-transparent text-sm outline-none ${dark ? "text-slate-100 placeholder:text-slate-500" : "text-slate-800 placeholder:text-slate-400"}`}
            />
            <Button size="sm" variant="outline" onClick={() => handleEmail(links[0].url)} disabled={!emailDraft.trim()}>
              <Mail className="w-3.5 h-3.5 mr-1.5" /> Email link
            </Button>
          </div>

          <Button size="sm" variant="ghost" onClick={handleCreate} disabled={busy} className="text-xs">
            <Plus className="w-3.5 h-3.5 mr-1" /> New link
          </Button>
        </div>
      )}
    </div>
  );
}
