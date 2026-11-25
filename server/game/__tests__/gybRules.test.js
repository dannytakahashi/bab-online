/**
 * Get Your Bid (owner 2026-11-24; server/game/gameMode.js): the mode's own
 * rules in rules.js. Card play is the base game's, with no partners.
 */

const rules = require('../rules');
const gybStrategy = require('../bot/gybStrategy');

const c = (rank, suit) => ({ rank, suit });
const trump = c('5', 'hearts');

describe('scoring: exactly the bid, or nothing', () => {
    test.each([
        // bid, took, forbidden, points
        [1, 1, null, 11],
        [1, 2, null, 0],
        [1, 0, null, 0],
        [0, 0, null, 5],
        [0, 1, null, 0],
        [5, 5, null, 15],
        [13, 13, null, 23],
        ['4', 4, null, 14],
    ])('bid %s, took %s (forbidden %s) scores %s', (bid, took, forbidden, points) => {
        expect(rules.gybHandScore(bid, took, forbidden)).toBe(points);
    });

    test('taking exactly the Forbidden Bid is worth 1 point', () => {
        expect(rules.gybHandScore(4, 3, 3)).toBe(1);
        expect(rules.gybHandScore(1, 0, 0)).toBe(1);
        // any other miss still scores nothing
        expect(rules.gybHandScore(4, 2, 3)).toBe(0);
        // the bid itself is never the Forbidden Bid, but exact still wins
        expect(rules.gybHandScore(4, 4, 3)).toBe(14);
    });

    test('never negative', () => {
        for (let bid = 0; bid <= 13; bid++) {
            for (let took = 0; took <= 13; took++) expect(rules.gybHandScore(bid, took, 2)).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('the Forbidden Bid', () => {
    test("the owner's example: on the 12, after 5 and 4 the last bidder cannot bid 3", () => {
        // seat 3 deals and bids last
        const bids = ['5', '4', undefined];
        expect(rules.gybForbiddenBid(bids, 12)).toBe(3);
        expect(rules.isValidGybBid('3', bids, 12)).toBe(false);
        for (const ok of ['0', '1', '2', '4', '12']) expect(rules.isValidGybBid(ok, bids, 12)).toBe(true);
    });

    test('only the last bidder, whichever seat that is', () => {
        expect(rules.gybForbiddenBid([undefined, undefined, undefined], 12)).toBeNull();
        expect(rules.gybForbiddenBid(['5', undefined, undefined], 12)).toBeNull();
        expect(rules.gybForbiddenBid(['5', undefined, '4'], 12)).toBe(3);
        expect(rules.gybForbiddenBid([undefined, '6', '6'], 12)).toBe(0);
        expect(rules.gybForbiddenBid(['5', '4', '2'], 12)).toBeNull();
    });

    test('only on hands of 5 or more cards', () => {
        for (const size of [1, 2, 3, 4]) {
            expect(rules.gybForbiddenBid(['1', '0', undefined], size)).toBeNull();
            expect(rules.isValidGybBid(String(size - 1), ['1', '0', undefined], size)).toBe(true);
        }
        for (const size of [5, 6, 7, 8, 9, 10, 11, 12, 13]) {
            expect(rules.gybForbiddenBid(['1', '0', undefined], size)).toBe(size - 1);
        }
    });

    test('none when the bids already exceed the hand', () => {
        expect(rules.gybForbiddenBid(['4', '3', undefined], 6)).toBeNull();
        expect(rules.isValidGybBid('0', ['4', '3', undefined], 6)).toBe(true);
    });

    test('zero can be the Forbidden Bid; the safe bid is then 1', () => {
        expect(rules.gybForbiddenBid(['3', '2', undefined], 5)).toBe(0);
        expect(rules.isValidGybBid('0', ['3', '2', undefined], 5)).toBe(false);
        expect(rules.gybSafeBid(['3', '2', undefined], 5)).toBe('1');
        expect(rules.gybSafeBid(['3', '1', undefined], 5)).toBe('0');
        expect(rules.gybSafeBid([undefined, undefined, undefined], 5)).toBe('0');
    });

    test('no bores, nothing above the hand', () => {
        for (const b of ['B', '2B', '3B', '4B', '7', '-1', '', 'x']) expect(rules.isValidGybBid(b, [], 6)).toBe(false);
        expect(rules.isValidGybBid('6', [], 6)).toBe(true);
    });
});

describe('three seats', () => {
    test('turns go 1, 2, 3, 1', () => {
        expect([1, 2, 3].map((p) => rules.rotatePosition(p, 3))).toEqual([2, 3, 1]);
        // the base game is unchanged
        expect([1, 2, 3, 4].map((p) => rules.rotatePosition(p))).toEqual([2, 3, 4, 1]);
    });

    test('the draw seats the highest card at 1, with no partner swap', () => {
        const cards = [c('4', 'clubs'), c('K', 'spades'), c('9', 'hearts')];
        expect(cards.map((card) => rules.gybDrawPosition(card, cards))).toEqual([3, 1, 2]);
        const tie = [c('9', 'clubs'), c('9', 'spades'), c('9', 'hearts')];
        expect(tie.map((card) => rules.gybDrawPosition(card, tie))).toEqual([3, 1, 2]);
    });

    test('a trick of three: trump beats the led suit, the led suit beats a discard', () => {
        // seat 2 leads spades
        expect(rules.determineWinner([c('A', 'clubs'), c('9', 'spades'), c('K', 'spades')], 2, trump, 3)).toBe(3);
        expect(rules.determineWinner([c('2', 'hearts'), c('9', 'spades'), c('K', 'spades')], 2, trump, 3)).toBe(1);
        expect(rules.determineWinner([c('LO', 'joker'), c('9', 'spades'), c('HI', 'joker')], 2, trump, 3)).toBe(3);
    });

    test('the highest bidder leads, the first of equals in bidding order; all zeros: the first bidder', () => {
        // seat 3 bids first
        expect(rules.findHighestBidder(3, ['2', '4', '4'], 3) + 1).toBe(3);
        expect(rules.findHighestBidder(2, ['4', '1', '4'], 3) + 1).toBe(3);
        expect(rules.findHighestBidder(2, ['0', '0', '0'], 3) + 1).toBe(2);
        expect(rules.findHighestBidder(1, ['0', '0', '0'], 3) + 1).toBe(1);
    });

    test('a HI joker lead makes BOTH other seats play their highest trump', () => {
        const hand = [c('3', 'hearts'), c('Q', 'hearts'), c('2', 'clubs')];
        const lead = c('HI', 'joker');
        for (const position of [2, 3]) {
            const trick = { leadCard: lead, isLeading: false, trump, trumpBroken: true, position, leadPosition: 1, solo: true };
            expect(rules.isLegalPlay(c('Q', 'hearts'), hand, trick)).toBe(true);
            expect(rules.isLegalPlay(c('3', 'hearts'), hand, trick)).toBe(false);
        }
        // the base game: seat 3 is seat 1's partner and may play low
        const partner = { leadCard: lead, isLeading: false, trump, trumpBroken: true, position: 3, leadPosition: 1 };
        expect(rules.isLegalPlay(c('3', 'hearts'), hand, partner)).toBe(true);
    });
});

describe('the bot', () => {
    test('bids a number the hand allows and never the Forbidden Bid', () => {
        const deckOf = () => {
            const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
            const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
            return [...suits.flatMap((s) => ranks.map((r) => c(r, s))), c('HI', 'joker'), c('LO', 'joker')];
        };
        let seed = 7;
        const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        for (const size of rules.HAND_PROGRESSION) {
            for (let round = 0; round < 40; round++) {
                const deck = deckOf().sort(() => rand() - 0.5);
                const hand = deck.slice(0, size);
                const t = deck[size];
                const others = [String(Math.floor(rand() * (size + 1))), String(Math.floor(rand() * (size + 1))), undefined];
                const bid = gybStrategy.decideBid(hand, t, others, size);
                expect(rules.isValidGybBid(bid, others, size)).toBe(true);
            }
        }
    });

    test('takes a trick it needs as cheaply as it can when last to play, and ducks once it has its bid', () => {
        const hand = [c('K', 'spades'), c('Q', 'spades'), c('3', 'spades')];
        const table = {
            playedCards: [c('10', 'spades'), c('J', 'spades'), undefined],
            leadCard: c('10', 'spades'), leadPosition: 1, trump, trumpBroken: false, position: 3, seatCount: 3,
        };
        expect(gybStrategy.decideCard(hand, { ...table, need: 1 })).toEqual(c('Q', 'spades'));
        expect(gybStrategy.decideCard(hand, { ...table, need: 0 })).toEqual(c('3', 'spades'));
    });
});
