/**
 * The deploy's time budget (deploy survival PR 5; docs/claude/server-infra.md
 * Deploys): Railway's drainingSeconds (.railway/railway.ts, SIGTERM to
 * SIGKILL) must cover the whole graceful shutdown with room to spare, and
 * the handoff must close the sockets before iOS's 8 s disconnect wait
 * (RestartNotice.swift) gives up on the restart toast.
 */

// Integration test (real Socket.IO / two instances / chaos): CI's slower runners take
// 3-5 s on cases that run in about 2 s on a laptop, so the 5 s default is too tight.
jest.setTimeout(30000);
const fs = require('fs');
const path = require('path');
const shutdown = require('../utils/shutdown');
const handoff = require('../game/persist/handoff');
const liveStore = require('../game/persist/liveStore');

const IOS_DISCONNECT_WAIT_MS = 8000;

function drainingSeconds() {
    const src = fs.readFileSync(path.join(__dirname, '../../.railway/railway.ts'), 'utf8');
    const m = src.match(/drainingSeconds:\s*(\d+)/);
    if (!m) throw new Error('drainingSeconds not found in .railway/railway.ts');
    return Number(m[1]);
}

test('drainingSeconds is 20 and covers HARD_EXIT_MS (15 s) with 5 s to spare', () => {
    expect(drainingSeconds()).toBe(20);
    expect(shutdown.HARD_EXIT_MS).toBe(15000);
    expect(drainingSeconds() * 1000).toBeGreaterThanOrEqual(shutdown.HARD_EXIT_MS + 5000);
});

test('settle + successor + flush + notice = 6.5 s to io.close, under iOS\'s 8 s disconnect wait and at most 7 s', () => {
    const span = handoff.HANDOFF_SETTLE_MS + handoff.SUCCESSOR_MS + handoff.FLUSH_MS + shutdown.NOTICE_MS;
    expect(span).toBe(6500);
    expect(span).toBe(shutdown.HANDOFF_SPAN_MS);
    expect(span).toBeLessThanOrEqual(7000);
    expect(span).toBeLessThan(IOS_DISCONNECT_WAIT_MS);
    expect([handoff.HANDOFF_SETTLE_MS, handoff.SUCCESSOR_MS, handoff.FLUSH_MS]).toEqual([500, 1000, 4000]);
});

test('the flush: the final writes are cut inside it, leaving the release and the delete their share', () => {
    expect(handoff.FLUSH_WRITE_MS).toBeLessThan(handoff.FLUSH_MS);
    expect(handoff.FLUSH_MS - handoff.FLUSH_WRITE_MS).toBeGreaterThanOrEqual(1000);
});

test('the in-flight drain gets what is left: 15 - 6.5 - 0.5 settle - 1 margin = 7 s; the whole path fits the hard deadline', () => {
    const drain = shutdown.HARD_EXIT_MS - shutdown.HANDOFF_SPAN_MS - shutdown.SETTLE_MS - shutdown.DRAIN_MARGIN_MS;
    expect(drain).toBe(7000);
    expect(shutdown.HANDOFF_SPAN_MS + drain + shutdown.SETTLE_MS).toBeLessThan(shutdown.HARD_EXIT_MS);
});

test('the other bounded waits fit too: the crash release and the no-successor delete 2 s, the write-mode self-delete 2 s', () => {
    expect(handoff.CRASH_RELEASE_MS).toBeLessThanOrEqual(2000);
    expect(handoff.NO_SUCCESSOR_DELETE_MS).toBeLessThanOrEqual(handoff.FLUSH_MS);
    expect(liveStore.SHUTDOWN_DELETE_MS).toBeLessThanOrEqual(2000);
    // The crash path: release + notice well before the hard deadline
    expect(handoff.CRASH_RELEASE_MS + shutdown.NOTICE_MS).toBeLessThan(IOS_DISCONNECT_WAIT_MS);
});
