/**
 * A seeded bot game played on a real GameState, for the /help engine's
 * tests and scripts (agreement, hidden-hand shuffle, coverage, fixtures,
 * the threshold sim). It is simulate.js's game loop with the table kept in
 * a GameState the way the socket handlers keep it, so seatView() reads the
 * same fields it reads in production:
 *  - deal: resetForNewHand, dealSeq, setHand, trump, bot memory reset,
 *    DEALING -> BIDDING (gameHandlers.dealHand)
 *  - bids: applyBid, currentTurn rotation; after four, team bids, multipliers
 *    and the lead, or an all-zero redeal (handlePostBid)
 *  - plays: applyPlay, every bot told the card (notifyCardPlayed), the 4th
 *    card -> TRICK_RESOLVING; then tricks, trickHistory, winner leads,
 *    advanceTrick, table cleared (resumeTrick)
 *  - hand end: calculateScore with rainbows (handleHandComplete)
 * Each seat is a BotPlayer that decides exactly as BotController does
 * (decideBid with the score context, decideCard with buildPlayContext),
 * unless `decide` replaces the choice. The socket handlers themselves are
 * exercised by the real-handler test (unperturbed.test.js).
 *
 * Math.random is seeded (mulberry32) for the length of the game and
 * restored after. The hooks run with that RNG installed: a hook that draws
 * from it shifts the game (the /help engine never does; the tests prove it).
 */

'use strict';

const rules = require('../../rules');
const GameState = require('../../GameState');
const { Phase } = require('../../GamePhase');
const BotPlayer = require('../../bot/BotPlayer');
const { buildPlayContext } = require('../../bot/BotController');

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
/** Seat names: Alice (1) and Bob (3) against Carol (2) and Dan (4). */
const NAMES = { 1: 'Alice', 2: 'Carol', 3: 'Bob', 4: 'Dan' };

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

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

const sameCard = (a, b) => !!a && !!b && a.suit === b.suit && a.rank === b.rank;

/**
 * Play one game.
 * @param {Object} o
 * @param {number} o.seed
 * @param {string[]} [o.personalities] - by position 1-4 (default all 'mary')
 * @param {number} [o.hands] - play only the first n hands of the progression
 * @param {Function} [o.makeBot] - (name, personality) => a BotPlayer (or a
 *   subclass deciding with another strategy); default new BotPlayer
 * @param {Function} [o.onTurn] - (game, pos, bot, kind) before each decision
 * @param {Function} [o.decide] - (game, pos, bot, kind, botChoice) => the
 *   bid/card to play instead (undefined: the bot's choice); runs after the
 *   bot decided, so the bot's RNG draws are the same either way
 * @param {Function} [o.onDecision] - (game, pos, bot, kind, played, botChoice)
 *   after the choice is applied
 * @param {Function} [o.onHandEnd] - (game, info) after each hand is scored
 * @returns {{game, score: {team1, team2}, decisions: number}}
 */
function playStateGame({ seed, personalities = ['mary', 'mary', 'mary', 'mary'], hands = rules.HAND_PROGRESSION.length,
    makeBot = (name, personality) => new BotPlayer(name, personality), onTurn, decide, onDecision, onHandEnd } = {}) {
    const realRandom = Math.random;
    Math.random = mulberry32(seed);
    try {
        const game = new GameState(`assist-sim-${seed}`);
        game._debugMode = false; // no per-action console lines
        const bots = {};
        for (let p = 1; p <= 4; p++) {
            const bot = makeBot(NAMES[p], personalities[p - 1]);
            bot.assignToGame(game.gameId, p, p);
            bots[p] = bot;
            game.createSeat(p, { controller: 'bot', bot });
        }
        game.transition(Phase.CREATED, Phase.DRAWING);
        game.transition(Phase.DRAWING, Phase.DRAW_RESOLVING);
        game.transition(Phase.DRAW_RESOLVING, Phase.TEAMS_ANNOUNCED);
        game.transition(Phase.TEAMS_ANNOUNCED, Phase.DEALING);

        let decisions = 0;
        let dealer = 1;
        const sizes = rules.HAND_PROGRESSION.slice(0, hands);
        for (let h = 0; h < sizes.length; h++) {
            const hs = sizes[h];
            // ----- Deal and bid (an all-zero table redeals) -----
            for (let redeal = 0; ; redeal++) {
                game.resetForNewHand(dealer, hs);
                game.dealSeq = (game.dealSeq || 0) + 1;
                const deck = freshDeck();
                const sids = game.getSocketIds();
                sids.forEach((sid, i) => game.setHand(sid, deck.slice(i * hs, (i + 1) * hs)));
                game.trump = deck[4 * hs];
                for (let p = 1; p <= 4; p++) bots[p].resetCardMemory(hs, game.trump);
                game.currentTurn = game.bidder;
                game.transition(Phase.DEALING, Phase.BIDDING);

                for (let i = 0; i < 4; i++) {
                    const pos = game.currentTurn;
                    const bot = bots[pos];
                    if (onTurn) onTurn(game, pos, bot, 'bid');
                    const ctx = {
                        teamScore: pos % 2 ? game.score.team1 : game.score.team2,
                        oppScore: pos % 2 ? game.score.team2 : game.score.team1,
                        currentHandSize: game.currentHand
                    };
                    const botBid = bot.decideBid(game.getHand(bot.socketId), game.trump, game.playerBids, game.currentHand, ctx);
                    const chosen = decide ? decide(game, pos, bot, 'bid', botBid) : undefined;
                    let result = game.applyBid(pos, chosen === undefined ? botBid : chosen);
                    if (!result.ok) result = game.applyBid(pos, rules.safeBid(game.playerBids));
                    decisions++;
                    if (onDecision) onDecision(game, pos, bot, 'bid', result.bid, botBid);
                    game.currentTurn = rules.rotatePosition(game.currentTurn);
                }

                const b = game.playerBids;
                game.bids = {
                    team1: Math.min(hs, (rules.BID_RANKS[b[0]] || 0) + (rules.BID_RANKS[b[2]] || 0)),
                    team2: Math.min(hs, (rules.BID_RANKS[b[1]] || 0) + (rules.BID_RANKS[b[3]] || 0))
                };
                game.team1Mult = rules.calculateMultiplier(b[0], b[2]);
                game.team2Mult = rules.calculateMultiplier(b[1], b[3]);
                if (game.bids.team1 === 0 && game.bids.team2 === 0 && redeal < 200) {
                    game.transition(Phase.BIDDING, Phase.REDEAL);
                    game.transition(Phase.REDEAL, Phase.DEALING);
                    continue;
                }
                break;
            }
            const lead = rules.findHighestBidder(game.bidder, game.playerBids) + 1;
            game.transition(Phase.BIDDING, Phase.PLAYING);
            game.currentTurn = lead;
            game.leadPosition = lead;
            if (hs === 4) {
                for (let p = 1; p <= 4; p++) {
                    if (rules.isRainbow(game.getHand(bots[p].socketId), game.trump)) game.rainbows[p % 2 ? 'team1' : 'team2']++;
                }
            }

            // ----- Play -----
            for (let t = 0; t < hs; t++) {
                for (let i = 0; i < 4; i++) {
                    const pos = game.currentTurn;
                    const bot = bots[pos];
                    if (onTurn) onTurn(game, pos, bot, 'play');
                    const hand = game.getHand(bot.socketId);
                    const botCard = bot.decideCard(hand, game.playedCards, game.leadCard, game.leadPosition,
                        game.trump, game.isTrumpBroken, game.currentHand, buildPlayContext(game));
                    const chosen = decide ? decide(game, pos, bot, 'play', botCard) : undefined;
                    let card = chosen === undefined ? botCard : chosen;
                    card = card && hand.find((c) => sameCard(c, card));
                    if (!card || !game.checkPlay(pos, card, bot.socketId).ok) card = game.firstLegalCard(pos);
                    const res = game.applyPlay(pos, card, bot.socketId);
                    if (!res.ok) throw new Error(`stateGame: play refused (${res.reason})`);
                    for (let q = 1; q <= 4; q++) bots[q].recordCardPlayed(card, pos, game.trump, game.leadPosition);
                    decisions++;
                    if (onDecision) onDecision(game, pos, bot, 'play', card, botCard);
                    game.currentTurn = rules.rotatePosition(game.currentTurn);
                }
                // ----- Trick (resumeTrick) -----
                game.transition(Phase.PLAYING, Phase.TRICK_RESOLVING);
                const winner = rules.determineWinner(game.playedCards, game.leadPosition, game.trump);
                game.tricks[winner % 2 ? 'team1' : 'team2']++;
                const lp = game.leadPosition;
                const cards = [0, 1, 2, 3].map((k) => game.playedCards[(lp - 1 + k) % 4]);
                game.trickHistory.push({ winner, lead: lp, cards: cards.map((c) => ({ suit: c.suit, rank: c.rank })) });
                game.handTricks[winner]++;
                game.currentTurn = winner;
                for (let q = 1; q <= 4; q++) bots[q].advanceTrick();
                game.playedCards = [];
                game.playedCardsIndex = 0;
                // leadPosition / leadCard keep the last trick's until the next
                // lead is played (applyPlay sets them), as in production
                game.transition(Phase.TRICK_RESOLVING, t === hs - 1 ? Phase.HAND_RESOLVING : Phase.PLAYING);
            }

            // ----- Score (handleHandComplete) -----
            const before = { ...game.score };
            for (const T of ['team1', 'team2']) {
                game.score[T] += rules.calculateScore(game.bids[T], game.tricks[T], game[`${T}Mult`], game.rainbows[T]);
            }
            for (let p = 1; p <= 4; p++) {
                if (bots[p].personality !== 'zach') continue;
                const partner = rules.getPartnerPosition(p);
                const s = String(game.playerBids[partner - 1]);
                if (!s.includes('B')) bots[p].recordPartnerHand(parseInt(s, 10) || 0, game.handTricks[partner]);
            }
            if (onHandEnd) onHandEnd(game, { handSize: hs, before, after: { ...game.score } });
            dealer = rules.rotatePosition(dealer);
            if (h < sizes.length - 1) game.transition(Phase.HAND_RESOLVING, Phase.DEALING);
        }
        return { game, score: { ...game.score }, decisions };
    } finally {
        Math.random = realRandom;
    }
}

module.exports = { playStateGame, NAMES, mulberry32, sameCard };
