/**
 * A spectator's chat by the spectator badge (owner, 2026-11-11: "a similar
 * chat bubble ... above the eye with the spectators name"), at the real
 * table (events-bots-s14: ios_fan watches ios_ann's game; the real page,
 * GameState and scene). The chatMessage payloads are the server's own
 * shapes (server/socket/__tests__/spectatorChat.test.js pins them from the
 * real chatHandlers): a pure spectator and a watching seat owner send
 * {position: null, isSpectator: true, type: 'spectator'}, a player and a
 * seat-view lazy owner {position, isSpectator: false, type: 'player'}.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let gate;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  gate = (await import('../state/SeqGate.js')).getSeqGate();
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1-r1' });
});

afterAll(() => vi.useRealTimers());

const hud = () => document.getElementById('table-hud');
const slot = () => document.querySelector('#table-hud > .hud-spectator-bubble');
const badgeBubbles = () => [...document.querySelectorAll('#table-hud > .hud-spectator-bubble > .chat-bubble')];
const seatBubble = (key) => document.querySelector(`#table-hud > .hud-seat[data-seat="${key}"] .chat-bubble`);
const allBubbles = () => [...document.querySelectorAll('.chat-bubble')];
// the room's next event (chatMessage is sequenced: the next seq, as the server stamps it)
const next = () => gate.lastSeq + 1;
const spectatorSays = (username, message) => page.socket.fire('chatMessage', { position: null, message, username, isSpectator: true, type: 'spectator', seq: next() });
const playerSays = (position, username, message) => page.socket.fire('chatMessage', { position, message, username, isSpectator: false, type: 'player', seq: next() });
/** Phaser's ScaleManager after a window resize: new size, then 'resize' (GameScene.relayout). */
function resize(w, h) {
  page.scene.scale.width = w;
  page.scene.scale.height = h;
  page.scene.scale.emit('resize', { width: w, height: h });
  return page.scene.getLayout();
}
const px = (v) => `${Math.round(v * 100) / 100}px`;
const logTexts = () => [...document.querySelectorAll('#gameFeedMessages .log-row__text')].map((n) => n.textContent);

describe('a spectator\'s chat at a seat', () => {
  it('back at the table (a rejoin mid-hand): no old bubble comes back with the log', () => {
    const log = rec.logs['seat1-rejoin'];
    const data = JSON.parse(JSON.stringify(log[0].data));
    // the snapshot's log carries an old spectator line (the server's game log)
    data.snapshot.log = [...(data.snapshot.log || []), { message: 'ios_fan: earlier', playerPosition: null, type: 'chat' }];
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    page.socket.fire('rejoinSuccess', data);
    replay.advance(100);
    expect(page.session.isAtTable).toBe(true);
    expect(allBubbles()).toEqual([]);
    // the badge's bubble slot (if any yet) has nothing in it
    expect(slot()?.childElementCount ?? 0).toBe(0);
  });

  it('a spectator\'s message shows "Name: text" by the badge, tinted, and in the log', () => {
    spectatorSays('ios_fan', 'hello');
    const [b] = badgeBubbles();
    expect(b).toBeTruthy();
    expect(b.textContent).toBe('ios_fan: hello');
    expect(b.querySelector('.chat-bubble-name').textContent).toBe('ios_fan:');
    expect(b.classList.contains('is-spectator')).toBe(true);
    // placed from the layout: hung from its spot, its tail the layout's, never hidden here
    const L = page.scene.getLayout();
    expect(slot().hidden).toBe(false);
    expect(hud().style.getPropertyValue('--specbub-x')).toBe(px(L.spectators.bubble.x));
    expect(hud().style.getPropertyValue('--specbub-y')).toBe(px(L.spectators.bubble.y));
    expect(b.classList.contains(`tail-${L.spectators.bubble.tail}`)).toBe(true);
    expect(slot().classList.contains(`align-${L.spectators.bubble.align}`)).toBe(true);
    // the seats show nothing; the log has the line (as before)
    expect(allBubbles()).toHaveLength(1);
    expect(logTexts().some((t) => t.includes('ios_fan: hello'))).toBe(true);
    // the seats' treatment: no live region or role (the log carries the line)
    expect(b.getAttribute('aria-live')).toBeNull();
    expect(b.getAttribute('role')).toBeNull();
    expect(slot().getAttribute('aria-live')).toBeNull();
  });

  it('a newer spectator message replaces it (one at a time)', () => {
    spectatorSays('kim', 'me too');
    expect(badgeBubbles().map((b) => b.textContent)).toEqual(['kim: me too']);
  });

  it('a player\'s message still goes over its seat; the badge\'s bubble is unaffected', () => {
    playerSays(3, '🤖 Partner', 'nice');
    const p = seatBubble('partner');
    expect(p?.textContent).toBe('nice');
    expect(p.classList.contains('is-spectator')).toBe(false);
    expect(badgeBubbles().map((b) => b.textContent)).toEqual(['kim: me too']);
  });

  it('a seat-view lazy owner\'s message goes over its seat (it comes with the position)', () => {
    playerSays(2, 'ios_bob', 'brb');
    expect(seatBubble('opp1')?.textContent).toBe('brb');
    expect(badgeBubbles().map((b) => b.textContent)).toEqual(['kim: me too']);
  });

  it('a re-render and a relayout keep it, placed from the new layout', () => {
    page.scene.director.fastForward('visible');
    page.scene.render(page.gameState.renderModel());
    expect(badgeBubbles().map((b) => b.textContent)).toEqual(['kim: me too']);
    // a smaller window: the slot moves with the layout, the same bubble stays
    const L = resize(1024, 668);
    expect(L.w).toBe(1024);
    expect(hud().style.getPropertyValue('--specbub-x')).toBe(px(L.spectators.bubble.x));
    expect(hud().style.getPropertyValue('--specbub-y')).toBe(px(L.spectators.bubble.y));
    expect(badgeBubbles()).toHaveLength(1);
    expect(badgeBubbles()[0].classList.contains(`tail-${L.spectators.bubble.tail}`)).toBe(true);
  });

  it('a size with no spot for it hides it rather than overlap; back to a roomy size it shows again', () => {
    expect(resize(680, 500).spectators.bubble).toBeNull(); // an 880 x 500 window less its log: my box fills the corner
    expect(slot().hidden).toBe(true);
    expect(badgeBubbles()).toHaveLength(1);
    expect(resize(1200, 790).spectators.bubble).toBeTruthy();
    expect(slot().hidden).toBe(false);
    expect(badgeBubbles()).toHaveLength(1);
  });

  it('it times out like a seat\'s chat bubble (6 s, the last 300 ms fading)', () => {
    spectatorSays('ios_fan', 'timing');
    replay.advance(5600);
    expect(badgeBubbles().map((b) => b.textContent)).toEqual(['ios_fan: timing']);
    expect(badgeBubbles()[0].classList.contains('fade-out')).toBe(false);
    replay.advance(150);
    expect(badgeBubbles()[0].classList.contains('fade-out')).toBe(true);
    replay.advance(300);
    expect(badgeBubbles()).toEqual([]);
  });

  it('a watching seat owner (the server sends it as spectator chat) shows by the badge with its name', () => {
    spectatorSays('ios_bob', 'watching my bot');
    expect(badgeBubbles().map((b) => b.textContent)).toEqual(['ios_bob: watching my bot']);
  });

  it('a spectator who chats before the coalesced spectatorsUpdated lands: at the layout\'s spot while the badge is still hidden', () => {
    page.socket.fire('spectatorsUpdated', { gameId: rec.gameId, spectators: [], count: 0 });
    const badge = document.querySelector('#table-hud > .hud-spectators');
    expect(!badge || badge.hidden).toBe(true);
    spectatorSays('newcomer', 'hi all');
    const L = page.scene.getLayout();
    expect(slot().hidden).toBe(false);
    expect(hud().style.getPropertyValue('--spec-x')).toBe(px(L.spectators.rect.x));
    expect(hud().style.getPropertyValue('--specbub-x')).toBe(px(L.spectators.bubble.x));
    expect(badgeBubbles().map((b) => b.textContent)).toEqual(['newcomer: hi all']);
    // the list lands: the badge appears under the bubble that is up
    page.socket.fire('spectatorsUpdated', { gameId: rec.gameId, spectators: [{ username: 'newcomer', pic: 3 }], count: 1 });
    expect(badge.hidden).toBe(false);
    expect(badgeBubbles()).toHaveLength(1);
  });

  it('a blocked sender shows nothing (no bubble, no log line)', () => {
    replay.advance(7000);
    page.socket.fire('blockListUpdated', { success: true, blockedUsers: ['troll'] });
    const rows = logTexts().length;
    spectatorSays('troll', 'spam');
    expect(badgeBubbles()).toEqual([]);
    expect(logTexts().length).toBe(rows);
  });

  it('leaving the table clears it', () => {
    spectatorSays('ios_fan', 'bye');
    expect(badgeBubbles()).toHaveLength(1);
    page.socket.fire('leftGame');
    replay.advance(100);
    expect(allBubbles()).toEqual([]);
    expect(slot()).toBeNull();
    // a message after leaving puts nothing up
    spectatorSays('ios_fan', 'late');
    expect(allBubbles()).toEqual([]);
  });
});
