/**
 * A spectator's game log score header during the draw for deal, before the
 * seats (and so the teams) exist: it names no team of theirs. It used to
 * read "Your Team" / "Opponents" (getTeamNames' no-seats fallback, and the
 * log's own first labels) until the deal, then "Team 1" / "Team 2"; now
 * (owner 2026-11-17: the header shows player names, never a placeholder)
 * the name lines are empty until the seats are known, then the teams'
 * names ("a/c" vs "b/d", seats 1/3 then 2/4) from positionUpdate on, not
 * only from the deal.
 *
 * Two ways in: a main-room spectator who comes in mid-draw (the recorded
 * events-humans-s13 spectator socket, its spectatorJoined at DRAWING), and
 * a family lobby's extra (spectatorJoined at CREATED, then the room's
 * startDraw). A seat's header: scoreHeaderNames*.test.js and
 * seatDisplay.test.js; the label logic for both, ScoreModal.test.js and
 * GameLog.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let replay;

const header = () => [...document.querySelectorAll('#gameLogScore .log-score__names')].map((n) => n.textContent);
const PLACEHOLDER = /Your Team|Opponents|Team 1|Team 2/;

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

  it('the join (DRAWING): no seats yet, so empty name lines (no placeholder)', () => {
    expect(log[0].event).toBe('spectatorJoined');
    expect(log[0].data.snapshot.stage).toBe('DRAWING');
    page.socket.fire('spectatorJoined', JSON.parse(JSON.stringify(log[0].data)));
    replay.advance(50);
    expect(page.session.role).toBe('spectator');
    expect(header()).toEqual(['', '']);
  });

  it('the rest of the draw: empty until positionUpdate seats the players, then the teams by name', () => {
    const seated = log.findIndex((e) => e.event === 'positionUpdate');
    replay.replayLog(page, log, { from: 1, to: seated });
    replay.advance(50);
    expect(header()).toEqual(['', '']);
    replay.replayLog(page, log, { from: seated, to: seated + 1 });
    const name = (p) => page.gameState.getPlayerNameByPosition(p);
    expect(header()).toEqual([`${name(1)}/${name(3)}`, `${name(2)}/${name(4)}`]);
    // the teams panel names the same pairs
    const teams = log.findIndex((e) => e.event === 'teamsAnnounced');
    replay.replayLog(page, log, { from: seated + 1, to: teams + 1 });
    replay.advance(100);
    expect(header()).toEqual([log[teams].data.team1.join('/'), log[teams].data.team2.join('/')]);
  });

  it('seated (the deal): the teams by name, seats 1/3 then 2/4', () => {
    const start = log.findIndex((e) => e.event === 'gameStart');
    replay.replayLog(page, log, { from: log.findIndex((e) => e.event === 'teamsAnnounced') + 1, to: start + 1 });
    replay.advance(5000);
    const name = (p) => page.gameState.getPlayerNameByPosition(p);
    expect(header()).toEqual([`${name(1)}/${name(3)}`, `${name(2)}/${name(4)}`]);
    expect(header().join(' ')).not.toMatch(PLACEHOLDER);
  });
});
