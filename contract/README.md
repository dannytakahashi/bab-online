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
| `baselines/` | FROZEN per iOS build that is not gated: the contract it was cut from (`ios-<v>-b<n>.schema.json`) and what its Swift decodes (`.decodes.json`); rules, release step and retiring in `baselines/README.md` |
| `baseline.js` | `npm run contract:baseline -- --build <n> [--commit <sha>]` freezes a build; `--check` re-derives the frozen ones from git |
| `lib/swiftDecodes.js` | Reads a build's decode floor from its Swift (ServerEvent.decode and the types it reaches: table events only, the hand-parsed `Networking/Handlers` rely on the schema baselines) and checks a schema against it |
| `lib/decodeRules.js` | The floors' named exceptions: `DECODE_WAIVED` (mismatches that cannot reach iOS) and `DECODE_RELIED` (optional properties a build needs once a planned removal takes their fallback: `positionUpdate.isBot` for 6-8) |
| `layout.json` | Which events each platform's constants file lists, in which section and order, plus `exclude` reasons |
| `gen.js` | Writes `events.schema.json`, `client/src/constants/events.js`, `iOSClient/BABOnline/Constants/SocketEvents.swift`, `iOSClient/BABOnline/Generated/TableSnapshot.swift` |
| `swift/snapshotSwift.js` | Renders `$defs.snapshotV2` as the Swift `TableSnapshot` Codable (+ `ContractSeq.events` from `SEQ_EVENTS`); throws on an unnamed inline object/enum or an unsupported keyword |
| `lib/validate.js` | Dependency-free validator for the JSON Schema subset used here (throws on any other keyword) |
| `index.js` | `schema`, `validateS2C(event, data)`, `validateC2S`, `s2cNames()`, `c2sNames()` |
| `fixtures/v2/` | Server-generated snapshot v2 fixtures (`npm run contract:fixtures`) |
| `rules/legality-cases.json` | Hand-written card-rules case table (legal cards, trick winners, over-trumps) run by Jest, Vitest and XCTest against the three copies of the rules; not wire, not generated |
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
(against the frozen v1 baseline and every iOS build's baseline and decode
floor in `baselines/`), `legacyConstants.test.js` (every cc865b4
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
guard fails if it does); `unsent` (handled, no client sends it). A c2s event
going from `unsent` to `active` (a client starts sending what the server
already handles) is additive: `additiveOnly.test.js` lets it pass every frozen
baseline (2026-11-21: `watchHand`, frozen `unsent` in iOS 1.2.3 (29)).

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
in `S2C_REFINED` (today: `recordsResponse.records`). A baseline payload
that was one object may become named variants only when listed in
`S2C_SPLIT` with the variant that keeps the old shape (checked as the old
payload) and why every frozen build reads the new forms (today:
`gameLogEntry`, 2026-11-18: its `room` variant is the old sequenced line,
`private` the unsequenced /help line; every shipped iOS build decodes
`seq` as optional and applies a seq-less event at once). A baseline `$def` is
held the same way as a payload, recursively: it may gain optional
properties (e.g. `tournamentChatLine.system` / `.type`, the tournament
server notice), never lose, retype or un-require one.
iOS 1.2.0 drops a tournament line whose username the player has blocked
before it reads `type` (TournamentSocketHandler), so an iOS player who
blocked a legacy account named "System" also loses the real notices
there; web does not. Accepted: the username stays 'System' for old clients.

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
  except the three UNSEQUENCED room events, `spectatorsUpdated`, `bidClock`
  and `seatLeft` (schema `seq: false` with `to: room`;
  `GameState.emitUnsequenced`; no seq on the wire, no bump). Each payload is
  an absolute state (the whole spectator list; a running clock with its
  deadline, or stopped; a seat's owner gone for good, which is absorbing and
  a later snapshot shows), so order against other events does not matter,
  and shipped builds register no
  handler for them: a sequenced form would open a gap in their gate (a
  requestSnapshot) on every change. The guard holds both rules.
  gameStart bumps it once per deal and is sent to every connected seat owner
  and every spectator, all with the same value. Private game events (replays,
  rejoin/restore/actionRejected, youDrew, the private
  updateTurn, assistHint, assistState and the private /help and tutorial
  gameLogEntry lines) are
  unsequenced. Events that carry it: see `seq: true` in
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

## Bid clock (bidClock)

Owner 2026-11-18, every game (`server/socket/bidClock.js`, server/CLAUDE.md
"Bid clock"). A human-controlled seat whose bid turn has been open 10 s
(`BID_CLOCK_DELAY_MS`) without a bid gets a 30 s clock (`BID_CLOCK_MS`, the
exact length of the tune `bidclock.m4a`); when it runs out the server bids
'0' for the seat. Bots never get one.

- `bidClock {gameId, position, running: true, inMs, durationMs}` to the
  room (players, lazy watchers, spectators), unsequenced (R1). `inMs` is the
  time from emission to the server's bid, RELATIVE like `resumeInMs`:
  measure it from receipt with a monotonic clock, never compare it with a
  wall clock. The client's deadline (receipt + inMs) is LATE by the one-way
  delay d: a bid sent with "1" showing can reach the server ~2d - 1 s after
  it already bid 0 (then `actionRejected not_your_turn` rolls it back). So
  show the countdown against `receipt + inMs - 750 ms` and stop offering the
  bid at 0, while the tune stays END-aligned with `receipt + inMs` (its
  offset into the file is `file duration - remaining`, from the decoded
  file's own duration, not a constant: AAC priming differs per decoder) so
  its end cue lines up with the `stopped {timeout}` that arrives d late.
  `durationMs` scales the countdown; never assume 30 s (tests shorten it).
- `bidClock {gameId, position, running: false, reason}`: `bid` (the seat
  bid; sent before its bidReceived), `timeout` (the server bids 0 right
  after: let the tune's last fraction ring, detached from the clock state,
  so the bidReceived / updateTurn that follow do not cut it), `controller`
  (a bot took the seat), `turn` (the turn moved some other way). Nothing
  is sent on gameEnd / abortGame / a deploy freeze: clients stop on those,
  on every clearing event (bidReceived for that seat, updateTurn to another
  seat, doneBidding, gameStart, destroyHands), on a snapshot without
  `bidClock`, on leaving the table and on their own socket's disconnect
  (the rejoin snapshot restarts it if it still runs).
- Order of a timeout (one synchronous run): `bidClock stopped {timeout}` →
  `gameLogEntry "<name> ran out of time."` (seq n+1) → `bidReceived {bid:
  '0'}` (seq n+2) → whatever a bid triggers next (`updateTurn`; for the 4th
  bid doneBidding ..., or the all-zero redeal's line, destroyHands, new
  gameStarts). No existing order changes. Shipped clients (iOS <= 1.2.3 (14))
  see only the two log lines and the ordinary bid.
- Timeouts in a row (strike rule, `BID_TIMEOUT_AFK_STRIKES`, default 2; off
  when 0, when `AFK_TIMEOUT_MS` is 0, in AFK-exempt solo games and for a
  disconnected seat): when the timeout is the connected seat's Nth in a row,
  a bot takes the seat as after an AFK takeover, inside that same run,
  after `bidReceived {bid: '0'}` and before whatever it triggers:
  `playerLazyMode`, the log line "<name> was idle and <bot> is playing for
  them. Type /active to return.", then `updateTurn` / doneBidding / the
  redeal (any idle offer for the seat was already withdrawn, with its
  `playerReconnected`, before `bidReceived`). Not at a tournament table
  where another owner is present: that seat is kept and offered to the
  others when its next clock starts (`resignationAvailable {idle: true}`
  and the "seems idle" line, as the AFK watchdog makes the offer).
- A `running` is never sent before the 10 s pre-wait except on a same-turn
  resume (/active, reclaimSeat), which comes right after sequenced events
  that do not clear the clock (playerActiveMode, a log line). That is what
  makes applying it on arrival safe on the web during a seq-gap buffer: a
  sequenced gameStart / updateTurn / destroyHands replayed later belongs to
  an older turn only if the gap outlived the pre-wait, and a gap resolves in
  5 s or less. Keep it that way.
- Snapshot v2 `bidClock {position, inMs, durationMs}` (inMs relative to the
  snapshot's own `serverTime`) is present ONLY while the clock runs and
  absent otherwise (pre-wait, stopped, any other stage). A snapshot is
  state, so a client may (re)start the tune from it at the right offset;
  within 750 ms of the tune already playing for that seat, keep it playing.

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

## Tournament rounds

The host picks the number of rounds, 1 to 5 (default 4), in the tournament
lobby (2026-11-25; `server/CLAUDE.md`, Tournament lifecycle).

- c2s `setTournamentRounds {totalRounds}`: an integer 1..5 (Joi
  `setTournamentRounds`, strict, so `"3"` is refused; rate limit 20 per
  60 s). Host only, lobby phase only; a refusal is a `serverError` ('Not in a
  tournament', 'Only the host can change the number of rounds', 'Rounds can
  only change before the tournament begins'). The same count again sends
  nothing.
- s2c `tournamentSettingsUpdated {totalRounds, by}` to the tournament room,
  then an unstored system `tournamentMessage` ("kim set the tournament to 3
  rounds.") and `lobbiesUpdated` (the summary's `totalRounds`). Ready flags
  are kept.
- No cap and no new field: every tournament payload already carries
  `totalRounds` (tournamentClientState, tournamentRoundStart,
  tournamentGameComplete, tournamentRoundComplete, the main-room summary,
  snapshot v2 `tournament`). Shipped iOS builds ignore the new event, see
  the system line, and read the count from round 1's `tournamentRoundStart`
  (their empty lobby scoreboard shows 4 columns until then).
- Web reads it in the lobby (`TournamentLobby.setTournamentTotalRounds`) and
  sends it from the host's Rounds picker; iOS from build 41.

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
- `casualSpectators` (`$defs.clientCapCasualSpectators`, its own const:
  `$defs.clientCap`'s enum is frozen byte for byte by the baselines;
  2026-11-16, family lobbies): the client can show a lobby of up to 8
  (`members`, `capacity`), its lobby `settings` (`spectatorsCanTalk`,
  always true since 2026-11-18: the host switch and c2s
  `setSpectatorsCanTalk` are gone from the web and from iOS after build 15;
  the server ignores the event and answers with the unchanged settings),
  being an extra who watches the game from its start (spectatorJoined at
  CREATED, never allPlayersReady), and spectator voice (`voiceSettings`;
  every voice spectator may talk). Only for such a
  socket does the server: count it toward a lobby of more than 4 (a lobby
  holds more than 4 only while EVERY human in it sent the cap; a legacy
  joiner is refused at 4, a legacy takeover above 4); add `members` /
  `host` / `settings` / `capacity` to its lobby events and `memberCount` /
  `capacity` / `memberUsernames` to its main-room list entries; admit it to
  a casual game's voice room as a spectator; send it `voiceSettings`.
  Without the cap anywhere the wire is byte-identical (wireGolden). Every
  shipped iOS build (1.2.0 build 6 to 1.2.2 build 11) sends only
  `avatarUrl`; the web bundle sends both since the family-lobbies web PR
  (2026-11-16; `client/src/utils/avatar.js` clientHello, also from a socket
  that cannot fold avatar URLs, which then sends `casualSpectators` alone),
  and iOS 1.2.2 (build 12) sends `avatarUrl` and `casualSpectators`.
  Send this cap ONLY from a client that does all of the above
  (server/voice/gameVoice.js; docs/claude/voice.md "Spectator voice").
- `playAgain` (`$defs.clientCapPlayAgain`, its own const for the same
  reason; 2026-11-16, play again, an automatic return): at the end of a
  casual game a lobby started, the server moves such a socket, if it is
  still at the table (a seat owner, a lazy watcher, a lobby extra still
  watching), into a recreated copy of that lobby (new lobbyId; same name,
  host, settings, chat, lobby bots; nobody ready) and sends it the private
  `lobbyReturn` right after its `gameEnd`. A user whose socket had the cap
  at the start but who is not at the table at the end keeps a place for
  `PLAY_AGAIN_HOLD_MS` (default 2 minutes): a row marked
  `members[].returning`, claimed by joinLobby from any client, and by the
  user's next `joinMainRoom` from a socket with the cap when they had no
  live socket at the end (answered with the ordinary `lobbyCreated`, no
  `mainRoomJoined`). An older-app seat owner gets no row but a reservation
  (`expected`; strangers and Add Bot refused while members + expected would
  pass 4) and keeps its score-screen calls with the returners until it
  leaves that screen (private `voicePeerLeft` both ways). c2s
  `releaseLobbyHold` ("Don't wait"). Nothing changes for a socket without
  the cap: it gets today's `gameEnd` and Return to Lobby flow. Send this cap
  ONLY with `casualSpectators` and from a client that handles `lobbyReturn`
  (server/socket/playAgain.js; `PLAY_AGAIN=off` turns it off). Both
  clients keep their score screen up when `lobbyReturn` arrives and enter
  that lobby only on its Return to Lobby (owner 2026-11-16), then send
  `lobbyReturnSeen` (the server cannot otherwise tell the score screen from
  the lobby screen; until it comes the server treats the socket as still on
  its results: a drop is a 2-minute hold, and at the next start of a lobby
  of more than 4 it gets leftLobby instead of becoming a spectator). The web
  bundle sends the cap since the play-again web PR (2026-11-16; both
  clientHello variants; docs/claude/web-client.md, Play again); iOS 1.2.2 (12)
  (build 12) with `casualSpectators` (`ClientHello.caps`; iOSClient/CLAUDE.md,
  "Play again"). Both send `releaseLobbyHold` ("Don't wait").
- `assist` (`$defs.clientCapAssist`, its own const for the same reason;
  2026-11-18, /help): the client renders the private s2c `assistHint`, the
  answer to its own `/help` or `?help` (a suggestion card with reasons,
  details, confidence, the suggested bid or card, and the use count; kind
  `status` for a reply with no suggestion). Without the cap the same reply
  comes as private, unsequenced, never stored `gameLogEntry {message, type:
  'system'}` lines (at most 2 per ask), which every shipped iOS build shows
  as a dim System line (it applies an event with no `seq` at once). No client
  sends it yet: web from H3, iOS from build 15 (H4). Everything else about
  /help is the same with or without it: the counter, the room notice
  "<name> used /help.", the stats marker (server/socket/assistHandlers.js;
  docs/claude/assist.md).
- `tutorial` (`$defs.clientCapTutorial`, its own const for the same reason;
  2026-11-19, the tutorial): the client renders the tutorial's tips
  (`assistHint` kind `tip`, `tipId`, `actions` ['keep', 'off'] on the welcome
  tip) and the private s2c `assistState {tutorial, auto, uses, freeUses,
  assisted, unlimited?}`; only such a socket gets the tutorial's auto-start
  in a new account's first game (`users.tutorial` 'pending'). Without it
  tips come as private "Tip: <text>" lines and there is no auto-start
  (shipped iOS: none, and a typed `?tutorial` stays chat). The web sends it
  from the tutorial's web PR; iOS from a build after 20
  (docs/claude/assist.md, The tutorial).
- `shoulderView` (`$defs.clientCapShoulderView`, its own const for the same
  reason; 2026-11-21, the over-the-shoulder view): a pure spectator may
  watch one seat's hand, read-only (c2s `watchHand {gameId, position |
  null, requestId?}`, answered by `stateSnapshot {snapshot, reason:
  'watchHand'}` with `viewer.shoulder {position, hand, hsi}`, or by s2c
  `watchHandRefused`; every later deal's spectator `gameStart.shoulder`; the
  watched seat's hints as `assistHint {watched}`; `shoulder` on the entries
  of the spectator list it gets). Without the cap a socket gets NONE of
  these keys or events (its watchHand is dropped silently, with no
  refusal): its spectatorsUpdated, snapshots and gameStart are
  byte-identical to before. A table suspended (self-fence) or frozen
  (handoff) serves no hand on any path (refusal `unavailable`). Never at tournament tables; a spectating socket
  whose user owns a seat at the table may watch only that seat. No client
  sends it yet (server phase 1); docs/claude/spectators.md
  "Over-the-shoulder view" is the client spec.
- `tournamentVoice` (`$defs.clientCapTournamentVoice`, its own const for the
  same reason; 2026-11-24, tournament voice): the client starts voice on its
  tournament lobby screen (muted, only with another member there) and at a
  tournament table, so the server may put it in the tournament's voice room
  (`tournament:<id>`: the members on that screen, at most `TOURNAMENT_VOICE_MAX`, default 8, 2..20; voicePeerList /
  voicePeerJoined / voicePeerLeft as in a lobby, offers relayed between two
  admitted members) and announces it at its table's seating. Without it a
  socket is never a tournament-room peer: shipped iOS 1.2.5 (39) and older
  start no voice on their tournament lobby screen, so a listed one would be
  offered to and never answer. At a tournament table `casualSpectators`
  from iOS that starts voice muted counts too (with `assist`, 1.2.3 (19)
  and later, or build 18 and later: they start voice there and clear
  buffered peers on teardown; 1.2.2 (12) to 1.2.3 (17) start with the mic
  live and are never announced there); a web tab with
  `casualSpectators` but not this cap is cached from before it and never
  starts voice there. No new event or field: only the existing voice
  events. The web sends it from 2026-11-24; iOS from its next build
  (server/voice/tournamentVoice.js, docs/claude/voice.md "Tournament voice").
- `tournamentVoiceStatus` (`$defs.clientCapTournamentVoiceStatus`, its own
  const for the same reason; 2026-11-25, the over-cap notice): the client
  renders the private s2c `tournamentVoiceStatus {admitted, cap}`. A member
  waiting in line for a full tournament voice room (past
  `TOURNAMENT_VOICE_MAX`, default 8) gets `admitted: false` when it enters
  the line (and again when its lobby screen is drawn again while it waits)
  and `admitted: true` when it is let in; nothing else. Without the cap
  nothing is sent (it waits silently, as before). The web sends it from
  2026-11-25 ("Voice is full (N people)" in the tournament lobby); iOS from
  1.2.7, which lists the event for Swift (`contract/layout.json` excludes
  it until then).
- `getYourBid` (`$defs.clientCapGetYourBid`, its own const for the same
  reason; 2026-11-24, Get Your Bid: `server/game/gameMode.js`,
  `server/CLAUDE.md` "Get Your Bid"): the client can show a Get Your Bid
  lobby and its three-seat, no-teams table. The web sends it; no iOS build
  does. Without it a socket is never listed such a lobby or table (the
  main room's lists are built per socket while one exists), and its
  `createLobby {mode: 'gyb'}`, `joinLobby`, `joinAsSpectator` and
  `rejoinGame` for one are refused (serverError / `rejoinFailed` with "Get
  Your Bid is not available in this app yet. Play it at the website.");
  sign-in then names no active game and leaves the pointer for the web. So
  every key below reaches only clients that know the mode. Additive keys,
  all optional: c2s `createLobby.mode` (`classic` | `gyb`); `mode: 'gyb'`
  on every lobby event of such a lobby (lobbyCreated, lobbyPlayerJoined,
  lobbyPlayerLeft, playerReadyUpdate, lobbyReturn), on its list entry
  (`$defs.lobby` `mode`, `seats: 3`; `maxPlayers` stays the frozen 4) and
  on `allPlayersReady`; `$defs.inProgressGame` `mode` + `scores`; and
  `gyb` on gameStart `{scores}`, doneBidding `{forbidden}`, handComplete
  (`$defs.gybHand`: each seat's bid / took / points, the scores before and
  after, the Forbidden Bid), gameEnd and lobbyReturn.lastGame
  (`$defs.gybEnd`: scores, winners, exact bids, hands) and beside every
  snapshot, as the CARRIER's own key (`$defs.gybSnapshot` on rejoinSuccess,
  restorePlayerState, the spectator full state, actionRejected and
  stateSnapshot). `$defs.snapshotV2` itself is unchanged (its generated
  Swift is not touched): a three-seat table fills its four-seat shape
  (`bids.byPosition` / `bids.order` / `tricksByPosition` padded with null /
  4 / 0, three `seats`, `hsi` null, `trickHistory` [] since its items must
  hold four cards) and the real tricks are `gyb.trickHistory` (three cards
  each). At such a table the team keys of every event (`score`, `score1` /
  `score2`, `teamBids`, `mults`, `team1Tricks`, ...) keep their shape and
  carry nothing, `teamsAnnounced` is never sent, `gameStart.hsiValues` is
  `{}`, and no `rainbow`, `destroyHands` or `assistHint` is ever sent.
- `tournamentPairings` (`$defs.clientCapTournamentPairings`, its own const
  for the same reason; 2026-11-25, partners shown openly): the client shows
  the tournament events' `pairings` (the round's tables and "Partners so
  far") and, at a tournament table, `startDraw.teams` / snapshot v2
  `draw.teams` as a draw for first deal ("Partners are set for this round.
  The highest card deals first." with the teams on one line). Every planned
  table (two or more members) sends the teams; the draw is honest (each
  player the card they picked; the draw decides only seats and the first
  deal) only when every human there and every spectator present at its
  startDraw has the cap, otherwise it is staged as before (invisible on the
  wire), so a client without it (iOS 1.2.6 (40) and older, cached web tabs)
  keeps its "The two highest cards are partners" and it stays true. An
  honest table also gets one stored system `gameLogEntry` "Partners this
  round: A & B vs C & D. The draw decides who deals first." The web sends
  it from 2026-11-25; iOS from build 41 (server/CLAUDE.md "Tournament
  partners"). Additive keys: `startDraw.teams` and `draw.teams` (both 2 x 2
  `$defs.plannedTeamPlayer {username, isBot}`, both keys always present:
  build 41 decodes the generated `TableSnapshot` strictly, `Draw.teams:
  [[PlannedTeamPlayer]]?`), `pairings` (`[$defs.roundPairings]`:
  `{roundNumber, tables: [{gameId | null, teams: [$defs.pairingTeam] x 2]}]}`,
  usernames or null for a bot) on tournamentRoundStart, tournamentGameComplete,
  tournamentRoundComplete, tournamentComplete and tournamentClientState
  (tournamentCreated / tournamentJoined), absent while no table has two
  members.

Avatar field rules (docs/avatars.md has the invariants I1-I6):

1. `avatarUrls`, `avatarUrl`, `seatV2.avatarUrl` (`$defs.avatarUrl`,
   `avatarUrlsByPosition`, `avatarUrlsByUsername`), optional, at payload
   level, are the ONLY way a custom picture travels. A pic slot never
   carries a URL nor, since V1_REMOVALS #19 (2026-11-12), a data URL:
   `$defs.pic` is integer | null (baseline narrowed), `customProfilePic` in
   profile / leaderboard / search rows is null, `seatV2.customPic` is null.
2. Omitted when there is no URL (no custom picture, rendition not ready,
   a hostile or undecodable stored picture, pipeline off): the slot is then
   null and clients show their neutral picture (web `default_avatar.png`
   via `seatAvatarSrc`, iOS 1.2.0 the name's initial; never a stock animal).
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
order is fixed, no socket ids appear. One documented exception: `bidClock`
(additive 2026-11-18) is present only while a bid clock runs and absent
otherwise ("Bid clock" above), so every snapshot and recording taken
without a running clock is unchanged; shipped iOS decodes `TableSnapshot`
with Codable, which ignores an unknown key, and the generated Swift makes
it Optional. Two more optional keys (additive 2026-11-19), absent where
they do not apply, Optional in the generated Swift and ignored by every
shipped build's Codable decoder (frozen floors list neither): `viewer.assist
{uses, freeUses, assisted}` (`$defs.viewerAssist`), the receiving seat
owner's own /help count, only for role seat / lazyWatcher, so a client
shows the exact count after a reload (+ `tutorial: true` and `auto:
true` only while the player's tutorial is on, 2026-11-19, so a reload
shows the "Tutorial on" chip); and a `log[]` item's `fault
{position, bid, took}` (`$defs.logFault`), only on a hand's fault line
("Fault: <name> (bid N, took M)", the s2c gameLogEntry room variant's same
optional `fault`), so a replay draws it red in place; and a `log[]` item's
`help {position}` (`$defs.logHelp`, 2026-11-23), only on the /help room
notice ("<name> used /help.", the same room variant's optional `help`), so
a replay draws it in the suggestion's gold.
Each `seats[]` item may carry `tutorial: true` (that seat's owner has the tutorial on: the avatar's graduation cap) and `askedHelp: true` (a counted /help on that seat's open turn: the avatar's lightbulb, until it bids or plays), both additive and present only when true (2026-11-23); the tutorial's room lines carry `tutorial {position, on}` (`$defs.logTutorial`) on the gameLogEntry and on their `log[]` items, so a replay draws them in the cap's colour (only the live tag moves the cap: the seats carry the state).

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
- `hsi`: for `seat` / `lazyWatcher` once dealt, 4 items in position order
  with a number ONLY at the viewer's own position and null at the other
  three (2026-11-21: all four were sent, which let a modified client read
  the opponents' hand strength); null for every other role and before the
  first deal. gameStart's `hsiValues` likewise holds only the receiver's
  own position's key (a spectator's gameStart none). Same schema (items
  were already `number | null`, `hsiValues` has no required key), and every
  client reads only its own position: web `main.js` gameStart
  (`data.hsiValues[gameState.position]`) and `GameState.applySnapshot` /
  `tableModel().hsi`; iOS from 1.2.0 (6) `GameState.myHSI` over `table.hsi`,
  filled from `WirePayload.GameStart.hsiValues` (`[String: Double]?`) and
  `TableSnapshot.hsi` (`[Double?]?`), both optional in every frozen floor.
  No socket ever receives another seat's HSI: `server/testUtils/hsiGuard.js`
  checks every recorded emit of every Jest suite.
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
  by `snapshotV2.test.js` (strict there; live, an unknown value of an open
  enum is kept raw with a warning, like iOS `.unknown(raw)`; an unknown
  stage or viewer role is still refused, falling back to the v1 fields). Wired in item 16: every snapshot carrier goes
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
