/**
 * The card back alternates red and blue by hand (owner, 2026-11-13): the
 * draw for deal and hand 1 red, hand 2 blue, hand 3 red, ... Every back on
 * the table (opponent fans, the draw's deck, the face-down trump, won-trick
 * stacks) is the current hand's colour and the switch comes with the next
 * hand's deal. A recorded game (events-bots-s14, seat 1, from the draw)
 * through the real page and scene. Rejoin: backColourRejoin.test.js;
 * spectator: backColourSpectator.test.js.
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
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
});

afterAll(() => vi.useRealTimers());

describe('the back alternates red and blue by hand (seat 1, live)', () => {
  it('the draw\'s deck red, hand 1 red, hand 2 blue, hand 3 red ...: every back of the table the hand\'s colour', () => {
    const seen = replayNotingBacks(page, rec.logs.seat1);

    // the draw for deal (no hand yet): the deck is red
    const draw = seen.filter((s) => s.handNo === 0 && s.deck.length);
    expect(draw.length).toBeGreaterThan(0);
    expect(draw.every((s) => s.all.every((f) => f === 'back-red'))).toBe(true);

    // each hand: every back on the table the hand's colour
    const hands = new Set(seen.filter((s) => s.handNo > 0).map((s) => s.handNo));
    expect([...hands]).toEqual(expect.arrayContaining([1, 2, 3, 4]));
    for (const s of seen.filter((x) => x.handNo > 0)) {
      expect(s.all.every((f) => f === wantBack(s.handNo)), `hand ${s.handNo} ${s.stage}: ${[...new Set(s.all)]}`).toBe(true);
    }
    expect(seen.flatMap((s) => s.missing)).toEqual([]);
    // the opponents' fans
    const fansIn = (n) => seen.filter((s) => s.handNo === n).flatMap((s) => s.fans);
    expect(fansIn(1).length).toBeGreaterThan(0);
    expect(new Set(fansIn(1))).toEqual(new Set(['back-red']));
    expect(new Set(fansIn(2))).toEqual(new Set(['back-blue']));
    expect(new Set(fansIn(3))).toEqual(new Set(['back-red']));
    expect(new Set(fansIn(4))).toEqual(new Set(['back-blue']));
    // the opponents' won tricks, face down
    const stacksIn = (n) => seen.filter((s) => s.handNo === n).flatMap((s) => s.stacks);
    expect(new Set(stacksIn(1))).toEqual(new Set(['back-red']));
    expect(new Set(stacksIn(2))).toEqual(new Set(['back-blue']));
    // the face-down trump of a fresh deal is the new hand's colour
    for (const s of seen.filter((x) => x.trump.length)) expect(s.trump[0], `trump in hand ${s.handNo}`).toBe(wantBack(s.handNo));
  });
});
