/**
 * Who is watching at the real table (events-bots-s14: ios_fan watches
 * ios_ann's game; the real page, GameState and scene): a reload mid-hand
 * with a spectator present shows the badge at once from the rejoin
 * snapshot's `watching`; spectatorsUpdated (unsequenced) moves it; another
 * game's list is ignored; a re-render and a relayout keep it; leaving the
 * table takes it down; a new game starts with nobody. The spectator's own
 * view lists itself.
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

const slot = () => document.querySelector('#table-hud > .hud-spectators');
const count = () => slot()?.querySelector('.spectator-badge__count').textContent;
const label = () => slot()?.querySelector('button').getAttribute('aria-label');
const visible = () => !!slot() && !slot().hidden;
const update = (spectators, n = spectators.length, gameId = rec.gameId) =>
  page.socket.fire('spectatorsUpdated', { gameId, spectators: spectators.map((username) => ({ username, pic: 3 })), count: n });

describe('the spectator badge at a seat', () => {
  it('a reload mid-hand with a spectator present: the badge is back at once, from the snapshot', () => {
    const log = rec.logs['seat1-rejoin'];
    expect(log[0].event).toBe('rejoinSuccess');
    expect(log[0].data.snapshot.watching).toEqual({ spectators: [{ username: 'ios_fan', pic: 12 }], count: 1 });
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    page.socket.fire('rejoinSuccess', JSON.parse(JSON.stringify(log[0].data)));
    replay.advance(100);
    expect(visible()).toBe(true);
    expect(count()).toBe('1');
    expect(label()).toBe('1 person watching');
    expect(page.gameState.renderModel().watching).toEqual({ spectators: [{ username: 'ios_fan', pic: 12 }], count: 1 });
  });

  it('spectatorsUpdated moves it (no seq: the gate never holds it); another game\'s list is ignored', async () => {
    const { getSeqGate } = await import('../state/SeqGate.js');
    const gate = getSeqGate();
    const seqBefore = gate.lastSeq;
    update(['ios_fan', 'kim']);
    expect(count()).toBe('2');
    expect(label()).toBe('2 people watching');
    update(['someone', 'else', 'entirely'], 3, 'another-game');
    expect(count()).toBe('2');
    expect(gate.lastSeq).toBe(seqBefore);
    expect(gate.buffered).toBe(0);
  });

  it('a re-render and a relayout keep it where the layout says', () => {
    page.scene.director.fastForward('visible');
    page.scene.render(page.gameState.renderModel());
    expect(count()).toBe('2');
    page.scene.relayout();
    const L = page.scene.getLayout();
    const hud = document.getElementById('table-hud');
    expect(hud.style.getPropertyValue('--spec-x')).toBe(`${Math.round(L.spectators.rect.x * 100) / 100}px`);
    expect(visible()).toBe(true);
  });

  it('nobody watching: hidden', () => {
    update([]);
    expect(visible()).toBe(false);
    update(['back']);
    expect(visible()).toBe(true);
  });

  it('leaving the table takes it down and forgets the list', () => {
    page.socket.fire('leftGame');
    replay.advance(100);
    expect(slot()).toBeNull();
    expect(page.gameState.watching).toEqual({ spectators: [], count: 0 });
  });
});
