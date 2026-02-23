# BAB Online

A 4-player online multiplayer trick-taking card game (Back Alley Bridge). Players bid on tricks, with special scoring for "rainbow" hands (all 4 suits). Hand progression: 12→10→8→6→4→2→1→3→5→7→9→11→13, then game ends. Teams: Positions 1 & 3 vs Positions 2 & 4.

> **Complete game rules**: See [docs/RULES.md](docs/RULES.md) for detailed rules including bidding, bore mechanics, trump, and scoring.

## Technology Stack

- **Web Frontend**: Phaser 3.55.2 (game engine), ES6 Modules, Socket.io 4.0.1, Vite (build)
- **iOS Client**: SwiftUI + SpriteKit, Socket.IO-Client-Swift 16, Combine, iOS 17+
- **Backend**: Node.js 18+, Express.js 4.21.2, Socket.IO 4.8.1
- **Database**: MongoDB with Mongoose 8.12.1
- **Security**: Helmet, bcryptjs for password hashing
- **Testing**: Vitest (client), Jest (server)
- **Deployment**: Railway.app

## Project Structure

```
bab-online/
├── client/                             # Web client (Phaser + Vite)
│   ├── src/
│   │   ├── main.js                     # Entry point, wires callbacks to GameScene
│   │   ├── constants/                  # events.js, ranks.js
│   │   ├── utils/                      # positions.js, cards.js, colors.js
│   │   ├── rules/                      # legality.js - card play validation
│   │   ├── state/                      # GameState.js - client state singleton
│   │   ├── socket/                     # SocketManager.js - connection management
│   │   ├── handlers/                   # Socket event handlers (auth, game, chat, lobby, profile, leaderboard, tournament)
│   │   ├── phaser/
│   │   │   ├── PhaserGame.js           # Game instance wrapper
│   │   │   ├── scenes/GameScene.js     # Main game scene
│   │   │   └── managers/               # Card, Trick, Opponent, Effects, Draw, Bid, Layout
│   │   └── ui/
│   │       ├── UIManager.js            # DOM lifecycle management
│   │       ├── components/             # Modal, Toast, BidUI, GameLog, ChatBubble, ScoreModal, TournamentScoreboard
│   │       └── screens/               # SignIn, Register, MainRoom, GameLobby, TournamentLobby, ProfilePage, LeaderboardPage
│   ├── styles/components.css           # All UI styles
│   └── assets/                         # Card images, backgrounds
├── iOSClient/BABOnline/                # iOS client (SwiftUI + SpriteKit)
│   ├── BABOnlineApp.swift              # App entry, environment objects, scene phase handling
│   ├── AppState.swift                  # Screen navigation state
│   ├── ContentView.swift               # Root view switch + session restore
│   ├── Constants/                      # CardConstants, LayoutConstants, SocketEvents
│   ├── Extensions/                     # Color+Theme, View+Haptics
│   ├── Models/                         # Card, ChatMessage, Lobby, Player, ScoreData, Tournament
│   ├── Networking/
│   │   ├── SocketService.swift         # Socket.IO connection, forceReconnect on foreground
│   │   ├── SocketEventRouter.swift     # Routes incoming events to handlers
│   │   ├── Emitters/                   # Auth, Chat, Game, Lobby, Tournament emitters
│   │   └── Handlers/                   # Auth, Chat, Game, Lobby, Tournament socket handlers
│   ├── Rules/CardLegality.swift        # Card play validation (mirrors server rules.js)
│   ├── State/                          # AuthState, GameState, LobbyState, MainRoomState, TournamentState
│   ├── SpriteKit/
│   │   ├── GameSKScene.swift           # Main scene, Combine subscriptions to GameState
│   │   ├── CardTextureGenerator.swift  # Programmatic card rendering
│   │   ├── Managers/                   # SKCard, SKTrick, SKBid, SKDraw, SKOpponent, SKEffects managers
│   │   ├── Nodes/                      # CardSprite, HandNode, TrickArea, BidBubble, Avatar, OpponentHand, TrickHistory
│   │   └── Actions/CardAnimations.swift
│   ├── Utils/                          # CardUtils, Positions, HapticManager, UsernameColor
│   └── Views/
│       ├── Auth/                       # SignInView, RegisterView
│       ├── Components/                 # ConnectionStatusToast
│       ├── Game/                       # GameContainerView, BidOverlayView, DrawPhaseView, GameEndView, GameLogView, ScoreBarView, DisconnectBannerView
│       ├── GameLobby/                  # GameLobbyView, LobbyChatView, LobbyPlayerRow
│       ├── MainRoom/                   # MainRoomView, MainRoomChatView, LobbyListView
│       └── Tournament/                 # TournamentLobbyView, PlayerList, Chat, Scoreboard, ActiveGames, Results
├── server/
│   ├── index.js                        # Entry point
│   ├── game/
│   │   ├── Deck.js                     # Card deck with shuffle
│   │   ├── GameState.js                # Per-game state + room management
│   │   ├── GameManager.js              # Queue, lobby, game coordination, in-progress listing
│   │   ├── TournamentState.js          # Per-tournament state + round management
│   │   ├── rules.js                    # Pure game logic functions
│   │   └── bot/                        # Bot player system
│   │       ├── BotPlayer.js            # Bot player class with card memory
│   │       ├── BotController.js        # Singleton managing bot lifecycle
│   │       ├── BotStrategy.js          # Pure strategy functions
│   │       └── personalities.js        # Bot personality definitions
│   ├── socket/
│   │   ├── index.js                    # Socket event routing
│   │   ├── authHandlers.js             # signIn, signUp
│   │   ├── mainRoomHandlers.js         # Main room, lobby browser, spectator join
│   │   ├── queueHandlers.js            # joinQueue, disconnect grace period
│   │   ├── lobbyHandlers.js            # playerReady, lobbyChat, leaveLobby
│   │   ├── gameHandlers.js             # playCard, playerBid, draw, forceResign
│   │   ├── reconnectHandlers.js        # rejoinGame for mid-game reconnection
│   │   ├── chatHandlers.js             # chatMessage, slash commands (/lazy, /active, /leave)
│   │   ├── profileHandlers.js          # Profile and leaderboard events
│   │   ├── tournamentHandlers.js       # Tournament lifecycle events
│   │   ├── validators.js               # Joi validation schemas
│   │   ├── errorHandler.js             # Handler wrappers with rate limiting
│   │   └── rateLimiter.js              # Per-socket rate limiting
│   ├── routes/index.js                 # Express routes, /health
│   ├── utils/                          # timing.js, logger.js, errors.js, shutdown.js
│   └── database.js                     # MongoDB connection
├── docs/
│   ├── RULES.md                        # Complete game rules
│   ├── bot-strategy-guide.md           # Bot strategy reference
│   └── todos/                          # Improvement roadmap
└── scripts/build-atlas.js              # Sprite atlas builder
```

## Architecture Patterns

### Web Client
- **Event Callbacks**: Socket events → `handlers/*.js` → `main.js` callbacks → `GameScene.handleX()` → Phaser managers
- **Client State**: `GameState` singleton with event emitter (`handChanged`, `bidChanged`)
- **Optimistic Updates**: Client updates UI immediately, rolls back on server rejection
- **Socket Cleanup**: `SocketManager` tracks listeners via `onGame()`, cleaned up between games
- **UI**: Phaser for game canvas, `UIManager` for DOM lifecycle

### iOS Client
- **Architecture**: SwiftUI views + SpriteKit game scene, MVVM-ish with `@Published` state objects
- **State**: `@EnvironmentObject` for AuthState, AppState, LobbyState, MainRoomState, GameState, TournamentState, SocketService
- **Reactive**: `GameState` uses `@Published` properties + Combine subjects; `GameSKScene` subscribes via `.sink`
- **Socket Pattern**: `SocketEventRouter` dispatches to domain handlers → handlers update `@Published` state → SwiftUI/SpriteKit react
- **Emitter Pattern**: Static methods on `AuthEmitter`, `GameEmitter`, `LobbyEmitter`, `ChatEmitter`, `TournamentEmitter` — access `SocketService.shared`
- **Game Rendering**: SpriteKit scene with managers (SKCardManager, SKTrickManager, etc.) matching web client manager pattern
- **Reconnection**: `BABOnlineApp` calls `forceReconnect()` on `scenePhase` change to `.active`; `ConnectionStatusToast` shows reconnecting/connected state
- **Theme**: `Color.Theme.*` extension (background, surface, primary, warning, success, etc.)

### Shared
- **Communication**: Socket.io bidirectional WebSocket (same server events for both clients)
- **State**: Server-authoritative, `GameState` class per game instance
- **Validation**: Server validates all actions; Joi schemas validate all socket event data
- **Socket Rooms**: Game events broadcast only to game participants + spectators via `game.broadcast()`
- **Game Logic**: Pure functions in `rules.js` for testability

## Game Flow

1. Authentication (signIn/signUp) → MongoDB users collection
2. Main Room → Global chat, browse game lobbies, spectate in-progress games
3. Game Lobby → 4 players chat and ready up; can add bot players (5 personalities)
4. Draw phase → Players draw cards to determine positions; teams announced (1&3 vs 2&4)
5. Hand progression (12→10→8→6→4→2→1→3→5→7→9→11→13) with bidding then playing
6. Game end → Final scores, return to main room

## Key Socket Events

**Client → Server**: `signIn`, `signUp`, `joinMainRoom`, `mainRoomChat`, `createLobby`, `joinLobby`, `playerReady`, `lobbyChat`, `leaveLobby`, `addBot`, `removeBot`, `draw`, `playerBid`, `playCard`, `chatMessage`, `rejoinGame`, `forceResign`, `joinAsSpectator`, `getProfile`, `updateProfilePic`, `getLeaderboard`, `createTournament`, `joinTournament`, `leaveTournament`, `tournamentReady`, `beginTournament`, `beginNextRound`, `returnToTournament`

**Server → Client**: `mainRoomJoined`, `mainRoomMessage`, `lobbiesUpdated`, `lobbyCreated`, `lobbyJoined`, `playerReadyUpdate`, `lobbyMessage`, `lobbyPlayerLeft`, `allPlayersReady`, `startDraw`, `playerDrew`, `youDrew`, `teamsAnnounced`, `positionUpdate`, `createUI`, `gameStart`, `bidReceived`, `doneBidding`, `cardPlayed`, `updateTurn`, `trickComplete`, `handComplete`, `gameEnd`, `rainbow`, `rejoinSuccess`, `rejoinFailed`, `playerDisconnected`, `playerReconnected`, `activeGameFound`, `resignationAvailable`, `playerResigned`, `playerLazyMode`, `playerActiveMode`, `gameLogEntry`, `leftGame`, `spectatorJoined`, `profileResponse`, `leaderboardResponse`, `restorePlayerState`, `tournamentCreated`, `tournamentJoined`, `tournamentRoundStart`, `tournamentGameAssignment`, `tournamentGameComplete`, `tournamentRoundComplete`, `tournamentComplete`

## Disconnection, Resignation & Bot Takeover

When a player disconnects mid-game:
1. Server marks player as disconnected, starts **60-second** grace period
2. Other players see "[username] disconnected - waiting for reconnection..."
3. If player reconnects within 60 seconds: normal rejoin via `rejoinGame`
4. If grace period expires: remaining players see a prompt to replace with a bot (`resignationAvailable`)
5. Any player clicks "Replace with bot" → `forceResign` → bot takes over the hand
6. Game stats are attributed to the original human player, not the bot
7. Game only aborts if ALL human players disconnect

### Cross-Browser/Device Reconnection
Server stores `activeGameId` in MongoDB user document. On sign-in, checks for active game and emits `activeGameFound`. iOS client also restores session via stored credentials on app launch.

## Slash Commands (In-Game)

Players type these in the game log chat input (autocomplete appears when typing `/`):

| Command | Behavior |
|---------|----------|
| `/lazy` | Bot takes over temporarily. Player stays as spectator (can see hand/chat, bot plays). Avatar switches to bot. |
| `/active` | Take back control from bot. Avatar switches back. Only works for original players, not spectators. |
| `/leave` | Bot takes over + player exits to main lobby. Can rejoin later and `/active` to resume. |

Slash commands are intercepted in `chatHandlers.js` on the server. The `GameLog.js` component provides autocomplete with single-match auto-submit on Enter.

### Lazy Mode State
- `GameState.lazyPlayers`: tracks `position → { botSocketId, botUsername, originalUsername, ... }`
- `triggerBotIfNeeded()` checks both `isBot()` and `isLazy()` to schedule bot actions
- Same bot personality persists across lazy/active cycles per position

## Spectator System

Players can join in-progress games from the main room lobby panel:
- `MainRoom.js` / `MainRoomView.swift` shows in-progress games with "Spectate" button
- `joinAsSpectator` event → server sends full game state (no hand data) → client sets up read-only view
- Spectators see tricks, bids, scores, game log; can chat (marked as spectator)
- Pure spectators only see `/leave` in autocomplete; `/lazy` and `/active` are silently ignored
- Lazy-mode players who used `/leave` and rejoined as spectators still see `/active` and `/leave`

## Server Game State (`server/game/GameState.js`)

Key fields beyond core game state:
- `resignedPlayers`: `position → { username, pic, resignedAt }` — original human info for stats
- `lazyPlayers`: `position → { botSocketId, botUsername, originalUsername, originalSocketId, ... }`
- `spectators`: Map of `socketId → { username, pic }`
- Key methods: `resignPlayer()`, `enableLazyMode()`, `disableLazyMode()`, `addSpectator()`, `removeSpectator()`, `isLazy()`, `isSpectator()`, `getOriginalPlayer()`

## Card Data Structure

```javascript
{ suit: "spades|hearts|diamonds|clubs|joker", rank: "2"-"K"|"A"|"HI"|"LO" }
```

Deck: 52 standard cards + 2 jokers (HI and LO). iOS uses `Card` struct with `Suit` and `Rank` enums.

## Scoring Rules

- Made bid: `+(bid × 10 × multiplier) + (tricks - bid) + (rainbows × 10)`
- Missed bid: `-(bid × 10 × multiplier) + (rainbows × 10)`
- Rainbow = 4-card hand containing all 4 suits (+10 points bonus)
- Bore multipliers: B (2x), 2B (4x), 3B (8x), 4B (16x)

## Bot System

5 personalities: Mary (balanced), Sharon (conservative), Danny (calculated risk-taker), Mike (overconfident), Zach (adaptive). Defined in `server/game/bot/personalities.js`.

- Bots use `isBot: true` flag, identified by `socketId.startsWith('bot:')`
- Auto-ready when lobby fills to 4 players
- Partner-aware play: positions 1&3 and 2&4 are partners
- Card memory tracking for strategic play
- Random delays simulate human thinking time (500-1500ms)
- Used for lobby fill, resignation replacement, and lazy mode

## Tournament System

4-round tournament with cumulative scoring. Managed by `TournamentState.js` on server and `tournamentHandlers.js`.

- Creator creates tournament from main room → tournament lobby (unbounded player count)
- Players join and ready up → creator begins tournament
- Each round: players shuffled into games of 4 (bots fill remaining slots)
- Round score = team's final game score; cumulative across 4 rounds
- Highest total score wins

## Development Commands

```bash
npm run dev           # Development server with hot reload (port 3000)
npm start             # Production server
npm test              # Run server tests (Jest)
npm run test:client   # Run client tests (Vitest)
npm run build:client  # Build client modules (Vite)
npm run build:atlas   # Generate sprite atlas
npm run dev:client    # Vite dev server (port 5173, proxies to :3000)
```

Server runs on port 3000. Requires Node.js 18+.

iOS client: open `iOSClient/BABOnline.xcodeproj` in Xcode 15+, build for iOS 17+ device/simulator.

## Common Tasks

### Adding Socket Events
1. Add handler in appropriate `server/socket/*.js` file
2. Register in `server/socket/index.js`
3. **Web client**: Add listener in `client/src/handlers/*.js`, wire callback through `client/src/handlers/index.js` — destructure from callbacks AND pass to the correct `register*Handlers()` call. Add cleanup in `cleanupGameListeners()` for game-specific events.
4. **iOS client**: Add handler in appropriate `iOSClient/BABOnline/Networking/Handlers/*SocketHandler.swift`, add emitter method in `Emitters/*.swift` if needed, update relevant `State/*.swift` `@Published` properties

### Game Logic Changes
- **Rules**: `server/game/rules.js` — pure functions
- **State**: `server/game/GameState.js` — game state management
- **Flow**: `server/socket/gameHandlers.js` — `playCard()`, `playerBid()`

### Web UI Changes
- **Styles**: `client/styles/components.css`
- **Components**: `client/src/ui/components/`
- **Screens**: `client/src/ui/screens/`
- **Cards**: `client/src/phaser/managers/CardManager.js`

### iOS UI Changes
- **Views**: `iOSClient/BABOnline/Views/` — SwiftUI views organized by screen
- **Theme**: `iOSClient/BABOnline/Extensions/Color+Theme.swift` — all colors
- **Game visuals**: `iOSClient/BABOnline/SpriteKit/Managers/` — SK managers mirror web Phaser managers
- **Game scene subscriptions**: `iOSClient/BABOnline/SpriteKit/GameSKScene.swift` — `subscribeToState()` wires Combine to managers
