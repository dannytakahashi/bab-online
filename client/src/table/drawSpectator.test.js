/**
 * A spectator who comes in mid-draw (events-humans-s13, the recorded
 * spectator socket: its spectatorJoined snapshot is DRAWING with one card
 * drawn, then the other three playerDrew): iOS 7bcb56f's "spectators see
 * the draws". The join draws the draw so far from the snapshot (the slot,
 * its name and its card face up), the deck is not theirs (no buttons, no
 * prompt, no Draw a card button), and the later draws fill the other
 * slots; then the teams panel, nobody marked as me.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let log;

const hud = () => document.getElementById('table-hud');
const draw = () => hud().querySelector(':scope > .hud-draw');
const slots = () => [...draw().querySelectorAll('.hud-draw__slot')];
const names = () => slots().map((s) => s.querySelector('.hud-draw__name').textContent);

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-humans-s13');
  log = rec.logs.spectator;
  page = await replay.realTablePage({ username: 'ios_fan' });
});

afterAll(() => vi.useRealTimers());

describe('a spectator mid-draw', () => {
  it('the join draws the draw so far: the snapshot\'s card face up in its slot, its name; no deck to pick, no prompt', () => {
    const join = log[0];
    expect(join.event).toBe('spectatorJoined');
    expect(join.data.snapshot.stage).toBe('DRAWING');
    const first = join.data.snapshot.draw.drawn[0];
    page.socket.fire('spectatorJoined', JSON.parse(JSON.stringify(join.data)));
    replay.advance(50);
    expect(page.session.role).toBe('spectator');
    expect(draw()).toBeTruthy();
    expect(draw().classList.contains('is-spectator')).toBe(true);
    expect(draw().querySelector('.hud-draw__prompt')).toBeNull();
    expect(draw().querySelector('.hud-draw__key')).toBeNull();
    // the bare felt, as a seat sees the draw (the play zone comes with the deal)
    expect(document.getElementById('playZoneDom')).toBeNull();
    expect(names()).toEqual([first.username, 'Waiting', 'Waiting', 'Waiting']);
    const dm = page.scene.drawManager;
    const drawn = dm.drawnCards();
    expect(drawn).toHaveLength(1);
    const L = page.scene.getLayout();
    const b = drawn[0].getBounds();
    const r = L.draw.slotRects[first.drawOrder - 1];
    expect([b.x, b.y, b.width, b.height].map((v) => Math.round(v * 100) / 100)).toEqual([r.x, r.y, r.w, r.h].map((v) => Math.round(v * 100) / 100));
    expect(dm.deckCards()).toHaveLength(53);
    expect(dm.deckCards().some(({ card }) => card.interactive)).toBe(false);
    // a click on the deck draws nothing
    page.socket.clearEmits();
    const p = L.draw.deck;
    page.scene.pointerDownAt(p.x0, p.y);
    expect(page.socket.emitted('draw')).toEqual([]);
  });

  it('the later draws fill the other slots; then the teams, nobody marked as me', () => {
    const teams = log.findIndex((e) => e.event === 'teamsAnnounced');
    replay.replayLog(page, log, { from: 1, to: teams });
    replay.advance(1000);
    const want = [rec.logs.spectator[0].data.snapshot.draw.drawn[0].username,
      ...log.slice(1, teams).filter((e) => e.event === 'playerDrew').map((e) => e.data.username)];
    expect(names()).toEqual(want);
    expect(slots().some((s) => s.classList.contains('is-mine'))).toBe(false);
    expect(page.scene.drawManager.drawnCards()).toHaveLength(4);
    replay.replayLog(page, log, { from: teams, to: teams + 1 });
    replay.advance(100);
    const panel = hud().querySelector(':scope > .hud-teams');
    expect(panel).toBeTruthy();
    expect(panel.querySelectorAll('.hud-teams__player')).toHaveLength(4);
    expect(panel.querySelectorAll('.hud-teams__player.is-mine')).toHaveLength(0);
  });

  it('…then watches the game as any spectator: every checkpoint matches to the game end, the draw\'s layers gone', () => {
    const teams = log.findIndex((e) => e.event === 'teamsAnnounced');
    const { results, bad } = replay.replayViewer(page, rec, 'spectator', { from: teams + 1 });
    expect(results.length).toBeGreaterThan(50);
    expect(bad).toEqual([]);
    expect(hud()?.querySelector(':scope > .hud-draw, :scope > .hud-teams') ?? null).toBeNull();
    expect(page.scene.drawManager.drawnCards()).toHaveLength(0);
    expect(page.session.screen).toBe('gameEnd');
  });
});
