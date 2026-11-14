/**
 * The back's colour on a rejoin / reload (owner, 2026-11-13: red on odd
 * hands, blue on even): seat 1 of events-bots-s14 rejoins mid hand 2 (its
 * own server snapshot from that hand) and the table draws every back blue,
 * the opponents' fans and the won tricks' face-down placeholders (an older
 * server: counts only); a relayout and a re-render keep it; a later
 * snapshot of hand 3 draws them red.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let backs;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  ({ backs } = await import('../testing/backFrames.js'));
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1-r2' });
});

afterAll(() => vi.useRealTimers());

describe('the back\'s colour on a rejoin', () => {
  it('a rejoin in hand 2 draws every back blue; a relayout keeps it; hand 3\'s snapshot draws them red', () => {
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    const rejoin = JSON.parse(JSON.stringify(rec.logs['seat1-rejoin'][0].data));
    // seat 1's own server snapshot mid hand 2, after two tricks or more were won
    const cp = rec.checkpoints.filter((c) => c.viewer === 'seat1' && c.snapshot?.deal?.handNo === 2 && c.snapshot.stage === 'PLAYING' &&
      (c.snapshot.tricks.team1 + c.snapshot.tricks.team2) >= 2).pop();
    expect(cp).toBeTruthy();
    const snap = JSON.parse(JSON.stringify(cp.snapshot));
    delete snap.trickHistory; // counts only: face-down placeholders for every won trick
    // the carrier down to {snapshot} (V1_REMOVALS #9): the snapshot is the table
    page.socket.fire('rejoinSuccess', { snapshot: snap, tournamentId: rejoin.tournamentId ?? null });
    replay.advance(100);

    expect(page.gameState.handNo).toBe(2);
    let b = backs(page.scene);
    expect(b.fans.length).toBe(replay.expectedCounts(cp.snapshot).opponentBacks);
    expect(b.stacks.length).toBe(4 * (snap.tricks.team1 + snap.tricks.team2));
    expect(new Set(b.all)).toEqual(new Set(['back-blue']));
    expect(b.missing).toEqual([]);

    // a relayout and a re-render keep it blue
    page.scene.relayout();
    page.scene.director.fastForward('visible');
    page.scene.render();
    expect(new Set(backs(page.scene).all)).toEqual(new Set(['back-blue']));

    // a snapshot of hand 3 (say a reload later): red
    const cp3 = rec.checkpoints.find((c) => c.viewer === 'seat1' && c.snapshot?.deal?.handNo === 3 && c.snapshot.stage === 'PLAYING');
    page.socket.fire('stateSnapshot', { snapshot: JSON.parse(JSON.stringify(cp3.snapshot)), requestId: 'ping-test-1' });
    replay.advance(100);
    expect(page.gameState.handNo).toBe(3);
    b = backs(page.scene);
    expect(b.fans.length).toBeGreaterThan(0);
    expect(new Set(b.all)).toEqual(new Set(['back-red']));
  });
});
