/**
 * A page reload of a tab that only watches a tournament lobby
 * (spectateTournament): it watches again, never joins as an entrant, and
 * gets no player controls; a tournament that is gone lands in the main room.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, tournamentPayload, mainRoomPayload } from '../testing/fakePage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

const spectatorView = (extra) => ({ ...tournamentPayload({ creator: 'bob', ...extra }), players: [{ username: 'bob', isReady: false, isCreator: true, connected: true }] });

beforeAll(async () => {
  page = await loadPage({
    session: { username: 'me', sessionToken: 'tok-me', tournamentId: 't1', tournamentSpectate: 't1' },
    connected: true,
  });
});

describe('reload while watching a tournament lobby', () => {
  it('re-spectates instead of joining, and shows no Ready button', () => {
    const { socket } = page;
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('spectateTournament')).toEqual([{ tournamentId: 't1' }]);
    expect(socket.emitted('joinTournament')).toHaveLength(0);
    expect(socket.emitted('joinMainRoom')).toHaveLength(0);

    socket.fire('tournamentJoined', { ...spectatorView(), isSpectator: true });
    expect(page.session.screen).toBe('tournamentLobby');
    expect(document.getElementById('tournamentLobbyContainer')).not.toBeNull();
    expect(document.getElementById('tournamentReadyBtn')).toBeNull();
    expect(sessionStorage.getItem('tournamentSpectate')).toBe('t1');
  });

  it('a reconnect there re-spectates too', () => {
    const { socket } = page;
    socket.clearEmits();
    socket.reconnect('sock-2');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('spectateTournament')).toEqual([{ tournamentId: 't1' }]);
    expect(socket.emitted('joinTournament')).toHaveLength(0);
  });

  it('a watched tournament that is gone lands in the main room (one joinMainRoom)', () => {
    const { socket } = page;
    socket.clearEmits();
    socket.fire('error', { message: 'Tournament not found' });
    // a failed spectateTournament gets no main room from the server
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(page.session.screen).toBe('mainRoom');
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(document.getElementById('mainRoomContainer')).not.toBeNull();
    expect(sessionStorage.getItem('tournamentId')).toBeNull();
    expect(sessionStorage.getItem('tournamentSpectate')).toBeNull();
    expect(page.gameState.tournamentId).toBeNull();
  });
});
