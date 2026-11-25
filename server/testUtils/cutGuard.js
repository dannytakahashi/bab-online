/**
 * Jest setupFilesAfterEnv hook (Cut for a buck, 2026-11-25; in the style of
 * hsiGuard.js): no socket ever receives a card drawn in Cut for a buck
 * before its reveal. Checked on every emit recorded through a gameDriver
 * makeIo / makeSocket log (contractCheck.onEmit) whose event is a
 * cutForABuck* or tournament* event: a card in the payload that is a
 * pending draw of a live cut (server/socket/cutForABuck.js
 * _pendingCardsForTests) and is not also a card already revealed in that
 * cut (its table or last reveal, which only more than 54 players can
 * duplicate) fails the test.
 *
 *   cutGuard.skip(reason)  this test only
 *   BAB_CUT_GUARD=0        turns the check off for a run
 */

'use strict';

const contractCheck = require('./contractCheck');

let violations = [];
let skipped = null;
const MAX = 20;

const enabled = () => process.env.BAB_CUT_GUARD !== '0';
const key = (c) => `${c.suit}:${c.rank}`;

function cardsIn(o, out = [], depth = 0) {
    if (!o || typeof o !== 'object' || depth > 10) return out;
    if (Array.isArray(o)) {
        for (const v of o) cardsIn(v, out, depth + 1);
        return out;
    }
    if (typeof o.suit === 'string' && typeof o.rank === 'string') out.push(o);
    for (const v of Object.values(o)) cardsIn(v, out, depth + 1);
    return out;
}

function checkEntry(entry, wire) {
    if (!enabled() || !wire || typeof wire !== 'object') return;
    if (!/^(cutForABuck|tournament)/.test(entry.event)) return;
    let live;
    try {
        live = require('../socket/cutForABuck')._pendingCardsForTests();
    } catch {
        return;
    }
    if (!live.length) return;
    const sent = cardsIn(wire).map(key);
    if (!sent.length) return;
    for (const cut of live) {
        const revealed = new Set(cut.revealed.map(key));
        for (const card of cut.cards) {
            const k = key(card);
            if (revealed.has(k)) continue;
            if (sent.includes(k) && violations.length < MAX) {
                violations.push({ why: 'a pending Cut for a buck card before its reveal', event: entry.event, to: entry.to, card: k });
            }
        }
    }
}

contractCheck.onEmit((entry, wire) => {
    try {
        checkEntry(entry, wire);
    } catch (err) {
        if (violations.length < MAX) violations.push({ why: `cutGuard threw: ${err.message}`, event: entry?.event });
    }
});

function skip(reason) {
    if (!reason) throw new Error('cutGuard.skip needs a reason');
    skipped = reason;
}

afterEach(() => {
    const v = violations;
    violations = [];
    const why = skipped;
    skipped = null;
    if (why || v.length === 0) return;
    let name = '';
    try {
        name = expect.getState().currentTestName || '';
    } catch {
        // outside a test
    }
    throw new Error(`Cut for a buck card leak (${v.length}) in "${name}"\n` + v.slice(0, 5).map((x) => JSON.stringify(x)).join('\n'));
});

module.exports = { skip, checkEntry, _take: () => { const v = violations; violations = []; return v; } };
