/**
 * The bot of a Get Your Bid table (gameMode.js; owner 2026-11-24): a simple
 * exact-bid player, the same for every personality. The base game's
 * BotStrategy plays a 4-seat team contract (partner signals, bores, sets)
 * and is not used at these tables.
 *
 * Bid: the hand's expected tricks, from the base game's HSI (hsi.js: the
 * expected share of a 4-seat hand's tricks) scaled to 3 seats, rounded, and
 * moved off the Forbidden Bid.
 * Play: while it still needs tricks it tries to win them (cheaply when last
 * to play); once it has its bid it ducks, shedding its highest safe card.
 *
 * Pure: no game, no io, no Math.random.
 */

'use strict';

const { RANK_VALUES, isLegalPlay, gybForbiddenBid, GYB_SEATS } = require('../rules');
const { calculateHSI } = require('../hsi');

const isTrump = (card, trump) => card.suit === 'joker' || card.suit === trump.suit;
const suitOf = (card, trump) => (card.suit === 'joker' ? trump.suit : card.suit);
const rank = (card) => RANK_VALUES[card.rank] || 0;

/** Expected tricks of `hand` at a 3-seat table (a real number). */
function expectedTricks(hand, trump, handSize) {
    const share = Math.max(0, (calculateHSI(hand, trump) - 55) / 300);
    // HSI's share is of a 4-seat hand: three seats split the same tricks
    return Math.min(handSize, share * handSize * (4 / GYB_SEATS));
}

/**
 * @param {Array} hand
 * @param {Object} trump
 * @param {Array} playerBids - the deal's bids so far, by position - 1
 * @param {number} handSize
 * @returns {string} a legal bid
 */
function decideBid(hand, trump, playerBids, handSize) {
    const est = expectedTricks(hand, trump, handSize);
    let bid = Math.max(0, Math.min(handSize, Math.round(est)));
    const forbidden = gybForbiddenBid(playerBids, handSize, GYB_SEATS);
    if (forbidden !== null && bid === forbidden) {
        // The nearer neighbour of the estimate that the hand allows
        const down = bid - 1;
        const up = bid + 1;
        if (down < 0) bid = up;
        else if (up > handSize) bid = down;
        else bid = est >= bid ? up : down;
    }
    return String(bid);
}

/** Does `card` beat `best` in a trick led in `leadSuit`? */
function beats(card, best, leadSuit, trump) {
    const ct = isTrump(card, trump);
    const bt = isTrump(best, trump);
    if (ct && !bt) return true;
    if (ct && bt) return rank(card) > rank(best);
    if (bt) return false;
    const cs = suitOf(card, trump);
    return cs === leadSuit && suitOf(best, trump) === leadSuit && rank(card) > rank(best);
}

/** How strong a card is to lead or hold: trumps above everything, then rank. */
const power = (card, trump) => rank(card) + (isTrump(card, trump) ? 100 : 0);

const byPower = (trump, dir) => (a, b) => dir * (power(a, trump) - power(b, trump));

/**
 * @param {Array} hand - the bot's cards
 * @param {Object} table
 * @param {Array} table.playedCards - this trick's cards by position - 1
 * @param {Object|null} table.leadCard
 * @param {number|null} table.leadPosition
 * @param {Object} table.trump
 * @param {boolean} table.trumpBroken
 * @param {number} table.position - the bot's seat
 * @param {number} table.seatCount
 * @param {number} table.need - tricks the bot still needs for its bid (may be <= 0)
 * @returns {Object|null} a legal card, or null for an empty hand
 */
function decideCard(hand, { playedCards, leadCard, leadPosition, trump, trumpBroken, position, seatCount = GYB_SEATS, need }) {
    const onTable = (playedCards || []).filter(Boolean);
    const isLeading = onTable.length === 0;
    const trick = { leadCard, isLeading, trump, trumpBroken, position, leadPosition, solo: true };
    const legal = hand.filter((c) => isLegalPlay(c, hand, trick));
    if (legal.length === 0) return hand[0] || null;
    if (legal.length === 1) return legal[0];

    const wantsTrick = need > 0;
    if (isLeading) {
        // Needing tricks: the strongest card. With the bid in hand: the weakest
        return [...legal].sort(byPower(trump, wantsTrick ? -1 : 1))[0];
    }

    const leadSuit = suitOf(leadCard, trump);
    let best = leadCard;
    for (const c of onTable) if (beats(c, best, leadSuit, trump)) best = c;
    const winners = legal.filter((c) => beats(c, best, leadSuit, trump));
    const losers = legal.filter((c) => !beats(c, best, leadSuit, trump));
    const last = onTable.length === seatCount - 1;

    if (wantsTrick) {
        if (winners.length > 0) {
            // Last to play: the cheapest winner. Earlier: the strongest,
            // which the seat still to play is least likely to beat
            return [...winners].sort(byPower(trump, last ? 1 : -1))[0];
        }
        // Cannot win: throw the weakest card
        return [...losers].sort(byPower(trump, 1))[0];
    }
    if (losers.length > 0) {
        // Duck, getting rid of the card most likely to win a later trick
        return [...losers].sort(byPower(trump, -1))[0];
    }
    // Every legal card wins for now: the weakest (a later seat may take it),
    // or as the last seat the strongest, since the trick is ours either way
    return [...winners].sort(byPower(trump, last ? -1 : 1))[0];
}

module.exports = { decideBid, decideCard, expectedTricks, beats };
