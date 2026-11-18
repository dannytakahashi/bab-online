#!/usr/bin/env node
/**
 * Coverage of the /help explainer over a sim corpus (plan H1b): plays
 * seeded Mary-vs-Mary games on a real GameState, explains every decision
 * of every seat, and reports how often each reason code is the main reason,
 * the confidence mix, the longest texts and any copy-rule problem
 * (sim/lint.js). The target: P.generic (no specific reason) under 2% of the
 * decisions, and no lint problem.
 *
 *   node server/game/assist/sim/assistCoverage.js [--games 100] [--seed 1] [--json]
 *
 * Exits 1 when P.generic is 2% or more or any explanation fails the lint.
 */

'use strict';

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { playStateGame } = require('./stateGame');
const { seatView } = require('../seatView');
const { advise } = require('../advise');
const { explain } = require('../explain');
const { render } = require('../copy');
const { lintExplanation } = require('./lint');

/** The code that carries the main reason (contract lines and S.* detail codes aside). */
function mainCode(e, d) {
    if (d.forced) return 'P.forced';
    const codes = e.codes.filter((c) => !c.startsWith('C.'));
    if (d.kind === 'bid') return codes[0];
    const s = codes.find((c) => c === 'S.overrides' || c === 'S.best' || (c === 'S.close' && !codes.some((k) => /^[LFD]\./.test(k))));
    if (s) return s;
    return codes.find((c) => /^[LFD]\.|^P\./.test(c) && c !== 'L.suit' && !/^D\.(partnerWins|cantOvertrump|noTrump)$/.test(c)) || codes[0];
}

function run({ games = 100, seed = 1 } = {}) {
    const counts = {};
    const confidence = {};
    const kinds = { bid: 0, rule: 0, search: 0, forced: 0 };
    const longest = { headline: 0, reason: 0, detail: 0, line: 0 };
    const problems = [];
    let decisions = 0;
    for (let g = 0; g < games; g++) {
        playStateGame({
            seed: seed + g,
            onTurn(game, pos) {
                const view = seatView(game, pos);
                const d = advise(view);
                const e = explain(d, view);
                const line = render(e, { style: 'line', uses: 3, freeUses: 3 });
                const rich = render(e);
                decisions++;
                const code = mainCode(e, d);
                counts[code] = (counts[code] || 0) + 1;
                confidence[e.confidence] = (confidence[e.confidence] || 0) + 1;
                kinds[d.forced ? 'forced' : d.kind === 'bid' ? 'bid' : d.source === 'search' ? 'search' : 'rule']++;
                longest.headline = Math.max(longest.headline, e.headline.length);
                for (const r of e.reasons) longest.reason = Math.max(longest.reason, r.length);
                for (const t of e.details) longest.detail = Math.max(longest.detail, t.length);
                longest.line = Math.max(longest.line, line.length);
                const bad = lintExplanation(e, view, { line, rich });
                if (bad.length && problems.length < 50) problems.push({ seed: seed + g, pos, codes: e.codes, bad });
            }
        });
    }
    const generic = (counts['P.generic'] || 0) / decisions;
    return {
        games,
        decisions,
        kinds,
        genericShare: +generic.toFixed(4),
        codes: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])),
        confidence,
        longest,
        problems
    };
}

function main() {
    const args = { games: 100, seed: 1, json: false };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--games') args.games = parseInt(argv[++i], 10);
        else if (argv[i] === '--seed') args.seed = parseInt(argv[++i], 10);
        else if (argv[i] === '--json') args.json = true;
    }
    const t0 = process.hrtime.bigint();
    const r = run(args);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (args.json) {
        console.log(JSON.stringify({ ...r, elapsedMs: Math.round(ms) }, null, 2));
    } else {
        console.log(`${r.games} games, ${r.decisions} decisions (${JSON.stringify(r.kinds)}) in ${(ms / 1000).toFixed(1)} s`);
        console.log(`P.generic: ${(r.genericShare * 100).toFixed(2)}% (target < 2%)`);
        console.log('Main reason codes:');
        for (const [c, n] of Object.entries(r.codes)) console.log(`  ${c.padEnd(22)} ${String(n).padStart(6)}  ${(100 * n / r.decisions).toFixed(2)}%`);
        console.log(`Confidence: ${JSON.stringify(r.confidence)}`);
        console.log(`Longest: ${JSON.stringify(r.longest)}`);
        console.log(`Lint problems: ${r.problems.length}`);
        for (const p of r.problems.slice(0, 10)) console.log(`  ${JSON.stringify(p)}`);
    }
    process.exitCode = r.genericShare >= 0.02 || r.problems.length ? 1 : 0;
}

if (require.main === module) main();

module.exports = { run, mainCode };
