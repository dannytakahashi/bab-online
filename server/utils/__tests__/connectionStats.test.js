/**
 * Connection arrivals for the deploy measurements (server/utils/
 * connectionStats.js): the SIGTERM line's lastConnectionAt and
 * connectionsInLast60s, and the "first connection" flag socket/index.js logs on.
 */

const fs = require('fs');
const path = require('path');
const stats = require('../connectionStats');

afterEach(() => stats._resetForTests());

test('empty before any connection', () => {
    expect(stats.connectionStats(1000)).toEqual({ lastConnectionAt: null, connectionsInLast60s: 0, connectionsTotal: 0 });
});

test('only the first connection of the process is flagged first', () => {
    expect(stats.noteConnection(1000)).toBe(true);
    expect(stats.noteConnection(2000)).toBe(false);
    expect(stats.noteConnection(3000)).toBe(false);
});

test('counts arrivals in the last 60 s, the last one as an ISO time with ms', () => {
    const t0 = Date.UTC(2026, 10, 16, 12, 0, 0, 0);
    stats.noteConnection(t0);
    stats.noteConnection(t0 + 30000);
    stats.noteConnection(t0 + 59999);
    expect(stats.connectionStats(t0 + 59999)).toEqual({
        lastConnectionAt: '2026-11-16T12:00:59.999Z', connectionsInLast60s: 3, connectionsTotal: 3,
    });
    // The first leaves the window exactly 60 s after it came
    expect(stats.connectionStats(t0 + 60000).connectionsInLast60s).toBe(2);
    expect(stats.connectionStats(t0 + 200000)).toEqual({
        lastConnectionAt: '2026-11-16T12:00:59.999Z', connectionsInLast60s: 0, connectionsTotal: 3,
    });
});

test('no dependencies (server/utils/shutdown.js reads it)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'connectionStats.js'), 'utf8');
    expect(src).not.toMatch(/require\(/);
});
