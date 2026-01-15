# BAB Online

A 4-player online multiplayer trick-taking card game (Back Alley Bridge). Players bid on tricks, with special scoring for "rainbow" hands (all 4 suits). Hand progression: 12→10→8→6→4→2→1→3→5→7→9→11→13, then game ends. Teams: Positions 1 & 3 vs Positions 2 & 4.

> **Complete game rules**: See [docs/RULES.md](docs/RULES.md) for detailed rules including bidding, bore mechanics, trump, and scoring.

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
│   ├── game.js                     # Phaser scene (active)
│   ├── ui.js                       # DOM UI (active)
│   ├── socketManager.js            # Socket connection manager
│   ├── index.html                  # Entry point
│   └── assets/                     # Card images, backgrounds
├── server/
│   ├── index.js                    # Entry point
│   ├── config/
│   │   └── index.js                # Server configuration
│   ├── game/
│   │   ├── Deck.js                 # Card deck with shuffle
│   │   ├── GameState.js            # Per-game state + room management
│   │   ├── GameManager.js          # Queue, lobby, and game coordination
│   │   └── rules.js                # Pure game logic functions
│   ├── socket/
│   │   ├── index.js                # Socket event routing
│   │   ├── authHandlers.js         # signIn, signUp (with auto-login)
│   │   ├── mainRoomHandlers.js     # Main room chat and lobby browsing
│   │   ├── queueHandlers.js        # joinQueue (creates/joins lobby)
│   │   ├── lobbyHandlers.js        # playerReady, lobbyChat, leaveLobby
│   │   ├── gameHandlers.js         # playCard, playerBid, draw
│   │   ├── reconnectHandlers.js    # rejoinGame for mid-game reconnection
│   │   ├── chatHandlers.js         # chatMessage (in-game)
│   │   ├── validators.js           # Joi validation schemas
│   │   ├── errorHandler.js         # Handler wrappers with rate limiting
│   │   └── rateLimiter.js          # Per-socket rate limiting
│   ├── routes/
│   │   └── index.js                # Express routes, /health endpoint
│   ├── utils/
│   │   └── timing.js               # Async delay utilities
│   └── database.js                 # MongoDB connection
├── docs/
│   ├── RULES.md                    # Complete game rules
│   └── todos/                      # Improvement roadmap
├── package.json
└── .env
```

## Key Files

### Server
- `server/index.js` - Entry point, Express/Socket.IO setup
- `server/game/rules.js` - Pure functions: `determineWinner()`, `isLegalMove()`, `calculateScore()`, `isRainbow()`
- `server/game/GameState.js` - Encapsulated game state class
- `server/game/GameManager.js` - Singleton managing queue, lobbies, and active games
- `server/socket/gameHandlers.js` - Game event handlers
- `server/socket/mainRoomHandlers.js` - Main room and lobby browser handlers

### Client (Active)
- `client/game.js` - Phaser scene, card rendering, game flow
- `client/ui.js` - DOM UI (auth, lobbies, main room, game log)
- `client/socketManager.js` - Socket connection with event forwarding
- `client/styles/components.css` - UI component styles

### Client (Modular - Reference)
- `client/js/main.js` - Entry point, auth/lobby flow
- `client/js/game/GameState.js` - Client state class
- `client/js/game/CardManager.js` - Card sprites and animations
- `client/js/socket/SocketManager.js` - Socket with listener tracking
- `client/js/scenes/GameScene.js` - Phaser scene with lifecycle

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
- **Responsive Layout**: Dynamic game container width (full in lobby, restricted during game for game log)
- **Turn Indicator**: CSS-based glow effect (`.turn-glow` class) for proper resize handling

## Game Flow

1. Authentication (signIn/signUp) → MongoDB users collection; auto-login after registration
2. Main Room → Global chat, browse/create game lobbies
3. Game Lobby → 4 players chat and click "Ready" when prepared
4. All 4 ready → Transition to draw phase
5. Draw phase → Players draw cards to determine positions; teams announced (1&3 vs 2&4)
6. Hand progression (12→10→8→6→4→2→1→3→5→7→9→11→13) with bidding then playing phases
7. Trick evaluation, scoring displayed in game log; rainbow bonuses (4-card hand only)
8. Game end → Final scores in game log, return to main room

## Key Socket Events

**Client → Server**: `signIn`, `signUp`, `joinMainRoom`, `mainRoomChat`, `createLobby`, `joinLobby`, `playerReady`, `lobbyChat`, `leaveLobby`, `draw`, `playerBid`, `playCard`, `chatMessage`, `rejoinGame`

**Server → Client**: `mainRoomJoined`, `mainRoomMessage`, `lobbiesUpdated`, `lobbyCreated`, `lobbyJoined`, `playerReadyUpdate`, `lobbyMessage`, `lobbyPlayerLeft`, `allPlayersReady`, `startDraw`, `playerDrew`, `youDrew`, `teamsAnnounced`, `positionUpdate`, `createUI`, `gameStart`, `bidReceived`, `doneBidding`, `cardPlayed`, `updateTurn`, `trickComplete`, `handComplete`, `gameEnd`, `rainbow`, `rejoinSuccess`, `rejoinFailed`, `playerDisconnected`, `playerReconnected`, `activeGameFound`

## Development Commands

```bash
npm run dev      # Development with hot reload
npm start        # Production server
npm test         # Run tests
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
- Rainbow = 4-card hand containing all 4 suits (+10 points bonus)
- Bore multipliers: B (2x), 2B (4x), 3B (8x), 4B (16x)

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
Singleton managing lobbies, queue, and active games. Methods: `joinQueue()` (creates/joins lobby), `createLobby()`, `setPlayerReady()`, `addLobbyMessage()`, `leaveLobby()`, `startGameFromLobby()`, `createGame()`, `getPlayerGame()`, `getPlayerLobby()`, `handleDisconnect()`, `updatePlayerGameMapping()`, `checkGameAbort()`

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

### Cross-Browser Reconnection
Players can rejoin from a different browser/device:
1. Server stores `activeGameId` in MongoDB user document when game starts
2. On sign-in, server checks if user has an active game
3. If found, emits `activeGameFound` event with gameId
4. Client prompts user to rejoin or shows auto-rejoin flow

### SocketManager (client)
Singleton for socket connection with listener tracking. Methods: `connect()`, `on()`, `off()`, `offAll()`, `emit()`, `cleanupGameListeners()`

### CardManager (client)
Manages card sprites in Phaser. Methods: `displayHand()`, `playCard()`, `animateOpponentCard()`, `collectTrick()`, `isLegalMove()`

### UIManager (client)
DOM element lifecycle management. Methods: `getOrCreate()`, `remove()`, `show()`, `hide()`, `showModal()`, `showError()`, `cleanup()`

### Socket Infrastructure (server)

**validators.js** - Joi validation schemas for socket events:
- `signIn`, `signUp` - Auth validation
- `lobbyChat` - Lobby chat validation
- `playCard`, `playerBid`, `draw` - Game action validation
- `chatMessage` - In-game chat validation
- Usage: `validate('playCard', data)` returns validated data or throws `ValidationError`

**errorHandler.js** - Handler wrappers:
- `asyncHandler(schemaName, handler)` - Wraps async handlers with validation, rate limiting, error handling
- `syncHandler(schemaName, handler)` - Same for sync handlers
- `safeHandler(handler)` - Simple wrapper without validation/rate limiting

**rateLimiter.js** - Per-socket rate limiting:
- Configurable limits per event type (e.g., `signIn: 5/min`, `chatMessage: 10/10s`)
- `check(socketId, event)` - Returns true if allowed
- `clearSocket(socketId)` - Cleanup on disconnect
