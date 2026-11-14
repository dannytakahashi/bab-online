/**
 * Search-based card play for small endings.
 *
 * When few cards remain, the bot samples full deals of the unseen cards
 * ("determinizations") consistent with everything it has observed (its own
 * hand, every card played, shown voids and HI-joker forced plays), solves each sampled deal exactly (double dummy), and plays the
 * card with the best average hand score (own team's points minus the
 * opponents'). Outside its scope, or whenever anything about the position is
 * unclear, it returns null and the caller keeps the rule-based card.
 *
 * Determinism: the sampler is seeded from the position itself and the effort
 * limit is a node count, never a clock, so a decision is a pure function of
 * what the bot has seen (the sims, wire goldens and iOS fixtures rely on it).
 */

const { RANK_VALUES } = require('../rules');

// Local bindings: the solver's inner loops call these millions of times, and
// a lookup through the global object is far slower under Jest's sandbox
const { clz32, imul, floor, min, max, abs } = Math;

const SEARCH = {
    /** Search only when the bot holds at most this many cards. */
    maxCards: 7,
    /** ...and at most this many when it leads (leads cost the most to solve). */
    maxCardsLead: 7,
    /** Sampled deals per decision (fewer when the node budget runs out). */
    samples: 64,
    /** Fewest solved deals a decision may rest on. */
    minSamples: 8,
    /** Stop sampling once this many solver nodes are spent... */
    nodeBudget: 200000,
    /** ...and give up the deal being solved past this many (hard limit per decision). */
    nodeHardCap: 300000,
    /** Diagnostics: set to an array to collect [cards held, cards on table,
     *  deals solved, nodes] for every search (profiling only). */
    trace: null
};

const SUIT_ID = { spades: 0, hearts: 1, diamonds: 2, clubs: 3 };
const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const SIDE_RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6D2B79F5) | 0;
        let t = imul(a ^ (a >>> 15), 1 | a);
        t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Suit index of a card; jokers belong to the trump suit (4 in no-trump). */
function suitOf(card, trumpSuitId) {
    return card.suit === 'joker' ? trumpSuitId : SUIT_ID[card.suit];
}

function cardCode(card) {
    return (card.suit === 'joker' ? 4 : SUIT_ID[card.suit]) * 17 + RANK_VALUES[card.rank];
}

/**
 * Exact solver for one fully known deal of at most 32 live cards.
 * Cards are bits ordered by (suit, rank); a state is the mask of unplayed
 * cards plus who leads and whether trump is broken. Value = tricks the
 * searching bot's team takes from here on. Mirrors rules.isLegalMove and
 * rules.determineWinner (follow suit, no trump lead until broken unless
 * trump-tight, HI-joker lead forces the leader's opponents to their highest
 * trump).
 */
const TT_BITS = 16;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const TT_SHIFT = 32 - TT_BITS;
const TT_PROBES = 16;

class Solver {
    constructor() {
        this.owner = new Int8Array(32);
        this.suit = new Int8Array(32);
        this.rv = new Int8Array(32);
        this.isTr = new Uint8Array(32);
        this.isHI = new Uint8Array(32);
        this.handMask = [0, 0, 0, 0, 0];
        this.suitMask = [0, 0, 0, 0, 0];
        this.trumpMask = 0;
        this.trick = new Int8Array(64);
        this.ttH1 = new Int32Array(TT_SIZE);
        this.ttMeta = new Int32Array(TT_SIZE);
        this.ttVal = new Uint8Array(TT_SIZE);
        this.ttH2 = new Int32Array(TT_SIZE);
        this.stamp = 0;
        this.nodes = 0;
        this.nodeLimit = Infinity;
        this.maxParity = 1;
        this.n = 0;
    }

    /**
     * @param {Array<{card: Object, owner: number}>} cards - every live card
     *   (hands plus the cards already on the table), owner = position 1-4
     */
    load(cards, trumpSuitId, myPosition) {
        const all = cards.map(e => ({ e, s: suitOf(e.card, trumpSuitId), r: RANK_VALUES[e.card.rank] }));
        all.sort((a, b) => a.s - b.s || a.r - b.r);
        this.n = all.length;
        this.handMask = [0, 0, 0, 0, 0];
        this.suitMask = [0, 0, 0, 0, 0];
        this.trumpMask = 0;
        this.index = new Map();
        for (let k = 0; k < all.length; k++) {
            const { e, s, r } = all[k];
            this.owner[k] = e.owner;
            this.suit[k] = s;
            this.rv[k] = r;
            this.isTr[k] = s === trumpSuitId ? 1 : 0;
            this.isHI[k] = e.card.rank === 'HI' ? 1 : 0;
            this.index.set(cardCode(e.card), k);
            if (!e.onTable) this.handMask[e.owner] |= (1 << k);
            this.suitMask[s] |= (1 << k);
            if (s === trumpSuitId) this.trumpMask |= (1 << k);
        }
        this.maxParity = myPosition & 1;
        // A new stamp empties the table
        if (++this.stamp >= (1 << 28)) { this.stamp = 1; this.ttMeta.fill(0); }
    }

    legal(mask, pos, i, leadIdx, tb, leader) {
        const hand = mask & this.handMask[pos];
        if (i === 0) {
            if (!tb) {
                const nonTrump = hand & ~this.trumpMask;
                return nonTrump !== 0 ? nonTrump : hand;
            }
            return hand;
        }
        const follow = hand & this.suitMask[this.suit[leadIdx]];
        if (follow === 0) return hand;
        if (this.isHI[leadIdx] && ((pos ^ leader) & 1)) {
            return 1 << (31 - clz32(follow)); // forced: highest trump
        }
        return follow;
    }

    /**
     * Value at a trick boundary, with transposition-table bounds.
     *
     * Two positions play out the same when, suit by suit, the unplayed cards
     * belong to the same players in the same rank order (and the HI joker,
     * whose lead forces trump, is or is not among them). The table is keyed
     * by a 64-bit hash of that shape, the leader and the trump-broken flag,
     * so positions reached by spending different small cards share an entry.
     */
    ab(mask, leader, tb, alpha, beta, base) {
        if (mask === 0) return 0;
        const lead = mask & this.handMask[leader];
        if ((lead & (lead - 1)) === 0) {
            // Last trick: every card is forced
            let wi = 31 - clz32(lead);
            let w = leader;
            const ls = this.suit[wi];
            for (let i = 1; i < 4; i++) {
                const pos = ((leader - 1 + i) % 4) + 1;
                const c = 31 - clz32(mask & this.handMask[pos]);
                if (this.beatsIdx(c, wi, ls)) { wi = c; w = pos; }
            }
            return (w & 1) === this.maxParity ? 1 : 0;
        }
        const meta = (this.stamp << 3) | ((leader - 1) << 1) | (tb ? 1 : 0);
        let h1 = 0x2545F491;
        let h2 = 0x61C88647;
        let prevSuit = -1;
        for (let m = mask; m !== 0; m &= m - 1) {
            const c = 31 - clz32(m & -m);
            const sc = this.suit[c];
            if (sc !== prevSuit) {
                prevSuit = sc;
                h1 = imul(h1 ^ (sc + 8), 0x9E3779B1);
                h2 = imul(h2 + sc + 8, 0x85EBCA6B);
            }
            const o = this.owner[c] + (this.isHI[c] << 3);
            h1 = (imul(h1 ^ o, 0x9E3779B1) + 0x7F4A7C15) | 0;
            h2 = imul(h2 + o, 0xC2B2AE35) ^ (h2 >>> 15);
        }
        const home = imul(h1 ^ (meta << 27), 0x9E3779B1) >>> TT_SHIFT;
        let slot = home;
        let found = false;
        for (let probes = 0; probes < TT_PROBES; probes++) {
            if (this.ttMeta[slot] === meta && this.ttH1[slot] === h1 && this.ttH2[slot] === h2) { found = true; break; }
            if ((this.ttMeta[slot] >>> 3) !== this.stamp) break; // empty, or left from an earlier deal
            slot = (slot + 1) & TT_MASK;
        }
        let lo = 0;
        let hi = 99;
        if (found) {
            const e = this.ttVal[slot];
            lo = e & 15;
            hi = e >> 4;
            if (lo >= beta) return lo;
            if (hi <= alpha) return hi;
            if (lo === hi) return lo;
            if (lo > alpha) alpha = lo;
            if (hi < beta) beta = hi;
        } else {
            let c = lead;
            let k = 0;
            while (c) { c &= c - 1; k++; }
            hi = k; // can't take more tricks than remain
            // Sure tricks for the side on lead: a leader free to lead trump
            // cashes the top trumps it holds; once nobody else has a trump it
            // cashes the top cards of every suit (and all its trumps)
            const leadTrump = lead & this.trumpMask;
            const trumpFree = tb || leadTrump === lead;
            let sure = 0;
            if ((mask & this.trumpMask) === leadTrump) {
                let tops = 0;
                for (let s = 0; s < 5; s++) {
                    const sm = this.suitMask[s] & ~this.trumpMask;
                    for (let m = mask & sm; m !== 0;) {
                        const bit = 1 << (31 - clz32(m));
                        if ((lead & bit) === 0) break;
                        tops |= bit;
                        sure++;
                        m &= ~bit;
                    }
                }
                if (leadTrump !== 0 && (trumpFree || (lead & ~this.trumpMask) === tops)) {
                    for (let m = leadTrump; m !== 0; m &= m - 1) sure++;
                }
            } else if (trumpFree) {
                for (let tm = mask & this.trumpMask; tm !== 0;) {
                    const bit = 1 << (31 - clz32(tm));
                    if ((lead & bit) === 0) break;
                    sure++;
                    tm &= ~bit;
                }
            }
            if (sure > 0) {
                if ((leader & 1) === this.maxParity) lo = sure; else hi = k - sure;
            }
            if (lo >= beta) return lo;
            if (hi <= alpha) return hi;
            if (lo > alpha) alpha = lo;
            if (hi < beta) beta = hi;
        }
        const v = this.inTrick(mask, leader, tb, 0, -1, alpha, beta, base, -1, 0);
        if (v <= alpha) hi = v;
        else if (v >= beta) lo = v;
        else { lo = v; hi = v; }
        if (lo > hi) { lo = v; hi = v; }
        // The search below wrote entries of its own: find this one's place again
        slot = home;
        for (let probes = 0; probes < TT_PROBES; probes++) {
            const free = (this.ttMeta[slot] >>> 3) !== this.stamp;
            if (free || (this.ttMeta[slot] === meta && this.ttH1[slot] === h1 && this.ttH2[slot] === h2)) {
                this.ttMeta[slot] = meta;
                this.ttH1[slot] = h1;
                this.ttH2[slot] = h2;
                this.ttVal[slot] = lo | (hi << 4);
                break;
            }
            slot = (slot + 1) & TT_MASK;
        }
        return v;
    }

    /**
     * Search inside a trick. `wi` is the card winning the trick so far and
     * `wj` how many seats after the leader played it.
     */
    inTrick(mask, leader, tb, i, leadIdx, alpha, beta, base, wi, wj) {
        if (++this.nodes > this.nodeLimit) throw Solver.LIMIT;
        if (i === 4) {
            const w = ((leader - 1 + wj) % 4) + 1;
            const won = (w & 1) === this.maxParity ? 1 : 0;
            return won + this.ab(mask, w, tb, alpha - won, beta - won, base + 4);
        }
        const pos = ((leader - 1 + i) % 4) + 1;
        const moves = this.legal(mask, pos, i, leadIdx, tb, leader);
        const maxing = (pos & 1) === this.maxParity;
        let best = maxing ? -1 : 99;
        let live = mask;
        for (let j = 0; j < i; j++) live |= (1 << this.trick[base + j]);

        if (i === 0) {
            // Leads: high cards first
            let m = moves;
            let prev = -1;
            while (m) {
                const c = 31 - clz32(m);
                m &= ~(1 << c);
                // Touching cards of one hand are the same play (HI aside:
                // leading it forces trump)
                if (prev >= 0 && this.suit[prev] === this.suit[c] && !this.isHI[prev]) {
                    const between = live & ((1 << prev) - 1) & ~((1 << (c + 1)) - 1);
                    if (between === 0) { prev = c; continue; }
                }
                prev = c;
                this.trick[base] = c;
                const v = this.inTrick(mask & ~(1 << c), leader, tb || this.isTr[c] === 1, 1, c, alpha, beta, base, c, 0);
                if (maxing) { if (v > best) best = v; if (best > alpha) alpha = best; }
                else { if (v < best) best = v; if (best < beta) beta = best; }
                if (alpha >= beta) break;
            }
            return best;
        }

        // Follows: with partner ahead try the cheap losers first, otherwise
        // the cheapest winner first
        const ls = this.suit[leadIdx];
        const above = wi === 31 ? 0 : ~((1 << (wi + 1)) - 1);
        const win = this.isTr[wi]
            ? moves & this.trumpMask & above
            : (moves & this.suitMask[ls] & above) | (moves & this.trumpMask);
        const lose = moves & ~win;
        const partnerAhead = ((wj ^ i) & 1) === 0;
        for (let phase = 0; phase < 2; phase++) {
            const winners = partnerAhead ? phase === 1 : phase === 0;
            let m = winners ? win : lose;
            let prev = -1;
            while (m) {
                const c = 31 - clz32(m & -m);
                m &= m - 1;
                // (HI is never merged: holding it keeps the forcing lead)
                if (prev >= 0 && this.suit[prev] === this.suit[c] && !this.isHI[c]) {
                    const between = live & ((1 << c) - 1) & ~((1 << (prev + 1)) - 1);
                    if (between === 0) { prev = c; continue; }
                }
                prev = c;
                this.trick[base + i] = c;
                const v = winners
                    ? this.inTrick(mask & ~(1 << c), leader, tb || this.isTr[c] === 1, i + 1, leadIdx, alpha, beta, base, c, i)
                    : this.inTrick(mask & ~(1 << c), leader, tb || this.isTr[c] === 1, i + 1, leadIdx, alpha, beta, base, wi, wj);
                if (maxing) { if (v > best) best = v; if (best > alpha) alpha = best; }
                else { if (v < best) best = v; if (best < beta) beta = best; }
                if (alpha >= beta) return best;
            }
        }
        return best;
    }

    /** Set the cards already on the table (bit indices, in play order). */
    setTable(tableIdx) {
        this.tableN = tableIdx.length;
        this.tableWi = -1;
        this.tableWj = 0;
        for (let j = 0; j < tableIdx.length; j++) {
            const c = tableIdx[j];
            this.trick[j] = c;
            if (j === 0 || this.beatsIdx(c, this.tableWi, this.suit[tableIdx[0]])) { this.tableWi = c; this.tableWj = j; }
        }
        this.values = new Map();
    }

    /** Does card c beat the winning card wi of a trick led in suit ls? */
    beatsIdx(c, wi, ls) {
        if (this.isTr[c]) return !this.isTr[wi] || this.rv[c] > this.rv[wi];
        return !this.isTr[wi] && this.suit[c] === ls && this.rv[c] > this.rv[wi];
    }

    /**
     * Exact value of the searching bot playing `card` now, by null-window
     * probes (MTD(f)) starting from `guess`.
     * @param {number} handsMask - unplayed cards of all four hands
     * @param {number} maxV - tricks still to be decided (the bot's hand length)
     */
    valueAfter(handsMask, leader, trumpBroken, myPos, card, guess, maxV) {
        let c = this.index.get(cardCode(card));
        const n = this.tableN;
        // Touching cards in the bot's own hand are one play: solve the top one
        // (never HI: holding it keeps the forcing lead)
        if (!this.isHI[c]) {
            const mine = this.handMask[myPos];
            while (c + 1 < this.n && this.suit[c + 1] === this.suit[c] && ((mine >>> (c + 1)) & 1) && !this.isHI[c + 1]) c++;
        }
        const known = this.values.get(c);
        if (known !== undefined) return known;

        let wi = this.tableWi, wj = this.tableWj;
        const leadIdx = n === 0 ? c : this.trick[0];
        if (n === 0 || this.beatsIdx(c, wi, this.suit[leadIdx])) { wi = c; wj = n; }
        const rest = handsMask & ~(1 << c);
        const tb = trumpBroken || this.isTr[c] === 1;
        let lo = 0, hi = maxV, g = max(0, min(maxV, guess));
        while (lo < hi) {
            const beta = g === lo ? g + 1 : g;
            this.trick[n] = c;
            const v = this.inTrick(rest, leader, tb, n + 1, leadIdx, beta - 1, beta, 0, wi, wj);
            if (v < beta) hi = max(lo, min(hi, v));
            else lo = min(hi, max(lo, v));
            g = v < beta ? hi : lo;
        }
        this.values.set(c, lo);
        return lo;
    }
}
Solver.LIMIT = { limit: true };

/** Points a team scores for the hand (rainbows aside). */
function teamScore(bid, mult, tricks) {
    return tricks >= bid ? bid * 10 * mult + (tricks - bid) : -bid * 10 * mult;
}

/**
 * Everything the bot knows about the unseen cards.
 * @returns {Object|null} null when the memory does not cover the whole hand
 *   (a bot that took the seat mid-hand), so the caller must not search
 */
function readPosition(hand, playedCards, leadPosition, trump, position, memory, handSize) {
    const noTrump = trump.suit === 'joker';
    const trumpSuitId = noTrump ? 4 : SUIT_ID[trump.suit];

    // Cards on the table, in play order
    const table = [];
    if (leadPosition) {
        for (let i = 0; i < 4; i++) {
            const pos = ((leadPosition - 1 + i) % 4) + 1;
            const c = playedCards[pos - 1];
            if (c === undefined || c === null) break;
            table.push({ card: c, owner: pos });
        }
    }
    const onTable = playedCards.filter(c => c !== undefined && c !== null).length;
    if (onTable !== table.length || table.some(t => t.owner === position)) return null;

    const seen = new Set();
    seen.add(cardCode(trump));
    for (const c of hand) seen.add(cardCode(c));
    for (const t of table) seen.add(cardCode(t.card));

    // What each other player cannot hold: voidIn[pos][suit], and a rank cap
    // per suit (cap[pos][suit]: nothing above this rank) after a forced play
    // under a HI-joker lead.
    const voidIn = [null, [], [], [], []];
    const cap = [null, [99, 99, 99, 99, 99], [99, 99, 99, 99, 99], [99, 99, 99, 99, 99], [99, 99, 99, 99, 99]];

    const noteTrick = (entries, leadEntry) => {
        const ls = suitOf(leadEntry, trumpSuitId);
        for (const e of entries) {
            if (e === leadEntry) continue;
            const s = suitOf(e, trumpSuitId);
            if (s !== ls) voidIn[e.position][ls] = true;
            else if (leadEntry.rank === 'HI' && ((e.position ^ leadEntry.position) & 1)) {
                cap[e.position][s] = min(cap[e.position][s], RANK_VALUES[e.rank]);
            }
        }
    };

    let pastCards = 0;
    if (memory && Array.isArray(memory.playedCards)) {
        const tableCodes = new Set(table.map(t => cardCode(t.card)));
        const tricks = new Map();
        for (const e of memory.playedCards) {
            const code = cardCode(e);
            if (tableCodes.has(code)) continue; // the current trick is read from the table
            if (seen.has(code)) return null; // contradicts the hand or a duplicate
            seen.add(code);
            pastCards++;
            if (!tricks.has(e.trickIndex)) tricks.set(e.trickIndex, []);
            tricks.get(e.trickIndex).push(e);
        }
        for (const entries of tricks.values()) {
            if (entries.length !== 4) return null;
            const leadEntry = entries.find(e => e.isLead);
            if (!leadEntry) return null;
            noteTrick(entries, leadEntry);
        }
    }
    if (pastCards !== 4 * (handSize - hand.length)) return null;
    if (table.length > 0) {
        const entries = table.map(t => ({ suit: t.card.suit, rank: t.card.rank, position: t.owner }));
        noteTrick(entries, entries[0]);
    }

    // Unseen cards: either in another hand or never dealt
    const unseen = [];
    for (const suit of SUITS) {
        for (const rank of SIDE_RANKS) {
            const c = { suit, rank };
            if (!seen.has(cardCode(c))) unseen.push(c);
        }
    }
    for (const rank of ['LO', 'HI']) {
        const c = { suit: 'joker', rank };
        if (!seen.has(cardCode(c))) unseen.push(c);
    }

    const others = [];
    for (let i = 1; i <= 3; i++) {
        const pos = ((position - 1 + i) % 4) + 1;
        const need = hand.length - (table.some(t => t.owner === pos) ? 1 : 0);
        const allowed = unseen.filter(c => {
            const s = suitOf(c, trumpSuitId);
            if (voidIn[pos][s]) return false;
            if (RANK_VALUES[c.rank] > cap[pos][s]) return false;
            return true;
        });
        if (allowed.length < need) return null;
        others.push({ pos, need, allowed: new Set(allowed.map(cardCode)), allowedCount: allowed.length });
    }
    // Most constrained hand is dealt first
    others.sort((a, b) => (a.allowedCount - a.need) - (b.allowedCount - b.need));

    return { trumpSuitId, table, unseen, others };
}

/** One sampled deal of the unseen cards, or null if the draw dead-ends. */
function sampleDeal(pos, rng) {
    const pool = pos.unseen.slice();
    for (let i = pool.length - 1; i > 0; i--) {
        const j = floor(rng() * (i + 1));
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const taken = new Uint8Array(pool.length);
    const hands = {};
    for (const o of pos.others) {
        const h = [];
        for (let i = 0; i < pool.length && h.length < o.need; i++) {
            if (!taken[i] && o.allowed.has(cardCode(pool[i]))) { taken[i] = 1; h.push(pool[i]); }
        }
        if (h.length < o.need) return null;
        hands[o.pos] = h;
    }
    return hands;
}

const solver = new Solver();

/**
 * Pick a card by sampled double-dummy search.
 *
 * @param {Object} q
 * @param {Array} q.hand - the bot's hand
 * @param {Array} q.legal - its legal cards (more than one)
 * @param {Object} q.ruleCard - the rule-based choice (kept on a tie)
 * @param {Array} q.playedCards - current trick, indexed by position-1
 * @param {number|null} q.leadPosition
 * @param {Object} q.trump
 * @param {boolean} q.trumpBroken
 * @param {number} q.position
 * @param {Object|null} q.memory
 * @param {number} q.handSize
 * @param {Object|null} q.playContext
 * @param {Object} [q.options] - overrides of SEARCH
 * @param {Object} [q.stats] - filled with {samples, nodes} when given
 * @returns {Object|null} the card to play, or null to keep the rule-based card
 */
function searchCard(q) {
    const opt = q.options ? { ...SEARCH, ...q.options } : SEARCH;
    const { hand, legal, ruleCard, playedCards, trump, trumpBroken, position, memory, handSize, playContext } = q;
    if (!trump || !ruleCard || !legal || legal.length < 2) return null;
    if (hand.length > opt.maxCards || hand.length < 2) return null;

    const isLeading = playedCards.every(c => c === undefined || c === null);
    if (isLeading && hand.length > opt.maxCardsLead) return null;
    const leadPosition = isLeading ? position : q.leadPosition;
    if (!leadPosition) return null;

    const pos = readPosition(hand, playedCards, isLeading ? null : leadPosition, trump, position, memory, handSize);
    if (!pos) return null;

    // Contract: score the hand for both teams from our final trick count
    const isTeam1 = position === 1 || position === 3;
    let myBid = 0, oppBid = 0, myMult = 1, oppMult = 1, myTricks = 0, oppTricks = 0;
    if (playContext && playContext.bids && playContext.tricks) {
        const b = playContext.bids, t = playContext.tricks;
        myBid = (isTeam1 ? b.team1 : b.team2) || 0;
        oppBid = (isTeam1 ? b.team2 : b.team1) || 0;
        myTricks = (isTeam1 ? t.team1 : t.team2) || 0;
        oppTricks = (isTeam1 ? t.team2 : t.team1) || 0;
        myMult = (isTeam1 ? playContext.team1Mult : playContext.team2Mult) || 1;
        oppMult = (isTeam1 ? playContext.team2Mult : playContext.team1Mult) || 1;
    }
    if (myTricks + oppTricks !== handSize - hand.length) return null;
    const utility = [];
    for (let v = 0; v <= hand.length; v++) {
        utility.push(teamScore(myBid, myMult, myTricks + v) - teamScore(oppBid, oppMult, oppTricks + hand.length - v));
    }

    // Last to play with the trick there to be won: never consider losing it
    let candidates = legal;
    if (pos.table.length === 3) {
        const lead = pos.table[0].card;
        let top = pos.table[0];
        for (let i = 1; i < 3; i++) {
            if (beats(pos.table[i].card, top.card, lead, pos.trumpSuitId)) top = pos.table[i];
        }
        if (((top.owner ^ position) & 1) === 1) {
            const winners = legal.filter(c => beats(c, top.card, lead, pos.trumpSuitId));
            if (winners.length > 0) candidates = winners;
        }
        if (candidates.length === 1) return candidates[0] === ruleCard ? null : candidates[0];
    }

    // Seed from the position so the same view always gives the same card
    let seed = 0x9E3779B9 ^ (position * 2654435761) ^ (handSize << 8) ^ cardCode(trump);
    for (const c of hand) seed = (imul(seed ^ cardCode(c), 16777619) + 0x7F4A7C15) | 0;
    for (const t of pos.table) seed = imul(seed ^ (cardCode(t.card) + 97), 16777619) | 0;
    seed ^= pos.unseen.length * 40503;
    const rng = mulberry32(seed);

    const deals = [];
    for (let tries = 0; deals.length < opt.samples && tries < opt.samples * 4; tries++) {
        const d = sampleDeal(pos, rng);
        if (d) deals.push(d);
    }
    if (deals.length < opt.minSamples) return null;

    const totals = new Float64Array(candidates.length);
    const ruleIdx = candidates.indexOf(ruleCard);
    let solved = 0;
    solver.nodes = 0;
    const row = new Float64Array(candidates.length);
    for (const deal of deals) {
        if (solver.nodes >= opt.nodeBudget && solved >= opt.minSamples) break;
        const live = [];
        for (const c of hand) live.push({ card: c, owner: position });
        for (const o of pos.others) for (const c of deal[o.pos]) live.push({ card: c, owner: o.pos });
        for (const t of pos.table) live.push({ card: t.card, owner: t.owner, onTable: true });
        solver.load(live, pos.trumpSuitId, position);
        let handsMask = 0;
        for (let p = 1; p <= 4; p++) handsMask |= solver.handMask[p];
        const tableIdx = pos.table.map(t => solver.index.get(cardCode(t.card)));
        solver.setTable(tableIdx);
        solver.nodeLimit = opt.nodeHardCap;
        let guess = (hand.length + 1) >> 1;
        try {
            for (let k = 0; k < candidates.length; k++) {
                guess = solver.valueAfter(handsMask, leadPosition, trumpBroken, position, candidates[k], guess, hand.length);
                row[k] = utility[guess];
            }
        } catch (e) {
            if (e === Solver.LIMIT) break;
            throw e;
        }
        for (let k = 0; k < candidates.length; k++) totals[k] += row[k];
        solved++;
        // Too costly a position to reach the minimum: stop early
        if (solved === 1 && solver.nodes * opt.minSamples > opt.nodeHardCap * 1.5) break;
    }
    if (q.stats) { q.stats.samples = solved; q.stats.nodes = solver.nodes; }
    if (opt.trace) opt.trace.push([hand.length, pos.table.length, solved, solver.nodes, candidates.length]);
    if (solved < opt.minSamples) return null;

    let best = 0;
    for (let k = 1; k < candidates.length; k++) {
        if (totals[k] > totals[best] + 1e-9) best = k;
        else if (abs(totals[k] - totals[best]) <= 1e-9 && cheaper(candidates[k], candidates[best], pos.trumpSuitId)) best = k;
    }
    if (ruleIdx < 0) return candidates[best];
    if (best === ruleIdx) return null;
    // On an exact tie the rule-based card stands
    if (totals[ruleIdx] >= totals[best] - 1e-9) return null;
    return candidates[best];
}

/** Does card a beat card b (b currently winning) given the lead card? */
function beats(a, b, lead, trumpSuitId) {
    const sa = suitOf(a, trumpSuitId), sb = suitOf(b, trumpSuitId), sl = suitOf(lead, trumpSuitId);
    const ta = sa === trumpSuitId, tb = sb === trumpSuitId;
    if (ta && !tb) return true;
    if (ta && tb) return RANK_VALUES[a.rank] > RANK_VALUES[b.rank];
    if (!tb && sa === sl && sb === sl) return RANK_VALUES[a.rank] > RANK_VALUES[b.rank];
    return false;
}

/** Tie-break between equal cards: spend the lesser one (non-trump first, then low rank). */
function cheaper(a, b, trumpSuitId) {
    const ta = suitOf(a, trumpSuitId) === trumpSuitId, tb = suitOf(b, trumpSuitId) === trumpSuitId;
    if (ta !== tb) return !ta;
    return RANK_VALUES[a.rank] < RANK_VALUES[b.rank];
}

module.exports = { searchCard, Solver, SEARCH, readPosition, sampleDeal, teamScore };
