/**
 * A second tab takes the session (live check 2026-11-11: the first tab was
 * left signed in but dead, "Server error: User not registered yet" for
 * every action). The server keeps one live connection per user and tells
 * the older tab `sessionSuperseded`; this tab then shows the full-screen
 * "open in another tab" notice, stays paused (no reconnect, ping or ack
 * resync takes the session back by itself) and Use here takes it back: a
 * fresh socket restores the session and re-enters the screen the tab
 * shows (main room, lobby, table), which parks the other tab the same way.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload, clientState, seatDeal } from '../testing/fakePage.js';
import { NOTICE_ID, NOTICE_TITLE } from '../ui/components/SupersededNotice.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;
let n = 1;
let errors;
const nextId = () => `sock-${++n}`;
const notice = () => document.getElementById(NOTICE_ID);
const useHere = () => notice()?.querySelector('.superseded-notice__use');

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
  socket = page.socket;
});

beforeEach(() => {
  errors = vi.spyOn(console, 'error');
});

afterEach(() => {
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

/** Restored in the main room on a fresh socket. */
function inMainRoom() {
  socket.reconnect(nextId());
  socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
  socket.fire('mainRoomJoined', mainRoomPayload());
  expect(page.session.screen).toBe('mainRoom');
  socket.clearEmits();
}

/** Use here: the page reconnects (a new socket) and restores. */
async function takeBack() {
  socket.disconnect.mockClear();
  useHere().click();
  expect(notice()).toBeNull();
  expect(socket.disconnect).toHaveBeenCalledTimes(1);
  await tick(150);
  socket.reconnect(nextId());
  expect(socket.emitted('restoreSession')).toEqual([{ username: 'me', sessionToken: 'tok-me' }]);
}

describe('another tab takes the session', () => {
  it('the main room: a full-screen notice, focus on Use here, the tab paused', () => {
    inMainRoom();
    page.voice.shutdown.mockClear();
    socket.fire('sessionSuperseded', { reason: 'newerConnection' });

    const backdrop = notice();
    expect(backdrop).not.toBeNull();
    expect(backdrop.classList.contains('superseded-notice-backdrop')).toBe(true);
    const dialog = backdrop.querySelector('[role="alertdialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe(NOTICE_TITLE);
    expect(document.getElementById(dialog.getAttribute('aria-describedby')).textContent).toMatch(/another tab or window/);
    expect(document.activeElement).toBe(useHere());
    expect(useHere().textContent).toBe('Use here');
    expect(page.session.isParked).toBe(true);
    expect(page.voice.shutdown).toHaveBeenCalled();

    // Escape does not close it; Tab keeps focus on its one button
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(notice()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(useHere());

    // A refusal (the answer to something this tab sent) changes nothing
    socket.fire('sessionSuperseded', { reason: 'newerConnection', refused: 'mainRoomChat' });
    expect(document.querySelectorAll(`#${NOTICE_ID}`)).toHaveLength(1);
  });

  it('while paused nothing takes the session back by itself: a reconnect, a background ping, an ack resync', () => {
    socket.reconnect(nextId());
    expect(socket.emitted('restoreSession')).toEqual([]);
    expect(page.socketManager.probeConnection()).toBe(false);
    socket.disconnect.mockClear();
    page.socketManager.forceReconnect();
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.emittedNames()).toEqual([]); // only clientHello (allowed while parked)
    expect(notice()).not.toBeNull();
  });

  it('Use here: a fresh socket restores the session and the main room comes back', async () => {
    await takeBack();
    expect(page.session.isParked).toBe(false);
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(page.session.screen).toBe('mainRoom');
    expect(notice()).toBeNull();
  });

  it('in a lobby: Use here re-enters the same lobby', async () => {
    socket.fire('lobbyCreated', { lobbyId: 'L5', players: [{ socketId: socket.id, username: 'me', ready: false }], messages: [] });
    expect(page.session.screen).toBe('lobby');
    socket.fire('sessionSuperseded', { reason: 'newerConnection' });
    expect(notice()).not.toBeNull();
    socket.clearEmits();
    await takeBack();
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinLobby')).toEqual([{ lobbyId: 'L5' }]);
    socket.fire('lobbyCreated', { lobbyId: 'L5', players: [{ socketId: socket.id, username: 'me', ready: false }], messages: [] });
    expect(page.session.screen).toBe('lobby');
  });

  it('at the table: Use here rejoins the game (the seat follows this tab again)', async () => {
    socket.fire('allPlayersReady', { gameId: 'g7' });
    socket.fire('startDraw', { start: true });
    socket.fire('createUI', {});
    socket.fire('gameStart', seatDeal({ gameId: 'g7' }));
    expect(page.session.screen).toBe('table');
    socket.fire('sessionSuperseded', { reason: 'newerConnection' });
    expect(notice()).not.toBeNull();
    // the table stays underneath (nothing torn down while paused)
    expect(page.session.screen).toBe('table');
    socket.clearEmits();
    await takeBack();
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g7', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toEqual([{ gameId: 'g7', username: 'me', sessionToken: 'tok-me' }]);
    socket.fire('rejoinSuccess', clientState({ gameId: 'g7' }));
    expect(page.session.screen).toBe('table');
    expect(notice()).toBeNull();
  });

  it('a restore answered on this socket after the notice (two restores racing) lifts it', () => {
    socket.fire('sessionSuperseded', { reason: 'newerConnection' });
    expect(page.session.isParked).toBe(true);
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g7', blockedUsers: [] });
    expect(notice()).toBeNull();
    expect(page.session.isParked).toBe(false);
  });

  it('signed out everywhere while paused: the sign-in screen, no notice', () => {
    socket.fire('sessionSuperseded', { reason: 'newerConnection' });
    socket.fire('forceLogout');
    expect(notice()).toBeNull();
    expect(page.session.isParked).toBe(false);
    expect(page.session.screen).toBe('signIn');
  });
});
