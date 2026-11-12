/**
 * The server restarts for an update (owner decision 2026-11-11: show it;
 * V1_REMOVALS #17 kept). Every deploy sends `serverShutdown` and closes
 * every socket about 1 s later; the server comes back with nothing in
 * memory. The page shows the restart banner until it is connected again,
 * then the restore finds the game / lobby / tournament gone and ONE plain
 * message says what ended. The player lands where the existing flows put
 * them (the main room). Nothing is said for a main-room player or when the
 * place survived, and one message only even when several paths fire.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload, clientState, seatDeal, spectatorState, tournamentPayload, tableLeftovers, CLEAN } from '../testing/fakePage.js';
import { BANNER_ID, BANNER_TEXT } from '../ui/components/ConnectionBanner.js';
import { RESTART_LOSS_TEXT, LOSS, getRestartNotice, RESTART_NOTICE_KEY } from '../state/restartNotice.js';
import { clearToasts } from '../ui/kit/toast.js';
import { NOTICE_ID } from '../ui/components/SupersededNotice.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const SHUTDOWN = { message: 'Server is restarting, please reconnect shortly' };
const RESTARTED_TEXTS = new Set(Object.values(RESTART_LOSS_TEXT));

let page;
let socket;
let n = 1;
let errors;
let toasts; // every toast text that appeared, in order
let observer;
const nextId = () => `sock-${++n}`;
const banner = () => document.getElementById(BANNER_ID);
const bannerShown = () => banner().classList.contains('visible');

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
  socket = page.socket;
});

beforeEach(() => {
  errors = vi.spyOn(console, 'error');
  clearToasts();
  toasts = [];
  // a toast replaces the text of one of its kind on screen: record every text
  observer = new MutationObserver(() => {
    for (const t of document.querySelectorAll('.kit-toast')) {
      const text = t.textContent;
      if (toasts[toasts.length - 1] !== text) toasts.push(text);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
});

afterEach(() => {
  observer.disconnect();
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

function atTable(gameId = 'g7') {
  socket.fire('allPlayersReady', { gameId });
  socket.fire('startDraw', { start: true });
  socket.fire('createUI', {});
  socket.fire('gameStart', seatDeal({ gameId }));
  expect(page.session.screen).toBe('table');
}

/**
 * The deploy: serverShutdown, the transport closes, Socket.IO retries while
 * the new server boots, then connects. The banner says it is a restart all
 * along and is gone once connected; the page restores its session.
 */
function restart() {
  socket.fire('serverShutdown', SHUTDOWN);
  expect([bannerShown(), banner().textContent]).toEqual([true, BANNER_TEXT.restarting]);
  socket.connected = false;
  socket.fire('disconnect', 'transport close');
  socket.fireIo('reconnect_attempt', 1);
  socket.fireIo('reconnect_attempt', 2);
  expect(banner().textContent).toBe(BANNER_TEXT.restarting);
  socket.clearEmits();
  socket.reconnect(nextId());
  expect(bannerShown()).toBe(false);
  expect(socket.emitted('restoreSession')).toEqual([{ username: 'me', sessionToken: 'tok-me' }]);
}

const restartToasts = () => toasts.filter((t) => RESTARTED_TEXTS.has(t));

describe('the server restarts for an update', () => {
  it('at a seat mid-hand: the banner, then after the reconnect "your game ended" once, in the main room', async () => {
    inMainRoom();
    atTable('g7');
    restart();
    // the new server: no game, so restoreSession has no activeGameId
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toEqual([{ gameId: 'g7', username: 'me', sessionToken: 'tok-me' }]);
    // a resync answered not_in_game says nothing on its own
    socket.fire('stateSnapshot', { snapshot: null, reason: 'not_in_game' });
    await tick();
    expect(restartToasts()).toEqual([]);

    socket.fire('rejoinFailed', { reason: 'Game no longer exists' });
    await tick();
    expect(page.session.screen).toBe('mainRoom');
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(tableLeftovers(page)).toEqual(CLEAN);
    expect(restartToasts()).toEqual([RESTART_LOSS_TEXT[LOSS.SEAT]]);
    const toast = [...document.querySelectorAll('.kit-toast')].find((t) => t.textContent === RESTART_LOSS_TEXT[LOSS.SEAT]);
    expect(toast.getAttribute('role')).toBe('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');

    // another path firing (a repeated refusal, another not_in_game): still one message
    socket.fire('rejoinFailed', { reason: 'Game no longer exists' });
    socket.fire('stateSnapshot', { snapshot: null, reason: 'not_in_game' });
    socket.fire('mainRoomJoined', mainRoomPayload());
    await tick();
    expect(restartToasts()).toEqual([RESTART_LOSS_TEXT[LOSS.SEAT]]);
    expect(getRestartNotice().pending).toBeNull();
  });

  it('in the main room only: the banner shows, then no "ended" message', async () => {
    inMainRoom();
    restart();
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    socket.fire('mainRoomJoined', mainRoomPayload());
    await tick();
    expect(page.session.screen).toBe('mainRoom');
    expect(restartToasts()).toEqual([]);
    expect(sessionStorage.getItem(RESTART_NOTICE_KEY)).toBeNull();
  });

  it('spectating: "the game you were watching ended", no error logged', async () => {
    inMainRoom();
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g2' }));
    expect(page.session.isSpectator).toBe(true);
    restart();
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinAsSpectator')).toEqual([{ gameId: 'g2' }]);
    socket.fire('error', { message: 'Game not found' });
    await tick();
    expect(page.session.screen).toBe('mainRoom');
    expect(tableLeftovers(page)).toEqual(CLEAN);
    expect(restartToasts()).toEqual([RESTART_LOSS_TEXT[LOSS.SPECTATOR]]);
    socket.fire('mainRoomJoined', mainRoomPayload());
  });

  it('in a game lobby: "your lobby closed" replaces the generic lobby toast', async () => {
    inMainRoom();
    socket.fire('lobbyCreated', { lobbyId: 'L5', players: [{ socketId: socket.id, username: 'me', ready: false }], messages: [] });
    expect(page.session.screen).toBe('lobby');
    restart();
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinLobby')).toEqual([{ lobbyId: 'L5' }]);
    socket.fire('error', { message: 'Lobby not found' });
    await tick();
    expect(page.session.screen).toBe('mainRoom');
    expect(toasts).toEqual([RESTART_LOSS_TEXT[LOSS.LOBBY]]);
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    socket.fire('mainRoomJoined', mainRoomPayload());
  });

  it('in a tournament lobby: "your tournament ended", not "no longer available"', async () => {
    inMainRoom();
    socket.fire('tournamentJoined', tournamentPayload({ tournamentId: 't1' }));
    expect(page.session.screen).toBe('tournamentLobby');
    restart();
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinTournament')).toEqual([{ tournamentId: 't1' }]);
    socket.fire('error', { message: 'Tournament not found' });
    socket.fire('mainRoomJoined', mainRoomPayload());
    await tick();
    expect(page.session.screen).toBe('mainRoom');
    expect(toasts).toEqual([RESTART_LOSS_TEXT[LOSS.TOURNAMENT]]);
  });

  it('at a tournament table: one message although the rejoin and the tournament re-entry both fail', async () => {
    inMainRoom();
    socket.fire('tournamentJoined', tournamentPayload({ tournamentId: 't3', phase: 'playing' }));
    atTable('g9');
    expect(page.gameState.tournamentId).toBe('t3');
    restart();
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toEqual([{ gameId: 'g9', username: 'me', sessionToken: 'tok-me' }]);
    socket.fire('rejoinFailed', { reason: 'Game no longer exists' });
    // a failed rejoin routes a tournament player back to the tournament
    expect(socket.emitted('returnToTournament')).toHaveLength(1);
    // the server finds none: tournamentLeft + the main room
    socket.fire('tournamentLeft', {});
    socket.fire('mainRoomJoined', mainRoomPayload());
    await tick();
    expect(page.session.screen).toBe('mainRoom');
    expect(restartToasts()).toEqual([RESTART_LOSS_TEXT[LOSS.TOURNAMENT]]);
    expect(toasts).toEqual([RESTART_LOSS_TEXT[LOSS.TOURNAMENT]]);
    expect(tableLeftovers(page)).toEqual(CLEAN);
  });

  it('a game that survived (the rejoin succeeds): nothing is said, and the record is gone', async () => {
    inMainRoom();
    atTable('g11');
    restart();
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g11', blockedUsers: [] });
    socket.fire('rejoinSuccess', clientState({ gameId: 'g11' }));
    await tick();
    expect(page.session.screen).toBe('table');
    expect(restartToasts()).toEqual([]);
    expect(getRestartNotice().pending).toBeNull();
    // leaving it later says nothing about a restart
    socket.fire('rejoinFailed', { reason: 'Game no longer exists' });
    await tick();
    expect(restartToasts()).toEqual([]);
    socket.fire('mainRoomJoined', mainRoomPayload());
  });

  it('a tab paused behind another one records nothing (nothing of its own is lost)', async () => {
    inMainRoom();
    atTable('g12');
    socket.fire('sessionSuperseded', { reason: 'newerConnection' });
    expect(page.session.isParked).toBe(true);
    socket.fire('serverShutdown', SHUTDOWN);
    expect(banner().textContent).toBe(BANNER_TEXT.restarting);
    expect(getRestartNotice().pending).toBeNull();
    // a reconnect while paused restores nothing; the notice stays
    socket.reconnect(nextId());
    expect(socket.emitted('restoreSession')).toEqual([]);
    expect(document.getElementById(NOTICE_ID)).not.toBeNull();
    await tick();
    expect(restartToasts()).toEqual([]);
    // Use here takes it back (and leaves the table it had)
    document.querySelector('.superseded-notice__use').click();
    await tick(150);
    socket.reconnect(nextId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    socket.fire('rejoinFailed', { reason: 'Game no longer exists' });
    socket.fire('mainRoomJoined', mainRoomPayload());
    await tick();
    expect(restartToasts()).toEqual([]);
  });

  it('the record expires: a restore failing long after the notice says nothing about it', async () => {
    inMainRoom();
    atTable('g13');
    const realNow = Date.now;
    socket.fire('serverShutdown', SHUTDOWN);
    expect(getRestartNotice().pending).toBe(LOSS.SEAT);
    try {
      Date.now = () => realNow() + 3 * 60 * 1000;
      socket.reconnect(nextId());
      socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
      socket.fire('rejoinFailed', { reason: 'Game no longer exists' });
      socket.fire('mainRoomJoined', mainRoomPayload());
      await tick();
    } finally {
      Date.now = realNow;
    }
    expect(restartToasts()).toEqual([]);
  });
});
