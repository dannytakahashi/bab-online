/**
 * The recorded 4-human game (events-humans-s13, seat 3 = ios_dee at
 * position 4: a rejected play answered by restorePlayerState, an `error` /
 * `serverError` twin) on the POST-GATE wire (testing/postGateWire.js: no
 * `error`, no playerAssigned, no gameStart playerInfo, no seat socket ids,
 * snapshot-only carriers):
 * my seat is known from positionUpdate before the first deal, and the table
 * (counts and seat names) matches every live checkpoint, as on today's wire.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  const { postGateRecording } = await import('../testing/postGateWire.js');
  const raw = replay.loadRecording('events-humans-s13');
  // the transforms really bite on this log
  const events = (log) => new Set(log.filter((e) => e.dir === 's2c').map((e) => e.event));
  expect([...events(raw.logs.seat3)]).toEqual(expect.arrayContaining(['error', 'serverError', 'playerAssigned', 'restorePlayerState']));
  rec = postGateRecording(raw);
  expect(events(rec.logs.seat3).has('error')).toBe(false);
  expect(events(rec.logs.seat3).has('playerAssigned')).toBe(false);
  page = await replay.realTablePage({ username: 'ios_dee' });
});

afterAll(() => vi.useRealTimers());

describe('post-gate wire, seat 3 (position 4)', () => {
  it('my seat from positionUpdate alone, then every checkpoint', async () => {
    const log = rec.logs.seat3;
    const seen = {};
    const byIndex = new Map(replay.tableCheckpoints(rec, 'seat3').map((c) => [c.afterIndex, c]));
    const results = [];
    replay.replayLog(page, log, {
      before: (e) => {
        // the first deal has not come yet: only positionUpdate said where I sit
        if (e.event === 'teamsAnnounced' && seen.teams === undefined) {
          seen.teams = { position: page.gameState.position, partner: page.gameState.partnerName };
        }
        const cp = byIndex.get(e.i);
        if (cp && page.scene.director.waiting === 0) {
          // the seat names too: no gameStart.playerInfo (#5) re-sends them each deal
          const pd = page.gameState.playerData;
          const names = Object.fromEntries(pd.position.map((p, i) => [p, pd.username[i]?.username ?? pd.username[i]]));
          results.push({
            i: e.i,
            live: { ...replay.liveCounts(page.scene), names },
            want: { ...replay.expectedCounts(cp.snapshot), names: Object.fromEntries(cp.snapshot.seats.map((x) => [x.position, x.username])) },
          });
        }
      },
    });
    expect(seen.teams).toEqual({ position: 4, partner: 'ios_cal' });
    expect(results.length).toBeGreaterThan(100);
    expect(results.filter((r) => JSON.stringify(r.live) !== JSON.stringify(r.want))).toEqual([]);
    // (this viewer's recording stops in a later hand: still at the table)
    expect(page.session.screen).toBe('table');
    // no socket id reached the seats: the voice glow maps by username
    expect((page.gameState.playerData.socket || []).every((s) => s === null || s === undefined)).toBe(true);
    expect(page.gameState.seatOwners).toEqual({ 1: 'ios_bea', 2: 'ios_cal', 3: 'ios_eli', 4: 'ios_dee' });
    const { getSeqGate } = await import('../state/SeqGate.js');
    expect(getSeqGate().stats.gaps).toBe(0);
  });
});
