/**
 * advise + explain (plan §3.2-3.4): the owner-review fixtures replay to the
 * same decision and text, the plan's worked bid examples, forced moves,
 * Quick suggestions, status lines, tutorial glosses, search errors, and
 * that the numbers a reason quotes are the trace's own.
 */

const fs = require('fs');
const { seatView } = require('../seatView');
const { advise } = require('../advise');
const { explain, status } = require('../explain');
const C = require('../copy');
const { tableAt } = require('../sim/table');
const { playStateGame } = require('../sim/stateGame');
const { markdown, answer, load, JSON_FILE, MD_FILE } = require('../sim/buildFixtures');
const { SEARCH } = require('../../bot/playSearch');

const FIXTURES = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));

describe('owner-review fixtures (__fixtures__/ownerReview.json)', () => {
    test('there are about 40 or more, covering bids, rule plays, searched plays and forced moves', () => {
        expect(FIXTURES.length).toBeGreaterThanOrEqual(40);
        const codes = new Set(FIXTURES.flatMap((f) => (f.expect.explanation ? f.expect.explanation.codes : [])));
        for (const c of ['B.ev', 'B.evFirst', 'B.sweep', 'B.lock', 'L.cashBoss', 'F.cantWin', 'D.voidShortest', 'S.overrides', 'S.close', 'P.forced', 'P.quick']) {
            expect(codes.has(c)).toBe(true);
        }
    });

    test.each(FIXTURES.map((f) => [f.name, f]))('%s replays to the same decision and text', (name, f) => {
        const view = load(f.view);
        expect(answer(view, { budget: f.budget, mode: f.mode, kind: f.kind === 'status' ? 'status' : undefined })).toEqual(f.expect);
    });

    test('ownerReview.md is the fixtures\' text (node server/game/assist/sim/buildFixtures.js rewrites both)', () => {
        expect(fs.readFileSync(MD_FILE, 'utf8')).toBe(markdown(FIXTURES));
    });
});

describe('the plan\'s worked bid examples (§3.4)', () => {
    test('8 cards, Alice bids last after Carol 1, Bob 2, Dan 0: Bid 4', () => {
        const v = seatView(tableAt({ handSize: 8, trump: '5h', hands: { 1: ['HI', 'Ah', '9h', '4h', 'Ac', 'Kc', '7d', '3s'] }, bids: [null, '1', '2', '0'], turn: 1 }), 1);
        const d = advise(v);
        const e = explain(d, v);
        expect(d.bid).toBe('4');
        expect(e.headline).toBe('Bid 4');
        expect(e.confidence).toBe('clear');
        expect(e.reasons[0]).toMatch(/^Your hand should win about 5 tricks: HI joker \(about \d\.\d\), A♥ \(about \d\.\d\)/);
        expect(e.reasons[1]).toBe('Bob (your partner) bid 2. Bid 4 makes your combined 6 almost always (about 95%), worth about +58; bid 3 is worth about +52.');
    });

    test('3 cards, Alice bids first: Bid 1', () => {
        const v = seatView(tableAt({ handSize: 3, trump: '5h', hands: { 1: ['LO', 'Kh', '8s'] }, turn: 1 }), 1);
        const e = explain(advise(v), v);
        expect(e.headline).toBe('Bid 1');
        expect(e.reasons[0]).toBe('Your hand should win about 1.9 tricks: LO joker (about 1.1), K♥ (about 0.9).');
        expect(e.reasons[1]).toMatch(/^Bob \(your partner\) bids after you and adds their own tricks\. Bid 1 is worth about \+1[78] on average/);
    });
});

describe('decisions', () => {
    test('null when the seat has nothing to decide', () => {
        const g = tableAt({ handSize: 3, trump: '5h', hands: { 1: ['LO', 'Kh', '8s'], 2: ['2c', '3c', '4c'] }, turn: 1 });
        expect(advise(seatView(g, 2))).toBeNull();
        expect(advise(null)).toBeNull();
        expect(status(seatView(g, 2))).toBe('Not your turn yet (Alice is bidding).');
    });

    test('a forced move: one line, "Only legal card", P.forced', () => {
        const g = tableAt({
            handSize: 3, trump: '2s', stage: 'play', hands: { 3: ['Kh', '9d', '4c'] },
            bids: ['1', '1', '0', '0'], turn: 3, open: { lead: 2, cards: ['5h'] }
        });
        const v = seatView(g, 3);
        const d = advise(v);
        expect(d.forced).toBe(true);
        const e = explain(d, v);
        expect(e).toMatchObject({ headline: 'Play K♥', reasons: ['Your only legal card: you must follow hearts.'], details: [], confidence: 'only', codes: ['P.forced'] });
        expect(C.render(e, { style: 'line', counted: false })).toBe('Suggested (only you see this): Play K♥. Your only legal card: you must follow hearts. (Not counted.)');
    });

    test('a HI joker lead forcing the highest trump', () => {
        const g = tableAt({
            handSize: 3, trump: '2s', stage: 'play', hands: { 3: ['Ks', '4s', '9d'] },
            bids: ['1', '1', '0', '0'], turn: 3, open: { lead: 2, cards: ['HI'] }, trumpBroken: true
        });
        const v = seatView(g, 3);
        const e = explain(advise(v), v);
        expect(e.reasons).toEqual(['Carol led the HI joker, so you must play your highest trump.']);
    });

    test('budget "rules": Quick suggestion only where the search would have run', () => {
        let quick = 0, plain = 0;
        playStateGame({
            seed: 3, hands: 6,
            onTurn(game, pos) {
                const v = seatView(game, pos);
                const d = advise(v, { budget: 'rules' });
                if (d.kind !== 'card') return;
                expect(d.trace.search).toBeUndefined();
                const e = explain(d, v);
                if (d.source === 'quick') {
                    quick++;
                    expect(e.confidence).toBe('quick');
                    expect(e.codes).toContain('P.quick');
                    expect(d.card).toEqual(d.trace.ruleCard);
                } else {
                    plain++;
                    expect(v.hand.length > SEARCH.maxCards || v.legal.length < 2).toBe(true);
                }
            }
        });
        expect(quick).toBeGreaterThan(50);
        expect(plain).toBeGreaterThan(50);
    });

    test('tutorial mode adds glosses, minus those already shown', () => {
        const v = seatView(tableAt({ handSize: 3, trump: '5h', hands: { 1: ['LO', 'Kh', '8s'] }, turn: 1 }), 1);
        const d = advise(v);
        const t = explain(d, v, { mode: 'tutorial' });
        expect(t.gloss.map((g) => g.term)).toEqual(['trick', 'joker']);
        expect(explain(d, v, { mode: 'tutorial', glossed: ['trick'] }).gloss.map((g) => g.term)).toEqual(['joker']);
        expect(explain(d, v).gloss).toBeUndefined();
        expect(Object.isFrozen(t)).toBe(true);
        expect(Object.keys(explain(d, v))).toEqual(['headline', 'reasons', 'details', 'confidence', 'suggest', 'codes']);
    });
});

describe('the words follow the trace (Q1)', () => {
    test('searched plays: the quoted rates are the search\'s own, over its own deal count', () => {
        let overrides = 0, details = 0;
        playStateGame({
            seed: 11, hands: 13,
            onTurn(game, pos) {
                const v = seatView(game, pos);
                const d = advise(v);
                if (d.kind !== 'card' || d.source !== 'search' || d.trace.search.onlyWinner) return;
                const e = explain(d, v);
                const s = d.trace.search;
                const text = [...e.reasons, ...e.details].join(' ');
                // "Checked over N" quotes the deals actually solved
                const m = /Checked over (\d+) likely/.exec(text);
                if (m) { details++; expect(Number(m[1])).toBe(s.samples); }
                const ruleIs = d.card.suit === d.trace.ruleCard.suit && d.card.rank === d.trace.ruleCard.rank;
                if (!ruleIs && e.codes.includes('S.overrides')) {
                    overrides++;
                    expect(e.reasons[e.reasons.length - 1]).toContain(C.cardText(d.trace.ruleCard));
                    expect(e.reasons[e.reasons.length - 1]).toContain(C.cardText(d.card));
                    // Every rate quoted is one of the two cards' make or set rates
                    const k = s.cands.findIndex((c) => c.suit === d.card.suit && c.rank === d.card.rank);
                    const rates = new Set([s.makes[k], s.makes[s.ruleIdx], s.sets[k], s.sets[s.ruleIdx]].map((x) => C.pct5(x / s.samples)));
                    for (const r of e.reasons[e.reasons.length - 1].matchAll(/(\d+)%/g)) expect(rates.has(Number(r[1]))).toBe(true);
                }
                if (ruleIs) expect(e.codes).not.toContain('S.overrides');
            }
        });
        expect(overrides).toBeGreaterThan(5);
        expect(details).toBeGreaterThan(50);
    }, 120000);

    test('bids: the EV numbers are the bid trace\'s', () => {
        let n = 0;
        playStateGame({
            seed: 12,
            onTurn(game, pos) {
                if (game.stage !== 'BIDDING') return;
                const v = seatView(game, pos);
                const d = advise(v);
                if (d.trace.bid.path !== 'ev') return;
                const e = explain(d, v);
                const evs = d.trace.bid.evs;
                const curve = e.details.find((x) => x.startsWith('On average:'));
                for (const m of curve.matchAll(/bid (\d+) about ([+−]?)(\d+)/g)) {
                    const v2 = Math.round(evs[Number(m[1])]);
                    expect(`${v2 > 0 ? '+' : v2 < 0 ? '−' : ''}${Math.abs(v2)}`).toBe(`${m[2]}${m[3]}`);
                }
                n++;
            }
        });
        expect(n).toBeGreaterThan(40);
    }, 120000);
});

describe('search errors go to onError, never to the bots\' counter', () => {
    let A, Ex, SEARCH2, warn;
    beforeEach(() => {
        jest.resetModules();
        warn = jest.fn();
        jest.isolateModules(() => {
            jest.doMock('../../../utils/logger', () => ({ gameLogger: { warn, error: jest.fn(), info: jest.fn(), debug: jest.fn() }, logger: { warn, error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
            jest.doMock('../../bot/playSearch', () => {
                const real = jest.requireActual('../../bot/playSearch');
                return { ...real, searchCard: () => { throw new TypeError('forced search failure'); } };
            });
            A = require('../advise');
            Ex = require('../explain');
            SEARCH2 = require('../../bot/playSearch').SEARCH;
        });
    });
    afterEach(() => {
        jest.dontMock('../../../utils/logger');
        jest.dontMock('../../bot/playSearch');
    });

    test('the rule card is suggested; onError gets (err, cards, handSize); SEARCH.errors and the log untouched', () => {
        const g = tableAt({ handSize: 3, trump: '2s', stage: 'play', hands: { 1: ['Kh', '4h', '9d'] }, bids: ['1', '1', '0', '0'], turn: 1 });
        const v = seatView(g, 1);
        const onError = jest.fn();
        const d = A.advise(v, { onError });
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0]).toBeInstanceOf(TypeError);
        expect(onError.mock.calls[0].slice(1)).toEqual([3, 3]);
        expect(d.card).toEqual(d.trace.ruleCard);
        expect(d.source).toBe('rules');
        expect(Ex.explain(d, v).headline).toBe(`Lead ${C.cardText(d.card)}`);
        // The default (no onError) is silent too
        A.advise(v);
        expect(SEARCH2.errors || 0).toBe(0);
        expect(warn).not.toHaveBeenCalled();
    });
});
