/**
 * A page reload in a tournament lobby the server has no activeTournamentId
 * for (it records one at Begin): the tab's own record of the tournament
 * lobby it showed brings it back while the tournament still exists, and the
 * main room otherwise (the server drops a lobby-phase member on disconnect
 * and deletes an empty tournament).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, tournamentPayload, mainRoomPayload } from '../testing/fakePage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', tournamentId: 't1' }, connected: true });
});

describe('reload in the tournament lobby before it begins', () => {
  it('re-enters the tournament the tab was showing, with the host controls', () => {
    const { socket } = page;
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinTournament')).toEqual([{ tournamentId: 't1' }]);
    expect(socket.emitted('joinMainRoom')).toHaveLength(0);

    socket.fire('tournamentJoined', tournamentPayload({ creator: 'me', phase: 'lobby' }));
    expect(page.session.screen).toBe('tournamentLobby');
    expect(document.getElementById('tournamentBeginBtn')).not.toBeNull();
    expect(document.getElementById('tournamentCancelBtn')).not.toBeNull();
    expect(sessionStorage.getItem('tournamentId')).toBe('t1');
  });

  it('a tournament that is gone lands in the main room', () => {
    const { socket } = page;
    socket.reconnect('sock-2');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinTournament')).toHaveLength(2);
    socket.clearEmits();
    socket.fire('serverError', { code: 'rejected', message: 'Tournament not found', handler: null });
    // the server sends the main room after a failed joinTournament itself
    expect(socket.emitted('joinMainRoom')).toHaveLength(0);
    expect(page.session.screen).toBe('mainRoom');
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(document.getElementById('mainRoomContainer')).not.toBeNull();
    expect(page.session.screen).toBe('mainRoom');
    expect(page.gameState.tournamentId).toBeNull();
    expect(sessionStorage.getItem('tournamentId')).toBeNull();
  });
});
