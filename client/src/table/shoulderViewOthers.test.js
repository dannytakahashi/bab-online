/**
 * The over-the-shoulder view as everyone else sees it, on the real page:
 *  - the watched player (events-bots-s14's seat 1, ios_ann): the wide
 *    spectatorsUpdated puts an eye on its own box, "ios_fan is watching your
 *    hand", and the badge's list row "ios_fan · watching ios_ann"; when the
 *    watch ends the eye goes;
 *  - a player's avatar clicks still open profiles (no watchHand from a seat).
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
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
});

afterAll(() => vi.useRealTimers());

describe('the watched player sees who watches its hand', () => {
  it('an eye on my own box and a row in the list; gone when the watch ends', () => {
    const log = rec.logs.seat1;
    const deal = log.findIndex((e) => e.event === 'gameStart');
    replay.replayLog(page, log, { to: deal + 1 });
    replay.advance(4000);
    expect(page.session.role).toBe('player');
    const eye = () => document.querySelector('#player-avatar-container .hud-watch-chip');
    expect(eye().classList.contains('is-on')).toBe(false);
    page.socket.fire('spectatorsUpdated', { gameId: rec.gameId, spectators: [{ username: 'ios_fan', pic: 12, shoulder: 1 }], count: 1 });
    expect(eye().classList.contains('is-on')).toBe(true);
    expect(eye().title).toBe('ios_fan is watching your hand');
    expect(eye().getAttribute('aria-label')).toBe('ios_fan is watching your hand');
    // the other seats carry none
    for (const e of document.querySelectorAll('.opponent-avatar-container .hud-watch-chip')) expect(e.classList.contains('is-on')).toBe(false);
    document.querySelector('#table-hud > .hud-spectators button').click();
    expect([...document.querySelectorAll('.spectator-popover__name')].map((n) => n.textContent)).toEqual(['ios_fan · watching ios_ann']);
    // two on a bot's seat: its eye counts them
    page.socket.fire('spectatorsUpdated', { gameId: rec.gameId, spectators: [{ username: 'ios_fan', pic: 12, shoulder: 3 }, { username: 'zed', pic: 4, shoulder: 3 }], count: 2 });
    expect(eye().classList.contains('is-on')).toBe(false);
    const partner = document.querySelector('#opponent-avatar-partner .hud-watch-chip');
    expect(partner.classList.contains('is-on')).toBe(true);
    expect(partner.querySelector('b').textContent).toBe('2');
    expect(partner.title).toBe("ios_fan and zed are watching 🤖 Mike's hand");
    // the last watch ends: the plain list
    page.socket.fire('spectatorsUpdated', { gameId: rec.gameId, spectators: [{ username: 'ios_fan', pic: 12 }, { username: 'zed', pic: 4 }], count: 2 });
    expect(document.querySelectorAll('.hud-watch-chip.is-on')).toHaveLength(0);
  });

  it('a player\'s avatar click opens the profile (a seat never sends watchHand)', () => {
    page.socket.clearEmits();
    document.querySelector('#opponent-avatar-partner').click();
    expect(page.socket.emitted('watchHand')).toEqual([]);
    expect(page.socket.emitted('getPlayerProfile').map((p) => p.username)).toEqual(['🤖 Mike']);
  });
});
