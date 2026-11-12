/**
 * The server restarts while this tab watches a table of a tournament it
 * watches. After the reconnect the re-spectate finds no game, the page goes
 * back to watching the tournament (spectateTournament), and the server finds
 * no tournament either: it answers with only an error, so the page must ask
 * for the main room itself. Before the fix the failed tournament route was
 * still "in flight" and joinMainRoom was skipped: a blank main room until a
 * reload (review 2026-11-12, tspec-blank).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, spectatorState, mainRoomPayload, tick } from '../testing/fakePage.js';
import { RESTART_LOSS_TEXT, getRestartNotice } from '../state/restartNotice.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const RESTARTED_TEXTS = new Set(Object.values(RESTART_LOSS_TEXT));

let page;
beforeAll(async () => {
  page = await loadPage({
    session: { username: 'me', sessionToken: 'tok-me', tournamentId: 't1', tournamentSpectate: 't1', spectatingGameId: 'g2' },
    connected: true,
  });
});

describe('the server restarts while watching a tournament table', () => {
  it('the table and the tournament are gone: joinMainRoom goes out and the main room is drawn, one message', async () => {
    const { socket } = page;
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g2' }));
    await vi.waitFor(() => expect(page.session.role).toBe('spectator'));

    socket.fire('serverShutdown', { message: 'Server is restarting, please reconnect shortly' });
    socket.connected = false;
    socket.fire('disconnect', 'transport close');
    socket.clearEmits();
    socket.reconnect('sock-new');
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinAsSpectator')).toEqual([{ gameId: 'g2' }]);

    socket.fire('error', { message: 'Game not found' });
    expect(socket.emitted('spectateTournament')).toEqual([{ tournamentId: 't1' }]);
    socket.clearEmits();

    // the new server has no tournament: an error and nothing else
    socket.fire('error', { message: 'Tournament not found' });
    expect(page.session.screen).toBe('mainRoom');
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    socket.fire('mainRoomJoined', mainRoomPayload());
    await tick();
    expect(page.session.screen).toBe('mainRoom');
    expect(document.getElementById('mainRoomContainer')).not.toBeNull();
    const shown = [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent).filter((t) => RESTARTED_TEXTS.has(t));
    expect(shown).toHaveLength(1);
    expect(getRestartNotice().pending).toBeNull();
  });
});
