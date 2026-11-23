/**
 * The tutorial's auto-start on the real page and scene (2026-11-19): the
 * server sends createUI, then at once the room line "<name> is playing with
 * the tutorial." and assistState {tutorial: true, auto: true}, then the
 * deal. The page's log comes up only after createUI's fade, so a line that
 * came in between is kept and written right after 'Game started!' (it was
 * dropped before: main.js flushEarlyLogLines), and the Tutorial
 * button in my seat's row shows On (no in-hand chip since 2026-11-21). From a seat's recorded game (events-humans-s13 seat4: ios_eli
 * at seat 3).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let replay;
let page;
let log;

const rowTexts = () => [...document.querySelectorAll('#gameFeedMessages .log-row .log-row__text')].map((r) => r.textContent);

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  log = replay.loadRecording('events-humans-s13').logs.seat4;
  page = await replay.realTablePage({ username: 'ios_eli', socketId: 'ios-p4' });
});

afterAll(() => vi.useRealTimers());

describe('an auto-started tutorial at the start of a game', () => {
  it('the notice that came before the log is written after "Game started!", once; the Tutorial button is On with the deal', () => {
    const create = log.findIndex((e) => e.event === 'createUI');
    replay.replayLog(page, log, { to: create + 1 });
    // right after createUI, as handleDrawComplete sends them
    // (with the server's tutorial tag, 2026-11-23: held with its kind, so
    // the row is the cap's green like a later tutorial line)
    page.socket.fire('gameLogEntry', { message: 'ios_eli is playing with the tutorial.', type: 'system', tutorial: { position: 4, on: true } });
    page.socket.fire('assistState', { tutorial: true, auto: true, uses: 0, freeUses: 3, assisted: false });
    replay.advance(3000);
    const rows = rowTexts();
    const at = rows.indexOf('Game started!');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rows[at + 1]).toBe('ios_eli is playing with the tutorial.');
    expect(rows.filter((r) => r === 'ios_eli is playing with the tutorial.')).toHaveLength(1);
    const tagged = [...document.querySelectorAll('#gameFeedMessages .log-row.is-tutorial')];
    expect(tagged.map((r) => r.querySelector('.log-row__text').textContent)).toEqual(['ios_eli is playing with the tutorial.']);
    // the deal and the first turn
    replay.replayLog(page, log, { from: create + 1, to: create + 3 });
    replay.advance(3000);
    const btn = document.getElementById('tutorial-toggle-btn');
    expect(btn?.hidden).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.hud-tutorial')).toBeNull();
  });

  it('later lines go straight to the log (nothing held)', () => {
    page.socket.fire('gameLogEntry', { message: 'This game now counts as bot-assisted for ios_eli.', type: 'system' });
    expect(rowTexts().at(-1)).toBe('This game now counts as bot-assisted for ios_eli.');
  });
});
