/**
 * Encapsulates all state for a single game instance
 * Includes validation and debug logging
 */
class GameState {
    constructor(gameId) {
        this.gameId = gameId;
        this.roomName = `game:${gameId}`;  // Socket.IO room name
        this.createdAt = Date.now();
        this._debugMode = process.env.NODE_ENV !== 'production';

        // Players: socketId → { username, position, pic }
        this.players = new Map();
        // Position lookup: position (1-4) → socketId
        this.positions = {};

        // Hands: socketId → array of cards
        this.hands = {};

        // Game progression
        this.currentHand = 12;     // Cards per player (12 down to 1)
        this.dealer = 1;           // Dealer position (rotates)

        // Phase tracking
        this.phase = 'waiting';    // waiting, drawing, bidding, playing
        this.bidding = true;
        this.currentTurn = 1;

        // Bidding state
        this.bids = {};            // position → bid value
        this.bidder = 2;           // First bidder position
        this.playerBids = [];      // Array of bid strings [pos1, pos2, pos3, pos4]
        this.team1Mult = 1;
        this.team2Mult = 1;

        // Trick play state
        this.leadPosition = 1;
        this.playedCards = [];     // Cards played this trick [pos1Card, pos2Card, ...]
        this.playedCardsIndex = 0;
        this.trump = null;         // Trump card
        this.isTrumpBroken = false;
        this.cardIndex = 0;        // Total cards played in hand

        // Scoring
        this.tricks = { team1: 0, team2: 0 };
        this.score = { team1: 0, team2: 0 };
        this.rainbows = { team1: 0, team2: 0 };

        // Draw phase
        this.drawCards = [];
        this.drawIDs = [];
        this.drawIndex = 0;
    }

    addPlayer(socketId, username, position, pic) {
        this.players.set(socketId, { username, position, pic });
        this.positions[position] = socketId;
    }

    removePlayer(socketId) {
        const player = this.players.get(socketId);
        if (player) {
            delete this.positions[player.position];
            this.players.delete(socketId);
        }
    }

    getPlayerByPosition(position) {
        const socketId = this.positions[position];
        if (!socketId) return null;
        return { socketId, ...this.players.get(socketId) };
    }

    getPositionBySocketId(socketId) {
        const player = this.players.get(socketId);
        return player ? player.position : null;
    }

    /**
     * Find a player by username
     * @param {string} username - Username to find
     * @returns {Object|null} - Player info with socketId, or null
     */
    getPlayerByUsername(username) {
        for (const [socketId, player] of this.players.entries()) {
            if (player.username === username) {
                return { socketId, ...player };
            }
        }
        return null;
    }

    /**
     * Update socket ID for a reconnecting player
     * @param {number} position - Player's position (1-4)
     * @param {string} newSocketId - New socket ID
     * @param {Server} io - Socket.IO server for room management
     * @returns {string|null} - Old socket ID, or null if position not found
     */
    updatePlayerSocket(position, newSocketId, io) {
        const oldSocketId = this.positions[position];
        if (!oldSocketId) return null;

        const player = this.players.get(oldSocketId);
        if (!player) return null;

        // Remove old socket from room
        if (io) {
            this.leaveRoom(io, oldSocketId);
        }

        // Transfer player data to new socket
        this.players.delete(oldSocketId);
        this.players.set(newSocketId, player);
        this.positions[position] = newSocketId;

        // Transfer hand to new socket
        if (this.hands[oldSocketId]) {
            this.hands[newSocketId] = this.hands[oldSocketId];
            delete this.hands[oldSocketId];
        }

        // Add new socket to room
        if (io) {
            this.joinToRoom(io, newSocketId);
        }

        this.logAction('updatePlayerSocket', { position, oldSocketId, newSocketId });
        return oldSocketId;
    }

    /**
     * Get current game state for a rejoining client
     * @param {string} socketId - Socket ID of the player
     * @returns {Object} - Game state object
     */
    getClientState(socketId) {
        const position = this.getPositionBySocketId(socketId);

        // Build player info array
        const playerInfo = [];
        for (let pos = 1; pos <= 4; pos++) {
            const player = this.getPlayerByPosition(pos);
            if (player) {
                playerInfo.push({
                    position: pos,
                    username: player.username,
                    pic: player.pic,
                    socketId: player.socketId
                });
            }
        }

        return {
            gameId: this.gameId,
            position,
            hand: this.getHand(socketId),
            trump: this.trump,
            currentHand: this.currentHand,
            dealer: this.dealer,
            phase: this.phase,
            bidding: this.bidding,
            currentTurn: this.currentTurn,
            bids: this.bids,
            playerBids: this.playerBids,
            tricks: this.tricks,
            score: this.score,
            playedCards: this.playedCards,
            isTrumpBroken: this.isTrumpBroken,
            players: playerInfo
        };
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
        this.playerBids[position - 1] = bid;
    }

    getBidCount() {
        return Object.keys(this.bids).length;
    }

    allBidsIn() {
        return this.getBidCount() === 4;
    }

    resetForNewHand(newDealer, newHandSize) {
        this.hands = {};
        this.currentHand = newHandSize;
        this.dealer = newDealer;
        this.bidder = (newDealer % 4) + 1;
        this.currentTurn = this.bidder;

        this.phase = 'bidding';
        this.bidding = true;

        this.bids = {};
        this.playerBids = [];
        this.team1Mult = 1;
        this.team2Mult = 1;

        this.playedCards = [];
        this.playedCardsIndex = 0;
        this.trump = null;
        this.isTrumpBroken = false;
        this.cardIndex = 0;

        this.tricks = { team1: 0, team2: 0 };
        this.rainbows = { team1: 0, team2: 0 };
    }

    resetForNewGame() {
        this.currentHand = 12;
        this.dealer = 1;
        this.score = { team1: 0, team2: 0 };
        this.resetForNewHand(1, 12);

        this.phase = 'waiting';
        this.drawCards = [];
        this.drawIDs = [];
        this.drawIndex = 0;
    }

    getSocketIds() {
        return Array.from(this.players.keys());
    }

    // ========================================
    // Room Management Methods
    // ========================================

    /**
     * Join all current players to the game room
     * @param {Server} io - Socket.IO server instance
     */
    joinAllToRoom(io) {
        for (const socketId of this.players.keys()) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                socket.join(this.roomName);
            }
        }
        this.logAction('joinAllToRoom', { roomName: this.roomName, playerCount: this.players.size });
    }

    /**
     * Join a single player to the game room
     * @param {Server} io - Socket.IO server instance
     * @param {string} socketId - Socket ID to join
     */
    joinToRoom(io, socketId) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.join(this.roomName);
            this.logAction('joinToRoom', { roomName: this.roomName, socketId });
        }
    }

    /**
     * Remove a player from the game room
     * @param {Server} io - Socket.IO server instance
     * @param {string} socketId - Socket ID to remove
     */
    leaveRoom(io, socketId) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.leave(this.roomName);
            this.logAction('leaveRoom', { roomName: this.roomName, socketId });
        }
    }

    /**
     * Remove all players from the game room
     * @param {Server} io - Socket.IO server instance
     */
    leaveAllFromRoom(io) {
        for (const socketId of this.players.keys()) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                socket.leave(this.roomName);
            }
        }
        this.logAction('leaveAllFromRoom', { roomName: this.roomName });
    }

    /**
     * Broadcast an event to all players in this game
     * @param {Server} io - Socket.IO server instance
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    broadcast(io, event, data) {
        io.to(this.roomName).emit(event, data);
    }

    /**
     * Send an event to a specific player in the game
     * @param {Server} io - Socket.IO server instance
     * @param {string} socketId - Target socket ID
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    sendToPlayer(io, socketId, event, data) {
        io.to(socketId).emit(event, data);
    }

    toJSON() {
        return {
            gameId: this.gameId,
            players: Array.from(this.players.entries()),
            positions: this.positions,
            currentHand: this.currentHand,
            currentTurn: this.currentTurn,
            phase: this.phase,
            bidding: this.bidding,
            trump: this.trump,
            isTrumpBroken: this.isTrumpBroken,
            tricks: this.tricks,
            score: this.score,
            rainbows: this.rainbows
        };
    }

    // ========================================
    // Validation Methods
    // ========================================

    /**
     * Validate that it's a player's turn
     * @param {string} socketId - Socket ID of player
     * @returns {{ valid: boolean, error?: string }}
     */
    validateTurn(socketId) {
        const position = this.getPositionBySocketId(socketId);

        if (!position) {
            return { valid: false, error: 'Player not in game' };
        }

        if (position !== this.currentTurn) {
            return { valid: false, error: `Not your turn (current: ${this.currentTurn}, you: ${position})` };
        }

        return { valid: true };
    }

    /**
     * Validate a card play
     * @param {string} socketId - Socket ID of player
     * @param {Object} card - Card being played
     * @returns {{ valid: boolean, error?: string }}
     */
    validateCardPlay(socketId, card) {
        // Check turn
        const turnCheck = this.validateTurn(socketId);
        if (!turnCheck.valid) return turnCheck;

        // Check not in bidding phase
        if (this.bidding) {
            return { valid: false, error: 'Cannot play cards during bidding' };
        }

        // Check card format
        if (!card || !card.suit || !card.rank) {
            return { valid: false, error: 'Invalid card format' };
        }

        // Check player has the card
        const hand = this.getHand(socketId);
        const hasCard = hand.some(c => c.suit === card.suit && c.rank === card.rank);
        if (!hasCard) {
            return { valid: false, error: 'Card not in hand' };
        }

        // Check trick not already complete
        if (this.playedCardsIndex >= 4) {
            return { valid: false, error: 'Trick already complete' };
        }

        return { valid: true };
    }

    /**
     * Validate a bid
     * @param {string} socketId - Socket ID of player
     * @param {*} bid - Bid value
     * @returns {{ valid: boolean, error?: string }}
     */
    validateBid(socketId, bid) {
        // Check turn
        const turnCheck = this.validateTurn(socketId);
        if (!turnCheck.valid) return turnCheck;

        // Check in bidding phase
        if (!this.bidding) {
            return { valid: false, error: 'Not in bidding phase' };
        }

        // Check bid is valid type
        const validBids = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'B', '2B', '3B', '4B'];
        const bidStr = String(bid);
        if (!validBids.includes(bidStr) && typeof bid !== 'number') {
            return { valid: false, error: `Invalid bid value: ${bid}` };
        }

        // Check hasn't already bid
        const position = this.getPositionBySocketId(socketId);
        if (this.bids[position] !== undefined) {
            return { valid: false, error: 'Already bid' };
        }

        return { valid: true };
    }

    /**
     * Validate entire game state for consistency
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateGameState() {
        const errors = [];

        // Check player count
        if (this.players.size !== 4 && this.phase !== 'waiting') {
            errors.push(`Expected 4 players, have ${this.players.size}`);
        }

        // Check all positions filled
        if (this.phase !== 'waiting') {
            for (let i = 1; i <= 4; i++) {
                if (!this.positions[i]) {
                    errors.push(`Position ${i} not assigned`);
                }
            }
        }

        // Check valid turn
        if (this.currentTurn < 1 || this.currentTurn > 4) {
            errors.push(`Invalid currentTurn: ${this.currentTurn}`);
        }

        // Check hand sizes match (during playing phase)
        if (this.phase === 'playing') {
            const totalTricks = this.tricks.team1 + this.tricks.team2;
            const expectedCards = this.currentHand - totalTricks;

            for (const [socketId, hand] of Object.entries(this.hands)) {
                // Account for cards played this trick
                const playerPos = this.getPositionBySocketId(socketId);
                const playedThisTrick = this.playedCards[playerPos - 1] ? 1 : 0;
                const expected = expectedCards - playedThisTrick;

                if (hand.length !== expected && hand.length !== expected + 1) {
                    errors.push(`Player at pos ${playerPos} has ${hand.length} cards, expected ~${expected}`);
                }
            }
        }

        // Check tricks don't exceed hand size
        const totalTricks = this.tricks.team1 + this.tricks.team2;
        if (totalTricks > this.currentHand) {
            errors.push(`Total tricks (${totalTricks}) exceeds hand size (${this.currentHand})`);
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    // ========================================
    // Debug Logging
    // ========================================

    /**
     * Log a state change (only in debug mode)
     * @param {string} action - Action being performed
     * @param {Object} details - Additional details
     */
    logAction(action, details = {}) {
        if (this._debugMode) {
            console.log(`[Game ${this.gameId.slice(0, 8)}] ${action}`, details);
        }
    }

    /**
     * Log current game state summary
     */
    logState() {
        if (!this._debugMode) return;

        console.log(`[Game ${this.gameId.slice(0, 8)}] State:`, {
            phase: this.phase,
            hand: this.currentHand,
            turn: this.currentTurn,
            bidding: this.bidding,
            tricks: this.tricks,
            score: this.score,
            players: this.players.size
        });
    }

    /**
     * Log validation result
     * @param {string} action - Action that was validated
     * @param {{ valid: boolean, error?: string }} result - Validation result
     */
    logValidation(action, result) {
        if (this._debugMode && !result.valid) {
            console.warn(`[Game ${this.gameId.slice(0, 8)}] Validation failed for ${action}: ${result.error}`);
        }
    }
}

module.exports = GameState;
