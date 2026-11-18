/**
 * Decision traces (the /help explainer hooks, plan H1a): an optional last
 * `trace` on the bid and play functions, `opts {trace, searchOptions,
 * onError}` on selectOptimalCard, the search's detail stats and the pure
 * card memory. None of it may change a decision:
 *  - trace-neutral: seeded games with a fresh trace on every decision play
 *    exactly the bids, cards, tricks and scores (and leave Math.random at the
 *    same point) as with no trace
 *  - the trace says what the path did (bid paths, rule codes, search stats
 *    consistent with the card the search chose)
 *  - cardMemory.fromHistory equals every bot's own snapshot
 *  - opts.onError replaces noteSearchError (SEARCH.errors untouched),
 *    searchOptions {maxCards: 0} plays the rule card
 */

const rules = require('../../rules');
const BotPlayer = require('../BotPlayer');
const Strategy = require('../BotStrategy');
const { SEARCH } = require('../playSearch');
const cardMemory = require('../cardMemory');
const tableView = require('../../tableView');

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const PERSONALITIES = ['mary', 'sharon', 'danny', 'mike', 'zach'];
const cardStr = (c) => (c ? `${c.rank}${c.suit[0]}` : '-');

function freshDeck() {
    const d = [];
    for (const suit of SUITS) for (const rank of RANKS) d.push({ suit, rank });
    d.push({ suit: 'joker', rank: 'HI' }, { suit: 'joker', rank: 'LO' });
    for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
}

/**
 * Seeded bot games through the real strategy (the sim loop, compact). Every
 * personality plays, so the Math.random branches run too. `traced`: pass a
 * fresh trace to every decision (else nothing extra, as the bots do).
 * `onDecision(info)` sees every decision (with its trace when traced).
 */
function playGames({ games, seed, traced, onDecision = () => {} }) {
    const rng = mulberry32(seed);
    const spy = jest.spyOn(Math, 'random').mockImplementation(() => rng());
    const log = [];
    const histories = [];
    try {
        for (let g = 0; g < games; g++) {
            const bots = {};
            for (let p = 1; p <= 4; p++) {
                bots[p] = new BotPlayer('x', PERSONALITIES[(g + p * (g % 3 + 1)) % PERSONALITIES.length]);
                bots[p].assignToGame(`g${g}`, p, p);
            }
            const team = (p) => (p % 2 === 1 ? 1 : 2);
            const score = { 1: 0, 2: 0 };
            let dealer = 1;
            for (const hs of rules.HAND_PROGRESSION) {
                const firstBidder = (dealer % 4) + 1;
                let hands, trump, playerBids, teamBid, mult;
                for (let redeal = 0; ; redeal++) {
                    const d = freshDeck();
                    hands = {};
                    for (let p = 1; p <= 4; p++) hands[p] = d.slice((p - 1) * hs, p * hs);
                    trump = d[4 * hs];
                    for (let p = 1; p <= 4; p++) bots[p].resetCardMemory(hs, trump);
                    playerBids = [undefined, undefined, undefined, undefined];
                    for (let i = 0; i < 4; i++) {
                        const pos = ((firstBidder - 1 + i) % 4) + 1;
                        const bot = bots[pos];
                        const ctx = { teamScore: score[team(pos)], oppScore: score[3 - team(pos)], currentHandSize: hs };
                        const trace = traced ? {} : undefined;
                        const hand = hands[pos].slice();
                        let bid = Strategy.calculateOptimalBid(hand, trump, pos, playerBids, hs,
                            bot.getMemorySnapshot(), ctx, bot.personality, bot.partnerHistory, trace);
                        onDecision({ kind: 'bid', bot, hand, trump, playerBids: playerBids.slice(), hs, bid, trace });
                        if (!rules.isValidBid(String(bid).toUpperCase(), playerBids, hs)) bid = rules.safeBid(playerBids);
                        playerBids[pos - 1] = bid;
                        log.push(`B${pos}:${bid}`);
                    }
                    teamBid = {
                        1: Math.min(hs, (rules.BID_RANKS[playerBids[0]] || 0) + (rules.BID_RANKS[playerBids[2]] || 0)),
                        2: Math.min(hs, (rules.BID_RANKS[playerBids[1]] || 0) + (rules.BID_RANKS[playerBids[3]] || 0))
                    };
                    mult = {
                        1: rules.calculateMultiplier(playerBids[0], playerBids[2]),
                        2: rules.calculateMultiplier(playerBids[1], playerBids[3])
                    };
                    if (teamBid[1] === 0 && teamBid[2] === 0 && redeal < 200) continue;
                    break;
                }
                let lead = rules.findHighestBidder(firstBidder, playerBids) + 1;
                let trumpBroken = false;
                const teamTricks = { team1: 0, team2: 0 };
                const tricks = { 1: 0, 2: 0 };
                const trickHistory = [];
                for (let t = 0; t < hs; t++) {
                    const playedCards = [undefined, undefined, undefined, undefined];
                    let leadCard = null;
                    const leadPosition = lead;
                    const open = { lead: leadPosition, cards: [] };
                    for (let i = 0; i < 4; i++) {
                        const pos = ((lead - 1 + i) % 4) + 1;
                        const bot = bots[pos];
                        const playContext = {
                            playerBids,
                            bids: { team1: teamBid[1], team2: teamBid[2] },
                            tricks: { ...teamTricks },
                            team1Mult: mult[1], team2Mult: mult[2]
                        };
                        const hand = hands[pos];
                        const memory = bot.getMemorySnapshot();
                        const opts = traced ? { trace: {} } : undefined;
                        const args = [hand.slice(), playedCards.slice(), i === 0 ? null : leadCard, i === 0 ? null : leadPosition,
                            trump, trumpBroken, pos, memory, hs, playContext, bot.personality];
                        let card = Strategy.selectOptimalCard(...args, opts);
                        onDecision({ kind: 'card', bot, args, card, trace: opts && opts.trace, trump, trickHistory, open });
                        const trick = { leadCard, isLeading: i === 0, trump, trumpBroken, position: pos, leadPosition };
                        const inHand = card && hand.find(c => c.suit === card.suit && c.rank === card.rank);
                        if (!inHand || !rules.isLegalPlay(inHand, hand, trick)) {
                            log.push('ILLEGAL');
                            card = rules.firstLegalCard(hand, trick) || hand[0];
                        } else {
                            card = inHand;
                        }
                        hands[pos] = hand.filter(c => c !== card);
                        playedCards[pos - 1] = card;
                        open.cards.push(card);
                        if (i === 0) leadCard = card;
                        if (card.suit === trump.suit || card.suit === 'joker') trumpBroken = true;
                        for (let q = 1; q <= 4; q++) bots[q].recordCardPlayed(card, pos, trump, leadPosition);
                        log.push(`P${pos}:${cardStr(card)}`);
                    }
                    const winner = rules.determineWinner(playedCards, leadPosition, trump);
                    trickHistory.push({ winner, lead: leadPosition, cards: open.cards.slice() });
                    teamTricks[winner % 2 === 1 ? 'team1' : 'team2']++;
                    tricks[team(winner)]++;
                    for (let q = 1; q <= 4; q++) bots[q].advanceTrick();
                    lead = winner;
                }
                histories.push(trickHistory.map(t => `${t.lead}>${t.winner}:${t.cards.map(cardStr).join(',')}`).join(' '));
                for (const T of [1, 2]) score[T] += rules.calculateScore(teamBid[T], tricks[T], mult[T], 0);
                for (let p = 1; p <= 4; p++) {
                    if (bots[p].personality !== 'zach') continue;
                    const s = String(playerBids[rules.getPartnerPosition(p) - 1]);
                    if (!s.includes('B')) bots[p].recordPartnerHand(parseInt(s, 10) || 0, 0);
                }
                log.push(`S${score[1]}/${score[2]}`);
                dealer = rules.rotatePosition(dealer);
            }
        }
        return { log, histories, rngNext: rng() };
    } finally {
        spy.mockRestore();
    }
}

const BID_PATHS = ['bore:lock', 'bore:sweep', 'bore:escalate', 'bore:big', 'ev', 'rule'];
const RULE_TAGS = ['oneCard.top', 'oneCard.noTrumpHigh', 'oneCard.highTrump', 'oneCard.low', 'twoCard',
    'smallCap', 'partnerCap', 'oppHeavy', 'oppBored', 'partnerBig', 'late'];

describe('decision traces change no decision', () => {
    const searchBefore = JSON.stringify(SEARCH);

    test.each([[4242], [97]])('seeded games (seed %i): trace {} plays exactly as no trace', (seed) => {
        const errorsBefore = SEARCH.errors || 0;
        const plain = playGames({ games: 5, seed, traced: false });
        let bidTraces = 0, playTraces = 0, searched = 0;
        const traced = playGames({
            games: 5, seed, traced: true,
            onDecision: ({ kind, trace }) => {
                if (kind === 'bid') { if (trace.bid && trace.bid.path) bidTraces++; return; }
                if (trace.path && trace.path.length) playTraces++;
                if (trace.search && trace.search.samples) searched++;
            }
        });
        expect(traced.log).toEqual(plain.log);
        expect(traced.histories).toEqual(plain.histories);
        expect(traced.rngNext).toBe(plain.rngNext);
        // The traces were really filled (not a vacuous comparison)
        expect(bidTraces).toBeGreaterThan(100);
        expect(playTraces).toBeGreaterThan(1000);
        expect(searched).toBeGreaterThan(200);
        expect(SEARCH.errors || 0).toBe(errorsBefore);
        expect(JSON.stringify(SEARCH)).toBe(searchBefore);
    });
});

describe('what the traces say', () => {
    const seen = { bidPaths: new Set(), ruleTags: new Set(), codes: new Set(), overrides: 0, agrees: 0, memories: 0 };

    beforeAll(() => {
        playGames({
            games: 4, seed: 777, traced: true,
            onDecision: (d) => {
                if (d.kind === 'bid') {
                    const tb = d.trace.bid;
                    // Every bid ends on one path (a declined bore falls through to ev / rule)
                    expect(tb && BID_PATHS.includes(tb.path)).toBe(true);
                    seen.bidPaths.add(tb.path);
                    if (tb.path === 'ev') {
                        expect(tb.evs).toHaveLength(d.hs + 1);
                        expect(typeof tb.ownMean).toBe('number');
                        if (d.bot.personality === 'mary') {
                            // Mary: the pick is the EV pick, then only the floor and cap move it
                            expect(tb.modified).toBe(tb.picked);
                            if (!tb.floored && !tb.capped) expect(String(tb.picked)).toBe(d.bid);
                        }
                    }
                    if (tb.path === 'bore:sweep') expect(tb.sweepP).toBeGreaterThanOrEqual(tb.sweepThreshold);
                    if (tb.path.startsWith('bore:')) expect(['B', '2B', '3B', '4B']).toContain(d.bid);
                    if (tb.path === 'rule') for (const r of tb.rule) { expect(RULE_TAGS).toContain(r); seen.ruleTags.add(r); }
                    return;
                }
                const t = d.trace;
                expect(t.path.length).toBeGreaterThan(0);
                const last = t.path[t.path.length - 1].code;
                seen.codes.add(last);
                expect(last).toMatch(/^[LFD]\./);
                // Context entries come first; the terminal one names a rule card
                expect(t.ruleCard).toBeTruthy();
                expect(t).toHaveProperty('contract');

                // Search detail agrees with the card the search chose
                const s = t.search;
                if (s && s.samples && !s.onlyWinner) {
                    expect(s.detail).toBe(true);
                    const n = s.cands.length;
                    for (const key of ['totals', 'tricks', 'makes', 'sets']) expect(s[key]).toHaveLength(n);
                    for (let k = 0; k < n; k++) {
                        expect(s.makes[k]).toBeLessThanOrEqual(s.samples);
                        expect(s.sets[k]).toBeLessThanOrEqual(s.samples);
                        expect(s.tricks[k]).toBeLessThanOrEqual(s.samples * d.args[0].length);
                    }
                    const best = Math.max(...s.totals);
                    if (d.card !== t.ruleCard) {
                        seen.overrides++;
                        expect(s.totals[s.cands.indexOf(d.card)]).toBeCloseTo(best, 9);
                        expect(s.totals[s.ruleIdx] ?? -Infinity).toBeLessThan(best);
                    } else {
                        seen.agrees++;
                    }
                }

                // The public record rebuilds the bot's own memory exactly
                const rebuilt = cardMemory.fromHistory(d.trump, d.trickHistory, d.open.cards.length ? d.open : null);
                expect(rebuilt).toEqual(d.args[7]);
                seen.memories++;
            }
        });
    });

    test('bids cover the ev, rule and bore paths with known rule tags', () => {
        expect(seen.bidPaths.has('ev')).toBe(true);
        expect(seen.bidPaths.has('rule')).toBe(true);
        expect([...seen.bidPaths].some(p => p.startsWith('bore:'))).toBe(true);
        expect(seen.ruleTags.size).toBeGreaterThan(2);
    });

    test('plays end on a lead, follow or throw code, and searched plays carry consistent stats', () => {
        expect([...seen.codes].some(c => c.startsWith('L.'))).toBe(true);
        expect([...seen.codes].some(c => c.startsWith('F.'))).toBe(true);
        expect([...seen.codes].some(c => c.startsWith('D.'))).toBe(true);
        expect(seen.overrides).toBeGreaterThan(5);
        expect(seen.agrees).toBeGreaterThan(50);
    });

    test('cardMemory.fromHistory equals the bot snapshot at every play', () => {
        expect(seen.memories).toBeGreaterThan(1000);
    });
});

describe('rule-play codes', () => {
    const H = (rank) => ({ suit: 'hearts', rank });
    const S = (rank) => ({ suit: 'spades', rank });
    const C = (rank) => ({ suit: 'clubs', rank });
    const D = (rank) => ({ suit: 'diamonds', rank });
    const heartsTrump = { suit: 'hearts', rank: '2' };
    const mem = () => cardMemory.getMemorySnapshot(cardMemory.resetCardMemory());

    test('note returns the card unchanged and the last entry is the terminal code', () => {
        const hand = [{ suit: 'joker', rank: 'HI' }, S('3'), C('4')];
        const trace = {};
        const plain = Strategy.selectLead(hand.slice(), heartsTrump, true, { position: 1 }, mem(), 3, null);
        const traced = Strategy.selectLead(hand.slice(), heartsTrump, true, { position: 1 }, mem(), 3, null, trace);
        expect(traced).toEqual(plain);
        expect(trace.path[trace.path.length - 1].code).toBe('L.hiJoker');
    });

    test('a follow that throws notes why, then the throw', () => {
        // No spades and no trump. Partner (3) wins with the A of spades...
        const hand = [D('4'), C('9'), C('K')];
        const played = [undefined, S('5'), S('A'), undefined];
        const trace = {};
        const card = Strategy.selectFollow(hand, played, S('5'), 2, heartsTrump, false, 1, mem(), 3, null, 'balanced', trace);
        expect(card).toEqual(Strategy.selectFollow(hand, played, S('5'), 2, heartsTrump, false, 1, mem(), 3, null, 'balanced'));
        expect(trace.path.map(e => e.code)).toEqual(['D.partnerWins', 'D.lowest']);
        expect(trace.path[0].facts.partnerCard).toEqual(S('A'));
        // ...or an opponent (2) leads it and nobody else has played
        const t2 = {};
        Strategy.selectFollow(hand, [undefined, S('A'), undefined, undefined], S('A'), 2, heartsTrump, false, 3, mem(), 3, null, 'balanced', t2);
        expect(t2.path.map(e => e.code)).toEqual(['D.noTrump', 'D.lowest']);
    });

    test('a single legal card is F.only / L.only', () => {
        const trace = {};
        Strategy.selectFollow([S('9'), D('2')], [S('5'), undefined, undefined, undefined], S('5'), 1, heartsTrump, false, 2, mem(), 2, null, 'balanced', trace);
        expect(trace.path).toEqual([{ code: 'F.only' }]);
    });

    test('selectDiscard codes', () => {
        const t1 = {};
        expect(Strategy.selectDiscard([C('4'), D('9'), D('J')], heartsTrump, true, null, null, t1)).toEqual(C('4'));
        expect(t1.path).toEqual([{ code: 'D.voidShortest', facts: { suit: 'clubs', length: 1 } }]);
        const t2 = {};
        // No memory: A and K are protected, so the K of clubs (shortest) is kept
        expect(Strategy.selectDiscard([C('K'), D('9'), D('J')], heartsTrump, true, null, null, t2)).toEqual(D('9'));
        expect(t2.path[0].code).toBe('D.keepWinner');
    });

    test('bid traces: lock, sweep and the EV numbers', () => {
        const hiTrump = { suit: 'hearts', rank: '2' };
        const t = {};
        // Both jokers on a 2-card hand: every card a top trump
        expect(Strategy.calculateOptimalBid([{ suit: 'joker', rank: 'HI' }, { suit: 'joker', rank: 'LO' }], hiTrump, 1, [], 2, null, null, 'mary', [], t)).toBe('B');
        expect(t.bid.path).toBe('bore:lock');

        const t2 = {};
        const hand8 = [{ suit: 'joker', rank: 'HI' }, H('A'), H('9'), H('4'), C('A'), C('K'), D('7'), S('3')];
        const bid = Strategy.calculateOptimalBid(hand8, { suit: 'hearts', rank: '6' }, 4, ['1', '0', '2', undefined], 8, null, null, 'mary', [], t2);
        expect(t2.bid.path).toBe('ev');
        expect(t2.bid.partnerBid).toBe(0);
        expect(t2.bid.evs).toHaveLength(9);
        expect(bid).toBe(String(Math.max(t2.bid.picked, t2.bid.lockedFloor)));
        expect(Strategy.calculateOptimalBid(hand8, { suit: 'hearts', rank: '6' }, 4, ['1', '0', '2', undefined], 8, null, null, 'mary', [])).toBe(bid);
    });
});

describe('selectOptimalCard opts', () => {
    // A 3-card position the search decides (searchErrors.test.js uses it too)
    const trump = { suit: 'spades', rank: '2' };
    const hand = [{ suit: 'hearts', rank: 'K' }, { suit: 'hearts', rank: '4' }, { suit: 'diamonds', rank: '9' }];
    const none = [undefined, undefined, undefined, undefined];
    const memory = { playedCards: [], trumpPlayed: [], acesPlayed: {}, trickIndex: 0, totalCardsPlayed: 0 };
    const ctx = { playerBids: ['1', '1', '0', '0'], bids: { team1: 1, team2: 1 }, tricks: { team1: 0, team2: 0 }, team1Mult: 1, team2Mult: 1 };
    const play = (opts) => Strategy.selectOptimalCard(hand.slice(), none.slice(), null, null, trump, false, 1, memory, 3, ctx, 'mary', opts);

    test('a trace leaves the card alone and records the search', () => {
        const trace = {};
        expect(play({ trace })).toEqual(play());
        expect(trace.contract).toEqual(Strategy.getContractState(ctx, 1, 3));
        expect(trace.ruleCard).toBeTruthy();
        expect(trace.search.detail).toBe(true);
        expect(trace.search.samples).toBeGreaterThanOrEqual(SEARCH.minSamples);
        expect(trace.search.cands).toHaveLength(3);
    });

    test('searchOptions {maxCards: 0} plays the rule card without searching', () => {
        const trace = {};
        const card = play({ trace, searchOptions: { maxCards: 0 } });
        expect(card).toBe(trace.ruleCard);
        expect(trace.search).toBeUndefined();
        expect(card).toEqual(Strategy.selectLead(hand.slice(), trump, false, { position: 1 }, memory, 3, Strategy.getContractState(ctx, 1, 3)));
    });

    test('searchOptions {maxCards: 0} plays the rule card where the search would not', () => {
        // Find a seeded decision the search overrides, then replay it rules-only
        let found = null;
        playGames({
            games: 2, seed: 31, traced: true,
            onDecision: (d) => { if (!found && d.kind === 'card' && d.trace.search && d.card !== d.trace.ruleCard) found = d; }
        });
        expect(found).not.toBeNull();
        const args = found.args.map(a => (Array.isArray(a) ? a.slice() : a));
        const trace = {};
        const card = Strategy.selectOptimalCard(...args, { trace, searchOptions: { maxCards: 0 } });
        expect(card).toEqual(found.trace.ruleCard);
        expect(card).not.toEqual(found.card);
        expect(Strategy.selectOptimalCard(...args)).toEqual(found.card);
    });
});

describe('opts.onError', () => {
    let S2, SEARCH2, warn;

    beforeEach(() => {
        jest.resetModules();
        warn = jest.fn();
        jest.isolateModules(() => {
            jest.doMock('../../../utils/logger', () => ({ gameLogger: { warn } }));
            jest.doMock('../playSearch', () => {
                const real = jest.requireActual('../playSearch');
                return { ...real, searchCard: () => { throw new TypeError('forced search failure'); } };
            });
            S2 = require('../BotStrategy');
            SEARCH2 = require('../playSearch').SEARCH;
        });
    });

    afterEach(() => {
        jest.dontMock('../../../utils/logger');
        jest.dontMock('../playSearch');
    });

    const trump = { suit: 'spades', rank: '2' };
    const hand = [{ suit: 'hearts', rank: 'K' }, { suit: 'hearts', rank: '4' }, { suit: 'diamonds', rank: '9' }];
    const none = [undefined, undefined, undefined, undefined];
    const memory = { playedCards: [], trumpPlayed: [], acesPlayed: {}, trickIndex: 0, totalCardsPlayed: 0 };
    const ctx = { playerBids: ['1', '1', '0', '0'], bids: { team1: 1, team2: 1 }, tricks: { team1: 0, team2: 0 }, team1Mult: 1, team2Mult: 1 };

    test('replaces noteSearchError: rule card, SEARCH.errors and the log untouched', () => {
        const onError = jest.fn();
        const trace = {};
        const card = S2.selectOptimalCard(hand.slice(), none.slice(), null, null, trump, false, 1, memory, 3, ctx, 'mary', { trace, onError });
        expect(card).toBe(trace.ruleCard);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0]).toBeInstanceOf(TypeError);
        expect(onError.mock.calls[0].slice(1)).toEqual([3, 3]);
        expect(SEARCH2.errors || 0).toBe(0);
        expect(warn).not.toHaveBeenCalled();

        // Without it the bots' path still counts and logs
        S2.selectOptimalCard(hand.slice(), none.slice(), null, null, trump, false, 1, memory, 3, ctx, 'mary');
        expect(SEARCH2.errors).toBe(1);
        expect(warn).toHaveBeenCalledTimes(1);
    });
});

describe('cardMemory and tableView', () => {
    test('BotPlayer keeps its memory in cardMemory and delegates', () => {
        const trump = { suit: 'hearts', rank: '2' };
        const bot = new BotPlayer('x', 'mary');
        expect(bot.getMemorySnapshot()).toBeNull();
        bot.resetCardMemory(3, trump);
        bot.recordCardPlayed({ suit: 'hearts', rank: 'A' }, 2, trump, 2);
        bot.recordCardPlayed({ suit: 'clubs', rank: 'A' }, 3, trump, 2);
        bot.advanceTrick();
        expect(bot.cardMemory).toEqual({
            playedCards: [
                { suit: 'hearts', rank: 'A', position: 2, trickIndex: 0, isLead: true },
                { suit: 'clubs', rank: 'A', position: 3, trickIndex: 0, isLead: false }
            ],
            trumpPlayed: [{ rank: 'A', position: 2 }],
            acesPlayed: { spades: false, hearts: true, diamonds: false, clubs: true },
            trickIndex: 1
        });
        expect(Object.keys(bot).sort()).toEqual(['cardMemory', 'gameId', 'partnerHistory', 'personality', 'pic', 'position', 'socketId', 'username']);
        const snap = bot.getMemorySnapshot();
        expect(snap.totalCardsPlayed).toBe(2);
        snap.playedCards.push('x');
        expect(bot.cardMemory.playedCards).toHaveLength(2);
    });

    test('fromHistory never needs a BotPlayer and handles no trump card', () => {
        expect(cardMemory.fromHistory(null, [])).toEqual(cardMemory.getMemorySnapshot(cardMemory.resetCardMemory()));
    });

    test('openTrick lives in tableView; seatLifecycle re-exports it', () => {
        // Fresh requires: the onError tests above reset the module registry
        const seatLifecycle = require('../../../socket/seatLifecycle');
        expect(seatLifecycle.openTrick).toBe(require('../../tableView').openTrick);
        const game = { playedCardsIndex: 2, leadPosition: 4, playedCards: [{ suit: 'spades', rank: '3' }, null, null, { suit: 'spades', rank: 'K' }] };
        expect(tableView.openTrick(game)).toEqual({ lead: 4, cards: [{ suit: 'spades', rank: 'K' }, { suit: 'spades', rank: '3' }] });
        expect(tableView.openTrick({ playedCardsIndex: 0, leadPosition: 1, playedCards: [] })).toBeNull();
    });
});
