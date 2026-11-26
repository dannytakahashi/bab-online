# BAB Online - Claude Context Document

This document helps Claude understand the project quickly in new sessions.
This root file is the index: per-area detail lives in the files listed under "Where to read" below.

## What is this?

BAB Online is a 4-player online multiplayer trick-taking card game ("Back Alley Bridge"). Players form 2 teams (positions 1&3 vs 2&4) and compete across 13 hands with varying card counts.

**See `docs/RULES.md` for complete game rules.**

## Tech Stack

- **Frontend (web)**: Phaser 3.55.2 (game engine), ES6 modules, Socket.IO client 4.8.1 (the server's version), Vite bundler; both libraries are bundled (`client/src/vendor.js`, `client/src/socket/createSocket.js`), no CDN scripts
- **iOS**: Native SwiftUI app in `iOSClient/` (SpriteKit game scene, Socket.IO-Client-Swift, WebRTC voice) — NOT a webview; it mirrors the web client's socket contract
- **Backend**: Node.js 26 LTS (`engines` 26.x, which Railway's Railpack reads first; `.nvmrc`, CI and `Dockerfile.local` match; moved from 24 on 2026-11-19 with the builder switch from Nixpacks, which is frozen and has no Node 26), Express.js, Socket.IO server
- **Database**: MongoDB (native client, no ORM) — collections: `users`, `gameRecords`, `reports`, `passwordResets`, `adminAudit` (the admin panel), `tournamentRecords` (the tournament history, one document per completed tournament: profiles' Tournaments section, Lucky Buck)
- **Testing**: Jest (server), Vitest (client)
- **Deployment**: Railway via its GitHub integration on push to main, once that commit's GitHub Actions checks pass (Jest, Vitest, tokens check, production + Docker boot checks; `docs/claude/server-infra.md`, CI). Service settings are infrastructure as code in `.railway/railway.ts` (applied by hand with `railway config plan` / `apply`, not on push; `railway.toml` is gone): Railpack, wait for CI, deploy healthcheck `/ready` on `PORT=3000` (a service variable), restart ON_FAILURE (a crash exits 1, a deploy's SIGTERM 0); `/health` shows the DB state and live counts (`docs/claude/server-infra.md`, Deploys)

## Directory Structure

```
bab-online/
├── client/                     # Frontend
│   ├── src/
│   │   ├── entry.js           # Page entry: phone gate (boot/), then import('./main.js'), the app
│   │   ├── boot/              # Phone gate: detection, gate screen, boot order
│   │   ├── audio/             # Sound effects: SoundManager (Web Audio, mute), tableSounds (event → sound)
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
│   └── assets/                # Card images, sprites, sounds/ (npm run build:sounds)
│
├── server/                     # Backend
│   ├── game/                  # Core game logic
│   │   ├── rules.js           # Pure functions: card comparison, legality, scoring
│   │   ├── Deck.js            # Card deck, Fisher-Yates shuffle (crypto.randomInt; a replaced Math.random, i.e. a seeded run, keeps its stream)
│   │   ├── GameState.js       # Game state encapsulation
│   │   ├── SeatState.js       # Seat controller/presence edge table + invariants
│   │   ├── GameManager.js     # Singleton: manages main room, lobbies, games, tournaments
│   │   ├── pacing.js          # EVERY presentation delay + bot think range (profiles, solo overlay, shipped-iOS floors)
│   │   ├── TournamentState.js # Per-tournament state (1-5 rounds, the host's pick; scoreboard; the cut)
│   │   ├── cutForABuck.js     # Cut for a buck's pure engine (the tournament finale; socket/cutForABuck.js runs it)
│   │   ├── badges.js          # Badges: catalog, per-game tracker, which seat earned what (human games only)
│   │   ├── tournamentRecord.js # The tournament history's record (pure builder) and a profile's recent results
│   │   └── bot/               # AI player system (strategy, personalities, sim/ harness)
│   ├── socket/                # Socket.IO handlers by domain
│   │   ├── gameHandlers.js    # Core gameplay (draw, bid, play)
│   │   ├── seatLifecycle.js   # Seat changes: disconnect, rejoin, lazy/active, resign, leave, abort
│   │   ├── lobbyHandlers.js   # Pre-game lobby
│   │   ├── tournamentHandlers.js # Tournament lifecycle
│   │   ├── authHandlers.js    # Sign-in/up, account deletion, signOutUser (forceLogout flow)
│   │   ├── adminHandlers.js   # Admin panel API (adminRequest/adminResponse), DB-checked per request
│   │   ├── upgradeGate.js     # Update screen for old iOS apps (User-Agent build < 3, or BAB_MIN_IOS_BUILD if higher; updateRequired; UPGRADE_GATE=off)
│   │   ├── badgeAwards.js     # Badges: award once per player after a game's stats, lifetime badges, badgesAwarded
│   │   ├── safetyHandlers.js  # Report / block / unblock users
│   │   └── validators.js      # Joi validation schemas
│   ├── admin/                 # Account admin logic: scripts/ CLIs + the web admin panel (role, reset links, audit, merge view)
│   ├── avatar/                # Custom-picture renditions (sharp), wire mapping (docs/avatars.md)
│   ├── voice/turnCredentials.js # Cloudflare TURN credentials for voice (STUN fallback)
│   ├── testUtils/memoryDb.js  # In-memory Mongo collection fake for Jest (no mongod needed; a duplicate _id or unique key rejects with E11000: createMemoryDb has the server's unique users.username and gameRecords.gameId; updateOne upserts)
│   ├── utils/
│   │   ├── profanityFilter.js # UGC filter (chat, usernames, lobby names)
│   │   ├── sessionTokens.js   # Per-device "stay signed in" tokens
│   │   ├── passwordHash.js    # bcryptjs in a worker_threads pool
│   │   ├── clientIp.js        # Client IP behind Railway's edge (sign-in throttle, sign-up limit)
│   │   ├── shutdown.js        # Graceful shutdown; exit 0 on SIGTERM, 1 on a crash
│   │   ├── safeTimer.js       # safeTimeout/safeInterval: a throwing callback is logged, never a crash
│   │   └── ttlCache.js        # Leaderboard/records caches
│   └── __tests__/             # Jest tests
│
├── scripts/                    # Owner-run CLIs: merge-accounts.js, set-password.js, set-admin.js, avatar-report.js (read-only), backup-db.js / restore-db.js (logical DB backup and restore), backfill-badges.js (badges the records prove; read-only without --apply); build-avatars.js, build-badges.py (the 20 badge SVGs), build-tokens.js (npm run tokens), build-sounds.py (npm run build:sounds); ios-live-resume-harness.sh (+ preload: local server for the iOS live resume tests); ci-boot-check.sh (CI: poll /health etc., fail if the server died)
│
├── contract/                   # Socket contract: schema source, generator, v1 + per-iOS-build baselines, v2 fixtures (dev/test only)
│
├── iOSClient/                  # Native SwiftUI iOS app
│   ├── BABOnline.xcodeproj    # THE project config (hand-maintained; no XcodeGen)
│   └── BABOnline/             # Synchronized folder = app target: Views, State, Networking (handlers/emitters), SpriteKit
│
└── docs/
    ├── claude/                # Per-area Claude docs that never auto-load (see "Where to read")
    ├── BACKLOG.md             # Known, deferred issues and small ideas (check before fixing a "new" nit)
    └── RULES.md               # Complete game rules
```

## Game Flow (Socket Events)

1. **Auth**: `signIn`/`signUp` → `signInResponse` (includes `blockedUsers`; `deleteAccount` → `deleteAccountResponse` for in-app account deletion, refused mid-game, the name then held 30 days; `changePassword` → `changePasswordResponse`, other devices signed out); `restoreSession` resumes a saved per-device token without a password (a failure with `retryable: true` keeps the token: `docs/claude/server-accounts.md`)
2. **Lobby**: `createLobby` / `joinLobby` → `lobbyCreated` → `playerReadyUpdate` → `allPlayersReady`
3. **Draw**: `startDraw` → `draw` → `playerDrew` → `teamsAnnounced`
4. **Bidding**: `gameStart` → `updateTurn` → `playerBid` → `bidReceived` → `doneBidding` (if both teams bid 0 there is no `doneBidding`: the server sends a log entry, `destroyHands` and a fresh `gameStart` for the redeal). A human bid turn idle for 10 s gets the bid clock (`bidClock`, unsequenced; the table plays a 30 s tune) and at 40 s the server bids 0 for the seat ("<name> ran out of time."; `server/CLAUDE.md`, Bid clock)
5. **Play**: `updateTurn` → `playCard` → `cardPlayed` → `trickComplete` → `handComplete` (then, for a set team, one stored room `gameLogEntry` with `fault {position, bid, took}` per player short of their own bid: the red "Fault: <name> (bid N, took M)" lines; `server/CLAUDE.md`, Hand-end log lines)
6. **End**: `gameEnd` (payload always includes `tournamentId`, null for casual games)
7. **Resync (snapshot v2)**: `requestSnapshot {requestId?, customPics?, log?}` → `stateSnapshot {snapshot, requestId?}` or `{snapshot: null, reason: 'not_in_game'}` (any seat owner, entrant or spectator; custom pictures only with `customPics: true`; `snapshot.partial` lists what was left out and the client keeps it — `mergeSnapshot`; `seq` on room broadcasts tells a v2 client when it missed something)
8. **Over the shoulder** (clientHello cap `shoulderView`; server, web and iOS (the build after 1.2.3 (30))): a pure spectator's `watchHand {gameId, position | null}` → `stateSnapshot {snapshot, reason: 'watchHand'}` with `viewer.shoulder {position, hand, hsi}` (viewer.position stays null) or `watchHandRefused {reason}` (never at tournament tables; an owner's other tab only its own seat); every deal's spectator `gameStart.shoulder`, the watched seat's hints as `assistHint {watched}`, `shoulder` on spectator entries (`docs/claude/spectators.md`, Over-the-shoulder view)

**Tournaments**: `createTournament`/`joinTournament` → `tournamentJoined` (the joiner) and `tournamentPlayerJoined {username, players, scoreboard}` (the members already there; `scoreboard` is additive, 2026-11-11, so an open lobby lists the joiner's row at once) → ready-up (the host may pick 1 to 5 rounds first, default 4: `setTournamentRounds {totalRounds}` → `tournamentSettingsUpdated {totalRounds, by}`, lobby phase only, `server/CLAUDE.md` Tournament lifecycle) → `beginTournament` → N rounds of games (`tournamentGameAssignment`, results via `tournamentGameComplete`/`tournamentRoundComplete`) → `beginNextRound` between rounds → after the last round, Cut for a buck (owner 2026-11-25: everyone still connected draws a card each round, the lowest is out, until one is left; phase 'cut', `cutForABuckStart` / `Round` / `Drew` / `Left` / `Reveal` / `Winner`, c2s `cutForABuckDraw`; only with a connected member who sent the clientHello cap `cutForABuck` (the web sends it: the ring of players around the deck in the tournament lobby, `docs/claude/web-client.md` "Cut for a buck, web"; iOS from build 41), else none and today's wire; `server/CLAUDE.md` Tournament lifecycle "Cut for a buck") → `tournamentComplete` (with `winners[]`, the top scorers when the last round completed, and `cutForABuck` when a cut ran), then its record in `tournamentRecords` (once; profiles show Tournaments played / won, Cut for a buck wins and the last 5 results; the Records page's Lucky Buck: `docs/claude/server-infra.md`, Tournament history). The creator may cancel in any phase (`cancelTournament` → `abortGame` at every running table, then `tournamentCancelled`). When the creator leaves or drops, the role passes to another member (`tournamentPlayerLeft {username, players, newCreator}`; every `players[]` carries `isCreator`), and both clients give the new host Begin / Cancel in place (web `TournamentLobby.addCreatorControls`, toast "You are now the tournament host" (never once the tournament is complete: no controls then either, `tournamentFinalHost.test.js`), iOS from 1.2.2 the same toast; tests `client/src/ui/screens/TournamentLobby.test.js`, `client/src/reload/tournamentHostHandoff.test.js`). Once begun, disconnected players are marked `connected: false` and reattach by username; in the lobby phase a disconnect is a leave, and both clients send `joinTournament` again after a restore (web from sessionStorage, iOS after 1.2.1 build 9 from memory) and come back as a new member, or land in the main room with a toast when refused; completed tournaments linger ~10 min so players can view results. Partners rotate (owner 2026-11-24): each round's tables and teams are planned so no member partners the same human twice when it can be avoided, and never in two rounds in a row they play (a bot partner never counts), and the pairings are shown openly (owner 2026-11-25: each round's tables as `pairings` on the tournament events, "Partners so far" on the tournament screen; never a whole-tournament chart) while the draw at a planned table decides only the seats and who deals first (the highest card's team at 1 & 3, that card at 1; `startDraw.teams` / snapshot `draw.teams`; each player the card they picked where every human and spectator there sent the clientHello cap `tournamentPairings`, else staged as before so shipped iOS builds stay consistent; `server/CLAUDE.md`, Tournament partners). Scoring (owner 2026-11-15): an aborted table scores the running score, a member who left it min(running, 0); a member who misses a round scores that round's lowest. Between rounds, 2 minutes after a round ends the host may begin with the ready members (the rest sit out; `readyDeadlinePassed`), a host idle 3 minutes while the others are ready hands the role on (`tournamentPlayerLeft {reason: 'hostIdle'}`), and past the deadline a host still idle 3 minutes after that hand-off gets the round started by the server with the ready members — `server/CLAUDE.md`, Tournament scoring / Tournament liveness. A connected player idle on their turn at a tournament table is never taken over automatically while another human is at the table: after the AFK timeout the others get the existing "Replace with Bot" offer (`resignationAvailable` with `idle: true`, private) and may `forceResign` it; the idle player acting first withdraws it (`playerReconnected`). A tournament table with nobody connected aborts after 60 s (casual solo tables wait 15 min). Details: `server/CLAUDE.md`, Seats and presence. Voice (owner 2026-11-24): a tournament table has whole-table voice as a casual game (its humans announced to each other at seating), and the tournament lobby / the time between rounds is one voice room of the members on that screen with the clientHello cap `tournamentVoice` (web now, iOS next build; at most `TOURNAMENT_VOICE_MAX`, default 8, clamped 2..20, the rest wait in line with the over-cap notice `tournamentVoiceStatus` for a client with that cap); never casual voice (`voiceSettings`, voice spectators) there (`docs/claude/voice.md`, Tournament voice).

**/help** (2026-11-18): a seat owner's `chatMessage '/help'` (or the exact line `?help`, for shipped iOS) on their turn → the bid or card a Mary bot would choose, privately (`assistHint` with the clientHello cap `assist`, else private unstored `gameLogEntry` lines); a counted use posts the room line "<name> used /help." (with `help {position}`: both clients draw it gold, 2026-11-23); 3 free per game, the 4th makes the game bot-assisted for that player (owner 2026-11-21: only a win goes to their `botStats`, a loss or tie stays in their human `stats`, so /help cannot carry a losing game off the leaderboard; the tutorial alike; `docs/claude/assist.md`). In a game with a native bot seat (lobby Add Bot, tournament filler, solo; never a lazy or resign bot: `assistState.isFreeHelpGame`) /help is unlimited and players see no count, limit or warning (`assistHint` / `viewer.assist` carry `unlimited: true`), the room notice stays and the record still marks more than 3 uses (owner 2026-11-19). Clients label the ask "Ask a bot for advice". **/tutorial** (2026-11-19, the lean scope with the fade-out): `/tutorial` toggles, `/tutorial on|off` sets (chatMessage; no `?tutorial`); while on, each own non-forced decision gets the same /help answer pushed (`assistHint source 'tutorial'`, never counted or announced) plus rule tips (`server/game/assist/curriculum.js`: one per own decision, one between, each once per game), fading out after the 2-card hand to tricky choices only; a new account's first game starts with it on for a client with the clientHello cap `tutorial` (`users.tutorial` 'pending', never at tournament tables); turning it on makes the game bot-assisted for that player (not an auto-start turned off before their first decision); s2c `assistState` (cap `tutorial`) and snapshot `viewer.assist.tutorial` carry the state (`docs/claude/assist.md`, The tutorial).

**Get Your Bid** (2026-11-24): a second game mode, a lobby option on the web and in iOS from 1.2.7 (41) (`createLobby {mode: 'gyb'}`, the clientHello cap `getYourBid`; never a tournament table, no stats; `iOSClient/CLAUDE.md`, iOS Get Your Bid). Three seats, no teams: exactly your bid scores 10 + the bid (an exact 0 scores 5), anything else nothing; no bores; on hands of 5 or more cards the last bidder may not make the bids add up to the hand (the Forbidden Bid, worth 1 point if taken anyway); all zeros is played, led by the first bidder. Same events, with additive `gyb` / `mode` keys (`server/CLAUDE.md`, Get Your Bid; `docs/claude/web-table.md`, Get Your Bid on the web).

**Badges** (2026-11-25; the web, and iOS from 1.2.7 (41)): 20 achievements a player earns in HUMAN games only (the leaderboard's rule: a seat whose stats go to `users.stats`; never a bot game, a /help-assisted win or a Get Your Bid game), and the skill badges only from bids and plays the player made themselves (owner 2026-11-25: never a lazy, AFK or resign bot's). Earned badges show on the profile pages below the statistics (the own profile and any player's; on iOS the Account sheet and the player profile sheet), and a game that newly earns one sends the private s2c `badgesAwarded {gameId, badges}` after its stats are written (a toast over the score screen); `profileResponse` / `playerProfileResponse` carry `badges` (earned only), all three only for the clientHello cap `badges`. A badge nobody earned is never shown or named: the catalog stays on the server (owner: "they should be a surprise"). Rules and catalog `server/game/badges.js`, awards `server/socket/badgeAwards.js`, art `client/assets/badges/<id>.svg` (`scripts/build-badges.py`, which also writes the iOS copies in `Misc.xcassets/Badges`), the owner-run backfill `scripts/backfill-badges.js` (`server/CLAUDE.md`, Badges; `docs/claude/web-client.md`, Badges and the Players page; `iOSClient/CLAUDE.md`, iOS badges).

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
npm run build:sounds # Table sound effects (macOS + numpy): client/assets/sounds/*.m4a and the same files in iOSClient/BABOnline/Resources/Sounds/ from sounds-src/ (scripts/build-sounds.py, incl. the synthesized bid clock tune bidclock.m4a; `-- --only bidclock[,name]` rebuilds just those and keeps every other file and manifest entry: AAC encodes differ across macOS versions; sounds:check = stale check, run by CI)

npm test             # Server tests (Jest)
npm run test:client  # Client tests (Vitest)
npm run sim          # Bot-vs-bot simulation (tuning/regression; see server/game/bot/sim/README.md)

npm run contract:gen        # regenerate events.schema.json + web/Swift constants from contract/src
npm run contract:check      # fail if a generated file is stale
npm run contract:fixtures   # rewrite contract/fixtures/v2 from real games
npm run contract:baseline -- --build <n>   # on every iOS upload: freeze that build's contract + decode floor (contract/baselines/README.md)
npm run test:contract       # 1500 chaos seeds + tournamentLifecycle + contract.test (also run with NODE_ENV=production)
npm run test:race           # BAB_PACING=zero: chaos (200) + tournamentLifecycle + harness A + budget with every delay 0 (CI)
# iOS compile check after touching SocketEvents.swift:
# xcodebuild -project iOSClient/BABOnline.xcodeproj -scheme BABOnline -destination 'id=<simulator>' -derivedDataPath <tmp>/dd CODE_SIGNING_ALLOWED=NO build
```

## Cross-client rules

- Card legality logic duplicated in `server/game/rules.js`, `client/src/rules/legality.js`, and `iOSClient/.../Rules/CardLegality.swift`; ONE case table, `contract/rules/legality-cases.json` (legal cards per position: trump not broken, trump-tight, must follow, joker as trump, HI-joker forcing, the no-trump hand; trick winners and over-trump rows), runs against all three (Jest `server/game/__tests__/legalityCases.test.js`, Vitest `client/src/rules/legalityCases.test.js` + `overTrump.test.js`, which also checks web against server on 5000 random positions, XCTest `LegalityCaseTableTests.swift` + `OverTrumpTests.swift`, read from the checkout). A rules row goes in the table, never in one copy's test
- One of each on the server (`server/game/rules.js`): `calculateScore` (handleHandComplete, playSearch.teamScore and the sim all score through it), `HAND_PROGRESSION` / `nextHandSize()` (handleHandComplete, BotStrategy, snapshotV2 `HAND_SEQUENCE`, the sim; `handProgression.test.js` holds the web `ranks.js` and iOS `CardConstants` / `HandSequence` copies to it); the stock avatar count 82 is `server/avatar/stockAvatars.js` (`randomStockPic`, `isStockPic`) and web `client/src/constants/avatars.js` (`stockAvatars.test.js` holds the web copy and the contract's profilePic bounds to it)
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
| /help and /tutorial (assist) | `docs/claude/assist.md` | `server/game/assist`: `curriculum` (the tutorial's tips, budget and fade-out), `seatView` (the only game reader), `advise` (Mary's bid or card), `explain` (words from the decision trace), copy rules, owner-review fixtures, coverage and threshold sims; `server/socket/assistHandlers.js`: /help and ?help, guards, cache, budget, counting (3 free, the 4th makes the game bot-assisted; unlimited with a native bot seat), the room notice, assistHint (cap `assist`) or private lines, the stats marker |
| Badges | `server/CLAUDE.md`, Badges; `docs/claude/web-client.md`, Badges and the Players page; `iOSClient/CLAUDE.md`, iOS badges | `game/badges.js` (catalog, `game.badgeTrack`, `gameBadges`), `statsDeltas.badges` / `overtrumped` on the record, `socket/badgeAwards.js` (guarded `$push` into `users.badges`, lifetime badges, `badgesAwarded`), the cap `badges`, merge carry-over, the backfill script |
| Socket rooms, draw watchdog | `server/CLAUDE.md`, Socket rooms and draw watchdog | `game:` / `tournament:` rooms; the 30 s auto-draw |
| Seats and presence | `server/CLAUDE.md`, Seats and presence | SeatState records, `playerGames`, /leave /lazy /active (incl. the iOS Leave alert: `LeaveAlertPresenter` UIAlertController, `LeaveOutcome`), grace / resign / abort, AFK, lazy rejoin |
| Lobby seats | `server/CLAUDE.md`, Lobby seats | one lobby seat per username, takeover, 30 s reload grace, `reconnecting` |
| Get Your Bid (3 players, no teams) | `server/CLAUDE.md`, Get Your Bid; `docs/claude/web-table.md`, Get Your Bid on the web; `contract/CLAUDE.md`, Get Your Bid | `gameMode.js`, `game.seatCount` instead of 4, `rules.gyb*`, `game.gyb`, the cap `getYourBid` and what a client without it never sees, the padded snapshot and the carriers' `gyb`, not saved / not recorded; web `GameState.mode`, `utils/positions.js` seat mapping, `computeTableLayout({solo})`, the three-score log header, the Forbidden Bid on the bid sheet |
| Cut for a buck (tournament finale) | `server/CLAUDE.md`, Tournament lifecycle "Cut for a buck"; `contract/README.md`, Cut for a buck; `docs/claude/web-client.md`, Cut for a buck, web | `game/cutForABuck.js` engine, `socket/cutForABuck.js` orchestration, cap `cutForABuck`, the no-cap projection to 'round_active', `finishTournament`, `finalWinners`, codec v2, `CUT_FOR_A_BUCK=off`; web `state/cutForABuck.js`, `ui/cut/` (ringLayout, CutForABuck, cutStore), the final lobby `FinalResultsCard` |
| Tournament history (records, profiles, Lucky Buck) | `docs/claude/server-infra.md`, Tournament history | `tournamentRecords` (`game/tournamentRecord.js`, `profileHandlers.recordTournament` / `tournamentProfile`), profile `tournaments` / `cutForABuck`, the Lucky Buck superlative (2 wins), admin rename / merge / delete (`admin/tournamentRecordNames.js`), web `ui/components/TournamentHistory.js` |
| Tournament lifecycle | `server/CLAUDE.md`, Tournament lifecycle | `tournament.epoch`, round start shape, cancel order, scores recorded once; partner rotation (`game/tournamentPartners.js`), pairings shown openly, the draw for first deal (honest with the cap `tournamentPairings`, else staged; `seatPlannedTeams`, `drawPositions`, `TOURNAMENT_HONEST_DRAW`) |
| Spectator badge and chat, over-the-shoulder view | `docs/claude/spectators.md` | `spectatorList()`, unsequenced `spectatorsUpdated`, web badge + spectator bubble, iOS 1.2.0; `watchHand` / `shoulderView` cap, the client spec |
| Ambient bot activity | `server/demo/CLAUDE.md` | on-demand demo game, idle rules, `AMBIENT_CHAT_USERS` (test1): who sees the bot chat AND the demo game (lists, spectate, demand) |
| Sessions and socket identity | `docs/claude/server-accounts.md`, Sessions and socket identity | per-device tokens, one live socket, supersede / parked tabs, `releaseIdentity` |
| Username rules, password hashing, sign-in throttle | `docs/claude/server-accounts.md` | sign-up name rules and budgets (per socket, per IP, server-wide), bcrypt worker pool, failed-sign-in limits + client IP |
| Database, caches, limits, CI, deploys | `docs/claude/server-infra.md` | `.railway/railway.ts` service settings (wait for CI, `/ready` healthcheck, `PORT=3000`, how to plan/apply), crash exit codes, `safeTimer`, `/health` counts, `LOG_LEVEL`; startup DB + indexes, 5 s server selection timeout, what CI runs (`ci-boot-check.sh`, `REQUIRE_REAL_MONGO`), active-game writes, projected reads, stats scopes (human `stats` / bot-game `botStats`, `withBots` records, `{scope}` reads), profile caches per scope, soft limits |
| Backups and restore | `docs/claude/server-infra.md`, Backups and restore | Railway volume backups (dashboard: schedules, retention, restore = new volume + DB redeploy); owner-run `scripts/backup-db.js` (mongodump archive, never in a repo, URI via `railway run`) and `scripts/restore-db.js` (local by default, `--into-db` scratch copy, `--i-mean-production` + typed name); copying one document back; what a full restore loses; the drill checklist; the scheduled-backup proposal. Stats are `$inc` counters and deletes are final: only backups undo them |
| Express pages, avatars | `docs/claude/server-infra.md` | /privacy /support /terms; avatar pipeline, `clientHello` caps, kill switches |
| Client error reports | `docs/claude/server-infra.md`, Client error reports | c2s `clientError` (web `telemetry/clientErrors.js`, iOS `ErrorReporter.swift` next build), limits, scrubbing, `CLIENT_ERRORS=off` |
| Voice | `docs/claude/voice.md` | signaling checks (peers, blocks, limits), Cloudflare TURN minting, web/iOS restart rules, web voice keys (hold `` ` `` for the overlay, M mute), no voice alone (voice only with another human; `seatLeft`), tournament voice (`server/voice/tournamentVoice.js`: the table at seating, the tournament lobby room, cap `tournamentVoice`) |
| Merged accounts, admin panel, reset links, deletion | `server/admin/CLAUDE.md` | tombstones, `adminRequest` authorization + audit, merge / delete / rename, one-time reset links |
| Account Admin CLIs | `server/admin/CLAUDE.md`, Account Admin | owner-run `scripts/` against production; the database is `DB_NAME`, else `babonline` (never the MONGO_URI path) |
| Socket contract | `contract/CLAUDE.md`, Socket contract | `contract/src`, `npm run contract:gen`, contract guard, additive-only wire, `contract/V1_REMOVALS.md` |
| Snapshot v2, `seq` | `contract/CLAUDE.md` | `getSnapshotV2`, `trickHistory`, `watching`; seq stamping, consumer rules R1-R5 |
| Upgrade gate | `contract/CLAUDE.md`, Upgrade gate | iOS 1.0.0 / 1.1.0 detection by User-Agent (`MIN_IOS_BUILD` 3, raised and never lowered by the env `BAB_MIN_IOS_BUILD`), update-only replies, `updateRequired` (build 41's update screen), `UPGRADE_GATE=off` |
| iOS reconnect, table store | `iOSClient/CLAUDE.md` | `forceReconnect` builds a new manager, a foreground keeps a live one (`resumeAfterKeepAlive` probe), session gate, lobby and tournament-lobby re-entry after a restore (`RestoreRoute`); TableReducer store, iOS fixtures; its intro lists iOS topics kept in other files (Leave alert, voice, spectators) |
| iOS admin panel (1.2.2) | `iOSClient/CLAUDE.md`, iOS admin panel | `AuthState.isAdmin` entry in the Account sheet, `AdminApi` (adminRequest / adminResponse), `AdminState`, typed confirmations, reset link, `-uiAdmin` fixtures |
| iOS project, builds, releases | `iOSClient/CLAUDE.md`, iOS project | hand-kept xcodeproj, synchronized folders, versions 1.1.0 / 1.2.0 (6, live) / 1.2.1 (9) and what each build adds (1.2.0 bot seats: `positionUpdate.isBot`, `bot:` socket-id fallback), dSYM warning |
| Play again (after a lobby-born casual game) | `server/CLAUDE.md`, Lobby seats ("Play again"); `docs/claude/web-client.md`, Play again; `docs/claude/voice.md`, Play again voice | the `playAgain` cap, `lobbyReturn`, holds / reservations, the score modal kept until Return to Lobby, `releaseLobbyHold` |
| Family lobbies (up to 8), spectator voice | `server/CLAUDE.md`, Lobby seats; `docs/claude/web-client.md`, Family lobbies; `docs/claude/voice.md`, Spectator voice | the `casualSpectators` cap, `members` / `capacity`, the host's "Spectators can talk", extras at CREATED, listen-only voice, `voiceSettings` |
| Web client architecture | `docs/claude/web-client.md`, Architecture | ClientSession screen FSM, SocketManager ping, reconnect order |
| Web stay signed in, delivery, screens, phone gate | `docs/claude/web-client.md` | session storage, `staticAssets.js` + CSP + restart notice, `.screen--full`, phone gate |
| Web table, layout, design system | `docs/claude/web-table.md` | GameState one writer, SeqGate, TableDirector, MyAction; `computeTableLayout`, `GameScene.relayout()` and its tests (`computeTableLayout.test.js`, `relayout.test.js` mid-deal / mid-trick); tokens + kit; keyboard card play (`ui/handA11y.js`: hand toolbar, announcer) |
| Web table sound effects | `docs/claude/web-table.md`, Web table sound | `audio/SoundManager.js` (own AudioContext, gesture unlock, `bab.sound` mute, throttle), `audio/tableSounds.js` event map, silent on snapshot / SeqGate replay (the bid clock's tune excepted: `_syncTune`, end-aligned, rings out on a timeout), `SoundToggle` in the voice row + main room; the bidder's countdown is `BidManager.syncClock` (`state/bidClock.js`) |

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
