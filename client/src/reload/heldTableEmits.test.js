/**
 * Table emits held over a reconnect (review 2026-11-15 of later #10): the
 * server's rejoinGame awaits an auth check before it seats the new socket,
 * so a table chat line sent in the same tick as the rejoin ran first and
 * was dropped as "not in a game" (3 of 12 on a live server). After a
 * restore that rejoins, the emit gate stays shut until the rejoin is
 * answered: rejoinSuccess sends what was held, in order; a failed rejoin
 * drops the table events with a notice; 'Already connected' sends them.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, clientState, tick } from '../testing/fakePage.js';
import { SCREEN } from '../state/ClientSession.js';
import { clearToasts } from '../ui/kit/toast.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;
let n = 1;

const toasts = () => [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent).join(' | ');
const restored = () => socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g1', blockedUsers: [] });

function downAndBack() {
  socket.reconnect(`sock-${++n}`);
}

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', gameId: 'g1' }, connected: true });
  socket = page.socket;
  restored();
  socket.fire('rejoinSuccess', clientState({ gameId: 'g1' }));
  await vi.waitFor(() => expect(page.session.screen).toBe(SCREEN.TABLE));
});

describe('table emits wait for the rejoin answer', () => {
  it('held while down, and still held after the restore until rejoinSuccess; then sent in order', () => {
    socket.connected = false;
    socket.fire('disconnect', 'transport close');
    socket.clearEmits();
    socket.emit('chatMessage', { message: 'while down' });
    socket.id = `sock-${++n}`;
    socket.connected = true;
    socket.fire('connect');
    restored();
    expect(socket.emittedNames()).toEqual(['restoreSession', 'rejoinGame']);
    // typed after the restore, before the seat is back: waits too
    socket.emit('chatMessage', { message: 'in between' });
    socket.emit('draw', {});
    expect(page.socketManager.heldEvents).toEqual(['chatMessage', 'chatMessage', 'draw']);
    // my play is refused (MyAction asks the same gate)
    expect(page.socketManager.canSend('playCard')).toBe(false);

    socket.fire('rejoinSuccess', clientState({ gameId: 'g1' }));
    expect(socket.emittedNames()).toEqual(['restoreSession', 'rejoinGame', 'chatMessage', 'chatMessage', 'draw']);
    expect(socket.emitted('chatMessage')).toEqual([{ message: 'while down' }, { message: 'in between' }]);
    expect(page.socketManager.heldEvents).toEqual([]);
    expect(page.socketManager.canSend('playCard')).toBe(true);
    // the gate is open again: a line goes straight out
    socket.emit('chatMessage', { message: 'after' });
    expect(socket.emitted('chatMessage')).toHaveLength(3);
  });

  it("'Already connected': this socket holds the seat, what was held goes", () => {
    downAndBack();
    restored();
    socket.clearEmits();
    socket.emit('chatMessage', { message: 'still here' });
    expect(socket.emitted('chatMessage')).toEqual([]);
    socket.fire('rejoinFailed', { reason: 'Already connected' });
    expect(socket.emitted('chatMessage')).toEqual([{ message: 'still here' }]);
    expect(page.session.screen).toBe(SCREEN.TABLE);
  });

  it('a new socket before the answer: the old wait ends with it, the next restore waits again', () => {
    downAndBack();
    restored();
    socket.clearEmits();
    socket.emit('chatMessage', { message: 'across two sockets' });
    downAndBack();
    expect(socket.emitted('chatMessage')).toEqual([]);
    restored();
    expect(socket.emitted('chatMessage')).toEqual([]);
    socket.fire('rejoinSuccess', clientState({ gameId: 'g1' }));
    expect(socket.emitted('chatMessage')).toEqual([{ message: 'across two sockets' }]);
  });

  it('the game is gone (rejoinFailed): the table events are dropped with a notice, the room is joined', async () => {
    await tick(50);
    downAndBack();
    restored();
    socket.clearEmits();
    clearToasts();
    socket.emit('chatMessage', { message: 'lost' });
    socket.emit('getLeaderboard', {});
    socket.fire('rejoinFailed', { reason: 'Game no longer exists' });
    expect(socket.emitted('chatMessage')).toEqual([]);
    expect(socket.emittedNames()).toContain('getLeaderboard');
    expect(socket.emittedNames()).toContain('joinMainRoom');
    expect(page.socketManager.heldEvents).toEqual([]);
    expect(page.session.screen).not.toBe(SCREEN.TABLE);
    await tick();
    expect(toasts()).toMatch(/A message from while you were reconnecting wasn't sent/);
  });
});
