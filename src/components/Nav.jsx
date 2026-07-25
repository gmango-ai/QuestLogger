import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useApp } from "../context/AppContext";
import { useTeam } from "../context/TeamContext";
import { useTheme } from "../context/ThemeContext";
import { supabase } from "../supabase";
import { markIntentionalSignOut } from "../lib/sessionRecovery";
import { formatDuration } from "../lib/utils";
import { Sun, Moon, LogOut, Loader2, Timer, Users, User, Building2, Settings as SettingsIcon, Menu, X, ChevronDown, ChevronUp, HelpCircle, LayoutGrid, Video } from "lucide-react";
import UserAvatar from "./UserAvatar";
import StatusChip from "./StatusChip";
import { useResolvedSelf } from "../hooks/useResolvedSelf";
import { availabilityDot } from "../lib/presence";
import LogoMark from "./LogoMark";
import OrgSwitcher from "./OrgSwitcher";
import BottomNav from "./BottomNav";
import MoreSheet from "./MoreSheet";
import NotificationBell from "./notifications/NotificationBell";
import NavMessages from "./messages/NavMessages";
import { useSyncSession } from "../context/SyncSessionContext";
import WorkClockBar from "./nav/WorkClockBar";
import PinnedWidgetStrip from "./widgets/PinnedWidgetStrip";
import { useWidgetDrawer } from "../context/WidgetDrawerContext";
import PomodoroNavButton from "./nav/PomodoroNavButton";
import { openHelpCenter } from "./tour/HelpCenter";

export default function Nav({ onOpenPomodoro, onPomodoroPage }) {
  const { settings, todayMins, exportMsg, dataSyncing, session, clockIn } = useApp();
  const { activeTeamSessions } = useTeam();
  const { syncSession } = useSyncSession();
  const hasTeamSessions = (activeTeamSessions?.length || 0) > 0;
  // Office nav dot: when you're tracking hours (clocked in) or present in a room.
  const officeActive = !!clockIn || !!syncSession;
  // Avatar presence dot mirrors the resolved status (same vocabulary + colors
  // as the nav StatusChip) so the two never disagree.
  const { resolved: selfStatus } = useResolvedSelf();
  const presenceDot = availabilityDot(selfStatus?.availability || "available");
  const { theme, toggleTheme } = useTheme();
  const darkMode = theme === "dark";
  const location = useLocation();
  const { toggle: toggleWidgets, open: widgetsOpen } = useWidgetDrawer();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Bottom sheet behind the mobile bottom-nav "More" tab (separate from the
  // narrow-desktop hamburger drawer above).
  const [moreOpen, setMoreOpen] = useState(false);

  // Interim de-cram: the ambient quick actions (status, clock, world clock…)
  // drop to a collapsible SECOND desktop row, ahead of the planned sidebar
  // split. Preference persisted.
  const [row2Open, setRow2Open] = useState(() => {
    try { return localStorage.getItem("mango:navRow2") !== "0"; } catch { return true; }
  });
  const toggleRow2 = () =>
    setRow2Open((v) => {
      const n = !v;
      try { localStorage.setItem("mango:navRow2", n ? "1" : "0"); } catch { /* */ }
      return n;
    });

  // Publish the header-content height as --nav-h so full-height pages can
  // subtract it (100dvh - var(--nav-h) - insets) — that's what lets the
  // second row grow the header without overflowing them, on every route. We
  // measure the inner wrapper (the rows only), NOT the safe-area padding, which
  // those pages already account for via --top-inset.
  const wrapRef = useRef(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const setVar = () => document.documentElement.style.setProperty("--nav-h", `${el.offsetHeight}px`);
    setVar();
    const ro = new ResizeObserver(setVar);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Close any open nav surface on route change
  useEffect(() => {
    setSidebarOpen(false);
    setMoreOpen(false);
  }, [location.pathname]);

  // Close on Escape
  useEffect(() => {
    if (!sidebarOpen) return;
    function onKey(e) { if (e.key === "Escape") setSidebarOpen(false); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  // Lock body scroll while sidebar is open
  useEffect(() => {
    if (!sidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [sidebarOpen]);

  // Active nav state uses the user's accent color via CSS variables —
  // applies in both light and dark themes because applyAccent overrides
  // them per-theme on the document root.
  const desktopNavLink = ({ isActive }) =>
    `px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${
      isActive
        ? "bg-[var(--color-accent-light)] text-[var(--color-accent)]"
        : darkMode
          ? "text-slate-400 hover:text-slate-300 hover:bg-[var(--color-surface-raised)]"
          : "text-slate-600 hover:text-slate-800 hover:bg-slate-100"
    }`;

  const sidebarNavLink = ({ isActive }) =>
    `flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold transition-all ${
      isActive
        ? "bg-[var(--color-accent-light)] text-[var(--color-accent)]"
        : darkMode
          ? "text-slate-300 hover:text-slate-100 hover:bg-[var(--color-surface-raised)]"
          : "text-slate-700 hover:text-slate-900 hover:bg-slate-100"
    }`;

  const themeBtnCls = `p-2 rounded-lg transition-all ${
    darkMode
      ? "border bg-[var(--color-surface-raised)] border-[var(--color-border)] text-slate-300 hover:bg-[var(--color-bg)]"
      : "bg-slate-100 text-slate-600 hover:bg-slate-200 border border-slate-200"
  }`;

  function signOut() {
    setSidebarOpen(false);
    setMoreOpen(false);
    markIntentionalSignOut();
    supabase.auth.signOut();
  }

  // Row 2 shows whenever the user hasn't collapsed it. Full-height pages read
  // var(--nav-h) so the extra row grows the header without overflowing them
  // — no per-route special-casing needed.
  const showRow2 = row2Open;

  // Widgets-drawer toggle — lives at the START of the pinned strip (row 2), next
  // to the widgets it opens, rather than in row 1's comms cluster.
  const widgetsBtn = (
    <button
      type="button"
      onClick={toggleWidgets}
      title="Widgets"
      aria-label="Open widgets"
      aria-pressed={widgetsOpen}
      className={`shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
        widgetsOpen
          ? "bg-[var(--color-accent-light)] text-[var(--color-accent)]"
          : darkMode ? "text-slate-400 hover:bg-white/10" : "text-slate-500 hover:bg-slate-100"
      }`}
    >
      <LayoutGrid className="w-[18px] h-[18px]" />
    </button>
  );

  return (
    <>
      <header
        className={`sticky top-0 z-50 border-b transition-all ${
          darkMode
            ? "bg-[var(--color-bg)] backdrop-blur-2xl border-[var(--color-accent-border)]"
            : "bg-white/60 backdrop-blur-xl border-[var(--color-accent-border)] shadow-sm"
        }`}
        style={{
          paddingTop: "env(safe-area-inset-top)",
          ...(darkMode
            ? { boxShadow: "0 4px 24px color-mix(in srgb, var(--color-accent) 12%, transparent)" }
            : {}),
        }}
      >
        {dataSyncing && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center justify-center gap-2 px-4 py-1.5 text-[11px] font-medium border-b border-[var(--color-accent-border)] bg-[var(--color-accent-light)] text-[var(--color-accent)]"
          >
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin opacity-90" aria-hidden />
            Syncing your data…
          </div>
        )}

        <div ref={wrapRef} className="max-w-6xl mx-auto px-3 sm:px-6">
          {/* Row 1 — brand, primary navigation, communication, account. */}
          <div className="h-14 sm:h-16 flex items-center gap-3">
            {/* Mobile: hamburger */}
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
              className={`ql-nav-hamburger xl:hidden p-2 -ml-2 rounded-lg ${
                darkMode ? "text-slate-300 hover:bg-[var(--color-surface-raised)]" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Brand — logo + wordmark, always visible. The user's
                avatar moved to the right of the bar so the product name
                isn't pushed offscreen by a long name. */}
            <NavLink to="/pomodoro" className="flex items-center gap-2 shrink-0">
              <span className="inline-flex text-[var(--color-accent)]" aria-hidden>
                <LogoMark size={28} />
              </span>
              <span
                className={`text-base sm:text-lg font-bold tracking-tight ${darkMode ? "text-white" : "text-slate-800"}`}
                style={{ fontFamily: "'Parkinsans', sans-serif" }}
              >
                Mangodoro
              </span>
            </NavLink>

            {/* Mobile row 1: pomodoro quick-open (Messages moved to the bottom
                nav) + notifications + a collapse toggle for row 2. The clock /
                who's-working / world-clock widgets live on mobile row 2 below
                (hidden when collapsed to reclaim height). */}
            <div className="xl:hidden ml-auto flex items-center gap-1">
              {!onPomodoroPage && <PomodoroNavButton dark={darkMode} onOpen={onOpenPomodoro} />}
              <NotificationBell size="lg" />
              <button
                type="button"
                onClick={toggleRow2}
                aria-label={row2Open ? "Hide quick actions" : "Show quick actions"}
                aria-expanded={row2Open}
                title={row2Open ? "Hide quick actions row" : "Show quick actions row"}
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${darkMode ? "text-slate-300 hover:bg-white/10" : "text-slate-600 hover:bg-slate-100"}`}
              >
                {row2Open ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
              </button>
            </div>

            {/* Desktop row 1: nav + comms + account. Ambient quick actions live
                in the collapsible desktop row 2 below. */}
            <div className="hidden xl:flex items-center gap-3 ml-auto">
              <nav className="flex items-center gap-1">
                <NavLink to="/pomodoro" className={desktopNavLink}>Pomodoro</NavLink>
                <NavLink to="/office" className={desktopNavLink}>
                  Office
                  {officeActive && (
                    <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse align-middle" />
                  )}
                </NavLink>
                <NavLink to="/calendar" className={desktopNavLink}>Calendar</NavLink>
                <NavLink to="/tasks" className={desktopNavLink}>Tasks</NavLink>
                <NavLink to="/time-tracker" className={desktopNavLink}>Time tracker</NavLink>
                <NavLink to="/whiteboards" className={desktopNavLink}>Whiteboards</NavLink>
                <NavLink to="/team" className={desktopNavLink}>Org</NavLink>
              </nav>

              {/* Help stays in row 1 (always visible). */}
              <button
                type="button"
                onClick={openHelpCenter}
                title="Learn Mangodoro"
                aria-label="Learn Mangodoro — tutorials"
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${darkMode ? "text-slate-300 hover:bg-white/10" : "text-slate-600 hover:bg-slate-100"}`}
              >
                <HelpCircle className="w-5 h-5" />
              </button>
              <NavMessages />
              <NotificationBell />

              {/* Collapse / expand the quick-actions row. */}
              <button
                type="button"
                onClick={toggleRow2}
                aria-label={row2Open ? "Hide quick actions" : "Show quick actions"}
                aria-expanded={row2Open}
                title={row2Open ? "Hide quick actions row" : "Show quick actions row"}
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${darkMode ? "text-slate-300 hover:bg-white/10" : "text-slate-600 hover:bg-slate-100"}`}
              >
                {row2Open ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
              </button>

              {/* Single user-menu dropdown on the right. */}
              <UserMenu
                dark={darkMode}
                settings={settings}
                todayMins={todayMins}
                hasTeamSessions={hasTeamSessions}
                presenceDot={presenceDot}
                onToggleTheme={toggleTheme}
                session={session}
              />
            </div>
          </div>

          {/* Row 2 (desktop, collapsible) — your pinned widget strip on the
              left, personal ambient controls (clock-in + status) on the right. */}
          {showRow2 && (
            <div className="hidden xl:flex items-center justify-between gap-3 pb-2 -mt-1">
              <div className="flex items-center gap-2 min-w-0">
                {widgetsBtn}
                <PinnedWidgetStrip dark={darkMode} ctx={{ inRoom: location.pathname.startsWith("/office/r/") }} />
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <WorkClockBar dark={darkMode} />
                <StatusChip />
              </div>
            </div>
          )}

          {/* Row 2 (mobile only, collapsible) — clock-in + the pinned widget
              strip (scrollable), keeping mobile row 1 uncluttered. Collapsing it
              shrinks --nav-h so full-height pages reclaim the space. */}
          {showRow2 && (
            <div className="xl:hidden flex items-center gap-2 h-10">
              {widgetsBtn}
              <WorkClockBar dark={darkMode} />
              <PinnedWidgetStrip dark={darkMode} ctx={{ inRoom: location.pathname.startsWith("/office/r/") }} />
            </div>
          )}
        </div>
      </header>

      {/* Mobile sidebar overlay + drawer */}
      {sidebarOpen && (
        <div
          className="xl:hidden fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={`no-drag xl:hidden fixed top-0 z-[90] h-full w-72 max-w-[85vw] transition-[left] duration-200 ease-out flex flex-col ${
          sidebarOpen ? "left-0" : "-left-72"
        } ${
          darkMode
            ? "border-r bg-[var(--color-surface)] border-[var(--color-border)]"
            : "bg-white border-r border-slate-200"
        }`}
        // Slide in via `left`, not a CSS transform: this drawer overlays the
        // Electron window-drag header, and the `no-drag` above carves the
        // drawer's footprint out of that drag region so the close button (and
        // the rest of the drawer) stay clickable. Chromium ignores app-region
        // inside transforms, so we animate `left` instead — that keeps no-drag
        // honored AND leaves the header draggable everywhere the drawer doesn't
        // cover, even while it's open.
        //
        // The drawer is pinned to the very top/bottom of the screen, so its
        // first/last rows would otherwise sit under the Dynamic Island and the
        // home indicator. Inset its content by the safe areas (the drawer
        // background still fills behind them).
        style={{
          // Clear the mobile notch AND the Electron title-bar / traffic lights
          // (the drawer is pinned to top:0; --titlebar-inset is 0 except in Electron).
          paddingTop: "calc(env(safe-area-inset-top) + var(--titlebar-inset, 0px))",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
        aria-hidden={!sidebarOpen}
      >
        <div className={`flex items-center justify-between px-4 py-3 border-b ${
          darkMode ? "border-[var(--color-border)]" : "border-slate-200"
        }`}>
          <div className="flex items-center gap-2 min-w-0">
            {settings.avatarUrl ? (
              <UserAvatar url={settings.avatarUrl} name={settings.name} size={28} className="shrink-0" />
            ) : (
              <span className="inline-flex shrink-0 text-[var(--color-accent)]" aria-label="Mangodoro">
                <LogoMark size={24} />
              </span>
            )}
            <span className={`text-sm font-semibold truncate ${darkMode ? "text-slate-100" : "text-slate-800"}`}>
              {settings.name ? `${settings.name}` : "Mangodoro"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
            className={`p-1.5 rounded-lg ${
              darkMode ? "text-slate-400 hover:bg-[var(--color-surface-raised)]" : "text-slate-500 hover:bg-slate-100"
            }`}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
          {/* Mobile org switcher — visible in the sidebar so multi-org
              users have a single tap to switch without crossing into
              Team admin. Single-org users see nothing here. */}
          <div className="px-2 pb-2">
            <OrgSwitcher />
          </div>

          <NavLink to="/pomodoro" className={sidebarNavLink}>
            <Timer className="w-5 h-5" /> Pomodoro
          </NavLink>
          <NavLink to="/office" className={sidebarNavLink}>
            <Building2 className="w-5 h-5" /> Office
            {officeActive && (
              <span className="ml-auto w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            )}
          </NavLink>
          <NavLink to="/tasks" className={sidebarNavLink}>
            <span className="w-5 text-center">✅</span> Tasks
          </NavLink>
          <NavLink to="/calendar" className={sidebarNavLink}>
            <span className="w-5 text-center">🗓️</span> Calendar
          </NavLink>
          <NavLink to="/time-tracker" className={sidebarNavLink}>
            <span className="w-5 text-center">📋</span> Time tracker
          </NavLink>
          <NavLink to="/whiteboards" className={sidebarNavLink}>
            <span className="w-5 text-center">🪧</span> Whiteboards
          </NavLink>
          <NavLink to="/meetings" className={sidebarNavLink}>
            <span className="w-5 text-center">🎥</span> Meetings
          </NavLink>
          <NavLink to="/team" className={sidebarNavLink}>
            <Users className="w-5 h-5" /> Org
          </NavLink>

          <div className={`my-3 border-t ${darkMode ? "border-[var(--color-border-light)]" : "border-slate-100"}`} />

          <button
            type="button"
            onClick={() => { setSidebarOpen(false); onOpenPomodoro?.(); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold transition-all ${
              darkMode
                ? "text-slate-300 hover:text-slate-100 hover:bg-[var(--color-surface-raised)]"
                : "text-slate-700 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Timer className="w-5 h-5" /> Quick timer
          </button>

          <button
            type="button"
            onClick={() => { setSidebarOpen(false); openHelpCenter(); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold transition-all ${
              darkMode
                ? "text-slate-300 hover:text-slate-100 hover:bg-[var(--color-surface-raised)]"
                : "text-slate-700 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <HelpCircle className="w-5 h-5" /> Learn Mangodoro
          </button>

          <NavLink
            to="/settings"
            onClick={() => setSidebarOpen(false)}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold transition-all ${
              darkMode
                ? "text-slate-300 hover:text-slate-100 hover:bg-[var(--color-surface-raised)]"
                : "text-slate-700 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <SettingsIcon className="w-5 h-5" /> Settings
          </NavLink>

          <button
            type="button"
            onClick={() => { toggleTheme(); }}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold transition-all ${
              darkMode
                ? "text-slate-300 hover:text-slate-100 hover:bg-[var(--color-surface-raised)]"
                : "text-slate-700 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            {darkMode ? "Light mode" : "Dark mode"}
          </button>
        </nav>

        <div className={`px-3 py-3 border-t ${darkMode ? "border-[var(--color-border-light)]" : "border-slate-100"}`}>
          <button
            type="button"
            onClick={signOut}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
              darkMode
                ? "text-slate-400 hover:text-red-300 hover:bg-red-500/10"
                : "text-slate-600 hover:text-red-600 hover:bg-red-50"
            }`}
          >
            <LogOut className="w-5 h-5" /> Sign out
          </button>
        </div>
      </aside>

      {/* Touch / small-screen bottom tab bar — replaces the hamburger on
          coarse-pointer devices below xl (gated in index.css). "More" opens a
          bottom sheet (thumb-friendly) rather than the side drawer. */}
      <BottomNav
        dark={darkMode}
        hasTeamSessions={hasTeamSessions}
        onMore={() => setMoreOpen(true)}
      />
      <MoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        dark={darkMode}
        settings={settings}
        onToggleTheme={toggleTheme}
        onOpenPomodoro={onOpenPomodoro}
        onSignOut={signOut}
        session={session}
      />

      {exportMsg ? (
        <div
          role="status"
          className={`fixed left-1/2 z-[100] max-w-[min(92vw,28rem)] -translate-x-1/2 rounded-lg border px-4 py-2.5 text-sm shadow-lg ${
            darkMode
              ? "border-slate-600 bg-[var(--color-surface-raised)] text-slate-100 shadow-black/40"
              : "border-slate-200 bg-white text-slate-900 shadow-slate-900/10"
          }`}
          // Sit above the bottom tab bar when it's present (--bottom-inset
          // collapses to the safe-area only on non-touch / desktop).
          style={{ bottom: "calc(1.25rem + var(--bottom-inset))" }}
        >
          {exportMsg}
        </div>
      ) : null}
    </>
  );
}

// Dropdown menu on the right of the top bar. Replaces the previous
// strip of independent buttons (timer / chip / theme / settings /
// sign out) with one click target — the avatar — that reveals the
// rest. Pattern matches Linear/Vercel/Notion: identity-as-handle.
function UserMenu({ dark, settings, todayMins, hasTeamSessions, presenceDot, onToggleTheme, session }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const { teams, activeTeam, activeTeamId, switchTeam } = useTeam();

  useEffect(() => {
    if (!open) return;
    function down(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function key(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const email = session?.user?.email || "";
  const name = settings.name || email.split("@")[0] || "You";
  const otherTeams = (teams || []).filter((t) => t.id !== activeTeamId);
  const showOrgSection = (teams || []).length >= 2;

  const itemBase = `w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors`;
  const item = dark
    ? `${itemBase} text-slate-200 hover:bg-slate-700/70`
    : `${itemBase} text-slate-700 hover:bg-slate-100`;
  const destructive = dark
    ? `${itemBase} text-red-300 hover:bg-red-500/15`
    : `${itemBase} text-red-600 hover:bg-red-50`;

  return (
    <div ref={ref} className="hidden xl:block relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full transition-colors ${
          dark ? "hover:bg-[var(--color-surface-raised)]" : "hover:bg-slate-100"
        }`}
      >
        <span className="relative">
          <UserAvatar url={settings.avatarUrl} name={name} size={28} />
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ${presenceDot} ${
              dark ? "ring-slate-900" : "ring-white"
            }`}
            aria-hidden
          />
        </span>
        <ChevronDown className={`w-3.5 h-3.5 ${dark ? "text-slate-500" : "text-slate-400"}`} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute right-0 top-full mt-1.5 min-w-[240px] rounded-xl border shadow-lg overflow-hidden z-50 ${
            dark ? "bg-[var(--color-surface)] border-[var(--color-border)]" : "bg-white border-slate-200"
          }`}
        >
          {/* Identity row */}
          <div className={`px-3 py-3 border-b ${dark ? "border-[var(--color-border)]" : "border-slate-200/70"}`}>
            <p className={`text-sm font-semibold truncate ${dark ? "text-slate-100" : "text-slate-800"}`}>
              {name}
            </p>
            {email && (
              <p className={`text-[11px] truncate ${dark ? "text-slate-500" : "text-slate-400"}`}>
                {email}
              </p>
            )}
            <p className={`text-[11px] mt-1 ${dark ? "text-slate-400" : "text-slate-500"}`}>
              {todayMins > 0 ? `Today · ${formatDuration(todayMins)}` : "No hours logged today"}
              {hasTeamSessions && (
                <span className="ml-2 inline-flex items-center gap-1 text-[var(--color-accent)]">
                  <Timer className="w-3 h-3 animate-pulse" />
                  session active
                </span>
              )}
            </p>
          </div>

          {/* Org switcher — current org + clickable list of the
              user's other orgs. Hidden when the user is only in one
              org (no switching to do). */}
          {showOrgSection && (
            <>
              <div className={`px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider ${
                dark ? "text-slate-500" : "text-slate-400"
              }`}>
                Org
              </div>
              <div className={`flex items-center gap-2 px-3 py-2 text-sm ${
                dark ? "text-slate-200" : "text-slate-700"
              }`}>
                <UserMenuTeamIcon team={activeTeam} size={20} />
                <span className="truncate font-semibold">{activeTeam?.name}</span>
                <span className={`ml-auto text-[10px] font-bold uppercase tracking-wider ${
                  dark ? "text-emerald-300" : "text-emerald-600"
                }`}>
                  Active
                </span>
              </div>
              {otherTeams.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitem"
                  onClick={() => { switchTeam(t.id); setOpen(false); }}
                  className={item}
                >
                  <UserMenuTeamIcon team={t} size={20} />
                  <span className="truncate">{t.name}</span>
                </button>
              ))}
              <div className={`my-1 h-px ${dark ? "bg-slate-700/60" : "bg-slate-200"}`} />
            </>
          )}

          {/* Theme toggle */}
          <button
            type="button"
            role="menuitem"
            onClick={() => { onToggleTheme(); setOpen(false); }}
            className={item}
          >
            {dark ? <Sun className="w-4 h-4 opacity-70" /> : <Moon className="w-4 h-4 opacity-70" />}
            {dark ? "Switch to light" : "Switch to dark"}
          </button>

          {/* Profile */}
          {session?.user?.id && (
            <NavLink
              to={`/u/${session.user.id}`}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={item}
            >
              <User className="w-4 h-4 opacity-70" />
              Profile
            </NavLink>
          )}

          {/* Meetings */}
          <NavLink
            to="/meetings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={item}
          >
            <Video className="w-4 h-4 opacity-70" />
            Meetings
          </NavLink>

          {/* Settings */}
          <NavLink
            to="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={item}
          >
            <SettingsIcon className="w-4 h-4 opacity-70" />
            Settings
          </NavLink>

          <div className={`my-1 h-px ${dark ? "bg-slate-700/60" : "bg-slate-200"}`} />

          {/* Sign out */}
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); markIntentionalSignOut(); supabase.auth.signOut(); }}
            className={destructive}
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// Small team-icon helper used inside the UserMenu org switcher list.
// Mirrors the OrgSwitcher's TeamIcon — not extracted to a shared
// component because the OrgSwitcher one is internal to that file and
// the duplication is a few lines. Worth converging if a third caller
// appears.
function UserMenuTeamIcon({ team, size = 20 }) {
  const px = `${size}px`;
  const initial = (team?.name || "?")[0].toUpperCase();
  if (team?.icon_url) {
    return (
      <img
        src={team.icon_url}
        alt=""
        style={{ width: px, height: px }}
        className="rounded-md object-cover shrink-0"
      />
    );
  }
  return (
    <span
      style={{
        width: px,
        height: px,
        background: team?.color || "#14b8a6",
        fontSize: Math.max(10, Math.round(size / 2.4)),
      }}
      className="rounded-md flex items-center justify-center font-bold text-white shrink-0"
    >
      {initial}
    </span>
  );
}
