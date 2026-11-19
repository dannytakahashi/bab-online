/**
 * safeTimeout / safeInterval: a throwing callback is logged with its label
 * and stack and never reaches uncaughtException; timing and handles are
 * those of the plain timers. A source scan keeps new bare timers out of
 * server code.
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');
const { safeTimeout, safeInterval, guard } = require('../safeTimer');

let errors;

beforeEach(() => {
    jest.useFakeTimers();
    errors = [];
    jest.spyOn(logger, 'error').mockImplementation((msg, meta) => { errors.push({ msg, meta }); });
});

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

test('a throwing timeout callback is logged with its label and stack, and nothing throws', () => {
    safeTimeout(() => { throw new Error('boom'); }, 100, 'unitTimer');
    expect(() => jest.advanceTimersByTime(100)).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toBe('Timer callback failed');
    expect(errors[0].meta).toMatchObject({ timer: 'unitTimer', error: 'boom' });
    expect(errors[0].meta.stack).toMatch(/boom/);
});

test('same timing as setTimeout; the handle clears and unrefs like one', () => {
    const fn = jest.fn();
    const t = safeTimeout(fn, 250, 'timing');
    expect(typeof t.unref).toBe('function');
    jest.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);

    const cleared = jest.fn();
    clearTimeout(safeTimeout(cleared, 10, 'cleared'));
    jest.advanceTimersByTime(50);
    expect(cleared).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
});

test('an interval keeps ticking after a failed tick', () => {
    let n = 0;
    const h = safeInterval(() => {
        n++;
        if (n === 2) throw new Error('tick 2');
    }, 1000, 'unitInterval');
    jest.advanceTimersByTime(3000);
    expect(n).toBe(3);
    expect(errors.map((e) => e.meta.error)).toEqual(['tick 2']);
    clearInterval(h);
});

test('an async callback that rejects is logged, not an unhandled rejection', async () => {
    const wrapped = guard(async () => { throw new Error('later'); }, 'asyncTimer');
    expect(() => wrapped()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect(errors[0].meta).toMatchObject({ timer: 'asyncTimer', error: 'later' });
});

test('a non-Error throw is still logged', () => {
    guard(() => { throw 'plain'; }, 'stringThrow')(); // eslint-disable-line no-throw-literal
    expect(errors[0].meta).toMatchObject({ timer: 'stringThrow', error: 'plain' });
});

describe('the server timers that use it', () => {
    test('tournament cleanup: a throw while deleting is logged and the process keeps going', () => {
        jest.spyOn(require('../logger').socketLogger, 'info').mockImplementation(() => {});
        const gameManager = require('../../game/GameManager');
        const { scheduleTournamentCleanup } = require('../../socket/tournamentHandlers');
        jest.spyOn(gameManager, 'getTournamentById').mockImplementation(() => { throw new Error('cleanup broke'); });
        scheduleTournamentCleanup({}, 'T-x', 10);
        expect(() => jest.advanceTimersByTime(10)).not.toThrow();
        expect(errors).toEqual([expect.objectContaining({ meta: expect.objectContaining({ timer: 'tournamentCleanup', error: 'cleanup broke' }) })]);
    });

    test('lobby seat grace: a throw on expiry is logged and the grace entry is still dropped', () => {
        const gameManager = require('../../game/GameManager');
        const lobbyId = 'L-grace';
        gameManager.lobbies.set(lobbyId, { players: [{ socketId: 's-grace', username: 'Gus', isBot: false, ready: true }], readyPlayers: new Set(['s-grace']), messages: [] });
        gameManager.playerLobbies.set('s-grace', lobbyId);
        jest.spyOn(gameManager, 'expireLobbySeat').mockImplementation(() => { throw new Error('expire broke'); });
        expect(gameManager.suspendLobbySeat('s-grace', jest.fn())).not.toBeNull();
        expect(gameManager.lobbyGrace.has('s-grace')).toBe(true);
        expect(() => jest.advanceTimersByTime(gameManager.constructor.LOBBY_SEAT_GRACE_MS)).not.toThrow();
        expect(gameManager.lobbyGrace.has('s-grace')).toBe(false);
        expect(errors[0].meta).toMatchObject({ timer: 'lobbySeatGrace', error: 'expire broke' });
        gameManager.lobbies.delete(lobbyId);
    });
});

// Bare timer calls (BARE_TIMER_RE) left in server code, each one either
// a promise resolve / abort that cannot throw, or guarded inside. A new
// timer that does real work uses safeTimeout/safeInterval (or
// game.setTimer for a game's own timers); add it here only if it cannot throw.
const BARE_TIMERS = {
    'database.js': 2, // backoff sleep, whenReady timeout: resolve only
    'demo/ambientBots.js': 2, // both call safeTick (its own try/catch)
    'game/GameState.js': 3, // pause() resolve and its re-arm after a suspension (unsuspend); setTimer, which guards fn
    'game/bot/BotController.js': 1, // _arm: bot bid/play and draw run their own try/catch with game context (chat goes through safeTimeout)
    'routes/avatar.js': 1, // lookup wait: resolve(false)
    'utils/safeTimer.js': 3, // the wrappers themselves
    'utils/shutdown.js': 3, // notice / settle waits, the hard-exit deadline
    'utils/timing.js': 3, // delay (resolve), schedule/debounce (unused helpers)
    'voice/turnCredentials.js': 1, // fetch timeout: ac.abort()
};

// Every way a callback can run later outside the caller's try/catch: the
// globals bare or through global/globalThis/timers, plus process.nextTick
// and queueMicrotask. A method on another object (foo.setTimeout) is not one.
const BARE_TIMER_RE = /(?<![\w.])(?:(?:global|globalThis|timers|process|\))\.)?(?:set(?:Timeout|Interval|Immediate)|nextTick|queueMicrotask)\(/g;

test('the bare-timer scan sees every form', () => {
    const count = (src) => (src.match(BARE_TIMER_RE) || []).length;
    expect(count('setTimeout(f, 1); setInterval(f, 1); setImmediate(f);')).toBe(3);
    expect(count('global.setTimeout(f); globalThis.setInterval(f); timers.setImmediate(f);')).toBe(3);
    expect(count("require('timers').setTimeout(f, 1);")).toBe(1);
    expect(count('process.nextTick(f); queueMicrotask(f);')).toBe(2);
    expect(count('safeTimeout(f, 1); game.setTimer(f); foo.setTimeout(f); clearTimeout(t);')).toBe(0);
});

test('no new bare timers in server code', () => {
    const root = path.join(__dirname, '..', '..');
    const found = {};
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (['__tests__', 'testUtils', 'node_modules'].includes(entry.name)) continue;
                walk(full);
            } else if (entry.name.endsWith('.js')) {
                const src = fs.readFileSync(full, 'utf8');
                const n = (src.match(BARE_TIMER_RE) || []).length;
                if (n) found[path.relative(root, full).split(path.sep).join('/')] = n;
            }
        }
    };
    walk(root);
    expect(found).toEqual(BARE_TIMERS);
});
