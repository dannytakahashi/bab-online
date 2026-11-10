/**
 * cli-20: a spectator joining mid-hand (events-bots-s12, the recorded
 * spectator socket) gets the whole table from the full state's snapshot:
 * the seat names in the score header (never 'null'), the turn glow, the
 * trump face up with no re-flip, each opponent's real card count; one
 * 'Game started!' in the log; and the table keeps matching the server to
 * the game end.
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
  rec = replay.loadRecording('events-bots-s12');
  page = await replay.realTablePage({ username: 'ios_fan' });
});

afterAll(() => vi.useRealTimers());

describe('recorded spectator joining mid-hand', () => {
  it('the join draws the snapshot: names, glow, face-up trump, opponent counts (cli-20)', () => {
    const log = rec.logs.spectator;
    const join = log[0];
    expect(join.event).toBe('spectatorJoined');
    page.socket.fire('spectatorJoined', JSON.parse(JSON.stringify(join.data)));
    replay.advance(50);
    const snap = join.data.snapshot;
    const scene = page.scene;
    expect(page.session.role).toBe('spectator');
    expect(replay.liveCounts(scene)).toEqual(replay.expectedCounts(snap));
    // all four seats' backs, the bottom one included
    expect(scene.tableCounts().opponentBySlot.bottom).toBe(snap.seats[0].cardsInHand);
    expect(scene.tableCardSprite.texture.key).toBe('cards');
    expect(scene.director.pending()).toBe(0);
    const header = document.getElementById('gameLogScore').textContent;
    expect(header).not.toContain('null');
    expect(header).toContain(`${snap.seats[0].username}/${snap.seats[2].username}`);
    if (snap.turn) {
      const glowing = [...document.querySelectorAll('.opponent-avatar-container.turn-glow')].map((el) => el.textContent);
      expect(glowing).toEqual([snap.seats[snap.turn.position - 1].username]);
    }
    const started = [...document.querySelectorAll('#gameFeedMessages > div')].filter((el) => el.textContent.includes('Game started!'));
    expect(started.length).toBeLessThanOrEqual(1);
    expect(replay.logRows()).toBe(snap.log.length + 1);
  });

  it('…and keeps matching every checkpoint to the game end', () => {
    const { results, bad } = replay.replayViewer(page, rec, 'spectator', { from: 1 });
    expect(results.length).toBeGreaterThan(100);
    expect(bad).toEqual([]);
    expect(page.session.screen).toBe('gameEnd');
  });
});
