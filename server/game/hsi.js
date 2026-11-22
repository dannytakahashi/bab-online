'use strict';
/**
 * Hand Strength Index (HSI): the share of the hand's tricks a dealt hand is
 * expected to win, on the same 70 (weak) .. 130 (average) .. 195 (strong)
 * scale as the formula it replaces.
 *
 *   HSI = 55 + 300 x (expected own tricks / hand size), rounded to 0.1
 *
 *   55  = no trick expected            130 = a quarter of the tricks (average)
 *   70  = 5% of the tricks (full red)  195 = 47% of the tricks (full green)
 *   355 = every trick                  3 points = 1% of the tricks
 *
 * Expected own tricks is a sum of card values fitted on 4,000 games of
 * Mary-bot self-play (208,000 dealt hands). A card's worth changes with the
 * hand size (a side ace wins 0.23 tricks in a 1-card hand and 1.0 in a
 * 13-card hand), so every value is a pair [1-card hand, 13-card hand] and is
 * read off a straight line between the two for the sizes in between.
 *
 * Trump deals (the turned card is a suit card), t = (handSize - 1) / 12:
 *   tricks = BASE[handSize]
 *          + SIDE[rank]                         for each side-suit card
 *                                               (only 10, J, Q, K, A count)
 *          + max(TRUMP[rank] + LOWER[k], SIDE[rank])
 *                                               for each trump, jokers
 *                                               included; k = how many lower
 *                                               trumps the hand also holds,
 *                                               capped at 3 (so long trump
 *                                               pays more); a trump is never
 *                                               worth less than the same card
 *                                               in a side suit (a joker: than
 *                                               a side ace)
 *          + VOID per void side suit            } only when the hand holds at
 *          + SINGLETON per 1-card side suit     } least one trump or joker
 *
 * No-trump deals (a joker is turned: the other joker is the only trump),
 * u = 13 x (handSize - 1) / (12 x handSize):
 *   tricks = NT_BASE (at t) + NT_JOKER per joker + NT_RANK[rank] per card (at u)
 *   No void or length terms: a void cannot ruff.
 *
 * tricks is clamped to 0..handSize. The turned card's rank is not used.
 *
 * Monotone by construction: every value is >= 0, every rank ladder is
 * non-decreasing at both ends (so at every size), LOWER is non-decreasing in
 * k, VOID >= SINGLETON >= 0 and a trump is floored at its side value. So a
 * higher card of the same suit, a joker for a trump, or a trump for the
 * same-rank side card never lowers the index. (A side ACE swapped for a LOW
 * trump can lower it in hands of 6+ cards: there a side ace really does win
 * more tricks than a small trump.)
 *
 * The constants below are fitted TOGETHER (non-negative least squares on the
 * training games; measure any change with server/game/bot/sim/hsiEval.js,
 * which has the refit recipe). Do not hand-edit single
 * values: re-run the monotonicity and distribution checks if any change.
 *
 * Pure function of (hand, trump): no bids, seat, partner or history; O(hand
 * size); no dependencies; does not mutate its arguments; independent of the
 * order of the cards. An empty or missing hand returns 0. HSI is shown and
 * summed into stats only, so it never throws: a missing trump, or one whose
 * suit is not spades / hearts / diamonds / clubs, is scored as a no-trump deal.
 *
 * History (owner 2026-11-21, "evaluate it and update it based on our current
 * knowledge of how to best value hand strength"): this replaced the original
 * points count (2 = 0 .. A = 12, any trump + 14, jokers 27 / 28, x 13 / hand
 * size, x 1.25 per void at 9+ cards). Measured on 2,000 held-out self-play
 * games (104,000 dealt hands), the Spearman correlation with the tricks a hand
 * actually took, within each hand size and averaged over the 13 sizes, went
 * from 0.640 to 0.714 (better at every size: +0.03 at 1 card, +0.15 at 13),
 * with the same scale (pooled mean 130.0 vs 130.3, sd 48.8 vs 50.1, the same
 * shares under 70 and over 195). No-trump deals now average 129 (they read 84);
 * 9+ card hands with a void no longer jump 1.25x per void. Four designs were
 * fitted and cross-checked (this table, a bridge-style point count, the bots'
 * own trick model refitted, per-card trick tables); this one ranked best for
 * its size and was the best calibrated. Refit (and re-check monotonicity and
 * the distribution) only if bot play changes a lot.
 */

const RANK_INDEX = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, '10': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12 };
const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const LO = 13, HI = 14;

// ---- trump deals: [tricks in a 1-card hand, tricks in a 13-card hand]
// side card by rank 2..A (2-9 are worth nothing)
const SIDE = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0.058, 0.072], [0.095, 0.147], [0.114, 0.331], [0.151, 0.675], [0.225, 1.009]];
// trump by rank 2..A, then LO joker, HI joker
const TRUMP = [[0.222, 0.153], [0.222, 0.153], [0.222, 0.153], [0.222, 0.153], [0.222, 0.153], [0.374, 0.19], [0.374, 0.19], [0.374, 0.19], [0.414, 0.28], [0.483, 0.351], [0.483, 0.475], [0.54, 0.599], [0.584, 0.755], [0.668, 0.891], [0.724, 1.465]];
// extra for a trump by the number of lower trumps held with it: 0, 1, 2, 3 or more
const LOWER = [[0, 0], [0.253, 0.074], [0.383, 0.298], [0.383, 0.635]];
// short side suits, counted only when the hand holds a trump
const SINGLETON = [0, 0.168];
const VOID = [0.093, 0.616];
// centring constant by hand size 1..13: the average kept hand of every size expects a quarter of the tricks
const BASE = [0.0018, 0.0214, 0.0353, 0.0386, 0.0251, 0.0102, -0.0219, -0.0659, -0.1338, -0.2214, -0.3531, -0.5054, -0.693];

// ---- no-trump deals: [tricks in a 1-card hand, tricks in a 13-card hand]
// card of any suit by rank 2..A (2-7 are worth nothing)
const NT_RANK = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0.068, 0.082], [0.068, 0.082], [0.134, 0.157], [0.134, 0.291], [0.186, 0.567], [0.284, 0.853], [0.318, 1.073]];
const NT_JOKER = [0.828, 1.411];
const NT_BASE = [0.1477, -0.1808];

// ---- scale: HSI = HSI_ZERO + HSI_PER_SHARE x share of the tricks
const HSI_ZERO = 55;
const HSI_PER_SHARE = 300;

const at = (pair, t) => pair[0] + (pair[1] - pair[0]) * t;

/** Rank index 0..12 of a suit card, or -1 for anything unknown (scored as a low card). */
function rankIndex(card) {
    const r = RANK_INDEX[card.rank];
    return typeof r === 'number' ? r : -1;
}

function trumpDealTricks(hand, trumpSuit, size) {
    const t = (size - 1) / 12;                 // linear in hand size
    const sideCount = new Array(13).fill(0);   // side cards by rank
    const trumpCount = new Array(15).fill(0);  // trumps by rank, jokers on top
    const suitLength = { spades: 0, hearts: 0, diamonds: 0, clubs: 0 };
    let trumps = 0;
    for (const card of hand) {
        if (card.suit === 'joker') {
            trumpCount[card.rank === 'HI' ? HI : LO]++;
            trumps++;
            continue;
        }
        const r = rankIndex(card);
        if (card.suit === trumpSuit) {
            trumpCount[r < 0 ? 0 : r]++;
            trumps++;
        } else {
            if (r >= 0) sideCount[r]++;
            if (typeof suitLength[card.suit] === 'number') suitLength[card.suit]++;
        }
    }

    // Cards are tallied by rank first and summed in rank order, so the
    // result does not depend on the order of the hand
    let tricks = BASE[size - 1];
    for (let r = 8; r < 13; r++) {
        if (sideCount[r]) tricks += sideCount[r] * at(SIDE[r], t);
    }
    let lower = 0; // trumps already counted, all lower than the current one
    for (let r = 0; r < 15; r++) {
        for (let k = trumpCount[r]; k > 0; k--) {
            const asTrump = at(TRUMP[r], t) + at(LOWER[lower < 3 ? lower : 3], t);
            const asSide = at(SIDE[r < 12 ? r : 12], t);
            tricks += asTrump > asSide ? asTrump : asSide;
            lower++;
        }
    }
    if (trumps > 0) {
        for (const suit of SUITS) {
            if (suit === trumpSuit) continue;
            if (suitLength[suit] === 0) tricks += at(VOID, t);
            else if (suitLength[suit] === 1) tricks += at(SINGLETON, t);
        }
    }
    return tricks;
}

function noTrumpDealTricks(hand, size) {
    const u = (13 * (size - 1)) / (12 * size); // values level off quickly: linear in 1 / hand size
    const count = new Array(13).fill(0);
    let jokers = 0;
    for (const card of hand) {
        if (card.suit === 'joker') { jokers++; continue; }
        const r = rankIndex(card);
        if (r >= 0) count[r]++;
    }
    let tricks = at(NT_BASE, (size - 1) / 12) + jokers * at(NT_JOKER, u);
    for (let r = 6; r < 13; r++) {
        if (count[r]) tricks += count[r] * at(NT_RANK[r], u);
    }
    return tricks;
}

/**
 * Expected own tricks for a dealt hand, clamped to 0..hand size.
 * @param {Array<{suit: string, rank: string}>} hand - the dealt hand
 * @param {{suit: string, rank: string}} trump - the turned card
 * @returns {number}
 */
function expectedTricks(hand, trump) {
    if (!hand || hand.length === 0) return 0;
    const trumpSuit = trump ? trump.suit : undefined;
    // a joker turned (or, defensively, no usable trump suit): a no-trump deal
    const noTrump = SUITS.indexOf(trumpSuit) === -1;
    const n = hand.length;
    const size = n > 13 ? 13 : n; // not a legal hand; read the 13-card values
    const tricks = noTrump ? noTrumpDealTricks(hand, size) : trumpDealTricks(hand, trumpSuit, size);
    return tricks < 0 ? 0 : tricks > n ? n : tricks;
}

/**
 * Hand Strength Index.
 * @param {Array<{suit: string, rank: string}>} hand - the dealt hand (1..13 cards)
 * @param {{suit: string, rank: string}} trump - the turned card
 * @returns {number} HSI to one decimal: 55 = no trick expected, 130 = an
 *   average hand, 355 = every trick; 0 for an empty hand
 */
function hsi(hand, trump) {
    if (!hand || hand.length === 0) return 0;
    const share = expectedTricks(hand, trump) / hand.length;
    return Math.round((HSI_ZERO + HSI_PER_SHARE * share) * 10) / 10;
}

module.exports = { calculateHSI: hsi, expectedTricks, HSI_ZERO, HSI_PER_SHARE };
