/**
 * Deploy survival PR 6 (web, client/src/main.js onRejoinFailed): after a
 * server restart a tournament table may not come back (the round was
 * rolled back, or the table was scored from its saved running score) while
 * the tournament goes on. The failed rejoin must not raise the restart-loss
 * toast ("Your game ended…"): the page goes back to the tournament
 * (returnToTournament) and the tournament route says what ended, if
 * anything did. A casual table's failed rejoin after a restart still
 * explains the loss once.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, tournamentPayload, clientState, tick } from '../testing/fakePage.js';
import { RESTART_LOSS_TEXT } from '../state/restartNotice.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const RESTARTED_TEXTS = new Set(Object.values(RESTART_LOSS_TEXT));
const restartToasts = () => [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent).filter((t) => RESTARTED_TEXTS.has(t));

let page;

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', tournamentId: 't1', gameId: 'g7' }, connected: true });
});

describe('a tournament table that did not survive a restart', () => {
  it('the failed rejoin goes back to the tournament with no restart-loss toast', async () => {
    const { socket } = page;
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g7', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toEqual([{ gameId: 'g7', username: 'me', sessionToken: 'tok-me' }]);
    socket.fire('rejoinSuccess', clientState({ gameId: 'g7', tournamentId: 't1' }));
    await tick();

    socket.fire('serverShutdown', { message: 'Server is restarting, please reconnect shortly' });
    socket.connected = false;
    socket.fire('disconnect', 'transport close');
    socket.clearEmits();
    socket.reconnect('sock-new');
    // The successor rolled the round back: the tournament is there, the table is not
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeTournamentId: 't1', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toHaveLength(1);
    socket.clearEmits();
    socket.fire('rejoinFailed', { reason: 'Game no longer exists' });
    expect(socket.emitted('returnToTournament')).toHaveLength(1);
    expect(socket.emitted('joinMainRoom')).toHaveLength(0);
    socket.fire('tournamentJoined', tournamentPayload({ creator: 'me', phase: 'lobby' }));
    await tick();
    expect(page.session.screen).toBe('tournamentLobby');
    expect(restartToasts()).toEqual([]);
  });
});
