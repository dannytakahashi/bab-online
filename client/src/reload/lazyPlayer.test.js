/**
 * A page reload in /lazy (one page load: gameId and the saved session in
 * sessionStorage, the socket not connected yet when the page loads).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, clientState } from '../testing/fakePage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', gameId: 'g1' }, connected: false });
  socket = page.socket;
});

function logLines(text) {
  const feed = document.getElementById('gameFeed');
  return [...feed.querySelectorAll('*')].filter((el) => el.children.length === 0 && el.textContent.includes(text)).length;
}

describe('reload while in /lazy', () => {
  it('sends nothing before the socket connects, then restoreSession first and exactly one rejoinGame', () => {
    expect(socket.emittedNames()).toEqual([]);
    socket.connected = true;
    socket.fire('connect');
    expect(socket.emittedNames()).toEqual(['restoreSession']);

    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g1', blockedUsers: [] });
    // a second connect event on the same socket changes nothing
    socket.fire('connect');
    expect(socket.emittedNames()).toEqual(['restoreSession', 'rejoinGame']);
    expect(socket.emitted('rejoinGame')).toEqual([{ gameId: 'g1', username: 'me', sessionToken: 'tok-me' }]);
  });

  it('processes a repeated rejoinSuccess once (the game log is replayed once)', async () => {
    const data = clientState({ gameId: 'g1', isLazy: true, gameLog: [{ message: 'Hand 1 started' }] });
    socket.fire('rejoinSuccess', data);
    socket.fire('rejoinSuccess', clientState({ gameId: 'g1', isLazy: true, gameLog: [{ message: 'Hand 1 started' }] }));

    await vi.waitFor(() => expect(document.getElementById('gameFeed')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 250));
    // the table was rebuilt from one rejoinSuccess only
    expect(page.scene.handleDisplayHand).toHaveBeenCalledTimes(1);
    expect(logLines('Hand 1 started')).toBe(1);
    expect(logLines('Reconnected to game!')).toBe(1);
    expect(page.session.role).toBe('lazy');
    expect(document.querySelectorAll('#spectating-indicator')).toHaveLength(1);
    expect(sessionStorage.getItem('gameId')).toBe('g1');
  });

  it('/active then /leave clears the table and every gameId copy', () => {
    socket.fire('playerActiveMode', { position: 1, username: 'me' });
    expect(page.session.role).toBe('player');
    expect(document.getElementById('spectating-indicator')).toBeNull();
    socket.clearEmits();
    socket.fire('leftGame');
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(sessionStorage.getItem('gameId')).toBeNull();
    expect(page.socketManager.gameId).toBeNull();
  });
});
