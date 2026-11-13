# BAB Online - Claude Context Document

This document helps Claude understand the project quickly in new sessions.
This root file is the index: per-area detail lives in the files listed under "Where to read" below.

## What is this?

BAB Online is a 4-player online multiplayer trick-taking card game ("Back Alley Bridge"). Players form 2 teams (positions 1&3 vs 2&4) and compete across 13 hands with varying card counts.

**See `docs/RULES.md` for complete game rules.**

## Tech Stack

- **Frontend (web)**: Phaser 3.55.2 (game engine), ES6 modules, Socket.IO client 4.8.1 (the server's version), Vite bundler; both libraries are bundled (`client/src/vendor.js`, `client/src/socket/createSocket.js`), no CDN scripts
- **iOS**: Native SwiftUI app in `iOSClient/` (SpriteKit game scene, Socket.IO-Client-Swift, WebRTC voice) — NOT a webview; it mirrors the web client's socket contract
- **Backend**: Node.js 18+, Express.js, Socket.IO server
- **Database**: MongoDB (native client, no ORM) — collections: `users`, `gameRecords`, `reports`, `passwordResets`, `adminAudit` (the admin panel)
- **Testing**: Jest (server), Vitest (client)
- **Deployment**: Railway via its GitHub integration on push to main (GitHub Actions runs tests/build only)

## Directory Structure

```
bab-online/
├── client/                     # Frontend
│   ├── src/
│   │   ├── entry.js           # Page entry: phone gate (boot/), then import('./main.js'), the app
│   │   ├── boot/              # Phone gate: detection, gate screen, boot order
│   │   ├── constants/         # Event names, card ranks, hand progression
│   │   ├── utils/             # Position math, card helpers
│   │   ├── rules/             # Card legality, bids.js bid totals (a bore = the hand, capped at it; mirror the server)
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
│   │   ├── GameManager.js     # Singleton: manages main room, lobbies, games, tournaments
│   │   ├── pacing.js          # EVERY presentation delay + bot think range (profiles, solo overlay, shipped-iOS floors)
│   │   ├── TournamentState.js # Per-tournament state (4 rounds, scoreboard)
│   │   └── bot/               # AI player system (strategy, personalities, sim/ harness)
│   ├── socket/                # Socket.IO handlers by domain
│   │   ├── gameHandlers.js    # Core gameplay (draw, bid, play)
│   │   ├── seatLifecycle.js   # Seat changes: disconnect, rejoin, lazy/active, resign, leave, abort
│   │   ├── lobbyHandlers.js   # Pre-game lobby
│   │   ├── tournamentHandlers.js # Tournament lifecycle
│   │   ├── authHandlers.js    # Sign-in/up, account deletion, signOutUser (forceLogout flow)
│   │   ├── adminHandlers.js   # Admin panel API (adminRequest/adminResponse), DB-checked per request
│   │   ├── upgradeGate.js     # Update screen for the old iOS 1.0.0 app (User-Agent build < 2; UPGRADE_GATE=off)
│   │   ├── safetyHandlers.js  # Report / block / unblock users
│   │   └── validators.js      # Joi validation schemas
│   ├── admin/                 # Account admin logic: scripts/ CLIs + the web admin panel (role, reset links, audit, merge view)
│   ├── avatar/                # Custom-picture renditions (sharp), wire mapping (docs/avatars.md)
│   ├── voice/turnCredentials.js # Cloudflare TURN credentials for voice (STUN fallback)
│   ├── testUtils/memoryDb.js  # In-memory Mongo collection fake for Jest (no mongod needed)
│   ├── utils/
│   │   ├── profanityFilter.js # UGC filter (chat, usernames, lobby names)
│   │   ├── sessionTokens.js   # Per-device "stay signed in" tokens
│   │   ├── passwordHash.js    # bcryptjs in a worker_threads pool
│   │   ├── clientIp.js        # Client IP behind Railway's edge (sign-in throttle)
│   │   └── ttlCache.js        # Leaderboard/records caches
│   └── __tests__/             # Jest tests
│
├── scripts/                    # Owner-run CLIs: merge-accounts.js, set-password.js, set-admin.js, avatar-report.js (read-only); build-avatars.js, build-tokens.js (npm run tokens)
│
├── contract/                   # Socket contract: schema source, generator, v1 baseline, v2 fixtures (dev/test only)
│
├── iOSClient/                  # Native SwiftUI iOS app
│   ├── BABOnline.xcodeproj    # THE project config (hand-maintained; no XcodeGen)
│   └── BABOnline/             # Synchronized folder = app target: Views, State, Networking (handlers/emitters), SpriteKit
│
└── docs/
    ├── claude/                # Per-area Claude docs that never auto-load (see "Where to read")
    └── RULES.md               # Complete game rules
```

## Game Flow (Socket Events)

1. **Auth**: `signIn`/`signUp` → `signInResponse` (includes `blockedUsers`; `deleteAccount` → `deleteAccountResponse` for in-app account deletion); `restoreSession` resumes a saved per-device token without a password
2. **Lobby**: `createLobby` / `joinLobby` → `lobbyCreated` → `playerReadyUpdate` → `allPlayersReady`
3. **Draw**: `startDraw` → `draw` → `playerDrew` → `teamsAnnounced`
4. **Bidding**: `gameStart` → `updateTurn` → `playerBid` → `bidReceived` → `doneBidding` (if both teams bid 0 there is no `doneBidding`: the server sends a log entry, `destroyHands` and a fresh `gameStart` for the redeal)
5. **Play**: `updateTurn` → `playCard` → `cardPlayed` → `trickComplete` → `handComplete`
6. **End**: `gameEnd` (payload always includes `tournamentId`, null for casual games)
7. **Resync (snapshot v2)**: `requestSnapshot {requestId?, customPics?, log?}` → `stateSnapshot {snapshot, requestId?}` or `{snapshot: null, reason: 'not_in_game'}` (any seat owner, entrant or spectator; custom pictures only with `customPics: true`; `snapshot.partial` lists what was left out and the client keeps it — `mergeSnapshot`; `seq` on room broadcasts tells a v2 client when it missed something)

**Tournaments**: `createTournament`/`joinTournament` → `tournamentJoined` (the joiner) and `tournamentPlayerJoined {username, players, scoreboard}` (the members already there; `scoreboard` is additive, 2026-11-11, so an open lobby lists the joiner's row at once) → ready-up → `beginTournament` → 4 rounds of games (`tournamentGameAssignment`, results via `tournamentGameComplete`/`tournamentRoundComplete`) → `beginNextRound` between rounds → `tournamentComplete` (with `winners[]`). The creator may cancel in any phase (`cancelTournament` → `abortGame` at every running table, then `tournamentCancelled`). Disconnected players are marked `connected: false` and reattach by username (any phase); completed tournaments linger ~10 min so players can view results.

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
npm run dev:client   # Client Vite dev server (port 5173; serves client/index.html → /src/entry.js → /src/main.js, API on 3000)
npm run build:client # Production build: client/dist (index.html + hashed assets/); Express serves / from it
npm run build:avatars # Re-encode stock avatar art from the fcdd885 masters (scripts/build-avatars.js)
npm run build:icons  # favicon.ico (16/32/48), assets/icons/icon-192.png + apple-touch-icon.png, assets/app-icon.webp (the phone gate's) from the iOS app icon (scripts/build-icons.js)

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

## Cross-client rules

- Card legality logic duplicated in `server/game/rules.js`, `client/src/rules/legality.js`, and `iOSClient/.../Rules/CardLegality.swift`
- Over-trump (OT) effect rule (owner 2026-11-11): the card just played is a trump or joker, the lead is not trump (a joker lead is), and it takes the trick (server `determineWinner` order) from an OPPONENT (seat parity) whose winning card was a trump or joker; over a partner's trump is never an OT. Web `client/src/rules/overTrump.js` (`GameScene.detectOverTrump`, from cardPlayed only), iOS `TrickRules.isOverTrump` (TableTypes.swift, reducer cardPlayed); case tables in `overTrump.test.js` / `OverTrumpTests.swift`

## Where to read

What used to be this file's long "Important Implementation Details" list (and the architecture, data-structure and Account Admin sections) now lives in the files below, moved verbatim. Moved text that still says "Important Implementation Details", "above" or "below" means the old single file: use this table.

The nested `CLAUDE.md` files (`server/`, `server/admin/`, `server/demo/`, `contract/`, `iOSClient/`) load automatically ONLY when Claude reads a file in that folder; the `docs/claude/` files never load on their own. A task that spans areas (a wire change, a feature on web and iOS, a seat or session change seen from a client) must open every doc below that it touches before editing.

| Topic | Read | Hook |
| --- | --- | --- |
| Server architecture | `server/CLAUDE.md`, Key Architecture Patterns | GameManager / GameState / rules.js roles; Socket.IO `serverOptions.js` (connectTimeout 10 s) |
| Key data structures | `server/CLAUDE.md`, Key Data Structures | Card shape, server GameState fields, the `stage` FSM chain, bid values (13, bores) |
| Game phase FSM | `server/CLAUDE.md`, Game phase FSM | `game.transition` / `terminate` / `setTimer`, abort and draw entry points, fsmGuard |
| Pacing | `server/CLAUDE.md`, Pacing | `pacing.js` profiles, SOLO overlay, iOS floors, resume holds, rate limits, the manual pacing check |
| Bots | `server/CLAUDE.md`, Bots | bot socket ids, strategy + personalities, `npm run sim` benchmark, lazy-bot timers |
| Socket rooms, draw watchdog | `server/CLAUDE.md`, Socket rooms and draw watchdog | `game:` / `tournament:` rooms; the 30 s auto-draw |
| Seats and presence | `server/CLAUDE.md`, Seats and presence | SeatState records, `playerGames`, /leave /lazy /active (incl. the iOS Leave alert: `LeaveAlertPresenter` UIAlertController, `LeaveOutcome`), grace / resign / abort, AFK, lazy rejoin |
| Lobby seats | `server/CLAUDE.md`, Lobby seats | one lobby seat per username, takeover, 30 s reload grace, `reconnecting` |
| Tournament lifecycle | `server/CLAUDE.md`, Tournament lifecycle | `tournament.epoch`, round start shape, cancel order, scores recorded once |
| Spectator badge and chat | `docs/claude/spectators.md` | `spectatorList()`, unsequenced `spectatorsUpdated`, web badge + spectator bubble, iOS 1.2.0 |
| Ambient bot activity | `server/demo/CLAUDE.md` | on-demand demo game, idle rules, `AMBIENT_CHAT_USERS` (test1) |
| Sessions and socket identity | `docs/claude/server-accounts.md`, Sessions and socket identity | per-device tokens, one live socket, supersede / parked tabs, `releaseIdentity` |
| Username rules, password hashing, sign-in throttle | `docs/claude/server-accounts.md` | sign-up name rules and budgets, bcrypt worker pool, failed-sign-in limits + client IP |
| Database, caches, limits | `docs/claude/server-infra.md` | startup DB + indexes, active-game writes, projected reads, profile caches, soft limits |
| Express pages, avatars | `docs/claude/server-infra.md` | /privacy /support /terms; avatar pipeline, `clientHello` caps, kill switches |
| Voice | `docs/claude/voice.md` | signaling checks (peers, blocks, limits), Cloudflare TURN minting, web/iOS restart rules |
| Merged accounts, admin panel, reset links, deletion | `server/admin/CLAUDE.md` | tombstones, `adminRequest` authorization + audit, merge / delete / rename, one-time reset links |
| Account Admin CLIs | `server/admin/CLAUDE.md`, Account Admin | owner-run `scripts/` against production, always the `babonline` database |
| Socket contract | `contract/CLAUDE.md`, Socket contract | `contract/src`, `npm run contract:gen`, contract guard, additive-only wire, `contract/V1_REMOVALS.md` |
| Snapshot v2, `seq` | `contract/CLAUDE.md` | `getSnapshotV2`, `trickHistory`, `watching`; seq stamping, consumer rules R1-R5 |
| Upgrade gate | `contract/CLAUDE.md`, Upgrade gate | iOS 1.0.0 detection by User-Agent, update-only replies, `UPGRADE_GATE=off` |
| iOS reconnect, table store | `iOSClient/CLAUDE.md` | `forceReconnect` builds a new manager, session gate; TableReducer store, iOS fixtures; its intro lists iOS topics kept in other files (Leave alert, voice, spectators) |
| iOS project, builds, releases | `iOSClient/CLAUDE.md`, iOS project | hand-kept xcodeproj, synchronized folders, versions 1.1.0 / 1.2.0 (6) and what each build adds (1.2.0 bot seats: `positionUpdate.isBot`, `bot:` socket-id fallback), dSYM warning |
| Web client architecture | `docs/claude/web-client.md`, Architecture | ClientSession screen FSM, SocketManager ping, reconnect order |
| Web stay signed in, delivery, screens, phone gate | `docs/claude/web-client.md` | session storage, `staticAssets.js` + CSP + restart notice, `.screen--full`, phone gate |
| Web table, layout, design system | `docs/claude/web-table.md` | GameState one writer, SeqGate, TableDirector, MyAction; `computeTableLayout`, `GameScene.relayout()` and its tests (`computeTableLayout.test.js`, `relayout.test.js` mid-deal / mid-trick); tokens + kit |

## Common Files to Check

| Task | Files |
|------|-------|
| Game rules/logic | `server/game/rules.js`, `docs/RULES.md` |
| Bot AI / strategy | `server/game/bot/BotStrategy.js`, `docs/bot-strategy-guide.md`, `server/game/bot/sim/` |
| Card play handling | `server/socket/gameHandlers.js` |
| Seats: lazy / resign / leave / rejoin / disconnect | `server/game/SeatState.js`, `server/socket/seatLifecycle.js` |
| Client card legality | `client/src/rules/legality.js` |
| UI screens | `client/src/ui/screens/` |
| Phone gate (send phones to the iOS app) | `client/src/boot/deviceGate.js`, `client/src/boot/gateScreen.js`, `client/src/entry.js` |
| Visual card display | `client/src/phaser/managers/CardManager.js` |
| Web table layout / DOM HUD | `client/src/phaser/layout/computeTableLayout.js`, `client/src/ui/tableHud.js` |
| State management | `server/game/GameState.js`, `client/src/state/GameState.js` |
| Socket events list / payloads | `contract/src/s2c.js`, `contract/src/c2s.js` (generated: `contract/events.schema.json`, `client/src/constants/events.js`, `SocketEvents.swift`) |
| Sign-in sessions / account merge | `server/socket/authHandlers.js`, `server/utils/sessionTokens.js`, `server/admin/accountMerge.js` |
| Admin panel / reset links / audit | `server/socket/adminHandlers.js`, `server/admin/`, `server/routes/passwordReset.js`, `client/src/ui/screens/AdminPanel.js`, `client/src/reset/`, `scripts/set-admin.js` |
