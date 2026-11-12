/**
 * A page reload while the server restarts (the notice came, then the
 * player reloaded): sessionStorage still has the notice with its
 * timestamp, so the restore that finds the lobby gone says the restart
 * closed it, once.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload } from '../testing/fakePage.js';
import { RESTART_LOSS_TEXT, LOSS, RESTART_NOTICE_KEY } from '../state/restartNotice.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

beforeAll(async () => {
  page = await loadPage({
    session: {
      username: 'me',
      sessionToken: 'tok-me',
      lobbyId: 'L9',
      [RESTART_NOTICE_KEY]: JSON.stringify({ kind: LOSS.LOBBY, at: Date.now() - 20000 }),
    },
    connected: true,
  });
});

describe('reload during a server restart', () => {
  it('the lobby re-entry fails: "your lobby closed" once, in the main room', async () => {
    const { socket } = page;
    const errors = vi.spyOn(console, 'error');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinLobby')).toEqual([{ lobbyId: 'L9' }]);
    socket.fire('error', { message: 'Lobby not found' });
    socket.fire('mainRoomJoined', mainRoomPayload());
    await tick();
    expect(page.session.screen).toBe('mainRoom');
    const texts = [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent);
    expect(texts).toEqual([RESTART_LOSS_TEXT[LOSS.LOBBY]]);
    expect(sessionStorage.getItem(RESTART_NOTICE_KEY)).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
