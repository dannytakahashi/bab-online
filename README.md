# BAB Online

A 4-player online multiplayer trick-taking card game built with Phaser 3 and Socket.IO.

## Game Overview

BAB is a partnership trick-taking game where players bid on tricks and score points based on their performance. Players are divided into two teams (positions 1 & 3 vs positions 2 & 4) and compete across multiple hands.

For complete game rules including bidding, scoring, and special mechanics, see [docs/RULES.md](docs/RULES.md).

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
