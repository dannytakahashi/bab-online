/**
 * (The rejoin half of scoreHeaderNames.test.js: one page per file.)
 *
 * A rejoin's snapshot (rejoinSuccess: events-humans-s13 seat2-rejoin,
 * ios_cal at seat 2) builds the game log with the players' names at once,
 * never "Your Team" / "Opponents", and they stay names to gameEnd.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const PLACEHOLDER = /Your Team|Opponents|Team 1|Team 2/;

let replay;
let page;
let log;

const header = () => [...document.querySelectorAll('#gameLogScore .log-score__names')].map((n) => n.textContent);

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  log = replay.loadRecording('events-humans-s13').logs['seat2-rejoin'];
  page = await replay.realTablePage({ username: 'ios_cal', socketId: 'ios-p2-r1' });
});

afterAll(() => vi.useRealTimers());

describe('a rejoin\'s score header', () => {
  it('rejoinSuccess: me/partner and opp1/opp2 by name at once', () => {
    expect(log[0].event).toBe('rejoinSuccess');
    page.socket.fire('rejoinSuccess', JSON.parse(JSON.stringify(log[0].data)));
    expect(page.gameState.position).toBe(2);
    const name = (p) => page.gameState.getPlayerNameByPosition(p);
    // seat 2's partner is seat 4; opp1 the next seat clockwise (3), then 1
    expect(header()).toEqual([`ios_cal/${name(4)}`, `${name(3)}/${name(1)}`]);
    expect(header().join(' ')).not.toMatch(PLACEHOLDER);
  });

  it('the rest of the game: names only', () => {
    const bad = [];
    replay.replayLog(page, log, {
      from: 1,
      before: (e, i) => {
        const names = header();
        if (names.length !== 2 || names.some((n) => !n || PLACEHOLDER.test(n))) bad.push({ i, event: e.event, names });
      },
    });
    replay.advance(3000);
    expect(bad).toEqual([]);
    expect(header()[0]).toMatch(/^ios_cal\//);
  });
});
