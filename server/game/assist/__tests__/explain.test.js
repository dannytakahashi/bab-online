/**
 * advise + explain (plan §3.2-3.4): the owner-review fixtures replay to the
 * same decision and text, the plan's worked bid examples, forced moves,
 * Quick suggestions, status lines, tutorial glosses, search errors, and
 * that the numbers a reason quotes are the trace's own.
 */

const fs = require('fs');
const { seatView } = require('../seatView');
const { advise } = require('../advise');
const { explain, status, trickDecided } = require('../explain');
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
        expect(e.reasons[0]).toBe('Your hand should win about 1.9 tricks: LO joker (about 1.0), K♥ (about 0.9).');
        expect(e.reasons[1]).toMatch(/^Bob \(your partner\) bids after you and adds their own tricks\. Bid 1 is worth about \+1[78] on average/);
    });
});

describe('decisions', () => {
    test('null when the seat has nothing to decide', () => {
        const g = tableAt({ handSize: 3, trump: '5h', hands: { 1: ['LO', 'Kh', '8s'], 2: ['2c', '3c', '4c'] }, turn: 1 });
        expect(advise(seatView(g, 2))).toBeNull();
        expect(advise(null)).toBeNull();
        expect(status(seatView(g, 2))).toBe('Not your turn yet: Alice is bidding.');
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
                // The curve, or (the floor over a better average) the floor line
                const curve = e.details.find((x) => x.startsWith('On average:') || x.startsWith('The averages lean'));
                for (const m of curve.replace(/ against about /, ' bid ' + d.bid + ' about ').matchAll(/bid (\d+) \(?about ([+−]?)(\d+)/g)) {
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

describe('H1 review fixes', () => {
    const card = (s) => tableCard(s);
    const tableCard = (s) => {
        const m = /^(10|[2-9JQKA])([shdc])$/.exec(s);
        return { suit: { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' }[m[2]], rank: m[1] };
    };
    // A searched lead with the search's numbers given: Alice leads, clubs trump
    const leadView = () => seatView(tableAt({
        handSize: 4, trump: '2c', stage: 'play', hands: { 1: ['Jd', '9h', '3s', '6d'] },
        bids: ['2', '1', '0', '1'], turn: 1, trumpBroken: true
    }), 1);
    const cands = ['Jd', '9h', '3s', '6d'].map(card);
    const searched = (played, ruleCard, n) => ({
        kind: 'card', bid: null, card: card(played), forced: false, source: 'search',
        trace: {
            ruleCard: card(ruleCard), contract: null, path: [{ code: 'L.fallback', card: card(ruleCard), facts: {} }],
            search: { cands, ruleIdx: 0, samples: 64, contract: { myBid: 2, oppBid: 2, myTricks: 1, oppTricks: 1, myMult: 1, oppMult: 1 }, ...n }
        }
    });

    test('a make (or set) rate is quoted only where the suggested card\'s is the higher one', () => {
        const v = leadView();
        // The rule card makes more often (90% vs 80%): the search went by points
        const inv = explain(searched('3s', 'Jd', { totals: [-15, -72, 4, -15], makes: [58, 56, 51, 58], sets: [5, 5, 5, 5] }), v);
        expect(inv.codes).toContain('S.overrides');
        expect(inv.reasons.join(' ')).not.toMatch(/bid makes|make your bid/);
        expect(inv.reasons[0]).toBe('Usually you\'d lead the J♦, but here the 3♠ comes out slightly better on average (by less than a point a hand).');
        expect(inv.confidence).toBe('close');
        // A set rate in the played card's favour is still quoted
        const set = explain(searched('3s', 'Jd', { totals: [-15, -72, 4, -15], makes: [58, 56, 51, 58], sets: [5, 6, 13, 5] }), v);
        expect(set.reasons[0]).toMatch(/the 3♠ does better: you set Carol and Dan sometimes \(about 20%\) with it, against rarely \(about 10%\)/);
        // The rule card kept: no comparison on a rate the runner-up wins
        const agree = explain(searched('Jd', 'Jd', { totals: [10, 5, -40, -40], makes: [40, 60, 10, 10], sets: [5, 5, 5, 5] }), v);
        expect(agree.codes).toContain('S.agrees');
        expect(agree.details.join(' ')).not.toMatch(/make your bid/);
        expect(agree.details).toContain('Checked over 64 likely ways the hidden cards could be split: the J♦ and the 9♥ come out within a fraction of a point of each other on average.');
    });

    test('the points margin is never clamped to 1 and the label follows the shown value', () => {
        const v = leadView();
        const same = explain(searched('Jd', 'Jd', { totals: [10, 10, -40, -40], makes: [40, 40, 10, 10], sets: [5, 5, 5, 5] }), v);
        expect(same.details.join(' ')).toMatch(/the J♦ and the 9♥ come out the same on average/);
        expect(same.details.join(' ')).not.toMatch(/1 point a hand better/);
        // 2.6 points shows as "about 3": a clear choice, as 3 is
        const three = explain(searched('3s', 'Jd', { totals: [0, -72, 166.4, -15], makes: [40, 40, 40, 40], sets: [5, 5, 5, 5] }), v);
        expect(three.reasons[0]).toMatch(/about 3 points a hand better/);
        expect(three.confidence).toBe('clear');
        const two = explain(searched('3s', 'Jd', { totals: [0, -72, 140, -15], makes: [40, 40, 40, 40], sets: [5, 5, 5, 5] }), v);
        expect(two.reasons[0]).toMatch(/about 2 points a hand better/);
        expect(two.confidence).toBe('close');
    });

    test('last to play: "Any card works" never stands for the winning cards only', () => {
        const v = seatView(tableAt({
            handSize: 3, trump: 'Js', stage: 'play', hands: { 2: ['As', '5d', 'Ks'] },
            bids: ['2', '2', '0', '1'], turn: 2, open: { lead: 3, cards: ['10c', '6c', '4s'] }, trumpBroken: true
        }), 2);
        const d = advise(v);
        expect(d.trace.search.cands.length).toBeLessThan(v.legal.length);
        const e = explain(d, v);
        expect(e.codes).toEqual(['C.max', 'F.ruffLast', 'S.anyWinner']);
        expect(e.confidence).toBe('certain');
        expect(e.details).toEqual(['Any card that wins this trick does as well in all 64 likely deals checked.']);
        // The search's own pick among tied winners (not the rule card): the cheapest, said so
        const s = d.trace.search;
        const other = explain({ ...d, card: s.cands[1], trace: { ...d.trace, ruleCard: card('5d'), search: { ...s, ruleIdx: -1 } } }, v);
        expect(other.codes).toContain('S.anyWinner');
        expect(other.confidence).toBe('certain');
        expect(other.reasons[1]).toMatch(/every card that wins this trick does as well: the [AK]♠ is the cheapest/);
    });

    test('bids: the floor, a one-card low trump, an opponent\'s bore with a winner, small-hand trump count', () => {
        // The floor over a better average: the numbers explain the floor, not argue against it
        const fv = seatView(tableAt({ handSize: 3, trump: '6c', hands: { 1: ['HI', '9s', 'LO'] }, turn: 1 }), 1);
        const f = explain(advise(fv), fv);
        expect(f.codes).toContain('B.floor');
        expect(f.details).toEqual(['The averages lean to bid 1 (about +19 against about +13), but they undercount cards that can\'t lose: never bid below your sure tricks.']);
        // No trick estimate credits one card with more than a trick
        expect(f.reasons[1]).toBe('Your hand should win about 2.2 tricks: HI joker (about 1.0), LO joker (about 1.0).');
        // One low trump: no "rarely", no "60%, just under 60%"
        const lv = seatView(tableAt({ handSize: 1, trump: '2d', hands: { 4: ['4d'] }, turn: 4 }), 4);
        const l = explain(advise(lv), lv);
        expect(l.reasons).toEqual(['Any higher trump or a joker beats your 4♦: too risky to bid.']);
        expect(l.codes).not.toContain('B.noBore');
        // An opponent bored and the hand bids 1
        const bv = seatView(tableAt({ handSize: 1, trump: '9h', hands: { 1: ['Ah'] }, bids: [null, null, null, 'B'], turn: 1 }), 1);
        const b = explain(advise(bv), bv);
        expect(b.headline).toBe('Bid 1');
        expect(b.reasons[0]).toBe('Dan bored. One trick sets the bore, and your hand should take one: bid 1.');
        // "1 trump supports"
        const sv = seatView(tableAt({ handSize: 3, trump: '6c', hands: { 1: ['Kc', 'As', 'Ad'] }, turn: 1 }), 1);
        const sd = { kind: 'bid', bid: '1', card: null, forced: false, source: 'rules', trace: { bid: { path: 'rule', rule: ['smallCap'], trumpBidCap: 1 } } };
        expect(explain(sd, sv).reasons).toEqual(['On a small hand trump decides it: 1 trump supports about 1 trick.']);
    });

    test('plays: trump led, a trump fight, save-strong-cards only when the card is not spent', () => {
        // Clubs (trump) led and no trump: "no trump", not "no clubs and no trump"
        const nv = seatView(tableAt({
            handSize: 3, trump: '2c', stage: 'play', hands: { 1: ['Kh', '9d', '4s'] },
            bids: ['1', '1', '0', '0'], turn: 1, open: { lead: 2, cards: ['5c', '8c', 'Jc'] }, trumpBroken: true
        }), 1);
        const n = explain(advise(nv), nv);
        expect(n.reasons[1]).toMatch(/^You have no trump, so you can't win this one\./);
        // Alice trumped; Carol's LO joker beats it and only the HI joker is out
        const rv = seatView(tableAt({
            handSize: 3, trump: 'Ad', stage: 'play', hands: { 2: ['6s', '10s', 'LO'] },
            bids: ['1', '0', '0', '2'], turn: 2, open: { lead: 4, cards: ['5c', '10d'] }, trumpBroken: true
        }), 2);
        const r = explain(advise(rv), rv);
        expect(r.codes).toContain('F.ruffFight');
        expect(r.reasons[1]).toBe('Alice trumped with the 10♦. Your LO joker beats it, but Bob could still hold the one higher trump not yet seen.');
        // Bid made and a trump spent: no "save strong cards"
        const fx = FIXTURES.find((x) => x.name === 'F.ruffLast').expect.explanation;
        expect(fx.codes).toContain('C.made');
        expect(fx.reasons[0]).not.toMatch(/save strong cards/);
    });

    test('status: no nested parentheses', () => {
        const g = tableAt({ handSize: 3, trump: '5h', hands: { 1: ['LO', 'Kh', '8s'] }, bids: [null], turn: 3 });
        expect(status(seatView(g, 1))).toBe('Not your turn yet: Bob (your partner) is bidding.');
    });
});

describe('a decided trick is never a close call (owner play-test 2026-11-19)', () => {
    const { card } = require('../sim/table');
    // The owner's table: trump clubs, Alice led the J♦, Carol (the partner)
    // trumped with the 2♣, Bob played the 8♦; Dan plays last with the 9♦
    // and the Q♦ (and 7 more), 9 tricks left
    const ownerView = () => seatView(tableAt({
        handSize: 12, trump: 'Jc', stage: 'play',
        hands: { 4: ['9d', 'Qd', '6s', 'Js', 'Qs', '9h', '10h', '4c', '9c'] },
        bids: ['4', '4', '1', '0'], turn: 4, trumpBroken: true,
        tricks: [{ lead: 1, cards: ['As', '2s', '3s', '4s'] }, { lead: 1, cards: ['Ah', '2h', '3h', '4h'] }, { lead: 1, cards: ['Ad', '2d', '3d', '4d'] }],
        open: { lead: 1, cards: ['Jd', '2c', '8d'] }
    }), 4);
    /** `d` with a search over the cards `cands` that agrees with the rule card (or not: `played`). */
    const withSearch = (d, cands, n, played = null) => ({
        ...d,
        card: played ? card(played) : d.card,
        source: 'search',
        trace: {
            ...d.trace,
            search: {
                cands: cands.map(card), ruleIdx: cands.findIndex((c) => card(c).suit === d.trace.ruleCard.suit && card(c).rank === d.trace.ruleCard.rank),
                samples: 64, contract: { myBid: 4, oppBid: 5, myTricks: 0, oppTricks: 3, myMult: 1, oppMult: 1 }, ...n
            }
        }
    });
    const rendered = (e) => {
        const rich = C.render(e);
        return [rich.label, rich.headline, ...rich.reasons, ...rich.details, rich.footer, C.render(e, { style: 'line', uses: 1, freeUses: 3 })].join('\n');
    };

    test('the seat view decides it: last to play, every legal card leaves the same pair winning', () => {
        expect(trickDecided(ownerView())).toBe(true);
        // Last to play, but the Q♦ wins and the 9♦ does not
        const open = seatView(tableAt({
            handSize: 3, trump: 'Jc', stage: 'play', hands: { 4: ['9d', 'Qd', '6s'] },
            bids: ['1', '1', '0', '0'], turn: 4, trumpBroken: true, open: { lead: 1, cards: ['Jd', '8d', '10d'] }
        }), 4);
        expect(trickDecided(open)).toBe(false);
        // Not last to play
        const second = seatView(tableAt({
            handSize: 3, trump: 'Jc', stage: 'play', hands: { 2: ['10d', 'Kd', '5h'] },
            bids: ['1', '1', '0', '0'], turn: 2, trumpBroken: true, open: { lead: 1, cards: ['Jd'] }
        }), 2);
        expect(trickDecided(second)).toBe(false);
    });

    test('the owner\'s position: Play 9♦, a clear choice, with or without the search', () => {
        const v = ownerView();
        const d = advise(v);
        expect(d.card).toEqual(card('9d'));
        const e = explain(d, v);
        expect(e.headline).toBe('Play 9♦');
        expect(e.codes).toContain('F.partnerWinsLow');
        expect(e.reasons).toEqual([
            'You and Carol (your partner) need 4 more of the last 9 tricks.',
            'Carol is winning with the 2♣ and nobody plays after you. Play low and keep the rest.'
        ]);
        expect(e.confidence).toBe('clear');
        expect(C.render(e).label).toBe('Clear choice');
        expect(rendered(e)).not.toMatch(/close call/i);

        // The search agreeing by a tight margin: still clear, no "Close call:"
        const s = explain(withSearch(d, ['9d', 'Qd'], { totals: [314, 310], makes: [40, 40], sets: [14, 14] }), v);
        expect(s.codes).toEqual(['C.normal', 'F.partnerWinsLow', 'S.close']);
        expect(s.confidence).toBe('clear');
        expect(C.render(s).label).toBe('Clear choice');
        expect(s.details).toEqual(['Checked over 64 likely ways the hidden cards could be split: the 9♦ and the Q♦ come out about the same later in the hand, and this trick is decided either way.']);
        expect(rendered(s)).not.toMatch(/close call/i);
        // A rate the search quotes stays, when it fits
        const r = explain(withSearch(d, ['9d', 'Qd'], { totals: [314, 310], makes: [51, 49], sets: [14, 14] }), v);
        expect(r.details).toEqual(['Checked over 64 likely ways the hidden cards could be split: the 9♦ and the Q♦ come out about the same later in the hand (your bid makes about 80% vs 75%), and this trick is decided either way.']);
        expect(r.details[0].length).toBeLessThanOrEqual(C.DETAIL_MAX);
        expect(r.confidence).toBe('clear');
    });

    test('a real search on a decided trick (Carol winning with the K♦): clear, never "Close call"', () => {
        const v = seatView(tableAt({
            handSize: 3, trump: 'Jc', stage: 'play',
            hands: { 1: ['5s', '6h'], 2: ['5h', '7s'], 3: ['3h', '8s'], 4: ['9d', 'Qd', '6s'] },
            bids: ['1', '1', '0', '0'], turn: 4, trumpBroken: true, open: { lead: 1, cards: ['8d', 'Kd', '10d'] }
        }), 4);
        expect(trickDecided(v)).toBe(true);
        const e = explain(advise(v), v);
        expect(e.headline).toBe('Play 9♦');
        expect(e.confidence).not.toBe('close');
        expect(rendered(e)).not.toMatch(/close call/i);
    });

    test('the card can still change the trick, or the search overrode the rule card: still a close call', () => {
        // Carol second to play: the K♦ or the 10♦ can still win or lose it
        const v = seatView(tableAt({
            handSize: 3, trump: 'Jc', stage: 'play', hands: { 2: ['10d', 'Kd', '5h'] },
            bids: ['1', '1', '0', '0'], turn: 2, trumpBroken: true, open: { lead: 1, cards: ['Jd'] }
        }), 2);
        const d = advise(v);
        expect(trickDecided(v)).toBe(false);
        const rc = d.trace.path[d.trace.path.length - 1].code;
        expect(rc).toBe('F.winFight');
        const legal = v.legal.map((c) => (c.rank + c.suit[0]));
        const totals = legal.map((c) => (same(card(c), d.trace.ruleCard) ? 314 : 310));
        const e = explain(withSearch(d, legal, { totals, makes: legal.map(() => 40), sets: legal.map(() => 14) }), v);
        expect(e.codes).toContain('S.close');
        expect(e.confidence).toBe('close');
        expect(C.render(e).label).toBe('Close call');
        expect(e.details.join(' ')).toMatch(/^Close call: /);

        // The owner's decided trick, the search playing the Q♦ over the rule's 9♦
        const ov = ownerView();
        const od = advise(ov);
        const o = explain(withSearch(od, ['9d', 'Qd'], { totals: [310, 314], makes: [40, 40], sets: [14, 14] }, 'Qd'), ov);
        expect(o.codes).toContain('S.close');
        expect(o.confidence).toBe('close');
        expect(o.reasons[1]).toBe('Close call: the Q♦ and the 9♦ do about equally well.');
    });

    test('the player could overtake the partner: the same pair takes the trick, so still a clear choice', () => {
        // The owner's table with Carol winning with the 10♦: the Q♦ moves the
        // trick from Carol's seat to Dan's, but tricks count per pair
        const v = seatView(tableAt({
            handSize: 12, trump: 'Jc', stage: 'play',
            hands: { 4: ['9d', 'Qd', '6s', 'Js', 'Qs', '9h', '10h', '4c', '9c'] },
            bids: ['4', '4', '1', '0'], turn: 4, trumpBroken: true,
            tricks: [{ lead: 1, cards: ['As', '2s', '3s', '4s'] }, { lead: 1, cards: ['Ah', '2h', '3h', '4h'] }, { lead: 1, cards: ['Ad', '2d', '3d', '4d'] }],
            open: { lead: 1, cards: ['5d', '10d', '8d'] }
        }), 4);
        expect(trickDecided(v)).toBe(true);
        const d = advise(v);
        expect(d.source).toBe('rules');
        const e = explain(d, v);
        expect(e.headline).toBe('Play 9♦');
        expect(e.codes).toEqual(['C.normal', 'F.partnerWinsLow']);
        expect(e.reasons[1]).toBe('Carol is winning with the 10♦ and nobody plays after you. Play low and keep the rest.');
        expect(e.confidence).toBe('clear');
        expect(C.render(e).label).toBe('Clear choice');
        expect(rendered(e)).not.toMatch(/close call/i);
        // A tight search agreeing: worded as decided, not "Close call:"
        const s = explain(withSearch(d, ['9d', 'Qd'], { totals: [314, 310], makes: [40, 40], sets: [14, 14] }), v);
        expect(s.confidence).toBe('clear');
        expect(s.details).toEqual(['Checked over 64 likely ways the hidden cards could be split: the 9♦ and the Q♦ come out about the same later in the hand, and this trick is decided either way.']);
        expect(rendered(s)).not.toMatch(/close call/i);

        // 11 cards (no search), Carol winning with the Q♥, Dan holding the K♥
        const h = seatView(tableAt({
            handSize: 13, trump: 'Jc', stage: 'play',
            hands: { 4: ['Kh', '9h', '6s', 'Js', 'Qs', '5d', '10d', '4c', '9c', '7d', '8s'] },
            bids: ['4', '4', '1', '0'], turn: 4, trumpBroken: true,
            tricks: [{ lead: 1, cards: ['As', '2s', '3s', '4s'] }],
            open: { lead: 1, cards: ['2h', 'Qh', '7h'] }
        }), 4);
        expect(trickDecided(h)).toBe(true);
        const he = explain(advise(h), h);
        expect(he.headline).toBe('Play 9♥');
        expect(he.codes).toContain('F.partnerWinsLow');
        expect(C.render(he).label).toBe('Clear choice');
        expect(rendered(he)).not.toMatch(/close call/i);

        // A real 3-card search: Dan holding the Q♦ and the 2♦ under Carol's 10♦
        const r = seatView(tableAt({
            handSize: 3, trump: 'Jc', stage: 'play',
            hands: { 1: ['5s', '6h'], 2: ['5h', '7s'], 3: ['3h', '8s'], 4: ['Qd', '2d', '6s'] },
            bids: ['1', '1', '0', '0'], turn: 4, trumpBroken: true, open: { lead: 1, cards: ['5d', '10d', '8d'] }
        }), 4);
        expect(trickDecided(r)).toBe(true);
        const re = explain(advise(r), r);
        expect(re.headline).toBe('Play 2♦');
        expect(re.confidence).not.toBe('close');
        expect(rendered(re)).not.toMatch(/close call/i);
    });

    test('a sure rule code is never turned into a close call by a tight search', () => {
        // Bob leads the HI joker (L.maxHi), the search a fraction of a point apart
        const fx = FIXTURES.find((x) => x.name === 'L.maxHi').expect.explanation;
        expect(fx.codes).toEqual(expect.arrayContaining(['L.maxHi', 'S.close']));
        expect(fx.confidence).toBe('clear');
        expect(fx.details.join(' ')).not.toMatch(/close call/i);
    });
});

function same(a, b) {
    return !!a && !!b && a.suit === b.suit && a.rank === b.rank;
}
