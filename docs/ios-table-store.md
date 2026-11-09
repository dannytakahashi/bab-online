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

- Recorded event logs (`npm run ios:fixtures` = `simulate.js --record-ios`,
  drift-checked in `npm test` by `iosEventLogs.test.js`): reducer and
  handler replays match the server snapshot at every checkpoint, and the
  final one (Done-when a); the live-replay node tree equals a fresh render
  of the server snapshot at every checkpoint (Done-when b); recorded rejects
  and timeouts restore the card (Done-when c).
- The contract v2 fixtures (folder reference `v2/`): strict decode, mapping,
  idempotent render.

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

## Visible changes to review on the next build

The rejoin log is restored from the snapshot; bore "Nx" annotations and the
ScoreBar bore badge work (real multipliers); the trick clears in state at
trickComplete (no 0.7 s delay) and there is no turn glow during the trick
hold; the bid overlay is disabled with a spinner while a bid is in flight;
my card shows in my trick slot before the server confirms it (a reject
flies it back); bid bubbles stay from the bid until the hand's first card;
chat bubbles render; voice starts after a rejoin (a first-time mic prompt can
appear mid-game).
