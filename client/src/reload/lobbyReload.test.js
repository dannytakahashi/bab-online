/**
 * A page reload in a game lobby (live check 2026-11-11: the lobby's only
 * human reloaded and the server deleted the lobby with its bots). The
 * server now holds the seat for 30 s (GameManager.LOBBY_SEAT_GRACE_MS) and
 * the tab keeps the lobby id in sessionStorage, so the restore re-enters
 * the same lobby; a lobby that is gone lands in the main room. Seats the
 * server holds for someone else show "Reconnecting…".
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, mainRoomPayload } from '../testing/fakePage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

const bots = [
  { socketId: 'bot:a', username: '🤖 Bot 1', ready: false, isBot: true },
  { socketId: 'bot:b', username: '🤖 Bot 2', ready: false, isBot: true },
  { socketId: 'bot:c', username: '🤖 Bot 3', ready: false, isBot: true },
];
const me = { socketId: 'sock-1', username: 'me', ready: false };
const statusOf = (name) => {
  const row = [...document.querySelectorAll('#lobbyPlayersList .seat-row')]
    .find((r) => r.querySelector('.seat-row__name')?.textContent === name);
  return row?.querySelector('.seat-row__status');
};

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', lobbyId: 'L1' }, connected: true });
});

describe('reload in a game lobby', () => {
  it('re-enters the lobby the tab was showing (same lobby, its bots), not the main room', () => {
    const { socket } = page;
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinLobby')).toEqual([{ lobbyId: 'L1' }]);
    expect(socket.emitted('joinMainRoom')).toHaveLength(0);

    socket.fire('lobbyCreated', { lobbyId: 'L1', name: 'My table', players: [me, ...bots], messages: [] });
    expect(page.session.screen).toBe('lobby');
    expect(document.querySelectorAll('#lobbyPlayersList .seat-row:not(.seat-row--empty)')).toHaveLength(4);
    expect(sessionStorage.getItem('lobbyId')).toBe('L1');
  });

  it('a lobby that closed meanwhile (grace over): the main room, and the id is forgotten', () => {
    const { socket } = page;
    socket.reconnect('sock-2');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinLobby')).toHaveLength(2);
    socket.clearEmits();
    socket.fire('serverError', { code: 'rejected', message: 'Lobby not found', handler: null });
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(page.session.screen).toBe('mainRoom');
    expect(sessionStorage.getItem('lobbyId')).toBeNull();
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(document.getElementById('mainRoomContainer')).not.toBeNull();
  });

  it('seats held for another player show "Reconnecting…" until they return or leave', () => {
    const { socket } = page;
    const bob = { socketId: 'sock-bob', username: 'bob', ready: false };
    socket.fire('lobbyCreated', { lobbyId: 'L2', name: 'Pair', players: [me, bob], messages: [], reconnecting: ['bob'] });
    expect(sessionStorage.getItem('lobbyId')).toBe('L2');
    expect(statusOf('bob').textContent).toBe('Reconnecting…');
    expect(statusOf('bob').classList.contains('is-reconnecting')).toBe(true);
    expect(statusOf('me').textContent).toBe('Waiting...');

    // A ready update while held still names the seat; one without the list: nobody held
    socket.fire('playerReadyUpdate', { lobbyId: 'L2', players: [{ ...me, ready: true }, bob], reconnecting: ['bob'] });
    expect(statusOf('bob').textContent).toBe('Reconnecting…');
    expect(statusOf('me').textContent).toBe('✓ Ready');

    // bob's new socket takes the seat back
    socket.fire('lobbyPlayerJoined', { lobbyId: 'L2', players: [me, { ...bob, socketId: 'sock-bob2' }], newPlayer: { socketId: 'sock-bob2', username: 'bob', ready: false } });
    expect(statusOf('bob').textContent).toBe('Waiting...');

    socket.fire('playerReadyUpdate', { lobbyId: 'L2', players: [me, bob], reconnecting: ['bob'] });
    expect(statusOf('bob').textContent).toBe('Reconnecting…');
    socket.fire('playerReadyUpdate', { lobbyId: 'L2', players: [me, bob] });
    expect(statusOf('bob').textContent).toBe('Waiting...');

    // The grace ran out: bob left
    socket.fire('playerReadyUpdate', { lobbyId: 'L2', players: [me, bob], reconnecting: ['bob'] });
    socket.fire('lobbyPlayerLeft', { lobbyId: 'L2', players: [me], leftUsername: 'bob', needsMorePlayers: true });
    expect(statusOf('bob')).toBeUndefined();
  });

  it('leaving the lobby (or its game starting) forgets the id, so a reload lands where the tab is', () => {
    const { socket } = page;
    expect(sessionStorage.getItem('lobbyId')).toBe('L2');
    socket.fire('allPlayersReady', { gameId: 'g1' });
    socket.fire('startDraw', { start: true });
    expect(page.session.screen).toBe('table');
    expect(sessionStorage.getItem('lobbyId')).toBeNull();
  });
});
