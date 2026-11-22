'use strict';
/**
 * Hand Strength Index (server/game/hsi.js; owner 2026-11-21: evaluated against
 * self-play and replaced). Golden values from the fitted reference module, and
 * the properties the index must keep: range, one decimal, order-independent,
 * pure, monotone under better cards, never throws.
 */
const { calculateHSI, expectedTricks } = require('../hsi');
const rules = require('../rules');

const SUIT = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const card = (s) => (s === 'HI' || s === 'LO' ? { suit: 'joker', rank: s } : { suit: SUIT[s.slice(-1)], rank: s.slice(0, -1) });
const hand = (s) => (s ? s.split(' ').map(card) : []);

// a seeded deal from the 54-card deck
function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const DECK = [];
for (const s of Object.values(SUIT)) for (const r of ORDER) DECK.push({ suit: s, rank: r });
DECK.push({ suit: 'joker', rank: 'LO' }, { suit: 'joker', rank: 'HI' });
function deal(rand, n) {
    const d = DECK.slice();
    for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
    }
    return { hand: d.slice(0, n), trump: d[n] };
}

describe('calculateHSI', () => {
    test('rules.js exports the same function', () => {
        expect(rules.calculateHSI).toBe(calculateHSI);
    });

    test.each([
        ["typical 8-card hand", 'KS 7S 3S AH 9H 4D QC 6C', '5S', 147.2],
        ["below-average 13-card hand", 'QS 9S 4S AH JH 6H 2H KD 8D 3D 10C 7C 5C', '6S', 110.4],
        ["above-average 13-card hand (one joker)", 'LO QS 9S 4S AH JH 6H 2H KD 8D 3D 10C 7C', '6S', 145.6],
        ["strong 13-card hand", 'HI LO AS KS 9S 5S AH KH 3H AD 7D 4D 2C', '8S', 251.1],
        ["weak 13-card hand (one low trump, no honours)", '3S 9H 7H 5H 2H 10D 8D 6D 4D 9C 7C 5C 3C', 'QS', 55],
        ["strong 5-card hand", 'HI AS QS AH 4D', '2S', 266.9],
        ["weak 13-card hand (two low trumps, one queen)", '6S 3S QH 7H 5H 2H 10D 8D 4D 9C 7C 5C 3C', 'QS', 57.1],
        ["weak 4-card hand (no trump)", '9H 6H 8D 3C', 'KS', 57.9],
        ["no-trump deal, 13 cards, 3 aces", 'AS KS 8S 4S AH QH 7H 2H AD 9D 5D JC 3C', 'HI', 168.4],
        ["no-trump deal, 13 cards, the joker and no honours", 'LO 9S 7S 4S 8H 6H 3H 2H 9D 5D 4D 7C 2C', 'HI', 89.1],
        ["no-trump deal, 1 card: the joker", 'HI', 'LO', 347.7],
        ["no-trump deal, 1 card: an ace", 'AS', 'LO', 194.7],
        ["both jokers, 2-card hand", 'HI LO', '7D', 355],
        ["both jokers, 13-card hand, nothing else", 'HI LO 9H 7H 5H 3H 8D 6D 4D 2D 9C 6C 3C', '7S', 97.8],
        ["1-card hand: side 2", '2H', '9S', 55.5],
        ["1-card hand: side ace", 'AH', '9S', 123],
        ["1-card hand: trump 2", '2S', '9S', 205.8],
        ["1-card hand: HI joker", 'HI', '9S', 355],
        ["void-heavy 13-card hand (7 trumps, two void suits)", 'AS QS 10S 8S 6S 4S 2S KH JH 9H 7H 5H 3H', '9S', 203.4],
        ["13 cards of one side suit (three voids, no trump)", '2H 3H 4H 5H 6H 7H 8H 9H 10H JH QH KH AH', '9S', 90.6],
        ["9-card hand, one void, three trumps", 'JS 8S 3S AH 10H 6H KD 7D 2D', '5S', 151.9],
        ["all-trump 5-card hand", 'KS 10S 7S 4S 2S', 'AS', 291.9],
        ["7-card hand with a side ace", 'AS LO 7C 5D 8S 8D 3S', '10C', 148.2],
        ["the same hand, side ace swapped for the trump 2 (reads lower)", '2C LO 7C 5D 8S 8D 3S', '10C', 144.4],
    ])('%s', (label, cards, turned, want) => {
        expect(calculateHSI(hand(cards), card(turned))).toBe(want);
    });

    test('a hopeless hand reads 55, every trick 355, no hand 0', () => {
        expect(calculateHSI(hand('2H'), card('9S'))).toBe(55.5);
        expect(calculateHSI(hand('HI LO'), card('7D'))).toBe(355);
        expect(calculateHSI([], card('5S'))).toBe(0);
        expect(calculateHSI(null, card('5S'))).toBe(0);
    });

    test('never throws: no usable trump is scored as a no-trump deal, an unknown rank as a low card', () => {
        const h = hand('AS KD 7C');
        const noTrump = calculateHSI(h, card('HI'));
        for (const t of [null, undefined, {}, { suit: 'toString' }, { suit: 'stars', rank: 'Z' }]) {
            expect(calculateHSI(h, t)).toBe(noTrump);
        }
        expect(calculateHSI([{ suit: 'hearts', rank: 'Z' }], card('9S'))).toBe(calculateHSI(hand('2H'), card('9S')));
    });

    test('every hand reads 55 to 355 to one decimal, the same in any card order, without touching its input', () => {
        const rand = rng(20261121);
        for (let i = 0; i < 3000; i++) {
            const n = 1 + (i % 13);
            const { hand: h, trump } = deal(rand, n);
            const frozen = Object.freeze(h.map((c) => Object.freeze({ ...c })));
            const v = calculateHSI(frozen, Object.freeze({ ...trump }));
            expect(v).toBeGreaterThanOrEqual(55);
            expect(v).toBeLessThanOrEqual(355);
            expect(Math.round(v * 10) / 10).toBe(v);
            expect(calculateHSI(h.slice().reverse(), trump)).toBe(v);
            const e = expectedTricks(h, trump);
            expect(e).toBeGreaterThanOrEqual(0);
            expect(e).toBeLessThanOrEqual(n);
        }
    });

    test('a better card never lowers it: a higher card of its suit, the same-rank trump for a side card, a joker for a trump', () => {
        const rand = rng(7);
        let checks = 0;
        for (let i = 0; i < 1500; i++) {
            const n = 1 + (i % 13);
            const { hand: h, trump } = deal(rand, n);
            const base = calculateHSI(h, trump);
            const trumpSuit = trump.suit === 'joker' ? null : trump.suit;
            const free = (c) => !h.some((x) => x.suit === c.suit && x.rank === c.rank) && !(c.suit === trump.suit && c.rank === trump.rank);
            h.forEach((c, k) => {
                const swaps = [];
                if (c.suit === 'joker') {
                    if (c.rank === 'LO') swaps.push({ suit: 'joker', rank: 'HI' });
                } else {
                    for (const r of ORDER.slice(ORDER.indexOf(c.rank) + 1)) swaps.push({ suit: c.suit, rank: r });
                    if (trumpSuit && c.suit !== trumpSuit) swaps.push({ suit: trumpSuit, rank: c.rank });
                    if (trumpSuit && c.suit === trumpSuit) swaps.push({ suit: 'joker', rank: 'LO' }, { suit: 'joker', rank: 'HI' });
                }
                for (const s of swaps.filter(free)) {
                    const h2 = h.slice();
                    h2[k] = s;
                    checks++;
                    expect(calculateHSI(h2, trump)).toBeGreaterThanOrEqual(base);
                }
            });
        }
        expect(checks).toBeGreaterThan(20000);
    });
});
