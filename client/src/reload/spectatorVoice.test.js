/**
 * Spectator voice for a main-room spectator (owner 2026-11-16; owner Q1:
 * strangers listen until they tap to talk). One page load: a reload while
 * spectating re-spectates, voiceSettings starts voice LISTEN-ONLY (no
 * microphone prompt), "Tap to talk" (the button, or M) asks for the
 * microphone; voice full ("none") is a pill, not a session; a refused
 * microphone stays listen-only with a toast.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, spectatorState, mainRoomPayload } from '../testing/fakePage.js';
import { clearToasts } from '../ui/kit/index.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

const settings = (extra = {}) => ({ gameId: 'g2', host: 'ann', spectatorsCanTalk: true, role: 'spectator', canTalk: true, canChange: false, ...extra });
const toasts = () => [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent).join(' | ');
const pill = () => document.getElementById('spectating-indicator')?.textContent || '';

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', spectatingGameId: 'g2' }, connected: true });
});

describe('a main-room spectator in a casual game\'s voice', () => {
  it('a reload re-spectates; no voice until voiceSettings says so', async () => {
    const { socket } = page;
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinAsSpectator')).toEqual([{ gameId: 'g2' }]);
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g2' }));
    await vi.waitFor(() => expect(document.getElementById('spectating-indicator')).not.toBeNull());
    expect(page.voice.initialize).not.toHaveBeenCalled();
  });

  it('voiceSettings (may talk): voice starts listen-only, no microphone prompt; the button says Tap to talk', async () => {
    page.socket.fire('voiceSettings', settings());
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    expect(page.voice.initialize.mock.calls[0][1]).toEqual({ talk: false });
    expect(page.voice.isListenOnly()).toBe(true);
    const mute = await vi.waitFor(() => {
      const b = document.getElementById('voice-mute-btn');
      expect(b).not.toBeNull();
      return b;
    });
    expect(mute.getAttribute('aria-disabled')).toBe('true');
    expect(mute.getAttribute('aria-label')).toBe('Tap to talk (M)');
    expect(mute.classList.contains('can-talk')).toBe(true);
    expect(pill()).toMatch(/\(listening only\)$/);
  });

  it('tap to talk: the button asks for the microphone; then it is a mute button again', async () => {
    document.getElementById('voice-mute-btn').click();
    expect(page.voice.setTalk).toHaveBeenLastCalledWith(true);
    await vi.waitFor(() => expect(page.voice.isTalking()).toBe(true));
    await vi.waitFor(() => expect(document.getElementById('voice-mute-btn').getAttribute('aria-label')).toBe('Mute microphone (M)'));
    expect(pill()).not.toMatch(/listening only/);
  });

  it('the host turns it off: listen-only with a toast; back on, a main-room spectator taps again', async () => {
    page.socket.fire('voiceSettings', settings({ spectatorsCanTalk: false, canTalk: false }));
    expect(page.voice.setTalk).toHaveBeenLastCalledWith(false);
    expect(toasts()).toMatch(/turned off spectator talk/);
    page.socket.fire('voiceSettings', settings());
    expect(page.voice.setTalk).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => expect(page.voice.isListenOnly()).toBe(true));
    expect(toasts()).toMatch(/tap the mic to talk/);
  });

  it('M while listen-only and allowed: asks for the microphone (a refusal stays listen-only, with a toast)', async () => {
    page.voice.micDenied = true; // the fake refuses from now on
    page.voice.setTalk.mockClear();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    expect(page.voice.setTalk).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(toasts()).toMatch(/Microphone access denied/));
    expect(page.voice.isListenOnly()).toBe(true);
    page.voice.micDenied = false;
    clearToasts();
  });

  it('no capable player could silence it: listen-only, and a tap only says why (the overlay opens)', async () => {
    page.voice.setTalk.mockClear();
    page.socket.fire('voiceSettings', settings({ canTalk: false }));
    await vi.waitFor(() => expect(document.getElementById('voice-mute-btn').getAttribute('aria-label')).toBe('Listening only (M)'));
    page.voice.getPeers.mockReturnValue([]);
    page.voice.getPeerVolume = vi.fn(() => 1);
    page.voice.setTalk.mockClear();
    document.getElementById('voice-mute-btn').click();
    expect(page.voice.setTalk).not.toHaveBeenCalled();
    expect(toasts()).toMatch(/nobody at this table can let spectators talk/);
    expect(document.getElementById('voice-overlay')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    clearToasts();
  });

  it('running voice told "none" (no place in voice): the session stops and the pill says voice is full', async () => {
    expect(page.voice.active).toBe(true);
    page.socket.fire('voiceSettings', settings({ role: 'none', canTalk: false }));
    expect(page.voice.active).toBe(false);
    expect(document.getElementById('voice-mute-btn')).toBeNull();
    await vi.waitFor(() => expect(pill()).toMatch(/Voice is full \(8 people\)$/));
    clearToasts();
  });

  it('another game with voice full: no voice session, the pill says so', async () => {
    const { socket } = page;
    socket.fire('leftGame');
    expect(page.voice.active).toBe(false);
    socket.fire('mainRoomJoined', mainRoomPayload());
    socket.emit('joinAsSpectator', { gameId: 'g3' });
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g3' }));
    await vi.waitFor(() => expect(document.getElementById('spectating-indicator')).not.toBeNull());
    page.voice.initialize.mockClear();
    socket.fire('voiceSettings', settings({ gameId: 'g3', role: 'none', canTalk: false }));
    expect(page.voice.initialize).not.toHaveBeenCalled();
    expect(page.voice.active).toBe(false);
    await vi.waitFor(() => expect(pill()).toMatch(/Voice is full \(8 people\)$/));
    expect(toasts()).toMatch(/Voice is full/);
  });
});
