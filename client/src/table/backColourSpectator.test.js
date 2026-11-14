/**
 * The back's colour for a spectator (owner, 2026-11-13: red on odd hands,
 * blue on even): the recorded spectator of events-bots-s14 joins mid game
 * and watches to the end; every back on its table (all four seats' fans,
 * the face-down trump of a deal) is the hand's colour.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let wantBack;
let replayNotingBacks;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  ({ wantBack, replayNotingBacks } = await import('../testing/backFrames.js'));
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_fan', socketId: 'ios-spec' });
});

afterAll(() => vi.useRealTimers());

describe('the back\'s colour for a spectator', () => {
  it('the join and every later hand in the hand\'s colour (odd red, even blue)', () => {
    const seen = replayNotingBacks(page, rec.logs.spectator);
    expect(page.session.role).toBe('spectator');
    const hands = new Set(seen.filter((s) => s.handNo > 0).map((s) => s.handNo));
    expect([...hands]).toEqual(expect.arrayContaining([4, 5, 6, 7]));
    for (const s of seen.filter((x) => x.handNo > 0)) {
      expect(s.all.every((f) => f === wantBack(s.handNo)), `hand ${s.handNo} ${s.stage}: ${[...new Set(s.all)]}`).toBe(true);
    }
    expect(seen.flatMap((s) => s.missing)).toEqual([]);
    expect(new Set(seen.filter((s) => s.handNo === 4).flatMap((s) => s.fans))).toEqual(new Set(['back-blue']));
    expect(new Set(seen.filter((s) => s.handNo === 5).flatMap((s) => s.fans))).toEqual(new Set(['back-red']));
  });
});
