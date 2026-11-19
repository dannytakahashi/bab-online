/**
 * Spectator voice for a main-room spectator (owner 2026-11-16), muted at
 * the start (owner 2026-11-18: "by default the mic should be muted and you
 * can click to unmute / activate mic"; spectators always may talk). One
 * page load: a reload while spectating re-spectates, voiceSettings starts
 * voice MUTED (no microphone prompt), the first unmute (the button, or M)
 * asks for the microphone; a refused microphone stays muted, listening
 * only, with a toast, and a tap asks again; voice full ("none") is a pill,
 * not a session.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPage, spectatorState, mainRoomPayload } from '../testing/fakePage.js';
import { REPO_ROOT } from '../testing/files.js';
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

  it('voiceSettings: voice starts muted, no microphone prompt; the button shows the muted mic', async () => {
    page.socket.fire('voiceSettings', settings());
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    expect(page.voice.initialize.mock.calls[0][1]).toEqual({});
    expect(page.voice.isTalking()).toBe(false);
    expect(page.voice.isMuted()).toBe(true);
    expect(page.voice.setTalk).not.toHaveBeenCalled();
    const mute = await vi.waitFor(() => {
      const b = document.getElementById('voice-mute-btn');
      expect(b).not.toBeNull();
      return b;
    });
    expect(mute.hasAttribute('aria-disabled')).toBe(false);
    expect(mute.getAttribute('aria-label')).toBe('Unmute microphone (M)');
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(pill()).not.toMatch(/listening only/);
  });

  it('unmute: the button asks for the microphone; then it reads Mute', async () => {
    document.getElementById('voice-mute-btn').click();
    expect(page.voice.setMuted).toHaveBeenLastCalledWith(false);
    expect(page.voice.setTalk).toHaveBeenLastCalledWith(true);
    await vi.waitFor(() => expect(page.voice.isTalking()).toBe(true));
    await vi.waitFor(() => expect(document.getElementById('voice-mute-btn').getAttribute('aria-label')).toBe('Mute microphone (M)'));
    expect(page.voice.isMuted()).toBe(false);
    expect(pill()).not.toMatch(/listening only/);
  });

  it('M mutes again and keeps the microphone (no new prompt)', async () => {
    page.voice.setTalk.mockClear();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    expect(page.voice.setMuted).toHaveBeenLastCalledWith(true);
    await vi.waitFor(() => expect(document.getElementById('voice-mute-btn').getAttribute('aria-label')).toBe('Unmute microphone (M)'));
    expect(page.voice.isTalking()).toBe(true);
    expect(page.voice.setTalk).not.toHaveBeenCalled();
  });

  it('voiceSettings with an old server\'s values (spectatorsCanTalk / canTalk false) changes nothing: no toast, the mode stays', async () => {
    page.voice.setTalk.mockClear();
    page.socket.fire('voiceSettings', settings({ spectatorsCanTalk: false, canTalk: false }));
    expect(page.voice.setTalk).not.toHaveBeenCalled();
    expect(toasts()).not.toMatch(/spectator talk/);
    expect(page.voice.isTalking()).toBe(true);
    page.socket.fire('voiceSettings', settings());
    expect(page.voice.setTalk).not.toHaveBeenCalled();
    clearToasts();
  });

  it('a refused microphone on unmute: stays muted, listening only, with a toast; a tap asks again', async () => {
    // back to no microphone (a fresh session would be the same)
    await page.voice.setTalk(false);
    page.voice.refuseMic = true;
    page.voice.setTalk.mockClear();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    expect(page.voice.setTalk).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(toasts()).toMatch(/Microphone access denied\. You can still listen\./));
    expect(page.voice.isListenOnly()).toBe(true);
    expect(page.voice.isMuted()).toBe(true);
    const mute = document.getElementById('voice-mute-btn');
    await vi.waitFor(() => expect(mute.getAttribute('aria-label')).toBe('Tap to talk (no mic access yet) (M)'));
    expect(mute.getAttribute('aria-disabled')).toBe('true');
    expect(mute.classList.contains('can-talk')).toBe(true);
    expect(pill()).toMatch(/\(listening only\)$/);
    clearToasts();
    // allowed this time
    page.voice.refuseMic = false;
    mute.click();
    await vi.waitFor(() => expect(page.voice.isTalking()).toBe(true));
    await vi.waitFor(() => expect(document.getElementById('voice-mute-btn').getAttribute('aria-label')).toBe('Mute microphone (M)'));
    expect(pill()).not.toMatch(/listening only/);
    expect(toasts()).toBe('');
  });

  it('a second click while the microphone prompt is up: the button shows each choice at once, and the mute wins when the prompt is allowed (review 2026-11-18)', async () => {
    await page.voice.setTalk(false); // no microphone again
    page.voice.holdMic = true;
    const label = () => document.getElementById('voice-mute-btn').getAttribute('aria-label');
    await vi.waitFor(() => expect(label()).toBe('Unmute microphone (M)'));
    document.getElementById('voice-mute-btn').click();
    expect(page.voice.micRequestInFlight).toBe(true);
    expect(label()).toBe('Mute microphone (M)'); // the unmute asked for, while the prompt is up
    document.getElementById('voice-mute-btn').click();
    expect(label()).toBe('Unmute microphone (M)');
    expect(page.voice.selfMuted).toBe(true);
    page.voice.answerMic(); // allowed
    await vi.waitFor(() => expect(page.voice.isTalking()).toBe(true));
    await vi.waitFor(() => expect(page.voice.micRequestInFlight).toBe(false));
    expect(page.voice.isMuted()).toBe(true);
    await Promise.resolve();
    expect(label()).toBe('Unmute microphone (M)');
    expect(toasts()).toBe('');
    page.voice.holdMic = false;
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
    clearToasts();
  });

  it('a watcher waiting for company told "none" no longer wants voice: a later arrival starts nothing (review 2026-11-19)', async () => {
    const { socket } = page;
    socket.fire('leftGame');
    socket.fire('mainRoomJoined', mainRoomPayload());
    socket.emit('joinAsSpectator', { gameId: 'g4' });
    // every seat a bot (a v2 snapshot): nobody to talk to yet
    const fx = JSON.parse(readFileSync(resolve(REPO_ROOT, 'contract/fixtures/v2/spectator-mid-hand.json'), 'utf8')).snapshot;
    const snapshot = {
      ...fx,
      gameId: 'g4',
      seats: fx.seats.map((st) => ({ ...st, username: `🤖 Bot${st.position}`, ownerUsername: null, controller: 'bot', presence: 'none', isBot: true })),
      watching: { spectators: [{ username: 'me', pic: 1 }], count: 1 },
    };
    socket.fire('spectatorJoined', { gameId: 'g4', players: [], trump: null, snapshot });
    await vi.waitFor(() => expect(document.getElementById('spectating-indicator')).not.toBeNull());
    expect(page.gameState.otherHumans().names.size).toBe(0);
    page.voice.initialize.mockClear();
    socket.fire('voiceSettings', settings({ gameId: 'g4' }));
    await Promise.resolve();
    expect(page.voice.initialize).not.toHaveBeenCalled();
    // a newer tab of mine took the slot
    socket.fire('voiceSettings', settings({ gameId: 'g4', role: 'none', canTalk: false }));
    socket.fire('spectatorsUpdated', { gameId: 'g4', spectators: [{ username: 'me', pic: 1 }, { username: 'zed', pic: 2 }], count: 2 });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(page.voice.initialize).not.toHaveBeenCalled();
    expect(page.voice.active).toBe(false);
    clearToasts();
  });
});
