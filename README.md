# BAB Online

A 4-player online multiplayer trick-taking card game built with Phaser 3, SpriteKit, and Socket.IO.

## Game Overview

BAB is a partnership trick-taking game where players bid on tricks and score points based on their performance. Players are divided into two teams (positions 1 & 3 vs positions 2 & 4) and compete across multiple hands.

For complete game rules including bidding, scoring, and special mechanics, see [docs/RULES.md](docs/RULES.md).

## Tech Stack

| Layer | Technology |
|-------|------------|
| Web Frontend | Phaser 3.55.2, ES6 Modules, Socket.IO Client 4.0.1 |
| iOS Client | SwiftUI, SpriteKit, Socket.IO-Client-Swift 16, Combine |
| Build | Vite (web), Xcode 16+ (iOS) |
| Backend | Node.js 18+, Express.js 4.21.2, Socket.IO 4.8.1 |
| Database | MongoDB (native driver) — `users`, `gameRecords`, `reports` collections |
| Security | Helmet, bcryptjs |
| Testing | Vitest (client), Jest (server) |
| Deployment | Railway.app |

## Getting Started

### Prerequisites
- Node.js 18+
- MongoDB (local or Atlas)
- Xcode 16+ (for iOS client)

### Installation

```bash
# Clone the repository
git clone https://github.com/dannytakahashi/bab-online.git
cd bab-online

# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Edit .env with your MongoDB connection string

# Start development server
npm run dev
```

### iOS Client

Open `iOSClient/BABOnline.xcodeproj` in Xcode 16 or later, select your target device (iOS 17+), and build. Command-line compile check (no signing):

```bash
xcodebuild -project iOSClient/BABOnline.xcodeproj -scheme BABOnline \
  -destination 'platform=iOS Simulator,name=<simulator>' -derivedDataPath /tmp/bab-dd \
  CODE_SIGNING_ALLOWED=NO build
```

#### iOS project layout

The committed `iOSClient/BABOnline.xcodeproj` is the only source of project configuration (signing team, bundle id, versions, entitlements, Info.plist keys, Swift packages). There is no XcodeGen or other generator. Change settings in Xcode or in `project.pbxproj`, and commit the result.

- `iOSClient/BABOnline/` is a **folder synchronized with the BABOnline target** (Xcode 16 `PBXFileSystemSynchronizedRootGroup`, project format `objectVersion = 77`). To add Swift files, folders or asset catalogs, put them under that folder. They are part of the app with no project-file edit.
- Every file in that folder becomes a target member by type. `.swift` files are compiled, and anything else (asset catalogs, JSON, images, even a stray `README.md`) is copied into the app bundle. To keep a file out of the target, put it outside `iOSClient/BABOnline/` (like `iOSClient/generate_icon.swift`), or untick its Target Membership in Xcode's File inspector. That adds it to the folder's exception set.
- `Info.plist` and `BABOnline.entitlements` are in that exception set (`membershipExceptions` of the `PBXFileSystemSynchronizedBuildFileExceptionSet`). They are used through `INFOPLIST_FILE` / `CODE_SIGN_ENTITLEMENTS` and are never bundle resources. Keep them there.
- Swift packages: socket.io-client-swift (up to next major from 16.1.1) and stasel/WebRTC (exactly 140.0.0). `Package.resolved` is generated under `BABOnline.xcodeproj/project.xcworkspace/` and is not committed.

#### Tests (BABOnlineTests)

`BABOnlineTests` is a unit-test bundle hosted in the app, in its own synchronized folder `iOSClient/BABOnlineTests/` (a new test file there needs no project edit). The shared scheme `BABOnline.xcodeproj/xcshareddata/xcschemes/BABOnline.xcscheme` runs it:

```bash
xcodebuild -project iOSClient/BABOnline.xcodeproj -scheme BABOnline \
  -destination 'platform=iOS Simulator,name=<simulator>' -derivedDataPath /tmp/bab-dd \
  CODE_SIGNING_ALLOWED=NO test
```

- Tests reach app code with `@testable import BAB_Online` (module name from the product name "BAB Online"). Only Debug sets `ENABLE_TESTABILITY = YES`, so tests run in Debug.
- Hosted tests launch the whole app. `BABOnlineApp.setupSocket()` returns early when `XCTestConfigurationFilePath` is set, so a test run never connects or signs in. `xcodebuild test` replaces the installed `com.bab-online.BABOnline` on the chosen simulator.
- Fixtures: the contract snapshot fixtures are bundled through a **folder reference** to `contract/fixtures/v2` (it keeps the `v2/` subdirectory: `Bundle(for:).url(forResource:withExtension:subdirectory: "v2")`). Files under `iOSClient/BABOnlineTests/` (e.g. the recorded event logs in `Fixtures/events/`, `npm run ios:fixtures`) are flattened into the bundle root, so **every fixture basename must be unique**; a duplicate fails the build with "Multiple commands produce".
- The UI-test bundle `BABOnlineUITests` was added the same way (a sibling synchronized folder, `TEST_TARGET_NAME = BABOnline`, a non-parallel Testable in the shared scheme). The scheme's Test action has two test plans (`iOSClient/BABOnline.xctestplan`, the default: unit tests only, so a plain `xcodebuild test` stays about 30 s; `iOSClient/BABOnlineUI.xctestplan`: the UI tests, run with `-testPlan BABOnlineUI`). A new test target goes into one of the plans.

#### UI tests and screenshots (BABOnlineUITests)

Debug builds have a fixture mode: `-uiFixture <name>` (a launch argument) seeds the app from `contract/fixtures/v2/<name>.json` (bundled into the Debug app only), or from the `UI_FIXTURE_SNAPSHOT` environment JSON, and never connects (no socket, no voice, avatars show initials). `game-end` adds a gameEnd to `hand-resolving`; `main-room`, `game-lobby`, `tournament-lobby` and `sign-in` show static screens; `-uiFold book|tabletop` simulates a Duo fold region. `-uiEffect rainbow|b|2b|3b|4b|ot|all` holds the table effects on screen (screenshots of the art). Release builds compile it out (`#if DEBUG`, and `EXCLUDED_SOURCE_FILE_NAMES = v2`).

`FixtureScreenshotTests` launches each fixture and keeps an XCUIScreen screenshot of every display, named `<pose>-<fixture>-screen<i>-<WxH>`; the pose comes from the app's `ui.pose` probe (466x678 `closed`, 669x951 `open-portrait`, 951x669 `open-landscape` on the iPhone Duo). The Duo's pose cannot be scripted: set it by hand in Device Hub (Xcode > Open Developer Tool > Device Hub, posture control), then run with the expected pose:

```bash
iOSClient/scripts/ios-screenshots.sh --status-bar <duo udid> set      # 9:41, full bars (App Store look)
TEST_RUNNER_BAB_POSE=closed xcodebuild -project iOSClient/BABOnline.xcodeproj -scheme BABOnline \
  -destination 'id=<duo udid>' -derivedDataPath /tmp/bab-dd CODE_SIGNING_ALLOWED=NO \
  test -testPlan BABOnlineUI -resultBundlePath /tmp/ui-closed.xcresult
iOSClient/scripts/ios-screenshots.sh --status-bar <duo udid> clear
iOSClient/scripts/ios-screenshots.sh /tmp/ui-closed.xcresult /tmp/shots/closed      # export + rename the attachments
iOSClient/scripts/ios-screenshots.sh --simctl <udid> /tmp/shots/raw trick-mid-lead3 bidding-mid   # no XCTest: simctl io of both displays (exact 2007 x 2853)
```

Fixture mode never opens a socket (every connect path, foreground and Settings included, checks `SocketService.connectionsDisabled`) and never starts voice or asks for the microphone (`VoiceChatManager.voiceDisabled`, also in Xcode previews), so a fresh simulator shows no permission alert.

`LobbyControlsTests` checks the main room's and the lobbies' header controls: each exists once, and on the Duo (vertical bar) they are in the side column with no content control reaching into it; it also checks that the lobby chat is right of the players on regular width (iPad, open Duo) and under them on compact. `RotationTests` (iPad only) rotates mid-hand and checks the `table.layoutCheck` / `table.state` probes. `DraftRotationTests` types in the main-room chat and rotates; it skips on a window that cannot rotate (a phone, the closed Duo). `PoseChangeTests` is opt-in (`TEST_RUNNER_BAB_POSE_CHANGE=1`): it lifts a card or selects a bid, then waits up to 120 s for you to fold or unfold the Duo in Device Hub and checks that the state survived. Screenshots are review material; keep them out of the repo.

#### Releasing (App Store)

- **Version**: bump `MARKETING_VERSION` (e.g. 1.1.0) and `CURRENT_PROJECT_VERSION` (the build number, +1 for every upload, even of the same version) in the BABOnline target's Debug and Release configurations (Xcode: target > General > Identity, or `project.pbxproj`); the test targets are kept in step. Never put literal versions in `Info.plist`: it reads `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`. `ReleaseMetadataTests` fails if the plist goes back to a literal "1.0".
- **Archive**: Xcode > scheme BABOnline > Any iOS Device (arm64) > Product > Archive (Release, automatic signing, team 9SYNY7K2HE), then Organizer > Distribute App > App Store Connect. Check first without signing: `xcodebuild -project iOSClient/BABOnline.xcodeproj -scheme BABOnline -configuration Release -destination 'generic/platform=iOS' -derivedDataPath /tmp/bab-dd -archivePath /tmp/BABOnline.xcarchive CODE_SIGNING_ALLOWED=NO archive`, then `/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "/tmp/BABOnline.xcarchive/Products/Applications/BAB Online.app/Info.plist"` (and `CFBundleVersion`). Expected noise: the AppIntents "Metadata extraction skipped" note at build and the missing WebRTC dSYM warning at upload.
- **Export compliance**: `ITSAppUsesNonExemptEncryption = NO` in `Info.plist` (HTTPS and WebRTC's standard DTLS/SRTP only), so App Store Connect does not ask on each upload. Revisit it if the app ever adds its own cryptography.
- **Privacy manifest**: `iOSClient/BABOnline/PrivacyInfo.xcprivacy` (bundled at the app root by the synchronized folder). No tracking; collected data: User ID (the username, sign-in/sign-up/restoreSession), Other User Content (chat messages, report reasons and the reported message), Gameplay Content (bids, plays, game records), all linked to the user, App Functionality only. Voice is peer to peer (STUN only, no TURN relay; the server relays signaling only) and the iOS app has no photo upload. No required-reason APIs in release code (`UserDefaults` is used only by the `#if DEBUG` fixture mode); WebRTC.framework and Starscream ship their own manifests. Update the manifest, and the App Privacy answers in App Store Connect, when the app starts sending new data or calls a required-reason API (UserDefaults, file timestamps, system boot time, disk space, active keyboards), including through a new package; Xcode's Organizer > Generate Privacy Report on the archive shows the combined result.
- **Usage strings**: `NSMicrophoneUsageDescription` (voice chat). `NSCameraUsageDescription` stays although the app never opens the camera: WebRTC.framework links `AVCaptureDevice`, and App Store Connect rejects an upload whose binary references camera APIs without the string. No background modes; the only entitlement is `webcredentials:babonline.io` (served by `/.well-known/apple-app-site-association`). The ATS exception (`NSAllowsLocalNetworking`, `localhost`) only affects simulator builds, which talk to `localhost:3000`.
- **TestFlight checks before submitting**: stay signed in across a force-quit and relaunch (Keychain token restore); the microphone prompt and voice on rejoining a game; one hand against staging for the pacing feel-check in CLAUDE.md (bot cards 0.3-0.75 s apart, trick view 1.1 s, bot lead 0.6 s after the collect, next hand 1.0 s after the last trick, teams overlay readable).

### Environment Variables

```bash
NODE_ENV=development
PORT=3000
MONGO_URI=mongodb://localhost:27017/bab-online
```

## Project Structure

```
bab-online/
├── client/                            # Web client (Phaser + Vite)
│   ├── src/
│   │   ├── main.js                    # Entry point
│   │   ├── constants/                 # events.js, ranks.js
│   │   ├── utils/                     # positions.js, cards.js, colors.js
│   │   ├── rules/                     # legality.js - card play validation
│   │   ├── state/                     # GameState.js - client state singleton
│   │   ├── socket/                    # SocketManager.js - connection management
│   │   ├── handlers/                  # Socket event handlers (auth, game, chat, lobby, profile, leaderboard, tournament)
│   │   ├── phaser/
│   │   │   ├── config.js              # Phaser game configuration
│   │   │   ├── PhaserGame.js          # Game instance wrapper
│   │   │   ├── scenes/                # GameScene.js
│   │   │   └── managers/              # CardManager, TrickManager, BidManager, etc.
│   │   └── ui/
│   │       ├── UIManager.js           # DOM lifecycle management
│   │       ├── components/            # Modal, Toast, BidUI, GameLog, TournamentScoreboard
│   │       └── screens/               # SignIn, Register, MainRoom, GameLobby, TournamentLobby, ProfilePage, LeaderboardPage
│   ├── styles/
│   │   └── components.css             # UI component styles
│   ├── assets/                        # Card images, backgrounds
│   ├── vite.config.js                 # Vite build configuration
│   └── index.html                     # Entry point
├── iOSClient/BABOnline/               # iOS client (SwiftUI + SpriteKit)
│   ├── BABOnlineApp.swift             # App entry point
│   ├── ContentView.swift              # Root view switch + session restore
│   ├── Constants/                     # CardConstants, LayoutConstants, SocketEvents
│   ├── Models/                        # Card, ChatMessage, Lobby, Player, ScoreData, Tournament
│   ├── Networking/
│   │   ├── SocketService.swift        # Socket.IO connection management
│   │   ├── Emitters/                  # Auth, Chat, Game, Lobby, Tournament, Safety emitters
│   │   └── Handlers/                  # Auth, Chat, Game, Lobby, Tournament, Safety socket handlers
│   ├── State/                         # AuthState, GameState, LobbyState, MainRoomState, TournamentState, SafetyState
│   ├── SpriteKit/
│   │   ├── GameSKScene.swift          # Main game scene
│   │   ├── Managers/                  # Card, Trick, Bid, Draw, Opponent, Effects managers
│   │   └── Nodes/                     # CardSprite, HandNode, TrickArea, BidBubble, etc.
│   └── Views/
│       ├── Auth/                      # SignInView, RegisterView
│       ├── Components/                # ConnectionStatusToast, SafetyMenus (report/block)
│       ├── Game/                      # GameContainerView, BidOverlay, DrawPhase, GameEnd, GameLog, ScoreBar
│       ├── GameLobby/                 # GameLobbyView, LobbyChatView, LobbyPlayerRow
│       ├── MainRoom/                  # MainRoomView, MainRoomChatView, LobbyListView, AccountSettingsView
│       └── Tournament/                # TournamentLobby, PlayerList, Chat, Scoreboard, ActiveGames, Results
├── server/
│   ├── index.js                       # Entry point
│   ├── config/
│   │   └── index.js                   # Server configuration
│   ├── game/
│   │   ├── Deck.js                    # Card deck management
│   │   ├── GameState.js               # Game state + room management
│   │   ├── GameManager.js             # Multi-game and tournament coordination
│   │   ├── TournamentState.js         # Per-tournament state + round management
│   │   ├── rules.js                   # Pure game logic functions
│   │   └── bot/                       # Bot player system
│   │       ├── BotPlayer.js           # Bot player class with card memory
│   │       ├── BotController.js       # Bot lifecycle and personality hooks
│   │       ├── BotStrategy.js         # AI strategy (contract-aware, card-counting)
│   │       ├── personalities.js       # Personality registry (bid + play styles)
│   │       ├── sim/                   # Bot-vs-bot simulation harness (npm run sim)
│   │       └── __tests__/             # Strategy tests + legality fuzz suite
│   ├── socket/
│   │   ├── index.js                   # Socket event routing
│   │   ├── authHandlers.js            # Auth events + account deletion
│   │   ├── mainRoomHandlers.js        # Main room & lobby browser
│   │   ├── queueHandlers.js           # Matchmaking events
│   │   ├── lobbyHandlers.js           # Game lobby events
│   │   ├── gameHandlers.js            # Game events
│   │   ├── reconnectHandlers.js       # Reconnection logic
│   │   ├── chatHandlers.js            # Chat events
│   │   ├── profileHandlers.js         # Profile and leaderboard events
│   │   ├── tournamentHandlers.js      # Tournament lifecycle events
│   │   ├── safetyHandlers.js          # Report / block / unblock users
│   │   ├── validators.js              # Joi validation schemas
│   │   ├── errorHandler.js            # Handler wrappers
│   │   └── rateLimiter.js             # Per-socket rate limiting
│   ├── routes/
│   │   └── index.js                   # Express routes
│   ├── middleware/
│   │   └── requestLogger.js           # Request logging
│   ├── utils/
│   │   ├── timing.js                  # Async timing utilities
│   │   ├── logger.js                  # Winston logger
│   │   ├── errors.js                  # Custom error classes
│   │   ├── profanityFilter.js         # UGC filter (chat, usernames, lobby names)
│   │   └── shutdown.js                # Graceful shutdown
│   └── database.js                    # MongoDB connection
├── docs/
│   ├── RULES.md                       # Complete game rules
│   ├── bot-strategy-guide.md          # Bot strategy reference
│   └── todos/                         # Improvement roadmap
├── scripts/
│   └── build-atlas.js                 # Sprite atlas builder
├── .github/
│   └── workflows/ci.yml              # GitHub Actions CI
├── package.json
├── docker-compose.yml
└── .env.example
```

## Development

```bash
# Start with hot reload (server + client)
npm run dev

# Start production server
npm start

# Run server tests (Jest)
npm test

# Run client tests (Vitest)
npm run test:client

# Bot-vs-bot simulation: benchmarks strategy changes against a frozen
# baseline and validates every bot decision against the rules engine
npm run sim

# Vite dev server only (port 5173, proxies to :3000)
npm run dev:client

# Build client
npm run build:client

# Build sprite atlas
npm run build:atlas
```

The server runs on `http://localhost:3000` by default.

**Ambient bot activity**: in production the server keeps one bot-vs-bot game running (spectatable from the main room) and seeds the global chat with bot-persona messages, so new players never land in an empty room. Control with `AMBIENT_BOTS=true|false` (default: on in production, off in development).

## How to Play

1. **Sign up/Sign in** - Create an account (auto-logs in) or log in
2. **Main Room** - Chat globally, browse game lobbies, create a new game, or create/join a tournament
3. **Game Lobby** - Wait for 4 players, chat, and click "Ready" when prepared
   - Click "+ Add Bot" to add AI players (up to 3 bots with unique personalities)
   - Bot names are hidden in lobby and revealed at game start
   - Personalities: Mary (balanced), Sharon (conservative), Danny (calculated risk-taker), Mike (overconfident), Zach (adaptive)
   - Click "✕" next to a bot to remove it before readying up
   - Bots auto-ready when lobby is full
4. **Draw Phase** - Draw cards from deck to determine seating positions; teams announced
5. **Bidding** - Bid on how many tricks your team will take
6. **Play** - Take turns playing cards, following suit when possible
7. **Score** - Points awarded based on bids vs tricks taken (shown in game log)

### Mid-Game Commands

Type these in the game log chat input (autocomplete appears when you type `/`):

| Command | Effect |
|---------|--------|
| `/lazy` | A bot takes over for you temporarily. You stay in the game as a spectator. |
| `/active` | Take back control from the bot. |
| `/leave` | Bot takes over and you exit to the main lobby. You can rejoin later. |

### Spectating

Browse in-progress games in the main room lobby panel and click **Spectate** to watch. Spectators can see tricks, bids, scores, and chat — but not player hands. Spectators only see `/leave` in autocomplete; `/lazy` and `/active` are silently ignored.

### Disconnection & Resignation

If a player disconnects, a 60-second grace period starts. If they don't return, any remaining player can click to replace them with a bot. The game only aborts if all human players disconnect.

### Tournaments

Create a tournament from the main room to compete across 4 rounds of randomly-assigned games:

1. Click **Create Tournament** — opens a tournament lobby (unbounded player count)
2. Other players click **Join** on the tournament listing in the main room (joining is only open before the tournament starts)
3. All players ready up, then the creator clicks **Begin Tournament**
4. Players are shuffled and divided into games of 4 (bots fill remaining slots)
5. Play a normal game — when it ends, click **Return to Tournament** to see the scoreboard
6. Ready up again for the next round (4 rounds total)
7. After round 4, the player with the highest cumulative score wins (ties produce co-winners)

Each player's round score is their team's final score from that round's game. Spectators can watch tournament games in progress from the tournament lobby. Disconnecting mid-tournament doesn't forfeit your seat — your scores are kept and you're re-attached when you reconnect; disconnected players just sit out rounds until they return. Final standings stay viewable for ~10 minutes after the tournament completes.

### Safety & Account Management

- All chat (main room, lobby, in-game, tournament), usernames, and lobby names are profanity-filtered server-side.
- **Report or block any player**: on iOS, long-press a chat message; on web, open a player's profile (leaderboard/search) for Report/Block buttons. Blocking hides that user's messages everywhere and persists across sessions; manage blocks on iOS under Account Settings → Blocked Users.
- **Sign out / delete account**: on iOS, main room gear icon → Account Settings; on web, your profile page. Account deletion confirms with your password, removes the account and stats immediately, and anonymizes the username in match records.
- Legal pages served by the app: `/privacy`, `/terms`, `/support`.

### Card Rankings
- High Joker (highest)
- Low Joker
- A, K, Q, J, 10, 9, 8, 7, 6, 5, 4, 3, 2

Trump suit beats all other suits. Must follow suit if possible.

## Architecture

### Communication Flow
```
Web Client (Phaser/ES6)  ←→ Socket.IO ←→ Server (Node/Express) ←→ MongoDB
iOS Client (SwiftUI/SK)  ←→ Socket.IO ←↗
```

### Server Architecture

The server uses a modular architecture with clear separation of concerns:

- **GameManager** - Singleton managing queue, active games, tournaments, and in-progress game listing
- **GameState** - Encapsulated state for each game instance (includes resignation, lazy mode, and spectator tracking)
- **TournamentState** - Per-tournament state managing players, rounds, scoring, and game distribution
- **Deck** - Card deck with Fisher-Yates shuffle
- **rules.js** - Pure functions for game logic (testable)
- **BotController / BotStrategy** - AI bot system: contract-aware card play (bore execution/defense, set denial), card-counting trick play, hand-size-aware bidding, card memory, and in-game chat. Five personalities layer measured bid/play variations over the optimal "Mary" baseline; strategy changes are benchmarked with the simulation harness (`npm run sim`) against a frozen snapshot
- **Socket handlers** - Organized by domain (auth, queue, game, chat, profile, reconnect, tournament)

### Web Client Architecture

The web client uses ES6 modules with Vite bundling and proper lifecycle management:

- **SocketManager** - Tracks listeners for cleanup (prevents memory leaks)
- **GameState** - Single source of truth (replaces 50+ globals)
- **GameScene** - Main Phaser scene coordinating all game visuals
- **Phaser Managers** - Specialized managers for different game aspects:
  - CardManager, TrickManager, BidManager, DrawManager
  - OpponentManager, EffectsManager, LayoutManager
- **UIManager** - DOM element lifecycle management
- **Handler Modules** - Socket event handlers (auth, game, chat, lobby, tournament)

### iOS Client Architecture

The iOS client uses SwiftUI for UI and SpriteKit for the game canvas:

- **SwiftUI Views** - Screen navigation, overlays (bid, score, draw phase, game end, disconnect banner)
- **SpriteKit GameSKScene** - Main game scene subscribing to GameState via Combine
- **SK Managers** - Mirror the web client's Phaser managers (SKCardManager, SKTrickManager, etc.)
- **State Objects** - `@Published` properties on ObservableObject classes, injected as `@EnvironmentObject`
- **SocketService** - Socket.IO connection with `forceReconnect()` on app foreground
- **Emitters / Handlers** - Static emitter methods and handler classes matching the web client's socket event structure

### Key Socket Events

| Client → Server | Description |
|-----------------|-------------|
| `signIn` | Authenticate user |
| `joinQueue` | Enter matchmaking / join lobby |
| `playerReady` | Mark ready in lobby |
| `lobbyChat` | Send lobby chat message |
| `leaveLobby` | Leave lobby before game starts |
| `addBot` | Add bot player to lobby |
| `removeBot` | Remove bot from lobby |
| `draw` | Draw card during draw phase |
| `playerBid` | Submit bid |
| `playCard` | Play a card |
| `chatMessage` | Send in-game chat (also handles `/lazy`, `/active`, `/leave`) |
| `rejoinGame` | Reconnect to game after disconnect |
| `forceResign` | Replace disconnected player with a bot |
| `joinAsSpectator` | Join an in-progress game as spectator |
| `getProfile` | Fetch user profile and stats |
| `updateProfilePic` | Change profile picture |
| `getLeaderboard` | Fetch leaderboard data |
| `createTournament` | Create a new tournament lobby |
| `joinTournament` | Join an existing tournament |
| `leaveTournament` | Leave a tournament |
| `tournamentReady` | Mark ready in tournament lobby |
| `beginTournament` | Start round 1 (creator only) |
| `beginNextRound` | Start rounds 2-4 (creator only) |
| `returnToTournament` | Return to tournament lobby after game |
| `deleteAccount` | Permanently delete account (password re-confirm) |
| `reportUser` | Report a user (stored for review) |
| `blockUser` / `unblockUser` | Manage personal block list |

| Server → Client | Description |
|-----------------|-------------|
| `lobbyCreated` | Joined lobby with player list |
| `playerReadyUpdate` | Player ready status changed |
| `lobbyMessage` | Lobby chat message received |
| `allPlayersReady` | All 4 players ready, transitioning |
| `startDraw` | Draw phase begins |
| `playerDrew` | Player drew a card (visible to all) |
| `teamsAnnounced` | Teams announced after draw |
| `gameStart` | Game begins with hand dealt |
| `bidReceived` | Player bid received |
| `cardPlayed` | Card was played |
| `trickComplete` | Trick finished |
| `handComplete` | Hand finished |
| `updateTurn` | Turn changed |
| `gameEnd` | Game finished with final scores |
| `rejoinSuccess` | Successfully reconnected to game |
| `activeGameFound` | Active game found on sign-in |
| `resignationAvailable` | Disconnected player's grace period expired |
| `playerResigned` | Player replaced by bot |
| `playerLazyMode` | Player entered lazy mode (bot playing) |
| `playerActiveMode` | Player took back control from bot |
| `spectatorJoined` | Spectator joined the game |
| `profileResponse` | User profile data |
| `leaderboardResponse` | Leaderboard data |
| `tournamentCreated` | Tournament created, show lobby |
| `tournamentJoined` | Joined tournament, show lobby |
| `tournamentRoundStart` | Round started, games being created |
| `tournamentGameAssignment` | Player assigned to a game |
| `tournamentGameComplete` | A game in the round finished |
| `tournamentRoundComplete` | All games in round finished |
| `tournamentComplete` | Tournament finished, final results (`winners[]` includes ties) |
| `deleteAccountResponse` | Account deletion result |
| `reportUserResponse` | Report acknowledgement |
| `blockListUpdated` | Current block list after block/unblock |

## Docker

```bash
# Start with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f app

# Stop services
docker-compose down

# Rebuild after changes
docker-compose up -d --build
```
