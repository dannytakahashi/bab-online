# BAB Online

A 4-player online multiplayer trick-taking card game. Players bid on tricks, with special scoring for "rainbow" hands (all 4 suits). Game progresses from 12-card hands down to 1, then repeats. Teams: Positions 1 & 3 vs Positions 2 & 4.

## Technology Stack

- **Frontend**: Phaser 3.55.2 (game engine), Vanilla JavaScript, Socket.io 4.0.1
- **Backend**: Node.js, Express.js 4.21.2, Socket.IO 4.8.1
- **Database**: MongoDB with Mongoose 8.12.1
- **Security**: Helmet, bcryptjs for password hashing
- **Deployment**: Railway.app

## Project Structure

```
bab-online/
├── client/
│   ├── game.js          # Phaser game scene, card rendering, animations
│   ├── ui.js            # Auth screens, lobby, chat, score displays
│   ├── socketManager.js # Socket.io connection setup
│   ├── index.html       # Entry point with CDN dependencies
│   ├── styles.css       # Minimal styling
│   └── assets/          # 151 PNG files (cards, backgrounds)
├── server/
│   ├── server.js        # Main game logic, socket handlers, state management
│   └── database.js      # MongoDB connection for user auth
├── package.json
└── .env
```

## Key Files

- `server/server.js` - All game logic, socket event handlers, scoring (~32KB)
- `client/game.js` - Phaser scene, card interactions, animations (~73KB)
- `client/ui.js` - DOM-based UI overlays and modals (~39KB)

## Architecture Patterns

- **Communication**: Socket.io bidirectional WebSocket
- **State**: Server-authoritative game state, client mirrors via socket events
- **UI**: Phaser for game canvas, vanilla JS DOM manipulation for overlays
- **Animations**: Phaser tweens (Power2 easing, 200-500ms durations)

## Game Flow

1. Authentication (signIn/signUp) → MongoDB users collection
2. Queue management → Game starts when 4 players ready
3. Draw phase → Players draw cards to determine positions (1-4)
4. Hand progression (12→1 cards) with bidding then playing phases
5. Trick evaluation, scoring with rainbow bonuses

## Key Socket Events

**Client → Server**: `signIn`, `signUp`, `joinQueue`, `playerBid`, `playCard`, `chatMessage`, `draw`

**Server → Client**: `gameStart`, `bidReceived`, `cardPlayed`, `trickComplete`, `handComplete`, `gameEnd`, `updateTurn`, `doneBidding`, `rainbow`, `positionUpdate`

## Development Commands

```bash
npm start     # Production: node server/server.js
npm run dev   # Development: nodemon server/server.js
```

Server runs on port 3000.

## Common Tasks

- **Card game logic**: `server/server.js` - functions `isLegalMove()`, `determineWinner()`, `cleanupNextHand()`
- **UI changes**: `client/ui.js` for overlays, `client/game.js` for game canvas
- **Adding card assets**: Place in `client/assets/`, preload in `game.js` preload function
- **Socket events**: Add handler in `server/server.js`, listener in `client/game.js`

## Scoring Rules

- Made bid: `+(bid × 10 × multiplier) + (tricks - bid) + (rainbows × 10)`
- Missed bid: `-(bid × 10 × multiplier) + (rainbows × 10)`
- Rainbow = hand containing all 4 suits (+10 points bonus)

## Game State (server/server.js)

Key state variables in `gameState` object:
- `hands` - Player cards by socket ID
- `currentTurn` - Position (1-4) of active player
- `bidding` - 1 for bidding phase, 0 for playing phase
- `dealer` - Position of dealer (rotates each hand)
- `currentHand` - Card count (12 down to 1)
- `trump` - Trump card {suit, rank}
- `bids/tricks/score` - Per-team tracking
- `rainbows` - Rainbow hand count per team

## Card Data Structure

```javascript
{ suit: "spades|hearts|diamonds|clubs|joker", rank: "2"-"K"|"A"|"HI"|"LO" }
```

Deck: 52 standard cards + 2 jokers (HI and LO)
