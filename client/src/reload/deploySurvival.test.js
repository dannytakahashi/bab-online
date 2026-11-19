/**
 * Deploy survival (LIVE_PERSIST=on, deploy-survival PR 5): what the page does when the
 * game outlives the deploy. The server sends serverShutdown at once, as today; the new
 * instance adopts the game a few seconds later. Until then it never answers "gone": a
 * restoreSession / rejoinGame / joinAsSpectator for a game it is about to adopt is parked
 * (up to 8 s, under REJOIN_HOLD_MS) and then the socket is engine-closed
 * (socket.conn.close(): the page sees a plain transport close, never 'io server
 * disconnect'), so the page reconnects and restores again until the game lands.
 *
 *   - the restore that lands (rejoinSuccess, the re-spectate's spectatorJoined) clears the
 *     restart record: no "ended" toast, then or later;
 *   - an engine close while the rejoin (or the restore itself) is parked leads to exactly
 *     one fresh restoreSession on the new socket and one rejoinGame after its answer; what
 *     the player sent meanwhile goes out once, after the seat is back;
 *   - a later deploy the game does not survive is still explained, once.
 * The seq jump of a restore (+1000) on the real scene: table/recordedDeployResume.test.js.
 * An old server (no handoff, the game gone): reload/serverRestart.test.js, unchanged.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload, clientState, seatDeal, spectatorState } from '../testing/fakePage.js';
import { RESTART_LOSS_TEXT, LOSS, getRestartNotice } from '../state/restartNotice.js';
import { clearToasts } from '../ui/kit/toast.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const SHUTDOWN = { message: 'Server is restarting, please reconnect shortly' };
const CONTINUE = 'The server is updating. This game will continue in a few seconds.';
const RESTARTED_TEXTS = new Set(Object.values(RESTART_LOSS_TEXT));

let page;
let socket;
let n = 1;
let errors;
const nextId = () => `sock-${++n}`;
const restartToasts = () => [...document.querySelectorAll('.kit-toast__text')].map((t) => t.textContent).filter((t) => RESTARTED_TEXTS.has(t));

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
  socket = page.socket;
});

beforeEach(() => {
  errors = vi.spyOn(console, 'error');
  clearToasts();
});

afterEach(() => {
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

function inMainRoom() {
  // the previous case's table goes (/leave), so this socket has nothing to rejoin
  if (page.session.hasTable) {
    socket.fire('leftGame');
    socket.fire('mainRoomJoined', mainRoomPayload());
  }
  socket.reconnect(nextId());
  socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
  socket.fire('mainRoomJoined', mainRoomPayload());
  expect(page.session.screen).toBe('mainRoom');
  socket.clearEmits();
}

function atTable(gameId) {
  socket.fire('allPlayersReady', { gameId });
  socket.fire('startDraw', { start: true });
  socket.fire('createUI', {});
  socket.fire('gameStart', seatDeal({ gameId }));
  expect(page.session.screen).toBe('table');
}

/** The deploy as an 'on' server runs it: serverShutdown now, the outcome line after the flush, the close. */
function deploy(gameId) {
  socket.fire('serverShutdown', SHUTDOWN);
  socket.fire('gameLogEntry', { message: CONTINUE, type: 'system' });
  socket.connected = false;
  socket.fire('disconnect', 'transport close');
  socket.clearEmits();
  socket.reconnect(nextId());
  expect(socket.emitted('restoreSession')).toEqual([{ username: 'me', sessionToken: 'tok-me' }]);
  expect(getRestartNotice().pending).not.toBeNull();
  return gameId;
}

/** The new instance engine-closes a socket it parked (socket.conn.close()): a transport close. */
function engineClose() {
  socket.clearEmits();
  socket.reconnect(nextId());
}

describe('a deploy the game survives', () => {
  it('an engine close during the rejoin hold: one fresh restore on the new socket, the rejoin lands, nothing said', async () => {
    inMainRoom();
    atTable('g21');
    deploy('g21');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g21', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toEqual([{ gameId: 'g21', username: 'me', sessionToken: 'tok-me' }]);
    expect(page.session.awaitingRejoin).toBe(true);
    // the player types while the rejoin is parked: held for the seat
    page.socketManager.emit('chatMessage', { message: 'still here?' });
    expect(socket.emitted('chatMessage')).toEqual([]);

    // parked 8 s, then engine-closed: the page reconnects and restores again, once
    engineClose();
    expect(socket.emitted('restoreSession')).toEqual([{ username: 'me', sessionToken: 'tok-me' }]);
    expect(socket.emitted('rejoinGame')).toEqual([]);
    expect(socket.emitted('chatMessage')).toEqual([]);
    await tick();
    expect(restartToasts()).toEqual([]);
    expect(page.session.screen).toBe('table');

    // the second socket's restore finds the game adopted
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g21', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toEqual([{ gameId: 'g21', username: 'me', sessionToken: 'tok-me' }]);
    socket.fire('rejoinSuccess', clientState({ gameId: 'g21' }));
    await tick();
    expect(page.session.screen).toBe('table');
    expect(sessionStorage.getItem('gameId')).toBe('g21');
    expect(socket.emitted('chatMessage')).toEqual([{ message: 'still here?' }]);
    expect(restartToasts()).toEqual([]);
    expect(getRestartNotice().pending).toBeNull();
  });

  it('the restore itself parked, then engine-closed twice: each new socket restores once, then it lands', async () => {
    inMainRoom();
    atTable('g22');
    deploy('g22');
    // no answer to restoreSession on this socket, nor on the next
    engineClose();
    expect(socket.emitted('restoreSession')).toHaveLength(1);
    engineClose();
    expect(socket.emitted('restoreSession')).toHaveLength(1);
    expect(socket.emitted('joinMainRoom')).toEqual([]);
    await tick();
    expect(restartToasts()).toEqual([]);
    expect(page.session.screen).toBe('table');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g22', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toEqual([{ gameId: 'g22', username: 'me', sessionToken: 'tok-me' }]);
    socket.fire('rejoinSuccess', clientState({ gameId: 'g22' }));
    await tick();
    expect(page.session.screen).toBe('table');
    expect(restartToasts()).toEqual([]);
    expect(getRestartNotice().pending).toBeNull();
  });

  it('a later deploy the game does not survive is still explained, once', async () => {
    inMainRoom();
    atTable('g23');
    deploy('g23');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g23', blockedUsers: [] });
    socket.fire('rejoinSuccess', clientState({ gameId: 'g23' }));
    await tick();
    expect(getRestartNotice().pending).toBeNull();
    // the next deploy has no 'on' successor: the old instance deletes the game and says so
    socket.fire('gameLogEntry', { message: "This game was interrupted by a server update. It won't count toward stats.", type: 'system' });
    socket.fire('serverShutdown', SHUTDOWN);
    expect(getRestartNotice().pending).toBe(LOSS.SEAT);
    socket.connected = false;
    socket.fire('disconnect', 'transport close');
    socket.reconnect(nextId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    socket.fire('rejoinFailed', { reason: 'Game no longer exists' });
    await tick();
    expect(page.session.screen).toBe('mainRoom');
    expect(restartToasts()).toEqual([RESTART_LOSS_TEXT[LOSS.SEAT]]);
    socket.fire('mainRoomJoined', mainRoomPayload());
  });
});

describe('a spectator through a deploy the game survives', () => {
  it('the re-spectate lands (after an engine close of the parked one) and clears the record; a later refusal says nothing about a restart', async () => {
    inMainRoom();
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g31' }));
    expect(page.session.isSpectator).toBe(true);
    deploy('g31');
    expect(getRestartNotice().pending).toBe(LOSS.SPECTATOR);
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinAsSpectator')).toEqual([{ gameId: 'g31' }]);

    // parked, then engine-closed: the next socket watches again
    engineClose();
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinAsSpectator')).toEqual([{ gameId: 'g31' }]);
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g31' }));
    await tick();
    expect(page.session.isSpectator).toBe(true);
    expect(sessionStorage.getItem('spectatingGameId')).toBe('g31');
    expect(getRestartNotice().pending).toBeNull();
    expect(restartToasts()).toEqual([]);

    // much later the game is gone for another reason: the ordinary message, not the restart's
    socket.reconnect(nextId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    socket.fire('serverError', { code: 'rejected', message: 'Game not found', handler: null });
    await tick();
    expect(page.session.screen).toBe('mainRoom');
    expect(restartToasts()).toEqual([]);
    socket.fire('mainRoomJoined', mainRoomPayload());
  });
});
