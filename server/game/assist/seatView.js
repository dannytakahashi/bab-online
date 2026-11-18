/**
 * What one seat may know, as a frozen plain object: the ONLY input of the
 * /help explainer (advise.js, explain.js) and the only file in
 * server/game/assist that reads a GameState (a test holds every other file
 * to that, and a Proxy game in fairness.test.js throws on any read outside
 * the list below).
 *
 * Read from `game`: the seat records (names, the seat socket), the seat's
 * OWN hand, the trump card, the stage and turn, the bids, the score, the
 * cards on the table, the contract (BotController.buildPlayContext: public
 * bids, tricks, multipliers) and the hand's public record (trickHistory and
 * the open trick, from which cardMemory rebuilds exactly the memory a bot
 * in this seat would hold). Never another seat's hand.
 *
 * Every card, array and object is a copy, deep-frozen, so nothing in the
 * engine can change the game through it. Pure: no I/O, no Math.random, no
 * Date.
 */

'use strict';

const { Phase } = require('../GamePhase');
const { getPartnerPosition, rotatePosition, isLegalPlay, isValidBid, BID_VALUES } = require('../rules');
const { openTrick } = require('../tableView');
const cardMemory = require('../bot/cardMemory');
const { buildPlayContext } = require('../bot/BotController');

/** The SeatView keys (pinned by seatView.test.js). */
const KEYS = Object.freeze([
    'position', 'partner', 'others', 'names',
    'hand', 'trump', 'isTrumpBroken', 'handSize',
    'stage', 'turnKey', 'currentTurn',
    'playerBids', 'score', 'currentHand',
    'playedCards', 'leadCard', 'leadPosition',
    'playContext', 'memory', 'legal'
]);

const copyCard = (c) => (c ? { suit: c.suit, rank: c.rank } : c);

function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
}

/** A sparse bids array copied with its holes and length (the bots read it as is). */
function copyBids(bids) {
    const out = new Array(bids.length);
    for (let i = 0; i < bids.length; i++) if (i in bids) out[i] = bids[i];
    return out;
}

/** The table cards by position - 1 (sparse, as the bots read them). */
function copyPlayed(played) {
    const out = new Array(played.length);
    for (let i = 0; i < played.length; i++) if (i in played) out[i] = copyCard(played[i]);
    return out;
}

/**
 * @param {Object} game - GameState
 * @param {number} pos - 1-4
 * @returns {Object|null} the frozen SeatView, or null outside a bid or play
 *   turn stage, for an empty seat or before trump is known
 */
function seatView(game, pos) {
    const stageName = game.stage;
    const stage = stageName === Phase.BIDDING ? 'bid' : stageName === Phase.PLAYING ? 'play' : null;
    if (!stage) return null;
    const seat = game.seat(pos);
    if (!seat || !game.trump) return null;

    const names = {};
    for (let p = 1; p <= 4; p++) {
        const shown = game.getPlayerByPosition(p);
        names[p] = shown ? shown.username : null;
    }
    const hand = game.getHand(seat.seatSocketId).map(copyCard);
    const trump = copyCard(game.trump);
    const handSize = game.currentHand;
    const team1 = pos === 1 || pos === 3;
    const playerBids = copyBids(game.playerBids);
    const playedCards = copyPlayed(game.playedCards);
    const leadCard = copyCard(game.leadCard);
    const leadPosition = game.leadPosition;
    const isTrumpBroken = game.isTrumpBroken;
    const ctx = buildPlayContext(game);
    const playContext = {
        playerBids: copyBids(ctx.playerBids),
        bids: ctx.bids ? { team1: ctx.bids.team1, team2: ctx.bids.team2 } : null,
        tricks: ctx.tricks ? { team1: ctx.tricks.team1, team2: ctx.tricks.team2 } : null,
        team1Mult: ctx.team1Mult,
        team2Mult: ctx.team2Mult
    };
    const open = openTrick(game);
    const memory = cardMemory.fromHistory(trump, game.trickHistory, open);

    let legal;
    if (stage === 'bid') {
        legal = BID_VALUES.filter((b) => isValidBid(b, playerBids, handSize));
    } else {
        const leading = !game.playedCardsIndex;
        const trick = { leadCard, isLeading: leading, trump, trumpBroken: isTrumpBroken, position: pos, leadPosition };
        legal = hand.filter((c) => isLegalPlay(c, hand, trick));
    }

    return deepFreeze({
        position: pos,
        partner: getPartnerPosition(pos),
        others: [rotatePosition(pos), rotatePosition(rotatePosition(rotatePosition(pos)))],
        names,
        hand,
        trump,
        isTrumpBroken,
        handSize,
        stage,
        turnKey: game.turnKey(),
        currentTurn: game.currentTurn,
        playerBids,
        score: {
            mine: team1 ? game.score.team1 : game.score.team2,
            theirs: team1 ? game.score.team2 : game.score.team1
        },
        currentHand: handSize,
        playedCards,
        leadCard,
        leadPosition,
        playContext,
        memory,
        legal
    });
}

module.exports = { seatView, KEYS, deepFreeze };
