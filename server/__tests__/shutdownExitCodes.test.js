/**
 * Exit codes of the graceful shutdown (server/utils/shutdown.js). Railway
 * restarts the service ON_FAILURE only, so a deploy's SIGTERM (and a local
 * ^C) must exit 0 and a crash (uncaughtException) must exit 1, after the
 * same restart notice and close, within a hard deadline. process.exit is
 * stubbed; the handlers are called directly (Jest owns process-level
 * uncaughtException while a test runs).
 */

const { logger } = require('../utils/logger');
const { setupGracefulShutdown, NOTICE_MS, SETTLE_MS, HARD_EXIT_MS } = require('../utils/shutdown');

const SIGNALS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];

let before;
let exit;
let logs;
let savedExitCode;

function fakeServers({ emitThrows = false } = {}) {
    const order = [];
    const server = { close: jest.fn((cb) => { order.push('server.close'); cb?.(); }) };
    const io = {
        emit: jest.fn((event) => {
            if (emitThrows) throw new Error('io half broken');
            order.push(`emit:${event}`);
        }),
        close: jest.fn((cb) => { order.push('io.close'); cb?.(); }),
    };
    return { server, io, order };
}

beforeEach(() => {
    jest.useFakeTimers();
    before = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
    savedExitCode = process.exitCode;
    logs = [];
    exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
    for (const m of ['error', 'warn', 'info', 'debug']) {
        jest.spyOn(logger, m).mockImplementation((msg, meta) => { logs.push({ level: m, msg, meta }); });
    }
});

afterEach(() => {
    for (const s of SIGNALS) {
        for (const fn of process.listeners(s)) if (!before[s].includes(fn)) process.removeListener(s, fn);
    }
    process.exitCode = savedExitCode;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

test('registers SIGTERM, SIGINT, uncaughtException and unhandledRejection handlers', () => {
    const { server, io } = fakeServers();
    const h = setupGracefulShutdown(server, io);
    for (const s of SIGNALS) expect(process.listeners(s).length).toBe(before[s].length + 1);
    expect(process.listeners('uncaughtException')).toContain(h.onUncaughtException);
    expect(process.listeners('unhandledRejection')).toContain(h.onUnhandledRejection);
});

test.each(['SIGTERM', 'SIGINT'])('%s: notice, close, then exit 0', async (signal) => {
    const { server, io, order } = fakeServers();
    setupGracefulShutdown(server, io);
    // The listener this setup added, called directly (no other process
    // listener, e.g. a runner's own SIGINT, gets the signal)
    process.listeners(signal).find((fn) => !before[signal].includes(fn))();
    await jest.advanceTimersByTimeAsync(NOTICE_MS + SETTLE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(order).toEqual(['server.close', 'emit:serverShutdown', 'io.close']);
});

test('uncaughtException: logged, the same notice and close, then exit 1', async () => {
    const { server, io, order } = fakeServers();
    const h = setupGracefulShutdown(server, io);
    h.onUncaughtException(new Error('kaboom'));
    expect(logs.find((l) => l.msg === 'Uncaught exception').meta).toMatchObject({ error: 'kaboom' });
    expect(process.exitCode).toBe(1);
    await jest.advanceTimersByTimeAsync(NOTICE_MS + SETTLE_MS);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(order).toEqual(['server.close', 'emit:serverShutdown', 'io.close']);
});

test('unhandledRejection is logged only: no shutdown, no exit', async () => {
    const { server, io } = fakeServers();
    const h = setupGracefulShutdown(server, io);
    h.onUnhandledRejection(new Error('meh'));
    await jest.advanceTimersByTimeAsync(HARD_EXIT_MS + 1000);
    expect(exit).not.toHaveBeenCalled();
    expect(server.close).not.toHaveBeenCalled();
    expect(logs.find((l) => l.msg === 'Unhandled rejection').meta).toMatchObject({ reason: 'meh' });
});

test('a second reason during a crash shutdown forces exit 1 at once (the first reason decides)', async () => {
    const { server, io } = fakeServers();
    const h = setupGracefulShutdown(server, io);
    h.onUncaughtException(new Error('first'));
    process.emit('SIGTERM');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenLastCalledWith(1);
    expect(server.close).toHaveBeenCalledTimes(1);
});

test('a crash during a SIGTERM shutdown forces exit 0 (the platform asked it to stop)', async () => {
    const { server, io } = fakeServers();
    const h = setupGracefulShutdown(server, io);
    process.emit('SIGTERM');
    h.onUncaughtException(new Error('during deploy'));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenLastCalledWith(0);
});

test('a throw inside the shutdown itself still exits with the crash code', async () => {
    const { server, io } = fakeServers({ emitThrows: true });
    const h = setupGracefulShutdown(server, io);
    h.onUncaughtException(new Error('crash'));
    await jest.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.some((l) => l.msg === 'Graceful shutdown failed, exiting')).toBe(true);
});

test('a shutdown that wedges is cut off by the hard deadline with the same code', async () => {
    const { server, io } = fakeServers();
    // A notice wait far beyond the deadline stands in for any wedged step
    const h = setupGracefulShutdown(server, io, { noticeMs: 10 * 60 * 1000, hardExitMs: 3000 });
    h.onUncaughtException(new Error('crash'));
    await jest.advanceTimersByTimeAsync(2999);
    expect(exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logs.some((l) => l.msg === 'Graceful shutdown timed out, forcing exit')).toBe(true);
});

test('the default deadline covers the normal shutdown', () => {
    expect(HARD_EXIT_MS).toBeGreaterThan(NOTICE_MS + SETTLE_MS);
});

describe('the SIGTERM line carries the deploy measurements', () => {
    const connectionStats = require('../utils/connectionStats');
    afterEach(() => connectionStats._resetForTests());

    test('at (ISO, ms), the connection arrivals and the socket count', async () => {
        jest.setSystemTime(Date.UTC(2026, 10, 16, 12, 0, 30, 250));
        connectionStats.noteConnection(Date.UTC(2026, 10, 16, 11, 59, 0, 0));
        connectionStats.noteConnection(Date.UTC(2026, 10, 16, 12, 0, 10, 5));
        const { server, io } = fakeServers();
        io.of = (ns) => ({ sockets: new Map(ns === '/' ? [['a', {}], ['b', {}]] : []) });
        setupGracefulShutdown(server, io);
        process.listeners('SIGTERM').find((fn) => !before.SIGTERM.includes(fn))();
        const line = logs.find((l) => l.msg === 'Received SIGTERM, starting graceful shutdown');
        expect(line.meta).toEqual({
            exitCode: 0,
            at: '2026-11-16T12:00:30.250Z',
            lastConnectionAt: '2026-11-16T12:00:10.005Z',
            connectionsInLast60s: 1,
            connectionsTotal: 2,
            sockets: 2,
        });
        await jest.advanceTimersByTimeAsync(NOTICE_MS + SETTLE_MS);
        expect(exit).toHaveBeenCalledWith(0);
    });

    test('an io that cannot count gives sockets null, no io gives 0; the shutdown goes on', async () => {
        const { server, io } = fakeServers();
        const h = setupGracefulShutdown(server, io);
        h.shutdown('SIGTERM', 0);
        expect(logs.find((l) => l.msg.startsWith('Received SIGTERM')).meta).toMatchObject({ sockets: null, connectionsInLast60s: 0, lastConnectionAt: null });
        await jest.advanceTimersByTimeAsync(NOTICE_MS + SETTLE_MS);
        expect(exit).toHaveBeenCalledWith(0);

        logs.length = 0;
        const bare = setupGracefulShutdown({ close: (cb) => cb?.() }, null);
        bare.shutdown('SIGINT', 0);
        expect(logs.find((l) => l.msg.startsWith('Received SIGINT')).meta).toMatchObject({ sockets: 0 });
    });
});
