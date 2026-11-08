/**
 * Jest setupFilesAfterEnv hook: every test must finish with zero FSM
 * violations (illegal transitions, legacy phase/bidding writes, broken
 * invariants). Violations raised inside timers or fire-and-forget promises
 * are swallowed by their catch handlers, so the recorded list — not a throw —
 * is the reliable signal.
 */

const GamePhase = require('../game/GamePhase');

afterEach(() => {
    const violations = GamePhase.getViolations();
    GamePhase.resetViolations();
    if (violations.length > 0) {
        const summary = violations.map(({ stack, ...v }) => JSON.stringify(v)).join('\n  ');
        throw new Error(`FSM violations recorded during this test:\n  ${summary}\n\nFirst stack:\n${violations[0].stack}`);
    }
});
