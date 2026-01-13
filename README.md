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
| Frontend | Phaser 3.55.2, Vanilla JavaScript, Socket.IO Client 4.0.1 |
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
│   ├── game.js          # Phaser game scene, card rendering, animations
│   ├── ui.js            # Auth screens, lobby, chat, score displays
│   ├── socketManager.js # Socket.IO connection setup
│   ├── index.html       # Entry point
│   ├── styles.css       # Styling
│   └── assets/          # Card images, backgrounds (151 PNGs)
├── server/
│   ├── server.js        # Game logic, socket handlers, state management
│   └── database.js      # MongoDB connection
├── docs/
│   └── todos/           # Improvement roadmap (see below)
├── package.json
└── .env.example
```

## Development

```bash
# Start with hot reload
npm run dev

# Start production server
npm start
```

The server runs on `http://localhost:3000` by default.

## How to Play

1. **Sign up/Sign in** - Create an account or log in
2. **Join Queue** - Wait for 4 players to be matched
3. **Draw Phase** - Draw cards to determine seating positions
4. **Bidding** - Bid on how many tricks your team will take
5. **Play** - Take turns playing cards, following suit when possible
6. **Score** - Points awarded based on bids vs tricks taken

### Card Rankings
- High Joker (highest)
- Low Joker
- A, K, Q, J, 10, 9, 8, 7, 6, 5, 4, 3, 2

Trump suit beats all other suits. Must follow suit if possible.

## Architecture

### Communication Flow
```
Client (Phaser/JS) ←→ Socket.IO ←→ Server (Node/Express) ←→ MongoDB
```

### Key Socket Events

| Client → Server | Description |
|-----------------|-------------|
| `signIn` | Authenticate user |
| `joinQueue` | Enter matchmaking |
| `playerBid` | Submit bid |
| `playCard` | Play a card |
| `chatMessage` | Send chat message |

| Server → Client | Description |
|-----------------|-------------|
| `gameStart` | Game begins |
| `bidReceived` | Player bid received |
| `cardPlayed` | Card was played |
| `trickComplete` | Trick finished |
| `handComplete` | Hand finished |
| `updateTurn` | Turn changed |

## Improvement Roadmap

The `docs/todos/` directory contains detailed improvement plans:

| Priority | File | Focus |
|----------|------|-------|
| 1 | `01-server-architecture.md` | Modularize server code |
| 2 | `02-client-architecture.md` | Restructure client code |
| 3 | `03-state-management.md` | Fix global state issues |
| 4 | `04-socket-patterns.md` | Fix socket event handling |
| 5 | `05-security.md` | Security hardening |
| 6 | `06-error-handling-logging.md` | Add logging & error handling |
| 7 | `07-testing.md` | Add test coverage |
| 8 | `08-devops-deployment.md` | CI/CD & containerization |
| 9 | `09-asset-management.md` | Optimize asset loading |

## Known Issues

- Server uses blocking `sleepSync()` for timing (should be async)
- Single global game state (can't run concurrent games)
- Socket event listeners accumulate (memory leak)
- No input validation on socket events
- Missing `.gitignore` (secrets may be exposed)

See the TODO files for detailed solutions.

## Contributing

1. Check the `docs/todos/` for areas needing work
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

ISC

---

*Built as a learning project for online multiplayer game development.*
