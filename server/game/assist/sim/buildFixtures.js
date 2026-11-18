#!/usr/bin/env node
/**
 * Writes the /help owner-review fixtures (server/game/assist/__fixtures__):
 * about 40 decisions with the exact text the engine gives for them, picked
 * from seeded Mary games so that every main reason code that occurs is
 * there once (bids, rule plays, searched plays, forced moves), plus the
 * plan's two worked bid examples (§3.4), a Quick suggestion (rules only), a
 * tutorial answer with glosses and an off-turn status line.
 *
 *   ownerReview.json - {name, note, view, budget, mode, expect} per fixture:
 *                      explain.test.js replays each view and requires the
 *                      same decision and text
 *   ownerReview.md   - the same texts to read (kept in sync by the test)
 *
 *   node server/game/assist/sim/buildFixtures.js          # rewrite both
 *   node server/game/assist/sim/buildFixtures.js --check  # exit 1 if stale
 */

'use strict';

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const fs = require('fs');
const path = require('path');
const { playStateGame } = require('./stateGame');
const { tableAt } = require('./table');
const { seatView, deepFreeze } = require('../seatView');
const { advise } = require('../advise');
const { explain, status } = require('../explain');
const { render, cardText } = require('../copy');
const { mainCode } = require('./assistCoverage');

const DIR = path.join(__dirname, '..', '__fixtures__');
const JSON_FILE = path.join(DIR, 'ownerReview.json');
const MD_FILE = path.join(DIR, 'ownerReview.md');

/** A view as it is stored: JSON (array holes become null). */
const store = (view) => JSON.parse(JSON.stringify(view));
const load = (stored) => deepFreeze(JSON.parse(JSON.stringify(stored)));

/** Which numbers an S.overrides reason quotes (make rate, set rate or points). */
function metricOf(e) {
    const t = e.reasons.join(' ');
    return /bid makes|make your bid/.test(t) ? 'make' : /\bset/.test(t) ? 'set' : 'points';
}

/** What a fixture pins: the decision, the explanation and both renderings. */
function answer(view, { budget = 'full', mode = 'help', kind = 'advice' } = {}) {
    if (kind === 'status') return { status: status(view) };
    const d = advise(view, { budget });
    const e = explain(d, view, { mode });
    return {
        decision: { kind: d.kind, bid: d.bid, card: d.card, forced: d.forced, source: d.source },
        explanation: JSON.parse(JSON.stringify(e)),
        line: render(e, { style: 'line', uses: 2, freeUses: 3, counted: !d.forced }),
        rich: render(e)
    };
}

function fixture(name, note, view, opts = {}) {
    const stored = store(view);
    const expect = answer(load(stored), opts);
    // The stored view must advise exactly as the live one
    if (!opts.kind) {
        const live = advise(view, { budget: opts.budget || 'full' });
        const d = expect.decision;
        if ((live.bid || null) !== (d.bid || null) || JSON.stringify(live.card) !== JSON.stringify(d.card)) {
            throw new Error(`fixture ${name}: the stored view advises differently`);
        }
    }
    return { name, note, budget: opts.budget || 'full', mode: opts.mode || 'help', kind: opts.kind || 'advice', view: stored, expect };
}

function build() {
    const out = [];
    // The plan's worked bid examples (§3.4)
    out.push(fixture('plan-bid-8-cards-last', 'Plan §3.4 example: 8 cards, Alice bids last; Carol 1, Bob 2, Dan 0.',
        seatView(tableAt({ handSize: 8, trump: '5h', hands: { 1: ['HI', 'Ah', '9h', '4h', 'Ac', 'Kc', '7d', '3s'] }, bids: [null, '1', '2', '0'], turn: 1 }), 1)));
    out.push(fixture('plan-bid-3-cards-first', 'Plan §3.4 example: 3 cards, Alice bids first.',
        seatView(tableAt({ handSize: 3, trump: '5h', hands: { 1: ['LO', 'Kh', '8s'] }, bids: [], turn: 1 }), 1)));

    // One decision per main reason code from seeded Mary games (seat order
    // and seeds fixed, so the pick is stable)
    const byCode = new Map();
    let quick = null, tutorial = null, statusView = null;
    for (let seed = 1; seed <= 40; seed++) {
        playStateGame({
            seed,
            onTurn(game, pos) {
                const view = seatView(game, pos);
                const d = advise(view);
                const e = explain(d, view);
                const code = mainCode(e, d);
                // A second example for the common bids and forced moves, three
                // for the search overriding the rules; one for everything else
                const room = code === 'S.overrides' ? 3 : ['B.ev', 'B.evFirst', 'P.forced'].includes(code) ? 2 : 1;
                const list = byCode.get(code) || [];
                const sameKind = list.some((v) => (code === 'P.forced' ? v.hand.length === view.hand.length
                    : code === 'S.overrides' ? metricOf(explain(advise(v), v)) === metricOf(e) : false));
                if (list.length < room && !sameKind) {
                    list.push(view);
                    byCode.set(code, list);
                }
                if (!quick && d.source === 'search' && advise(view, { budget: 'rules' }).card.rank !== d.card.rank) quick = view;
                if (!tutorial && d.kind === 'card' && !d.forced && game.currentHand === 12 && game.trickHistory.length === 1) tutorial = view;
                if (!statusView && game.stage === 'PLAYING' && game.trickHistory.length === 2) {
                    statusView = seatView(game, (pos % 4) + 1);
                }
            }
        });
    }
    const order = [...byCode.keys()].sort();
    for (const code of order) {
        byCode.get(code).forEach((view, i) => {
            out.push(fixture(`${code}${i ? `-${i + 1}` : ''}`, `Main reason ${code}.`, view));
        });
    }
    out.push(fixture('quick-rules-only', 'Budget fallback: the server is busy, so rules only (the search would play another card).', quick, { budget: 'rules' }));
    out.push(fixture('tutorial-gloss', 'Tutorial mode: the same advice plus glosses for the game words it uses.', tutorial, { mode: 'tutorial' }));
    out.push(fixture('status-off-turn', 'Asked off turn: the status line (not counted).', statusView, { kind: 'status' }));
    return out;
}

function markdown(fixtures) {
    const lines = ['# /help owner-review fixtures', '',
        'GENERATED by `server/game/assist/sim/buildFixtures.js` with ownerReview.json; explain.test.js keeps the two in sync.',
        'Each entry: the position (the asker is the seat on turn), then the card (rich) text and the one-line text for clients without the card.', ''];
    for (const f of fixtures) {
        const v = f.view;
        const bids = [1, 2, 3, 4].map((p) => `${v.names[p]} ${v.playerBids[p - 1] ?? '-'}`).join(', ');
        const table = v.playedCards.some((c) => c) ? ` Table: ${[1, 2, 3, 4].filter((p) => v.playedCards[p - 1]).map((p) => `${v.names[p]} ${cardText(v.playedCards[p - 1])}`).join(', ')}.` : '';
        lines.push(`## ${f.name}`, '', `${f.note}`, '');
        lines.push(`${v.names[v.position]}, ${v.handSize}-card hand, trump ${cardText(v.trump)}. Hand: ${v.hand.map(cardText).join(' ')}. Bids: ${bids}.${table}`, '');
        if (f.expect.status) {
            lines.push(`> ${f.expect.status}`, '');
            continue;
        }
        const e = f.expect.explanation;
        lines.push(`> **${e.headline}** · ${f.expect.rich.label}`);
        for (const r of e.reasons) lines.push(`> ${r}`);
        for (const d of e.details) lines.push(`> - Why: ${d}`);
        if (e.gloss) for (const g of e.gloss) lines.push(`> - *${g.term}*: ${g.text}`);
        lines.push(`> *${f.expect.rich.footer}*`, '', `Line: ${f.expect.line}`, '', `Codes: ${e.codes.join(', ')}`, '');
    }
    return lines.join('\n');
}

function main() {
    const check = process.argv.includes('--check');
    const fixtures = build();
    const json = `${JSON.stringify(fixtures, null, 1)}\n`;
    const md = markdown(fixtures);
    if (check) {
        const stale = !fs.existsSync(JSON_FILE) || fs.readFileSync(JSON_FILE, 'utf8') !== json ||
            !fs.existsSync(MD_FILE) || fs.readFileSync(MD_FILE, 'utf8') !== md;
        console.log(stale ? 'owner-review fixtures are stale' : 'owner-review fixtures are current');
        process.exitCode = stale ? 1 : 0;
        return;
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(JSON_FILE, json);
    fs.writeFileSync(MD_FILE, md);
    console.log(`${fixtures.length} fixtures written to ${path.relative(process.cwd(), DIR)}`);
}

if (require.main === module) main();

module.exports = { build, markdown, answer, load, JSON_FILE, MD_FILE };
