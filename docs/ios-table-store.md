# iOS table: reducer, render model, acked actions (roadmap item 23)

Status of roadmap items 21, 22 and 23 for the iOS app (not yet in the App
Store; the shipped build is cc9059f). The wire is unchanged by this work.

## Shape

```
socket event ──> GameSocketHandler.handle(event:payload:)   (Chat / Voice / Lobby / Tournament / Auth / SocketService .error route theirs)
                 └─ ServerEvent.decode  ([Any] → JSONSerialization → JSONDecoder; Networking/Wire)
                 └─ GameState.apply(.server(ev))            (@MainActor store, State/GameState.swift)
                      └─ TableReducer.reduce(&TableState, event) -> [TableEffect]   (pure, State/Table)
                           seq gate (contract/README.md R1-R5) · snapshots are the only restore path (R5)
                      └─ commit the changed slices: table, scores, players, log (@Published)
                      └─ GameSKScene.apply(model: TableRenderModel(state), animations:)   (synchronous)
                      └─ ioRequests → ActionCoordinator (requestSnapshot, ack timers, haptics)
taps / bid overlay ──> ActionCoordinator.play / .bid ──> .local(.submitPlay/.submitBid) + emit, 5 s ack timeout
```

- `GamePhase`: none, waiting, draw(DrawState), bidding(turn, bids),
  playing(trick in play order, lead, turn, bids), handResolving(bids,
  outcome), ended(data). `MyTurnState` (waiting / choosing / submitted) is
  derived from the phase and the one pending submission; a submission never
  edits the hand (the render model hides the card), so a rollback just drops
  `pending`.
- `TableSnapshot` is generated from `$defs.snapshotV2`
  (`contract/swift/snapshotSwift.js`, part of `npm run contract:gen`).
- The scene renders the model idempotently; animations carry `dealSeq` /
  `TrickKey`. Tests swap `InstantAnimator` for `LiveAnimator`.

## Tests

`iOSClient/BABOnlineTests` (shared scheme, `xcodebuild ... test`):

- Recorded event logs (`npm run ios:fixtures` = `simulate.js --record-ios
  <dir>`, drift-checked in `npm test` by `iosEventLogs.test.js`). Deviation
  from the roadmap wording ("an instrumented `npm run sim`"): the bot sim
  never touches handlers or io, so it has no wire to record; `--record-ios`
  runs scripted real-handler games instead (`server/testUtils/iosScenarios.js`:
  memoryDb, fake timers, seeded RNG, the exact iOS payloads) and simulates
  nothing; the sim's own output is unchanged without the flag. Five games:
  1 human + 3 bots (two seeds: spectator join, rejoin mid-trick), 4 humans
  (spectator mid-draw, redeal, bore, every reject kind, rejoin mid-bid,
  /lazy, /active, resign), presence (two resignable seats + a rejoin that
  replays them, a lazy owner's drop / lazy rejoin / /active, two resigns) and
  a tournament (rounds 1 and 2, a spectator via spectateTournamentGame).
  Checkpoints are dense (every step that changed a viewer's log: draw, bot
  turns, trick resolving, presence) in the draw and in each scenario's
  scripted hands, elsewhere at the main seat's turns and every handComplete,
  which keeps the fixtures at ~8 MB. They use the real BotStrategy, so a bot
  or RNG change needs a re-record and then `xcodebuild test`.
- Done-when (a): reducer and handler replays (the handler one through every
  handler's table route and ActionCoordinator, the clock following the
  recording) match the server snapshot at every checkpoint (~2,900) and the
  final one. The projection (`Support/TableProjection.swift`) lists what it
  leaves out and why: notably the log, whose live lines are the client's
  strings (as the App Store build) while a snapshot carries the server's.
- Done-when (b): the live-replay node tree equals a fresh render of the
  server snapshot at every checkpoint, and after every recorded event a no-op
  re-render changes nothing with nothing left in transient and no collect
  open; `testLiveAnimationsConverge` runs LiveAnimator in a window and fails
  (skips only when a probe action shows SpriteKit does not tick).
- Done-when (c): recorded rejects and timeouts restore the card.
- The contract v2 fixtures (folder reference `v2/`): strict decode, mapping,
  idempotent render.

## Table layout (roadmap item 25)

`SpriteKit/TableLayout.swift` is a pure function (CoreGraphics only) of the
scene size and `TableChrome`, which GameContainerView measures:

- `safeArea`: the table pane's insets (the SpriteView ignores the safe area,
  so the scene size is the pane size plus these insets),
- `topBar`: the measured ScoreBar height, `cornerButton`: max(Leave, Log),
  placed `topBar + 8` below the safe top (an obstacle at both top corners);
  `.zero` where Leave / Log are in the vertical bar (below),
- `bottomBar`: the lazy / spectator pill + 12 padding,
- `fold`: the active division region in scene coordinates (item 27),
- `occlusions`: system UI over the app (`GeometryProxy.reservedRegions`,
  iOS 27.1 SDK); a full-height strip on a side edge (the iPad Air reports a
  32 pt one on the left in landscape) widens that side's inset, and the
  Leave / Log button moves in by the same amount (`occludedLeft/Right`);
  any other occlusion joins the corner obstacle on its side with its part
  inside the top quarter.

Algorithm (first written as the reference model `layout_ref.py`, a planning
tool kept outside the repo; the golden values in TableLayoutTests are frozen
from it and TableLayout.swift is the source of truth since item 27): the
bottom bar is honoured first and dropped only when nothing fits with it
(then the pill overlays the bottom of a read-only hand); for the hand scale
s = 1.0, 0.95 ... 0.80 and the trick scale k = 1.0 ... 0.70 (0.60 in a
tabletop split) the first pair that fits wins. The hand sits 12 pt (or bar
+ 6) above the safe bottom, its overlap is min(35s, (safe width - 16 - 100s)
/ (n - 1)), so 13 cards fit at 375 pt; a window too narrow for an 18s step
(320 pt Slide Over) takes a smaller s first.
The bid band (340 x 140, centered) is reserved above the lifted hand even
while the panel is hidden. The trick cluster (cards 80k x 116k, offsets
from the card size) is centered between the floor (lifted hand + 6, or the
tabletop fold + 6) and the partner (below the top bar and the corner
buttons); side seats sit at the table radius in a "row" (beside the
cluster) or "raised" (above the side cards) mode; the history goes left of
my trick slot (Q2), HSI + voice right of it (Q3, a 124 x 48 row or an 84 x 76
stack, kept clear of the right seat's bid bubble), my bid bubble left of my
slot. A book fold puts the cluster on the wider page and keeps the seats off
the hinge, a spectator's bottom seat included (it sits under the cluster);
a seated player's 13-card hand and the bid band are wider than a page and
span the hinge. A tabletop fold puts the table above it (the cluster rises
until the history and HSI / voice fit under the side cards) and the hand
and bid band below it; on the open Duo in landscape (951 x 669, or the
572 x 669 pane beside the side panel) that takes s 0.85-0.9 and k 0.6-0.65,
and with the largest ScoreBar (84 pt) or a hinge over ~20 pt the fold is
ignored instead. When nothing fits (windows under ~660-720 pt tall at narrow
widths, 320x568, 678x466, an iPad Stage Manager window around 700 x 500) the
layout is `isDegraded`: s = 0.8, k = 0.7, positions clamped into the safe
rect, and parts may overlap.

Exempt pairs (never on screen together; `TableInvariantTests` proves the
facts over every recorded log): the bid band vs the trick cards, history,
accessory and my bid bubble (the panel shows only with an empty trick and
history); every bid bubble vs the history; the other seats' bid bubbles vs
trick cards other than my provisional one.

Relayout (`GameSKScene.relayout(animated:)`): `didChangeSize` and every
chrome change build a new layout and every manager's `apply(layout:)` moves
the existing nodes: seats, hand cards (a running move is re-aimed, a lift
or lower in flight is cut short, a lifted card stays lifted), trick cards
and their scale, history place and spacing, bid bubbles (a pop keeps
going), chat bubbles and effects in the transient layer; then the latest
model re-renders (the game-over table too). Size changes are instant; a
fold-only change glides with the scene animator. Trick collects and
handsDestroyed fades in flight finish at their old target (<= 0.4 s,
fading); the collect gate is untouched. A redeal's handsDestroyed moves the
hand sprites into the transient layer at their on-screen place and size
(converted from the scaled hand node) and fades them there. An unchanged
layout is a no-op,
so the two relayouts of a rotation (size, then chrome) are idempotent.
Every layer stays at the scene origin; the hand node carries the hand
scale (`handSlots` are local units), trick sprites are 100 x 145 at 0.8k
(an adopted hand sprite keeps its world scale and scales to it), and
SceneDump tags a scaled container (`scale=`).

Tests: `TableLayoutTests` (frozen golden values; no intersections in
TableLayout's own rect model at the seven item sizes plus the SE / Duo at
zero insets, the docked inner landscape and the measured Duo / iPad chrome,
topBar 70 / 84, the pill; the folds the app really hands TableLayout, seated
and spectating: tabletop and undocked book at 669 x 951, tabletop at 951 x
669 and 572 x 669 (a book fold at 951 x 669 is always docked, so it is not
a TableLayout case); occlusions; hand fit; fuzz 320...1400),
`SceneLayoutTests` (real node frames: a 13-card bid turn with lifts, trick
with hand, spectator, a lazy player's hand with the pill, chats from every
seat, all at the listed sizes plus the measured chrome; the reachable folds
with every seat, a spectator's bottom one included, trick cards and bid
bubbles off the fold and, in tabletop, the hand and bid band below it; the
handsDestroyed fade in place; the bid panel <= 340 x 140 and ScoreBar <= 84
at capped Dynamic Type), `SceneResizeTests` (resize mid-replay equals a
fresh render, the in-flight iPad rotation, transient, game end),
`TableInvariantTests`.

### Leave / Log in the vertical bar (iOS 27.1)

Where the system shows the vertical bar (the Duo's side column with the status
bar: closed, open in landscape, book pose) Leave and the game log toggle are
standard toolbar items (`.topBarLeading` / `.topBarTrailing`) that the system
lays out in that column under the status bar (and folds into its overflow menu
when Live Activities need the room); the corner buttons are not drawn there and
`chrome.cornerButton` is `.zero`, so the table uses the corners. Everywhere else
(open portrait, other phones, the iPad, iOS < 27.1) nothing changes: corner
buttons, no navigation bar. Detection: `EnvironmentValues.toolbarVerticalEdge`
(nil where the system never places a vertical bar; UIKit's
`traitCollection.verticalBarEdge`), not the window size; `ui.pose` ends with
`vbar trailing|-`. `GameContainerView` is `VerticalBarHost`
(`Views/Components/VerticalBarHost.swift`: an iOS 27.1 `NavigationStack` +
`toolbarVerticalEdge`) around `GameScreen`, which owns all the state and adds the
toolbar; the stack wraps the game on every iOS 27.1 device, with the bar hidden
where no vertical bar is used, so a fold never rebuilds the screen. Two UIKit
details: the hidden navigation bar still sits 24 pt down in vertical-bar mode
(zero height) and would end the content's top safe area there, and it takes its
full height for the first pass after launch, so the screen ignores the
container's top safe area and re-adds the window's top inset (measured outside
the stack; `verticalBarChrome`); and the stack lays its root out once at zero
size (the ScoreBar wraps to 120-170 pt there), so the table pane measures
nothing until it has a size. The vertical bar draws a toolbar badge only when it
builds the item, so the Log item's identity follows the unread count. During the
draw both items are disabled (the corner buttons sat under the draw overlay).

The main room and the two lobbies use the same host (each view is a
`VerticalBarHost` around a private `…Screen` that owns the state). In the
vertical bar: the main room's header row is not drawn and its controls are
toolbar items, New Game / Tournament / Stats (`.topBarLeading`, tinted like the
header) and Online / Account settings (`.topBarTrailing`); the online count moves
to the chat header, because the vertical bar lays out symbols only (a text or a
custom-view label lands outside the column, seen with the 27.2 SDK) and a badge
reads as an alert. The game and tournament lobbies' "‹ Leave" is the leading
toolbar item and the title leads the header row; Ready, Begin, Cancel and Add Bot
stay in the content (the tournament's Leave is disabled under the results
overlay, which covered the header button). Elsewhere these screens are
pixel-identical to before. Their dividers and the lobby list's rows paint their
backgrounds only up and down (`ignoresSafeAreaEdges: .vertical`), so nothing
runs under the status column. `LobbyControlsTests` (UI plan) checks that each
control exists once, sits in the column when `ui.pose` reports a vertical bar
(and that one is reported in `TEST_RUNNER_BAB_POSE` closed / open-landscape),
that no content button reaches into the column, and that Stats opens the
leaderboard.

### Lobby chat on the right (regular width)

Owner decision 2026-11-09: on regular width (`horizontalSizeClass == .regular`:
the iPad in both orientations, the open Duo in every pose, which reports
regular/regular) both lobbies put the chat in a right-hand column, as the main
room does; compact (other phones, the closed Duo) is pixel-identical to before.
Game lobby: one `ScrollView` and one `AnyLayout` (`VStackLayout` compact,
`LobbySplitLayout` wide) over the same three children (header + players + Add
Bot, chat, Ready), so a size-class change keeps the chat field's identity, focus
and draft; wide = the header, players and Add Bot at the top of the left 55%,
Ready at its bottom, the chat (with a "Chat" row as tall as the header) filling
the right column. Tournament lobby: two branches (the draft lives in
`TournamentState`); wide = header, player list (the rest of the height,
scrolls) and the buttons on the left; on the right the scoreboard and the
active tables when there are any, sized to their content, then the chat with a
240 pt minimum: when both no longer fit (8 players and two tables in landscape
with the keyboard up) the standings scroll in what is left. Both use
`CappedAboveChat` (content above a chat that fills the rest, capped so the
chat keeps its minimum, scrolling inside the cap). While more of it is below
the cap (iOS 18+, `onScrollGeometryChange`) its bottom 32 pt fade out toward
the chat, and its scroll indicator flashes when it appears, so a cut-off row
(8 players on a phone or the closed Duo: "ora" half under the chat, already
so at 5f81865) reads as a list that scrolls rather than a broken layout;
scrolled to the end, nothing fades (`TournamentListReachTests` scrolls every
row fully into view).

Compact tournament lobby (owner follow-up 2026-11-09; phones, the closed Duo):
the chat is pinned and always on screen, as in the game lobby. Header, then
the players, scoreboard and active tables in one ScrollView sized to its
content, then `TournamentChatView` filling the rest (its field never below the
fold, its messages no longer nested in an outer ScrollView), then the buttons.
Rule: the chat keeps `min(220, 0.55 × H)`, H = the height between the header
and the buttons (closed Duo / iPhone 17 / 17e portrait: 220 pt, the players
above it scroll; at accessibility sizes ~150-200 pt); with few players and no
standings the top takes its natural height and the chat the rest. When H would
be under 200 pt (a short compact window, accessibility sizes with the host's
three buttons) the buttons scroll with the players instead of staying pinned,
so the field keeps its room. Compact iPhones stay portrait (`AppDelegate`
mask), so a landscape phone is not a compact case here. Keyboard (compact):
the screen's GeometryReader ignores the keyboard and a clear view in the
ZStack (compact only: in the wide layout it changed the system chrome's
pixels) measures the room above it; the chat is padded so its field sits on
the keyboard's top, the top section shrinks, and the keyboard covers the
buttons (as Messages does; tap outside or drag the messages to dismiss it).
Keyboard: in the wide layouts only the chat column makes room
for it (game lobby: the layout ignores the keyboard and the chat is padded by
the measured overlap; tournament: the left column ignores it), so typing never
moves the players or Ready. Book pose (a vertical division with both pages at
least 240 pt, `FoldReader.bookHinge`; the Duo partially open in landscape:
455.5 pt left page, 40 pt hinge): the left column ends at the hinge and the
right one starts after it, with no rule between them (the hinge divides them),
so no content spans the hinge, as on the table; otherwise the split is 55%
(the main room still splits at 55% in book pose). `HingeTick` re-reads the fold
at the same window size. Fixtures `tournament-round` (round 3 in play:
scoreboard, two active tables) and `tournament-between` (round 2 complete).
`LobbyControlsTests.test…ChatPlacement` asserts the chat field is right of the
player list on regular width (and that the iPad reports it) and under it on
compact (the tournament's player list may run on, scrolled and clipped, under
the pinned chat: it must start above the field and leave it hittable); on regular width it relaunches with `-uiFold book` and asserts the
players end before the synthetic hinge and the chat field starts after it.
`LobbyControlsTests.testTournamentChatFieldOnScreen` (`tournament-round`, 8
players and the standings) asserts the chat field is inside the window and the
safe area and hittable without scrolling, then types and asserts it is still
hittable, above the software keyboard when one shows (the simulator panel can
attach a hardware keyboard, as on the closed Duo here; the iPhone 17 shows the
software one) and keeps the draft. Neither UI-plan destination shows a
software keyboard in the window (closed Duo: hardware keyboard, the software
one parked below the window; iPad: wide layout, no
keyboard padding), so the plan alone never exercises the compact keyboard
padding (`visibleHeight` / `.padding(.bottom, keyboard - buttonsHeight)`). The
verification recipe for lobby or keyboard changes adds this one test on an
iPhone 17: `xcodebuild test -testPlan BABOnlineUI -destination 'id=<iPhone 17>'
-only-testing:BABOnlineUITests/LobbyControlsTests/testTournamentChatFieldOnScreen`
(there, zeroing that padding fails it: the field is left under the keyboard;
without a software keyboard the test records a "keyboard-overlap check
skipped" activity instead).

## Fixture mode and Duo poses (roadmap items 26, 27)

Fixture mode (Debug only): `-uiFixture <name>` seeds the app from a v2
snapshot (or `UI_FIXTURE_SNAPSHOT`), or shows a static screen (`main-room`,
`game-lobby`, `tournament-lobby`, `sign-in`); `game-end` adds a gameEnd.
No socket on any path (`SocketService.connectionsDisabled`: launch,
foreground, Settings), no voice and no microphone prompt
(`VoiceChatManager.voiceDisabled`, every start path, also in Xcode
previews), avatars show initials, the sign-in screen shows the connected
form. `-uiFold book|tabletop` fakes a 20 pt division at the window center
(the composition only, not the API); `-uiEffect rainbow|b|2b|3b|4b|ot|all` holds
the effects on the table. Accessibility probes: `ui.pose` ("WxH
t/l/b/r topBar N fold F occlusions N sc H/V vbar E", the window's size
classes and the vertical bar edge), `table.layoutCheck` ("ok" when every stable node is inside
the safe rect), `table.state` (lifted card, refreshed on a tap too; hand and
trick counts; the scene's didMove count). The UI tests are their own test
plan (`-testPlan BABOnlineUI`); the default plan is unit tests only. README
"UI tests and screenshots" has the commands.

Measured in fixture mode (Xcode 27.2 simulators, `ui.pose` and the
`[Layout]` line):

| Device / pose | Window | Insets t/l/b/r | ScoreBar | Leave/Log | Layout |
|---|---|---|---|---|---|
| iPhone Duo, closed | 466 x 678 | 0 / 0 / 34 / 84 | 75.3 | 79.7 x 50.3 | s 1, k 0.85, raised |
| iPad Air 11-inch (M4), portrait | 820 x 1180 | 32 / 0 / 20 / 0 | 75.5 | 80 x 50.5 | s 1, k 1, row |
| iPad Air 11-inch (M4), landscape | 1180 x 820 | 32 / 0 / 20 / 0 | 75.5 | 80 x 50.5 | s 1, k 1, row |

The closed Duo reports no top inset and an 84 pt trailing inset for the
whole height (the clock / Wi-Fi cluster on the right edge): the table and the
ScoreBar stay left of it. (The Leave / Log column of this table was measured
before they moved into the vertical bar; the closed Duo now lays out with
corner 0 x 0: s 1, k 1, raised.) `reservedRegions(kind:
.occlusion)` is empty there, so `chrome.occlusions` stays empty (the code
path merges an occlusion in the top quarter into the corner obstacle). The
rows are in TableLayoutTests. The open poses (669 x 951, 951 x 669) are
covered by the layout tests with assumed insets (24/0/20/0 and 0/59/21/59);
their real insets still have to be read from `ui.pose` (below).

Orientation: a phone whose display is at least 600 pt on its short side
(the open Duo's 669 x 951) turns to landscape; every other phone, the closed
Duo (466 x 678) included, stays portrait; the iPad turns freely
(`AppDelegate.mask`). The rule reads the display, not the size classes: the
short side is the same in both orientations, so the mask cannot flip back
after the rotation it allowed (a size-class rule would, if the open Duo's
landscape window reports compact height). Folds (27-4), whichever way the
Duo's hinge turns out to run: tabletop (a horizontal division, in portrait
or in landscape) puts the table above it and the hand and bid panel below
it (ignored when the window is too short to split, e.g. the closed Duo);
in landscape the side panel stays and the table pane gets the same split.
Book (a vertical division) docks the game log on the right page from the
hinge (the table takes the left page) and the scene never spans it, when the
right page is at least 240 pt and the left one 375 pt (the open Duo in landscape); otherwise (open
portrait, ~325 pt pages) the table spans both pages with its cluster and
every seat on the wider page, or ignores the fold when that would crowd the
seats. The open Duo in landscape without a fold docks the log as a 320 pt
side panel (the Log button collapses it); the iPad keeps the drawer.

Pose procedure (the Duo's pose cannot be scripted: the iOS 27.2 SDK has no
posture API in XCTest, `simctl` has no posture command, and powering the
outer display off with `simctl io ... screenConfig` leaves the app in the
closed pose): open Device Hub, pick the iPhone Duo, use its posture control
(closed; open portrait / landscape; partially open for tabletop and book),
then run `TEST_RUNNER_BAB_POSE=<closed|open-portrait|open-landscape>
xcodebuild ... test -testPlan BABOnlineUI -resultBundlePath <r>` and
`iOSClient/scripts/ios-screenshots.sh <r> <dir>` (screen 0 is the outer
1398 x 2034 display, screen 1 the inner 2006 x 2852; `--simctl` gives the
exact 2007 x 2853). `TEST_RUNNER_BAB_POSE_CHANGE=1` runs PoseChangeTests,
which wait 120 s for a fold or unfold with a lifted card / a selected bid.
Device Hub's posture buttons (Closed / Partially Open / Open) answer
background accessibility presses, so an agent with a Device Hub grant can run
this without taking over the screen. Orientation: `XCUIDevice.orientation`
does not turn the Duo's window (DraftRotationTests skips there); the
simulator's own rotate (Device Hub "Rotate", or the iOS Simulator tool's
quarter turn) does.

Recorded 2026-11-09 (iOS 27.2 simulator), `ui.pose` as
window, insets top/left/bottom/right, size classes:

| Pose | Window | Insets | Fold (`[Regions] division`, proxy-local) | Size classes |
|------|--------|--------|------------------------------------------|--------------|
| Closed | 466 x 678 | 0/0/34/84 (status column on the right) | none | compact/regular |
| Open portrait | 669 x 951 | 82/0/34/0 | none | regular/regular |
| Open landscape | 951 x 669 | 0/0/34/84 | none (side log panel on the right, table pane 546 x 669) | regular/regular |
| Partially open, portrait | 669 x 951 | 82/0/34/0 | (0, 373.5, 669, 40): horizontal hinge, 40 pt, centred -> tabletop | regular/regular |
| Partially open, landscape | 951 x 669 | 0/0/34/84 | vertical hinge -> book (table on the left page, 455.5 x 669; log on the right page) | regular/regular |

Open portrait cannot be ruled out by the app: on the inner display iOS 27.2
ignores a landscape-only `supportedInterfaceOrientationsFor` mask (the window
stays portrait) and refuses `requestGeometryUpdate` with UISceneErrorDomain 101
"The current windowing mode does not allow for programmatic changes to interface
orientation" (tried 2026-11-09). In open portrait iOS reserves an 82 pt band
across the top for the status bar and reports no frame for the clock (status bar
frame 2 pt tall, no active occlusion region), so the score bar stays below it,
as the home screen's icons do. The band shows the felt: the score bar's
background stays inside the safe area on every device (owner decision 2026-11-09),
so system zones (status band, Dynamic Island, the Duo's vertical bar) read as table.

Results: the BABOnlineUI plan passes in closed, open-portrait and
open-landscape (21 run, 0 failures; skips: the 2 opt-in PoseChangeTests,
RotationTests (iPad only) and DraftRotationTests (see above));
PoseChangeTests passes (open landscape -> closed mid-bid keeps the selected
bid, closed -> open mid-trick keeps the lifted card); live on a local server:
draft survives rotation and fold, bid selection survives rotation, a lifted
card survives fold and unfold, the trick collects across a fold.

## Card textures, effect art, avatars (roadmap item 28)

- Card faces (`CardTextureGenerator`): one texture per face, drawn at the largest
  on-screen card (`TableLayout.maxCardPoints`, 100 x 145 pt: the hand at s = 1;
  trick sprites are 0.8k) times the screen scale, 8-bit sRGB: 300 x 435 px
  (522,000 bytes) on 3x, 200 x 290 on 2x; 54 faces = 28.19 MB on 3x, 12.53 MB on 2x (measured by
  `AssetEfficiencyTests`; the pre-aea0ebb renderer drew 900 x 1305 px, 4.7 MB each).
  Linear filtering, no mipmaps (the smallest static card is 0.48 of the texture;
  `usesMipmaps` changed nothing in SpriteKit on the 27.2 simulator). The 54 faces
  are rendered off the main thread when a game lobby, tournament lobby or the game
  screen shows (`prewarm()`, once per process); the lock-guarded cache keeps the
  first texture stored for a card, and a face not yet prewarmed renders on demand.
  The card back is not prewarmed (no table sprite uses it; the draw is SwiftUI).
- Effects: the rainbow, bore and OT sprites keep their art's aspect inside their
  box (128 x 118, 80 x 80, 120 x 120). No larger art exists (client/assets has the
  same PNGs): b/2b/3b/4b/ot are registered as 3x (their pixels are ~3x the box),
  rainbow1 (128 x 118 px at 128 x 118 pt) stays 1x and is still upscaled.
  Cards.xcassets (56 unused 64 x 64 PNGs) is gone; the launch screen uses
  LaunchBackground (4af29fa).
- Avatars (`AvatarTextureCache`): one pre-cut circular texture per picture (no
  SKCropNode), one fetch per stock picture however many seats or games ask, a
  generation token drops loads for a picture the seat no longer shows, one avatar
  sprite per seat. Opponent seats are built once per layout and reload only when
  the picture changes (item 23).

## iOS 1.2.0 (build 3): the release after 1.1.0 (roadmap 29 track)

Version: `MARKETING_VERSION` 1.2.0, `CURRENT_PROJECT_VERSION` 3 (Info.plist
reads them; `ReleaseMetadataTests` pins build >= 3). The upgrade gate gates
only builds < 2, so build 3 is current (`upgradeGate.test.js` "1.2.0 (build
3) is current"). It works against today's server and against the server
after the V1 removals: `cardPlayed` is read as `trumpBroken ?? trump`, chat
routes on `isSpectator` (`type` only for an older server), and the server's
failures arrive as `error` and/or `serverError`.

- **Spectators** (`contract/V1_REMOVALS.md` "iOS spectator badge"):
  `spectatorsUpdated` decodes to `ServerEvent.spectators` with seq nil, so the
  gate applies it at once (also while a gap is buffered) and never moves
  `lastSeq`; a list for another gameId is dropped. `PlayersSlice.watching`
  (`WatchingList`) comes from the event and from every snapshot's `watching`;
  `spectatorCount` keeps the socket-count meaning. The badge is SwiftUI
  (`SpectatorBadgeView`, eye.fill + count, a 44 pt target, hidden at 0,
  "99+" past 99, VoiceOver "2 people watching" with the real count; its text
  stops growing at Dynamic Type .large, where "99+" still fits the layout's
  60 x 44 pt `spectatorBadgeSize` (`SpectatorBadgeFitTests` hosts the view at
  every text size; a wider rect no longer keeps clear on a 375 x 667 phone),
  and a long press shows the Large Content Viewer; a tap opens a popover: names with avatars,
  "(you)", scrolling past 8 rows, "and N more" past the server's 50) placed at
  `TableLayout.spectatorBadge(spectating:)` (`TableLayout+Spectators.swift`, a
  pure function of the solved layout; it does not move anything else):
  seated, right of HSI / voice, else above it at the right edge, else the
  nearest clear spot along the edges; spectating (no hand), the bottom-right
  corner above the pill. It keeps clear of the hand, the accessory's content,
  the trick cards, every seat (glow, name, bid bubble), the history and the
  corner buttons; on a packed table (375 x 667 at zero insets) it may cover
  a bid bubble or the history, never the rest; the bid band is exempt: like
  HSI / voice, the badge hides while my bid panel shows. A spectator's chat (`isSpectator`, with or without a
  position: a watching owner's line has none) is
  `TableAnimation.spectatorChatBubble` -> `SKChatBubbleManager.showSpectator`:
  "Name: text" in a green bubble (`spectatorFill`, white text, at most 200 pt
  wide) above the badge (else beside or below it, else higher up its edge,
  else the clear spot nearest the first; `spectatorBubbleCenter`; seated,
  never over the bid band, which the panel would cover; on a phone it may
  cover an empty trick slot, as a seat's chat bubble can, never a seat, the
  hand, HSI / voice, the badge itself or the bottom pill's strip
  (`bottomBarRect`: "Spectating / Exit", the lazy pill; a long line on the
  Pro Max sat under it before 1.2.0 (3)); a seat's chat bubble's last resort
  also stays above that strip), one at a time, the seats' lifetime and two
  lines (`SKChatBubbleManager.fitTwoLines`: SKLabelNode wraps past
  `numberOfLines`, so a longer text drops words and ends in "…"; "two lines"
  is measured with two unwrapped lines of the message's own glyphs
  (`twoLineHeight`), since a line with an emoji is taller than a text line:
  13 pt, two text lines 32 pt, two emoji lines 45 pt, three text lines 47),
  shown even
  before the coalesced list makes the badge appear; players' lines keep their
  seat bubble. Debug: `-uiChat "lou|text;2|text"` holds spectator / seat
  lines on a fixture table for screenshots.
- **Replay**: the harnesses no longer skip spectatorsUpdated and the
  projection compares `watching`, except while a spectatorsUpdated reaches
  the viewer within 1 s of the checkpoint (`RecordedGame.watchingInFlight`:
  the server coalesces 250 ms and fills a joiner's picture in after its
  lookup, while a snapshot shows the list at once).
- **Voice TURN** (V1_REMOVALS "iOS TURN"): `Voice/IceServerStore.swift`.
  `VoiceChatManager.initialize` asks in parallel with the microphone prompt and
  buffers peers / offers until the answer (<= 4 s, else STUN) is in;
  `rtcConfiguration(_:)` maps the entries to `RTCIceServer(urlStrings:username:credential:)`.
  Recovery per peer (`VoiceRecovery`): `RTCIceConnectionState.failed` or no
  connection within 20 s -> one restart (lower socket id refreshes the ICE
  servers and offers on a new connection; the other refreshes and waits 15 s),
  then `PeerInfo.isUnavailable` ("voice unavailable" in the voice panel); a
  later offer from the peer retries. The DEBUG log prints only "ICE servers:
  TURN (n servers)" / "STUN only"; `IceServerEntry`'s descriptions leave the
  credential out. End-to-end audio cannot be checked in the simulator.
- **Voice peers without socket ids**: the speaking glow finds the seat by the
  peer's username (`TableRenderModel.seat(forVoicePeer:username:)`: a seat's
  owner, so a lazy seat's bot still glows for its owner), the seat socket id
  only as a fallback; `closePeer` turns the glow off before it forgets the
  username.
- **`serverError`**: SocketService listens to it next to `clientEvent: .error`;
  `ServerErrorDeduper` drops the other channel's copy (same handler, or the
  same message without one, within 1.5 s), so a failure shows one toast and
  runs `routeTableError` once; a repeat on the same channel is a new failure.
  `WirePayload.ServerError` decodes both shapes (`type` / `code`).
- **`clientHello`** (`Networking/ServerConfig.swift` `ClientHello`): `{client:
  'ios', version, build, caps: ['avatarUrl']}` on every connect, before
  restoreSession. From then on custom pictures come as URLs:
  `Opponent.pictureKey` is the seat's `avatarUrl` (positionUpdate.avatarUrls,
  gameStart.avatarUrls, playerActiveMode.avatarUrl, the snapshot seat's, a
  rejoin carrier's `avatarUrls` as a hint, or the one held for that username),
  else the stock number / inline picture, which is also the fallback when the
  URL fails (`OpponentHandNode.fallbackPic`). `AvatarTextureCache` loads
  `/avatar/<name>?v=` paths through `AvatarLoading.load(path:)`
  (`HTTPAvatarLoader`: same origin only, URLSession's shared cache; the
  versioned URL is immutable) with one fetch per version.
- **Resign offer**: the reducer clears it on the offered seat's
  `playerReconnected` and `playerActiveMode`, on any `playerResigned`, when a
  new `resignationAvailable` moves it, and on every snapshot (rebuilt from
  `seats[].offered`); `GameState.resignationAvailable` also hides an offer
  whose seat is no longer resignable.
- **Live checks**: Debug builds take `-serverURL http://localhost:<port>`
  (`ServerConfig`, localhost / 127.0.0.1 origins only) for the socket and the
  avatar URLs, so the simulator can talk to a local server that is not on 3000.

- **Per-player trick pips** (owner 2026-11-11; web #215 parity):
  `State/Table/SeatPips.swift` is the projection: each seat its OWN bid as
  slots and its own tricks won (past the bid: gold "over" dots; a 0 bid no
  slots until it wins one), a bore seat (B to 4B) the hand size filled with
  the TEAM's tricks and outlined in the bore chip's red (both rings when both
  partners bore), nothing while bidding or before both partners have bid; a
  seat whose own count is unknown shows its team's tricks out of the team
  total. Counts: `ScoreSlice.tricksByPosition` (`[Int?]`), +1 per
  trickComplete winner; a snapshot's `tricksByPosition` when its team's two
  seats add up to the team's count, else the trickHistory winners when all
  of that team's tricks have one, else nil (`TableReducer.seatTricks`, the
  web's `_seatTricksFor`), so a relaunch, a rejoin and a spectator see the
  same counts. Drawn by `SeatPipsNode`: on each avatar's ring (dots at
  radius 25 inside the 60 x 60 glow rect, so the layout is unchanged) as a
  horseshoe open at the bottom, where the name is (1.2.0 (3): a bore's full
  circle covered "kim" on the Pro Max): the dots and the bore's red arc span
  129 degrees each side of the top (`seatArcHalfSpan`), so nothing reaches
  below `seatPipFloor` (-19 pt; a name's ink starts at -20 at most, an
  accented capital), 45 degrees apart or closer, centred on the top and
  filled clockwise from the left end; and, for my own seat (no avatar), a
  pill of one row up to 7, else two balanced rows (8: 4 + 4, 13: 7 + 6;
  `myPipRows`) in a 56 x 20 box at `TableLayout.myPips`
  (`TableLayout+Pips.swift`: where my bid bubble was, else up beside my trick
  slot, under it, right of it above HSI / voice, else the nearest clear
  spot; clear of the hand, HSI / voice, the trick cards, the 13-wide
  history (by 8 pt past its border plus 2 pt of stroke: `myPipsHistoryKeep`;
  the closed Duo's box sat on the pile's top edge before 1.2.0 (3)), every
  seat and its bubble and the corner buttons; the bid band and my bubble are
  exempt: my pips show once my bubble is gone; the spectator badge and its
  bubble keep clear of it). VoiceOver: an invisible element per seat whose
  bid counts, over its footprint ("Ann: 2 of 3 tricks", "Bo: 0 of 1 trick",
  "Cy: Bid 0, no tricks" (a 0 bid draws no slots: `spokenPips`), "Your
  tricks: Team 7 of 10, bore"; identifiers `pips.<position>` / `pips.mine`).
  The drawing nodes (dots, box, bore outline, the history's icons, slots and
  borders) carry a `role` in userData, never a `name`: SpriteKit lists every
  named node in the accessibility tree under its name (about 35 raw
  "pip.3" / "history.team.slot.2" elements per table before 1.2.0 (3)).
  The same rule for the rest of the scene (SpriteKit reads a node with no
  accessibilityLabel by its name): the layers, seats, avatar pictures and
  glows have roles too (`seat.left`, `avatar.image`, `glow.turn`; lookups and
  SceneDump read `name ?? role`), and every node that keeps a name for
  lookups speaks (`SKNode.speak`): cards their `displayName` ("Queen of
  Clubs"; my hand's are buttons, dimmed while illegal, selected while lifted,
  and VoiceOver's double tap lifts then plays, `accessibilityActivate`), a
  seat's name label the whole name, chat bubbles the whole message, bid
  bubbles "Bid 3", effects "Rainbow" / "Double bore" / "Over trump".
  `PolishAccessibilityTests.testEveryNamedNodeReadsAsWhatItShows` walks a
  busy scene; `TableAccessibilityTests` fails on any dotted / underscored or
  layer-name label in the XCUITest tree.
  Colors: Theme.SK `pipBox` / `pipEmpty` / team / `pipOver` (gold) /
  `pipBore` (danger.solid).
- **Bores count as the whole hand** wherever a bid total is shown
  (`Rules/BidTotals.swift`, the web's `rules/bids.js`; capped at the hand):
  the seat pips, the score bar's "Tricks: 2/7" (the team's tricks of its bid
  total once bidding is over; one line, shrinking to 75 % on a 375 pt phone)
  and the trick history's bid border (`TrickHistoryNode`: per row the bid's
  unwon slots as dim boxes and a border in danger.text until the team has its
  total, then success; the web's TrickManager piles). iOS had no bid total
  before (the score bar showed the bids as "3/B" only, the history only the
  won tricks).
- **Restart notice** (owner 2026-11-11, roadmap #17; `State/RestartNotice.swift`):
  the server sends `serverShutdown {message}` about 1 s before it closes every
  socket on every deploy. `SocketService.handleServerShutdown` (registered in
  `SocketService.connect`, next to the serverError listener) records what the
  player would lose (`RestartNotice.place`: a seat (the draw and a lazy seat
  included), spectating, a lobby, a tournament lobby, a tournament game; the
  main room, sign-in, a finished casual game (watched or played: the
  spectator's GameEndView too) and a complete tournament (its results, or
  the last game's end) lose nothing) and the
  ConnectionStatusToast reads "Restarting for an update…" (VoiceOver
  announcement) until the socket is back (a `.reconnectAttempt` counts as the
  drop: Socket.IO-Client-Swift sends no `.disconnect` when the server closes
  the connection and reconnects by itself; 8 s with neither drops the toast).
  After the reconnect the restore paths report: `lost` (restoreSession with
  no activeGameId / activeTournamentId, a failed restore, signIn to the main
  room, rejoinFailed, a `not_in_game` stateSnapshot, tournamentLeft) or
  `survived` (rejoinSuccess, a spectator's full state, tournamentJoined). The
  first `lost` within 2 minutes shows ONE alert ("Server restarted": "Your
  game ended because the server restarted for an update. It won't count
  toward your stats." / "The game you were watching ended ..." / "Your lobby
  closed ..." / "Your tournament ended ..."); later paths show nothing, and
  nothing shows when nothing was lost. The stats sentence holds: stats and
  gameRecords are written only after `gameEnd` (gameHandlers.js
  `recordGameStats`), never on abort or shutdown (`RestartNoticeTests` reads
  the server source). In memory only (the process outlives the restart;
  persisting would put UserDefaults, a required-reason API, into release
  code), so a relaunch inside the window shows nothing.
- **Socket log**: Debug builds no longer set Socket.IO `.log(true)` (it printed
  every payload: the TURN username and credential of voiceIceServers, the
  sign-in / restore payloads). `-socketLog YES` installs
  `Networking/RedactingSocketLogger.swift`, which replaces everything from a
  line's first `[` / `{` with `<redacted>` when the line is about
  voiceIceServers, signIn, signUp or restoreSession or mentions a credential,
  password or token. Release builds never install it (and read no
  UserDefaults for it).
- **VoiceOver** (pre-submission audit): chat Send buttons read "Send" (not
  "Arrow Up Circle"), the table's Leave reads "Leave game" ("Exit game" for a
  spectator), the log drawer's close "Close game log", the voice buttons
  "Mute microphone" / "Unmute microphone" / "Mute <name>"; ready indicators
  "Ready" / "Not ready", medals "1st" to "3rd"; decorative symbols are hidden
  (`AccessibilityLabelSourceTests` fails on an icon-only Button without an
  accessibilityLabel).
- **Disconnect banner**: `TableLayout.disconnectBanner(height:spectating:)`
  (`TableLayout+Banner.swift`) gives the highest full-width strip clear of
  every seat, the trick cards, the history, the hand, HSI / voice, my pips,
  the bid band, the badge and the corner buttons: a wide window (the iPad)
  shows the banner there, off the avatars. A phone has no such strip (the
  partner sits right above the cluster, the side seats and the cluster fill
  every row below), so the banner keeps its old place under the corner
  buttons, over the partner: making room would shrink the table for a
  transient banner.

Tests: `BABOnlineTests/Release12Tests.swift`, `ReleaseMetadataTests`,
`ServerEventDecodingTests` (spectatorsUpdated decodes strictly, with no seq),
`SceneRenderTests.testChatBubbleAppearsInTransient`; the follow-up:
`SeatPipsTests` (the recorded games replayed into a live scene: seated with a
bore, rejoin with B + 2B, a spectator, every viewer in the store, a reload mid
bore hand, unknown counts), `Release12FollowupTests.swift` (`MyPipsLayoutTests`
at every listed size and Duo pose, `RestartNoticeTests`,
`SocketLogRedactionTests`, `AccessibilityLabelSourceTests`).

## Visible changes to review on the next build (1.2.0)

An eye with the number of people watching sits by the HSI / voice buttons
(a spectator: the bottom-right corner); tapping it lists them. A spectator's
chat shows as "Name: text" in a green bubble by the eye instead of only in
the log. Custom pictures load from the server's avatar URLs. Voice asks the
server for relay (TURN) servers, so it connects behind strict NATs; a peer
that still cannot connect after one retry shows "voice unavailable" in the
voice panel. A server error that arrives twice (old and new event) shows one
toast. The "Replace with Bot" banner never outlives the seat's reconnect.
Each seat's avatar ring shows its own bid as dots and fills them with its
own tricks (gold past the bid); a bore ring is outlined red and fills with
the team's tricks; my own dots sit in a small box left of my trick slot once
my bid bubble is gone. The score bar reads "Tricks: 2/7" and the trick
history shows the bid's slots with a red border until the team makes it
(green after), a bore counting as the whole hand. On a deploy the toast says
"Restarting for an update…", and after the reconnect one alert says what
ended (nothing from the main room). VoiceOver reads Send and Leave game; on
the iPad the disconnect banner sits off the avatars.

## Items 21 / 22 status

All bullets are done except these, which are follow-ups:

- **Tournament voice peer discovery (server, gated on C10).** iOS now starts
  voice on every game entry as a seat and on rejoin (rejoin is fully fixed:
  `reconnectOwner` sends `voicePeerList`). No server path sends the peer list
  to a tournament table; emitting it to everyone would reach the App Store
  build, which buffers peers while voice is inactive and later offers to
  stale sockets. It needs clientHello capabilities (item C10) to gate it.
- **21.10b `serverError`**: listened to since 1.2.0 (deduped against the
  `error` twin, above); the server emits it with V1_REMOVALS #1 phase A. The
  `error` dictionary still shows a toast and, for playCard / playerBid /
  requestSnapshot, resyncs the table.
- `spectateState` does not exist: the store routes `spectatorJoined` by its
  `snapshot` key (V1_REMOVALS #8).

Known server gaps left as they are: draw-phase rejoin is refused; the socket
a `watchSeat` demotes gets no event (item 16).

## Visible changes to review on the next build (lobby chat)

On the iPad and the open Duo the game lobby and the tournament lobby show the
chat in a right-hand column, like the main room: the players and Ready (and the
tournament's Begin / Cancel) on the left, the scoreboard and active tables above
the tournament chat on the right. Typing there no longer moves the left column.
On phones and the closed Duo the tournament lobby's chat and its field are now
always on screen under the players (the players, scoreboard and active tables
scroll above it); with the keyboard up the field sits on the keyboard and the
keyboard covers Ready / Begin / Cancel. The game lobby is unchanged.

## Visible changes to review on the next build (items 26, 27)

The open Duo turns to landscape (the closed Duo and other phones stay
portrait); in landscape the game log is a side panel right of the table (like the
drawer, the iPad and the web client), in book pose the right page; in tabletop pose the table sits above the fold
and the hand and bid panel below it. The main room and tournament lobby go
side by side on regular width (iPad, open Duo) instead of above 700 pt; the
game lobby, sign-in and register scroll when the keyboard or a short window
leaves no room, and are capped at 560 / 440 pt wide, the game-end card at
460 pt; in the tournament lobby on regular width the header (Leave, title,
round) stays pinned and only the player list scrolls, on short windows; the
bid grid has fixed 44 pt cells (40 pt faces, 44 x 44 hit areas), the bore
and Submit buttons are 40 pt tall with a 44 pt hit area; the capped corner
and bid buttons show the large content viewer on a long press at
accessibility text sizes. A chat line being typed survives a rotation or a
fold, but not a sign-out, a forced logout, account deletion or leaving its
lobby / game. Cards you cannot play are dimmed with an opaque gray (they were translucent, so the overlapped cards' centre pips showed through them). Debug builds only: `-uiFixture`.

## Visible changes to review on the next build (item 25)

The table is laid out from the screen instead of the web client's 1920 x 953
ratios: seats, trick cards and the hand never overlap at 375-1180 pt (on
375-393 pt phones the side seats rise above the side trick cards and the
trick cards are 72 x 104 on the SE); cards fly in from their seat's side
and a collected trick flies to the winner's seat; a long name is cut at
96 pt with "…"; chat bubbles wrap to two lines and sit above (or below) the
seat; the history moved left of my trick slot, my bid bubble left of my
slot; HSI is "HSI 119.2" in 11 pt mono beside the voice button, right of my
trick slot; the bid panel sits just above the lifted hand; the disconnect
banner sits below the Leave / Log buttons; the ScoreBar, bid panel and the
corner buttons stop growing past Dynamic Type xxLarge. Rotating an iPad or
folding the Duo moves everything at once, cards in flight included.

## Visible changes to review on the next build (item 23)

The rejoin log is restored from the snapshot; bore "Nx" annotations and the
ScoreBar bore badge work (real multipliers); the trick clears in state at
trickComplete (no 0.7 s delay) and there is no turn glow during the trick
hold; the bid overlay is disabled with a spinner while a bid is in flight;
my card shows in my trick slot before the server confirms it (a reject
flies it back); bid bubbles stay from the bid until the hand's first card,
beside the top seat and below the side seats' names (clear of the avatar,
glow and name); chat bubbles render for the other seats (not mine over my
hand: the log shows it); a card lifted outside my play window is lowered
when the window opens (two taps always play); the final table stays behind
GameEndView; voice starts after a rejoin (a first-time mic prompt can appear
mid-game) and stops for good if the player leaves during that prompt.
