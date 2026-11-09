# BAB Online - Claude Context Document

This document helps Claude understand the project quickly in new sessions.

## What is this?

BAB Online is a 4-player online multiplayer trick-taking card game ("Back Alley Bridge"). Players form 2 teams (positions 1&3 vs 2&4) and compete across 13 hands with varying card counts.

**See `docs/RULES.md` for complete game rules.**

## Tech Stack

- **Frontend (web)**: Phaser 3 (game engine), ES6 modules, Socket.IO client, Vite bundler
- **iOS**: Native SwiftUI app in `iOSClient/` (SpriteKit game scene, Socket.IO-Client-Swift, WebRTC voice) — NOT a webview; it mirrors the web client's socket contract
- **Backend**: Node.js 18+, Express.js, Socket.IO server
- **Database**: MongoDB (native client, no ORM) — collections: `users`, `gameRecords`, `reports`
- **Testing**: Jest (server), Vitest (client)
- **Deployment**: Railway via its GitHub integration on push to main (GitHub Actions runs tests/build only)

## Directory Structure

```
bab-online/
├── client/                     # Frontend
│   ├── src/
│   │   ├── constants/         # Event names, card ranks, hand progression
│   │   ├── utils/             # Position math, card helpers
│   │   ├── rules/             # Card legality (mirrors server)
│   │   ├── state/             # GameState singleton
│   │   ├── socket/            # SocketManager (connection + listener cleanup)
│   │   ├── handlers/          # Socket event handlers by domain
│   │   ├── phaser/            # Game rendering
│   │   │   ├── scenes/        # GameScene (main Phaser scene)
│   │   │   └── managers/      # CardManager, TrickManager, BidManager, etc.
│   │   └── ui/                # DOM-based UI (screens, components)
│   └── assets/                # Card images, sprites
│
├── server/                     # Backend
│   ├── game/                  # Core game logic
│   │   ├── rules.js           # Pure functions: card comparison, legality, scoring
│   │   ├── Deck.js            # Card deck with Fisher-Yates shuffle
│   │   ├── GameState.js       # Game state encapsulation
│   │   ├── SeatState.js       # Seat controller/presence edge table + invariants
│   │   ├── GameManager.js     # Singleton: manages games, queue, lobbies, tournaments
│   │   ├── pacing.js          # EVERY presentation delay + bot think range (profiles, shipped-iOS floors)
│   │   ├── TournamentState.js # Per-tournament state (4 rounds, scoreboard)
│   │   └── bot/               # AI player system (strategy, personalities, sim/ harness)
│   ├── socket/                # Socket.IO handlers by domain
│   │   ├── gameHandlers.js    # Core gameplay (draw, bid, play)
│   │   ├── seatLifecycle.js   # Seat changes: disconnect, rejoin, lazy/active, resign, leave, abort
│   │   ├── lobbyHandlers.js   # Pre-game lobby
│   │   ├── tournamentHandlers.js # Tournament lifecycle
│   │   ├── authHandlers.js    # Sign-in/up, account deletion
│   │   ├── safetyHandlers.js  # Report / block / unblock users
│   │   └── validators.js      # Joi validation schemas
│   ├── admin/                 # Account admin logic used by scripts/ (merge, set password)
│   ├── avatar/                # Custom-picture renditions (sharp), wire mapping (docs/avatars.md)
│   ├── testUtils/memoryDb.js  # In-memory Mongo collection fake for Jest (no mongod needed)
│   ├── utils/
│   │   ├── profanityFilter.js # UGC filter (chat, usernames, lobby names)
│   │   ├── sessionTokens.js   # Per-device "stay signed in" tokens
│   │   ├── passwordHash.js    # bcryptjs in a worker_threads pool
│   │   ├── clientIp.js        # Client IP behind Railway's edge (sign-in throttle)
│   │   └── ttlCache.js        # Leaderboard/records caches
│   └── __tests__/             # Jest tests
│
├── scripts/                    # Owner-run CLIs: merge-accounts.js, set-password.js, avatar-report.js (read-only); build-atlas.js, build-avatars.js
│
├── contract/                   # Socket contract: schema source, generator, v1 baseline, v2 fixtures (dev/test only)
│
├── iOSClient/                  # Native SwiftUI iOS app
│   ├── BABOnline.xcodeproj    # THE project config (hand-maintained; no XcodeGen)
│   └── BABOnline/             # Synchronized folder = app target: Views, State, Networking (handlers/emitters), SpriteKit
│
└── docs/
    └── RULES.md               # Complete game rules
```

## Key Architecture Patterns

**Server:**
- `GameManager` singleton manages all active games and queue
- `GameState` encapsulates all state for a single game
- `rules.js` contains pure, stateless game logic functions (highly testable)
- Socket handlers wrapped with validation, rate limiting, error handling

**Client:**
- `GameState` singleton replaces global variables
- `SocketManager` tracks listeners for cleanup (prevents memory leaks)
- Manager pattern: specialized managers (CardManager, TrickManager, etc.)
- Client-side validation mirrors server for immediate UI feedback

## Key Data Structures

**Card:**
```javascript
{ suit: 'spades'|'hearts'|'diamonds'|'clubs'|'joker', rank: '2'-'A'|'HI'|'LO' }
```

**Server GameState:**
- `seats`: {1..4 → seat record} (`server/game/SeatState.js`): who controls the seat and whether its owner is present (see Important Implementation Details)
- `players`: Map<seat socketId → {username, position, pic}> and `positions`: {pos → seat socketId} — a derived index of `seats` (display identity: the owner for a human seat, else the bot), written only by the seat transitions
- `entrants`: Map<socketId → {username, isBot, presence connected|disconnected|left}> before seating (set by `createGame`, null once 4 seats exist)
- `hands`: {socketId → card[]}, `bids`: {position → bid_value} during bidding, then {team1, team2}
- `stage` (internal, authoritative): `CREATED → DRAWING → DRAW_RESOLVING → TEAMS_ANNOUNCED → (DEALING → BIDDING [→ REDEAL → DEALING → BIDDING] → PLAYING ⇄ TRICK_RESOLVING → HAND_RESOLVING) ×13 → ENDED`, any live stage `→ ABORTED` (`server/game/GamePhase.js`). `epoch` bumps once on ENDED/ABORTED
- `phase` / `bidding`: read-only wire projections of `stage` — `phase` is 'waiting'|'drawing'|'bidding' (never 'playing'; it stays 'bidding' through play), `bidding` is false only from the end of bidding to the next deal
- `trump`: card, `isTrumpBroken`: boolean
- `playedCards`: [pos1Card, pos2Card, pos3Card, pos4Card]
- `tricks`: {team1: count, team2: count}

**Bid Values:** '0'-'12' for numbers, 'B'/'2B'/'3B'/'4B' for bores (2x/4x/8x/16x multipliers)

## Game Flow (Socket Events)

1. **Auth**: `signIn`/`signUp` → `signInResponse` (includes `blockedUsers`; `deleteAccount` → `deleteAccountResponse` for in-app account deletion); `restoreSession` resumes a saved per-device token without a password
2. **Lobby**: `joinQueue` → `lobbyCreated` → `playerReadyUpdate` → `allPlayersReady`
3. **Draw**: `startDraw` → `draw` → `playerDrew` → `teamsAnnounced`
4. **Bidding**: `gameStart` → `updateTurn` → `playerBid` → `bidReceived` → `doneBidding` (if both teams bid 0 there is no `doneBidding`: the server sends a log entry, `destroyHands` and a fresh `gameStart` for the redeal)
5. **Play**: `updateTurn` → `playCard` → `cardPlayed` → `trickComplete` → `handComplete`
6. **End**: `gameEnd` (payload always includes `tournamentId`, null for casual games)
7. **Resync (snapshot v2)**: `requestSnapshot {requestId?, customPics?, log?}` → `stateSnapshot {snapshot, requestId?}` or `{snapshot: null, reason: 'not_in_game'}` (any seat owner, entrant or spectator; custom pictures only with `customPics: true`; `snapshot.partial` lists what was left out and the client keeps it — `mergeSnapshot`; `seq` on room broadcasts tells a v2 client when it missed something)

**Tournaments**: `createTournament`/`joinTournament` → `tournamentJoined` → ready-up → `beginTournament` → 4 rounds of games (`tournamentGameAssignment`, results via `tournamentGameComplete`/`tournamentRoundComplete`) → `beginNextRound` between rounds → `tournamentComplete` (with `winners[]`). The creator may cancel in any phase (`cancelTournament` → `abortGame` at every running table, then `tournamentCancelled`). Disconnected players are marked `connected: false` and reattach by username (any phase); completed tournaments linger ~10 min so players can view results.

**Safety**: `reportUser` → `reportUserResponse` (stored in `reports` collection); `blockUser`/`unblockUser` → `blockListUpdated`. Chat is profanity-filtered server-side; clients hide blocked users' messages.

## Quick Game Rules Reference

- 54 cards (52 + HI/LO jokers), jokers are always trump
- Hand sizes: 12→10→8→6→4→2→1→3→5→7→9→11→13
- Must follow suit; trump can't lead until broken (unless hand is all trump)
- HI joker forces opponents to play highest trump, partner plays lowest
- Scoring: Made bid = (bid × 10 × multiplier) + overtricks; Set = -(bid × 10 × multiplier)
- Rainbow bonus: +10 on 4-card hand if hand has all 4 suits

## Commands

```bash
npm run dev          # Start server + client (hot reload)
npm start            # Server only (port 3000)
npm run dev:client   # Client Vite dev server (port 5173)
npm run build:client # Production build
npm run build:avatars # Re-encode stock avatar art from the fcdd885 masters (scripts/build-avatars.js)

npm test             # Server tests (Jest)
npm run test:client  # Client tests (Vitest)
npm run sim          # Bot-vs-bot simulation (tuning/regression; see server/game/bot/sim/README.md)

npm run contract:gen        # regenerate events.schema.json + web/Swift constants from contract/src
npm run contract:check      # fail if a generated file is stale
npm run contract:fixtures   # rewrite contract/fixtures/v2 from real games
npm run test:contract       # 1500 chaos seeds + tournamentLifecycle + contract.test (also run with NODE_ENV=production)
npm run test:race           # BAB_PACING=zero: chaos (200) + tournamentLifecycle + harness A + budget with every delay 0 (CI)
# iOS compile check after touching SocketEvents.swift:
# xcodebuild -project iOSClient/BABOnline.xcodeproj -scheme BABOnline -destination 'id=<simulator>' -derivedDataPath <tmp>/dd CODE_SIGNING_ALLOWED=NO build
```

## Important Implementation Details

- Game phase FSM (`server/game/GamePhase.js`, `GameState`): the stage changes only through `game.transition(from, to)` (every call site reads `if (!game.transition(F, T)) return;` — an illegal call throws under Jest / `BAB_FSM_STRICT=1`, logs and fails closed in production), `tryTransition` (the DRAWING → DRAW_RESOLVING latch, so the draw resolves exactly once) and `terminate(io, ENDED|ABORTED, event, payload)` (final event out first, then epoch bump + cancel all game timers). Never write `game.phase`/`game.bidding` (getters; a write is a reported violation) and never gate on flags — gate on `game.stage` (`acceptsTurnInput()`, `actionTypeForTurn()`, `isPreSeating()`). Lifecycle waits use `if (!(await game.pause(ms))) return;` (presentation holds: `game.hold(kind, ms)`, see Pacing) and timers use `game.setTimer(key, ms, fn)` (`grace:<pos>` per-seat reconnect grace, `abandon`, `draw:watchdog`, `resume` (trick/hand hold); `afk:<pos>` is reserved for a future turn watchdog and cleared on every controller change; bot bid/play/draw/chat stay in `BotController.pendingActions`), so nothing runs or emits after end/abort; BotController timers check `game.epoch`, and `broadcast`/`sendToPlayer` drop everything from a terminal game. `recordDraw` is the only writer of draw state. Abort only through `socket/gameLifecycle.abortGame(io, game, reason)` (abortGame to the room incl. spectators → ABORTED → `GameManager._retire`: bots, room, every `playerGames` entry for the game → lobbiesUpdated → DB/tournament follow-up); the draw starts only through `gameLifecycle.beginDraw` (also auto-draws for sockets that left/disconnected during the pre-draw countdown). The end path sends `gameEnd` before persisting stats. Jest's `server/testUtils/fsmGuard.js` fails any test that records a violation; `BAB_FSM_CHECK=1` runs `validateGameState()` (per-stage + seat invariants) on every stage and seat transition and records `_history` (`server/socket/__tests__/chaos.test.js`, `lifecycle.test.js`, `wireProjection.test.js`)
- Pacing (`server/game/pacing.js`, the only home of presentation delays; read `pacing(game).X` at call time, never destructure): profiles `standard` (default), `legacy` (pre-retune values, rollback knob), `fast` (dev only, ignored in production), `zero` (tests only) via `BAB_PACING`; bot ranges are `[min, span]` with ONE `Math.random()` per action (`BotPlayer.getActionDelay(type, {kind})`; `BotController.actionKind` picks firstBid/bid, afterBidding/afterTrick/forced/follow at schedule time from public state only — forced = the hand's last card, never "one legal card", which would leak a void; leads never use the forced range). `SHIPPED_IOS_FLOORS` is what the App Store build (cc9059f, 1.0.0 build 1) needs — it ignores resumeInMs and has no actionRejected handling (a refused play loses the card), so the server's gaps are its only protection; `pacing.test.js` holds every non-zero profile to it. Retune: edit the profile, run `BAB_PACING_REPORT=1 npx jest server/socket/__tests__/pacingBudget.test.js` (1 human acting instantly + 3 bots over 12 seeds: legacy 594.6 s, standard 320.9 s; sensitivities in the pacing.js header; TRICK_VIEW_MS is the cheapest knob, 1000 gives about -48%; `legacy` also skips the ambient pre-game overlay) and repin its component table. Holds: `game.hold(kind, ms)` for linear chains (countdown, drawReveal, seating, teams, firstTurn) and `game.scheduleResume(kind, ms, fn)` on the `resume` timer for TRICK_RESOLVING/HAND_RESOLVING: the 4th card returns at once, `resumeTrick` counts the trick at resume (so a rejoin inside the hold sees today's pre-resolution table) and sends trickComplete + updateTurn in the same tick, or holds HAND_RESOLVING until handComplete; `game.resume` = `{kind, at}` while a hold is open (`resumeInfo(now)` → snapshot v2 `resume {kind, inMs}`). Wire: relative `resumeInMs` on the trick-completing cardPlayed, a hand's last trickComplete and teamsAnnounced (contract/README.md "Resume holds"). Early actions inside a hold are rejected (`not_your_turn`), never queued: no compliant client can send one (no updateTurn goes out after the 4th card; the trick winner's updateTurn shares the trickComplete tick and its play is accepted). Web sizes its fly-in/collect/teams fade to resumeInMs and keeps the hand dimmed until the collect lands (`TrickManager.isCollecting/onCollected`; iOS source builds: `SKTrickManager.isCollecting`). Event order is unchanged. Rate limits: playCard 90/min, playerBid 30/min (an over-limit play gets `error`, which loses the card on the shipped app)
- Bots have socketIds like `bot:{username}:{uuid}`, use `BotStrategy.js` for AI. Card play is contract-aware: `processBotPlay` passes a play context (team bids/tricks/bores) into `decideCard`. Personalities (`personalities.js`) define `bidStyle` + `playStyle` consumed by the strategy; Mary is the sim-tuned optimal baseline, the others are slight measured variations. Strategy changes must be benchmarked with `npm run sim` against the frozen legacy snapshot (`sim/legacyStrategy.js`)
- Sessions are per device (`server/utils/sessionTokens.js`): each sign-in adds a token to `users.sessionTokens` (SHA-256 hashes only, max 5, expire 90 days after last use) instead of replacing the old one, so signing in on the computer doesn't log the phone out. A legacy plaintext `users.sessionToken` is still accepted and migrated. Only one *live* socket per user: a password sign-in, or a different device restoring its token, kicks the previous socket (`forceLogout`); the same device reconnecting (same token hash in `socket.data.sessionHash`) does not. `rejoinGame` from an unauthenticated socket (web reload mid-game) is authorized by the same `verifySession` check on the token it sends. Rejoining a tournament game also reattaches tournament membership to the new socket
- Web "stay signed in" (`client/src/utils/sessionPersistence.js`): the tab's session is in `sessionStorage` (so 4-tab local testing still works) and the latest sign-in is mirrored to `localStorage`, which a fresh tab adopts on load. Profile page has a Sign Out button (shared family computers). iOS keeps its token in the Keychain
- Merged accounts: `scripts/merge-accounts.js` turns duplicate accounts into tombstones `{ username, mergedInto, mergedAt }` (no password/tokens/stats). Sign-in/sign-up/restore on a tombstone tell the player which account to use; leaderboard and player search exclude them; `getPlayerProfile` follows `mergedInto`; deleting the kept account deletes its tombstones. The kept account's `mergedFrom[]` is the audit log and the idempotency guard. Any new per-user data keyed by username must be added to `server/admin/accountMerge.js` (in-memory server state keyed by username — the profile caches, the sign-in throttle — cannot see a CLI merge; the caches' 60 s TTL and the throttle's 15 min window bound it)
- Socket rooms: players join `game:{gameId}` for broadcasts; tournaments use `tournament:{tournamentId}`
- Socket contract (`contract/`, dev/test only — production code never requires it; see `contract/README.md`): `contract/src` describes every event in both directions (payload JSON Schema, status, emittedFrom, clientReads, reserved keys); `npm run contract:gen` writes `contract/events.schema.json`, `client/src/constants/events.js` and `iOSClient/.../Constants/SocketEvents.swift` (from `contract/layout.json`; never hand-edit them; `generated.test.js` fails when stale). Every emit recorded through `gameDriver.makeIo`/`makeSocket` is validated by the always-on contract guard (`server/testUtils/contractCheck.js` + `contractGuard.js`; escape hatches `contractGuard.skip(reason)` / `BAB_CONTRACT=0`). **The wire is additive-only until the new iOS build ships** (the App Store build stays as is): never rename/remove an event or change a field's type/meaning/order — `additiveOnly.test.js` holds the schema to the frozen `contract/v1-baseline.schema.json`, `legacyConstants.test.js` pins every cc865b4 constant, `wireCompat.test.js` pins the values of the touched builders. The non-additive changes wait in `contract/V1_REMOVALS.md`
- Snapshot v2 (`server/game/snapshotV2.js`, `game.getSnapshotV2(sid)`; `$defs.snapshotV2`): one normalized, versioned table view for the receiving socket (stage, viewer role, hand, bids, trick in play order, seats from the seat records, draw/entrants, tournament; no socket ids). Sent as an extra `snapshot` field on rejoinSuccess / restorePlayerState / actionRejected / the spectator full state and as the reply to `requestSnapshot`. Fixtures in `contract/fixtures/v2` (`npm run contract:fixtures`), web parser `client/src/state/snapshotV2.js` (not wired into rendering yet)
- `seq`: `game.eventSeq` +1 per room broadcast (`GameState.broadcast` stamps `{...data, seq}`) and +1 per deal (every gameStart of a deal carries the same value); private emits carry none. Consumer rules R1–R5 in `contract/README.md`; `server/testUtils/seqCheck.js` checks them per receiver in chaos and contract tests
- iOS table (`docs/ios-table-store.md`): `GameState` is a `@MainActor` store over the pure `State/Table/TableReducer` (GamePhase with associated data, derived MyTurnState, seq gate R1-R5, snapshot-only restore); `GameSKScene.apply(model:animations:)` renders `TableRenderModel` idempotently; `ActionCoordinator` sends plays/bids with a 5 s ack timeout (network liveness, not pacing). Fixtures: `npm run ios:fixtures` (simulate.js `--record-ios <dir>` runs the scripted real-handler games of `server/testUtils/iosScenarios.js` under Jest; it simulates nothing); `iosEventLogs.test.js` fails in `npm test` when server event shapes, game-log text, bot decisions (BotStrategy) or RNG use change, until they are re-recorded — then re-run `xcodebuild test`, since only the iOS replay tests say whether the client still matches the new logs
- Card legality logic duplicated in `server/game/rules.js`, `client/src/rules/legality.js`, and `iOSClient/.../Rules/CardLegality.swift`
- Seats (`server/game/SeatState.js`, `GameState.seats`, orchestration in `server/socket/seatLifecycle.js`): one record per position — `controller` human | lazyBot | resignBot | bot (native lobby/tournament/ambient bot, no owner) and `presence` connected | grace | resignable (human seat) / connected | away | gone (lazy/resigned seat) / none (native bot), plus `ownerUsername`/`ownerPic`, `ownerSocketId` (the owner's ONE live socket, set exactly when connected), `ownerView` ('seat' after /lazy at the seat, 'watch' after a rejoin/spectate), `seatSocketId`, `bot`, `lastPersonality` and timestamps. A bot-controlled seat's seat socket (positions/players/hands key) is the bot's `bot:` socket; the owner socket is separate, so lazy play goes through `BotController.scheduleBotAction` like any bot and the owner's socket can't bid/play over it. Seats change only through the GameState transitions (`createSeat`, `seatDisconnect` — a no-op unless the socket is the current owner socket — `seatGraceExpired`, `seatReconnect`, `seatWatch`, `seatGoLazy`, `seatGoActive`, `seatResign`, `seatLeave`; `forceSeat` is test-only), each checked against the SeatState edge table (illegal → 'seat-illegal' violation); `gone` is absorbing. `seatLifecycle` functions do transition → playerGames/room → emits → `maybeAbort`; handlers only dispatch. `pickBotPersonality` never reuses a name/personality already at the table (lazy, resign and draw-leaver bots)
- `playerGames` maps exactly: connected entrants (before seating), every seat's `ownerSocketId`, and every bot-controlled seat's bot socket — never a dead or stale socket. Pure spectators live only in `gameManager.spectatorGames` (one game per socket; `addSpectator` / `leaveSpectating`, also on `joinMainRoom` and `returnToTournament`) and `game.spectators`; a socket mapped to a game is never a pure spectator. `chatMessage` resolves the sender's role (owner / entrant / spectator) first, so a spectator or stale socket can never /active, /lazy or /leave a seat — with one exception: a pure spectator recorded under the owner's name may `/active` a bot-controlled seat whose presence is `away` (no owner socket attached; `seatLifecycle.reclaimSeat`, e.g. the phone after the laptop that took the seat closed). The newest socket owns a seat: a rejoin while an older socket is attached moves the seat and unmaps the old one (a watched seat demotes it to a pure spectator). `rejoinGame` refuses a socket that dropped during its session lookup or is mapped to another game. A socket leaves spectating before it becomes a seat owner (the seat transition's invariants hold throughout). `game.offerPos` is the offer present clients hold, including one `replayPresenceTo` handed a returner, so `reofferAfter` moves it when that seat comes back
- In-game leave is a chat command (`/leave`, `/lazy`, `/active`) routed through `chatMessage` — both clients' Leave buttons send `/leave`. At a human seat `/leave` = `/lazy` + leave: the bot keeps the seat (lazyBot/gone) and rejoining a gone seat gives `rejoinFailed`; from a lazy/resigned owner's socket (either view) it is the same permanent leave. Before seats exist (countdown, draw) it marks the entrant left: `handleDrawComplete` seats a bot for it (resignBot/gone) and a draw-phase disconnect is seated in its 60s reconnect grace (announced with `playerDisconnected` after `positionUpdate`)
- Disconnect / grace / abort: a human seat's owner dropping starts its own `grace:<pos>` (60s); on expiry the seat is resignable and, if any owner is connected, the room gets `resignationAvailable` (`offerPos`). `forceResign` needs a resignable seat (refused during grace with 'Player is not disconnected') and a connected owner (a lazy owner may ask); after a resign, or when the offered seat comes back, the oldest other resignable seat is offered again. Rejoiners and `/active` watchers get the other seats' `playerDisconnected` and the current offer replayed privately (iOS shows its banner only from `playerDisconnected`). A lazy/resigned owner dropping makes the seat 'away' (no `playerDisconnected`). `seatLifecycle.maybeAbort` is the only presence-driven abort: a seated table with owners aborts at once ('All players left') when no owner can ever return, and after 60s (`abandon`, 'All players disconnected') while no owner is connected; native-bot/ambient tables are never presence-aborted
- Tournament lifecycle (`server/socket/tournamentHandlers.js`, `TournamentState`): `tournament.epoch` is the start generation, like `game.epoch` — `beginStart()` (phase 'starting', epoch++) on Begin/Next round, `retire()` (epoch++) inside `GameManager.deleteTournament`, which also drops every `tournamentGames`/`playerTournaments` entry and returns the tables still live. `startTournamentRound(io, t, round, epoch)` re-checks `t.isLive(epoch)` (and that the id still resolves to `t`) after EVERY await and stops — aborting any table still alive, creating and sending nothing more. Shape: announce (`tournamentRoundStart`, 1.5s) → create every table synchronously (game, mapping, bots, round entry, game-room joins) → one `Promise.all` of `setActiveGame` → `tournamentGameAssignment` + `allPlayersReady` → one shared 2s countdown (`game.pause` per table) → `beginDraw` for all, so every table starts its draw at the same instant and the round's game set is final before any table can finish. `cancelTournament` works in any phase and does the whole in-memory teardown synchronously, before its first await: `deleteTournament` → `abortGame(io, table, 'Tournament cancelled')` for every live table → `tournamentCancelled` to the tournament room → room leave → lobbiesUpdated, then the scoped DB clears (`clearActiveTournament(username, tournamentId)`). Clients rely on that order: abortGame then tournamentCancelled lands web and iOS in the main room (iOS answers abortGame with `returnToTournament`, which finds no tournament → `tournamentLeft` + `mainRoomJoined`). A tournament game resolves exactly once (`handleTournamentGameEnd` deletes the mapping first); the gameEnd path records scores only while the game is still mapped (into `roundOfGame`'s round) and an aborted game records none. Leaving the tournament before your table is seated leaves the table too; the last member leaving aborts orphaned tables; `clearActiveGameForAll` also clears pre-seating entrants (`server/socket/__tests__/tournamentLifecycle.test.js`)
- Draw watchdog: 30s after DRAWING opens (`draw:watchdog`, armed by `beginDraw`, cleared by `handleDrawComplete`) every entrant that still has not drawn is auto-drawn (`youDrew` to a connected one); disconnected/left entrants are auto-drawn immediately and bots draw within ~4s, so the draw always ends within ~30s
- Lazy-bot timers: lazy, resign and draw-leaver bots are seat bots and schedule through `BotController.scheduleBotAction` (keys `${gameId}:${botSocketId}:bid|play|draw|chat:<n>`); `/active` → `unregisterBot` → `cancelBotActions` clears every key of that bot (chat included) and `cleanupGame` clears by game prefix (srv-15; `botTiming.test.js`)
- Manual check before merging a pacing change (owner): one hand on the App Store build against staging — bot cards 0.3–0.75 s apart, trick view 1.1 s, bot lead 0.6 s after the collect, next hand 1.0 s after the last trick, teams overlay readable
- A lazy or resigned player who rejoins (`rejoinGame` or `joinAsSpectator`) watches their seat (`rejoinSuccess` with `isLazy`, seat `gameStart` with the hand each deal); `/active` from that owner socket makes the seat fully human again (the bot is released with all its timers). `/active` re-sends `updateTurn` at the seat while a turn is open (BIDDING/PLAYING, not during trick/hand resolution); from the watch view it sends `restorePlayerState` instead. A repeated rejoin from the watching socket is idempotent
- Startup DB (`server/database.js`): `connectDB` runs fire-and-forget after `listen()`, retries the connect with backoff (2 s doubling, max 30 s), assigns the collections and resolves `whenReady()`, then `ensureIndexes()` (`Promise.allSettled` of `safeIndex` per index: `gameRecords.completedAt_-1`, `reports.createdAt_-1`, unique `users.username_1` via `ensureUsernameIndex`); each failure is a warning and startup continues (existing duplicates → no unique index, but a non-unique `username_nonunique` fallback so lookups stay indexed; a later boot drops the fallback and retries the unique build). Only `createIndex` (MongoDB 4.0+); no backfills. `signIn`/`restoreSession`/`signUp` and the `rejoinGame` token check wait up to 10 s on `whenReady` when the collection is still undefined (a failed restore makes both clients forget their token). `server/__tests__/realMongo.test.js` checks indexes/plans/race/payload equality against a localhost mongod (scratch DB, skips green without one; never call `connectDB` from tests: its dbName is `babonline`)
- `users.username` has a unique index, created at startup (`ensureUsernameIndex`); if existing duplicates block it the server logs a warning and runs with the non-unique `username_nonunique` fallback until they are merged. `signUp` treats a duplicate-key error as "Username already taken". Active-game DB writes (`setActiveGame`, `clearActiveGameForAll`) go to each seat's `ownerUsername` (none for native bots; `setActiveGame` also skips resigned and gone seats); `clearActiveGameForAll` only clears users whose `activeGameId` is still that game (a leaver may be in another game by then). Both run as one `Promise.all` of the per-user helpers (deliberately not `updateMany`: same latency at 4 users, per-user error isolation, the tests' `updateOne` spies), still awaited: game start writes before `teamsAnnounced` (sign-in auto-rejoin reads it) and re-clears every launched write if aborted meanwhile (and a seat's write if it was resigned or /leave'd during the batch); the end path clears before tournament scoring. Stale-pointer clears on signIn/restoreSession/rejoinFailed are scoped to the stale id (`clearActiveGame(u, staleId)`), so a pointer a new game wrote meanwhile survives
- DB reads are projected (memoryDb supports projections, so tests see the real shape): signIn excludes `customProfilePic`/`stats`/`mergedFrom` (restoreSession also `password`); profile/leaderboard/search/records read only the fields their replies use. `handleDrawComplete` looks up the four saved pics in parallel with `getUserProfilePic(u, {randomFallback:false})` (null instead of a random pic) and the unchanged loop draws every random pic in `drawIDs` order — never let lookups draw randoms concurrently (seeded fixtures/transcripts/sim depend on the order)
- Profile caches (`server/utils/ttlCache.js`, `profileHandlers.js`): leaderboard and records are 60 s single-flight caches (records keyed by server-local year-month); a fill that overlaps an `invalidate()` is never stored; cached values are shared, never mutate them. Invalidated after `recordGameStats` (records after `recordGameResult`, both after the stat writes), `deleteAccount`, `updateProfilePic`/`uploadProfilePic`. The owner CLIs (`merge-accounts`, `set-password`) run in another process: only the TTL covers them. Search stays the unanchored case-insensitive regex (it walks the `username_1` index keys; no `usernameLower` field by choice — no backfill, no Alan/alan collisions); a trimmed query longer than 50 answers `[]` without a read
- Soft limits (`rateLimiter.limits`, per socket): `getLeaderboard`/`getRecords` 10/10 s are checked inside their handlers and over the limit reply with the cached (even stale) page, the fill in flight, else the ordinary `{success:false, message}` — never `error`; `searchPlayers`/`getPlayerProfile` 30/10 s through `asyncHandler` (`error {type:'rateLimit'}`, a web toast; both web-only). `contract/src/c2s.js` mirrors the wrapper metadata (contract.test checks it)
- Password hashing (`server/utils/passwordHash.js`): bcryptjs (same `$2a$`/`$2b$` cost-10 format, no migration) in a `worker_threads` pool (`BAB_HASH_WORKERS`, default 2; lazy, unref'd while idle; >50 pending → `HASH_BUSY` → "Server is busy"; a crashed worker's jobs re-run inline). Inline bcryptjs when the Worker constructor throws and under Jest unless `BAB_HASH_POOL=1` (`server/utils/__tests__/passwordHash.test.js`). The CLIs (`setPassword`) keep plain bcryptjs
- Failed-sign-in throttle (`server/socket/signInThrottle.js`): failures only (unknown user, wrong password; not merged-account redirects, DB errors or HASH_BUSY), 15 min sliding window: (ip, username) pair 10, ip 50, username 30 (pair and ip skipped when the IP is unknown); a success clears the pair; an (ip, username) that signed in or restored a session in the last 30 days is known-good and skips the username key (an outsider's guesses cannot lock out the household); a flood never evicts a key at its limit (a map full of lockouts fails closed for new keys); checked before any DB read and answered with the usual `signInResponse` failure. The pair/username keys are reserved synchronously with the check (no overshoot from parallel guesses); the ip key counts confirmed failures only (a family signing in together behind one NAT never blocks itself). restoreSession/rejoinGame/signUp are never limited. Client IP (`server/utils/clientIp.js`, `socket.data.clientIp` at connection): a public handshake peer is used as-is (headers ignored); behind a proxy/private peer (Railway's edge is in 100/8) `X-Real-IP` when it is a non-proxy IP that appears in `X-Forwarded-For` (or XFF is absent); the leftmost XFF entry alone is never trusted; else null and only the username key applies (never one shared key). Every password sign-in logs 'Sign-in client address' (peer, X-Real-IP, XFF, chosen ip): check it after a deploy that different networks get different IPs
- Account deletion (`authHandlers.deleteAccount`) requires an authenticated socket + password re-confirm; it anonymizes the username in `gameRecords`
- Express pages: `/privacy`, `/support`, `/terms` (App Store compliance copy lives in `server/routes/index.js`)
- Avatars (docs/avatars.md, invariants I1-I6): clients that send `clientHello {caps:['avatarUrl']}` (`server/socket/clientInfo.js`, `socket.data.client`; web sends it from `client/src/utils/avatar.js`) get null custom-picture slots plus additive `avatarUrls`/`avatarUrl` (`GET /avatar/:username?v=`, `server/routes/avatar.js`: immutable only on the current version, uniform 404, per-IP bucket via clientIp); every other socket (the App Store build, old web bundles) gets the small derived inline WebP in the same slot. Renditions are derived lazily in memory (`server/avatar/avatarStore.js`, sharp 0.34.5 pinned for Node 18; `warm` from getUserProfilePic, never blocking, no RNG) and mapped at emit time (`server/avatar/avatarWire.js`); room broadcasts (positionUpdate, playerActiveMode) stay ONE emit with inline + URL. Stored `customProfilePic` values are never rewritten; new uploads are stored as the canonical WebP. Kill switches: `AVATAR_LEGACY_INLINE=raw`, `AVATAR_PIPELINE=off` (default off under Jest: tests opt in with `avatarStore.configure({enabled:true})` + `_reset()`). Stock art: `client/assets/profileN.png` 192 px (same paths: the App Store app loads them) and `client/assets/avatars/v1/*.webp` (immutable; new art goes to v2); web renders every picture through `avatarSrc`/`applyAvatarImg` only. Removing the inline images waits in `contract/V1_REMOVALS.md` #19
- Ambient bot activity (`server/demo/ambientBots.js`): keeps one spectatable bot-vs-bot game running and seeds main-room chat with bot-persona messages, so the app is never an empty room (added for App Review Guideline 2.1(a) — reviewers must see other users' chats and games). On by default in production; `AMBIENT_BOTS=true|false` overrides. A wedged game (older than 90 min) is recycled through `gameLifecycle.abortGame` (spectators get `abortGame { reason: 'Game recycled' }` and leave the room). Always on (occupancy gating was declined: three main-room join points, negligible saving): a finished game is replaced within `AMBIENT_CHECK_MS + AMBIENT_RESTART_MS` (5 + 5 s); before the deal and while unwatched a demo game uses `pacing.AMBIENT_PREGAME` (draw/reveal/seating/teams ~0: those stages are unlisted), so it is listed ~0.1 s after its start and then plays at the standard pacing App Store review sees
- iOS builds: prebuilt WebRTC (stasel/WebRTC via SPM) ships no dSYM — the archive warning at upload is expected and safe to ignore
- iOS project (README "iOS project layout" / "Adding test targets"): the committed `iOSClient/BABOnline.xcodeproj` is the single source of truth (team 9SYNY7K2HE, bundle id, versions, entitlements, INFOPLIST_KEY_*, SPM packages). There is no XcodeGen spec, so never add one or regenerate the project. It uses Xcode 16 synchronized folders (`objectVersion = 77`, one `PBXFileSystemSynchronizedRootGroup` for `BABOnline/`), so a new .swift file or folder under `iOSClient/BABOnline/` is compiled with no pbxproj edit. Any other file there is copied into the app bundle, so keep non-app files outside it (e.g. `iOSClient/generate_icon.swift`). `Info.plist` and `BABOnline.entitlements` stay in the folder's `membershipExceptions`, so they are never bundle resources. Unit tests: `BABOnlineTests` (sibling synchronized folder, hosted, `@testable import BAB_Online`), run by the committed shared scheme `xcshareddata/xcschemes/BABOnline.xcscheme` (`xcodebuild ... test`, README "Tests"); the app skips its socket under XCTest; contract/fixtures/v2 is a folder reference (`subdirectory: "v2"`); files in BABOnlineTests are flattened, so fixture basenames must be unique

## Account Admin (owner-run, against production via `MONGO_URI`)

```bash
node scripts/merge-accounts.js --find-duplicates                  # list look-alike usernames
node scripts/merge-accounts.js --into Alan alan2 AlanB            # dry run: prints every change
node scripts/merge-accounts.js --into Alan alan2 AlanB --apply    # asks you to type MERGE
node scripts/set-password.js Alan                                 # new friendly password, signs out all devices
node scripts/avatar-report.js [--list]                            # read-only: stored custom pictures, sizes, how many derive (run before enabling the avatar pipeline)
```

Merging is idempotent (re-running prints "Nothing to do") and refuses while a source account is in an active game or tournament. There is no in-app password reset by design (no emails are stored); the owner resets passwords for players who ask.

## Common Files to Check

| Task | Files |
|------|-------|
| Game rules/logic | `server/game/rules.js`, `docs/RULES.md` |
| Bot AI / strategy | `server/game/bot/BotStrategy.js`, `docs/bot-strategy-guide.md`, `server/game/bot/sim/` |
| Card play handling | `server/socket/gameHandlers.js` |
| Seats: lazy / resign / leave / rejoin / disconnect | `server/game/SeatState.js`, `server/socket/seatLifecycle.js` |
| Client card legality | `client/src/rules/legality.js` |
| UI screens | `client/src/ui/screens/` |
| Visual card display | `client/src/phaser/managers/CardManager.js` |
| State management | `server/game/GameState.js`, `client/src/state/GameState.js` |
| Socket events list / payloads | `contract/src/s2c.js`, `contract/src/c2s.js` (generated: `contract/events.schema.json`, `client/src/constants/events.js`, `SocketEvents.swift`) |
| Sign-in sessions / account merge | `server/socket/authHandlers.js`, `server/utils/sessionTokens.js`, `server/admin/accountMerge.js` |
