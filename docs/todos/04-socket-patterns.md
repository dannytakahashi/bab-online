# Socket.IO Patterns

## Overview
Socket event handling has critical issues on both client and server that cause memory leaks, missing error handling, and poor connection management.

## Current Problems

### Client (game.js)
- Event listeners registered in `create()` never cleaned up
- Listeners accumulate with each game/hand
- No reconnection logic
- No connection state management

### Server (server/server.js)
- No event validation
- No error handling in handlers
- No rate limiting
- No timeout handling

---

## Task 1: Client - Fix Event Listener Leaks

**Problem:** Listeners registered every time without cleanup

**Current (game.js lines 103-150, 1103-1574):**
```javascript
create() {
    // These listeners are added every time create() is called
    // but never removed!
    socket.on("bidReceived", (data) => { ... });
    socket.on("updateTurn", (data) => { ... });
    socket.on("cardPlayed", (data) => { ... });
    // ... 15+ more listeners
}
```

**Solution:** Track and clean up listeners (from 02-client-architecture.md SocketManager):

```javascript
class GameScene extends Phaser.Scene {
    create() {
        // Store cleanup functions
        this.cleanups = [];

        // Register with tracking
        this.cleanups.push(
            socketManager.on('bidReceived', this.handleBid.bind(this)),
            socketManager.on('updateTurn', this.handleTurn.bind(this)),
            socketManager.on('cardPlayed', this.handleCard.bind(this))
        );
    }

    shutdown() {
        // Clean up all listeners when scene ends
        this.cleanups.forEach(cleanup => cleanup());
        this.cleanups = [];
    }
}
```

---

## Task 2: Client - Implement Reconnection Logic

**Problem:** Disconnect just restarts scene, loses game state

**Current (game.js lines 734-744):**
```javascript
socket.on("disconnect", () => {
    // Just restarts everything - loses game progress!
    this.scene.restart();
});
```

**Solution:** Implement reconnection with state recovery

```javascript
class SocketManager {
    constructor() {
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.gameId = null;  // Store current game ID
    }

    connect() {
        this.socket = io({
            reconnection: true,
            reconnectionAttempts: this.maxReconnectAttempts,
            reconnectionDelay: this.reconnectDelay,
            reconnectionDelayMax: 5000
        });

        this.socket.on('connect', () => {
            console.log('Connected:', this.socket.id);

            // If we were in a game, try to rejoin
            if (this.gameId) {
                this.rejoinGame();
            }
        });

        this.socket.on('disconnect', (reason) => {
            console.log('Disconnected:', reason);
            this.handleDisconnect(reason);
        });

        this.socket.on('reconnect_attempt', (attemptNumber) => {
            console.log(`Reconnect attempt ${attemptNumber}/${this.maxReconnectAttempts}`);
            this.emit('reconnecting', attemptNumber);
        });

        this.socket.on('reconnect_failed', () => {
            console.log('Reconnection failed');
            this.emit('reconnectFailed');
        });
    }

    handleDisconnect(reason) {
        if (reason === 'io server disconnect') {
            // Server forced disconnect - try to reconnect
            this.socket.connect();
        }
        // For other reasons, socket.io handles reconnection
    }

    rejoinGame() {
        this.socket.emit('rejoinGame', {
            gameId: this.gameId,
            username: sessionStorage.getItem('username')
        });
    }

    setGameId(gameId) {
        this.gameId = gameId;
    }

    clearGameId() {
        this.gameId = null;
    }
}
```

**Server handler for rejoin:**
```javascript
socket.on('rejoinGame', async (data) => {
    const { gameId, username } = data;

    const game = gameManager.getGame(gameId);
    if (!game) {
        socket.emit('rejoinFailed', { reason: 'Game no longer exists' });
        return;
    }

    // Find player's old position
    const existingPlayer = game.getPlayerByUsername(username);
    if (!existingPlayer) {
        socket.emit('rejoinFailed', { reason: 'Not a player in this game' });
        return;
    }

    // Update socket ID mapping
    game.updatePlayerSocket(existingPlayer.position, socket.id);
    gameManager.addPlayerToGame(socket.id, gameId);

    // Send current game state
    socket.emit('rejoinSuccess', {
        position: existingPlayer.position,
        hand: game.getHand(socket.id),
        gameState: game.getClientState()
    });

    // Notify other players
    game.broadcast('playerReconnected', {
        position: existingPlayer.position,
        username
    });
});
```

---

## Task 3: Client - Connection State UI

**Problem:** User has no feedback about connection status

**Solution:** Add connection indicator

```javascript
class ConnectionIndicator {
    constructor() {
        this.element = this.createElement();
        this.setupListeners();
    }

    createElement() {
        const el = document.createElement('div');
        el.className = 'connection-indicator';
        el.innerHTML = `
            <span class="status-dot"></span>
            <span class="status-text">Connected</span>
        `;
        document.body.appendChild(el);
        return el;
    }

    setupListeners() {
        socketManager.on('connect', () => this.setConnected());
        socketManager.on('disconnect', () => this.setDisconnected());
        socketManager.on('reconnecting', (attempt) => this.setReconnecting(attempt));
    }

    setConnected() {
        this.element.className = 'connection-indicator connected';
        this.element.querySelector('.status-text').textContent = 'Connected';
    }

    setDisconnected() {
        this.element.className = 'connection-indicator disconnected';
        this.element.querySelector('.status-text').textContent = 'Disconnected';
    }

    setReconnecting(attempt) {
        this.element.className = 'connection-indicator reconnecting';
        this.element.querySelector('.status-text').textContent = `Reconnecting (${attempt})...`;
    }
}
```

**CSS:**
```css
.connection-indicator {
    position: fixed;
    top: 10px;
    right: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    font-size: 12px;
    z-index: 9999;
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.connected .status-dot { background: #4ade80; }
.disconnected .status-dot { background: #ef4444; }
.reconnecting .status-dot {
    background: #fbbf24;
    animation: blink 1s infinite;
}

@keyframes blink {
    50% { opacity: 0.5; }
}
```

---

## Task 4: Server - Add Event Validation

**Problem:** No validation on incoming socket data

**Current (server/server.js lines 645-680):**
```javascript
socket.on("playCard", (data) => {
    // No validation of data.card format
    // No validation that position is 1-4
    // No validation player has this card
    if (data.position !== gameState.currentTurn) {
        return;
    }
    // Proceeds with invalid data...
});
```

**Solution:** Add validation schemas

```javascript
// server/socket/validators.js
const Joi = require('joi');

const cardSchema = Joi.object({
    suit: Joi.string().valid('spades', 'hearts', 'diamonds', 'clubs', 'joker').required(),
    rank: Joi.string().valid(
        '2', '3', '4', '5', '6', '7', '8', '9', '10',
        'J', 'Q', 'K', 'A', 'HI', 'LO'
    ).required()
});

const schemas = {
    playCard: Joi.object({
        card: cardSchema.required(),
        position: Joi.number().integer().min(1).max(4).required()
    }),

    playerBid: Joi.object({
        bid: Joi.alternatives().try(
            Joi.number().integer().min(0).max(12),
            Joi.string().valid('B', '2B')  // Board bids
        ).required(),
        position: Joi.number().integer().min(1).max(4).required()
    }),

    signIn: Joi.object({
        username: Joi.string().min(3).max(20).alphanum().required(),
        password: Joi.string().min(6).max(100).required()
    }),

    signUp: Joi.object({
        username: Joi.string().min(3).max(20).alphanum().required(),
        password: Joi.string().min(6).max(100).required(),
        pic: Joi.number().integer().min(1).max(82).default(1)
    }),

    chatMessage: Joi.object({
        text: Joi.string().min(1).max(500).required()
    })
};

function validate(schemaName, data) {
    const schema = schemas[schemaName];
    if (!schema) {
        throw new Error(`Unknown schema: ${schemaName}`);
    }

    const { error, value } = schema.validate(data, {
        stripUnknown: true,  // Remove extra fields
        abortEarly: false    // Return all errors
    });

    if (error) {
        const messages = error.details.map(d => d.message);
        throw new ValidationError(messages.join(', '));
    }

    return value;
}

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.isValidation = true;
    }
}

module.exports = { validate, schemas, ValidationError };
```

**Usage in handler:**
```javascript
const { validate, ValidationError } = require('./validators');

socket.on('playCard', (data) => {
    try {
        // Validate and sanitize input
        const validData = validate('playCard', data);

        // Now safe to use
        const game = gameManager.getPlayerGame(socket.id);
        if (!game) {
            socket.emit('error', { message: 'Not in a game' });
            return;
        }

        // Verify player owns this position
        const playerPosition = game.getPositionBySocketId(socket.id);
        if (playerPosition !== validData.position) {
            socket.emit('error', { message: 'Invalid position' });
            return;
        }

        // Verify player has this card
        if (!game.playerHasCard(socket.id, validData.card)) {
            socket.emit('error', { message: 'Card not in hand' });
            return;
        }

        // Process valid move
        handlePlayCard(game, socket, validData);

    } catch (error) {
        if (error.isValidation) {
            socket.emit('error', { message: error.message });
        } else {
            console.error('playCard error:', error);
            socket.emit('error', { message: 'Server error' });
        }
    }
});
```

---

## Task 5: Server - Add Error Handling Wrapper

**Problem:** Errors in handlers crash or behave unexpectedly

**Solution:** Create handler wrapper

```javascript
// server/socket/errorHandler.js

/**
 * Wrap async socket handler with error handling
 */
function asyncHandler(handler) {
    return async (socket, io, data) => {
        try {
            await handler(socket, io, data);
        } catch (error) {
            console.error(`Socket handler error:`, {
                event: handler.name,
                socketId: socket.id,
                error: error.message,
                stack: error.stack
            });

            if (error.isValidation) {
                socket.emit('error', { message: error.message });
            } else {
                socket.emit('error', { message: 'An error occurred' });
            }
        }
    };
}

/**
 * Wrap sync socket handler
 */
function syncHandler(handler) {
    return (socket, io, data) => {
        try {
            handler(socket, io, data);
        } catch (error) {
            console.error(`Socket handler error:`, {
                event: handler.name,
                socketId: socket.id,
                error: error.message
            });
            socket.emit('error', { message: 'An error occurred' });
        }
    };
}

module.exports = { asyncHandler, syncHandler };
```

**Usage:**
```javascript
const { asyncHandler, syncHandler } = require('./errorHandler');
const handlers = require('./gameHandlers');

io.on('connection', (socket) => {
    socket.on('signIn', asyncHandler(handlers.signIn));
    socket.on('playCard', asyncHandler(handlers.playCard));
    socket.on('playerBid', syncHandler(handlers.playerBid));
    socket.on('chatMessage', syncHandler(handlers.chatMessage));
});
```

---

## Task 6: Server - Add Rate Limiting

**Problem:** No protection against spam/abuse

**Solution:** Per-socket rate limiting

```javascript
// server/socket/rateLimiter.js

class RateLimiter {
    constructor() {
        this.limits = {
            chatMessage: { max: 5, windowMs: 10000 },   // 5 per 10s
            playCard: { max: 10, windowMs: 60000 },     // 10 per minute
            signIn: { max: 5, windowMs: 60000 },        // 5 per minute
            signUp: { max: 3, windowMs: 300000 }        // 3 per 5 minutes
        };
        this.requests = new Map();  // socketId → { event → timestamps[] }
    }

    check(socketId, event) {
        const limit = this.limits[event];
        if (!limit) return true;  // No limit defined

        const key = `${socketId}:${event}`;
        const now = Date.now();
        const windowStart = now - limit.windowMs;

        // Get or create timestamps array
        let timestamps = this.requests.get(key) || [];

        // Remove old timestamps
        timestamps = timestamps.filter(t => t > windowStart);

        // Check limit
        if (timestamps.length >= limit.max) {
            return false;  // Rate limited
        }

        // Record this request
        timestamps.push(now);
        this.requests.set(key, timestamps);

        return true;
    }

    clear(socketId) {
        // Remove all entries for this socket
        for (const key of this.requests.keys()) {
            if (key.startsWith(socketId)) {
                this.requests.delete(key);
            }
        }
    }
}

const rateLimiter = new RateLimiter();
module.exports = rateLimiter;
```

**Usage:**
```javascript
const rateLimiter = require('./rateLimiter');

socket.on('chatMessage', (data) => {
    if (!rateLimiter.check(socket.id, 'chatMessage')) {
        socket.emit('error', { message: 'Too many messages, slow down' });
        return;
    }

    // Process message...
});

socket.on('disconnect', () => {
    rateLimiter.clear(socket.id);
});
```

---

## Task 7: Server - Socket Rooms for Games

**Problem:** Broadcasting to all players inefficient

**Current:**
```javascript
// Manually emit to each player
for (const [socketId] of game.players) {
    io.to(socketId).emit('cardPlayed', data);
}
```

**Solution:** Use Socket.IO rooms

```javascript
// When game starts, add all players to a room
function startGame(io, game) {
    const roomName = `game:${game.gameId}`;

    for (const [socketId] of game.players) {
        io.sockets.sockets.get(socketId)?.join(roomName);
    }

    game.roomName = roomName;
}

// Broadcast to game
function broadcastToGame(io, game, event, data) {
    io.to(game.roomName).emit(event, data);
}

// Send to specific player
function sendToPlayer(io, socketId, event, data) {
    io.to(socketId).emit(event, data);
}

// Cleanup when game ends
function endGame(io, game) {
    // Remove all players from room
    for (const [socketId] of game.players) {
        io.sockets.sockets.get(socketId)?.leave(game.roomName);
    }
}
```

---

## Task 8: Add Heartbeat/Ping Monitoring

**Problem:** Can't detect stale connections

**Solution:** Monitor ping/pong

```javascript
// Server-side
io.on('connection', (socket) => {
    // Socket.IO has built-in ping/pong, but we can add custom monitoring
    socket.lastPing = Date.now();

    socket.on('pong', () => {
        socket.lastPing = Date.now();
    });

    // Check for stale connections periodically
    const interval = setInterval(() => {
        const staleDuration = Date.now() - socket.lastPing;
        if (staleDuration > 60000) {  // 1 minute without response
            console.log(`Stale connection detected: ${socket.id}`);
            socket.disconnect(true);
        }
    }, 30000);

    socket.on('disconnect', () => {
        clearInterval(interval);
    });
});
```

**Client-side monitoring:**
```javascript
// Track latency
socketManager.on('pong', (latency) => {
    console.log(`Latency: ${latency}ms`);

    // Show warning if latency is high
    if (latency > 200) {
        showLatencyWarning(latency);
    }
});
```

---

## Verification

1. [ ] No socket listener accumulation (check with `socket.listeners()`)
2. [ ] Reconnection works and restores game state
3. [ ] Connection indicator shows correct status
4. [ ] Invalid data is rejected with helpful error messages
5. [ ] Rate limiting prevents spam
6. [ ] Errors don't crash server
7. [ ] Room-based broadcasting works correctly
8. [ ] Stale connections are cleaned up
