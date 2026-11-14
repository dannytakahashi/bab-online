/**
 * A reload mid-hand after tricks were already won (a bots recording's seat 1 rejoin,
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
  // the first bots recording whose rejoin hand has an opponent trick and,
  // after it, a partner trick (which recording that is depends on the bots' bids)
  rec = ['events-bots-s14', 'events-bots-s12'].map((n) => replay.loadRecording(n)).find((r) => {
    const log = r.logs['seat1-rejoin'];
    if (!log) return false;
    let opp = false;
    for (const e of log.slice(1)) {
      if (e.event === 'handComplete') return false;
      if (e.event !== 'trickComplete') continue;
      if (e.data.winner % 2 === 0) opp = true;
      else if (opp) return true;
    }
    return false;
  });
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

    // play on to the first partner trick after an opponent trick (opponent
    // tricks face down, every trick the partners win live face up)
    const firstOpp = log.findIndex((e, i) => i > 0 && e.event === 'trickComplete' && e.data.winner % 2 === 0);
    const done = log.findIndex((e, i) => i > firstOpp && e.event === 'trickComplete' && e.data.winner % 2 === 1);
    expect(firstOpp).toBeGreaterThan(0);
    expect(done).toBeGreaterThan(firstOpp);
    const live = log.slice(1, done + 1).filter((e) => e.event === 'trickComplete');
    const oppLive = live.filter((e) => e.data.winner % 2 === 0).length;
    const teamLive = live.length - oppLive;
    replay.replayLog(page, log, { from: 1, to: done + 1 });
    replay.advance(800);
    const before = stacks(page.scene.trickManager._teamTrickHistory);
    expect(before).toHaveLength(1 + teamLive);
    expect(faceDown(before[0])).toBe(true);
    expect(before.slice(1).every(faceUp)).toBe(true);

    // a tab return with something applied while hidden renders the model again
    page.scene.director.fastForward('visible');
    const after = stacks(page.scene.trickManager._teamTrickHistory);
    expect(after).toEqual(before);
    expect(stacks(page.scene.trickManager._oppTrickHistory).map(faceDown)).toEqual(Array(1 + oppLive).fill(true));
    expect(page.scene.trickManager.spriteCounts()).toMatchObject({ teamStacks: 1 + teamLive, oppStacks: 1 + oppLive, stackCards: (2 + teamLive + oppLive) * 4 });
  });
});
