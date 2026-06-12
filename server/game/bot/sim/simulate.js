/**
 * Bot-vs-bot simulation harness for tuning and regression-testing bot strategy.
 *
 * Requires the REAL modules — no game logic is reimplemented except the
 * orchestration loop, which mirrors server/socket/gameHandlers.js exactly:
 *  - first bidder = dealer + 1; dealer starts at 1 and rotates each hand
 *  - team bid = BID_RANKS[bid_a] + BID_RANKS[bid_b], capped at hand size
 *    (so any bore => team bid = hand size = must win ALL tricks)
 *  - multiplier = rules.calculateMultiplier(bid_a, bid_b)
 *  - both teams bid 0 => redeal, same hand size and dealer
 *  - rainbows: 4-card hand only, checked after bidding, +10 per rainbow
 *    player added to team score whether made or set
 *  - score: made => bid*10*mult + (tricks-bid) + rainbows*10
 *           set  => -bid*10*mult + rainbows*10
 *  - trump broken when a trump-suit card or joker is played
 *  - bots are notified of each card as it is played (notifyCardPlayed) and
 *    advanceTrick on every bot after each trick (notifyTrickComplete)
 *  - Zach partner history updated every hand, bore -> 0 (updatePartnerHistory)
 *
 * Every card a bot chooses is re-validated with rules.isLegalMove; illegal
 * choices and thrown exceptions are counted and reported (and substituted so
 * the run can continue). A healthy strategy reports zero of both.
 *
 * Usage:
 *   node server/game/bot/sim/simulate.js                         # all experiments, 2000 games each
 *   node server/game/bot/sim/simulate.js --games 8000            # more precision (~±1.1% CI at 8000)
 *   node server/game/bot/sim/simulate.js --exp legacy            # current Mary vs frozen pre-tuning Mary
 *   node server/game/bot/sim/simulate.js --exp personalities     # each personality+Mary vs Mary+Mary
 *   node server/game/bot/sim/simulate.js --team mary,danny --vs legacy:mary,legacy:mary
 *
 * Personality specs: mary | sharon | danny | mike | zach, with optional
 * `legacy:` prefix to use the frozen June-2026 strategy snapshot
 * (./legacyStrategy.js) — the fixed benchmark all tuning is measured against.
 *
 * Matchups are seat-balanced: half the games are played with the pair swapped
 * onto the other team, cancelling the first-bidder positional asymmetry, so
 * an even matchup reads 50.0%.
 */
'use strict';

const rules = require('../../rules');
const BotPlayer = require('../BotPlayer');
const legacyStrategy = require('./legacyStrategy');

const { BID_RANKS } = rules;
const HAND_SIZES = [12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13];
const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// ---------- Seeded RNG (mulberry32), installed over Math.random for reproducibility ----------
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
let rng = mulberry32(12345);
Math.random = () => rng(); // bot strategy randomness must go through the seeded RNG

/** Bot that plays with the frozen legacy strategy but shares BotPlayer's memory machinery. */
class LegacyBotPlayer extends BotPlayer {
    decideBid(hand, trump, existingBids, handSize, gameContext) {
        return legacyStrategy.calculateOptimalBid(
            hand, trump, this.position, existingBids, handSize,
            this.getMemorySnapshot(), gameContext, this.personality, this.partnerHistory
        );
    }

    decideCard(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, handSize) {
        return legacyStrategy.selectOptimalCard(
            hand, playedCards, leadCard, leadPosition, trump, trumpBroken,
            this.position, this.getMemorySnapshot(), handSize
        );
    }
}

const NAMES = { mary: 'Mary', sharon: 'Sharon', danny: 'Danny', mike: 'Mike', zach: 'Zach' };

/** spec: 'mary' or 'legacy:mary' */
function makeBot(spec, position, gameId) {
    const legacy = spec.startsWith('legacy:');
    const personality = legacy ? spec.slice('legacy:'.length) : spec;
    if (!NAMES[personality]) throw new Error(`Unknown personality spec: ${spec}`);
    const Ctor = legacy ? LegacyBotPlayer : BotPlayer;
    const bot = new Ctor(`🤖 ${NAMES[personality]}`, personality);
    bot.assignToGame(gameId, position, position);
    bot.statKey = spec; // legacy and current stats must not merge
    return bot;
}

function freshDeck() {
    const cards = [];
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ suit, rank });
    cards.push({ suit: 'joker', rank: 'HI' });
    cards.push({ suit: 'joker', rank: 'LO' });
    for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
}

const cardStr = (c) => (c ? `${c.rank}${c.suit === 'joker' ? 'Jok' : c.suit[0].toUpperCase()}` : '-');
const handStr = (h) => h.map(cardStr).join(' ');
const isBore = (b) => ['B', '2B', '3B', '4B'].includes(b);
const numericBid = (b) => (isBore(b) ? null : (parseInt(String(b), 10) || 0));

// ---------- Global stat accumulators ----------
const incidents = [];   // illegal card selections
const exceptions = [];  // thrown errors
let redealCount = 0;
let totalHandsDealt = 0;
const byHandSize = {};
for (const hs of HAND_SIZES) byHandSize[hs] = { keptHands: 0, redeals: 0, sumTeamBids: 0, boreHands: 0 };

function newPersStats() {
    return {
        handsBid: 0,
        bidSumByHandSize: {}, bidCountByHandSize: {},
        boreAttempts: 0, boreSuccesses: 0, boreOppsOneCard: 0, boreAttemptsOneCard: 0,
        zeroBids: 0,
        accuracy: {},
        teamHands: 0, teamSets: 0,
        teamMade: 0, overtricksOnMade: 0,
        personalTricksSum: 0, personalBidSum: 0, nonBoreHands: 0
    };
}
const persStats = {};
function ps(key) { if (!persStats[key]) persStats[key] = newPersStats(); return persStats[key]; }

/**
 * Play one full 13-hand game.
 * specs: array of 4 personality specs for positions 1..4. Team 1 = positions 1&3, team 2 = 2&4.
 * Returns { score1, score2 }
 */
function playGame(specs, expName, gameIdx) {
    const bots = {};
    for (let p = 1; p <= 4; p++) bots[p] = makeBot(specs[p - 1], p, `sim:${expName}:${gameIdx}`);
    const teamOf = (p) => (p === 1 || p === 3 ? 1 : 2);
    const score = { 1: 0, 2: 0 };

    let dealer = 1; // GameState starts dealer at 1; bidder = dealer + 1
    for (let handIdx = 0; handIdx < HAND_SIZES.length; handIdx++) {
        const handSize = HAND_SIZES[handIdx];
        const firstBidder = (dealer % 4) + 1;

        // ----- Deal (with zero-bid redeal loop, mirroring handlePostBid) -----
        let hands, trump, playerBids, teamBid, mult;
        let redeals = 0;
        for (;;) {
            totalHandsDealt++;
            const deck = freshDeck();
            hands = {};
            for (let p = 1; p <= 4; p++) hands[p] = deck.slice((p - 1) * handSize, p * handSize);
            trump = deck[4 * handSize]; // flipped card; suit 'joker' => no-trump
            for (let p = 1; p <= 4; p++) bots[p].resetCardMemory(handSize, trump);

            // ----- Bidding -----
            playerBids = [undefined, undefined, undefined, undefined];
            for (let i = 0; i < 4; i++) {
                const pos = ((firstBidder - 1 + i) % 4) + 1;
                const bot = bots[pos];
                const gameContext = {
                    teamScore: score[teamOf(pos)],
                    oppScore: score[teamOf(pos) === 1 ? 2 : 1],
                    currentHandSize: handSize
                };
                let bid;
                try {
                    bid = bot.decideBid(hands[pos].slice(), trump, playerBids, handSize, gameContext);
                } catch (e) {
                    exceptions.push({
                        where: 'decideBid', exp: expName, game: gameIdx, handSize,
                        position: pos, personality: bot.statKey,
                        hand: handStr(hands[pos]), trump: cardStr(trump),
                        existingBids: playerBids.slice(), error: e.message, stack: e.stack.split('\n')[1]
                    });
                    bid = '0';
                }
                playerBids[pos - 1] = bid;
            }

            teamBid = {
                1: (BID_RANKS[playerBids[0]] || 0) + (BID_RANKS[playerBids[2]] || 0),
                2: (BID_RANKS[playerBids[1]] || 0) + (BID_RANKS[playerBids[3]] || 0)
            };
            mult = {
                1: rules.calculateMultiplier(playerBids[0], playerBids[2]),
                2: rules.calculateMultiplier(playerBids[1], playerBids[3])
            };
            if (teamBid[1] > handSize) teamBid[1] = handSize;
            if (teamBid[2] > handSize) teamBid[2] = handSize;

            if (teamBid[1] === 0 && teamBid[2] === 0) {
                redealCount++; redeals++;
                byHandSize[handSize].redeals++;
                if (redeals > 200) throw new Error('redeal livelock');
                continue;
            }
            break;
        }
        byHandSize[handSize].keptHands++;
        byHandSize[handSize].sumTeamBids += teamBid[1] + teamBid[2];
        if (playerBids.some(isBore)) byHandSize[handSize].boreHands++;

        // ----- Rainbows (4-card hand only, after bidding) -----
        const rainbows = { 1: 0, 2: 0 };
        if (handSize === 4) {
            for (let p = 1; p <= 4; p++) {
                if (rules.isRainbow(hands[p], trump)) rainbows[teamOf(p)]++;
            }
        }

        // per-bid stats
        for (let p = 1; p <= 4; p++) {
            const s = ps(bots[p].statKey);
            const bid = playerBids[p - 1];
            s.handsBid++;
            if (handSize === 1) s.boreOppsOneCard++;
            if (isBore(bid)) {
                s.boreAttempts++;
                if (handSize === 1) s.boreAttemptsOneCard++;
            } else {
                const nb = numericBid(bid);
                s.bidSumByHandSize[handSize] = (s.bidSumByHandSize[handSize] || 0) + nb;
                s.bidCountByHandSize[handSize] = (s.bidCountByHandSize[handSize] || 0) + 1;
                if (nb === 0) s.zeroBids++;
            }
        }

        // ----- Play -----
        let lead = rules.findHighestBidder(firstBidder, playerBids) + 1;
        let trumpBroken = false;
        const tricksByPos = { 1: 0, 2: 0, 3: 0, 4: 0 };
        const teamTricks = { team1: 0, team2: 0 };

        for (let t = 0; t < handSize; t++) {
            const playedCards = [undefined, undefined, undefined, undefined];
            let leadCard = null;
            const leadPosition = lead;
            for (let i = 0; i < 4; i++) {
                const pos = ((lead - 1 + i) % 4) + 1;
                const bot = bots[pos];
                const hand = hands[pos];
                const isLeading = i === 0;
                // Contract state, shaped like what processBotPlay can read off `game`
                const playContext = {
                    playerBids,
                    bids: { team1: teamBid[1], team2: teamBid[2] },
                    tricks: { team1: teamTricks.team1, team2: teamTricks.team2 },
                    team1Mult: mult[1], team2Mult: mult[2]
                };
                let card = null;
                try {
                    card = bot.decideCard(hand.slice(), playedCards,
                        isLeading ? null : leadCard, isLeading ? null : leadPosition,
                        trump, trumpBroken, handSize, playContext);
                } catch (e) {
                    exceptions.push({
                        where: 'decideCard', exp: expName, game: gameIdx, handSize, trick: t,
                        position: pos, personality: bot.statKey,
                        hand: handStr(hand), trump: cardStr(trump), trumpBroken,
                        playedCards: playedCards.map(cardStr).join(','),
                        leadCard: cardStr(leadCard), error: e.message, stack: e.stack.split('\n')[1]
                    });
                }

                // Validate the choice against the REAL rules before accepting it
                const inHand = card && hand.find(c => c.suit === card.suit && c.rank === card.rank);
                let legal = false;
                if (inHand) {
                    const remaining = hand.filter(c => c !== inHand);
                    legal = rules.isLegalMove(inHand, remaining, leadCard || inHand, isLeading,
                        trump, trumpBroken, pos, isLeading ? pos : leadPosition);
                }
                if (!inHand || !legal) {
                    incidents.push({
                        exp: expName, game: gameIdx, handSize, trick: t,
                        position: pos, personality: bot.statKey,
                        chosen: cardStr(card), inHand: !!inHand,
                        hand: handStr(hand), trump: cardStr(trump), trumpBroken,
                        leadCard: cardStr(leadCard),
                        playedCards: playedCards.map(cardStr).join(',')
                    });
                    card = hand.find(c => {
                        const remaining = hand.filter(x => x !== c);
                        return rules.isLegalMove(c, remaining, leadCard || c, isLeading,
                            trump, trumpBroken, pos, isLeading ? pos : leadPosition);
                    }) || hand[0];
                } else {
                    card = inHand;
                }

                hands[pos] = hand.filter(c => c !== card);
                playedCards[pos - 1] = card;
                if (isLeading) leadCard = card;
                if (card.suit === trump.suit || card.suit === 'joker') trumpBroken = true;

                for (let q = 1; q <= 4; q++) bots[q].recordCardPlayed(card, pos, trump, leadPosition);
            }
            const winner = rules.determineWinner(playedCards, leadPosition, trump);
            tricksByPos[winner]++;
            teamTricks[winner === 1 || winner === 3 ? 'team1' : 'team2']++;
            for (let q = 1; q <= 4; q++) bots[q].advanceTrick();
            lead = winner;
        }

        const tricks = { 1: tricksByPos[1] + tricksByPos[3], 2: tricksByPos[2] + tricksByPos[4] };

        // ----- Scoring (mirrors handleHandComplete exactly) -----
        for (const T of [1, 2]) {
            if (tricks[T] >= teamBid[T]) {
                score[T] += teamBid[T] * 10 * mult[T] + (tricks[T] - teamBid[T]) + rainbows[T] * 10;
            } else {
                score[T] -= teamBid[T] * 10 * mult[T];
                score[T] += rainbows[T] * 10;
            }
        }

        // ----- Per-personality outcome stats -----
        for (let p = 1; p <= 4; p++) {
            const s = ps(bots[p].statKey);
            const T = teamOf(p);
            const bid = playerBids[p - 1];
            s.teamHands++;
            const made = tricks[T] >= teamBid[T];
            if (!made) s.teamSets++;
            else { s.teamMade++; s.overtricksOnMade += (tricks[T] - teamBid[T]); }
            if (isBore(bid)) {
                if (tricks[T] === handSize) s.boreSuccesses++;
            } else {
                const nb = numericBid(bid);
                const diff = tricksByPos[p] - nb;
                const key = diff <= -3 ? '<=-3' : diff >= 3 ? '>=3' : String(diff);
                s.accuracy[key] = (s.accuracy[key] || 0) + 1;
                s.personalTricksSum += tricksByPos[p];
                s.personalBidSum += nb;
                s.nonBoreHands++;
            }
        }

        // ----- Zach partner history (mirrors updatePartnerHistory: bores skipped) -----
        for (let p = 1; p <= 4; p++) {
            const bot = bots[p];
            if (bot.personality !== 'zach') continue;
            const partnerPos = rules.getPartnerPosition(p);
            const bidStr = String(playerBids[partnerPos - 1]);
            if (bidStr.includes('B')) continue;
            bot.recordPartnerHand(parseInt(bidStr, 10) || 0, tricksByPos[partnerPos]);
        }

        dealer = rules.rotatePosition(dealer);
    }

    return { score1: score[1], score2: score[2] };
}

/**
 * Seat-balanced matchup: pairX vs pairY, with X on team 1 for even game
 * indices and on team 2 for odd ones. Returns X's win rate (ties = 0.5).
 */
function runMatch(name, pairX, pairY, nGames, seed) {
    rng = mulberry32(seed);
    let winsX = 0, ties = 0, sumDeltaX = 0, sumX = 0, sumY = 0;
    for (let g = 0; g < nGames; g++) {
        const xOnTeam1 = g % 2 === 0;
        const specs = xOnTeam1
            ? [pairX[0], pairY[0], pairX[1], pairY[1]]
            : [pairY[0], pairX[0], pairY[1], pairX[1]];
        const r = playGame(specs, name, g);
        const scoreX = xOnTeam1 ? r.score1 : r.score2;
        const scoreY = xOnTeam1 ? r.score2 : r.score1;
        if (scoreX > scoreY) winsX++;
        else if (scoreX === scoreY) ties++;
        sumDeltaX += scoreX - scoreY;
        sumX += scoreX; sumY += scoreY;
    }
    const winRate = (winsX + ties * 0.5) / nGames;
    const ci95 = 1.96 * Math.sqrt(winRate * (1 - winRate) / nGames);
    return {
        name, nGames,
        teamX: pairX.join('+'), teamY: pairY.join('+'),
        winRateX: +winRate.toFixed(4),
        ci95: +ci95.toFixed(4),
        avgScoreDeltaX: +(sumDeltaX / nGames).toFixed(1),
        avgScoreX: +(sumX / nGames).toFixed(1),
        avgScoreY: +(sumY / nGames).toFixed(1)
    };
}

// ---------- CLI ----------
function parseArgs(argv) {
    const args = { games: 2000, seed: 1001, exp: 'all', team: null, vs: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--games') args.games = parseInt(argv[++i], 10);
        else if (a === '--seed') args.seed = parseInt(argv[++i], 10);
        else if (a === '--exp') args.exp = argv[++i];
        else if (a === '--team') args.team = argv[++i].split(',');
        else if (a === '--vs') args.vs = argv[++i].split(',');
        else if (/^\d+$/.test(a)) args.games = parseInt(a, 10); // bare number = games
        else throw new Error(`Unknown argument: ${a}`);
    }
    return args;
}

function main() {
    const args = parseArgs(process.argv);
    const N = args.games;
    const t0 = Date.now();
    const results = [];

    if (args.team && args.vs) {
        results.push(runMatch('custom', args.team, args.vs, N, args.seed));
    } else {
        const exps = args.exp === 'all' ? ['baseline', 'legacy', 'personalities'] : [args.exp];
        for (const exp of exps) {
            if (exp === 'baseline') {
                results.push(runMatch('baseline: mary vs mary', ['mary', 'mary'], ['mary', 'mary'], N, args.seed));
            } else if (exp === 'legacy') {
                results.push(runMatch('mary vs legacy mary', ['mary', 'mary'], ['legacy:mary', 'legacy:mary'], N, args.seed + 1));
                results.push(runMatch('mary vs legacy danny+zach', ['mary', 'mary'], ['legacy:danny', 'legacy:zach'], N, args.seed + 2));
            } else if (exp === 'personalities') {
                for (const p of ['sharon', 'danny', 'mike', 'zach']) {
                    results.push(runMatch(`${p}+mary vs mary+mary`, [p, 'mary'], ['mary', 'mary'], N, args.seed + 10 + p.charCodeAt(0)));
                }
            } else {
                throw new Error(`Unknown experiment: ${exp}`);
            }
        }
    }

    const elapsed = (Date.now() - t0) / 1000;
    const out = {
        elapsedSec: +elapsed.toFixed(1),
        gamesPerMatch: N,
        results,
        redealCount,
        totalHandsDealt,
        byHandSize: {},
        personalities: {},
        incidentCount: incidents.length,
        incidents: incidents.slice(0, 25),
        exceptionCount: exceptions.length,
        exceptions: exceptions.slice(0, 25)
    };
    for (const hs of HAND_SIZES) {
        const b = byHandSize[hs];
        if (b.keptHands === 0) continue;
        out.byHandSize[hs] = {
            keptHands: b.keptHands,
            redealRate: +(b.redeals / (b.keptHands + b.redeals)).toFixed(3),
            avgCombinedTeamBid: +(b.sumTeamBids / b.keptHands).toFixed(2),
            bidFractionOfTricks: +((b.sumTeamBids / b.keptHands) / hs).toFixed(3),
            boreHandRate: +(b.boreHands / b.keptHands).toFixed(3)
        };
    }
    for (const [key, s] of Object.entries(persStats)) {
        const avgBidByHS = {};
        for (const hs of HAND_SIZES) {
            if (s.bidCountByHandSize[hs]) avgBidByHS[hs] = +(s.bidSumByHandSize[hs] / s.bidCountByHandSize[hs]).toFixed(2);
        }
        out.personalities[key] = {
            handsBid: s.handsBid,
            avgBidByHandSize: avgBidByHS,
            zeroBidRate: +(s.zeroBids / Math.max(1, s.nonBoreHands)).toFixed(4),
            boreAttemptRate: +(s.boreAttempts / s.handsBid).toFixed(4),
            boreSuccessRate: s.boreAttempts ? +(s.boreSuccesses / s.boreAttempts).toFixed(3) : null,
            oneCardBoreRate: s.boreOppsOneCard ? +(s.boreAttemptsOneCard / s.boreOppsOneCard).toFixed(3) : null,
            teamSetRate: +(s.teamSets / s.teamHands).toFixed(4),
            avgOvertricksPerMadeHand: +(s.overtricksOnMade / Math.max(1, s.teamMade)).toFixed(3),
            avgPersonalBid: +(s.personalBidSum / Math.max(1, s.nonBoreHands)).toFixed(3),
            avgPersonalTricks: +(s.personalTricksSum / Math.max(1, s.nonBoreHands)).toFixed(3),
            accuracyHistogram: s.accuracy
        };
    }
    console.log(JSON.stringify(out, null, 1));
}

main();
