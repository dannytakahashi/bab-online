/**
 * Test harness: replay recorded real-handler games through the page.
 *
 * The recordings are the ones `npm run ios:fixtures` writes (simulate.js
 * --record-ios runs the scripted games of server/testUtils/iosScenarios.js
 * through the real server handlers; iosEventLogs.test.js keeps them in step
 * with the server). Read here, never written: one log per viewer socket
 * ({i, dir, event, to, t, data}) and server snapshots at checkpoints
 * ({viewer, afterIndex, snapshot}).
 *
 * Time: `advance(ms)` steps the fake DOM timers (vi) and the Phaser clock
 * (testing/fakePhaser.js) together, in small slices, so animations, the
 * director's waits and the page's timers interleave as in a browser.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { vi } from 'vitest';
import { clock } from './fakePhaser.js';

// The repo root: npm runs vitest from it (its config root is client/)
const ROOT = existsSync(resolve(process.cwd(), 'contract')) ? process.cwd() : resolve(process.cwd(), '..');
const FIXTURES = resolve(ROOT, 'iOSClient/BABOnlineTests/Fixtures/events');
const V2_FIXTURES = resolve(ROOT, 'contract/fixtures/v2');

export function loadRecording(name) {
  return JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8'));
}

export function loadV2Fixtures() {
  const index = JSON.parse(readFileSync(resolve(V2_FIXTURES, 'index.json'), 'utf8'));
  return index.fixtures.map((f) => JSON.parse(readFileSync(resolve(V2_FIXTURES, f.file), 'utf8')));
}

export function advance(ms, slice = 25) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(slice, left);
    vi.advanceTimersByTime(step);
    clock.step(step);
    left -= step;
  }
}

/** Live-table checkpoints of one viewer (a dealt hand on the table). */
export function tableCheckpoints(rec, viewer) {
  return rec.checkpoints.filter((c) => c.viewer === viewer && c.snapshot?.deal &&
    ['BIDDING', 'PLAYING', 'TRICK_RESOLVING', 'HAND_RESOLVING'].includes(c.snapshot.stage));
}

/**
 * What the table must show for a snapshot: my hand, the other seats' card
 * backs, the trick in play, and 4 stacked cards per completed trick.
 */
export function expectedCounts(snap) {
  const role = snap.viewer.role;
  const me = role === 'spectator' ? null : snap.viewer.position;
  const others = snap.seats.filter((s) => s.position !== me);
  return {
    hand: role === 'spectator' ? 0 : (snap.hand || []).length,
    opponentBacks: others.reduce((n, s) => n + s.cardsInHand, 0),
    trick: snap.trick.cards.length,
    stackCards: (snap.tricks.team1 + snap.tricks.team2) * 4,
  };
}

/**
 * The same four numbers from the live scene. Between handComplete and the
 * next deal the finished hand's stacks are flying back to the trump (the
 * whisk): the server still counts those tricks, so they count as stacked.
 */
export function liveCounts(scene) {
  const c = scene.tableCounts();
  const handOver = scene.state?.stage === 'HAND_RESOLVING';
  return { hand: c.hand, opponentBacks: c.opponentBacks, trick: c.trick, stackCards: c.stackCards + (handOver ? c.whisking : 0) };
}

/** Game-log rows on the page. */
export function logRows() {
  return document.getElementById('gameFeedMessages')?.childElementCount ?? 0;
}

/**
 * Fire a viewer's recorded server events in order, advancing time by the
 * recording's clock between them. `before(entry)` runs at the entry's time,
 * just before it fires: a checkpoint with afterIndex === entry.i reflects
 * every entry before it (the iOS replay tests' convention).
 * @returns {number} the index after the last fired entry
 */
export function replayLog(page, log, { from = 0, to = log.length, before, settle = true } = {}) {
  let lastT = log[from]?.t ?? 0;
  let i = from;
  for (; i < to; i++) {
    const e = log[i];
    if (settle && e.t > lastT) advance(e.t - lastT);
    lastT = e.t;
    before?.(e, i);
    if (e.dir === 's2c') {
      // a fresh copy: handlers may fold or keep the payload
      page.socket.fire(e.event, JSON.parse(JSON.stringify(e.data)));
    }
  }
  return i;
}

/**
 * Replay one viewer's whole log and compare the live table with every
 * live-table checkpoint, just before the entry it precedes.
 * @returns {{results: Array, bad: Array}}
 */
export function replayViewer(page, rec, label, { from = 0 } = {}) {
  const log = rec.logs[label];
  const byIndex = new Map(tableCheckpoints(rec, label).map((c) => [c.afterIndex, c]));
  const results = [];
  const check = (i) => {
    const cp = byIndex.get(i);
    if (!cp) return;
    // a deal still waiting for the first hand's fade or the whisk is not on the table yet
    if (page.scene.director.waiting > 0) return;
    results.push({ i, stage: cp.snapshot.stage, live: liveCounts(page.scene), want: expectedCounts(cp.snapshot) });
  };
  replayLog(page, log, { from, before: (e) => check(e.i) });
  advance(50);
  check(log.length);
  const bad = results.filter((r) => JSON.stringify(r.live) !== JSON.stringify(r.want));
  return { results, bad };
}

/** A real-scene page signed in as `username`, on the main room (or with `session`). */
export async function realTablePage({ username, socketId = 'sock-1', session = {} }) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
  if (!document.getElementById('game-container')) {
    const container = document.createElement('div');
    container.id = 'game-container';
    document.body.appendChild(container);
  }
  const { loadPage } = await import('./fakePage.js');
  const page = await loadPage({ realScene: true, session: { username, sessionToken: `tok-${username}`, ...session }, connected: true, socketId });
  page.socket.fire('restoreSessionResponse', { success: true, username, blockedUsers: [] });
  return page;
}
