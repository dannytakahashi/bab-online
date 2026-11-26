/**
 * The host of a finished tournament (live check 2026-11-25, before Cut for a
 * buck: Cancel Tournament still showed behind the results). The complete
 * phase is the final results in the lobby itself: never Ready, Begin or
 * Cancel, whichever way the host gets there: back from the last table's
 * results (returnToTournament), from the main room, a reload, the end
 * arriving while the lobby is up, or the host role passing to them after the
 * end (no "You are now the tournament host" then: there is nothing to host).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, tick, tournamentPayload } from '../testing/fakePage.js';
import { clearToasts } from '../ui/kit/index.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

const toasts = () => [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent);
const roster = (host) => ['me', 'cat'].map((username) => ({ username, ready: false, isCreator: username === host, connected: true }));
const board = [
  { username: 'me', totalScore: 240, roundScores: [120, 120] },
  { username: 'cat', totalScore: 180, roundScores: [90, 90] },
];
const finished = (host = 'me') => ({
  ...tournamentPayload({ creator: host, phase: 'complete' }),
  players: roster(host),
  scoreboard: board,
  currentRound: 2,
  totalRounds: 2,
  winners: ['me'],
  cutForABuck: null,
});
const controls = () => ['tournamentReadyBtn', 'tournamentBeginBtn', 'tournamentCancelBtn'].filter((id) => document.getElementById(id));

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
  page.socket.fire('restoreSessionResponse', { success: true, username: 'me', activeTournamentId: 't1', blockedUsers: [] });
});

describe('the host of a finished tournament', () => {
  it('back into it (Return to Tournament, the main room, a reload): the final results, no Cancel', async () => {
    page.socket.fire('tournamentJoined', finished());
    await tick();
    expect(page.session.screen).toBe('tournamentLobby');
    expect(document.getElementById('tournamentLobbyContainer').dataset.isCreator).toBe('true');
    expect(document.getElementById('tournamentReturnBtn').textContent).toBe('Return to Main Room');
    expect(controls()).toEqual([]);
    expect(document.querySelector('.rounds-picker')).toBeNull();
  });

  it('the end arriving while the host is on the lobby takes the controls away', async () => {
    page.socket.fire('tournamentJoined', { ...tournamentPayload({ creator: 'me', phase: 'between_rounds' }), players: roster('me'), scoreboard: board, currentRound: 1, totalRounds: 2 });
    await tick();
    expect(document.getElementById('tournamentCancelBtn')).not.toBeNull();
    page.socket.fire('tournamentComplete', { scoreboard: board, winners: ['me'] });
    await tick();
    expect(document.getElementById('tournamentLobbyContainer').dataset.phase).toBe('complete');
    expect(controls()).toEqual([]);
  });

  it('the role passing to me after the end adds no controls and no host toast', async () => {
    page.socket.fire('tournamentJoined', finished('cat'));
    await tick();
    clearToasts();
    page.socket.fire('tournamentPlayerLeft', { username: 'cat', players: [{ username: 'me', ready: false, isCreator: true, connected: true }], newCreator: 'me' });
    await tick();
    expect(controls()).toEqual([]);
    expect(toasts()).toEqual([]);
  });
});
