/**
 * Deferred table rebuilds while the scene is not ready yet (a hidden tab,
 * a restarting scene): a later rejoin on a new socket supersedes an earlier
 * one still waiting (the game log is replayed once), and a gameEnd that
 * lands first stops it (nothing is rebuilt over the score modal).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, clientState, tick } from '../testing/fakePage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', gameId: 'g1' }, connected: true });
  socket = page.socket;
});

function logLines(text) {
  const feed = document.getElementById('gameFeed');
  if (!feed) return 0;
  return [...feed.querySelectorAll('*')].filter((el) => el.children.length === 0 && el.textContent.includes(text)).length;
}

describe('rejoin waits for the scene', () => {
  it('a second rejoinSuccess on a new socket supersedes the first one still waiting', async () => {
    const managers = page.scene.cardManager;
    page.scene.cardManager = null; // the scene has not created yet
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g1', blockedUsers: [] });
    socket.fire('rejoinSuccess', clientState({ gameId: 'g1', isLazy: true }));
    await tick(150);

    socket.reconnect('sock-2');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g1', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toHaveLength(2);
    socket.fire('rejoinSuccess', clientState({ gameId: 'g1', isLazy: true }));
    await tick(150);

    page.scene.cardManager = managers; // the tab is visible again
    await vi.waitFor(() => expect(document.getElementById('gameFeed')).not.toBeNull());
    await tick(250);
    expect(page.scene.handleDisplayHand).toHaveBeenCalledTimes(1);
    expect(logLines('Reconnected to game!')).toBe(1);
    expect(logLines('Hand 1 started')).toBe(1);
    expect(document.querySelectorAll('#spectating-indicator')).toHaveLength(1);
  });

  it('a gameEnd before the scene is ready stops the rebuild (no pill over the score modal)', async () => {
    const managers = page.scene.cardManager;
    page.scene.handleDisplayHand.mockClear();
    page.scene.cardManager = null;
    socket.reconnect('sock-3');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g1', blockedUsers: [] });
    socket.fire('rejoinSuccess', clientState({ gameId: 'g1', isLazy: true }));
    await tick(150);

    socket.fire('gameEnd', { score: { team1: 300, team2: 120 }, playerStats: {}, tournamentId: null });
    expect(page.session.screen).toBe('gameEnd');
    expect(document.getElementById('spectating-indicator')).toBeNull();

    page.scene.cardManager = managers;
    await tick(300);
    expect(page.scene.handleDisplayHand).not.toHaveBeenCalled();
    expect(document.getElementById('spectating-indicator')).toBeNull();
  });
});
