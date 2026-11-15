/**
 * LOG_LEVEL (server/utils/logger.js): honoured when it names a level,
 * otherwise today's defaults (debug in development, info elsewhere). The
 * console format is unchanged.
 */

const { resolveLevel } = require('../logger');

let warn;
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

test.each([
    [{}, 'debug'],
    [{ NODE_ENV: 'development' }, 'debug'],
    [{ NODE_ENV: 'production' }, 'info'],
    [{ NODE_ENV: 'test' }, 'info'],
    [{ NODE_ENV: 'production', LOG_LEVEL: '' }, 'info'],
    [{ NODE_ENV: 'production', LOG_LEVEL: '   ' }, 'info'],
])('defaults: %j -> %s', (env, level) => {
    expect(resolveLevel(env)).toBe(level);
    expect(warn).not.toHaveBeenCalled();
});

test.each(['error', 'warn', 'info', 'http', 'debug'])('LOG_LEVEL=%s is used as is', (level) => {
    expect(resolveLevel({ NODE_ENV: 'production', LOG_LEVEL: level })).toBe(level);
});

test('case and spaces are ignored', () => {
    expect(resolveLevel({ NODE_ENV: 'production', LOG_LEVEL: ' DEBUG ' })).toBe('debug');
});

test.each(['verbose', 'silly', 'trace', 'none'])('an unknown LOG_LEVEL=%s is reported and the default kept', (value) => {
    expect(resolveLevel({ NODE_ENV: 'production', LOG_LEVEL: value })).toBe('info');
    expect(resolveLevel({ NODE_ENV: 'development', LOG_LEVEL: value })).toBe('debug');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring LOG_LEVEL'));
});

test('the logger itself starts at the resolved level', () => {
    jest.isolateModules(() => {
        const saved = { ...process.env };
        try {
            process.env.LOG_LEVEL = 'warn';
            const { logger } = require('../logger');
            expect(logger.level).toBe('warn');
        } finally {
            process.env = saved;
        }
    });
});
