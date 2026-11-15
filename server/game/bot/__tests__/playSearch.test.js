/**
 * playSearch: the exact solver against a plain rules.js minimax, and the
 * search's guard rails (scope, incomplete memory, determinism, never losing
 * a winnable trick as last to play).
 */

const rules = require('../../rules');
const { Solver, searchCard, readPosition, sampleDeal, pickByBidFit, teamScore, SEARCH } = require('../playSearch');
const { selectOptimalCard, getLegalCards, estimateOwnTricks } = require('../BotStrategy');

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const card = (suit, rank) => ({ suit, rank });
const isTrump = (c, trump) => c.suit === 'joker' || c.suit === trump.suit;
const code = (c) => (c.suit === 'joker' ? 4 : SUITS.indexOf(c.suit)) * 17 + rules.RANK_VALUES[c.rank];

function fullDeck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push(card(s, r));
    d.push(card('joker', 'HI'), card('joker', 'LO'));
    return d;
}

function shuffle(d, rng) {
    for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
}

/** Tricks the side of `me` takes with every hand visible: plain minimax over rules.js. */
function minimax(hands, played, lead, tb, trump, me) {
    const n = played.filter(Boolean).length;
    if (n === 4) {
        const w = rules.determineWinner(played, lead, trump);
        const won = (w & 1) === (me & 1) ? 1 : 0;
        if (hands[1].length + hands[2].length + hands[3].length + hands[4].length === 0) return won;
        return won + minimax(hands, [undefined, undefined, undefined, undefined], w, tb, trump, me);
    }
    const pos = ((lead - 1 + n) % 4) + 1;
    const hand = hands[pos];
    const leadCard = played[lead - 1];
    const maxing = (pos & 1) === (me & 1);
    let best = maxing ? -1 : 99;
    for (const c of hand) {
        const rest = hand.filter(x => x !== c);
        if (!rules.isLegalMove(c, rest, leadCard || c, n === 0, trump, tb, pos, lead)) continue;
        const h2 = hands.slice();
        h2[pos] = rest;
        const p2 = played.slice();
        p2[pos - 1] = c;
        const v = minimax(h2, p2, lead, tb || isTrump(c, trump), trump, me);
        if (maxing ? v > best : v < best) best = v;
    }
    return best;
}

describe('Solver', () => {
    test('matches a rules.js minimax on random deals, mid-trick roots and no-trump included', () => {
        const rng = mulberry32(20261114);
        const solver = new Solver();
        let checks = 0;
        let noTrumpDeals = 0;
        let hiDeals = 0;
        for (let t = 0; t < 700; t++) {
            const hs = 2 + Math.floor(rng() * 3);
            let d = fullDeck();
            // A short deck most of the time, so suits and trump interact
            if (rng() < 0.7) {
                const keep = SUITS.slice(0, 2 + Math.floor(rng() * 3));
                d = d.filter(c => c.suit === 'joker' || (keep.includes(c.suit) && RANKS.indexOf(c.rank) >= 6));
            }
            shuffle(d, rng);
            if (d.length < 4 * hs + 1) continue;
            const hands = [null];
            for (let p = 1; p <= 4; p++) hands[p] = d.slice((p - 1) * hs, p * hs);
            const trump = d[4 * hs];
            if (trump.suit === 'joker') noTrumpDeals++;
            if ([1, 2, 3, 4].some(p => hands[p].some(c => c.rank === 'HI'))) hiDeals++;

            const lead = 1 + Math.floor(rng() * 4);
            let tb = rng() < 0.5;
            const k = Math.floor(rng() * 4);
            const played = [undefined, undefined, undefined, undefined];
            const table = [];
            for (let i = 0; i < k; i++) {
                const pos = ((lead - 1 + i) % 4) + 1;
                const hand = hands[pos];
                const legal = hand.filter(c => rules.isLegalMove(c, hand.filter(x => x !== c), played[lead - 1] || c, i === 0, trump, tb, pos, lead));
                const c = legal[Math.floor(rng() * legal.length)];
                hands[pos] = hand.filter(x => x !== c);
                played[pos - 1] = c;
                table.push({ card: c, owner: pos, onTable: true });
                if (isTrump(c, trump)) tb = true;
            }
            const me = ((lead - 1 + k) % 4) + 1;
            const myHand = hands[me];
            const legal = myHand.filter(c => rules.isLegalMove(c, myHand.filter(x => x !== c), played[lead - 1] || c, k === 0, trump, tb, me, lead));

            const live = [];
            for (let p = 1; p <= 4; p++) for (const c of hands[p]) live.push({ card: c, owner: p });
            for (const x of table) live.push(x);
            solver.load(live, trump.suit === 'joker' ? 4 : SUITS.indexOf(trump.suit), me);
            solver.nodes = 0;
            solver.nodeLimit = Infinity;
            let handsMask = 0;
            for (let p = 1; p <= 4; p++) handsMask |= solver.handMask[p];
            solver.setTable(table.map(x => solver.index.get(code(x.card))));
            let guess = Math.floor(rng() * (myHand.length + 1));
            for (const c of legal) {
                const h2 = hands.slice();
                h2[me] = myHand.filter(x => x !== c);
                const p2 = played.slice();
                p2[me - 1] = c;
                const want = minimax(h2, p2, lead, tb || isTrump(c, trump), trump, me);
                guess = solver.valueAfter(handsMask, lead, tb, me, c, guess, myHand.length);
                expect(guess).toBe(want);
                checks++;
            }
        }
        expect(checks).toBeGreaterThan(1000);
        expect(noTrumpDeals).toBeGreaterThan(10);
        expect(hiDeals).toBeGreaterThan(100);
    });

    test('stops at its node limit', () => {
        const rng = mulberry32(3);
        const d = shuffle(fullDeck(), rng);
        const live = [];
        for (let p = 1; p <= 4; p++) for (const c of d.slice((p - 1) * 7, p * 7)) live.push({ card: c, owner: p });
        const solver = new Solver();
        solver.load(live, 0, 1);
        solver.nodes = 0;
        solver.nodeLimit = 50;
        solver.setTable([]);
        let handsMask = 0;
        for (let p = 1; p <= 4; p++) handsMask |= solver.handMask[p];
        const lead = d.slice(0, 7).find(c => !isTrump(c, { suit: 'spades' })) || d[0];
        expect(() => solver.valueAfter(handsMask, 1, true, 1, lead, 3, 7)).toThrow();
        expect(solver.nodes).toBeLessThanOrEqual(51);
    });
});

/** Play a hand out with selectOptimalCard in every seat, calling `onDecision` for each play. */
function playHand(rng, hs, onDecision) {
    const d = shuffle(fullDeck(), rng);
    const hands = [null];
    for (let p = 1; p <= 4; p++) hands[p] = d.slice((p - 1) * hs, p * hs);
    const trump = d[4 * hs];
    const memory = { playedCards: [], trumpPlayed: [], acesPlayed: {}, trickIndex: 0, totalCardsPlayed: 0 };
    const tricks = { team1: 0, team2: 0 };
    const bid = Math.floor(hs / 3);
    const ctx = () => ({
        playerBids: [String(bid), '1', '0', '0'],
        bids: { team1: bid, team2: 1 },
        tricks: { ...tricks },
        team1Mult: 1,
        team2Mult: 1
    });
    let lead = 1 + Math.floor(rng() * 4);
    let tb = false;
    for (let t = 0; t < hs; t++) {
        const played = [undefined, undefined, undefined, undefined];
        let leadCard = null;
        for (let i = 0; i < 4; i++) {
            const pos = ((lead - 1 + i) % 4) + 1;
            const hand = hands[pos];
            const legal = getLegalCards(hand, leadCard, i === 0, trump, tb, pos, lead);
            const snapshot = { ...memory, playedCards: memory.playedCards.slice() };
            const chosen = selectOptimalCard(hand, played, leadCard, i === 0 ? null : lead, trump, tb, pos, snapshot, hs, ctx(), 'mary');
            onDecision({ hand, legal, chosen, played: played.slice(), lead, leadCard, i, pos, trump, tb, memory: snapshot, hs, ctx: ctx() });
            expect(legal).toContain(chosen);
            hands[pos] = hand.filter(c => c !== chosen);
            played[pos - 1] = chosen;
            if (i === 0) leadCard = chosen;
            if (isTrump(chosen, trump)) tb = true;
            memory.playedCards.push({ suit: chosen.suit, rank: chosen.rank, position: pos, trickIndex: memory.trickIndex, isLead: pos === lead });
        }
        const w = rules.determineWinner(played, lead, trump);
        tricks[w % 2 === 1 ? 'team1' : 'team2']++;
        memory.trickIndex++;
        lead = w;
    }
}

describe('searchCard', () => {
    test('whole hands: every play is legal, and the last seat never loses a trick it could win', () => {
        const rng = mulberry32(77);
        let lastSeatLosses = 0;
        let searched = 0;
        for (let g = 0; g < 30; g++) {
            const hs = [3, 4, 5, 6, 7, 9][g % 6];
            playHand(rng, hs, (s) => {
                if (s.hand.length <= SEARCH.maxCards && s.legal.length > 1) searched++;
                if (s.i !== 3) return;
                const after = s.played.slice();
                after[s.pos - 1] = s.chosen;
                const winner = rules.determineWinner(after, s.lead, s.trump);
                if ((winner & 1) === (s.pos & 1)) return;
                lastSeatLosses++;
                for (const c of s.legal) {
                    const alt = s.played.slice();
                    alt[s.pos - 1] = c;
                    expect(rules.determineWinner(alt, s.lead, s.trump)).not.toBe(s.pos);
                }
            });
        }
        expect(searched).toBeGreaterThan(150);
        expect(lastSeatLosses).toBeGreaterThan(10);
    });

    test('the same position always gives the same card, and Math.random is never used', () => {
        const rng = mulberry32(5);
        const seen = [];
        playHand(rng, 6, (s) => seen.push(s));
        const spy = jest.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random used'); });
        try {
            let compared = 0;
            for (const s of seen) {
                if (s.legal.length < 2) continue;
                const q = {
                    hand: s.hand, legal: s.legal, ruleCard: s.legal[0], playedCards: s.played, leadPosition: s.i === 0 ? null : s.lead,
                    trump: s.trump, trumpBroken: s.tb, position: s.pos, memory: s.memory, handSize: s.hs, playContext: s.ctx
                };
                const a = searchCard(q);
                const b = searchCard(q);
                expect(b).toBe(a);
                compared++;
            }
            expect(compared).toBeGreaterThan(5);
        } finally {
            spy.mockRestore();
        }
    });

    test('keeps out when the memory does not cover the hand (a bot seated mid-hand)', () => {
        const rng = mulberry32(9);
        const seen = [];
        playHand(rng, 6, (s) => seen.push(s));
        const late = seen.find(s => s.hand.length === 3 && s.legal.length > 1);
        expect(late).toBeDefined();
        const q = {
            hand: late.hand, legal: late.legal, ruleCard: late.legal[0], playedCards: late.played, leadPosition: late.i === 0 ? null : late.lead,
            trump: late.trump, trumpBroken: late.tb, position: late.pos, handSize: late.hs, playContext: late.ctx
        };
        const stats = {};
        searchCard({ ...q, memory: late.memory, stats });
        expect(stats.samples).toBeGreaterThanOrEqual(SEARCH.minSamples);
        // No memory, a memory missing one trick, and a memory without lead flags
        expect(searchCard({ ...q, memory: null })).toBeNull();
        const short = { ...late.memory, playedCards: late.memory.playedCards.slice(4) };
        expect(searchCard({ ...q, memory: short })).toBeNull();
        const unflagged = { ...late.memory, playedCards: late.memory.playedCards.map(e => ({ ...e, isLead: undefined })) };
        expect(searchCard({ ...q, memory: unflagged })).toBeNull();
    });

    test('out of scope: big hands and forced plays return null', () => {
        const hand = fullDeck().filter(c => c.suit === 'hearts').slice(0, SEARCH.maxCards + 1);
        const base = {
            playedCards: [undefined, undefined, undefined, undefined], leadPosition: null, trump: card('spades', '2'),
            trumpBroken: false, position: 1, memory: { playedCards: [], trickIndex: 0 }, playContext: null
        };
        expect(searchCard({ ...base, hand, legal: hand, ruleCard: hand[0], handSize: hand.length })).toBeNull();
        const two = hand.slice(0, 2);
        expect(searchCard({ ...base, hand: two, legal: [two[0]], ruleCard: two[0], handSize: 2 })).toBeNull();
    });

    test('sampled deals respect shown voids and the cap a HI-joker lead puts on an opponent', () => {
        // Hearts trump. Trick 0: seat 1 led the HI joker, seat 2 (an opponent)
        // followed with the 9 of hearts, so it holds no higher trump; seat 3
        // followed low, seat 4 threw a club, so it has no trump at all.
        const trump = card('hearts', '2');
        const memory = {
            trickIndex: 1,
            playedCards: [
                { suit: 'joker', rank: 'HI', position: 1, trickIndex: 0, isLead: true },
                { suit: 'hearts', rank: '9', position: 2, trickIndex: 0, isLead: false },
                { suit: 'hearts', rank: '3', position: 3, trickIndex: 0, isLead: false },
                { suit: 'clubs', rank: '4', position: 4, trickIndex: 0, isLead: false }
            ]
        };
        const hand = [card('spades', 'A'), card('spades', '5'), card('diamonds', 'K')];
        const pos = readPosition(hand, [undefined, undefined, undefined, undefined], null, trump, 1, memory, 4);
        expect(pos).not.toBeNull();
        const rng = mulberry32(1);
        for (let i = 0; i < 200; i++) {
            const deal = sampleDeal(pos, rng);
            if (!deal) continue;
            expect(deal[2].every(c => !isTrump(c, trump) || rules.RANK_VALUES[c.rank] < rules.RANK_VALUES['9'])).toBe(true);
            expect(deal[4].every(c => !isTrump(c, trump))).toBe(true);
            expect(deal[2]).toHaveLength(3);
            expect(deal[3]).toHaveLength(3);
            expect(deal[4]).toHaveLength(3);
            const all = [...deal[2], ...deal[3], ...deal[4]].map(code);
            expect(new Set(all).size).toBe(9);
            for (const c of [...hand, trump, ...memory.playedCards]) expect(all).not.toContain(code(c));
        }
    });

    test('bid fit: sampled hands lean toward what their owners bid', () => {
        // 4-card hand, hearts trump, nothing played. Seat 2 bid 3, seat 4 bid 0:
        // the deals kept should give seat 2 clearly more trick-taking power.
        const trump = card('hearts', '2');
        const hand = [card('spades', '7'), card('spades', '5'), card('diamonds', '6'), card('clubs', '4')];
        const pos = readPosition(hand, [undefined, undefined, undefined, undefined], null, trump, 1, { playedCards: [], trickIndex: 0 }, 4);
        const rng = mulberry32(11);
        const deals = [];
        while (deals.length < 300) {
            const d = sampleDeal(pos, rng);
            if (d) deals.push(d);
        }
        const q = {
            playContext: { playerBids: ['0', '3', '1', '0'] },
            estimateTricks: (h) => estimateOwnTricks(h, trump, 4)
        };
        const kept = pickByBidFit(deals, 60, pos, q, SEARCH, rng);
        expect(kept).toHaveLength(60);
        const mean = (list, seat) => list.reduce((sum, d) => sum + q.estimateTricks(d[seat]), 0) / list.length;
        expect(mean(kept, 2)).toBeGreaterThan(mean(deals, 2) + 0.5);
        expect(mean(kept, 4)).toBeLessThan(mean(deals, 4));
        expect(mean(kept, 2)).toBeGreaterThan(mean(kept, 4) + 1);
        // No bids to go by (or only bores): the first deals are kept as drawn
        expect(pickByBidFit(deals, 60, pos, { ...q, playContext: { playerBids: ['0', 'B', '2B', '3B'] } }, SEARCH, rng)).toEqual(deals.slice(0, 60));
    });

    test('last seat: a player who closed a trick the other side won holds nothing that would have won it', () => {
        // Hearts trump. Trick 0: seat 1 led the K of spades and it held; seat 4,
        // last to play, followed with the 5, so it has no spade above the K.
        // Trick 1: seat 1 led the Q of clubs, seat 2 followed, seat 3 threw a
        // diamond, and seat 4 threw a diamond instead of trumping: no trump.
        const trump = card('hearts', '2');
        const memory = {
            trickIndex: 2,
            playedCards: [
                { suit: 'spades', rank: 'K', position: 1, trickIndex: 0, isLead: true },
                { suit: 'spades', rank: '3', position: 2, trickIndex: 0, isLead: false },
                { suit: 'spades', rank: '4', position: 3, trickIndex: 0, isLead: false },
                { suit: 'spades', rank: '5', position: 4, trickIndex: 0, isLead: false },
                { suit: 'clubs', rank: 'Q', position: 1, trickIndex: 1, isLead: true },
                { suit: 'clubs', rank: '6', position: 2, trickIndex: 1, isLead: false },
                { suit: 'diamonds', rank: '3', position: 3, trickIndex: 1, isLead: false },
                { suit: 'diamonds', rank: '4', position: 4, trickIndex: 1, isLead: false }
            ]
        };
        const hand = [card('spades', '9'), card('diamonds', 'K'), card('clubs', '9')];
        const none = [undefined, undefined, undefined, undefined];
        const rng = mulberry32(2);
        const sample = (pos) => {
            const out = [];
            while (out.length < 200) {
                const d = sampleDeal(pos, rng);
                if (d) out.push(d);
            }
            return out;
        };
        const on = sample(readPosition(hand, none, null, trump, 1, memory, 5));
        expect(on.every(d => d[4].every(c => !isTrump(c, trump) && !(c.suit === 'spades' && c.rank === 'A')))).toBe(true);
        // Seat 2 was not last: it may still hold the ace of spades or a trump
        expect(on.some(d => d[2].some(c => isTrump(c, trump)))).toBe(true);
        // Seat 3 threw off on its partner's winning trick: no inference beyond the club void
        expect(on.some(d => d[3].some(c => isTrump(c, trump)))).toBe(true);
        expect(on.every(d => d[3].every(c => c.suit !== 'clubs'))).toBe(true);
        const off = sample(readPosition(hand, none, null, trump, 1, memory, 5, false));
        expect(off.some(d => d[4].some(c => isTrump(c, trump)))).toBe(true);
    });

    /** Up to `n` sampled deals in at most 4n draws: never loops on a dead position. */
    const boundedSample = (pos, rng, n) => {
        const out = [];
        for (let i = 0; i < 4 * n && out.length < n; i++) {
            const d = sampleDeal(pos, rng);
            if (d) out.push(d);
        }
        return out;
    };

    test('last seat: a player who declines a ruff and ruffs later is read as holding trump again', () => {
        // Hearts trump, 5-card hand. Trick 0: seat 1 led the K of spades and it
        // held; seat 4, last, threw a diamond instead of ruffing (no trump, as
        // read). Trick 1: seat 1 led the Q of spades and seat 4 ruffed with the
        // 5 of hearts, so it did hold trump: the read is lifted. Seat 4 then
        // led the 8 of clubs and seat 1 (the bot) is to play.
        const trump = card('hearts', '2');
        const trick0 = [
            { suit: 'spades', rank: 'K', position: 1, trickIndex: 0, isLead: true },
            { suit: 'spades', rank: '3', position: 2, trickIndex: 0, isLead: false },
            { suit: 'spades', rank: '4', position: 3, trickIndex: 0, isLead: false },
            { suit: 'diamonds', rank: '4', position: 4, trickIndex: 0, isLead: false }
        ];
        const trick1 = (seat4) => [
            { suit: 'spades', rank: 'Q', position: 1, trickIndex: 1, isLead: true },
            { suit: 'spades', rank: '6', position: 2, trickIndex: 1, isLead: false },
            { suit: 'spades', rank: '7', position: 3, trickIndex: 1, isLead: false },
            { ...seat4, position: 4, trickIndex: 1, isLead: false }
        ];
        const ruffed = { trickIndex: 2, playedCards: [...trick0, ...trick1(card('hearts', '5'))] };
        const declinedTwice = { trickIndex: 2, playedCards: [...trick0, ...trick1(card('diamonds', '5'))] };
        const hand = [card('clubs', 'K'), card('clubs', '3'), card('hearts', '9')];
        const table = [undefined, undefined, undefined, card('clubs', '8')];
        const rng = mulberry32(3);

        const lifted = readPosition(hand, table, 4, trump, 1, ruffed, 5);
        expect(lifted).not.toBeNull();
        expect(lifted.loose).toBeNull(); // no read left on anyone
        const seat4 = lifted.others.find(o => o.pos === 4);
        expect(seat4.need).toBe(2);
        expect(lifted.unseen.filter(c => isTrump(c, trump)).every(c => seat4.allowed.has(code(c)))).toBe(true);
        const deals = boundedSample(lifted, rng, 200);
        expect(deals).toHaveLength(200);
        expect(deals.some(d => d[4].some(c => isTrump(c, trump)))).toBe(true);
        // Still void in spades: that one is a rule, not a read
        expect(deals.every(d => d[4].every(c => c.suit !== 'spades'))).toBe(true);

        // Declining twice keeps the read: no trump for seat 4
        const kept = readPosition(hand, table, 4, trump, 1, declinedTwice, 5);
        expect(boundedSample(kept, rng, 200).every(d => d[4].every(c => !isTrump(c, trump)))).toBe(true);

        // The search runs on the lifted read and plays a legal card
        const legal = getLegalCards(hand, table[3], false, trump, true, 1, 4);
        expect(legal).toHaveLength(2);
        const ctx = { playerBids: ['2', '1', '1', '1'], bids: { team1: 3, team2: 2 }, tricks: { team1: 1, team2: 1 }, team1Mult: 1, team2Mult: 1 };
        const stats = {};
        const q = { hand, legal, ruleCard: legal[0], playedCards: table, leadPosition: 4, trump, trumpBroken: true, position: 1, memory: ruffed, handSize: 5, playContext: ctx, stats };
        const found = searchCard(q);
        expect(stats.samples).toBeGreaterThanOrEqual(SEARCH.minSamples);
        if (found !== null) expect(legal).toContain(found);
        const chosen = selectOptimalCard(hand, table, table[3], 4, trump, true, 1, ruffed, 5, ctx, 'mary');
        expect(legal).toContain(chosen);
    });

    test('last seat: reads that leave a hand too few cards are dropped, not a reason to give up', () => {
        // Hearts trump, 7-card hand, the bot (seat 1) holds the top five
        // diamonds. Seat 4 showed out of spades and clubs, each time throwing a
        // diamond instead of ruffing; seats 2 and 3 threw diamonds too. Read
        // literally seat 4 holds only diamonds, and just two are left for its
        // five cards: the reads must be wrong, so the search deals from the
        // rules alone (any trump for seat 4) instead of returning nothing.
        const trump = card('hearts', '2');
        const memory = {
            trickIndex: 2,
            playedCards: [
                { suit: 'spades', rank: 'A', position: 1, trickIndex: 0, isLead: true },
                { suit: 'diamonds', rank: '5', position: 2, trickIndex: 0, isLead: false },
                { suit: 'diamonds', rank: '6', position: 3, trickIndex: 0, isLead: false },
                { suit: 'diamonds', rank: '2', position: 4, trickIndex: 0, isLead: false },
                { suit: 'clubs', rank: 'A', position: 1, trickIndex: 1, isLead: true },
                { suit: 'diamonds', rank: '7', position: 2, trickIndex: 1, isLead: false },
                { suit: 'diamonds', rank: '8', position: 3, trickIndex: 1, isLead: false },
                { suit: 'diamonds', rank: '3', position: 4, trickIndex: 1, isLead: false }
            ]
        };
        const hand = ['A', 'K', 'Q', 'J', '10'].map(r => card('diamonds', r));
        const none = [undefined, undefined, undefined, undefined];
        const pos = readPosition(hand, none, null, trump, 1, memory, 7);
        expect(pos).not.toBeNull();
        expect(pos.loose).toBeNull();
        const deals = boundedSample(pos, mulberry32(4), 100);
        expect(deals.length).toBeGreaterThanOrEqual(SEARCH.minSamples);
        expect(deals.every(d => d[4].length === 5 && d[4].every(c => c.suit !== 'spades' && c.suit !== 'clubs'))).toBe(true);
        expect(deals.some(d => d[4].some(c => isTrump(c, trump)))).toBe(true);
        const ctx = { playerBids: ['3', '1', '1', '1'], bids: { team1: 4, team2: 2 }, tricks: { team1: 2, team2: 0 }, team1Mult: 1, team2Mult: 1 };
        const stats = {};
        const found = searchCard({ hand, legal: hand, ruleCard: hand[4], playedCards: none, leadPosition: null, trump, trumpBroken: false, position: 1, memory, handSize: 7, playContext: ctx, stats });
        expect(stats.samples).toBeGreaterThanOrEqual(SEARCH.minSamples);
        if (found !== null) expect(hand).toContain(found);
    });

    test('teamScore follows the rules', () => {
        expect(teamScore(3, 1, 3)).toBe(30);
        expect(teamScore(3, 1, 5)).toBe(32);
        expect(teamScore(3, 1, 2)).toBe(-30);
        expect(teamScore(12, 2, 12)).toBe(240);
        expect(teamScore(12, 2, 11)).toBe(-240);
        expect(teamScore(0, 1, 2)).toBe(2);
    });
});
