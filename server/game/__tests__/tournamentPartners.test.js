/**
 * Tournament partner rotation (owner 2026-11-24): game/tournamentPartners.js.
 * Deterministic (seeded rng): every round plan keeps distributePlayersIntoGames's
 * table shapes, never repeats a member's last human partner when any
 * arrangement avoids it, and repeats a partnership only as often as the best
 * arrangement must (checked against an exhaustive search of every
 * arrangement for small fields, with random attendance: sit-outs, returns,
 * leaves). With everyone playing every round the round-by-round plan is as
 * good as the best whole-tournament plan (exhaustive, up to 7 members).
 */

'use strict';

const TournamentState = require('../TournamentState');
const P = require('../tournamentPartners');
const { determineDrawPosition } = require('../rules');
const Deck = require('../Deck');
const { mulberry32 } = require('../../testUtils/gameDriver');

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

const names = (n, tag = 'p') => Array.from({ length: n }, (_, i) => `${tag}${i}`);
const clone = (h) => ({ counts: new Map(h.counts), last: new Map(h.last) });
const teamsOfPlan = (plan) => plan.flatMap((t) => t.teams);
const pairsOfPlan = (plan) => teamsOfPlan(plan).filter(([a, b]) => a && b);
const score = ({ consecutive, repeats }) => consecutive * P.CONSECUTIVE + repeats;

/** Every arrangement of `players` for the round's shapes: its human pairs and its teams. */
function allArrangements(players) {
    const { pairs: nP, singles: nS } = P.slotsOf(P.tableShapes(players.length));
    const out = [];
    (function rec(rest, pairs, pl, sl) {
        if (rest.length === 0) {
            const paired = new Set(pairs.flat());
            out.push({ pairs: pairs.slice(), teams: [...pairs, ...players.filter((p) => !paired.has(p)).map((p) => [p, null])] });
            return;
        }
        const [p, ...r] = rest;
        if (sl > 0) rec(r, pairs, pl, sl - 1);
        if (pl > 0) {
            for (let i = 0; i < r.length; i++) {
                pairs.push([p, r[i]]);
                rec(r.filter((_, j) => j !== i), pairs, pl - 1, sl);
                pairs.pop();
            }
        }
    })(players, [], nP, nS);
    return out;
}

/** The least cost any arrangement of `players` has after `history`. */
function oracleRound(players, history) {
    let best = Infinity;
    for (const a of allArrangements(players)) best = Math.min(best, score(P.planCost(history, a.pairs)));
    return best;
}

/** The least total cost of the best whole-tournament plan for these line-ups. */
function oracleTournament(lineups) {
    const arrs = lineups.map(allArrangements);
    let best = Infinity;
    (function rec(r, h, cost) {
        if (cost >= best) return;
        if (r === lineups.length) { best = cost; return; }
        for (const a of arrs[r]) {
            const c = cost + score(P.planCost(h, a.pairs));
            if (c >= best) continue;
            const h2 = clone(h);
            P.addRound(h2, a.teams);
            rec(r + 1, h2, c);
        }
    })(0, P.emptyHistory(), 0);
    return best;
}

/** Play `lineups` round by round through planRoundTables; per-round costs. */
function playRounds(lineups, rng, onRound) {
    const history = P.emptyHistory();
    const costs = [];
    lineups.forEach((players, r) => {
        const plan = P.planRoundTables(players, history, rng);
        const c = P.planCost(history, pairsOfPlan(plan));
        if (onRound) onRound(plan, history, players, r);
        costs.push(c);
        P.addRound(history, teamsOfPlan(plan));
    });
    return costs;
}

describe('a round plan', () => {
    test('keeps the table shapes and seats every member once, for 1 to 41 members', () => {
        for (let n = 1; n <= 41; n++) {
            const players = names(n);
            const plan = P.planRoundTables(players, P.emptyHistory(), mulberry32(n));
            const shapes = TournamentState.distributePlayersIntoGames(players).map((a) => a.humans.length).sort();
            expect(plan.map((t) => t.humans.length).sort()).toEqual(shapes);
            expect(plan.flatMap((t) => t.humans).sort()).toEqual([...players].sort());
            for (const t of plan) {
                expect(t.teams).toHaveLength(2);
                for (const team of t.teams) expect(team).toHaveLength(2);
                expect(t.teams.flat().filter(Boolean).sort()).toEqual([...t.humans].sort());
                expect(t.botCount).toBe(4 - t.humans.length);
                // A 2-human table: the two face each other, each with a bot
                if (t.humans.length === 2) expect(t.teams.every(([a, b]) => !(a && b))).toBe(true);
                if (t.humans.length === 3) expect(t.teams.filter(([a, b]) => a && b)).toHaveLength(1);
                if (t.humans.length === 4) expect(t.teams.every(([a, b]) => a && b)).toBe(true);
            }
        }
        expect(P.planRoundTables([], P.emptyHistory())).toEqual([]);
    });

    test('is as good as the best arrangement, every round, with random attendance (1 to 10 members, 400 seeds)', () => {
        let rounds = 0;
        let forced = 0;
        for (let seed = 1; seed <= 400; seed++) {
            const rng = mulberry32(seed);
            const n = 1 + (seed % 10);
            const all = names(n);
            // Each member plays a round with probability 0.8 (a sit-out, a
            // drop and a return), and one may leave for good
            const leaver = rng() < 0.3 ? all[Math.floor(rng() * n)] : null;
            const lineups = [0, 1, 2, 3].map((r) => {
                const l = all.filter((u) => rng() < 0.8 && !(u === leaver && r >= 2));
                return l.length ? l : [all[0]];
            });
            playRounds(lineups, rng, (plan, history, players) => {
                rounds++;
                const got = score(P.planCost(history, pairsOfPlan(plan)));
                const best = oracleRound(players, history);
                expect(got).toBe(best);
                if (best > 0) forced++;
            });
        }
        expect(rounds).toBe(1600);
        // Some rounds had to repeat a partnership (small fields)
        expect(forced).toBeGreaterThan(0);
    });

    test('never repeats the partner of a member\'s last played round when it can avoid it', () => {
        for (let seed = 1; seed <= 300; seed++) {
            const rng = mulberry32(1000 + seed);
            const n = 1 + (seed % 10);
            const all = names(n);
            const lineups = [0, 1, 2, 3].map(() => all.filter(() => rng() < 0.75)).map((l) => (l.length ? l : [all[0]]));
            playRounds(lineups, rng, (plan, history, players) => {
                const c = P.planCost(history, pairsOfPlan(plan));
                const avoidable = oracleRound(players, history) < P.CONSECUTIVE;
                if (avoidable) expect(c.consecutive).toBe(0);
            });
        }
    });

    test('everyone playing every round: as good as the best whole-tournament plan (1 to 7 members)', () => {
        // The least total: 3 members (one pair each round, 3 pairs over 4
        // rounds) and 4 members (one table, 3 pairings over 4 rounds) must
        // repeat; every other size never does
        const expected = { 1: 0, 2: 0, 3: 1, 4: 2, 5: 0, 6: 0, 7: 0 };
        for (let n = 1; n <= 7; n++) {
            const lineups = [0, 1, 2, 3].map(() => names(n));
            expect(oracleTournament(lineups)).toBe(expected[n]);
            for (let seed = 1; seed <= 50; seed++) {
                const costs = playRounds(lineups, mulberry32(n * 100 + seed));
                expect(costs.reduce((s, c) => s + score(c), 0)).toBe(expected[n]);
                expect(costs.every((c) => c.consecutive === 0)).toBe(true);
            }
        }
    });

    test('4 members: the first three rounds use the three pairings; the fourth repeats one, never round 3\'s', () => {
        for (let seed = 1; seed <= 100; seed++) {
            const rounds = [];
            playRounds([0, 1, 2, 3].map(() => names(4)), mulberry32(seed), (plan) => {
                rounds.push(pairsOfPlan(plan).map((p) => [...p].sort().join('+')).sort().join(' / '));
            });
            expect(new Set(rounds.slice(0, 3)).size).toBe(3);
            expect(rounds[3]).not.toBe(rounds[2]);
        }
    });

    test('8 to 41 members, everyone playing: no partnership ever repeats', () => {
        for (let n = 8; n <= 41; n++) {
            for (let seed = 1; seed <= 5; seed++) {
                const costs = playRounds([0, 1, 2, 3].map(() => names(n)), mulberry32(n * 7 + seed));
                expect(costs.every((c) => c.consecutive === 0 && c.repeats === 0)).toBe(true);
            }
        }
    });

    test('8 or more playing, after any history: never a repeat (random attendance, 8 to 30 members)', () => {
        for (let seed = 1; seed <= 200; seed++) {
            const rng = mulberry32(5000 + seed);
            const all = names(8 + (seed % 23));
            const lineups = [0, 1, 2, 3].map(() => {
                const l = all.filter(() => rng() < 0.85);
                return l.length >= 8 ? l : all;
            });
            const costs = playRounds(lineups, rng);
            expect(costs.every((c) => c.consecutive === 0 && c.repeats === 0)).toBe(true);
        }
    });

    test('ties are broken at random: who gets the bot partner and the pairings vary by seed', () => {
        const seen = new Set();
        const singles = new Set();
        for (let seed = 1; seed <= 60; seed++) {
            const plan = P.planRoundTables(names(5), P.emptyHistory(), mulberry32(seed));
            seen.add(pairsOfPlan(plan).map((p) => [...p].sort().join('+')).join());
            for (const t of plan) for (const [a, b] of t.teams) if (a && !b) singles.add(a);
        }
        expect(seen.size).toBeGreaterThan(5);
        expect(singles.size).toBe(5);
    });

    test('a large round stays fast (200 members, 4 rounds)', () => {
        const start = Date.now();
        playRounds([0, 1, 2, 3].map(() => names(200)), mulberry32(3));
        expect(Date.now() - start).toBeLessThan(2000);
    });
});

describe('sit-outs, returns and leaves', () => {
    test('a member who sat a round out keeps their last partner: no partnership with them on their return', () => {
        // Round 1: a+b and c+d. Round 2: a sits out. Round 3: a returns
        for (let seed = 1; seed <= 50; seed++) {
            const h = P.addRound(P.emptyHistory(), [['a', 'b'], ['c', 'd']]);
            const r2 = P.planRoundTables(['b', 'c', 'd'], h, mulberry32(seed));
            P.addRound(h, teamsOfPlan(r2));
            expect(h.last.get('a')).toBe('b');
            const r3 = P.planRoundTables(['a', 'b', 'c', 'd'], h, mulberry32(seed + 1));
            const pairs = pairsOfPlan(r3).map((p) => [...p].sort().join('+'));
            expect(pairs).not.toContain('a+b');
            expect(P.planCost(h, pairsOfPlan(r3)).consecutive).toBe(0);
        }
    });

    test('when every option repeats a last partner: never the pair who are each other\'s last partner', () => {
        // Round 1: m1+m2. Round 2: m1+m3, m0+m4 (m2 sits out). Round 3:
        // m1+m0 (m2, m3 sit out). Round 4: m0, m1, m2, m3. Every matching
        // pairs someone with their last partner, but m0+m1 is in a row for
        // BOTH (partners in round 3, both playing round 4); m1+m3 or m1+m2
        // only for m3 or m2, who sat out while m1 played with someone else
        const h = P.emptyHistory();
        P.addRound(h, [['m1', 'm2'], ['m0', null], ['m3', null], ['m4', null]]);
        P.addRound(h, [['m1', 'm3'], ['m0', 'm4']]);
        P.addRound(h, [['m1', 'm0'], ['m4', null]]);
        expect(P.pairCost(h, 'm0', 'm1')).toBeGreaterThan(P.pairCost(h, 'm1', 'm3'));
        expect(P.planCost(h, [['m0', 'm1'], ['m2', 'm3']]).consecutive).toBe(2);
        expect(P.planCost(h, [['m0', 'm2'], ['m1', 'm3']]).consecutive).toBe(1);
        for (let seed = 1; seed <= 100; seed++) {
            const plan = P.planRoundTables(['m0', 'm1', 'm2', 'm3'], h, mulberry32(seed));
            const pairs = pairsOfPlan(plan).map((p) => [...p].sort().join('+'));
            expect(pairs).not.toContain('m0+m1');
            expect(P.planCost(h, pairsOfPlan(plan))).toEqual({ consecutive: 1, repeats: 1 });
        }
    });

    test('a bot partner leaves no last partner and never counts as a repeat', () => {
        const h = P.addRound(P.emptyHistory(), [['a', null], ['b', null]]);
        expect(h.last.get('a')).toBeNull();
        expect(h.counts.size).toBe(0);
        expect(P.pairCost(h, 'a', 'b')).toBe(0);
    });

    test('a member who left is simply not planned; the others keep their history', () => {
        const h = P.addRound(P.emptyHistory(), [['a', 'b'], ['c', 'd']]);
        P.addRound(h, [['a', 'c'], ['b', 'd']]);
        // d left: a, b, c play (one pair and one with a bot)
        for (let seed = 1; seed <= 30; seed++) {
            const plan = P.planRoundTables(['a', 'b', 'c'], h, mulberry32(seed));
            const pairs = pairsOfPlan(plan).map((p) => [...p].sort().join('+'));
            // a+c is back to back for both; b+c was never: the only cost-0 pair
            expect(pairs).toEqual(['b+c']);
        }
    });

    test('three members where every pair was partners: the one repeat avoids a back-to-back', () => {
        const h = P.emptyHistory();
        P.addRound(h, [['a', 'b'], ['c', null]]);
        P.addRound(h, [['a', 'c'], ['b', null]]);
        P.addRound(h, [['b', 'c'], ['a', null]]);
        for (let seed = 1; seed <= 30; seed++) {
            const plan = P.planRoundTables(['a', 'b', 'c'], h, mulberry32(seed));
            const pairs = pairsOfPlan(plan).map((p) => [...p].sort().join('+'));
            expect(pairs).toHaveLength(1);
            expect(pairs[0]).not.toBe('b+c');
            expect(P.planCost(h, pairsOfPlan(plan))).toEqual({ consecutive: 0, repeats: 1 });
        }
    });

    test('TournamentState.partnerHistory reads every table\'s teams in round order', () => {
        const t = new TournamentState('tid', 'T', 's-a', 'a');
        t.startRound(1);
        t.addGameToRound('g1', ['a', 'b', 'c', 'd'], 0, [['a', 'b'], ['c', 'd']]);
        t.startRound(2);
        t.addGameToRound('g2', ['a', 'c', 'b'], 1, [['a', 'c'], ['b', null]]);
        // A table recorded without teams adds nothing
        t.addGameToRound('g3', ['e', 'f'], 2);
        const h = t.partnerHistory();
        expect(h.last.get('a')).toBe('c');
        expect(h.last.get('b')).toBeNull();
        expect(h.last.get('d')).toBe('c');
        expect(h.last.has('e')).toBe(false);
        expect(h.counts.get(P.pairKey('a', 'b'))).toBe(1);
        expect(h.counts.get(P.pairKey('c', 'a'))).toBe(1);
    });
});

describe('a table that never seated adds no partnership', () => {
    const { recordTableScores } = require('../tournamentScoring');
    const { scoreGoneTable } = require('../persist/restoreTournament');

    function roundOne() {
        const t = new TournamentState('tid', 'T', 's-a', 'a');
        for (const [i, u] of ['b', 'c', 'd', 'e', 'f', 'g'].entries()) t.addPlayer(`s-${i}`, u);
        t.startRound(1);
        t.addGameToRound('g1', ['a', 'b', 'c', 'd'], 0, [['a', 'b'], ['c', 'd']]);
        t.addGameToRound('g2', ['e', 'f', 'g'], 1, [['e', 'f'], ['g', null]]);
        return t;
    }
    // A table aborted before its draw seated anyone (the countdown): the
    // entrants only, as gameLifecycle leaves it
    const unseated = (gameId, humans) => ({
        gameId,
        score: { team1: 0, team2: 0 },
        seatList: () => [],
        entrants: new Map(humans.map((u, i) => [`x${i}`, { isBot: false, username: u, presence: 'connected' }]))
    });

    test('aborted in the countdown: its planned teams are dropped; the other table\'s stay', () => {
        const t = roundOne();
        recordTableScores(t, unseated('g2', ['e', 'f', 'g']), { aborted: true });
        expect(t.rounds[0].games.get('g2').teams).toBeUndefined();
        const h = t.partnerHistory();
        expect(h.counts.has(P.pairKey('e', 'f'))).toBe(false);
        expect(h.last.has('e')).toBe(false);
        expect(h.counts.get(P.pairKey('a', 'b'))).toBe(1);
        // Scored as before: 0, aborted, no position
        expect(t.scoreboard.e.roundDetails[0]).toMatchObject({ teamScore: 0, aborted: true, position: null });
    });

    test('restored with the round in play: a pre-deal table scored as an abort adds no partnership', () => {
        const t = roundOne();
        expect(scoreGoneTable(t, 'g2')).toBe(true);
        expect(t.partnerHistory().counts.has(P.pairKey('e', 'f'))).toBe(false);
        // A table that was seated (its saved seats) keeps its teams
        const seats = [['a', 1], ['c', 2], ['b', 3], ['d', 4]].map(([username, position]) => ({ username, position }));
        expect(scoreGoneTable(t, 'g1', { tableScore: { score: { team1: 40, team2: -20 }, seats } })).toBe(true);
        expect(t.partnerHistory().counts.get(P.pairKey('a', 'b'))).toBe(1);
    });
});

describe('the draw seats the planned teams', () => {
    test('planDrawCards: the planned partners draw the two highest or the two lowest of four cards', () => {
        const orientations = new Set();
        for (let seed = 1; seed <= 300; seed++) {
            const rng = mulberry32(seed);
            const deck = new Deck();
            deck.cards.sort(() => rng() - 0.5);
            const teams = [['s1', 's2'], ['s3', 's4']];
            const plan = P.planDrawCards(deck.cards, teams, rng);
            const four = [...plan.values()];
            expect(new Set(four).size).toBe(4);
            const pos = (id) => determineDrawPosition(plan.get(id), four);
            const parity = (id) => pos(id) % 2;
            expect(parity('s1')).toBe(parity('s2'));
            expect(parity('s3')).toBe(parity('s4'));
            expect(parity('s1')).not.toBe(parity('s3'));
            orientations.add(pos('s1') % 2);
        }
        expect(orientations.size).toBe(2);
    });

    test('planDrawCards refuses a malformed plan or a short deck', () => {
        const deck = new Deck();
        expect(P.planDrawCards(deck.cards, [['a', 'b']])).toBeNull();
        expect(P.planDrawCards(deck.cards, [['a', 'a'], ['b', 'c']])).toBeNull();
        expect(P.planDrawCards(deck.cards, [['a', null], ['b', 'c']])).toBeNull();
        expect(P.planDrawCards(deck.cards.slice(0, 3), [['a', 'b'], ['c', 'd']])).toBeNull();
    });
});
