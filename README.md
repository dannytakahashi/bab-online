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

Debug builds have a fixture mode: `-uiFixture <name>` (a launch argument) seeds the app from `contract/fixtures/v2/<name>.json` (bundled into the Debug app only), or from the `UI_FIXTURE_SNAPSHOT` environment JSON, and never connects (no socket, no voice, avatars show initials). `game-end` adds a gameEnd (with each player's stats) to `hand-resolving`, `game-end-spectator` to `spectator-mid-hand`, `game-end-tournament` to `tournament-game` (`-uiNoEndStats YES`: a gameEnd without the stats, as from an older server); `main-room`, `game-lobby`, `game-lobby-bots` (two bots that are not ready; removeBot / addBot answered as the server would), `tournament-lobby` and `sign-in` show static screens; `-uiFold book|tabletop` simulates a Duo fold region. `-uiEffect rainbow|b|2b|3b|4b|ot|all` holds the table effects on screen (screenshots of the art). The main room's Stats sheet answers itself in fixture mode (`Debug/UIFixture+Stats.swift`, wire-shaped replies through the real decoding); `-uiStats ok|empty|error|rateLimited|silent|refreshFail` picks the replies (`silent` never answers: the 10 s timeout). Release builds compile it out (`#if DEBUG`, and `EXCLUDED_SOURCE_FILE_NAMES = v2`).

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

`LobbyControlsTests` checks the main room's and the lobbies' header controls: each exists once, and on the Duo (vertical bar) they are in the side column with no content control reaching into it; it also checks that the lobby chat is right of the players on regular width (iPad, open Duo) and under them on compact. `RotationTests` (iPad only) rotates mid-hand and checks the `table.layoutCheck` / `table.state` probes. `DraftRotationTests` types in the main-room chat and rotates; it skips on a window that cannot rotate (a phone, the closed Duo). `StatsUITests` opens the Stats sheet from `main-room` and checks the Leaderboard tab (the web's columns, sort and population row; the table on the iPad, the list on phones, the Duo and accessibility type sizes), the Records tab (the web's periods and labels; one period at a time on phones) and the loading, empty, error, rate-limited and failed-refresh states. `PoseChangeTests` is opt-in (`TEST_RUNNER_BAB_POSE_CHANGE=1`): it lifts a card or selects a bid, then waits up to 120 s for you to fold or unfold the Duo in Device Hub and checks that the state survived. Screenshots are review material; keep them out of the repo.

#### Releasing (App Store)

- **Version**: bump `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` (the build number, +1 for every upload, even of the same version) in the BABOnline target's Debug and Release configurations (Xcode: target > General > Identity, or `project.pbxproj`); the test targets are kept in step. History: 1.0.0 (1), 1.1.0 (2), 1.2.0 (6, released 2026-11-13; build 3 was uploaded but never submitted; build 4 was submitted and pulled from review; build 5 was uploaded and replaced by 6, which added the new app icon), 1.2.1 (7, this branch: removing lobby bots, game-end stats, the Stats sheet with Records and the four-suit empty lobby; the 1.2.0 train closed when 6 was released). Never put literal versions in `Info.plist`: it reads `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`. `ReleaseMetadataTests` fails if the plist goes back to a literal "1.0" or the build number drops below 7 (`minimumBuild`), and checks that this history names the current build.
- **Upgrade gate**: the server (`server/socket/upgradeGate.js`) reads the build number from the handshake User-Agent (`BAB%20Online/<CFBundleVersion> ...`) and answers only builds below `MIN_IOS_BUILD` (3: 1.0.0 (1) and 1.1.0 (2)) with an update message ("Update required. Please update BAB Online in the App Store. You'll stay signed in." under the sign-in fields and as the main room's only chat line); build 3 and later are current (`upgradeGate.test.js` pins the 2/3 boundary and 1.2.0 builds 3, 4 and 5). Raise `MIN_IOS_BUILD` only once the build that becomes the floor is live in the App Store (the `iOS app connected {build}` log line counts sockets per build), and re-check the gate's payloads against what the newly gated build reads (the upgradeGate.js header).
- **Archive**: Xcode > scheme BABOnline > Any iOS Device (arm64) > Product > Archive (Release, automatic signing, team 9SYNY7K2HE), then Organizer > Distribute App > App Store Connect. Check first without signing: `xcodebuild -project iOSClient/BABOnline.xcodeproj -scheme BABOnline -configuration Release -destination 'generic/platform=iOS' -derivedDataPath /tmp/bab-dd -archivePath /tmp/BABOnline.xcarchive CODE_SIGNING_ALLOWED=NO archive`, then `/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "/tmp/BABOnline.xcarchive/Products/Applications/BAB Online.app/Info.plist"` (and `CFBundleVersion`). Expected noise: the AppIntents "Metadata extraction skipped" note at build and the missing WebRTC dSYM warning at upload.
- **Export compliance**: `ITSAppUsesNonExemptEncryption = NO` in `Info.plist` (HTTPS and WebRTC's standard DTLS/SRTP only), so App Store Connect does not ask on each upload. Revisit it if the app ever adds its own cryptography.
- **Privacy manifest**: `iOSClient/BABOnline/PrivacyInfo.xcprivacy` (bundled at the app root by the synchronized folder). No tracking; collected data: User ID (the username, sign-in/sign-up/restoreSession), Other User Content (chat messages, report reasons and the reported message), Gameplay Content (bids, plays, game records), all linked to the user, App Functionality only. Voice is peer to peer; the game server relays signaling only. The web client also gets short-lived Cloudflare Realtime TURN credentials from the server (`getVoiceIceServers`), so when a direct path fails its audio goes through Cloudflare's TURN relay, still as encrypted SRTP that nobody stores; iOS 1.1.0 is STUN only; iOS 1.2.0 fetches the same TURN credentials before each voice start (contract/V1_REMOVALS.md "iOS TURN"). The App Privacy answers do not change. The iOS app has no photo upload. No required-reason APIs in release code (`UserDefaults` is used only by the `#if DEBUG` fixture mode and the Debug-only `-serverURL http://localhost:<port>` override, `Networking/ServerConfig.swift`); WebRTC.framework and Starscream ship their own manifests. Update the manifest, and the App Privacy answers in App Store Connect, when the app starts sending new data or calls a required-reason API (UserDefaults, file timestamps, system boot time, disk space, active keyboards), including through a new package; Xcode's Organizer > Generate Privacy Report on the archive shows the combined result.
- **Usage strings**: `NSMicrophoneUsageDescription` (voice chat). `NSCameraUsageDescription` stays although the app never opens the camera: WebRTC.framework links `AVCaptureDevice`, and App Store Connect rejects an upload whose binary references camera APIs without the string. No background modes; the only entitlement is `webcredentials:babonline.io` (served by `/.well-known/apple-app-site-association`). The ATS exception (`NSAllowsLocalNetworking`, `localhost`) only affects simulator builds, which talk to `localhost:3000`.
- **TestFlight checks before submitting**: stay signed in across a force-quit and relaunch (Keychain token restore); the microphone prompt and voice on rejoining a game; one hand against staging for the pacing feel-check in server/CLAUDE.md, Pacing (bot cards 0.3-0.75 s apart, trick view 1.1 s, bot lead 0.6 s after the collect, next hand 1.0 s after the last trick, teams overlay readable).

### Environment Variables

```bash
NODE_ENV=development
PORT=3000
MONGO_URI=mongodb://localhost:27017/bab-online
# Voice TURN (optional; both or neither; never logged). Unset = STUN only
CLOUDFLARE_TURN_KEY_ID=...
CLOUDFLARE_TURN_API_TOKEN=...
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
│   │       ├── components/            # Toast, GameLog, ScoreModal, ChatBubble, TournamentScoreboard
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
│   └── build-tokens.js                # Design tokens (client/tokens/tokens.json -> CSS + JS)
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

# Regenerate the design tokens after editing client/tokens/tokens.json: the web's
# tokens.css / tokens.js and the iOS app's Generated/Theme.swift
# (tokens:check fails when a generated file is stale or a contrast pair fails)
npm run tokens
```

The web cards are drawn at runtime (`client/src/phaser/cards/`, a port of the
iOS `CardTextureGenerator`) into one atlas at the device pixel ratio; there is
no card art to build.

The server runs on `http://localhost:3000` by default.

**Ambient bot activity**: in production the server keeps one bot-vs-bot game running (spectatable from the main room) and seeds the global chat with bot-persona messages, so new players never land in an empty room. Control with `AMBIENT_BOTS=true|false` (default: on in production, off in development). The bot chat lines are shown only to the accounts in `AMBIENT_CHAT_USERS` (comma list, ignoring case; default `test1`, the App Review demo account; `*` everyone, `none` nobody); everyone else sees a humans-only main-room chat. The bot game itself stays visible to everyone.

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
| `/leave` | A bot takes your seat for good (no rejoin) and you go back to the main room (or, at a tournament table, the tournament). If no other player is at the table or can come back, the game ends instead (a tournament table's game then scores nothing that round). |

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

### Admin

Admins get an **Admin** entry in the web main room's menu (web only; the iOS app has no admin screens). The panel has five tabs:

- **Players**: every account in one table, newest first (up to 500; above that a note says how many are not shown): name, created, last seen, games, admin, and for an old name what it points at ("into X" for a merged account, "renamed to X" for a rename). Click a column header to sort; type in **Filter by name** to narrow it as you type. Per player: **Reset link** (a one-time password link, see below) and a **More** menu: **Rename…**, **Make admin…**, then the destructive ones: **Sign out everywhere…** (revokes every saved session and signs out live connections, including the iOS app), **Remove admin…**, **Delete account…**. An old (merged or renamed) name offers only **Show X** and **Delete…**.
- **Merge**: find look-alike names, preview a merge of duplicate accounts (the same plan `scripts/merge-accounts.js` prints), type the kept account's name to confirm, apply. If anything changed since the preview, the merge is refused and you preview again.
- **Reports**: player reports, newest first; resolve or dismiss with a note; open the reported player.
- **Admins**: who is an admin; remove one. The last admin can never remove their own flag.
- **Audit**: every admin action (who, what, target, when, result), newest first.

Every admin request is checked against the database on the server (the menu entry is only display), and everything is written to the audit log. Destructive actions ask for confirmation.

**Deleting an account** (More → Delete account…) does what the player's own Delete account does: they are signed out everywhere, their stats, leaderboard row, pictures and saved sessions are deleted, their name shows as `[deleted]` in past games, they are removed from other players' block lists (a player's own Delete account keeps other players' blocks, so nobody can clear a block by deleting and signing up again with the same name), any open reset link is cancelled, and the old names merged into the account are deleted too. Reports by or about them are kept, marked "account deleted". The name becomes free for a new sign-up. You type the account's name to confirm. It is refused for an admin (remove their admin first), for yourself (use Delete account on your own profile) and for a player in a game, tournament or the draw (try again when it is over).

**Deleting an old name** (Delete… on a merged or renamed row) removes only that name: the account it points at keeps its games and stats (if the freed name is later signed up again and merged into the same account, its stats are added). It is refused for the old name of a rename that has not finished (finish it first). Signing in as the old name then no longer says which account to use, and anyone can sign up with it. Old names are kept by default so a player who signs in with one is told where their account went.

**Renaming an account** (More → Rename…): type the new name, then type it again to confirm. It follows the sign-up rules (3-20 letters, numbers, spaces and `_ - .`, starting with a letter or number) and must not be taken, ignoring capital letters, by any account or old name. The player is signed out everywhere (refused while they are in a game, tournament or the draw); they sign in again with the new name and the same password. Their games, stats, reports and block lists move to the new name. Any open reset link for them is cancelled. The old name stays behind, reserved, as a redirect: signing in with it and the account's password says "This account is now called X. Sign in as X." Nobody else is told the new name (a wrong password gets the usual "Invalid username or password!", a sign-up gets "That name is taken.", and the old name's profile is not found), so a player renamed to get away from someone is not found again through the old name. Games they played with others do show the new name. Delete the old name later to free it. You cannot rename your own account here (it would sign you out mid-way); ask another admin. If a rename stops partway (a database error), the message says to rename again with the same names; the account's row also shows **rename unfinished** with a **Finish rename** button that does that, and the old name cannot be deleted until it is finished.

**Password reset links.** No email is stored, so a reset is a link you text the player: **Reset link** shows `https://<host>/reset#…` once with a **Copy** button. It works once, for 24 hours; making a new link cancels the old one, and so do **Sign out everywhere** and `scripts/set-password.js` (use either if a link went to the wrong person). The player opens it (it works on phones), chooses a new password, and every device they were signed in on is signed out; they then sign in with the new password on the app or the website.

**Making yourself the first admin** (once; after that, use the panel). Against production, with `MONGO_URI` set as for the server, run the read-only listing first, check the `Database:` line, then apply:

```bash
node scripts/set-admin.js --list            # read-only: current admins
node scripts/set-admin.js YourName          # shows the admins, then asks you to type ADMIN
node scripts/set-admin.js YourName --remove # (asks you to type REMOVE)
```

Then sign in again on the website (or reload it) and the **Admin** entry appears.

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
- **Design tokens (item 29)** - `iOSClient/BABOnline/Generated/Theme.swift` is generated from the web's `client/tokens/tokens.json` by `npm run tokens` (never hand-edit it): `Theme.Palette` (every color as a `ThemeColor` with `.color` / `.uiColor`), `TypeScale`, `Space`, `Radius`, `Weight`, `Elevation`, `Motion`, `hitTarget` and the tokens.json contrast pairs. Views and SpriteKit nodes use the semantic roles in `Extensions/Theme+Roles.swift` (`Theme.background`, `Theme.buttonBackground` + `buttonForeground`, `Theme.team(_:)` (absolute: team 1 = A, as the web), `Theme.SK.*` for nodes, `themeFont` for Dynamic Type), never a color literal; the felt is the web's radial gradient (`GameSKScene.feltTexture`). Every text-on-surface pair a role is used for is a tokens.json `contrast` entry (iOS-only ones say "iOS:"), checked by `tokens.test.js`, `tokens:check` and `ThemeTests` (which also checks Theme.swift against tokens.json). SpriteKit labels use Helvetica Neue (the first font.ui family SpriteKit can load by name). Off-grid paddings (2, 6, 10, 14 pt) that the table layout and bid band are sized around are still literals
- **Chat times** - every chat line keeps the server's time (`timestamp` on main room / lobby / tournament lines, `at` on snapshot log entries; a live table line has none and is stamped on arrival: `ChatMessage.serverDate`). The four chat lists show a Messages-style divider (`ChatTimeDivider`, `Utils/ChatTimestamps.swift`) above the first message and after a gap of more than 15 minutes: "Today 2:14 PM", "Yesterday 9:03 PM", a weekday within the week ("Mon 4:10 PM"), else "Nov 3, 4:10 PM" (with the year when it is not this year), in the user's locale and 12/24-hour setting; VoiceOver reads the full date. No per-message times

### Key Socket Events

| Client → Server | Description |
|-----------------|-------------|
| `signIn` | Authenticate user |
| `createLobby` / `joinLobby` | Open a named lobby / join one from the main room |
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
