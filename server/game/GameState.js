/**
 * Encapsulates all state for a single game instance
 */
class GameState {
    constructor(gameId) {
        this.gameId = gameId;
        this.createdAt = Date.now();

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
}

module.exports = GameState;
