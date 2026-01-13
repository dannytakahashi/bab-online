# BAB Online

A 4-player online multiplayer trick-taking card game. Players bid on tricks, with special scoring for "rainbow" hands (all 4 suits). Game progresses from 12-card hands down to 1, then repeats. Teams: Positions 1 & 3 vs Positions 2 & 4.

## Technology Stack

- **Frontend**: Phaser 3.55.2 (game engine), ES6 Modules, Socket.io 4.0.1
- **Backend**: Node.js, Express.js 4.21.2, Socket.IO 4.8.1
- **Database**: MongoDB with Mongoose 8.12.1
- **Security**: Helmet, bcryptjs for password hashing
- **Deployment**: Railway.app

## Project Structure

```
bab-online/
├── client/
│   ├── js/                         # Modular ES6 client code
│   │   ├── main.js                 # Entry point, auth flow
│   │   ├── config.js               # Centralized constants
│   │   ├── socket/
│   │   │   └── SocketManager.js    # Connection with listener cleanup
│   │   ├── scenes/
│   │   │   └── GameScene.js        # Phaser game scene
│   │   ├── game/
│   │   │   ├── CardManager.js      # Card sprites and animations
│   │   │   └── GameState.js        # Client state container
│   │   └── ui/
│   │       └── UIManager.js        # DOM lifecycle management
│   ├── styles/
│   │   └── components.css          # All UI component styles
│   ├── game.js                     # Legacy: Phaser scene (preserved)
│   ├── ui.js                       # Legacy: DOM UI (preserved)
│   ├── index.html                  # Entry point
│   └── assets/                     # Card images, backgrounds
├── server/
│   ├── index.js                    # Entry point
│   ├── config/
│   │   └── index.js                # Server configuration
│   ├── game/
│   │   ├── Deck.js                 # Card deck with shuffle
│   │   ├── GameState.js            # Per-game state + room management
│   │   ├── GameManager.js          # Queue and game coordination
│   │   └── rules.js                # Pure game logic functions
│   ├── socket/
│   │   ├── index.js                # Socket event routing
│   │   ├── authHandlers.js         # signIn, signUp
│   │   ├── queueHandlers.js        # joinQueue, leaveQueue, disconnect handling
│   │   ├── gameHandlers.js         # playCard, playerBid, draw
│   │   ├── reconnectHandlers.js    # rejoinGame for mid-game reconnection
│   │   ├── chatHandlers.js         # chatMessage
│   │   ├── validators.js           # Joi validation schemas
│   │   ├── errorHandler.js         # Handler wrappers with rate limiting
│   │   └── rateLimiter.js          # Per-socket rate limiting
│   ├── routes/
│   │   └── index.js                # Express routes, /health endpoint
│   ├── utils/
│   │   └── timing.js               # Async delay utilities
│   ├── server.js                   # Legacy: monolithic server (preserved)
│   └── database.js                 # MongoDB connection
├── docs/
│   └── todos/                      # Improvement roadmap
├── package.json
└── .env
```

## Key Files

### Server (Modular)
- `server/index.js` - Entry point, Express/Socket.IO setup
- `server/game/rules.js` - Pure functions: `determineWinner()`, `isLegalMove()`, `calculateScore()`, `isRainbow()`
- `server/game/GameState.js` - Encapsulated game state class
- `server/game/GameManager.js` - Singleton managing queue and active games
- `server/socket/gameHandlers.js` - Game event handlers

### Client (Modular)
- `client/js/main.js` - Entry point, auth/lobby flow
- `client/js/game/GameState.js` - Client state (replaces globals)
- `client/js/game/CardManager.js` - Card sprites and animations
- `client/js/socket/SocketManager.js` - Socket with listener tracking
- `client/js/scenes/GameScene.js` - Phaser scene with lifecycle

### Legacy (Preserved)
- `server/server.js` - Original monolithic server
- `client/game.js` - Original Phaser scene
- `client/ui.js` - Original DOM UI

## Architecture Patterns

- **Communication**: Socket.io bidirectional WebSocket
- **State**: Server-authoritative, `GameState` class per game instance
- **Client State**: `GameState` singleton replaces 50+ globals
- **State Validation**: Server validates all actions (`validateTurn`, `validateCardPlay`, `validateBid`)
- **Input Validation**: Joi schemas validate all socket event data (`validators.js`)
- **Error Handling**: All handlers wrapped with try/catch, validation errors sent to client (`errorHandler.js`)
- **Rate Limiting**: Per-socket limits prevent spam/abuse (`rateLimiter.js`)
- **Socket Rooms**: Game events broadcast only to game participants via `game.broadcast()`
- **Optimistic Updates**: Client updates UI immediately, rolls back on server rejection
- **Socket Cleanup**: `SocketManager` tracks listeners, prevents memory leaks
- **Reconnection**: 30-second grace period for disconnected players to rejoin via `rejoinGame` event
- **UI**: Phaser for game canvas, `UIManager` for DOM lifecycle
- **Animations**: Phaser tweens (Power2 easing, 200-500ms durations)
- **Game Logic**: Pure functions in `rules.js` for testability

## Game Flow

1. Authentication (signIn/signUp) → MongoDB users collection
2. Queue management → Game starts when 4 players ready
3. Draw phase → Players draw cards to determine positions (1-4)
4. Hand progression (12→1 cards) with bidding then playing phases
5. Trick evaluation, scoring with rainbow bonuses

## Key Socket Events

**Client → Server**: `signIn`, `signUp`, `joinQueue`, `leaveQueue`, `playerBid`, `playCard`, `chatMessage`, `draw`, `rejoinGame`

**Server → Client**: `gameStart`, `yourHand`, `trumpCard`, `bidReceived`, `doneBidding`, `cardPlayed`, `updateTurn`, `trickComplete`, `handComplete`, `gameEnd`, `rainbow`, `positionUpdate`, `rejoinSuccess`, `rejoinFailed`, `playerDisconnected`, `playerReconnected`

## Development Commands

```bash
npm run dev      # Development: nodemon server/index.js (modular)
npm run dev:old  # Development: nodemon server/server.js (legacy)
npm start        # Production: node server/index.js
npm start:old    # Production: node server/server.js (legacy)
```

Server runs on port 3000.

## Common Tasks

### Game Logic Changes
- **Rules**: `server/game/rules.js` - `determineWinner()`, `isLegalMove()`, `calculateScore()`
- **State**: `server/game/GameState.js` - game state management
- **Flow**: `server/socket/gameHandlers.js` - `playCard()`, `playerBid()`

### UI Changes
- **Styles**: `client/styles/components.css` - CSS classes for all UI
- **DOM**: `client/js/ui/UIManager.js` - element lifecycle
- **Game Canvas**: `client/js/scenes/GameScene.js` - Phaser scene
- **Cards**: `client/js/game/CardManager.js` - card sprites

### Adding Socket Events
1. Add handler in `server/socket/gameHandlers.js` (or appropriate handler file)
2. Register in `server/socket/index.js`
3. Add listener in `client/js/scenes/GameScene.js` via `socketManager.on()`
4. Remember to add cleanup in `shutdown()` method

### Adding Card Assets
1. Place PNG in `client/assets/`
2. Add to `loadCardAssets()` in `GameScene.js`
3. Update `getCardTextureKey()` in `CardManager.js` if needed

## Scoring Rules

- Made bid: `+(bid × 10 × multiplier) + (tricks - bid) + (rainbows × 10)`
- Missed bid: `-(bid × 10 × multiplier) + (rainbows × 10)`
- Rainbow = hand containing all 4 suits (+10 points bonus)
- Multipliers: Board (2x), Double Board (4x)

## Game State

### Server (`server/game/GameState.js`)
```javascript
class GameState {
    // Core state
    gameId, roomName, players, positions, hands, currentHand, dealer,
    bidding, bids, team1Mult, team2Mult, currentTurn, leadPosition,
    currentTrick, trump, trumpBroken, team1Tricks, team2Tricks,
    team1Score, team2Score, team1Rainbows, team2Rainbows

    // Validation methods
    validateTurn(socketId)           // Returns { valid, error? }
    validateCardPlay(socketId, card) // Validates turn, phase, card ownership, trick state
    validateBid(socketId, bid)       // Validates turn, phase, bid value
    validateGameState()              // Full consistency check, returns { valid, errors[] }

    // Room management (Socket.IO rooms for targeted broadcasts)
    joinToRoom(io, socketId)         // Add player to game room
    leaveRoom(io, socketId)          // Remove player from room
    joinAllToRoom(io)                // Add all players to room
    leaveAllFromRoom(io)             // Remove all (on game end)
    broadcast(io, event, data)       // Send to all players in game
    sendToPlayer(io, socketId, event, data) // Send to specific player

    // Debug logging (development mode only)
    logAction(action, details)       // Log state changes
    logState()                       // Log current state summary
    logValidation(action, result)    // Log failed validations
}
```

### Client (`client/js/game/GameState.js`)
```javascript
class GameState {
    // Core state
    playerId, username, position, pic, myCards, currentHand,
    trump, dealer, phase, currentTurn, isBidding, leadCard,
    playedCards, trumpBroken, bids, teamTricks, oppTricks,
    teamScore, oppScore, players

    // Optimistic updates (instant UI feedback before server confirms)
    optimisticPlayCard(card)   // Remove card locally, returns boolean
    confirmCardPlay()          // Clear pending state on success
    rollbackCardPlay()         // Restore card on server rejection
    optimisticBid(bid)         // Record bid locally
    confirmBid() / rollbackBid()
    hasPendingAction()         // Check if waiting for server

    // Event system (for reactive UI updates)
    on(event, callback)        // Subscribe, returns unsubscribe function
    off(event, callback)       // Unsubscribe
    _emit(event, data)         // Notify listeners
    // Events: 'handChanged', 'bidChanged'
}
```

## Card Data Structure

```javascript
{ suit: "spades|hearts|diamonds|clubs|joker", rank: "2"-"K"|"A"|"HI"|"LO" }
```

Deck: 52 standard cards + 2 jokers (HI and LO)

## Key Classes

### GameManager (server)
Singleton managing queue and active games. Methods: `joinQueue()`, `leaveQueue()`, `createGame()`, `getPlayerGame()`, `handleDisconnect()`, `updatePlayerGameMapping()`, `checkGameAbort()`

### Reconnection Flow
When a player disconnects mid-game:
1. Server marks player as disconnected, starts 30-second grace period timer
2. Other players see "[username] disconnected - waiting for reconnection..."
3. If player refreshes/reconnects within 30 seconds:
   - Client sends `rejoinGame` with stored `gameId` and `username` from sessionStorage
   - Server finds game, validates player, updates socket mapping
   - Client receives `rejoinSuccess` with full game state (hand, trump, scores, etc.)
   - Client waits for Phaser scene to be ready, then rebuilds UI
4. If grace period expires, game is aborted for all players

### SocketManager (client)
Singleton for socket connection with listener tracking. Methods: `connect()`, `on()`, `off()`, `offAll()`, `emit()`, `cleanupGameListeners()`

### CardManager (client)
Manages card sprites in Phaser. Methods: `displayHand()`, `playCard()`, `animateOpponentCard()`, `collectTrick()`, `isLegalMove()`

### UIManager (client)
DOM element lifecycle management. Methods: `getOrCreate()`, `remove()`, `show()`, `hide()`, `showModal()`, `showError()`, `cleanup()`

### Socket Infrastructure (server)

**validators.js** - Joi validation schemas for socket events:
- `signIn`, `signUp` - Auth validation
- `playCard`, `playerBid`, `draw` - Game action validation
- `chatMessage` - Chat validation
- Usage: `validate('playCard', data)` returns validated data or throws `ValidationError`

**errorHandler.js** - Handler wrappers:
- `asyncHandler(schemaName, handler)` - Wraps async handlers with validation, rate limiting, error handling
- `syncHandler(schemaName, handler)` - Same for sync handlers
- `safeHandler(handler)` - Simple wrapper without validation/rate limiting

**rateLimiter.js** - Per-socket rate limiting:
- Configurable limits per event type (e.g., `signIn: 5/min`, `chatMessage: 10/10s`)
- `check(socketId, event)` - Returns true if allowed
- `clearSocket(socketId)` - Cleanup on disconnect
