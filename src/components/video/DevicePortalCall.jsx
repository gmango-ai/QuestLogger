import { useEffect, useReducer, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useTracks,
  useRoomContext,
  useParticipants,
  useLocalParticipant,
  useSpeakingParticipants,
  useMediaDeviceSelect,
} from "@livekit/components-react";
import { Track, RoomEvent } from "livekit-client";
import "@livekit/components-styles";
import AudioUnblocker from "./AudioUnblocker";
import { Mic, MicOff, Video, VideoOff, Volume2, VolumeX, Monitor, MonitorOff, Settings, LayoutGrid, Focus, Presentation, Maximize2, Minimize2, ScanFace } from "lucide-react";

// Per-device audio/camera choices persist locally (the kiosk is read-only, so no
// DB) — applied on connect so a paired display keeps its mic/speaker across restarts.
const DEV_PREF = { mic: "ql_device_mic", speaker: "ql_device_speaker", camera: "ql_device_camera", layout: "ql_device_layout", followSpeaker: "ql_device_follow_speaker" };

// One device <select> backed by LiveKit's device manager. Switching a kind calls
// room.switchActiveDevice under the hood (incl. setSinkId for the speaker), and we
// remember the choice per-device + re-apply it once the device list resolves.
function DeviceMediaPicker({ kind, label, storageKey }) {
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({ kind });
  const appliedRef = useRef(false);
  useEffect(() => {
    if (appliedRef.current || !devices.length) return;
    let saved = null;
    try { saved = localStorage.getItem(storageKey); } catch { /* */ }
    if (saved && devices.some((d) => d.deviceId === saved)) {
      appliedRef.current = true;
      Promise.resolve(setActiveMediaDevice(saved)).catch(() => {});
    }
  }, [devices, setActiveMediaDevice, storageKey]);
  const onChange = (id) => {
    Promise.resolve(setActiveMediaDevice(id)).catch(() => {});
    try { localStorage.setItem(storageKey, id); } catch { /* */ }
  };
  return (
    <label className="block mb-2 last:mb-0">
      <span className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">{label}</span>
      <select
        value={activeDeviceId || ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md bg-white/10 px-2 py-1.5 text-[12px] text-white outline-none cursor-pointer"
      >
        {devices.length === 0 && <option value="">System default</option>}
        {devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId} className="text-slate-900">
            {d.label || `${label} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}
import { LIVEKIT_URL, fetchLiveKitToken, liveKitRoomName } from "../../lib/livekit";
import { getLkRoomOptions, LK_CONNECT_OPTIONS, connectDelayFor, markConnectAttempt, connectCooldownMs, noteConnectFailure } from "./livekitConnect";
import { ATTR_CLUSTER, ATTR_LEADER, ATTR_ROOM_DEVICE, ATTR_SINK_OFF, resolveDeviceRoles } from "./useRoomCluster";
import AdaptiveStage from "./AdaptiveStage";
import { useFeaturedSpeaker } from "./useFeaturedSpeaker";
import { useGlobalPin } from "./useGlobalPin";
import { useFullscreen } from "./useFullscreen";
import { refKey, KioskParticipantTile, orderTilesStable, surfaceOverflowSpeakers, capFor, AudienceRow } from "./tileChrome";

// Track the stage's own size so a big call can spill its overflow into the
// audience row (same threshold logic the member grid uses).
function useStageSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const apply = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

// Kiosk display layouts. "grid" (the default for a wall display) shows everyone
// in an even grid — a screen share or a pin still promotes a focus, and the
// speaking ring marks who's talking so grid stays glanceable. "spotlight" shows
// only the focused tile (the active speaker when Follow is on) for a single big
// face. "auto" keeps the adaptive middle ground (even grid for a small call,
// else focus + filmstrip). Persisted per device so a paired display keeps its
// choice; the order below is also the tap-to-cycle order.
const PORTAL_LAYOUTS = ["grid", "spotlight", "auto"];
const PORTAL_LAYOUT_META = {
  grid: { label: "Grid", Icon: LayoutGrid },
  spotlight: { label: "Spotlight", Icon: Focus },
  auto: { label: "Auto", Icon: Presentation },
};
function loadDevLayout(storageKey) {
  try {
    const v = localStorage.getItem(storageKey);
    return PORTAL_LAYOUTS.includes(v) ? v : "grid";
  } catch {
    return "grid";
  }
}

// Advertises the locked device as its room's default mic + speakers (companion
// mode). The device is always-on and already publishes mic + plays the call
// aloud, so it self-claims the mic role and flags itself the room device; people
// physically in the room then join it (muted) from their own LiveKitCall.
//
// MUST run once the room is actually connected: before the server join completes
// the local identity isn't assigned and setAttributes is a no-op, so asserting
// only on mount silently did nothing (the original bug). Assert on Connected (and
// Reconnected, in case attributes don't survive a rejoin), plus immediately in
// case we mounted already-connected. Cluster id = the device's stable identity.
function DeviceClusterBeacon() {
  const room = useRoomContext();
  useEffect(() => {
    if (!room) return undefined;
    const assert = () => {
      const lp = room.localParticipant;
      const id = lp?.identity;
      if (!id || room.state !== "connected") return;
      lp.setAttributes({
        role: "publisher",
        [ATTR_CLUSTER]: id,
        [ATTR_LEADER]: id,
        [ATTR_ROOM_DEVICE]: "1",
      }).catch(() => { /* device keeps publishing regardless */ });
    };
    assert();
    room.on(RoomEvent.Connected, assert);
    room.on(RoomEvent.Reconnected, assert);
    return () => {
      room.off(RoomEvent.Connected, assert);
      room.off(RoomEvent.Reconnected, assert);
    };
  }, [room]);
  return null;
}

// The device's current room roles. Either goes false once someone in the room
// takes over that role: the device then pauses its mic / speakers so two mics
// or two speakers in one space don't conflict.
const DEVICE_ROLE_SETTLE_MS = 1500;

function useDeviceRoles() {
  const room = useRoomContext();
  const participants = useParticipants();
  const [, bump] = useReducer((n) => (n + 1) % 1e9, 0);
  // Fresh device: assume it's the room's mic + sink until told otherwise. Held
  // across reconnects so a mid-reconnect participant-list flicker (collapse to
  // nothing, or to just the kiosk) can't flip it back to mic source under a
  // human who took it over (echo).
  const lastRolesRef = useRef({ isMicSource: true, isAudioSink: true });
  // When the room last became connected — starts the self-only settle window.
  const [connectedAt, setConnectedAt] = useState(null);
  useEffect(() => {
    if (!room) return undefined;
    const onState = () => {
      setConnectedAt((prev) => (room.state === "connected" ? (prev ?? Date.now()) : null));
      bump();
    };
    room.on(RoomEvent.ParticipantAttributesChanged, bump);
    room.on(RoomEvent.ConnectionStateChanged, onState);
    onState(); // initialise from the current state
    return () => {
      room.off(RoomEvent.ParticipantAttributesChanged, bump);
      room.off(RoomEvent.ConnectionStateChanged, onState);
    };
  }, [room]);
  // Re-evaluate once the settle window elapses, so a genuine "everyone left"
  // (still self-only after the settle) lets the kiosk reclaim the mic.
  useEffect(() => {
    if (connectedAt == null) return undefined;
    const t = setTimeout(bump, DEVICE_ROLE_SETTLE_MS + 100);
    return () => clearTimeout(t);
  }, [connectedAt]);
  const myId = room?.localParticipant?.identity;
  // The device's cluster id is its own identity (set by the beacon).
  const members = participants.filter((p) => p.attributes?.[ATTR_CLUSTER] === myId);
  const roles = resolveDeviceRoles({
    myId, roomState: room?.state, members, lastRoles: lastRolesRef.current,
    connectedSince: connectedAt, now: Date.now(), settleMs: DEVICE_ROLE_SETTLE_MS,
  });
  lastRolesRef.current = roles;
  return roles;
}

// TV conferencing stage. Small calls use an even grid; once there are 3+
// cameras or a screen share, it switches to a spotlight (the screen share, else
// the active speaker, else the first person) with the rest in a filmstrip — the
// glanceable "who's talking" framing you want on a big communal display.
function PortalStage({ layoutMode = "grid", followSpeaker = true }) {
  const { localParticipant } = useLocalParticipant();
  const cameras = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], { onlySubscribed: false });
  const screens = useTracks([{ source: Track.Source.ScreenShare, withPlaceholder: false }], { onlySubscribed: false });
  const speaking = useSpeakingParticipants();
  // Follow the same admin "pin for everyone" the member call obeys, so a pinned
  // presenter shows on the wall display too.
  const globalPinId = useGlobalPin();
  const rootRef = useRef(null);
  const { w, h } = useStageSize(rootRef);

  // The kiosk publishes the room's mic, so its own mic keeps it in the active-
  // speaker list (room noise + the call audio echoing back through the speakers).
  // Left in, that made the spotlight snap to the kiosk's OWN camera the instant a
  // remote speaker paused. Exclude the device itself so a surfaced/featured speaker
  // is always a real remote person.
  const localId = localParticipant?.identity;
  const remoteSpeaking = speaking.filter((p) => p.identity !== localId);
  // HOLD the last remote speaker (matches the member call) — never release on
  // silence. The grid keeps its stable order and the ONLY movement is an
  // off-screen speaker surfacing into one quiet slot; a surfaced person then holds
  // that slot until another off-screen person speaks. (Previously a 3.5s decay
  // paged the surfaced speaker back out on its own — movement the grid shouldn't
  // make unprompted.)
  const featuredId = useFeaturedSpeaker(remoteSpeaking, { hold: true });

  // Focus priority: an admin's global pin > a screen share > the featured remote
  // speaker > the first REMOTE camera (prefer a person over the empty-room shot)
  // > the first camera.
  const pinTrack = globalPinId
    ? (screens.find((t) => t.participant?.identity === globalPinId)
       || cameras.find((t) => t.participant?.identity === globalPinId))
    : null;
  // When "follow active speaker" is off, the big tile never chases the talker —
  // drop the featured speaker from the focus so it holds a static framing (pin >
  // screen > first remote camera). In grid mode the speaker was never the focus
  // anyway, so this only affects auto / spotlight.
  const speakerCam = followSpeaker && featuredId ? cameras.find((t) => t.participant?.identity === featuredId) : null;
  const firstRemoteCam = cameras.find((t) => t.participant && t.participant.identity !== localId);

  // Resolve the focus tile per layout mode:
  //   grid     — equal tiles; only a pin or screen share forces a focus.
  //   auto     — even grid for a small call (≤2 cams, no screen/pin), else focus.
  //   spotlight/(default focus) — always a focus tile.
  let focus;
  if (layoutMode === "grid") {
    focus = pinTrack || screens[0] || null;
  } else {
    focus = pinTrack || screens[0] || speakerCam || firstRemoteCam || cameras[0] || null;
    if (layoutMode === "auto" && !pinTrack && !screens.length && cameras.length <= 2) {
      focus = null;
    }
  }

  // The grid/filmstrip order NEVER reshuffles when someone talks — speaking only
  // lights the tile's edge (KioskParticipantTile's speaking ring). Screen shares
  // and pins still lead; everyone else holds a stable arrival order. "Follow
  // active speaker" no longer reorders the grid — it only lets the spotlight tile
  // chase the talker (above) and, in a full call, surfaces an off-screen speaker
  // into the grid. With Follow off, the wall stays fully static.
  const stableOpts = { globalPinId, pinnedTrackKey: null, sortBy: "join" };

  // Spotlight shows ONLY the focused tile; a filmstrip focus keeps the rest
  // alongside; a pure grid (no focus) spills its overflow into the audience row
  // once there are more faces than fit at a comfortable size — so a big call on
  // the wall degrades gracefully instead of shrinking every tile to a postage
  // stamp.
  const spotlightOnly = layoutMode === "spotlight" && !!focus;
  const AUDIENCE_H = 80;
  let stageTiles;
  let audienceTiles = [];
  if (spotlightOnly) {
    stageTiles = [focus];
  } else if (focus) {
    stageTiles = [focus, ...orderTilesStable(cameras.filter((t) => t !== focus), stableOpts)];
  } else {
    const ordered = orderTilesStable(cameras, stableOpts);
    if (ordered.length > capFor(w, h)) {
      const cap = capFor(w, h - AUDIENCE_H);
      // Keep the visible grid put; only when Follow is on may a talking off-screen
      // person pop into the grid (taking a quiet tile's slot). The audience row
      // keeps its stable order.
      const visible = followSpeaker
        ? surfaceOverflowSpeakers(ordered.slice(0, cap), ordered.slice(cap), {
            speakingIds: new Set(remoteSpeaking.map((p) => p.identity)),
            featuredId,
            globalPinId,
            pinnedTrackKey: null,
          })
        : ordered.slice(0, cap);
      const visibleKeys = new Set(visible.map(refKey));
      stageTiles = visible;
      audienceTiles = ordered.filter((t) => !visibleKeys.has(refKey(t)));
    } else {
      stageTiles = ordered;
    }
  }

  // Native aspect per track (from the published video dimensions) so the solver
  // can shape the big focus tile — e.g. an ultrawide or portrait screen share —
  // to its real proportions instead of cropping it to the box.
  const ratios = new Map();
  for (const t of stageTiles) {
    const d = t?.publication?.dimensions;
    if (d?.width && d?.height) ratios.set(refKey(t), d.width / d.height);
  }

  return (
    <div ref={rootRef} className="relative w-full h-full flex flex-col">
      <div className="relative flex-1 min-h-0">
        <AdaptiveStage
          tiles={stageTiles.map((t) => ({ key: refKey(t), content: <KioskParticipantTile trackRef={t} /> }))}
          focusKey={focus ? refKey(focus) : null}
          ratios={ratios}
          gap={12}
        />
      </div>
      {audienceTiles.length > 0 && <AudienceRow tracks={audienceTiles} />}
    </div>
  );
}

// One labelled kiosk control. `on` = the function is active (mic live, camera
// on, sound playing, screen showing); when off it tints amber so "this is
// switched off" reads at a glance. The text label + tooltip spell out exactly
// what it does, since icons alone made the four controls easy to confuse.
function CtrlButton({ on, onIcon: OnIcon, offIcon: OffIcon, label, title, disabled, onClick }) {
  const Icon = on ? OnIcon : OffIcon;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-pressed={!on}
      className={`flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-lg transition-colors disabled:opacity-40 ${
        on ? "text-white hover:bg-white/10" : "text-amber-300 bg-white/5 hover:bg-white/10"
      }`}
    >
      <Icon className="w-5 h-5" />
      <span className="text-[9px] font-medium leading-none">{label}</span>
    </button>
  );
}

// On-kiosk controls, grouped so the two "mute"s and two "hide"s aren't confused:
//   Room sends  → Mic (audio the room sends out) · Camera (video the room sends out)
//   This screen → Sound (call audio playing here) · Screen (call video shown here)
// The Mic auto-mutes (and locks out here) while someone in the room has taken
// over the mic — its tooltip says so.
function DeviceControls({
  micOn, micOverridden, onToggleMic,
  cameraOn, onToggleCamera,
  soundOn, soundOverridden, onToggleSound,
  screenOn, onToggleScreen,
  layout, onCycleLayout,
  followSpeaker, onToggleFollowSpeaker,
  fullscreenSupported, isFullscreen, onToggleFullscreen,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const layoutMeta = PORTAL_LAYOUT_META[layout] || PORTAL_LAYOUT_META.auto;
  const LayoutIcon = layoutMeta.Icon;
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-stretch gap-0.5 rounded-2xl bg-black/55 backdrop-blur px-2 py-1.5 opacity-60 hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <CtrlButton
        on={micOn}
        onIcon={Mic}
        offIcon={MicOff}
        label="Mic"
        disabled={micOverridden}
        title={micOverridden
          ? "Someone in the room has taken over the mic — the device mic is paused"
          : micOn ? "Mute the room mic (stop sending the room's audio)" : "Unmute the room mic"}
        onClick={onToggleMic}
      />
      <CtrlButton
        on={cameraOn}
        onIcon={Video}
        offIcon={VideoOff}
        label="Camera"
        title={cameraOn ? "Turn off the room camera (others stop seeing the room)" : "Turn the room camera back on"}
        onClick={onToggleCamera}
      />
      <span className="self-stretch w-px bg-white/15 mx-1.5" aria-hidden="true" />
      <CtrlButton
        on={soundOn}
        onIcon={Volume2}
        offIcon={VolumeX}
        label="Sound"
        disabled={soundOverridden}
        title={soundOverridden
          ? "Someone in the room is the speaker — the device speaker is paused"
          : soundOn ? "Mute the call audio playing in the room" : "Play the call audio in the room again"}
        onClick={onToggleSound}
      />
      <CtrlButton
        on={screenOn}
        onIcon={Monitor}
        offIcon={MonitorOff}
        label="Screen"
        title={screenOn ? "Hide the call video on this display" : "Show the call video on this display"}
        onClick={onToggleScreen}
      />
      <span className="self-stretch w-px bg-white/15 mx-1.5" aria-hidden="true" />
      {/* Display layout — tap to cycle Auto → Grid → Spotlight for this kiosk. */}
      <button
        type="button"
        onClick={onCycleLayout}
        title={`Layout: ${layoutMeta.label} — tap to change`}
        aria-label={`Layout: ${layoutMeta.label}. Tap to change.`}
        className="flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-lg text-white hover:bg-white/10 transition-colors"
      >
        <LayoutIcon className="w-5 h-5" />
        <span className="text-[9px] font-medium leading-none">{layoutMeta.label}</span>
      </button>
      {/* Follow active speaker — when off, the big tile stops chasing whoever's
          talking (amber = off, matching the other "switched off" controls). */}
      <CtrlButton
        on={followSpeaker}
        onIcon={ScanFace}
        offIcon={ScanFace}
        label="Follow"
        title={followSpeaker
          ? "Following the active speaker — tap to stop highlighting whoever's talking"
          : "Not following the speaker — tap to highlight whoever's talking"}
        onClick={onToggleFollowSpeaker}
      />
      {fullscreenSupported && (
        <button
          type="button"
          onClick={onToggleFullscreen}
          aria-pressed={isFullscreen}
          title={isFullscreen ? "Exit fullscreen" : "Fill the whole screen"}
          aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          className="flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-lg text-white hover:bg-white/10 transition-colors"
        >
          {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
          <span className="text-[9px] font-medium leading-none">{isFullscreen ? "Exit" : "Full"}</span>
        </button>
      )}
      <span className="self-stretch w-px bg-white/15 mx-1.5" aria-hidden="true" />
      {/* Device picker — set which mic / speaker / camera this kiosk uses. */}
      <div className="relative flex items-center">
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          title="Choose microphone, speaker, and camera"
          aria-label="Device settings"
          aria-expanded={settingsOpen}
          className={`flex flex-col items-center gap-0.5 px-2.5 py-1 rounded-lg transition-colors ${
            settingsOpen ? "text-white bg-white/15" : "text-white hover:bg-white/10"
          }`}
        >
          <Settings className="w-5 h-5" />
          <span className="text-[9px] font-medium leading-none">Devices</span>
        </button>
        {settingsOpen && (
          <div className="absolute bottom-full right-0 mb-2 w-64 rounded-xl bg-slate-900/95 backdrop-blur p-3 shadow-2xl ring-1 ring-white/10 text-left">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-white/60 mb-2">Devices</div>
            <DeviceMediaPicker kind="audioinput" label="Microphone" storageKey={DEV_PREF.mic} />
            <DeviceMediaPicker kind="audiooutput" label="Speaker" storageKey={DEV_PREF.speaker} />
            <DeviceMediaPicker kind="videoinput" label="Camera" storageKey={DEV_PREF.camera} />
          </div>
        )}
      </div>
    </div>
  );
}

// Lives inside <LiveKitRoom>: owns the device's self-management state and keeps
// its mic gated by both the operator's intent (micOn) and whether the device is
// still the room mic source (someone may have taken over).
function DevicePortalInner() {
  const { localParticipant } = useLocalParticipant();
  const { isMicSource, isAudioSink } = useDeviceRoles();
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [soundOn, setSoundOn] = useState(true); // the room's speaker output
  const [screenOn, setScreenOn] = useState(true); // the call video on this display
  const [layout, setLayout] = useState(() => loadDevLayout(DEV_PREF.layout));
  const [followSpeaker, setFollowSpeaker] = useState(() => {
    try { return localStorage.getItem(DEV_PREF.followSpeaker) !== "0"; } catch { return true; }
  });
  const rootRef = useRef(null);
  const { isFs, supported: fsSupported, toggle: toggleFullscreen } = useFullscreen(rootRef);

  const cycleLayout = () => {
    setLayout((cur) => {
      const next = PORTAL_LAYOUTS[(PORTAL_LAYOUTS.indexOf(cur) + 1) % PORTAL_LAYOUTS.length];
      try { localStorage.setItem(DEV_PREF.layout, next); } catch { /* */ }
      return next;
    });
  };
  const toggleFollowSpeaker = () => {
    setFollowSpeaker((v) => {
      const next = !v;
      try { localStorage.setItem(DEV_PREF.followSpeaker, next ? "1" : "0"); } catch { /* */ }
      return next;
    });
  };

  useEffect(() => {
    if (!localParticipant) return;
    localParticipant.setMicrophoneEnabled(micOn && isMicSource).catch(() => {});
  }, [localParticipant, micOn, isMicSource]);

  useEffect(() => {
    if (!localParticipant) return;
    localParticipant.setCameraEnabled(cameraOn).catch(() => {});
  }, [localParticipant, cameraOn]);

  // When the operator turns the room's Sound off, mark the device as opted OUT of
  // the sink role (ATTR_SINK_OFF) so pickAudioSink falls through to a co-located
  // human whose speakers carry the room — instead of the device staying the sink
  // while silent and muting the whole room. Cleared when Sound comes back on.
  useEffect(() => {
    if (!localParticipant) return;
    localParticipant.setAttributes({ [ATTR_SINK_OFF]: soundOn ? "" : "1" }).catch(() => {});
  }, [localParticipant, soundOn]);

  return (
    <div ref={rootRef} className="relative w-full h-full bg-slate-900">
      <DeviceClusterBeacon />
      {screenOn ? (
        <PortalStage layoutMode={layout} followSpeaker={followSpeaker} />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-slate-600 text-sm uppercase tracking-widest">
          Display off
        </div>
      )}
      <DeviceControls
        micOn={micOn && isMicSource}
        micOverridden={!isMicSource}
        onToggleMic={() => setMicOn((v) => !v)}
        cameraOn={cameraOn}
        onToggleCamera={() => setCameraOn((v) => !v)}
        soundOn={soundOn && isAudioSink}
        // "Overridden" means ANOTHER member is the sink while we still want sound —
        // NOT our own Sound-off (which now opts us out of the sink role via
        // ATTR_SINK_OFF). Gating on soundOn keeps the button enabled so the
        // operator can always turn their own sound back on.
        soundOverridden={soundOn && !isAudioSink}
        onToggleSound={() => setSoundOn((v) => !v)}
        screenOn={screenOn}
        onToggleScreen={() => setScreenOn((v) => !v)}
        layout={layout}
        onCycleLayout={cycleLayout}
        followSpeaker={followSpeaker}
        onToggleFollowSpeaker={toggleFollowSpeaker}
        fullscreenSupported={fsSupported}
        isFullscreen={isFs}
        onToggleFullscreen={toggleFullscreen}
      />
      {/* The device is the room's speakers by default — keep playing remote audio
          (even when someone took over the mic) unless its operator muted the
          Sound, OR someone in the room took over the speakers. ALWAYS mounted and
          silenced via `muted` (never unmounted) so the Web-Audio mix isn't torn
          down and rebuilt autoplay-blocked when the operator toggles Sound. */}
      <RoomAudioRenderer muted={!(soundOn && isAudioSink)} />
      {/* Autoplay-recovery affordance if the browser blocked playback. */}
      <AudioUnblocker />
    </div>
  );
}

// Always-on two-way video portal for the device kiosk. Publishes the device's
// camera + mic and shows everyone in the room's LiveKit call, so remote members
// can drop in and see/hear the physical office — and be seen/heard back. The
// device is the room's default mic + speakers (DeviceClusterBeacon); a small,
// clearly-labelled control cluster lets it manage its own mic/camera, the room
// sound, and this display.
// Idle state — the kiosk is awake and announcing its presence (so the hallway /
// pre-join still show "Room display on"), but it stays OFF the LiveKit call
// while nobody's in it, to not publish camera/mic 24/7. It connects the moment
// someone joins.
function DeviceCallIdle() {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-slate-950 text-slate-500 select-none">
      <ScanFace className="w-8 h-8 opacity-40" />
      <p className="text-sm">Ready when you are</p>
      <p className="text-[11px] text-slate-600">The display joins the call when someone drops in.</p>
    </div>
  );
}

export default function DevicePortalCall({ roomId, displayName, active = true }) {
  const [token, setToken] = useState(null);
  const [failed, setFailed] = useState(false);
  // Bumped to force a fresh mint+connect (a backoff retry, an involuntary
  // disconnect, or connectivity returning). A kiosk has no human to recover it,
  // so it must reconnect itself.
  const [nonce, bumpNonce] = useReducer((n) => (n + 1) & 0xffff, 0);
  const retryRef = useRef(0);
  const retryTimerRef = useRef(null);

  useEffect(() => {
    // Only mint a token + connect while `active` (someone's in the call). When
    // idle, tear the token down so the LiveKitRoom below unmounts and the media
    // connection closes — the resource saving.
    if (!active) { setToken(null); setFailed(false); retryRef.current = 0; return undefined; }
    if (!roomId || !LIVEKIT_URL) { setFailed(true); return undefined; }
    let cancelled = false;
    setToken(null);
    setFailed(false);
    const room = liveKitRoomName(roomId);
    // Same connection throttle as the app call: don't re-mint/reconnect to the
    // same room inside the cooldown, and honour the global 429 breaker.
    const timer = setTimeout(() => {
      if (cancelled) return;
      markConnectAttempt(room);
      fetchLiveKitToken(room, displayName)
        .then((t) => { if (!cancelled) { retryRef.current = 0; setToken(t); } })
        .catch(() => {
          if (cancelled) return;
          // Auto-retry with backoff instead of dead-ending on "Could not connect"
          // forever — during a brownout the kiosk keeps trying until it clears.
          noteConnectFailure();
          setFailed(true); // show the connecting-failed state meanwhile
          retryRef.current = Math.min(retryRef.current + 1, 8);
          const backoff = Math.min(30000, 1000 * 2 ** retryRef.current);
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(() => { if (!cancelled) bumpNonce(); }, backoff);
        });
    }, Math.max(connectDelayFor(room), connectCooldownMs()));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    };
  }, [roomId, displayName, active, nonce]);

  // Retry promptly when connectivity returns (a new outage deserves a fresh try).
  useEffect(() => {
    if (!active) return undefined;
    const onOnline = () => { retryRef.current = 0; bumpNonce(); };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [active]);

  if (!active) return <DeviceCallIdle />;
  if (failed || !token) return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-slate-950 text-slate-500 select-none">
      <ScanFace className="w-8 h-8 opacity-40" />
      <p className="text-sm">{failed ? "Could not connect" : "Connecting\u2026"}</p>
    </div>
  );

  return (
    <div data-lk-theme="default" className="w-full h-full bg-slate-900">
      <LiveKitRoom
        serverUrl={LIVEKIT_URL}
        token={token}
        connect
        video
        audio
        options={getLkRoomOptions()}
        connectOptions={LK_CONNECT_OPTIONS}
        style={{ height: "100%" }}
        onError={() => { noteConnectFailure(); }}
        onDisconnected={(reason) => {
          // A non-user disconnect (reason !== ClientInitiated=1) that LiveKit's
          // own reconnect couldn't recover → drop the token and re-mint so the
          // kiosk rejoins itself instead of freezing on a dead room. (A teardown
          // when `active` flips off is client-initiated → left alone.)
          if (reason !== undefined && reason !== 1) { setToken(null); bumpNonce(); }
        }}
      >
        <DevicePortalInner />
      </LiveKitRoom>
    </div>
  );
}
