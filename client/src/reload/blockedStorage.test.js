/**
 * Site data blocked (later #9): reading window.sessionStorage or
 * localStorage throws a SecurityError. ClientSession read it at module load,
 * so the whole app chunk threw before start and the page stayed blank. Now
 * every module-load touch goes through utils/safeStorage.js: the page boots
 * to the sign-in screen, signs in, keeps the session in memory for this
 * page, and joins a game.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload } from '../testing/fakePage.js';
import { SCREEN } from '../state/ClientSession.js';
import { safeSessionStorage } from '../utils/safeStorage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let errors;

beforeAll(async () => {
  errors = vi.spyOn(console, 'error');
  page = await loadPage({ connected: true, blockStorage: true });
});

afterAll(() => {
  errors.mockRestore();
});

describe('blocked storage', () => {
  it('the storage really throws in this page', () => {
    expect(() => window.sessionStorage).toThrow();
    expect(() => window.localStorage).toThrow();
  });

  it('the app loads: the sign-in screen, no error', () => {
    expect(page.session.screen).toBe(SCREEN.SIGN_IN);
    expect(document.getElementById('sign-in-container') || document.querySelector('.auth-screen')).not.toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it('a sign-in works and is kept for this page (memory), then the main room', async () => {
    page.socket.fire('signInResponse', { success: true, username: 'me', sessionToken: 'tok-me', blockedUsers: [] });
    await tick();
    expect(safeSessionStorage().getItem('username')).toBe('me');
    expect(safeSessionStorage().persistent).toBe(false);
    expect(page.session.credentials()).toEqual({ username: 'me', sessionToken: 'tok-me' });
    page.socket.fire('mainRoomJoined', mainRoomPayload());
    await tick();
    expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
    expect(document.getElementById('mainRoomContainer')).not.toBeNull();
  });

  it('a game id is kept for a rejoin after a reconnect (memory)', () => {
    page.socketManager.setGameId('g1');
    expect(page.socketManager.gameId).toBe('g1');
    expect(page.session.persistedGameId).toBe('g1');
    expect(errors).not.toHaveBeenCalled();
  });
});
