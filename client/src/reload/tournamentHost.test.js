/**
 * A page reload of a tournament host (one page load: the tab's saved
 * session in sessionStorage, the socket already connected at load).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { loadPage, tournamentPayload } from '../testing/fakePage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me' }, connected: true });
});

describe('reload as a tournament host', () => {
  it('restores the session first (once), then rejoins the tournament', () => {
    expect(page.socket.emittedNames()).toEqual(['restoreSession']);
    page.socket.fire('restoreSessionResponse', { success: true, username: 'me', activeTournamentId: 't1', blockedUsers: [] });
    expect(page.socket.emitted('joinTournament')).toEqual([{ tournamentId: 't1' }]);
  });

  it('keeps the Begin and Cancel buttons', () => {
    page.socket.fire('tournamentJoined', tournamentPayload({ creator: 'me', phase: 'lobby' }));
    expect(page.session.screen).toBe('tournamentLobby');
    expect(document.getElementById('tournamentBeginBtn')).not.toBeNull();
    expect(document.getElementById('tournamentCancelBtn')).not.toBeNull();
  });

  it('between rounds too', () => {
    page.socket.fire('tournamentJoined', tournamentPayload({ creator: 'me', phase: 'between_rounds' }));
    expect(document.getElementById('tournamentBeginBtn').textContent).toBe('Begin Next Round');
    expect(document.getElementById('tournamentCancelBtn')).not.toBeNull();
  });
});
