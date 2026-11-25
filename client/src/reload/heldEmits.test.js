/**
 * Emits made while the socket is down (later #10). Socket.IO buffers them
 * and flushes them on connect BEFORE the page's restoreSession, so the
 * server got a chat line from an anonymous socket and dropped it ("Not in
 * main room"). The emit gate (SocketManager._send) now holds anything that
 * needs the session until the restore is answered, then sends it in order
 * after the restore's own route; offline it refuses (the chat draft stays,
 * with a notice); my bids and plays are refused while not restored
 * (MyAction asks the same gate), never held.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload } from '../testing/fakePage.js';
import { SCREEN, CONNECTION } from '../state/ClientSession.js';
import { getMyAction } from '../state/MyAction.js';
import { HOLD_MAX_MS } from '../socket/SocketManager.js';
import { clearToasts } from '../ui/kit/toast.js';
import { createAdminApi } from '../admin/adminApi.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;
let n = 1;

const chatInput = () => document.getElementById('mainRoomChatInput');
const sendChat = (text) => {
  chatInput().value = text;
  chatInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
};
const toasts = () => [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent).join(' | ');

function goDown() {
  socket.connected = false;
  socket.fire('disconnect', 'transport close');
}

function comeBack() {
  socket.id = `sock-${++n}`;
  socket.connected = true;
  socket.fire('connect');
}

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
  socket = page.socket;
  socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
  socket.fire('mainRoomJoined', mainRoomPayload());
  await tick();
  expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
});

describe('the emit gate', () => {
  it('restored and connected: a chat line goes out at once and the input clears', () => {
    socket.clearEmits();
    sendChat('hello');
    expect(socket.emitted('mainRoomChat')).toEqual([{ message: 'hello' }]);
    expect(chatInput().value).toBe('');
  });

  it('down: a chat line and a button are held, not buffered for the anonymous socket', () => {
    goDown();
    socket.clearEmits();
    sendChat('while down');
    document.querySelector('#mainRoomContainer .room-create button').click(); // + Create Game
    document.getElementById('createGameClassic').click(); // ...the base game (the dialog's first choice)
    expect(socket.emitted('mainRoomChat')).toEqual([]);
    expect(socket.emitted('createLobby')).toEqual([]);
    expect(page.socketManager.heldEvents).toEqual(['mainRoomChat', 'createLobby']);
    // held means it will be sent: the draft is done with
    expect(chatInput().value).toBe('');
  });

  it('back: restoreSession first, nothing else until it is answered', () => {
    comeBack();
    expect(socket.emittedNames()).toEqual(['restoreSession']);
    // a line typed between the connect and the restore's answer waits too
    sendChat('in between');
    expect(socket.emittedNames()).toEqual(['restoreSession']);
  });

  it('the answer: the restore\'s route (joinMainRoom), then the held emits in order', () => {
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emittedNames()).toEqual(['restoreSession', 'joinMainRoom', 'mainRoomChat', 'createLobby', 'mainRoomChat']);
    expect(socket.emitted('mainRoomChat')).toEqual([{ message: 'while down' }, { message: 'in between' }]);
    expect(page.socketManager.heldEvents).toEqual([]);
  });

  it('auth, the hello and pings never wait', () => {
    goDown();
    socket.clearEmits();
    socket.emit('requestSnapshot', { requestId: 'p1' });
    socket.emit('clientHello', {});
    expect(socket.emits.map(([e]) => e)).toEqual(['requestSnapshot', 'clientHello']);
    expect(page.socketManager.heldEvents).toEqual([]);
  });

  it('my bid or play while not restored is refused (not held), with a notice', () => {
    const action = getMyAction();
    expect(action.submitBid('3', 1)).toBe(false);
    expect(action.submitPlay({ suit: 'spades', rank: 'A' }, 1)).toBe(false);
    expect(action.isPending()).toBe(false);
    expect(socket.emitted('playerBid')).toEqual([]);
    expect(page.socketManager.heldEvents).toEqual([]);
    expect(toasts()).toMatch(/Reconnecting\. Try again in a moment\./);
  });

  it('an admin request while not restored is refused at once (an anonymous socket got "forbidden", which closed the panel)', async () => {
    socket.clearEmits();
    expect(socket.emit('adminRequest', { requestId: 'r1', action: 'listPlayers', args: {} })).toBe(false);
    await expect(createAdminApi(socket).request('listPlayers')).rejects.toThrow('offline');
    expect(socket.emitted('adminRequest')).toEqual([]);
    expect(page.socketManager.heldEvents).toEqual([]);
  });

  it('offline (the server closed the socket: no reconnect by itself): a chat line is refused, the draft stays, a notice says so', async () => {
    socket.fire('disconnect', 'io server disconnect');
    expect(page.session.connection).toBe(CONNECTION.OFFLINE);
    socket.clearEmits();
    clearToasts();
    sendChat('keep me');
    expect(socket.emitted('mainRoomChat')).toEqual([]);
    expect(page.socketManager.heldEvents).toEqual([]);
    expect(chatInput().value).toBe('keep me');
    await tick();
    expect(toasts()).toMatch(/Your message wasn't sent/);
  });

  it('held too long: dropped at the flush with a notice, the rest still goes out', async () => {
    comeBack(); // connected again (restoreSession out)
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now - HOLD_MAX_MS - 1);
    sendChat('stale');
    spy.mockReturnValue(now);
    sendChat('fresh');
    spy.mockRestore();
    socket.clearEmits();
    clearToasts();
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('mainRoomChat')).toEqual([{ message: 'fresh' }]);
    await tick();
    expect(toasts()).toMatch(/A message from while you were reconnecting wasn't sent/);
  });

  it('a failed restore (signed out) drops what was held: nothing goes out under the next sign-in', () => {
    goDown();
    comeBack();
    socket.clearEmits();
    document.querySelector('#mainRoomContainer .room-create button')?.click();
    document.getElementById('createGameClassic')?.click(); // the dialog's first choice: the base game
    expect(page.socketManager.heldEvents).toEqual(['createLobby']);
    socket.fire('restoreSessionResponse', { success: false, message: 'Invalid session token' });
    expect(page.session.screen).toBe(SCREEN.SIGN_IN);
    expect(page.socketManager.heldEvents).toEqual([]);
    expect(socket.emitted('createLobby')).toEqual([]);
    // signed out: nothing is held any more (no session), a sign-in goes out
    socket.emit('signIn', { username: 'me', password: 'x' });
    expect(socket.emitted('signIn')).toHaveLength(1);
  });
});
