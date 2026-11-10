/**
 * A tab that watches a tournament, watching one of its tables, reloads:
 * it re-spectates the table, and /leave (or the score modal's Return) goes
 * back to WATCHING the tournament (spectateTournament: the new socket is no
 * spectator the server knows, so returnToTournament would land in the main
 * room). The tournamentSpectate key survives the table.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, spectatorState, tournamentPayload } from '../testing/fakePage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

beforeAll(async () => {
  page = await loadPage({
    session: { username: 'me', sessionToken: 'tok-me', tournamentId: 't1', tournamentSpectate: 't1', spectatingGameId: 'g2' },
    connected: true,
  });
});

const watchedLobby = () => ({ ...tournamentPayload({ creator: 'bob', phase: 'round_active' }), players: [{ username: 'bob', isReady: true, isCreator: true, connected: true }], isSpectator: true });

describe('reload while watching a tournament table', () => {
  it('re-spectates the table; the tournament key stays', async () => {
    const { socket } = page;
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinAsSpectator')).toEqual([{ gameId: 'g2' }]);
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g2' }));
    await vi.waitFor(() => expect(page.session.role).toBe('spectator'));
    expect(sessionStorage.getItem('tournamentSpectate')).toBe('t1');
  });

  it('/leave goes back to watching the tournament, not the main room', () => {
    const { socket } = page;
    socket.clearEmits();
    socket.fire('leftGame');
    expect(socket.emitted('spectateTournament')).toEqual([{ tournamentId: 't1' }]);
    expect(socket.emitted('returnToTournament')).toHaveLength(0);
    expect(socket.emitted('joinMainRoom')).toHaveLength(0);
    expect(page.session.screen).toBe('tournamentLobby');
    socket.fire('tournamentJoined', watchedLobby());
    expect(document.getElementById('tournamentLobbyContainer')).not.toBeNull();
    expect(document.getElementById('tournamentReadyBtn')).toBeNull();
    expect(sessionStorage.getItem('tournamentSpectate')).toBe('t1');
  });

  it('on the same socket the server knows it as the spectator: returnToTournament', () => {
    const { socket } = page;
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g3' }));
    socket.clearEmits();
    socket.fire('gameEnd', { score: { team1: 300, team2: 120 }, playerStats: {}, tournamentId: null });
    document.querySelector('#finalScoreOverlay button')?.click();
    expect(socket.emitted('returnToTournament')).toHaveLength(1);
    expect(socket.emitted('spectateTournament')).toHaveLength(0);
    expect(page.session.screen).toBe('tournamentLobby');
  });
});
