/**
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

describe('a main-room spectator mid-draw', () => {
  let page;
  let log;

  beforeAll(async () => {
    log = replay.loadRecording('events-humans-s13').logs.spectator;
    page = await replay.realTablePage({ username: 'ios_fan' });
  });

  it('the join (DRAWING): "Team 1" / "Team 2"', () => {
    expect(log[0].event).toBe('spectatorJoined');
    expect(log[0].data.snapshot.stage).toBe('DRAWING');
    page.socket.fire('spectatorJoined', JSON.parse(JSON.stringify(log[0].data)));
    replay.advance(50);
    expect(page.session.role).toBe('spectator');
    expect(header()).toEqual(['Team 1', 'Team 2']);
  });

  it('the rest of the draw and the teams panel: still neutral', () => {
    const teams = log.findIndex((e) => e.event === 'teamsAnnounced');
    replay.replayLog(page, log, { from: 1, to: teams + 1 });
    replay.advance(100);
    expect(header()).toEqual(['Team 1', 'Team 2']);
  });

  it('seated (the deal): the teams by name, seats 1/3 then 2/4', () => {
    const start = log.findIndex((e) => e.event === 'gameStart');
    replay.replayLog(page, log, { from: log.findIndex((e) => e.event === 'teamsAnnounced') + 1, to: start + 1 });
    replay.advance(5000);
    const name = (p) => page.gameState.getPlayerNameByPosition(p);
    expect(header()).toEqual([`${name(1)}/${name(3)}`, `${name(2)}/${name(4)}`]);
    expect(header().join(' ')).not.toMatch(/Your Team|Opponents/);
  });
});
