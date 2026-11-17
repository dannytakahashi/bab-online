/**
 * The game log's score header names the players, never a placeholder
 * (owner 2026-11-17): no "Your Team" / "Opponents" (a seat's old first
 * labels, which flashed on desktop between createUI and the deal) and no
 * "Team 1" / "Team 2" (a spectator's). Until the seats are known the line
 * is empty (it keeps its height: table.css); then "me/partner" and
 * "opp1/opp2".
 *
 * A seat's whole recorded game (events-humans-s13 seat4: ios_eli at seat
 * 3, from the draw to gameEnd) through the real page and scene, the
 * header read after every event. The rejoin's half is
 * scoreHeaderNamesRejoin.test.js; a spectator's, spectatorScoreHeader*.
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
  log = replay.loadRecording('events-humans-s13').logs.seat4;
  page = await replay.realTablePage({ username: 'ios_eli', socketId: 'ios-p4' });
});

afterAll(() => vi.useRealTimers());

describe('a seat\'s score header, the draw to gameEnd', () => {
  const ME = 'ios_eli/ios_bea'; // seat 3 and partner seat 1
  const THEM = 'ios_dee/ios_cal'; // seat 4 (opp1, next clockwise) and seat 2

  it('createUI: the log comes up with the names, before the deal (no placeholder flash)', () => {
    const create = log.findIndex((e) => e.event === 'createUI');
    const seen = [];
    replay.replayLog(page, log, { to: create + 1, before: () => seen.push(...header()) });
    expect(seen.join(' ')).not.toMatch(PLACEHOLDER);
    // the createUI fade (1.2s), not yet the deal
    replay.advance(100);
    expect(page.gameState.position).toBe(3);
    expect(header()).toEqual([ME, THEM]);
    expect(log[create + 1].event).toBe('gameStart');
  });

  it('every event to gameEnd: player names only, never empty once seated, never a placeholder', () => {
    const create = log.findIndex((e) => e.event === 'createUI');
    const bad = [];
    let checked = 0;
    replay.replayLog(page, log, {
      from: create + 1,
      before: (e, i) => {
        const names = header();
        checked += 1;
        if (names.length !== 2 || names.some((n) => !n || PLACEHOLDER.test(n))) bad.push({ i, event: e.event, names });
      },
    });
    replay.advance(3000);
    expect(checked).toBeGreaterThan(1000);
    expect(bad).toEqual([]);
    expect(log[log.length - 1].event).toBe('gameEnd');
    // the game end's header: the same seats (seat 4 is a resign bot by then)
    const [mine, theirs] = header();
    expect(mine).toBe(ME);
    expect(theirs).toMatch(/\/ios_cal$/);
    expect(theirs).not.toMatch(PLACEHOLDER);
  });
});
