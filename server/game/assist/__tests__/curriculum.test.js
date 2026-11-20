/**
 * The tutorial's curriculum (server/game/assist/curriculum.js):
 *  - every rule tip fires with its own trigger, once per game (its bit),
 *    and not when the trigger does not hold
 *  - every number a tip states matches rules.calculateScore /
 *    calculateMultiplier / isLegalPlay / determineWinner (docs/RULES.md)
 *  - the copy rules on every tip text seeded games produce (names only,
 *    lengths, no jargon or team words)
 *  - the budget: one rule tip per own decision, one between two of them
 *  - the fade-out: advice on every non-forced decision before the end of
 *    the 2-card hand, only tricky ones after it (measured on seeded games)
 */

'use strict';

jest.setTimeout(30000);

const fs = require('fs');
const path = require('path');
const rules = require('../../rules');
const C = require('../copy');
const T = require('../curriculum');
const { seatView } = require('../seatView');
const { advise } = require('../advise');
const { explain } = require('../explain');
const { tableAt, card } = require('../sim/table');
const { measureFade } = require('../sim/tutorialFade');

const ALL = (1 << 21) - 1;
/** Every topic shown except `ids` (so only those can fire). */
const only = (...ids) => ids.reduce((t, id) => (t & ~(1 << T.TIP_BITS[id])) >>> 0, ALL);
const view = (o) => seatView(tableAt(o), 1);
const bidDecision = (bid) => ({ kind: 'bid', bid, card: null, forced: false });
const cardDecision = (c) => ({ kind: 'card', bid: null, card: card(c), forced: false });
const legalOf = (hand, trick) => hand.map(card).filter((c) => rules.isLegalPlay(c, hand.map(card), trick));

// ------------------------------------------------------------ triggers

describe('every rule tip: its trigger, once per game', () => {
    const bidView = view({ handSize: 12, trump: '5h', hands: { 1: ['Ah', 'Kc', '2d'] }, turn: 1 });

    test('T.trump: a trump suit; not in a no-trump hand', () => {
        const t = T.pickTip('decision', bidView, bidDecision('2'), only('T.trump'));
        expect(t).toMatchObject({ id: 'T.trump', title: 'Trump' });
        expect(t.text).toBe('Trump this hand is hearts ♥. Any heart beats any card of another suit, and the two jokers are the highest trumps.');
        expect(T.pickTip('between', bidView, null, only('T.trump')).id).toBe('T.trump');
        expect(T.pickTip('decision', bidView, bidDecision('2'), ALL)).toBe(null);
        expect(T.pickTip('decision', view({ handSize: 12, trump: 'LO', hands: { 1: ['Ah'] }, turn: 1 }), bidDecision('1'), only('T.trump'))).toBe(null);
    });

    test('T.noTrump: a joker flipped', () => {
        const v = view({ handSize: 12, trump: 'LO', hands: { 1: ['Ah'] }, turn: 2 });
        expect(T.pickTip('between', v, null, only('T.noTrump')).text).toBe('A joker was flipped: no trump suit this hand. Only the other joker is trump.');
        expect(T.pickTip('between', bidView, null, only('T.noTrump'))).toBe(null);
    });

    test('T.bid: the seat\'s own bid only (never between)', () => {
        expect(T.pickTip('decision', bidView, bidDecision('2'), only('T.bid')).text)
            .toBe('Bid how many tricks you expect to win. Your bid adds to the bid of Bob (your partner): together you must win at least that many.');
        expect(T.pickTip('between', bidView, null, only('T.bid'))).toBe(null);
    });

    test('T.oneCard: a bid on the 1-card hand', () => {
        const v = view({ handSize: 1, trump: '5h', hands: { 1: ['Ah'] }, turn: 1 });
        expect(T.pickTip('decision', v, bidDecision('1'), only('T.oneCard')).text).toBe('One card each: bid 1 only if your card is likely to win the trick.');
        expect(T.pickTip('decision', bidView, bidDecision('1'), only('T.oneCard'))).toBe(null);
    });

    test('T.bore: a suggested bore, or one bid at the table (who and the multiplier)', () => {
        expect(T.pickTip('decision', bidView, bidDecision('B'), only('T.bore')).text)
            .toBe('A bore (B) is a bet that you and Bob (your partner) win every trick. Double the points if made, minus double if not.');
        const carol = view({ handSize: 12, trump: '5h', hands: { 1: ['Ah'] }, bids: [null, 'B'], turn: 3 });
        expect(T.pickTip('between', carol, null, only('T.bore')).text)
            .toBe('Carol bid B, a bore: a bet that Carol and Dan win every trick. Double the points if made, minus double if not.');
        const bob = view({ handSize: 12, trump: '5h', hands: { 1: ['Ah'] }, bids: [null, 'B', '2B'], turn: 4 });
        expect(T.pickTip('between', bob, null, only('T.bore')).text)
            .toBe('Bob (your partner) bid 2B, a bore: a bet that you and Bob win every trick. Four times the points if made, minus four times if not.');
        expect(T.pickTip('decision', bidView, bidDecision('3'), only('T.bore'))).toBe(null);
    });

    test('T.zero: 0 suggested, or the partner bid 0', () => {
        const text = 'If you and Bob (your partner) both bid 0, you can\'t be set: each trick you win is worth 1 point.';
        expect(T.pickTip('decision', bidView, bidDecision('0'), only('T.zero')).text).toBe(text);
        const v = view({ handSize: 12, trump: '5h', hands: { 1: ['Ah'] }, bids: [null, '2', '0'], turn: 4 });
        expect(T.pickTip('between', v, null, only('T.zero')).text).toBe(text);
        expect(T.pickTip('decision', bidView, bidDecision('2'), only('T.zero'))).toBe(null);
    });

    const playView = (o) => view({ handSize: 3, trump: '5h', bids: ['1', '1', '0', '0'], stage: 'play', ...o });

    test('T.hiJoker: in hand, led by Carol (highest trump), led by Bob (any trump)', () => {
        const inHand = playView({ hands: { 1: ['HI', '2c', '3d'] }, turn: 1 });
        expect(T.pickTip('decision', inHand, cardDecision('2c'), only('T.hiJoker')).text)
            .toBe('You hold the HI joker, the highest card. When you lead it, Carol and Dan must each play their highest trump.');
        // Carol (2) leads the HI joker, Bob (3) and Dan (4) follow, Alice (1) last
        const byCarol = playView({ hands: { 1: ['Kh', '2h', '3d'] }, open: { lead: 2, cards: ['HI', '4h', '6h'] }, turn: 1, trumpBroken: true });
        expect(T.pickTip('decision', byCarol, cardDecision('Kh'), only('T.hiJoker')).text)
            .toBe('Carol led the HI joker: you must play your highest trump, or any card if you have none.');
        const byBob = playView({ hands: { 1: ['Kh', '2h', '3d'] }, open: { lead: 3, cards: ['HI', '7h'] }, turn: 1, trumpBroken: true });
        expect(T.pickTip('decision', byBob, cardDecision('2h'), only('T.hiJoker')).text)
            .toBe('Bob (your partner) led the HI joker: Carol and Dan must play their highest trump. You may play any trump you hold, or any card if you have none.');
        expect(T.pickTip('between', inHand, null, only('T.hiJoker'))).toBe(null);
    });

    test('T.lead: leading while trump is not broken (no-trump words in a no-trump hand)', () => {
        const v = playView({ hands: { 1: ['Ah', '2c', '3d'] }, turn: 1 });
        expect(T.pickTip('decision', v, cardDecision('2c'), only('T.lead')).text)
            .toBe('You lead this trick. Trump can\'t be led until a trump has been played (trump is then broken), unless you hold only trump.');
        const nt = playView({ trump: 'LO', hands: { 1: ['HI', '2c', '3d'] }, turn: 1 });
        expect(T.pickTip('decision', nt, cardDecision('2c'), only('T.lead')).text)
            .toBe('You lead this trick. A joker can\'t be led until a joker has been played, unless you hold only jokers.');
        expect(T.pickTip('decision', playView({ hands: { 1: ['Ah', '2c', '3d'] }, turn: 1, trumpBroken: true }), cardDecision('2c'), only('T.lead'))).toBe(null);
    });

    test('T.follow: holding the suit led, with other cards it may not play', () => {
        const v = playView({ hands: { 1: ['Kc', '2c', '3d'] }, open: { lead: 4, cards: ['9c'] }, turn: 1 });
        expect(T.pickTip('decision', v, cardDecision('2c'), only('T.follow')).text).toBe('Clubs were led: you must play a club if you have one.');
        const tr = playView({ hands: { 1: ['Kh', 'LO', '3d'] }, open: { lead: 4, cards: ['9h'] }, turn: 1, trumpBroken: true });
        expect(T.pickTip('decision', tr, cardDecision('Kh'), only('T.follow')).text).toBe('Trump was led: you must play a trump if you have one (the jokers are trump too).');
        const all = playView({ hands: { 1: ['Kc', '2c', '3c'] }, open: { lead: 4, cards: ['9c'] }, turn: 1 });
        expect(T.pickTip('decision', all, cardDecision('2c'), only('T.follow'))).toBe(null);
    });

    test('T.void: none of the suit led (with and without a trump); never for a trump lead', () => {
        const v = playView({ hands: { 1: ['Kh', '2d', '3d'] }, open: { lead: 4, cards: ['9c'] }, turn: 1 });
        expect(T.pickTip('decision', v, cardDecision('2d'), only('T.void')).text)
            .toBe('You have no clubs, so you may play any card. A trump beats every club; any other card can\'t win this trick.');
        const none = playView({ hands: { 1: ['Ks', '2d', '3d'] }, open: { lead: 4, cards: ['9c'] }, turn: 1 });
        expect(T.pickTip('decision', none, cardDecision('2d'), only('T.void')).text)
            .toBe('You have no clubs, so you may play any card, but none of yours can win this trick.');
        const trumpLead = playView({ hands: { 1: ['Ks', '2d', '3d'] }, open: { lead: 4, cards: ['9h'] }, turn: 1, trumpBroken: true });
        expect(T.pickTip('decision', trumpLead, cardDecision('2d'), only('T.void'))).toBe(null);
    });

    test('T.partnerWins: the partner winning and the suggested card leaving it so', () => {
        // Bob (3) leads A♣, Dan (4) plays 2♣, Alice (1) to play
        const v = playView({ hands: { 1: ['Kc', '3c', '3d'] }, open: { lead: 3, cards: ['Ac', '2c'] }, turn: 1 });
        expect(T.pickTip('decision', v, cardDecision('3c'), only('T.partnerWins')).text)
            .toBe('Bob (your partner) is winning this trick. Save your strong cards for later tricks.');
        // Carol winning: no
        const carol = playView({ hands: { 1: ['Kc', '3c', '3d'] }, open: { lead: 2, cards: ['Ac', '2c', '4c'] }, turn: 1 });
        expect(T.pickTip('decision', carol, cardDecision('3c'), only('T.partnerWins'))).toBe(null);
    });

    test('T.set: once T.bid was shown, at any moment', () => {
        expect(T.pickTip('between', bidView, null, only('T.set', 'T.bid'))).toBe(null);
        expect(T.pickTip('between', bidView, null, only('T.set')).text)
            .toBe('Win at least your combined bid and you score 10 points per trick bid, plus 1 for each extra trick. Fall short and you lose 10 per trick bid.');
    });

    test('T.rainbow: the 4-card hand', () => {
        const v = view({ handSize: 4, trump: '5h', hands: { 1: ['Ah', 'Kc', '2d', '3s'] }, turn: 2 });
        expect(T.pickTip('between', v, null, only('T.rainbow')).text).toBe('On the 4-card hand, holding one card of each suit is a rainbow: +10 points, even if the bid is missed.');
        expect(T.pickTip('between', bidView, null, only('T.rainbow'))).toBe(null);
    });

    test('T.broken: trump broken in play', () => {
        expect(T.pickTip('between', playView({ hands: { 1: ['Ah', '2c', '3d'] }, turn: 2, trumpBroken: true }), null, only('T.broken')).text).toBe('Trump is broken: anyone may now lead trump.');
        expect(T.pickTip('between', playView({ hands: { 1: ['Ah', '2c', '3d'] }, turn: 2 }), null, only('T.broken'))).toBe(null);
    });

    test('T.made: the pair reached its bid with tricks to go', () => {
        // Alice and Bob bid 1 + 0 = 1 and won the first trick (Alice's A♠)
        const v = view({
            handSize: 3, trump: '5h', bids: ['1', '1', '0', '0'], stage: 'play', hands: { 1: ['2c', '3d'] },
            tricks: [{ lead: 1, cards: ['As', '2s', '3s', '4s'] }], turn: 2
        });
        expect(T.pickTip('between', v, null, only('T.made')).text).toBe('You and Bob (your partner) made your bid! Extra tricks are worth 1 point each.');
        expect(T.pickTip('between', playView({ hands: { 1: ['Ah', '2c', '3d'] }, turn: 2 }), null, only('T.made'))).toBe(null);
    });

    test('T.handScore after hands 1-3 only, with the real numbers; T.graduate after the 2-card hand', () => {
        const facts = (handIndex, handSize) => ({
            handIndex, handSize, position: 1, names: { 1: 'Alice', 2: 'Carol', 3: 'Bob', 4: 'Dan' },
            bids: { team1: 5, team2: 3 }, tricks: { team1: 6, team2: 2 }, mults: { team1: 1, team2: 1 }
        });
        const [hs] = T.handEndTips(facts(1, 12), 0);
        expect(hs).toMatchObject({ id: 'T.handScore', bitId: 'T.handScore1', title: 'Hand score' });
        expect(hs.text).toBe('This hand, you and Bob (your partner) bid 5 and won 6: 5 × 10 + 1 = +51. Carol and Dan bid 3 and won 2: −3 × 10 = −30.');
        expect(T.handEndTips(facts(1, 12), T.withTip(0, 'T.handScore1'))).toEqual([]);
        expect(T.handEndTips(facts(3, 8), 0).map((t) => t.bitId)).toEqual(['T.handScore3']);
        expect(T.handEndTips(facts(4, 6), 0)).toEqual([]);
        const grad = T.handEndTips(facts(6, 2), 0);
        expect(grad.map((t) => t.id)).toEqual(['T.graduate']);
        expect(grad[0].text).toBe('You\'ve got the basics. From now on tips show only for tricky choices. /help works any time.');
        expect(T.handEndTips(facts(13, 13), 0)).toEqual([]);
    });

    test('a forced move gets nothing; the bit makes a topic once per game', () => {
        const v = playView({ hands: { 1: ['Kc', '2c', '3d'] }, open: { lead: 4, cards: ['9c'] }, turn: 1 });
        expect(T.decisionStep({ view: v, decision: { ...cardDecision('2c'), forced: true }, e: { confidence: 'only', codes: [] }, tips: 0 }))
            .toEqual({ tip: null, advice: false, tips: 0 });
        const r = T.decisionStep({ view: v, decision: cardDecision('2c'), e: { confidence: 'clear', codes: [] }, tips: only('T.follow') });
        expect(r.tip.id).toBe('T.follow');
        expect(T.has(r.tips, 'T.follow')).toBe(true);
        expect(T.decisionStep({ view: v, decision: cardDecision('2c'), e: { confidence: 'clear', codes: [] }, tips: r.tips }).tip).toBe(null);
        // between: one per window
        const b = T.betweenStep({ view: bidView, tips: only('T.trump', 'T.set'), windowUsed: false });
        expect(b).toMatchObject({ tip: { id: 'T.trump' }, windowUsed: true });
        expect(T.betweenStep({ view: bidView, tips: b.tips, windowUsed: true }).tip).toBe(null);
    });
});

// ------------------------------------------------------------ the numbers

describe('every number a tip states matches the rules (docs/RULES.md, rules.js)', () => {
    const RULES_MD = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docs', 'RULES.md'), 'utf8');

    test('T.set and T.made: 10 per trick bid made or set, +1 per extra trick', () => {
        for (let b = 1; b <= 13; b++) {
            for (let k = 0; b + k <= 13; k++) expect(rules.calculateScore(b, b + k, 1, 0)).toBe(10 * b + k);
            expect(rules.calculateScore(b, b - 1, 1, 0)).toBe(-10 * b);
            expect(rules.calculateScore(b, 0, 1, 0)).toBe(-10 * b);
            if (b < 13) expect(rules.calculateScore(b, b + 1, 1, 0) - rules.calculateScore(b, b, 1, 0)).toBe(1);
        }
        expect(RULES_MD).toMatch(/Points = \(Bid × 10 × Multiplier\) \+ Overtricks/);
        expect(RULES_MD).toMatch(/\+1 point for each trick won beyond the bid/);
    });

    test('T.bore: B doubles, 2B four times, 3B eight, 4B sixteen, made or missed', () => {
        const words = { B: ['Double', 'double', 2], '2B': ['Four times', 'four times', 4], '3B': ['Eight times', 'eight times', 8], '4B': ['Sixteen times', 'sixteen times', 16] };
        for (const [bid, [Big, small, m]] of Object.entries(words)) {
            expect(rules.calculateMultiplier(bid, '0')).toBe(m);
            for (let n = 1; n <= 13; n++) {
                expect(rules.calculateScore(n, n, m, 0)).toBe(m * rules.calculateScore(n, n, 1, 0));
                expect(rules.calculateScore(n, n - 1, m, 0)).toBe(m * rules.calculateScore(n, n - 1, 1, 0));
            }
            const v = seatView(tableAt({ handSize: 12, trump: '5h', hands: { 1: ['Ah'] }, bids: [null, bid === 'B' ? 'B' : null], turn: 1 }), 1);
            if (bid !== 'B') continue;
            expect(T.pickTip('between', v, null, only('T.bore')).text).toContain(`${Big} the points if made, minus ${small} if not.`);
        }
    });

    test('T.zero: a pair bidding 0 scores 1 a trick and is never set', () => {
        for (let t = 0; t <= 13; t++) expect(rules.calculateScore(0, t, 1, 0)).toBe(t);
        expect(RULES_MD).toMatch(/If one team bids 0 total, any tricks they win are worth 1 point each/);
    });

    test('T.rainbow: +10 on the 4-card hand, made or missed', () => {
        for (let b = 0; b <= 4; b++) {
            for (let t = 0; t <= 4; t++) expect(rules.calculateScore(b, t, 1, 1) - rules.calculateScore(b, t, 1, 0)).toBe(10);
        }
        expect(rules.isRainbow(['Ah', 'Kc', '2d', '3s'].map(card), card('5h'))).toBe(true);
        expect(RULES_MD).toMatch(/On the \*\*4-card hand only\*\*.*\*\*\+10 point bonus\*\*/);
        expect(RULES_MD).toMatch(/Rainbow bonus is awarded even if the team gets set/);
    });

    test('T.handScore: every formula is the score calculateScore gives', () => {
        const evalSide = (f) => {
            const [lhs, rhs] = f.split(' = ');
            // eslint-disable-next-line no-new-func
            const v = Function(`return (${lhs.replace(/×/g, '*').replace(/−/g, '-')});`)();
            return { v, rhs: Number(rhs.replace('−', '-').replace('+', '')) };
        };
        for (const m of [1, 2, 4, 8, 16]) {
            for (let bid = 0; bid <= 13; bid++) {
                for (let won = 0; won <= 13; won++) {
                    const f = T.pointsFormula(bid, won, m);
                    const { v, rhs } = evalSide(f);
                    const want = rules.calculateScore(bid, won, m, 0);
                    expect({ f, v, rhs }).toEqual({ f, v: want, rhs: want });
                }
            }
        }
    });

    test('T.trump, T.noTrump: trump beats every other suit, the jokers top it; in a no-trump hand only the jokers are trump', () => {
        const trick = (cards, lead) => {
            const p = [];
            cards.forEach((c, k) => { p[(lead - 1 + k) % 4] = card(c); });
            return p;
        };
        expect(rules.determineWinner(trick(['Ac', '2h', 'Kc', 'Qc'], 1), 1, card('5h'))).toBe(2);
        expect(rules.determineWinner(trick(['Ac', 'Ah', 'LO', 'Qc'], 1), 1, card('5h'))).toBe(3);
        expect(rules.determineWinner(trick(['Ac', 'Ah', 'Kh', 'LO'], 1), 1, card('HI'))).toBe(4);
        expect(rules.determineWinner(trick(['2c', 'Ah', 'Ks', 'Qd'], 1), 1, card('HI'))).toBe(1);
    });

    test('T.lead, T.broken, T.follow, T.void, T.hiJoker: what may be played', () => {
        const trump = card('5h');
        // leading: no trump before it is broken (unless only trump), any after
        const hand = ['Ah', '2c'];
        expect(legalOf(hand, { isLeading: true, trump, trumpBroken: false, position: 1 })).toEqual([card('2c')]);
        expect(legalOf(hand, { isLeading: true, trump, trumpBroken: true, position: 1 })).toHaveLength(2);
        expect(legalOf(['Ah', 'LO'], { isLeading: true, trump, trumpBroken: false, position: 1 })).toHaveLength(2);
        // following: the suit led if held; any card when void
        const lead = { leadCard: card('9c'), isLeading: false, trump, trumpBroken: false, position: 1, leadPosition: 4 };
        expect(legalOf(['Kc', '2c', '3d'], lead)).toEqual([card('Kc'), card('2c')]);
        expect(legalOf(['Kh', '2d', '3d'], lead)).toHaveLength(3);
        // the HI joker led: the other pair its highest trump (any card when it has none), the partner any trump
        const hi = (leadPosition) => ({ leadCard: card('HI'), isLeading: false, trump, trumpBroken: true, position: 1, leadPosition });
        expect(legalOf(['Kh', '2h', '3d'], hi(2))).toEqual([card('Kh')]);
        expect(legalOf(['Ks', '2d', '3d'], hi(2))).toHaveLength(3);
        expect(legalOf(['Kh', '2h', '3d'], hi(3))).toEqual([card('Kh'), card('2h')]);
    });
});

// ------------------------------------------------------------ seeded games

describe('seeded games (sim/tutorialFade.js)', () => {
    const events = [];
    let result;
    beforeAll(() => {
        result = measureFade({ games: 8, seed: 101, onEvent: (ev) => events.push(ev) });
    });

    test('every tip text keeps the copy rules', () => {
        const texts = new Set();
        for (const ev of events) if (ev.tip) texts.add(JSON.stringify([ev.tip.title, ev.tip.text]));
        for (const id of Object.keys(T.SYSTEM_TIPS)) {
            const t = T.systemTip(id);
            texts.add(JSON.stringify([t.title, t.text]));
            const l = T.systemTip(id, { line: true });
            texts.add(JSON.stringify([l.title, l.text]));
        }
        expect(texts.size).toBeGreaterThan(20);
        for (const j of texts) {
            const [title, text] = JSON.parse(j);
            const bad = [];
            if (!title || title.length > T.TITLE_MAX) bad.push('title length');
            if (!text || text.length > T.TIP_MAX) bad.push('text length');
            for (const t of [title, text]) {
                if (C.NAME_LINT.test(t)) bad.push('team words');
                if (/optimal/i.test(t)) bad.push('optimal');
                if (/\b(he|she|his|her|hers|him)\b/i.test(t)) bad.push('gendered pronoun');
                if (/\b(ruff|slough|boss|EV)\b/.test(t)) bad.push('jargon');
                if (/undefined|NaN|\bnull\b|\[object|Infinity|\s{2}|…/.test(t)) bad.push('junk');
                if (/\([^()]*\(/.test(t)) bad.push('nested parentheses');
            }
            // the partner is named with the tag ("you and Bob (your partner)")
            if (/\byou and [A-Z]/.test(text) && !text.includes('(your partner)')) bad.push('partner untagged');
            expect({ title, text, bad }).toEqual({ title, text, bad: [] });
        }
    });

    test('every topic at most once per game (T.handScore after each of hands 1-3)', () => {
        const per = {};
        for (const ev of events) {
            if (!ev.tip) continue;
            const k = `${ev.game}|${ev.tip.bitId || ev.tip.id}`;
            per[k] = (per[k] || 0) + 1;
        }
        expect(Object.values(per).every((n) => n === 1)).toBe(true);
        const ids = new Set(events.filter((ev) => ev.tip).map((ev) => ev.tip.id));
        // what 8 games reach (T.noTrump needs a flipped joker; T.bore a bore)
        for (const id of ['T.trump', 'T.bid', 'T.set', 'T.lead', 'T.follow', 'T.void', 'T.partnerWins', 'T.broken', 'T.made', 'T.handScore', 'T.rainbow', 'T.oneCard', 'T.graduate']) {
            expect([id, ids.has(id)]).toEqual([id, true]);
        }
    });

    test('the budget: one rule tip per own decision, one between two of them (a hand end opens a new window)', () => {
        let between = 0;
        let key = null;
        for (const ev of events) {
            if (key !== `${ev.game}|${ev.hand}`) {
                key = `${ev.game}|${ev.hand}`;
                between = 0;
            }
            if (ev.moment === 'decision') between = 0;
            else if (ev.moment === 'between') {
                between++;
                expect(between).toBeLessThanOrEqual(1);
            } else if (ev.moment === 'handEnd') between = 0;
        }
    });

    test('the fade-out: every non-forced decision shows advice up to the 2-card hand, only the tricky ones after', () => {
        expect(result.before.decisions).toBeGreaterThan(0);
        expect(result.before.advice).toBe(result.before.decisions);
        expect(result.after.advice).toBeLessThan(result.after.decisions * 0.6);
        expect(result.after.advice).toBeGreaterThan(0);
        for (const ev of events) {
            if (ev.moment !== 'decision' || ev.hand <= 6 || !ev.advice) continue;
            if (ev.decision.kind === 'card') {
                expect(['clear', 'certain']).toContain(ev.e.confidence);
                expect(T.obviousCard(ev.view, ev.decision.card, ev.e.codes)).toBe(false);
            } else {
                expect(T.trickyBid(ev.decision, ev.e)).toBe(true);
            }
        }
    });
});

// ------------------------------------------------------------ showAdvice

describe('showAdvice (the fade-out rule)', () => {
    const follow = seatView(tableAt({ handSize: 3, trump: '5h', bids: ['1', '1', '0', '0'], stage: 'play', hands: { 1: ['Kc', '2c', '3d'] }, open: { lead: 2, cards: ['Ac', '4c', '6c'] }, turn: 1 }), 1);

    test('before graduation: every non-forced decision; never a forced one', () => {
        expect(T.showAdvice(follow, cardDecision('2c'), { confidence: 'close', codes: [] }, false)).toBe(true);
        expect(T.showAdvice(follow, { ...cardDecision('2c'), forced: true }, { confidence: 'only', codes: [] }, false)).toBe(false);
    });

    test('after it: cards only clear or certain and not the obvious one', () => {
        expect(T.showAdvice(follow, cardDecision('Kc'), { confidence: 'close', codes: [] }, true)).toBe(false);
        expect(T.showAdvice(follow, cardDecision('Kc'), { confidence: 'clear', codes: ['F.winFight'] }, true)).toBe(true);
        // the plain "play low": the lowest club with F.cantWin
        expect(T.showAdvice(follow, cardDecision('2c'), { confidence: 'clear', codes: ['C.normal', 'F.cantWin'] }, true)).toBe(false);
        // the only card of the suit led
        const one = seatView(tableAt({ handSize: 3, trump: '5h', bids: ['1', '1', '0', '0'], stage: 'play', hands: { 1: ['Kc', '2d', '3d'] }, open: { lead: 2, cards: ['Ac'] }, turn: 1 }), 1);
        expect(T.showAdvice(one, cardDecision('Kc'), { confidence: 'certain', codes: [] }, true)).toBe(false);
    });

    test('after it: bids only when not the plain count (or a bore), never a close call', () => {
        const bid = (b, ownMean) => ({ ...bidDecision(b), trace: { bid: { path: 'ev', ownMean } } });
        expect(T.showAdvice(null, bid('3', 3.2), { confidence: 'clear' }, true)).toBe(false);
        expect(T.showAdvice(null, bid('2', 3.2), { confidence: 'clear' }, true)).toBe(true);
        expect(T.showAdvice(null, bid('2', 3.2), { confidence: 'close' }, true)).toBe(false);
        expect(T.showAdvice(null, { ...bidDecision('B'), trace: { bid: { path: 'bore:sweep' } } }, { confidence: 'close' }, true)).toBe(true);
    });
});

// The real engine on one of those views, so the helpers above match its shapes
test('a real decision and explanation go through decisionStep', () => {
    const g = tableAt({ handSize: 3, trump: '5h', bids: ['1', '1', '0', '0'], stage: 'play', hands: { 1: ['Kc', '2c', '3d'], 2: ['5c', '6d', '7d'], 3: ['8s', '9s', '10s'], 4: ['Js', 'Qs', 'Ks'] }, open: { lead: 2, cards: ['Ac', '4c', '6c'] }, turn: 1 });
    const v = seatView(g, 1);
    const d = advise(v);
    const e = explain(d, v);
    const r = T.decisionStep({ view: v, decision: d, e, tips: 0 });
    expect(r.advice).toBe(true);
    expect(r.tip && r.tip.id).toBe('T.trump');
});
