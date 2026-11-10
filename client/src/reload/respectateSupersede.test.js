/**
 * A spectator whose socket drops twice while the scene is not ready (a hidden
 * tab, a restarting scene): the second re-spectate supersedes the first one
 * still waiting, so the table and its game log are rebuilt once.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, spectatorState, tick } from '../testing/fakePage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', spectatingGameId: 'g2' }, connected: true });
});

const MARK = 'Zach led the 7 of clubs';
// the server's log has its own 'Game started!' (a re-spectate shows it once)
const state = () => ({ ...spectatorState({ gameId: 'g2' }), gameLog: [{ message: 'Game started!' }, { message: MARK }] });

function logLines(text) {
  const feed = document.getElementById('gameFeed');
  if (!feed) return 0;
  return feed.textContent.split(text).length - 1;
}

describe('re-spectate waits for the scene', () => {
  it('a second re-spectate on a new socket supersedes the first one still waiting', async () => {
    const { socket } = page;
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    socket.fire('spectatorJoined', state());
    await vi.waitFor(() => expect(document.getElementById('spectating-indicator')).not.toBeNull());
    expect(logLines(MARK)).toBe(1);
    expect(page.scene.render).toHaveBeenCalledTimes(1);

    // The tab is hidden / the scene is restarting: it has no managers yet
    const managers = page.scene.cardManager;
    page.scene.cardManager = null;

    socket.reconnect('sock-2');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    socket.fire('spectatorJoined', state());
    await tick(150);

    socket.reconnect('sock-3');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinAsSpectator')).toHaveLength(3);
    socket.fire('spectatorJoined', state());
    await tick(150);
    // nothing was torn down or drawn while the scene was not ready
    expect(page.scene.render).toHaveBeenCalledTimes(1);
    expect(page.scene.scene.restart).not.toHaveBeenCalled();

    page.scene.cardManager = managers; // the scene is ready again: one rebuild
    await tick(300);
    expect(page.scene.render).toHaveBeenCalledTimes(2);
    expect(page.scene.render.mock.calls[1][0].viewer.role).toBe('spectator');
    expect(logLines(MARK)).toBe(1);
    expect(logLines('Game started!')).toBe(1);
    expect(document.querySelectorAll('#spectating-indicator')).toHaveLength(1);
    expect(page.session.role).toBe('spectator');
  });
});
