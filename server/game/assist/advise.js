/**
 * The /help suggestion (plan D1): exactly what a Mary bot in this seat
 * would bid or play, from the seat's SeatView alone, with the decision
 * trace that explain.js turns into words.
 *
 *  - bids: BotStrategy.calculateOptimalBid(..., 'mary', [], trace)
 *  - plays: BotStrategy.selectOptimalCard(..., 'mary', {trace, onError,
 *    searchOptions}) with the default search settings; budget 'rules'
 *    passes {maxCards: 0} (the rules-only fallback when the server is busy)
 *
 * Never reads a GameState (seatView.js does), never mutates the view (the
 * strategy gets copies), never calls Math.random (Mary's paths draw none),
 * a clock, a uuid or anything that makes a bot (createSeatBot, new
 * BotPlayer). A search error goes to `onError` (default: ignored), never to
 * SEARCH.errors or the bots' search-error log.
 */

'use strict';

const { calculateOptimalBid, selectOptimalCard } = require('../bot/BotStrategy');
const { SEARCH } = require('../bot/playSearch');

const PERSONALITY = 'mary';

const copyCard = (c) => (c ? { suit: c.suit, rank: c.rank } : c);
const copyArray = (a, f = (x) => x) => {
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i++) if (i in a) out[i] = f(a[i]);
    return out;
};

/** A mutable copy of the view's memory for the strategy (the view is frozen). */
function copyMemory(m) {
    if (!m) return m;
    return {
        playedCards: m.playedCards.map((e) => ({ ...e })),
        trumpPlayed: m.trumpPlayed.map((e) => ({ ...e })),
        acesPlayed: { ...m.acesPlayed },
        trickIndex: m.trickIndex,
        totalCardsPlayed: m.totalCardsPlayed
    };
}

function copyContext(c) {
    return {
        playerBids: copyArray(c.playerBids),
        bids: c.bids ? { ...c.bids } : null,
        tricks: c.tricks ? { ...c.tricks } : null,
        team1Mult: c.team1Mult,
        team2Mult: c.team2Mult
    };
}

const noop = () => {};

/** Would the search look at this play (selectOptimalCard's own gate)? */
function searchEligible(view) {
    return view.hand.length >= 2 && view.hand.length <= SEARCH.maxCards && view.legal.length >= 2;
}

/**
 * @param {Object|null} view - seatView()
 * @param {Object} [o]
 * @param {'full'|'rules'} [o.budget] - 'rules': no search (Quick suggestion)
 * @param {Function} [o.onError] - (err, cardsInHand, handSize) for an error
 *   inside the search (the rule card is suggested then)
 * @returns {Object|null} Decision {kind, bid, card, forced, source, trace},
 *   or null when the seat has no decision to make (not its turn, already bid,
 *   empty hand)
 */
function advise(view, { budget = 'full', onError = noop } = {}) {
    if (!view || view.currentTurn !== view.position) return null;
    const pos = view.position;

    if (view.stage === 'bid') {
        if (view.playerBids[pos - 1] != null) return null;
        const trace = {};
        const gameContext = { teamScore: view.score.mine, oppScore: view.score.theirs, currentHandSize: view.handSize };
        const bid = calculateOptimalBid(
            view.hand.map(copyCard), copyCard(view.trump), pos, copyArray(view.playerBids), view.handSize,
            copyMemory(view.memory), gameContext, PERSONALITY, [], trace
        );
        return Object.freeze({
            kind: 'bid',
            bid: String(bid),
            card: null,
            forced: false,
            source: trace.bid && trace.bid.path === 'ev' ? 'ev' : 'rules',
            trace
        });
    }

    if (view.stage !== 'play' || view.hand.length === 0) return null;
    const trace = {};
    const opts = { trace, onError };
    const quick = budget === 'rules' && searchEligible(view);
    if (budget === 'rules') opts.searchOptions = { maxCards: 0 };
    const card = selectOptimalCard(
        view.hand.map(copyCard),
        copyArray(view.playedCards, copyCard),
        copyCard(view.leadCard),
        view.leadPosition,
        copyCard(view.trump),
        view.isTrumpBroken,
        pos,
        copyMemory(view.memory),
        view.handSize,
        copyContext(view.playContext),
        PERSONALITY,
        opts
    );
    const searched = !!(trace.search && trace.search.samples >= SEARCH.minSamples);
    return Object.freeze({
        kind: 'card',
        bid: null,
        card: copyCard(card),
        forced: view.legal.length === 1,
        source: quick ? 'quick' : searched || (trace.search && trace.search.onlyWinner) ? 'search' : 'rules',
        trace
    });
}

module.exports = { advise, PERSONALITY, searchEligible };
