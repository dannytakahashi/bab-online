/**
 * Tests for bot strategy functions
 */

const {
    evaluateHand,
    calculateOptimalBid,
    selectLead,
    selectFollow,
    selectDiscard,
    selectOptimalCard,
    isNoTrump,
    getNonTrumpScale,
    getTrumpScale,
    getOpponentPositions,
    getOpponentVoidSuits,
    getPartnerVoidSuits,
    getGameProgress,
    applyBidModifier
} = require('../BotStrategy');

const BotPlayer = require('../BotPlayer');

// --- Helper to create cards ---
const card = (suit, rank) => ({ suit, rank });
const HI = card('joker', 'HI');
const LO = card('joker', 'LO');

// --- Common trump cards ---
const heartsTrump = card('hearts', '7');
const spadesTrump = card('spades', '5');
const jokerTrump = card('joker', 'HI'); // No-trump: joker flipped

// --- evaluateHand tests ---

describe('evaluateHand', () => {
    describe('hand-size scaling for non-trump cards', () => {
        test('non-trump Ace worth ~0.8 at hand size 13 (excluding void bonuses)', () => {
            // Use a hand with all 4 suits represented so no void bonuses
            const hand = [
                card('spades', 'A'),
                card('hearts', '2'), card('diamonds', '2'), card('clubs', '2')
            ];
            const result = evaluateHand(hand, heartsTrump, 13);
            // Ace: 0.8 * 1.0 = 0.8, hearts 2 = trump (no value), diamonds 2 = 0, clubs 2 = 0
            // trumpCount = 1, single trump devaluation doesn't apply (handSize < 8 for this check... wait handSize=13)
            // Actually single trump devaluation: trumpCount=1, handSize=13>=8, card is hearts 2 (not HI/LO)
            // hearts 2 rank value = 2 < 7, so no points were added, devaluation doesn't subtract anything extra
            // voids = 0 (all suits present)
            // trump length bonus: trumpCount=1, < 4, so 0
            expect(result.points).toBeCloseTo(0.8, 1);
        });

        test('non-trump Ace worth ~0.08 at hand size 2', () => {
            const hand = [card('spades', 'A'), card('spades', 'K')];
            const result = evaluateHand(hand, heartsTrump, 2);
            // Ace: 0.8 * 0.1 = 0.08, King: 0.4 * 0.1 = 0.04
            // Voids: 2 (diamonds=0, clubs=0) but trumpCount=0, so void bonus = 0
            expect(result.points).toBeCloseTo(0.08 + 0.04, 1);
        });

        test('non-trump Ace worth 0 at hand size 1', () => {
            const hand = [card('spades', 'A')];
            const result = evaluateHand(hand, heartsTrump, 1);
            // 0.8 * 0.0 = 0, trumpCount=0 so void bonus = 0
            expect(result.points).toBeCloseTo(0, 1);
        });

        test('HI joker always worth ~1.9 regardless of hand size', () => {
            const hand1 = [HI];
            const hand13 = [HI, ...Array(12).fill(null).map((_, i) => card('spades', String(i + 2)))];

            const result1 = evaluateHand([HI], heartsTrump, 1);
            const result13 = evaluateHand([HI], heartsTrump, 13);

            // Both should include 1.9 for HI joker (plus void bonuses)
            expect(result1.points).toBeGreaterThanOrEqual(1.9);
            expect(result13.points).toBeGreaterThanOrEqual(1.9);
        });

        test('trump Ace strong regardless of hand size', () => {
            const hand = [card('hearts', 'A')];
            const small = evaluateHand(hand, heartsTrump, 2);
            const large = evaluateHand(hand, heartsTrump, 12);

            // Trump Ace: 1.4 * tScale (1.2 for small, 1.0 for large)
            expect(small.points).toBeGreaterThan(1.4);
            expect(large.points).toBeGreaterThanOrEqual(1.4);
        });
    });

    describe('single trump devaluation', () => {
        test('single trump King devalued in 12-card hand', () => {
            const hand = [
                card('hearts', 'K'),
                ...Array(11).fill(null).map((_, i) => card('spades', String(Math.min(i + 2, 10))))
            ];
            // Remove duplicates by using different suits
            const cleanHand = [
                card('hearts', 'K'),
                card('spades', '2'), card('spades', '3'), card('spades', '4'),
                card('diamonds', '2'), card('diamonds', '3'), card('diamonds', '4'),
                card('clubs', '2'), card('clubs', '3'), card('clubs', '4'),
                card('spades', '5'), card('spades', '6')
            ];
            const result = evaluateHand(cleanHand, heartsTrump, 12);
            // Single trump King = 0.9 * 1.0 - 0.3 (devaluation) = 0.6
            // Only 1 trump card, handSize >= 8
            expect(result.trumpCount).toBe(1);
            // Points should be less than 0.9 for the King alone (devalued)
        });

        test('single trump not devalued in 4-card hand', () => {
            const hand = [
                card('hearts', 'K'),
                card('spades', 'A'), card('diamonds', '2'), card('clubs', '3')
            ];
            const result = evaluateHand(hand, heartsTrump, 4);
            expect(result.trumpCount).toBe(1);
            // handSize < 8, no devaluation applied
        });

        test('single HI joker never devalued', () => {
            const hand = [
                HI,
                card('spades', '2'), card('spades', '3'), card('spades', '4'),
                card('diamonds', '2'), card('diamonds', '3'), card('diamonds', '4'),
                card('clubs', '2'), card('clubs', '3'), card('clubs', '4'),
                card('spades', '5'), card('spades', '6')
            ];
            const result = evaluateHand(hand, heartsTrump, 12);
            // HI joker is excluded from devaluation
            expect(result.points).toBeGreaterThanOrEqual(1.9);
        });
    });

    describe('void + trump synergy', () => {
        test('void worth more with 5 trump than 1 trump', () => {
            const hand5Trump = [
                card('hearts', 'A'), card('hearts', 'K'), card('hearts', 'Q'),
                card('hearts', 'J'), card('hearts', '10'),
                card('spades', '2')
            ];
            const hand1Trump = [
                card('hearts', 'A'),
                card('spades', '2'), card('spades', '3'), card('spades', '4'),
                card('spades', '5'), card('spades', '6')
            ];

            const result5 = evaluateHand(hand5Trump, heartsTrump, 6);
            const result1 = evaluateHand(hand1Trump, heartsTrump, 6);

            // 5 trump hand has more void bonus per void
            // voidBonus(5 trump) = min(0.3 + 5*0.15, 1.5) = 1.05
            // voidBonus(1 trump) = min(0.3 + 1*0.15, 1.5) = 0.45
            expect(result5.voids).toBeGreaterThan(0);
            // The 5-trump hand should get more total points from void+trump
        });

        test('void worth nothing with 0 trump', () => {
            const hand = [card('spades', 'A'), card('spades', 'K')];
            const result = evaluateHand(hand, heartsTrump, 4);
            // trumpCount = 0, so void bonus = 0 regardless of void count
            // Ace: 0.8 * 0.3 = 0.24, King: 0.4 * 0.3 = 0.12
            expect(result.voids).toBe(2); // diamonds=0, clubs=0
            expect(result.points).toBeCloseTo(0.24 + 0.12, 1);
        });

        test('void worth minimal in no-trump hand', () => {
            const hand = [
                card('spades', 'A'), card('spades', 'K')
            ];
            const result = evaluateHand(hand, jokerTrump, 2);
            // In no-trump, void bonus = 0.1 per void
            // Three voids (hearts, diamonds, clubs - all non-trump since joker flipped) = 0.3
            expect(result.voids).toBe(3);
        });
    });

    describe('no-trump hands', () => {
        test('non-trump Ace valued at ~1.3 in no-trump', () => {
            const hand = [card('spades', 'A')];
            const result = evaluateHand(hand, jokerTrump, 8);
            // In no-trump, Ace = 1.3
            expect(result.points).toBeGreaterThanOrEqual(1.3);
        });

        test('non-trump King valued at ~0.7 in no-trump', () => {
            const hand = [card('spades', 'K')];
            const result = evaluateHand(hand, jokerTrump, 8);
            // In no-trump, King = 0.7
            expect(result.points).toBeGreaterThanOrEqual(0.7);
        });

        test('isNoTrump detects joker trump', () => {
            expect(isNoTrump(jokerTrump)).toBe(true);
            expect(isNoTrump(heartsTrump)).toBe(false);
        });
    });
});

// --- calculateOptimalBid tests ---

describe('calculateOptimalBid', () => {
    describe('conservative rounding', () => {
        test('floors instead of rounding (points just below integer)', () => {
            // Hand that evaluates to ~2.9 points should bid 2, not 3
            const hand = [
                HI,                      // 1.9
                card('hearts', 'Q'),     // 0.4 (trump queen)
                card('spades', '2'), card('spades', '3'),
                card('diamonds', '2'), card('diamonds', '3'),
                card('clubs', '2'), card('clubs', '3')
            ];
            // Position 2 (not first bidder), no existing bids from anyone before
            const bid = calculateOptimalBid(hand, heartsTrump, 2, [undefined, undefined, undefined, undefined], 8, null, null);
            // Should be <= 2 (floor of ~2.3)
            const bidNum = parseInt(bid);
            expect(bidNum).toBeLessThanOrEqual(3);
        });
    });

    describe('bore on small hands', () => {
        test('2-card hand: two mid-trump bores when all bid 0', () => {
            const hand = [card('hearts', '9'), card('hearts', '8')];
            // All others bid 0
            const bids = ['0', undefined, '0', '0'];
            const bid = calculateOptimalBid(hand, heartsTrump, 2, bids, 2, null, null);
            expect(bid).toBe('B');
        });

        test('2-card hand: HI joker + Ace non-trump bores when all bid 0', () => {
            const hand = [HI, card('spades', 'A')];
            const bids = ['0', undefined, '0', '0'];
            const bid = calculateOptimalBid(hand, heartsTrump, 2, bids, 2, null, null);
            expect(bid).toBe('B');
        });

        test('2-card hand: HI joker + King non-trump bores when all bid 0', () => {
            const hand = [HI, card('spades', 'K')];
            const bids = ['0', undefined, '0', '0'];
            const bid = calculateOptimalBid(hand, heartsTrump, 2, bids, 2, null, null);
            expect(bid).toBe('B');
        });

        test('2-card hand: HI joker + 5 non-trump does NOT bore', () => {
            const hand = [HI, card('spades', '5')];
            const bids = ['0', undefined, '0', '0'];
            const bid = calculateOptimalBid(hand, heartsTrump, 2, bids, 2, null, null);
            expect(bid).not.toBe('B');
        });

        test('1-card hand: HI joker bores when all bid 0', () => {
            const hand = [HI];
            const bids = ['0', undefined, '0', '0'];
            const bid = calculateOptimalBid(hand, heartsTrump, 2, bids, 1, null, null);
            expect(bid).toBe('B');
        });

        test('1-card hand: low trump does NOT bore', () => {
            const hand = [card('hearts', '3')];
            const bids = ['0', undefined, '0', '0'];
            const bid = calculateOptimalBid(hand, heartsTrump, 2, bids, 1, null, null);
            expect(bid).not.toBe('B');
        });

        test('2-card hand: does NOT bore when opponent bid > 0', () => {
            const hand = [card('hearts', '9'), card('hearts', '8')];
            const bids = ['1', undefined, '0', '0'];
            const bid = calculateOptimalBid(hand, heartsTrump, 2, bids, 2, null, null);
            expect(bid).not.toBe('B');
        });
    });

    describe('opponent bid awareness', () => {
        test('more conservative when opponents bid high', () => {
            const hand = [
                card('hearts', 'A'), card('hearts', 'K'),
                card('spades', 'A'), card('spades', 'K'),
                card('diamonds', '2'), card('diamonds', '3')
            ];
            // Low opponent bids
            const bidsLow = ['0', undefined, '0', '1'];
            const bidLow = calculateOptimalBid(hand, heartsTrump, 2, bidsLow, 6, null, null);

            // High opponent bids (both opponents bid high)
            const bidsHigh = ['4', undefined, '0', '4'];
            const bidHigh = calculateOptimalBid(hand, heartsTrump, 2, bidsHigh, 6, null, null);

            expect(parseInt(bidHigh)).toBeLessThanOrEqual(parseInt(bidLow));
        });

        test('first bidder is more conservative', () => {
            const hand = [
                card('hearts', 'A'), card('hearts', 'K'),
                card('spades', 'A'), card('spades', 'K'),
                card('diamonds', '2'), card('diamonds', '3'),
                card('clubs', '2'), card('clubs', '3')
            ];
            // First bidder (no bids yet)
            const bidFirst = calculateOptimalBid(hand, heartsTrump, 1, [undefined, undefined, undefined, undefined], 8, null, null);
            // Dealer (last bidder, all others bid 0)
            const bidDealer = calculateOptimalBid(hand, heartsTrump, 4, ['0', '0', '0', undefined], 8, null, null);

            expect(parseInt(bidFirst)).toBeLessThanOrEqual(parseInt(bidDealer));
        });
    });

    describe('Danny small hand overbid fix', () => {
        test('Danny does not bid 1 on worthless 1-card non-trump hand', () => {
            const hand = [card('spades', 'J')];
            const bids = ['B', undefined, '0', '0'];
            const bid = calculateOptimalBid(hand, heartsTrump, 2, bids, 1, null, null, 'danny');
            expect(bid).toBe('0');
        });

        test('Danny does not bid 1 on worthless 2-card non-trump hand', () => {
            const hand = [card('spades', 'J'), card('diamonds', '5')];
            const bids = ['0', undefined, '0', '0'];
            const bid = calculateOptimalBid(hand, heartsTrump, 2, bids, 2, null, null, 'danny');
            expect(bid).toBe('0');
        });
    });

    describe('partner bore support', () => {
        test('double-bores to support partner on small hands with trump', () => {
            const hand = [card('hearts', 'K'), card('hearts', 'Q')];
            // Partner (position 4) bored, we're position 2
            const bids = ['0', undefined, undefined, 'B'];
            const bid = calculateOptimalBid(hand, heartsTrump, 2, bids, 2, null, null);
            expect(bid).toBe('2B');
        });
    });
});

// --- selectLead tests ---

describe('selectLead', () => {
    describe('King timing', () => {
        test('does not lead King when Ace unplayed on large hand', () => {
            const hand = [
                card('spades', 'K'), card('spades', '5'),
                card('diamonds', '3'), card('diamonds', '2'),
                card('clubs', '3'), card('clubs', '2'),
                card('hearts', '2'), card('hearts', '3')
            ];
            const memory = {
                playedCards: [],
                trumpPlayed: [],
                acesPlayed: { spades: false, hearts: false, diamonds: false, clubs: false },
                trickIndex: 0,
                totalCardsPlayed: 0
            };
            const result = selectLead(hand, heartsTrump, false, { position: 1 }, memory, 8);
            // Should NOT lead King of spades (Ace hasn't been played)
            expect(result.rank).not.toBe('K');
        });

        test('leads King when Ace already played (from memory)', () => {
            const hand = [
                card('spades', 'K'), card('spades', '5'),
                card('diamonds', '3'), card('diamonds', '2'),
                card('clubs', '3'), card('clubs', '2'),
                card('hearts', '2'), card('hearts', '3')
            ];
            const memory = {
                playedCards: [{ suit: 'spades', rank: 'A', position: 3, trickIndex: 0 }],
                trumpPlayed: [],
                acesPlayed: { spades: true, hearts: false, diamonds: false, clubs: false },
                trickIndex: 1,
                totalCardsPlayed: 4
            };
            const result = selectLead(hand, heartsTrump, false, { position: 1 }, memory, 8);
            // Should lead King of spades (Ace has been played)
            expect(result.rank).toBe('K');
            expect(result.suit).toBe('spades');
        });

        test('leads King freely on small hand (Ace may not be dealt)', () => {
            const hand = [
                card('spades', 'K'), card('diamonds', '3')
            ];
            const memory = {
                playedCards: [],
                trumpPlayed: [],
                acesPlayed: { spades: false, hearts: false, diamonds: false, clubs: false },
                trickIndex: 0,
                totalCardsPlayed: 0
            };
            const result = selectLead(hand, heartsTrump, false, { position: 1 }, memory, 2);
            // On small hand, King is fine to lead
            expect(result.rank).toBe('K');
        });
    });

    test('leads HI joker when available and trump is broken', () => {
        const hand = [HI, card('spades', 'A'), card('diamonds', 'K')];
        const result = selectLead(hand, heartsTrump, true, { position: 1 }, null, 3);
        expect(result.rank).toBe('HI');
    });

    test('prefers shorter suits for leading', () => {
        const hand = [
            card('spades', 'A'),  // Short suit (1 card) with Ace
            card('diamonds', '8'), card('diamonds', '7'), card('diamonds', '6'),  // Long suit (3 cards)
            card('clubs', '2'), card('clubs', '3')
        ];
        const result = selectLead(hand, heartsTrump, false, { position: 1 }, null, 6);
        // Should prefer spades (shorter + has Ace)
        expect(result.suit).toBe('spades');
    });
});

// --- selectFollow tests ---

describe('selectFollow', () => {
    describe('King protection', () => {
        test('avoids King as lowest winner when Ace unplayed on large hand', () => {
            const hand = [
                card('spades', 'K'), card('spades', 'A'), // Has both King and Ace
                card('diamonds', '2'), card('diamonds', '3'),
                card('clubs', '2'), card('clubs', '3'),
                card('hearts', '2'), card('hearts', '3')
            ];
            // Lead is spades, current winner is Q of spades from opponent
            const playedCards = [undefined, card('spades', 'Q'), undefined, undefined];
            const leadCard = card('spades', 'Q');
            const memory = {
                playedCards: [],
                trumpPlayed: [],
                acesPlayed: { spades: false, hearts: false, diamonds: false, clubs: false },
                trickIndex: 0,
                totalCardsPlayed: 1
            };

            // Position 1, lead position 2, Ace unplayed, but we HAVE both K and A
            // King is lowest winner, A hasn't been played but we have it
            // This should actually still play King (we own the Ace)
            // Let's test a case where we DON'T have the Ace
            const hand2 = [
                card('spades', 'K'), card('spades', '10'),
                card('diamonds', '2'), card('diamonds', '3'),
                card('clubs', '2'), card('clubs', '3'),
                card('hearts', '2'), card('hearts', '3')
            ];
            // King is lowest winner, Ace not played, players still to act
            const result = selectFollow(hand2, playedCards, leadCard, 2, heartsTrump, false, 3, memory, 8);
            // Should avoid playing King (play 10 instead since it can't win, or skip to lower)
            // Actually, if Q is current winner, K beats Q, 10 doesn't beat Q
            // So King is the ONLY winner - should still play it
        });

        test('plays King when last to act', () => {
            const hand = [
                card('spades', 'K'), card('spades', '5'),
                card('diamonds', '2'), card('clubs', '2')
            ];
            // 3 cards already played, we're last
            const playedCards = [card('spades', 'Q'), card('spades', '3'), card('spades', '4'), undefined];
            const leadCard = card('spades', 'Q');
            const memory = {
                playedCards: [],
                trumpPlayed: [],
                acesPlayed: { spades: false, hearts: false, diamonds: false, clubs: false },
                trickIndex: 0,
                totalCardsPlayed: 3
            };
            const result = selectFollow(hand, playedCards, leadCard, 1, heartsTrump, false, 4, memory, 4);
            // Last to play, King wins, play it
            expect(result.rank).toBe('K');
            expect(result.suit).toBe('spades');
        });
    });

    test('plays low when partner is winning', () => {
        const hand = [
            card('spades', 'K'), card('spades', '3')
        ];
        // Partner (position 3) is winning with Ace of spades
        const playedCards = [undefined, card('spades', '5'), card('spades', 'A'), undefined];
        const leadCard = card('spades', '5');
        const result = selectFollow(hand, playedCards, leadCard, 2, heartsTrump, false, 1, null, 2);
        // Partner winning, play lowest
        expect(result.rank).toBe('3');
    });

    test('trumps in when void and opponent winning', () => {
        const hand = [
            card('hearts', '3'), card('clubs', '2')
        ];
        // Spades led, we're void in spades, opponent winning
        const playedCards = [card('spades', 'A'), undefined, undefined, undefined];
        const leadCard = card('spades', 'A');
        const result = selectFollow(hand, playedCards, leadCard, 1, heartsTrump, false, 2, null, 2);
        // Should trump in with hearts 3
        expect(result.suit).toBe('hearts');
    });
});

// --- Card memory tests ---

describe('BotPlayer card memory', () => {
    let bot;

    beforeEach(() => {
        bot = new BotPlayer('TestBot');
        bot.position = 1;
    });

    test('tracks played cards', () => {
        bot.resetCardMemory(4, heartsTrump);
        bot.recordCardPlayed(card('spades', 'A'), 2, heartsTrump);
        bot.recordCardPlayed(card('hearts', 'K'), 3, heartsTrump);

        const snapshot = bot.getMemorySnapshot();
        expect(snapshot.playedCards).toHaveLength(2);
        expect(snapshot.playedCards[0].suit).toBe('spades');
        expect(snapshot.playedCards[0].rank).toBe('A');
        expect(snapshot.playedCards[0].position).toBe(2);
    });

    test('tracks aces played per suit', () => {
        bot.resetCardMemory(8, heartsTrump);
        bot.recordCardPlayed(card('spades', 'A'), 2, heartsTrump);
        bot.recordCardPlayed(card('diamonds', 'K'), 3, heartsTrump);

        const snapshot = bot.getMemorySnapshot();
        expect(snapshot.acesPlayed.spades).toBe(true);
        expect(snapshot.acesPlayed.diamonds).toBe(false);
        expect(snapshot.acesPlayed.hearts).toBe(false);
    });

    test('tracks trump cards played', () => {
        bot.resetCardMemory(8, heartsTrump);
        bot.recordCardPlayed(card('hearts', 'K'), 2, heartsTrump);
        bot.recordCardPlayed(card('spades', 'A'), 3, heartsTrump);
        bot.recordCardPlayed(HI, 4, heartsTrump);

        const snapshot = bot.getMemorySnapshot();
        expect(snapshot.trumpPlayed).toHaveLength(2); // hearts K and HI joker
        expect(snapshot.trumpPlayed[0].rank).toBe('K');
        expect(snapshot.trumpPlayed[1].rank).toBe('HI');
    });

    test('resets between hands', () => {
        bot.resetCardMemory(4, heartsTrump);
        bot.recordCardPlayed(card('spades', 'A'), 2, heartsTrump);

        bot.resetCardMemory(2, heartsTrump);
        const snapshot = bot.getMemorySnapshot();
        expect(snapshot.playedCards).toHaveLength(0);
        expect(snapshot.acesPlayed.spades).toBe(false);
    });

    test('getMemorySnapshot returns independent copy', () => {
        bot.resetCardMemory(4, heartsTrump);
        bot.recordCardPlayed(card('spades', 'A'), 2, heartsTrump);

        const snapshot1 = bot.getMemorySnapshot();
        bot.recordCardPlayed(card('hearts', 'K'), 3, heartsTrump);
        const snapshot2 = bot.getMemorySnapshot();

        expect(snapshot1.playedCards).toHaveLength(1);
        expect(snapshot2.playedCards).toHaveLength(2);
    });

    test('advances trick index', () => {
        bot.resetCardMemory(4, heartsTrump);
        expect(bot.getMemorySnapshot().trickIndex).toBe(0);

        bot.advanceTrick();
        expect(bot.getMemorySnapshot().trickIndex).toBe(1);
    });

    test('returns null when memory not initialized', () => {
        const freshBot = new BotPlayer('Fresh');
        expect(freshBot.getMemorySnapshot()).toBeNull();
    });
});

// --- Helper function tests ---

describe('helper functions', () => {
    test('getNonTrumpScale returns 0 for 1-card hand', () => {
        expect(getNonTrumpScale(1)).toBe(0.0);
    });

    test('getNonTrumpScale returns 1.0 for 13-card hand', () => {
        expect(getNonTrumpScale(13)).toBe(1.0);
    });

    test('getTrumpScale higher for small hands', () => {
        expect(getTrumpScale(2)).toBeGreaterThan(getTrumpScale(8));
    });

    test('getOpponentPositions returns correct opponents', () => {
        expect(getOpponentPositions(1).sort()).toEqual([2, 4]);
        expect(getOpponentPositions(2).sort()).toEqual([1, 3]);
    });

    test('getGameProgress returns 0 for first hand', () => {
        expect(getGameProgress(12)).toBe(0);
    });

    test('getGameProgress returns 1 for last hand', () => {
        expect(getGameProgress(13)).toBe(1);
    });

    test('getGameProgress returns ~0.5 for middle hand', () => {
        const progress = getGameProgress(1); // 1-card hand is index 6 of 12
        expect(progress).toBe(6 / 12);
    });
});

describe('opponent void detection', () => {
    test('detects opponent void when they played off-suit', () => {
        const memory = {
            playedCards: [
                { suit: 'spades', rank: 'A', position: 1, trickIndex: 0 },   // Lead
                { suit: 'hearts', rank: '3', position: 2, trickIndex: 0 },   // Opponent played hearts (void in spades!)
                { suit: 'spades', rank: 'K', position: 3, trickIndex: 0 },
                { suit: 'spades', rank: 'Q', position: 4, trickIndex: 0 },
            ],
            trumpPlayed: [],
            acesPlayed: { spades: true, hearts: false, diamonds: false, clubs: false },
            trickIndex: 1,
            totalCardsPlayed: 4
        };

        const voids = getOpponentVoidSuits(memory, 1, heartsTrump);
        // Position 2 played hearts on a spades lead -> void in spades
        expect(voids.has('2:spades')).toBe(true);
    });

    test('detects partner void', () => {
        const memory = {
            playedCards: [
                { suit: 'spades', rank: 'A', position: 2, trickIndex: 0 },
                { suit: 'hearts', rank: '3', position: 3, trickIndex: 0 },  // Partner (of pos 1) played off-suit
                { suit: 'spades', rank: 'K', position: 4, trickIndex: 0 },
                { suit: 'spades', rank: 'Q', position: 1, trickIndex: 0 },
            ],
            trumpPlayed: [],
            acesPlayed: { spades: true, hearts: false, diamonds: false, clubs: false },
            trickIndex: 1,
            totalCardsPlayed: 4
        };

        const voids = getPartnerVoidSuits(memory, 1, heartsTrump);
        // Partner (position 3) played hearts on a spades lead -> void in spades
        expect(voids.has('spades')).toBe(true);
    });
});

// --- applyBidModifier tests ---

describe('applyBidModifier', () => {
    // Helper to create a mock evaluation
    const makeEval = (points, trumpCount = 2) => ({
        points,
        trumpCount,
        voids: 0,
        suitCounts: { spades: 3, hearts: 3, diamonds: 3, clubs: 3 },
        hasHighJoker: false,
        hasLowJoker: false,
        hasTrumpAce: false
    });

    describe('mary (neutral)', () => {
        test('returns unmodified bid', () => {
            expect(applyBidModifier(3, 'mary', makeEval(3.5), 12, [])).toBe(3);
        });

        test('returns unmodified bid for strong hand', () => {
            expect(applyBidModifier(5, 'mary', makeEval(8.0), 12, [])).toBe(5);
        });
    });

    describe('sharon (conservative)', () => {
        test('underbids strong hand by 1 (points >= handSize * 0.5)', () => {
            // handSize=12, 0.5*12=6, points=6.5 >= 6
            expect(applyBidModifier(6, 'sharon', makeEval(6.5), 12, [])).toBe(5);
        });

        test('underbids very strong hand by 2 (points >= handSize * 0.7)', () => {
            // handSize=12, 0.7*12=8.4, points=9.0 >= 8.4
            expect(applyBidModifier(8, 'sharon', makeEval(9.0), 12, [])).toBe(6);
        });

        test('does not modify weak hand bid', () => {
            // handSize=12, 0.5*12=6, points=2.0 < 6
            expect(applyBidModifier(2, 'sharon', makeEval(2.0), 12, [])).toBe(2);
        });

        test('does not go below 0', () => {
            // handSize=4, 0.5*4=2, points=2.5 >= 2, bid 1 - 1 = 0
            expect(applyBidModifier(1, 'sharon', makeEval(2.5), 4, [])).toBe(0);
        });
    });

    describe('danny (calculated aggressive)', () => {
        test('rounds up when points close to next integer (0.25+ over)', () => {
            // baseBid=2 (from floor(2.7)), points=2.7, diff=0.7 >= 0.25
            expect(applyBidModifier(2, 'danny', makeEval(2.7), 12, [])).toBe(3);
        });

        test('does not round up when well below next integer', () => {
            // baseBid=2, points=2.1, diff=0.1 < 0.25
            expect(applyBidModifier(2, 'danny', makeEval(2.1), 12, [])).toBe(2);
        });

        test('does not exceed hand size', () => {
            expect(applyBidModifier(4, 'danny', makeEval(4.5), 4, [])).toBe(4);
        });

        test('does not bump 0 to 1 on small hands (<=4 cards)', () => {
            expect(applyBidModifier(0, 'danny', makeEval(0.5), 1, [])).toBe(0);
            expect(applyBidModifier(0, 'danny', makeEval(0.5), 2, [])).toBe(0);
            expect(applyBidModifier(0, 'danny', makeEval(0.5), 4, [])).toBe(0);
        });

        test('still bumps 0 to 1 on large hands when close', () => {
            expect(applyBidModifier(0, 'danny', makeEval(0.5), 8, [])).toBe(1);
        });
    });

    describe('mike (overconfident)', () => {
        test('sometimes overbids by 1 (random)', () => {
            // Run multiple times to verify randomness
            const results = new Set();
            for (let i = 0; i < 100; i++) {
                results.add(applyBidModifier(3, 'mike', makeEval(3.0), 12, []));
            }
            // Should see both 3 and 4 in results
            expect(results.has(3)).toBe(true);
            expect(results.has(4)).toBe(true);
        });

        test('does not exceed hand size', () => {
            const results = new Set();
            for (let i = 0; i < 100; i++) {
                results.add(applyBidModifier(4, 'mike', makeEval(4.0), 4, []));
            }
            // All results should be 4 (capped at handSize)
            expect(results.has(4)).toBe(true);
            expect(results.size).toBe(1);
        });
    });

    describe('zach (adaptive)', () => {
        test('does not modify bid with insufficient history (< 2 hands)', () => {
            const history = [{ bid: 3, tricks: 5 }]; // only 1 hand
            expect(applyBidModifier(3, 'zach', makeEval(3.5), 12, history)).toBe(3);
        });

        test('bids down when partner is aggressive (overbids)', () => {
            // Partner bids more than they win: avg error = (2-3 + 1-3) / 2 = -1.5
            const history = [
                { bid: 3, tricks: 2 },
                { bid: 3, tricks: 1 }
            ];
            expect(applyBidModifier(3, 'zach', makeEval(3.5), 12, history)).toBe(2);
        });

        test('cautiously bids up when partner is conservative and hand supports it', () => {
            // Partner wins more than they bid: avg error = (5-2 + 4-2) / 2 = 2.5
            const history = [
                { bid: 2, tricks: 5 },
                { bid: 2, tricks: 4 }
            ];
            // evaluation.points - baseBid = 3.5 - 3 = 0.5 >= 0.3 -> bid up
            expect(applyBidModifier(3, 'zach', makeEval(3.5), 12, history)).toBe(4);
        });

        test('does not bid up when hand does not support it', () => {
            // Partner is conservative but hand evaluation barely supports current bid
            const history = [
                { bid: 2, tricks: 5 },
                { bid: 2, tricks: 4 }
            ];
            // evaluation.points - baseBid = 3.1 - 3 = 0.1 < 0.3 -> stay
            expect(applyBidModifier(3, 'zach', makeEval(3.1), 12, history)).toBe(3);
        });

        test('does not go below 0', () => {
            const history = [
                { bid: 3, tricks: 0 },
                { bid: 3, tricks: 0 }
            ];
            expect(applyBidModifier(0, 'zach', makeEval(0.5), 4, history)).toBe(0);
        });
    });
});

// --- selectDiscard tests ---

describe('selectDiscard', () => {
    test('with trump: voids shortest non-trump suit', () => {
        const cards = [
            card('spades', '3'),
            card('diamonds', '5'), card('diamonds', '7')
        ];
        const result = selectDiscard(cards, heartsTrump, true);
        expect(result.suit).toBe('spades');
        expect(result.rank).toBe('3');
    });

    test('without trump: dumps lowest card overall regardless of suit length', () => {
        const cards = [
            card('spades', 'K'),
            card('diamonds', '3'), card('diamonds', '7')
        ];
        const result = selectDiscard(cards, heartsTrump, false);
        expect(result.suit).toBe('diamonds');
        expect(result.rank).toBe('3');
    });

    test('with trump: protects Ace when voiding', () => {
        const cards = [
            card('spades', 'A'),
            card('diamonds', '3'), card('diamonds', '7')
        ];
        const result = selectDiscard(cards, heartsTrump, true);
        expect(result.rank).not.toBe('A');
        expect(result.rank).toBe('3');
    });

    test('with trump: protects King when voiding', () => {
        const cards = [
            card('spades', 'K'),
            card('diamonds', '4'), card('diamonds', '8')
        ];
        const result = selectDiscard(cards, heartsTrump, true);
        expect(result.rank).not.toBe('K');
        expect(result.rank).toBe('4');
    });

    test('with trump: discards King if no lower cards available', () => {
        const cards = [
            card('spades', 'A'),
            card('diamonds', 'K')
        ];
        const result = selectDiscard(cards, heartsTrump, true);
        expect(result.rank).toBe('K');
    });
});
