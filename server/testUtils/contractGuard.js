/**
 * Jest setupFilesAfterEnv hook (after fsmGuard): every test whose emits were
 * recorded through a gameDriver makeIo / makeSocket log must finish with
 * zero socket-contract violations (server/testUtils/contractCheck.js).
 *
 *   contractGuard.skip(reason)  this test only — synthetic forcePhase
 *                               states production never emits; every use
 *                               is listed in contract/README.md
 *   BAB_CONTRACT=0              turns the check off for a run
 */

'use strict';

const contractCheck = require('./contractCheck');

let skipped = null;

function skip(reason) {
    if (!reason) throw new Error('contractGuard.skip needs a reason');
    skipped = reason;
}

afterEach(() => {
    const violations = contractCheck.takeViolations();
    const why = skipped;
    skipped = null;
    contractCheck.setContext(null);
    if (why || violations.length === 0) return;
    let name = '';
    try {
        name = expect.getState().currentTestName || '';
    } catch {
        // outside a test
    }
    const lines = violations.slice(0, 5).map((v) => JSON.stringify(v, null, 1)).join('\n');
    throw new Error(`Contract violations (${violations.length}) in "${name}"` +
        `${violations[0].context ? ` [${violations[0].context}]` : ''}:\n${lines}\n\n` +
        'Fix the server or contract/src (only for variants the real server emits); see contract/README.md.');
});

module.exports = { skip };
