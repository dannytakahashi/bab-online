/**
 * The over-the-shoulder view of a lazy seat on the real page (owner rule
 * 2026-11-25, people by player names; iOS after #427): events-bots-s14's
 * spectator (ios_fan) watches ios_ann's seat 1 while a bot plays it. The
 * labels of the seat name its owner, ios_ann: the watching pill, the seat-eye
 * chip, the spectator badge's "watching <player>" rows; the avatar's plate
 * shows the bot that plays. Back from /lazy, one name again; a resigned seat
 * keeps its owner; a native bot seat (seat 3, 🤖 Mike) keeps its persona.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
const copy = (v) => JSON.parse(JSON.stringify(v));
let seq = 0;
const next = () => ++seq;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_fan', socketId: 'ios-spec' });
});

afterAll(() => vi.useRealTimers());

const joined = () => rec.logs.spectator[0];
const seatDeal = () => rec.logs.seat1.find((e) => e.event === 'gameStart' && e.t === joined().t);
const pill = () => document.getElementById('spectating-indicator');
const box = () => document.getElementById('player-avatar-container');
const eye = () => box().querySelector('.hud-watch-chip');
const rows = () => {
  document.querySelector('#table-hud > .hud-spectators button').click();
  const names = [...document.querySelectorAll('.spectator-popover__name')].map((n) => n.textContent);
  document.querySelector('#table-hud > .hud-spectators button').click();
  return names;
};
const watchers = (shoulder) => ({ gameId: rec.gameId, spectators: [{ username: 'ios_fan', pic: 12, shoulder }, { username: 'zed', pic: 3, shoulder }], count: 2 });

describe('watching a seat a bot plays for its owner', () => {
  it('watches ios_ann (seat 1)', () => {
    page.socket.fire('spectatorJoined', copy(joined().data));
    replay.advance(100);
    seq = joined().data.snapshot.seq;
    const deal = seatDeal();
    const snap = copy(joined().data.snapshot);
    snap.viewer = { ...snap.viewer, shoulder: { position: 1, hand: copy(deal.data.hand), hsi: null } };
    snap.partial = ['log'];
    page.socket.fire('stateSnapshot', { snapshot: snap, reason: 'watchHand' });
    replay.advance(200);
    expect(pill().textContent).toContain("Watching ios_ann's hand");
  });

  it('lazy: the pill, the eye and the list name ios_ann; the plate shows the bot', () => {
    page.socket.fire('playerLazyMode', { position: 1, botUsername: '🤖 Zach', botPic: 7, originalUsername: 'ios_ann', seq: next() });
    replay.advance(50);
    expect(box().dataset.username).toBe('🤖 Zach');
    expect(pill().textContent).toContain("Watching ios_ann's hand");
    expect(pill().textContent).not.toContain('Zach');
    page.socket.fire('spectatorsUpdated', watchers(1));
    expect(eye().classList.contains('is-on')).toBe(true);
    expect(eye().getAttribute('aria-label')).toBe("You and zed are watching ios_ann's hand");
    expect(rows()).toEqual(['ios_fan (you) · watching ios_ann', 'zed · watching ios_ann']);
  });

  it('back from /lazy: ios_ann everywhere again', () => {
    page.socket.fire('playerActiveMode', { position: 1, username: 'ios_ann', pic: 3, seq: next() });
    replay.advance(50);
    expect(box().dataset.username).toBe('ios_ann');
    expect(pill().textContent).toContain("Watching ios_ann's hand");
    expect(eye().getAttribute('aria-label')).toBe("You and zed are watching ios_ann's hand");
  });

  it('resigned: still the owner who left', () => {
    page.socket.fire('playerResigned', { position: 1, oldUsername: 'ios_ann', botUsername: '🤖 Gina', botPic: 8, seq: next() });
    replay.advance(50);
    expect(box().dataset.username).toBe('🤖 Gina');
    expect(pill().textContent).toContain("Watching ios_ann's hand");
    expect(rows()).toEqual(['ios_fan (you) · watching ios_ann', 'zed · watching ios_ann']);
  });

  it('a native bot seat keeps its persona in the list', () => {
    page.socket.fire('spectatorsUpdated', { gameId: rec.gameId, spectators: [{ username: 'ios_fan', pic: 12, shoulder: 1 }, { username: 'zed', pic: 3, shoulder: 3 }], count: 2 });
    expect(rows()).toEqual(['ios_fan (you) · watching ios_ann', 'zed · watching 🤖 Mike']);
  });
});
