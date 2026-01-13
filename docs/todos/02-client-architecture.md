# Client Architecture Refactoring

## Overview
The client code is split across three files but lacks proper organization:
- `game.js` - 1721 lines with 50+ global variables
- `ui.js` - 939 lines with heavy DOM manipulation
- `socketManager.js` - 27 lines, mostly unused

## Critical Issues

1. **50+ global variables** scattered throughout game.js
2. **Socket event listeners never cleaned up** - memory leaks every hand
3. **200+ inline styles** instead of CSS classes
4. **No module system** - everything in global scope
5. **Phaser scene lifecycle not properly managed**

---

## Task 1: Create Client Directory Structure ✅

```
client/
├── index.html
├── styles.css              # Consolidated CSS
├── js/
│   ├── main.js             # Entry point
│   ├── config.js           # Game configuration
│   ├── socket/
│   │   ├── SocketManager.js    # Connection management
│   │   └── eventHandlers.js    # Socket event handlers
│   ├── scenes/
│   │   ├── GameScene.js        # Main game scene
│   │   ├── LobbyScene.js       # Pre-game lobby
│   │   └── DrawScene.js        # Position draw phase
│   ├── game/
│   │   ├── CardManager.js      # Card sprites and logic
│   │   ├── PlayerDisplay.js    # Opponent display
│   │   └── TrickManager.js     # Trick tracking
│   ├── ui/
│   │   ├── UIManager.js        # DOM UI coordination
│   │   ├── AuthUI.js           # Login/register forms
│   │   ├── BidUI.js            # Bidding interface
│   │   ├── ScoreUI.js          # Score display
│   │   └── ChatUI.js           # Chat system
│   └── utils/
│       ├── animations.js       # Reusable animations
│       └── helpers.js          # Utility functions
└── assets/
    └── sprites/
        └── cards.json          # Texture atlas
```

---

## Task 2: Create Configuration Module ✅

**Create:** `client/js/config.js`
```javascript
const GameConfig = {
    // Display
    DESIGN_WIDTH: 1920,
    DESIGN_HEIGHT: 953,

    // Card dimensions
    CARD_WIDTH: 100,
    CARD_HEIGHT: 140,
    CARD_SCALE: 1.5,

    // Positions (relative to center)
    POSITIONS: {
        PLAYER: { x: 0, y: 300 },      // Bottom (position 1)
        PARTNER: { x: 0, y: -300 },    // Top (position 3)
        LEFT: { x: -400, y: 0 },       // Left (position 2 or 4)
        RIGHT: { x: 400, y: 0 }        // Right (position 4 or 2)
    },

    // Animation
    ANIMATION: {
        CARD_PLAY_DURATION: 300,
        TRICK_COLLECT_DELAY: 2000,
        CARD_DEAL_STAGGER: 100
    },

    // Timing
    TIMING: {
        BID_BUBBLE_DURATION: 3000,
        TURN_INDICATOR_PULSE: 1000
    }
};

// Freeze to prevent accidental modification
Object.freeze(GameConfig);
Object.freeze(GameConfig.POSITIONS);
Object.freeze(GameConfig.ANIMATION);
Object.freeze(GameConfig.TIMING);

export default GameConfig;
```

---

## Task 3: Create Proper SocketManager ✅

**Replace:** `client/socketManager.js` with `client/js/socket/SocketManager.js`

```javascript
/**
 * Centralized socket connection management with lifecycle handling
 */
class SocketManager {
    constructor() {
        this.socket = null;
        this.listeners = new Map();  // event → Set of handlers
        this.connectionState = 'disconnected';
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
    }

    /**
     * Initialize socket connection
     */
    connect() {
        if (this.socket?.connected) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            this.socket = io({
                reconnection: true,
                reconnectionAttempts: this.maxReconnectAttempts,
                reconnectionDelay: 1000
            });

            this.socket.on('connect', () => {
                this.connectionState = 'connected';
                this.reconnectAttempts = 0;
                console.log('Socket connected:', this.socket.id);
                resolve();
            });

            this.socket.on('disconnect', (reason) => {
                this.connectionState = 'disconnected';
                console.log('Socket disconnected:', reason);
                this.handleDisconnect(reason);
            });

            this.socket.on('connect_error', (error) => {
                this.reconnectAttempts++;
                console.error('Connection error:', error);
                if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    reject(error);
                }
            });
        });
    }

    /**
     * Register event listener with tracking
     * @param {string} event - Event name
     * @param {Function} handler - Event handler
     * @returns {Function} - Cleanup function
     */
    on(event, handler) {
        if (!this.socket) {
            console.error('Socket not connected');
            return () => {};
        }

        // Track listener
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(handler);

        // Attach to socket
        this.socket.on(event, handler);

        // Return cleanup function
        return () => this.off(event, handler);
    }

    /**
     * Remove specific event listener
     */
    off(event, handler) {
        if (!this.socket) return;

        this.socket.off(event, handler);

        const handlers = this.listeners.get(event);
        if (handlers) {
            handlers.delete(handler);
        }
    }

    /**
     * Remove ALL listeners for an event
     */
    offAll(event) {
        if (!this.socket) return;

        const handlers = this.listeners.get(event);
        if (handlers) {
            handlers.forEach(handler => {
                this.socket.off(event, handler);
            });
            handlers.clear();
        }
    }

    /**
     * Clean up all game-related listeners (call between games/hands)
     */
    cleanupGameListeners() {
        const gameEvents = [
            'cardPlayed', 'updateTurn', 'bidReceived', 'doneBidding',
            'trickComplete', 'handComplete', 'gameEnd', 'rainbow',
            'positionUpdate', 'opponentCards'
        ];

        gameEvents.forEach(event => this.offAll(event));
        console.log('Game listeners cleaned up');
    }

    /**
     * Emit event to server
     */
    emit(event, data) {
        if (!this.socket?.connected) {
            console.error('Cannot emit: socket not connected');
            return false;
        }
        this.socket.emit(event, data);
        return true;
    }

    /**
     * Handle disconnection
     */
    handleDisconnect(reason) {
        if (reason === 'io server disconnect') {
            // Server initiated disconnect, need to reconnect manually
            this.socket.connect();
        }
        // For other reasons, socket.io handles reconnection automatically
    }

    /**
     * Get socket ID
     */
    get id() {
        return this.socket?.id;
    }

    /**
     * Check if connected
     */
    get connected() {
        return this.socket?.connected || false;
    }

    /**
     * Disconnect and cleanup
     */
    disconnect() {
        if (this.socket) {
            // Remove all listeners
            for (const [event, handlers] of this.listeners) {
                handlers.forEach(handler => this.socket.off(event, handler));
            }
            this.listeners.clear();

            this.socket.disconnect();
            this.socket = null;
        }
        this.connectionState = 'disconnected';
    }
}

// Singleton instance
const socketManager = new SocketManager();
export default socketManager;
```

---

## Task 4: Create GameState Class for Client ✅

**Create:** `client/js/game/GameState.js`
```javascript
/**
 * Client-side game state container
 * Single source of truth for game data
 */
class GameState {
    constructor() {
        this.reset();
    }

    reset() {
        // Player info
        this.playerId = null;
        this.username = null;
        this.position = null;
        this.pic = 1;

        // Hand info
        this.myCards = [];
        this.currentHand = 12;
        this.trump = null;

        // Game phase
        this.phase = 'waiting';  // waiting, drawing, bidding, playing
        this.currentTurn = 1;
        this.isBidding = true;

        // Trick state
        this.leadCard = null;
        this.playedCards = [null, null, null, null];
        this.trumpBroken = false;

        // Scores
        this.myBid = null;
        this.partnerBid = null;
        this.teamTricks = 0;
        this.oppTricks = 0;
        this.teamScore = 0;
        this.oppScore = 0;

        // Players
        this.players = {};  // position → { username, pic }
    }

    /**
     * Update from server sync
     */
    syncFromServer(data) {
        if (data.position !== undefined) this.position = data.position;
        if (data.hand !== undefined) this.myCards = [...data.hand];
        if (data.trump !== undefined) this.trump = data.trump;
        if (data.currentTurn !== undefined) this.currentTurn = data.currentTurn;
        if (data.bidding !== undefined) this.isBidding = data.bidding === 1;
        if (data.players !== undefined) this.players = { ...data.players };
    }

    /**
     * Get relative position (who is where on screen)
     * @param {number} absolutePos - Position 1-4
     * @returns {string} - 'self', 'partner', 'left', 'right'
     */
    getRelativePosition(absolutePos) {
        if (absolutePos === this.position) return 'self';
        if (absolutePos === this.getPartnerPosition()) return 'partner';

        // Determine left/right based on turn order
        const diff = (absolutePos - this.position + 4) % 4;
        return diff === 1 ? 'left' : 'right';
    }

    getPartnerPosition() {
        return ((this.position + 1) % 4) + 1;
    }

    isMyTurn() {
        return this.currentTurn === this.position;
    }

    isTeammate(position) {
        return position === this.position || position === this.getPartnerPosition();
    }

    removeCard(card) {
        const index = this.myCards.findIndex(c =>
            c.suit === card.suit && c.rank === card.rank
        );
        if (index !== -1) {
            this.myCards.splice(index, 1);
            return true;
        }
        return false;
    }
}

// Singleton
const gameState = new GameState();
export default gameState;
```

---

## Task 5: Refactor GameScene ✅

**Create:** `client/js/scenes/GameScene.js`
```javascript
import GameConfig from '../config.js';
import socketManager from '../socket/SocketManager.js';
import gameState from '../game/GameState.js';
import CardManager from '../game/CardManager.js';
import PlayerDisplay from '../game/PlayerDisplay.js';

export default class GameScene extends Phaser.Scene {
    constructor() {
        super({ key: 'GameScene' });

        // Managed components
        this.cardManager = null;
        this.playerDisplay = null;

        // Cleanup functions for socket listeners
        this.cleanupFunctions = [];
    }

    preload() {
        // Load texture atlas (single file instead of 54)
        this.load.atlas('cards', 'assets/sprites/cards.png', 'assets/sprites/cards.json');
        this.load.image('cardBack', 'assets/card_back.png');
        this.load.image('background', 'assets/background.png');

        // Show loading progress
        this.createLoadingBar();
    }

    createLoadingBar() {
        const { width, height } = this.scale;

        const progressBar = this.add.graphics();
        const progressBox = this.add.graphics();
        progressBox.fillStyle(0x222222, 0.8);
        progressBox.fillRect(width / 2 - 160, height / 2 - 25, 320, 50);

        this.load.on('progress', (value) => {
            progressBar.clear();
            progressBar.fillStyle(0xffffff, 1);
            progressBar.fillRect(width / 2 - 150, height / 2 - 15, 300 * value, 30);
        });

        this.load.on('complete', () => {
            progressBar.destroy();
            progressBox.destroy();
        });
    }

    create() {
        // Setup background
        this.add.image(this.scale.width / 2, this.scale.height / 2, 'background');

        // Initialize components
        this.cardManager = new CardManager(this);
        this.playerDisplay = new PlayerDisplay(this);

        // Register socket event listeners with cleanup tracking
        this.setupSocketListeners();

        // Notify server we're ready
        socketManager.emit('sceneReady');
    }

    setupSocketListeners() {
        // Store cleanup functions for later
        this.cleanupFunctions.push(
            socketManager.on('cardPlayed', this.handleCardPlayed.bind(this)),
            socketManager.on('updateTurn', this.handleUpdateTurn.bind(this)),
            socketManager.on('bidReceived', this.handleBidReceived.bind(this)),
            socketManager.on('doneBidding', this.handleDoneBidding.bind(this)),
            socketManager.on('trickComplete', this.handleTrickComplete.bind(this)),
            socketManager.on('handComplete', this.handleHandComplete.bind(this)),
            socketManager.on('gameEnd', this.handleGameEnd.bind(this))
        );
    }

    handleCardPlayed(data) {
        const relativePos = gameState.getRelativePosition(data.position);

        if (relativePos === 'self') {
            // Our card - already handled locally
            return;
        }

        // Animate opponent card
        this.cardManager.animateOpponentCard(relativePos, data.card);

        // Store in trick
        gameState.playedCards[data.position - 1] = data.card;
    }

    handleUpdateTurn(data) {
        gameState.currentTurn = data.turn;

        // Update turn indicators
        this.playerDisplay.updateTurnIndicator(data.turn);

        // Enable/disable card interaction
        if (gameState.isMyTurn()) {
            this.cardManager.enableInteraction();
        } else {
            this.cardManager.disableInteraction();
        }
    }

    handleBidReceived(data) {
        this.playerDisplay.showBidBubble(data.position, data.bid);
    }

    handleDoneBidding(data) {
        gameState.isBidding = false;
        // Hide bid UI, start play phase
        this.events.emit('biddingComplete', data);
    }

    handleTrickComplete(data) {
        gameState.teamTricks = gameState.isTeammate(1) ? data.team1Tricks : data.team2Tricks;
        gameState.oppTricks = gameState.isTeammate(1) ? data.team2Tricks : data.team1Tricks;

        // Animate trick collection
        this.cardManager.collectTrick(data.winner);
    }

    handleHandComplete(data) {
        // Update scores
        gameState.teamScore = gameState.isTeammate(1) ? data.team1Score : data.team2Score;
        gameState.oppScore = gameState.isTeammate(1) ? data.team2Score : data.team1Score;

        this.events.emit('handComplete', data);
    }

    handleGameEnd(data) {
        this.events.emit('gameEnd', data);
    }

    /**
     * Called when player plays a card
     */
    playCard(card) {
        if (!gameState.isMyTurn() || gameState.isBidding) {
            return false;
        }

        // Validate move locally first
        if (!this.cardManager.isLegalMove(card)) {
            this.showError('Illegal move');
            return false;
        }

        // Update local state immediately
        gameState.removeCard(card);

        // Send to server
        socketManager.emit('playCard', {
            card,
            position: gameState.position
        });

        // Animate card to center
        this.cardManager.playCard(card);

        return true;
    }

    showError(message) {
        // Create temporary error text
        const text = this.add.text(
            this.scale.width / 2,
            this.scale.height / 2,
            message,
            { fontSize: '32px', color: '#ff0000' }
        ).setOrigin(0.5);

        this.time.delayedCall(2000, () => text.destroy());
    }

    /**
     * Clean up when leaving scene
     */
    shutdown() {
        // Call all cleanup functions
        this.cleanupFunctions.forEach(cleanup => cleanup());
        this.cleanupFunctions = [];

        // Destroy components
        this.cardManager?.destroy();
        this.playerDisplay?.destroy();

        console.log('GameScene shutdown complete');
    }
}
```

---

## Task 6: Create CardManager Component ✅

**Create:** `client/js/game/CardManager.js`
```javascript
import GameConfig from '../config.js';
import gameState from './GameState.js';

export default class CardManager {
    constructor(scene) {
        this.scene = scene;
        this.cardSprites = [];
        this.playedCardSprites = [];
        this.interactionEnabled = false;
    }

    /**
     * Display player's hand
     * @param {Array} cards - Array of card objects
     */
    displayHand(cards) {
        // Clear existing
        this.clearHand();

        const { width, height } = this.scene.scale;
        const cardWidth = GameConfig.CARD_WIDTH * GameConfig.CARD_SCALE;
        const overlap = cardWidth * 0.3;
        const totalWidth = cardWidth + (cards.length - 1) * (cardWidth - overlap);
        const startX = (width - totalWidth) / 2 + cardWidth / 2;
        const y = height - 100;

        cards.forEach((card, index) => {
            const x = startX + index * (cardWidth - overlap);
            const sprite = this.createCardSprite(card, x, y);
            sprite.setData('card', card);
            sprite.setData('index', index);
            this.cardSprites.push(sprite);
        });

        this.updateCardDepths();
    }

    createCardSprite(card, x, y) {
        const key = this.getCardTextureKey(card);
        const sprite = this.scene.add.image(x, y, 'cards', key);

        sprite.setScale(GameConfig.CARD_SCALE);
        sprite.setInteractive({ useHandCursor: true });

        // Hover effect
        sprite.on('pointerover', () => {
            if (this.interactionEnabled) {
                this.scene.tweens.add({
                    targets: sprite,
                    y: y - 30,
                    duration: 150,
                    ease: 'Power2'
                });
            }
        });

        sprite.on('pointerout', () => {
            this.scene.tweens.add({
                targets: sprite,
                y: y,
                duration: 150,
                ease: 'Power2'
            });
        });

        sprite.on('pointerdown', () => {
            if (this.interactionEnabled) {
                const card = sprite.getData('card');
                this.scene.playCard(card);
            }
        });

        return sprite;
    }

    getCardTextureKey(card) {
        if (card.suit === 'joker') {
            return card.rank === 'HI' ? 'joker_hi' : 'joker_lo';
        }

        const rankMap = {
            'A': 'ace', 'K': 'king', 'Q': 'queen', 'J': 'jack',
            '10': '10', '9': '9', '8': '8', '7': '7',
            '6': '6', '5': '5', '4': '4', '3': '3', '2': '2'
        };

        return `${rankMap[card.rank]}_${card.suit}`;
    }

    updateCardDepths() {
        this.cardSprites.forEach((sprite, index) => {
            sprite.setDepth(index);
        });
    }

    /**
     * Animate playing a card to the center
     */
    playCard(card) {
        const sprite = this.cardSprites.find(s => {
            const c = s.getData('card');
            return c.suit === card.suit && c.rank === card.rank;
        });

        if (!sprite) return;

        // Remove from hand array
        const index = this.cardSprites.indexOf(sprite);
        this.cardSprites.splice(index, 1);

        // Animate to center
        const { width, height } = this.scene.scale;

        this.scene.tweens.add({
            targets: sprite,
            x: width / 2,
            y: height / 2,
            duration: GameConfig.ANIMATION.CARD_PLAY_DURATION,
            ease: 'Power2',
            onComplete: () => {
                this.playedCardSprites.push(sprite);
            }
        });

        // Rearrange remaining cards
        this.repositionHand();
    }

    repositionHand() {
        const { width, height } = this.scene.scale;
        const cardWidth = GameConfig.CARD_WIDTH * GameConfig.CARD_SCALE;
        const overlap = cardWidth * 0.3;
        const totalWidth = cardWidth + (this.cardSprites.length - 1) * (cardWidth - overlap);
        const startX = (width - totalWidth) / 2 + cardWidth / 2;
        const y = height - 100;

        this.cardSprites.forEach((sprite, index) => {
            const targetX = startX + index * (cardWidth - overlap);
            this.scene.tweens.add({
                targets: sprite,
                x: targetX,
                duration: 200,
                ease: 'Power2'
            });
            sprite.setData('index', index);
        });

        this.updateCardDepths();
    }

    /**
     * Check if move is legal
     */
    isLegalMove(card) {
        const leadCard = gameState.playedCards.find(c => c !== null);

        if (!leadCard) {
            // Leading - can't lead trump unless broken (or only have trump)
            if ((card.suit === gameState.trump?.suit || card.suit === 'joker') &&
                !gameState.trumpBroken) {
                // Check if we have non-trump
                const hasNonTrump = gameState.myCards.some(c =>
                    c.suit !== gameState.trump?.suit && c.suit !== 'joker'
                );
                return !hasNonTrump;
            }
            return true;
        }

        // Following - must follow suit if possible
        const leadSuit = leadCard.suit === 'joker' ? gameState.trump?.suit : leadCard.suit;
        const cardSuit = card.suit === 'joker' ? gameState.trump?.suit : card.suit;

        if (cardSuit !== leadSuit) {
            // Check if we're void
            const hasSuit = gameState.myCards.some(c => {
                const s = c.suit === 'joker' ? gameState.trump?.suit : c.suit;
                return s === leadSuit;
            });
            return !hasSuit;
        }

        return true;
    }

    animateOpponentCard(relativePos, card) {
        const { width, height } = this.scene.scale;
        const positions = {
            partner: { x: width / 2, y: 150 },
            left: { x: 150, y: height / 2 },
            right: { x: width - 150, y: height / 2 }
        };

        const startPos = positions[relativePos];
        const endPos = { x: width / 2, y: height / 2 };

        // Create sprite at opponent position, animate to center
        const key = this.getCardTextureKey(card);
        const sprite = this.scene.add.image(startPos.x, startPos.y, 'cards', key);
        sprite.setScale(GameConfig.CARD_SCALE);

        this.scene.tweens.add({
            targets: sprite,
            x: endPos.x,
            y: endPos.y,
            duration: GameConfig.ANIMATION.CARD_PLAY_DURATION,
            ease: 'Power2',
            onComplete: () => {
                this.playedCardSprites.push(sprite);
            }
        });
    }

    collectTrick(winnerPosition) {
        const relativePos = gameState.getRelativePosition(winnerPosition);
        const { width, height } = this.scene.scale;

        const targetPositions = {
            self: { x: width / 2, y: height + 100 },
            partner: { x: width / 2, y: -100 },
            left: { x: -100, y: height / 2 },
            right: { x: width + 100, y: height / 2 }
        };

        const target = targetPositions[relativePos];

        // Animate all played cards off screen
        this.scene.time.delayedCall(GameConfig.ANIMATION.TRICK_COLLECT_DELAY, () => {
            this.playedCardSprites.forEach(sprite => {
                this.scene.tweens.add({
                    targets: sprite,
                    x: target.x,
                    y: target.y,
                    alpha: 0,
                    duration: 500,
                    ease: 'Power2',
                    onComplete: () => sprite.destroy()
                });
            });
            this.playedCardSprites = [];
        });
    }

    enableInteraction() {
        this.interactionEnabled = true;
        this.cardSprites.forEach(sprite => {
            sprite.setTint(0xffffff);
        });
    }

    disableInteraction() {
        this.interactionEnabled = false;
        this.cardSprites.forEach(sprite => {
            sprite.setTint(0xcccccc);
        });
    }

    clearHand() {
        this.cardSprites.forEach(sprite => sprite.destroy());
        this.cardSprites = [];
    }

    destroy() {
        this.clearHand();
        this.playedCardSprites.forEach(sprite => sprite.destroy());
        this.playedCardSprites = [];
    }
}
```

---

## Task 7: Move Inline Styles to CSS ✅

**Current problem (200+ occurrences in ui.js and game.js):**
```javascript
element.style.position = "absolute";
element.style.width = "6vw";
element.style.height = "10vh";
// ... 40+ more lines per element
```

**Create:** `client/styles/components.css`
```css
/* Bid Container */
.bid-container {
    position: absolute;
    width: 6vw;
    height: 10vh;
    bottom: 200px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
}

.bid-input {
    width: 100%;
    height: 40px;
    font-size: 1.5em;
    text-align: center;
    border: 2px solid #333;
    border-radius: 4px;
}

.bid-button {
    width: 100%;
    height: 36px;
    font-size: 1.2em;
    background: #4a90d9;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.2s;
}

.bid-button:hover {
    background: #357abd;
}

/* Chat Container */
.chat-container {
    position: absolute;
    top: 50%;
    right: 20px;
    transform: translateY(-50%);
    width: 300px;
    height: 400px;
    background: rgba(0, 0, 0, 0.8);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
}

.chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
}

.chat-input-container {
    display: flex;
    padding: 8px;
    border-top: 1px solid #333;
}

.chat-input {
    flex: 1;
    padding: 8px;
    border: 1px solid #333;
    border-radius: 4px;
    background: #222;
    color: white;
}

/* Score Display */
.score-container {
    position: absolute;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 40px;
}

.score-team {
    text-align: center;
    padding: 12px 24px;
    background: rgba(0, 0, 0, 0.7);
    border-radius: 8px;
    color: white;
}

.score-label {
    font-size: 0.9em;
    color: #888;
    margin-bottom: 4px;
}

.score-value {
    font-size: 2em;
    font-weight: bold;
}

/* Turn Indicator */
.turn-indicator {
    position: absolute;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #4ade80;
    animation: pulse 1s infinite;
}

@keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.2); opacity: 0.7; }
}

/* Auth Forms */
.auth-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    background: rgba(0, 0, 0, 0.9);
}

.auth-form {
    background: #1a1a2e;
    padding: 40px;
    border-radius: 12px;
    width: 320px;
}

.auth-input {
    width: 100%;
    padding: 12px;
    margin-bottom: 16px;
    border: 1px solid #333;
    border-radius: 4px;
    background: #0f0f1a;
    color: white;
    font-size: 1em;
}

.auth-button {
    width: 100%;
    padding: 12px;
    background: #4a90d9;
    color: white;
    border: none;
    border-radius: 4px;
    font-size: 1.1em;
    cursor: pointer;
}

/* Error Toast */
.error-toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #dc2626;
    color: white;
    padding: 12px 24px;
    border-radius: 4px;
    animation: slideUp 0.3s ease;
}

@keyframes slideUp {
    from { transform: translate(-50%, 100%); opacity: 0; }
    to { transform: translate(-50%, 0); opacity: 1; }
}
```

**Then update JavaScript to use classes:**
```javascript
// BEFORE
const container = document.createElement('div');
container.style.position = 'absolute';
container.style.width = '6vw';
// ... 20 more lines

// AFTER
const container = document.createElement('div');
container.className = 'bid-container';
```

---

## Task 8: Create UIManager for DOM Lifecycle ✅

**Create:** `client/js/ui/UIManager.js`
```javascript
/**
 * Manages DOM element lifecycle to prevent duplicates and leaks
 */
class UIManager {
    constructor() {
        this.elements = new Map();  // id → element
        this.eventCleanups = [];    // cleanup functions
    }

    /**
     * Create or get existing element
     */
    getOrCreate(id, tagName, parent = document.body) {
        let element = this.elements.get(id);

        if (!element || !document.contains(element)) {
            element = document.createElement(tagName);
            element.id = id;
            parent.appendChild(element);
            this.elements.set(id, element);
        }

        return element;
    }

    /**
     * Remove element by ID
     */
    remove(id) {
        const element = this.elements.get(id);
        if (element) {
            element.remove();
            this.elements.delete(id);
        }
    }

    /**
     * Add event listener with tracking
     */
    addEventListener(element, event, handler) {
        element.addEventListener(event, handler);
        this.eventCleanups.push(() => {
            element.removeEventListener(event, handler);
        });
    }

    /**
     * Clean up all tracked elements and listeners
     */
    cleanup() {
        // Remove event listeners
        this.eventCleanups.forEach(cleanup => cleanup());
        this.eventCleanups = [];

        // Remove elements
        for (const element of this.elements.values()) {
            element.remove();
        }
        this.elements.clear();
    }

    /**
     * Show an element
     */
    show(id) {
        const element = this.elements.get(id);
        if (element) {
            element.style.display = '';
        }
    }

    /**
     * Hide an element
     */
    hide(id) {
        const element = this.elements.get(id);
        if (element) {
            element.style.display = 'none';
        }
    }
}

const uiManager = new UIManager();
export default uiManager;
```

---

## Verification

After refactoring:

1. [ ] No global variables (check with `window.myVar` tests)
2. [ ] Socket listeners cleaned up between hands (check listener count)
3. [ ] No duplicate DOM elements created
4. [ ] All styles in CSS files
5. [ ] Game scene properly shuts down
6. [ ] Browser memory stable during extended play
7. [ ] All interactions still work correctly
