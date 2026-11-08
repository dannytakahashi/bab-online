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
│   │   ├── GameManager.js     # Singleton: manages games, queue, lobbies, tournaments
│   │   ├── TournamentState.js # Per-tournament state (4 rounds, scoreboard)
│   │   └── bot/               # AI player system (strategy, personalities, sim/ harness)
│   ├── socket/                # Socket.IO handlers by domain
│   │   ├── gameHandlers.js    # Core gameplay (draw, bid, play)
│   │   ├── lobbyHandlers.js   # Pre-game lobby
│   │   ├── tournamentHandlers.js # Tournament lifecycle
│   │   ├── authHandlers.js    # Sign-in/up, account deletion
│   │   ├── safetyHandlers.js  # Report / block / unblock users
│   │   └── validators.js      # Joi validation schemas
│   ├── admin/                 # Account admin logic used by scripts/ (merge, set password)
│   ├── testUtils/memoryDb.js  # In-memory Mongo collection fake for Jest (no mongod needed)
│   ├── utils/
│   │   ├── profanityFilter.js # UGC filter (chat, usernames, lobby names)
│   │   └── sessionTokens.js   # Per-device "stay signed in" tokens
│   └── __tests__/             # Jest tests
│
├── scripts/                    # Owner-run CLIs: merge-accounts.js, set-password.js, build-atlas.js
│
├── iOSClient/                  # Native SwiftUI iOS app (Xcode project)
│   └── BABOnline/             # Views, State, Networking (handlers/emitters), SpriteKit
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
- `players`: Map<socketId → {username, position, pic, isBot}>
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

**Tournaments**: `createTournament`/`joinTournament` → `tournamentJoined` → ready-up → `beginTournament` → 4 rounds of games (`tournamentGameAssignment`, results via `tournamentGameComplete`/`tournamentRoundComplete`) → `beginNextRound` between rounds → `tournamentComplete` (with `winners[]`). Disconnected players are marked `connected: false` and reattach by username (any phase); completed tournaments linger ~10 min so players can view results.

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

npm test             # Server tests (Jest)
npm run test:client  # Client tests (Vitest)
npm run sim          # Bot-vs-bot simulation (tuning/regression; see server/game/bot/sim/README.md)
```

## Important Implementation Details

- Game phase FSM (`server/game/GamePhase.js`, `GameState`): the stage changes only through `game.transition(from, to)` (every call site reads `if (!game.transition(F, T)) return;` — an illegal call throws under Jest / `BAB_FSM_STRICT=1`, logs and fails closed in production), `tryTransition` (the DRAWING → DRAW_RESOLVING latch, so the draw resolves exactly once) and `terminate(io, ENDED|ABORTED, event, payload)` (final event out first, then epoch bump + cancel all game timers). Never write `game.phase`/`game.bidding` (getters; a write is a reported violation) and never gate on flags — gate on `game.stage` (`acceptsTurnInput()`, `actionTypeForTurn()`, `isPreSeating()`). Lifecycle waits use `if (!(await game.pause(ms))) return;` and timers use `game.setTimer(key, ms, fn)` (`lazy:<pos>`, `reconnectGrace`), so nothing runs or emits after end/abort; BotController timers check `game.epoch`, and `broadcast`/`sendToPlayer` drop everything from a terminal game. `recordDraw` is the only writer of draw state. Abort only through `socket/gameLifecycle.abortGame(io, game, reason)` (abortGame to the room incl. spectators → ABORTED → `GameManager._retire`: bots, room, every `playerGames` entry for the game → lobbiesUpdated → DB/tournament follow-up); the draw starts only through `gameLifecycle.beginDraw` (also auto-draws for sockets that left/disconnected during the pre-draw countdown). The end path sends `gameEnd` before persisting stats. Jest's `server/testUtils/fsmGuard.js` fails any test that records a violation; `BAB_FSM_CHECK=1` runs `validateGameState()` (per-stage invariants) on every transition and records `_history` (`server/socket/__tests__/chaos.test.js`, `lifecycle.test.js`, `wireProjection.test.js`)
- Bots have socketIds like `bot:{username}:{uuid}`, use `BotStrategy.js` for AI. Card play is contract-aware: `processBotPlay` passes a play context (team bids/tricks/bores) into `decideCard`. Personalities (`personalities.js`) define `bidStyle` + `playStyle` consumed by the strategy; Mary is the sim-tuned optimal baseline, the others are slight measured variations. Strategy changes must be benchmarked with `npm run sim` against the frozen legacy snapshot (`sim/legacyStrategy.js`)
- Sessions are per device (`server/utils/sessionTokens.js`): each sign-in adds a token to `users.sessionTokens` (SHA-256 hashes only, max 5, expire 90 days after last use) instead of replacing the old one, so signing in on the computer doesn't log the phone out. A legacy plaintext `users.sessionToken` is still accepted and migrated. Only one *live* socket per user: a password sign-in, or a different device restoring its token, kicks the previous socket (`forceLogout`); the same device reconnecting (same token hash in `socket.data.sessionHash`) does not. `rejoinGame` from an unauthenticated socket (web reload mid-game) is authorized by the same `verifySession` check on the token it sends. Rejoining a tournament game also reattaches tournament membership to the new socket
- Web "stay signed in" (`client/src/utils/sessionPersistence.js`): the tab's session is in `sessionStorage` (so 4-tab local testing still works) and the latest sign-in is mirrored to `localStorage`, which a fresh tab adopts on load. Profile page has a Sign Out button (shared family computers). iOS keeps its token in the Keychain
- Merged accounts: `scripts/merge-accounts.js` turns duplicate accounts into tombstones `{ username, mergedInto, mergedAt }` (no password/tokens/stats). Sign-in/sign-up/restore on a tombstone tell the player which account to use; leaderboard and player search exclude them; `getPlayerProfile` follows `mergedInto`; deleting the kept account deletes its tombstones. The kept account's `mergedFrom[]` is the audit log and the idempotency guard. Any new per-user data keyed by username must be added to `server/admin/accountMerge.js`
- Socket rooms: players join `game:{gameId}` for broadcasts; tournaments use `tournament:{tournamentId}`
- Event constants in `client/src/constants/events.js` (web) and `iOSClient/.../Constants/SocketEvents.swift` (iOS) prevent typos — keep all three sides of the contract in sync
- Card legality logic duplicated in `server/game/rules.js`, `client/src/rules/legality.js`, and `iOSClient/.../Rules/CardLegality.swift`
- In-game leave is a chat command (`/leave`, `/lazy`, `/active`) routed through `chatMessage` — both clients' Leave buttons send `/leave`; it also works before positions exist (pre-draw countdown and draw phase): when seats are assigned (`handleDrawComplete`) a draw-phase leaver's seat goes straight to a bot (recorded as resigned) and the game aborts if every human left; a draw-phase disconnect gets the normal 60s reconnect grace timer (`startReconnectGraceTimer`), after which the others get `resignationAvailable`. A lazy/resigned human's rejoin shadow sending `/leave` is a permanent leave too. A table where nobody present can forceResign the disconnected seats (`isHumanPresent`: lazy seats count only while their human's socket is connected) re-arms the grace timer and aborts on expiry instead of waiting forever
- A resigned player who rejoins comes back as a lazy spectator; `/active` then makes the seat fully human again (clears `isBot` and the `resignedPlayers` entry, cancels the resign bot). `/active` re-sends `updateTurn` to the returning socket while a turn is open (BIDDING/PLAYING, not during trick/hand resolution; the spectator path sends `restorePlayerState` instead)
- `users.username` has a unique index, created at startup (`ensureUsernameIndex`); if existing duplicates block it the server logs a warning and runs without it. `signUp` treats a duplicate-key error as "Username already taken". Active-game DB writes (`setActiveGame`, `clearActiveGameForAll`) skip bots and target the human behind lazy/resigned seats; `clearActiveGameForAll` only clears users whose `activeGameId` is still that game (a leaver may be in another game by then)
- Account deletion (`authHandlers.deleteAccount`) requires an authenticated socket + password re-confirm; it anonymizes the username in `gameRecords`
- Express pages: `/privacy`, `/support`, `/terms` (App Store compliance copy lives in `server/routes/index.js`)
- Ambient bot activity (`server/demo/ambientBots.js`): keeps one spectatable bot-vs-bot game running and seeds main-room chat with bot-persona messages, so the app is never an empty room (added for App Review Guideline 2.1(a) — reviewers must see other users' chats and games). On by default in production; `AMBIENT_BOTS=true|false` overrides. A wedged game (older than 90 min) is recycled through `gameLifecycle.abortGame` (spectators get `abortGame { reason: 'Game recycled' }` and leave the room)
- iOS builds: prebuilt WebRTC (stasel/WebRTC via SPM) ships no dSYM — the archive warning at upload is expected and safe to ignore

## Account Admin (owner-run, against production via `MONGO_URI`)

```bash
node scripts/merge-accounts.js --find-duplicates                  # list look-alike usernames
node scripts/merge-accounts.js --into Alan alan2 AlanB            # dry run: prints every change
node scripts/merge-accounts.js --into Alan alan2 AlanB --apply    # asks you to type MERGE
node scripts/set-password.js Alan                                 # new friendly password, signs out all devices
```

Merging is idempotent (re-running prints "Nothing to do") and refuses while a source account is in an active game or tournament. There is no in-app password reset by design (no emails are stored); the owner resets passwords for players who ask.

## Common Files to Check

| Task | Files |
|------|-------|
| Game rules/logic | `server/game/rules.js`, `docs/RULES.md` |
| Bot AI / strategy | `server/game/bot/BotStrategy.js`, `docs/bot-strategy-guide.md`, `server/game/bot/sim/` |
| Card play handling | `server/socket/gameHandlers.js` |
| Client card legality | `client/src/rules/legality.js` |
| UI screens | `client/src/ui/screens/` |
| Visual card display | `client/src/phaser/managers/CardManager.js` |
| State management | `server/game/GameState.js`, `client/src/state/GameState.js` |
| Socket events list | `client/src/constants/events.js` |
| Sign-in sessions / account merge | `server/socket/authHandlers.js`, `server/utils/sessionTokens.js`, `server/admin/accountMerge.js` |
