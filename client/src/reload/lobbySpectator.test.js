/**
 * A family lobby's extra (owner 2026-11-16: lobbies of up to 8, the first 4
 * to tap Ready play, the rest watch the game in its chat and voice). One
 * page load: the lobby of 6 with its host switch and rows, then the start
 * as an extra (spectatorJoined at CREATED, never allPlayersReady), the
 * room's startDraw that must not seat it, the voice that carries over and
 * follows the host's "Spectators can talk", and the M key while it may
 * only listen.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPage, mainRoomPayload } from '../testing/fakePage.js';
import { REPO_ROOT } from '../testing/files.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

const NAMES = ['ann', 'bob', 'cat', 'dan', 'eve', 'me'];
/** A lobby event for a capable socket: players (first 4) plus the additive keys. */
function lobbyPayload({ ready = [], playing = null, on = true, host = 'ann' } = {}) {
  const members = NAMES.map((username) => ({
    socketId: username === 'me' ? 'sock-1' : `s-${username}`,
    username,
    ready: ready.includes(username),
    playing: playing ? playing.includes(username) : ready.includes(username),
  }));
  return {
    lobbyId: 'L6',
    players: members.slice(0, 4).map(({ socketId, username, ready: r }) => ({ socketId, username, ready: r })),
    members,
    host,
    settings: { spectatorsCanTalk: on },
    capacity: 8,
  };
}

/** The server's spectatorJoined full state for an extra: a CREATED snapshot (contract fixture). */
function createdForSpectator(gameId = 'g9') {
  const fx = JSON.parse(readFileSync(resolve(REPO_ROOT, 'contract/fixtures/v2/created-countdown.json'), 'utf8'));
  const snapshot = { ...fx.snapshot, gameId, viewer: { role: 'spectator', position: null, ownerView: null, canAct: false } };
  return { gameId, players: [], trump: null, snapshot };
}

const voiceSettings = (extra = {}) => ({ gameId: 'g9', host: 'ann', spectatorsCanTalk: true, role: 'spectator', canTalk: true, canChange: false, ...extra });
const toasts = () => [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent);
const rowOf = (name) => [...document.querySelectorAll('#lobbyPlayersList .seat-row')]
  .find((r) => r.querySelector('.seat-row__name')?.textContent.startsWith(name));

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
  page.socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
  page.socket.fire('mainRoomJoined', mainRoomPayload());
});

describe('a family lobby of 6, seen by a member who is not the host', () => {
  it('the hello says casualSpectators', () => {
    const hello = page.socket.emitted('clientHello')[0];
    expect(hello.caps).toContain('casualSpectators');
  });

  it('every member has a row, the header counts n/8 and Ready r/4, the host is marked; the switch is read-only', async () => {
    page.socket.fire('lobbyCreated', { ...lobbyPayload(), name: 'Family', messages: [] });
    expect(page.session.screen).toBe('lobby');
    expect(document.querySelectorAll('#lobbyPlayersList .seat-row:not(.seat-row--empty)')).toHaveLength(6);
    expect(document.querySelectorAll('#lobbyPlayersList .seat-row--empty')).toHaveLength(0);
    expect(document.querySelector('#lobbyPlayersList .section-label').textContent).toBe('Players 6/8 · Ready 0/4');
    expect(rowOf('ann').querySelector('.seat-row__name').textContent).toBe('ann (host)');
    expect(document.getElementById('lobbySpectatorsCanTalk')).toBeNull();
    expect(document.getElementById('lobbySpectatorsCanTalkValue').textContent).toMatch(/On/);
    expect(document.getElementById('lobbyVoiceHint').textContent).toMatch(/can talk/);
    // lobby voice starts as always (with the microphone)
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    expect(page.voice.isTalking()).toBe(true);
  });

  it('four others ready first: they show Playing, I show Will watch, my Ready is "Table full"', () => {
    page.socket.fire('playerReadyUpdate', lobbyPayload({ ready: ['ann', 'bob', 'cat', 'dan'], on: false }));
    expect(rowOf('ann').dataset.role).toBe('playing');
    expect(rowOf('me').dataset.role).toBe('watching');
    expect(rowOf('me').querySelector('.seat-row__role').textContent).toBe('Will watch');
    const ready = document.getElementById('lobbyReadyBtn');
    expect(ready.disabled).toBe(true);
    expect(ready.textContent).toBe('Table full — you\'ll watch');
    expect(document.getElementById('lobbySpectatorsCanTalkValue').textContent).toMatch(/Off/);
    expect(document.getElementById('lobbyVoiceHint').textContent).toMatch(/only listen/);
  });

  it('the start: spectatorJoined at CREATED puts me at the table as a spectator; voice is not shut down', () => {
    page.socket.fire('spectatorJoined', createdForSpectator());
    expect(page.session.screen).toBe('table');
    expect(page.session.role).toBe('spectator');
    expect(sessionStorage.getItem('spectatingGameId')).toBe('g9');
    expect(sessionStorage.getItem('lobbyId')).toBeNull();
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    expect(page.voice.active).toBe(true);
  });

  it('voiceSettings with the switch off: listen-only (the mic goes), the pill says so', async () => {
    page.voice.setTalk.mockClear();
    page.socket.fire('voiceSettings', voiceSettings({ spectatorsCanTalk: false, canTalk: false }));
    expect(page.voice.setTalk).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(page.voice.isListenOnly()).toBe(true));
    await vi.waitFor(() => expect(document.getElementById('spectating-indicator')?.textContent).toMatch(/\(listening only\)$/));
    const mute = document.getElementById('voice-mute-btn');
    expect(mute.getAttribute('aria-disabled')).toBe('true');
    expect(mute.disabled).toBe(false);
    expect(mute.getAttribute('aria-label')).toBe('Listening only (M)');
  });

  it('the room\'s startDraw never makes me a player (no draw button of mine)', () => {
    page.socket.fire('startDraw', { start: true });
    expect(page.session.role).toBe('spectator');
    expect(sessionStorage.getItem('gameId')).toBeNull();
    expect(page.socket.emitted('draw')).toEqual([]);
  });

  it('M while I may not talk: says why, asks for no microphone', () => {
    page.voice.setTalk.mockClear();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    expect(page.voice.setTalk).not.toHaveBeenCalled();
    expect(toasts().join(' ')).toMatch(/turned off spectator talk/);
  });

  it('the host turns it back on: a lobby extra talks again (its microphone comes back), with a toast', async () => {
    page.socket.fire('voiceSettings', voiceSettings());
    expect(page.voice.setTalk).toHaveBeenLastCalledWith(true);
    await vi.waitFor(() => expect(page.voice.isTalking()).toBe(true));
    expect(toasts().join(' ')).toMatch(/Spectators can talk again/);
    const mute = document.getElementById('voice-mute-btn');
    expect(mute.hasAttribute('aria-disabled')).toBe(false);
    expect(document.getElementById('spectating-indicator').textContent).not.toMatch(/listening only/);
  });

  it('another table\'s late voiceSettings is ignored', () => {
    page.voice.setTalk.mockClear();
    page.socket.fire('voiceSettings', voiceSettings({ gameId: 'other', canTalk: false, spectatorsCanTalk: false }));
    expect(page.voice.setTalk).not.toHaveBeenCalled();
  });

  it('leaving the table stops voice', () => {
    page.socket.fire('leftGame');
    expect(page.voice.shutdown).toHaveBeenCalled();
    expect(page.voice.active).toBe(false);
    expect(document.getElementById('voice-mute-btn')).toBeNull();
  });
});
