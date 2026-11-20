/**
 * The tutorial on the real page and scene (2026-11-19), from the recorded
 * game events-bots-s14 (seat1-rejoin: a 1-human + 3-bot game): the page
 * says the clientHello cap tutorial; a reload whose snapshot's viewer.assist
 * says the tutorial is on shows the "Tutorial on" chip at my seat; a rule
 * tip draws its section and its "Tip:" row; the chip's switch sends
 * chatMessage '/tutorial off'; the server's assistState off takes the chip
 * and the tips down; the chat list offers /tutorial again.
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
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1-r1' });
});

afterAll(() => vi.useRealTimers());

const rejoin = (assist) => {
  const data = JSON.parse(JSON.stringify(rec.logs['seat1-rejoin'][0].data));
  data.snapshot.viewer.assist = assist;
  return data;
};
const chip = () => document.querySelector('.hud-tutorial');
const tipTitles = () => [...document.querySelectorAll('.hud-assist:not([hidden]) .assist-tip__title')].map((e) => e.textContent);
const rows = () => [...document.querySelectorAll('#gameFeedMessages .log-row.is-private .log-row__text')].map((r) => r.textContent);
const listed = (text) => {
  const input = document.getElementById('chatInput');
  input.value = text;
  input.dispatchEvent(new Event('input'));
  return [...document.querySelectorAll('.slash-item')].map((el) => [el.querySelector('.slash-item__cmd').textContent, el.querySelector('.slash-item__desc').textContent]);
};

describe('the tutorial after a reload', () => {
  it('the page says the cap tutorial (and assist)', () => {
    const hello = page.socket.emitted('clientHello').at(-1);
    expect(hello.caps).toEqual(expect.arrayContaining(['assist', 'tutorial']));
  });

  it('viewer.assist.tutorial: the chip at my seat; /tutorial offers to turn it off', () => {
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    page.socket.fire('rejoinSuccess', rejoin({ uses: 0, freeUses: 3, assisted: false, unlimited: true, tutorial: true, auto: true }));
    replay.advance(100);
    expect(chip()).not.toBeNull();
    expect(chip().hidden).toBe(false);
    expect(chip().textContent).toContain('Tutorial on');
    expect(listed('/tu')).toEqual([['/tutorial', 'Turn off the tutorial']]);
  });

  it('a rule tip: its section and its private "Tip:" row', () => {
    page.socket.fire('assistHint', {
      v: 1, source: 'tutorial', kind: 'tip', turnKey: 'k', headline: 'Scoring',
      reasons: ['Win at least your combined bid and you score 10 points per trick bid, plus 1 for each extra trick. Fall short and you lose 10 per trick bid.'],
      uses: 0, freeUses: 3, assisted: false, counted: false, tipId: 'T.set', unlimited: true,
    });
    replay.advance(50);
    expect(tipTitles()).toEqual(['Scoring']);
    expect(rows().at(-1)).toMatch(/^Tip: Win at least your combined bid/);
  });

  it('the chip\'s switch sends /tutorial off; the server\'s assistState off takes the chip and the tips down', () => {
    page.socket.clearEmits?.();
    chip().querySelector('.hud-tutorial__switch').click();
    const sent = page.socket.emitted('chatMessage').map((d) => d.message);
    expect(sent.at(-1)).toBe('/tutorial off');
    page.socket.fire('assistState', { tutorial: false, auto: false, uses: 0, freeUses: 3, assisted: false, unlimited: true });
    replay.advance(50);
    expect(chip().hidden).toBe(true);
    expect(tipTitles()).toEqual([]);
    expect(listed('/tu')).toEqual([['/tutorial', 'Tutorial: tips and advice every turn']]);
  });

  it('a reload without the key: off', () => {
    page.socket.fire('assistState', { tutorial: true, auto: false, uses: 0, freeUses: 3, assisted: false, unlimited: true });
    replay.advance(50);
    expect(chip().hidden).toBe(false);
    page.socket.reconnect('ios-h1-r2');
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    page.socket.fire('rejoinSuccess', rejoin({ uses: 0, freeUses: 3, assisted: false, unlimited: true }));
    replay.advance(100);
    expect(chip()?.hidden ?? true).toBe(true);
  });
});
