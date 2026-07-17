import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../supabase";
import {
  isUUID, normalizeEntry, normalizeTemplate, normalizeSettings, normalizeTime,
  calcWorked, roundTimeStr, currentTimeStr, todayStr, weekStart,
  makeEmptyForm, formatDuration, formatDecimal, formatMoney, formatMonthLabel,
  weekRangeLabel, toDisplayTime, downloadFile, unpaidBreakMins,
  formatClockNotes,
} from "../lib/utils";
import {
  startTaskSegment, stopTaskSegment, updateOpenTaskSegment,
  linkSegmentsToEntry, fetchCurrentTaskSegment,
} from "../lib/taskSegments";
import { uploadUserSound, deleteCustomSound } from "../lib/customSound";
import { emailDomain, isLikelyCompanyEvent, googleRawToCompanyCandidate } from "../lib/calendar";

const AppContext = createContext(null);

export function AppProvider({ session, children }) {
  // ── Data state ───────────────────────────────────────────────
  const [entries, setEntries] = useState([]);
  const [projects, setProjects] = useState([]);
  const [settings, setSettings] = useState({});
  const [templates, setTemplates] = useState([]);
  /** True while main Supabase data fetch is in flight — non-blocking; use for subtle UI only. */
  const [dataSyncing, setDataSyncing] = useState(false);
  /**
   * True after the first non-retried load completes for the current user.
   * Pages use this to distinguish "still loading on first render" (show
   * skeleton) from "loaded and the user genuinely has no data yet" (show
   * empty state).
   */
  const [dataLoaded, setDataLoaded] = useState(false);
  // Guards a single retry when an initial fetch returns suspiciously empty
  // (all collections empty AND a cached marker says we previously loaded
  // data for this user). Reset after every successful non-empty load.
  const emptyRetriedRef = useRef(false);
  const [hourlyRate, setHourlyRate] = useState(0);
  const [deepseekKey, setDeepseekKey] = useState("");
  const [reminderTime, setReminderTime] = useState("");
  const [timeRounding, setTimeRounding] = useState("none");
  const [dailyTarget, setDailyTarget] = useState(0);
  const [weeklyTarget, setWeeklyTarget] = useState(0);
  const [defaultEntryMode, setDefaultEntryMode] = useState("manual");
  const [defaultLandingPage, setDefaultLandingPage] = useState("pomodoro");
  const [stickyColor, setStickyColor] = useState("#fde68a");

  // ── UI state ─────────────────────────────────────────────────
  const [form, setForm] = useState(() => makeEmptyForm());
  const [exportMsg, setExportMsg] = useState("");
  const [localImportBanner, setLocalImportBanner] = useState(null);
  const importEntriesRef = useRef(null);
  const importProfileRef = useRef(null);
  const logHoursRef = useRef(null);
  const dateInputRef = useRef(null);

  // ── Clock in state ───────────────────────────────────────────
  const [clockIn, setClockIn] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem("ql_clock_in") || "null");
      return v?.start ? v : null; // guard against stale { stopped: true } sentinel in localStorage
    } catch { return null; }
  });
  const [clockedTick, setClockedTick] = useState(0);
  const [pendingEntry, setPendingEntry] = useState(null);
  // Currently open task segment (during a clock-in session). Null when
  // not clocked in or hasn't been seeded yet. {id, description, started_at}.
  const [currentTask, setCurrentTask] = useState(null);
  const clockInRef = useRef(null);
  const clockInSyncTimer = useRef(null);
  const clockInFromDBRef = useRef(false); // true when setClockIn came from a DB poll — skip write-back

  // ── Settings modal state ─────────────────────────────────────
  const [showSettings, setShowSettings] = useState(false);
  const [draftSettings, setDraftSettings] = useState({});
  const [draftTemplates, setDraftTemplates] = useState([]);
  const [draftNewTemplate, setDraftNewTemplate] = useState(null);
  const [draftEditingId, setDraftEditingId] = useState(null);
  const [draftEditingTemplate, setDraftEditingTemplate] = useState(null);
  const [draftProjects, setDraftProjects] = useState([]);
  const [draftNewProject, setDraftNewProject] = useState(null);
  const [draftEditingProjectId, setDraftEditingProjectId] = useState(null);

  // ── Entry list state ─────────────────────────────────────────
  const [inlineEditId, setInlineEditId] = useState(null);
  const [inlineForm, setInlineForm] = useState(null);
  const [sortAsc, setSortAsc] = useState(false);
  const [expandedDates, setExpandedDates] = useState(() => new Set([todayStr()]));
  const [earningsPeriod, setEarningsPeriod] = useState("week");
  const [monthSummaries, setMonthSummaries] = useState({});
  const [rewritingDesc, setRewritingDesc] = useState(false);

  // ── Google Sheets ────────────────────────────────────────────
  const [googleToken, setGoogleToken] = useState(null);
  const [googleTokenExpiry, setGoogleTokenExpiry] = useState(0);
  const googleRefreshingRef = useRef(false); // de-dupe concurrent refreshes
  // Always-current mirrors so a just-refreshed token is visible to an in-flight
  // API call in the same tick (state updates only land next render).
  const googleTokenRef = useRef(null);
  const googleTokenExpiryRef = useRef(0);
  googleTokenRef.current = googleToken;
  googleTokenExpiryRef.current = googleTokenExpiry;

  // ── Invoice modal ────────────────────────────────────────────
  const [showInvoice, setShowInvoice] = useState(false);

  // ── Load data ────────────────────────────────────────────────
  // Defined as a useCallback so the self-heal effect below can call it
  // when the auth token refreshes (covers the cold-load case where the
  // initial fetch raced an unwarm access token and RLS returned nothing).
  const loadData = useCallback(async () => {
    if (!session) return;
    setDataSyncing(true);
    try {
      // entries + projects are scoped to the signed-in user. We used to
      // rely on RLS alone, but the "Team admins can read member entries"
      // policy (added in 20260519140000) intentionally lets admins read
      // any teammate's rows from the *admin* timesheet view — without
      // an explicit user_id filter here, that policy also let admins
      // see teammates' rows on their own /time-tracker page. The admin
      // view at /team/timesheets uses fetchMemberEntries, which is
      // unaffected.
      const [entriesRes, templatesRes, settingsRes, projectsRes] = await Promise.all([
        supabase.from("entries").select("*").eq("user_id", session.user.id).order("date", { ascending: false }),
        supabase.from("templates").select("*").order("created_at"),
        supabase.from("user_settings").select("*").eq("user_id", session.user.id).maybeSingle(),
        supabase.from("projects").select("*").eq("user_id", session.user.id).order("created_at"),
      ]);

      // Auth race-guard. On a fresh page load (or laptop-lid wake) the
      // access token isn't always warm yet — RLS evaluates auth.uid() to
      // null and silently returns 0 rows for *everything*. If localStorage
      // hints we've successfully loaded data for this user before, treat
      // the all-empty result as transient and retry once before clobbering
      // settings/entries/projects/templates with empty defaults. Otherwise
      // a returning user briefly sees hourly rate $0, no projects, no
      // entries, etc., until something refires the load.
      const loadHintKey = `ql_data_loaded:${session.user.id}`;
      const hadDataBefore = (() => {
        try { return localStorage.getItem(loadHintKey) === "1"; } catch { return false; }
      })();
      const everythingEmpty =
        (entriesRes.data ?? []).length === 0
        && (templatesRes.data ?? []).length === 0
        && (projectsRes.data ?? []).length === 0
        && !settingsRes.data;
      if (everythingEmpty && hadDataBefore && !emptyRetriedRef.current) {
        emptyRetriedRef.current = true;
        setDataSyncing(false);
        setTimeout(() => loadData(), 600);
        return;
      }

      // Sync clock-in state from DB (handles cross-device tracking). The DB is
      // authoritative for an ACTIVE clock and for an EXPLICIT stop:
      //   • active clock  → adopt it (refresh / other device clocked in).
      //   • { stopped:true } → CLEAR any stale local clock. This is the fix for
      //     "clock out on one device, the others auto-restart": a device that was
      //     closed during the clock-out reopens with a stale localStorage clock;
      //     without this it kept that clock and its write-back effect re-wrote it
      //     to the DB, undoing the clock-out everywhere.
      //   • null → ambiguous (this device may just not have synced yet); keep
      //     local so an offline clock-in isn't lost — visibilitychange reconciles.
      const dbClock = settingsRes.data?.active_clock ?? null;
      if (dbClock && !dbClock.stopped) {
        clockInFromDBRef.current = true;
        setClockIn(dbClock);
        localStorage.setItem("ql_clock_in", JSON.stringify(dbClock));
        // Restore the open task segment too — survives refresh /
        // cross-device because it lives in Postgres.
        fetchCurrentTaskSegment().then(({ data: seg }) => {
          if (seg) setCurrentTask({ id: seg.id, description: seg.description, started_at: seg.started_at });
        }).catch((e) => console.warn("fetchCurrentTaskSegment:", e?.message || e));
      } else if (dbClock?.stopped === true) {
        clockInFromDBRef.current = true;
        setClockIn(null);
        try { localStorage.removeItem("ql_clock_in"); } catch { /* */ }
      }
      const loadedTemplates = (templatesRes.data ?? []).map(normalizeTemplate);
      const loadedSettings = settingsRes.data ? normalizeSettings(settingsRes.data) : {};
      const loadedEntries = (entriesRes.data ?? []).map(normalizeEntry);
      const loadedProjects = projectsRes.data ?? [];
      setTemplates(loadedTemplates);
      setSettings(loadedSettings);
      setEntries(loadedEntries);
      setProjects(loadedProjects);
      setHourlyRate(settingsRes.data?.hourly_rate ?? 0);
      setDeepseekKey(settingsRes.data?.deepseek_key ?? "");
      setReminderTime(normalizeTime(settingsRes.data?.reminder_time ?? ""));
      setTimeRounding(settingsRes.data?.time_rounding || "none");
      setDailyTarget(settingsRes.data?.daily_target ?? 0);
      setWeeklyTarget(settingsRes.data?.weekly_target ?? 0);
      setDefaultEntryMode(settingsRes.data?.default_entry_mode || "manual");
      const landing = settingsRes.data?.default_landing_page === "log" ? "log" : "pomodoro";
      setDefaultLandingPage(landing);
      // Synced to localStorage so the `/` redirect in App.jsx can decide
      // where to send the user *before* the AppContext fetch resolves.
      try { localStorage.setItem("ql_default_landing", landing); } catch { /* ignore */ }
      setStickyColor(settingsRes.data?.sticky_color || "#fde68a");

      // One-time migration: if the legacy single-sound fields are set
      // but the multi-sound list is empty, fold the legacy sound into
      // the list so the picker shows it. The legacy columns stay until
      // the next release for safety.
      const customs = Array.isArray(settingsRes.data?.custom_sounds) ? settingsRes.data.custom_sounds : [];
      const legacyUrl = settingsRes.data?.pomodoro_sound_url;
      const legacyName = settingsRes.data?.pomodoro_sound_name;
      if (customs.length === 0 && legacyUrl) {
        const migrated = [{
          id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `s${Date.now().toString(36)}`,
          name: legacyName || "My sound",
          url: legacyUrl,
          path: "", // unknown — old uploads predate path tracking
        }];
        await supabase.from("user_settings").upsert({
          user_id: session.user.id,
          custom_sounds: migrated,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });
        setSettings((prev) => ({ ...prev, customSounds: migrated }));
      }
      // Prefer provider_token from OAuth redirect over stale DB value
      if (session?.provider_token) {
        const expiry = Date.now() + 3500 * 1000;
        setGoogleToken(session.provider_token);
        setGoogleTokenExpiry(expiry);
        await supabase.from("user_settings").upsert({
          user_id: session.user.id,
          google_access_token: session.provider_token,
          google_token_expiry: expiry,
        }, { onConflict: "user_id" });
        // Capture the long-lived refresh token (offline access) so we can mint
        // fresh access tokens server-side (google-token edge fn) instead of
        // making the user re-consent every hour. Stored write-only (RLS).
        if (session.provider_refresh_token) {
          supabase.from("google_oauth_tokens").upsert({
            user_id: session.user.id,
            refresh_token: session.provider_refresh_token,
            updated_at: new Date().toISOString(),
          }, { onConflict: "user_id" }).then(({ error }) => {
            if (error) console.warn("store google refresh token:", error.message);
          });
        }
      } else {
        setGoogleToken(settingsRes.data?.google_access_token ?? null);
        setGoogleTokenExpiry(settingsRes.data?.google_token_expiry ?? 0);
      }
      setForm(makeEmptyForm(loadedSettings, loadedTemplates));
      try {
        const oldEntries = JSON.parse(localStorage.getItem("worklog_entries_v2") || "[]");
        if (oldEntries.length > 0 && (entriesRes.data ?? []).length === 0) {
          setLocalImportBanner({ count: oldEntries.length });
        }
      } catch { /* ignore */ }

      // Mark this user as having a known-good load so a future cold load
      // can recognise the transient-empty case.
      if (!everythingEmpty) {
        emptyRetriedRef.current = false;
        try { localStorage.setItem(loadHintKey, "1"); } catch { /* ignore */ }
      }
      setDataLoaded(true);
    } finally {
      setDataSyncing(false);
    }
  }, [session]);

  useEffect(() => { loadData(); }, [loadData]);

  // Self-heal: refire the data load when supabase finishes restoring or
  // refreshing the session token. Catches the case where the initial cold
  // fetch was sent before the access token was fully attached and RLS
  // returned an empty set.
  useEffect(() => {
    if (!session?.user?.id) return;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") loadData();
    });
    return () => subscription.unsubscribe();
  }, [session?.user?.id, loadData]);

  // ── Reminder notifications ───────────────────────────────────
  useEffect(() => {
    if (!reminderTime || !session) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const checkReminder = () => {
      const now = new Date();
      const [rh, rm] = reminderTime.split(":").map(Number);
      const reminderDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), rh, rm, 0);
      const todayLogged = entries.some((e) => e.date === todayStr());
      const alreadyNotifiedKey = `ql_notified_${todayStr()}`;
      if (now >= reminderDate && !todayLogged && !localStorage.getItem(alreadyNotifiedKey)) {
        new Notification("Mangodoro reminder", {
          body: "You haven't logged any hours today. Tap to open.",
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          tag: "daily-reminder",
        });
        localStorage.setItem(alreadyNotifiedKey, "1");
      }
    };
    checkReminder();
    const interval = setInterval(checkReminder, 60_000);
    return () => clearInterval(interval);
  }, [reminderTime, session, entries]);

  // ── Sync active clock to DB (only for active sessions — clock-out is handled explicitly) ──
  useEffect(() => {
    clockInRef.current = clockIn;
    if (!session?.user?.id) return;
    if (clockInFromDBRef.current) {
      clockInFromDBRef.current = false;
      return;
    }
    if (!clockIn) return; // clock-out writes { stopped: true } explicitly in handleClockOut
    if (clockInSyncTimer.current) clearTimeout(clockInSyncTimer.current);
    clockInSyncTimer.current = setTimeout(async () => {
      await supabase.from("user_settings").update({ active_clock: clockIn }).eq("user_id", session.user.id);
    }, 0);
    return () => { if (clockInSyncTimer.current) clearTimeout(clockInSyncTimer.current); };
  }, [clockIn, session?.user?.id]);

  // ── Real-time clock sync (cross-device) ──
  // Supabase Realtime pushes clock state instantly. visibilitychange is a reconnection fallback.
  // { stopped: true } sentinel means explicit clock-out (vs null = not yet synced).
  useEffect(() => {
    if (!session?.user?.id) return;

    function applyRemoteClock(dbClock) {
      const localClock = clockInRef.current;
      if (dbClock?.stopped === true) {
        if (localClock !== null) {
          clockInFromDBRef.current = true;
          setClockIn(null);
          localStorage.removeItem("ql_clock_in");
        }
      } else if (dbClock !== null && JSON.stringify(dbClock) !== JSON.stringify(localClock)) {
        clockInFromDBRef.current = true;
        setClockIn(dbClock);
        localStorage.setItem("ql_clock_in", JSON.stringify(dbClock));
      }
    }

    // Fallback: re-sync on tab focus (e.g. after laptop lid close/open)
    async function syncFromDB() {
      const { data } = await supabase.from("user_settings").select("active_clock").eq("user_id", session.user.id).maybeSingle();
      applyRemoteClock(data?.active_clock ?? null);
      // Refresh the open task too — another tab may have switched it.
      fetchCurrentTaskSegment().then(({ data: seg }) => {
        setCurrentTask(seg ? { id: seg.id, description: seg.description, started_at: seg.started_at } : null);
      }).catch((e) => console.warn("fetchCurrentTaskSegment:", e?.message || e));
    }
    function onVisible() { if (!document.hidden) syncFromDB(); }
    document.addEventListener("visibilitychange", onVisible);

    // Realtime subscription — instant cross-device sync
    const channel = supabase
      .channel(`clock:${session.user.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "user_settings", filter: `user_id=eq.${session.user.id}` },
        (payload) => {
          applyRemoteClock(payload.new?.active_clock ?? null);
          // Also pick up status-message changes from other devices.
          const row = payload.new;
          if (row && typeof row === "object") {
            setSettings((prev) => ({
              ...prev,
              status: row.status ?? prev.status ?? "",
              statusUpdatedAt: row.status_updated_at ?? prev.statusUpdatedAt ?? null,
              avatarUrl: row.avatar_url ?? prev.avatarUrl ?? "",
              name: row.name ?? prev.name ?? "",
              pomodoroSoundUrl: row.pomodoro_sound_url ?? prev.pomodoroSoundUrl ?? "",
              pomodoroSoundName: row.pomodoro_sound_name ?? prev.pomodoroSoundName ?? "",
              worldClockPersonal: Array.isArray(row.world_clock_personal) ? row.world_clock_personal : (prev.worldClockPersonal ?? []),
              navPinnedTz: row.nav_pinned_tz ?? prev.navPinnedTz ?? "",
              onboarding: (row.onboarding && typeof row.onboarding === "object") ? row.onboarding : (prev.onboarding ?? {}),
            }));
          }
        }
      )
      .subscribe();

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      supabase.removeChannel(channel);
    };
  }, [session?.user?.id]);

  // ── Fire-and-forget status-MESSAGE setter usable from anywhere in the app ──
  // Availability lives on user_presence (the resolver); this only carries the
  // free-text status message shown on org/profile surfaces (user_settings.status).
  const updateStatus = useCallback(async ({ status } = {}) => {
    if (!session?.user?.id || status == null) return;
    const stamp = new Date().toISOString();
    // Optimistic update so the UI reflects the change instantly.
    setSettings((prev) => ({ ...prev, status, statusUpdatedAt: stamp }));
    const { error } = await supabase
      .from("user_settings")
      .update({ status, status_updated_at: stamp })
      .eq("user_id", session.user.id);
    if (error) console.warn("update status:", error.message);
  }, [session?.user?.id]);

  // ── Capture Google provider_token when user was already signed in ──
  // loadData only runs on user ID change. After the Sheets OAuth redirect
  // the user ID is unchanged, so we need this separate effect.
  useEffect(() => {
    if (!session?.provider_token || !session?.user?.id) return;
    const expiry = Date.now() + 3500 * 1000;
    setGoogleToken(session.provider_token);
    setGoogleTokenExpiry(expiry);
    supabase.from("user_settings").upsert({
      user_id: session.user.id,
      google_access_token: session.provider_token,
      google_token_expiry: expiry,
    }, { onConflict: "user_id" }).then(({ error }) => {
      if (error) console.warn("save google token:", error.message);
    });
  }, [session?.provider_token]);

  // ── Clock tick ───────────────────────────────────────────────
  useEffect(() => {
    if (!clockIn) return;
    const t = setInterval(() => setClockedTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [clockIn]);

  // ── Clock in/out ─────────────────────────────────────────────
  function handleClockIn(startOverride, taskDescription) {
    const raw = startOverride || currentTimeStr();
    const start = roundTimeStr(raw, timeRounding, startOverride ? "nearest" : "down");
    const data = {
      start, date: todayStr(),
      description: taskDescription || "",
      projectIds: [], billable: true, breaks: [], activeBreak: null,
    };
    localStorage.setItem("ql_clock_in", JSON.stringify(data));
    setClockIn(data);
    if (session?.user?.id) {
      supabase.from("user_settings").update({ active_clock: data }).eq("user_id", session.user.id).then(({ error }) => {
        if (error) console.warn("sync active_clock:", error.message);
      });
      // Open the first task segment for this clock-in. Empty description
      // is fine — the user can name it after the fact via switchTask.
      startTaskSegment(taskDescription || "").then(({ data: id }) => {
        if (id) setCurrentTask({ id, description: taskDescription || "", started_at: new Date().toISOString() });
      });
    }
  }

  function updateClockIn(fields) {
    setClockIn((prev) => {
      const updated = { ...prev, ...fields };
      localStorage.setItem("ql_clock_in", JSON.stringify(updated));
      return updated;
    });
  }

  // Append a per-pomodoro reflection to the running day-log + keep `description`
  // pointed at the latest (so presence/work_status shows the current focus). The
  // accumulated `notes` become the entry's description at clock-out.
  function addClockNote(note) {
    if (!note?.text?.trim()) return;
    setClockIn((prev) => {
      if (!prev) return prev;
      const entry = { at: new Date().toISOString(), text: note.text.trim(), status: note.status || null };
      const updated = { ...prev, notes: [...(prev.notes || []), entry], description: entry.text };
      localStorage.setItem("ql_clock_in", JSON.stringify(updated));
      return updated;
    });
  }

  // `meta` lets a caller mark the break paid/unpaid + tag its kind (e.g. the
  // quick "On lunch" button passes { unpaid: !lunchBreakPaid, kind: "lunch" }).
  function startClockBreak(meta) {
    updateClockIn({ activeBreak: { start: currentTimeStr(), ...(meta || {}) } });
  }

  function endClockBreak() {
    setClockIn((prev) => {
      if (!prev?.activeBreak) return prev;
      const ab = prev.activeBreak;
      const newBreak = { id: Date.now().toString(), start: ab.start, end: currentTimeStr(), unpaid: ab.unpaid ?? true, ...(ab.kind ? { kind: ab.kind } : {}) };
      const updated = { ...prev, breaks: [...(prev.breaks || []), newBreak], activeBreak: null };
      localStorage.setItem("ql_clock_in", JSON.stringify(updated));
      return updated;
    });
  }

  // Returns prefilled form values on clock-out (does NOT save to DB)
  function handleClockOut() {
    if (!clockIn) return null;
    const raw = currentTimeStr();
    const end = roundTimeStr(raw, timeRounding, "up");
    let breaks = clockIn.breaks || [];
    // Auto-end any active break
    if (clockIn.activeBreak) {
      const ab = clockIn.activeBreak;
      breaks = [...breaks, { id: Date.now().toString(), start: ab.start, end: currentTimeStr(), unpaid: ab.unpaid ?? true, ...(ab.kind ? { kind: ab.kind } : {}) }];
    }
    const minutes = calcWorked(clockIn.start, end, breaks);
    // Capture the clock-in moment so we can link only this session's
    // segments to the entry once it's saved (rather than every
    // unlinked segment in the user's history).
    const sessionStartIso = (() => {
      try {
        return new Date(`${clockIn.date}T${clockIn.start}:00`).toISOString();
      } catch { return null; }
    })();
    const prefilled = {
      date: clockIn.date,
      start: clockIn.start,
      end,
      minutes,
      // The day's accumulated pomodoro notes become the entry description (one
      // bullet per focus block); fall back to the single description if none.
      description: (clockIn.notes && clockIn.notes.length)
        ? formatClockNotes(clockIn.notes)
        : (clockIn.description || ""),
      breaks,
      projectIds: clockIn.projectIds || [],
      billable: clockIn.billable !== false,
      _sessionStartIso: sessionStartIso,
    };
    localStorage.removeItem("ql_clock_in");
    setClockIn(null);
    if (session?.user?.id) {
      supabase.from("user_settings").update({ active_clock: { stopped: true } }).eq("user_id", session.user.id).then(({ error }) => {
        if (error) console.warn("sync active_clock:", error.message);
      });
      // Close the open segment immediately so its ended_at reflects
      // the actual clock-out time rather than the form-submit time.
      stopTaskSegment().catch(() => {});
      setCurrentTask(null);
    }
    return prefilled;
  }

  // Human elapsed time since a same-day "HH:MM" start.
  function elapsedSince(startStr) {
    if (!startStr) return "";
    const [sh, sm] = startStr.split(":").map(Number);
    const now = new Date();
    const diff = now.getHours() * 60 + now.getMinutes() - (sh * 60 + sm);
    if (diff <= 0) return "0m";
    return diff >= 60 ? `${Math.floor(diff / 60)}h ${diff % 60}m` : `${diff}m`;
  }

  function clockedElapsed() { return elapsedSince(clockIn?.start); }

  function breakElapsed() { return elapsedSince(clockIn?.activeBreak?.start); }

  // Switch the open task to a new description. Closes the existing
  // open segment and opens a new one in a single RPC call.
  async function switchTask(description) {
    const { data: id, error } = await startTaskSegment(description || "");
    if (error) return { error };
    setCurrentTask({ id, description: description || "", started_at: new Date().toISOString() });
    return { data: id };
  }

  // Rename the open segment without creating a new boundary — used
  // when the user is finishing the name in place after starting tracking.
  async function renameCurrentTask(description) {
    const { error } = await updateOpenTaskSegment(description || "");
    if (!error) {
      setCurrentTask((prev) => prev ? { ...prev, description: description || "" } : prev);
    }
    return { error };
  }

  // ── Entry CRUD ───────────────────────────────────────────────
  async function handleSubmit(f = form) {
    if (!f.date || !f.start || !f.end) return;
    const minutes = calcWorked(f.start, f.end, f.breaks);
    const { data, error } = await supabase.from("entries").insert({
      user_id: session.user.id,
      date: f.date,
      start: f.start || null,
      end_time: f.end || null,
      description: f.description || "",
      minutes,
      breaks: f.breaks,
      project_ids: f.projectIds || [],
      billable: f.billable !== false,
    }).select().single();
    if (error) { flash("✗ Failed to save entry"); return; }
    if (data) {
      setEntries((prev) => [normalizeEntry(data), ...prev]);
      // If this submit finalized a clock-out (we tucked the session
      // start onto the form via _sessionStartIso), attach every segment
      // from that window to the new entry. Safe to call when not a
      // clock-out submit — `since` will be null and we just skip.
      if (f._sessionStartIso) {
        linkSegmentsToEntry(data.id, f._sessionStartIso).catch(() => {});
      }
    }
    setForm(makeEmptyForm(settings, templates));
  }

  async function handleDelete(id) {
    await supabase.from("entries").delete().eq("id", id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  async function saveInlineEdit() {
    if (!inlineForm || !inlineForm.date || !inlineForm.start || !inlineForm.end) return;
    const minutes = calcWorked(inlineForm.start, inlineForm.end, inlineForm.breaks);
    const { error } = await supabase.from("entries").update({
      date: inlineForm.date,
      start: inlineForm.start || null,
      end_time: inlineForm.end || null,
      description: inlineForm.description || "",
      minutes,
      breaks: inlineForm.breaks,
      project_ids: inlineForm.projectIds || [],
      billable: inlineForm.billable !== false,
    }).eq("id", inlineEditId);
    if (error) { flash("✗ Failed to save entry"); return; }
    setEntries((prev) => prev.map((e) => e.id === inlineEditId ? { ...e, ...inlineForm, project_ids: inlineForm.projectIds || [], minutes } : e));
    setInlineEditId(null);
    setInlineForm(null);
  }

  function duplicateEntry(entry) {
    setForm({
      date: todayStr(),
      start: entry.start || "",
      end: entry.end || "",
      description: entry.description || "",
      breaks: (entry.breaks || []).map((b) => ({ ...b, id: Date.now() + Math.random() })),
      projectIds: entry.project_ids || [],
      billable: entry.billable !== false,
    });
    logHoursRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ── Inline edit helpers ──────────────────────────────────────
  function startInlineEdit(entry) {
    setInlineEditId(entry.id);
    setInlineForm({
      date: entry.date,
      start: entry.start,
      end: entry.end,
      description: entry.description,
      breaks: entry.breaks || [],
      projectIds: entry.project_ids || [],
      billable: entry.billable !== false,
    });
  }
  function cancelInlineEdit() { setInlineEditId(null); setInlineForm(null); }
  function setInlineField(key, val) { setInlineForm((f) => ({ ...f, [key]: val })); }
  function addInlineBreak() { setInlineForm((f) => ({ ...f, breaks: [...f.breaks, { id: Date.now(), start: "", end: "", unpaid: true }] })); }
  function updateInlineBreak(id, patch) { setInlineForm((f) => ({ ...f, breaks: f.breaks.map((b) => b.id === id ? { ...b, ...patch } : b) })); }
  function removeInlineBreak(id) { setInlineForm((f) => ({ ...f, breaks: f.breaks.filter((b) => b.id !== id) })); }

  function toggleExpanded(date, dayEntries) {
    if (expandedDates.has(date) && inlineEditId && dayEntries.some((e) => e.id === inlineEditId)) {
      setInlineEditId(null); setInlineForm(null);
    }
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date); else next.add(date);
      return next;
    });
  }

  // ── Form helpers ─────────────────────────────────────────────
  function applyTemplate(tmpl) {
    setForm((f) => ({
      ...f,
      start: tmpl.start || "",
      end: tmpl.end || "",
      breaks: (tmpl.breaks || []).map((b) => ({ ...b, id: Date.now() + Math.random() })),
    }));
  }
  function setField(key, val) { setForm((f) => ({ ...f, [key]: val })); }
  function addBreak() { setForm((f) => ({ ...f, breaks: [...f.breaks, { id: Date.now(), start: "", end: "", unpaid: true }] })); }
  function updateBreak(id, patch) { setForm((f) => ({ ...f, breaks: f.breaks.map((b) => b.id === id ? { ...b, ...patch } : b) })); }
  function removeBreak(id) { setForm((f) => ({ ...f, breaks: f.breaks.filter((b) => b.id !== id) })); }

  // ── Settings modal ───────────────────────────────────────────
  function openSettings() {
    setDraftSettings({ ...settings, hourlyRate: hourlyRate || "", _deepseekKey: deepseekKey, _reminderTime: reminderTime, _timeRounding: timeRounding, dailyTarget: dailyTarget || "", weeklyTarget: weeklyTarget || "", _defaultEntryMode: defaultEntryMode, _defaultLandingPage: defaultLandingPage, _stickyColor: stickyColor });
    setDraftTemplates(templates.map((t) => ({ ...t, breaks: [...(t.breaks || [])] })));
    setDraftProjects(projects.map((p) => ({ ...p })));
    setDraftNewTemplate(null);
    setDraftEditingId(null);
    setDraftEditingTemplate(null);
    setDraftNewProject(null);
    setDraftEditingProjectId(null);
    setShowSettings(true);
  }

  async function saveSettings() {
    const { hourlyRate: draftRate, _deepseekKey: draftKey, _reminderTime: draftReminder, _timeRounding: draftRounding, dailyTarget: draftDaily, weeklyTarget: draftWeekly, _defaultEntryMode: draftEntryMode, _defaultLandingPage: draftLanding, _stickyColor: draftStickyColor, ...rest } = draftSettings;
    const rate = parseFloat(draftRate) || 0;
    const key = (draftKey || "").trim();
    const reminder = draftReminder || null;
    const rounding = draftRounding || "none";
    const daily = parseFloat(draftDaily) || 0;
    const weekly = parseFloat(draftWeekly) || 0;
    const entryMode = draftEntryMode || "manual";
    const landingPage = draftLanding === "log" ? "log" : "pomodoro";
    const stickyColorClean = /^#[0-9a-f]{6}$/i.test(draftStickyColor || "") ? draftStickyColor : "#fde68a";

    // Sync templates
    const existingUUIDs = templates.map((t) => t.id).filter(isUUID);
    const draftUUIDs = draftTemplates.map((t) => t.id).filter(isUUID);
    const removed = existingUUIDs.filter((id) => !draftUUIDs.includes(id));
    if (removed.length) {
      const { error } = await supabase.from("templates").delete().in("id", removed);
      if (error) { console.error("delete templates:", error); flash(`✗ Failed to remove templates: ${error.message}`); return; }
    }

    let finalDefaultTemplateId = rest.defaultTemplateId;
    if (draftTemplates.length > 0) {
      const toUpsert = draftTemplates.map((t) => {
        const obj = { user_id: session.user.id, name: t.name, start: t.start || null, end_time: t.end || null, breaks: t.breaks || [] };
        if (isUUID(t.id)) obj.id = t.id;
        return obj;
      });
      const { data: saved, error } = await supabase.from("templates").upsert(toUpsert).select();
      if (error) { console.error("upsert templates:", error); flash(`✗ Failed to save templates: ${error.message}`); return; }
      const normalizedSaved = (saved || []).map(normalizeTemplate);
      setTemplates(normalizedSaved);
      if (finalDefaultTemplateId && !isUUID(finalDefaultTemplateId)) {
        const idx = draftTemplates.findIndex((t) => String(t.id) === String(finalDefaultTemplateId));
        finalDefaultTemplateId = idx >= 0 && normalizedSaved[idx] ? normalizedSaved[idx].id : undefined;
      }
    } else {
      setTemplates([]);
    }

    // Sync projects
    const existingProjectUUIDs = projects.map((p) => p.id).filter(isUUID);
    const draftProjectUUIDs = draftProjects.map((p) => p.id).filter(isUUID);
    const removedProjects = existingProjectUUIDs.filter((id) => !draftProjectUUIDs.includes(id));
    if (removedProjects.length) {
      const { error } = await supabase.from("projects").delete().in("id", removedProjects);
      if (error) { console.error("delete projects:", error); flash(`✗ Failed to remove projects: ${error.message}`); return; }
    }
    if (draftProjects.length > 0) {
      const toUpsert = draftProjects.map((p) => {
        const obj = { user_id: session.user.id, name: p.name, client_name: p.client_name || "", color: p.color || "#14b8a6" };
        if (isUUID(p.id)) obj.id = p.id;
        return obj;
      });
      const { data: savedProjects, error } = await supabase.from("projects").upsert(toUpsert).select();
      if (error) { console.error("upsert projects:", error); flash(`✗ Failed to save projects: ${error.message}`); return; }
      setProjects(savedProjects ?? draftProjects);
    } else {
      setProjects([]);
    }

    const { error: settingsError } = await supabase.from("user_settings").upsert({
      user_id: session.user.id,
      name: rest.name || null,
      default_start: rest.defaultStart || null,
      default_end: rest.defaultEnd || null,
      default_template_id: finalDefaultTemplateId || null,
      hourly_rate: rate,
      deepseek_key: key,
      reminder_time: reminder,
      time_rounding: rounding,
      daily_target: daily,
      weekly_target: weekly,
      default_entry_mode: entryMode,
      default_landing_page: landingPage,
      sticky_color: stickyColorClean,
      avatar_url: rest.avatarUrl || null,
      status: rest.status ?? null,
      pomodoro_sound_url: rest.pomodoroSoundUrl || null,
      pomodoro_sound_name: rest.pomodoroSoundName || null,
      accent_color: rest.accentColor || "teal",
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (settingsError) {
      console.error("upsert user_settings:", settingsError);
      flash(`✗ Failed to save settings: ${settingsError.message}`);
      return;
    }

    const newSettings = { ...rest, defaultTemplateId: finalDefaultTemplateId };
    setSettings(newSettings);
    setHourlyRate(rate);
    setDeepseekKey(key);
    setReminderTime(reminder || "");
    setTimeRounding(rounding);
    setDailyTarget(daily);
    setWeeklyTarget(weekly);
    setDefaultEntryMode(entryMode);
    setDefaultLandingPage(landingPage);
    try { localStorage.setItem("ql_default_landing", landingPage); } catch { /* ignore */ }
    setStickyColor(stickyColorClean);
    setShowSettings(false);
    flash("✓ Settings saved");
    // Best-effort: push the new avatar/name into any active sync sessions.
    supabase.rpc("refresh_my_sync_avatar").then(() => {}, () => {});
  }

  // ── Template draft helpers ───────────────────────────────────
  function startDraftNew() {
    setDraftNewTemplate({ name: "", start: "", end: "", breaks: [] });
    setDraftEditingId(null);
    setDraftEditingTemplate(null);
  }
  function commitDraftNew() {
    const tempId = Date.now();
    setDraftTemplates((ts) => [...ts, { ...draftNewTemplate, id: tempId }]);
    setDraftNewTemplate(null);
  }
  function startDraftEdit(tmpl) {
    setDraftEditingId(tmpl.id);
    setDraftEditingTemplate({ ...tmpl, breaks: [...(tmpl.breaks || [])] });
    setDraftNewTemplate(null);
  }
  function commitDraftEdit() {
    setDraftTemplates((ts) => ts.map((t) => t.id === draftEditingId ? draftEditingTemplate : t));
    setDraftEditingId(null);
    setDraftEditingTemplate(null);
  }
  function deleteDraftTemplate(id) {
    setDraftTemplates((ts) => ts.filter((t) => t.id !== id));
    if (draftSettings.defaultTemplateId === id) {
      setDraftSettings((d) => ({ ...d, defaultTemplateId: undefined }));
    }
  }

  // ── Project draft helpers ────────────────────────────────────
  function startDraftNewProject() {
    setDraftNewProject({ name: "", client_name: "", color: "#14b8a6" });
    setDraftEditingProjectId(null);
  }
  function commitDraftNewProject() {
    const tempId = Date.now();
    setDraftProjects((ps) => [...ps, { ...draftNewProject, id: tempId }]);
    setDraftNewProject(null);
  }
  function startDraftEditProject(proj) {
    setDraftEditingProjectId(proj.id);
    setDraftNewProject({ ...proj });
  }
  function commitDraftEditProject() {
    setDraftProjects((ps) => ps.map((p) => p.id === draftEditingProjectId ? draftNewProject : p));
    setDraftEditingProjectId(null);
    setDraftNewProject(null);
  }
  function deleteDraftProject(id) {
    setDraftProjects((ps) => ps.filter((p) => p.id !== id));
  }

  // ── AI helpers ───────────────────────────────────────────────
  async function callDeepSeek(systemPrompt, userPrompt) {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deepseekKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 512,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek error ${res.status}`);
    const data = await res.json();
    return data.choices[0].message.content.trim();
  }

  /** Returns actionable step titles, or null if AI is unavailable / failed. */
  async function breakdownPlannerTask(description) {
    const text = (description || "").trim();
    if (!text || !deepseekKey) return null;
    try {
      const result = await callDeepSeek(
        "You help people with ADHD break work into tiny, concrete actions. Reply with one action per line only — no numbering, bullets, or extra commentary. Max 8 lines. Each line under 80 characters.",
        `The user described this task or goal. Break it into small, ordered next steps they could add to a daily task list:\n\n${text}`,
      );
      const lines = result
        .split(/\n/)
        .map((l) => l.replace(/^\s*\d+[\).\s]+/, "").replace(/^\s*[-*•]\s*/, "").trim())
        .filter(Boolean);
      return lines.length ? lines.slice(0, 10) : null;
    } catch {
      return null;
    }
  }

  /** AI subtasks for a task: returns concrete subtask titles, or null if unavailable. */
  async function suggestSubtasks(title, notes = "") {
    const t = (title || "").trim();
    if (!t || !deepseekKey) return null;
    try {
      const result = await callDeepSeek(
        "You break a task into 3-6 small, concrete, ordered subtasks. Reply with one subtask per line only — no numbering, bullets, or commentary. Each line under 80 characters.",
        `Break this task into actionable subtasks:\n\nTask: ${t}${notes ? `\nNotes: ${notes}` : ""}`,
      );
      const lines = result
        .split(/\n/)
        .map((l) => l.replace(/^\s*\d+[\).\s]+/, "").replace(/^\s*[-*•]\s*/, "").trim())
        .filter(Boolean);
      return lines.length ? lines.slice(0, 8) : null;
    } catch {
      return null;
    }
  }

  async function rewriteDescription(text, setter) {
    const src = text !== undefined ? text : form.description;
    const set = setter || ((v) => setField("description", v));
    if (!src.trim() || !deepseekKey) return;
    setRewritingDesc(true);
    try {
      const result = await callDeepSeek(
        "You are a professional business writer. Rewrite work log descriptions into concise, professional client-facing language. Keep it to 1–2 sentences. Do not invent details not present in the original.",
        `Rewrite this work description professionally: "${src}"`,
      );
      set(result);
    } catch { flash("✗ AI rewrite failed"); }
    finally { setRewritingDesc(false); }
  }

  async function generateMonthSummary(monthKey, weeks) {
    if (!deepseekKey) return;
    setMonthSummaries((s) => ({ ...s, [monthKey]: { loading: true, text: null } }));
    try {
      const allEntries = weeks
        .flatMap((w) => w.days)
        .sort((a, b) => a.date.localeCompare(b.date))
        .flatMap(({ date, entries: dayEntries }) =>
          dayEntries.filter((e) => e.description).map((e) => `${date} (${formatDecimal(e.minutes)}h): ${e.description}`)
        );
      const totalMins = weeks.flatMap((w) => w.days).flatMap((d) => d.entries).reduce((a, e) => a + e.minutes, 0);
      const result = await callDeepSeek(
        "You are a professional writer creating concise work summaries for client invoices and reports. Write in first person. Be specific about what was accomplished. 2–4 sentences maximum.",
        `Write a professional summary for ${formatMonthLabel(monthKey)} (${formatDecimal(totalMins)} hours total) from these work log entries:\n\n${allEntries.join("\n")}`,
      );
      setMonthSummaries((s) => ({ ...s, [monthKey]: { loading: false, text: result } }));
    } catch {
      setMonthSummaries((s) => ({ ...s, [monthKey]: { loading: false, text: null } }));
      flash("✗ AI summary failed");
    }
  }

  // ── Flash message ────────────────────────────────────────────
  const flashTimerRef = useRef(null);
  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);
  function flash(msg) {
    setExportMsg(msg);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setExportMsg(""), 2500);
  }

  // ── Export / import ──────────────────────────────────────────
  function buildCSVRows(days, label) {
    const hasRate = hourlyRate > 0;
    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const csv = (val) => { const s = String(val ?? ""); return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s; };
    const row = (...cells) => cells.map(csv).join(",");
    const rows = [];
    const title = settings.name ? `${settings.name}'s Timesheet` : "Timesheet";
    rows.push(csv(title));
    if (label) rows.push(row("Period:", label));
    if (settings.name) rows.push(row("Name:", settings.name));
    if (hasRate) rows.push(row("Hourly Rate:", `$${hourlyRate.toFixed(2)}`));
    rows.push("");
    if (hasRate) {
      rows.push(row("Date", "Start", "End", "Project", "Billable", "Unpaid Break (mins)", "Income Earned", "Hours Worked", "Description", "Total Income", "Total Hours"));
    } else {
      rows.push(row("Date", "Start", "End", "Project", "Billable", "Unpaid Break (mins)", "Hours Worked", "Description", "Total Hours"));
    }
    const weekMap = new Map();
    for (const d of days) {
      const wk = weekStart(d.date);
      if (!weekMap.has(wk)) weekMap.set(wk, []);
      weekMap.get(wk).push(d);
    }
    let grandMins = 0, grandEarned = 0;
    for (const [wkStr, wkDays] of weekMap) {
      const wkLabel = weekRangeLabel(wkStr);
      let weekMins = 0, weekEarned = 0;
      for (const { dayEntries } of wkDays) {
        for (const e of dayEntries) { weekMins += e.minutes; weekEarned += hasRate && e.billable !== false ? (e.minutes / 60) * hourlyRate : 0; }
      }
      if (hasRate) rows.push(row(wkLabel, "", "", "", "", "", "", "", formatMoney(weekEarned), formatDuration(weekMins)));
      else rows.push(row(wkLabel, "", "", "", "", "", "", formatDuration(weekMins)));
      for (const { date, dayEntries } of wkDays) {
        const dayMins = dayEntries.reduce((a, e) => a + e.minutes, 0);
        const dayEarned = hasRate ? dayEntries.reduce((a, e) => a + (e.billable !== false ? (e.minutes / 60) * hourlyRate : 0), 0) : 0;
        const dayLabel = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
        if (hasRate) rows.push(row(dayLabel, "", "", "", "", "", "", "", formatMoney(dayEarned), formatDuration(dayMins)));
        else rows.push(row(dayLabel, "", "", "", "", "", "", formatDuration(dayMins)));
        for (const e of dayEntries) {
          const bm = unpaidBreakMins(e);
          const projectName = (e.project_ids || []).map((id) => projectMap.get(id)?.name).filter(Boolean).join(", ");
          const billableLabel = e.billable === false ? "No" : "Yes";
          const earned = hasRate && e.billable !== false ? (e.minutes / 60) * hourlyRate : null;
          if (hasRate) rows.push(row("", toDisplayTime(e.start), toDisplayTime(e.end), projectName, billableLabel, bm > 0 ? bm : "", earned != null ? formatMoney(earned) : "", formatDuration(e.minutes), e.description || "", "", ""));
          else rows.push(row("", toDisplayTime(e.start), toDisplayTime(e.end), projectName, billableLabel, bm > 0 ? bm : "", formatDuration(e.minutes), e.description || "", ""));
        }
        grandMins += dayMins; grandEarned += dayEarned;
      }
      rows.push("");
    }
    if (hasRate) rows.push(row("TOTAL", "", "", "", "", "", "", "", formatMoney(grandEarned), formatDuration(grandMins)));
    else rows.push(row("TOTAL", "", "", "", "", "", formatDuration(grandMins)));
    return rows;
  }

  function exportAllCSV() {
    const byDate = {};
    for (const e of entries) { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e); }
    const days = Object.keys(byDate).sort().map((date) => ({ date, dayEntries: byDate[date] }));
    const rows = buildCSVRows(days, null);
    const name = settings.name ? `${settings.name.toLowerCase().replace(/\s+/g, "_")}_` : "";
    downloadFile(new Blob([rows.join("\n")], { type: "text/csv" }), `${name}work_hours_all.csv`);
    flash("✓ All data exported");
  }

  function exportMonthCSV(monthKey, weeks) {
    const days = [...weeks].flatMap((w) => w.days).sort((a, b) => a.date.localeCompare(b.date)).map(({ date, entries: dayEntries }) => ({ date, dayEntries }));
    const rows = buildCSVRows(days, formatMonthLabel(monthKey));
    const name = settings.name ? `${settings.name.toLowerCase().replace(/\s+/g, "_")}_` : "";
    downloadFile(new Blob([rows.join("\n")], { type: "text/csv" }), `${name}${monthKey}.csv`);
    flash(`✓ ${formatMonthLabel(monthKey)} exported`);
  }

  async function buildXLSX(days, label, summary = "") {
    const { default: ExcelJS } = await import("exceljs");
    const hasRate = hourlyRate > 0;
    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const NAVY = "FF1F3864", BLUE = "FF4472C4", WHITE = "FFFFFFFF", LIGHT = "FFF0F4FA";
    const navyFill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    const blueFill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    const lightFill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
    const whiteFont = { color: { argb: WHITE }, bold: true, name: "Calibri", size: 11 };
    const boldFont = { bold: true, name: "Calibri", size: 11 };
    const baseFont = { name: "Calibri", size: 11 };
    const thinBorder = { style: "thin", color: { argb: "FFD0D7E3" } };
    const cellBorder = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
    const styleAll = (row, style) => row.eachCell({ includeEmpty: true }, (cell) => Object.assign(cell, { style }));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Timesheet");
    // Cols: Date, Start, End, Project, Billable, Unpaid Break, [Income Earned, Hours Worked, Description, Total Income, Total Hours] or [Hours Worked, Description, Total Hours]
    const cols = hasRate ? [20, 12, 12, 18, 10, 22, 16, 16, 16, 16, 38] : [20, 12, 12, 18, 10, 22, 16, 16, 38];
    ws.columns = cols.map((width) => ({ width }));
    const numCols = cols.length;
    const merge = (row) => ws.mergeCells(row.number, 1, row.number, numCols);
    const titleText = settings.name ? `${settings.name}'s Timesheet${label ? ` – ${label}` : ""}` : `Timesheet${label ? ` – ${label}` : ""}`;
    const titleRow = ws.addRow([titleText]);
    merge(titleRow); titleRow.height = 24;
    titleRow.getCell(1).style = { font: { bold: true, size: 14, name: "Calibri" }, alignment: { horizontal: "center", vertical: "middle" } };
    const addInfo = (lbl, val) => { const r = ws.addRow([lbl, val || ""]); r.height = 18; styleAll(r, { fill: blueFill, font: whiteFont, border: cellBorder }); };
    if (settings.name) addInfo("Name:", settings.name);
    if (label) addInfo("Period:", label);
    if (hasRate) addInfo("Hourly Rate:", `$${hourlyRate.toFixed(2)}`);
    ws.addRow([]).height = 6;
    const headerLabels = hasRate
      ? ["Date", "Start", "End", "Project", "Billable", "Unpaid Break (mins)", "Income Earned", "Hours Worked", "Total Income", "Total Hours", "Description"]
      : ["Date", "Start", "End", "Project", "Billable", "Unpaid Break (mins)", "Hours Worked", "Total Hours", "Description"];
    const hdrRow = ws.addRow(headerLabels);
    hdrRow.height = 20;
    styleAll(hdrRow, { fill: navyFill, font: whiteFont, border: cellBorder, alignment: { vertical: "middle" } });
    const weekMap = new Map();
    for (const d of days) { const wk = weekStart(d.date); if (!weekMap.has(wk)) weekMap.set(wk, []); weekMap.get(wk).push(d); }
    let grandMins = 0, grandEarned = 0;
    for (const [wkStr, wkDays] of weekMap) {
      const wkLabel = weekRangeLabel(wkStr);
      let weekMins = 0, weekEarned = 0;
      for (const { dayEntries } of wkDays) { for (const e of dayEntries) { weekMins += e.minutes; weekEarned += hasRate && e.billable !== false ? (e.minutes / 60) * hourlyRate : 0; } }
      const wkCells = hasRate ? [wkLabel, "", "", "", "", "", "", "", formatMoney(weekEarned), formatDuration(weekMins), ""] : [wkLabel, "", "", "", "", "", "", formatDuration(weekMins), ""];
      const wkRow = ws.addRow(wkCells); wkRow.height = 22;
      styleAll(wkRow, { fill: navyFill, font: whiteFont, border: cellBorder, alignment: { vertical: "middle" } });
      for (const { date, dayEntries } of wkDays) {
        const dayMins = dayEntries.reduce((a, e) => a + e.minutes, 0);
        const dayEarned = hasRate ? dayEntries.reduce((a, e) => a + (e.billable !== false ? (e.minutes / 60) * hourlyRate : 0), 0) : 0;
        const dayLabel = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
        const dayCells = hasRate ? [dayLabel, "", "", "", "", "", "", "", formatMoney(dayEarned), formatDuration(dayMins), ""] : [dayLabel, "", "", "", "", "", "", formatDuration(dayMins), ""];
        const dayRow = ws.addRow(dayCells); dayRow.height = 18;
        styleAll(dayRow, { fill: lightFill, font: boldFont, border: cellBorder, alignment: { vertical: "middle" } });
        for (const e of dayEntries) {
          const bm = unpaidBreakMins(e);
          const projectName = (e.project_ids || []).map((id) => projectMap.get(id)?.name).filter(Boolean).join(", ");
          const billableLabel = e.billable === false ? "No" : "Yes";
          const earned = hasRate && e.billable !== false ? (e.minutes / 60) * hourlyRate : null;
          const entryCells = hasRate
            ? ["", toDisplayTime(e.start), toDisplayTime(e.end), projectName, billableLabel, bm > 0 ? bm : "", earned != null ? formatMoney(earned) : "", formatDuration(e.minutes), "", "", e.description || ""]
            : ["", toDisplayTime(e.start), toDisplayTime(e.end), projectName, billableLabel, bm > 0 ? bm : "", formatDuration(e.minutes), "", e.description || ""];
          const entryRow = ws.addRow(entryCells); entryRow.height = 16;
          styleAll(entryRow, { font: baseFont, border: cellBorder, alignment: { vertical: "middle" } });
        }
        grandMins += dayMins; grandEarned += dayEarned;
      }
      ws.addRow([]).height = 8;
    }
    const totalCells = hasRate ? ["TOTAL", "", "", "", "", "", "", "", formatMoney(grandEarned), formatDuration(grandMins), ""] : ["TOTAL", "", "", "", "", "", "", formatDuration(grandMins), ""];
    const totalRow = ws.addRow(totalCells); totalRow.height = 20;
    styleAll(totalRow, { font: boldFont, border: cellBorder, alignment: { vertical: "middle" } });
    if (summary) {
      ws.addRow([]).height = 8;
      const hdr = ws.addRow(["AI Summary"]);
      merge(hdr); hdr.height = 18;
      styleAll(hdr, { fill: blueFill, font: whiteFont, border: cellBorder });
      const sumRow = ws.addRow([summary]);
      merge(sumRow); sumRow.height = 80;
      sumRow.getCell(1).style = { font: baseFont, alignment: { wrapText: true, vertical: "top" }, border: cellBorder };
    }
    return wb.xlsx.writeBuffer();
  }

  async function exportMonthXLSX(monthKey, weeks) {
    const days = [...weeks].flatMap((w) => w.days).sort((a, b) => a.date.localeCompare(b.date)).map(({ date, entries: dayEntries }) => ({ date, dayEntries }));
    const buffer = await buildXLSX(days, formatMonthLabel(monthKey), monthSummaries[monthKey]?.text || "");
    const name = settings.name ? `${settings.name.toLowerCase().replace(/\s+/g, "_")}_` : "";
    downloadFile(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${name}${monthKey}.xlsx`);
    flash(`✓ ${formatMonthLabel(monthKey)} exported`);
  }

  async function exportAllXLSX() {
    const byDate = {};
    for (const e of entries) { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e); }
    const days = Object.keys(byDate).sort().map((date) => ({ date, dayEntries: byDate[date] }));
    const buffer = await buildXLSX(days, null);
    const name = settings.name ? `${settings.name.toLowerCase().replace(/\s+/g, "_")}_` : "";
    downloadFile(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${name}work_hours_all.xlsx`);
    flash("✓ All data exported");
  }

  async function importFromLocalStorage() {
    try {
      const oldEntries = JSON.parse(localStorage.getItem("worklog_entries_v2") || "[]");
      const oldTemplates = JSON.parse(localStorage.getItem("worklog_templates_v1") || "[]");
      const oldSettings = JSON.parse(localStorage.getItem("worklog_settings_v1") || "{}");
      const oldRate = parseFloat(localStorage.getItem("worklog_hourly_rate") || "0") || 0;
      const oldKey = localStorage.getItem("worklog_deepseek_key") || "";
      if (oldEntries.length > 0) {
        const rows = oldEntries.map((e) => ({ user_id: session.user.id, date: e.date, start: e.start || null, end_time: e.end || null, description: e.description || "", minutes: e.minutes || 0, breaks: e.breaks || [] }));
        const { data: inserted } = await supabase.from("entries").insert(rows).select();
        if (inserted) setEntries((prev) => [...(inserted.map(normalizeEntry)), ...prev].sort((a, b) => b.date.localeCompare(a.date)));
      }
      if (oldTemplates.length > 0) {
        const rows = oldTemplates.map((t) => ({ user_id: session.user.id, name: t.name, start: t.start || null, end_time: t.end || null, breaks: t.breaks || [] }));
        const { data: savedTmpl } = await supabase.from("templates").insert(rows).select();
        if (savedTmpl) setTemplates((prev) => [...prev, ...savedTmpl.map(normalizeTemplate)]);
      }
      await supabase.from("user_settings").upsert({ user_id: session.user.id, name: oldSettings.name || null, default_start: oldSettings.defaultStart || null, default_end: oldSettings.defaultEnd || null, hourly_rate: oldRate, deepseek_key: oldKey, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      ["worklog_entries_v2", "worklog_templates_v1", "worklog_settings_v1", "worklog_hourly_rate", "worklog_deepseek_key"].forEach((k) => localStorage.removeItem(k));
      setLocalImportBanner(null);
      flash(`✓ Imported ${oldEntries.length} ${oldEntries.length === 1 ? "entry" : "entries"} from local storage`);
    } catch { flash("✗ Import failed"); }
  }

  async function importEntriesFromFile(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const arr = Array.isArray(parsed) ? parsed : parsed.entries;
      if (!Array.isArray(arr) || arr.length === 0) { flash("✗ No entries found in file"); return; }
      const rows = arr.map((e) => ({ user_id: session.user.id, date: e.date, start: e.start || null, end_time: e.end || e.end_time || null, description: e.description || "", minutes: typeof e.minutes === "number" ? e.minutes : calcWorked(e.start, e.end || e.end_time, e.breaks), breaks: e.breaks || [] })).filter((e) => e.date && (e.start || e.minutes > 0));
      const { data: inserted, error } = await supabase.from("entries").insert(rows).select();
      if (error) { flash("✗ Import failed"); return; }
      setEntries((prev) => [...(inserted ?? []).map(normalizeEntry), ...prev].sort((a, b) => b.date.localeCompare(a.date)));
      flash(`✓ Imported ${inserted?.length ?? 0} ${inserted?.length === 1 ? "entry" : "entries"}`);
    } catch { flash("✗ Invalid file format"); }
  }

  function exportProfile() {
    const profile = { version: 1, type: "mangodoro-profile", settings: { name: settings.name || "", defaultStart: settings.defaultStart || "", defaultEnd: settings.defaultEnd || "", hourlyRate }, templates: templates.map(({ name, start, end, breaks }) => ({ name, start, end, breaks })) };
    downloadFile(new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" }), "mangodoro-profile.json");
    flash("✓ Profile exported");
  }

  function importProfileFromFile(file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const profile = JSON.parse(ev.target.result);
        // Accept both the new "mangodoro-profile" and the legacy
        // "questlogger-profile" identifier so older exports still import.
        if (profile.type !== "mangodoro-profile" && profile.type !== "questlogger-profile") {
          flash("✗ Not a Mangodoro profile file"); return;
        }
        if (profile.settings) {
          setDraftSettings((d) => ({ ...d, name: profile.settings.name || d.name, defaultStart: profile.settings.defaultStart || d.defaultStart, defaultEnd: profile.settings.defaultEnd || d.defaultEnd, hourlyRate: profile.settings.hourlyRate ?? d.hourlyRate }));
        }
        if (Array.isArray(profile.templates) && profile.templates.length > 0) {
          const imported = profile.templates.map((t) => ({ id: Date.now() + Math.random(), name: t.name, start: t.start || "", end: t.end || "", breaks: t.breaks || [] }));
          setDraftTemplates((prev) => [...prev, ...imported]);
        }
        flash("✓ Profile loaded — review and hit Save");
      } catch { flash("✗ Invalid profile file"); }
    };
    reader.readAsText(file);
  }

  // ── Computed values ──────────────────────────────────────────
  const todayMins = useMemo(
    () => entries.filter((e) => e.date === todayStr()).reduce((a, e) => a + e.minutes, 0),
    [entries],
  );

  const grouped = useMemo(() => {
    const byDate = {};
    for (const e of entries) { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e); }
    for (const date of Object.keys(byDate)) { byDate[date].sort((a, b) => (a.start || "").localeCompare(b.start || "")); }
    const byMonthWeek = {};
    for (const [date, dayEntries] of Object.entries(byDate)) {
      const monthKey = date.slice(0, 7);
      const wk = weekStart(date);
      if (!byMonthWeek[monthKey]) byMonthWeek[monthKey] = {};
      if (!byMonthWeek[monthKey][wk]) byMonthWeek[monthKey][wk] = [];
      byMonthWeek[monthKey][wk].push({ date, entries: dayEntries });
    }
    const dir = sortAsc ? 1 : -1;
    return Object.keys(byMonthWeek).sort((a, b) => dir * a.localeCompare(b)).map((monthKey) => ({
      monthKey,
      weeks: Object.keys(byMonthWeek[monthKey]).sort((a, b) => dir * a.localeCompare(b)).map((weekKey) => ({
        weekKey,
        days: [...byMonthWeek[monthKey][weekKey]].sort((a, b) => dir * a.date.localeCompare(b.date)),
      })),
    }));
  }, [entries, sortAsc]);

  const earningsData = useMemo(() => {
    const today = todayStr();
    const thisWeekSun = weekStart(today);
    const thisMonth = today.slice(0, 7);
    const weekEntries = entries.filter((e) => weekStart(e.date) === thisWeekSun);
    const monthEntries = entries.filter((e) => e.date.slice(0, 7) === thisMonth);
    const weekMins = weekEntries.reduce((a, e) => a + e.minutes, 0);
    const monthMins = monthEntries.reduce((a, e) => a + e.minutes, 0);
    const weekBillableMins = weekEntries.filter((e) => e.billable !== false).reduce((a, e) => a + e.minutes, 0);
    const monthBillableMins = monthEntries.filter((e) => e.billable !== false).reduce((a, e) => a + e.minutes, 0);
    const byWeek = {}, byMonth = {};
    for (const e of entries) {
      const wk = weekStart(e.date);
      byWeek[wk] = (byWeek[wk] || 0) + e.minutes;
      const mo = e.date.slice(0, 7);
      byMonth[mo] = (byMonth[mo] || 0) + e.minutes;
    }
    const weekKeys = Object.keys(byWeek);
    const monthKeys = Object.keys(byMonth);
    const avgWeekMins = weekKeys.length > 0 ? weekKeys.reduce((a, k) => a + byWeek[k], 0) / weekKeys.length : 0;
    const avgMonthMins = monthKeys.length > 0 ? monthKeys.reduce((a, k) => a + byMonth[k], 0) / monthKeys.length : 0;
    const periodMins = earningsPeriod === "week" ? weekMins : monthMins;
    const periodBillableMins = earningsPeriod === "week" ? weekBillableMins : monthBillableMins;
    const periodNonBillableMins = periodMins - periodBillableMins;
    return {
      periodMins, periodBillableMins, periodNonBillableMins,
      periodEarnings: (periodBillableMins / 60) * hourlyRate,
      avgWeekMins, avgMonthMins,
      avgWeekEarnings: (avgWeekMins / 60) * hourlyRate,
      avgMonthEarnings: (avgMonthMins / 60) * hourlyRate,
    };
  }, [entries, hourlyRate, earningsPeriod]);

  // ── Google (Sheets / Calendar / Docs) ─────────────────────────
  // One consent covers every Google feature. `prompt: consent` forces the
  // dialog so already-connected users pick up newly-added scopes on their next
  // connect (the token is captured from session.provider_token — see the auth
  // effect above — and persisted to user_settings.google_access_token).
  function connectGoogle() {
    supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        scopes: [
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/documents",
          "https://www.googleapis.com/auth/drive.file",
        ].join(" "),
        queryParams: { access_type: "offline", prompt: "consent" },
        redirectTo: window.location.href,
      },
    });
  }

  // Silently mint a fresh Google access token from the stored refresh token
  // (via the google-token edge fn) — no OAuth popup. Returns the new token, or
  // null if there's no refresh token / it was revoked (caller then re-auths).
  async function refreshGoogleToken() {
    if (googleRefreshingRef.current) return null;
    googleRefreshingRef.current = true;
    try {
      const { data, error } = await supabase.functions.invoke("google-token", { body: {} });
      if (error || !data?.access_token) return null;
      const exp = data.expiry || (Date.now() + 3500 * 1000);
      googleTokenRef.current = data.access_token; // visible to callers this tick
      googleTokenExpiryRef.current = exp;
      setGoogleToken(data.access_token);
      setGoogleTokenExpiry(exp);
      return data.access_token;
    } catch {
      return null;
    } finally {
      googleRefreshingRef.current = false;
    }
  }

  // Return a currently-valid Google access token — refreshing silently if it's
  // expired/missing — or null if that fails (caller then does a full re-auth).
  // Guards call this so an expired token triggers a silent refresh, not a popup.
  async function ensureGoogleToken() {
    if (googleTokenRef.current && Date.now() < googleTokenExpiryRef.current) return googleTokenRef.current;
    return await refreshGoogleToken();
  }

  // Keep the Google access token fresh in the background so Calendar/Docs never
  // hit an expired token: refresh ~2 min before expiry (or immediately if it's
  // already past — e.g. reopening the app after a while). Updating the token
  // re-runs this effect, scheduling the next refresh. Silent no-op when there's
  // no refresh token yet (older connections re-auth once to capture one).
  useEffect(() => {
    if (!googleToken || !googleTokenExpiry) return undefined;
    const delay = Math.max(0, googleTokenExpiry - Date.now() - 120000);
    const id = setTimeout(() => { refreshGoogleToken(); }, delay);
    return () => clearTimeout(id);
  }, [googleToken, googleTokenExpiry]); // eslint-disable-line react-hooks/exhaustive-deps

  // Direct save for a single field — used by the new SettingsPage so
  // pickers (theme, accent, etc.) commit on click without a Save step.
  async function updateSettingsField(patch) {
    setSettings((prev) => ({ ...prev, ...patch }));
    const dbPatch = {};
    if ("jobTitle" in patch) dbPatch.job_title = patch.jobTitle || null;
    if ("accentColor" in patch) dbPatch.accent_color = patch.accentColor;
    if ("name" in patch) dbPatch.name = patch.name || null;
    if ("status" in patch) dbPatch.status = patch.status ?? null;
    if ("lunchTime" in patch) dbPatch.lunch_time = patch.lunchTime || null;
    if ("lunchMode" in patch) dbPatch.lunch_mode = patch.lunchMode || "off";
    if ("lunchDurationMin" in patch) dbPatch.lunch_duration_min = patch.lunchDurationMin ?? 60;
    if ("notifQuietStart" in patch) dbPatch.notif_quiet_start = patch.notifQuietStart || null;
    if ("notifQuietEnd" in patch) dbPatch.notif_quiet_end = patch.notifQuietEnd || null;
    if ("notifDesktopEnabled" in patch) dbPatch.notif_desktop_enabled = patch.notifDesktopEnabled;
    if ("wellbeingReminders" in patch) dbPatch.wellbeing_reminders = patch.wellbeingReminders || {};
    if ("reminderActiveStart" in patch) dbPatch.reminder_active_start = patch.reminderActiveStart || null;
    if ("reminderActiveEnd" in patch) dbPatch.reminder_active_end = patch.reminderActiveEnd || null;
    if ("workStart" in patch) dbPatch.work_start = patch.workStart || null;
    if ("workEnd" in patch) dbPatch.work_end = patch.workEnd || null;
    if ("workDays" in patch) dbPatch.work_days = patch.workDays && patch.workDays.length ? patch.workDays : null;
    if ("workSchedule" in patch) dbPatch.work_schedule = patch.workSchedule || {};
    if ("oooRanges" in patch) dbPatch.ooo_ranges = patch.oooRanges || [];
    if ("lunchBreakPaid" in patch) dbPatch.lunch_break_paid = patch.lunchBreakPaid;
    if ("reflectWhen" in patch) dbPatch.reflect_when = patch.reflectWhen || "off";
    if ("timezone" in patch) dbPatch.timezone = patch.timezone || null;
    if ("timezoneManual" in patch) dbPatch.timezone_manual = patch.timezoneManual;
    if ("wageMode" in patch) dbPatch.wage_mode = patch.wageMode || "hourly";
    if ("annualSalary" in patch) dbPatch.annual_salary = patch.annualSalary ?? null;
    if ("offHoursWarn" in patch) dbPatch.off_hours_warn = patch.offHoursWarn;
    if ("shareFreebusy" in patch) dbPatch.share_freebusy_with_team = patch.shareFreebusy;
    if ("oooStart" in patch) dbPatch.ooo_start = patch.oooStart || null;
    if ("oooEnd" in patch) dbPatch.ooo_end = patch.oooEnd || null;
    if ("oooNote" in patch) dbPatch.ooo_note = patch.oooNote || null;
    if ("worldClockPersonal" in patch) dbPatch.world_clock_personal = Array.isArray(patch.worldClockPersonal) ? patch.worldClockPersonal : [];
    if ("navPinnedTz" in patch) dbPatch.nav_pinned_tz = patch.navPinnedTz || null;
    if ("onboarding" in patch) dbPatch.onboarding = patch.onboarding && typeof patch.onboarding === "object" ? patch.onboarding : {};
    if (Object.keys(dbPatch).length === 0) return;
    if (!session?.user?.id) return;
    await supabase.from("user_settings").update(dbPatch).eq("user_id", session.user.id);
  }

  // ── Onboarding / tutorial state ──────────────────────────────
  // onboarding (a jsonb blob on user_settings) is written from several
  // independent places — tour completion, checklist facts, the welcome flow, the
  // seen-marker seed. Writing the whole blob from a stale in-memory copy let
  // concurrent writers clobber each other (which is why completedTours never
  // stuck). Instead each setter sends a MINIMAL patch to the `onboarding_merge`
  // RPC, which merges server-side (scalars overwrite, checklist shallow-merges,
  // tour-id arrays union) so no writer ever drops another's keys. The optimistic
  // local merge keeps the UI instant; realtime + refetch reconcile from the DB.
  const addToSet = (arr, id) => (Array.isArray(arr) && arr.includes(id) ? arr : [...(arr || []), id]);
  const mergeOnboarding = useCallback((patch) => {
    if (!session?.user?.id) return;
    setSettings((prev) => {
      const cur = prev.onboarding && typeof prev.onboarding === "object" ? prev.onboarding : {};
      const next = { ...cur };
      if ("welcomeDone" in patch) next.welcomeDone = patch.welcomeDone;
      if ("seenTourMarker" in patch) next.seenTourMarker = patch.seenTourMarker;
      if ("hintsDisabled" in patch) next.hintsDisabled = patch.hintsDisabled;
      if (patch.checklist) next.checklist = { ...(cur.checklist || {}), ...patch.checklist };
      if (patch.completedTours) next.completedTours = patch.completedTours.reduce(addToSet, cur.completedTours || []);
      if (patch.dismissedTours) next.dismissedTours = patch.dismissedTours.reduce(addToSet, cur.dismissedTours || []);
      return { ...prev, onboarding: next };
    });
    // Authoritative, merge-safe DB write (never clobbers other keys / writers).
    supabase.rpc("onboarding_merge", { p: patch }).then(({ error }) => {
      if (error) console.warn("save onboarding:", error.message);
    });
  }, [session?.user?.id]);

  const markTourComplete = useCallback((id) => mergeOnboarding({ completedTours: [id] }), [mergeOnboarding]);
  const dismissTour = useCallback((id) => mergeOnboarding({ dismissedTours: [id] }), [mergeOnboarding]);
  const setChecklistItem = useCallback((id, val = true) => mergeOnboarding({ checklist: { [id]: val } }), [mergeOnboarding]);
  const setWelcomeDone = useCallback(() => mergeOnboarding({ welcomeDone: true }), [mergeOnboarding]);
  const setSeenTourMarker = useCallback((marker) => mergeOnboarding({ seenTourMarker: marker }), [mergeOnboarding]);
  // Master switch for the proactive onboarding hints (welcome modal, tour offers
  // + new-feature announcements, getting-started checklist). Help center stays
  // reachable regardless — this only silences the unprompted nudges.
  const setHintsDisabled = useCallback((val = true) => mergeOnboarding({ hintsDisabled: val }), [mergeOnboarding]);

  // ── Widget preferences (settings.widget_prefs jsonb) ─────────
  // Widget order + the pinned-strip set live per-account so they follow the
  // user across devices (replacing per-device localStorage). Same clobber-safe
  // pattern as onboarding: optimistic shallow-merge locally, then a partial
  // patch to the widget_prefs_merge RPC so a writer only touches its own keys.
  const mergeWidgetPrefs = useCallback((patch) => {
    if (!session?.user?.id) return;
    setSettings((prev) => {
      const cur = prev.widget_prefs && typeof prev.widget_prefs === "object" ? prev.widget_prefs : {};
      return { ...prev, widget_prefs: { ...cur, ...patch } };
    });
    supabase.rpc("widget_prefs_merge", { p: patch }).then(({ error }) => {
      if (error) console.warn("save widget prefs:", error.message);
    });
  }, [session?.user?.id]);

  // ── Custom sounds (user) ─────────────────────────────────────
  // Stored as a JSONB array on user_settings.custom_sounds. We round-trip
  // the whole list through one upsert per change — small lists, low write
  // frequency, no need for a separate table.

  function pickId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  async function persistCustomSounds(next) {
    if (!session?.user?.id) return { error: { message: "Not signed in" } };
    setSettings((s) => ({ ...s, customSounds: next }));
    const { error } = await supabase
      .from("user_settings")
      .upsert({
        user_id: session.user.id,
        custom_sounds: next,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    return { error };
  }

  async function addCustomSound(file, name) {
    if (!session?.user?.id) return { error: { message: "Not signed in" } };
    const up = await uploadUserSound(file, session.user.id);
    if (up.error) return { error: up.error };
    const entry = {
      id: pickId(),
      name: (name || file.name || "Custom sound").trim().slice(0, 80),
      url: up.data.url,
      path: up.data.path,
    };
    const next = [...(settings.customSounds || []), entry];
    const { error } = await persistCustomSounds(next);
    if (error) {
      await deleteCustomSound(up.data.path);
      return { error };
    }
    return { data: entry };
  }

  async function renameCustomSound(id, name) {
    const clean = (name || "").trim().slice(0, 80);
    if (!clean) return { error: { message: "Name can't be empty" } };
    const next = (settings.customSounds || []).map((s) =>
      s.id === id ? { ...s, name: clean } : s,
    );
    return persistCustomSounds(next);
  }

  async function removeCustomSound(id) {
    const sound = (settings.customSounds || []).find((s) => s.id === id);
    if (!sound) return { error: { message: "Sound not found" } };
    const next = (settings.customSounds || []).filter((s) => s.id !== id);
    const { error } = await persistCustomSounds(next);
    if (error) return { error };
    if (sound.path) await deleteCustomSound(sound.path);
    else if (sound.url) await deleteCustomSound(sound.url);
    return { error: null };
  }

  async function disconnectGoogleSheets() {
    setGoogleToken(null);
    setGoogleTokenExpiry(0);
    await supabase.from("user_settings").update({
      google_access_token: null,
      google_token_expiry: null,
    }).eq("user_id", session.user.id);
  }

  async function exportToGoogleSheets(monthStr, monthEntries) {
    if (!(await ensureGoogleToken())) {
      connectGoogle();
      return;
    }

    const hasRate = hourlyRate > 0;
    const projectMap = new Map(projects.map((p) => [p.id, p]));
    const monthDate = new Date(monthStr + "-01");
    const monthLabel = monthDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    const title = `Mangodoro${settings.name ? ` — ${settings.name}` : ""} — ${monthLabel}`;
    const numCols = hasRate ? 11 : 9;

    // Sheets API colors: {red, green, blue} 0-1
    const NAVY = { red: 0.122, green: 0.220, blue: 0.392 };
    const BLUE = { red: 0.267, green: 0.447, blue: 0.769 };
    const LIGHT = { red: 0.941, green: 0.957, blue: 0.980 };
    const WHITE = { red: 1, green: 1, blue: 1 };

    const navyFmt = { backgroundColor: NAVY, textFormat: { foregroundColor: WHITE, bold: true, fontSize: 11, fontFamily: "Arial" }, verticalAlignment: "MIDDLE" };
    const blueFmt = { backgroundColor: BLUE, textFormat: { foregroundColor: WHITE, bold: true, fontSize: 11, fontFamily: "Arial" }, verticalAlignment: "MIDDLE" };
    const lightFmt = { backgroundColor: LIGHT, textFormat: { bold: true, fontSize: 11, fontFamily: "Arial" }, verticalAlignment: "MIDDLE" };
    const baseFmt = { textFormat: { fontSize: 11, fontFamily: "Arial" }, verticalAlignment: "MIDDLE" };
    const boldFmt = { textFormat: { bold: true, fontSize: 11, fontFamily: "Arial" }, verticalAlignment: "MIDDLE" };

    const cell = (value, fmt) => {
      const v = typeof value === "number"
        ? { userEnteredValue: { numberValue: value } }
        : { userEnteredValue: { stringValue: String(value ?? "") } };
      if (fmt) v.userEnteredFormat = fmt;
      return v;
    };
    const empty = (fmt) => cell("", fmt);
    const blankRow = () => ({ values: Array(numCols).fill(null).map(() => empty()) });

    const rowData = [];

    // ── Title row ──
    rowData.push({ values: Array(numCols).fill(null).map((_, i) => i === 0
      ? cell(title, { textFormat: { bold: true, fontSize: 14, fontFamily: "Arial" }, horizontalAlignment: "CENTER", verticalAlignment: "MIDDLE" })
      : empty()
    )});

    // ── Info rows ──
    const addInfo = (label, value) => {
      rowData.push({ values: Array(numCols).fill(null).map((_, i) =>
        i === 0 ? cell(label, blueFmt) : i === 1 ? cell(value, blueFmt) : empty(blueFmt)
      )});
    };
    if (settings.name) addInfo("Name:", settings.name);
    addInfo("Period:", monthLabel);
    if (hasRate) addInfo("Hourly Rate:", `$${hourlyRate.toFixed(2)}`);

    rowData.push(blankRow());

    // ── Header row (record its index for freezing) ──
    const headerRowIndex = rowData.length;
    const headerLabels = hasRate
      ? ["Date", "Start", "End", "Project", "Billable", "Break (min)", "Income", "Hours", "Total Income", "Total Hours", "Description"]
      : ["Date", "Start", "End", "Project", "Billable", "Break (min)", "Hours", "Total Hours", "Description"];
    rowData.push({ values: headerLabels.map((h) => cell(h, navyFmt)) });

    // ── Group entries by week → day ──
    const sorted = [...monthEntries].sort((a, b) => a.date.localeCompare(b.date));
    const weekMap = new Map();
    for (const e of sorted) {
      const wk = weekStart(e.date);
      if (!weekMap.has(wk)) weekMap.set(wk, new Map());
      const dayMap = weekMap.get(wk);
      if (!dayMap.has(e.date)) dayMap.set(e.date, []);
      dayMap.get(e.date).push(e);
    }

    let grandMins = 0, grandEarned = 0;

    for (const [wkStr, dayMap] of weekMap) {
      let weekMins = 0, weekEarned = 0;
      for (const dayEntries of dayMap.values()) {
        for (const e of dayEntries) {
          weekMins += e.minutes;
          if (hasRate && e.billable !== false) weekEarned += (e.minutes / 60) * hourlyRate;
        }
      }

      // Week row — Total Income at numCols-3 (if hasRate), Total Hours at numCols-2, Description blank at numCols-1
      rowData.push({ values: Array(numCols).fill(null).map((_, i) => {
        if (i === 0) return cell(weekRangeLabel(wkStr), navyFmt);
        if (hasRate && i === numCols - 3) return cell(formatMoney(weekEarned), navyFmt);
        if (i === numCols - 2) return cell(formatDuration(weekMins), navyFmt);
        return empty(navyFmt);
      })});

      for (const [date, dayEntries] of dayMap) {
        const dayMins = dayEntries.reduce((a, e) => a + e.minutes, 0);
        const dayEarned = hasRate ? dayEntries.reduce((a, e) => a + (e.billable !== false ? (e.minutes / 60) * hourlyRate : 0), 0) : 0;
        const dayLabel = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

        // Day row
        rowData.push({ values: Array(numCols).fill(null).map((_, i) => {
          if (i === 0) return cell(dayLabel, lightFmt);
          if (hasRate && i === numCols - 3) return cell(formatMoney(dayEarned), lightFmt);
          if (i === numCols - 2) return cell(formatDuration(dayMins), lightFmt);
          return empty(lightFmt);
        })});

        // Entry rows
        for (const e of dayEntries) {
          const bm = unpaidBreakMins(e);
          const projectName = (e.project_ids || []).map((id) => projectMap.get(id)?.name).filter(Boolean).join(", ");
          const earned = hasRate && e.billable !== false ? formatMoney((e.minutes / 60) * hourlyRate) : "";
          const entryCells = hasRate
            ? [empty(baseFmt), cell(toDisplayTime(e.start), baseFmt), cell(toDisplayTime(e.end), baseFmt), cell(projectName, baseFmt), cell(e.billable === false ? "No" : "Yes", baseFmt), cell(bm > 0 ? bm : "", baseFmt), cell(earned, baseFmt), cell(formatDuration(e.minutes), baseFmt), empty(baseFmt), empty(baseFmt), cell(e.description || "", baseFmt)]
            : [empty(baseFmt), cell(toDisplayTime(e.start), baseFmt), cell(toDisplayTime(e.end), baseFmt), cell(projectName, baseFmt), cell(e.billable === false ? "No" : "Yes", baseFmt), cell(bm > 0 ? bm : "", baseFmt), cell(formatDuration(e.minutes), baseFmt), empty(baseFmt), cell(e.description || "", baseFmt)];
          rowData.push({ values: entryCells });
        }

        grandMins += dayMins;
        grandEarned += dayEarned;
      }

      rowData.push(blankRow());
    }

    // ── Total row ──
    rowData.push({ values: Array(numCols).fill(null).map((_, i) => {
      if (i === 0) return cell("TOTAL", boldFmt);
      if (hasRate && i === numCols - 3) return cell(formatMoney(grandEarned), boldFmt);
      if (i === numCols - 2) return cell(formatDuration(grandMins), boldFmt);
      return empty(boldFmt);
    })});

    // ── AI Summary (if available) ──
    const summary = monthSummaries[monthStr]?.text;
    if (summary) {
      rowData.push(blankRow());
      rowData.push({ values: Array(numCols).fill(null).map((_, i) => i === 0 ? cell("AI Summary", blueFmt) : empty(blueFmt)) });
      rowData.push({ values: [cell(summary, { textFormat: { fontSize: 11, fontFamily: "Arial" }, verticalAlignment: "TOP", wrapStrategy: "WRAP" }), ...Array(numCols - 1).fill(null).map(() => empty())] });
    }

    // ── Create spreadsheet ──
    const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      headers: { "Authorization": `Bearer ${googleTokenRef.current}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        properties: { title },
        sheets: [{ properties: { title: "Timesheet" }, data: [{ startRow: 0, startColumn: 0, rowData }] }],
      }),
    });

    if (!res.ok) {
      if (res.status === 401) { connectGoogle(); return; }
      if (res.status === 403) { flash("✗ Sheets: enable Google Sheets API in your Google Cloud project"); return; }
      flash("✗ Google Sheets export failed");
      return;
    }
    const created = await res.json();
    const spreadsheetId = created.spreadsheetId;
    const sheetId = created.sheets[0].properties.sheetId;

    // ── batchUpdate: merge title + summary rows, freeze header, set column widths ──
    const colWidths = hasRate ? [160, 80, 80, 140, 70, 100, 100, 80, 120, 120, 260] : [160, 80, 80, 140, 70, 100, 80, 120, 260];
    const summaryRowIndex = summary ? rowData.length - 1 : -1; // last row is the summary text row
    const summaryHdrIndex = summary ? rowData.length - 2 : -1;
    fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${googleTokenRef.current}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [
        { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols }, mergeType: "MERGE_ALL" } },
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: headerRowIndex + 1 } }, fields: "gridProperties.frozenRowCount" } },
        ...colWidths.map((pixelSize, i) => ({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize }, fields: "pixelSize" } })),
        ...(summary ? [
          { mergeCells: { range: { sheetId, startRowIndex: summaryHdrIndex, endRowIndex: summaryHdrIndex + 1, startColumnIndex: 0, endColumnIndex: numCols }, mergeType: "MERGE_ALL" } },
          { mergeCells: { range: { sheetId, startRowIndex: summaryRowIndex, endRowIndex: summaryRowIndex + 1, startColumnIndex: 0, endColumnIndex: numCols }, mergeType: "MERGE_ALL" } },
          { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: summaryRowIndex, endIndex: summaryRowIndex + 1 }, properties: { pixelSize: 120 }, fields: "pixelSize" } },
        ] : []),
      ]}),
    }).catch(() => {}); // best-effort — sheet is already created

    window.open(created.spreadsheetUrl, "_blank");
    flash("✓ Opened in Google Sheets");
  }

  // Create a Google Calendar event on the user's primary calendar. Foreground /
  // client-side (same token pattern as the Sheets export). Returns
  // { id, htmlLink } or null on failure (and re-prompts consent on 401/403).
  async function createCalendarEvent({ summary, description, start, end, attendees = [], location }) {
    if (!(await ensureGoogleToken())) {
      connectGoogle();
      return null;
    }
    const toISO = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
    const body = {
      summary: summary || "Meeting",
      ...(description ? { description } : {}),
      ...(location ? { location } : {}),
      start: { dateTime: toISO(start) },
      end: { dateTime: toISO(end) },
      attendees: (attendees || []).filter(Boolean).map((email) => ({ email })),
    };
    let res;
    try {
      res = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all",
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${googleTokenRef.current}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch {
      flash("✗ Could not reach Google Calendar");
      return null;
    }
    if (!res.ok) {
      if (res.status === 401) { connectGoogle(); return null; }
      // Missing scope surfaces as 403 (not 401) — re-consent to pick up calendar.
      if (res.status === 403) { connectGoogle(); flash("Reconnect Google to enable Calendar"); return null; }
      flash("✗ Could not create calendar event");
      return null;
    }
    const created = await res.json();
    return { id: created.id, htmlLink: created.htmlLink };
  }

  // Create a Google Doc and write the summary (then transcript) into it.
  // Foreground / client-side. Returns { documentId, url } or null on failure.
  async function exportToGoogleDoc({ title, summaryMd, transcriptText }) {
    if (!(await ensureGoogleToken())) {
      connectGoogle();
      return null;
    }
    let createRes;
    try {
      createRes = await fetch("https://docs.googleapis.com/v1/documents", {
        method: "POST",
        headers: { "Authorization": `Bearer ${googleTokenRef.current}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || "Meeting summary" }),
      });
    } catch {
      flash("✗ Could not reach Google Docs");
      return null;
    }
    if (!createRes.ok) {
      if (createRes.status === 401) { connectGoogle(); return null; }
      if (createRes.status === 403) { connectGoogle(); flash("Reconnect Google to enable Docs"); return null; }
      flash("✗ Could not create Google Doc");
      return null;
    }
    const doc = await createRes.json();
    const documentId = doc.documentId;
    const url = `https://docs.google.com/document/d/${documentId}/edit`;

    // Assemble the whole body once and insert it in a single request. (Multiple
    // insertText requests all at index 1 would stack in reverse order.)
    const parts = [];
    if (summaryMd) parts.push(summaryMd.trim(), "\n\n");
    if (transcriptText) parts.push("Transcript\n\n", transcriptText.trim(), "\n");
    const text = parts.join("");

    if (text) {
      // The create round-trip can straddle the ~1h token life — re-ensure before
      // the batchUpdate. A silent refresh keeps it going; only a failed refresh
      // hands back the (empty) doc + re-auth.
      if (!(await ensureGoogleToken())) { connectGoogle(); return { documentId, url }; }
      await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${googleTokenRef.current}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text } }] }),
      }).catch(() => {}); // best-effort — the doc already exists
    }

    return { documentId, url };
  }

  // Read the user's Google Calendar (primary) for a window. Foreground token —
  // the existing calendar.events scope already permits events.list. Returns a
  // lean normalized list; stays silent on failure (it's a background layer).
  // Returns the fetched events on success (an EMPTY array is a valid "no events"
  // result), or `null` when not connected / the request failed — so callers can
  // tell a real empty window from a desync and avoid clobbering a cache.
  async function listGoogleCalendarEvents({ timeMin, timeMax }) {
    if (!(await ensureGoogleToken())) return null;
    const params = new URLSearchParams({
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
    let res;
    try {
      res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
        headers: { "Authorization": `Bearer ${googleTokenRef.current}` },
      });
    } catch { return null; }
    if (!res.ok) {
      // Token expired / lost scope: clear it so callers stop retrying (no 401
      // storm) and the UI falls back to a "Connect Google" prompt.
      if (res.status === 401 || res.status === 403) { setGoogleToken(null); setGoogleTokenExpiry(0); }
      return null;
    }
    const data = await res.json().catch(() => ({}));
    return (data.items || []).map((ev) => {
      // Working-location events (eventType 'workingLocation') describe where the
      // person is working that day (home/office/custom) — surface a label so the
      // calendar can render them as a location badge, not a normal event.
      const wl = ev.workingLocationProperties;
      let locationLabel = null;
      if (ev.eventType === "workingLocation" && wl) {
        if (wl.type === "homeOffice") locationLabel = "Home";
        else if (wl.type === "officeLocation") locationLabel = wl.officeLocation?.label || "Office";
        else if (wl.type === "customLocation") locationLabel = wl.customLocation?.label || "Elsewhere";
        else locationLabel = "Working";
      }
      return {
        id: ev.id,
        iCalUID: ev.iCalUID, // lets the calendar dedupe vs published company events
        title: ev.summary || locationLabel || "(busy)",
        start: ev.start?.dateTime || ev.start?.date,
        end: ev.end?.dateTime || ev.end?.date,
        allDay: !ev.start?.dateTime,
        htmlLink: ev.htmlLink,
        eventType: ev.eventType || "default",
        locationLabel,
      };
    });
  }

  // Company-event candidates: read the user's PRIMARY calendar (where company
  // events sit mixed with personal ones) and keep only those that look like
  // company events — someone other than you, on your company email domain, is
  // involved. A SUGGESTION list for the review UI; nothing is shared until the
  // user confirms. Returns candidates on success, or null when not connected /
  // the request failed (so callers can tell empty from error).
  async function listGoogleCompanyCandidates({ timeMin, timeMax }) {
    if (!(await ensureGoogleToken())) return null;
    const myEmail = session?.user?.email || "";
    const companyDomain = emailDomain(myEmail);
    if (!companyDomain) return [];
    const params = new URLSearchParams({
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
    let res;
    try {
      res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
        headers: { "Authorization": `Bearer ${googleTokenRef.current}` },
      });
    } catch { return null; }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) { setGoogleToken(null); setGoogleTokenExpiry(0); }
      return null;
    }
    const data = await res.json().catch(() => ({}));
    return (data.items || [])
      .filter((ev) => ev.status !== "cancelled" && (ev.eventType || "default") === "default")
      .filter((ev) => isLikelyCompanyEvent(ev, { companyDomain, myEmail }))
      .map(googleRawToCompanyCandidate);
  }

  // Patch a Google event we created (write-back on reschedule/edit).
  async function updateCalendarEvent(eventId, { start, end, summary, description } = {}) {
    if (!eventId || !(await ensureGoogleToken())) return { error: { message: "not connected" } };
    const toISO = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
    const body = {};
    if (start) body.start = { dateTime: toISO(start) };
    if (end) body.end = { dateTime: toISO(end) };
    if (summary !== undefined) body.summary = summary;
    if (description !== undefined) body.description = description || "";
    let res;
    try {
      res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${googleTokenRef.current}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch { return { error: { message: "network" } }; }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) connectGoogle();
      return { error: { message: `google ${res.status}` } };
    }
    return { error: null };
  }

  // Delete a Google event we created (best-effort — silent on failure).
  async function deleteCalendarEvent(eventId) {
    if (!eventId || !(await ensureGoogleToken())) return { error: null };
    try {
      await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${googleTokenRef.current}` },
      });
    } catch { /* best-effort */ }
    return { error: null };
  }

  async function addProjectQuick(name, color = "#14b8a6") {
    if (!session?.user?.id || !name.trim()) return null;
    const { data } = await supabase.from("projects").insert({
      user_id: session.user.id,
      name: name.trim(),
      client_name: "",
      color,
    }).select().single();
    if (data) {
      setProjects((prev) => [...prev, data]);
      return data;
    }
    return null;
  }

  const value = {
    // data
    session, entries, projects, settings, templates, dataSyncing, dataLoaded,
    hourlyRate, deepseekKey, reminderTime, timeRounding, dailyTarget, weeklyTarget, defaultEntryMode, defaultLandingPage, stickyColor, setStickyColor,
    setSettings, setHourlyRate, setDailyTarget, setWeeklyTarget, updateSettingsField,
    // onboarding / tutorial state setters (settings.onboarding jsonb)
    markTourComplete, dismissTour, setChecklistItem, setWelcomeDone, setSeenTourMarker, setHintsDisabled,
    // widget preferences (settings.widget_prefs jsonb) — synced order + pins
    mergeWidgetPrefs,
    // setters used by the SettingsPage's immediate-save flow
    setTemplates, setProjects,
    setDeepseekKey, setReminderTime, setTimeRounding,
    setDefaultEntryMode, setDefaultLandingPage,
    // custom sounds (user)
    addCustomSound, renameCustomSound, removeCustomSound,
    updateStatus,
    // ui
    form, setForm, exportMsg, flash,
    localImportBanner, setLocalImportBanner,
    importEntriesRef, importProfileRef, logHoursRef, dateInputRef,
    // clock
    clockIn, clockedTick, handleClockIn, handleClockOut, clockedElapsed, breakElapsed,
    updateClockIn, addClockNote, startClockBreak, endClockBreak,
    // tasks within a clock-in session
    currentTask, switchTask, renameCurrentTask,
    clockOutAndFill: () => { const p = handleClockOut(); if (p) setPendingEntry(p); },
    pendingEntry,
    updatePendingEntry: (fields) => setPendingEntry((prev) => prev ? { ...prev, ...fields } : prev),
    clearPendingEntry: () => setPendingEntry(null),
    // entries
    handleSubmit, handleDelete, saveInlineEdit, duplicateEntry,
    inlineEditId, inlineForm,
    startInlineEdit, cancelInlineEdit, setInlineField,
    addInlineBreak, updateInlineBreak, removeInlineBreak,
    sortAsc, setSortAsc, expandedDates, toggleExpanded,
    // form helpers
    applyTemplate, setField, addBreak, updateBreak, removeBreak,
    // settings modal
    showSettings, setShowSettings, openSettings, saveSettings,
    draftSettings, setDraftSettings,
    draftTemplates, draftNewTemplate, draftEditingId, draftEditingTemplate,
    startDraftNew, commitDraftNew, startDraftEdit, commitDraftEdit, deleteDraftTemplate,
    setDraftNewTemplate, setDraftEditingId, setDraftEditingTemplate,
    draftProjects, draftNewProject, draftEditingProjectId,
    startDraftNewProject, commitDraftNewProject, startDraftEditProject, commitDraftEditProject, deleteDraftProject,
    setDraftNewProject, setDraftEditingProjectId,
    // earnings
    earningsPeriod, setEarningsPeriod, earningsData,
    // ai
    rewritingDesc, rewriteDescription,
    monthSummaries, setMonthSummaries, generateMonthSummary,
    breakdownPlannerTask, suggestSubtasks,
    // invoice
    showInvoice, setShowInvoice,
    // computed
    todayMins, grouped,
    // projects
    addProjectQuick,
    // google (sheets / calendar / docs)
    googleToken, googleTokenExpiry,
    connectGoogle, disconnectGoogle: disconnectGoogleSheets,
    connectGoogleSheets: connectGoogle, disconnectGoogleSheets, // back-compat aliases
    exportToGoogleSheets, createCalendarEvent, exportToGoogleDoc,
    listGoogleCalendarEvents, updateCalendarEvent, deleteCalendarEvent,
    listGoogleCompanyCandidates, companyEmailDomain: emailDomain(session?.user?.email),
    // export/import
    exportAllCSV, exportMonthCSV, exportAllXLSX, exportMonthXLSX,
    importFromLocalStorage, importEntriesFromFile, exportProfile, importProfileFromFile,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  return useContext(AppContext);
}
