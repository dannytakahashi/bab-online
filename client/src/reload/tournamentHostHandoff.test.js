/**
 * The tournament host leaves while the page shows the lobby: the server
 * passes the role on (tournamentPlayerLeft newCreator). The new host gets
 * Begin / Cancel in place and is told "You are now the tournament host";
 * everyone else hears who it is.
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
const joined = () => ({
  ...tournamentPayload({ creator: 'bob', phase: 'lobby' }),
  players: [{ username: 'bob', ready: false, isCreator: true, connected: true }, ...roster(null)],
});

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
  page.socket.fire('restoreSessionResponse', { success: true, username: 'me', activeTournamentId: 't1', blockedUsers: [] });
});

describe('the tournament host leaves', () => {
  it('to someone else: their name in the toast, no controls here', async () => {
    page.socket.fire('tournamentJoined', joined());
    expect(page.session.screen).toBe('tournamentLobby');
    clearToasts();
    page.socket.fire('tournamentPlayerLeft', { username: 'bob', players: roster('cat'), newCreator: 'cat' });
    await tick();
    expect(toasts()).toEqual(['cat is now the tournament host']);
    expect(document.getElementById('tournamentBeginBtn')).toBeNull();
    expect(document.getElementById('tournamentCancelBtn')).toBeNull();
  });

  it('to me: "You are now the tournament host" and Begin / Cancel that work', async () => {
    page.socket.fire('tournamentJoined', joined());
    clearToasts();
    page.socket.fire('tournamentPlayerLeft', { username: 'bob', players: roster('me'), newCreator: 'me' });
    await tick();
    expect(toasts()).toEqual(['You are now the tournament host']);
    const beginBtn = document.getElementById('tournamentBeginBtn');
    expect(beginBtn.textContent).toBe('Begin Tournament');
    expect(beginBtn.disabled).toBe(true);
    page.socket.fire('tournamentReadyUpdate', { players: roster('me').map((p) => ({ ...p, ready: true })), allReady: true });
    expect(beginBtn.disabled).toBe(false);
    beginBtn.click();
    expect(page.socket.emitted('beginTournament')).toHaveLength(1);
    document.getElementById('tournamentCancelBtn').click();
    expect(page.socket.emitted('cancelTournament')).toHaveLength(1);
  });
});
