/**
 * The back at the end of a hand (backColour.test.js: the settled table).
 * The finished hand's won tricks whisk into its trump, which flips face
 * down: all of it stays the finished hand's colour until the next deal,
 * although the next hand's gameStart (GameState.handNo + 1) lands in the
 * same tick as the handComplete and the deal waits for the whisk. A
 * recorded game (events-bots-s14, seat 1, from the draw) through the real
 * page and scene, sampled every 25 ms across each hand boundary.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let rec;
let wantBack;
let replayNotingWhiskBacks;

beforeAll(async () => {
  const replay = await import('../testing/replay.js');
  ({ wantBack, replayNotingWhiskBacks } = await import('../testing/backFrames.js'));
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
});

afterAll(() => vi.useRealTimers());

describe('the back at the whisk (seat 1, live)', () => {
  it('the whisking tricks and the trump flipping face down stay the finished hand\'s colour until the next deal', () => {
    const seen = replayNotingWhiskBacks(page, rec.logs.seat1);

    // the boundaries were sampled mid-whisk, with the next gameStart already in
    const finished = [...new Set(seen.map((s) => s.finished))];
    expect(finished).toEqual(expect.arrayContaining([1, 2, 3]));
    for (const n of [1, 2, 3]) {
      const at = seen.filter((s) => s.finished === n);
      expect(at.some((s) => s.handNo === n + 1 && s.whisking > 0), `hand ${n}: gameStart in during the whisk`).toBe(true);
      // the trump turned face down while the stacks were still flying
      expect(at.some((s) => s.trump.length && s.whisking > 0), `hand ${n}: trump face down mid-whisk`).toBe(true);
    }

    for (const s of seen) {
      const want = wantBack(s.finished);
      expect(s.all.every((f) => f === want), `whisk after hand ${s.finished} (GameState hand ${s.handNo}): ${[...new Set(s.all)]}`).toBe(true);
    }
  });
});
