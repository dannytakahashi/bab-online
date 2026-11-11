# v1 removal list

The changes from roadmap item 8 that are NOT wire-additive. The owner
decided (2026-11) that the App Store iOS build stays as it is until the whole
iOS track is done, so for months the shipped iOS app and the current web
client must keep working exactly as today. Everything here waits until the
new iOS build has shipped and the old one is gone.

File:line references are as of cc865b4 + item 8 and will drift; the
function names will not.

## Step 0: the old app is gone from the wire (satisfied 2026-11-11)

Originally: log a client version and wait for **zero `protocol < 2` iOS
sessions for 2+ weeks**. Owner decision 2026-11-11 replaces that: iOS 1.1.0
(build 2) is the App Store build, and the old 1.0.0 build (cc9059f, build 1)
is answered only with an update message by `server/socket/upgradeGate.js`
(identified by its handshake User-Agent, `BAB%20Online/1 CFNetwork/...`). A
gated socket never signs in, never joins a room and never receives a game
payload, so no removal below can break it any more.

- **Kill switch caveat.** `UPGRADE_GATE=off` lets 1.0.0 play again. After
  the first removal below merges, that is no longer a full rollback: the
  old app would meet the new wire. Treat the gate as permanent from then on.
- **The gate's own payloads.** The gate sends `signInResponse`,
  `signUpResponse`, `mainRoomJoined` (with `recentMessages`, the key 1.0.0
  reads), `leftGame`, `leftLobby` and `tournamentLeft` in their v1 shapes. A
  removal that touches one of those shapes must keep the gate's copy valid
  (it is a 1.0.0-only emitter), e.g. #13 below.
- **Its one database touch.** A gated restoreSession refreshes that
  session's `lastUsedAt` (nothing else), so the 90-day session TTL does not
  run out while a player keeps opening 1.0.0 before updating.
- **Telemetry.** Every iOS socket logs `iOS app connected {build}` and every
  gated connection `Upgrade gate: outdated iOS app {build, username}`. 1.1.0
  sends no `clientHello`, so clientHello caps still say nothing about iOS.

## How to execute one removal

One PR per entry:

1. Make the server change.
2. Hand-edit `contract/v1-baseline.schema.json` (the frozen baseline) to drop
   what is removed, and update `contract/src`; run `npm run contract:gen`.
3. Update `additiveOnly.test.js` expectations if needed,
   `legacyConstants.golden.json` (constants), `transcripts.test.js` and
   `wireProjection.test.js` (legacy key sets), `wireCompat.test.js` goldens.
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
  a shared code enum in the contract.
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

### 2. The matchmaking queue

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
- **CAUTION `activeGameFound`**: it is the only event that makes the shipped
  iOS app emit `rejoinGame` by itself (`AuthSocketHandler.swift:41`,
  handleActiveGameFound). Keep it as a possible server hook (e.g. to nudge old
  apps back into their game) until the old app is gone.

### 4. s2c `joinMainRoom`

- Emit sites: `seatLifecycle.leaveSeat` (watch view), `chatHandlers.spectatorCommand` (/leave).
- Consumers: none in either client. Drop it.

### 5. `gameStart.playerInfo` - NOT dead (roadmap correction)

The roadmap said "drop gameStart.playerInfo". It is read: web
`client/src/main.js:2495` rebuilds the avatars (positions, usernames, pics)
from it every hand. Prerequisite: item 16 renders seats from snapshot v2
(`seats[]`) and item 10 turns pictures into references. Only then drop it.

### 6. `gameStart.players` (seat socket ids)

Leaks socket ids, but it is READ: web `main.js` gameStart handler stores it
(`gameState.setPlayerData({ sockets: data.players })` → `playerData.socket`)
and `startVoice` / `onSpeakingChange` maps a voice peer's socket id to a seat
with `pd.socket.indexOf(id)` to highlight the speaking player. iOS does not
read it. Prerequisite: a v2 seat ↔ voice-peer mapping (e.g. voice peers
carry a position, or a voice-only id per seat) used by web; only then drop
it. Until then dropping it silently breaks the web speaking indicator.

### 7. `playerAssigned`

- Emit: `gameHandlers.handleDrawComplete` (to each connected human).
- Consumer: web `client/src/main.js:1495` (playerId, position).
- Replacement: v2 `viewer.position`.

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

### 10. `cardPlayed.trump` → `trumpBroken`; drop `playerId`

`trump` is a Bool meaning "trump is broken" (iOS GameSocketHandler.swift:531
reads `trumpBroken` first, then `trump`). Rename in the new builds; drop
`playerId` (a socket id).

### 11. `bidReceived.bid` always a string; `bidArray` → v2

iOS sends numeric bids as Int and the server echoes them (`$defs.bidWire`;
not an audit finding: ctr-22 is iOS feature work, out of scope). v2
`bids.byPosition` is already strings.

### 12. `chatMessage`: keep one of `isSpectator` / `type`

Web reads `isSpectator` (main.js:3217); the App Store iOS build reads `type`
(ChatSocketHandler.swift at cc9059f) and the new iOS build reads
`isSpectator ?? (type == 'spectator')` (TableReducer+Events.swift). Item 8
sends both; once the App Store build is gone either can go.

### 13. `mainRoomJoined.recentMessages`

Duplicates `messages`; iOS reads `recentMessages` first with `messages` as the
fallback (LobbySocketHandler.swift:33). Drop once the old app is gone.

### 14. Socket ids on the wire

`positionUpdate.sockets` / `usernames[].socketId`, `playerDrew.socketId`,
lobby `players[].socketId` where replaceable (removeBot needs the bot's id
today), `players[].socketId` in the legacy states.

### 15. `rejoinFailed.debug.playersInGame`

Leaks usernames to whoever asks. Safe for both clients now (neither reads
`debug`), so this one may move earlier if the owner agrees.

### 16. Lobby players' `personality`

Leaks a bot's real personality name before the game starts (the lobby shows
"🤖 Bot"). Drop from lobby payloads.

### 17. `serverShutdown`

No listener in either client today (constants added in item 8). Handle it in
the new builds (show "server restarting") or drop it.

### 18. Hardening that could reject inputs

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
- **Normalizing `bidReceived.bid` to a string** (see #11).
- **Draw-phase rejoin** (contract/README.md "Draw-phase rejoin"): stays
  refused; a future opt-in `rejoinGame {protocol: 2}` → entrant re-key →
  `stateSnapshot`, never replaying v1 draw events.
- **`seq` on private emits.** Not needed: Socket.IO keeps per-socket order and
  snapshots carry seq.
- **`serverError` dual emit** (#1 phase A).

## Plan after the gate (2026-11-11): re-checked against 1.1.0 and web

Each entry's blockers re-checked against the 1.1.0 iOS source (f05d264;
`iOSClient/` is unchanged on main since) and the web client on main
(b11e830; web item 18b is in progress and may change web reads). One PR per
step, in this order; nothing is removed by the gate PR itself.

**Safe now (no shipped reader left once 1.0.0 is gated):**

1. **#15 `rejoinFailed.debug`** and **#16 lobby players' `personality`**:
   neither client reads them (1.1.0 only *sends* `addBot {personality}`).
   Pure leak fixes, smallest PR.
2. **#2 the matchmaking queue** (`queueUpdate`, c2s `joinQueue` /
   `leaveQueue` / `getLobbies`, `GameManager.queue`): no sender or listener
   in 1.1.0 or web.
3. **#4 s2c `joinMainRoom`**: no listener in 1.1.0 or web.
4. **#12 `chatMessage.type`**: web reads `isSpectator`, 1.1.0 reads
   `isSpectator` first (`type` was only for 1.0.0). Drop `type`, keep
   `isSpectator`.
5. **#10 `cardPlayed.trump` → `trumpBroken`, drop `playerId`**: 1.1.0
   decodes `trumpBroken ?? trump` (WirePayloads.CardPlayed) and web
   `GameState.applyCardPlayed` reads either. `trumpBroken` is in the
   event's `reserved` list only for 1.0.0, so: lift the reservation and send
   `trumpBroken`, then drop `trump`. `playerId` is read by neither.
6. **#11 `bidReceived.bid` always a string**: 1.1.0 still SENDS numeric
   bids as an Int (`GameEmitter.playerBid` → `String(bid)` →
   `LiveGameEmitter.playerBidPayload`, which turns a numeric string back into
   an Int; pinned by ActionCoordinatorTests) and DECODES either form
   (`BidWire` in WireDecoding.swift; web `applyBid` calls `String(data.bid)`).
   So normalize only the s2c echo to a string; c2s `playerBid.bid` must keep
   accepting an Int (the contract's `{ bid: 3 }` example), or every numeric
   bid from the App Store app is refused. Web already sends strings.
7. **#13 `mainRoomJoined.recentMessages`**: 1.1.0 reads `recentMessages ??
   messages` (falls back) and web reads `messages`, so the main-room handler
   can drop it; the gate's 1.0.0-only copy keeps it (variant or `added`
   note), since 1.0.0 reads only `recentMessages` first.
8. **#18 hardening Joi**: 1.1.0 now sends `removeBot {botSocketId}` (the
   "no payload" note is 1.0.0-only) and web sends the same; the Joi schemas
   for `removeBot`, `joinLobby`, `searchPlayers`, `getPlayerProfile` and the
   voice relays (plus the shared-room relay check) can land.
9. **#17 `serverShutdown`**: no listener anywhere; either drop it or add the
   "server restarting" handling in a later client build. Owner call.
10. **#1 phase A only** (`serverError` dual emit with `{code, message,
    handler}`): additive, safe now.

**Still blocked (by what a shipped client reads):**

- **#1 phase B** (drop app-level `error`): 1.1.0 listens only to
  `clientEvent: .error` (SocketService.swift; toast + table resync), not to
  `serverError`; web listens to `error`. Needs an iOS build (and web) that
  read `serverError`.
- **#3 client-only listeners** (`lobbyJoined`, `roomFull`,
  `activeTournamentFound`, `activeGameFound`): nothing to remove server
  side (never emitted); 1.1.0 still registers them and web has its own.
  Drop schema entries / constants with the next client builds.
- **#5 `gameStart.playerInfo`**: 1.1.0 reads it every deal
  (TableReducer.gameStart: names and pictures); web `main.js` too.
- **#6 `gameStart.players`**: web voice speaking indicator reads it.
- **#7 `playerAssigned`**: 1.1.0 ignores it, web `main.js` reads it.
- **#8 split `spectatorJoined`**: 1.1.0 routes on the `snapshot` key (fine);
  web routes on `players && trump`. Blocked by web.
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
spectator snapshots (#5, #6, #7, #8).
