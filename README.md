# BAB Online

A 4-player online multiplayer trick-taking card game built with Phaser 3 and Socket.IO.

## Game Overview

BAB is a partnership trick-taking game where players bid on tricks and score points based on their performance. Players are divided into two teams (positions 1 & 3 vs positions 2 & 4) and compete across multiple hands.

### Key Features
- Real-time multiplayer with WebSocket communication
- Progressive hand sizes (12 cards down to 1, then repeating)
- Trump suit determined each hand
- Special "rainbow" bonus for hands containing all 4 suits
- "Board" bids for high-risk/high-reward plays

### Scoring
- **Made bid:** `+(bid × 10 × multiplier) + overtricks + (rainbows × 10)`
- **Missed bid:** `-(bid × 10 × multiplier) + (rainbows × 10)`
- Multipliers apply when players call "Board" (2x) or "Double Board" (4x)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Phaser 3.55.2, ES6 Modules, Socket.IO Client 4.0.1 |
| Backend | Node.js, Express.js 4.21.2, Socket.IO 4.8.1 |
| Database | MongoDB with Mongoose 8.12.1 |
| Security | Helmet, bcryptjs |
| Deployment | Railway.app |

## Getting Started

### Prerequisites
- Node.js 18+
- MongoDB (local or Atlas)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/bab-online.git
cd bab-online

# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Edit .env with your MongoDB connection string

# Start development server
npm run dev
```

### Environment Variables

```bash
NODE_ENV=development
PORT=3000
MONGO_URI=mongodb://localhost:27017/bab-online
```

## Project Structure

```
bab-online/
├── client/
│   ├── js/                     # Modular ES6 client code
│   │   ├── main.js             # Entry point
│   │   ├── config.js           # Centralized constants
│   │   ├── socket/
│   │   │   └── SocketManager.js    # Connection management
│   │   ├── scenes/
│   │   │   └── GameScene.js        # Phaser game scene
│   │   ├── game/
│   │   │   ├── CardManager.js      # Card sprites & logic
│   │   │   └── GameState.js        # Client state container
│   │   └── ui/
│   │       └── UIManager.js        # DOM lifecycle management
│   ├── styles/
│   │   └── components.css      # UI component styles
│   ├── index.html              # Entry point
│   └── assets/                 # Card images, backgrounds
├── server/
│   ├── index.js                # Entry point
│   ├── config/
│   │   └── index.js            # Server configuration
│   ├── game/
│   │   ├── Deck.js             # Card deck management
│   │   ├── GameState.js        # Game state + room management
│   │   ├── GameManager.js      # Multi-game coordination
│   │   └── rules.js            # Pure game logic functions
│   ├── socket/
│   │   ├── index.js            # Socket event routing
│   │   ├── authHandlers.js     # Auth events
│   │   ├── mainRoomHandlers.js # Main room & lobby browser
│   │   ├── queueHandlers.js    # Matchmaking events
│   │   ├── lobbyHandlers.js    # Game lobby events
│   │   ├── gameHandlers.js     # Game events
│   │   ├── reconnectHandlers.js # Reconnection logic
│   │   ├── chatHandlers.js     # Chat events
│   │   ├── validators.js       # Joi validation schemas
│   │   ├── errorHandler.js     # Handler wrappers
│   │   └── rateLimiter.js      # Per-socket rate limiting
│   ├── routes/
│   │   └── index.js            # Express routes
│   ├── utils/
│   │   └── timing.js           # Async timing utilities
│   └── database.js             # MongoDB connection
├── docs/
│   └── todos/                  # Improvement roadmap
├── package.json
└── .env.example
```

## Development

```bash
# Start with hot reload
npm run dev

# Start production server
npm start

# Run tests
npm test
```

The server runs on `http://localhost:3000` by default.

## How to Play

1. **Sign up/Sign in** - Create an account (auto-logs in) or log in
2. **Main Room** - Chat globally, browse game lobbies, or create a new game
3. **Game Lobby** - Wait for 4 players, chat, and click "Ready" when prepared
4. **Draw Phase** - Draw cards from deck to determine seating positions; teams announced
5. **Bidding** - Bid on how many tricks your team will take
6. **Play** - Take turns playing cards, following suit when possible
7. **Score** - Points awarded based on bids vs tricks taken (shown in game log)

### Card Rankings
- High Joker (highest)
- Low Joker
- A, K, Q, J, 10, 9, 8, 7, 6, 5, 4, 3, 2

Trump suit beats all other suits. Must follow suit if possible.

## Architecture

### Communication Flow
```
Client (Phaser/ES6) ←→ Socket.IO ←→ Server (Node/Express) ←→ MongoDB
```

### Server Architecture

The server uses a modular architecture with clear separation of concerns:

- **GameManager** - Singleton managing queue and active games
- **GameState** - Encapsulated state for each game instance
- **Deck** - Card deck with Fisher-Yates shuffle
- **rules.js** - Pure functions for game logic (testable)
- **Socket handlers** - Organized by domain (auth, queue, game, chat)

### Client Architecture

The client uses ES6 modules with proper lifecycle management:

- **SocketManager** - Tracks listeners for cleanup (prevents memory leaks)
- **GameState** - Single source of truth (replaces 50+ globals)
- **CardManager** - Phaser sprite management
- **UIManager** - DOM element lifecycle management
- **GameScene** - Proper Phaser scene with shutdown cleanup

### Key Socket Events

| Client → Server | Description |
|-----------------|-------------|
| `signIn` | Authenticate user |
| `joinQueue` | Enter matchmaking / join lobby |
| `playerReady` | Mark ready in lobby |
| `lobbyChat` | Send lobby chat message |
| `leaveLobby` | Leave lobby before game starts |
| `draw` | Draw card during draw phase |
| `playerBid` | Submit bid |
| `playCard` | Play a card |
| `chatMessage` | Send in-game chat message |

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

## Improvement Roadmap

The `docs/todos/` directory contains detailed improvement plans:

| Priority | File | Focus | Status |
|----------|------|-------|--------|
| 1 | `01-server-architecture.md` | Modularize server code | ✅ Complete |
| 2 | `02-client-architecture.md` | Restructure client code | ✅ Complete |
| 3 | `03-state-management.md` | Fix global state issues | ✅ Complete |
| 4 | `04-socket-patterns.md` | Fix socket event handling | ✅ Complete |
| 5 | `05-security.md` | Security hardening | ✅ Complete |
| 6 | `06-error-handling-logging.md` | Add logging & error handling | ✅ Complete |
| 7 | `07-testing.md` | Add test coverage | ✅ Complete |
| 8 | `08-devops-deployment.md` | CI/CD & containerization | ✅ Complete |
| 9 | `09-asset-management.md` | Optimize asset loading | ✅ Complete |

## Recent Improvements

### Server Refactor
- Replaced blocking `sleepSync()` with async `delay()` utilities
- Created `GameManager` singleton for concurrent game support
- Extracted pure game rules to `rules.js` for testability
- Organized socket handlers by domain

### Client Refactor
- Created `SocketManager` with listener tracking (fixes memory leaks)
- Created `GameState` class (replaces 50+ global variables)
- Moved 200+ inline styles to CSS classes
- Added proper Phaser scene lifecycle management

### State Management
- Added server-side validation methods (`validateTurn`, `validateCardPlay`, `validateBid`)
- Added full game state consistency checking (`validateGameState`)
- Added debug logging for state changes (development mode only)
- Added client-side optimistic updates with rollback capability
- Added event system for reactive UI updates (`on`/`off`/`_emit`)

### Deployment Fixes
- Fixed Railway 502 error: hardcoded port 3000 (Railway expects this despite setting `PORT=8080`)
- Removed `node_modules` from git, added proper `.gitignore`

### Socket Patterns
- Added Joi validation schemas for all socket events (`validators.js`)
- Added error handling wrappers for async/sync handlers (`errorHandler.js`)
- Added per-socket rate limiting with configurable limits (`rateLimiter.js`)
- Added Socket.IO room support for targeted game broadcasts (game events only go to game participants)
- Added reconnection logic with automatic game state recovery (`reconnectHandlers.js`)
- Client stores gameId/username in sessionStorage for reconnection
- Server tracks disconnected players for 5 minutes, allowing rejoin

### Security Hardening
- Fixed CORS: Replaced wildcard `*` with whitelist of allowed origins
- Enabled Helmet middleware for security headers
- Improved CSP: Removed `unsafe-inline` from script-src (kept `unsafe-eval` for Phaser WebGL)
- Added `.gitignore` to protect `.env` files from accidental commits
- Created `.env.example` template for required environment variables
- Removed sensitive connection string logging from database errors

### Testing
- Set up Jest testing framework with 112 unit tests
- Created comprehensive tests for game rules (`rules.test.js`)
- Created tests for Deck class (`Deck.test.js`)
- Created tests for GameManager singleton (`GameManager.test.js`)
- Coverage: Deck.js 100%, GameManager.js ~85%, rules.js ~80%

### Error Handling & Logging
- Implemented Winston structured logging with module-specific loggers
- Added custom error classes (`GameError`, `ValidationError`, `AuthError`, etc.)
- Replaced all `console.log` statements with structured logging
- Added graceful shutdown handler for SIGTERM/SIGINT signals
- Added HTTP request logging middleware
- Added client-side error toast notifications for user-friendly error display
- Log files written to `logs/` directory (error.log + combined.log)

### DevOps & Deployment
- Added health check endpoints (`/health`, `/ready`, `/live`)
- Created Dockerfile with multi-stage build and non-root user
- Created docker-compose.yml for local development with MongoDB
- Set up GitHub Actions CI/CD pipeline (test, build, deploy)
- Created railway.toml for Railway.app deployment configuration

### Asset Management
- Created texture atlas for 54 card images (reduces requests from 54 to 2)
- Added `npm run build:atlas` script using free-tex-packer-core
- Updated game.js to load cards from atlas instead of individual files
- Added caching headers for static assets (7 days for images, 1 year for sprites)
- Reduced initial load from ~149 HTTP requests to ~95 requests

### Lobby System & UX Polish
- Implemented pre-game lobby with chat and ready-up functionality
- Players auto-join lobby on sign-in (no manual "Join Queue" button)
- Auto-login after registration (no need to sign in again)
- Lobby persists when players leave; next queued player fills the slot
- Draw phase improvements: cards animate visibly, all players see each draw
- Team announcements displayed after draw phase before game starts
- Fixed HI joker rule: opponents must play highest trump when HI joker leads
- Fixed follow-suit validation for void hands
- Improved card table styling with bottom clearance

### Multi-Lobby System
- Added main room with global chat and lobby browser
- Players can create named game lobbies or join existing ones
- Multiple concurrent games supported
- Lobbies are ephemeral (deleted when empty)
- Recent chat history (last 50 messages) shown when joining main room

### Cross-Browser Reconnection
- Players can rejoin games from different browsers/devices
- Server stores `activeGameId` in MongoDB user document
- On sign-in, server checks for active game and prompts rejoin
- Full game state restored on successful rejoin

### UI Simplification
- Score updates now displayed in game log instead of popup dialogs
- Game log expanded to full-height right column
- Bid UI centered over play area
- Transparent canvas with CSS gradient background
- Removed legacy server code

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

## Contributing

1. Check the `docs/todos/` for areas needing work
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

ISC

---

*Built as a learning project for online multiplayer game development.*
