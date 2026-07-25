import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import { ChevronLeft, ChevronRight, ChevronDown, Plus, CalendarClock, CalendarPlus, CheckSquare, User, Users, Home, Target, Umbrella, AlertTriangle, PanelLeft, PanelRight, X, LayoutGrid, Columns3, RectangleVertical, Maximize2, RotateCw } from "lucide-react";
import { useApp } from "../context/AppContext";
import { useTeam } from "../context/TeamContext";
import { useTheme } from "../context/ThemeContext";
import { listTeamGoals, weekBucket } from "../lib/goals";
import { listMilestonesInRange, updateMilestone } from "../lib/milestones";
import { getProfiles } from "../lib/profiles";
import {
  LAYERS, toDateStr, timeStrFromDate,
  fetchMeetingsInRange, fetchPlannerTasksInRange, fetchPlannerDueInRange,
  fetchPersonalDueInRange, fetchMyAvailability,
  meetingToEvent, plannerTaskToEvent, taskDueToEvent, personalDueToEvent,
  milestoneToEvent, goalToEvent, goalGridSpan, availabilityToEvents, entryToEvent,
  googleEventToEvent, companyEventToEvent, profileOooToEvents,
  workLocationEvents, workHoursBackgroundEvents,
  updateMeetingTime, updatePlannerSchedule, updateTaskDue, updatePersonalDue,
  updatePlannerTaskFields, createPlannerTask, fetchOpenPlannerTasks, saveWorkLocationOverrides,
} from "../lib/calendar";
import { cacheGoogleEvents, loadGoogleCache } from "../lib/googleCache";
import { loadCompanyEvents } from "../lib/companyEvents";
import CompanyEventsReview from "../components/calendar/CompanyEventsReview";
import RemoveCompanyEventDialog from "../components/calendar/RemoveCompanyEventDialog";
import Modal from "../components/Modal";
import { oceanType, OCEAN_LEGEND } from "../components/calendar/oceanTheme";
import MiniMonth from "../components/calendar/MiniMonth";
import EventSlideOver from "../components/calendar/EventSlideOver";
import MilestoneModal from "../components/calendar/MilestoneModal";
import NewItemPopover from "../components/calendar/NewItemPopover";
import TaskDetailSheet from "../components/tasks/TaskDetailSheet";
import { normalizeTask } from "../lib/tasks/model";
import { setTaskStatus } from "../lib/tasks/mutations";
import { StatusControl } from "../components/tasks/TaskControls";
import ScheduleMeetingModal from "../components/office/ScheduleMeetingModal";
import FindATimeModal from "../components/calendar/FindATimeModal";
import { fetchSubtaskCounts } from "../lib/subtasks";
import "../components/calendar/calendar-ocean.css";

const LS_LAYERS = "cal_layers";
const LS_SCOPE = "cal_scope";
const LS_WEEKSTART = "cal_weekstart";
const PERSONAL_ONLY = new Set(["tasks", "actuals", "google"]);
// Company events are a TEAM-tab thing (the personal tab already shows them as
// ordinary Google events) — so the "company" layer only appears in team scope.
const TEAM_ONLY = new Set(["company"]);
// Day reading order (lower = higher). CONTEXT band on top (OOO, goals, work
// location), then the "meat" — meetings + deadlines by priority — then tasks.
const RANK = {
  ooo: 0.0, goal: 0.1, worklocation_conflict: 0.15, worklocation_app: 0.2, worklocation: 0.25,
  task_due: 1.0, ptask_due: 1.0, milestone: 1.2, google: 1.4, company: 1.1,
  task: 3.0, actual: 4.0,
};
const CTX_TYPES = new Set(["worklocation_app", "worklocation", "worklocation_conflict", "ooo", "goal"]);
const rankFor = (p) => (p?.type === "meeting"
  ? 1.0 - ((p.priority ?? 1) - 1) * 0.3   // high(2)=0.7 above deadlines · low(0)=1.3 below
  : RANK[p?.type] ?? 2);
const AGENDA_SKIP = new Set(["ooo_bg", "workhours"]);
const AGENDA_STATUS = new Set(["worklocation", "worklocation_app", "worklocation_conflict", "ooo", "goal"]);
const LS_GOALS_COLLAPSED = "cal_goals_collapsed";
// Sidebar goal groups, in display order.
const GOAL_GROUPS = [
  ["thisWeek", "This week"], ["nextWeek", "Next week"], ["month", "This month"],
  ["quarter", "This quarter"], ["year", "This year"], ["ongoing", "Ongoing"], ["earlier", "Earlier weeks"],
];
function goalGroupKey(g) {
  if (g.horizon === "week") { const b = weekBucket(g); return b === "this" ? "thisWeek" : b === "next" ? "nextWeek" : "earlier"; }
  if (g.horizon === "month") return "month";
  if (g.horizon === "quarter") return "quarter";
  if (g.horizon === "year") return "year";
  return "ongoing";
}

// Merge the app work-schedule location with Google's working-location per day.
// Same location → one chip; different → a single conflict chip showing both.
const LOC_CODE_LABEL = { office: "Office", home: "Home", remote: "Remote", out: "Out" };
const canonLoc = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
function mergeWorkLocations(appLoc, gLoc, overrides = {}) {
  const out = [];
  const dates = new Set([...appLoc.keys(), ...gLoc.keys()]);
  dates.forEach((date) => {
    const aCode = appLoc.get(date);
    const aLabel = aCode ? (LOC_CODE_LABEL[aCode] || aCode) : null;
    const gLabel = gLoc.get(date) || null;
    let type = "worklocation_app", title = aLabel, conflict = null;
    if (aLabel && gLabel) {
      if (overrides[date]) { title = overrides[date]; type = "worklocation"; } // resolved
      else if (canonLoc(aLabel) === canonLoc(gLabel)) { title = aLabel; type = "worklocation"; }
      else { title = `${aLabel} vs ${gLabel}`; type = "worklocation_conflict"; conflict = { app: aLabel, google: gLabel, date }; }
    } else if (gLabel) { title = gLabel; type = "worklocation"; }
    if (!title) return;
    out.push({ id: `wloc:${date}`, title, start: date, allDay: true, editable: false, extendedProps: { type, loc: aCode, conflict } });
  });
  return out;
}

// Scope a goal to the viewer: own personal goals, department goals for members,
// company goals for all. Skip completed goals.
function goalVisibleToViewer(g, myUserId, myOrgTeamIds) {
  if (g.status === "done") return false;
  if (g.owner_type === "user") return g.owner_id === myUserId;
  if (g.owner_type === "department") return !!myOrgTeamIds?.has?.(g.owner_id);
  return true; // company / team-wide
}
const stripEmoji = (s) => String(s || "").replace(/^[⏳◆🏖⏱🎯]\s*/, "");
const eventDayStr = (e) => (e.allDay && typeof e.start === "string" && e.start.length === 10 ? e.start : toDateStr(new Date(e.start)));

function loadEnabledLayers() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_LAYERS));
    if (Array.isArray(raw)) return new Set(raw.filter((l) => LAYERS.includes(l)));
  } catch { /* */ }
  return new Set(LAYERS.filter((l) => l !== "google"));
}

export default function CalendarPage() {
  const { session, entries, googleToken, googleTokenExpiry, connectGoogle, listGoogleCalendarEvents, updateCalendarEvent, listGoogleCompanyCandidates, companyEmailDomain } = useApp();
  const { activeTeamId, rooms, teamMembers, myOrgTeamIds, isAdmin } = useTeam();
  const { theme } = useTheme();
  const dark = theme === "dark";
  const navigate = useNavigate();
  const userId = session?.user?.id;
  const googleConnected = !!googleToken && Date.now() < googleTokenExpiry;

  const [enabledLayers, setEnabledLayers] = useState(loadEnabledLayers);
  const [events, setEvents] = useState([]);
  const [avail, setAvail] = useState(null);
  const [teamProfiles, setTeamProfiles] = useState({});
  const [scope, setScope] = useState(() => { try { return localStorage.getItem(LS_SCOPE) || "personal"; } catch { return "personal"; } });
  const [weekStart, setWeekStart] = useState(() => { try { return localStorage.getItem(LS_WEEKSTART) === "0" ? 0 : 1; } catch { return 1; } });
  const [title, setTitle] = useState("");
  const [viewType, setViewType] = useState("dayGridMonth");
  // Week-view width level (normal fits to width; wide/xwide widen day columns +
  // scroll horizontally so more event detail fits). Persisted per device.
  const [weekWidth, setWeekWidth] = useState(() => { try { return localStorage.getItem("cal_weekw") || "normal"; } catch { return "normal"; } });
  const changeWeekWidth = (w) => { setWeekWidth(w); try { localStorage.setItem("cal_weekw", w); } catch { /* */ } };
  const [focusDate, setFocusDate] = useState(() => new Date());
  const [detailEvent, setDetailEvent] = useState(null);
  const [newSlot, setNewSlot] = useState(null);
  const [milestoneModal, setMilestoneModal] = useState(null);
  const [meetingModal, setMeetingModal] = useState(null);
  const [findTime, setFindTime] = useState(false);
  const [taskEdit, setTaskEdit] = useState(null);
  const [allGoals, setAllGoals] = useState([]);
  const [myTasks, setMyTasks] = useState([]);
  /** plannerTaskId -> { done, total, pct } for subtask surfacing on chips + cards. */
  const [subCounts, setSubCounts] = useState({});
  const [locConflict, setLocConflict] = useState(null); // { app, google, date }
  const [companyReviewOpen, setCompanyReviewOpen] = useState(false);
  const [removeCompany, setRemoveCompany] = useState(null); // { icalUid, title }
  const [expanded, setExpanded] = useState(false);
  // On narrow screens (≤1180px) the left rail is CSS-hidden; this reveals it as
  // an overlay drawer so its filters / mini-month / scope switch stay reachable
  // (e.g. on iPad). Ignored on desktop, where the rail is always inline.
  const [railOpen, setRailOpen] = useState(false);
  // The right rail (agenda + tasks) drops at an even narrower breakpoint (≤920px)
  // where BOTH rails are gone, so it gets its own reveal drawer too.
  const [railRightOpen, setRailRightOpen] = useState(false);
  const closeRails = useCallback(() => { setRailOpen(false); setRailRightOpen(false); }, []);
  useEffect(() => {
    if (!railOpen && !railRightOpen) return undefined;
    const onKey = (e) => { if (e.key === "Escape") closeRails(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [railOpen, railRightOpen, closeRails]);
  const [goalsCollapsed, setGoalsCollapsed] = useState(() => { try { return localStorage.getItem(LS_GOALS_COLLAPSED) === "1"; } catch { return false; } });
  const [openGroups, setOpenGroups] = useState(() => new Set(["thisWeek", "month"]));

  const calRef = useRef(null);
  const rangeRef = useRef(null);
  const layersRef = useRef(enabledLayers); layersRef.current = enabledLayers;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const weekStartRef = useRef(weekStart); weekStartRef.current = weekStart;
  const orgTeamsRef = useRef(myOrgTeamIds); orgTeamsRef.current = myOrgTeamIds;
  const goalsCollapsedRef = useRef(goalsCollapsed); goalsCollapsedRef.current = goalsCollapsed;
  const gcalRef = useRef(listGoogleCalendarEvents); gcalRef.current = listGoogleCalendarEvents;
  const gUpdateRef = useRef(updateCalendarEvent); gUpdateRef.current = updateCalendarEvent;

  useEffect(() => { if (userId) fetchMyAvailability(userId).then(({ data }) => setAvail(data || null)); }, [userId]);
  const reloadTasks = useCallback(() => {
    if (!userId) return;
    fetchOpenPlannerTasks(userId).then(async ({ data }) => {
      const tasks = data || [];
      setMyTasks(tasks);
      const ids = tasks.map((t) => t.id);
      if (ids.length) {
        const { byPlanner } = await fetchSubtaskCounts({ plannerIds: ids });
        setSubCounts((prev) => ({ ...prev, ...byPlanner }));
      }
    });
  }, [userId]);
  useEffect(() => { reloadTasks(); }, [reloadTasks]);
  useEffect(() => {
    if (scope !== "team" || !teamMembers?.length) { setTeamProfiles({}); return; }
    getProfiles(teamMembers.map((m) => m.user_id).filter(Boolean)).then((map) => setTeamProfiles(map || {}));
  }, [scope, teamMembers]);

  const loadRange = useCallback(async (startDate, endDate) => {
    const layers = layersRef.current;
    const team = scopeRef.current === "team";
    const startStr = toDateStr(startDate);
    const endStr = toDateStr(endDate);
    const collected = [];
    const jobs = [];
    const appLoc = new Map();   // date → app work-location code (from work_schedule)
    const gLoc = new Map();      // date → Google working-location label

    if (layers.has("meetings") && activeTeamId) {
      jobs.push(fetchMeetingsInRange(activeTeamId, startDate.toISOString(), endDate.toISOString())
        .then(({ data }) => (data || []).forEach((m) => collected.push(meetingToEvent(m)))));
    }
    // Company events (Google → confirmed for the team) live on the TEAM tab only
    // — the personal tab already shows these as ordinary Google events.
    if (team && layers.has("company") && activeTeamId) {
      jobs.push(loadCompanyEvents(activeTeamId, startDate.toISOString(), endDate.toISOString())
        .then((rows) => (rows || []).forEach((r) => collected.push(companyEventToEvent(r)))));
    }
    if (layers.has("goals") && activeTeamId) {
      jobs.push(listTeamGoals(activeTeamId).then(({ data }) => {
        const scoped = (data || []).filter((g) => goalVisibleToViewer(g, userId, orgTeamsRef.current));
        setAllGoals(scoped);
        const ws = weekStartRef.current;
        if (goalsCollapsedRef.current) {
          // Collapsed: ONE thin line per unique week/month span (not per goal).
          const spans = new Map();
          scoped.forEach((g) => {
            const span = goalGridSpan(g, ws);
            if (!span || span.start >= endStr || span.end <= startStr) return;
            const key = `${span.start}_${span.end}`;
            const cur = spans.get(key) || { span, count: 0 };
            cur.count += 1;
            spans.set(key, cur);
          });
          spans.forEach(({ span, count }, key) => collected.push({
            id: `goalsline:${key}`, start: span.start, end: span.end, allDay: true, display: "block",
            editable: false, classNames: ["cal-span", "cal-span-goal", "cal-goal-min"],
            extendedProps: { type: "goal", collapsed: true, count },
          }));
        } else {
          scoped.forEach((g) => {
            const e = goalToEvent(g, ws, false);
            if (e && e.start < endStr && e.end > startStr) collected.push(e); // overlaps visible range
          });
        }
      }));
    } else {
      setAllGoals([]);
    }
    if (!team) {
      if (layers.has("tasks") && userId) {
        jobs.push(fetchPlannerTasksInRange(userId, startStr, endStr).then(({ data }) => (data || []).forEach((t) => collected.push(plannerTaskToEvent(t)))));
      }
      if (layers.has("deadlines") && userId) {
        jobs.push(fetchPlannerDueInRange(userId, startStr, endStr).then(({ data }) => (data || []).forEach((t) => collected.push(taskDueToEvent(t)))));
        jobs.push(fetchPersonalDueInRange(userId, startStr, endStr).then(({ data }) => (data || []).forEach((t) => collected.push(personalDueToEvent(t)))));
        if (activeTeamId) jobs.push(listMilestonesInRange(activeTeamId, startStr, endStr).then(({ data }) => (data || []).forEach((m) => collected.push(milestoneToEvent(m)))));
      }
      if (layers.has("availability") && avail) {
        availabilityToEvents(avail).forEach((e) => collected.push(e));
        // App work location → merged below (not pushed directly, to dedupe vs Google).
        workLocationEvents(avail, startDate, endDate).forEach((e) => appLoc.set(e.start, e.extendedProps?.loc));
        workHoursBackgroundEvents(avail, startDate, endDate).forEach((e) => collected.push(e));
      }
      if (layers.has("actuals")) (entries || []).filter((e) => e.date >= startStr && e.date < endStr).forEach((e) => collected.push(entryToEvent(e)));
      if (layers.has("google")) {
        // Personal Google events (company events live on the Team tab's own
        // "company" layer, so there's no double here to dedupe).
        const handleGoogle = (g) => {
          if (!g) return;
          if (g.eventType === "workingLocation") {
            const ds = g.allDay && typeof g.start === "string" && g.start.length === 10 ? g.start : toDateStr(new Date(g.start));
            gLoc.set(ds, g.locationLabel || g.title);
          } else {
            collected.push(googleEventToEvent(g));
          }
        };
        const gStart = startDate.toISOString(), gEnd = endDate.toISOString();
        if (googleToken) {
          // Connected: fetch live. A real array (even empty) = success → refresh
          // the cache. null = the token desynced mid-request → fall back to cache
          // so events don't vanish (and don't clobber the cache with nothing).
          jobs.push(Promise.resolve(gcalRef.current?.({ timeMin: gStart, timeMax: gEnd })).then((list) => {
            if (Array.isArray(list)) {
              list.forEach(handleGoogle);
              cacheGoogleEvents(userId, list, gStart, gEnd);
            } else {
              return loadGoogleCache(gStart, gEnd).then((cached) => cached.forEach(handleGoogle));
            }
          }));
        } else {
          // Disconnected: show the last events we cached while connected.
          jobs.push(loadGoogleCache(gStart, gEnd).then((cached) => cached.forEach(handleGoogle)));
        }
      }
    } else {
      if (layers.has("deadlines") && activeTeamId) jobs.push(listMilestonesInRange(activeTeamId, startStr, endStr).then(({ data }) => (data || []).filter((m) => m.scope === "team").forEach((m) => collected.push(milestoneToEvent(m)))));
      if (layers.has("availability")) Object.values(teamProfiles || {}).forEach((p) => profileOooToEvents(p).forEach((e) => collected.push(e)));
    }

    await Promise.all(jobs);
    // Merge app + Google work location into ONE chip per day (dedupe when they
    // agree; flag a conflict when they differ).
    if (!team) mergeWorkLocations(appLoc, gLoc, avail?.work_location_overrides || {}).forEach((e) => collected.push(e));
    // Stamp reading-order rank: context band → meetings/deadlines (by priority) → tasks.
    collected.forEach((e) => { if (e.extendedProps) e.extendedProps.orderRank = rankFor(e.extendedProps); });
    setEvents(collected);
    // Subtask counts for the planner-task chips now in view (chipContent reads subCounts).
    const taskIds = collected.filter((e) => e.extendedProps?.type === "task").map((e) => e.extendedProps.sourceId);
    if (taskIds.length) fetchSubtaskCounts({ plannerIds: taskIds }).then(({ byPlanner }) => setSubCounts((prev) => ({ ...prev, ...byPlanner })));
  }, [activeTeamId, userId, avail, entries, teamProfiles, googleToken]);

  const reload = useCallback(() => { if (rangeRef.current) loadRange(rangeRef.current.start, rangeRef.current.end); }, [loadRange]);

  const onDatesSet = useCallback((arg) => {
    rangeRef.current = { start: arg.start, end: arg.end };
    setTitle(arg.view.title);
    setViewType(arg.view.type);
    setFocusDate(arg.view.currentStart);
    loadRange(arg.start, arg.end);
  }, [loadRange]);

  useEffect(() => { reload(); }, [enabledLayers, scope, weekStart, goalsCollapsed, reload]);
  const toggleGoalsCollapsed = () => setGoalsCollapsed((v) => { const nv = !v; try { localStorage.setItem(LS_GOALS_COLLAPSED, nv ? "1" : "0"); } catch { /* */ } return nv; });
  const toggleGroup = (k) => setOpenGroups((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const api = () => calRef.current?.getApi();
  const changeScope = (id) => { setScope(id); try { localStorage.setItem(LS_SCOPE, id); } catch { /* */ } };
  const changeWeekStart = (v) => { setWeekStart(v); try { localStorage.setItem(LS_WEEKSTART, String(v)); } catch { /* */ } };
  const toggleLayer = (layer) => setEnabledLayers((prev) => {
    const next = new Set(prev);
    if (next.has(layer)) next.delete(layer); else next.add(layer);
    try { localStorage.setItem(LS_LAYERS, JSON.stringify([...next])); } catch { /* */ }
    return next;
  });


  const onEventChange = useCallback(async (info) => {
    const p = info.event.extendedProps || {};
    const start = info.event.start; const end = info.event.end;
    let res = { error: null };
    if (p.type === "meeting") {
      const endDate = end || new Date(start.getTime() + 30 * 60000);
      res = await updateMeetingTime(p.sourceId, start.toISOString(), endDate.toISOString());
      if (!res.error && p.googleEventId) gUpdateRef.current?.(p.googleEventId, { start, end: endDate });
    } else if (p.type === "task") {
      res = info.event.allDay
        ? await updatePlannerSchedule(p.sourceId, { planner_date: toDateStr(start), start_time: null, duration_min: null })
        : await updatePlannerSchedule(p.sourceId, { planner_date: toDateStr(start), start_time: timeStrFromDate(start), duration_min: end ? Math.round((end - start) / 60000) : 60 });
    } else if (p.type === "task_due") res = await updateTaskDue(p.sourceId, toDateStr(start));
    else if (p.type === "ptask_due") res = await updatePersonalDue(p.sourceId, toDateStr(start));
    else if (p.type === "milestone") res = await updateMilestone(p.sourceId, info.event.allDay ? { milestone_date: toDateStr(start), milestone_time: null } : { milestone_date: toDateStr(start), milestone_time: timeStrFromDate(start) });
    else { info.revert(); return; }
    if (res.error) info.revert();
  }, []);

  const openDetails = useCallback((ev) => {
    const p = ev.extendedProps || {};
    if (p.type === "worklocation_conflict" && p.conflict) { setLocConflict(p.conflict); return; }
    setDetailEvent({ title: ev.title, start: ev.start, end: ev.end, allDay: ev.allDay, extendedProps: p });
  }, []);
  const resolveLocation = async (date, label) => {
    const next = { ...(avail?.work_location_overrides || {}), [date]: label };
    await saveWorkLocationOverrides(userId, next);
    setAvail((a) => ({ ...(a || {}), work_location_overrides: next }));
    setLocConflict(null);
    reload();
  };
  const createTask = async (t) => {
    if (!newSlot || !userId) return;
    const s = newSlot.start;
    await createPlannerTask({ userId, title: t, plannerDate: toDateStr(s), startTime: newSlot.allDay ? null : timeStrFromDate(s), durationMin: !newSlot.allDay && newSlot.end ? Math.round((newSlot.end - s) / 60000) : null });
    reload();
  };
  const toggleTaskDone = async (row) => { await updatePlannerTaskFields(row.id, { done: !row.done }); reloadTasks(); reload(); };
  const setCardStatus = async (row, status) => { await setTaskStatus({ userId, task: normalizeTask(row, "planner"), status }); reloadTasks(); reload(); };

  // ── right-rail agenda: everything from ~now forward, sorted by time, with
  // consecutive same-type items clustered (grouped by type around a similar time). ──
  const todayStr = toDateStr(new Date());
  const agenda = useMemo(() => {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const items = events
      .filter((e) => e.display !== "background" && !AGENDA_SKIP.has(e.extendedProps?.type))
      .map((e) => ({ ...e, _s: new Date(e.start), _rank: e.extendedProps?.orderRank ?? 2 }))
      .filter((e) => !Number.isNaN(e._s.getTime()) && e._s >= startOfToday)
      .sort((a, b) => a._s - b._s || a._rank - b._rank);
    const days = [];
    let curKey = null;
    for (const it of items) {
      const k = toDateStr(it._s);
      if (k !== curKey) { days.push({ key: k, date: new Date(it._s), statuses: [], allday: [], runs: [] }); curKey = k; }
      const day = days[days.length - 1];
      const type = it.extendedProps?.type;
      // Order within a day: statuses (work location/OOO/goals) → all-day events → timed.
      if (AGENDA_STATUS.has(type)) { day.statuses.push(it); continue; }
      if (it.allDay) { day.allday.push(it); continue; }
      const last = day.runs[day.runs.length - 1];
      if (last && last.type === type) last.items.push(it);
      else day.runs.push({ type, items: [it] });
    }
    return days.slice(0, 10);
  }, [events]);

  const dayHeading = (d) => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const tm = new Date(t); tm.setDate(t.getDate() + 1);
    if (toDateStr(d) === toDateStr(t)) return "Today";
    if (toDateStr(d) === toDateStr(tm)) return "Tomorrow";
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };

  // Goals grouped by timeframe for the sidebar.
  const goalGroups = useMemo(() => {
    const b = { thisWeek: [], nextWeek: [], month: [], quarter: [], year: [], ongoing: [], earlier: [] };
    for (const g of allGoals) b[goalGroupKey(g)].push(g);
    return b;
  }, [allGoals]);

  const scopes = [{ id: "personal", icon: User, label: "Mine" }, { id: "team", icon: Users, label: "Team" }];
  const visibleLegend = OCEAN_LEGEND.filter((l) => (scope === "personal" ? !TEAM_ONLY.has(l.layer) : !PERSONAL_ONLY.has(l.layer)));

  const chipContent = (arg) => {
    if (arg.event.display === "background") return undefined; // OOO/work-hours shading
    const p = arg.event.extendedProps || {};
    const meta = oceanType(p.type);
    const title = stripEmoji(arg.event.title);
    const timed = !arg.event.allDay && arg.event.start;

    // Collapsed goal → a thin bar with no text (you see it's set, not what it is).
    if (p.type === "goal" && p.collapsed) {
      return <div className="cal-chip2 cal-chip2--ctx cal-goal-minchip" style={{ color: meta.fg }} />;
    }
    // Day-context band (compact, muted): work location, goals, OOO.
    if (CTX_TYPES.has(p.type)) {
      const isLoc = p.type === "worklocation" || p.type === "worklocation_app";
      const Icon = p.type === "worklocation_conflict" ? AlertTriangle : isLoc ? Home : p.type === "goal" ? Target : Umbrella;
      return (
        <div className="cal-chip2 cal-chip2--ctx" style={{ color: meta.fg }} title={title}>
          <Icon /><span className="ctitle">{title}</span>
        </div>
      );
    }

    const isTask = p.type === "task";
    const isDue = p.type === "task_due" || p.type === "ptask_due";
    const isLoc = p.type === "worklocation";
    const cls = ["cal-chip2"];
    if (isTask) cls.push("cal-chip2--task");
    else if (isDue) cls.push("cal-chip2--due");
    else if (isLoc) cls.push("cal-chip2--loc");
    if (p.done) cls.push("done");
    const style = isTask ? { color: meta.fg, borderColor: meta.solid } : { background: meta.bg, color: meta.fg, borderColor: meta.solid };
    const sc = isTask ? subCounts[p.sourceId] : null;
    // Week/Day (timeGrid) blocks have room to lead with the NAME — the time is
    // implied by the row and just trails it. Month cells are cramped, so there
    // the time still comes first.
    const timeGrid = arg.view.type === "timeGridWeek" || arg.view.type === "timeGridDay";
    const timeEl = timed && !isTask ? <span className="ctime">{arg.timeText}</span> : null;
    return (
      <div className={`${cls.join(" ")}${timeGrid ? " cal-chip2--stack" : ""}`} style={style} title={title}>
        {/* Name leads everywhere. Month is a single line (dot · name · time);
            week/day blocks stack the name over the time (no dot — the block is
            already colour-coded). */}
        {!timeGrid && (isTask ? <span className="cbox" /> : <span className="cdot" style={{ background: meta.solid }} />)}
        <span className="ctitle">{title}</span>
        {timeEl}
        {sc && sc.total > 0 && (
          <span style={{ marginLeft: "auto", paddingLeft: 4, fontSize: 10, opacity: 0.7, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
            {sc.done}/{sc.total}
          </span>
        )}
      </div>
    );
  };

  // "Expanded" only applies to the month grid — on week/day it's meaningless.
  const expandedMonth = expanded && viewType === "dayGridMonth";

  return (
    <div className="cal-ocean" data-weekw={weekWidth}>
      <div className="cal-ocean__shell">
        {/* Scrim behind either rail drawer on narrow screens — tap to dismiss. */}
        {(railOpen || railRightOpen) && <div className="cal-ocean__railscrim is-open" onClick={closeRails} aria-hidden />}

        {/* ── left rail ── */}
        <aside className={`cal-ocean__rail cal-ocean__rail--left${railOpen ? " is-open" : ""}`}>
          {/* Close affordance — only visible when the rail is a drawer. */}
          <button type="button" className="cal-ocean__railclose" aria-label="Close panel" onClick={() => setRailOpen(false)}>
            <X className="w-4 h-4" />
          </button>
          <div className="cal-ocean__seg" style={{ width: "100%", marginBottom: 16 }}>
            {scopes.map((s) => {
              const Icon = s.icon;
              return (
                <button key={s.id} type="button" aria-pressed={scope === s.id} onClick={() => changeScope(s.id)} style={{ flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
                  <Icon className="w-3.5 h-3.5" /> {s.label}
                </button>
              );
            })}
          </div>

          <div className="cal-ocean__card" style={{ padding: 12 }}>
            <MiniMonth selected={focusDate} weekStart={weekStart} onPick={(d) => { api()?.gotoDate(d); setFocusDate(d); }} />
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
              <span style={{ fontSize: 11, color: "var(--o-ink-400)", fontWeight: 700 }}>Week starts</span>
              <div className="cal-ocean__seg" style={{ marginLeft: "auto" }}>
                <button type="button" aria-pressed={weekStart === 0} onClick={() => changeWeekStart(0)}>Sun</button>
                <button type="button" aria-pressed={weekStart === 1} onClick={() => changeWeekStart(1)}>Mon</button>
              </div>
            </div>
          </div>

          <div className="cal-ocean__card">
            <div className="cal-ocean__eyebrow">My calendars</div>
            {visibleLegend.map((l) => {
              const on = enabledLayers.has(l.layer);
              return (
                <div key={l.layer} className={`cal-ocean__filter ${on ? "" : "off"}`} onClick={() => toggleLayer(l.layer)} role="button" tabIndex={0}>
                  <span className="cal-ocean__box" style={{ borderColor: l.solid, background: on ? l.solid : "transparent" }}>
                    {on && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4"><polyline points="20 6 9 17 4 12" /></svg>}
                  </span>
                  <span className="lbl">{l.label}</span>
                </div>
              );
            })}
          </div>

          {enabledLayers.has("goals") && allGoals.length > 0 && (
            <div className="cal-ocean__card">
              <div className="cal-ocean__eyebrow" style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
                <span>Goals</span>
                <button type="button" onClick={toggleGoalsCollapsed} title={goalsCollapsed ? "Show goal text on the calendar" : "Collapse goal bars on the calendar"}
                  style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--o-ink-400)", cursor: "pointer", fontSize: 10, fontWeight: 700, textTransform: "none", letterSpacing: 0 }}>
                  {goalsCollapsed ? "Expand on calendar" : "Collapse on calendar"}
                </button>
              </div>
              {GOAL_GROUPS.map(([key, label]) => {
                const list = goalGroups[key];
                if (!list.length) return null;
                const open = openGroups.has(key);
                return (
                  <div key={key} className="cal-ocean__goalgroup">
                    <button type="button" className="cal-ocean__goalgrouphd" onClick={() => toggleGroup(key)}>
                      {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      <span className="lbl">{label}</span>
                      <span className="cnt">{list.length}</span>
                    </button>
                    {open && list.map((g) => (
                      <div key={g.id} className="cal-ocean__goalitem">
                        <span className="dot" style={{ background: g.owner_color || "var(--o-mango-500)" }} />
                        <span className="txt">{(g.body || "").trim() || "Goal"}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {scope === "personal" && (
            <div className="cal-ocean__card">
              <div className="cal-ocean__eyebrow">Google Calendar</div>
              {googleConnected ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 700, color: "var(--o-aqua-600)" }}>
                      <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--o-aqua-500)" }} /> Connected
                    </span>
                    <button type="button" onClick={reload} className="cal-ocean__today" style={{ marginLeft: "auto", padding: "4px 10px", fontSize: 11 }}>Refresh</button>
                  </div>
                  {!enabledLayers.has("google") && (
                    <button type="button" onClick={() => toggleLayer("google")} className="cal-ocean__today" style={{ width: "100%", marginTop: 8, fontSize: 12 }}>
                      Show Google events
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p style={{ fontSize: 11.5, color: "var(--o-ink-500)", margin: "0 0 8px", lineHeight: 1.4 }}>
                    Show your Google events here and keep scheduled meetings in sync.
                  </p>
                  <button type="button" onClick={() => { if (!enabledLayers.has("google")) toggleLayer("google"); connectGoogle(); }} className="cal-ocean__new" style={{ width: "100%", justifyContent: "center" }}>
                    Connect Google Calendar
                  </button>
                </>
              )}
            </div>
          )}

          {scope === "team" && (
            <div className="cal-ocean__card">
              <div className="cal-ocean__eyebrow">Company events</div>
              <p style={{ fontSize: 11.5, color: "var(--o-ink-500)", margin: "0 0 8px", lineHeight: 1.4 }}>
                Pull company events from your Google Calendar into the shared team calendar.
              </p>
              {googleConnected ? (
                <button type="button" onClick={() => { if (!enabledLayers.has("company")) toggleLayer("company"); setCompanyReviewOpen(true); }} className="cal-ocean__new" style={{ width: "100%", justifyContent: "center", fontSize: 12 }}>
                  Select company events →
                </button>
              ) : (
                <button type="button" onClick={() => connectGoogle()} className="cal-ocean__new" style={{ width: "100%", justifyContent: "center" }}>
                  Connect Google Calendar
                </button>
              )}
            </div>
          )}
        </aside>

        {/* ── main ── */}
        <main className="cal-ocean__main">
          <header className="cal-ocean__toolbar">
            {/* Reveal the left rail on narrow screens (hidden on desktop where
                the rail is always inline — see .cal-ocean__railtoggle). */}
            <button type="button" className="cal-ocean__navbtn cal-ocean__railtoggle" aria-label="Show panel" aria-expanded={railOpen} onClick={() => setRailOpen((o) => !o)}>
              <PanelLeft className="w-[18px] h-[18px]" />
            </button>
            <span className="cal-ocean__title">{title}</span>
            <button type="button" className="cal-ocean__navbtn" aria-label="Previous" onClick={() => api()?.prev()}><ChevronLeft className="w-[18px] h-[18px]" /></button>
            <button type="button" className="cal-ocean__navbtn" aria-label="Next" onClick={() => api()?.next()}><ChevronRight className="w-[18px] h-[18px]" /></button>
            <button type="button" className="cal-ocean__today" onClick={() => api()?.today()}>Today</button>
            {activeTeamId && (
              <button type="button" className="cal-ocean__today" onClick={() => setFindTime(true)} title="Find a time that works for everyone">Find a time</button>
            )}
            <span className="cal-ocean__spacer" />
            {/* Google connection — ALWAYS present (both scopes). A token can be
                revoked/expired server-side while the app still thinks it's
                connected, so a Reconnect affordance is always reachable. */}
            {googleConnected ? (
              <>
                <button type="button" className="cal-ocean__today" onClick={reload} title="Google Calendar connected — refresh"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--o-aqua-500)" }} /> Google
                </button>
                <button type="button" className="cal-ocean__today" onClick={() => { if (!enabledLayers.has("google")) toggleLayer("google"); connectGoogle(); }}
                  title="Reconnect Google Calendar — fixes a broken or expired connection"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <RotateCw className="w-[14px] h-[14px]" /> Reconnect
                </button>
              </>
            ) : (
              <button type="button" className="cal-ocean__today" onClick={() => { if (!enabledLayers.has("google")) toggleLayer("google"); connectGoogle(); }} title="Connect Google Calendar"
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: "#4285F4" }} /> Connect Google
              </button>
            )}
            <div className="cal-ocean__seg">
              {[["dayGridMonth", "Month", LayoutGrid], ["timeGridWeek", "Week", Columns3], ["timeGridDay", "Day", RectangleVertical]].map(([v, lbl, Icon]) => (
                <button key={v} type="button" aria-pressed={viewType === v} title={lbl} aria-label={lbl}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "7px 12px" }}
                  onClick={() => api()?.changeView(v)}>
                  <Icon className="w-[17px] h-[17px]" />
                </button>
              ))}
            </div>
            {/* Expanded is a MONTH-view option (all events by type, no popover),
                not a separate view — only offered while the month grid is shown. */}
            {viewType === "dayGridMonth" && (
              <div className="cal-ocean__seg">
                <button type="button" aria-pressed={expanded} onClick={() => setExpanded((e) => !e)}
                  title="Expanded — show every event, no “+more” popover" aria-label="Expanded view"
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "7px 12px" }}>
                  <Maximize2 className="w-[16px] h-[16px]" />
                </button>
              </div>
            )}
            {/* Week-view width levels — widen day columns + scroll horizontally
                so more event detail fits. Only offered on the week grid. */}
            {viewType === "timeGridWeek" && (
              <div className="cal-ocean__seg">
                {[["normal", "Fit"], ["wide", "Wide"], ["xwide", "Max"]].map(([w, lbl]) => (
                  <button key={w} type="button" aria-pressed={weekWidth === w}
                    onClick={() => changeWeekWidth(w)}
                    title={`Week width: ${lbl}`} aria-label={`Week width ${lbl}`}
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "7px 11px", fontSize: 12, fontWeight: 700 }}>
                    {lbl}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="cal-ocean__new cal-ocean__new--icon" title="New event" aria-label="New event"
              onClick={() => setNewSlot({ start: focusDate || new Date(), end: null, allDay: true })}>
              <CalendarPlus className="w-[18px] h-[18px]" />
            </button>
            {/* Reveal the right rail (agenda) on very narrow screens (hidden on
                larger — see .cal-ocean__railtoggle--right). */}
            <button type="button" className="cal-ocean__navbtn cal-ocean__railtoggle-r" aria-label="Show agenda" aria-expanded={railRightOpen} onClick={() => setRailRightOpen((o) => !o)}>
              <PanelRight className="w-[18px] h-[18px]" />
            </button>
          </header>

          <div className={`cal-ocean__gridwrap ${expandedMonth ? "cal-ocean__gridwrap--expanded" : ""}`}>
            <FullCalendar
              ref={calRef}
              plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              headerToolbar={false}
              events={events}
              eventContent={chipContent}
              eventDisplay="block"
              eventOrder="orderRank,start,title"
              datesSet={onDatesSet}
              eventClick={(info) => { if (info.event.extendedProps?.collapsed) toggleGoalsCollapsed(); else openDetails(info.event); }}
              editable
              selectable
              selectMirror
              select={(arg) => setNewSlot({ start: arg.start, end: arg.end, allDay: arg.allDay })}
              eventDrop={onEventChange}
              eventResize={onEventChange}
              nowIndicator
              slotEventOverlap={false}
              firstDay={weekStart}
              dayMaxEvents={expandedMonth ? false : 4}
              slotMinTime="06:00:00"
              slotMaxTime="22:00:00"
              height={expandedMonth ? "auto" : "100%"}
              eventTimeFormat={{ hour: "numeric", minute: "2-digit", meridiem: "short" }}
            />
          </div>
        </main>

        {/* ── right rail: unified time-grouped agenda ── */}
        <aside className={`cal-ocean__rail cal-ocean__rail--right${railRightOpen ? " is-open" : ""}`}>
          {/* Close affordance — only visible when the rail is a drawer. */}
          <button type="button" className="cal-ocean__railclose-r" aria-label="Close panel" onClick={() => setRailRightOpen(false)}>
            <X className="w-4 h-4" />
          </button>
          <div className="cal-ocean__card">
            <div className="cal-ocean__cardhd"><CalendarClock className="w-[17px] h-[17px]" style={{ color: "var(--o-ocean-600)" }} /><h3>Agenda</h3></div>
            <div className="cal-ocean__agendascroll">
            {agenda.length === 0 ? <p className="cal-ocean__empty">Nothing coming up.</p> : agenda.map((day) => (
              <div key={day.key} className="cal-ocean__aday">
                <div className="cal-ocean__adayhd">{dayHeading(day.date)}</div>

                {/* 1. status strip: work location / OOO / goals — not events */}
                {day.statuses.length > 0 && (
                  <div className="cal-ocean__statusrow">
                    {day.statuses.map((it) => {
                      const t = it.extendedProps?.type;
                      const Icon = t === "worklocation_conflict" ? AlertTriangle : (t === "worklocation" || t === "worklocation_app") ? Home : t === "goal" ? Target : Umbrella;
                      return (
                        <button key={it.id} type="button" className="cal-ocean__status" onClick={() => openDetails(it)} title={stripEmoji(it.title)}>
                          <Icon className="w-3 h-3" /> <span>{stripEmoji(it.title)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* 2. all-day events — distinct pill rows, above timed events */}
                {day.allday.map((it) => {
                  const meta = oceanType(it.extendedProps?.type);
                  return (
                    <button key={it.id} type="button" className="cal-ocean__allday" onClick={() => openDetails(it)}>
                      <span className="tag">all-day</span>
                      <span className="sq" style={{ background: meta.solid }} />
                      <span className="txt">{stripEmoji(it.title)}</span>
                    </button>
                  );
                })}

                {/* 3. timed events, clustered by type */}
                {day.runs.map((run, ri) => {
                  const meta = oceanType(run.type);
                  return (
                    <div key={ri} className="cal-ocean__run">
                      {run.items.length > 1 && <div className="cal-ocean__runlabel" style={{ color: meta.solid }}>{meta.label}</div>}
                      {run.items.map((it) => {
                        const isTask = it.extendedProps?.type === "task";
                        const done = !!it.extendedProps?.done;
                        const row = it.extendedProps?.row || {};
                        const allDay = it.allDay;
                        return (
                          <div key={it.id} className={`cal-ocean__row ${allDay ? "cal-ocean__row--allday" : ""}`}>
                            <span className="time">{allDay ? "all-day" : it._s.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                            {isTask ? (
                              <button type="button" aria-label="Toggle done" onClick={() => toggleTaskDone(row)}
                                className="cal-ocean__box" style={{ borderColor: done ? "var(--o-aqua-500)" : "var(--o-ink-300)", background: done ? "var(--o-aqua-500)" : "transparent" }}>
                                {done && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="4"><polyline points="20 6 9 17 4 12" /></svg>}
                              </button>
                            ) : <span className={allDay ? "sq" : "dot"} style={{ background: meta.solid }} />}
                            <button type="button" className="txt" onClick={() => openDetails(it)}
                              style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", textDecoration: done ? "line-through" : "none", color: done ? "var(--o-ink-400)" : undefined }}>
                              {stripEmoji(it.title)}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
            </div>
          </div>

          {scope === "personal" && (
            <div className="cal-ocean__card">
              <div className="cal-ocean__cardhd">
                <CheckSquare className="w-[17px] h-[17px]" style={{ color: "var(--o-mango-600)" }} /><h3>Tasks</h3>
                <span className="count">{myTasks.length} open</span>
              </div>
              {myTasks.length === 0 ? (
                <p className="cal-ocean__empty">No open tasks. <button type="button" onClick={() => navigate("/tasks")} style={{ background: "none", border: "none", padding: 0, color: "var(--o-ocean-600)", cursor: "pointer", fontWeight: 600 }}>Open Tasks</button></p>
              ) : myTasks.map((t) => (
                <div key={t.id} className="cal-ocean__row" style={{ cursor: "default" }}>
                  <button type="button" className="txt" onClick={() => setTaskEdit({ task: t, kind: "planner" })}
                    style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer" }}>
                    {(t.title || "").trim()}
                  </button>
                  {subCounts[t.id]?.total > 0 && (
                    <span className="due" style={{ fontVariantNumeric: "tabular-nums" }} title={`${subCounts[t.id].done} of ${subCounts[t.id].total} subtasks done`}>
                      ☑ {subCounts[t.id].done}/{subCounts[t.id].total}
                    </span>
                  )}
                  <StatusControl status={t.status || (t.done ? "done" : "todo")} onChange={(s) => setCardStatus(t, s)} compact />
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

      {/* ── work-location conflict resolver ── */}
      {locConflict && (
        <Modal open onClose={() => setLocConflict(null)} labelledBy="loc-conflict-title">
          <div onClick={(e) => e.stopPropagation()} className="cal-ocean" style={{ height: "auto", background: "var(--o-sand-50)", borderRadius: 20, border: "1px solid var(--o-border-default)", boxShadow: "var(--o-shadow-xl)", width: "100%", maxWidth: 360, padding: 20 }}>
            <h2 id="loc-conflict-title" style={{ fontSize: 16, fontWeight: 800, color: "var(--o-ink-900)", margin: "0 0 4px" }}>Working location</h2>
            <p style={{ fontSize: 12.5, color: "var(--o-ink-500)", margin: "0 0 14px" }}>
              {new Date(locConflict.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} — your schedule and Google disagree. Which is right?
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button type="button" className="cal-ocean__today" style={{ width: "100%", justifyContent: "flex-start", textAlign: "left" }} onClick={() => resolveLocation(locConflict.date, locConflict.app)}>
                <b>{locConflict.app}</b> — your schedule
              </button>
              <button type="button" className="cal-ocean__today" style={{ width: "100%", justifyContent: "flex-start", textAlign: "left" }} onClick={() => resolveLocation(locConflict.date, locConflict.google)}>
                <b>{locConflict.google}</b> — Google
              </button>
              <button type="button" onClick={() => setLocConflict(null)} style={{ marginTop: 4, alignSelf: "flex-end", border: "none", background: "transparent", color: "var(--o-ink-400)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── slide-over + modals ── */}
      {detailEvent && (
        <EventSlideOver
          ev={detailEvent}
          rooms={rooms}
          onClose={() => setDetailEvent(null)}
          onGo={(path) => { setDetailEvent(null); navigate(path); }}
          onEditMeeting={(row) => { setDetailEvent(null); setMeetingModal({ meeting: row }); }}
          onEditMilestone={(row) => { setDetailEvent(null); setMilestoneModal({ milestone: row }); }}
          onEditTask={(row, kind) => { setDetailEvent(null); setTaskEdit({ task: row, kind }); }}
          onRemoveCompany={(detailEvent?.extendedProps?.publishedBy === userId || isAdmin) ? ({ icalUid, title }) => { setDetailEvent(null); setRemoveCompany({ icalUid, title }); } : undefined}
        />
      )}
      {newSlot && (
        <NewItemPopover
          dark={dark}
          slotLabel={newSlot.allDay ? newSlot.start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : newSlot.start.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          onClose={() => setNewSlot(null)}
          onCreateTask={createTask}
          onPickMilestone={() => setMilestoneModal({ initialDate: toDateStr(newSlot.start) })}
          onPickMeeting={() => setMeetingModal({ initialStart: newSlot.start })}
        />
      )}
      {milestoneModal && (
        <MilestoneModal teamId={activeTeamId} dark={dark} initialDate={milestoneModal.initialDate} milestone={milestoneModal.milestone} onClose={() => setMilestoneModal(null)} onSaved={reload} />
      )}
      {meetingModal && (
        <ScheduleMeetingModal
          rooms={rooms} teamId={activeTeamId} dark={dark}
          initialStart={meetingModal.initialStart}
          initialAttendeeIds={meetingModal.initialAttendeeIds}
          initialExternalEmails={meetingModal.initialExternalEmails}
          initialDuration={meetingModal.initialDuration}
          meeting={meetingModal.meeting}
          onClose={() => setMeetingModal(null)} onCreated={reload} onDeleted={reload}
        />
      )}
      {findTime && (
        <FindATimeModal
          teamId={activeTeamId} rooms={rooms} dark={dark}
          onClose={() => setFindTime(false)}
          onScheduled={() => { setFindTime(false); reload(); }}
          onMoreOptions={({ start, attendeeIds, externalEmails, duration }) => {
            setFindTime(false);
            setMeetingModal({ initialStart: start, initialAttendeeIds: attendeeIds, initialExternalEmails: externalEmails, initialDuration: duration });
          }}
        />
      )}
      {taskEdit && (
        <TaskDetailSheet
          task={normalizeTask(taskEdit.task, taskEdit.kind)}
          onClose={() => { setTaskEdit(null); reload(); }}
          onDeleted={() => { setTaskEdit(null); reload(); }}
        />
      )}
      <CompanyEventsReview
        open={companyReviewOpen}
        onClose={() => setCompanyReviewOpen(false)}
        teamId={activeTeamId}
        userId={userId}
        isAdmin={isAdmin}
        companyDomain={companyEmailDomain}
        fetchCandidates={listGoogleCompanyCandidates}
        onChanged={reload}
      />
      {removeCompany && (
        <RemoveCompanyEventDialog
          open
          teamId={activeTeamId}
          icalUid={removeCompany.icalUid}
          title={removeCompany.title}
          onClose={() => setRemoveCompany(null)}
          onRemoved={reload}
        />
      )}
    </div>
  );
}
