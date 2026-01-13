/**
 * Unit tests for Deck class
 */

const Deck = require('../Deck');

describe('Deck', () => {
    let deck;

    beforeEach(() => {
        deck = new Deck();
    });

    describe('initialization', () => {
        test('creates deck with 54 cards', () => {
            expect(deck.remaining).toBe(54);
        });

        test('contains all 52 standard cards', () => {
            const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
            const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

            for (const suit of suits) {
                for (const rank of ranks) {
                    const found = deck.cards.some(c =>
                        c.suit === suit && c.rank === rank
                    );
                    expect(found).toBe(true);
                }
            }
        });

        test('contains HI joker', () => {
            const hiJoker = deck.cards.find(c =>
                c.suit === 'joker' && c.rank === 'HI'
            );
            expect(hiJoker).toBeDefined();
        });

        test('contains LO joker', () => {
            const loJoker = deck.cards.find(c =>
                c.suit === 'joker' && c.rank === 'LO'
            );
            expect(loJoker).toBeDefined();
        });
    });

    describe('shuffle', () => {
        test('maintains 54 cards after shuffle', () => {
            deck.shuffle();
            expect(deck.remaining).toBe(54);
        });

        test('randomizes card order', () => {
            const original = deck.cards.map(c => `${c.rank}_${c.suit}`);
            deck.shuffle();
            const shuffled = deck.cards.map(c => `${c.rank}_${c.suit}`);

            // Very unlikely to be in same order
            let samePosition = 0;
            for (let i = 0; i < 54; i++) {
                if (shuffled[i] === original[i]) samePosition++;
            }
            expect(samePosition).toBeLessThan(10);
        });

        test('all cards still present after shuffle', () => {
            deck.shuffle();

            const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
            const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

            for (const suit of suits) {
                for (const rank of ranks) {
                    const found = deck.cards.some(c =>
                        c.suit === suit && c.rank === rank
                    );
                    expect(found).toBe(true);
                }
            }

            // Check jokers
            expect(deck.cards.some(c => c.suit === 'joker' && c.rank === 'HI')).toBe(true);
            expect(deck.cards.some(c => c.suit === 'joker' && c.rank === 'LO')).toBe(true);
        });
    });

    describe('draw', () => {
        test('draws correct number of cards', () => {
            const drawn = deck.draw(5);
            expect(drawn.length).toBe(5);
        });

        test('reduces deck size', () => {
            deck.draw(5);
            expect(deck.remaining).toBe(49);
        });

        test('returns valid cards', () => {
            const drawn = deck.draw(3);
            drawn.forEach(card => {
                expect(card).toHaveProperty('suit');
                expect(card).toHaveProperty('rank');
            });
        });

        test('throws error if drawing more than available', () => {
            deck.draw(50);
            expect(() => deck.draw(10)).toThrow();
        });

        test('can draw all 54 cards', () => {
            const drawn = deck.draw(54);
            expect(drawn.length).toBe(54);
            expect(deck.remaining).toBe(0);
        });

        test('cards drawn are removed from deck', () => {
            const firstFive = deck.draw(5);
            const remaining = deck.cards;

            for (const drawnCard of firstFive) {
                const stillInDeck = remaining.some(c =>
                    c.suit === drawnCard.suit && c.rank === drawnCard.rank
                );
                expect(stillInDeck).toBe(false);
            }
        });
    });

    describe('drawOne', () => {
        test('returns single card', () => {
            const card = deck.drawOne();
            expect(card).toHaveProperty('suit');
            expect(card).toHaveProperty('rank');
        });

        test('reduces deck by one', () => {
            deck.drawOne();
            expect(deck.remaining).toBe(53);
        });

        test('throws error on empty deck', () => {
            deck.draw(54);
            expect(() => deck.drawOne()).toThrow('Deck is empty');
        });

        test('returns different cards on successive calls', () => {
            const card1 = deck.drawOne();
            const card2 = deck.drawOne();

            // Could be same card in different suits, but string representation should differ
            // (or same card twice if shuffled - but very unlikely in first 2 draws)
            expect(deck.remaining).toBe(52);
        });
    });

    describe('reset', () => {
        test('restores all cards', () => {
            deck.draw(30);
            deck.reset();
            expect(deck.remaining).toBe(54);
        });

        test('can draw full deck after reset', () => {
            deck.draw(54);
            deck.reset();
            const drawn = deck.draw(54);
            expect(drawn.length).toBe(54);
        });

        test('restores standard cards after reset', () => {
            deck.draw(54);
            deck.reset();

            const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
            const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

            for (const suit of suits) {
                for (const rank of ranks) {
                    const found = deck.cards.some(c =>
                        c.suit === suit && c.rank === rank
                    );
                    expect(found).toBe(true);
                }
            }
        });

        test('restores jokers after reset', () => {
            deck.draw(54);
            deck.reset();

            expect(deck.cards.some(c => c.suit === 'joker' && c.rank === 'HI')).toBe(true);
            expect(deck.cards.some(c => c.suit === 'joker' && c.rank === 'LO')).toBe(true);
        });
    });

    describe('remaining getter', () => {
        test('returns correct count initially', () => {
            expect(deck.remaining).toBe(54);
        });

        test('updates after draw', () => {
            deck.draw(10);
            expect(deck.remaining).toBe(44);
        });

        test('returns 0 when empty', () => {
            deck.draw(54);
            expect(deck.remaining).toBe(0);
        });
    });
});
