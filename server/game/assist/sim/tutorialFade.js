#!/usr/bin/env node
/**
 * The tutorial's fade-out measured on seeded games (curriculum.js): one
 * seat per game plays with the tutorial on from the first deal (seat
 * `seed % 4 + 1`, so the four seats take turns), every seat a Mary bot,
 * and the tutor runs exactly as assistHandlers drives it (decisionStep on
 * the seat's own turns, betweenStep on the others' with one tip per
 * window (reopened only by the seat's own decision), handEndTips after
 * each hand). Prints, per hand, the seat's own
 * non-forced decisions, the advice shown and the rule tips shown; and the
 * totals before graduation (hands 1-6) and after it (hands 7-13).
 *
 *   node server/game/assist/sim/tutorialFade.js [--games 50] [--seed 1] [--json]
 *
 * measureFade() is what curriculum.test.js runs on a few games.
 */

'use strict';

if (require.main === module) process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const rules = require('../../rules');
const { playStateGame } = require('./stateGame');
const { seatView } = require('../seatView');
const { advise } = require('../advise');
const { explain } = require('../explain');
const T = require('../curriculum');

/**
 * @param {Object} o
 * @param {number} [o.games]
 * @param {number} [o.seed] - the first game's seed (then seed + 1, ...)
 * @param {Function} [o.onEvent] - ({game: seed, hand, moment: 'decision' |
 *   'between' | 'handEnd', tip, advice, decision, e, view}) for each own
 *   non-forced decision and each other moment that showed a tip (tests:
 *   the budget, the copy lint)
 * @returns {{perHand: Array<{hand, size, decisions, advice, bids, bidAdvice, cards, cardAdvice, tips}>,
 *   before: {decisions, advice, tips}, after: {decisions, advice, tips}, tipCounts: Object, games: number}}
 */
function measureFade({ games = 50, seed = 1, onEvent = null } = {}) {
    const sizes = rules.HAND_PROGRESSION;
    const perHand = sizes.map((size, i) => ({ hand: i + 1, size, decisions: 0, advice: 0, bids: 0, bidAdvice: 0, cards: 0, cardAdvice: 0, tips: 0 }));
    const tipCounts = {};
    for (let g = 0; g < games; g++) {
        const s = seed + g;
        const me = (s % 4) + 1;
        let tips = T.withTip(0, 'T.welcome');
        let windowUsed = false;
        const note = (tip, h) => {
            tipCounts[tip.id] = (tipCounts[tip.id] || 0) + 1;
            if (h) h.tips++;
        };
        playStateGame({
            seed: s,
            onTurn(game, pos) {
                const h = perHand[sizes.indexOf(game.currentHand)];
                const view = seatView(game, me);
                if (pos === me) {
                    const decision = advise(view);
                    if (!decision || decision.forced) return;
                    const e = explain(decision, view);
                    const r = T.decisionStep({ view, decision, e, tips });
                    tips = r.tips;
                    windowUsed = false;
                    h.decisions++;
                    if (decision.kind === 'bid') h.bids++; else h.cards++;
                    if (r.tip) note(r.tip, h);
                    if (onEvent) onEvent({ game: s, hand: h.hand, moment: 'decision', tip: r.tip, advice: r.advice, decision, e, view });
                    if (r.advice) {
                        h.advice++;
                        if (decision.kind === 'bid') h.bidAdvice++; else h.cardAdvice++;
                    }
                } else {
                    const r = T.betweenStep({ view, tips, windowUsed });
                    tips = r.tips;
                    windowUsed = r.windowUsed;
                    if (r.tip) note(r.tip, h);
                    if (onEvent && r.tip) onEvent({ game: s, hand: h.hand, moment: 'between', tip: r.tip, advice: false, view });
                }
            },
            onHandEnd(game) {
                const h = perHand[sizes.indexOf(game.currentHand)];
                const facts = {
                    handIndex: sizes.indexOf(game.currentHand) + 1,
                    handSize: game.currentHand,
                    position: me,
                    names: { 1: 'Alice', 2: 'Carol', 3: 'Bob', 4: 'Dan' },
                    bids: { ...game.bids },
                    tricks: { ...game.tricks },
                    mults: { team1: game.team1Mult, team2: game.team2Mult }
                };
                for (const tip of T.handEndTips(facts, tips)) {
                    tips = T.withTip(tips, tip.bitId);
                    note(tip, h);
                    if (onEvent) onEvent({ game: s, hand: h.hand, moment: 'handEnd', tip, advice: false, facts });
                }
            }
        });
    }
    const sum = (rows) => rows.reduce((a, r) => ({ decisions: a.decisions + r.decisions, advice: a.advice + r.advice, tips: a.tips + r.tips }), { decisions: 0, advice: 0, tips: 0 });
    const cut = sizes.indexOf(T.GRADUATE_AFTER) + 1;
    return { perHand, before: sum(perHand.slice(0, cut)), after: sum(perHand.slice(cut)), tipCounts, games };
}

function main() {
    const args = process.argv.slice(2);
    const opt = (name, def) => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 ? Number(args[i + 1]) : def;
    };
    const r = measureFade({ games: opt('games', 50), seed: opt('seed', 1) });
    if (args.includes('--json')) {
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        return;
    }
    const per = (n) => (n / r.games).toFixed(2);
    console.log(`Tutorial fade-out, ${r.games} seeded games (one tutorial seat each); per game averages`);
    console.log('hand  cards  decisions  advice  (bids shown/of  cards shown/of)  tips');
    for (const h of r.perHand) {
        console.log(`${String(h.hand).padStart(4)}  ${String(h.size).padStart(5)}  ${per(h.decisions).padStart(9)}  ${per(h.advice).padStart(6)}  (${per(h.bidAdvice)}/${per(h.bids)}  ${per(h.cardAdvice)}/${per(h.cards)})  ${per(h.tips)}`);
    }
    const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
    console.log(`hands 1-6:  ${per(r.before.decisions)} decisions, ${per(r.before.advice)} advice shown (${pct(r.before.advice, r.before.decisions)}), ${per(r.before.tips)} tips`);
    console.log(`hands 7-13: ${per(r.after.decisions)} decisions, ${per(r.after.advice)} advice shown (${pct(r.after.advice, r.after.decisions)}), ${per(r.after.tips)} tips`);
    console.log('tips shown (games):', JSON.stringify(r.tipCounts));
}

if (require.main === module) main();

module.exports = { measureFade };
