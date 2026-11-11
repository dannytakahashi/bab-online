/**
 * Who is watching, in the spectator's own view (events-bots-s14: ios_fan
 * watches; the real page and scene): its full state's snapshot lists it at
 * once (the server looks its picture up after), the following
 * spectatorsUpdated brings the picture, and the list marks it as you.
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
  page = await replay.realTablePage({ username: 'ios_fan', socketId: 'ios-spec' });
});

afterAll(() => vi.useRealTimers());

const slot = () => document.querySelector('#table-hud > .hud-spectators');

describe('the spectator\'s own view', () => {
  it('lists itself at once, then with its picture, marked as you', () => {
    const log = rec.logs.spectator;
    const own = log.find((e) => e.event === 'spectatorJoined' && e.data.snapshot);
    page.socket.fire('spectatorJoined', JSON.parse(JSON.stringify(own.data)));
    replay.advance(100);
    expect(page.session.role).toBe('spectator');
    expect(slot() && !slot().hidden).toBe(true);
    expect(slot().querySelector('button').getAttribute('aria-label')).toBe('1 person watching');

    const later = log.find((e) => e.event === 'spectatorsUpdated');
    page.socket.fire('spectatorsUpdated', JSON.parse(JSON.stringify(later.data)));
    slot().querySelector('button').click();
    expect([...slot().querySelectorAll('li .spectator-popover__name')].map((n) => n.textContent)).toEqual(['ios_fan (you)']);
    expect(slot().querySelector('li img').getAttribute('src')).toBe('assets/avatars/v1/profile12.webp');
  });
});
