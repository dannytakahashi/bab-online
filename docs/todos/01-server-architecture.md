# Server Architecture Refactoring

## Overview
The current `server/server.js` is a monolithic 844-line file containing all game logic, socket handlers, routes, and state management. This needs to be split into focused modules.

## Critical Issues

1. **Blocking `sleepSync()` function** (lines 2-6) freezes the entire Node.js event loop
2. **50+ global variables** (lines 52-162) prevent concurrent games
3. **All logic in one file** makes testing and maintenance impossible
4. **No separation of concerns** - auth, game rules, socket handlers all mixed together

---

## Task 1: Create Directory Structure

Create the following directory structure:

```
server/
├── index.js              # Entry point, server setup
├── config/
│   └── index.js          # Configuration management
├── database.js           # Database connection (existing, needs fixes)
├── game/
│   ├── Deck.js           # Card deck management
│   ├── GameEngine.js     # Core game rules and logic
│   ├── GameManager.js    # Manages multiple game instances
│   ├── GameState.js      # State container for a single game
│   └── rules.js          # Pure functions for game rules
├── socket/
│   ├── index.js          # Socket.io setup and middleware
│   ├── authHandlers.js   # signIn, signUp handlers
│   ├── queueHandlers.js  # joinQueue, leaveQueue handlers
│   ├── gameHandlers.js   # playCard, playerBid handlers
│   └── chatHandlers.js   # chatMessage handlers
├── routes/
│   └── index.js          # Express routes
└── utils/
    ├── logger.js         # Structured logging
    └── timing.js         # Async timing utilities
```

---

## Task 2: Replace Blocking `sleepSync` with Async Utilities

**Current (BROKEN):** `server/server.js` lines 2-6
```javascript
function sleepSync(milliseconds) {
    const start = Date.now();
    while (Date.now() - start < milliseconds) {
    }
}
```

**Create:** `server/utils/timing.js`
```javascript
/**
 * Async delay utility - does NOT block the event loop
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Schedule a callback after delay
 * @param {Function} callback - Function to call
 * @param {number} ms - Delay in milliseconds
 * @returns {NodeJS.Timeout} - Timer ID for cancellation
 */
function schedule(callback, ms) {
    return setTimeout(callback, ms);
}

/**
 * Create a debounced function
 * @param {Function} fn - Function to debounce
 * @param {number} ms - Debounce delay
 */
function debounce(fn, ms) {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), ms);
    };
}

module.exports = { delay, schedule, debounce };
```

**Update usages:** Replace all `sleepSync()` calls with async `await delay()`:
- Line 559: `sleepSync(3500)` → `await delay(3500)`
- Line 602: `sleepSync(1000)` → `await delay(1000)`
- Line 605: `sleepSync(2000)` → `await delay(2000)`
- Line 629: `sleepSync(1000)` → `await delay(1000)`
- Line 689: `sleepSync(2000)` → `await delay(2000)`
- Line 698: `sleepSync(4000)` → `await delay(4000)`

---

## Task 3: Create Deck Class

**Create:** `server/game/Deck.js`
```javascript
const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

class Deck {
    constructor() {
        this.cards = [];
        this.reset();
    }

    /**
     * Reset deck to full 54 cards (52 + 2 jokers)
     */
    reset() {
        this.cards = [];

        // Standard cards
        for (const suit of SUITS) {
            for (const rank of RANKS) {
                this.cards.push({ suit, rank });
            }
        }

        // Jokers
        this.cards.push({ suit: 'joker', rank: 'HI' });
        this.cards.push({ suit: 'joker', rank: 'LO' });
    }

    /**
     * Fisher-Yates shuffle
     */
    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }

    /**
     * Draw n cards from the deck
     * @param {number} n - Number of cards to draw
     * @returns {Array} - Drawn cards
     */
    draw(n) {
        if (n > this.cards.length) {
            throw new Error(`Cannot draw ${n} cards, only ${this.cards.length} remaining`);
        }
        return this.cards.splice(0, n);
    }

    /**
     * Draw a single card
     * @returns {Object} - Single card
     */
    drawOne() {
        if (this.cards.length === 0) {
            throw new Error('Deck is empty');
        }
        return this.cards.shift();
    }

    get remaining() {
        return this.cards.length;
    }
}

module.exports = Deck;
```

---

## Task 4: Extract Game Rules as Pure Functions

**Create:** `server/game/rules.js`

Extract these functions from `server/server.js` and make them pure (no side effects):

```javascript
const RANK_VALUES = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
    '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
    'LO': 15, 'HI': 16
};

/**
 * Rotate position (1→2→3→4→1)
 * @param {number} position - Current position (1-4)
 * @returns {number} - Next position
 */
function rotatePosition(position) {
    return (position % 4) + 1;
}

/**
 * Get teammate position
 * @param {number} position - Player position (1-4)
 * @returns {number} - Partner position
 */
function getPartnerPosition(position) {
    return ((position + 1) % 4) + 1;
}

/**
 * Check if two cards are same suit (considering jokers as trump)
 * @param {Object} card1 - First card
 * @param {Object} card2 - Second card
 * @param {Object} trump - Trump card
 * @returns {boolean}
 */
function isSameSuit(card1, card2, trump) {
    const suit1 = card1.suit === 'joker' ? trump.suit : card1.suit;
    const suit2 = card2.suit === 'joker' ? trump.suit : card2.suit;
    return suit1 === suit2;
}

/**
 * Check if hand is void in a suit
 * @param {Array} hand - Player's hand
 * @param {string} suit - Suit to check
 * @param {Object} trump - Trump card
 * @returns {boolean}
 */
function isVoidInSuit(hand, suit, trump) {
    return !hand.some(card => {
        const cardSuit = card.suit === 'joker' ? trump.suit : card.suit;
        return cardSuit === suit;
    });
}

/**
 * Check if a move is legal
 * @param {Object} card - Card being played
 * @param {Array} hand - Player's hand
 * @param {Object|null} leadCard - First card of trick (null if leading)
 * @param {Object} trump - Trump card
 * @param {boolean} trumpBroken - Whether trump has been played
 * @returns {boolean}
 */
function isLegalMove(card, hand, leadCard, trump, trumpBroken) {
    // Leading
    if (!leadCard) {
        // Can't lead trump unless broken (or only have trump)
        if (card.suit === trump.suit || card.suit === 'joker') {
            return trumpBroken || isVoidInSuit(hand, 'non-trump', trump);
        }
        return true;
    }

    // Following
    const leadSuit = leadCard.suit === 'joker' ? trump.suit : leadCard.suit;
    const cardSuit = card.suit === 'joker' ? trump.suit : card.suit;

    // Must follow suit if possible
    if (cardSuit !== leadSuit) {
        return isVoidInSuit(hand, leadSuit, trump);
    }

    return true;
}

/**
 * Check if hand is a rainbow (has all 4 suits)
 * @param {Array} hand - Player's hand
 * @param {Object} trump - Trump card
 * @returns {boolean}
 */
function isRainbow(hand, trump) {
    const suits = new Set();

    for (const card of hand) {
        const suit = card.suit === 'joker' ? trump.suit : card.suit;
        suits.add(suit);
    }

    return suits.size === 4;
}

/**
 * Determine winner of a trick
 * @param {Array} trick - Array of 4 cards (indexed by position-1)
 * @param {number} leadPosition - Position that led (1-4)
 * @param {Object} trump - Trump card
 * @returns {number} - Winning position (1-4)
 */
function determineWinner(trick, leadPosition, trump) {
    const leadCard = trick[leadPosition - 1];
    const leadSuit = leadCard.suit === 'joker' ? trump.suit : leadCard.suit;

    let winningPos = leadPosition;
    let winningValue = RANK_VALUES[leadCard.rank];
    let winningIsTrump = leadCard.suit === trump.suit || leadCard.suit === 'joker';

    for (let i = 0; i < 4; i++) {
        if (i === leadPosition - 1) continue;

        const card = trick[i];
        const cardSuit = card.suit === 'joker' ? trump.suit : card.suit;
        const cardValue = RANK_VALUES[card.rank];
        const cardIsTrump = card.suit === trump.suit || card.suit === 'joker';

        // Trump beats non-trump
        if (cardIsTrump && !winningIsTrump) {
            winningPos = i + 1;
            winningValue = cardValue;
            winningIsTrump = true;
        }
        // Same category: compare values
        else if (cardIsTrump === winningIsTrump) {
            // Only compare if following suit (or both trump)
            if (cardIsTrump || cardSuit === leadSuit) {
                if (cardValue > winningValue) {
                    winningPos = i + 1;
                    winningValue = cardValue;
                }
            }
        }
    }

    return winningPos;
}

/**
 * Calculate score for a team
 * @param {number} bid - Team's bid
 * @param {number} tricks - Tricks won
 * @param {number} multiplier - Bid multiplier (1, 2, or 4)
 * @param {number} rainbows - Number of rainbow hands
 * @returns {number} - Points scored
 */
function calculateScore(bid, tricks, multiplier, rainbows) {
    const rainbowBonus = rainbows * 10;

    if (tricks >= bid) {
        // Made bid: (bid × 10 × multiplier) + overtricks + rainbow bonus
        return (bid * 10 * multiplier) + (tricks - bid) + rainbowBonus;
    } else {
        // Missed bid: -(bid × 10 × multiplier) + rainbow bonus
        return -(bid * 10 * multiplier) + rainbowBonus;
    }
}

module.exports = {
    RANK_VALUES,
    rotatePosition,
    getPartnerPosition,
    isSameSuit,
    isVoidInSuit,
    isLegalMove,
    isRainbow,
    determineWinner,
    calculateScore
};
```

---

## Task 5: Create GameState Class

**Create:** `server/game/GameState.js`
```javascript
/**
 * Encapsulates all state for a single game instance
 */
class GameState {
    constructor(gameId) {
        this.gameId = gameId;
        this.createdAt = Date.now();

        // Players
        this.players = new Map();  // socketId → { username, position, pic }
        this.positions = {};       // position (1-4) → socketId

        // Hands
        this.hands = {};           // socketId → array of cards
        this.currentHand = 12;     // Cards per player (12 down to 1)
        this.dealer = 1;           // Dealer position

        // Bidding
        this.bidding = true;
        this.bids = {};            // position → bid value
        this.team1Mult = 1;
        this.team2Mult = 1;

        // Trick play
        this.currentTurn = 1;
        this.leadPosition = 1;
        this.currentTrick = [];    // Cards played this trick
        this.trump = null;         // Trump card
        this.trumpBroken = false;

        // Scoring
        this.team1Tricks = 0;
        this.team2Tricks = 0;
        this.team1Score = 0;
        this.team2Score = 0;
        this.team1Rainbows = 0;
        this.team2Rainbows = 0;
    }

    addPlayer(socketId, username, position, pic) {
        this.players.set(socketId, { username, position, pic });
        this.positions[position] = socketId;
    }

    getPlayerByPosition(position) {
        const socketId = this.positions[position];
        return socketId ? { socketId, ...this.players.get(socketId) } : null;
    }

    getPositionBySocketId(socketId) {
        const player = this.players.get(socketId);
        return player ? player.position : null;
    }

    setHand(socketId, cards) {
        this.hands[socketId] = [...cards];
    }

    getHand(socketId) {
        return this.hands[socketId] || [];
    }

    removeCardFromHand(socketId, card) {
        const hand = this.hands[socketId];
        if (!hand) return false;

        const index = hand.findIndex(c =>
            c.suit === card.suit && c.rank === card.rank
        );

        if (index === -1) return false;

        hand.splice(index, 1);
        return true;
    }

    recordBid(position, bid) {
        this.bids[position] = bid;
    }

    allBidsIn() {
        return Object.keys(this.bids).length === 4;
    }

    resetForNewHand() {
        this.bids = {};
        this.currentTrick = [];
        this.trumpBroken = false;
        this.team1Tricks = 0;
        this.team2Tricks = 0;
        this.team1Rainbows = 0;
        this.team2Rainbows = 0;
        this.team1Mult = 1;
        this.team2Mult = 1;
        this.bidding = true;
    }

    toJSON() {
        return {
            gameId: this.gameId,
            players: Array.from(this.players.entries()),
            currentHand: this.currentHand,
            currentTurn: this.currentTurn,
            bidding: this.bidding,
            trump: this.trump,
            scores: {
                team1: this.team1Score,
                team2: this.team2Score
            }
        };
    }
}

module.exports = GameState;
```

---

## Task 6: Create GameManager Singleton

**Create:** `server/game/GameManager.js`
```javascript
const GameState = require('./GameState');
const Deck = require('./Deck');
const { v4: uuidv4 } = require('uuid');

/**
 * Manages game queue and active game instances
 * Singleton pattern for server-wide coordination
 */
class GameManager {
    constructor() {
        this.queue = [];           // Players waiting for game
        this.games = new Map();    // gameId → GameState
        this.playerGames = new Map(); // socketId → gameId
    }

    /**
     * Add player to matchmaking queue
     * @param {string} socketId
     * @param {string} username
     * @returns {Object} - Result with queue position or game start info
     */
    joinQueue(socketId, username) {
        // Check if already in queue or game
        if (this.queue.some(p => p.socketId === socketId)) {
            return { success: false, error: 'Already in queue' };
        }
        if (this.playerGames.has(socketId)) {
            return { success: false, error: 'Already in game' };
        }

        this.queue.push({ socketId, username, joinedAt: Date.now() });

        // Start game if 4 players
        if (this.queue.length >= 4) {
            const players = this.queue.splice(0, 4);
            const game = this.createGame(players);
            return { success: true, gameStarted: true, game };
        }

        return {
            success: true,
            gameStarted: false,
            queuePosition: this.queue.length
        };
    }

    /**
     * Remove player from queue
     */
    leaveQueue(socketId) {
        const index = this.queue.findIndex(p => p.socketId === socketId);
        if (index !== -1) {
            this.queue.splice(index, 1);
            return { success: true };
        }
        return { success: false };
    }

    /**
     * Create new game with 4 players
     */
    createGame(players) {
        const gameId = uuidv4();
        const game = new GameState(gameId);

        // Assign random positions
        const positions = [1, 2, 3, 4].sort(() => Math.random() - 0.5);

        players.forEach((player, index) => {
            const position = positions[index];
            game.addPlayer(player.socketId, player.username, position, 1);
            this.playerGames.set(player.socketId, gameId);
        });

        this.games.set(gameId, game);
        return game;
    }

    /**
     * Get game by ID
     */
    getGame(gameId) {
        return this.games.get(gameId);
    }

    /**
     * Get game that player is in
     */
    getPlayerGame(socketId) {
        const gameId = this.playerGames.get(socketId);
        return gameId ? this.games.get(gameId) : null;
    }

    /**
     * Handle player disconnect
     */
    handleDisconnect(socketId) {
        // Remove from queue
        const queueResult = this.leaveQueue(socketId);

        // Handle in-game disconnect
        const gameId = this.playerGames.get(socketId);
        if (gameId) {
            const game = this.games.get(gameId);
            // TODO: Implement disconnect handling (pause game, notify others)
            return { wasInQueue: queueResult.success, wasInGame: true, game };
        }

        return { wasInQueue: queueResult.success, wasInGame: false };
    }

    /**
     * End and cleanup a game
     */
    endGame(gameId) {
        const game = this.games.get(gameId);
        if (!game) return;

        // Remove player mappings
        for (const socketId of game.players.keys()) {
            this.playerGames.delete(socketId);
        }

        this.games.delete(gameId);
    }

    getQueueStatus() {
        return {
            size: this.queue.length,
            players: this.queue.map(p => p.username)
        };
    }
}

// Singleton instance
const gameManager = new GameManager();

module.exports = gameManager;
```

---

## Task 7: Create Socket Handler Modules

**Create:** `server/socket/index.js`
```javascript
const authHandlers = require('./authHandlers');
const queueHandlers = require('./queueHandlers');
const gameHandlers = require('./gameHandlers');
const chatHandlers = require('./chatHandlers');

function setupSocketHandlers(io) {
    io.on('connection', (socket) => {
        console.log(`Client connected: ${socket.id}`);

        // Auth events
        socket.on('signIn', (data) => authHandlers.signIn(socket, io, data));
        socket.on('signUp', (data) => authHandlers.signUp(socket, io, data));

        // Queue events
        socket.on('joinQueue', () => queueHandlers.joinQueue(socket, io));
        socket.on('leaveQueue', () => queueHandlers.leaveQueue(socket, io));

        // Game events
        socket.on('draw', (data) => gameHandlers.draw(socket, io, data));
        socket.on('playerBid', (data) => gameHandlers.playerBid(socket, io, data));
        socket.on('playCard', (data) => gameHandlers.playCard(socket, io, data));

        // Chat events
        socket.on('chatMessage', (data) => chatHandlers.chatMessage(socket, io, data));

        // Disconnect
        socket.on('disconnect', () => {
            console.log(`Client disconnected: ${socket.id}`);
            queueHandlers.handleDisconnect(socket, io);
        });
    });
}

module.exports = { setupSocketHandlers };
```

**Create:** `server/socket/gameHandlers.js`
```javascript
const gameManager = require('../game/GameManager');
const { isLegalMove, determineWinner, calculateScore, isRainbow } = require('../game/rules');
const { delay } = require('../utils/timing');

async function playerBid(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) {
        socket.emit('error', { message: 'Not in a game' });
        return;
    }

    const position = game.getPositionBySocketId(socket.id);
    if (!position) return;

    // Validate it's this player's turn to bid
    if (!game.bidding) {
        socket.emit('error', { message: 'Not in bidding phase' });
        return;
    }

    // Record bid
    game.recordBid(position, data.bid);

    // Broadcast bid to all players in game
    for (const [socketId] of game.players) {
        io.to(socketId).emit('bidReceived', {
            position,
            bid: data.bid
        });
    }

    // Check if all bids are in
    if (game.allBidsIn()) {
        game.bidding = false;

        // Calculate multipliers based on "board" bids
        // ... (implement multiplier logic)

        for (const [socketId] of game.players) {
            io.to(socketId).emit('doneBidding', {
                bids: game.bids,
                team1Mult: game.team1Mult,
                team2Mult: game.team2Mult
            });
        }
    }
}

async function playCard(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    if (!game) return;

    const position = game.getPositionBySocketId(socket.id);

    // Validate turn
    if (position !== game.currentTurn || game.bidding) {
        return;
    }

    const hand = game.getHand(socket.id);
    const leadCard = game.currentTrick.length > 0 ? game.currentTrick[0] : null;

    // Validate move is legal
    if (!isLegalMove(data.card, hand, leadCard, game.trump, game.trumpBroken)) {
        socket.emit('error', { message: 'Illegal move' });
        return;
    }

    // Remove card from hand
    game.removeCardFromHand(socket.id, data.card);

    // Add to current trick
    game.currentTrick.push({ ...data.card, position });

    // Check if trump is broken
    if (data.card.suit === game.trump.suit || data.card.suit === 'joker') {
        game.trumpBroken = true;
    }

    // Broadcast card played
    for (const [socketId] of game.players) {
        io.to(socketId).emit('cardPlayed', {
            position,
            card: data.card
        });
    }

    // Check if trick is complete
    if (game.currentTrick.length === 4) {
        await handleTrickComplete(game, io);
    } else {
        // Advance turn
        game.currentTurn = (game.currentTurn % 4) + 1;

        for (const [socketId] of game.players) {
            io.to(socketId).emit('updateTurn', { turn: game.currentTurn });
        }
    }
}

async function handleTrickComplete(game, io) {
    // Build trick array for winner determination
    const trickArray = [null, null, null, null];
    for (const play of game.currentTrick) {
        trickArray[play.position - 1] = play;
    }

    const winner = determineWinner(trickArray, game.leadPosition, game.trump);

    // Update tricks for winning team
    if (winner === 1 || winner === 3) {
        game.team1Tricks++;
    } else {
        game.team2Tricks++;
    }

    // Broadcast trick result
    for (const [socketId] of game.players) {
        io.to(socketId).emit('trickComplete', {
            winner,
            team1Tricks: game.team1Tricks,
            team2Tricks: game.team2Tricks
        });
    }

    // Wait for animation
    await delay(2000);

    // Check if hand is complete
    if (game.team1Tricks + game.team2Tricks === game.currentHand) {
        await handleHandComplete(game, io);
    } else {
        // Setup next trick
        game.currentTrick = [];
        game.leadPosition = winner;
        game.currentTurn = winner;

        for (const [socketId] of game.players) {
            io.to(socketId).emit('updateTurn', { turn: game.currentTurn });
        }
    }
}

async function handleHandComplete(game, io) {
    // Calculate scores
    const team1Bid = (game.bids[1] || 0) + (game.bids[3] || 0);
    const team2Bid = (game.bids[2] || 0) + (game.bids[4] || 0);

    const team1Points = calculateScore(
        team1Bid,
        game.team1Tricks,
        game.team1Mult,
        game.team1Rainbows
    );
    const team2Points = calculateScore(
        team2Bid,
        game.team2Tricks,
        game.team2Mult,
        game.team2Rainbows
    );

    game.team1Score += team1Points;
    game.team2Score += team2Points;

    // Broadcast hand result
    for (const [socketId] of game.players) {
        io.to(socketId).emit('handComplete', {
            team1Points,
            team2Points,
            team1Score: game.team1Score,
            team2Score: game.team2Score
        });
    }

    // Check for game end or start next hand
    // ... (implement game progression logic)
}

function draw(socket, io, data) {
    // Handle draw phase for position determination
    // ... (implement draw logic)
}

module.exports = {
    playerBid,
    playCard,
    draw
};
```

---

## Task 8: Create New Entry Point

**Create:** `server/index.js`
```javascript
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');

const { connectDB } = require('./database');
const { setupSocketHandlers } = require('./socket');
const routes = require('./routes');
const config = require('./config');

const app = express();
const httpServer = createServer(app);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "cdn.socket.io", "cdn.jsdelivr.net"],
            connectSrc: ["'self'", "wss:", "ws:"],
            imgSrc: ["'self'", "data:"],
            styleSrc: ["'self'", "'unsafe-inline'"]
        }
    }
}));

app.use(cors({
    origin: config.allowedOrigins,
    methods: ['GET', 'POST']
}));

app.use(express.static(path.join(__dirname, '..', 'client')));

// Routes
app.use('/', routes);

// Socket.io
const io = new Server(httpServer, {
    cors: {
        origin: config.allowedOrigins,
        methods: ['GET', 'POST']
    }
});

setupSocketHandlers(io);

// Start server
async function start() {
    try {
        await connectDB();
        console.log('Database connected');

        httpServer.listen(config.port, () => {
            console.log(`Server running on port ${config.port}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

start();
```

---

## Verification

After refactoring:

1. [ ] Server starts without errors: `npm run dev`
2. [ ] No blocking during delays (test with multiple clients)
3. [ ] Can run multiple concurrent games
4. [ ] All socket events still work correctly
5. [ ] Game logic produces same results as before
6. [ ] Unit tests pass for rules.js functions
