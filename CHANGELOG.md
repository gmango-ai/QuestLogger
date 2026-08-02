# Changelog

Notable changes to Mangodoro. Pre-1.0, so grouped by date/area rather than
semantic versions. Newest first. Each release lists **New & improved** (features
and changes to features) and **Fixes**.

## 2026-08-02

### New & improved

- **chore** — commit in-flight UI work (weather, world clock, messages, office)
- feat(whiteboards): clickable cards + preview thumbnails
- feat(whiteboards): invite-only sharing + public boards + scope settings
- feat(calendar): "Find a time" scheduler + always-present Google reconnect
- feat(rooms): meeting auto-close warning + extend, ephemeral chat, modal overflow fix

### Fixes

- (whiteboard,calls): harden realtime whiteboard + make calls survive DB brownouts
- (auth): safer auto-rejoin + a reconnecting indicator
- (audio): harden + simplify the LiveKit audio pipeline
- (auth): survive transient token-refresh failures without ejecting the call
- (kiosk): grid holds order; only surface an off-screen speaker
- (identity): seed name/avatar from Google OAuth metadata

## 2026-07-25

### New & improved

- feat(whiteboards): clickable cards + preview thumbnails
- feat(whiteboards): invite-only sharing + public boards + scope settings
- feat(calendar): "Find a time" scheduler + always-present Google reconnect
- feat(rooms): meeting auto-close warning + extend, ephemeral chat, modal overflow fix

### Fixes

- (auth): safer auto-rejoin + a reconnecting indicator
- (audio): harden + simplify the LiveKit audio pipeline
- (auth): survive transient token-refresh failures without ejecting the call
- (kiosk): grid holds order; only surface an off-screen speaker
- (identity): seed name/avatar from Google OAuth metadata

## 2026-07-17

### New & improved

- feat(widgets): weather widget + chip popovers open/fit instead of inheriting collapse
- feat(widgets): drop room-only whiteboard widget, move drawer button to row 2, readable goals
- feat(video): auto-center a shared screen + multi-share, zoom, fill-screen PiP
- feat(widgets): show the meeting name with the time in the strip chip
- feat(widgets): pinned topbar strip + app-wide widget drawer
- feat(widgets): sync widget order + pins to the account
- refactor(widgets): unify sidebar + room-tile lists into one registry

### Fixes

- Align GoalsChip scope with GoalsWidget using syncSession room id
- (widgets): team strip chip always shows + wider chip popovers
- (widgets): denser goals list + meetings chip rolls past started meetings
- (widgets): task source, meeting next, pin persistence, strip reorder
- (video): keep a shared screen the focus over active speaker + kiosk

## 2026-07-15

### New & improved

- feat(calendar): company events live on the Team tab; Join goes to the event
- feat(calendar): remove company events with one/all/selection for recurring
- feat(office): show company events in the Upcoming meetings widget
- feat(calendar): collapse recurring company events to one expandable row
- feat(calendar): import & separate company events from Google → team calendar
- diag(video): log the room-mic gate decision to trace mic-leak reports
- test(video): grid order ignores speaking; overflow-surfacing keeps positions
- feat(electron): sign in via the system browser, not an embedded popup

### Fixes

- Update publisherMap after publishing events so canRemove works immediately
- OAuth restart error silenced, company event remove permission check, widget meeting fairness
- (calendar): don't show a published company event twice on personal view
- (calendar): company-event upsert conflict + review state wiped on rerender
- (video): hard-lock a follower's mic so it can't leak into the room
- (video): keep call audio playing through PiP / pop-out re-parenting
- (office): render the "Add to view" menu in a portal so it's never hidden
- (kiosk): grid highlights the speaker without reshuffling tiles

## 2026-07-14

### New & improved

- feat(kiosk): ticker fixed-lines + inline sources/icons; settings in headers; multi-city weather
- feat(kiosk): save & switch named layouts
- feat(kiosk): unified Ticker (goals + news), modal picker, more sources
- feat(kiosk): multi-line news ticker — a scrolling line per source
- feat(office): drop a panel at the outer edge to stretch it full-span
- feat(kiosk): news ticker (server-side RSS proxy)
- feat(kiosk): weather panel (Open-Meteo, keyless)
- feat(office): hallway floor plan scales to fit + team list to the side
- feat(kiosk): full team roster (everyone's location) replaces "Who's here"
- feat(kiosk): dark tile chrome, Add menu + Lock (hide bars), drop quick toggles
- feat(kiosk): only connect the LiveKit call when a human is in it
- feat(office): badge rooms with a live display on the hallway floor plan
- feat(rooms): show "Room display on" in the pre-join when a kiosk is live
- feat(kiosk): room meetings view + imminent-meeting alert with chime
- feat(kiosk): status-aware "Who's here" roster on the device display
- feat(video): respect incoming video native size to avoid crop/stretch
- chore(db): repair migration history — align local files to applied remote stamps
- feat(db): device kiosk SELECT on user_presence for its room's occupants

### Fixes

- Guard presence listeners before subscribe in useOfficeDisplays
- Show connecting/error UI, fix display badge subscribe, fix roster room highlight
- (video): grid highlights the speaker without reshuffling tiles
- (presence): roster shows your room when viewing it + keeps in-room offline people
- (video): kiosk tile parity via shared tileChrome (camera-off avatar, grid default, overflow)

## 2026-07-10

### New & improved

- Guard stale lunch auto-return
- feat(whiteboard): rich text — italic/underline/strike + line-height + kerning
- refactor(whiteboard): text panel as a compact format bar
- feat(whiteboard): font-weight selector + compact, themed text panel
- feat(whiteboard): disable edit-on-create; Enter edits the selected node
- feat(whiteboard): custom marquee with live highlight, align + bulk-edit, additive Shift
- feat(whiteboard): fold crossing edges + brush paint into native selection
- feat(whiteboard): bulk-edit multiple same-type selected nodes
- feat(whiteboard): native React Flow multi-select as the primary select gesture
- feat(whiteboard): marquee/lasso selects edges by crossing them
- feat(whiteboard): propagate keyboard zoom to followers; fix mobile selection drag/deselect
- feat(whiteboard): follow a collaborator's view + hover-for-names
- feat(calendar): theme-aware calendar & tasks + week width levels
- feat(onboarding): add a switch to disable onboarding hints
- feat(whiteboard): selection envelopes its items instead of a bbox rectangle
- feat(whiteboard): bigger toolbar buttons (48px touch / 40px mouse)
- feat(whiteboard): keyboard-shortcuts cheatsheet (press ?)
- feat(whiteboard): support image transparency
- feat(whiteboard): stamp sticky/goal/frame/image + no auto-edit on placement
- feat(onboarding): guided welcome tour + full-app tour coverage
- feat(tasks): timeline overview + unified task editor across all surfaces
- feat(whiteboard): stamp a shape — number keys place a shape at the cursor
- feat(whiteboard): single-key tool shortcuts + font-size & z-order keys
- feat(whiteboard): live auto-shape preview + fewer false ellipses
- feat(whiteboard): pen auto-shape — draw & hold to snap to shapes/edges
- refactor(whiteboard): extract usePalmRejection (version 3 foundation)
- refactor(whiteboard): extract useWhiteboardInspector + useWhiteboardRegionSelect
- feat(google): refresh the token on-demand at API guards, not just in the timer
- refactor(whiteboard): extract useWhiteboardKeyboard
- feat(google): silent token refresh so Calendar/Docs stay connected
- refactor(whiteboard): extract useWhiteboardPersistence
- refactor(whiteboard): extract useWhiteboardClipboard
- refactor(whiteboard): extract toolbar + overlay components
- refactor(whiteboard): extract pure utils + storage helpers
- feat(office): widgets as room views + drop Arrange, move Leave
- **chore** — room type setter, OAuth account chooser, nav + widget fixes
- feat(status): drop legacy presence_state, unify on user_presence
- feat(calendar): responsive rails, icon views, name-first chips + Google cache
- feat(status): P4 (2/2) — drop the resolver's per-tick legacy write-through
- feat(status): P4 (1/2) — occupant surfaces read user_presence, not presence_state
- feat(whiteboard): :emoji: shortcodes in sticky notes + text nodes
- feat(chat): back :emoji: shortcodes with the full Unicode set (~3.9k names)
- feat(chat): apply EmojiTextField across free-text inputs + show all matches
- feat(chat): reusable EmojiTextField — :emoji: shortcodes on any input, with arrow-key nav
- **Whiteboard** — speed up the airbrush (and all wet-layer strokes) on mobile
- feat(chat): Discord-style :emoji: shortcodes
- **Profile** — browse previous focus notes with their Result status
- refactor(status): remove the Status setter from Settings
- feat(status): P5 — unified manual status UI (message, emoji, expiry, pin, invisible)
- feat(status): P3 — server-side offline sweep (pg_cron)
- feat(status): team status roster (combined in-room + team view)
- **Whiteboard** — raster brush strokes read as one mark (wet-layer opacity)
- feat(status): P2 — single leader-owned presence writer + heartbeat
- feat(status): P1 — resolver emits 7 states + new precedence
- **Whiteboard** — clamp toolbar popovers to viewport + tighten gap to the bar
- **Whiteboard** — lasso select + unify all toolbar popovers to portal above trigger
- feat(status): P0 — 7-state vocabulary + one shared presence map
- **docs** — status-system rewrite plan (targeted, 7-state)
- **Whiteboard** — fix inert region selection (pointer-events + click-off to place)
- **Whiteboard** — fold region-select into the select tool + fix color popover & drag
- refactor(planner): declutter the expanded task panel
- feat(pomodoro): focus-task subtasks + task→status link
- feat(calendar): surface subtask counts on task chips + Tasks card
- feat(planner): redesign task rows with progressive disclosure
- **Whiteboard/App** — fix startup crash, add route error boundary + mobile nav
- feat(tasks): subtasks in the office Tasks widget
- feat(tasks): subtasks + AI generation + subtask-driven progress (planner)
- **Calendar** — expanded view = full month grid (no +more), not a list
- **Calendar** — work-location conflict resolution + expanded month view
- **Calendar** — goal grouping/collapse, work-location merge, agenda structure, tasks card
- **Whiteboard** — Apple Pencil overhaul + region select, clear-all, live raster sync
- **Meetings** — show record toggle to team admins, not just the session leader
- **Calendar** — render weekly goals & OOO as full-span bars
- Remove deprecated retros feature (whiteboards replaced it)
- **Calendar** — restore a visible Google Calendar connect/sync control
- **Calendar** — day hierarchy, meeting priority, work-hours band, unified agenda
- **Calendar** — Mangodoro ocean reskin + type-distinct chips, priority, editing
- Calendar (Phase 3): team scope, Google two-way, attendees & timezones
- Calendar (Phase 2): deadlines, milestones, drag-to-schedule, list view
- Calendar (Phase 1): read-only command-center overview
- **Meetings** — AI summaries, room scheduling, Google Calendar/Docs
- Retire Jitsi/JaaS; standardize video on LiveKit

### Fixes

- (db): resolve migration version collision on 20260709150000
- (whiteboard): bulk-edit dropdowns no longer clipped
- (whiteboard): contextual toolbars follow the app theme
- (whiteboard): connect edges to nodes inside a frame (absolute rects)
- (whiteboard): marquee-select edges, connect to framed shapes, mobile endcaps
- (whiteboard): block iOS long-press callout/magnifier on the canvas pane
- (whiteboard): Shift+number no longer arms a shape stamp (Shift+1 = fit view)
- (whiteboard): frames are selectable again; empty paint tiles don't inflate the box
- (whiteboard): single content-fitted selection box; ignore empty frames
- (whiteboard): selection wraps only drawn items; hit area matches; re-marquee works
- (whiteboard): keep top-center overlays clear of the title card
- (onboarding): tours now persist completion (stop re-offering finished tours)
- (whiteboard): stop auto-zoom on draw (drop the fitView prop)
- (chat): select-none on the clickable author name
- (chat): click a message avatar/name to open the profile popover
- (whiteboard): click empty canvas deselects (region-drag only on move)
- (whiteboard): don't start a region box on node clicks (broke selection)
- (meetings): make the schedule-meeting dialog fit any viewport
- (presence): heartbeat-based liveness, Away<12h before Offline
- (milestones): default created_by to auth.uid()
- (notifications): clearing didn't persist — add recipient DELETE policy
- (chat): @mentions highlight + open profile in the /messages view
- (status): P6 — repair focus-aware notification DND for the 7-state vocab
- Repeating 'set your working hours' nudge

## 2026-07-07

### New & improved

- **Meetings** — record a room's call with one toggle; it's transcribed and AI-summarized automatically, with a REC indicator everyone sees. Review past summaries + transcripts on the new Meetings page and export any to Google Docs.
- **Calendar** — schedule meetings into a room (optionally mirrored to Google Calendar) with an "Upcoming meetings" office widget.
- **Video** — standardized fully on LiveKit; removed the Jitsi/JaaS fallback and code path (retired the Share-music tab-audio feature, which was Jitsi-only)
## 2026-07-06

### New & improved

- Preserve lunch presence in resolver
- Reconcile rebased staging to verified merge state
- **iOS launch screen** — new logo, clean up the imageset
- **Rebrand** — new Mangodoro logo across web, iOS, Android, desktop
- **Video** — flip auto-rotate sign on Android (web DeviceMotion path)
- **Android** — theme-matched status bar + fix timer overlap on narrow screens
- **Video landscape** — counter the container rotation on the self-view
- **Video landscape** — flip UI direction, video rotates only when mirrored + landscape
- **Video** — flip the landscape UI rotation direction
- **Video** — auto-rotate the fullscreen call UI to landscape; mirror-only self flip
- **Video rotate** — manual button in fullscreen chrome, mirror-aware, auto on by default
- Auto-rotate video: read orientation natively (web DeviceMotion is dead in WKWebView)
- Auto-rotate video: add NSMotionUsageDescription + calibrated gravity
- **Chat** — tap-to-reveal message actions on mobile (not every row)
- Auto-rotate video: request motion permission from a user gesture (actually works now)
- **Whiteboard toolbar** — comfortable, grouped spacing for the scrolling rail
- **Drive mode** — optional video
- **Video** — auto-rotate self-view + fullscreen control-bar toggle (mobile)
- **Mobile touch targets** — Messages + pomodoro + room chat surfaces
- **Whiteboard** — fit the toolbar to the room panel, not the viewport
- Unify emoji picker across chat, whiteboard, and emote bar
- **Mobile touch targets** — nav dropdowns (org switcher, status, world clock, notifications)
- **Room UI** — single-row header, room-scoped widgets drawer, bigger add menu
- **Video call** — fix stuck-fullscreen-leave, add crop toggle + portrait tiles
- **Room header** — mobile-friendly layout + unified widgets toggle
- **Mobile nav** — Messages as a first-class bottom-nav tab
- **Kill the teal loading flash** — black load surfaces everywhere
- **Whiteboard mobile round 4** — edit-bar scale/scroll, inline carets, 2-finger pan while drawing
- **Whiteboard mobile round 3** — taps, flyouts, drawing, scroll pin
- **Whiteboard mobile round 2** — hold-to-select, 1-tap select, real bar sizes
- **Messages** — pin a channel to the top for everyone
- **Messages** — channel management suite — colour, archive, retention, images, force-notify
- **Messages** — distinct icon for room channels (door) vs regular channels (#)
- **Messages/Rooms** — chat settings gear in the tile header + fix reaction popover cutoff
- **Messages/Rooms** — slim settings header in room tile + fix presence channel crash
- **Messages/Rooms** — room chat uses the shared Thread UI + @mention rendering + open-room
- **Messages** — org setting to auto-add everyone to open channels
- **Messages** — apply set_channel_meta open-channel fix; align migration filename
- **Messages** — show channel folders in the nav quick-view
- **Messages** — compact (Slack-like) list density toggle
- **Messages** — announcement channel option on creation
- **Messages** — drag to reorder folders themselves
- **Messages** — drag to reorder channels within a folder
- **Messages** — drag channels in/out of folders
- **Messages** — apply delete + folders migrations to shared DB; reconcile history
- **Messages** — shared team-wide channel folders
- **Messages** — delete / leave conversations & channels (smart)
- **Messages** — quick-view popover on the nav icon
- **Messages** — stop auto-listed channels from showing false unread
- **Whiteboard** — drag-to-place shapes from toolbar + quick-palette shapes & centre X
- **Whiteboard edges** — fix arrow line-poke + white bordered cap handles on hover
- **Whiteboard edges** — float caps a small gap off the node, line ends mid-cap
- **Whiteboard edges** — drop the cap standoff so no line stub pokes past dot/diamond
- **Whiteboard edges** — seat end-caps outside the node, not half inside
- **Whiteboard edges** — endpoint handles ARE the end-cap, not a disc over it
- **Whiteboard edge cap previews** — explicit light stroke so caps aren't black
- **Whiteboard edges** — visual cap previews in the start/finish pickers
- **Whiteboard edges** — fix dot/diamond caps + independent start/finish ends
- **Whiteboard** — restore click quick-add on the arrow handles
- **Whiteboard** — quick-connect arrows are now real handles (drag + click)
- **Whiteboard** — draw.io-style drag-to-connect flowchart building
- **Whiteboard shape tool** — one-click add of the last-used shape
- **Video call** — camera-off tile shows profile photo with initials fallback
- **Whiteboard text** — no edge handles, shapeable box, format panel below
- **Whiteboard** — fix alt-drag clone edges + sticky color/drag behaviour
- Reconcile migration history with the shared DB (two-agent overlap)
- **Messaging Stage 2** — unify in-room chat onto the channels backend
- **Messaging** — open-join channels with optional team-lock (rooms↔channels Stage 1)
- **UX batch** — whiteboard, rooms, status, task tracker, world clock, profile
- **Whiteboard mobile** — pan-first gestures, full-width toolbar, no page bounce
- **Widgets** — align with the orange brand, drop dead assets
- **Whiteboard mobile toolbar** — finish the in-flight layout cleanup
- Import native-push + icon rebrand WIP from main tree
- **Mobile calls** — one-tap fullscreen via CSS maximize
- **Mobile call fixes** — usable controls on phones, PiP replaced by pill
- Car-Bluetooth prompt: offer Drive mode when the car connects
- **Drive mode** — giant audio-first UI for joining meetings on the road
- Dedupe, bugfix, and perf sweep across app + contexts
- Wait for service worker activation before push subscribe
- Avoid hanging web push ready fallback
- **Notifications** — consolidate across multiple tabs (leader election)
- Web-push: fail cleanly instead of hanging the toggle
- **Sound cues** — fix silent playback + cue your own send/raise-hand
- **Mobile** — top-align the pomodoro popover under the top bar (was cut off)
- **Mobile** — two-row header (clock/world-clock/pomodoro on row 2), drop FAB on mobile
- Add sound cues for notifications, chat messages, and raised hands
- Add video-call pop-out (Document Picture-in-Picture)
- **Address PR review** — presence retry, override reflection, web-push auth
- **Notifications** — OS popup always fires, not only when the tab is backgrounded
- Web-push: browser push notifications when the app is closed
- **Notification cutover** — client inbox reads notification_deliveries
- Apply notifications_v2: rename to 20260704140000 (timestamp collision)
- **Notification rebuild Phase 1a** — shadow events/deliveries schema + priority
- **Status vocab** — drop "Active", standardize on "Available"
- Consolidate status onto one source: the resolver is the sole writer
- **Status at Pomodoro end** — clear or prompt-to-update each cycle
- Nav row 2 balance + status text: help in row 1, clock-in left, text field surfaced
- **Nav** — second row on all routes (--app-nav-h) + bridge status to room
- **Status setter** — click the nav chip to set a manual status override
- **Nav** — collapsible two-row top bar to de-cram the header
- **Status system foundation** — resolver + user_presence + surfaces (seam ①)

### Fixes

- (db): resolve migration version collision on 20260704120000
- Legacy presence feedback loop
- Manual self-view rotation override
- Self-view auto-rotate preference
- Device rotation setup races
- Legacy room mobile action selection
- Stale device rotation state
- Emoji picker viewport clamping
- Responsive room and video layouts
- Mobile office controls
- Full-height page scroll (Messages/Office/whiteboard) + mobile polish
- Sticky-color crash + two-finger zigzag; skeleton loading screens
- Whiteboard bottom chrome stacking
- Notification tap lifecycle handling
- Org team stale state and delete modal close
- Desktop notification leader handoff
- Room whiteboard and chat state gating
- Notification icon: consolidate to one canonical AppIcon set
- Slow service worker push enable timeout
- Presence availability after clearing override
- Paused timer fingerprint
- IOS OOM: stop firing native timer side-effects every second
- Pomodoro popover breakpoint
- Mobile pomodoro nav state indicators
- In-room audio rejoin entry hold
- Leaving a room's audio left your mic AND everyone's audio stuck muted
- Realtime sound cue races
- Duplicate sound cues
- Pop-out (blank window) + move it into the control bar's More menu
- Notification delivery: always toast, add sound, client-side focus policy
- Status popover clipping/scroll + avatar/chip color mismatch

## 2026-07-04

### New & improved

- UI(Electron): distinguish Pomodoro tray phases

### Fixes

- Allow tray popover to open without main timer handler
- Stale timer handler readiness and popover opening bugs
- (Pomodoro): remove break transition
- (Electron): wait for Pomodoro timer command readiness
- Command acknowledgement race condition in PomodoroEngine
- (Electron): repair menubar Pomodoro popover controls
- (Electron): allow video providers through CSP

## 2026-07-03

### Fixes

- (Video): stabilize call media and grid layout

## 2026-07-02

### New & improved

- **docs** — restructure changelog into New & improved / Fixes sections

### Fixes

- World clock nav pill showed city instead of pinned org label until opened

## 2026-07-01

- Persist pending welcome state after onboarding
- Fix onboarding and message tour regressions
- Fix chat author settings fallback
- Fix: non-admin members saw teammates as "Member" in chat + presence roster
- Fix create-room tour entry route
- Onboarding P5: collaboration tours + new-feature announcements
- Onboarding P4: Help / Learn center
- Onboarding P3: core tours + non-blocking auto-offer
- Onboarding P2: welcome flow + getting-started checklist
- Onboarding P1: tutorial foundation (driver.js engine + persistence)
- Video: extend auto pin + speaker dual view to Presenter mode
- Fix self spotlight ignore fallback
- Video: spotlight holds last speaker, auto pin+spotlight, ignore-self, grid default
- Fix pomodoro and message deep-link states
- Org page: People filter deep links force the People page
- Fix pomodoro FAB pending dismiss
- Pomodoro: floating popover closes on outside-click / Escape / tab re-click
- Org page: real multi-page layout grouped by what you edit together
- Nav: pomodoro is a slim clock pull-tab (no sliding FAB) + edge padding
- Fix team side nav anchors and scroll spy
- Nav: pomodoro FAB fully off-screen with a show/hide edge tab
- Green room: make 'I'm in this room' its own button (out of the mic menu)
- Green room: call-style mic/camera device menus; fold in "join room audio"
- Nav: make the pomodoro FAB edge-peek so it stops covering UI
- Org page: in-page side nav + image-forward team cards
- Fix single-room rejoin enforcement
- Sync: enforce a single active room per user across all instances
- Fix org chart cyclic reporting roots
- Org chart: card / list / reporting views + leadership + manager field
- Nav: pomodoro FAB + world-clock globe dropdown
- Video: merge Watch/Join into the green room; kiosk speaker-highlight toggle
- Video: stop camera turning off when call settings change
- Fix deafen mute and message deep links
- Video: restore the personal "expand" pin on each tile
- Video UI: move Deafen next to the audio controls
- Video UI: legible Join button + distinct room-audio icon
- Video: kiosk speaker-focus fix, pin/layout/fullscreen sync, deafen
- Fix scoped messages and knock handling

## 2026-06-30

### New & improved

- **Messaging v2** — an org-scoped inbox with team channels alongside direct and group DMs, plus image/file attachments. Slack/Teams-grade redesign of the whole surface.
- **Rooms** — knock-to-enter for locked rooms: share a code, or gate access by department.
- **Video** — full call-disconnect diagnostics, and true fullscreen that takes over the whole screen (not just the window).

### Fixes

- Messaging: attachment uploads are now restricted to the sender; channel pin unread state and other channel-state bugs fixed; attachment preview URLs cleaned up.
- Video: the call preview is opt-in, ending a LiveKit request (429) storm; token-mint failures are handled during the reconnect cooldown.
- Pomodoro: the focus→break alert no longer plays twice in synced sessions.

## 2026-06-29

### New & improved

- **Messaging** — first release: schema + a `/messages` page with a conversation list, threads, and new DM/group creation.
- **Calls: raise-hand** — a control-bar toggle, a tile badge, and a People queue; your hand auto-lowers once you start talking.
- **Call UI overhaul** — one cohesive menu system, a visual layout picker, an avatar-rich People sidebar, your own name/mute pill, distinct rounded tiles, camera-off initials avatars, and smoother microinteractions.
- **Video (Phase 2)** — floating, mirrorable self-view; audience overflow for big calls; tile chrome with a speaking ring and connection-quality dot; a fluid adaptive stage with active-speaker decay.
- **Pre-join lobby** — a shared settings gear on both surfaces, with speaker output, noise cancellation, and push-to-talk available before you join; unified pre-join that turns spectating into an office walk-in.
- **Rooms: watch-together** — shared website-view tiles with URL sync; embed Google Docs/Sheets/Slides and more platforms (with a fallback card when a site blocks embedding); YouTube play/pause/seek stays in sync.
- **Rooms & whiteboard** — pin-for-everyone policy with one-click tile pinning; anyone in the room can attach/swap the whiteboard; "New whiteboard" uses the full create dialog (templates + name); activity badges on collapsed panel toggles (call / whiteboard / chat); a world-clock widget of org-curated locations and local times.
- **Clock & office** — save or edit your time at clock-out from a modal (no trip to `/log`); per-block pomodoro notes accumulate into the day log, surfaced at clock-out; the hallway shows people from presence detection, not just who's clocked in; the top-bar clock replaces the old fixed bottom banner.
- **Notifications** — clear/dismiss items from the inbox.
- **Audio** — the app's Web Audio is consolidated onto one shared AudioContext.

### Fixes

- Clock-out modal path, pin-policy save, video badge count, and cross-device clock-out auto-restart on reload.
- Calls: don't probe mics mid-call (label-only best-mic on room-leader switch); don't write participant signal state before connect; connection attempts are rate-limited with a capped reconnect backoff.
- `livekit-moderate` now names the missing secret(s) in its config-guard 500.
- Assorted: AudioContext churn, PWA stuck-version, emote-fountain performance, DM 42702, and sync-presence rejecting valid states.

## 2026-06-26

### New & improved

- **Kiosk** — scheduled active hours plus manual sleep/wake, so a display can rest offline and wake on tap.
- **Video** — an "I'm in this room" pre-join that joins you muted before entry, so you don't squeal into the room.

### Fixes

- Cluster handoff: fixed followers being stranded on an abandoned id; reworked late cluster-join and the kiosk sleep loading gate so tap-to-wake isn't blocked while the schedule loads.
- Reverted the prod COOP/COEP headers that broke joining a call.
- Green room: pinned the Join button so it can't be clipped.

## 2026-06-25

### New & improved

- **Device kiosks** — movable devices (Phase C): a kiosk room switcher + admin controls; a modular, arrangeable room layout with a view-only whiteboard (Phase B); mic/speaker/camera pickers (Phase A); read-only access so a kiosk can view its room's chat + whiteboard.
- **What's new** — an in-app changelog toast + modal, with the changelog auto-generated on push to main.
- **Video** — surfaces the LiveKit disconnect reason to diagnose silent green-room bounces.

### Fixes

- Pinned-room loading race and a stale fetch in the org devices panel; device room select when the pinned room is archived; device RLS for the active-session whiteboard + chat author profiles.
- The "What's new" toast now fires correctly for same-day changelog merges and PWA reloads.

## 2026-06-21 → 2026-06-23 (last 48 hours)

A large burst: a near-complete collaborative whiteboard, a LiveKit video
overhaul + room-audio model, device/kiosk accounts, an "Out to lunch" status,
and pomodoro/office/iOS-widget polish.

### Whiteboard — collaborative canvas

**Foundations & collaboration**
- Multiplayer-safe undo/redo + copy/paste/cut.
- Persist pan/zoom per board.
- Easier node resizing + text selection inside nodes (nodrag/nowheel opt-outs).

**Content**
- Storage-backed image nodes; drag-drop a file onto the canvas + paste from clipboard.
- Markdown in sticky / text / shape nodes.
- Double-click empty canvas to drop a text node.
- Interactive task-list checkboxes (ticking one rewrites the markdown source).

**Text & styling**
- Per-node text colour + alignment; bold / italic buttons; text background +
  radius + padding; the text editor hugs its content while editing.
- Google Fonts + a consolidated text panel; a default text style for new text nodes.
- Shape border width + style; z-order (bring to front / send to back); lock node;
  per-node opacity; custom-colour well in the swatch pickers.
- Grid + edge snapping on resize, grow-to-fit, text wrap; sticky notes grow to fit text.

**Tools**
- Freehand vector **pen**.
- **Laser pointer** with a fading ink trail + colour picker (⌘/Ctrl-drag pans;
  the dot shows only while pressing).
- Collaborative **raster paint** layer — infinite tiled brush, strokes broadcast
  as vectors and rasterise locally, tiles persisted to Storage; bottom paint
  toolbar, Photoshop-style brush-ring cursor, paints over nodes/images.
- Multi-select align / distribute / match width-height; export board as PNG.

**Per-node collaboration**
- **Dot-voting** on nodes (per-user tallies, multiplayer).
- **Comments** on nodes (thread popover, add / delete-your-own, click-away close).
- Alt/Option-drag to clone a node.

**Fixes**
- Editing no longer balloons an auto-width text node; clipped swatch grids fixed;
  vote/comment badges no longer overlap the Inspector and their clicks register
  (pointer-events); CommentThread crash (missing import) fixed.

### Video calls (LiveKit)
- Background blur + strengths, virtual-background images, a self-managed refined
  background pipeline (crisper edges), Krisp noise cancellation, speaker/pin layouts.
- Host moderation — remove / mute from a People roster.
- **Standardised on LiveKit** (retired the Jitsi↔LiveKit A/B split).
- Room-audio model: in-room audio clustering ("companion mode") to kill same-room
  echo; split room mic-source vs audio-sink + self-serve mic take-over; clearer
  in-room mute UX; experimental opt-in proximity auto mic-switching.
- In-room badge on participant tiles; device room-leader beacon fix + tighter
  follower audio + kiosk controls.
- Mobile: declared camera + mic permissions so calls can capture devices.

### Status & presence
- New **"Out to lunch"** presence state (orange) across the status picker, room
  roster, sync-participant list, and shared presence maps.
- **Lunch-break scheduler** — Settings → Notifications: Off / Ask me / Automatic
  with a lunch time + duration. While the app is open it flips your status to
  *Out to lunch* (auto) or prompts you (ask) and flips back after the duration;
  fires a browser notification when permitted; mirrors into an active sync session.
- Fixed sync presence rejecting `heads_down` / `available` (Invalid presence_state).

### Pomodoro & Office
- Edit room settings from inside a room; two-row mobile room header (container queries).
- Stable participant order + a sort picker; office room name in the synced-session header.
- No-account local timer + signed-out landing; rebuilt the PiP popout on the
  shared timer components.

### Device accounts
- Backend: provision / pair / revoke flow with least-privilege RLS.
- UI: admin panel, `/device` pairing, kiosk display.
- Hardened RPCs; the kiosk became a two-way video portal.

### iOS widget
- Airy redesign + fixed the synced-timer widget pause.
- Await home-widget intent round-trips + periodic self-heal.

### Docs / CI / chores
- Rewrote the roadmap (`.TODO`) around the three-program strategy; added this CHANGELOG.
- Renamed the Electron release tag trigger (`electron-v*` → `Mangodoro-v*`);
  docs on opening the unsigned desktop app.

### Migrations added (apply on deploy)
- `whiteboard-images` bucket + RLS; `whiteboard_paint_tiles` RLS (collaborative paint writes).
- `lunch_break_status` (widen presence_state CHECKs + setter RPCs to `out_to_lunch`).
- `lunch_break_prefs` (`lunch_time` / `lunch_mode` / `lunch_duration_min` on user_settings).
- Org device-account tables + hardening; sync-presence full state set.
