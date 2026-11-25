/**
 * Cut for a buck's pure engine (server/game/cutForABuck.js), on fixed
 * decks: every elimination, rank-only tie, redraw, reshuffle, the slot
 * rules, leaves, more than 54 players, save / restore at every step, the
 * round cap's forced winner, and a seeded property run.
 */

'use strict';

const { CutEngine, fullDecks, cardKey, decksFor, cutStateWire } = require('../cutForABuck');
const { mulberry32 } = require('../../testUtils/gameDriver');

const SUIT = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
/** '3h' -> 3 of hearts, 'Th' / '10h' -> 10, 'HI' / 'LO' -> jokers */
function c(code) {
    if (code === 'HI' || code === 'LO') return { suit: 'joker', rank: code };
    const suit = SUIT[code.slice(-1)];
    let rank = code.slice(0, -1);
    if (rank === 'T') rank = '10';
    return { suit, rank };
}
/** The given cards first, then the rest of one full deck (Deck order). */
function deckOf(...codes) {
    const head = codes.map(c);
    const used = new Map();
    for (const x of head) used.set(cardKey(x), (used.get(cardKey(x)) || 0) + 1);
    const rest = [];
    for (const x of fullDecks(1)) {
        const k = cardKey(x);
        if (used.get(k)) used.set(k, used.get(k) - 1);
        else rest.push(x);
    }
    return [...head, ...rest];
}
const names = (n) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
/** Everyone alive draws slots 0, 1, 2, ... in participant order. */
function drawInOrder(e) {
    e.aliveList().forEach((u, i) => {
        const d = e.draw(u, i);
        expect(d).not.toBeNull();
    });
}
/** One round: open, everyone draws slots in order, resolve. */
function playRound(e) {
    e.openRound();
    drawInOrder(e);
    const res = e.resolve();
    e.assertValid();
    return res;
}
const identity = (cards) => cards.map((x) => ({ ...x }));

describe('eliminations and ties (rank only)', () => {
    test('one lowest card is out', () => {
        const e = new CutEngine(names(3), { deck: deckOf('9h', '3s', 'Kd') });
        const r = playRound(e);
        expect(r).toMatchObject({ round: 1, eliminated: ['p2'], redraw: false, alive: ['p1', 'p3'], winner: null });
        expect(r.draws).toEqual([
            { username: 'p1', slot: 0, card: c('9h') },
            { username: 'p2', slot: 1, card: c('3s') },
            { username: 'p3', slot: 2, card: c('Kd') },
        ]);
        expect(e.out.get('p2')).toEqual({ round: 1 });
    });

    test('the same rank in different suits: both out', () => {
        const e = new CutEngine(names(3), { deck: deckOf('9h', '3s', '3d') });
        const r = playRound(e);
        expect(r.eliminated).toEqual(['p2', 'p3']);
        expect(r.winner).toBe('p1');
    });

    test('a suit never breaks a tie (spades over clubs is still a tie)', () => {
        const e = new CutEngine(names(4), { deck: deckOf('5s', '5c', 'Ah', 'Qd') });
        const r = playRound(e);
        expect(r.eliminated).toEqual(['p1', 'p2']);
        expect(r.redraw).toBe(false);
    });

    test('a three-way lowest tie: all three out', () => {
        const e = new CutEngine(names(5), { deck: deckOf('4s', 'Jh', '4d', '4c', '8h') });
        const r = playRound(e);
        expect(r.eliminated).toEqual(['p1', 'p3', 'p4']);
        expect(r.alive).toEqual(['p2', 'p5']);
    });

    test('everyone tied: a redraw, nobody out, and the deck still shrinks', () => {
        const e = new CutEngine(names(3), { deck: deckOf('7s', '7h', '7d', '2c', 'Kc', 'Kd') });
        const before = e.deckCount;
        const r = playRound(e);
        expect(r).toMatchObject({ redraw: true, eliminated: [], alive: ['p1', 'p2', 'p3'], winner: null });
        expect(e.deckCount).toBe(before - 3);
        expect(e.table.get('p1')).toEqual([c('7s')]);
        // the next round draws from what is left
        const r2 = playRound(e);
        expect(r2.draws.map((d) => d.card)).toEqual([c('2c'), c('Kc'), c('Kd')]);
        expect(r2.eliminated).toEqual(['p1']);
    });

    test('two players tied: a redraw', () => {
        const e = new CutEngine(names(2), { deck: deckOf('Qs', 'Qh', '2s', '3s') });
        expect(playRound(e)).toMatchObject({ redraw: true, eliminated: [] });
        expect(playRound(e)).toMatchObject({ redraw: false, eliminated: ['p1'], winner: 'p2' });
    });

    test('LO is below HI, and both are above an ace', () => {
        const e = new CutEngine(names(3), { deck: deckOf('HI', 'LO', 'As') });
        expect(playRound(e).eliminated).toEqual(['p3']);
        expect(playRound(e)).toBeDefined();
        const f = new CutEngine(names(2), { deck: deckOf('HI', 'LO') });
        expect(playRound(f)).toMatchObject({ eliminated: ['p2'], winner: 'p1' });
    });

    test('it runs to a single winner', () => {
        const e = new CutEngine(names(4), { deck: deckOf('2s', '9h', '9d', 'Ks', '3h', '4h', 'Ah') });
        expect(playRound(e).eliminated).toEqual(['p1']);
        expect(playRound(e).eliminated).toEqual(['p2']);
        const last = playRound(e);
        expect(last).toMatchObject({ eliminated: ['p3'], winner: 'p4', alive: ['p4'] });
        expect(e.winner).toBe('p4');
        expect(() => e.openRound()).toThrow();
    });
});

describe('reshuffles', () => {
    test('exactly when fewer cards are left than players still in; none when they are equal', () => {
        // 3 players, 4 rounds of three ties use 12 cards... use a 2-player
        // all-tie deck: 26 redraws leave the 2 jokers, which is not < 2
        const pairs = [];
        for (const r of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']) pairs.push(`${r}s`, `${r}h`, `${r}d`, `${r}c`);
        const shuffles = [];
        const e = new CutEngine(names(2), { deck: deckOf(...pairs), shuffle: (cards) => { shuffles.push(cards.length); return identity(cards); } });
        for (let i = 0; i < 26; i++) {
            const open = e.openRound();
            expect(open.reshuffled).toBe(false);
            drawInOrder(e);
            expect(e.resolve().redraw).toBe(true);
        }
        expect(e.deckCount).toBe(2);
        // deck === alive: no reshuffle
        const open = e.openRound();
        expect(open).toMatchObject({ reshuffled: false, deckCount: 2 });
        e.cancelRound();
        expect(shuffles).toEqual([]);
        // one card fewer than the players still in: reshuffle the full deck, table cleared
        const f = new CutEngine(names(3), { deck: deckOf('7s', '7h', '7d'), shuffle: (cards) => { shuffles.push(cards.length); return identity(cards); } });
        f.deck = f.deck.slice(0, 5); // test setup: 5 cards left, 49 on the table
        f.table.set('p1', fullDecks(1).filter((x) => !f.deck.some((y) => cardKey(y) === cardKey(x))));
        f.assertValid();
        expect(playRound(f).redraw).toBe(true); // 7s 7h 7d
        expect(f.deckCount).toBe(2);
        const o2 = f.openRound();
        expect(o2).toMatchObject({ reshuffled: true, deckCount: 54, round: 2 });
        expect(shuffles).toEqual([54]);
        expect(f.table.size).toBe(0);
        expect(f.reshuffles).toBe(1);
        f.assertValid();
    });

    test('two reshuffles with 20 players (seeded): every card unique between reshuffles', () => {
        const realRandom = Math.random;
        Math.random = mulberry32(20);
        try {
            const e = new CutEngine(names(20));
            let reshuffles = 0;
            let seen = new Set();
            let guard = 0;
            // tie the round every time to stay at 20 players: draw the lowest
            // three times until two reshuffles happened (force redraws by
            // playing with the engine's rule: only count reshuffles)
            while (reshuffles < 2 && guard++ < 50) {
                const open = e.openRound();
                if (open.reshuffled) {
                    reshuffles++;
                    seen = new Set();
                }
                e.aliveList().forEach((u) => e.draw(u, null));
                for (const card of e.pendingCards()) {
                    // single deck: a card key is seen at most once between reshuffles
                    expect(seen.has(cardKey(card))).toBe(false);
                    seen.add(cardKey(card));
                }
                const res = e.resolve();
                e.assertValid();
                if (res.winner) break;
                // put eliminated players back for this test: we only look at reshuffles
                for (const u of res.eliminated) {
                    e.out.delete(u);
                    e.alive.add(u);
                }
            }
            expect(reshuffles).toBe(2);
            expect(e.reshuffles).toBe(2);
        } finally {
            Math.random = realRandom;
        }
    });
});

describe('slots', () => {
    test('a taken slot goes to the nearest free one, i + d before i - d', () => {
        const e = new CutEngine(names(5), { deck: deckOf('2s', '3s', '4s', '5s', '6s') });
        e.openRound();
        expect(e.draw('p1', 10).slot).toBe(10);
        expect(e.draw('p2', 10).slot).toBe(11);
        expect(e.draw('p3', 10).slot).toBe(9);
        expect(e.draw('p4', 10).slot).toBe(12);
        // the last slot taken: the nearest below
        const last = e.deckCount - 1;
        expect(e.draw('p5', 11).slot).toBe(13);
        e.assertValid();
        expect(e.allDrawn()).toBe(true);
        const f = new CutEngine(names(2), { deck: deckOf('2s') });
        f.openRound();
        expect(f.draw('p1', last).slot).toBe(last);
        expect(f.draw('p2', last).slot).toBe(last - 1);
    });

    test('a null or out-of-range slot draws a random free one (the given randomInt)', () => {
        const picks = [];
        const e = new CutEngine(names(3), { randomInt: (n) => { picks.push(n); return n - 1; } });
        e.openRound();
        expect(e.draw('p1', null).slot).toBe(53);
        expect(e.draw('p2', 999).slot).toBe(52);
        expect(e.draw('p3', -1).slot).toBe(51);
        expect(picks).toEqual([54, 53, 52]);
    });

    test('seeded: the same seed draws the same random slots', () => {
        const run = (seed) => {
            const realRandom = Math.random;
            Math.random = mulberry32(seed);
            try {
                const e = new CutEngine(names(4));
                e.openRound();
                return e.aliveList().map((u) => e.draw(u, null).slot);
            } finally {
                Math.random = realRandom;
            }
        };
        expect(run(7)).toEqual(run(7));
        expect(new Set(run(7)).size).toBe(4);
    });

    test('no draw for a player not alive, a repeat, or with no round open', () => {
        const e = new CutEngine(names(3), { deck: deckOf('2s', '9h', '9d') });
        expect(e.draw('p1', 0)).toBeNull(); // no round
        e.openRound();
        expect(e.draw('nobody', 0)).toBeNull();
        expect(e.draw('p1', 0)).toMatchObject({ username: 'p1', slot: 0, allDrawn: false });
        expect(e.draw('p1', 1)).toBeNull(); // repeat
        e.draw('p2', 1);
        expect(e.draw('p3', 2).allDrawn).toBe(true);
        e.resolve();
        e.openRound();
        expect(e.draw('p1', 0)).toBeNull(); // eliminated
        expect(() => new CutEngine(['a'])).toThrow();
        expect(() => new CutEngine(['a', 'a'])).toThrow();
    });
});

describe('leaves', () => {
    test('undraw puts the card back; remove takes the player out as left', () => {
        const e = new CutEngine(names(3), { deck: deckOf('2s', '9h', '9d') });
        e.openRound();
        e.draw('p1', 0);
        expect(e.undraw('p1')).toBe(0);
        expect(e.undraw('p1')).toBeNull();
        e.draw('p2', 0);
        expect(e.pending.get('p2').slot).toBe(0);
        expect(e.remove('p2')).toBe(true);
        expect(e.remove('p2')).toBe(false);
        expect(e.out.get('p2')).toEqual({ round: 1, left: true });
        expect(e.alive.has('p2')).toBe(false);
        e.assertValid();
        e.draw('p1', 0);
        e.draw('p3', 1);
        const r = e.resolve();
        expect(r.draws.map((d) => d.username)).toEqual(['p1', 'p3']);
        expect(r.eliminated).toEqual(['p1']); // 2s
    });

    test('a leave that leaves one player alive: the winner', () => {
        const e = new CutEngine(names(2), { deck: deckOf('2s', '9h') });
        e.openRound();
        e.draw('p2', 1);
        e.remove('p1');
        expect(e.winner).toBe('p2');
        e.cancelRound();
        e.assertValid();
        expect(e.open).toBe(false);
    });
});

describe('more than 54 players', () => {
    test('two decks for 55 to 108, three from 109', () => {
        expect([1, 2, 54, 55, 108, 109].map(decksFor)).toEqual([1, 1, 1, 2, 2, 3]);
        const e = new CutEngine(names(60));
        expect(e.decks).toBe(2);
        expect(e.deckCount).toBe(108);
        e.assertValid();
        const r = e.openRound();
        expect(r.deckCount).toBe(108);
        e.aliveList().forEach((u) => e.draw(u, null));
        e.resolve();
        e.assertValid();
        expect(e.deckCount).toBe(48);
    });
});

describe('save and restore', () => {
    test('toSaved / fromSaved at every step: the same players, cards and round; an open round is redrawn', () => {
        const realRandom = Math.random;
        Math.random = mulberry32(3);
        try {
            const e = new CutEngine(names(6));
            const check = () => {
                const saved = JSON.parse(JSON.stringify(e.toSaved()));
                const r = CutEngine.fromSaved(saved);
                r.assertValid();
                expect(r.aliveList()).toEqual(e.aliveList());
                expect([...r.out.entries()]).toEqual([...e.out.entries()]);
                expect([...r.table.entries()]).toEqual([...e.table.entries()]);
                expect(r.reshuffles).toBe(e.reshuffles);
                expect(r.pending.size).toBe(0);
                expect(r.open).toBe(false);
                // the same remaining cards (the open round's back in), another order allowed
                const sorted = (cards) => cards.map(cardKey).sort();
                expect(sorted(r.deck)).toEqual(sorted(e.open ? e.openDeck : e.deck));
                // an open round reopens as the same round number
                expect(r.round).toBe(e.open ? e.round - 1 : e.round);
                if (r.alive.size >= 2) expect(r.openRound().round).toBe(e.open ? e.round : e.round + 1);
            };
            check();
            while (!e.winner) {
                e.openRound();
                check();
                const alive = e.aliveList();
                e.draw(alive[0], null);
                check();
                alive.slice(1).forEach((u) => e.draw(u, null));
                check();
                e.resolve();
                check();
            }
            // and no pending card is ever saved
            expect(JSON.stringify(e.toSaved())).not.toContain('pending');
        } finally {
            Math.random = realRandom;
        }
    });
});

describe('the round cap', () => {
    test('forceWinner: one player still in wins (uniformly picked), the rest are out this round', () => {
        const e = new CutEngine(names(4), { randomInt: (n) => 2 % n });
        e.openRound();
        e.draw('p1', 0);
        expect(e.forceWinner()).toBe('p3');
        expect(e.winner).toBe('p3');
        expect(e.open).toBe(false);
        expect(e.out.get('p1')).toEqual({ round: 1 });
        e.assertValid();
    });
});

describe('the wire view', () => {
    test('cutStateWire never carries a pending card', () => {
        const e = new CutEngine(names(3), { deck: deckOf('2s', '9h', '9d', 'Kh', 'Qh', 'Jh') });
        playRound(e);
        e.openRound();
        e.draw('p2', 0);
        const wire = cutStateWire({ stage: 'drawing', engine: e, candidates: names(3), lastReveal: null, result: null, endsAt: Date.now() + 5000 });
        expect(wire).toMatchObject({ stage: 'drawing', round: 2, alive: ['p2', 'p3'], drawn: [{ username: 'p2', slot: 0 }], deckCount: 51 });
        expect(wire.out).toEqual([{ username: 'p1', round: 1 }]);
        expect(JSON.stringify(wire)).not.toContain('"rank":"K"'); // Kh is p2's pending card
        expect(wire.inMs).toBeGreaterThan(4000);
    });
});

describe('property run: 2000 seeds, 2 to 24 players', () => {
    test('it always ends with exactly one winner; invariants after every call; no card twice between reshuffles; the out never draw', () => {
        const realRandom = Math.random;
        try {
            for (let seed = 1; seed <= 2000; seed++) {
                Math.random = mulberry32(seed);
                const n = 2 + (seed % 23);
                const e = new CutEngine(names(n));
                e.assertValid();
                let seen = new Set();
                let rounds = 0;
                while (!e.winner) {
                    rounds++;
                    if (rounds > 500) throw new Error(`seed ${seed}: no end`);
                    const open = e.openRound();
                    if (open.reshuffled) seen = new Set();
                    e.assertValid();
                    for (const u of e.participants) {
                        const d = e.draw(u, Math.random() < 0.5 ? null : Math.floor(Math.random() * 60));
                        if (!e.alive.has(u)) expect(d).toBeNull();
                    }
                    e.assertValid();
                    for (const card of e.pendingCards()) {
                        expect(seen.has(cardKey(card))).toBe(false);
                        seen.add(cardKey(card));
                    }
                    const res = e.resolve();
                    e.assertValid();
                    for (const u of res.eliminated) expect(e.out.get(u)).toEqual({ round: res.round });
                }
                expect(e.alive.size).toBe(1);
                expect(e.out.size).toBe(n - 1);
            }
        } finally {
            Math.random = realRandom;
        }
    }, 120000);
});
