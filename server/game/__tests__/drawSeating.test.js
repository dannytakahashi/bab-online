/**
 * Seating a draw (rules.js): drawBeats orders the four drawn cards with no
 * tie, determineDrawPosition seats an ordinary draw, and seatPlannedTeams
 * seats a tournament table's planned teams (owner 2026-11-25: the draw
 * decides only the seats and who deals first): the team holding the highest
 * card at 1 & 3 with that card at 1, the other team at 2 & 4 with its
 * higher card at 2. On every staged draw (planDrawCards) it seats exactly as
 * determineDrawPosition does.
 */

'use strict';

const { drawBeats, determineDrawPosition, seatPlannedTeams } = require('../rules');
const { planDrawCards } = require('../tournamentPartners');
const Deck = require('../Deck');
const { mulberry32 } = require('../../testUtils/gameDriver');

const IDS = ['a', 'b', 'c', 'd'];
const SPLITS = [
    [['a', 'b'], ['c', 'd']],
    [['a', 'c'], ['b', 'd']],
    [['a', 'd'], ['b', 'c']],
];

function deckCards(rng) {
    const real = Math.random;
    Math.random = rng;
    try {
        const d = new Deck();
        d.shuffle();
        return d.cards;
    } finally {
        Math.random = real;
    }
}

/** The rule, spelled out: by beats, the high team 1 & 3, the low team 2 & 4. */
function expected(cards, teams) {
    const beats = new Map(IDS.map((id, i) => [id, drawBeats(cards[i], cards)]));
    const high = teams.find((t) => t.some((id) => beats.get(id) === 3));
    const low = teams.find((t) => t !== high);
    const hi = [...high].sort((x, y) => beats.get(y) - beats.get(x));
    const lo = [...low].sort((x, y) => beats.get(y) - beats.get(x));
    return new Map([[hi[0], 1], [hi[1], 3], [lo[0], 2], [lo[1], 4]]);
}

describe('drawBeats', () => {
    test('any four distinct cards of the 54 are a permutation of 0..3 (no ties)', () => {
        const rng = mulberry32(5);
        for (let n = 0; n < 5000; n++) {
            const four = deckCards(rng).slice(0, 4);
            expect(four.map((c) => drawBeats(c, four)).sort()).toEqual([0, 1, 2, 3]);
        }
    });

    test('rank first, then suit clubs < diamonds < hearts < spades; HI over LO over the ace', () => {
        const cards = [{ suit: 'spades', rank: 'A' }, { suit: 'joker', rank: 'LO' }, { suit: 'joker', rank: 'HI' }, { suit: 'clubs', rank: 'A' }];
        expect(cards.map((c) => drawBeats(c, cards))).toEqual([1, 2, 3, 0]);
    });
});

describe('seatPlannedTeams', () => {
    test('20k random draws, all three team splits: the rule, and seat 1 holds the highest card', () => {
        const rng = mulberry32(2026);
        for (let n = 0; n < 20000; n++) {
            const cards = deckCards(rng).slice(0, 4);
            const teams = SPLITS[n % 3];
            const seats = seatPlannedTeams(cards, IDS, teams);
            expect(seats).toEqual(expected(cards, teams));
            // partners opposite: each team holds 1 & 3 or 2 & 4
            const pos = teams.map((t) => t.map((id) => seats.get(id)).sort().join());
            expect(pos.sort()).toEqual(['1,3', '2,4']);
            const top = IDS[cards.findIndex((c) => drawBeats(c, cards) === 3)];
            expect(seats.get(top)).toBe(1);
        }
    });

    test('every joker case: one joker, both jokers, with partners and opponents', () => {
        const HI = { suit: 'joker', rank: 'HI' };
        const LO = { suit: 'joker', rank: 'LO' };
        const others = [{ suit: 'spades', rank: 'A' }, { suit: 'clubs', rank: '2' }, { suit: 'hearts', rank: '10' }];
        const hands = [
            [HI, ...others], [LO, ...others], [HI, LO, others[0], others[1]], [others[1], HI, others[2], LO],
            [LO, others[0], HI, others[2]],
        ];
        for (const cards of hands) {
            for (const teams of SPLITS) {
                const seats = seatPlannedTeams(cards, IDS, teams);
                expect(seats).toEqual(expected(cards, teams));
                const hiHolder = IDS[cards.indexOf(HI)];
                if (hiHolder) expect(seats.get(hiHolder)).toBe(1);
                else expect(seats.get(IDS[cards.indexOf(LO)])).toBe(1);
            }
        }
    });

    test('equals determineDrawPosition on every planDrawCards draw (a staged table seats as before)', () => {
        const rng = mulberry32(99);
        for (let n = 0; n < 3000; n++) {
            const deck = deckCards(rng);
            const teams = SPLITS[n % 3];
            const plan = planDrawCards(deck, teams, rng);
            // any draw order
            const order = [...IDS].sort(() => rng() - 0.5);
            const cards = order.map((id) => plan.get(id));
            const seats = seatPlannedTeams(cards, order, teams);
            expect(order.map((id) => seats.get(id))).toEqual(cards.map((c) => determineDrawPosition(c, cards)));
        }
    });

    test('equals determineDrawPosition whenever the partners hold the two highest or the two lowest cards', () => {
        const cards = [{ suit: 'spades', rank: 'K' }, { suit: 'hearts', rank: '3' }, { suit: 'clubs', rank: 'Q' }, { suit: 'diamonds', rank: '7' }];
        // K and Q (a, c) partners: the ordinary draw would pair them too
        const seats = seatPlannedTeams(cards, IDS, [['a', 'c'], ['b', 'd']]);
        expect(IDS.map((id) => seats.get(id))).toEqual(cards.map((c) => determineDrawPosition(c, cards)));
        // K and 3 partners: the ordinary draw would not; the K still deals
        const other = seatPlannedTeams(cards, IDS, [['a', 'b'], ['c', 'd']]);
        expect(IDS.map((id) => other.get(id))).toEqual([1, 3, 2, 4]);
    });

    test.each([
        ['three cards', [1, 2, 3], IDS, SPLITS[0]],
        ['five ids', [1, 2, 3, 4], [...IDS, 'e'], SPLITS[0]],
        ['one team', [1, 2, 3, 4], IDS, [['a', 'b']]],
        ['a team of three', [1, 2, 3, 4], IDS, [['a', 'b', 'c'], ['d']]],
        ['a stranger in a team', [1, 2, 3, 4], IDS, [['a', 'b'], ['c', 'x']]],
        ['a socket twice', [1, 2, 3, 4], IDS, [['a', 'b'], ['b', 'd']]],
        ['duplicate drawers', [1, 2, 3, 4], ['a', 'a', 'c', 'd'], SPLITS[0]],
        ['teams not arrays', [1, 2, 3, 4], IDS, null],
    ])('null on malformed input: %s', (_label, which, ids, teams) => {
        const all = [{ suit: 'spades', rank: 'K' }, { suit: 'hearts', rank: '3' }, { suit: 'clubs', rank: 'Q' }, { suit: 'diamonds', rank: '7' }];
        const cards = which.map((i) => all[i - 1]);
        expect(seatPlannedTeams(cards, ids, teams)).toBeNull();
    });

    test('null on a malformed or duplicate card (no permutation)', () => {
        const k = { suit: 'spades', rank: 'K' };
        expect(seatPlannedTeams([k, k, { suit: 'clubs', rank: 'Q' }, { suit: 'diamonds', rank: '7' }], IDS, SPLITS[0])).toBeNull();
        expect(seatPlannedTeams([k, { suit: 'stars', rank: '1' }, { suit: 'clubs', rank: 'Q' }, null], IDS, SPLITS[0])).toBeNull();
    });
});
