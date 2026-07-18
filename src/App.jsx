import { useState, useEffect, lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, useLocation, useNavigate, Navigate } from "react-router-dom";
import { App as CapApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { StatusBar, Style } from "@capacitor/status-bar";
import { supabase } from "./supabase";
import { isMobileApp, getPlatform } from "./lib/platform";
import { requestNotificationPermissions } from "./lib/nativeNotifications";
import { addNotificationTapListener, consumePendingNotificationRoute } from "./lib/persistentTimer";
import AuthPage from "./AuthPage";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { AppProvider, useApp } from "./context/AppContext";
import { TeamProvider } from "./context/TeamContext";
import { SyncSessionProvider, useSyncSession } from "./context/SyncSessionContext";
import { PomodoroProvider } from "./pomodoro/PomodoroContext";
import { VideoCallProvider } from "./context/VideoCallContext";
import { NotificationProvider } from "./context/NotificationContext";
import { MessagesProvider } from "./context/MessagesContext";
import MessagesPage from "./pages/MessagesPage";
import { ProfileProvider } from "./context/ProfileContext";
import { TourProvider } from "./context/TourContext";
import ErrorBoundary from "./components/ErrorBoundary";
import LunchReminder from "./components/LunchReminder";
import HealthReminders from "./components/HealthReminders";
import PresenceSync from "./components/PresenceSync";
import IdlePresence from "./components/IdlePresence";
import PresenceResolver from "./components/PresenceResolver";
import ReflectionPrompt from "./components/ReflectionPrompt";
import StatusCyclePrompt from "./components/StatusCyclePrompt";
import ClockOutModal from "./components/ClockOutModal";
import NotificationToaster from "./components/notifications/NotificationToaster";
import WhatsNew from "./components/WhatsNew";
import PersistentVideoCall from "./components/video/PersistentVideoCall";
import WidgetDrawer from "./components/widgets/WidgetDrawer";
import { WidgetDrawerProvider } from "./context/WidgetDrawerContext";
import DriveModeSuggest from "./components/DriveModeSuggest";
import Nav from "./components/Nav";
import InvoiceModal from "./components/InvoiceModal";
import PomodoroSurface from "./components/pomodoro/PomodoroSurface";
import PomodoroFab from "./components/PomodoroFab";
import SyncSessionModal from "./components/SyncSessionModal";
import OnboardingModal from "./components/OnboardingModal";
import WelcomeFlow from "./components/tour/WelcomeFlow";
import OnboardingFactTracker from "./components/tour/OnboardingFactTracker";
import TourOfferToast from "./components/tour/TourOfferToast";
import HelpCenter from "./components/tour/HelpCenter";
import PWAUpdater from "./components/PWAUpdater";
// PomodoroPage is the landing route, so it stays eager — no Suspense flash
// on cold start. Every other route page is lazy-loaded: the initial bundle
// is just the app shell + Pomodoro, and each route's code (plus its heavy
// deps — charts, codemirror, xyflow, the office/video stack) downloads on
// first visit. /log, /overview, /planner now redirect into /time-tracker,
// so those page imports are gone.
import PomodoroPage from "./pages/PomodoroPage";
const TimeTrackerPage = lazy(() => import("./pages/TimeTrackerPage"));
const TasksPage = lazy(() => import("./pages/TasksPage"));
const TeamPage = lazy(() => import("./pages/TeamPage"));
const TeamTimesheetsPage = lazy(() => import("./pages/TeamTimesheetsPage"));
const WhiteboardsListPage = lazy(() => import("./pages/WhiteboardsListPage"));
const WhiteboardPage = lazy(() => import("./pages/WhiteboardPage"));
const PublicWhiteboardPage = lazy(() => import("./pages/PublicWhiteboardPage"));
const OfficePage = lazy(() => import("./pages/OfficePage"));
const MeetingSummariesPage = lazy(() => import("./pages/MeetingSummariesPage"));
const CalendarPage = lazy(() => import("./pages/CalendarPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const JoinSyncPage = lazy(() => import("./pages/JoinSyncPage"));
const ProfilePage = lazy(() => import("./pages/ProfilePage"));
const JoinTeamPage = lazy(() => import("./pages/JoinTeamPage"));
const LocalTimerPage = lazy(() => import("./pages/LocalTimerPage"));
const DevicePairPage = lazy(() => import("./pages/DevicePairPage"));
const DeviceKioskPage = lazy(() => import("./pages/DeviceKioskPage"));
const DriveModePage = lazy(() => import("./pages/DriveModePage"));
import { applyAccent } from "./lib/accent";
import { toElectronAuthPayload } from "./electron/authSessionBridge";

function publishElectronAuthSession(session) {
  if (typeof window === "undefined") return;
  window.__electronAuthBridge?.publishSession?.(toElectronAuthPayload(session));
}

// Shared placeholder shown while a lazy route chunk downloads. Dependency-
// free skeleton page (theme-aware via the dark: variant) so the swap reads
// as content arriving, not a blank pause.
const SK = "animate-pulse bg-slate-200/70 dark:bg-[var(--color-surface-raised)]";
const ROUTE_FALLBACK = (
  <div className="px-4 pt-6 max-w-[1400px] mx-auto space-y-4" role="status" aria-label="Loading">
    <div className={`h-7 w-44 rounded-lg ${SK}`} />
    <div className={`h-28 rounded-2xl ${SK}`} />
    <div className={`h-28 rounded-2xl ${SK}`} />
    <div className={`h-64 rounded-2xl ${SK}`} />
  </div>
);

function AppLayout({ session }) {
  const { theme } = useTheme();
  const darkMode = theme === "dark";
  const { settings, dataSyncing, clockIn, projects } = useApp();
  const { joinSession } = useSyncSession();
  const location = useLocation();
  const navigate = useNavigate();

  // Apply the user's accent color to the document root whenever the
  // chosen palette or theme changes. Default is "teal" which matches
  // the existing --color-accent values, so first-time users see no
  // change.
  useEffect(() => {
    applyAccent(settings.accentColor || "teal", darkMode);
  }, [settings.accentColor, darkMode]);

  // Native status bar follows the in-app theme so it's not a gray/dark band
  // above a light app. Icon style applies on both platforms; the solid
  // background + no-overlay is Android-only (iOS keeps its safe-area overlay,
  // which the layout already accounts for via env(safe-area-inset-top)).
  useEffect(() => {
    if (!isMobileApp) return;
    StatusBar.setStyle({ style: darkMode ? Style.Dark : Style.Light }).catch(() => {});
    if (getPlatform() === "android") {
      StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
      StatusBar.setBackgroundColor({ color: darkMode ? "#0f172a" : "#ffffff" }).catch(() => {});
    }
  }, [darkMode]);

  // Mount the `.dark` class on <html> rather than a wrapper div. Two reasons:
  //   1. CSS variable inheritance — if `.dark { --color-accent: cyan }` is
  //      defined on a child of <html>, descendants inherit the child's
  //      value even when applyAccent writes `--color-accent: pink !important`
  //      on <html>. Putting .dark on <html> aligns both sources.
  //   2. Portal-rendered content (PiP window, modals) sees dark mode.
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) root.classList.add("dark");
    else root.classList.remove("dark");
  }, [darkMode]);

  useEffect(() => {
    const prevent = (e) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Persistent-timer surfaces (Electron tray, Android ongoing notification)
  // push the user back into the app via this event when the system
  // affordance is tapped. The detail is a router path, defaulting to
  // /pomodoro. iOS Live Activities open the app via the registered URL
  // scheme and route through the existing CapApp deep-link handler.
  useEffect(() => {
    function onNav(e) {
      const route = (e?.detail && typeof e.detail === "string") ? e.detail : "/pomodoro";
      navigate(route);
    }
    window.addEventListener("mangodoro:nav", onNav);
    window.addEventListener("mangodoro:route", onNav);
    if (typeof window !== "undefined" && window.__pendingRoute) {
      navigate(window.__pendingRoute);
      window.__pendingRoute = null;
    }
    return () => {
      window.removeEventListener("mangodoro:nav", onNav);
      window.removeEventListener("mangodoro:route", onNav);
    };
  }, [navigate]);

  // Native alert-notification taps → deep-link. The iOS push handler
  // (PersistentTimerPlugin, fed by the native-push edge fn) reports the route
  // the alert carried; also drains a route captured before the listener existed
  // (cold launch straight from the notification). No-op off iOS.
  useEffect(() => {
    let disposed = false;
    let handle;
    let lastHandledRoute = null;
    let dedupeTimer;
    const navigateToNotificationRoute = (url) => {
      if (disposed || typeof url !== "string" || !url.startsWith("/") || url === lastHandledRoute) return;
      lastHandledRoute = url;
      clearTimeout(dedupeTimer);
      dedupeTimer = setTimeout(() => {
        if (lastHandledRoute === url) lastHandledRoute = null;
      }, 1000);
      navigate(url);
    };
    (async () => {
      handle = await addNotificationTapListener(navigateToNotificationRoute);
      if (disposed) {
        handle?.remove?.();
        return;
      }
      const pending = await consumePendingNotificationRoute();
      navigateToNotificationRoute(pending);
    })();
    return () => {
      disposed = true;
      clearTimeout(dedupeTimer);
      handle?.remove?.();
    };
  }, [navigate]);

  const onPomodoroPage = location.pathname.startsWith("/pomodoro");

  // When loaded inside another surface (an iframe embedded in a room) we hide
  // the global Nav and floating chrome so the embedded view gets the full
  // viewport. Trigger: ?embed=1 query param.
  const isEmbed = new URLSearchParams(location.search).get("embed") === "1";

  const currentTaskHint = (() => {
    if (!clockIn) return "";
    const projId = clockIn.projectIds?.[0];
    const proj = projId ? projects?.find((p) => p.id === projId)?.name : null;
    const desc = (clockIn.description || "").trim();
    if (proj && desc) return `${proj} — ${desc}`;
    if (proj) return proj;
    if (desc) return desc;
    return "";
  })();

  const [showPomodoro, setShowPomodoro] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  // Cross-tree opener for the floating PomodoroSurface. Room widgets
  // (header chip, sidebar widget) dispatch `mangodoro:open-pomodoro`
  // via lib/pomodoroSurface.js to bring the full controls up without
  // prop-drilling setShowPomodoro through the office shell.
  useEffect(() => {
    function onOpen() { setShowPomodoro(true); }
    window.addEventListener("mangodoro:open-pomodoro", onOpen);
    return () => window.removeEventListener("mangodoro:open-pomodoro", onOpen);
  }, []);

  const showOnboarding = !onboardingDismissed && !dataSyncing && !settings.name;

  function handleSessionJoined(sess) {
    joinSession(sess);
    setShowSyncModal(false);
    setShowPomodoro(true);
  }

  return (
    <div>
      {/* Out-to-lunch auto-status nudge (renders a prompt at lunch time). */}
      <LunchReminder />
      {/* Recurring wellbeing/break reminders (hydration, move, eye rest…). */}
      <HealthReminders />
      {/* Mirrors timezone + clock-in into outward presence signals. */}
      <PresenceSync />
      {/* Auto online/away from tab activity (idle → away, return → restore). */}
      <IdlePresence />
      {/* Seam ①: resolve every signal → one status, persist to user_presence. */}
      <PresenceResolver />
      {/* "What did you work on?" capture around pomodoro phases. */}
      <ReflectionPrompt />
      {/* Clear/update your status at pomodoro phase ends (per preference). */}
      <StatusCyclePrompt />
      {/* Save/edit-your-time modal on clock-out (skips the trip to /log). */}
      <ClockOutModal />
      {/* Transient in-app notification toasts. */}
      <NotificationToaster />
      {/* "What's new" toast + changelog modal (reads CHANGELOG.md). */}
      <WhatsNew />
      {/* First-run orientation (after OnboardingModal) + invisible tracker that
          flips getting-started checklist flags from real app activity. */}
      {!isEmbed && <WelcomeFlow />}
      {!isEmbed && <OnboardingFactTracker />}
      {!isEmbed && <TourOfferToast />}
      {!isEmbed && <HelpCenter />}
      {/* overflow-x-clip (not overflow-hidden): clipping the vertical axis
          here makes this div a scroll container, which traps the sticky
          <header> so it scrolls away and lets content slide under the
          Dynamic Island. `clip` on the x-axis alone keeps the decorative
          glows from causing horizontal scroll without establishing a
          scroll container, so the header stays pinned to the viewport. */}
      <div className="relative min-h-screen w-full overflow-x-clip transition-colors duration-300">
        {/*
          Animated background glows tinted by the user's accent (and its
          color-theory partner --color-break). We use color-mix() against
          the live CSS vars so picking a new accent recolors the entire
          background without a reload. The previous version baked in cyan/
          teal/purple/pink/blue which made dark mode look identical regardless
          of accent.
        */}
        {darkMode && (
          <div className="fixed inset-0 z-0" style={{ background: "var(--color-bg)" }}>
            <div
              className="absolute top-0 right-1/4 w-[600px] h-[600px] rounded-full blur-3xl animate-pulse"
              style={{
                background:
                  "radial-gradient(circle, color-mix(in srgb, var(--color-accent) 22%, transparent), transparent 70%)",
                animationDuration: "8s",
              }}
            />
            <div
              className="absolute bottom-0 left-1/4 w-[700px] h-[700px] rounded-full blur-3xl animate-pulse"
              style={{
                background:
                  "radial-gradient(circle, color-mix(in srgb, var(--color-break) 18%, transparent), transparent 70%)",
                animationDuration: "10s",
                animationDelay: "2s",
              }}
            />
            <div
              className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full blur-3xl animate-pulse"
              style={{
                background:
                  "radial-gradient(circle, color-mix(in srgb, var(--color-accent) 10%, transparent), transparent 70%)",
                animationDuration: "12s",
                animationDelay: "4s",
              }}
            />
            <div
              className="absolute inset-0 opacity-[0.015]"
              style={{
                backgroundImage:
                  "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
              }}
            />
            <div
              className="absolute inset-0"
              style={{
                backgroundImage:
                  "linear-gradient(color-mix(in srgb, var(--color-accent) 4%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 4%, transparent) 1px, transparent 1px)",
                backgroundSize: "64px 64px",
              }}
            />
          </div>
        )}

        {!darkMode && (
          <div
            className="fixed inset-0 z-0"
            style={{
              background:
                "linear-gradient(135deg, #f8fafc 0%, color-mix(in srgb, var(--color-accent) 6%, #f8fafc) 50%, color-mix(in srgb, var(--color-break) 6%, #f8fafc) 100%)",
            }}
          >
            <div
              className="absolute top-0 right-1/4 w-[500px] h-[500px] rounded-full blur-3xl"
              style={{
                background:
                  "radial-gradient(circle, color-mix(in srgb, var(--color-accent) 15%, transparent), transparent 70%)",
              }}
            />
            <div
              className="absolute bottom-0 left-1/4 w-[600px] h-[600px] rounded-full blur-3xl"
              style={{
                background:
                  "radial-gradient(circle, color-mix(in srgb, var(--color-break) 12%, transparent), transparent 70%)",
              }}
            />
            <div
              className="absolute inset-0"
              style={{
                backgroundImage:
                  "linear-gradient(color-mix(in srgb, var(--color-accent) 3%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 3%, transparent) 1px, transparent 1px)",
                backgroundSize: "48px 48px",
              }}
            />
          </div>
        )}

        {/* A small right-edge gutter so the fixed pomodoro pull-tab (PomodoroFab,
            docked to the right edge) doesn't sit on top of page content. */}
        <WidgetDrawerProvider>
        <div className={`relative z-10 min-h-screen ${!isEmbed && !onPomodoroPage ? "xl:pr-2" : ""}`}>
          {!isEmbed && <Nav onOpenPomodoro={() => setShowPomodoro(true)} onPomodoroPage={onPomodoroPage} />}
          {/* Floating pomodoro button (replaces the old nav Pomodoro link + timer
              pill). Hidden on the pomodoro page itself, where you're already there. */}
          {!isEmbed && !onPomodoroPage && <PomodoroFab onToggle={() => setShowPomodoro((v) => !v)} />}
          {!isEmbed && <InvoiceModal />}
          {/* ClockBanner (fixed bottom tracking bar) disabled — the top-bar
              WorkClockBar now owns clock display + controls; the bottom bar was
              redundant and overlapped content. Component kept for reference. */}
          {!isEmbed && !onPomodoroPage && (
            <PomodoroSurface
              variant="floating"
              open={showPomodoro}
              onClose={() => setShowPomodoro(false)}
              onOpenSync={() => setShowSyncModal(true)}
              currentTaskHint={currentTaskHint}
            />
          )}
          {!isEmbed && (
            <SyncSessionModal
              open={showSyncModal}
              onClose={() => setShowSyncModal(false)}
              userId={session.user.id}
              displayName={settings?.name || ""}
              onSessionJoined={handleSessionJoined}
            />
          )}
          {!isEmbed && (
            <OnboardingModal
              open={showOnboarding}
              onClose={() => setOnboardingDismissed(true)}
              userId={session.user.id}
            />
          )}
          {!isEmbed && <PWAUpdater />}
          {/* Route content is boundaried so one page throwing shows a
              recoverable fallback (not a blank screen) while the nav shell
              survives; it auto-clears when you navigate (resetKey=pathname). */}
          <ErrorBoundary label="route" resetKey={location.pathname}>
          <Suspense fallback={ROUTE_FALLBACK}>
          <Routes>
            <Route path="/" element={<LandingRedirector />} />
            {/* Legacy time-tracker URLs redirect into the unified page */}
            <Route path="/log" element={<Navigate to="/time-tracker/log" replace />} />
            <Route path="/overview" element={<Navigate to="/time-tracker/overview" replace />} />
            {/* Planner retired → the Tasks timeline is the tasks home */}
            <Route path="/planner" element={<Navigate to="/tasks" replace />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/time-tracker" element={<TimeTrackerPage />} />
            <Route path="/time-tracker/:tab" element={<TimeTrackerPage />} />
            <Route path="/team" element={<TeamPage />} />
            <Route path="/messages" element={<MessagesPage />} />
            <Route path="/u/:userId" element={<ProfilePage />} />
            <Route path="/team/timesheets" element={<TeamTimesheetsPage />} />
            {/* Retros retired — whiteboards replaced them; keep the legacy URLs
                redirecting so old links/bookmarks still land somewhere useful. */}
            <Route path="/team/retro" element={<Navigate to="/whiteboards" replace />} />
            <Route path="/retros" element={<Navigate to="/whiteboards" replace />} />
            <Route path="/whiteboard" element={<Navigate to="/whiteboards" replace />} />
            <Route path="/whiteboards" element={<WhiteboardsListPage />} />
            <Route path="/whiteboards/:whiteboardId" element={<WhiteboardPage />} />
            <Route
              path="/pomodoro"
              element={<PomodoroPage session={session} onOpenSync={() => setShowSyncModal(true)} />}
            />
            <Route path="/office" element={<OfficePage />} />
            <Route path="/drive" element={<DriveModePage />} />
            <Route path="/office/r/:roomId" element={<OfficePage />} />
            <Route path="/meetings" element={<MeetingSummariesPage />} />
            <Route path="/meetings/:recordingId" element={<MeetingSummariesPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* /account merged into /settings → Profile section. */}
            <Route path="/account" element={<Navigate to="/settings" replace />} />
          </Routes>
          </Suspense>
          </ErrorBoundary>

          {/* Persistent video call mount — lives outside <Routes> so the
              call survives page navigation. Renders as a PiP when no
              page has provided a stageEl via VideoCallContext. */}
          <PersistentVideoCall />
          {!isEmbed && <WidgetDrawer />}
          {/* Car-Bluetooth detector — offers the /drive takeover when a car's
              hands-free audio device appears. */}
          <DriveModeSuggest />
        </div>
        </WidgetDrawerProvider>
      </div>
    </div>
  );
}

// Reads the user's preferred landing page and redirects `/` there. Uses a
// localStorage cache so the redirect happens synchronously on initial
// render — without it, /log fans would briefly land on /pomodoro before
// the AppContext fetch completes and the redirect re-fires.
function LandingRedirector() {
  let target = "/pomodoro";
  try {
    if (localStorage.getItem("ql_default_landing") === "log") target = "/log";
  } catch { /* ignore — Safari private mode etc. */ }
  return <Navigate to={target} replace />;
}

function AuthenticatedApp({ session }) {
  return (
    <AppProvider session={session}>
      <TeamProvider session={session}>
        <SyncSessionProvider session={session}>
          <PomodoroProvider userId={session.user.id}>
            <VideoCallProvider>
              <NotificationProvider>
                <MessagesProvider>
                  <ProfileProvider>
                    <TourProvider>
                      <AppLayout session={session} />
                    </TourProvider>
                  </ProfileProvider>
                </MessagesProvider>
              </NotificationProvider>
            </VideoCallProvider>
          </PomodoroProvider>
        </SyncSessionProvider>
      </TeamProvider>
    </AppProvider>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const nextSession = data.session ?? null;
      publishElectronAuthSession(nextSession);
      setSession(nextSession);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, s) => {
      publishElectronAuthSession(s);
      setSession(s);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Ask once for notification permission on native launch. The actual
  // OS prompt only appears on first call; subsequent calls just return
  // the current grant state. Web builds use the in-page Notification
  // API which is requested lazily from PomodoroContext.toggleRun.
  useEffect(() => {
    if (!isMobileApp) return;
    requestNotificationPermissions();
  }, []);

  // Lock the viewport on native. iOS auto-zooms when the user taps an
  // input whose font-size renders below 16 CSS px and then doesn't
  // expose a way to zoom back out — the app gets stuck zoomed in.
  // maximum-scale + user-scalable=no kills the auto-zoom. We keep web
  // unrestricted because pinch-zoom is an accessibility win there;
  // iOS Safari still allows system-level accessibility zoom regardless.
  useEffect(() => {
    if (!isMobileApp) return;
    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport) {
      viewport.setAttribute(
        "content",
        "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"
      );
    }
  }, []);

  // Native deep-link bridge. AuthPage opens the Supabase OAuth URL in
  // an in-app browser; Supabase redirects to mangodoro://auth/callback
  // when done; iOS/Android routes that URL back into the app via
  // @capacitor/app's appUrlOpen event. Supabase returns one of two
  // shapes depending on the flow:
  //   - PKCE:     ?code=<auth_code>  → exchangeCodeForSession(code)
  //   - implicit: #access_token=...&refresh_token=...  → setSession(...)
  // signInWithOAuth defaults to the implicit shape for OAuth providers
  // regardless of the client's flowType, so we handle both. Session
  // state then propagates via the onAuthStateChange listener above.
  useEffect(() => {
    if (!isMobileApp) return;
    let handle;
    (async () => {
      handle = await CapApp.addListener("appUrlOpen", async ({ url }) => {
        if (!url || !url.startsWith("mangodoro://")) return;
        try {
          const u = new URL(url);
          const code = u.searchParams.get("code");
          if (code) {
            await supabase.auth.exchangeCodeForSession(code);
          } else if (u.hash) {
            const params = new URLSearchParams(
              u.hash.startsWith("#") ? u.hash.slice(1) : u.hash
            );
            const access_token = params.get("access_token");
            const refresh_token = params.get("refresh_token");
            if (access_token && refresh_token) {
              await supabase.auth.setSession({ access_token, refresh_token });
            }
          }
        } catch (e) {
          console.error("[auth] deep-link handler failed", e);
        }
        Browser.close().catch(() => { /* already closed */ });
      });
    })();
    return () => {
      handle?.remove?.();
    };
  }, []);

  if (session === undefined) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          background: "var(--color-bg)",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--color-muted)" }}>Loading…</span>
      </div>
    );
  }

  // Device accounts are flagged at creation (user_metadata.is_device); they
  // render the read-only kiosk instead of the full member app.
  const isDevice = !!session?.user?.user_metadata?.is_device;

  return (
    <ThemeProvider>
      <BrowserRouter>
        <Suspense fallback={ROUTE_FALLBACK}>
        <Routes>
          <Route path="/pomodoro/join/:code" element={<JoinSyncPage />} />
          <Route path="/team/join/:code" element={<JoinTeamPage />} />
          {/* No-account local timer. It's also the default landing for
              signed-out visitors (catch-all below), so the web/desktop/Electron
              app opens straight into a usable timer; signing in is opt-in. */}
          <Route path="/timer" element={<LocalTimerPage />} />
          <Route path="/login" element={session ? <Navigate to="/" replace /> : <AuthPage />} />
          {/* Device accounts: signed-out → pairing screen; a paired device
              session (flagged in user_metadata) always renders the kiosk. */}
          <Route
            path="/device"
            element={isDevice ? <DeviceKioskPage session={session} /> : session ? <Navigate to="/" replace /> : <DevicePairPage />}
          />
          {/* Public read-only whiteboard — renders OUTSIDE the auth gate so
              anyone with the link (even signed out) can view a scope='public'
              board. RLS returns the row only when it's public. */}
          <Route path="/w/:whiteboardId" element={<PublicWhiteboardPage />} />
          <Route
            path="/*"
            element={isDevice ? <DeviceKioskPage session={session} /> : session ? <AuthenticatedApp session={session} /> : <LocalTimerPage />}
          />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </ThemeProvider>
  );
}

