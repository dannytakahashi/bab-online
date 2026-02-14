# BAB Online

A 4-player online multiplayer trick-taking card game built with Phaser 3 and Socket.IO.

## Game Overview

BAB is a partnership trick-taking game where players bid on tricks and score points based on their performance. Players are divided into two teams (positions 1 & 3 vs positions 2 & 4) and compete across multiple hands.

For complete game rules including bidding, scoring, and special mechanics, see [docs/RULES.md](docs/RULES.md).

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Phaser 3.55.2, ES6 Modules, Socket.IO Client 4.0.1 |
| Build | Vite |
| Backend | Node.js 18+, Express.js 4.21.2, Socket.IO 4.8.1 |
| Database | MongoDB with Mongoose 8.12.1 |
| Security | Helmet, bcryptjs |
| Testing | Vitest (client), Jest (server) |
| Deployment | Railway.app |

## Getting Started

### Prerequisites
- Node.js 18+
- MongoDB (local or Atlas)

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
│   ├── src/                        # Modular ES6 client code (Vite)
│   │   ├── main.js                 # Entry point
│   │   ├── constants/              # events.js, ranks.js
│   │   ├── utils/                  # positions.js, cards.js, colors.js
│   │   ├── rules/                  # legality.js - card play validation
│   │   ├── state/                  # GameState.js - client state singleton
│   │   ├── socket/                 # SocketManager.js - connection management
│   │   ├── handlers/               # Socket event handlers (auth, game, chat, lobby, profile, leaderboard)
│   │   ├── phaser/
│   │   │   ├── config.js           # Phaser game configuration
│   │   │   ├── PhaserGame.js       # Game instance wrapper
│   │   │   ├── scenes/             # GameScene.js
│   │   │   └── managers/           # CardManager, TrickManager, BidManager, etc.
│   │   └── ui/
│   │       ├── UIManager.js        # DOM lifecycle management
│   │       ├── components/         # Modal, Toast, BidUI, GameLog
│   │       └── screens/            # SignIn, Register, MainRoom, GameLobby, ProfilePage, LeaderboardPage
│   ├── styles/
│   │   └── components.css          # UI component styles
│   ├── assets/                     # Card images, backgrounds
│   ├── vite.config.js              # Vite build configuration
│   └── index.html                  # Entry point
├── server/
│   ├── index.js                    # Entry point
│   ├── config/
│   │   └── index.js                # Server configuration
│   ├── game/
│   │   ├── Deck.js                 # Card deck management
│   │   ├── GameState.js            # Game state + room management
│   │   ├── GameManager.js          # Multi-game coordination
│   │   ├── rules.js                # Pure game logic functions
│   │   └── bot/                    # Bot player system
│   │       ├── BotPlayer.js        # Bot player class with card memory
│   │       ├── BotController.js    # Bot lifecycle management
│   │       ├── BotStrategy.js      # AI strategy functions
│   │       └── __tests__/          # Bot strategy tests
│   ├── socket/
│   │   ├── index.js                # Socket event routing
│   │   ├── authHandlers.js         # Auth events
│   │   ├── mainRoomHandlers.js     # Main room & lobby browser
│   │   ├── queueHandlers.js        # Matchmaking events
│   │   ├── lobbyHandlers.js        # Game lobby events
│   │   ├── gameHandlers.js         # Game events
│   │   ├── reconnectHandlers.js    # Reconnection logic
│   │   ├── chatHandlers.js         # Chat events
│   │   ├── profileHandlers.js      # Profile and leaderboard events
│   │   ├── validators.js           # Joi validation schemas
│   │   ├── errorHandler.js         # Handler wrappers
│   │   └── rateLimiter.js          # Per-socket rate limiting
│   ├── routes/
│   │   └── index.js                # Express routes
│   ├── middleware/
│   │   └── requestLogger.js        # Request logging
│   ├── utils/
│   │   ├── timing.js               # Async timing utilities
│   │   ├── logger.js               # Winston logger
│   │   ├── errors.js               # Custom error classes
│   │   └── shutdown.js             # Graceful shutdown
│   └── database.js                 # MongoDB connection
├── docs/
│   ├── RULES.md                    # Complete game rules
│   ├── bot-strategy-guide.md       # Bot strategy reference
│   └── todos/                      # Improvement roadmap
├── scripts/
│   └── build-atlas.js              # Sprite atlas builder
├── .github/
│   └── workflows/ci.yml            # GitHub Actions CI
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

# Vite dev server only (port 5173, proxies to :3000)
npm run dev:client

# Build client
npm run build:client

# Build sprite atlas
npm run build:atlas
```

The server runs on `http://localhost:3000` by default.

## How to Play

1. **Sign up/Sign in** - Create an account (auto-logs in) or log in
2. **Main Room** - Chat globally, browse game lobbies, or create a new game
3. **Game Lobby** - Wait for 4 players, chat, and click "Ready" when prepared
   - Click "+ Add Bot" to add AI players (up to 3 bots named "🤖 Mary")
   - Click "✕" next to a bot to remove it before readying up
   - Bots auto-ready when lobby is full
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
- **BotController / BotStrategy** - AI bot system with hand-size-aware bidding and card memory
- **Socket handlers** - Organized by domain (auth, queue, game, chat, profile)

### Client Architecture

The client uses ES6 modules with Vite bundling and proper lifecycle management:

- **SocketManager** - Tracks listeners for cleanup (prevents memory leaks)
- **GameState** - Single source of truth (replaces 50+ globals)
- **GameScene** - Main Phaser scene coordinating all game visuals
- **Phaser Managers** - Specialized managers for different game aspects:
  - CardManager, TrickManager, BidManager, DrawManager
  - OpponentManager, EffectsManager, LayoutManager
- **UIManager** - DOM element lifecycle management
- **Handler Modules** - Socket event handlers (auth, game, chat, lobby)

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
| `chatMessage` | Send in-game chat message |
| `rejoinGame` | Reconnect to game after disconnect |
| `getProfile` | Fetch user profile and stats |
| `updateProfilePic` | Change profile picture |
| `getLeaderboard` | Fetch leaderboard data |

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
| `profileResponse` | User profile data |
| `leaderboardResponse` | Leaderboard data |

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
