/**
 * Fairness and determinism of the /help engine (plan §3.5):
 *  - Proxy game: seatView reads only the whitelisted fields, and of `hands`
 *    only its own seat's
 *  - hidden-hand shuffle: over 500 positions (bids, rule plays, searched
 *    plays), dealing the other three seats' unplayed cards differently (same
 *    counts, same history, shown voids kept) changes no byte of the decision,
 *    its trace or its explanation
 *  - no RNG: 1,000 advise + explain calls with Math.random, Date and uuid
 *    throwing; SEARCH unchanged
 *  - solver interleave: /help between bot searches changes no bot result
 */

jest.mock('uuid', () => {
    const real = jest.requireActual('uuid');
    const state = { forbid: false };
    return {
        ...real,
        __state: state,
        v4: (...a) => {
            if (state.forbid) throw new Error('uuid called');
            return real.v4(...a);
        }
    };
});

const { seatView } = require('../seatView');
const { advise } = require('../advise');
const { explain, status } = require('../explain');
const copy = require('../copy');
const { playStateGame, mulberry32 } = require('../sim/stateGame');
const Strategy = require('../../bot/BotStrategy');
const { SEARCH } = require('../../bot/playSearch');
const { buildPlayContext } = require('../../bot/BotController');

const key = (c) => `${c.suit}:${c.rank}`;
const effSuit = (c, trump) => (c.suit === 'joker' ? (trump.suit === 'joker' ? 'joker' : trump.suit) : c.suit);

/** advise + explain as one comparable string. */
function answer(view, budget = 'full') {
    const d = advise(view, { budget });
    if (!d) return 'null';
    return JSON.stringify({ d, e: explain(d, view), t: explain(d, view, { mode: 'tutorial' }) });
}

// ------------------------------------------------------------ Proxy

describe('Proxy game: seatView reads only what the seat may know', () => {
    const ALLOWED = new Set([
        // seat records and names
        'seat', 'seats', 'getPlayerByPosition', 'positions', 'players',
        // the own hand (hands itself is guarded below)
        'getHand', 'hands',
        // stage and turn (turnKey reads the bid count and card index)
        'stage', '_stage', 'turnKey', 'dealSeq', 'currentTurn', 'getBidCount', 'cardIndex',
        // the deal, bids, score, table, contract and the hand's public record
        'trump', 'isTrumpBroken', 'currentHand', 'playerBids', 'bids', 'score',
        'playedCards', 'playedCardsIndex', 'leadCard', 'leadPosition',
        'tricks', 'team1Mult', 'team2Mult', 'trickHistory'
    ]);

    function guarded(game, pos) {
        const own = game.seat(pos).seatSocketId;
        const reads = new Set();
        const hands = new Proxy(game.hands, {
            get(t, k) {
                if (k !== own) throw new Error(`read another seat's hand (${String(k)})`);
                return t[k];
            },
            ownKeys() { throw new Error('listed the hands'); }
        });
        const proxy = new Proxy(game, {
            get(t, k, r) {
                if (typeof k === 'symbol') return Reflect.get(t, k, r);
                if (!ALLOWED.has(k)) throw new Error(`seatView read game.${k}`);
                reads.add(k);
                if (k === 'hands') return hands;
                return Reflect.get(t, k, r);
            },
            set() { throw new Error('seatView wrote to the game'); },
            ownKeys() { throw new Error('seatView listed the game'); }
        });
        return { proxy, reads };
    }

    test('every turn of a seeded game, every seat', () => {
        let n = 0;
        const reads = new Set();
        playStateGame({
            seed: 404, hands: 6,
            onTurn(game, pos) {
                for (let p = 1; p <= 4; p++) {
                    const g = guarded(game, p);
                    const v = seatView(g.proxy, p);
                    expect(JSON.stringify(v)).toBe(JSON.stringify(seatView(game, p)));
                    for (const r of g.reads) reads.add(r);
                    n++;
                }
                expect(pos).toBeGreaterThan(0);
            }
        });
        expect(n).toBeGreaterThan(500);
        // The whitelist is what it reads (no stale entries)
        expect([...ALLOWED].filter((k) => !reads.has(k))).toEqual([]);
    });

    test('the guard bites', () => {
        let done = false;
        playStateGame({
            seed: 405, hands: 1,
            onTurn(game) {
                if (done) return;
                done = true;
                const { proxy } = guarded(game, 1);
                const other = game.seat(2).seatSocketId;
                expect(() => proxy.hands[other]).toThrow(/another seat/);
                expect(() => proxy.deck).toThrow(/game\.deck/);
                expect(() => proxy.getClientState).toThrow();
            }
        });
        expect(done).toBe(true);
    });
});

// ------------------------------------------------------------ hidden hands

/**
 * Deal the three other seats' unplayed cards again: same counts, no card of a
 * suit a seat has shown it is out of (it failed to follow), using a local RNG
 * (the game's own stream is left alone). Returns the restore function.
 */
function reshuffleOthers(game, pos, rng) {
    const trump = game.trump;
    const others = [1, 2, 3, 4].filter((p) => p !== pos);
    const sids = Object.fromEntries(others.map((p) => [p, game.seat(p).seatSocketId]));
    const saved = Object.fromEntries(others.map((p) => [p, game.getHand(sids[p])]));
    // Shown voids, from the won tricks and the open trick
    const voids = { 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set() };
    const tricks = game.trickHistory.slice();
    if (game.playedCardsIndex) {
        const cards = [];
        for (let k = 0; k < 4; k++) {
            const c = game.playedCards[(game.leadPosition - 1 + k) % 4];
            if (!c) break;
            cards.push(c);
        }
        tricks.push({ lead: game.leadPosition, cards });
    }
    for (const t of tricks) {
        const ls = effSuit(t.cards[0], trump);
        t.cards.forEach((c, k) => {
            if (effSuit(c, trump) !== ls) voids[((t.lead - 1 + k) % 4) + 1].add(ls);
        });
    }
    const pool = others.flatMap((p) => saved[p]);
    for (let attempt = 0; attempt < 200; attempt++) {
        const order = pool.slice();
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        const room = Object.fromEntries(others.map((p) => [p, saved[p].length]));
        const out = Object.fromEntries(others.map((p) => [p, []]));
        let ok = true;
        for (const c of order) {
            const can = others.filter((p) => room[p] > 0 && !voids[p].has(effSuit(c, trump)));
            if (!can.length) { ok = false; break; }
            const p = can[Math.floor(rng() * can.length)];
            out[p].push(c);
            room[p]--;
        }
        if (!ok) continue;
        for (const p of others) game.setHand(sids[p], out[p]);
        return {
            changed: others.some((p) => out[p].map(key).sort().join() !== saved[p].map(key).sort().join()),
            restore: () => { for (const p of others) game.hands[sids[p]] = saved[p]; }
        };
    }
    return null;
}

describe('hidden-hand shuffle', () => {
    test('500 positions: another deal of the hidden cards changes no byte', () => {
        const rng = mulberry32(99);
        const kinds = { bid: 0, rule: 0, search: 0, quick: 0 };
        let positions = 0, changed = 0;
        for (let seed = 300; positions < 500 && seed < 340; seed++) {
            let turn = 0;
            playStateGame({
                seed,
                onTurn(game, pos) {
                    if (positions >= 500 || turn++ % 3 !== 0) return;
                    const view = seatView(game, pos);
                    const before = answer(view);
                    const quick = answer(view, 'rules');
                    const sh = reshuffleOthers(game, pos, rng);
                    if (!sh) return;
                    try {
                        const view2 = seatView(game, pos);
                        expect(JSON.stringify(view2)).toBe(JSON.stringify(view));
                        expect(answer(view2)).toBe(before);
                        expect(answer(view2, 'rules')).toBe(quick);
                    } finally {
                        sh.restore();
                    }
                    if (sh.changed) changed++;
                    positions++;
                    const d = advise(view);
                    kinds[d.kind === 'bid' ? 'bid' : d.source === 'search' ? 'search' : 'rule']++;
                }
            });
        }
        expect(positions).toBe(500);
        expect(changed).toBeGreaterThan(400);
        expect(kinds.bid).toBeGreaterThan(30);
        expect(kinds.rule).toBeGreaterThan(100);
        expect(kinds.search).toBeGreaterThan(100);
    }, 300000);
});

// ------------------------------------------------------------ no RNG

describe('no RNG, no clock, no uuid', () => {
    test('1,000 advise + explain calls with Math.random, Date and uuid throwing; SEARCH untouched', () => {
        const views = [];
        for (let seed = 500; views.length < 1000; seed++) {
            let turn = 0;
            playStateGame({ seed, onTurn(game, pos) { if (views.length < 1000 && turn++ % 2 === 0) views.push(seatView(game, pos)); } });
        }
        const searchBefore = JSON.stringify(SEARCH);
        const errorsBefore = SEARCH.errors || 0;
        const uuid = require('uuid');
        const realRandom = Math.random;
        const realDate = global.Date;
        const boom = (what) => () => { throw new Error(`${what} called`); };
        let calls = 0, searched = 0;
        try {
            Math.random = boom('Math.random');
            global.Date = new Proxy(realDate, { construct: boom('new Date'), apply: boom('Date()'), get: (t, k) => (k === 'now' ? boom('Date.now') : t[k]) });
            uuid.__state.forbid = true;
            for (const v of views) {
                for (const budget of ['full', 'rules']) {
                    const d = advise(v, { budget });
                    if (!d) continue;
                    if (d.source === 'search') searched++;
                    const e = explain(d, v);
                    explain(d, v, { mode: 'tutorial', glossed: ['trick'] });
                    copy.render(e, { style: 'line', uses: 2, freeUses: 3 });
                    copy.render(e);
                    calls++;
                }
                status(v);
            }
        } finally {
            Math.random = realRandom;
            global.Date = realDate;
            uuid.__state.forbid = false;
        }
        expect(calls).toBe(2000);
        expect(searched).toBeGreaterThan(150);
        expect(JSON.stringify(SEARCH)).toBe(searchBefore);
        expect(SEARCH.errors || 0).toBe(errorsBefore);
    }, 300000);
});

// ------------------------------------------------------------ interleave

describe('solver interleave', () => {
    test('bot search, /help, bot search: the bots\' cards are the same as without /help', () => {
        const spots = [];
        playStateGame({
            seed: 77,
            onTurn(game, pos, bot, kind) {
                if (kind !== 'play' || game.getHand(bot.socketId).length > SEARCH.maxCards || spots.length >= 120) return;
                const ctx = buildPlayContext(game);
                spots.push({
                    view: seatView(game, pos),
                    args: [game.getHand(bot.socketId).map((c) => ({ ...c })), game.playedCards.map((c) => c && { ...c }),
                        game.leadCard && { ...game.leadCard }, game.leadPosition, { ...game.trump }, game.isTrumpBroken, pos,
                        bot.getMemorySnapshot(), game.currentHand,
                        { ...ctx, playerBids: ctx.playerBids.slice(), bids: ctx.bids && { ...ctx.bids }, tricks: { ...ctx.tricks } }, 'mary']
                });
            }
        });
        expect(spots.length).toBeGreaterThan(60);
        const bot = (s) => JSON.stringify(Strategy.selectOptimalCard(...s.args.map((a) => (Array.isArray(a) ? a.slice() : a))));
        const plain = spots.map(bot);
        const helped = spots.map((s, i) => {
            advise(spots[(i + 7) % spots.length].view);
            const r = bot(s);
            advise(spots[(i + 13) % spots.length].view);
            return r;
        });
        expect(helped).toEqual(plain);
        // and /help itself is stable around bot searches
        const h1 = spots.map((s) => answer(s.view));
        spots.forEach(bot);
        expect(spots.map((s) => answer(s.view))).toEqual(h1);
    }, 300000);
});
