#!/usr/bin/env node
/**
 * The /help stats threshold sim (plan §2 Q1, H1b): how much do N free /help
 * uses per game move a game? A Mike seat (Mary's play with a 10% overbid and
 * the odd needless overtake: the stand-in for a decent human) gets Mary's
 * choice on its N decisions per game where Mary's own numbers say Mike's
 * choice costs the most ("EV gap"):
 *  - bids: Mary's expected-value curve, evs[Mary's bid] - evs[Mike's bid]
 *  - searched plays (7 cards or fewer): the search's average hand score,
 *    (totals[Mary's card] - totals[Mike's card]) / deals solved
 * Plays above 7 cards and rule-path bids have no such number; where Mike and
 * Mary differ there (rare) the decision is not a candidate.
 *
 * Each seed is played three times on the same deals: unhelped, then with
 * help on the top 2 and the top 3 gaps of the unhelped game (an oracle: the
 * best possible use of the free helps; after the first substitution the game
 * can drift, so later picks are by decision number). Pair X = the helped
 * Mike + a Mike partner, against Y = two Mikes, seat-balanced (X on team 1
 * for even games). The helped decisions draw no RNG (advise never does), and
 * the Mike bot still decides first, so the deals stay the same.
 *
 * Reported: X's win rate and average score margin for 0 / 2 / 3 helps, and
 * the paired change against 0 with a 95% interval. The plan's rule: if 3
 * helps add more than about 1 point of pair win rate, ship 2.
 *
 * --proxy legacy plays every seat with the frozen June-2026 Mary
 * (bot/sim/legacyStrategy.js) instead of Mike: a clearly weaker player who
 * differs from Mary far more often, so the extra (3rd) help has more to do.
 *
 *   node server/game/assist/sim/assistThreshold.js --games 4000 [--seed 1] [--workers 8] [--proxy mike|legacy] [--json]
 */

'use strict';

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { playStateGame, sameCard } = require('./stateGame');
const BotPlayer = require('../../bot/BotPlayer');
const { seatView } = require('../seatView');
const { advise } = require('../advise');

const HELPS = [2, 3];

/** A seat that decides with the frozen legacy strategy (simulate.js's LegacyBotPlayer). */
class LegacyBot extends BotPlayer {
    decideBid(hand, trump, existingBids, handSize, gameContext) {
        return require('../../bot/sim/legacyStrategy').calculateOptimalBid(
            hand, trump, this.position, existingBids, handSize,
            this.getMemorySnapshot(), gameContext, this.personality, this.partnerHistory);
    }

    decideCard(hand, playedCards, leadCard, leadPosition, trump, trumpBroken, handSize) {
        return require('../../bot/sim/legacyStrategy').selectOptimalCard(
            hand, playedCards, leadCard, leadPosition, trump, trumpBroken,
            this.position, this.getMemorySnapshot(), handSize);
    }
}

const PROXIES = {
    mike: { personalities: ['mike', 'mike', 'mike', 'mike'], makeBot: undefined },
    legacy: { personalities: ['mary', 'mary', 'mary', 'mary'], makeBot: (name, p) => new LegacyBot(name, p) }
};

/** Mary's advice for the seat on turn and the gap to the bot's own choice. */
function gapOf(decision, botChoice) {
    const t = decision.trace;
    if (decision.kind === 'bid') {
        if (decision.bid === String(botChoice)) return 0;
        const evs = t.bid && t.bid.path === 'ev' ? t.bid.evs : null;
        const a = Number(decision.bid), b = Number(botChoice);
        if (!evs || !Number.isInteger(a) || !Number.isInteger(b) || evs[a] == null || evs[b] == null) return null;
        return evs[a] - evs[b];
    }
    if (sameCard(decision.card, botChoice)) return 0;
    const s = t.search;
    if (!s || !s.cands || !(s.samples > 0) || !s.totals) return null;
    const i = s.cands.findIndex((c) => sameCard(c, decision.card));
    const j = s.cands.findIndex((c) => sameCard(c, botChoice));
    if (i < 0 || j < 0) return null;
    return (s.totals[i] - s.totals[j]) / s.samples;
}

/**
 * One seed: unhelped, then helped on the top-n gaps for each n in HELPS.
 * @returns {{xOnTeam1, scores: {0: [x, y], 2: [x, y], 3: [x, y]}, gaps: number[], diffs: number}}
 */
function playSeed(seed, gameIndex, proxy = 'mike') {
    const xOnTeam1 = gameIndex % 2 === 0;
    const helped = xOnTeam1 ? 1 : 2;
    const { personalities, makeBot } = PROXIES[proxy];
    const result = { xOnTeam1, scores: {}, gaps: [], unknown: 0, differ: 0 };

    // Unhelped: the gap at each of the helped seat's decisions
    let k = 0;
    const gaps = [];
    let pending = null;
    const run0 = playStateGame({
        seed,
        personalities,
        makeBot,
        onTurn(game, pos) {
            pending = pos === helped ? advise(seatView(game, pos)) : null;
        },
        decide(game, pos, bot, kind, botChoice) {
            if (pos !== helped) return undefined;
            const g = gapOf(pending, botChoice);
            if (g === null) result.unknown++;
            if (g !== 0) result.differ++;
            gaps.push({ k: k++, g: g === null ? 0 : g });
            return undefined;
        }
    });
    const xy = (s) => (xOnTeam1 ? [s.team1, s.team2] : [s.team2, s.team1]);
    result.scores[0] = xy(run0.score);
    const ranked = gaps.filter((x) => x.g > 1e-9).sort((a, b) => b.g - a.g);
    result.gaps = ranked.slice(0, Math.max(...HELPS)).map((x) => +x.g.toFixed(2));

    for (const n of HELPS) {
        const pick = new Set(ranked.slice(0, n).map((x) => x.k));
        let i = 0;
        const run = playStateGame({
            seed,
            personalities,
            makeBot,
            decide(game, pos, bot, kind) {
                if (pos !== helped) return undefined;
                const use = pick.has(i++);
                if (!use) return undefined;
                const d = advise(seatView(game, pos));
                return kind === 'bid' ? d.bid : d.card;
            }
        });
        result.scores[n] = xy(run.score);
    }
    return result;
}

function summarize(rows) {
    const n = rows.length;
    const win = (s) => (s[0] > s[1] ? 1 : s[0] === s[1] ? 0.5 : 0);
    const out = { games: n, byHelps: {} };
    for (const h of [0, ...HELPS]) {
        const w = rows.map((r) => win(r.scores[h]));
        const m = rows.map((r) => r.scores[h][0] - r.scores[h][1]);
        const wr = w.reduce((a, b) => a + b, 0) / n;
        const entry = {
            winRateX: +wr.toFixed(4),
            ci95: +(1.96 * Math.sqrt(wr * (1 - wr) / n)).toFixed(4),
            avgMarginX: +(m.reduce((a, b) => a + b, 0) / n).toFixed(2)
        };
        if (h > 0) {
            const dw = rows.map((r) => win(r.scores[h]) - win(r.scores[0]));
            const dm = rows.map((r) => (r.scores[h][0] - r.scores[h][1]) - (r.scores[0][0] - r.scores[0][1]));
            const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
            const se = (a) => { const mu = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / (a.length - 1) / a.length); };
            entry.winRateChange = +mean(dw).toFixed(4);
            entry.winRateChangeCi95 = +(1.96 * se(dw)).toFixed(4);
            entry.marginChange = +mean(dm).toFixed(2);
            entry.marginChangeCi95 = +(1.96 * se(dm)).toFixed(2);
            entry.gamesChanged = rows.filter((r) => win(r.scores[h]) !== win(r.scores[0])).length;
        }
        out.byHelps[h] = entry;
    }
    const allGaps = rows.flatMap((r) => r.gaps);
    out.helpedDecisionsPerGame = +(rows.reduce((a, r) => a + r.differ, 0) / n).toFixed(2);
    out.unknownGapPerGame = +(rows.reduce((a, r) => a + r.unknown, 0) / n).toFixed(2);
    out.gamesWith3Gaps = rows.filter((r) => r.gaps.length >= 3).length;
    out.avgTopGap = allGaps.length ? +(rows.reduce((a, r) => a + (r.gaps[0] || 0), 0) / n).toFixed(2) : 0;
    out.avgThirdGap = +(rows.reduce((a, r) => a + (r.gaps[2] || 0), 0) / n).toFixed(2);
    return out;
}

function runRange(seed, from, to, proxy) {
    const rows = [];
    for (let g = from; g < to; g++) rows.push(playSeed(seed + g, g, proxy));
    return rows;
}

function main() {
    const args = { games: 2000, seed: 1, workers: 1, json: false, from: null, to: null, proxy: 'mike' };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--games') args.games = parseInt(argv[++i], 10);
        else if (a === '--seed') args.seed = parseInt(argv[++i], 10);
        else if (a === '--workers') args.workers = parseInt(argv[++i], 10);
        else if (a === '--json') args.json = true;
        else if (a === '--proxy') args.proxy = argv[++i];
        else if (a === '--range') { args.from = parseInt(argv[++i], 10); args.to = parseInt(argv[++i], 10); }
    }
    if (args.from !== null) {
        process.stdout.write(JSON.stringify(runRange(args.seed, args.from, args.to, args.proxy)));
        return;
    }
    const t0 = process.hrtime.bigint();
    const finish = (rows) => {
        const s = summarize(rows);
        s.elapsedS = +(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1);
        s.seed = args.seed;
        s.proxy = args.proxy;
        if (args.json) { console.log(JSON.stringify(s, null, 2)); return; }
        const who = args.proxy === 'mike' ? 'Mike' : 'legacy Mary';
        console.log(`${s.games} games (seed ${s.seed}), X = helped ${who} + ${who} vs Y = ${who} + ${who}, ${s.elapsedS} s`);
        for (const [h, e] of Object.entries(s.byHelps)) {
            const extra = h === '0' ? '' : `  change ${(e.winRateChange * 100).toFixed(2)} pp (±${(e.winRateChangeCi95 * 100).toFixed(2)}), margin ${e.marginChange >= 0 ? '+' : ''}${e.marginChange} (±${e.marginChangeCi95}), ${e.gamesChanged} games changed`;
            console.log(`  ${h} helps: X wins ${(e.winRateX * 100).toFixed(2)}% (±${(e.ci95 * 100).toFixed(2)}), margin ${e.avgMarginX}${extra}`);
        }
        console.log(`  ${who} and Mary differ ${s.helpedDecisionsPerGame} times a game (${s.unknownGapPerGame} with no gap number); games with 3+ gaps: ${s.gamesWith3Gaps}; avg top gap ${s.avgTopGap}, avg 3rd gap ${s.avgThirdGap} points`);
    };
    if (!PROXIES[args.proxy]) throw new Error(`--proxy ${args.proxy}: mike or legacy`);
    if (args.workers <= 1) { finish(runRange(args.seed, 0, args.games, args.proxy)); return; }
    const { execFile } = require('child_process');
    const per = Math.ceil(args.games / args.workers);
    const jobs = [];
    for (let w = 0; w < args.workers; w++) {
        const from = w * per, to = Math.min(args.games, from + per);
        if (from >= to) continue;
        jobs.push(new Promise((resolve, reject) => {
            execFile(process.execPath, [__filename, '--seed', String(args.seed), '--proxy', args.proxy, '--range', String(from), String(to)],
                { maxBuffer: 1 << 28, env: process.env },
                (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
        }));
    }
    Promise.all(jobs).then((parts) => finish(parts.flat())).catch((e) => { console.error(e); process.exitCode = 1; });
}

if (require.main === module) main();

module.exports = { playSeed, summarize, gapOf };
