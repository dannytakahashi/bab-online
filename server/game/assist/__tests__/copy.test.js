/**
 * The /help copy rules (plan §3.3, Q1-Q9) over every decision of seeded
 * games, all four seats (sim/lint.js): lengths, hedged and rounded rates,
 * names only (never team numbers, "your team", "opponents"), "suggested"
 * and "our strongest bot" (never "optimal"), plain words, the partner
 * tagged once on first mention, and no card the seat cannot see. Plus the
 * copy helpers themselves and a lint that bites.
 */

const C = require('../copy');
const R = require('../reasons');
const { seatView } = require('../seatView');
const { advise } = require('../advise');
const { explain, status } = require('../explain');
const { lintExplanation, namedCards } = require('../sim/lint');
const { run: coverage } = require('../sim/assistCoverage');
const { playStateGame } = require('../sim/stateGame');
const { tableAt } = require('../sim/table');

describe('copy helpers', () => {
    test('cards and suits', () => {
        expect(C.cardText({ suit: 'clubs', rank: 'A' })).toBe('A♣');
        expect(C.cardText({ suit: 'spades', rank: '10' })).toBe('10♠');
        expect(C.cardText({ suit: 'joker', rank: 'HI' })).toBe('HI joker');
        expect(C.suitWord('hearts', 1)).toBe('heart');
        expect(C.suitWord('hearts')).toBe('hearts');
        expect(C.cleanName('\u{1F916} Mary')).toBe('Mary');
        expect(C.listText(['a', 'b', 'c'])).toBe('a, b and c');
    });

    test('rates: rounded to 5% with a word for every band (Q3)', () => {
        const cases = [[1, 'almost always (about 100%)'], [0.951, 'almost always (about 95%)'], [0.93, 'almost always (about 95%)'],
            [0.82, 'usually (about 80%)'], [0.7, 'more often than not (about 70%)'], [0.5, 'about half the time (about 50%)'],
            [0.31, 'sometimes (about 30%)'], [0.12, 'rarely (about 10%)'], [0.02, 'almost never (about 0%)']];
        for (const [p, want] of cases) expect(C.rate(p)).toBe(want);
        expect(C.rateShort(0.82)).toBe('usually (80%)');
        // The word follows the rounded value, never the raw one
        for (let p = 0; p <= 1.0001; p += 0.01) expect(C.rate(p)).toMatch(/^(almost always|usually|more often than not|about half the time|sometimes|rarely|almost never) \(about \d+%\)$/);
    });

    test('tricks and points', () => {
        expect(C.tricksText(1.94)).toBe('about 1.9');
        expect(C.tricksText(0.4)).toBe('about 0.4');
        expect(C.tricksText(4.6)).toBe('about 5');
        // Rounded first: 2.96 is "about 3", never "about 3.0"
        expect(C.tricksText(2.96)).toBe('about 3');
        expect(C.tricksText(2.94)).toBe('about 2.9');
        expect(C.pointsText(58.4)).toBe('about +58');
        expect(C.pointsText(-10)).toBe('about −10');
        expect(C.pointsText(0.2)).toBe('about 0');
    });

    test('clip and fit', () => {
        expect(C.clip('short', 10)).toBe('short');
        const long = 'word '.repeat(50).trim();
        expect(C.clip(long, 60).length).toBeLessThanOrEqual(60);
        expect(C.clip(long, 60)).toMatch(/…$/);
        expect(C.fit(['x'.repeat(200), 'fits'], 140)).toBe('fits');
        // No parenthesis left open by the cut
        expect(C.clip(`${'word '.repeat(12)}against almost never (about 0%) with it.`, 90)).toBe(`${'word '.repeat(12)}against almost never…`);
    });

    test('render: rich card and the line (LINE_MAX, both reasons whenever they fit) with the use count', () => {
        const e = { headline: 'Play 4♦', reasons: ['You and Bob (your partner) need 2 more of the last 4 tricks.', 'Bob is winning.'], details: ['d'], confidence: 'clear', suggest: {}, codes: [] };
        expect(C.render(e)).toEqual({ headline: 'Play 4♦', label: 'Clear choice', reasons: e.reasons, details: ['d'], footer: C.FOOTER });
        expect(C.FOOTER).toMatch(/our strongest bot/);
        const line = C.render(e, { style: 'line', uses: 2, freeUses: 3 });
        expect(line).toBe('Suggested (only you see this): Play 4♦. You and Bob (your partner) need 2 more of the last 4 tricks. Bob is winning. (Help 2 of 3 free)');
        expect(C.render(e, { style: 'line', uses: 4, freeUses: 3 })).toMatch(/\(Help 4: this game counts as bot-assisted for you\)$/);
        expect(C.render(e, { style: 'line', counted: false })).toMatch(/\(Not counted\.\)$/);
        expect(C.render({ ...e, confidence: 'quick' }).footer).toBe(C.QUICK_NOTE);
        expect(C.render({ ...e, confidence: 'quick' }, { style: 'line' })).toMatch(/^Quick suggestion, rules only/);
        // Too long for both: the main reason alone, the partner tag moved onto it
        const big = { ...e, reasons: [`You and Bob (your partner) ${'need '.repeat(80)}tricks.`, `Bob's ${'x'.repeat(100)} could lose.`] };
        Object.defineProperty(big, 'partnerName', { value: 'Bob' });
        const l2 = C.render(big, { style: 'line', uses: 1, freeUses: 3 });
        expect(l2.length).toBeLessThanOrEqual(C.LINE_MAX);
        expect(l2).toMatch(/: Play 4♦\. Your partner Bob's x+/);
    });

    test('render: the moved partner tag goes on the name as a whole word, and no guess footer on a forced move', () => {
        const line = (partner, main) => {
            const e = { headline: 'Play 4♦', reasons: [`You and ${partner} (your partner) ${'need '.repeat(90)}tricks.`, main], details: [], confidence: 'clear', suggest: {}, codes: [] };
            Object.defineProperty(e, 'partnerName', { value: partner });
            return C.render(e, { style: 'line' });
        };
        expect(line('Al', 'All your cards could win later: Al plays after you.')).toBe('Suggested (only you see this): Play 4♦. All your cards could win later: Al (your partner) plays after you.');
        expect(line('Ali', 'Alice, last to play, then Ali.')).toBe('Suggested (only you see this): Play 4♦. Alice, last to play, then Ali (your partner).');
        expect(line('Ali', 'Alice is winning with the 9♦. Ali\'s 4♦ could still lose.')).toBe('Suggested (only you see this): Play 4♦. Alice is winning with the 9♦. Your partner Ali\'s 4♦ could still lose.');
        expect(line('A.B', 'AxB plays, then A.B.')).toBe('Suggested (only you see this): Play 4♦. AxB plays, then A.B (your partner).');
        const forced = { headline: 'Play K♥', reasons: ['Your only legal card.'], details: [], confidence: 'only', suggest: {}, codes: ['P.forced'] };
        expect(C.render(forced).footer).toBeNull();
        expect(C.render(forced).label).toBe('Only legal card');
    });

    test('the name lint (Q9)', () => {
        for (const bad of ['Team 1 needs', 'team2 leads', 'T1 bid', 'your team', 'the other team', 'the opponents', 'an opponent']) expect(C.NAME_LINT.test(bad)).toBe(true);
        for (const ok of ['You and Bob need', 'Carol and Dan bid 3', 'the bottom trick']) expect(C.NAME_LINT.test(ok)).toBe(false);
    });

    test('glosses', () => {
        const g = C.glossFor(['Lead the HI joker.', 'It wins the trick.'], ['trick']);
        expect(g.map((x) => x.term)).toEqual(['lead', 'joker']);
    });

    test('every reason template exists for every rule code the bot can end on', () => {
        const codes = ['L.only', 'L.maxHi', 'L.maxBossTrump', 'L.maxCashBoss', 'L.maxTrump', 'L.maxHigh', 'L.bossTrump', 'L.cashBoss',
            'L.hiJoker', 'L.lowTrump', 'L.suitAce', 'L.suitKing', 'L.suitLow', 'L.onlyTrump', 'L.fallback',
            'F.only', 'F.erraticOvertake', 'F.overtake', 'F.overtakeFight', 'F.partnerWinsLow', 'F.hoardDuck', 'F.flashyWin',
            'F.winSure', 'F.winFight', 'F.lastLowestWin', 'F.cantWin', 'F.ruffMaxPartner', 'F.ruffForPartner', 'F.onlyTrumpLeft',
            'F.holdHi', 'F.ruffLowSafe', 'F.ruffLow2nd', 'F.ruffLow3rd', 'F.flashyRuff', 'F.ruffSecure', 'F.ruffFight', 'F.ruffLast',
            'F.underTrump', 'D.partnerWins', 'D.cantOvertrump', 'D.noTrump', 'D.voidShortest', 'D.keepWinner', 'D.lowest', 'D.allWinners',
            'C.boreUs', 'C.boreThem', 'C.max', 'C.setThem', 'C.normal', 'C.made', 'C.dead', 'P.generic'];
        for (const c of codes) expect(typeof R.TABLE[c]).toBe('function');
    });
});

describe('the lint bites', () => {
    const view = seatView(tableAt({ handSize: 3, trump: '5h', hands: { 1: ['LO', 'Kh', '8s'] }, turn: 1 }), 1);
    const ok = { headline: 'Bid 1', reasons: ['Bob (your partner) bids after you.'], details: [], confidence: 'clear', suggest: { bid: '1' }, codes: ['B.evFirst'] };
    const lint = (patch) => lintExplanation({ ...ok, ...patch }, view);

    test('a clean one passes', () => expect(lint({})).toEqual([]));
    test.each([
        ['team words', { reasons: ['Bob (your partner) and your team.'] }],
        ['opponents', { reasons: ['The opponents bid 3.'] }],
        ['optimal', { reasons: ['The optimal bid.'] }],
        ['an unhedged rate', { reasons: ['It makes 80% of the time.'] }],
        ['an unrounded rate', { reasons: ['usually (about 83%)'] }],
        ['a rate without a word', { reasons: ['It makes (80%).'] }],
        ['a hidden card', { reasons: ['Carol holds the A♠.'] }],
        ['the HI joker when unseen', { reasons: ['Only the HI joker beats it.'] }],
        ['undefined', { reasons: ['Bid undefined.'] }],
        ['a pronoun', { reasons: ['Carol bored, so set her.'] }],
        ['jargon', { reasons: ['Bob (your partner) can ruff it: the boss is gone.'] }],
        ['an untagged partner', { reasons: ['Bob bid 2.'] }],
        ['a double tag', { reasons: ['Bob (your partner) bid 2.', 'Bob (your partner) again.'] }],
        ['a long reason', { reasons: ['x'.repeat(141)] }],
        ['three reasons', { reasons: ['a', 'b', 'c'] }],
        ['nested parentheses', { reasons: ['Not your turn yet (Bob (your partner) is bidding).'] }],
        ['"60%, just under 60%"', { details: ['Not a bore: Bob (your partner) would win every trick more often than not (about 60%), just under what a bore needs (about 60%).'] }],
        ['the trump suit as a side suit', { reasons: ['Bob (your partner) leads. You have no hearts and no trump, so you can\'t win this one.'] }],
        ['one card credited with 1.8 tricks', { reasons: ['Your hand should win about 2.2 tricks: HI joker (about 1.8).'] }],
        ['"save strong cards" before a winning play', { reasons: ['You and Bob (your partner) have made your bid. Extra tricks are worth 1 point each, so save strong cards.', 'x'], codes: ['C.made', 'F.ruffLast'] }]
    ])('%s', (name, patch) => expect(lint(patch).length).toBeGreaterThan(0));

    test('card tokens', () => {
        expect(namedCards('Lead A♣, then the 10♦ and the LO joker.')).toEqual(['clubs:A', 'diamonds:10', 'joker:LO']);
    });
});

describe('every decision of seeded games passes the copy rules', () => {
    test('4 games, all seats (sim/assistCoverage.js): no lint problem, P.generic under 2%', () => {
        const r = coverage({ games: 4, seed: 900 });
        expect(r.problems).toEqual([]);
        expect(r.genericShare).toBeLessThan(0.02);
        expect(r.decisions).toBeGreaterThan(1500);
        expect(r.longest.headline).toBeLessThanOrEqual(C.HEADLINE_MAX);
        expect(r.longest.reason).toBeLessThanOrEqual(C.REASON_MAX);
        expect(r.longest.line).toBeLessThanOrEqual(C.LINE_MAX);
        // Not vacuous: bids, rule plays, searched plays and forced moves
        for (const k of ['bid', 'rule', 'search', 'forced']) expect(r.kinds[k]).toBeGreaterThan(50);
    }, 300000);

    test('Quick suggestions, tutorial glosses and status lines too', () => {
        let n = 0;
        playStateGame({
            seed: 901, hands: 8,
            onTurn(game, pos) {
                const view = seatView(game, pos);
                const d = advise(view, { budget: 'rules' });
                const e = explain(d, view, { mode: 'tutorial' });
                expect(lintExplanation(e, view, { line: C.render(e, { style: 'line', uses: 1, freeUses: 3 }), rich: C.render(e) })).toEqual([]);
                expect(Array.isArray(e.gloss)).toBe(true);
                for (let p = 1; p <= 4; p++) {
                    if (p === pos) continue;
                    const s = status(seatView(game, p));
                    expect(s).toMatch(/^Not your turn yet: /);
                    expect(s).not.toMatch(/\([^)]*\(/);
                    expect(s.length).toBeLessThanOrEqual(C.LINE_MAX);
                    expect(C.NAME_LINT.test(s)).toBe(false);
                }
                n++;
            }
        });
        expect(n).toBeGreaterThan(150);
    }, 300000);
});
