import { useEffect, useState } from "react";
import { useTheme } from "../context/ThemeContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Check, Trash2, Clock, Lock, Globe, Eraser, Pin, PenLine, Home, MessageSquare } from "lucide-react";
import {
  renameRoomV2, setRoomColor, updateRoomGating, archiveRoomV2,
  setRoomMaxDuration, setRoomEntryPolicy, setRoomAccessCode, getRoomAccessCode,
  setRoomPinPolicy, setRoomKnockEnabled, setRoomWhiteboardLock, setRoomKind,
} from "../lib/rooms";
import { clearRoomChat } from "../lib/chatMessages";

const DURATION_PRESETS = [
  { value: 15, label: "15m" },
  { value: 30, label: "30m" },
  { value: 45, label: "45m" },
  { value: 60, label: "1h" },
  { value: 90, label: "1.5h" },
  { value: 120, label: "2h" },
  { value: null, label: "No limit" },
];

const ROOM_COLORS = [
  "#14b8a6", "#0ea5e9", "#6366f1", "#8b5cf6", "#ec4899",
  "#f43f5e", "#f59e0b", "#84cc16", "#10b981", "#64748b",
];

// Room types, mirroring CreateRoomModal. 'general' is org-wide and admin-only;
// 'meeting' rooms can auto-close after a max duration; 'private' rooms lock
// behind a shareable code once occupied.
const KIND_OPTIONS = [
  { key: "general", label: "General", Icon: Home, adminsOnly: true,
    hint: "Long-lived shared room anyone in the org can drop into." },
  { key: "meeting", label: "Meeting", Icon: MessageSquare, adminsOnly: false,
    hint: "Time-boxed room that can auto-close after a max duration." },
  { key: "private", label: "Private", Icon: Lock, adminsOnly: false,
    hint: "Locks behind a shareable code once someone's inside." },
];

// Combined edit modal for a room. Replaces the inline rename + the
// separate RoomGatingModal — admins/leads change everything from one
// screen. Each section saves independently so a partial failure doesn't
// nuke the rest of the form.
export default function RoomSettingsModal({
  open, onClose, room, orgTeams, isAdmin, myOrgTeamLeadIds, onSaved, onError, onDeleted,
}) {
  const { theme } = useTheme();
  const dark = theme === "dark";

  const [name, setName] = useState("");
  const [kind, setKind] = useState("meeting");
  const [color, setColor] = useState("#14b8a6");
  const [selectedTeamIds, setSelectedTeamIds] = useState([]);
  const [maxDuration, setMaxDuration] = useState(null);   // minutes, or null
  const [customDuration, setCustomDuration] = useState(""); // text in custom input
  const [showCustomDuration, setShowCustomDuration] = useState(false);
  const [entryPolicy, setEntryPolicy] = useState("open");  // 'open' | 'code'
  const [accessCode, setAccessCode] = useState("");        // editable PIN
  const [currentCode, setCurrentCode] = useState("");      // loaded PIN, for diffing
  const [pinPolicy, setPinPolicy] = useState("admins");    // who can pin for everyone
  const [knockEnabled, setKnockEnabled] = useState(true);  // accept knocks while occupied
  const [whiteboardLocked, setWhiteboardLocked] = useState(false); // lock board to managers
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState({ name: false, kind: false, color: false, gating: false, duration: false, access: false, pin: false, whiteboard: false });
  // Two-step delete: clicking the trash icon flips this to true and the
  // footer swaps in a Confirm / Cancel pair. Avoids needing a separate
  // modal layer for a single destructive action.
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Two-step "clear chat", same pattern as delete (a destructive action that
  // soft-deletes every message in the room).
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!open || !room) return;
    setName(room.name || "");
    setKind(room.kind || "meeting");
    setColor(room.color || "#14b8a6");
    setSelectedTeamIds((room.room_teams || []).map((rt) => rt.org_team_id));
    const current = room.max_duration_minutes ?? null;
    setMaxDuration(current);
    // Show the custom input if the existing value isn't a preset.
    const presetValues = DURATION_PRESETS.map((p) => p.value);
    setShowCustomDuration(current != null && !presetValues.includes(current));
    setCustomDuration(current != null && !presetValues.includes(current) ? String(current) : "");
    setEntryPolicy(room.entry_policy || "open");
    setPinPolicy(room.pin_policy || "admins");
    setKnockEnabled(room.knock_enabled !== false);
    setWhiteboardLocked(room.whiteboard_locked === true);
    setAccessCode("");
    setCurrentCode("");
    setDirty({ name: false, color: false, gating: false, duration: false, access: false, pin: false, whiteboard: false });
    setConfirmDelete(false);
    setConfirmClear(false);
    setBusy(false);
    // Fetch the current PIN (room_secrets RLS returns it only to managers).
    let cancelled = false;
    getRoomAccessCode(room.id).then(({ data }) => {
      if (cancelled) return;
      setCurrentCode(data || "");
      setAccessCode(data || "");
    });
    return () => { cancelled = true; };
  }, [open, room]);

  async function handleDelete() {
    if (!room?.id) return;
    setBusy(true);
    const { error } = await archiveRoomV2(room.id);
    setBusy(false);
    if (error) {
      onError?.(error.message || "Could not delete room");
      setConfirmDelete(false);
      return;
    }
    onDeleted?.(room.name || "Room");
    onClose?.();
  }

  async function handleClearChat() {
    if (!room?.id) return;
    setBusy(true);
    const { error } = await clearRoomChat(room.id);
    setBusy(false);
    setConfirmClear(false);
    if (error) { onError?.(error.message || "Could not clear chat"); return; }
    // Soft-deletes propagate via realtime — the chat empties on every client.
    onSaved?.("Chat cleared");
  }

  if (!open || !room) return null;

  const eligibleGatingTeams = isAdmin
    ? orgTeams
    : (orgTeams || []).filter((t) => myOrgTeamLeadIds?.has(t.id) || selectedTeamIds.includes(t.id));

  function toggleTeam(id) {
    setSelectedTeamIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
    setDirty((d) => ({ ...d, gating: true }));
  }

  async function handleSave() {
    setBusy(true);
    const errs = [];

    // Type first, awaited on its own: it rewrites coupled columns server-side
    // (clears a non-meeting room's max duration, seeds a private room's code),
    // so the parallel saves below run against the settled row. Bail if it
    // fails — the rest of the form assumes the new type took.
    if (dirty.kind && kind !== room.kind) {
      const { error } = await setRoomKind(room.id, kind);
      if (error) {
        setBusy(false);
        onError?.(error.message || "Could not change room type");
        return;
      }
    }

    // Run the remaining saves in parallel so the modal closes quickly.
    const tasks = [];
    if (dirty.name && name.trim() && name.trim() !== room.name) {
      tasks.push(renameRoomV2(room.id, name.trim()).then((r) => r.error && errs.push(r.error)));
    }
    if (dirty.color && color !== room.color) {
      tasks.push(setRoomColor(room.id, color).then((r) => r.error && errs.push(r.error)));
    }
    if (dirty.gating) {
      tasks.push(updateRoomGating(room.id, selectedTeamIds).then((r) => r.error && errs.push(r.error)));
    }
    if (dirty.duration && kind === "meeting") {
      const next = showCustomDuration
        ? (customDuration.trim() === "" ? null : Math.max(1, parseInt(customDuration, 10) || 0))
        : maxDuration;
      tasks.push(setRoomMaxDuration(room.id, next).then((r) => r.error && errs.push(r.error)));
    }
    if (dirty.access) {
      // Persist policy + code sequentially: set the policy first, then the
      // code. Run as one task so it doesn't race the others.
      tasks.push((async () => {
        if (entryPolicy !== (room.entry_policy || "open")) {
          const r = await setRoomEntryPolicy(room.id, entryPolicy);
          if (r.error) { errs.push(r.error); return; }
        }
        const cleanCode = accessCode.trim().toUpperCase();
        if (entryPolicy === "code" && cleanCode && cleanCode !== (currentCode || "").toUpperCase()) {
          const r = await setRoomAccessCode(room.id, cleanCode);
          if (r.error) errs.push(r.error);
        }
        if ((room.knock_enabled !== false) !== knockEnabled) {
          const r = await setRoomKnockEnabled(room.id, knockEnabled);
          if (r.error) errs.push(r.error);
        }
      })());
    }
    if (dirty.pin && pinPolicy !== (room.pin_policy || "admins")) {
      tasks.push(setRoomPinPolicy(room.id, pinPolicy).then((r) => r.error && errs.push(r.error)));
    }
    if (dirty.whiteboard && whiteboardLocked !== (room.whiteboard_locked === true)) {
      tasks.push(setRoomWhiteboardLock(room.id, whiteboardLocked).then((r) => r.error && errs.push(r.error)));
    }
    await Promise.all(tasks);
    setBusy(false);
    if (errs.length > 0) {
      onError?.(errs[0].message || "Could not save");
      return;
    }
    onSaved?.("Room updated");
  }

  function pickDurationPreset(value) {
    setMaxDuration(value);
    setShowCustomDuration(false);
    setCustomDuration("");
    setDirty((d) => ({ ...d, duration: true }));
  }
  function pickCustomDuration() {
    setShowCustomDuration(true);
    setMaxDuration(null);
    setDirty((d) => ({ ...d, duration: true }));
  }
  function onCustomDurationChange(v) {
    // Strip non-digits; clamp to int. Empty string = "no limit" (null on save).
    const clean = v.replace(/\D/g, "").slice(0, 4);
    setCustomDuration(clean);
    setDirty((d) => ({ ...d, duration: true }));
  }

  // Cap the card at the viewport (dvh accounts for mobile browser chrome) and
  // let the body scroll — the form has grown tall enough to overflow small
  // screens. Header + footer stay pinned outside the scroll area.
  const cardCls = `relative w-full max-w-md rounded-2xl border flex flex-col overflow-hidden max-h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-2rem)] ${
    dark ? "bg-[var(--color-surface)] border-[var(--color-border)] shadow-2xl shadow-black/40" : "bg-white border-slate-200 shadow-xl"
  }`;
  const labelCls = `text-[10px] font-semibold uppercase tracking-wider ${dark ? "text-slate-400" : "text-slate-500"}`;
  const inputCls = dark ? "bg-[var(--color-surface-raised)] border-[var(--color-border)] text-slate-100" : "";

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-3 sm:p-4" onClick={onClose}>
      <div className={cardCls} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={`absolute top-3 right-3 p-1.5 rounded-lg ${
            dark ? "hover:bg-[var(--color-surface-raised)] text-slate-400" : "hover:bg-slate-100 text-slate-500"
          }`}
        >
          <X className="w-4 h-4" />
        </button>

        <h2 className={`text-lg font-bold flex items-center gap-2 px-5 sm:px-6 pt-5 sm:pt-6 pb-4 shrink-0 ${dark ? "text-slate-100" : "text-slate-800"}`}>
          <span
            className="w-3 h-3 rounded-md border border-black/10"
            style={{ background: color }}
          />
          Room settings
        </h2>

        {/* Scrollable body — everything between the pinned header and footer. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6">

        {/* Name */}
        <div className="mb-4">
          <label className={labelCls}>Name</label>
          <Input
            value={name}
            onChange={(e) => { setName(e.target.value.slice(0, 40)); setDirty((d) => ({ ...d, name: true })); }}
            className={`mt-1 ${inputCls}`}
            autoFocus
          />
        </div>

        {/* Type — general / meeting / private. Changing it rewrites coupled
            server-side state (a non-meeting room loses its duration; a private
            room gets a shareable code). General is org-wide, so only admins may
            promote a room to it. */}
        <div className="mb-4">
          <label className={labelCls}>Type</label>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {KIND_OPTIONS.map(({ key, label, Icon, adminsOnly }) => {
              const active = kind === key;
              const locked = adminsOnly && !isAdmin && !active;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={locked}
                  onClick={() => { setKind(key); setDirty((d) => ({ ...d, kind: true })); }}
                  title={locked ? "Only org admins can make a room general" : undefined}
                  className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
                    active
                      ? "bg-[var(--accent-bg)] text-[var(--accent-text)] border-[var(--accent-border)]"
                      : (dark
                          ? "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50")
                  } ${locked ? "opacity-40 cursor-not-allowed" : ""}`}
                  aria-pressed={active}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              );
            })}
          </div>
          <p className={`text-[11px] mt-1 ${dark ? "text-slate-400" : "text-slate-500"}`}>
            {KIND_OPTIONS.find((o) => o.key === kind)?.hint}
          </p>
        </div>

        {/* Color */}
        <div className="mb-4">
          <label className={labelCls}>Color</label>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {ROOM_COLORS.map((c) => {
              const active = color === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => { setColor(c); setDirty((d) => ({ ...d, color: true })); }}
                  className={`w-7 h-7 rounded-md border-2 transition-all relative ${
                    active
                      ? "scale-110 shadow-md"
                      : "hover:scale-105"
                  }`}
                  style={{
                    background: c,
                    borderColor: active ? (dark ? "#fff" : "#0f172a") : "transparent",
                  }}
                  aria-label={c}
                  aria-pressed={active}
                >
                  {active && (
                    <Check className="w-3 h-3 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white drop-shadow" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Meeting duration (meeting rooms only) — keyed off the currently
            selected type so it appears the moment you switch to Meeting. */}
        {kind === "meeting" && (
          <div className="mb-4">
            <label className={labelCls}>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                Auto-close after
              </span>
            </label>
            <p className={`text-[11px] mt-0.5 mb-2 ${dark ? "text-slate-400" : "text-slate-500"}`}>
              {showCustomDuration
                ? (customDuration
                    ? `Session will end after ${customDuration} minute${customDuration === "1" ? "" : "s"}`
                    : "Custom duration in minutes")
                : (maxDuration == null
                    ? "Session stays open until everyone leaves"
                    : `Session will end after ${maxDuration} minute${maxDuration === 1 ? "" : "s"}`)}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {DURATION_PRESETS.map((p) => {
                const active = !showCustomDuration && maxDuration === p.value;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => pickDurationPreset(p.value)}
                    className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                      active
                        ? (dark
                            ? "bg-[var(--accent-bg)] text-[var(--accent-text)] border-[var(--accent-border)]"
                            : "bg-[var(--accent-bg)] text-[var(--accent-text)] border-[var(--accent-border)]")
                        : (dark
                            ? "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                            : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50")
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={pickCustomDuration}
                className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                  showCustomDuration
                    ? "bg-[var(--accent-bg)] text-[var(--accent-text)] border-[var(--accent-border)]"
                    : (dark
                        ? "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                        : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50")
                }`}
              >
                Custom
              </button>
            </div>
            {showCustomDuration && (
              <div className="mt-2 flex items-center gap-2">
                <Input
                  type="text"
                  inputMode="numeric"
                  placeholder="e.g. 25"
                  value={customDuration}
                  onChange={(e) => onCustomDurationChange(e.target.value)}
                  className={`w-24 ${inputCls}`}
                />
                <span className={`text-xs ${dark ? "text-slate-400" : "text-slate-500"}`}>minutes</span>
              </div>
            )}
          </div>
        )}

        {/* Gating */}
        {eligibleGatingTeams.length > 0 && (
          <div className="mb-4">
            <label className={labelCls}>Visible to</label>
            <p className={`text-[11px] mt-0.5 mb-2 ${dark ? "text-slate-400" : "text-slate-500"}`}>
              {selectedTeamIds.length === 0
                ? "Everyone in the org"
                : `Only ${selectedTeamIds.length} team${selectedTeamIds.length === 1 ? "" : "s"}`}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {eligibleGatingTeams.map((t) => {
                const active = selectedTeamIds.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleTeam(t.id)}
                    className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-full border transition-colors"
                    style={
                      active
                        ? { background: `${t.color}22`, borderColor: `${t.color}99`, color: dark ? "#fff" : t.color }
                        : undefined
                    }
                    {...(!active && {
                      className: `inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-full border transition-colors ${
                        dark
                          ? "bg-[var(--color-surface-raised)] border-[var(--color-border)] text-slate-300 hover:border-slate-600"
                          : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                      }`,
                    })}
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.color }} />
                    {t.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Access — who can enter the room. 'Open' = any teammate who can
            see it; 'Code' = a shareable access code is required (managers
            always get in without one). */}
        <div className="mb-4">
          <label className={labelCls}>Access</label>
          <div className="flex gap-1.5 mt-1.5">
            {[
              { value: "open", label: "Open", Icon: Globe },
              { value: "code", label: "Requires code", Icon: Lock },
            ].map(({ value, label, Icon }) => {
              const active = entryPolicy === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => { setEntryPolicy(value); setDirty((d) => ({ ...d, access: true })); }}
                  className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
                    active
                      ? "bg-[var(--accent-bg)] text-[var(--accent-text)] border-[var(--accent-border)]"
                      : (dark
                          ? "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50")
                  }`}
                  aria-pressed={active}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              );
            })}
          </div>
          {entryPolicy === "code" && (
            <div className="mt-2">
              <input
                value={accessCode}
                onChange={(e) => {
                  setAccessCode(e.target.value.toUpperCase().slice(0, 16));
                  setDirty((d) => ({ ...d, access: true }));
                }}
                placeholder="Set an access code"
                className={`w-full px-3 py-2 rounded-lg border text-sm font-mono uppercase tracking-widest ${
                  dark ? "bg-[var(--color-surface-raised)] border-[var(--color-border)] text-slate-100" : "bg-white border-slate-200 text-slate-800"
                }`}
              />
              <p className={`text-[11px] mt-1 ${dark ? "text-slate-400" : "text-slate-500"}`}>
                {accessCode.trim()
                  ? "Lets people join while the room is occupied (an empty room is open to claim). Expires 24h after you set it — re-save to refresh. 4–16 characters."
                  : "No code set yet — anyone can claim the room while it's empty; once someone's inside, only managers can enter until you set a code."}
              </p>
            </div>
          )}

          {/* Knock applies to any room that can be locked — a code room OR a
              team-gated one. (A fully open, ungated room is never locked, so
              the toggle is moot there and we hide it.) */}
          {(entryPolicy === "code" || selectedTeamIds.length > 0) && (
            <label className="mt-3 flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={knockEnabled}
                onChange={(e) => { setKnockEnabled(e.target.checked); setDirty((d) => ({ ...d, access: true })); }}
                className="mt-0.5 h-4 w-4 rounded accent-teal-600"
              />
              <span>
                <span className={`text-sm ${dark ? "text-slate-200" : "text-slate-700"}`}>Accept knocks</span>
                <span className={`block text-[11px] ${dark ? "text-slate-400" : "text-slate-500"}`}>
                  When this room is locked, someone who can’t get in can ask to be let in — an occupant or a manager approves. Turn off for a do-not-disturb room.
                </span>
              </span>
            </label>
          )}
        </div>

        {/* Pin control — who can pin a participant into everyone's view during a
            call (sets the shared focus all clients follow). */}
        <div className="mb-4">
          <label className={labelCls}>
            <Pin className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
            Who can pin for everyone
          </label>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {[
              { value: "admins", label: "Admins" },
              { value: "leaders", label: "Session leader" },
              { value: "both", label: "Admins & leader" },
              { value: "everyone", label: "Everyone" },
            ].map(({ value, label }) => {
              const active = pinPolicy === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => { setPinPolicy(value); setDirty((d) => ({ ...d, pin: true })); }}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
                    active
                      ? "bg-[var(--accent-bg)] text-[var(--accent-text)] border-[var(--accent-border)]"
                      : (dark
                          ? "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                          : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50")
                  }`}
                  aria-pressed={active}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <p className={`text-[11px] mt-1 ${dark ? "text-slate-400" : "text-slate-500"}`}>
            {pinPolicy === "admins" && "Only org admins can pin someone into everyone's view."}
            {pinPolicy === "leaders" && "Only the room's session leader can pin for everyone."}
            {pinPolicy === "both" && "Org admins and the session leader can pin for everyone."}
            {pinPolicy === "everyone" && "Anyone in the call can pin a participant for everyone."}
          </p>
        </div>

        {/* Whiteboard — by default anyone in the room can attach / swap the
            shared board. Lock it to keep that to managers only. */}
        <div className="mb-4">
          <label className={labelCls}>
            <PenLine className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
            Whiteboard
          </label>
          <label className="mt-1.5 flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={whiteboardLocked}
              onChange={(e) => { setWhiteboardLocked(e.target.checked); setDirty((d) => ({ ...d, whiteboard: true })); }}
              className="mt-0.5 h-4 w-4 rounded accent-teal-600"
            />
            <span>
              <span className={`text-sm ${dark ? "text-slate-200" : "text-slate-700"}`}>Only managers can change the whiteboard</span>
              <span className={`block text-[11px] ${dark ? "text-slate-400" : "text-slate-500"}`}>
                Off (default): anyone in the room can attach, swap, or remove the shared whiteboard. On: only the room's managers can — everyone else still sees whatever's attached.
              </span>
            </span>
          </label>
        </div>

        </div>{/* /scrollable body */}

        {/* Footer (pinned) */}
        <div className={`flex items-center gap-2 px-5 sm:px-6 py-4 border-t shrink-0 ${dark ? "border-[var(--color-border)]" : "border-slate-200"}`}>
          {confirmDelete ? (
            <div className="flex items-center gap-2 flex-1">
              <span className={`text-xs ${dark ? "text-slate-300" : "text-slate-600"}`}>
                Delete "{room.name}"?
              </span>
              <div className="ml-auto flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmDelete(false)}
                  disabled={busy}
                >
                  Keep
                </Button>
                <Button
                  type="button"
                  onClick={handleDelete}
                  disabled={busy}
                  className={dark
                    ? "bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/40"
                    : "bg-red-50 text-red-600 hover:bg-red-100 border border-red-200"}
                >
                  {busy ? "Deleting…" : "Delete room"}
                </Button>
              </div>
            </div>
          ) : confirmClear ? (
            <div className="flex items-center gap-2 flex-1">
              <span className={`text-xs ${dark ? "text-slate-300" : "text-slate-600"}`}>
                Clear all chat in "{room.name}"? This can't be undone.
              </span>
              <div className="ml-auto flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmClear(false)}
                  disabled={busy}
                >
                  Keep
                </Button>
                <Button
                  type="button"
                  onClick={handleClearChat}
                  disabled={busy}
                  className={dark
                    ? "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/40"
                    : "bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200"}
                >
                  {busy ? "Clearing…" : "Clear chat"}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-1.5 rounded-md transition-colors ${
                  dark
                    ? "text-red-400 hover:bg-red-500/15"
                    : "text-red-600 hover:bg-red-50"
                }`}
                title="Delete this room"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                disabled={busy}
                className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-1.5 rounded-md transition-colors ${
                  dark ? "text-slate-300 hover:bg-white/10" : "text-slate-600 hover:bg-slate-100"
                }`}
                title="Clear all messages in this room's chat"
              >
                <Eraser className="w-3.5 h-3.5" />
                Clear chat
              </button>
              <div className="ml-auto flex gap-2">
                <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button
                  type="button"
                  onClick={handleSave}
                  disabled={busy || !(dirty.name || dirty.kind || dirty.color || dirty.gating || dirty.duration || dirty.access || dirty.pin || dirty.whiteboard) || !name.trim()}
                >
                  {busy ? "Saving…" : "Save"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
