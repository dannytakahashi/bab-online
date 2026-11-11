/**
 * A spectator's chat by the badge, in the spectator's own view
 * (events-bots-s14: ios_fan watches; the real page and scene): its own
 * message comes back from the room like everyone's and shows by its own
 * badge (beside the corner's voice slot), as a player's own message shows
 * over its own avatar; a player's message goes over that player's seat.
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
  page = await replay.realTablePage({ username: 'ios_fan', socketId: 'ios-spec' });
});

afterAll(() => vi.useRealTimers());

const badgeBubbles = () => [...document.querySelectorAll('#table-hud > .hud-spectator-bubble > .chat-bubble')];
const px = (v) => `${Math.round(v * 100) / 100}px`;

describe('the spectator\'s own view', () => {
  it('its own message shows by its own badge, beside the corner voice slot', () => {
    const log = rec.logs.spectator;
    const own = log.find((e) => e.event === 'spectatorJoined' && e.data.snapshot);
    page.socket.fire('spectatorJoined', JSON.parse(JSON.stringify(own.data)));
    replay.advance(100);
    expect(page.session.role).toBe('spectator');

    // what the server sends the room (and so this socket) for its chat
    page.socket.fire('chatMessage', { position: null, message: 'go team', username: 'ios_fan', isSpectator: true, type: 'spectator', seq: gate.lastSeq + 1 });
    const [b] = badgeBubbles();
    expect(b?.textContent).toBe('ios_fan: go team');
    expect(b.classList.contains('is-spectator')).toBe(true);

    const L = page.scene.getLayout();
    expect(L.isSpectator).toBe(true);
    // the badge beside the voice slot, its bubble hung from the layout's spot
    expect(L.spectators.rect.y).toBe(L.voice.rect.y);
    const hud = document.getElementById('table-hud');
    expect(hud.style.getPropertyValue('--specbub-x')).toBe(px(L.spectators.bubble.x));
    expect(hud.style.getPropertyValue('--specbub-y')).toBe(px(L.spectators.bubble.y));
    expect(document.querySelector('#table-hud > .hud-spectator-bubble').hidden).toBe(false);
  });

  it('a player\'s message goes over that player\'s seat (the bottom seat is position 1)', () => {
    page.socket.fire('chatMessage', { position: 1, message: 'thanks', username: 'ios_ann', isSpectator: false, type: 'player', seq: gate.lastSeq + 1 });
    expect(document.querySelector('#table-hud > .hud-seat[data-seat="self"] .chat-bubble')?.textContent).toBe('thanks');
    expect(badgeBubbles().map((b) => b.textContent)).toEqual(['ios_fan: go team']);
  });
});
