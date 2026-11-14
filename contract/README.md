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
| `gen.js` | Writes `events.schema.json`, `client/src/constants/events.js`, `iOSClient/BABOnline/Constants/SocketEvents.swift`, `iOSClient/BABOnline/Generated/TableSnapshot.swift` |
| `swift/snapshotSwift.js` | Renders `$defs.snapshotV2` as the Swift `TableSnapshot` Codable (+ `ContractSeq.events` from `SEQ_EVENTS`); throws on an unnamed inline object/enum or an unsupported keyword |
| `lib/validate.js` | Dependency-free validator for the JSON Schema subset used here (throws on any other keyword) |
| `index.js` | `schema`, `validateS2C(event, data)`, `validateC2S`, `s2cNames()`, `c2sNames()` |
| `fixtures/v2/` | Server-generated snapshot v2 fixtures (`npm run contract:fixtures`) |
| `V1_REMOVALS.md` | The non-additive changes, to run after the new iOS build ships |

## The rule: additive only

Status 2026-11-11: iOS 1.1.0 (build 2) is the App Store build and the old
1.0.0 build is answered only with an update message
(`server/socket/upgradeGate.js`), so the non-additive changes in
`V1_REMOVALS.md` may proceed one PR at a time in the order of its plan.
Until a removal PR changes them, the rules below still hold. "The current iOS
app" below now means 1.1.0 (iOS source f05d264), which still reads most v1
keys (see the plan). 1.2.0 (build 6) is live since 2026-11-13 and, with
`MIN_IOS_BUILD` 3 (the gate PR), 1.1.0 is gated too (V1_REMOVALS "Step 0"),
so "the current iOS app" then means 1.2.0 (V1_REMOVALS "What iOS 1.2.0
unblocks").

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

**Deliberate, visible changes to the App Store iOS build.** Two additive keys
switch on read paths the shipped app already has, so its screen changes
(as fixes; "exactly as today" is knowingly relaxed for these two):

- Spectator full state `trumpBroken`, `teamTricks`, `oppTricks`: the App
  Store build reads them in `GameState.restoreFromSpectator` (since Feb 2026)
  but never got them, so a joining spectator saw trump unbroken and 0-0 (or a
  previous game's) tricks. It now shows the real values (spectators view from
  seat 1, so team 1 is "team"; later trickComplete increments use position % 2).
  `leadPosition` on the same payload is read only by iOS source builds after
  10d1538 (2026-11-07); the App Store build ignores it and infers the lead
  from the first card.
- `chatMessage.type` (dropped again 2026-11-11, V1_REMOVALS #12): the
  1.0.0 build's ChatSocketHandler (since ad956b2, 2026-02-16) styled
  `type == "spectator"` lines as spectator chat. 1.0.0 is gated now, and
  1.1.0 and web read `isSpectator`, which stays.

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
`gameDriver.makeIo` / `makeSocket` log (and of the local stubs in
hardening and seatRecovery, which call `instrument(log)` themselves), so
every suite that drives handlers through them (chaos, tournamentLifecycle,
transcripts, presence, seatRecovery, lifecycle, hardening, wireProjection,
contract, contractFixtures, wireCompat) validates every emit in its wire form
(a synchronous JSON round-trip). `contract.test.js` fails if a suite adds a
local stub io/socket without `instrument(log)`. The guard also checks:

- routing: the kind of target (room, mainRoom, tournament, all, or one
  client: self / socket) must be listed in the event's `to`;
- seq: every room broadcast and gameStart carries `seq`, nothing else does
  (a room event the schema marks `seq: false`, spectatorsUpdated, must not).

`server/testUtils/contractGuard.js` (jest `setupFilesAfterEnv`) fails the
test. `contract.test.js` also asserts coverage per event AND per variant
(`NOT_EXERCISED` / `NOT_EXERCISED_VARIANTS` list what is unreached, with a
reason).

Client → server: each c2s schema mirrors its Joi schema's bounds
(`server/socket/validators.js`; `joi` = the wrapper's schema, `joiInHandler`
= one the handler checks itself and drops silently on, the voice relays;
every c2s event with a payload has one since V1_REMOVALS #18); `examples`
must pass both, `invalid` examples must fail both, so a client generated from the schema never sends
what the server refuses. `additiveOnly.test.js` holds c2s to "the server
accepts what it accepted": the `joi` key is unchanged, no documented key
disappears, and every baseline example still validates (the schema may
tighten toward Joi). For s2c, a baseline property that was a bare open
object may be spelled out (narrowing only adds promises) only when listed
in `S2C_REFINED` (today: `recordsResponse.records`).

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
  broadcast (`game:<id>`) carries previous+1 and reaches every room member,
  except `spectatorsUpdated`: the one UNSEQUENCED room event (schema `seq:
  false` with `to: room`; `GameState.emitUnsequenced`; no seq on the wire, no
  bump). Its payload is the whole spectator list, so order against other
  events does not matter, and the App Store build registers no handler for
  it: a sequenced form would open a gap in that build's gate (a
  requestSnapshot) on every change. The guard holds both rules.
  gameStart bumps it once per deal and is sent to every connected seat owner
  and every spectator, all with the same value. Private game events (replays,
  rejoin/restore/actionRejected, youDrew, the private
  updateTurn) are unsequenced. Events that carry it: see `seq: true` in
  `events.schema.json` (only the room variant where a private form exists).
- **R2.** Keep `lastSeq`. `seq === lastSeq + 1`: apply. `seq <= lastSeq`:
  drop. `seq > lastSeq + 1`: a GAP - buffer the event, send `requestSnapshot`,
  apply the snapshot, then replay the buffered events with `seq > snapshot.seq`.
  Unsequenced events always apply in arrival order (Socket.IO keeps per-socket
  FIFO). `client/src/state/snapshotV2.js` has `classifySeq`.
- **R3.** A snapshot with seq S reflects every event ≤ S. It may already
  reflect ABSOLUTE presence events sent right after it (playerReconnected,
  playerActiveMode, gameLogEntry, and, during DRAW_RESOLVING, positionUpdate
  and the playerDisconnected of a draw-time grace seat): treat those as
  idempotent setters. (A joining spectator never gets its own
  spectatorJoined notice: the notice goes to the rest of the room first and
  the joiner's snapshot counts it, V1_REMOVALS #8.) Some state changes carry
  no broadcast and so no seq bump (seating at DRAW_RESOLVING is reflected
  ~1s before positionUpdate; a watch-view owner's or a spectator's /leave
  changes `presence` / `spectatorCount` silently), so **equal seq does not
  mean an equal snapshot**: always apply a snapshot, never skip one because
  its seq is not newer.
- **R4.** DELTA events (playerDrew, bidReceived, doneBidding, rainbow,
  cardPlayed, trickComplete, handComplete, gameStart, destroyHands) are never
  reflected ahead of S (`contract.test.js` (h), `watchSnapshots`).
- **R5.** On a snapshot: replace the whole table, set `lastSeq = S`, except
  what `snapshot.partial` says was left out, which the client keeps:
  - `'log'` (actionRejected; `requestSnapshot {log:false}`): keep the log
    it has (same gameId).
  - `'customPics'` (servers before V1_REMOVALS #19 C only; since then no
    snapshot carries a picture inline and `partial` never lists it): for a
    seat with `hasCustomPic` and `customPic: null`, keep the picture it holds
    for that username, or take it from `players[].pic` of the same v1
    payload.
  `mergeSnapshot(prev, next, {pics})` in `client/src/state/snapshotV2.js`
  does exactly this. A spurious gap costs one request, so debounce
  `requestSnapshot` (the server rate-limits it to 10 per 10s) and do not ask
  for pictures on a gap resync.

Checked per receiver in every chaos seed and in contract F1/F2/F3
(`server/testUtils/seqCheck.js`).

## Resume holds (resumeInMs)

The server holds the table for presentation at fixed points (all delays in
`server/game/pacing.js`): the full trick before `trickComplete`, the last
trick before `handComplete`, the team announcement before
`createUI`/`gameStart`, and a few pre-game steps. While a trick or hand
hold (`trick`, `hand`) is open the table state is authoritative and
complete, every bid/play is rejected with
`actionRejected {reason: 'not_your_turn'}`, and nothing becomes actionable
until the hold's resume event (`updateTurn` in the same tick as
`trickComplete` / the next deal's `gameStart`). The `firstTurn` hold (the
first hand's deal reveal) is the exception: the seat on turn may already
bid during it (the bid ends the hold early), so a client must not disable
bidding just because a snapshot's `resume` is non-null. No action exists in
the pre-game holds (countdown, drawReveal, seating, teams).

`resumeInMs` = the server holds the table this long from emission; clients
may size animations to it, measured from receipt with a local monotonic
timer; never compare it with a local wall clock. Latency only shortens the
client's view by the one-way delay. It appears on:

- `cardPlayed`, only on the card that completes a trick (time until
  `trickComplete`);
- `trickComplete`, only on a hand's last trick (time until `handComplete`;
  absent means the next trick is open now);
- `teamsAnnounced`, always (time until `createUI`/`gameStart`);
- snapshot v2 `resume: {kind, inMs} | null` — the open hold, `inMs` relative
  to the snapshot's own `serverTime` (kinds: countdown, drawReveal, seating,
  teams, firstTurn, trick, hand).

The event order is unchanged; the shipped iOS app ignores the field and
relies on the server's minimum gaps (`pacing.SHIPPED_IOS_FLOORS`).

## Client capabilities (clientHello) and avatar fields

`clientHello {client, version, build?, caps}` (c2s, no reply) tells the
server what this socket can render. It is sent on every connect, before
anything else the client emits (web: `client/src/utils/avatar.js`
`installAvatarSupport`, called at the top of main.js; iOS: the iOS-track
PR). The server keeps it on `socket.data.client`; the last hello wins (one
without a cap downgrades the socket); unknown caps are ignored; over its
rate limit (5 per 10 s) it is dropped silently. A socket that never says
hello — the App Store iOS build, a web bundle cached before the change —
gets the legacy shape of every payload. Caps (`$defs.clientCap`):

- `avatarUrl`: the client renders `/avatar/<username>?v=<16 hex>` URLs
  (same origin as the page; `server/routes/avatar.js`). It then gets, per
  socket, `null` in custom-picture slots plus `avatarUrls` (by position for
  seat payloads, by username for leaderboard / search rows) or `avatarUrl`
  (profile replies). Send this cap ONLY from a client whose every avatar
  render site resolves URLs (web: `avatarSrc` / `applyAvatarImg`; iOS:
  AvatarStore); otherwise its custom pictures go blank.

Avatar field rules (docs/avatars.md has the invariants I1-I6):

1. `avatarUrls`, `avatarUrl`, `seatV2.avatarUrl` (`$defs.avatarUrl`,
   `avatarUrlsByPosition`, `avatarUrlsByUsername`), optional, at payload
   level, are the ONLY way a custom picture travels. A pic slot never
   carries a URL nor, since V1_REMOVALS #19 (2026-11-12), a data URL:
   `$defs.pic` is integer | null (baseline narrowed), `customProfilePic` in
   profile / leaderboard / search rows is null, `seatV2.customPic` is null.
2. Omitted when there is no URL (no custom picture, rendition not ready,
   a hostile or undecodable stored picture, pipeline off): the slot is then
   null and clients show their neutral picture.
3. Every recipient gets the same shape (#19 F): the clientHello avatarUrl
   cap is still logged but no longer picks a payload shape (web on main and
   iOS 1.2.0 send it; the builds that did not are gated).
4. Room broadcasts (positionUpdate, playerActiveMode) are one emit, one seq.
5. Web folds URLs into the existing pic fields as each message arrives
   (`foldAvatarPayload`, socket.onAny) and still renders every older shape
   (number, data URL, null, URL).

## Snapshot v2

`server/game/snapshotV2.js` (`$defs.snapshotV2`): one normalized table view
for ONE viewer, the receiving socket. Every key is always present, the key
order is fixed, no socket ids appear.

Delivery (all additive): `snapshot` on rejoinSuccess, restorePlayerState,
actionRejected (no log) and the spectator full state;
`requestSnapshot {requestId?, customPics?, log?}` → `stateSnapshot`, one of
`{snapshot, requestId?}` or `{snapshot: null, reason: 'not_in_game',
requestId?}`. requestSnapshot includes the log unless `log: false`. No
snapshot carries a custom picture inline (V1_REMOVALS #19 C): `customPic`
is always null, the seat's `avatarUrl` is the picture, `customPics` in the
request is accepted and ignored, and `partial` never lists `'customPics'`.

The terminal moment is never a snapshot: once the socket's game is ENDED
or ABORTED, requestSnapshot answers `not_in_game` (the same as a socket
that was never in a game; ENDED / ABORTED are in the `stage` enum but never
reach the wire). A v2 client takes the end from `gameEnd` / `abortGame`.

Known gap (still open after item 16, it needs the server): when
`watchSeat` (a rejoin or joinAsSpectator by a lazy/resigned owner) moves the
seat to a newer socket, the older live socket is demoted to a pure spectator
and gets NO event (v1 behaviour: any v1 event would change what current
clients show). Its client keeps the seat view, hand included. The web
client renders any `stateSnapshot` it receives for its table, so pushing one
to the demoted socket (`prev` in `seatLifecycle.watchSeat`) is all that is
left; item 16 changed no server code.

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
- `trickHistory` (additive, 2026-11-11): this deal's won tricks in order,
  `{winner, lead, cards}` with the 4 cards in play order from `lead`; exactly
  as many as `tricks` counts (written when the trick is counted, at the end
  of the trick view, and reset with the counts by the next deal; a trick
  still in TRICK_RESOLVING is in `trick.cards`, not here). Public: every
  viewer saw the cards played. At most 13 entries, ~150 bytes each. Web
  draws them as before a reload (its team's face up, the other's face down,
  a spectator's all face up); iOS 1.1.0's decoder ignores the key.
- `seats`: `[]` until all four exist, then 4 in position order, from the seat
  records (#182): controller, presence, owner, lazy, offered, grace/resignable
  timestamps, card count.
- `entrants` / `draw`: before seating; `draw` until the deal resets it (draw
  names are exactly the names playerDrew showed). Bot entrants carry the
  bot's display name before they draw (from the BotController, the name
  playerDrew will show).
- `spectatorCount`: the spectator SOCKET count, cc865b4's meaning (an
  owner's second tab or demoted older socket is in it; wireCompat pins it).
- `watching` (additive, 2026-11-11, the table's spectator badge):
  `{spectators: [{username, pic, avatarUrl?}], count}`, exactly what
  `spectatorsUpdated` sends: `GameState.spectatorList()`, pure spectators,
  one per username in join order, never a seat owner (lazy, resigned or
  /leave'd) or pre-seating entrant; at most 50 entries, `count` the true
  total. `pic` is a stock number or null; a custom picture is only an
  `avatarUrl` (every client that reads the list is avatarUrl-capable).
  Blocked users are listed too (owner: you would want to know). iOS 1.1.0's
  decoder ignores the key.
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
  by `snapshotV2.test.js`. Wired in item 16: every snapshot carrier goes
  through `state/tableSync.applyTableSnapshot` (GameState.applySnapshot,
  MyAction.reconcile, the render, then `state/SeqGate.onSnapshot`: R1-R5 over
  every sequenced event, SocketManager wraps the handlers), and
  `GameScene.render` draws it; `client/src/table/*.test.js` replays the
  recorded games (`npm run ios:fixtures`, read in place) and every fixture
  here through the real page and scene.
- iOS (item 23): `struct TableSnapshot` in
  `iOSClient/BABOnline/Generated/TableSnapshot.swift`, GENERATED from
  `$defs.snapshotV2` by `contract/swift/snapshotSwift.js` (part of
  `npm run contract:gen`, so `contract:check` / `generated.test.js` catch a
  stale file). All types are nested (`TableSnapshot.Seat`, `.Viewer`, ...);
  a required non-null key is non-optional, a nullable or optional one is
  Optional. String enums decode an unknown value as `.unknown(raw)` (or throw
  with `userInfo[.contractStrict] = true`). The live path
  (`TableSnapshot.decode(_:strict:)`, `Models/TableSnapshot+Decode.swift`)
  re-serializes the `[String: Any]` payload value with `JSONSerialization`
  and runs `JSONDecoder`. The `BABOnlineTests` target bundles
  `contract/fixtures/v2` as a folder reference and strict-decodes every file
  (`TableSnapshotDecodingTests`).
- iOS conformance (item 23, `docs/ios-table-store.md`): the store applies
  R1-R5 (seq gate over every sequenced event, chat and voicePeerLeft
  included; buffered gaps; snapshot replay above S; `partial` merge), and
  replays of recorded real games (`npm run ios:fixtures`, drift-checked by
  `server/socket/__tests__/iosEventLogs.test.js`) must equal the server's
  snapshot at every checkpoint.

## Constants

`npm run contract:gen` renders the web and Swift constants from
`layout.json`. Existing names, values and order never change (the shipped iOS
app was compiled against them; `legacyConstants.test.js` pins every cc865b4
constant). New events are appended at the end of their section.
`generated.test.js` fails when a generated file is stale. Verify Swift
changes with `xcodebuild` (see CLAUDE.md).
