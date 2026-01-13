# State Management

## Overview
Both server and client suffer from global state issues that prevent proper isolation, testing, and concurrent operations.

## Current Problems

### Server (server/server.js lines 52-162)
- 50+ module-level variables mutated throughout
- Single global gameState object
- Cannot run multiple games simultaneously
- Race conditions when multiple players act

### Client (game.js)
- 50+ global variables: `playerId`, `playerCards`, `trump`, `position`, `currentTurn`, etc.
- State scattered across files
- No single source of truth
- Client/server state can desync

---

## Task 1: Server - Encapsulate Per-Game State

**Problem:** Global state prevents concurrent games

**Current (lines 52-130):**
```javascript
let drawIndex = 0;
let drawCards = [];
let drawIDs = [];
let positions = [];
let players = [];
let currentPlayers = [];
let playedCards = [];
let playedCardsIndex = 0;
let playerBids = [];
let numBids = 0;
// ... 20+ more
```

**Solution:** Use GameState class (created in 01-server-architecture.md)

Each game instance gets its own state:
```javascript
// GameManager tracks multiple games
const games = new Map();  // gameId → GameState

// When 4 players queue
const game = new GameState(uuid());
games.set(game.id, game);

// All operations reference specific game
function playCard(gameId, socketId, card) {
    const game = games.get(gameId);
    if (!game) throw new Error('Game not found');

    const position = game.getPositionBySocketId(socketId);
    // ... use game.currentTurn, game.hands, etc.
}
```

---

## Task 2: Server - Player-to-Game Mapping

**Problem:** No way to find which game a player is in

**Solution:** Maintain bidirectional mapping
```javascript
class GameManager {
    constructor() {
        this.games = new Map();        // gameId → GameState
        this.playerGames = new Map();  // socketId → gameId
    }

    addPlayerToGame(socketId, gameId) {
        this.playerGames.set(socketId, gameId);
    }

    getPlayerGame(socketId) {
        const gameId = this.playerGames.get(socketId);
        return gameId ? this.games.get(gameId) : null;
    }

    removePlayer(socketId) {
        const gameId = this.playerGames.get(socketId);
        if (gameId) {
            const game = this.games.get(gameId);
            game?.removePlayer(socketId);
            this.playerGames.delete(socketId);
        }
    }
}
```

---

## Task 3: Server - Prevent Race Conditions

**Problem:** Multiple socket events can modify state simultaneously

**Current issue:**
```javascript
socket.on("playCard", (data) => {
    // Player 1 enters this handler
    playedCards[data.position - 1] = data.card;
    playedCardsIndex += 1;  // Race condition!
    // Player 2 could enter while Player 1 is still here
});
```

**Solution 1:** Use per-game locks
```javascript
class GameState {
    constructor() {
        this.lock = new AsyncLock();
    }

    async withLock(operation) {
        return this.lock.acquire('game', operation);
    }
}

// Usage in socket handler
async function playCard(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);

    await game.withLock(async () => {
        // All state modifications inside lock
        if (data.position !== game.currentTurn) return;

        game.addCardToTrick(data.card, data.position);
        game.removeCardFromHand(socket.id, data.card);

        if (game.currentTrick.length === 4) {
            await handleTrickComplete(game, io);
        }
    });
}
```

**Solution 2:** Use turn validation (simpler)
```javascript
function playCard(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);
    const position = game.getPositionBySocketId(socket.id);

    // Strict turn validation prevents concurrent modifications
    if (position !== game.currentTurn) {
        socket.emit('error', { message: 'Not your turn' });
        return;
    }

    // Only one player can pass this check at a time
    // because currentTurn is a single value
    game.currentTurn = (game.currentTurn % 4) + 1;

    // Safe to modify state now
    game.addCardToTrick(data.card, position);
}
```

---

## Task 4: Client - Create Single State Container

**Problem:** 50+ global variables

**Solution:** Single GameState class (created in 02-client-architecture.md)

```javascript
// BEFORE (scattered globals)
let playerId, playerCards, trump;
let position, currentTurn;
let me, partner, opp1, opp2;
let teamTricks, oppTricks;
// ... 40+ more

// AFTER (single container)
const gameState = {
    // Player
    playerId: null,
    username: null,
    position: null,

    // Hand
    myCards: [],
    trump: null,

    // Game phase
    phase: 'waiting',
    currentTurn: 1,
    isBidding: true,

    // etc.
};
```

---

## Task 5: Client - State Synchronization

**Problem:** Client state can drift from server state

**Solution:** Server-authoritative sync with local prediction

```javascript
class GameState {
    /**
     * Sync state from server (source of truth)
     */
    syncFromServer(data) {
        // Only update if different (avoid unnecessary rerenders)
        if (data.currentTurn !== undefined && data.currentTurn !== this.currentTurn) {
            this.currentTurn = data.currentTurn;
            this.emit('turnChanged', this.currentTurn);
        }

        if (data.hand !== undefined) {
            this.myCards = [...data.hand];
            this.emit('handChanged', this.myCards);
        }

        // Handle score sync
        if (data.scores) {
            this.teamScore = this.isTeammate(1) ? data.scores.team1 : data.scores.team2;
            this.oppScore = this.isTeammate(1) ? data.scores.team2 : data.scores.team1;
            this.emit('scoresChanged', { team: this.teamScore, opp: this.oppScore });
        }
    }

    /**
     * Optimistic local update (before server confirms)
     */
    localPlayCard(card) {
        // Remove card locally for instant feedback
        const index = this.myCards.findIndex(c =>
            c.suit === card.suit && c.rank === card.rank
        );

        if (index !== -1) {
            this.pendingCard = this.myCards.splice(index, 1)[0];
            this.emit('handChanged', this.myCards);
        }
    }

    /**
     * Rollback if server rejects
     */
    rollbackCard() {
        if (this.pendingCard) {
            this.myCards.push(this.pendingCard);
            this.pendingCard = null;
            this.emit('handChanged', this.myCards);
        }
    }
}
```

---

## Task 6: State Validation

**Problem:** Invalid state can corrupt game

**Solution:** Add validation layer

```javascript
class GameState {
    setCurrentTurn(turn) {
        if (typeof turn !== 'number' || turn < 1 || turn > 4) {
            throw new Error(`Invalid turn value: ${turn}`);
        }
        this.currentTurn = turn;
    }

    addCardToTrick(card, position) {
        // Validate card format
        if (!card || !card.suit || !card.rank) {
            throw new Error('Invalid card format');
        }

        // Validate position
        if (position < 1 || position > 4) {
            throw new Error('Invalid position');
        }

        // Validate trick state
        if (this.currentTrick.length >= 4) {
            throw new Error('Trick already complete');
        }

        // Validate no duplicate positions
        if (this.currentTrick.some(c => c.position === position)) {
            throw new Error('Position already played this trick');
        }

        this.currentTrick.push({ ...card, position });
    }

    validateGameState() {
        const errors = [];

        // Check player count
        if (this.players.size !== 4) {
            errors.push(`Expected 4 players, have ${this.players.size}`);
        }

        // Check all positions filled
        for (let i = 1; i <= 4; i++) {
            if (!this.positions[i]) {
                errors.push(`Position ${i} not assigned`);
            }
        }

        // Check valid turn
        if (this.currentTurn < 1 || this.currentTurn > 4) {
            errors.push(`Invalid currentTurn: ${this.currentTurn}`);
        }

        // Check hand sizes match
        const expectedCards = this.currentHand - this.team1Tricks - this.team2Tricks;
        for (const [socketId, hand] of Object.entries(this.hands)) {
            if (hand.length !== expectedCards) {
                errors.push(`Player ${socketId} has ${hand.length} cards, expected ${expectedCards}`);
            }
        }

        if (errors.length > 0) {
            console.error('Game state validation failed:', errors);
            return false;
        }

        return true;
    }
}
```

---

## Task 7: Immutable State Updates (Optional)

For larger applications, use immutable patterns:

```javascript
// Using immer for immutable updates
import { produce } from 'immer';

function updateGameState(state, action) {
    return produce(state, draft => {
        switch (action.type) {
            case 'PLAY_CARD':
                const { position, card } = action.payload;
                draft.currentTrick.push({ ...card, position });
                draft.currentTurn = (draft.currentTurn % 4) + 1;
                break;

            case 'COMPLETE_TRICK':
                const { winner } = action.payload;
                if (winner === 1 || winner === 3) {
                    draft.team1Tricks++;
                } else {
                    draft.team2Tricks++;
                }
                draft.currentTrick = [];
                draft.leadPosition = winner;
                draft.currentTurn = winner;
                break;

            case 'RECORD_BID':
                const { position: bidPos, bid } = action.payload;
                draft.bids[bidPos] = bid;
                break;
        }
    });
}
```

---

## Task 8: Debug/Logging State Changes

Add state change logging for debugging:

```javascript
class GameState {
    constructor() {
        this._debugMode = process.env.NODE_ENV === 'development';
    }

    setState(key, value) {
        const oldValue = this[key];
        this[key] = value;

        if (this._debugMode) {
            console.log(`[GameState] ${key}: ${JSON.stringify(oldValue)} → ${JSON.stringify(value)}`);
        }
    }

    logState() {
        console.log('[GameState] Current state:', {
            gameId: this.gameId,
            currentHand: this.currentHand,
            currentTurn: this.currentTurn,
            bidding: this.bidding,
            team1Score: this.team1Score,
            team2Score: this.team2Score,
            playerCount: this.players.size
        });
    }
}
```

---

## Migration Strategy

### Phase 1: Server State Isolation
1. Create GameState class
2. Create GameManager singleton
3. Update socket handlers to use GameManager
4. Remove global variables one by one
5. Test with multiple concurrent games

### Phase 2: Client State Consolidation
1. Create client GameState class
2. Move global variables into GameState
3. Update all references
4. Add sync handlers
5. Test state consistency

### Phase 3: Validation
1. Add state validation to both sides
2. Add debug logging
3. Test edge cases
4. Monitor for state corruption

---

## Verification

1. [ ] Server can run 2+ concurrent games without interference
2. [ ] Client state matches server after each operation
3. [ ] State validation catches invalid operations
4. [ ] No global variables remain in either codebase
5. [ ] Debug logging helps identify state issues
6. [ ] Race conditions eliminated
