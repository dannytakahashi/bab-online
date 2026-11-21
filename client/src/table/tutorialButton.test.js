/**
 * The Tutorial button on the real page and scene (owner 2026-11-21), from
 * the recorded game events-bots-s14 (seat1-rejoin: a 1-human + 3-bot game):
 * a reload's snapshot puts it in my seat's row of round controls, right
 * after the sound toggle,
 * On or Off by viewer.assist.tutorial; on -> off sends chatMessage
 * '/tutorial off' and waits (Off, disabled) for assistState; off -> on in
 * this game with native bot seats never asks. The question in a human-only
 * game: table/tutorialButtonHumans.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let n = 1;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1-r1' });
});

afterAll(() => vi.useRealTimers());

/** A reload (a new socket) whose snapshot's viewer.assist is `assist`. */
function reload(assist) {
  page.socket.reconnect(`ios-h1-r${++n}`);
  page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
  const data = JSON.parse(JSON.stringify(rec.logs['seat1-rejoin'][0].data));
  data.snapshot.viewer.assist = assist;
  page.socket.fire('rejoinSuccess', data);
  replay.advance(100);
}
const btn = () => document.getElementById('tutorial-toggle-btn');
const word = () => (btn().getAttribute('aria-pressed') === 'true' ? 'On' : 'Off');
const busy = () => btn().getAttribute('aria-disabled') === 'true';
const dialog = () => document.querySelector('#tutorial-confirm [role="dialog"]');
const lastSent = () => page.socket.emitted('chatMessage').map((d) => d.message).at(-1);
const sentCount = () => page.socket.emitted('chatMessage').length;

describe('the Tutorial button after a reload', () => {
  it('viewer.assist.tutorial: in my seat\'s row, On, aria-pressed true', () => {
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    const data = JSON.parse(JSON.stringify(rec.logs['seat1-rejoin'][0].data));
    data.snapshot.viewer.assist = { uses: 0, freeUses: 3, assisted: false, unlimited: true, tutorial: true, auto: true };
    page.socket.fire('rejoinSuccess', data);
    replay.advance(100);
    expect(btn()).not.toBeNull();
    // in my seat's row of round controls, after the sound toggle (not the log)
    expect(btn().closest('#table-hud > .hud-voice')).not.toBeNull();
    expect(btn().previousElementSibling?.id).toBe('sound-toggle-btn');
    expect(btn().closest('#gameFeed')).toBeNull();
    expect(btn().hidden).toBe(false);
    expect(word()).toBe('On');
    expect(btn().getAttribute('aria-pressed')).toBe('true');
  });

  it('on -> off: /tutorial off at once, Off and waiting; the server\'s assistState off: enabled', () => {
    const before = sentCount();
    btn().click();
    expect(dialog()).toBeNull();
    expect(lastSent()).toBe('/tutorial off');
    expect(word()).toBe('Off');
    expect(busy()).toBe(true);
    btn().click();
    expect(sentCount()).toBe(before + 1);
    page.socket.fire('assistState', { tutorial: false, auto: false, uses: 0, freeUses: 3, assisted: false, unlimited: true });
    replay.advance(50);
    expect(word()).toBe('Off');
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    expect(busy()).toBe(false);
  });

  it('off -> on in a game with a native bot seat: no question, /tutorial on; assistState on: On', () => {
    btn().click();
    expect(dialog()).toBeNull();
    expect(lastSent()).toBe('/tutorial on');
    page.socket.fire('assistState', { tutorial: true, auto: false, uses: 0, freeUses: 3, assisted: false, unlimited: true });
    replay.advance(50);
    expect(word()).toBe('On');
    expect(busy()).toBe(false);
  });

  it('a reload without the key: Off', () => {
    reload({ uses: 0, freeUses: 3, assisted: false, unlimited: true });
    expect(btn().hidden).toBe(false);
    expect(word()).toBe('Off');
  });

});
