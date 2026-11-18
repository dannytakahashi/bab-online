/**
 * A GameState set up at one decision, for the /help engine's fixtures and
 * tests: four seats named Alice (1), Carol (2), Bob (3) and Dan (4), the
 * given hands, trump, bids and table, in BIDDING or PLAYING, so seatView()
 * reads it exactly as it reads a live game.
 */

'use strict';

const rules = require('../../rules');
const GameState = require('../../GameState');
const { Phase } = require('../../GamePhase');
const { NAMES } = require('./stateGame');

let seq = 0;

/** "A♣" / "10h" / "HI" -> card. */
function card(s) {
    if (typeof s !== 'string') return s;
    if (s === 'HI' || s === 'LO') return { suit: 'joker', rank: s };
    const m = /^(10|[2-9JQKA])([shdc♠♥♦♣])$/.exec(s);
    if (!m) throw new Error(`bad card ${s}`);
    const suit = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs', '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' }[m[2]];
    return { suit, rank: m[1] };
}

/**
 * @param {Object} o
 * @param {number} o.handSize
 * @param {string|Object} o.trump
 * @param {Object} o.hands - {pos: [cards]} (others may be left out)
 * @param {Array} [o.bids] - playerBids by position - 1 (bidding: the bids so far)
 * @param {number} o.turn - the seat on turn
 * @param {'bid'|'play'} [o.stage]
 * @param {Object} [o.score] - {team1, team2}
 * @param {Array} [o.tricks] - won tricks {lead, cards} in play order
 * @param {Object} [o.open] - the open trick {lead, cards}
 * @param {boolean} [o.trumpBroken]
 * @returns {GameState}
 */
function tableAt({ handSize, trump, hands, bids = [], turn, stage = 'bid', score = { team1: 0, team2: 0 }, tricks = [], open = null, trumpBroken = false }) {
    const game = new GameState(`assist-table-${++seq}`);
    game._debugMode = false;
    for (let p = 1; p <= 4; p++) {
        game.createSeat(p, { controller: 'bot', bot: { socketId: `bot:${NAMES[p].toLowerCase()}:${seq}`, username: NAMES[p], pic: p, personality: 'mary' } });
    }
    game.transition(Phase.CREATED, Phase.DRAWING);
    game.transition(Phase.DRAWING, Phase.DRAW_RESOLVING);
    game.transition(Phase.DRAW_RESOLVING, Phase.TEAMS_ANNOUNCED);
    game.transition(Phase.TEAMS_ANNOUNCED, Phase.DEALING);
    game.resetForNewHand(1, handSize);
    game.dealSeq = 1;
    for (let p = 1; p <= 4; p++) game.setHand(game.seat(p).seatSocketId, (hands[p] || []).map(card));
    game.trump = card(trump);
    game.score = { ...score };
    game.transition(Phase.DEALING, Phase.BIDDING);
    bids.forEach((b, i) => { if (b != null) game.recordBid(i + 1, String(b)); });
    if (stage === 'play') {
        const b = game.playerBids;
        game.bids = {
            team1: Math.min(handSize, (rules.BID_RANKS[b[0]] || 0) + (rules.BID_RANKS[b[2]] || 0)),
            team2: Math.min(handSize, (rules.BID_RANKS[b[1]] || 0) + (rules.BID_RANKS[b[3]] || 0))
        };
        game.team1Mult = rules.calculateMultiplier(b[0], b[2]);
        game.team2Mult = rules.calculateMultiplier(b[1], b[3]);
        game.transition(Phase.BIDDING, Phase.PLAYING);
        for (const t of tricks) {
            const cards = t.cards.map(card);
            const p4 = [];
            cards.forEach((c, k) => { p4[(t.lead - 1 + k) % 4] = c; });
            const winner = rules.determineWinner(p4, t.lead, game.trump);
            game.tricks[winner % 2 ? 'team1' : 'team2']++;
            game.trickHistory.push({ winner, lead: t.lead, cards });
            game.cardIndex += 4;
            game.leadCard = cards[0];
            game.leadPosition = t.lead;
        }
        game.isTrumpBroken = trumpBroken;
        if (open && open.cards.length) {
            game.leadPosition = open.lead;
            open.cards.map(card).forEach((c, k) => {
                if (k === 0) game.leadCard = c;
                game.playedCards[(open.lead - 1 + k) % 4] = c;
                game.playedCardsIndex++;
                game.cardIndex++;
            });
        }
    }
    game.currentTurn = turn;
    return game;
}

module.exports = { tableAt, card };
