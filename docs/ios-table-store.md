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
  placed `topBar + 8` below the safe top (an obstacle at both top corners),
- `bottomBar`: the lazy / spectator pill + 12 padding,
- `fold`: the active division region in scene coordinates (item 27),
- `occlusions`: system UI over the app (`GeometryProxy.reservedRegions`,
  iOS 27.1 SDK); one in the top quarter joins the corner obstacle on its side.

Algorithm (reference model `layout_ref.py`, kept outside the repo; the
Swift port is checked equal on 958 configurations): the bottom bar is
honoured first and dropped only when nothing fits with it (then the pill
overlays the bottom of a read-only hand); for the hand scale s = 1.0, 0.95
... 0.80 and the trick scale k = 1.0 ... 0.70 the first pair that fits wins.
The hand sits 12 pt (or bar + 6) above the safe bottom, its overlap is
min(35s, (safe width - 16 - 100s) / (n - 1)), so 13 cards fit at 375 pt.
The bid band (340 x 140, centered) is reserved above the lifted hand even
while the panel is hidden. The trick cluster (cards 80k x 116k, offsets
from the card size) is centered between the floor (lifted hand + 6, or the
tabletop fold + 6) and the partner (below the top bar and the corner
buttons); side seats sit at the table radius in a "row" (beside the
cluster) or "raised" (above the side cards) mode; the history goes left of
my trick slot (Q2), HSI + voice right of it (Q3, a 124 x 48 row or an 84 x 76
stack), my bid bubble left of my slot. A book fold puts the cluster on the
wider side and keeps side seats off the hinge. When nothing fits (windows
under ~660-720 pt tall at narrow widths, 320x568, 678x466) the layout is
`isDegraded`: s = 0.8, k = 0.7, positions clamped into the safe rect.

Exempt pairs (never on screen together; `TableInvariantTests` proves the
facts over every recorded log): the bid band vs the trick cards, history,
accessory and my bid bubble (the panel shows only with an empty trick and
history); my bid bubble vs the history; the other seats' bid bubbles vs
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
fading); the collect gate is untouched. An unchanged layout is a no-op,
so the two relayouts of a rotation (size, then chrome) are idempotent.
Every layer stays at the scene origin; the hand node carries the hand
scale (`handSlots` are local units), trick sprites are 100 x 145 at 0.8k
(an adopted hand sprite keeps its world scale and scales to it), and
SceneDump tags a scaled container (`scale=`).

Tests: `TableLayoutTests` (golden values, no intersections at the seven
item sizes plus the SE / Duo at zero insets and the docked inner landscape,
topBar 70 / 84, the pill, both folds; hand fit; fuzz 320...1400),
`SceneLayoutTests` (the same with real node frames: a 13-card bid turn with
lifts, trick with hand, spectator, chats from every seat; the bid panel
<= 340 x 140 and ScoreBar <= 84 at capped Dynamic Type), `SceneResizeTests`
(resize mid-replay equals a fresh render, the in-flight iPad rotation,
transient, game end), `TableInvariantTests`.

## Items 21 / 22 status

All bullets are done except these, which are follow-ups:

- **Tournament voice peer discovery (server, gated on C10).** iOS now starts
  voice on every game entry as a seat and on rejoin (rejoin is fully fixed:
  `reconnectOwner` sends `voicePeerList`). No server path sends the peer list
  to a tournament table; emitting it to everyone would reach the App Store
  build, which buffers peers while voice is inactive and later offers to
  stale sockets. It needs clientHello capabilities (item C10) to gate it.
- **21.10b `serverError`**: the server does not emit it yet; deferred to
  `contract/V1_REMOVALS.md` #1 Phase A. The `error` dictionary already shows
  a toast and, for playCard / playerBid / requestSnapshot, resyncs the table.
- `spectateState` does not exist: the store routes `spectatorJoined` by its
  `snapshot` key (V1_REMOVALS #8).

Known server gaps left as they are: draw-phase rejoin is refused; the socket
a `watchSeat` demotes gets no event (item 16).

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
