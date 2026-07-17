import { useEffect, useRef, useState } from "react";
import { useApp } from "../context/AppContext";
import { useTeam } from "../context/TeamContext";
import { useTheme } from "../context/ThemeContext";
import { supabase } from "../supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Settings as SettingsIcon, User, Palette, Timer, Clock,
  Briefcase, Bell, Database, Check, Sun, Moon, Sparkles,
  FileText, Download, Upload, KeyRound, Volume2, CalendarClock, Plus, X, Info, GraduationCap,
} from "lucide-react";
import { openWhatsNew } from "../components/WhatsNew";
import { openHelpCenter } from "../components/tour/HelpCenter";
import { uiSoundsEnabled, setUiSoundsEnabled, playNotify, playMessage, playHandRaise } from "../lib/uiSounds";
import { appVersion, latestEntryId } from "../lib/changelog";
import { ACCENTS } from "../lib/accent";
import AvatarUploader from "../components/AvatarUploader";
import SoundLibrary from "../components/SoundLibrary";
import TimeSelect from "../components/TimeSelect";
import { toDisplayTime } from "../lib/utils";
import { loadPomodoroSoundSettings, savePomodoroSoundSettings, USER_SOUND_PREFIX } from "../lib/pomodoroSound";
import { clearCachedNotificationSound, nativePushSupported, getNativePushStatus, enableNativePush } from "../lib/nativeNotifications";
import { NOTIFICATION_TYPES, listPreferences, setPreferenceEnabled } from "../lib/notifications";
import { REMINDERS, REMINDER_INTERVALS, reminderConfig } from "../lib/reminders";
import { TIMEZONES, browserTimezone, localTimeLabel } from "../lib/timezone";
import { readStatusOnCycle, writeStatusOnCycle } from "../lib/statusCyclePref";
import { enableWebPush, disableWebPush, isWebPushEnabled, webPushSupported } from "../lib/webPush";

// Settings as a real page. Left rail of sections, right pane renders
// the active section. Sections persist on field commit (blur/change)
// instead of via a global Save — picking a theme or color commits
// instantly, and the small toast at the top of each section confirms.

const SECTIONS = [
  { key: "profile",       label: "Profile",       Icon: User },
  { key: "availability",  label: "Availability",  Icon: CalendarClock },
  { key: "appearance",    label: "Appearance",    Icon: Palette },
  { key: "pomodoro",      label: "Pomodoro",      Icon: Timer },
  { key: "sounds",        label: "Sounds",        Icon: Volume2 },
  { key: "tracker",       label: "Time tracker",  Icon: Clock },
  { key: "projects",      label: "Projects",      Icon: Briefcase },
  { key: "notifications", label: "Notifications", Icon: Bell },
  { key: "data",          label: "Data",          Icon: Database },
  { key: "about",         label: "About",         Icon: Info },
];

const PROJECT_COLORS = ["#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#ef4444", "#64748b"];

// Pastel palette for whiteboard sticky notes. Stays light enough that body
// text reads in either theme without needing per-color contrast tweaks.
const STICKY_COLORS = [
  { hex: "#fde68a", label: "Yellow" },
  { hex: "#fbcfe8", label: "Pink" },
  { hex: "#bfdbfe", label: "Blue" },
  { hex: "#bbf7d0", label: "Green" },
  { hex: "#ddd6fe", label: "Purple" },
  { hex: "#fed7aa", label: "Orange" },
  { hex: "#fecaca", label: "Coral" },
  { hex: "#e2e8f0", label: "Slate" },
];

export default function SettingsPage() {
  const { theme } = useTheme();
  const dark = theme === "dark";
  const [section, setSection] = useState("profile");

  return (
    <main className="max-w-[1100px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-[var(--color-accent-light)]">
          <SettingsIcon className="w-5 h-5 text-[var(--color-accent)]" />
        </div>
        <h1 className={`text-2xl font-bold ${dark ? "text-slate-100" : "text-slate-800"}`}>
          Settings
        </h1>
      </div>

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <aside className="space-y-0.5 self-start md:sticky md:top-20">
          {SECTIONS.map(({ key, label, Icon }) => {
            const active = section === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSection(key)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                  active
                    ? "bg-[var(--color-accent-light)] text-[var(--color-accent)] font-semibold"
                    : dark
                      ? "text-slate-400 hover:bg-[var(--color-surface-raised)] hover:text-slate-200"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-800"
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            );
          })}
        </aside>

        <div className="min-w-0">
          {section === "profile" && <ProfileSection dark={dark} />}
          {section === "availability" && <AvailabilitySection dark={dark} />}
          {section === "appearance" && <AppearanceSection dark={dark} />}
          {section === "sounds" && <SoundsSection dark={dark} />}
          {section === "pomodoro" && <PomodoroSection dark={dark} />}
          {section === "tracker" && <TimeTrackerSection dark={dark} />}
          {section === "projects" && <ProjectsSection dark={dark} />}
          {section === "notifications" && <NotificationsSection dark={dark} />}
          {section === "data" && <DataSection dark={dark} />}
          {section === "about" && <AboutSection dark={dark} />}
        </div>
      </div>
    </main>
  );
}

// ── Shared shell ──────────────────────────────────────────────────

function SectionCard({ title, hint, dark, children, action }) {
  return (
    <div
      className={`rounded-2xl border p-5 sm:p-6 mb-4 ${
        dark ? "" : "bg-white border-slate-200"
      }`}
      style={dark ? { background: "var(--color-surface)", borderColor: "var(--color-border)" } : undefined}
    >
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="min-w-0">
          <h2 className={`text-base font-bold ${dark ? "text-slate-100" : "text-slate-800"}`}>
            {title}
          </h2>
          {hint && (
            <p className={`text-xs mt-0.5 ${dark ? "text-slate-400" : "text-slate-500"}`}>
              {hint}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Toast({ message, dark, tone = "ok" }) {
  if (!message) return null;
  const cls = tone === "err"
    ? (dark ? "bg-red-500/15 text-red-300" : "bg-red-50 text-red-700")
    : (dark ? "bg-emerald-500/15 text-emerald-300" : "bg-emerald-50 text-emerald-700");
  return (
    <div className={`mb-3 text-xs px-3 py-2 rounded-md ${cls}`}>{message}</div>
  );
}

function FieldLabel({ children, dark, hint }) {
  return (
    <div className="mb-1.5">
      <span className={`block text-[10px] font-semibold uppercase tracking-wider ${
        dark ? "text-slate-400" : "text-slate-500"
      }`}>
        {children}
      </span>
      {hint && (
        <span className={`block text-[11px] ${dark ? "text-slate-500" : "text-slate-400"}`}>
          {hint}
        </span>
      )}
    </div>
  );
}

// Tiny helper that writes one column to user_settings via upsert.
// Mirrors the modal's saveSettings() shape so behavior stays identical
// — just narrower. Returns a promise so callers can chain a savedAt
// notification.
async function persistUserSettings(userId, patch) {
  if (!userId) return { error: { message: "Not signed in" } };
  const { error } = await supabase
    .from("user_settings")
    .upsert(
      { user_id: userId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
  return { error };
}

// ── Profile: name, avatar, status, hourly rate, custom alarm ───────

function ProfileSection({ dark }) {
  const {
    settings, setSettings, session,
    hourlyRate, setHourlyRate,
    updateSettingsField,
    addCustomSound, renameCustomSound, removeCustomSound,
  } = useApp();
  const { teamSounds } = useTeam();
  const [soundSettings, setSoundSettings] = useState(() => loadPomodoroSoundSettings());
  function updateSound(patch) {
    setSoundSettings((prev) => {
      const next = { ...prev, ...patch };
      savePomodoroSoundSettings(next);
      return next;
    });
  }
  const userId = session?.user?.id;

  const [name, setName] = useState(settings.name || "");
  const [avatarUrl, setAvatarUrl] = useState(settings.avatarUrl || "");
  const [rateDraft, setRateDraft] = useState(hourlyRate ? String(hourlyRate) : "");
  const [annualDraft, setAnnualDraft] = useState("");
  const [error, setError] = useState("");
  const HOURS_PER_YEAR = 2080; // 40h × 52w — standard salary↔hourly basis
  const [savingMsg, setSavingMsg] = useState("");

  const [jobTitle, setJobTitle] = useState(settings.jobTitle || "");
  useEffect(() => { setJobTitle(settings.jobTitle || ""); }, [settings.jobTitle]);
  useEffect(() => { setName(settings.name || ""); }, [settings.name]);
  useEffect(() => { setAvatarUrl(settings.avatarUrl || ""); }, [settings.avatarUrl]);
  useEffect(() => { setRateDraft(hourlyRate ? String(hourlyRate) : ""); }, [hourlyRate]);
  useEffect(() => {
    setAnnualDraft(settings?.annualSalary != null ? String(settings.annualSalary) : (hourlyRate ? String(Math.round(hourlyRate * HOURS_PER_YEAR)) : ""));
  }, [settings?.annualSalary, hourlyRate]);

  function flashSaved() {
    setSavingMsg("Saved");
    setTimeout(() => setSavingMsg(""), 1500);
  }

  async function persist(patch) {
    const { error: err } = await persistUserSettings(userId, patch);
    if (err) { setError(err.message); return false; }
    setSettings((prev) => ({
      ...prev,
      ...(patch.name !== undefined        ? { name: patch.name || "" }                 : {}),
      ...(patch.avatar_url !== undefined  ? { avatarUrl: patch.avatar_url || "" }      : {}),
    }));
    flashSaved();
    return true;
  }

  function onAvatarChange(url) {
    setAvatarUrl(url || "");
    persist({ avatar_url: url || null });
    supabase.rpc("refresh_my_sync_avatar").then(() => {}, () => {});
  }

  function onNameBlur() {
    const clean = name.trim();
    if (clean === (settings.name || "")) return;
    persist({ name: clean || null });
  }


  async function onRateBlur() {
    const rate = parseFloat(rateDraft);
    const clean = Number.isFinite(rate) && rate >= 0 ? rate : 0;
    if (clean === hourlyRate) return;
    const { error: err } = await persistUserSettings(userId, { hourly_rate: clean });
    if (err) { setError(err.message); return; }
    setHourlyRate(clean);
    updateSettingsField({ wageMode: "hourly", annualSalary: clean ? Math.round(clean * HOURS_PER_YEAR) : null });
    flashSaved();
  }

  async function onAnnualBlur() {
    const annual = parseFloat(annualDraft);
    const clean = Number.isFinite(annual) && annual >= 0 ? annual : 0;
    const hourly = clean ? Math.round((clean / HOURS_PER_YEAR) * 100) / 100 : 0;
    const { error: err } = await persistUserSettings(userId, { hourly_rate: hourly });
    if (err) { setError(err.message); return; }
    setHourlyRate(hourly);
    updateSettingsField({ wageMode: "yearly", annualSalary: clean || null });
    flashSaved();
  }

  return (
    <>
      <Toast message={error} dark={dark} tone="err" />
      <Toast message={savingMsg} dark={dark} />

      <SectionCard title="Your profile" hint="What teammates see in shared sessions." dark={dark}>
        <div className="space-y-4">
          <div>
            <FieldLabel dark={dark}>Display name</FieldLabel>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 60))}
              onBlur={onNameBlur}
              placeholder="e.g. Jacob"
              className="max-w-sm"
              maxLength={60}
            />
          </div>
          <div>
            <FieldLabel dark={dark}>Job title</FieldLabel>
            <Input
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value.slice(0, 80))}
              onBlur={() => { const v = jobTitle.trim(); if (v !== (settings.jobTitle || "")) { updateSettingsField({ jobTitle: v || null }); flashSaved(); } }}
              placeholder="e.g. Product Engineer"
              className="max-w-sm"
              maxLength={80}
            />
          </div>
          <div>
            <FieldLabel dark={dark}>Profile picture</FieldLabel>
            <AvatarUploader
              userId={userId}
              value={avatarUrl}
              displayName={name}
              size={72}
              onChange={onAvatarChange}
              onError={(msg) => setError(msg)}
            />
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Pay rate" hint="Used to calculate earnings on the Overview page. Enter it hourly or yearly — we convert (assuming ~2,080 work hours a year)." dark={dark}>
        {(() => {
          const yearly = (settings?.wageMode || "hourly") === "yearly";
          return (
            <div className="flex flex-col gap-2.5">
              <div className="flex gap-1.5">
                {[["hourly", "Hourly"], ["yearly", "Yearly"]].map(([v, l]) => {
                  const on = (settings?.wageMode || "hourly") === v;
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => updateSettingsField({ wageMode: v })}
                      className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                        on ? "bg-[var(--color-accent-light)] text-[var(--color-accent)]" : dark ? "text-slate-400 hover:bg-white/5" : "text-slate-500 hover:bg-slate-100"
                      }`}
                    >{l}</button>
                  );
                })}
              </div>
              {yearly ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-sm ${dark ? "text-slate-400" : "text-slate-500"}`}>$</span>
                  <Input type="number" min="0" step="1000" value={annualDraft} onChange={(e) => setAnnualDraft(e.target.value)} onBlur={onAnnualBlur} placeholder="80,000" className="w-32" />
                  <span className={`text-sm ${dark ? "text-slate-500" : "text-slate-400"}`}>/ yr</span>
                  {hourlyRate > 0 && <span className={`text-xs ${dark ? "text-slate-500" : "text-slate-400"}`}>≈ ${hourlyRate.toFixed(2)}/hr</span>}
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-sm ${dark ? "text-slate-400" : "text-slate-500"}`}>$</span>
                  <Input type="number" min="0" step="0.01" value={rateDraft} onChange={(e) => setRateDraft(e.target.value)} onBlur={onRateBlur} placeholder="0.00" className="w-28" />
                  <span className={`text-sm ${dark ? "text-slate-500" : "text-slate-400"}`}>/ hr</span>
                  {hourlyRate > 0 && <span className={`text-xs ${dark ? "text-slate-500" : "text-slate-400"}`}>≈ ${Math.round(hourlyRate * HOURS_PER_YEAR).toLocaleString()}/yr</span>}
                </div>
              )}
            </div>
          );
        })()}
      </SectionCard>

    </>
  );
}

// ── Sounds: pomodoro alarms (its own section; room to grow) ─────────
function SoundsSection({ dark }) {
  const { settings, addCustomSound, renameCustomSound, removeCustomSound } = useApp();
  const { teamSounds } = useTeam();
  const [soundSettings, setSoundSettings] = useState(() => loadPomodoroSoundSettings());
  const [error, setError] = useState("");
  function updateSound(patch) {
    setSoundSettings((prev) => { const next = { ...prev, ...patch }; savePomodoroSoundSettings(next); return next; });
  }
  return (
    <>
      {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
      <SectionCard
        title="Pomodoro sounds"
        hint="Upload your own alarms or pick from the built-in library. Tap a card to preview; the Focus / Break pills assign it as the alarm for that phase."
        dark={dark}
      >
        <SoundLibrary
          mode="manage"
          userSounds={settings.customSounds || []}
          teamSounds={teamSounds || []}
          soundSettings={soundSettings}
          onSelectFocus={(presetId) => { updateSound({ workEndPreset: presetId }); }}
          onSelectBreak={(presetId) => { updateSound({ breakEndPreset: presetId }); }}
          onUpdateSettings={updateSound}
          onAddSound={async (file) => { const r = await addCustomSound(file); if (r.error) setError(r.error.message || "Upload failed"); }}
          onRenameSound={async (id, name) => { const r = await renameCustomSound(id, name); if (r.error) setError(r.error.message); }}
          onRemoveSound={async (sound) => {
            const r = await removeCustomSound(sound.id);
            if (r.error) { setError(r.error.message); return; }
            clearCachedNotificationSound(`${USER_SOUND_PREFIX}${sound.id}`);
          }}
          onError={setError}
        />
      </SectionCard>
    </>
  );
}

// ── Availability: timezone, per-day hours + location, lunch, out of office ─
function AvailabilitySection({ dark }) {
  const { settings, updateSettingsField } = useApp();
  const [saved, setSaved] = useState(false);
  const muted = dark ? "text-slate-400" : "text-slate-500";
  const commit = (patch) => { updateSettingsField(patch); setSaved(true); setTimeout(() => setSaved(false), 1500); };

  const sched = settings?.workSchedule && typeof settings.workSchedule === "object" ? settings.workSchedule : {};
  const DAYS = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 0]];
  const toggleDay = (d) => {
    const next = { ...sched };
    if (next[d]) delete next[d]; else next[d] = { start: "09:00", end: "17:00", loc: "office" };
    commit({ workSchedule: next });
  };
  const setDay = (d, patch) => commit({ workSchedule: { ...sched, [d]: { ...sched[d], ...patch } } });

  const ranges = Array.isArray(settings?.oooRanges) ? settings.oooRanges : [];
  const newId = () => Math.random().toString(36).slice(2);
  const addRange = () => commit({ oooRanges: [...ranges, { id: newId(), start: "", end: "", note: "" }] });
  const setRange = (id, patch) => commit({ oooRanges: ranges.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const removeRange = (id) => commit({ oooRanges: ranges.filter((r) => r.id !== id) });

  const mode = settings?.lunchMode || "off";
  const fieldCls = `rounded-lg px-2 py-1.5 text-sm border ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)] text-slate-200" : "bg-white border-slate-200 text-slate-700"}`;
  const pill = (on) => `px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${on ? "bg-[var(--color-accent)] text-white" : dark ? "bg-[var(--color-surface-raised)] text-slate-400 hover:text-slate-200" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`;

  return (
    <>
      <div className="h-4">
        {saved && <span className={`text-xs inline-flex items-center gap-1 ${dark ? "text-emerald-300" : "text-emerald-600"}`}><Check className="w-3.5 h-3.5" /> Saved</span>}
      </div>

      <SectionCard title="Timezone" hint="Shown on your profile so teammates know your local time. Auto-detected from your device unless you set it." dark={dark}>
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <select
            value={settings?.timezoneManual ? (settings?.timezone || "") : ""}
            onChange={(e) => { const v = e.target.value; if (!v) commit({ timezoneManual: false, timezone: browserTimezone() }); else commit({ timezoneManual: true, timezone: v }); }}
            className={`${fieldCls} max-w-[18rem]`}
          >
            <option value="">Auto-detect ({browserTimezone() || "?"})</option>
            {TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
          {settings?.timezone && <span className={`text-xs ${muted}`}>{localTimeLabel(settings.timezone)} now</span>}
        </div>
      </SectionCard>

      <SectionCard title="Working schedule" hint="Set hours per day and where you're working. Toggle a day off to mark it non-working. Shown on your profile + used for the off-hours @mention warning." dark={dark}>
        <div className="flex flex-col gap-2">
          {DAYS.map(([label, d]) => {
            const day = sched[d];
            const on = !!day;
            return (
              <div key={d} className="flex items-center gap-2 flex-wrap text-sm">
                <button type="button" onClick={() => toggleDay(d)} aria-pressed={on} className={`w-14 text-center ${pill(on)}`}>{label}</button>
                {on ? (
                  <>
                    <TimeSelect value={day.start || ""} onChange={(v) => setDay(d, { start: v || "" })} />
                    <span className={muted}>–</span>
                    <TimeSelect value={day.end || ""} onChange={(v) => setDay(d, { end: v || "" })} />
                    <button type="button" onClick={() => setDay(d, { loc: day.loc === "home" ? "office" : "home" })} className={`${fieldCls} cursor-pointer`}>
                      {day.loc === "home" ? "🏠 Home" : "🏢 Office"}
                    </button>
                  </>
                ) : (
                  <span className={`text-xs ${muted}`}>Off</span>
                )}
              </div>
            );
          })}
          <div className="flex items-center gap-2.5 mt-1">
            <button type="button" role="switch" aria-checked={settings?.offHoursWarn !== false}
              onClick={() => commit({ offHoursWarn: !(settings?.offHoursWarn !== false) })}
              className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${settings?.offHoursWarn !== false ? "bg-[var(--color-accent)]" : dark ? "bg-slate-600" : "bg-slate-300"}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${settings?.offHoursWarn !== false ? "translate-x-4" : ""}`} />
            </button>
            <span className={`text-sm ${dark ? "text-slate-300" : "text-slate-700"}`}>Warn teammates who @mention me outside these hours</span>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Scheduling availability" hint="Powers the calendar's “Find a time” scheduler. Only applies if you've connected Google Calendar — it shares busy/free times (no event titles or details) so teammates can book around you. Off by default." dark={dark}>
        <div className="flex items-center gap-2.5">
          <button type="button" role="switch" aria-checked={!!settings?.shareFreebusy}
            onClick={() => commit({ shareFreebusy: !settings?.shareFreebusy })}
            className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${settings?.shareFreebusy ? "bg-[var(--color-accent)]" : dark ? "bg-slate-600" : "bg-slate-300"}`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${settings?.shareFreebusy ? "translate-x-4" : ""}`} />
          </button>
          <span className={`text-sm ${dark ? "text-slate-300" : "text-slate-700"}`}>Let teammates see when I'm busy (times only, no event details)</span>
        </div>
      </SectionCard>

      <SectionCard title="Lunch break" hint="At your lunch time, flip your status to Out to lunch — automatically or after a prompt. Logs a break (paid/unpaid below)." dark={dark}>
        <div className="flex flex-col gap-3">
          <div className="flex gap-1.5">
            {[["off", "Off"], ["ask", "Ask me"], ["auto", "Automatic"]].map(([v, l]) => (
              <button key={v} type="button" onClick={() => commit({ lunchMode: v })}
                className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${mode === v ? (dark ? "bg-orange-500/25 text-orange-200" : "bg-orange-100 text-orange-700") : dark ? "text-slate-300 hover:bg-white/10" : "text-slate-600 hover:bg-slate-100"}`}>{l}</button>
            ))}
          </div>
          {mode !== "off" && (
            <div className="flex items-center gap-2 flex-wrap text-sm">
              <span className={muted}>At</span>
              <TimeSelect value={settings?.lunchTime || ""} onChange={(v) => commit({ lunchTime: v || null })} />
              <span className={muted}>for</span>
              <select value={settings?.lunchDurationMin ?? 60} onChange={(e) => commit({ lunchDurationMin: Number(e.target.value) })} className={fieldCls}>
                {[30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} min</option>)}
              </select>
            </div>
          )}
          <div className="flex items-center gap-2.5">
            <button type="button" role="switch" aria-checked={!!settings?.lunchBreakPaid}
              onClick={() => commit({ lunchBreakPaid: !settings?.lunchBreakPaid })}
              className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${settings?.lunchBreakPaid ? "bg-[var(--color-accent)]" : dark ? "bg-slate-600" : "bg-slate-300"}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${settings?.lunchBreakPaid ? "translate-x-4" : ""}`} />
            </button>
            <span className={`text-sm ${dark ? "text-slate-300" : "text-slate-700"}`}>Lunch break is paid (counts toward logged time)</span>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Out of office" hint="Add the days you'll be away — vacations, conferences. Each change saves automatically (watch for ✓ Saved up top)." dark={dark}>
        <div className="flex flex-col gap-2">
          {ranges.length === 0 && <p className={`text-xs ${muted}`}>No out-of-office dates set.</p>}
          {ranges.map((r) => (
            <div key={r.id} className="flex items-center gap-2 flex-wrap text-sm">
              <input type="date" value={r.start || ""} onChange={(e) => setRange(r.id, { start: e.target.value })} className={fieldCls} />
              <span className={muted}>to</span>
              <input type="date" value={r.end || ""} onChange={(e) => setRange(r.id, { end: e.target.value })} className={fieldCls} />
              <input type="text" maxLength={60} value={r.note || ""} onChange={(e) => setRange(r.id, { note: e.target.value })} placeholder="Note" className={`flex-1 min-w-[7rem] ${fieldCls}`} />
              <button type="button" onClick={() => removeRange(r.id)} aria-label="Remove" className={`shrink-0 ${dark ? "text-slate-500 hover:text-red-300" : "text-slate-400 hover:text-red-500"}`}><X className="w-4 h-4" /></button>
            </div>
          ))}
          <button type="button" onClick={addRange} className={`self-start inline-flex items-center gap-1.5 text-sm mt-1 ${dark ? "text-slate-300 hover:text-slate-100" : "text-slate-600 hover:text-slate-800"}`}>
            <Plus className="w-4 h-4" /> Add dates
          </button>
        </div>
      </SectionCard>
    </>
  );
}

// ── Appearance: theme + accent + sticky-note color ─────────────────

function AppearanceSection({ dark }) {
  const { settings, updateSettingsField, session, stickyColor, setStickyColor } = useApp();
  const { toggleTheme } = useTheme();
  const userId = session?.user?.id;
  const current = settings.accentColor || "teal";

  async function pickSticky(hex) {
    if (hex === stickyColor) return;
    setStickyColor(hex);
    await persistUserSettings(userId, { sticky_color: hex });
  }

  return (
    <>
      <SectionCard title="Theme" hint="Switch between light and dark mode." dark={dark}>
        <div className="flex gap-2">
          {[
            { key: "light", label: "Light", Icon: Sun },
            { key: "dark", label: "Dark", Icon: Moon },
          ].map(({ key, label, Icon }) => {
            const active = (key === "dark") === dark;
            return (
              <button
                key={key}
                type="button"
                onClick={() => { if (active) return; toggleTheme(); }}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 text-sm font-semibold transition-all ${
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-light)] text-[var(--color-accent)]"
                    : dark
                      ? "border-[var(--color-border)] text-slate-400 hover:border-slate-600"
                      : "border-slate-200 text-slate-600 hover:border-slate-300"
                }`}
              >
                <Icon className="w-4 h-4" /> {label}
              </button>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        title="Accent color"
        hint="Used on buttons, links, focus rings, and active states. Saves immediately."
        dark={dark}
      >
        <div className="grid grid-cols-5 gap-3">
          {ACCENTS.map((a) => {
            const active = current === a.key;
            return (
              <button
                key={a.key}
                type="button"
                onClick={() => updateSettingsField({ accentColor: a.key })}
                className={`flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all ${
                  active
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-light)]"
                    : dark
                      ? "border-transparent hover:border-[var(--color-border)]"
                      : "border-transparent hover:border-slate-300"
                }`}
                aria-label={a.label}
                aria-pressed={active}
              >
                <span
                  className="w-10 h-10 rounded-full relative shrink-0"
                  style={{ background: a.swatch }}
                >
                  {active && (
                    <Check className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 text-white drop-shadow" />
                  )}
                </span>
                <span className={`text-[11px] font-semibold ${
                  dark ? "text-slate-400" : "text-slate-600"
                }`}>
                  {a.label}
                </span>
              </button>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        title="Sticky-note color"
        hint="Default background tint for sticky notes you add to whiteboards."
        dark={dark}
      >
        <div className="flex flex-wrap gap-2">
          {STICKY_COLORS.map((c) => {
            const active = (stickyColor || "#fde68a").toLowerCase() === c.hex.toLowerCase();
            return (
              <button
                key={c.hex}
                type="button"
                onClick={() => pickSticky(c.hex)}
                title={c.label}
                aria-label={c.label}
                className="rounded-lg"
                style={{
                  width: 32,
                  height: 32,
                  background: c.hex,
                  border: active ? "2px solid var(--color-text)" : "2px solid transparent",
                  boxShadow: active ? "0 0 0 1px var(--color-surface)" : "none",
                }}
              />
            );
          })}
        </div>
      </SectionCard>
    </>
  );
}

// ── Pomodoro: landing page + DeepSeek key ──────────────────────────

function PomodoroSection({ dark }) {
  const {
    session,
    defaultLandingPage, setDefaultLandingPage,
    deepseekKey, setDeepseekKey,
    settings, updateSettingsField,
  } = useApp();
  const userId = session?.user?.id;

  const [landing, setLanding] = useState(defaultLandingPage || "pomodoro");
  const [keyDraft, setKeyDraft] = useState(deepseekKey || "");
  const [savingMsg, setSavingMsg] = useState("");
  const [error, setError] = useState("");
  const [statusOnCycle, setStatusOnCycle] = useState(readStatusOnCycle());

  useEffect(() => { setLanding(defaultLandingPage || "pomodoro"); }, [defaultLandingPage]);
  useEffect(() => { setKeyDraft(deepseekKey || ""); }, [deepseekKey]);

  function flashSaved() { setSavingMsg("Saved"); setTimeout(() => setSavingMsg(""), 1500); }

  async function pickLanding(v) {
    const clean = v === "log" ? "log" : "pomodoro";
    if (clean === landing) return;
    setLanding(clean);
    const { error: err } = await persistUserSettings(userId, { default_landing_page: clean });
    if (err) { setError(err.message); return; }
    setDefaultLandingPage(clean);
    try { localStorage.setItem("ql_default_landing", clean); } catch { /* ignore */ }
    flashSaved();
  }

  async function onKeyBlur() {
    const clean = (keyDraft || "").trim();
    if (clean === (deepseekKey || "")) return;
    const { error: err } = await persistUserSettings(userId, { deepseek_key: clean });
    if (err) { setError(err.message); return; }
    setDeepseekKey(clean);
    flashSaved();
  }

  return (
    <>
      <Toast message={error} dark={dark} tone="err" />
      <Toast message={savingMsg} dark={dark} />

      <SectionCard
        title="Default landing page"
        hint="Where opening the app drops you."
        dark={dark}
      >
        <Select value={landing} onValueChange={pickLanding}>
          <SelectTrigger className="h-10 w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="pomodoro">Pomodoro</SelectItem>
            <SelectItem value="log">Time tracker</SelectItem>
          </SelectContent>
        </Select>
      </SectionCard>

      <SectionCard
        title="Session reflections"
        hint="Pop a quick 'what did you work on?' note around your focus blocks — it sets your current task so the work is captured as you go."
        dark={dark}
      >
        <Select value={settings?.reflectWhen || "off"} onValueChange={(v) => { updateSettingsField({ reflectWhen: v }); flashSaved(); }}>
          <SelectTrigger className="h-10 w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="after_focus">After each focus block</SelectItem>
            <SelectItem value="before_focus">Before the next focus</SelectItem>
            <SelectItem value="both">Both</SelectItem>
          </SelectContent>
        </Select>
      </SectionCard>

      <SectionCard
        title="Status at Pomodoro end"
        hint="When a focus block or break ends, clear your manual status (back to auto) or get a quick prompt to update it."
        dark={dark}
      >
        <Select value={statusOnCycle} onValueChange={(v) => { setStatusOnCycle(v); writeStatusOnCycle(v); flashSaved(); }}>
          <SelectTrigger className="h-10 w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="clear">Clear my status</SelectItem>
            <SelectItem value="ask">Ask me</SelectItem>
          </SelectContent>
        </Select>
      </SectionCard>

      <SectionCard
        title="DeepSeek API key"
        hint="Enables the description rewriter and month summaries on the time tracker."
        dark={dark}
      >
        <div className="flex items-center gap-2 max-w-md">
          <KeyRound className={`w-4 h-4 shrink-0 ${dark ? "text-slate-500" : "text-slate-400"}`} />
          <Input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onBlur={onKeyBlur}
            placeholder="sk-…"
            className="font-mono"
          />
        </div>
      </SectionCard>
    </>
  );
}

// ── Time tracker: rounding, targets, defaults, templates ───────────

function TimeTrackerSection({ dark }) {
  const {
    session, settings, setSettings, templates, setTemplates,
    defaultEntryMode, setDefaultEntryMode,
    timeRounding, setTimeRounding,
    dailyTarget, setDailyTarget,
    weeklyTarget, setWeeklyTarget,
  } = useApp();
  const userId = session?.user?.id;

  const [entryMode, setEntryMode] = useState(defaultEntryMode || "manual");
  const [rounding, setRounding] = useState(timeRounding || "none");
  const [daily, setDaily] = useState(dailyTarget ? String(dailyTarget) : "");
  const [weekly, setWeekly] = useState(weeklyTarget ? String(weeklyTarget) : "");
  const [defaultTplId, setDefaultTplId] = useState(settings.defaultTemplateId || "");
  const [defaultStart, setDefaultStart] = useState(settings.defaultStart || "");
  const [defaultEnd, setDefaultEnd] = useState(settings.defaultEnd || "");

  const [error, setError] = useState("");
  const [savingMsg, setSavingMsg] = useState("");

  useEffect(() => { setEntryMode(defaultEntryMode || "manual"); }, [defaultEntryMode]);
  useEffect(() => { setRounding(timeRounding || "none"); }, [timeRounding]);
  useEffect(() => { setDaily(dailyTarget ? String(dailyTarget) : ""); }, [dailyTarget]);
  useEffect(() => { setWeekly(weeklyTarget ? String(weeklyTarget) : ""); }, [weeklyTarget]);
  useEffect(() => { setDefaultTplId(settings.defaultTemplateId || ""); }, [settings.defaultTemplateId]);
  useEffect(() => { setDefaultStart(settings.defaultStart || ""); }, [settings.defaultStart]);
  useEffect(() => { setDefaultEnd(settings.defaultEnd || ""); }, [settings.defaultEnd]);

  function flashSaved() { setSavingMsg("Saved"); setTimeout(() => setSavingMsg(""), 1500); }

  async function pickEntryMode(v) {
    const clean = v === "auto" ? "auto" : "manual";
    if (clean === entryMode) return;
    setEntryMode(clean);
    const { error: err } = await persistUserSettings(userId, { default_entry_mode: clean });
    if (err) { setError(err.message); return; }
    setDefaultEntryMode(clean);
    flashSaved();
  }

  async function pickRounding(v) {
    if (v === rounding) return;
    setRounding(v);
    const { error: err } = await persistUserSettings(userId, { time_rounding: v });
    if (err) { setError(err.message); return; }
    setTimeRounding(v);
    flashSaved();
  }

  async function onDailyBlur() {
    const n = parseFloat(daily);
    const clean = Number.isFinite(n) && n >= 0 ? n : 0;
    if (clean === dailyTarget) return;
    const { error: err } = await persistUserSettings(userId, { daily_target: clean });
    if (err) { setError(err.message); return; }
    setDailyTarget(clean);
    flashSaved();
  }

  async function onWeeklyBlur() {
    const n = parseFloat(weekly);
    const clean = Number.isFinite(n) && n >= 0 ? n : 0;
    if (clean === weeklyTarget) return;
    const { error: err } = await persistUserSettings(userId, { weekly_target: clean });
    if (err) { setError(err.message); return; }
    setWeeklyTarget(clean);
    flashSaved();
  }

  async function pickDefaultTemplate(v) {
    const clean = v === "__none__" ? null : v;
    if ((clean || "") === (defaultTplId || "")) return;
    setDefaultTplId(clean || "");
    const { error: err } = await persistUserSettings(userId, { default_template_id: clean });
    if (err) { setError(err.message); return; }
    setSettings((s) => ({ ...s, defaultTemplateId: clean || undefined }));
    flashSaved();
  }

  async function commitDefaultStart(v) {
    if ((v || "") === (settings.defaultStart || "")) return;
    setDefaultStart(v || "");
    const { error: err } = await persistUserSettings(userId, { default_start: v || null });
    if (err) { setError(err.message); return; }
    setSettings((s) => ({ ...s, defaultStart: v || "" }));
    flashSaved();
  }

  async function commitDefaultEnd(v) {
    if ((v || "") === (settings.defaultEnd || "")) return;
    setDefaultEnd(v || "");
    const { error: err } = await persistUserSettings(userId, { default_end: v || null });
    if (err) { setError(err.message); return; }
    setSettings((s) => ({ ...s, defaultEnd: v || "" }));
    flashSaved();
  }

  return (
    <>
      <Toast message={error} dark={dark} tone="err" />
      <Toast message={savingMsg} dark={dark} />

      <SectionCard title="Entry behavior" hint="How the log form opens and rounds time." dark={dark}>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <FieldLabel dark={dark}>Default entry mode</FieldLabel>
            <Select value={entryMode} onValueChange={pickEntryMode}>
              <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="auto">Automatic</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <FieldLabel dark={dark} hint="Down on clock in, up on clock out">
              Time rounding
            </FieldLabel>
            <Select value={rounding} onValueChange={pickRounding}>
              <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[["none", "No rounding"], ["1", "1 minute"], ["5", "5 minutes"], ["15", "15 minutes"], ["30", "30 minutes"]].map(([v, l]) => (
                  <SelectItem key={v} value={v}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Goals" hint="Targets shown on the Overview page." dark={dark}>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <FieldLabel dark={dark}>Daily goal</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                type="number" min="0" max="24" step="0.5"
                value={daily}
                onChange={(e) => setDaily(e.target.value)}
                onBlur={onDailyBlur}
                placeholder="0"
                className="w-28"
              />
              <span className={`text-sm ${dark ? "text-slate-500" : "text-slate-400"}`}>hrs / day</span>
            </div>
          </div>
          <div>
            <FieldLabel dark={dark}>Weekly goal</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                type="number" min="0" max="168" step="1"
                value={weekly}
                onChange={(e) => setWeekly(e.target.value)}
                onBlur={onWeeklyBlur}
                placeholder="0"
                className="w-28"
              />
              <span className={`text-sm ${dark ? "text-slate-500" : "text-slate-400"}`}>hrs / week</span>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Defaults for new entries"
        hint={defaultTplId ? "Default template overrides start & end times." : "Pick a template or set start/end manually."}
        dark={dark}
      >
        <div className="space-y-4">
          <div>
            <FieldLabel dark={dark}>Default template</FieldLabel>
            <Select value={defaultTplId || "__none__"} onValueChange={pickDefaultTemplate}>
              <SelectTrigger className="h-10 max-w-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!defaultTplId && (
            <div className="grid sm:grid-cols-2 gap-4 max-w-md">
              <div>
                <FieldLabel dark={dark}>Default start</FieldLabel>
                <TimeSelect value={defaultStart} onChange={commitDefaultStart} />
              </div>
              <div>
                <FieldLabel dark={dark}>Default end</FieldLabel>
                <TimeSelect value={defaultEnd} onChange={commitDefaultEnd} />
              </div>
            </div>
          )}
        </div>
      </SectionCard>

      <TemplatesCard
        dark={dark}
        userId={userId}
        templates={templates}
        setTemplates={setTemplates}
        defaultTplId={defaultTplId}
        onClearDefault={() => pickDefaultTemplate("__none__")}
        onError={setError}
        onSaved={flashSaved}
      />
    </>
  );
}

// Templates CRUD — collapsed inline editor. Each save round-trips to
// supabase directly rather than relying on the legacy draft pipeline.
function TemplatesCard({ dark, userId, templates, setTemplates, defaultTplId, onClearDefault, onError, onSaved }) {
  const [editing, setEditing] = useState(null); // null | { id?: uuid, name, start, end, breaks: [] }
  const [busy, setBusy] = useState(false);

  function newTemplate() {
    setEditing({ name: "", start: "", end: "", breaks: [] });
  }
  function edit(t) {
    setEditing({ id: t.id, name: t.name, start: t.start || "", end: t.end || "", breaks: [...(t.breaks || [])] });
  }
  function patch(patchObj) { setEditing((d) => ({ ...d, ...patchObj })); }
  function addBreak() {
    setEditing((d) => ({ ...d, breaks: [...(d.breaks || []), { id: Date.now(), start: "", end: "", unpaid: true }] }));
  }
  function changeBreak(bid, p) {
    setEditing((d) => ({ ...d, breaks: d.breaks.map((b) => b.id === bid ? { ...b, ...p } : b) }));
  }
  function removeBreak(bid) {
    setEditing((d) => ({ ...d, breaks: d.breaks.filter((b) => b.id !== bid) }));
  }

  async function commit() {
    if (!editing.name || !editing.start || !editing.end) return;
    setBusy(true);
    const row = {
      user_id: userId,
      name: editing.name,
      start: editing.start || null,
      end_time: editing.end || null,
      breaks: editing.breaks || [],
    };
    if (editing.id) row.id = editing.id;
    const { data, error } = await supabase.from("templates").upsert(row).select().single();
    setBusy(false);
    if (error) { onError(error.message); return; }
    const saved = { id: data.id, name: data.name, start: data.start || "", end: data.end_time || "", breaks: data.breaks || [] };
    setTemplates((prev) => {
      const existing = prev.find((t) => t.id === saved.id);
      return existing ? prev.map((t) => t.id === saved.id ? saved : t) : [...prev, saved];
    });
    setEditing(null);
    onSaved?.();
  }

  async function remove(id) {
    if (!window.confirm("Delete this template?")) return;
    setBusy(true);
    const { error } = await supabase.from("templates").delete().eq("id", id);
    setBusy(false);
    if (error) { onError(error.message); return; }
    setTemplates((prev) => prev.filter((t) => t.id !== id));
    if (defaultTplId === id) onClearDefault();
    onSaved?.();
  }

  return (
    <SectionCard
      title="Templates"
      hint="Reusable shift presets — name, start, end, and optional breaks."
      dark={dark}
      action={
        !editing && (
          <button
            type="button"
            onClick={newTemplate}
            className="text-xs font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
          >
            + New template
          </button>
        )
      }
    >
      {templates.length === 0 && !editing && (
        <p className={`text-sm ${dark ? "text-slate-400" : "text-slate-500"}`}>
          No templates yet. A template lets you reuse a start/end + break setup with one click on the log form.
        </p>
      )}
      <div className="space-y-2">
        {templates.map((t) => {
          if (editing?.id === t.id) {
            return (
              <TemplateEditor
                key={t.id}
                dark={dark}
                value={editing}
                busy={busy}
                onChange={patch}
                onAddBreak={addBreak}
                onChangeBreak={changeBreak}
                onRemoveBreak={removeBreak}
                onSave={commit}
                onCancel={() => setEditing(null)}
                saveLabel="Update template"
              />
            );
          }
          const breakCount = (t.breaks || []).length;
          return (
            <div
              key={t.id}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${
                dark ? "border-[var(--color-border)] bg-[var(--color-surface-raised)]" : "bg-slate-50 border-slate-200"
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-semibold ${dark ? "text-slate-100" : "text-slate-800"}`}>
                  {t.name}
                </p>
                <p className={`text-[11px] font-mono ${dark ? "text-slate-400" : "text-slate-500"}`}>
                  {toDisplayTime(t.start)} – {toDisplayTime(t.end)}
                  {breakCount > 0 && ` · ${breakCount} break${breakCount > 1 ? "s" : ""}`}
                </p>
              </div>
              {defaultTplId === t.id && (
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-[var(--color-accent-light)] text-[var(--color-accent)]">
                  Default
                </span>
              )}
              <button
                type="button"
                onClick={() => edit(t)}
                className={`text-xs font-semibold px-2 py-1 rounded ${dark ? "text-slate-300 hover:bg-slate-700" : "text-slate-600 hover:bg-slate-100"}`}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => remove(t.id)}
                className={`text-xs px-2 py-1 rounded ${dark ? "text-slate-400 hover:text-red-300" : "text-slate-500 hover:text-red-500"}`}
              >
                Delete
              </button>
            </div>
          );
        })}
        {editing && !editing.id && (
          <TemplateEditor
            dark={dark}
            value={editing}
            busy={busy}
            onChange={patch}
            onAddBreak={addBreak}
            onChangeBreak={changeBreak}
            onRemoveBreak={removeBreak}
            onSave={commit}
            onCancel={() => setEditing(null)}
            saveLabel="Add template"
          />
        )}
      </div>
    </SectionCard>
  );
}

function TemplateEditor({ dark, value, busy, onChange, onAddBreak, onChangeBreak, onRemoveBreak, onSave, onCancel, saveLabel }) {
  return (
    <div className={`rounded-lg border p-3 ${dark ? "border-[var(--color-border)] bg-[var(--color-surface-raised)]" : "bg-white border-slate-200"}`}>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 mb-3 items-end">
        <div>
          <FieldLabel dark={dark}>Name</FieldLabel>
          <Input
            value={value.name || ""}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Regular day"
            className="h-9"
          />
        </div>
        <div>
          <FieldLabel dark={dark}>Start</FieldLabel>
          <TimeSelect value={value.start || ""} onChange={(v) => onChange({ start: v })} />
        </div>
        <div>
          <FieldLabel dark={dark}>End</FieldLabel>
          <TimeSelect value={value.end || ""} onChange={(v) => onChange({ end: v })} />
        </div>
      </div>
      {(value.breaks || []).map((b) => (
        <div
          key={b.id}
          className={`flex items-center gap-2 px-2 py-2 rounded-md mb-2 border ${dark ? "border-[var(--color-border)] bg-[var(--color-bg)]" : "bg-slate-50 border-slate-200"}`}
        >
          <span className={`text-[11px] ${dark ? "text-slate-400" : "text-slate-500"}`}>From</span>
          <TimeSelect value={b.start} onChange={(v) => onChangeBreak(b.id, { start: v })} />
          <span className={`text-[11px] ${dark ? "text-slate-400" : "text-slate-500"}`}>→</span>
          <TimeSelect value={b.end} onChange={(v) => onChangeBreak(b.id, { end: v })} />
          <Checkbox
            id={`tb-${b.id}`}
            checked={b.unpaid}
            onCheckedChange={(v) => onChangeBreak(b.id, { unpaid: !!v })}
            className="border-slate-300 data-[state=checked]:bg-[var(--color-accent)] data-[state=checked]:border-[var(--color-accent)] h-4 w-4"
          />
          <Label htmlFor={`tb-${b.id}`} className={`text-[11px] ${dark ? "text-slate-300" : "text-slate-700"}`}>
            Unpaid
          </Label>
          <button
            type="button"
            onClick={() => onRemoveBreak(b.id)}
            className={`ml-auto text-sm leading-none ${dark ? "text-slate-500 hover:text-red-300" : "text-slate-400 hover:text-red-500"}`}
            aria-label="Remove break"
          >
            ✕
          </button>
        </div>
      ))}
      <div className="flex items-center justify-between mt-2">
        <Button variant="outline" size="sm" onClick={onAddBreak} className="h-7 text-xs">
          + Add break
        </Button>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 text-xs">Cancel</Button>
          <Button
            size="sm"
            onClick={onSave}
            disabled={busy || !value.name || !value.start || !value.end}
            className="h-7 text-xs font-semibold disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "#fff" }}
          >
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Projects: full CRUD ────────────────────────────────────────────

function ProjectsSection({ dark }) {
  const { session, projects, setProjects } = useApp();
  const userId = session?.user?.id;
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savingMsg, setSavingMsg] = useState("");

  function flashSaved() { setSavingMsg("Saved"); setTimeout(() => setSavingMsg(""), 1500); }

  function newProj() {
    setEditing({ name: "", client_name: "", color: PROJECT_COLORS[0] });
  }
  function edit(p) {
    setEditing({ id: p.id, name: p.name, client_name: p.client_name || "", color: p.color || PROJECT_COLORS[0] });
  }

  async function commit() {
    if (!editing?.name) return;
    setBusy(true);
    const row = {
      user_id: userId,
      name: editing.name,
      client_name: editing.client_name || "",
      color: editing.color || PROJECT_COLORS[0],
    };
    if (editing.id) row.id = editing.id;
    const { data, error: err } = await supabase.from("projects").upsert(row).select().single();
    setBusy(false);
    if (err) { setError(err.message); return; }
    setProjects((prev) => {
      const existing = prev.find((p) => p.id === data.id);
      return existing ? prev.map((p) => p.id === data.id ? data : p) : [...prev, data];
    });
    setEditing(null);
    flashSaved();
  }

  async function remove(id) {
    if (!window.confirm("Delete this project? Entries already logged will stay but lose their project link.")) return;
    setBusy(true);
    const { error: err } = await supabase.from("projects").delete().eq("id", id);
    setBusy(false);
    if (err) { setError(err.message); return; }
    setProjects((prev) => prev.filter((p) => p.id !== id));
    flashSaved();
  }

  return (
    <>
      <Toast message={error} dark={dark} tone="err" />
      <Toast message={savingMsg} dark={dark} />

      <SectionCard
        title="Projects"
        hint="Tag time entries by project so you can break down hours and earnings."
        dark={dark}
        action={
          !editing && (
            <button
              type="button"
              onClick={newProj}
              className="text-xs font-semibold text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
            >
              + New project
            </button>
          )
        }
      >
        {projects.length === 0 && !editing && (
          <p className={`text-sm ${dark ? "text-slate-400" : "text-slate-500"}`}>
            No projects yet.
          </p>
        )}
        <div className="space-y-2">
          {projects.map((p) => {
            if (editing?.id === p.id) {
              return (
                <ProjectEditor
                  key={p.id}
                  dark={dark}
                  value={editing}
                  busy={busy}
                  onChange={(patch) => setEditing((d) => ({ ...d, ...patch }))}
                  onSave={commit}
                  onCancel={() => setEditing(null)}
                  saveLabel="Update project"
                />
              );
            }
            return (
              <div
                key={p.id}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${
                  dark ? "border-[var(--color-border)] bg-[var(--color-surface-raised)]" : "bg-slate-50 border-slate-200"
                }`}
              >
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ background: p.color || PROJECT_COLORS[0] }}
                />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-semibold truncate ${dark ? "text-slate-100" : "text-slate-800"}`}>
                    {p.name}
                  </p>
                  {p.client_name && (
                    <p className={`text-[11px] ${dark ? "text-slate-400" : "text-slate-500"}`}>
                      {p.client_name}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => edit(p)}
                  className={`text-xs font-semibold px-2 py-1 rounded ${dark ? "text-slate-300 hover:bg-slate-700" : "text-slate-600 hover:bg-slate-100"}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => remove(p.id)}
                  className={`text-xs px-2 py-1 rounded ${dark ? "text-slate-400 hover:text-red-300" : "text-slate-500 hover:text-red-500"}`}
                >
                  Delete
                </button>
              </div>
            );
          })}
          {editing && !editing.id && (
            <ProjectEditor
              dark={dark}
              value={editing}
              busy={busy}
              onChange={(patch) => setEditing((d) => ({ ...d, ...patch }))}
              onSave={commit}
              onCancel={() => setEditing(null)}
              saveLabel="Add project"
            />
          )}
        </div>
      </SectionCard>
    </>
  );
}

function ProjectEditor({ dark, value, busy, onChange, onSave, onCancel, saveLabel }) {
  return (
    <div className={`rounded-lg border p-3 ${dark ? "border-[var(--color-border)] bg-[var(--color-surface-raised)]" : "bg-white border-slate-200"}`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div>
          <FieldLabel dark={dark}>Project name</FieldLabel>
          <Input
            value={value.name || ""}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Acme Corp"
            className="h-9"
          />
        </div>
        <div>
          <FieldLabel dark={dark}>Client</FieldLabel>
          <Input
            value={value.client_name || ""}
            onChange={(e) => onChange({ client_name: e.target.value })}
            placeholder="e.g. John Smith"
            className="h-9"
          />
        </div>
      </div>
      <div className="mb-3">
        <FieldLabel dark={dark}>Color</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {PROJECT_COLORS.map((c) => {
            const active = value.color === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => onChange({ color: c })}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: c,
                  border: active ? "3px solid var(--color-text)" : "2px solid transparent",
                  cursor: "pointer",
                }}
                aria-label={`Color ${c}`}
                aria-pressed={active}
              />
            );
          })}
        </div>
      </div>
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 text-xs">Cancel</Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={busy || !value.name}
          className="h-7 text-xs font-semibold disabled:opacity-40"
          style={{ background: "var(--color-accent)", color: "#fff" }}
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

// ── Notifications: daily reminder + Google Sheets + browser perm ───

function NotificationsSection({ dark }) {
  const {
    session,
    reminderTime, setReminderTime,
    googleToken, googleTokenExpiry,
    connectGoogleSheets, disconnectGoogleSheets,
    settings, updateSettingsField,
  } = useApp();
  const userId = session?.user?.id;

  const [time, setTime] = useState(reminderTime || "");
  const [error, setError] = useState("");
  const [savingMsg, setSavingMsg] = useState("");
  // Sound effects — per-device (localStorage), so it can differ across devices.
  const [soundOn, setSoundOn] = useState(() => uiSoundsEnabled());
  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    setUiSoundsEnabled(next);
    if (next) playNotify(); // confirm it's audible when turning on
  };
  const [permTick, setPermTick] = useState(0);
  void permTick;

  // Per-type notification prefs (sparse; absence = enabled).
  const [typePrefs, setTypePrefs] = useState({});
  useEffect(() => { listPreferences().then(setTypePrefs); }, []);
  const typeEnabled = (type) => typePrefs[type] !== false;
  const toggleType = async (type) => {
    const next = !typeEnabled(type);
    setTypePrefs((p) => ({ ...p, [type]: next }));
    await setPreferenceEnabled(userId, type, next);
  };

  // Push when the app is closed. Two transports depending on platform:
  //   • native iOS app → APNs alert push (Web Push can't run in the WKWebView)
  //   • web / installed PWA → browser Web Push
  const isNativePush = nativePushSupported();
  const pushSupported = webPushSupported();

  // Native (iOS) alert-push permission.
  const [nativePushStatus, setNativePushStatus] = useState("prompt");
  const [nativeBusy, setNativeBusy] = useState(false);
  useEffect(() => {
    if (isNativePush) getNativePushStatus().then(setNativePushStatus);
  }, [isNativePush]);
  const nativeOn = nativePushStatus === "granted";
  const nativeDenied = nativePushStatus === "denied";
  const enableNative = async () => {
    if (nativeOn || nativeBusy) return;
    if (nativeDenied) {
      setError("Notifications are off for Mangodoro. Turn them on in iOS Settings › Mangodoro › Notifications.");
      return;
    }
    setNativeBusy(true);
    try {
      const { granted, error: err } = await enableNativePush(userId);
      setNativePushStatus(granted ? "granted" : "denied");
      if (granted) flashSaved();
      else if (err) setError(err);
    } catch (e) {
      setError(e?.message || "Couldn't enable notifications.");
    } finally {
      setNativeBusy(false);
    }
  };

  // Browser web-push (notifications delivered even when the app is closed).
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => { isWebPushEnabled().then(setPushOn); }, []);
  const togglePush = async () => {
    setPushBusy(true);
    try {
      if (pushOn) {
        await disableWebPush(userId);
        setPushOn(false);
      } else {
        const { error: err } = await enableWebPush(userId);
        if (err) setError(err);
        else { setPushOn(true); flashSaved(); }
      }
    } catch (e) {
      setError(e?.message || "Couldn't change push setting.");
    } finally {
      setPushBusy(false);
    }
  };

  useEffect(() => { setTime(reminderTime || ""); }, [reminderTime]);

  function flashSaved() { setSavingMsg("Saved"); setTimeout(() => setSavingMsg(""), 1500); }

  async function commitTime(v) {
    if ((v || "") === (reminderTime || "")) return;
    setTime(v || "");
    const { error: err } = await persistUserSettings(userId, { reminder_time: v || null });
    if (err) { setError(err.message); return; }
    setReminderTime(v || "");
    flashSaved();
  }

  const hasNotif = typeof window !== "undefined" && "Notification" in window;
  const granted = hasNotif && Notification.permission === "granted";
  const denied = hasNotif && Notification.permission === "denied";
  async function ask() {
    if (!hasNotif) return;
    await Notification.requestPermission();
    setPermTick((n) => n + 1);
  }

  const googleConnected = googleToken && Date.now() < googleTokenExpiry;

  return (
    <>
      <Toast message={error} dark={dark} tone="err" />
      <Toast message={savingMsg} dark={dark} />

      <SectionCard
        title="Daily reminder"
        hint="Notifies you if no hours have been logged by this time of day."
        dark={dark}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <TimeSelect value={time} onChange={commitTime} />
          {time && (
            <button
              type="button"
              onClick={() => commitTime("")}
              className={`text-xs ${dark ? "text-slate-400 hover:text-red-300" : "text-slate-500 hover:text-red-500"}`}
            >
              Clear
            </button>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Wellbeing reminders"
        hint="Gentle nudges to drink water, move, rest your eyes and more — delivered to your inbox + desktop, only during your active hours."
        dark={dark}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className={dark ? "text-slate-400" : "text-slate-500"}>Active from</span>
            <TimeSelect value={settings?.reminderActiveStart || "09:00"} onChange={(v) => updateSettingsField({ reminderActiveStart: v || null })} />
            <span className={dark ? "text-slate-400" : "text-slate-500"}>to</span>
            <TimeSelect value={settings?.reminderActiveEnd || "17:00"} onChange={(v) => updateSettingsField({ reminderActiveEnd: v || null })} />
          </div>
          <div className={`flex flex-col rounded-xl border divide-y ${dark ? "border-[var(--color-border)] divide-[var(--color-border)]" : "border-slate-200 divide-slate-100"}`}>
            {REMINDERS.map((r) => {
              const cfg = reminderConfig(settings?.wellbeingReminders, r.key);
              const set = (patch) => updateSettingsField({
                wellbeingReminders: { ...(settings?.wellbeingReminders || {}), [r.key]: { on: cfg.on, every: cfg.every, ...patch } },
              });
              return (
                <div key={r.key} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="text-lg leading-none">{r.emoji}</span>
                  <span className={`flex-1 text-sm font-medium ${dark ? "text-slate-200" : "text-slate-700"}`}>{r.label}</span>
                  {cfg.on && (
                    <select
                      value={cfg.every}
                      onChange={(e) => set({ every: Number(e.target.value) })}
                      className={`rounded-lg px-2 py-1 text-xs border ${dark ? "bg-[var(--color-surface)] border-[var(--color-border)] text-slate-200" : "bg-white border-slate-200 text-slate-700"}`}
                    >
                      {REMINDER_INTERVALS.map((m) => <option key={m} value={m}>every {m} min</option>)}
                    </select>
                  )}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={cfg.on}
                    onClick={() => set({ on: !cfg.on })}
                    className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${cfg.on ? "bg-[var(--color-accent)]" : dark ? "bg-slate-600" : "bg-slate-300"}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${cfg.on ? "translate-x-4" : ""}`} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Browser notifications"
        hint="So you know when a teammate starts a session or a timer ends."
        dark={dark}
      >
        {granted ? (
          <p className={`inline-flex items-center gap-1.5 text-sm ${dark ? "text-emerald-300" : "text-emerald-700"}`}>
            <Check className="w-4 h-4" /> Enabled
          </p>
        ) : denied ? (
          <p className={`text-sm ${dark ? "text-slate-400" : "text-slate-500"}`}>
            Blocked by your browser. Re-enable from the site settings (lock icon in the address bar).
          </p>
        ) : (
          <Button onClick={ask} variant="outline" size="sm">
            <Bell className="w-3.5 h-3.5 mr-1.5" /> Allow notifications
          </Button>
        )}
      </SectionCard>

      {isNativePush ? (
        <SectionCard
          title="Push when the app is closed"
          hint={
            nativeDenied
              ? "Notifications are off for Mangodoro. Turn them on in iOS Settings › Mangodoro › Notifications."
              : "Get mentions, knocks, and reminders on this device even when the app is closed."
          }
          dark={dark}
        >
          <button
            type="button"
            role="switch"
            aria-checked={nativeOn}
            disabled={nativeBusy || nativeOn}
            onClick={enableNative}
            className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${nativeOn ? "bg-[var(--color-accent)]" : dark ? "bg-slate-600" : "bg-slate-300"} ${nativeBusy ? "opacity-50" : ""}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${nativeOn ? "translate-x-4" : ""}`} />
          </button>
        </SectionCard>
      ) : pushSupported ? (
        <SectionCard
          title="Push when the app is closed"
          hint="Also get notifications on this device when Mangodoro isn't open in a tab (uses the browser's push service)."
          dark={dark}
        >
          <button
            type="button"
            role="switch"
            aria-checked={pushOn}
            disabled={pushBusy}
            onClick={togglePush}
            className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${pushOn ? "bg-[var(--color-accent)]" : dark ? "bg-slate-600" : "bg-slate-300"} ${pushBusy ? "opacity-50" : ""}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${pushOn ? "translate-x-4" : ""}`} />
          </button>
        </SectionCard>
      ) : null}

      <SectionCard
        title="What to notify me about"
        hint="Per-type switches. Awareness pings reach your team by default; turn off any you don't want."
        dark={dark}
      >
        <div className="flex flex-col">
          {NOTIFICATION_TYPES.map((t, i) => {
            const on = typeEnabled(t.type);
            return (
              <div
                key={t.type}
                className={`flex items-center justify-between gap-3 py-2.5 ${i > 0 ? "border-t" : ""}`}
                style={{ borderColor: dark ? "var(--color-border)" : "rgb(241,245,249)" }}
              >
                <div className="min-w-0">
                  <div className={`text-sm font-semibold ${dark ? "text-slate-200" : "text-slate-700"}`}>{t.label}</div>
                  <div className={`text-xs ${dark ? "text-slate-400" : "text-slate-500"}`}>{t.description}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => toggleType(t.type)}
                  className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${on ? "bg-[var(--color-accent)]" : dark ? "bg-slate-600" : "bg-slate-300"}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
                </button>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        title="Quiet hours"
        hint="During quiet hours, desktop pop-ups are silenced — your inbox still collects everything."
        dark={dark}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={settings?.notifDesktopEnabled !== false}
              onClick={() => updateSettingsField({ notifDesktopEnabled: !(settings?.notifDesktopEnabled !== false) })}
              className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${settings?.notifDesktopEnabled !== false ? "bg-[var(--color-accent)]" : dark ? "bg-slate-600" : "bg-slate-300"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${settings?.notifDesktopEnabled !== false ? "translate-x-4" : ""}`} />
            </button>
            <span className={`text-sm font-semibold ${dark ? "text-slate-200" : "text-slate-700"}`}>Desktop pop-up notifications</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className={dark ? "text-slate-400" : "text-slate-500"}>Quiet from</span>
            <TimeSelect value={settings?.notifQuietStart || ""} onChange={(v) => updateSettingsField({ notifQuietStart: v || null })} />
            <span className={dark ? "text-slate-400" : "text-slate-500"}>to</span>
            <TimeSelect value={settings?.notifQuietEnd || ""} onChange={(v) => updateSettingsField({ notifQuietEnd: v || null })} />
            {(settings?.notifQuietStart || settings?.notifQuietEnd) && (
              <button
                type="button"
                onClick={() => updateSettingsField({ notifQuietStart: null, notifQuietEnd: null })}
                className={`text-xs ${dark ? "text-slate-400 hover:text-red-300" : "text-slate-500 hover:text-red-500"}`}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Sound effects"
        hint="Play a short sound for notifications, new chat messages, and raised hands in a call. Applies to this device only."
        dark={dark}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={soundOn}
              onClick={toggleSound}
              className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${soundOn ? "bg-[var(--color-accent)]" : dark ? "bg-slate-600" : "bg-slate-300"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${soundOn ? "translate-x-4" : ""}`} />
            </button>
            <span className={`text-sm font-semibold ${dark ? "text-slate-200" : "text-slate-700"}`}>Play sound effects</span>
          </div>
          {soundOn && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs ${dark ? "text-slate-400" : "text-slate-500"}`}>Preview:</span>
              {[
                { label: "Notification", fn: playNotify },
                { label: "Message", fn: playMessage },
                { label: "Raised hand", fn: playHandRaise },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => p.fn()}
                  className={`text-xs font-medium px-2.5 py-1 rounded-full border ${dark ? "border-[var(--color-border)] text-slate-300 hover:bg-white/5" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Google Sheets"
        hint="Connect to export months directly to a new Google Sheet from the Overview page."
        dark={dark}
      >
        {googleConnected ? (
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 text-sm ${dark ? "text-emerald-300" : "text-emerald-700"}`}>
              <Check className="w-4 h-4" /> Connected
            </span>
            <button
              type="button"
              onClick={disconnectGoogleSheets}
              className={`text-xs ${dark ? "text-slate-400 hover:text-red-300" : "text-slate-500 hover:text-red-500"}`}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <Button onClick={connectGoogleSheets} variant="outline" size="sm">
            Connect Google Sheets
          </Button>
        )}
      </SectionCard>
    </>
  );
}

// ── Data: exports + invoice + imports ──────────────────────────────

function AboutSection({ dark }) {
  const latest = latestEntryId();
  const { settings, setHintsDisabled } = useApp();
  const hintsOn = !settings?.onboarding?.hintsDisabled;
  return (
    <SectionCard title="About" hint="App version and recent changes." dark={dark}>
      <div className="space-y-4">
        <div className="text-sm">
          <div className={`font-semibold ${dark ? "text-slate-200" : "text-slate-800"}`}>Mangodoro</div>
          <div className={`text-xs ${dark ? "text-slate-500" : "text-slate-400"}`}>
            Version {appVersion || "—"}{latest ? ` · Latest update ${latest}` : ""}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={openWhatsNew} variant="outline" size="sm">
            <Sparkles className="w-3.5 h-3.5 mr-1.5" /> What&rsquo;s new
          </Button>
          <Button onClick={openHelpCenter} variant="outline" size="sm">
            <GraduationCap className="w-3.5 h-3.5 mr-1.5" /> Learn Mangodoro
          </Button>
        </div>

        {/* Master switch for the proactive onboarding hints. Off silences the
            welcome modal, "take a tour?" offers, new-feature nudges, and the
            getting-started checklist — the tutorials above stay available. */}
        <div className={`flex items-start gap-3 pt-1 border-t ${dark ? "border-[var(--color-border-light)]" : "border-slate-100"}`}>
          <button
            type="button"
            role="switch"
            aria-checked={hintsOn}
            aria-label="Show onboarding hints"
            onClick={() => setHintsDisabled(hintsOn)}
            className={`relative shrink-0 mt-3 w-10 h-6 rounded-full transition-colors ${hintsOn ? "bg-[var(--color-accent)]" : dark ? "bg-slate-600" : "bg-slate-300"}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${hintsOn ? "translate-x-4" : ""}`} />
          </button>
          <div className="pt-1.5">
            <div className={`text-sm font-medium ${dark ? "text-slate-200" : "text-slate-700"}`}>Show onboarding hints &amp; tips</div>
            <div className={`text-xs mt-0.5 ${dark ? "text-slate-500" : "text-slate-400"}`}>
              The welcome tour offer, feature nudges, and the getting-started checklist. Turn off for a quieter app — you can still replay any tutorial from Learn Mangodoro.
            </div>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

function DataSection({ dark }) {
  const {
    exportAllXLSX, exportProfile,
    setShowInvoice,
    importEntriesFromFile, importProfileFromFile,
  } = useApp();
  const entriesRef = useRef(null);
  const profileRef = useRef(null);

  function pickEntries() { entriesRef.current?.click(); }
  function pickProfile() { profileRef.current?.click(); }

  function onEntriesChange(e) {
    const file = e.target.files?.[0];
    if (file) importEntriesFromFile(file);
    e.target.value = "";
  }
  function onProfileChange(e) {
    const file = e.target.files?.[0];
    if (file) importProfileFromFile(file);
    e.target.value = "";
  }

  return (
    <>
      <SectionCard title="Export" hint="Download a full backup of your time entries or your account profile." dark={dark}>
        <div className="flex flex-wrap gap-2">
          <Button onClick={exportAllXLSX} variant="outline" size="sm">
            <Sparkles className="w-3.5 h-3.5 mr-1.5" /> All entries (XLSX)
          </Button>
          <Button onClick={() => setShowInvoice(true)} variant="outline" size="sm">
            <FileText className="w-3.5 h-3.5 mr-1.5" /> Generate invoice (PDF)
          </Button>
          <Button onClick={exportProfile} variant="outline" size="sm">
            <Download className="w-3.5 h-3.5 mr-1.5" /> Profile (JSON)
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Import"
        hint="Restore from a previous backup. Imports merge — they don't replace existing data."
        dark={dark}
      >
        <div className="flex flex-wrap gap-2">
          <Button onClick={pickEntries} variant="outline" size="sm">
            <Upload className="w-3.5 h-3.5 mr-1.5" /> Load entries.json…
          </Button>
          <Button onClick={pickProfile} variant="outline" size="sm">
            <Upload className="w-3.5 h-3.5 mr-1.5" /> Load profile.json…
          </Button>
        </div>
        {/* Hidden file inputs — previously hosted by LogPage; on the
            Settings page we own them locally so import works without
            navigating to /log first. */}
        <input
          ref={entriesRef}
          type="file"
          accept=".json"
          style={{ display: "none" }}
          onChange={onEntriesChange}
        />
        <input
          ref={profileRef}
          type="file"
          accept=".json"
          style={{ display: "none" }}
          onChange={onProfileChange}
        />
      </SectionCard>
    </>
  );
}
