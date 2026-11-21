/**
 * The Tutorial button's question on the real page, in a
 * human-only game (events-humans-s13 seat2-rejoin, ios_cal): turning the
 * tutorial on there makes this game bot-assisted for me, so the button asks
 * first ("Turn on the tutorial?", iOS's words); Cancel sends nothing, Turn
 * on sends chatMessage '/tutorial on'. Once the server says `assisted` (a
 * later snapshot's viewer.assist, or an assistState) it no longer asks.
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
  rec = replay.loadRecording('events-humans-s13');
  page = await replay.realTablePage({ username: 'ios_cal', socketId: 'ios-p2-r1' });
});

afterAll(() => vi.useRealTimers());

function rejoin(assist, { reconnect = true } = {}) {
  if (reconnect) page.socket.reconnect(`ios-p2-r${++n}`);
  page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_cal', activeGameId: rec.gameId, blockedUsers: [] });
  const data = JSON.parse(JSON.stringify(rec.logs['seat2-rejoin'][0].data));
  data.snapshot.viewer.assist = assist;
  page.socket.fire('rejoinSuccess', data);
  replay.advance(100);
}
const btn = () => document.getElementById('tutorial-toggle-btn');
const word = () => (btn().getAttribute('aria-pressed') === 'true' ? 'On' : 'Off');
const dialog = () => document.querySelector('#tutorial-confirm [role="dialog"]');
const sent = () => page.socket.emitted('chatMessage').map((d) => d.message);

describe('the Tutorial button in a human-only game', () => {
  it('Off; a click asks first, with iOS\'s words', () => {
    rejoin({ uses: 1, freeUses: 3, assisted: false }, { reconnect: false });
    expect(btn().hidden).toBe(false);
    expect(word()).toBe('Off');
    btn().click();
    expect(dialog().querySelector('.kit-modal__title').textContent).toBe('Turn on the tutorial?');
    expect(dialog().querySelector('.kit-modal__body').textContent).toBe("You'll get tips and advice on every turn. This game will count as bot-assisted for you: it goes in your bot-game stats, not the human leaderboard.");
    expect([...dialog().querySelectorAll('.kit-modal__actions button')].map((b) => b.textContent)).toEqual(['Cancel', 'Turn on']);
  });

  it('Cancel sends nothing', () => {
    const before = sent().length;
    document.getElementById('tutorial-confirm-cancel').click();
    expect(dialog()).toBeNull();
    expect(sent().length).toBe(before);
    expect(word()).toBe('Off');
  });

  it('Turn on sends /tutorial on; the server\'s assistState on: On', () => {
    const before = sent().length;
    btn().click();
    document.getElementById('tutorial-confirm-ok').click();
    expect(sent().slice(before)).toEqual(['/tutorial on']);
    page.socket.fire('assistState', { tutorial: true, auto: false, uses: 1, freeUses: 3, assisted: true });
    replay.advance(50);
    expect(word()).toBe('On');
  });

  it('off again, then on: the server said assisted, so no question', () => {
    btn().click();
    expect(sent().at(-1)).toBe('/tutorial off');
    page.socket.fire('assistState', { tutorial: false, auto: false, uses: 1, freeUses: 3, assisted: true });
    replay.advance(50);
    btn().click();
    expect(dialog()).toBeNull();
    expect(sent().at(-1)).toBe('/tutorial on');
    page.socket.fire('assistState', { tutorial: true, auto: false, uses: 1, freeUses: 3, assisted: true });
    replay.advance(50);
    expect(word()).toBe('On');
  });

  it('a reload whose viewer.assist says assisted (4 /help uses): no question either', () => {
    rejoin({ uses: 4, freeUses: 3, assisted: true });
    expect(word()).toBe('Off');
    const before = sent().length;
    btn().click();
    expect(dialog()).toBeNull();
    expect(sent().slice(before)).toEqual(['/tutorial on']);
  });

  it('typing /tutorial in the chat never asks', () => {
    rejoin({ uses: 0, freeUses: 3, assisted: false });
    const before = sent().length;
    const input = document.getElementById('chatInput');
    input.value = '/tutorial on';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.querySelector('#gameFeed .chat-send').click();
    expect(dialog()).toBeNull();
    expect(sent().slice(before)).toContain('/tutorial on');
  });
});
