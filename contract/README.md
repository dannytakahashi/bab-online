# BAB Online socket contract

One description of every Socket.IO event between the server, the web client
and the iOS app, checked against the real server in every test run.

**Dev/test only.** Production server code never requires anything under
`contract/` (`contract.test.js` greps for it).

## Files

| Path | What |
|---|---|
| `src/defs.js`, `src/c2s.js`, `src/s2c.js` | The source: shared `$defs` and the two event maps, written with small helpers |
| `events.schema.json` | GENERATED from `src/` (`npm run contract:gen`). The artifact other tools read (e.g. a future Swift Codable generator) |
| `v1-baseline.schema.json` | FROZEN copy of the contract at cc865b4. Edited by hand only when a `V1_REMOVALS.md` entry is executed |
| `layout.json` | Which events each platform's constants file lists, in which section and order, plus `exclude` reasons |
| `gen.js` | Writes `events.schema.json`, `client/src/constants/events.js`, `iOSClient/BABOnline/Constants/SocketEvents.swift` |
| `lib/validate.js` | Dependency-free validator for the JSON Schema subset used here (throws on any other keyword) |
| `index.js` | `schema`, `validateS2C(event, data)`, `validateC2S`, `s2cNames()`, `c2sNames()` |
| `fixtures/v2/` | Server-generated snapshot v2 fixtures (`npm run contract:fixtures`) |
| `V1_REMOVALS.md` | The non-additive changes, to run after the new iOS build ships |

## The rule: additive only

The App Store iOS build will not change until the whole iOS track is done,
so the current iOS app and the current web client must keep working exactly
as today:

- no event is renamed or removed;
- no existing field is removed or changed in type, value or meaning;
- no event order a client depends on changes (createUI before gameStart;
  startDraw then youDrew/playerDrew; bidReceived ×4 → doneBidding → rainbow* →
  updateTurn; 4×cardPlayed → trickComplete → updateTurn; handComplete before
  the next gameStart/gameEnd; actionRejected before restorePlayerState;
  rejoinSuccess before playerReconnected and the presence replays; spectator
  full state before its notice).

New events and new fields are fine: both clients read payloads by name (iOS
casts `[String: Any]` keys one by one, web reads `data.x`), neither iterates
top-level keys, and neither has an `onAny`. Keys in an event's `reserved`
list must never be added (a shipped client would misread them).

Guards: the always-on contract guard (every emit), `additiveOnly.test.js`
(against the frozen baseline), `legacyConstants.test.js` (every cc865b4
constant), `wireCompat.test.js` (values and meaning of the touched
builders), `transcripts.test.js` and `wireProjection.test.js` (legacy keys).

## Changing an event

1. Edit `src/s2c.js` / `src/c2s.js` (or `src/defs.js`).
2. New keys on an existing payload go in its `added` list; if a shipped client
   already reads that name, also in `activates` (and cite the read in
   `clientReads` with `#reads:key`). Add per variant; never merge variants.
3. A new event also goes in `layout.json` for each platform, or in `exclude`
   with a reason.
4. `npm run contract:gen`, then `npm test`.

Status values: `active`; `deprecated` (still emitted or handled, listed in
V1_REMOVALS); `clientOnly` (clients listen, the server never sends it - the
guard fails if it does); `unsent` (handled, no client sends it).

## The contract guard

`server/testUtils/contractCheck.js` wraps the push of every
`gameDriver.makeIo` / `makeSocket` log, so every suite that drives handlers
through them (chaos, tournamentLifecycle, transcripts, presence,
seatRecovery, lifecycle, hardening, wireProjection, contract, ...) validates
every emit in its wire form (a synchronous JSON round-trip). It also checks
seq routing: every room broadcast and gameStart carries `seq`, nothing else
does. `server/testUtils/contractGuard.js` (jest `setupFilesAfterEnv`) fails
the test.

Escape hatches:

- `require('server/testUtils/contractGuard').skip(reason)` for one test, only
  for synthetic `forcePhase` states production never emits. **Current uses:
  none.**
- `BAB_CONTRACT=0` turns the check off for a run.

Overhead (measured at C2): `npm test` 6.4s → 5.8s (noise);
`CHAOS_SEEDS=1500` chaos + tournamentLifecycle 44.0s → 47.7s (+8%). A memo
skips exact repeats of a validated (event, target kind, payload).

`npm run test:contract` = 1500 chaos seeds + tournamentLifecycle +
`contract.test.js`. `bot/sim/simulate.js` never touches handlers or io, so
`contract.test.js` plays full ambient bot games (F2) in its place.

## seq (snapshot v2 consumers)

- **R1.** `seq` is per gameId, starts at 0 and only increases. Each room
  broadcast (`game:<id>`) carries previous+1 and reaches every room member.
  gameStart bumps it once per deal and is sent to every connected seat owner
  and every spectator, all with the same value. Private game events (replays,
  rejoin/restore/actionRejected, youDrew, playerAssigned, the private
  updateTurn) are unsequenced. Events that carry it: see `seq: true` in
  `events.schema.json` (only the room variant where a private form exists).
- **R2.** Keep `lastSeq`. `seq === lastSeq + 1`: apply. `seq <= lastSeq`:
  drop. `seq > lastSeq + 1`: a GAP - buffer the event, send `requestSnapshot`,
  apply the snapshot, then replay the buffered events with `seq > snapshot.seq`.
  Unsequenced events always apply in arrival order (Socket.IO keeps per-socket
  FIFO). `client/src/state/snapshotV2.js` has `classifySeq`.
- **R3.** A snapshot with seq S reflects every event ≤ S. It may already
  reflect ABSOLUTE presence events sent right after it (playerReconnected,
  the spectatorJoined notice, playerActiveMode, gameLogEntry): treat those as
  idempotent setters.
- **R4.** DELTA events (playerDrew, bidReceived, doneBidding, rainbow,
  cardPlayed, trickComplete, handComplete, gameStart, destroyHands) are never
  reflected ahead of S (`contract.test.js` (h), `watchSnapshots`).
- **R5.** On a snapshot: replace the whole table and log, set `lastSeq = S`.
  A spurious gap costs one request, so debounce `requestSnapshot` (the
  server rate-limits it to 10 per 10s).

Checked per receiver in every chaos seed and in contract F1/F2/F3
(`server/testUtils/seqCheck.js`).

## Snapshot v2

`server/game/snapshotV2.js` (`$defs.snapshotV2`): one normalized table view
for ONE viewer, the receiving socket. Every key is always present, the key
order is fixed, no socket ids appear.

Delivery (all additive): `snapshot` on rejoinSuccess, restorePlayerState,
actionRejected (no log, no custom pictures) and the spectator full state;
`requestSnapshot {requestId?, customPics?, log?}` → `stateSnapshot
{snapshot, requestId?, reason?}` (`reason: 'not_in_game'`, snapshot null,
when the socket is in no game). Snapshots attached to v1 payloads use
`customPics: false` (`partial` lists `'customPics'`): the same payload
already carries the pictures in `players[].pic`.

Semantics:

- `stage` is the server FSM stage verbatim (12 names). Renaming one breaks v2.
- `viewer.role`: `seat` (owner of a human seat), `lazyWatcher` (owner of a
  bot-controlled seat - lazy or resigned, `ownerView` seat or watch),
  `spectator`, `entrant` (before seating), `none`. `canAct` is true only for a
  seat on turn that has not bid/played yet.
- `hand`: the seat's cards for `seat` / `lazyWatcher`, else null.
- `deal`: null before the first deal (and through TEAMS_ANNOUNCED).
- `turn`: null outside BIDDING / PLAYING (hides the stale currentTurn during
  DEALING, TRICK_RESOLVING, HAND_RESOLVING).
- `bids.byPosition`: always strings, length 4 with nulls; `order` is the
  bidding order from the bidder; `teamBids` once bidding is over; `mults`
  over the bids so far.
- `trick.cards`: in play order from `leadPosition`. Between tricks `cards` is
  `[]`, `leadPosition` null and the next leader is `turn.position`.
- `seats`: `[]` until all four exist, then 4 in position order, from the seat
  records (#182): controller, presence, owner, lazy, offered, grace/resignable
  timestamps, card count.
- `entrants` / `draw`: before seating; `draw` until the deal resets it (draw
  names are exactly the names playerDrew showed).
- `tournament`: `{tournamentId, name, roundNumber, totalRounds}` or null.

### Draw-phase rejoin (for items 16 / 23)

A rejoin during CREATED / DRAWING stays refused (`reconnectHandlers.js`): the
current clients cannot render a replayed draw (web has no gameId in
sessionStorage until gameStart and DrawManager throws on a playerDrew before
showDrawUI; iOS startDraw does not clear drawResults and playerDrew appends;
casual draws have no activeGameId) and the server would need an entrant
re-key transition valid only in CREATED/DRAWING.

What v2 clients get instead:

- The snapshot's `entrants` and `draw` blocks; `requestSnapshot` already works
  for a connected entrant (it is in `playerGames`).
- Planned opt-in path: `rejoinGame {..., protocol: 2}` → an entrant re-key
  (`entrantReconnect`) → reply `stateSnapshot`. It never replays v1 draw
  events.
- The window that is accepted but misrendered by v1 (a rejoin during
  DRAW_RESOLVING, TEAMS_ANNOUNCED or DEALING shows bidding=true, hand=[],
  trump=null) is renderable from v2 `stage` (fixture `teams-announced`).

### Fixtures

`contract/fixtures/v2/*.json` (+ `index.json`) are produced by
`server/socket/__tests__/contractFixtures.test.js` from real handler-driven
games (counter uuids, a fixed clock, seeded Math.random) and captured exactly
as a client received them. The test regenerates and compares; `npm run
contract:fixtures` rewrites them. Each file: `{name, description,
capturedFrom, viewerRole, snapshot}`.

Consumers:

- Web: `client/src/state/snapshotV2.js` (`parseSnapshotV2`, `classifySeq`,
  `seatAt`, `relativeSeat`, `isComplete`, `teamOf`), tested over every fixture
  by `snapshotV2.test.js`. Not wired into rendering yet (item 16).
- iOS (item 23; no test target yet): a `Codable TableSnapshotV2`, later
  generated from `$defs.snapshotV2` by extending `gen.js`. Enums get an
  unknown-case fallback. An XCTest target adds `contract/fixtures/v2` as a
  folder reference and decodes each file with `JSONDecoder`. The live path
  re-serializes the `[String: Any]` payload value via
  `JSONSerialization.data(withJSONObject:)` before decoding. Explicit nulls
  and the length-4 arrays decode cleanly into `[Card?]` / `[String?]`.

## Constants

`npm run contract:gen` renders the web and Swift constants from
`layout.json`. Existing names, values and order never change (the shipped iOS
app was compiled against them; `legacyConstants.test.js` pins every cc865b4
constant). New events are appended at the end of their section.
`generated.test.js` fails when a generated file is stale. Verify Swift
changes with `xcodebuild` (see CLAUDE.md).
