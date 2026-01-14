/**
 * Unit tests for game rules
 */

const {
    RANK_VALUES,
    BID_RANKS,
    rotatePosition,
    getPartnerPosition,
    isSameSuit,
    isVoidInSuit,
    isRainbow,
    isTrumpTight,
    isLegalMove,
    determineWinner,
    calculateScore,
    findHighestBidder,
    calculateMultiplier,
    determineDrawPosition
} = require('../rules');

describe('rotatePosition', () => {
    test('rotates 1 to 2 (clockwise)', () => {
        expect(rotatePosition(1)).toBe(2);
    });

    test('rotates 2 to 3 (clockwise)', () => {
        expect(rotatePosition(2)).toBe(3);
    });

    test('rotates 3 to 4 (clockwise)', () => {
        expect(rotatePosition(3)).toBe(4);
    });

    test('rotates 4 to 1 (clockwise wrap around)', () => {
        expect(rotatePosition(4)).toBe(1);
    });
});

describe('getPartnerPosition', () => {
    test('position 1 partner is 3', () => {
        expect(getPartnerPosition(1)).toBe(3);
    });

    test('position 2 partner is 4', () => {
        expect(getPartnerPosition(2)).toBe(4);
    });

    test('position 3 partner is 1', () => {
        expect(getPartnerPosition(3)).toBe(1);
    });

    test('position 4 partner is 2', () => {
        expect(getPartnerPosition(4)).toBe(2);
    });
});

describe('isSameSuit', () => {
    const trump = { suit: 'hearts', rank: 'A' };

    test('same regular suits returns true', () => {
        const card1 = { suit: 'spades', rank: '2' };
        const card2 = { suit: 'spades', rank: 'K' };
        expect(isSameSuit(card1, card2, trump)).toBe(true);
    });

    test('different suits returns false', () => {
        const card1 = { suit: 'spades', rank: '2' };
        const card2 = { suit: 'hearts', rank: 'K' };
        expect(isSameSuit(card1, card2, trump)).toBe(false);
    });

    test('joker matches trump suit', () => {
        const joker = { suit: 'joker', rank: 'HI' };
        const heart = { suit: 'hearts', rank: '5' };
        expect(isSameSuit(joker, heart, trump)).toBe(true);
    });

    test('joker does not match non-trump', () => {
        const joker = { suit: 'joker', rank: 'HI' };
        const spade = { suit: 'spades', rank: '5' };
        expect(isSameSuit(joker, spade, trump)).toBe(false);
    });

    test('two jokers match each other', () => {
        const joker1 = { suit: 'joker', rank: 'HI' };
        const joker2 = { suit: 'joker', rank: 'LO' };
        expect(isSameSuit(joker1, joker2, trump)).toBe(true);
    });
});

describe('isVoidInSuit', () => {
    const trump = { suit: 'hearts', rank: 'A' };

    test('empty hand is void in all suits', () => {
        expect(isVoidInSuit([], 'spades', trump)).toBe(true);
    });

    test('hand without suit is void', () => {
        const hand = [
            { suit: 'hearts', rank: '2' },
            { suit: 'diamonds', rank: '3' }
        ];
        expect(isVoidInSuit(hand, 'spades', trump)).toBe(true);
    });

    test('hand with suit is not void', () => {
        const hand = [
            { suit: 'spades', rank: '2' },
            { suit: 'diamonds', rank: '3' }
        ];
        expect(isVoidInSuit(hand, 'spades', trump)).toBe(false);
    });

    test('joker counts as trump suit', () => {
        const hand = [
            { suit: 'joker', rank: 'HI' },
            { suit: 'spades', rank: '3' }
        ];
        expect(isVoidInSuit(hand, 'hearts', trump)).toBe(false);
    });
});

describe('isRainbow', () => {
    const trump = { suit: 'hearts', rank: 'A' };

    test('hand with all 4 suits is rainbow', () => {
        const hand = [
            { suit: 'spades', rank: '2' },
            { suit: 'hearts', rank: '3' },
            { suit: 'diamonds', rank: '4' },
            { suit: 'clubs', rank: '5' }
        ];
        expect(isRainbow(hand, trump)).toBe(true);
    });

    test('hand missing a suit is not rainbow', () => {
        const hand = [
            { suit: 'spades', rank: '2' },
            { suit: 'spades', rank: '3' },
            { suit: 'diamonds', rank: '4' },
            { suit: 'clubs', rank: '5' }
        ];
        expect(isRainbow(hand, trump)).toBe(false);
    });

    test('joker counts as trump suit for rainbow', () => {
        const hand = [
            { suit: 'spades', rank: '2' },
            { suit: 'joker', rank: 'HI' },  // Counts as hearts
            { suit: 'diamonds', rank: '4' },
            { suit: 'clubs', rank: '5' }
        ];
        expect(isRainbow(hand, trump)).toBe(true);
    });

    test('hand with 2 jokers and 2 other suits is not rainbow', () => {
        const hand = [
            { suit: 'joker', rank: 'HI' },
            { suit: 'joker', rank: 'LO' },
            { suit: 'spades', rank: '4' },
            { suit: 'clubs', rank: '5' }
        ];
        expect(isRainbow(hand, trump)).toBe(false);  // Missing diamonds
    });
});

describe('isTrumpTight', () => {
    const trump = { suit: 'hearts', rank: 'A' };

    test('hand with only trump is trump tight', () => {
        const hand = [
            { suit: 'hearts', rank: '2' },
            { suit: 'hearts', rank: '5' }
        ];
        expect(isTrumpTight(hand, trump)).toBe(true);
    });

    test('hand with jokers is trump tight', () => {
        const hand = [
            { suit: 'hearts', rank: '2' },
            { suit: 'joker', rank: 'HI' }
        ];
        expect(isTrumpTight(hand, trump)).toBe(true);
    });

    test('hand with non-trump is not trump tight', () => {
        const hand = [
            { suit: 'hearts', rank: '2' },
            { suit: 'spades', rank: '5' }
        ];
        expect(isTrumpTight(hand, trump)).toBe(false);
    });
});

describe('isLegalMove', () => {
    const trump = { suit: 'hearts', rank: 'A' };

    describe('when leading', () => {
        test('can lead any non-trump when trump not broken', () => {
            const card = { suit: 'spades', rank: '2' };
            const hand = [{ suit: 'hearts', rank: '3' }];
            expect(isLegalMove(card, hand, card, true, trump, false, 1, 1)).toBe(true);
        });

        test('cannot lead trump when not broken and have other suits', () => {
            const card = { suit: 'hearts', rank: '3' };
            const hand = [{ suit: 'spades', rank: '2' }];
            expect(isLegalMove(card, hand, card, true, trump, false, 1, 1)).toBe(false);
        });

        test('can lead trump when trump is broken', () => {
            const card = { suit: 'hearts', rank: '3' };
            const hand = [{ suit: 'spades', rank: '2' }];
            expect(isLegalMove(card, hand, card, true, trump, true, 1, 1)).toBe(true);
        });

        test('can lead trump when only have trump', () => {
            const card = { suit: 'hearts', rank: '2' };
            const hand = [{ suit: 'hearts', rank: '3' }];
            expect(isLegalMove(card, hand, card, true, trump, false, 1, 1)).toBe(true);
        });
    });

    describe('when following', () => {
        test('must follow suit if possible', () => {
            const card = { suit: 'hearts', rank: '3' };
            const hand = [{ suit: 'spades', rank: '2' }];
            const leadCard = { suit: 'spades', rank: 'K' };
            expect(isLegalMove(card, hand, leadCard, false, trump, false, 2, 1)).toBe(false);
        });

        test('can play any card if void in lead suit', () => {
            const card = { suit: 'hearts', rank: '2' };
            const hand = [{ suit: 'hearts', rank: '3' }];
            const leadCard = { suit: 'spades', rank: 'K' };
            expect(isLegalMove(card, hand, leadCard, false, trump, false, 2, 1)).toBe(true);
        });

        test('following suit is always legal', () => {
            const card = { suit: 'spades', rank: '2' };
            const hand = [{ suit: 'hearts', rank: '3' }];
            const leadCard = { suit: 'spades', rank: 'K' };
            expect(isLegalMove(card, hand, leadCard, false, trump, false, 2, 1)).toBe(true);
        });
    });
});

describe('determineWinner', () => {
    const trump = { suit: 'hearts', rank: 'A' };

    test('highest card of led suit wins when no trump', () => {
        const trick = [
            { suit: 'spades', rank: '5' },   // Position 1 (lead)
            { suit: 'spades', rank: 'K' },   // Position 2 - wins
            { suit: 'spades', rank: '3' },   // Position 3
            { suit: 'spades', rank: '7' }    // Position 4
        ];
        expect(determineWinner(trick, 1, trump)).toBe(2);
    });

    test('trump beats non-trump regardless of rank', () => {
        const trick = [
            { suit: 'spades', rank: 'A' },   // Position 1 (lead)
            { suit: 'hearts', rank: '2' },   // Position 2 - trump wins
            { suit: 'spades', rank: 'K' },   // Position 3
            { suit: 'spades', rank: 'Q' }    // Position 4
        ];
        expect(determineWinner(trick, 1, trump)).toBe(2);
    });

    test('higher trump beats lower trump', () => {
        const trick = [
            { suit: 'hearts', rank: '5' },   // Position 1 (lead)
            { suit: 'hearts', rank: '2' },   // Position 2
            { suit: 'hearts', rank: 'K' },   // Position 3 - wins
            { suit: 'hearts', rank: '7' }    // Position 4
        ];
        expect(determineWinner(trick, 1, trump)).toBe(3);
    });

    test('HI joker beats everything', () => {
        const trick = [
            { suit: 'hearts', rank: 'A' },   // Position 1 (lead)
            { suit: 'joker', rank: 'HI' },   // Position 2 - wins
            { suit: 'hearts', rank: 'K' },   // Position 3
            { suit: 'hearts', rank: 'Q' }    // Position 4
        ];
        expect(determineWinner(trick, 1, trump)).toBe(2);
    });

    test('HI joker beats LO joker', () => {
        const trick = [
            { suit: 'joker', rank: 'LO' },   // Position 1 (lead)
            { suit: 'joker', rank: 'HI' },   // Position 2 - wins
            { suit: 'hearts', rank: 'K' },   // Position 3
            { suit: 'hearts', rank: 'Q' }    // Position 4
        ];
        expect(determineWinner(trick, 1, trump)).toBe(2);
    });

    test('off-suit card never wins', () => {
        const trick = [
            { suit: 'spades', rank: '5' },      // Position 1 (lead)
            { suit: 'diamonds', rank: 'A' },    // Position 2 - off suit
            { suit: 'spades', rank: '7' },      // Position 3 - wins
            { suit: 'clubs', rank: 'K' }        // Position 4 - off suit
        ];
        expect(determineWinner(trick, 1, trump)).toBe(3);
    });

    test('lead position wins if all others off-suit', () => {
        const trick = [
            { suit: 'spades', rank: '2' },     // Position 1 (lead) - wins
            { suit: 'diamonds', rank: 'A' },   // Position 2 - off suit
            { suit: 'clubs', rank: 'K' },      // Position 3 - off suit
            { suit: 'diamonds', rank: 'Q' }    // Position 4 - off suit
        ];
        expect(determineWinner(trick, 1, trump)).toBe(1);
    });
});

describe('calculateScore', () => {
    test('made bid exactly scores bid * 10', () => {
        expect(calculateScore(3, 3, 1, 0)).toBe(30);
    });

    test('made bid with overtricks adds overtricks', () => {
        // Bid 3, got 5 = 30 + 2 = 32
        expect(calculateScore(3, 5, 1, 0)).toBe(32);
    });

    test('missed bid is negative', () => {
        // Bid 5, got 3 = -50
        expect(calculateScore(5, 3, 1, 0)).toBe(-50);
    });

    test('rainbow bonus added to made bid', () => {
        // Bid 2, got 2, 1 rainbow = 20 + 10 = 30
        expect(calculateScore(2, 2, 1, 1)).toBe(30);
    });

    test('rainbow bonus added even to missed bid', () => {
        // Bid 5, got 3, 1 rainbow = -50 + 10 = -40
        expect(calculateScore(5, 3, 1, 1)).toBe(-40);
    });

    test('multiplier applies to bid', () => {
        // Bid 4, got 4, multiplier 2 = 4 * 10 * 2 = 80
        expect(calculateScore(4, 4, 2, 0)).toBe(80);
    });

    test('multiplier applies to negative', () => {
        // Bid 4, got 2, multiplier 2 = -4 * 10 * 2 = -80
        expect(calculateScore(4, 2, 2, 0)).toBe(-80);
    });

    test('zero bid made scores zero', () => {
        expect(calculateScore(0, 0, 1, 0)).toBe(0);
    });

    test('zero bid with overtricks scores overtricks only', () => {
        // Bid 0, got 3 = 0 + 3 = 3
        expect(calculateScore(0, 3, 1, 0)).toBe(3);
    });
});

describe('calculateMultiplier', () => {
    test('4B returns 16', () => {
        expect(calculateMultiplier('4B', '0')).toBe(16);
    });

    test('3B returns 8', () => {
        expect(calculateMultiplier('3B', '5')).toBe(8);
    });

    test('2B returns 4', () => {
        expect(calculateMultiplier('2', '2B')).toBe(4);
    });

    test('B returns 2', () => {
        expect(calculateMultiplier('B', '3')).toBe(2);
    });

    test('no board bid returns 1', () => {
        expect(calculateMultiplier('5', '6')).toBe(1);
    });
});

describe('findHighestBidder', () => {
    test('finds highest bidder starting from position 1', () => {
        const bids = ['3', '5', '2', '4'];  // Position 2 (index 1) has highest
        expect(findHighestBidder(1, bids)).toBe(1);
    });

    test('finds board bid as highest', () => {
        const bids = ['B', '5', '2', '4'];  // Position 1 (index 0) has B=13
        expect(findHighestBidder(1, bids)).toBe(0);
    });

    test('handles tie by finding first in rotation', () => {
        const bids = ['5', '5', '5', '5'];  // All same, first from start wins
        expect(findHighestBidder(1, bids)).toBe(0);
    });
});

describe('RANK_VALUES', () => {
    test('has correct number values', () => {
        expect(RANK_VALUES['2']).toBe(2);
        expect(RANK_VALUES['10']).toBe(10);
        expect(RANK_VALUES['A']).toBe(14);
    });

    test('jokers are highest', () => {
        expect(RANK_VALUES['LO']).toBe(15);
        expect(RANK_VALUES['HI']).toBe(16);
    });
});

describe('BID_RANKS', () => {
    test('has correct bid values', () => {
        expect(BID_RANKS['0']).toBe(0);
        expect(BID_RANKS['5']).toBe(5);
        expect(BID_RANKS['12']).toBe(12);
    });

    test('board bids are highest', () => {
        expect(BID_RANKS['B']).toBe(13);
        expect(BID_RANKS['2B']).toBe(14);
        expect(BID_RANKS['3B']).toBe(15);
        expect(BID_RANKS['4B']).toBe(16);
    });
});
