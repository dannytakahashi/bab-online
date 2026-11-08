/**
 * Jest setupFilesAfterEnv: every test starts from the env-selected pacing
 * profile (server/game/pacing.js) with no trace listener, whatever the
 * previous test switched to.
 */

const pacing = require('../game/pacing');

afterEach(() => {
    pacing.resetPacing();
});
