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

  it('idle (2026-11-15, reason hostIdle): the role leaves me while I am here, the controls go', async () => {
    page.socket.fire('tournamentJoined', { ...tournamentPayload({ creator: 'me', phase: 'between_rounds' }), players: roster('me') });
    expect(document.getElementById('tournamentCancelBtn')).not.toBeNull();
    clearToasts();
    page.socket.fire('tournamentPlayerLeft', { username: 'me', players: roster('cat'), newCreator: 'cat', reason: 'hostIdle' });
    await tick();
    expect(toasts()).toEqual(['cat is now the tournament host']);
    expect(document.getElementById('tournamentBeginBtn')).toBeNull();
    expect(document.getElementById('tournamentCancelBtn')).toBeNull();
  });

  it('between rounds the ready deadline (readyDeadlinePassed) lets the ready host start', async () => {
    page.socket.fire('tournamentJoined', { ...tournamentPayload({ creator: 'me', phase: 'between_rounds' }), players: roster('me') });
    const ready = roster('me').map((p) => ({ ...p, ready: p.username === 'me' }));
    page.socket.fire('tournamentReadyUpdate', { players: ready, allReady: false, readyDeadlinePassed: false });
    const beginBtn = document.getElementById('tournamentBeginBtn');
    expect(beginBtn.disabled).toBe(true);
    page.socket.fire('tournamentReadyUpdate', { players: ready, allReady: false, readyDeadlinePassed: true });
    expect(beginBtn.disabled).toBe(false);
    expect(beginBtn.textContent).toBe('Start with ready players');
    beginBtn.click();
    expect(page.socket.emitted('beginNextRound')).toHaveLength(1);
  });
});
