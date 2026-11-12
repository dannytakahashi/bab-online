# v1 removal list

The changes from roadmap item 8 that are NOT wire-additive. The owner
decided (2026-11) that the App Store iOS build stays as it is until the whole
iOS track is done, so for months the shipped iOS app and the current web
client must keep working exactly as today. Everything here waits until the
new iOS build has shipped and the old one is gone.

File:line references are as of cc865b4 + item 8 and will drift; the
function names will not.

## Step 0: the old app is gone from the wire (satisfied 2026-11-11; 1.1.0 too with MIN_IOS_BUILD 3)

Originally: log a client version and wait for **zero `protocol < 2` iOS
sessions for 2+ weeks**. Owner decision 2026-11-11 replaces that: iOS 1.1.0
(build 2) is the App Store build, and the old 1.0.0 build (cc9059f, build 1)
is answered only with an update message by `server/socket/upgradeGate.js`
(identified by its handshake User-Agent, `BAB%20Online/1 CFNetwork/...`). A
gated socket never signs in, never joins a room and never receives a game
payload, so no removal below can break it any more.

Second step (owner decision: once 1.2.0 is approved and live; 1.2.0 build 6
went live 2026-11-13, and the gate PR is #234):
`MIN_IOS_BUILD` 3 gates 1.1.0 (f05d264, build 2, `BAB%20Online/2 ...`) the
same way; 1.2.0 (build 6 in the App Store = build 5 + the new app icon, so it
reads what build 5 reads, `iOSClient/` at 92d0c75; build 3 was never
submitted, build 4 was pulled from review) and later are never gated. The gate's payloads were re-checked against what 1.1.0 reads
(SignInView / RegisterView show `signInResponse` / `signUpResponse`
messages in red under the fields; LobbySocketHandler reads
`recentMessages ?? messages`; leftGame / leftLobby / tournamentLeft land in
the main room, whose joinMainRoom gets the update-only room; 1.1.0's table
Leave cannot be reached during the draw (on phones DrawPhaseView's
full-screen overlay covers the corner Leave, which stays enabled; only the
Duo's vertical-bar `leaveBarButton` is `.disabled(phase == .draw)`), so the
gate answers Tap to Draw (`draw`) with leftGame too; the upgradeGate.js header and upgradeGate.test.js run
every gated-socket check for both builds). From that PR on, "the shipped iOS app" in the entries
below means 1.2.0, and the 1.1.0 blockers in "Plan after the gate" are
lifted: see "What iOS 1.2.0 unblocks".

- **Kill switch caveat.** `UPGRADE_GATE=off` lets 1.0.0 and 1.1.0 play again. After
  the first removal below merges, that is no longer a full rollback: the
  old app would meet the new wire. Treat the gate as permanent from then on.
- **The gate's own payloads.** The gate sends `signInResponse`,
  `signUpResponse`, `mainRoomJoined` (with `recentMessages`, the key 1.0.0
  reads; 1.1.0 reads `recentMessages ?? messages`), `leftGame`, `leftLobby`
  and `tournamentLeft` in their v1 shapes. A removal that touches one of
  those shapes must keep the gate's copy valid (it is an old-builds-only
  emitter), e.g. #13 below (done: only the gate still sends
  `recentMessages`).
- **Its one database touch.** A gated restoreSession refreshes that
  session's `lastUsedAt` (nothing else), so the 90-day session TTL does not
  run out while a player keeps opening an old build before updating.
- **Telemetry.** Every iOS socket logs `iOS app connected {build}` and every
  gated connection `Upgrade gate: outdated iOS app {build, username}`.
  1.0.0 and 1.1.0 never send `clientHello` (both are gated); 1.2.0 and later
  send `clientHello {client:'ios', version, build, caps}` on every connect,
  so once this step is live clientHello caps cover every iOS socket that is
  not gated (the 2-week clientHello check for #19 can count iOS).

## How to execute one removal

One PR per entry:

1. Make the server change.
2. Hand-edit `contract/v1-baseline.schema.json` (the frozen baseline) to drop
   what is removed, and update `contract/src`; run `npm run contract:gen`.
3. Update `additiveOnly.test.js` expectations if needed,
   `legacyConstants.golden.json` (constants), `transcripts.test.js` and
   `wireProjection.test.js` (legacy key sets), `wireCompat.test.js` goldens.
   `wireGolden.test.js` hashes the wire through `v1Projection`, which
   undoes exactly the executed removals (one line each, naming its entry),
   so the fcdd885 golden keeps pinning everything else: add the removal
   there, never regenerate the golden for it.
4. Verify: `npm test`, `npm run test:contract` (also `NODE_ENV=production`),
   `npm run test:client`, `npm run build`, xcodebuild, and a manual pass on
   web and the 1.1.0 iOS build against a local server (a 1.0.0 build must
   still get the update message).

## Removals

### 1. App-level `error` → `serverError {code, message, handler}`

- Emit sites: ~50 `socket.emit('error', ...)` across server/socket/* plus
  errorHandler.js (asyncHandler, syncHandler, handleError), validators.js
  withValidation and chatHandlers.sendError.
- Consumers:
  - web `client/src/main.js` `socket.on('error')` (setupSocketErrorHandler).
  - iOS `SocketService.swift` `connect()`: Socket.IO-Client-Swift reserves the
    `error` name, so the server's event arrives on `clientEvent: .error`
    (mixed with transport errors, told apart by payload shape: a dictionary
    with `message` vs a String). Since 0fd6ef1 (ctr-4) the iOS source shows
    `message` as a toast (`serverError` → ConnectionStatusToast); the build
    that ships with the iOS track WILL show these messages. Builds before
    0fd6ef1 do not.
- Phase A (additive, can run before the iOS build): an `emitError(socket,
  {code, message, handler})` helper that sends both `error` and `serverError`;
  a shared code enum in the contract. **Done 2026-11-11 (PR #TBD):**
  `server/socket/serverError.js` `emitError(socket, errorPayload, handler?)`
  sends `error` and then `serverError {code, message, handler}` (code
  `$defs.serverErrorCode`: rateLimit / validation / server from the error's
  type, rejected for a handler's `{message}` refusal; handler = the c2s
  event, null when unknown). Both copies carry the same handler, so a
  client reading both channels (iOS 1.2's ServerErrorDeduper drops the
  second copy only on equal handlers) shows one failure once: a refusal's
  `error` is `{message, handler}` (contract variant `rejected`, additive:
  1.1.0's routeTableError and web act only on playCard / playerBid /
  requestSnapshot, which no refusal names), and the wrappers report the
  registered `socket.on` name (errorHandler `options.event`: mainRoomChat /
  lobbyChat / tournamentChat, not their shared chatMessage schema and
  rate-limit key; clientHello, not its function `handle`) on every path.
  Every emit site uses it (the
  wrappers, ~45 handler refusals, chat's `sendError`); only the dead
  `withValidation` does not. Constants: web `SERVER_EVENTS.SERVER_ERROR`,
  Swift `SocketEvents.Server.serverError` (appended to Connection). The
  iOS fixture `events-humans-s13` now records the twin; the iOS test
  harness (ServerEventDecodingTests, ReplayHarness, RecordedGame) skips it
  like spectatorsUpdated, since 1.1.0 registers no handler. Test:
  `serverError.test.js`.
- **Prerequisite of Phase B:** the new iOS build listens to `serverError`
  (not only `clientEvent: .error`); otherwise dropping `error` silently loses
  the iOS error toast. Same for web.
- Phase B (this entry): drop the `error` emit once no v1 client remains.
- Item 23 note (21.10b): the iOS source does not listen to `serverError` yet
  (nothing emits it); it waits for Phase A. Its `error` path now also resyncs
  the table for playCard / playerBid / requestSnapshot.
- The `validation` variant (`{type:'validation', message}`, from
  `validators.withValidation`) is dead today: nothing calls withValidation.
  Delete withValidation and the variant with this entry.
- **Web ready for phase B (2026-11-12, PR #TBD):** main.js
  `onServerFailure` listens to `error` AND `serverError`, normalizes both
  (`client/src/socket/serverErrors.js` `failureOf`: serverError `code` is
  the v1 `type`) and drops the twin as iOS 1.2's ServerErrorDeduper does
  (`ServerErrorDeduper`: the other channel's copy within 1.5 s with an
  equal handler; both handlers null: an equal message), so a failure shows
  one toast, one restore refusal, one retry. A refused playCard / playerBid
  asks for its snapshot at once (`MyAction.transportError`, the iOS
  reducer's transportError) and a refused requestSnapshot flushes the seq
  gate. The admin panel's rate-limit path (`adminApi.js`) reads either. So
  phase B needs no web change; the `error` listeners stay until it. Tests:
  `client/src/serverErrorPage.test.js` (both copies and serverError alone),
  `socket/serverErrors.test.js`, `admin/adminApi.test.js`,
  `table/postGateSeat.test.js`.
- **Phase B done (2026-11-12, PR #TBD; stacked on the MIN_IOS_BUILD 3
  gate, merges after it):** `emitError` (server/socket/serverError.js) and
  chat's `sendError` send `serverError {code, message, handler}` ONLY; the
  app-level `error` is gone (no `emit('error'` / `sendToPlayer(..., 'error')`
  left under server/, serverError.test.js scans it), and so are
  `errorOf`, `validators.withValidation` and the `error` event's variants
  (handler / validation / message / rejected): contract s2c `error` removed
  (baseline hand-edited), web `SERVER_EVENTS.ERROR` removed (layout +
  legacyConstants golden; Swift never had it: the name is reserved there,
  so SocketEvents.swift is unchanged), the Swift `exclude.error` reason
  dropped, wireGolden `v1Projection` names #1 phase B (the golden games
  send no error: a no-op kept as the record). `events-humans-s13` was
  re-recorded (only its one `error` entry is gone: every other entry,
  checkpoint and final snapshot is equal up to the shifted indices).
  Readers re-checked at eeeeb23, and again for iOS 1.2.0 build 5 (the
  submitted build, `iOSClient/` at main 92d0c75; build 4 was pulled from
  review):
  - iOS 1.2.0 (build 5, `iOSClient/`): `SocketService.swift:193` listens to
    `serverError` (toast via `handleServerError:213`, table resync via
    `routeTableError:52` for playCard / playerBid / requestSnapshot). Build
    5's background-resume fix (#240) builds a new manager and socket on
    every `forceReconnect` (`openConnection:131`), and `registerHandlers:140`
    registers the serverError listener on each one, so a reconnected socket
    still hears it; `isSessionReady` is set only by a successful sign-in /
    sign-up / restore (`noteSessionEstablished:301`), never by an error
    event, so dropping `error` does not touch the session gate. Its
    `clientEvent: .error` listener (`:180`) stays for Socket.IO-Client-Swift's
    own transport errors (a String payload -> `connectionError`), which this
    removal does not touch; its dictionary branch (the app-level `error`) is
    simply never hit. The iOS replay harness (BABOnlineTests
    `RecordedGame`, `ReplayHarness`, `ServerEventDecodingTests`) now routes
    the recorded serverError as the app does; app source unchanged.
  - web on main: `main.js:795-796` (at 92d0c75) listens to both channels and
    `serverErrors.js:31` reads serverError's `code`, `adminApi.js:66,76`
    reads `err.type ?? err.code` on serverError, so web on main needs no
    change (serverErrorPage.test.js at eeeeb23 passes its serverError-only
    cases; live check below). This PR then drops the web's own `error`
    listeners and the twin deduper (main.js `onServerFailure` on serverError
    only, `serverErrors.js` `failureOf(payload)`, adminApi on serverError
    only).
  - The gate's own payloads: upgradeGate.js never sends `error` (header:
    "app-level `error` never sent") and registers no handler for builds 1
    and 2, so they get neither event; upgradeGate.test.js asserts no
    `error` and no `serverError` for a gated socket.
  - Kill switch: with `UPGRADE_GATE=off`, 1.0.0 and 1.1.0 would play again
    but get no error toast or immediate table resync (1.1.0's 5 s ack
    timeout still resyncs a refused play; 1.0.0 loses the card on a
    rate-limited play), as Step 0's caveat says.
  - Stale web tabs: the server never forces a loaded bundle to reload
    (index.html is no-cache, so any reload gets the new one; an open tab
    keeps its JS through a deploy's reconnect). A bundle from before #233
    listens only to `error` (`socket.on('error')` in setupSocketErrorHandler,
    adminApi on `SERVER_EVENTS.ERROR`): it loses the error toasts; a refused
    play / bid still resyncs through MyAction's 5 s ack timeout; a restore
    refusal (`Lobby not found` / `Game not found` / `Tournament not found`
    after a reconnect) gets no answer, so such a tab can sit on a lobby or
    tournament screen that is gone until it reloads; an admin request
    dropped by the rate limit fails by its 15 s timeout instead of at once.
    Nothing hard-breaks, and only a tab left open since before #233 (days
    before this merges) is affected. Bundles from #233 on read serverError.

### 2. The matchmaking queue

**Done 2026-11-11 (PR #TBD).** Gone: c2s `joinQueue` / `leaveQueue` /
`getLobbies` (handlers, registrations, Joi and rate-limit entries), s2c
`queueUpdate`, `GameManager.queue` / `queuedUsers` / `joinQueue` /
`leaveQueue` / `addPlayerToLobby` / `fillLobbyFromQueue` /
`getQueueStatus`, the merge lock's joinQueue refusal and the `lobbyCreated`
`withoutName` variant (`lobbiesUpdated` now goes only to the main room).
`queueHandlers.js` keeps only `handleDisconnect`. Re-checked first: no
sender or listener in 1.1.0 (f05d264) or web on main.

- `queueUpdate` (only from `queueHandlers.leaveQueue`); c2s `joinQueue`,
  `leaveQueue`, `getLobbies` (status `unsent`: no client sends them);
  `GameManager.queue` / `queuedUsers` / `getQueueStatus`; their rate-limit and
  Joi entries; the `lobbyCreated` `withoutName` variant.
- Consumers: none (no listener in either client).

### 3. Client-only listeners

- `lobbyJoined` (web lobbyHandlers.js, iOS LobbySocketHandler.swift:110),
  `roomFull` (web gameHandlers.js:326, iOS GameSocketHandler.swift:281),
  `activeTournamentFound` (web tournamentHandlers.js:102, iOS
  TournamentSocketHandler.swift:181): the server never emits them. Remove the
  listeners in the new builds; then drop the constants and the schema entries.
- **Web listeners removed 2026-11-12 (PR #TBD):** no `lobbyJoined`, `roomFull`
  or `activeTournamentFound` listener or callback (lobbyHandlers.js,
  gameHandlers.js, tournamentHandlers.js, handlers/index.js, main.js); the
  web constants stay (generated; legacyConstants pins them) until the
  schema entries go. `activeGameFound` is kept. Test:
  `client/src/eventHandlerMap.test.js` (no listener for a `clientOnly`
  event but activeGameFound). iOS 1.2.0 still registers all four.
- **Done 2026-11-12 (PR #TBD), after the 1.1.0 gate:** the three schema
  entries (src + hand-edited baseline), the web `SERVER_EVENTS`
  LOBBY_JOINED / ROOM_FULL / ACTIVE_TOURNAMENT_FOUND and the Swift
  `SocketEvents.Server` constants (layout, legacyConstants golden), and the
  iOS source's listeners for the next build (LobbySocketHandler lobbyJoined,
  TournamentSocketHandler activeTournamentFound, GameSocketHandler.events /
  ServerEvent / TableReducer roomFull). Nothing changes on the wire (the
  server never sent them). iOS 1.2.0 (build 5, `iOSClient/` at 92d0c75)
  keeps its four listeners (LobbySocketHandler.swift:119 lobbyJoined,
  TournamentSocketHandler.swift:189 activeTournamentFound,
  GameSocketHandler.swift:18 roomFull, AuthSocketHandler.swift:41
  activeGameFound); they never fire. `activeGameFound` stays (schema, both constants, iOS
  AuthSocketHandler, web authHandlers). Tests:
  `contract/__tests__/v1Removed.test.js`, `eventHandlerMap.test.js`,
  iOS `V1RemovalsTests`.
- **CAUTION `activeGameFound`**: it is the only event that makes the shipped
  iOS app emit `rejoinGame` by itself (`AuthSocketHandler.swift:41`,
  handleActiveGameFound). Keep it as a possible server hook (e.g. to nudge old
  apps back into their game) until the old app is gone.

### 4. s2c `joinMainRoom`

**Done 2026-11-11 (PR #TBD).** Both emits are gone; the /leave answer is
`leftGame` alone (both clients go back to the main room on it and send the
c2s `joinMainRoom` themselves, which stays). Re-checked first: no listener
in 1.1.0 (f05d264: only `LobbyEmitter.joinMainRoom` emits it) or web on
main.

- Emit sites: `seatLifecycle.leaveSeat` (watch view), `chatHandlers.spectatorCommand` (/leave).
- Consumers: none in either client. Drop it.

### 5. `gameStart.playerInfo` - NOT dead (roadmap correction)

The roadmap said "drop gameStart.playerInfo". It is read: web
`client/src/main.js:2495` rebuilds the avatars (positions, usernames, pics)
from it every hand. Prerequisite: item 16 renders seats from snapshot v2
(`seats[]`) and item 10 turns pictures into references. Only then drop it.

**Web no longer needs it (audit 2026-11-12).** What web reads from it:
`client/src/state/GameState.js` `applyDeal` (positions, usernames, pics to
`playerData`, when present; else it keeps what it has and only recomputes
the names) and `client/src/utils/avatar.js` `foldAvatarPayload`
('gameStart': folds `avatarUrls` into its pics). Names and pictures also
come from positionUpdate (seating), playerLazyMode / playerActiveMode /
playerResigned (`applySeatDisplay`) and every snapshot's `seats`, so a
gameStart without it changes nothing on the table: the post-gate replays
(`client/src/table/postGate*.test.js`, `testing/postGateWire.js` '#5')
match the server's seat names and counts at every checkpoint, and so did a
scratch run over humans-s13 seat1 / seat3 / seat2-rejoin, presence-s21
seat1-rejoin, tournament-s15 seat1 and bots-s12 spectator. The reads can
stay (harmless when the key is gone). iOS 1.2.0 decodes it optionally
(`TableReducer+Events` gameStart, `p.playerInfo ?? []`); whether its table
keeps names and pictures without it is not checked here, and 1.1.0 needs it.

### 6. `gameStart.players` (seat socket ids)

Leaks socket ids, but it is READ: web `main.js` gameStart handler stores it
(`gameState.setPlayerData({ sockets: data.players })` → `playerData.socket`)
and `startVoice` / `onSpeakingChange` maps a voice peer's socket id to a seat
with `pd.socket.indexOf(id)` to highlight the speaking player. iOS does not
read it. Prerequisite: a v2 seat ↔ voice-peer mapping (e.g. voice peers
carry a position, or a voice-only id per seat) used by web; only then drop
it. Until then dropping it silently breaks the web speaking indicator.

**Web ready 2026-11-12 (PR #TBD).** The speaking glow
(`client/src/voice/speakingSlot.js`, main.js startVoice) maps a peer by its
username (voicePeerList / voiceOffer, named by the server): first the seat's
OWNER (`GameState.seatOwners`, from positionUpdate and every snapshot's
`ownerUsername`, never overwritten by a lazy / resign bot), then the name
the seat shows, the seat socket id only as the fallback, as iOS 1.2's
`TableRenderModel.seat(forVoicePeer:username:)`. A gameStart without
`players` keeps the socket ids positionUpdate gave (`applyDeal`). Tests:
`voice/speakingSlot.test.js` (no socket ids, a lazy owner),
`state/seating.test.js`.

**Done 2026-11-12 (PR #TBD), after the 1.1.0 gate:** dealHand's seat
gameStart no longer carries `players`. Re-checked first at eeeeb23: web reads
it only in `GameState.applyDeal` (`Array.isArray(data.players) ? ... :` the
ids positionUpdate gave; voice glow by username first, the socket id only as
the fallback, `voice/speakingSlot.js`); iOS 1.2.0 decodes it optionally
(`WirePayload.GameStart.players`) and never reads it. (At eeeeb23 web paired
these deal-order ids with playerInfo's position order, so its fallback ids
were per-seat wrong whenever deal order differed from seat order; without
`players` it keeps positionUpdate's position-ordered ids.) Gone with it: the
schema and hand-edited baseline property (seat variant), the iOS source's
dead `GameStart.players` (next build). positionUpdate's `sockets` stay (#14).
iOS fixtures re-recorded (only the key goes), wireCompat compares the
cc865b4 seat gameStart without it, and wireGolden's `v1Restore` puts it back
so the fcdd885 golden still pins the rest. Tests: `lifecycle.test.js` (#6
block), `contract/__tests__/v1Removed.test.js`, transcripts, iOS
`V1RemovalsTests`.
Re-checked 2026-11-13 for iOS 1.2.0 build 5 (`iOSClient/` at main 92d0c75,
the submitted build): `WirePayload.GameStart.players` is still decoded
(WirePayloads.swift:40) and still never read: `TableReducer.gameStart`
(TableReducer+Events.swift:276) reads only gameId, currentHand, dealer,
position, trump, hand, hsiValues, score1/score2, playerInfo and avatarUrls.

### 7. `playerAssigned`

- Emit: `gameHandlers.handleDrawComplete` (to each connected human).
- Consumer: web `client/src/main.js:1495` (playerId, position).
- Replacement: v2 `viewer.position`.
- **No consumer since 2026-11-12 (PR #TBD):** the web listener is gone. My
  seat comes from positionUpdate (my username's position, the socket id as
  a fallback: `GameState.applyPositionUpdate`), every seat gameStart's
  `position` and every snapshot's `viewer.position`; `playerId` (my socket
  id) is set at sign-in and read by nothing but the debug toJSON. Neither
  iOS build reads it, so the server may drop the emit once 1.1.0 is gated.
  Tests: `state/seating.test.js`, `eventHandlerMap.test.js`,
  `table/postGateSeat.test.js` (my seat and partner known before the first
  deal with no playerAssigned).
- **Done 2026-11-12 (PR #TBD), after the 1.1.0 gate:** handleDrawComplete
  no longer sends it. Re-checked first: web on main has no listener (only
  comments name it); iOS 1.2.0 (iOSClient at eeeeb23) registers it
  (GameSocketHandler.events) but its reducer case is `break`, and it is
  private and unsequenced, so its absence opens no seq gap. Gone with it:
  the schema entry (src + hand-edited baseline), the web PLAYER_ASSIGNED
  and Swift `playerAssigned` constants (layout, legacyConstants golden),
  the iOS source's listener / ServerEvent case / reducer case (next build),
  and the test harnesses' read (avatarHarness / pacingHarness find the
  seat in positionUpdate). iOS fixtures re-recorded (only the
  playerAssigned lines go; every other entry and checkpoint snapshot is
  unchanged), and wireGolden's `v1Restore` puts the old emits back so the
  fcdd885 golden still pins the rest. Tests: `lifecycle.test.js` (#7
  block), `contract/__tests__/v1Removed.test.js`, transcripts T-draw,
  iOS `V1RemovalsTests`.
  Re-checked 2026-11-13 for iOS 1.2.0 build 5 (`iOSClient/` at main
  92d0c75, the submitted build): still registered
  (GameSocketHandler.swift:13), decoded (ServerEvent.swift:83) and ignored
  (TableReducer+Events.swift:23-24 `break`); build 5 finds my seat from
  positionUpdate (TableReducer+Events.swift:265-271) and the seat gameStart's
  `position` (:285-288).

### 8. Split `spectatorJoined`

- Today one event carries both the joiner's full state (socket.emit) and the
  room notice (game.broadcast, which also reaches the joiner - ctr-17), and
  `seatLifecycle.watchSeat` via 'spectate' sends the notice for an owner.
- Replacement: a self-only `spectateState` (or just the v2 snapshot) plus the
  notice via `socket.to(room)`; stop the notice from watchSeat 'spectate'.
- Consumers: web lobbyHandlers.js + main.js onSpectatorJoined (routes on
  `players && trump`), the App Store iOS build (routes on
  `players != nil && trump != nil`); iOS source after item 23 routes on the
  `snapshot` key (ServerEvent.decode), so a self-only snapshot carrier works
  for it. `spectateState` still does not exist.
- **Web (2026-11-12):** onSpectatorJoined takes the full state from the v1
  keys OR the snapshot (`trump` dealt and `players` / `snapshot.seats`, the
  same rule as before), so a `spectatorJoined {snapshot}` to the joiner plus
  the notice via `socket.to(room)` needs no web change
  (`table/postGateSpectator.test.js`). A NEW event name (`spectateState`)
  would still need a web listener.

### 9. Legacy client-state keys → snapshot-only rejoin / restore

The legacy `getClientState` (22 keys) and spectator-state keys: `bids`
changing shape mid-hand, sparse `playedCards`, `phase` / `bidding`,
`players[].socketId`, `resignedPositions` / `lazyPositions`, and the C10
aliases (`leadPosition`, `trumpBroken`, `teamTricks`, `oppTricks` on the
spectator state). Replacement: rejoinSuccess / restorePlayerState / the
spectator state carry only `{snapshot}` (and `tournamentId` while web needs
it). Prerequisite: items 16 and 23 render from v2. iOS (item 23) restores
the table only from `snapshot`, but the new build still READS two legacy keys
of these carriers, so #9 as written would break it (blockers):

- `players[].socketId`: its only socket-id source for the voice speaking
  glows after a rejoin / restore / spectate (v2 has no socket ids; live play
  gets them from `positionUpdate.sockets`).
- `players[].pic`: its custom-picture fallback, because every server-built
  rejoin / restore / spectator snapshot uses `customPics: false`
  (gameHandlers.js, seatLifecycle.js, mainRoomHandlers.js,
  tournamentHandlers.js).

Before #9: either keep `players[].socketId` and `pic` in the replacement, or
have iOS follow a restore with `requestSnapshot {customPics: true}` (or
avatar URLs, C10) and take socket ids from another source (e.g. a voice peer
list). It also reads `tournamentId` (kept while web needs it); `isLazy` is
decoded but never read. Web (item 16) does not render from v2 yet.

**Web ready 2026-11-12 (PR #TBD); audit of what it still reads.** Every
carrier goes through `state/tableSync.applyTableSnapshot`: the v2
`snapshot` is the table; `state/legacySnapshot.js` builds one from the v1
keys only when a carrier has no valid snapshot (an older server). Reads of
legacy keys left, all with a snapshot fallback:
- `players[]` (`tableSync.js` `applyTableSnapshot` to
  `GameState._seatsToPlayerData`): when present it wins for names /
  pictures (`pic`) and gives the voice glow's socket-id fallback
  (`socketId`); without it the snapshot's seats (`avatarUrl`, `customPic`,
  the picture already held) are used. `utils/avatar.js` folds `avatarUrls`
  into it.
- rejoinSuccess `gameId` and `isLazy` (main.js onRejoinSuccess): else
  `snapshot.gameId` and `snapshot.viewer.role === 'lazyWatcher'`;
  `tournamentId` (kept by the plan).
- restorePlayerState / spectator full state `gameId`: else `snapshot.gameId`.
- spectator full state routing `players && trump`: else `snapshot.seats` /
  `snapshot.trump` (#8).

So `{snapshot}` (+ rejoinSuccess's `tournamentId`) carriers need no web
change: `table/postGateRejoin.test.js` (a lazy rejoin, /active,
restorePlayerState, to the game end) and `postGateSpectator.test.js`.

### 10. `cardPlayed.trump` → `trumpBroken`; drop `playerId`

**Done 2026-11-11 (PR #TBD), two commits:** first `trumpBroken` is sent
beside `trump` (the reservation was for 1.0.0 only), then `trump` and
`playerId` are dropped: cardPlayed is `{card, position, trumpBroken,
resumeInMs?, seq}` (`GameState.cardPlayedPayload(card, position)`).
Re-checked first: 1.1.0 (f05d264) `WirePayloads.CardPlayed` decodes both
names and `TableReducer+Events` takes `trumpBroken ?? trump`; web
`GameState.applyCardPlayed` reads either; neither reads `playerId` (1.1.0's
`playerId` is its own socket id, from AuthSocketHandler). iOS event
fixtures re-recorded; web `soloPacing.test.js` tells bot leads by seat.

`trump` is a Bool meaning "trump is broken" (iOS GameSocketHandler.swift:531
reads `trumpBroken` first, then `trump`). Rename in the new builds; drop
`playerId` (a socket id).

### 11. `bidReceived.bid` always a string; `bidArray` → v2

**Done 2026-11-11 (PR #TBD), the string half:** the echo is the
normalized bid string (`bidString`, the value `bidArray` already holds);
`$defs.bidWire` is gone. c2s `playerBid.bid` still takes an Int (1.1.0
sends one for every numeric bid; `bid13.test.js` pins the Int -> string
round trip through Joi and the handler). `bidArray` stays (web and 1.1.0
read it). iOS event fixtures re-recorded.

iOS sends numeric bids as Int and the server echoes them (`$defs.bidWire`;
not an audit finding: ctr-22 is iOS feature work, out of scope). v2
`bids.byPosition` is already strings.

### 12. `chatMessage`: keep one of `isSpectator` / `type`

**Done 2026-11-11 (PR #TBD): `isSpectator` kept, `type` dropped** (human
and bot chat). Re-checked first: web's onChatMessage and its spectator
bubble (#220) route on `isSpectator` only; 1.1.0 (f05d264) reads
`isSpectator ?? (type == "spectator")` in TableReducer+Events and
`ChatMessage.from` (lobby / tournament lines, which never carried `type`)
defaults a missing `type` to player and lets `isSpectator` win. The iOS
event fixtures and `contract/fixtures/web/spectator-chat.json` were
re-recorded (only `type` left them).

Web reads `isSpectator` (main.js:3217); the App Store iOS build reads `type`
(ChatSocketHandler.swift at cc9059f) and the new iOS build reads
`isSpectator ?? (type == 'spectator')` (TableReducer+Events.swift). Item 8
sends both; once the App Store build is gone either can go.

### 13. `mainRoomJoined.recentMessages`

**Done 2026-11-11 (PR #TBD).** The main-room handlers (joinMainRoom,
leaveLobby, a tournament's sendToMainRoom) send `messages` only; the
upgrade gate's 1.0.0-only payload (`upgradeGate.sendMainRoom`) keeps
`recentMessages`, so the property stays in the schema, optional (baseline:
no longer required). Re-checked first: 1.1.0 (f05d264) LobbySocketHandler
reads `recentMessages ?? messages`, web reads `messages`. Test:
`mainRoomJoined.test.js`.

Duplicates `messages`; iOS reads `recentMessages` first with `messages` as the
fallback (LobbySocketHandler.swift:33). Drop once the old app is gone.

### 14. Socket ids on the wire

`positionUpdate.sockets` / `usernames[].socketId`, `playerDrew.socketId`,
lobby `players[].socketId` where replaceable (removeBot needs the bot's id
today), `players[].socketId` in the legacy states.

**Web (2026-11-12):** needs none of positionUpdate's socket ids (my seat by
username, the glow by owner / username: #6, #7), `playerDrew.socketId`
(never read) or the legacy states' `players[].socketId` (fallback only:
#9). Still read by web: lobby `players[].socketId` (GameLobby.js, removeBot's
`botSocketId`) and the voice signaling's own ids (`voicePeerList` /
`voicePeerJoined` / `voicePeerLeft` `socketId`, `voiceOffer` / `voiceAnswer`
/ `voiceIceCandidate` `fromSocketId`, the c2s `targetSocketId`), which #14
does not remove.

### 15. `rejoinFailed.debug.playersInGame`

**Done 2026-11-11 (PR #TBD).** rejoinFailed is `{reason}` only; the names
stay in the server's debug log. Test: `v1LeakFixes.test.js`.

Leaks usernames to whoever asks. Safe for both clients now (neither reads
`debug`), so this one may move earlier if the owner agrees.

### 16. Lobby players' `personality`

**Done 2026-11-11 (PR #TBD).** `$defs.lobbyMember` has no `personality`;
the server keeps it in `lobby.botPersonalities` (by bot socket id,
`GameManager.lobbyBotPersonality`) for the reveal at game start. Test:
`v1LeakFixes.test.js`.

Leaks a bot's real personality name before the game starts (the lobby shows
"🤖 Bot"). Drop from lobby payloads.

### 17. `serverShutdown`

**Kept (owner 2026-11-11): web and iOS 1.2 show it.** Not removed. Web
(2026-11-11): the connection banner shows "BAB Online is restarting for an
update. You'll reconnect in a moment." until the socket is back, and the
first restore path that finds the game / watched game / lobby / tournament
gone shows one message saying it ended because of the restart
(`client/src/state/restartNotice.js`, sessionStorage, ~2 min; nothing for
the main room). No server change: gracefulShutdown's io.close() is a
transport close, so both clients reconnect by themselves
(`server/__tests__/serverShutdown.test.js`). iOS 1.1.0 ignores it.

### 18. Hardening that could reject inputs

**Done 2026-11-11 (PR #TBD).** Joi schemas (`server/socket/validators.js`):
`joinLobby {lobbyId: uuid}` and `removeBot {botSocketId: 'bot:...'}` (both
now `syncHandler`), `searchPlayers {query <= 500}`, `getPlayerProfile
{username 1-100}` (their wrappers already named them), and the four voice
relays (three since #20 removed voiceRelayAudio), checked inside voiceHandlers after the peer check so a bad one is
dropped silently (contract key `joiInHandler`; `joi` stays null for them).
The shared-room relay check was already in place (#211:
`voiceHandlers.authorize`). `GameManager.removeBotFromLobby` also refuses a
human member's socket id (before, any lobby member could remove another by
the socket id the lobby list shows). Payloads checked against what web on
main and 1.1.0 (f05d264 LobbyEmitter / VoiceEmitter: `username: ""`,
`sdpMid: ""`) send; the iOS fixture logs carry no c2s lobby or voice
events. Tests: `v1Hardening.test.js`, `voiceSignaling.test.js`.

Joi schemas for `searchPlayers`, `getPlayerProfile`, `joinLobby`,
`removeBot` and the voice relays (`voiceOffer`, `voiceAnswer`,
`voiceIceCandidate`, `voiceRelayAudio`); a shared-room check for the voice
relays (today any socket can relay to any socket id). Note iOS
`LobbyEmitter.removeBot` sends no payload at all.

### 19. Inline avatar images (roadmap item 10; docs/avatars.md)

Precondition (on top of step 0): the App Store build that sends
`clientHello caps ['avatarUrl']` has shipped AND the `clientHello` log shows
no socket without the cap for 2+ weeks (old web bundles are gone after one
day of the 1-day bundle cache; the App Store build is the long tail). Step 0
above is now partly in place: `clientHello {client, version, build, caps}`
is logged per socket (server/socket/clientInfo.js).

- **A. Seat payloads without inline pictures.** positionUpdate.pics,
  gameStart.playerInfo[].pic, rejoinSuccess / restorePlayerState /
  spectatorJoined players[].pic, playerActiveMode.pic: `null` for a custom
  picture plus `avatarUrls` / `avatarUrl` for everyone; narrow `$defs.pic`
  to integer | null (baseline edit).
- **B. Profile rows without customProfilePic.** leaderboard / search rows
  and profile / playerProfile replies drop `customProfilePic` (or always
  null) in favour of `avatarUrls` / `avatarUrl`; `$defs.profile`,
  `leaderboardRow`, `playerSearchRow` baseline edits.
- **C. Snapshot v2 `seatV2.customPic`, the `customPics` request option and
  `partial: 'customPics'`** go; `avatarUrl` is the only custom picture.
- **D. Server code:** the legacy branches of `server/avatar/avatarWire.js`
  (`slot`, the per-kind playerInfo variants, the leaderboard `legacy`
  rows), `AVATAR_LEGACY_INLINE`, the placeholder inline image.
- **E. Delete `client/assets/profileN.png` and `frog.png`** (keep
  `avatars/v1`). Needs every App Store build older than the new one gone:
  the shipped app loads `/assets/profile<N>.png` directly.
- **F. The cap check becomes unconditional** (`hasCap` / `socketHasCap`
  always true for avatars); clientHello stays for version prompts and
  future caps.

### 20. `voiceRelayAudio` (the web PCM relay, both directions)

**Done 2026-11-12 (PR #TBD),** after the one-day window (TURN deploy
2026-11-11 10:46 PST). Removed: the c2s registration
(`server/socket/index.js`), `voiceHandlers.voiceRelayAudio`,
`isRelayChunk` and `MAX_RELAY_BYTES`, the `voiceRelayAudio` rate-limit key,
its #18 Joi schema (`validators.schemas.voiceRelayAudio`), both schema
entries (c2s + s2c; baseline hand-edited), the web constants
`CLIENT_EVENTS.VOICE_RELAY_AUDIO` / `SERVER_EVENTS.VOICE_RELAY_AUDIO`
(`legacyConstants.golden.json` updated; Swift never had one, so
`SocketEvents.swift` is unchanged) and the relay cases of
voiceSignaling.test.js. `wireGolden.test.js` `v1Projection` names #20 (a
no-op there: those games have no voice). A `voiceRelayAudio` packet now
reaches no handler: Socket.IO drops it, nothing is forwarded, no `error`.
Re-checked: no web code on main sends or listens to it; iOS 1.1.0 (f05d264)
and 1.2.0 never had it. Rollback caveat: a web tab still running a bundle
from before the TURN deploy loses only its PCM fallback (P2P/STUN as
before). Tests: `voiceSignaling.test.js` ("V1_REMOVALS #20"),
`client/src/voice/VoiceChatManager.test.js`.

The entry as planned:

Replaced by Cloudflare TURN (owner, 2026-11-11; `getVoiceIceServers` →
`voiceIceServers`, server/voice/turnCredentials.js). The current web bundle
neither sends nor listens to it; both schema entries are `deprecated`. The
server handler (`voiceHandlers.voiceRelayAudio`, authorized and rate limited
as in #211: same lobby or game, no block, binary chunks of at most 64 KB)
stays only for web bundles cached before that deploy: index.html is
`no-cache`, so only a tab left open across the deploy still runs one, and
it relays only to another such tab. iOS never had it.

Remove: the c2s registration in `server/socket/index.js`, `voiceRelayAudio`
and `isRelayChunk` / `MAX_RELAY_BYTES` in voiceHandlers.js, the
`voiceRelayAudio` rate-limit key, both schema entries (c2s + s2c; a
baseline edit, since cc865b4 had them), the web constants
`VOICE_RELAY_AUDIO` (legacyConstants pins them: update the golden) and the
relay cases of voiceSignaling.test.js. Precondition: one day after the TURN
deploy (no tab can still hold the old bundle in practice).

**Not run 2026-11-11** with the "safe now" steps: the TURN deploy (#213)
merged 2026-11-11 10:46 PST, so the one-day window ended 2026-11-12 10:46
PST. (1.1.0 never sent it; the blocker was the cached web bundle.) #18 gave
it a Joi schema meanwhile; removed with the handler (done, above).

## iOS TURN (iOS 1.2.0, live 2026-11-13; roadmap 29 track; not a removal)

**Done in iOS 1.2.0 (build 3, branch ios/release-1.2):** `Voice/IceServerStore.swift`
(`IcePolicy`, `IceServerStore`, `VoiceRecovery`) + `VoiceChatManager`: the
request goes out in parallel with the microphone prompt on every voice start
(`ice-<n>`, 4 s, else STUN), a TURN answer is reused per username and
refreshed 30 min before expiry (`setConfiguration`), a STUN answer is asked
again on every start and restart; one restart (lower socket id offers, the
other waits 15 s), a 20 s connect timeout, then "voice unavailable" in the
voice panel; credentials are never logged (the descriptions leave them out)
or persisted. Tests: `Release12Tests.swift` (IcePolicyTests,
IceServerStoreTests, VoiceRecoveryTests). The spec as written for it:

iOS 1.1.0 hard-codes Google STUN (`VoiceChatManager.iceConfig`,
`iOSClient/BABOnline/Voice/VoiceChatManager.swift`), so an iOS peer behind
a strict NAT still cannot connect, to web or iOS. The next iOS build needs:

1. Generated constants: move `getVoiceIceServers` / `voiceIceServers` from
   `layout.json` `exclude.swift` into the Swift layout's Voice Chat
   sections (append at the end), `npm run contract:gen`, xcodebuild.
2. Before the first `RTCPeerConnection` of a voice session (VoiceChatManager
   start, when the app `holdsSeat` or is in a lobby), emit
   `getVoiceIceServers {requestId: "ice-<n>"}` and wait for
   `voiceIceServers {iceServers, turn, expiresInSec, requestId}` with the same
   requestId, at most ~4 s; on timeout or a malformed reply use today's STUN
   list. `iceServers` is `[{urls: [String], username?: String, credential?:
   String}]` → `RTCIceServer(urlStrings:username:credential:)`; `turn` true
   means Cloudflare TURN; `expiresInSec` (null for STUN) says how long the
   credentials stay valid (about 4 h when fresh).
3. Reuse them for the session (per signed-in username); 30 min before
   `expiresInSec` runs out ask again and apply them with
   `peerConnection.setConfiguration` to open connections.
4. On `RTCIceConnectionState.failed`, or no connection within 20 s: one
   restart (web: the peer with the lower socket id offers again on a new
   connection, the other waits 15 s for that offer), then show the peer as
   voice unavailable.
5. Server side nothing changes: the request is answered for any signed-in
   socket in a lobby or game (STUN for everyone else); the wrapper limit is
   20 requests a minute per socket (`error {type:'rateLimit'}` over it).

The App Privacy answers do not change: TURN relays the encrypted SRTP
stream and nothing is stored.

## iOS spectator badge (iOS 1.2.0, live 2026-11-13; roadmap 29 track; not a removal)

**Done in iOS 1.2.0:** `ServerEvent.spectators` (decoded with seq nil, so it
goes around the gate; another game's list is dropped), `PlayersSlice.watching`
(from the event and every snapshot's `watching`; a new game and reset clear
it), `TableLayout+Spectators.swift` (`spectatorBadge(spectating:)`: beside
HSI / voice, a spectator's in the bottom-right corner; `spectatorBubbleCenter`),
`Views/Game/SpectatorBadgeView.swift` (eye.fill + count, "2 people watching",
the list with avatars and "(you)", "and N more"), and the bubble
(`TableAnimation.spectatorChatBubble`, `SKChatBubbleManager.showSpectator`:
"Name: text", one at a time, the seats' 5 s, routed on `isSpectator`).
Tests: `Release12Tests.swift` (SpectatorStateTests, ChatRoutingTests,
SpectatorBadgeLayoutTests, SpectatorBubbleSceneTests), the replay harnesses
(they no longer skip spectatorsUpdated; `TableProjection.watching`). One
difference from point 3: the generated `TableSnapshot.watching` is required,
so a snapshot without the key fails to decode (every server since 2026-11-11
sends it). The spec as written for it:

Web shows who is watching at the table since 2026-11-11 (an eye and the
count in the bottom-right corner, the names with avatars on tap; owner's
design). The server side is done and additive; iOS 1.1.0 ignores all of
it (GameSocketHandler.events is a fixed list; TableSnapshot is a
synthesized Decodable that skips unknown keys). The next iOS build needs:

1. Generated constants: move `spectatorsUpdated` from `layout.json`
   `exclude.swift` into the Swift layout's "Resignation & Lazy Mode"
   section (append at the end), `npm run contract:gen`, xcodebuild. The
   generated `TableSnapshot.swift` already decodes `watching`
   (`SpectatorList {spectators: [Spectator], count}`, `Spectator
   {username, pic: Int?, avatarUrl: String?}`).
2. Event: `spectatorsUpdated {gameId, spectators: [{username, pic,
   avatarUrl?}], count}` to the game room, the WHOLE list each time (join,
   leave, disconnect, spectating another game, a round start), coalesced
   to one per 250 ms. It is UNSEQUENCED (no `seq`, it never moves the
   gate): route it around the seq gate, e.g. a `.spectators` ServerEvent
   the reducer applies at once (drop it when `gameId` is another game's),
   and add it to GameSocketHandler.events; the replay harness and
   ServerEventDecodingTests then stop skipping it.
3. State: `TableState.players.watching` set from the event and from every
   snapshot's `watching` (a rejoin / spectate shows it at once); a snapshot
   without the key (an older server) keeps the current game's list; a new
   gameId clears it. Leave `spectatorCount` alone: it stays the spectator
   SOCKET count (cc865b4's meaning), the badge reads `watching.count`.
4. Pictures: `pic` is a stock number (1-82) or null; a custom picture comes
   only as `avatarUrl` (`/avatar/<name>?v=`), never inline: the app's
   AvatarStore loads it (the clientHello avatarUrl capability is not
   needed for this list). null with no URL: the default avatar.
5. Where: the table's bottom-right corner, outside the felt, at the voice
   buttons' height, never over the hand, my HSI / voice accessory (Q3),
   the trick, the histories or a bubble: SpriteKit `TableLayout` gains a
   `spectators` rect beside `accessory` (the badge sits right of or below
   it where the accessory row leaves room; for a spectator, whose layout
   has no hand, the corner itself), checked by TableLayoutTests like the
   other rects. SF Symbol `eye.fill` plus the count, hidden at 0; tap opens
   a small popover (names with avatars, "(you)" on mine, scrolls past ~8,
   "and N more" past 50); VoiceOver label "2 people watching".
6. Server side nothing changes.
7. The spectator chat bubble goes with the badge in this build: a `chatMessage` with `isSpectator` shows "Zach: hello" over the eye (web since 2026-11-11: `ChatBubble.showSpectatorChatBubble`, layout `spectators.bubble`).

## Deferred additive (not removals; held back on purpose)

- **`bidReceived` team1Mult / team2Mult.** The shipped iOS app reads them
  (GameSocketHandler.swift:119) but resets `team1Mult` / `team2Mult` only in
  `reset()` (GameState.swift ~177), never per hand, and ScoreBarView shows the
  bore badge whenever a multiplier is above 1. Sending them would keep the
  previous hand's "B" badge on screen through the next deal until its first
  bid: a new visible glitch. Ship only once the new iOS build resets them per
  hand, or on an explicit owner call. The multipliers already go out in
  `doneBidding.mults` (read by the iOS source since item 23; not by web) and
  in snapshot v2; the iOS source computes them from the bids per deal.
- **Re-sending `mainRoomPlayerJoined` on leave.** Would fix the stale online
  count on both current clients, but changes the event's meaning. Item 8 sends
  the new `mainRoomPlayerLeft` instead (current builds keep a stale count).
- **Normalizing `bidReceived.bid` to a string** (see #11): done 2026-11-11.
- **Draw-phase rejoin** (contract/README.md "Draw-phase rejoin"): stays
  refused; a future opt-in `rejoinGame {protocol: 2}` → entrant re-key →
  `stateSnapshot`, never replaying v1 draw events.
- **`seq` on private emits.** Not needed: Socket.IO keeps per-socket order and
  snapshots carry seq.
- **`serverError` dual emit** (#1 phase A): done 2026-11-11.

## Plan after the gate (2026-11-11): re-checked against 1.1.0 and web

Each entry's blockers re-checked against the 1.1.0 iOS source (f05d264;
`iOSClient/` is unchanged on main since) and the web client on main
(b11e830; web item 18b is in progress and may change web reads). One PR per
step, in this order; nothing is removed by the gate PR itself.

**Safe now (no shipped reader left once 1.0.0 is gated):**

1. **#15 `rejoinFailed.debug`** and **#16 lobby players' `personality`**:
   neither client reads them (1.1.0 only *sends* `addBot {personality}`).
   Pure leak fixes, smallest PR. **Done 2026-11-11 (PR #TBD).**
2. **#2 the matchmaking queue** (`queueUpdate`, c2s `joinQueue` /
   `leaveQueue` / `getLobbies`, `GameManager.queue`): no sender or listener
   in 1.1.0 or web. **Done 2026-11-11 (PR #TBD).**
3. **#4 s2c `joinMainRoom`**: no listener in 1.1.0 or web. **Done
   2026-11-11 (PR #TBD).**
4. **#12 `chatMessage.type`**: web reads `isSpectator`, 1.1.0 reads
   `isSpectator` first (`type` was only for 1.0.0). Drop `type`, keep
   `isSpectator`. **Done 2026-11-11 (PR #TBD).**
5. **#10 `cardPlayed.trump` → `trumpBroken`, drop `playerId`**: 1.1.0
   decodes `trumpBroken ?? trump` (WirePayloads.CardPlayed) and web
   `GameState.applyCardPlayed` reads either. `trumpBroken` is in the
   event's `reserved` list only for 1.0.0, so: lift the reservation and send
   `trumpBroken`, then drop `trump`. `playerId` is read by neither. **Done
   2026-11-11 (PR #TBD).**
6. **#11 `bidReceived.bid` always a string**: 1.1.0 still SENDS numeric
   bids as an Int (`GameEmitter.playerBid` → `String(bid)` →
   `LiveGameEmitter.playerBidPayload`, which turns a numeric string back into
   an Int; pinned by ActionCoordinatorTests) and DECODES either form
   (`BidWire` in WireDecoding.swift; web `applyBid` calls `String(data.bid)`).
   So normalize only the s2c echo to a string; c2s `playerBid.bid` must keep
   accepting an Int (the contract's `{ bid: 3 }` example), or every numeric
   bid from the App Store app is refused. Web already sends strings. **Done
   2026-11-11 (PR #TBD).**
7. **#13 `mainRoomJoined.recentMessages`**: 1.1.0 reads `recentMessages ??
   messages` (falls back) and web reads `messages`, so the main-room handler
   can drop it; the gate's 1.0.0-only copy keeps it (variant or `added`
   note), since 1.0.0 reads only `recentMessages` first. **Done 2026-11-11
   (PR #TBD).**
8. **#18 hardening Joi**: 1.1.0 now sends `removeBot {botSocketId}` (the
   "no payload" note is 1.0.0-only) and web sends the same; the Joi schemas
   for `removeBot`, `joinLobby`, `searchPlayers`, `getPlayerProfile` and the
   voice relays (plus the shared-room relay check) can land. **Done
   2026-11-11 (PR #TBD).**
9. **#17 `serverShutdown`**: kept (owner 2026-11-11): web and iOS 1.2 show
   it (web: restart banner, then what ended). Nothing to remove.
10. **#1 phase A only** (`serverError` dual emit with `{code, message,
    handler}`): additive, safe now. **Done 2026-11-11 (PR #TBD).**
11. **#20 `voiceRelayAudio`**: no reader in 1.1.0, 1.2.0 or web on main;
    it waited only for the one-day window after the TURN deploy. **Done
    2026-11-12 (PR #TBD).**

**Still blocked (by what a shipped client reads):**

- **#1 phase B** (drop app-level `error`): 1.1.0 listens only to
  `clientEvent: .error` (SocketService.swift; toast + table resync), not to
  `serverError`; web listens to `error`. Needs an iOS build (and web) that
  read `serverError`. (Web and iOS 1.2.0 read it since 2026-11-12: only
  1.1.0 is left. Done 2026-11-12 on top of the MIN_IOS_BUILD 3 gate, #1.)
- **#3 client-only listeners** (`lobbyJoined`, `roomFull`,
  `activeTournamentFound`, `activeGameFound`): nothing to remove server
  side (never emitted); 1.1.0 still registers them and web has its own.
  Drop schema entries / constants with the next client builds. (Web's are
  gone since 2026-11-12; activeGameFound kept. Done 2026-11-12: schema
  entries, constants and the iOS source's listeners, #3.)
- **#5 `gameStart.playerInfo`**: 1.1.0 reads it every deal
  (TableReducer.gameStart: names and pictures). (Web: not needed since
  2026-11-12: GameState.applyDeal / avatar.js foldAvatarPayload read it
  only when present; #5 audit.)
- **#6 `gameStart.players`**: web voice speaking indicator reads it.
  (Not since 2026-11-12: by owner / username, #6. Done 2026-11-12, #6.)
- **#7 `playerAssigned`**: 1.1.0 ignores it, web `main.js` reads it. (Not
  since 2026-11-12: no reader left. Done 2026-11-12, #7.)
- **#8 split `spectatorJoined`**: 1.1.0 routes on the `snapshot` key (fine);
  web routes on `players && trump`. Blocked by web. (Web routes on the
  snapshot too since 2026-11-12.)
- **#9 legacy client-state keys**: 1.1.0 reads `players[].socketId` (voice
  glows) and `players[].pic` (custom pictures) from rejoin / restore /
  spectator payloads.
- **#14 socket ids on the wire**: 1.1.0 reads `positionUpdate.sockets` and
  `players[].socketId` for voice.
- **#19 inline avatar images**: 1.1.0 never sends `clientHello` (no
  `avatarUrl` cap), so it renders only the inline pictures. Needs an iOS
  build that sends the cap, then the 2-week clientHello check for iOS.

Next client work that unblocks the most: an iOS build that listens to
`serverError`, sends `clientHello {caps:['avatarUrl']}` and maps voice
peers without socket ids (#1B, #19, #9, #14), and web reading v2 seats /
spectator snapshots (#5, #6, #7, #8; web done 2026-11-12).

## What iOS 1.2.0 unblocks (once 1.1.0 is gated)

iOS 1.2.0 (build 6, live in the App Store since 2026-11-13: build 5 + the new
app icon, so it reads what build 5 reads; build 3 was uploaded, never
submitted; build 4 was pulled from review and never ships) does that iOS
work. Owner decision: once 1.2.0 is approved and live, `MIN_IOS_BUILD` in
`server/socket/upgradeGate.js` goes to 3, which gates 1.1.0 the way 1.0.0
is gated (its own PR, the gate's v1 payloads re-checked against what 1.1.0
reads: Step 0). Until that PR merges, 1.1.0 keeps every blocker listed
above; after it, what 1.2.0 itself still reads is the remaining blocker:

- **#1 phase B (drop app-level `error`)**: 1.2.0 listens to `serverError
  {code, message, handler}` (SocketService; `error` and `serverError` twins
  are deduped, one toast and one table resync) and keeps the `error` path
  for today's server. iOS no longer blocks it, nor does web (2026-11-12:
  both channels, the twin dropped; #1). **Done 2026-11-12 (PR #TBD, after
  the gate PR).**
- **#19 inline avatar images**: 1.2.0 sends `clientHello {client:'ios',
  version, build, caps:['avatarUrl']}` on every connect (before
  restoreSession) and renders `avatarUrl` / `avatarUrls` (positionUpdate,
  gameStart, playerActiveMode, rejoin / restore / spectator carriers,
  snapshot seats, the spectator list) through `AvatarTextureCache`
  (`/avatar/...` paths, URLSession's cache), with the inline picture as the
  fallback when a URL fails. Step "the clientHello log shows no socket
  without the cap for 2+ weeks" can start counting once 1.1.0 is gated.
  1.2.0 does not show profile, leaderboard or search pictures, so #19 B
  never mattered to iOS.
- **#9 legacy client-state keys**: `players[].pic` is now only a fallback
  (the carrier's `avatarUrls` and the snapshot's `avatarUrl` come first) and
  `players[].socketId` is no longer needed for the speaking glows (below).
  iOS no longer blocks #9, nor does web (2026-11-12; #9).
- **#14 socket ids on the wire**: the speaking glows map a voice peer to its
  seat by the peer's username (voicePeerList / voiceOffer carry it;
  `TableRenderModel.seat(forVoicePeer:username:)`), the seat socket id only
  as a fallback. Still read by 1.2.0: `positionUpdate.sockets` tells a native
  bot (`bot:` prefix) from a human and finds my own seat (a username match is
  the fallback), and the voice signaling itself targets socket ids
  (`voiceOffer.targetSocketId`, `fromSocketId`), which #14 does not remove.
  Before dropping `positionUpdate.sockets`, add a seat kind to positionUpdate
  (e.g. `isBot[]`) and have a later iOS build read it.
- **#10 `cardPlayed.trump`**, **#12 `chatMessage.type`**, **#13
  `recentMessages`**: already safe for 1.1.0; 1.2.0 reads `trumpBroken ??
  trump`, routes chat on `isSpectator` (`type` only as the older server's
  fallback) and reads `recentMessages ?? messages`.
- **#3 client-only listeners**: 1.2.0 still registers `lobbyJoined`,
  `roomFull` and `activeTournamentFound` (and `activeGameFound`); they are
  harmless (never emitted) and can go in a later build. (Done 2026-11-12:
  the schema entries and constants are gone and the iOS source no longer
  registers the three; 1.2.0's listeners never fire. #3.)
- **#17 `serverShutdown`**: not handled by 1.2.0.
