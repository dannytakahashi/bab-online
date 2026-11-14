/**
 * A reload mid-hand after tricks were already won (events-bots-s14, seat 1,
 * the real page and scene), from a server whose snapshot only counts those
 * tricks (no trickHistory that matches the counts: an older server), so
 * they are face-down stacks (with trickHistory: reloadWonTricks.test.js). The tricks won live after the reload are seen
 * being collected face up, and they must stay face up on any later render
 * in the hand (a tab return's fast-forward, a ping reply, an actionRejected),
 * not flip to card backs.
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
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1-r1' });
});

afterAll(() => vi.useRealTimers());

/** Each stack's cards as texture keys ('cardBack': the atlas's back frame, or 'cards:<frame>' for a face). */
const stacks = (history) => history.map((t) => t.cards.map((c) => (c.texture?.key === 'cards' && /^back-(red|blue)$/.test(c.frame?.name || '') ? 'cardBack' : `${c.texture?.key}:${c.frame?.name ?? ''}`)));
const faceDown = (stack) => stack.length === 4 && stack.every((k) => k === 'cardBack');
const faceUp = (stack) => stack.length === 4 && stack.every((k) => k.startsWith('cards:'));

describe('a reload after tricks were won: the tricks seen live keep their faces', () => {
  it('the snapshot-counted tricks are backs, the live ones faces, before and after a fast-forward', () => {
    const log = rec.logs['seat1-rejoin'];
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    const rejoin = JSON.parse(JSON.stringify(log[0].data));
    // one trick per team was already won before the reload
    rejoin.snapshot.tricks = { team1: 1, team2: 1 };
    page.socket.fire('rejoinSuccess', rejoin);
    replay.advance(100);
    const tm = page.scene.trickManager;
    expect(stacks(tm._teamTrickHistory).map(faceDown)).toEqual([true]);
    expect(stacks(tm._oppTrickHistory).map(faceDown)).toEqual([true]);

    // the opponents win the next trick (face down), then the partner one (face up)
    const done = log.findIndex((e, i) => i > 0 && e.event === 'trickComplete' && e.data.winner % 2 === 1);
    expect(done).toBeGreaterThan(0);
    expect(log.slice(1, done).filter((e) => e.event === 'trickComplete')).toHaveLength(1);
    replay.replayLog(page, log, { from: 1, to: done + 1 });
    replay.advance(800);
    const before = stacks(page.scene.trickManager._teamTrickHistory);
    expect(before).toHaveLength(2);
    expect(faceDown(before[0])).toBe(true);
    expect(faceUp(before[1])).toBe(true);

    // a tab return with something applied while hidden renders the model again
    page.scene.director.fastForward('visible');
    const after = stacks(page.scene.trickManager._teamTrickHistory);
    expect(after).toEqual(before);
    expect(stacks(page.scene.trickManager._oppTrickHistory).map(faceDown)).toEqual([true, true]);
    expect(page.scene.trickManager.spriteCounts()).toMatchObject({ teamStacks: 2, oppStacks: 2, stackCards: 16 });
  });
});
