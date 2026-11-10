/**
 * A page reload of a tournament player whose game ended while the tab was
 * gone (gameEnd never arrived, so gameId is still saved): the server knows
 * the tournament, not the game. The stale rejoin fails, and the player goes
 * back to the tournament lobby (returnToTournament reattaches by username),
 * not the main room.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, tournamentPayload, tableLeftovers, CLEAN } from '../testing/fakePage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', gameId: 'g7' }, connected: true });
});

describe('reload after a tournament game ended offline', () => {
  it('a failed rejoin of the saved game returns to the tournament', () => {
    const { socket } = page;
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeTournamentId: 't1', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toEqual([{ gameId: 'g7', username: 'me', sessionToken: 'tok-me' }]);
    socket.clearEmits();

    socket.fire('rejoinFailed', { reason: 'Game no longer exists' });
    expect(socket.emitted('returnToTournament')).toHaveLength(1);
    expect(socket.emitted('joinMainRoom')).toHaveLength(0);
    expect(page.session.screen).toBe('tournamentLobby');

    socket.fire('tournamentJoined', tournamentPayload({ creator: 'me', phase: 'between_rounds' }));
    expect(document.getElementById('tournamentLobbyContainer')).not.toBeNull();
    expect(document.getElementById('tournamentReadyBtn')).not.toBeNull();
    expect(page.gameState.tournamentId).toBe('t1');
    expect(tableLeftovers(page)).toEqual(CLEAN);
  });
});
