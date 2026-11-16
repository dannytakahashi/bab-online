/**
 * Spectator voice seen from a seat (family lobbies, owner 2026-11-16), on
 * the real table (events-bots-s14: ios_ann's game, ios_fan watching). A
 * player's voiceSettings: while spectators may not talk, watchers' audio is
 * force-muted (a backstop: the server already gates their SDP); a watcher
 * speaking lights the spectator badge, not a seat; a player who may change
 * the switch (canChange) gets it in the voice overlay, and it shows the
 * server's value once echoed.
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
  const log = rec.logs['seat1-rejoin'];
  page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
  page.socket.fire('rejoinSuccess', JSON.parse(JSON.stringify(log[0].data)));
  replay.advance(100);
});

afterAll(() => vi.useRealTimers());

const settings = (extra = {}) => ({ gameId: rec.gameId, host: 'ios_ann', spectatorsCanTalk: true, role: 'player', canTalk: true, canChange: true, ...extra });
const badge = () => document.querySelector('#table-hud > .hud-spectators .spectator-badge');
const sw = () => document.getElementById('voice-spectators-can-talk');

describe('a player in a casual game with spectator voice', () => {
  it('voice runs (a rejoin restarts it), with the microphone', async () => {
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    expect(page.voice.isTalking()).toBe(true);
  });

  it('switch off: watchers are force-muted, players never; on again lifts it', () => {
    page.socket.fire('voiceSettings', settings({ spectatorsCanTalk: false }));
    const force = page.voice.forcedMute;
    expect(typeof force).toBe('function');
    expect(force('s-fan', 'ios_fan')).toBe(true);
    const owner = Object.values(page.gameState.seatOwners)[0];
    expect(force('s-x', owner)).toBe(false);
    expect(force('s-y', 'stranger')).toBe(false);
    page.socket.fire('voiceSettings', settings());
    expect(page.voice.forcedMute).toBeNull();
    // the player's own mode never changes
    expect(page.voice.setTalk).not.toHaveBeenCalled();
  });

  it('a watcher speaking lights the spectator badge (a watcher has no seat)', () => {
    page.voice.peers.set('s-fan', { username: 'ios_fan' });
    const cb = page.voice.onSpeakingChange.mock.calls.at(-1)[0];
    cb('s-fan', true);
    expect(badge().classList.contains('voice-speaking')).toBe(true);
    cb('s-fan', false);
    expect(badge().classList.contains('voice-speaking')).toBe(false);
  });

  it('the overlay shows the switch to a player who may change it; it shows the value once echoed', () => {
    page.voice.getPeerVolume = vi.fn(() => 1);
    page.voice.getPeers.mockReturnValue([{ socketId: 's-fan', username: 'ios_fan' }]);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', key: '`', bubbles: true }));
    replay.advance(150);
    expect(sw()).not.toBeNull();
    expect(sw().getAttribute('aria-checked')).toBe('true');
    // the watcher's row says "(watching)"
    const fanRow = [...document.querySelectorAll('#voice-overlay-players .voice-row')].find((r) => r.textContent.includes('ios_fan'));
    expect(fanRow.querySelector('.voice-row__tags').textContent).toBe('(watching)');
    page.socket.clearEmits();
    sw().click();
    expect(page.socket.emitted('setSpectatorsCanTalk')).toEqual([{ spectatorsCanTalk: false }]);
    replay.advance(150);
    expect(sw().disabled).toBe(true);
    // a second click before the echo sends nothing
    sw().click();
    expect(page.socket.emitted('setSpectatorsCanTalk')).toHaveLength(1);
    page.socket.fire('voiceSettings', settings({ spectatorsCanTalk: false }));
    replay.advance(150);
    expect(sw().disabled).toBe(false);
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(fanRow.querySelector('.voice-row__tags').textContent).toBe('(watching) · listening only');
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backquote', key: '`', bubbles: true }));
  });

  it('without canChange (the host is back): no switch', () => {
    page.socket.fire('voiceSettings', settings({ spectatorsCanTalk: false, canChange: false, host: 'someone' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', key: '`', bubbles: true }));
    replay.advance(150);
    expect(document.getElementById('voice-overlay')).not.toBeNull();
    expect(sw()).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backquote', key: '`', bubbles: true }));
  });

  it('a switch change with no echo shows the server\'s value again after 5 s', () => {
    page.socket.fire('voiceSettings', settings({ spectatorsCanTalk: false }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', key: '`', bubbles: true }));
    replay.advance(150);
    sw().click();
    replay.advance(150);
    expect(sw().disabled).toBe(true);
    replay.advance(5000);
    expect(sw().disabled).toBe(false);
    expect(sw().getAttribute('aria-checked')).toBe('false');
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backquote', key: '`', bubbles: true }));
  });
});
