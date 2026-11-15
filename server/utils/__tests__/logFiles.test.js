/**
 * File logs (server/utils/logger.js fileLogsEnabled) are for local runs
 * only: on Railway or in production stdout is the log, so the privacy
 * policy's log retention is Railway's and nothing outlives it in the
 * container.
 */

const { fileLogsEnabled } = require('../logger');

test.each([
    [{}, true],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'test' }, false],
    [{ NODE_ENV: 'production' }, false],
    [{ RAILWAY_ENVIRONMENT_NAME: 'production' }, false],
    [{ NODE_ENV: 'development', RAILWAY_ENVIRONMENT: 'staging' }, false],
    [{ RAILWAY_PROJECT_ID: 'x' }, false],
])('%j -> %s', (env, enabled) => {
    expect(fileLogsEnabled(env, true)).toBe(enabled);
});

test('never when the logs directory is not writable', () => {
    expect(fileLogsEnabled({}, false)).toBe(false);
});
