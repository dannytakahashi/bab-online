# v1 removal list

The changes from roadmap item 8 that are NOT wire-additive. The owner
decided (2026-11) that the App Store iOS build stays as it is until the whole
iOS track is done, so for months the shipped iOS app and the current web
client must keep working exactly as today. Everything here waits until the
new iOS build has shipped and the old one is gone.

File:line references are as of cc865b4 + item 8 and will drift; the
function names will not.

## Step 0: know who is still on v1 (precondition, not in item 8)

Add an additive `clientHello {platform, appVersion, protocol}` c2s event (or a
`client` field on signIn / restoreSession - Joi must allow it, or
`stripUnknown` silently drops it) and log it server side. Execute removals
only after **zero `protocol < 2` iOS sessions for 2+ weeks**.

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
   both clients against a local server.

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
  `players && trump`), iOS GameSocketHandler.swift:377 (routes on
  `players != nil && trump != nil`).

### 9. Legacy client-state keys → snapshot-only rejoin / restore

The legacy `getClientState` (22 keys) and spectator-state keys: `bids`
changing shape mid-hand, sparse `playedCards`, `phase` / `bidding`,
`players[].socketId`, `resignedPositions` / `lazyPositions`, and the C10
aliases (`leadPosition`, `trumpBroken`, `teamTricks`, `oppTricks` on the
spectator state). Replacement: rejoinSuccess / restorePlayerState / the
spectator state carry only `{snapshot}` (and `tournamentId` while web needs
it). Prerequisite: items 16 and 23 render from v2.

### 10. `cardPlayed.trump` → `trumpBroken`; drop `playerId`

`trump` is a Bool meaning "trump is broken" (iOS GameSocketHandler.swift:531
reads `trumpBroken` first, then `trump`). Rename in the new builds; drop
`playerId` (a socket id).

### 11. `bidReceived.bid` always a string; `bidArray` → v2

iOS sends numeric bids as Int and the server echoes them (`$defs.bidWire`;
not an audit finding: ctr-22 is iOS feature work, out of scope). v2
`bids.byPosition` is already strings.

### 12. `chatMessage`: keep one of `isSpectator` / `type`

Web reads `isSpectator` (main.js:3217), iOS reads `type`
(ChatSocketHandler.swift). Item 8 sends both; keep one.

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

## Deferred additive (not removals; held back on purpose)

- **`bidReceived` team1Mult / team2Mult.** The shipped iOS app reads them
  (GameSocketHandler.swift:119) but resets `team1Mult` / `team2Mult` only in
  `reset()` (GameState.swift ~177), never per hand, and ScoreBarView shows the
  bore badge whenever a multiplier is above 1. Sending them would keep the
  previous hand's "B" badge on screen through the next deal until its first
  bid: a new visible glitch. Ship only once the new iOS build resets them per
  hand, or on an explicit owner call. The multipliers already go out in
  `doneBidding.mults` (read by neither client) and in snapshot v2.
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
