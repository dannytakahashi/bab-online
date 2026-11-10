/**
 * A page reload while spectating (one page load: spectatingGameId and the
 * saved session in sessionStorage, the socket connected at load).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, spectatorState } from '../testing/fakePage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', spectatingGameId: 'g2' }, connected: true });
});

describe('reload while spectating', () => {
  it('restores the session, then re-spectates (never rejoinGame)', async () => {
    const { socket } = page;
    expect(socket.emittedNames()).toEqual(['restoreSession']);
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinAsSpectator')).toEqual([{ gameId: 'g2' }]);
    expect(socket.emitted('rejoinGame')).toHaveLength(0);
    expect(socket.emitted('joinMainRoom')).toHaveLength(0);

    socket.fire('spectatorJoined', spectatorState({ gameId: 'g2' }));
    expect(page.session.screen).toBe('table');
    expect(page.session.role).toBe('spectator');
    await vi.waitFor(() => expect(document.getElementById('spectating-indicator')).not.toBeNull());
  });
});
