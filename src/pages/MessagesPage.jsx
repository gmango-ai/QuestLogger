import { useEffect, useMemo, useRef, useState, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useSearchParams, useNavigate } from "react-router-dom";
import Markdown from "react-markdown";
import {
  Send, Plus, ArrowLeft, Users, MessageSquare, Hash, Search, Paperclip, X,
  SmilePlus, Pencil, Trash2, Pin, PinOff, Bell, BellOff, Megaphone, Settings2, Download, ExternalLink,
  MoreHorizontal, LogOut, Folder, FolderPlus, FolderInput, ChevronDown, ChevronRight, Rows2, Rows3, DoorOpen,
} from "lucide-react";
import { useApp } from "../context/AppContext";
import { useTeam } from "../context/TeamContext";
import { useMessages } from "../context/MessagesContext";
import { useTheme } from "../context/ThemeContext";
import { useProfileCard } from "../context/ProfileContext";
import UserAvatar from "../components/UserAvatar";
import { EMOTES } from "../components/emotes/presets";
import FullEmojiPicker from "../components/emotes/FullEmojiPicker";
import {
  listMessages, sendMessage, editMessage, deleteMessage,
  listReactions, toggleReaction, listReadMarks, setChannelMeta,
  setConversationPinned, setConversationMuted,
} from "../lib/messages";
import { attachToMessage, listAttachments, isImage } from "../lib/messageAttachments";
import { expandEmojiShortcodes } from "../lib/emojiShortcodes";
import EmojiTextField from "../components/EmojiTextField";
import { emitMention } from "../lib/notifications";
import { playMessage } from "../lib/uiSounds";
import { supabase } from "../supabase";
import { useBodyScrollLock } from "../hooks/useBodyScrollLock";

// Quick-reaction set for the picker (presets + a few common extras, deduped).
const QUICK_REACTIONS = [...new Set([...EMOTES.map((e) => e.glyph), "😂", "😮", "😢", "🙏", "👀", "✅"])];
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function clockTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export function listStamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((today - d) / 86400000);
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
const fmtBytes = (n) => {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

// The glyph for a channel: announcement (admins-only posting) → megaphone, a
// room's chat channel → door, an ordinary channel → hash. Shared everywhere a
// channel is listed so the distinction is consistent.
export function channelGlyph(c, className = "w-4 h-4") {
  const Icon = c?.post_policy === "admins" ? Megaphone : c?.room_id ? DoorOpen : Hash;
  return <Icon className={className} />;
}

// A channel's accent colour — its own override, else the team colour, else teal.
export function channelColor(c) {
  return c?.color || c?.org_team_color || "#14b8a6";
}

// A conversation's display name — channel title, group title (or its members),
// or the other DM participant. Shared by the page + the nav quick-view.
export function conversationName(c, memberById) {
  if (!c) return "Conversation";
  if (c.kind === "channel") return c.title || "channel";
  if (c.kind === "group") return c.title || (c.participant_ids.map((id) => memberById.get(id)?.name || "Member").join(", ") || "Group");
  return memberById.get(c.participant_ids?.[0])?.name || "Member";
}

// Turn "@Name" (where Name is a known teammate) into a markdown link with a
// mention:// href, so the Body renderer can style it as a mention chip. Longest
// names first so "@Ann Marie" wins over "@Ann".
function linkifyMentions(text, mentionNames) {
  if (!text || !text.includes("@") || !mentionNames || mentionNames.size === 0) return text;
  // Match a name as-is AND with its spaces removed — mentions were historically
  // inserted de-spaced ("@CristianCantu"), which never matched the spaced name.
  // Both variants resolve to the same id; we always DISPLAY the readable name.
  const byToken = new Map();
  for (const [name, id] of mentionNames) {
    byToken.set(name, { name, id });
    const nospace = name.replace(/\s+/g, "");
    if (nospace !== name && !byToken.has(nospace)) byToken.set(nospace, { name, id });
  }
  const present = [...byToken.keys()].filter((t) => text.includes(`@${t}`)).sort((a, b) => b.length - a.length);
  if (!present.length) return text;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@(${present.map(esc).join("|")})`, "g");
  return text.replace(re, (_m, token) => {
    const v = byToken.get(token);
    return v ? `[@${v.name}](mention://${v.id})` : _m;
  });
}
// Keep react-markdown's URL safety but let our mention:// scheme (and same-page
// anchors) through.
function mdUrl(url) {
  if (!url) return "";
  if (url.startsWith("mention://")) return url;
  if (/^(https?:|mailto:|tel:)/i.test(url) || url.startsWith("/") || url.startsWith("#")) return url;
  return "";
}

// ── light markdown body (bold/italic/code/links + @mentions) ──
function Body({ text, mentionNames, className = "" }) {
  const { openProfile } = useProfileCard();
  const src = mentionNames ? linkifyMentions(text, mentionNames) : text;
  return (
    <div className={`text-sm leading-relaxed whitespace-pre-wrap break-words [&_a]:text-[var(--color-accent)] [&_a]:underline [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-black/10 [&_code]:text-[0.85em] [&_p]:m-0 [&_ul]:my-1 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:my-1 [&_ol]:pl-4 [&_ol]:list-decimal ${className}`}>
      <Markdown urlTransform={mdUrl} components={{ a: ({ node, href, ...p }) => (href || "").startsWith("mention://")
        ? <button
            type="button"
            onClick={(e) => { e.stopPropagation(); openProfile?.(href.slice("mention://".length), e.currentTarget.getBoundingClientRect()); }}
            className="font-semibold text-[var(--color-accent)] no-underline hover:underline align-baseline"
            {...p}
          />
        : <a href={href} {...p} target="_blank" rel="noopener noreferrer" /> }}>
        {src || ""}
      </Markdown>
    </div>
  );
}

// ── viewport-aware emoji picker (portal so nothing clips it) ──
// Quick-reaction strip with a "+" that expands to the shared FullEmojiPicker
// (the SAME picker the whiteboard / call emote bar uses) so you can pick ANY
// emoji, not just the presets. Themed to match the rest of the app.
function EmojiPopover({ anchor, onPick, onClose, dark }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [full, setFull] = useState(false);

  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const M = 8;
    let W, H;
    if (full) {
      // The full picker's default size, capped to the viewport.
      W = Math.min(300, window.innerWidth - 2 * M);
      H = Math.min(380, Math.max(0, window.innerHeight - 2 * M));
    } else {
      // Width from the ACTUAL number of quick reactions (each button ~40px on
      // touch), capped to the viewport so it never runs off-screen — it wraps
      // to more rows instead. Reserve one slot for the "+" more button.
      const wide = (QUICK_REACTIONS.length + 1) * 40 + 14;
      W = Math.min(wide, window.innerWidth - 2 * M);
      const rows = Math.ceil(wide / W);
      H = rows * 46 + 6;
    }
    let left = Math.min(r.left, window.innerWidth - W - M);
    left = Math.max(M, left);
    let top = r.top - H - 6;
    if (top < M) top = r.bottom + 6;
    top = Math.min(top, window.innerHeight - H - M);
    top = Math.max(M, top);
    setPos({ top, left, W, H });
  }, [anchor, full]);

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  if (!pos) return null;
  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 70 }}
      className={`rounded-2xl border shadow-xl overflow-hidden ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}
    >
      {full ? (
        <FullEmojiPicker dark={dark} width={pos.W} height={pos.H} onPick={(g) => onPick(g)} />
      ) : (
        <div style={{ maxWidth: pos.W }} className="flex flex-wrap items-center gap-0.5 px-1.5 py-1">
          {QUICK_REACTIONS.map((g) => (
            <button key={g} type="button" onClick={() => onPick(g)} className="w-10 h-10 sm:w-8 sm:h-8 rounded-full text-xl sm:text-lg leading-none hover:bg-slate-500/15 transition-transform hover:scale-110">
              {g}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setFull(true)}
            aria-label="Pick any emoji"
            title="More emojis"
            className={`w-10 h-10 sm:w-8 sm:h-8 rounded-full flex items-center justify-center transition-colors ${dark ? "text-slate-400 hover:text-slate-200 hover:bg-white/10" : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"}`}
          >
            <Plus className="w-5 h-5 sm:w-4 sm:h-4" />
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ── full-screen image lightbox ──
function Lightbox({ url, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!url) return null;
  return createPortal(
    <div onClick={onClose} className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm">
      <button type="button" onClick={onClose} aria-label="Close" className="absolute top-4 right-4 text-white/80 hover:text-white"><X className="w-6 h-6" /></button>
      <img src={url} alt="" onClick={(e) => e.stopPropagation()} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
    </div>,
    document.body,
  );
}

// ── reaction pills under a message ──
function ReactionPills({ reactions, onToggle, onAdd, dark }) {
  const entries = reactions ? [...reactions.entries()] : [];
  if (entries.length === 0) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap mt-1">
      {entries.map(([emoji, { count, mine }]) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onToggle(emoji, mine)}
          className={`inline-flex items-center gap-1 px-1.5 h-7 sm:h-6 rounded-full text-[12px] border transition-colors ${
            mine ? "bg-[var(--color-accent-light)] border-[var(--color-accent)] text-[var(--color-accent)] font-semibold"
                 : dark ? "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10" : "bg-slate-100 border-slate-200 text-slate-600 hover:bg-slate-200"
          }`}
        >
          <span className="text-sm leading-none">{emoji}</span><span>{count}</span>
        </button>
      ))}
      <button type="button" onClick={(e) => onAdd(e.currentTarget)} aria-label="Add reaction"
        className={`inline-flex items-center justify-center w-7 h-7 sm:w-6 sm:h-6 rounded-full border ${dark ? "border-white/10 text-slate-400 hover:bg-white/10" : "border-slate-200 text-slate-400 hover:bg-slate-100"}`}>
        <SmilePlus className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
      </button>
    </div>
  );
}

// ── attachment rendering: images inline (no filename), files as cards ──
function Attachments({ items, onOpenImage, dark }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-1.5">
      {items.map((a) => (
        isImage(a.mime) ? (
          <button key={a.id} type="button" onClick={() => onOpenImage(a.url)} className="block overflow-hidden rounded-xl border border-black/5 hover:opacity-95 transition-opacity">
            <img src={a.url} alt="" loading="lazy" className="max-h-72 max-w-[min(20rem,100%)] object-cover" />
          </button>
        ) : (
          <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer"
            className={`inline-flex items-center gap-2.5 rounded-xl border px-3 py-2 max-w-xs ${dark ? "border-[var(--color-border)] bg-[var(--color-surface-raised)] hover:bg-white/5" : "border-slate-200 bg-slate-50 hover:bg-slate-100"}`}>
            <span className="w-9 h-9 rounded-lg bg-[var(--color-accent-light)] text-[var(--color-accent)] flex items-center justify-center shrink-0"><Paperclip className="w-4 h-4" /></span>
            <span className="min-w-0">
              <span className={`block text-sm font-medium truncate ${dark ? "text-slate-200" : "text-slate-700"}`}>{a.name || "Attachment"}</span>
              <span className="block text-[11px] text-slate-400">{fmtBytes(a.bytes)}</span>
            </span>
            <Download className="w-4 h-4 text-slate-400 shrink-0" />
          </a>
        )
      ))}
    </div>
  );
}

// ── mention-aware text field (shared by the composer AND the inline editor) ──
// EmojiTextField (":emoji:" shortcodes) plus an @-teammate autocomplete. Fully
// controlled — the caller owns `value`; we track only the transient mention
// query. Auto-grows to fit. Extracted so editing a message keeps the exact same
// mention/emoji behaviour the composer has (previously the editor was a bare
// <textarea>, so @-mentions couldn't be picked and had to be retyped by hand).
function MentionField({
  value, onChange, candidates = [], onSubmit, onCancel, onTyping, dark,
  autoFocus, wrapperClassName = "", className, maxHeight = 160, ...rest
}) {
  const taRef = useRef(null);
  const [mentionQ, setMentionQ] = useState(null);

  const matches = useMemo(() => {
    if (mentionQ == null) return [];
    const q = mentionQ.toLowerCase();
    return candidates.filter((m) => (m.name || "").toLowerCase().includes(q)).slice(0, 6);
  }, [mentionQ, candidates]);

  // Auto-grow to fit (capped), and shrink back when the value is cleared/reset.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return undefined;
    const resize = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    };
    resize();
    // The synchronous measure above can be wrong when the field mounts inside a
    // room tile that isn't laid out yet (or is momentarily hidden) — that would
    // leave an empty field stuck at the max height with no keystroke to correct
    // it. Re-measure after the next frame (once layout/flex widths resolve), and
    // whenever the field's width settles/changes (observing width only, so
    // setting our own height can't feed back into a loop).
    const raf = requestAnimationFrame(resize);
    const wrap = el.parentElement;
    let ro;
    if (wrap && typeof ResizeObserver !== "undefined") {
      let lastW = wrap.clientWidth;
      ro = new ResizeObserver(() => {
        const w = wrap.clientWidth;
        if (w !== lastW) { lastW = w; resize(); }
      });
      ro.observe(wrap);
    }
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [value, maxHeight]);

  // Focus + drop the caret at the end when opened as an editor.
  useEffect(() => {
    if (!autoFocus) return;
    const el = taRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    try { el.setSelectionRange(len, len); } catch { /* */ }
  }, [autoFocus]);

  // EmojiTextField already live-expanded :codes:; its synthetic event carries
  // value + selectionStart, so this only tracks the @-mention query.
  const handleChange = (e) => {
    const val = e.target.value;
    const caret = e.target.selectionStart ?? val.length;
    const m = val.slice(0, caret).match(/@([\w]*)$/);
    setMentionQ(m ? m[1] : null);
    onChange(val);
    onTyping?.();
  };

  const pickMention = (member) => {
    const el = taRef.current;
    const pos = el ? el.selectionStart : value.length;
    const before = value.slice(0, pos).replace(/@([\w]*)$/, `@${(member.name || "").replace(/\s+/g, "")} `);
    onChange(before + value.slice(pos));
    setMentionQ(null);
    requestAnimationFrame(() => { try { el?.focus(); el?.setSelectionRange(before.length, before.length); } catch { /* */ } });
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      if (mentionQ != null) { e.preventDefault(); setMentionQ(null); return; }
      if (onCancel) { e.preventDefault(); onCancel(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && mentionQ == null && onSubmit) { e.preventDefault(); onSubmit(); }
  };

  return (
    <div className={`relative ${wrapperClassName}`}>
      {matches.length > 0 && (
        <div className={`absolute bottom-full left-0 mb-2 w-64 max-h-52 overflow-y-auto rounded-xl border shadow-lg z-30 ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}>
          {matches.map((m) => (
            <button key={m.user_id} type="button" onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${dark ? "hover:bg-white/5 text-slate-200" : "hover:bg-slate-50 text-slate-700"}`}>
              <UserAvatar url={m.avatar_url || ""} name={m.name || "Member"} size={24} />{m.name || "Member"}
            </button>
          ))}
        </div>
      )}
      <EmojiTextField
        multiline
        ref={taRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        className={className}
        {...rest}
      />
    </div>
  );
}

// ── composer (mentions + attachments + image thumbnails) ──
function Composer({ onSend, onTyping, candidates, dark, placeholder = "Message…", disabled, allowImages = true }) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState([]);
  const fileRef = useRef(null);
  const filesRef = useRef(files);

  useEffect(() => {
    filesRef.current.forEach((f) => {
      if (f._url && !files.includes(f)) URL.revokeObjectURL(f._url);
    });
    filesRef.current = files;
  }, [files]);

  useEffect(() => () => filesRef.current.forEach((f) => f._url && URL.revokeObjectURL(f._url)), []);

  const addFiles = (list) => setFiles((p) => [...p, ...Array.from(list).map((f) => Object.assign(f, { _url: f.type?.startsWith("image/") ? URL.createObjectURL(f) : null }))]);

  const submit = async () => {
    const body = expandEmojiShortcodes(draft.trim()); // catch any unexpanded :code:
    if (!body && files.length === 0) return;
    setDraft(""); setFiles([]);
    await onSend(body, files);
  };

  if (disabled) {
    return <div className={`shrink-0 border-t px-4 py-3.5 text-center text-[13px] ${dark ? "border-[var(--color-border)] text-slate-500" : "border-slate-200 text-slate-400"}`}>{placeholder}</div>;
  }

  return (
    <div className={`shrink-0 border-t p-3 ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
      {files.length > 0 && (
        <div className="flex gap-2 flex-wrap mb-2">
          {files.map((f, i) => (
            <div key={i} className="relative group/att">
              {f._url
                ? <img src={f._url} alt="" className="w-16 h-16 object-cover rounded-lg border border-black/10" />
                : <div className={`w-16 h-16 rounded-lg border flex flex-col items-center justify-center gap-1 ${dark ? "border-[var(--color-border)] bg-[var(--color-surface-raised)]" : "border-slate-200 bg-slate-50"}`}>
                    <Paperclip className="w-4 h-4 text-slate-400" /><span className="text-[8px] px-1 truncate max-w-full text-slate-400">{f.name}</span>
                  </div>}
              <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} aria-label="Remove"
                className="absolute -top-1.5 -right-1.5 w-6 h-6 sm:w-5 sm:h-5 rounded-full bg-slate-800 text-white flex items-center justify-center shadow"><X className="w-3.5 h-3.5 sm:w-3 sm:h-3" /></button>
            </div>
          ))}
        </div>
      )}
      <div className={`relative flex items-end gap-1.5 rounded-2xl border px-1.5 py-1 ${dark ? "bg-[var(--color-surface-raised)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}>
        {allowImages && <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files || []); e.target.value = ""; }} />}
        {allowImages && (
          <button type="button" onClick={() => fileRef.current?.click()} aria-label="Attach"
            className={`shrink-0 w-11 h-11 sm:w-9 sm:h-9 rounded-xl inline-flex items-center justify-center ${dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"}`}>
            <Paperclip className="w-5 h-5 sm:w-[18px] sm:h-[18px]" />
          </button>
        )}
        <MentionField
          value={draft}
          onChange={setDraft}
          candidates={candidates}
          onSubmit={submit}
          onTyping={onTyping}
          dark={dark}
          wrapperClassName="flex-1 min-w-0"
          rows={1}
          placeholder={placeholder}
          className={`w-full resize-none bg-transparent py-2 text-sm outline-none max-h-40 ${dark ? "text-slate-100 placeholder:text-slate-500" : "text-slate-800 placeholder:text-slate-400"}`}
        />
        <button type="button" onClick={submit} disabled={!draft.trim() && files.length === 0} aria-label="Send"
          className="shrink-0 inline-flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 rounded-xl bg-[var(--color-accent)] text-white disabled:opacity-30 transition-opacity">
          <Send className="w-5 h-5 sm:w-[18px] sm:h-[18px]" />
        </button>
      </div>
    </div>
  );
}

// ── conversation header ──
function ConvHeader({ conversation, name, memberById, canManage, onBack, onToggleSettings, onOpenFull, onOpenRoom, dark }) {
  const kind = conversation?.kind || (conversation?.is_group ? "group" : "dm");
  const first = memberById.get(conversation?.participant_ids?.[0]);
  return (
    <div className={`flex items-center gap-3 px-3 sm:px-4 h-14 shrink-0 border-b ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
      {/* In the embedded quick-view (onOpenFull set) the back arrow is always
          shown so you can return to the list; on the full page it's mobile-only. */}
      <button type="button" onClick={onBack} className={`${onOpenFull ? "" : "md:hidden"} p-3 sm:p-1.5 -ml-1 rounded-lg ${dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"}`} aria-label="Back">
        <ArrowLeft className="w-5 h-5" />
      </button>
      {kind === "channel" ? (
        <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: `${channelColor(conversation)}22`, color: channelColor(conversation) }}>{channelGlyph(conversation)}</span>
      ) : kind === "group" ? (
        <span className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${dark ? "bg-[var(--color-surface-raised)] text-slate-300" : "bg-slate-200 text-slate-600"}`}><Users className="w-4 h-4" /></span>
      ) : (
        <UserAvatar url={first?.avatar_url || ""} name={first?.name || name} size={36} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-[15px] font-bold truncate ${dark ? "text-slate-100" : "text-slate-800"}`}>{name}</span>
          {conversation?.post_policy === "admins" && <Megaphone className="w-3.5 h-3.5 text-amber-500 shrink-0" aria-label="Announcement channel" />}
        </div>
        {kind === "channel" && conversation?.topic && <span className={`block text-[12px] truncate ${dark ? "text-slate-500" : "text-slate-400"}`}>{conversation.topic}</span>}
      </div>
      {onOpenRoom && conversation?.room_id && (
        <button type="button" onClick={onOpenRoom} aria-label="Open room" title="Open room" className={`p-3 sm:p-2 rounded-lg ${dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"}`}>
          <DoorOpen className="w-[18px] h-[18px]" />
        </button>
      )}
      {onOpenFull && (
        <button type="button" onClick={onOpenFull} aria-label="Open in Messages" title="Open full page" className={`p-3 sm:p-2 rounded-lg ${dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"}`}>
          <ExternalLink className="w-[18px] h-[18px]" />
        </button>
      )}
      {canManage && (
        <button type="button" onClick={onToggleSettings} aria-label="Channel settings" className={`p-3 sm:p-2 rounded-lg ${dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"}`}>
          <Settings2 className="w-[18px] h-[18px]" />
        </button>
      )}
    </div>
  );
}

// ── Open conversation ──
export function Thread({ conversation, name, memberById, candidates, userId, isAdmin, myOrgTeamLeadIds, onBack, onOpenFull, onOpenRoom, hideHeader, slimHeader, markRead, subscribeMessages, subscribeReactions, onChannelMetaSaved, dark }) {
  const convId = conversation?.id;
  const kind = conversation?.kind || (conversation?.is_group ? "group" : "dm");
  const isChannel = kind === "channel";
  const showAuthors = kind === "group" || isChannel;
  const canManageChannel = isChannel && (isAdmin || myOrgTeamLeadIds?.has(conversation?.org_team_id));
  const { openProfile } = useProfileCard();
  // Name → user_id for rendering @mentions, from everyone we can see.
  const mentionNames = useMemo(() => {
    const m = new Map();
    for (const mem of memberById.values()) if (mem?.name && mem?.user_id) m.set(mem.name, mem.user_id);
    return m;
  }, [memberById]);
  // Resolve the teammate ids @-mentioned in a body (names are stored de-spaced,
  // e.g. "@AnaLopez"), excluding yourself. Shared by send AND edit so a mention
  // added or fixed while editing still fires a ping.
  const mentionIdsIn = useCallback((body) => {
    const ids = new Set();
    if (!body) return ids;
    for (const tok of (body.match(/@([\w]+)/g) || [])) {
      const nm = tok.slice(1).toLowerCase();
      const hit = candidates.find((c) => (c.name || "").replace(/\s+/g, "").toLowerCase() === nm);
      if (hit && hit.user_id !== userId) ids.add(hit.user_id);
    }
    return ids;
  }, [candidates, userId]);
  const pingMentions = useCallback((ids, body) => {
    for (const rid of ids) {
      emitMention({ recipient: rid, title: `${memberById.get(userId)?.name || "Someone"} mentioned you`, body: body.slice(0, 140), payload: { route: conversation?.room_id ? `/office/r/${conversation.room_id}` : "/messages", room_id: conversation?.room_id || undefined, conversation_id: convId }, entityType: "conversation", entityId: convId });
    }
  }, [memberById, userId, conversation, convId]);
  const [messages, setMessages] = useState([]);
  const [reactions, setReactions] = useState(new Map());
  const [attachments, setAttachments] = useState(new Map());
  const [readMarks, setReadMarks] = useState([]);
  const [editing, setEditing] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const [typers, setTypers] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [emoji, setEmoji] = useState(null);   // { messageId, anchor }
  const [lightbox, setLightbox] = useState(null);
  // Touch: which message's action toolbar is revealed (tap a message to show
  // its react/edit/delete; tap again or elsewhere to hide). Desktop uses hover.
  const [selectedMsg, setSelectedMsg] = useState(null);
  const scrollRef = useRef(null);
  const presenceRef = useRef(null);

  const refreshSidecars = useCallback(async (msgs) => {
    const ids = msgs.map((m) => m.id);
    const [rx, at] = await Promise.all([listReactions(ids, userId), listAttachments(ids)]);
    setReactions(rx); setAttachments(at);
  }, [userId]);

  useEffect(() => {
    if (!convId) return;
    let alive = true;
    setMessages([]); setReactions(new Map()); setAttachments(new Map()); setShowSettings(false);
    listMessages(convId).then((msgs) => { if (alive) { setMessages(msgs); refreshSidecars(msgs); } });
    listReadMarks(convId).then((m) => alive && setReadMarks(m));
    markRead(convId, kind);
    return () => { alive = false; };
  }, [convId, kind, markRead, refreshSidecars]);

  useEffect(() => subscribeMessages((m) => {
    if (m.conversation_id !== convId) return;
    setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
    markRead(convId, kind);
    listReadMarks(convId).then(setReadMarks);
  }), [convId, kind, subscribeMessages, markRead]);

  useEffect(() => subscribeReactions(() => {
    setMessages((cur) => { refreshSidecars(cur); return cur; });
  }), [subscribeReactions, refreshSidecars]);

  // Keep the view pinned to the newest message. A plain effect fires before
  // images/attachments finish loading (so scrollHeight is still short and it
  // lands mid-thread), and a conversation switch needs to jump to the bottom
  // immediately. rAF after paint + a short retry covers the async growth.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const toBottom = () => { el.scrollTop = el.scrollHeight; };
    toBottom();
    const raf = requestAnimationFrame(toBottom);
    const t = setTimeout(toBottom, 150);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [messages, convId]);

  // presence: typing + online. The topic is shared across USERS (that's how
  // typing propagates), so it must stay deterministic per conversation — which
  // means two Thread instances in one browser (e.g. a room tile + the quick view
  // for the same channel), or a StrictMode re-mount, would otherwise hand back an
  // already-subscribed channel and blow up on `.on('presence')` after
  // subscribe(). Reuse the live channel for the topic when one exists; only the
  // instance that created it registers callbacks + owns cleanup.
  useEffect(() => {
    if (!convId || !userId) return undefined;
    const topic = `presence:conv:${convId}`;
    const existing = supabase.getChannels().find((c) => c.topic === `realtime:${topic}` || c.topic === topic);
    if (existing) { presenceRef.current = existing; return undefined; }
    const ch = supabase.channel(topic, { config: { presence: { key: userId } } });
    presenceRef.current = ch;
    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState();
      const t = [];
      for (const key of Object.keys(state)) {
        if (key === userId) continue;
        if ((state[key][0] || {}).typing) t.push({ user_id: key, name: state[key][0].name });
      }
      setTypers(t);
    }).subscribe(async (status) => {
      if (status === "SUBSCRIBED") await ch.track({ typing: false, name: memberById.get(userId)?.name || "Someone" });
    });
    return () => { try { supabase.removeChannel(ch); } catch { /* */ } if (presenceRef.current === ch) presenceRef.current = null; };
  }, [convId, userId, memberById]);

  const typingTimer = useRef(null);
  const signalTyping = useCallback(() => {
    const ch = presenceRef.current;
    if (!ch) return;
    const nm = memberById.get(userId)?.name || "Someone";
    try { ch.track({ typing: true, name: nm }); } catch { /* channel may be torn down by another instance */ }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => { try { ch.track({ typing: false, name: nm }); } catch { /* */ } }, 2500);
  }, [userId, memberById]);

  const onSend = async (body, files) => {
    // Body must be ≥1 char (DB constraint); for an attachment-only message send a
    // single space and let the renderer hide whitespace-only text.
    const hasFiles = files.length > 0;
    const outBody = body || (hasFiles ? " " : "");
    if (!outBody) return;
    const { message } = await sendMessage(convId, outBody, userId, kind);
    if (!message) return;
    playMessage(); // cue your own send
    setMessages((prev) => (prev.some((x) => x.id === message.id) ? prev : [...prev, message]));
    if (hasFiles) {
      await Promise.all(files.map((f) => attachToMessage(f, convId, message.id)));
      const at = await listAttachments([message.id]);
      setAttachments((prev) => new Map([...prev, ...at]));
    }
    // mentions (only when there's real text)
    if (body) pingMentions(mentionIdsIn(body), body);
  };

  const onToggleReaction = async (messageId, glyph, mine) => {
    setEmoji(null);
    await toggleReaction(messageId, glyph, userId, mine);
    setReactions(await listReactions(messages.map((m) => m.id), userId));
  };

  const saveEdit = async (messageId) => {
    const body = editDraft.trim();
    if (!body) { setEditing(null); return; }
    const prevBody = messages.find((m) => m.id === messageId)?.body || "";
    const { message } = await editMessage(messageId, body);
    if (message) {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, body: message.body, edited_at: message.edited_at } : m)));
      // Ping only teammates the edit NEWLY mentions — not those already tagged.
      const before = mentionIdsIn(prevBody);
      pingMentions(new Set([...mentionIdsIn(body)].filter((id) => !before.has(id))), body);
    }
    setEditing(null);
  };
  const onDelete = async (messageId) => {
    if (!window.confirm("Delete this message?")) return;
    await deleteMessage(messageId);
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  };

  const lastMsg = messages[messages.length - 1];
  const seenBy = useMemo(() => {
    if (!lastMsg || lastMsg.sender_id !== userId) return [];
    return readMarks
      .filter((r) => r.user_id !== userId && r.last_read_at && new Date(r.last_read_at) >= new Date(lastMsg.created_at))
      .map((r) => memberById.get(r.user_id)).filter(Boolean);
  }, [readMarks, lastMsg, memberById, userId]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {slimHeader ? (
        // Slim bar for embedded room tiles (the tile has its own "Chat" title):
        // just the channel settings gear (admins), topic, and announcement badge.
        (canManageChannel || conversation?.topic || conversation?.post_policy === "admins") && (
          <div className={`flex items-center gap-2 px-2.5 h-8 shrink-0 border-b ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
            {conversation?.post_policy === "admins" && <Megaphone className="w-3.5 h-3.5 text-amber-500 shrink-0" aria-label="Announcement channel" />}
            {conversation?.topic && <span className={`flex-1 min-w-0 truncate text-[11px] ${dark ? "text-slate-500" : "text-slate-400"}`}>{conversation.topic}</span>}
            {canManageChannel && (
              <button type="button" onClick={() => setShowSettings((v) => !v)} aria-label="Channel settings" title="Channel settings" className={`ml-auto p-1 rounded ${dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"}`}>
                <Settings2 className="w-4 h-4" />
              </button>
            )}
          </div>
        )
      ) : !hideHeader && (
        <ConvHeader conversation={conversation} name={name} memberById={memberById} canManage={canManageChannel} onBack={onBack} onToggleSettings={() => setShowSettings((v) => !v)} onOpenFull={onOpenFull} onOpenRoom={onOpenRoom} dark={dark} />
      )}

      {showSettings && canManageChannel && (
        <ChannelSettings conversation={conversation} memberById={memberById} dark={dark} onClose={() => setShowSettings(false)} onSaved={onChannelMetaSaved} />
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-3">
        {messages.length === 0 && (
          <div className={`text-center text-sm py-16 ${dark ? "text-slate-500" : "text-slate-400"}`}>This is the beginning of your conversation.</div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const mine = m.sender_id === userId;
          const author = memberById.get(m.sender_id);
          const atts = attachments.get(m.id) || [];
          const hasText = (m.body || "").trim().length > 0;
          const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
          const grouped = !newDay && prev && prev.sender_id === m.sender_id && (new Date(m.created_at) - new Date(prev.created_at)) < GROUP_WINDOW_MS;

          return (
            <div key={m.id}>
              {newDay && (
                <div className="flex items-center gap-3 px-4 py-2">
                  <div className={`flex-1 h-px ${dark ? "bg-white/10" : "bg-slate-200"}`} />
                  <span className={`text-[11px] font-semibold ${dark ? "text-slate-500" : "text-slate-400"}`}>{dayLabel(m.created_at)}</span>
                  <div className={`flex-1 h-px ${dark ? "bg-white/10" : "bg-slate-200"}`} />
                </div>
              )}
              <div
                onClick={() => setSelectedMsg((cur) => (cur === m.id ? null : m.id))}
                className={`group relative flex gap-3 px-4 ${grouped ? "mt-0.5" : "mt-3"} py-0.5 ${selectedMsg === m.id ? (dark ? "bg-white/[0.03]" : "bg-slate-50") : dark ? "hover:bg-white/[0.03]" : "hover:bg-slate-50"}`}
              >
                <div className="w-9 shrink-0">
                  {!grouped
                    ? <button type="button" className="rounded-full" title="View profile" onClick={(e) => { e.stopPropagation(); openProfile?.(m.sender_id, e.currentTarget.getBoundingClientRect()); }}>
                        <UserAvatar url={author?.avatar_url || ""} name={author?.name || "Member"} size={36} />
                      </button>
                    : <span className="hidden group-hover:block pt-1 text-right pr-1 text-[10px] text-slate-400 tabular-nums">{clockTime(m.created_at)}</span>}
                </div>
                <div className="min-w-0 flex-1">
                  {!grouped && (
                    <div className="flex items-baseline gap-2">
                      <button type="button" onClick={(e) => { e.stopPropagation(); openProfile?.(m.sender_id, e.currentTarget.getBoundingClientRect()); }} className={`select-none text-sm font-bold hover:underline ${mine ? "text-[var(--color-accent)]" : dark ? "text-slate-100" : "text-slate-800"}`}>{mine ? "You" : (author?.name || "Member")}</button>
                      <span className="text-[11px] text-slate-400">{clockTime(m.created_at)}</span>
                    </div>
                  )}
                  {editing === m.id ? (
                    <div className="flex flex-col gap-1.5 mt-1">
                      <MentionField
                        value={editDraft}
                        onChange={setEditDraft}
                        candidates={candidates}
                        onSubmit={() => saveEdit(m.id)}
                        onCancel={() => setEditing(null)}
                        onTyping={signalTyping}
                        autoFocus
                        dark={dark}
                        rows={2}
                        className={`w-full resize-none rounded-lg border px-2.5 py-1.5 text-sm outline-none max-h-40 ${dark ? "bg-[var(--color-surface-raised)] border-[var(--color-border)] text-slate-100" : "bg-white border-slate-200 text-slate-800"}`}
                      />
                      <div className="flex gap-3 text-[12px]">
                        <button onClick={() => saveEdit(m.id)} className="font-semibold text-[var(--color-accent)] py-2 sm:py-0">Save</button>
                        <button onClick={() => setEditing(null)} className="text-slate-400 py-2 sm:py-0">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {hasText && <Body text={m.body} mentionNames={mentionNames} />}
                      {m.edited_at && hasText && <span className="text-[10px] text-slate-400 ml-1">(edited)</span>}
                      <Attachments items={atts} onOpenImage={setLightbox} dark={dark} />
                      <ReactionPills reactions={reactions.get(m.id)} onToggle={(g, isMine) => onToggleReaction(m.id, g, isMine)} onAdd={(el) => setEmoji({ messageId: m.id, anchor: el })} dark={dark} />
                    </>
                  )}
                </div>

                {/* action toolbar — tap-to-reveal on touch (only the selected
                    message), hover-reveal on desktop. */}
                {editing !== m.id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className={`absolute -top-3 right-3 flex items-center rounded-lg border shadow-sm transition-opacity ${selectedMsg === m.id ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"} md:opacity-0 md:pointer-events-auto md:group-hover:opacity-100 ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}
                  >
                    <button type="button" onClick={(e) => setEmoji({ messageId: m.id, anchor: e.currentTarget })} aria-label="React"
                      className={`p-2.5 sm:p-1.5 ${dark ? "text-slate-400 hover:text-slate-200" : "text-slate-500 hover:text-slate-700"}`}><SmilePlus className="w-5 h-5 sm:w-4 sm:h-4" /></button>
                    {mine && <button type="button" onClick={() => { setEditing(m.id); setEditDraft(m.body); }} aria-label="Edit"
                      className={`p-2.5 sm:p-1.5 ${dark ? "text-slate-400 hover:text-slate-200" : "text-slate-500 hover:text-slate-700"}`}><Pencil className="w-5 h-5 sm:w-4 sm:h-4" /></button>}
                    {mine && <button type="button" onClick={() => onDelete(m.id)} aria-label="Delete"
                      className="p-2.5 sm:p-1.5 text-slate-400 hover:text-red-500"><Trash2 className="w-5 h-5 sm:w-4 sm:h-4" /></button>}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {seenBy.length > 0 && (
          <div className="flex items-center justify-end gap-1 px-4 pt-1.5">
            <span className={`text-[10px] ${dark ? "text-slate-500" : "text-slate-400"}`}>Seen by</span>
            {seenBy.slice(0, 5).map((u) => <UserAvatar key={u.user_id} url={u.avatar_url || ""} name={u.name || "Member"} size={16} />)}
          </div>
        )}
        {typers.length > 0 && (
          <div className={`px-4 pt-2 text-[12px] italic ${dark ? "text-slate-500" : "text-slate-400"}`}>
            {typers.map((t) => t.name || "Someone").join(", ")} {typers.length === 1 ? "is" : "are"} typing…
          </div>
        )}
      </div>

      <Composer onSend={onSend} onTyping={signalTyping} candidates={candidates} dark={dark}
        allowImages={conversation?.allow_images !== false}
        placeholder={conversation?.post_policy === "admins" && !canManageChannel ? "Only admins can post in this channel" : `Message ${isChannel ? "#" + (name || "channel") : name || ""}`}
        disabled={conversation?.post_policy === "admins" && !canManageChannel} />

      {emoji && <EmojiPopover anchor={emoji.anchor} dark={dark}
        onPick={(g) => onToggleReaction(emoji.messageId, g, reactions.get(emoji.messageId)?.get(g)?.mine)}
        onClose={() => setEmoji(null)} />}
      <Lightbox url={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}

// ── channel settings (admin/lead) ──
export function ChannelSettings({ conversation, memberById, dark, onClose, onSaved }) {
  const [title, setTitle] = useState(conversation.title || "");
  const [topic, setTopic] = useState(conversation.topic || "");
  const [policy, setPolicy] = useState(conversation.post_policy || "all");
  const [color, setColor] = useState(conversation.color || "");
  const [retention, setRetention] = useState(conversation.retention_days || 0);
  const [allowImages, setAllowImages] = useState(conversation.allow_images !== false);
  const [forceNotify, setForceNotify] = useState(!!conversation.force_notify);
  const [pinnedAll, setPinnedAll] = useState(!!conversation.pinned_all);
  const [archived, setArchived] = useState(!!conversation.archived_at);
  const [busy, setBusy] = useState(false);
  const { teamsByUserId } = useTeam();
  const isRoom = !!conversation.room_id;
  const teamColor = conversation.org_team_color || "#14b8a6";
  const roster = useMemo(() => {
    const out = [];
    for (const [uid, teams] of (teamsByUserId || new Map())) {
      if (teams.some((t) => t.id === conversation.org_team_id)) { const m = memberById.get(uid); if (m) out.push(m); }
    }
    return out;
  }, [teamsByUserId, conversation.org_team_id, memberById]);

  const save = async () => {
    setBusy(true);
    await setChannelMeta(conversation.id, {
      title, topic, postPolicy: policy,
      color: color || "",              // "" clears back to the team colour
      retentionDays: Number(retention) || 0,
      allowImages, forceNotify, pinnedAll,
      ...(isRoom ? {} : { archived }), // room channels can't be archived here
    });
    await onSaved?.();
    setBusy(false);
    onClose();
  };
  const inputCls = `w-full rounded-lg border px-3 py-2 text-sm ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)] text-slate-100" : "bg-white border-slate-200 text-slate-800"}`;
  const rowCls = `flex items-center gap-2 py-1.5 sm:py-0 text-xs ${dark ? "text-slate-300" : "text-slate-700"}`;
  return (
    <div className={`px-4 py-3 border-b space-y-2.5 max-h-[70vh] overflow-y-auto ${dark ? "border-[var(--color-border)] bg-[var(--color-surface-raised)]" : "border-slate-200 bg-slate-50"}`}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Channel name" className={inputCls} />
      <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic / description" className={inputCls} />

      {/* Colour */}
      <div className={rowCls}>
        <span className="flex-1">Colour</span>
        <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : teamColor} onChange={(e) => setColor(e.target.value)}
          style={{ width: 26, height: 26, padding: 0, border: "none", background: "none", cursor: "pointer" }} aria-label="Channel colour" />
        {color && <button type="button" onClick={() => setColor("")} className="text-[11px] text-slate-400 hover:text-slate-500">Reset</button>}
      </div>

      <label className={rowCls}>
        <input type="checkbox" checked={pinnedAll} onChange={(e) => setPinnedAll(e.target.checked)} />
        Pin to top for everyone
      </label>
      <label className={rowCls}>
        <input type="checkbox" checked={policy === "admins"} onChange={(e) => setPolicy(e.target.checked ? "admins" : "all")} />
        Announcement channel (only admins/leads can post)
      </label>
      <label className={rowCls}>
        <input type="checkbox" checked={allowImages} onChange={(e) => setAllowImages(e.target.checked)} />
        Allow image uploads
      </label>
      <label className={rowCls}>
        <input type="checkbox" checked={forceNotify} onChange={(e) => setForceNotify(e.target.checked)} />
        Force notifications (members can't mute)
      </label>

      {/* Retention */}
      <div className={rowCls}>
        <span className="flex-1">Auto-delete messages older than</span>
        <select value={retention} onChange={(e) => setRetention(Number(e.target.value))}
          className={`rounded-lg border px-2 py-1 text-xs ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)] text-slate-100" : "bg-white border-slate-200 text-slate-800"}`}>
          <option value={0}>Never</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365}>1 year</option>
        </select>
      </div>

      {/* Archive (not for room channels — those follow their room) */}
      {!isRoom && (
        <label className={`${rowCls} ${archived ? "text-amber-500" : ""}`}>
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Archive channel (hidden from everyone; admins can restore)
        </label>
      )}

      <div className="flex items-center justify-between pt-1">
        <span className={`text-[11px] ${dark ? "text-slate-500" : "text-slate-400"}`}>{roster.length} members</span>
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className="text-sm text-slate-400 py-2 sm:py-0">Cancel</button>
          <button type="button" onClick={save} disabled={busy} className="text-sm font-semibold text-[var(--color-accent)] py-2 sm:py-0">{busy ? "…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

// ── New message (DM / group / channel) ──
function NewMessage({ others, orgTeams, leadOrAdminTeamIds, onCancel, onStartDm, onCreateGroup, onCreateChannel, onBrowse, onJoin, dark }) {
  const [mode, setMode] = useState("people");
  const [picked, setPicked] = useState([]);
  const [title, setTitle] = useState("");
  const [chanTeam, setChanTeam] = useState("");
  const [chanName, setChanName] = useState("");
  const [visibility, setVisibility] = useState("org"); // 'org' = open · 'org_team' = locked
  const [announce, setAnnounce] = useState(false);     // admins-only posting
  const [q, setQ] = useState("");
  const [joinable, setJoinable] = useState(null); // null = loading
  const [joining, setJoining] = useState("");
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const creatableTeams = orgTeams.filter((t) => leadOrAdminTeamIds.has(t.id));
  const shown = others.filter((m) => (m.name || "").toLowerCase().includes(q.trim().toLowerCase()));
  const canCreateChannel = !!chanName.trim() && (visibility === "org" || !!chanTeam);

  useEffect(() => {
    if (mode !== "browse") return undefined;
    let cancelled = false;
    setJoinable(null);
    Promise.resolve(onBrowse?.()).then((list) => { if (!cancelled) setJoinable(list || []); });
    return () => { cancelled = true; };
  }, [mode, onBrowse]);

  const go = async () => {
    if (mode === "channel") {
      if (canCreateChannel) await onCreateChannel(visibility === "org" ? null : chanTeam, chanName.trim(), visibility, announce);
      return;
    }
    if (picked.length === 0) return;
    if (picked.length === 1) await onStartDm(picked[0]);
    else await onCreateGroup(title, picked);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className={`flex items-center justify-between px-4 h-14 shrink-0 border-b ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
        <button type="button" onClick={onCancel} className={`p-3 sm:p-1.5 -ml-1 rounded-lg ${dark ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"}`} aria-label="Cancel"><X className="w-5 h-5" /></button>
        <span className={`text-[15px] font-bold ${dark ? "text-slate-100" : "text-slate-800"}`}>{mode === "channel" ? "New channel" : mode === "browse" ? "Browse channels" : "New message"}</span>
        {mode === "browse" ? (
          <span className="w-10" />
        ) : (
          <button type="button" onClick={go} disabled={mode === "channel" ? !canCreateChannel : picked.length === 0} className="text-sm font-semibold text-[var(--color-accent)] disabled:opacity-40 py-2 sm:py-0">
            {mode === "channel" ? "Create" : picked.length > 1 ? "Create" : "Start"}
          </button>
        )}
      </div>

      <div className="flex gap-1.5 px-4 pt-3 shrink-0">
        {[["people", "People", null], ["channel", "Channel", Hash], ["browse", "Browse", Search]].map(([k, label, Icon]) => (
          <button key={k} type="button" onClick={() => setMode(k)} className={`px-3 h-11 sm:h-8 rounded-full text-[13px] font-semibold inline-flex items-center gap-1.5 ${mode === k ? "bg-[var(--color-accent)] text-white" : dark ? "bg-white/5 text-slate-300" : "bg-slate-100 text-slate-600"}`}>
            {Icon && <Icon className="w-3.5 h-3.5" />}{label}
          </button>
        ))}
      </div>

      {mode === "channel" ? (
        <div className="p-4 space-y-3">
          {/* Open (anyone in the org can join) vs Team-locked (a department's
              members only — needs lead/admin of that team). */}
          <div className="flex gap-1.5">
            {[["org", "Open to org"], ["org_team", "Team only"]].map(([v, label]) => {
              const disabled = v === "org_team" && creatableTeams.length === 0;
              return (
                <button key={v} type="button" disabled={disabled} onClick={() => setVisibility(v)}
                  className={`flex-1 px-3 h-11 sm:h-9 rounded-lg text-[13px] font-semibold border transition-colors disabled:opacity-40 ${
                    visibility === v ? "bg-[var(--color-accent)] text-white border-[var(--color-accent)]" : dark ? "border-[var(--color-border)] text-slate-300" : "border-slate-200 text-slate-600"
                  }`}>
                  {label}
                </button>
              );
            })}
          </div>
          {visibility === "org_team" && (
            <select value={chanTeam} onChange={(e) => setChanTeam(e.target.value)} className={`w-full rounded-lg border px-3 py-2.5 text-sm ${dark ? "bg-[var(--color-surface-raised)] border-[var(--color-border)] text-slate-100" : "bg-white border-slate-200 text-slate-800"}`}>
              <option value="">Choose a team…</option>
              {creatableTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <div className={`flex items-center rounded-lg border px-3 ${dark ? "bg-[var(--color-surface-raised)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}>
            {announce ? <Megaphone className="w-4 h-4 text-amber-500" /> : <Hash className="w-4 h-4 text-slate-400" />}
            <input value={chanName} onChange={(e) => setChanName(e.target.value.slice(0, 40))} placeholder="channel-name" className={`flex-1 bg-transparent px-2 py-2.5 text-sm outline-none ${dark ? "text-slate-100" : "text-slate-800"}`} />
          </div>
          {/* Announcement channel — only admins/leads can post; everyone else reads. */}
          <button type="button" onClick={() => setAnnounce((v) => !v)}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors ${announce ? (dark ? "border-amber-400/60 bg-amber-500/10" : "border-amber-400 bg-amber-50") : dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
            <Megaphone className={`w-4 h-4 shrink-0 ${announce ? "text-amber-500" : "text-slate-400"}`} />
            <span className="flex-1 min-w-0">
              <span className={`block text-[13px] font-semibold ${dark ? "text-slate-200" : "text-slate-700"}`}>Announcement channel</span>
              <span className={`block text-[11px] ${dark ? "text-slate-500" : "text-slate-400"}`}>Only admins can post; everyone else can read &amp; react.</span>
            </span>
            <span className={`shrink-0 w-9 h-5 rounded-full p-0.5 transition-colors ${announce ? "bg-amber-500" : dark ? "bg-white/15" : "bg-slate-300"}`}>
              <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${announce ? "translate-x-4" : ""}`} />
            </span>
          </button>
          <p className={`text-[11px] leading-snug ${dark ? "text-slate-500" : "text-slate-400"}`}>
            {visibility === "org" ? "Anyone in your org can find this channel under Browse and join it." : "Only members of the selected team will see this channel."}
          </p>
        </div>
      ) : mode === "browse" ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {joinable === null ? (
            <div className={`text-center text-sm py-10 ${dark ? "text-slate-500" : "text-slate-400"}`}>Loading…</div>
          ) : joinable.length === 0 ? (
            <div className={`text-center text-sm py-10 ${dark ? "text-slate-500" : "text-slate-400"}`}>No open channels to join.</div>
          ) : (
            joinable.map((c) => (
              <div key={c.id} className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-lg ${dark ? "hover:bg-white/5" : "hover:bg-slate-50"}`}>
                <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-[var(--color-accent-light)] text-[var(--color-accent)]"><Hash className="w-4 h-4" /></span>
                <span className="flex-1 min-w-0">
                  <span className={`block text-sm font-medium truncate ${dark ? "text-slate-200" : "text-slate-700"}`}>{c.title}</span>
                  <span className={`block text-[11px] ${dark ? "text-slate-500" : "text-slate-400"}`}>{c.member_count || 0} member{Number(c.member_count) === 1 ? "" : "s"}{c.topic ? ` · ${c.topic}` : ""}</span>
                </span>
                <button type="button" disabled={joining === c.id} onClick={async () => { setJoining(c.id); await onJoin?.(c.id); setJoining(""); }}
                  className="shrink-0 px-3 h-11 sm:h-8 rounded-full text-[13px] font-semibold text-white bg-[var(--color-accent)] disabled:opacity-50">
                  {joining === c.id ? "Joining…" : "Join"}
                </button>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          {picked.length > 1 && (
            <div className="px-4 pt-3 shrink-0">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Group name (optional)" className={`w-full rounded-lg border px-3 py-2.5 text-sm ${dark ? "bg-[var(--color-surface-raised)] border-[var(--color-border)] text-slate-100 placeholder:text-slate-500" : "bg-white border-slate-200 text-slate-800 placeholder:text-slate-400"}`} />
            </div>
          )}
          <div className="px-4 pt-3 shrink-0">
            <div className={`flex items-center gap-2 rounded-lg px-3 h-11 sm:h-9 ${dark ? "bg-[var(--color-surface-raised)]" : "bg-slate-100"}`}>
              <Search className="w-4 h-4 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" className={`flex-1 bg-transparent text-sm outline-none ${dark ? "text-slate-100 placeholder:text-slate-500" : "text-slate-800 placeholder:text-slate-400"}`} />
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            {shown.length === 0 && <div className={`text-center text-sm py-10 ${dark ? "text-slate-500" : "text-slate-400"}`}>No teammates found.</div>}
            {shown.map((m) => {
              const on = picked.includes(m.user_id);
              return (
                <button key={m.user_id} type="button" onClick={() => toggle(m.user_id)} className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition-colors ${on ? "bg-[var(--color-accent-light)]" : dark ? "hover:bg-white/5" : "hover:bg-slate-50"}`}>
                  <UserAvatar url={m.avatar_url || ""} name={m.name || "Member"} size={32} />
                  <span className={`flex-1 text-sm font-medium ${dark ? "text-slate-200" : "text-slate-700"}`}>{m.name || "Member"}</span>
                  <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${on ? "bg-[var(--color-accent)] border-[var(--color-accent)]" : dark ? "border-slate-600" : "border-slate-300"}`}>
                    {on && <span className="w-2 h-2 rounded-full bg-white" />}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Can the caller delete this conversation FOR EVERYONE? (matches the server gate
// in delete_conversation: channel → creator/admin/lead; group → creator; never a
// room channel or a DM.) Otherwise the row can only be hidden/left for yourself.
function canDeleteConversation(c, userId, isAdmin, myOrgTeamLeadIds) {
  if (c.room_id) return false;
  if (c.kind === "group") return c.created_by === userId;
  if (c.kind === "channel") return c.created_by === userId || isAdmin || (c.org_team_id && myOrgTeamLeadIds?.has(c.org_team_id));
  return false;
}

// ── sidebar conversation row ──
function Row({ c, nameOf, memberById, active, userId, isAdmin, myOrgTeamLeadIds, folders = [], canOrganize, onAssignFolder, canDrag, dragActive, onDragStartRow, onDragEndRow, isDragged, onReorderOver, onReorderDrop, lineBefore, lineAfter, compact, onOpen, onPin, onMute, onDelete, onHide, dark }) {
  const first = memberById.get(c.participant_ids[0]);
  const muted = !!c.muted_at;
  const unread = c.unread && !muted;
  const [menu, setMenu] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const menuRef = useRef(null);
  const canDelete = canDeleteConversation(c, userId, isAdmin, myOrgTeamLeadIds);
  const canMove = canOrganize && c.kind === "channel";
  const leaveLabel = c.kind === "dm" ? "Delete conversation" : c.room_id ? "Hide channel" : c.kind === "group" ? "Leave group" : "Leave channel";
  useEffect(() => {
    if (!menu) return undefined;
    const f = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) { setMenu(false); setConfirmDel(false); setMoveOpen(false); } };
    window.addEventListener("pointerdown", f, true);
    return () => window.removeEventListener("pointerdown", f, true);
  }, [menu]);
  const close = () => { setMenu(false); setConfirmDel(false); setMoveOpen(false); };

  return (
    <div
      draggable={canDrag}
      onDragStart={canDrag ? (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.id); onDragStartRow?.(c.id); } : undefined}
      onDragEnd={canDrag ? () => onDragEndRow?.() : undefined}
      onDragOver={canDrag && dragActive ? (e) => { e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onReorderOver?.(c.id, (e.clientY - r.top) < r.height / 2); } : undefined}
      onDrop={canDrag && dragActive ? (e) => { e.preventDefault(); e.stopPropagation(); onReorderDrop?.(); } : undefined}
      className={`group relative flex items-center mx-2 my-0.5 px-2.5 rounded-xl cursor-pointer transition-colors ${compact ? "gap-2 py-1" : "gap-2.5 py-2"} ${isDragged ? "opacity-40" : ""} ${
        active ? (dark ? "bg-white/10" : "bg-[var(--color-accent-light)]") : dark ? "hover:bg-white/5" : "hover:bg-slate-100"
      }`} onClick={() => onOpen(c.id)}>
      {lineBefore && <span className="pointer-events-none absolute left-3 right-3 -top-px h-0.5 rounded bg-[var(--color-accent)] z-10" />}
      {lineAfter && <span className="pointer-events-none absolute left-3 right-3 -bottom-px h-0.5 rounded bg-[var(--color-accent)] z-10" />}
      {c.kind === "channel" ? (
        <span className={`${compact ? "w-6 h-6" : "w-9 h-9"} rounded-full flex items-center justify-center shrink-0`} style={{ background: `${channelColor(c)}22`, color: channelColor(c) }}>{channelGlyph(c, compact ? "w-3.5 h-3.5" : "w-4 h-4")}</span>
      ) : c.kind === "group" ? (
        <span className={`${compact ? "w-6 h-6" : "w-9 h-9"} rounded-full flex items-center justify-center shrink-0 ${dark ? "bg-[var(--color-surface-raised)] text-slate-300" : "bg-slate-200 text-slate-600"}`}><Users className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} /></span>
      ) : (
        <UserAvatar url={first?.avatar_url || ""} name={first?.name || "Member"} size={compact ? 24 : 36} />
      )}
      <span className="flex-1 min-w-0">
        <span className={`flex items-center gap-1 truncate ${compact ? "text-[13px]" : "text-sm"} ${unread ? "font-bold" : "font-medium"} ${dark ? "text-slate-100" : "text-slate-800"}`}>
          {c.pinned_all ? <Pin className="w-3 h-3 text-[var(--color-accent)] shrink-0" aria-label="Pinned for everyone" /> : c.pinned_at ? <Pin className="w-3 h-3 opacity-50 shrink-0" /> : null}
          <span className="truncate">{nameOf(c)}</span>
        </span>
        {!compact && <span className={`block text-[11px] ${dark ? "text-slate-500" : "text-slate-400"}`}>{listStamp(c.last_message_at)}</span>}
      </span>
      {/* hover actions */}
      <div className={`absolute right-2 flex ${menu ? "" : "md:hidden md:group-hover:flex"} items-center gap-0.5`}>
        {c.kind !== "channel" && (
          <button type="button" onClick={(e) => { e.stopPropagation(); onPin(c); }} aria-label={c.pinned_at ? "Unpin" : "Pin"}
            className={`p-2.5 sm:p-1 rounded ${dark ? "text-slate-400 hover:bg-white/10 bg-[var(--color-surface)]" : "text-slate-400 hover:bg-slate-200 bg-white"}`}>{c.pinned_at ? <PinOff className="w-5 h-5 sm:w-3.5 sm:h-3.5" /> : <Pin className="w-5 h-5 sm:w-3.5 sm:h-3.5" />}</button>
        )}
        {!c.force_notify && (
          <button type="button" onClick={(e) => { e.stopPropagation(); onMute(c); }} aria-label={muted ? "Unmute" : "Mute"}
            className={`p-2.5 sm:p-1 rounded ${dark ? "text-slate-400 hover:bg-white/10 bg-[var(--color-surface)]" : "text-slate-400 hover:bg-slate-200 bg-white"}`}>{muted ? <BellOff className="w-5 h-5 sm:w-3.5 sm:h-3.5" /> : <Bell className="w-5 h-5 sm:w-3.5 sm:h-3.5" />}</button>
        )}
        <div className="relative" ref={menuRef}>
          <button type="button" onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); setConfirmDel(false); }} aria-label="More"
            className={`p-2.5 sm:p-1 rounded ${dark ? "text-slate-400 hover:bg-white/10 bg-[var(--color-surface)]" : "text-slate-400 hover:bg-slate-200 bg-white"}`}><MoreHorizontal className="w-5 h-5 sm:w-3.5 sm:h-3.5" /></button>
          {menu && (
            <div onClick={(e) => e.stopPropagation()}
              className={`absolute right-0 top-full mt-1 w-52 py-1 rounded-xl border shadow-xl z-30 ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}>
              {canMove && (
                <>
                  <button type="button" onClick={() => setMoveOpen((v) => !v)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 sm:py-1.5 text-[13px] ${dark ? "text-slate-300 hover:bg-white/5" : "text-slate-600 hover:bg-slate-50"}`}>
                    <FolderInput className="w-3.5 h-3.5" /> Move to folder
                  </button>
                  {moveOpen && (
                    <div className={`max-h-48 overflow-y-auto border-y my-1 ${dark ? "border-[var(--color-border)]" : "border-slate-100"}`}>
                      <button type="button" onClick={() => { close(); onAssignFolder(c, null); }}
                        className={`w-full text-left pl-8 pr-3 py-2.5 sm:py-1.5 text-[13px] ${!c.folder_id ? "text-[var(--color-accent)] font-semibold" : dark ? "text-slate-400 hover:bg-white/5" : "text-slate-500 hover:bg-slate-50"}`}>
                        No folder
                      </button>
                      {folders.map((f) => (
                        <button key={f.id} type="button" onClick={() => { close(); onAssignFolder(c, f.id); }}
                          className={`w-full text-left pl-8 pr-3 py-2.5 sm:py-1.5 text-[13px] truncate ${c.folder_id === f.id ? "text-[var(--color-accent)] font-semibold" : dark ? "text-slate-300 hover:bg-white/5" : "text-slate-600 hover:bg-slate-50"}`}>
                          {f.name}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              <button type="button" onClick={() => { close(); onHide(c); }}
                className={`w-full flex items-center gap-2 px-3 py-2.5 sm:py-1.5 text-[13px] ${dark ? "text-slate-300 hover:bg-white/5" : "text-slate-600 hover:bg-slate-50"}`}>
                <LogOut className="w-3.5 h-3.5" /> {leaveLabel}
              </button>
              {canDelete && (
                confirmDel ? (
                  <button type="button" onClick={() => { close(); onDelete(c); }}
                    className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-1.5 text-[13px] font-semibold text-white bg-rose-500 hover:bg-rose-600">
                    <Trash2 className="w-3.5 h-3.5" /> Delete for everyone?
                  </button>
                ) : (
                  <button type="button" onClick={() => setConfirmDel(true)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 sm:py-1.5 text-[13px] ${dark ? "text-rose-300 hover:bg-rose-500/10" : "text-rose-600 hover:bg-rose-50"}`}>
                    <Trash2 className="w-3.5 h-3.5" /> Delete {c.kind === "group" ? "group" : "channel"}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      </div>
      {unread && <span className="hidden md:block md:group-hover:hidden w-2.5 h-2.5 rounded-full bg-[var(--color-accent)] shrink-0" />}
    </div>
  );
}

// ── one shared channel folder in the sidebar (collapsible; admin rename/delete) ──
function FolderGroup({ folder, items, collapsed, onToggle, canOrganize, onRename, onDelete, dropActive, onDragOverFolder, onDropFolder,
  canDragFolder, folderDragActive, onFolderDragStart, onFolderDragEnd, isFolderDragged, onFolderReorderOver, onFolderReorderDrop, folderLineBefore, folderLineAfter, dark, children }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(folder.name);
  const [menu, setMenu] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => setName(folder.name), [folder.name]);
  useEffect(() => {
    if (!menu) return undefined;
    const f = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) { setMenu(false); setConfirmDel(false); } };
    window.addEventListener("pointerdown", f, true);
    return () => window.removeEventListener("pointerdown", f, true);
  }, [menu]);
  const commit = () => { const n = name.trim(); if (n && n !== folder.name) onRename(folder.id, n); setEditing(false); };
  return (
    <div
      onDragOver={onDragOverFolder}
      onDrop={onDropFolder}
      className={`relative mt-1 rounded-lg transition-colors ${isFolderDragged ? "opacity-40" : ""} ${dropActive ? `ring-2 ring-[var(--color-accent)] ${dark ? "bg-white/10" : "bg-[var(--color-accent-light)]"}` : ""}`}>
      {folderLineBefore && <span className="pointer-events-none absolute left-2 right-2 -top-px h-0.5 rounded bg-[var(--color-accent)] z-10" />}
      {folderLineAfter && <span className="pointer-events-none absolute left-2 right-2 -bottom-px h-0.5 rounded bg-[var(--color-accent)] z-10" />}
      <div
        draggable={canDragFolder && !editing}
        onDragStart={canDragFolder && !editing ? (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", `folder:${folder.id}`); onFolderDragStart?.(folder.id); } : undefined}
        onDragEnd={canDragFolder ? () => onFolderDragEnd?.() : undefined}
        onDragOver={folderDragActive ? (e) => { e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onFolderReorderOver?.(folder.id, (e.clientY - r.top) < r.height / 2); } : undefined}
        onDrop={folderDragActive ? (e) => { e.preventDefault(); e.stopPropagation(); onFolderReorderDrop?.(); } : undefined}
        className={`group/f flex items-center gap-1 pl-2 pr-3 pt-2 pb-0.5 ${canDragFolder && !editing ? "cursor-grab active:cursor-grabbing" : ""}`}>
        <button type="button" onClick={onToggle} className="p-2 sm:p-0.5 text-slate-400 hover:text-slate-500" aria-label={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? <ChevronRight className="w-4 h-4 sm:w-3.5 sm:h-3.5" /> : <ChevronDown className="w-4 h-4 sm:w-3.5 sm:h-3.5" />}
        </button>
        <Folder className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        {editing ? (
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") { setName(folder.name); setEditing(false); } }}
            className={`flex-1 min-w-0 bg-transparent text-[12px] font-semibold outline-none border-b ${dark ? "text-slate-200 border-slate-600" : "text-slate-700 border-slate-300"}`} />
        ) : (
          <span className={`flex-1 min-w-0 text-[11px] font-semibold uppercase tracking-wide truncate ${dark ? "text-slate-400" : "text-slate-500"}`}>{folder.name}</span>
        )}
        <span className="text-[10px] text-slate-400 shrink-0">{items.length}</span>
        {canOrganize && !editing && (
          <div className="relative shrink-0" ref={menuRef}>
            <button type="button" onClick={() => { setMenu((m) => !m); setConfirmDel(false); }} aria-label="Folder options"
              className="opacity-100 md:opacity-0 md:group-hover/f:opacity-100 p-2 sm:p-0.5 text-slate-400 hover:text-slate-500"><MoreHorizontal className="w-5 h-5 sm:w-3.5 sm:h-3.5" /></button>
            {menu && (
              <div className={`absolute right-0 top-full mt-1 w-40 py-1 rounded-xl border shadow-xl z-30 ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"}`}>
                <button type="button" onClick={() => { setMenu(false); setEditing(true); }}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 sm:py-1.5 text-[13px] ${dark ? "text-slate-300 hover:bg-white/5" : "text-slate-600 hover:bg-slate-50"}`}><Pencil className="w-3.5 h-3.5" /> Rename</button>
                {confirmDel ? (
                  <button type="button" onClick={() => { setMenu(false); setConfirmDel(false); onDelete(folder.id); }}
                    className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-1.5 text-[13px] font-semibold text-white bg-rose-500 hover:bg-rose-600"><Trash2 className="w-3.5 h-3.5" /> Delete folder?</button>
                ) : (
                  <button type="button" onClick={() => setConfirmDel(true)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 sm:py-1.5 text-[13px] ${dark ? "text-rose-300 hover:bg-rose-500/10" : "text-rose-600 hover:bg-rose-50"}`}><Trash2 className="w-3.5 h-3.5" /> Delete folder</button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {!collapsed && (items.length ? children : (
        <div className={`pl-8 pr-3 py-1 text-[11px] italic ${dark ? "text-slate-600" : "text-slate-400"}`}>Empty — move channels here</div>
      ))}
    </div>
  );
}

// ── sidebar (sectioned list, channels grouped into shared folders) ──
function Sidebar({ conversations, nameOf, memberById, activeId, userId, isAdmin, myOrgTeamLeadIds, folders = [], canOrganize, onCreateFolder, onRenameFolder, onDeleteFolder, onAssignFolder, onPlaceChannel, onReorderFolders, onOpen, onNew, onPin, onMute, onDelete, onHide, dark }) {
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [newFolder, setNewFolder] = useState(null); // draft name string while creating, else null
  const [dragId, setDragId] = useState(null);        // channel being dragged (admins only)
  const [dropTarget, setDropTarget] = useState(undefined); // folder id | "__none__" — empty-area folder assign
  const [dropAt, setDropAt] = useState(null);        // { rowId, before } — the channel reorder insertion line
  const [dragFolderId, setDragFolderId] = useState(null);  // folder header being dragged
  const [folderDropAt, setFolderDropAt] = useState(null);  // { folderId, before } — folder reorder line
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem("msg_compact") === "1"; } catch { return false; } });
  const toggleCompact = () => setCompact((v) => { const n = !v; try { localStorage.setItem("msg_compact", n ? "1" : "0"); } catch { /* */ } return n; });
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = needle ? conversations.filter((c) => nameOf(c).toLowerCase().includes(needle)) : conversations;
    return [...list].sort((a, b) => (b.pinned_at ? 1 : 0) - (a.pinned_at ? 1 : 0));
  }, [conversations, q, nameOf]);

  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);
  // Inside a group: pin-for-everyone floats to the top, then manual
  // folder_position, then recency (so un-reordered channels keep their old order).
  const byPos = (a, b) => ((b.pinned_all ? 1 : 0) - (a.pinned_all ? 1 : 0)) || (a.folder_position - b.folder_position) || (new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0));
  const channels = filtered.filter((c) => c.kind === "channel" && !c.archived_at);
  // Archived channels only reach admins (server-side); shown in their own section.
  const archived = filtered.filter((c) => c.kind === "channel" && c.archived_at);
  const groupKeyOf = (c) => (c.folder_id && folderIds.has(c.folder_id) ? c.folder_id : "__none__");
  const groupChannels = (key) => channels.filter((c) => groupKeyOf(c) === key).sort(byPos);
  const ungrouped = groupChannels("__none__");
  const groups = filtered.filter((c) => c.kind === "group");
  const dms = filtered.filter((c) => c.kind === "dm" || (!c.kind && !c.is_group));

  const toggle = (id) => setCollapsed((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Drop on a folder's EMPTY area (or the "No folder" zone) → just re-file (append).
  const overZone = (t) => (e) => { if (dragId == null) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDropAt(null); if (dropTarget !== t) setDropTarget(t); };
  const dropZone = (t) => (e) => {
    e.preventDefault();
    const id = dragId || e.dataTransfer.getData("text/plain");
    const folderId = t === "__none__" ? null : t;
    const cur = channels.find((c) => c.id === id);
    if (id && cur && (cur.folder_id || null) !== folderId) onAssignFolder({ id }, folderId);
    setDragId(null); setDropTarget(undefined); setDropAt(null);
  };

  // Drop ONTO a row → insert at that spot: reorder within the group, or move to
  // that row's folder at that position.
  const onReorderOver = (rowId, before) => { if (rowId === dragId) { setDropAt(null); return; } setDropTarget(undefined); setDropAt({ rowId, before }); };
  const onReorderDrop = () => {
    const at = dropAt, id = dragId;
    setDragId(null); setDropAt(null); setDropTarget(undefined);
    if (id == null || !at) return;
    const target = channels.find((c) => c.id === at.rowId); if (!target) return;
    const key = groupKeyOf(target);
    const ids = groupChannels(key).map((c) => c.id).filter((x) => x !== id);
    let idx = ids.indexOf(at.rowId); if (idx < 0) idx = ids.length;
    if (!at.before) idx += 1;
    ids.splice(idx, 0, id);
    onPlaceChannel(id, key === "__none__" ? null : key, ids);
  };

  // Drag a folder HEADER over another folder to reorder the folder list itself.
  const onFolderReorderOver = (folderId, before) => { if (folderId === dragFolderId) { setFolderDropAt(null); return; } setFolderDropAt({ folderId, before }); };
  const onFolderReorderDrop = () => {
    const at = folderDropAt, id = dragFolderId;
    setDragFolderId(null); setFolderDropAt(null);
    if (id == null || !at || at.folderId === id) return;
    const ids = folders.map((f) => f.id).filter((x) => x !== id);
    let idx = ids.indexOf(at.folderId); if (idx < 0) idx = ids.length;
    if (!at.before) idx += 1;
    ids.splice(idx, 0, id);
    onReorderFolders?.(ids);
  };

  const rowOf = (c) => (
    <Row key={c.id} c={c} nameOf={nameOf} memberById={memberById} active={c.id === activeId}
      userId={userId} isAdmin={isAdmin} myOrgTeamLeadIds={myOrgTeamLeadIds}
      folders={folders} canOrganize={canOrganize} onAssignFolder={onAssignFolder}
      canDrag={canOrganize && c.kind === "channel"} dragActive={dragId != null}
      onDragStartRow={setDragId} onDragEndRow={() => { setDragId(null); setDropTarget(undefined); setDropAt(null); }} isDragged={dragId === c.id}
      onReorderOver={onReorderOver} onReorderDrop={onReorderDrop}
      lineBefore={dropAt?.rowId === c.id && dropAt.before} lineAfter={dropAt?.rowId === c.id && !dropAt.before}
      compact={compact}
      onOpen={onOpen} onPin={onPin} onMute={onMute} onDelete={onDelete} onHide={onHide} dark={dark} />
  );
  const commitNewFolder = () => { const n = (newFolder || "").trim(); if (n) onCreateFolder(n); setNewFolder(null); };
  const sectionLabel = (t) => `px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide ${dark ? "text-slate-500" : "text-slate-400"}`;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className={`flex items-center justify-between px-4 h-14 shrink-0 border-b ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
        <span className={`text-lg font-bold ${dark ? "text-slate-100" : "text-slate-800"}`}>Messages</span>
        <div className="flex items-center gap-1">
          <button type="button" onClick={toggleCompact} title={compact ? "Comfortable list" : "Compact list"} aria-label="Toggle list density"
            className={`w-11 h-11 sm:w-8 sm:h-8 rounded-full inline-flex items-center justify-center ${compact ? "text-[var(--color-accent)]" : dark ? "text-slate-400 hover:bg-white/10" : "text-slate-400 hover:bg-slate-100"}`}>
            {compact ? <Rows3 className="w-5 h-5 sm:w-4 sm:h-4" /> : <Rows2 className="w-5 h-5 sm:w-4 sm:h-4" />}
          </button>
          <button type="button" onClick={onNew} aria-label="New message" className="inline-flex items-center gap-1.5 pl-2.5 pr-3 h-11 sm:h-8 rounded-full bg-[var(--color-accent)] text-white text-[13px] font-semibold hover:opacity-90">
            <Plus className="w-4 h-4" /> New
          </button>
        </div>
      </div>
      <div className="px-3 py-2.5 shrink-0">
        <div className={`flex items-center gap-2 rounded-lg px-3 h-11 sm:h-9 ${dark ? "bg-[var(--color-surface-raised)]" : "bg-slate-100"}`}>
          <Search className="w-4 h-4 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" className={`flex-1 bg-transparent text-sm outline-none ${dark ? "text-slate-100 placeholder:text-slate-500" : "text-slate-800 placeholder:text-slate-400"}`} />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto pb-3">
        {filtered.length === 0 && (
          <div className={`flex flex-col items-center justify-center gap-2 py-16 text-center ${dark ? "text-slate-500" : "text-slate-400"}`}>
            <MessageSquare className="w-7 h-7 opacity-60" />
            <p className="text-sm">{q ? "No matches." : "No conversations yet."}</p>
            {!q && <button type="button" onClick={onNew} className="text-[var(--color-accent)] text-sm font-semibold">Start one</button>}
          </div>
        )}

        {/* Channels — grouped into shared folders, then anything ungrouped */}
        {(channels.length > 0 || (canOrganize && folders.length > 0)) && (
          <div className="mt-1">
            <div className="flex items-center justify-between pr-2">
              <div className={sectionLabel()}>Channels</div>
              {canOrganize && (
                <button type="button" onClick={() => setNewFolder("")} title="New folder" aria-label="New folder"
                  className={`p-2.5 sm:p-1 rounded ${dark ? "text-slate-400 hover:bg-white/10" : "text-slate-400 hover:bg-slate-100"}`}><FolderPlus className="w-5 h-5 sm:w-4 sm:h-4" /></button>
              )}
            </div>
            {newFolder !== null && (
              <div className="flex items-center gap-1 pl-3 pr-3 pb-1">
                <Folder className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <input autoFocus value={newFolder} onChange={(e) => setNewFolder(e.target.value)} onBlur={commitNewFolder}
                  onKeyDown={(e) => { if (e.key === "Enter") commitNewFolder(); else if (e.key === "Escape") setNewFolder(null); }}
                  placeholder="Folder name" className={`flex-1 min-w-0 bg-transparent text-[12px] font-semibold outline-none border-b ${dark ? "text-slate-200 border-slate-600 placeholder:text-slate-500" : "text-slate-700 border-slate-300 placeholder:text-slate-400"}`} />
              </div>
            )}
            {folders.map((f) => {
              const items = groupChannels(f.id);
              if (!items.length && !canOrganize) return null;
              return (
                <FolderGroup key={f.id} folder={f} items={items} collapsed={collapsed.has(f.id)} onToggle={() => toggle(f.id)}
                  canOrganize={canOrganize} onRename={onRenameFolder} onDelete={onDeleteFolder}
                  dropActive={dropTarget === f.id} onDragOverFolder={overZone(f.id)} onDropFolder={dropZone(f.id)}
                  canDragFolder={canOrganize && folders.length > 1} folderDragActive={dragFolderId != null}
                  onFolderDragStart={setDragFolderId} onFolderDragEnd={() => { setDragFolderId(null); setFolderDropAt(null); }} isFolderDragged={dragFolderId === f.id}
                  onFolderReorderOver={onFolderReorderOver} onFolderReorderDrop={onFolderReorderDrop}
                  folderLineBefore={folderDropAt?.folderId === f.id && folderDropAt.before} folderLineAfter={folderDropAt?.folderId === f.id && !folderDropAt.before}
                  dark={dark}>
                  {items.map(rowOf)}
                </FolderGroup>
              );
            })}
            {/* Ungrouped channels + the "move out of a folder" drop zone. Always a
                drop target while dragging (even when empty) so a channel can be
                pulled back out of every folder. */}
            {(ungrouped.length > 0 || (dragId != null && folders.length > 0)) && (
              <div onDragOver={overZone("__none__")} onDrop={dropZone("__none__")}
                className={`mt-0.5 rounded-lg transition-colors ${dropTarget === "__none__" ? `ring-2 ring-[var(--color-accent)] ${dark ? "bg-white/10" : "bg-[var(--color-accent-light)]"}` : ""}`}>
                {folders.length > 0 && <div className={`pl-3 pr-3 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide ${dark ? "text-slate-600" : "text-slate-400"}`}>Ungrouped</div>}
                {ungrouped.map(rowOf)}
                {dragId != null && ungrouped.length === 0 && folders.length > 0 && (
                  <div className={`mx-2 my-1 px-2.5 py-3 rounded-lg border border-dashed text-center text-[11px] ${dark ? "border-slate-600 text-slate-500" : "border-slate-300 text-slate-400"}`}>Drop here to remove from folder</div>
                )}
              </div>
            )}
          </div>
        )}

        {groups.length > 0 && (
          <div className="mt-1">
            <div className={sectionLabel()}>Group chats</div>
            {groups.map(rowOf)}
          </div>
        )}
        {dms.length > 0 && (
          <div className="mt-1">
            <div className={sectionLabel()}>Direct messages</div>
            {dms.map(rowOf)}
          </div>
        )}
        {archived.length > 0 && (
          <div className="mt-1">
            <button type="button" onClick={() => toggle("__archived__")} className={`${sectionLabel()} flex items-center gap-1 w-full`}>
              {collapsed.has("__archived__") ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />} Archived
            </button>
            {!collapsed.has("__archived__") && archived.map((c) => <div key={c.id} className="opacity-60">{rowOf(c)}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyPane({ dark, onNew }) {
  return (
    <div className={`flex flex-col items-center justify-center h-full gap-3 text-center px-6 ${dark ? "text-slate-500" : "text-slate-400"}`}>
      <div className={`w-16 h-16 rounded-2xl flex items-center justify-center ${dark ? "bg-white/5" : "bg-slate-100"}`}><MessageSquare className="w-8 h-8 opacity-70" /></div>
      <p className="text-base font-semibold">Your messages</p>
      <p className="text-sm max-w-xs">Pick a conversation from the list, or start a new direct message or channel.</p>
      <button type="button" onClick={onNew} className="mt-1 inline-flex items-center gap-1.5 px-4 h-9 rounded-full bg-[var(--color-accent)] text-white text-sm font-semibold"><Plus className="w-4 h-4" /> New message</button>
    </div>
  );
}

function LoadingPane({ dark }) {
  return (
    <div className={`flex flex-col items-center justify-center h-full gap-3 text-center px-6 ${dark ? "text-slate-500" : "text-slate-400"}`}>
      <span className="w-7 h-7 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
      <p className="text-sm font-semibold">Loading conversation…</p>
    </div>
  );
}

export default function MessagesPage() {
  useBodyScrollLock();
  const { session } = useApp();
  const userId = session?.user?.id;
  const { teamMembers = [], orgTeams = [], myOrgTeamLeadIds = new Set(), isAdmin } = useTeam();
  const { conversations = [], activeConversations = [], startDm, createGroup, createChannel, browseChannels, joinOpenChannel, deleteConversation, hideConversation, folders = [], isTeamAdmin, createFolder, renameFolder, deleteFolder, assignFolder, placeChannelAt, reorderFolders, markRead, subscribeMessages, subscribeReactions, reload } = useMessages();
  const { theme } = useTheme();
  const dark = theme === "dark";
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const activeId = params.get("c") || null;
  const [composing, setComposing] = useState(false);
  const [loadingActiveId, setLoadingActiveId] = useState(null);

  const memberById = useMemo(() => new Map(teamMembers.map((m) => [m.user_id, m])), [teamMembers]);
  const others = useMemo(() => teamMembers.filter((m) => m.user_id !== userId), [teamMembers, userId]);
  const leadOrAdminTeamIds = useMemo(() => (isAdmin ? new Set(orgTeams.map((t) => t.id)) : myOrgTeamLeadIds), [isAdmin, orgTeams, myOrgTeamLeadIds]);

  const nameOf = (c) => conversationName(c, memberById);

  const open = (id) => { setComposing(false); setParams(id ? { c: id } : {}, { replace: true }); };
  const active = activeConversations.find((c) => c.id === activeId) || conversations.find((c) => c.id === activeId) || null;
  useEffect(() => {
    if (!activeId || active) { setLoadingActiveId(null); return undefined; }
    let alive = true;
    setLoadingActiveId(activeId);
    Promise.resolve(reload?.()).catch(() => {}).finally(() => { if (alive) setLoadingActiveId(null); });
    return () => { alive = false; };
  }, [activeId, active, reload]);
  const loadingActive = !!activeId && !active && loadingActiveId === activeId;
  const showMain = composing || !!active || loadingActive;

  const onPin = async (c) => { await setConversationPinned(c.id, userId, !c.pinned_at, c.kind); reload?.(); };
  const onMute = async (c) => { await setConversationMuted(c.id, userId, !c.muted_at, c.kind); reload?.(); };
  const onDelete = async (c) => { if (activeId === c.id) open(null); await deleteConversation?.(c.id); };
  const onHide = async (c) => { if (activeId === c.id) open(null); await hideConversation?.(c.id); };

  return (
    <div className={`mx-auto w-full max-w-6xl h-[calc(100dvh-var(--nav-h)-var(--top-inset)-var(--bottom-inset))] sm:h-[calc(100dvh-var(--nav-h)-var(--top-inset)-var(--bottom-inset)-1.5rem)] sm:my-3 flex overflow-hidden rounded-none sm:rounded-2xl sm:border ${dark ? "bg-[var(--color-surface)] sm:border-[var(--color-border)]" : "bg-white sm:border-slate-200"}`}>
      {/* Sidebar — full width on mobile when nothing open; fixed column on desktop */}
      <aside className={`${showMain ? "hidden md:flex" : "flex"} w-full md:w-[340px] md:shrink-0 flex-col md:border-r ${dark ? "md:border-[var(--color-border)]" : "md:border-slate-200"}`}>
        <Sidebar conversations={activeConversations} nameOf={nameOf} memberById={memberById} activeId={activeId} userId={userId} isAdmin={isAdmin} myOrgTeamLeadIds={myOrgTeamLeadIds}
          folders={folders} canOrganize={isTeamAdmin} onCreateFolder={createFolder} onRenameFolder={renameFolder} onDeleteFolder={deleteFolder} onAssignFolder={(c, fid) => assignFolder(c.id, fid)} onPlaceChannel={placeChannelAt} onReorderFolders={reorderFolders}
          onOpen={open} onNew={() => setComposing(true)} onPin={onPin} onMute={onMute} onDelete={onDelete} onHide={onHide} dark={dark} />
      </aside>

      {/* Main pane */}
      <main className={`${showMain ? "flex" : "hidden md:flex"} flex-1 min-w-0 flex-col`}>
        {composing ? (
          <NewMessage
            others={others} orgTeams={orgTeams} leadOrAdminTeamIds={leadOrAdminTeamIds}
            onCancel={() => setComposing(false)}
            onStartDm={async (id) => { const cid = await startDm(id); if (cid) open(cid); else setComposing(false); }}
            onCreateGroup={async (title, ids) => { const cid = await createGroup(title, ids); if (cid) open(cid); else setComposing(false); }}
            onCreateChannel={async (teamId, name, visibility, announcement) => { const cid = await createChannel(teamId, name, visibility, announcement); if (cid) open(cid); else setComposing(false); }}
            onBrowse={browseChannels}
            onJoin={async (id) => { const ok = await joinOpenChannel(id); if (ok) open(id); }}
            dark={dark}
          />
        ) : active ? (
          <Thread
            key={active.id}
            conversation={active} name={nameOf(active)} memberById={memberById} candidates={others}
            userId={userId} isAdmin={isAdmin} myOrgTeamLeadIds={myOrgTeamLeadIds}
            onBack={() => open(null)} onOpenRoom={active.room_id ? () => navigate(`/office/r/${active.room_id}`) : undefined} markRead={markRead}
            subscribeMessages={subscribeMessages} subscribeReactions={subscribeReactions} onChannelMetaSaved={reload} dark={dark}
          />
        ) : loadingActive ? (
          <LoadingPane dark={dark} />
        ) : (
          <EmptyPane dark={dark} onNew={() => setComposing(true)} />
        )}
      </main>
    </div>
  );
}
