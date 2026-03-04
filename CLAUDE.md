# BAB Online - Claude Context Document

This document helps Claude understand the project quickly in new sessions.

## What is this?

BAB Online is a 4-player online multiplayer trick-taking card game ("Back Alley Bridge"). Players form 2 teams (positions 1&3 vs 2&4) and compete across 13 hands with varying card counts.

**See `docs/RULES.md` for complete game rules.**

## Tech Stack

- **Frontend**: Phaser 3 (game engine), ES6 modules, Socket.IO client, Vite bundler
- **Backend**: Node.js 18+, Express.js, Socket.IO server
- **Database**: MongoDB (native client, no ORM)
- **Testing**: Jest (server), Vitest (client)
- **Deployment**: Railway.app via GitHub Actions

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
│   │   ├── GameManager.js     # Singleton: manages games, queue, lobbies
│   │   └── bot/               # AI player system
│   ├── socket/                # Socket.IO handlers by domain
│   │   ├── gameHandlers.js    # Core gameplay (draw, bid, play)
│   │   ├── lobbyHandlers.js   # Pre-game lobby
│   │   ├── authHandlers.js    # Sign-in/up
│   │   └── validators.js      # Joi validation schemas
│   └── __tests__/             # Jest tests
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
- `hands`: {socketId → card[]}, `bids`: {position → bid_value}
- `phase`: 'waiting'|'drawing'|'bidding'|'playing'
- `trump`: card, `isTrumpBroken`: boolean
- `playedCards`: [pos1Card, pos2Card, pos3Card, pos4Card]
- `tricks`: {team1: count, team2: count}

**Bid Values:** '0'-'12' for numbers, 'B'/'2B'/'3B'/'4B' for bores (2x/4x/8x/16x multipliers)

## Game Flow (Socket Events)

1. **Auth**: `signIn`/`signUp` → `signInResponse`
2. **Lobby**: `joinQueue` → `lobbyCreated` → `playerReadyUpdate` → `allPlayersReady`
3. **Draw**: `startDraw` → `draw` → `playerDrew` → `teamsAnnounced`
4. **Bidding**: `gameStart` → `updateTurn` → `playerBid` → `bidReceived` → `doneBidding`
5. **Play**: `updateTurn` → `playCard` → `cardPlayed` → `trickComplete` → `handComplete`
6. **End**: `gameEnd`

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
```

## Important Implementation Details

- Bots have socketIds like `bot:{username}:{uuid}`, use `BotStrategy.js` for AI
- Reconnection uses session tokens stored in MongoDB
- Socket rooms: players join `game:{gameId}` for broadcasts
- Event constants in `client/src/constants/events.js` prevent typos
- Card legality logic duplicated in `server/game/rules.js` and `client/src/rules/legality.js`

## Common Files to Check

| Task | Files |
|------|-------|
| Game rules/logic | `server/game/rules.js`, `docs/RULES.md` |
| Card play handling | `server/socket/gameHandlers.js` |
| Client card legality | `client/src/rules/legality.js` |
| UI screens | `client/src/ui/screens/` |
| Visual card display | `client/src/phaser/managers/CardManager.js` |
| State management | `server/game/GameState.js`, `client/src/state/GameState.js` |
| Socket events list | `client/src/constants/events.js` |
