/**
 * Card deck management for BAB card game
 */

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

    /**
     * Get number of remaining cards
     */
    get remaining() {
        return this.cards.length;
    }
}

module.exports = Deck;
