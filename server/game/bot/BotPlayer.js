/**
 * BotPlayer class representing a single bot instance.
 * Wraps strategy functions with bot-specific state and timing.
 */

const { v4: uuidv4 } = require('uuid');
const {
    calculateOptimalBid,
    selectOptimalCard
} = require('./BotStrategy');

class BotPlayer {
    /**
     * Create a new bot player
     * @param {string} username - Bot's display name (e.g., "Mary")
     */
    constructor(username = 'Mary') {
        this.socketId = `bot:${username.toLowerCase()}:${uuidv4()}`;
        this.username = username;
        this.gameId = null;
        this.position = null;
        this.pic = null;
        this.cardMemory = null;
    }

    /**
     * Check if a socketId belongs to a bot
     * @param {string} socketId
     * @returns {boolean}
     */
    static isBot(socketId) {
        return socketId?.startsWith('bot:');
    }

    /**
     * Assign bot to a game with position
     * @param {string} gameId
     * @param {number} position
     * @param {number} pic
     */
    assignToGame(gameId, position, pic) {
        this.gameId = gameId;
        this.position = position;
        this.pic = pic;
    }

    /**
     * Reset card memory at the start of each hand
     * @param {number} handSize - Cards per player this hand
     * @param {Object} trump - Trump card (also removed from deck)
     */
    resetCardMemory(handSize, trump) {
        this.cardMemory = {
            playedCards: [],
            trumpPlayed: [],
            acesPlayed: {
                spades: false,
                hearts: false,
                diamonds: false,
                clubs: false
            },
            trickIndex: 0
        };
    }

    /**
     * Record a card that was played in the current trick
     * @param {Object} card - { suit, rank }
     * @param {number} position - Position of player who played it (1-4)
     * @param {Object} trump - Trump card for determining trump status
     */
    recordCardPlayed(card, position, trump) {
        if (!this.cardMemory) return;

        this.cardMemory.playedCards.push({
            suit: card.suit,
            rank: card.rank,
            position,
            trickIndex: this.cardMemory.trickIndex
        });

        // Track aces
        if (card.rank === 'A' && card.suit !== 'joker') {
            this.cardMemory.acesPlayed[card.suit] = true;
        }

        // Track trump cards played
        const isTrump = card.suit === 'joker' ||
            (trump.suit !== 'joker' && card.suit === trump.suit);
        if (isTrump) {
            this.cardMemory.trumpPlayed.push({ rank: card.rank, position });
        }
    }

    /**
     * Advance to next trick
     */
    advanceTrick() {
        if (!this.cardMemory) return;
        this.cardMemory.trickIndex++;
    }

    /**
     * Get a snapshot of memory for strategy functions (keeps them pure)
     * @returns {Object|null} - Copy of card memory, or null if not initialized
     */
    getMemorySnapshot() {
        if (!this.cardMemory) return null;
        return {
            playedCards: [...this.cardMemory.playedCards],
            trumpPlayed: [...this.cardMemory.trumpPlayed],
            acesPlayed: { ...this.cardMemory.acesPlayed },
            trickIndex: this.cardMemory.trickIndex,
            totalCardsPlayed: this.cardMemory.playedCards.length
        };
    }

    /**
     * Decide which card position to draw from deck
     * @param {number} remaining - Number of cards remaining in deck
     * @returns {number} - Index to draw from (0 to remaining-1)
     */
    decideDraw(remaining) {
        // Random choice for draw phase
        return Math.floor(Math.random() * remaining);
    }

    /**
     * Decide what to bid
     * @param {Array} hand - Bot's cards
     * @param {Object} trump - Trump card
     * @param {Array} existingBids - Bids already made
     * @param {number} handSize - Number of cards in hand
     * @returns {string} - Bid value
     */
    decideBid(hand, trump, existingBids, handSize, gameContext) {
        return calculateOptimalBid(hand, trump, this.position, existingBids, handSize, this.getMemorySnapshot(), gameContext);
    }

    /**
     * Decide which card to play
     * @param {Array} hand - Bot's cards
     * @param {Array} playedCards - Cards already played in trick
     * @param {Object|null} leadCard - First card of trick
     * @param {number|null} leadPosition - Position that led
     * @param {Object} trump - Trump card
     * @param {boolean} trumpBroken - Whether trump has been broken
     * @returns {Object} - Card to play
     */
    decideCard(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, handSize) {
        return selectOptimalCard(
            hand,
            playedCards,
            leadCard,
            leadPosition,
            trump,
            trumpBroken,
            this.position,
            this.getMemorySnapshot(),
            handSize
        );
    }

    /**
     * Get random delay for actions (simulates thinking)
     * @param {string} actionType - 'draw', 'bid', or 'play'
     * @returns {number} - Delay in milliseconds
     */
    getActionDelay(actionType) {
        switch (actionType) {
            case 'draw':
                return 500 + Math.random() * 500; // 500-1000ms
            case 'bid':
                return 300 + Math.random() * 500; // 300-800ms
            case 'play':
                return 800 + Math.random() * 700; // 800-1500ms
            default:
                return 500;
        }
    }

    /**
     * Get player data for lobby/game display
     * @returns {Object}
     */
    toPlayerData() {
        return {
            socketId: this.socketId,
            username: this.username,
            isBot: true
        };
    }
}

module.exports = BotPlayer;
