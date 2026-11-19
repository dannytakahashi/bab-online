/**
 * Spectator voice seen from a seat (family lobbies, owner 2026-11-16), on
 * the real table (events-bots-s14: ios_ann's game, ios_fan watching).
 * Owner 2026-11-18: voice starts muted (a rejoin restarts it with no
 * microphone prompt; the first unmute asks), and there is no "Spectators
 * can talk" switch: not in the voice overlay, not in the gear menu, and a
 * voiceSettings with an old server's values (switch off, canChange) shows
 * none and mutes nobody. A watcher speaking lights the spectator badge,
 * not a seat.
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

const settings = (extra = {}) => ({ gameId: rec.gameId, host: 'ios_ann', spectatorsCanTalk: true, role: 'player', canTalk: true, canChange: false, ...extra });
const badge = () => document.querySelector('#table-hud > .hud-spectators .spectator-badge');
const anySwitch = () => document.querySelector('#voice-spectators-can-talk, #voice-popover-spectators-can-talk, #voice-overlay-settings, #voice-popover-settings, [role="switch"]');

describe('a player in a casual game with spectator voice', () => {
  it('voice runs (a rejoin restarts it), muted: no microphone until the first unmute', async () => {
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    expect(page.voice.initialize.mock.calls[0][1]).toEqual({});
    expect(page.voice.isTalking()).toBe(false);
    expect(page.voice.isMuted()).toBe(true);
    const mute = await vi.waitFor(() => {
      const b = document.getElementById('voice-mute-btn');
      expect(b).not.toBeNull();
      return b;
    });
    expect(mute.getAttribute('aria-label')).toBe('Unmute microphone (M)');
    mute.click();
    await vi.waitFor(() => expect(page.voice.isTalking()).toBe(true));
    expect(page.voice.isMuted()).toBe(false);
    await vi.waitFor(() => expect(mute.getAttribute('aria-label')).toBe('Mute microphone (M)'));
  });

  it('an old server\'s voiceSettings (switch off, canChange): nobody is muted for me, my mode never changes', () => {
    page.voice.setTalk.mockClear();
    page.socket.fire('voiceSettings', settings({ spectatorsCanTalk: false, canChange: true }));
    expect(page.voice.setTalk).not.toHaveBeenCalled();
    expect(page.voice.setForcedMute).toBeUndefined();
    expect(page.voice.isTalking()).toBe(true);
    page.socket.fire('voiceSettings', settings());
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

  it('the overlay has no switch (even with an old canChange true); the watcher\'s row says "(watching)"', () => {
    page.socket.fire('voiceSettings', settings({ canChange: true }));
    page.voice.getPeerVolume = vi.fn(() => 1);
    page.voice.getPeers.mockReturnValue([{ socketId: 's-fan', username: 'ios_fan' }]);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backquote', key: '`', bubbles: true }));
    replay.advance(150);
    expect(document.getElementById('voice-overlay')).not.toBeNull();
    expect(anySwitch()).toBeNull();
    const fanRow = [...document.querySelectorAll('#voice-overlay-players .voice-row')].find((r) => r.textContent.includes('ios_fan'));
    expect(fanRow.querySelector('.voice-row__tags').textContent).toBe('(watching)');
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Backquote', key: '`', bubbles: true }));
  });

  it('a watcher who stops speaking as it leaves (no longer listed) clears the ring', () => {
    page.voice.peers.set('s-fan', { username: 'ios_fan' });
    const cb = page.voice.onSpeakingChange.mock.calls.at(-1)[0];
    cb('s-fan', true);
    expect(badge().classList.contains('voice-speaking')).toBe(true);
    const watching = page.gameState.watching;
    page.gameState.watching = { spectators: [], count: 0 };
    try {
      // its call closes after the list dropped it (VoiceChatManager._closePeer)
      cb('s-fan', false);
      expect(badge().classList.contains('voice-speaking')).toBe(false);
    } finally {
      page.gameState.watching = watching;
    }
  });

  it('without a keyboard: the gear menu (no switch) opens the voice panel by click (a Close button)', async () => {
    page.socket.fire('voiceSettings', settings({ canChange: true }));
    replay.advance(150);
    const gear = document.getElementById('voice-device-btn');
    expect(gear).not.toBeNull();
    expect(gear.getAttribute('aria-label')).toBe('Voice settings');
    page.socket.clearEmits();
    gear.click();
    await vi.waitFor(() => expect(document.getElementById('voice-device-popover')).not.toBeNull());
    expect(anySwitch()).toBeNull();
    // "Voice chat panel": the overlay, opened by click, stays until closed
    document.getElementById('voice-panel-item').click();
    expect(document.getElementById('voice-device-popover')).toBeNull();
    expect(document.getElementById('voice-overlay')).not.toBeNull();
    expect(anySwitch()).toBeNull();
    replay.advance(500);
    expect(document.getElementById('voice-overlay')).not.toBeNull();
    const close = document.querySelector('#voice-overlay .kit-modal__close');
    expect(close).not.toBeNull();
    close.click();
    expect(document.getElementById('voice-overlay')).toBeNull();
    expect(page.socket.emitted('setSpectatorsCanTalk')).toEqual([]);
  });
});
