/**
 * (The lobby-extra half of spectatorScoreHeader.test.js: one page per file.)
 *
 * A spectator's game log score header during the draw for deal, before the
 * seats (and so the teams) exist: it names no team of theirs. It used to
 * read "Your Team" / "Opponents" (getTeamNames' no-seats fallback, and the
 * log's own first labels) until the deal; now "Team 1" / "Team 2", as the
 * teams panel names them, then the teams' names ("a/c" vs "b/d") once
 * they are seated, as before.
 *
 * Two ways in: a main-room spectator who comes in mid-draw (the recorded
 * events-humans-s13 spectator socket, its spectatorJoined at DRAWING), and
 * a family lobby's extra (spectatorJoined at CREATED, then the room's
 * startDraw). A seat's header is unchanged (seatDisplay.test.js; the label
 * logic for both, ScoreModal.test.js and GameLog.test.js).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../testing/files.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let replay;

const header = () => [...document.querySelectorAll('#gameLogScore .log-score__names')].map((n) => n.textContent);

beforeAll(async () => {
  replay = await import('../testing/replay.js');
});

afterAll(() => vi.useRealTimers());

describe('a family lobby\'s extra (spectatorJoined at CREATED, then startDraw)', () => {
  let page;

  beforeAll(async () => {
    page = await replay.realTablePage({ username: 'me_extra', socketId: 'sock-x' });
    const { mainRoomPayload } = await import('../testing/fakePage.js');
    page.socket.fire('mainRoomJoined', mainRoomPayload());
  });

  it('the start and the draw: "Team 1" / "Team 2"', () => {
    const fx = JSON.parse(readFileSync(resolve(REPO_ROOT, 'contract/fixtures/v2/created-countdown.json'), 'utf8'));
    const snapshot = { ...fx.snapshot, gameId: 'g9', viewer: { role: 'spectator', position: null, ownerView: null, canAct: false } };
    page.socket.fire('spectatorJoined', { gameId: 'g9', players: [], trump: null, snapshot });
    replay.advance(50);
    expect(page.session.role).toBe('spectator');
    expect(header()).toEqual(['Team 1', 'Team 2']);
  });

  it('the room\'s startDraw (its clearUI takes the log down, as a seat\'s draw has none), then the teams and the table: the log comes back neutral, then by name', () => {
    page.socket.fire('startDraw', { start: true });
    replay.advance(50);
    expect(page.session.role).toBe('spectator');
    expect(header().join(' ')).not.toMatch(/Your Team|Opponents/);
    page.socket.fire('positionUpdate', {
      positions: [1, 2, 3, 4],
      sockets: ['s-a', 's-b', 's-c', 's-d'],
      usernames: ['ann', 'bob', 'cat', 'dan'].map((username, i) => ({ username, socketId: `s-${'abcd'[i]}` })),
      pics: [1, 2, 3, 4],
    });
    page.socket.fire('teamsAnnounced', { team1: ['ann', 'cat'], team2: ['bob', 'dan'], resumeInMs: 3000 });
    replay.advance(100);
    expect(header().join(' ')).not.toMatch(/Your Team|Opponents/);
    page.socket.fire('createUI', {});
    replay.advance(3000);
    expect(header()).toEqual(['Team 1', 'Team 2']);
  });
});
