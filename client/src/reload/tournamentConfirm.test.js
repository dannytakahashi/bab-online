/**
 * The tournament lobby's confirms on the page (main.js, the real entry
 * module with the socket faked; owner 2026-11-26): End Tournament's dialog
 * goes when the server hands the host role on (tournamentPlayerLeft) while
 * it is open, a Leave dialog goes when the host ends the tournament
 * (tournamentCancelled) or the round's table takes the screen (startDraw),
 * and nothing is sent without a confirm.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload, tournamentPayload } from '../testing/fakePage.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;
let socketCount = 1;
const $ = (id) => document.getElementById(id);
const dialog = () => document.querySelector('#tournamentConfirmDialog [role="dialog"]');
const sentDestructive = () => [...socket.emitted('leaveTournament'), ...socket.emitted('cancelTournament')];
const roster = (host) => ['me', 'bo', 'cy'].map((username) => ({ username, ready: false, isCreator: username === host, connected: true }));

beforeAll(async () => {
  page = await loadPage({ connected: false });
  socket = page.socket;
});

beforeEach(async () => {
  socket.fire('forceLogout');
  await tick();
  socket.reconnect(`sock-${++socketCount}`);
  socket.fire('signInResponse', { success: true, username: 'me', sessionToken: 'tok-me', blockedUsers: [] });
  socket.fire('mainRoomJoined', mainRoomPayload());
  socket.clearEmits();
});

describe('the tournament lobby\'s confirms on the page', () => {
  it('End Tournament open when the role passes to someone else: closed, nothing sent, the toast says who hosts', async () => {
    socket.fire('tournamentJoined', { ...tournamentPayload({ creator: 'me', phase: 'between_rounds' }), currentRound: 1, players: roster('me') });
    expect(page.session.screen).toBe('tournamentLobby');
    $('tournamentCancelBtn').click();
    expect(dialog()?.textContent).toContain('End tournament?');
    socket.fire('tournamentPlayerLeft', { username: 'me', players: roster('bo'), newCreator: 'bo', reason: 'hostIdle' });
    await tick();
    expect(dialog()).toBeNull();
    expect($('tournamentCancelBtn')).toBeNull();
    expect(sentDestructive()).toEqual([]);
  });

  it('End Tournament confirmed sends cancelTournament once', async () => {
    socket.fire('tournamentJoined', { ...tournamentPayload({ creator: 'me' }), players: roster('me') });
    $('tournamentCancelBtn').click();
    expect(socket.emitted('cancelTournament')).toEqual([]);
    $('tournamentConfirmOk').click();
    expect(socket.emitted('cancelTournament')).toHaveLength(1);
    expect(socket.emitted('leaveTournament')).toEqual([]);
  });

  it('Leave open when the host ends the tournament: the dialog goes with the lobby, nothing sent', async () => {
    socket.fire('tournamentJoined', { ...tournamentPayload({ creator: 'bo' }), players: roster('bo') });
    $('tournamentLeaveBtn').click();
    expect(dialog()?.textContent).toContain('Leave tournament?');
    const ok = $('tournamentConfirmOk');
    socket.fire('tournamentCancelled', { tournamentId: 't1' });
    await tick();
    expect(page.session.screen).toBe('mainRoom');
    expect(dialog()).toBeNull();
    ok.click();
    expect(sentDestructive()).toEqual([]);
  });

  it('Leave open when the round\'s table takes the screen: closed, nothing sent', async () => {
    socket.fire('tournamentJoined', { ...tournamentPayload({ creator: 'bo', phase: 'round_active' }), currentRound: 1, players: roster('bo') });
    $('tournamentLeaveBtn').click();
    expect(dialog()).not.toBeNull();
    socket.fire('startDraw', { gameId: 'g1', tournamentId: 't1' });
    await tick();
    expect($('tournamentLobbyContainer')).toBeNull();
    expect(dialog()).toBeNull();
    expect(sentDestructive()).toEqual([]);
  });

  it('a spectator\'s Stop Watching confirmed sends leaveTournament', async () => {
    socket.fire('tournamentJoined', { ...tournamentPayload({ creator: 'bo', phase: 'round_active' }), currentRound: 1, players: roster('bo'), isSpectator: true });
    expect($('tournamentLeaveBtn').textContent).toBe('Stop Watching');
    $('tournamentLeaveBtn').click();
    expect(socket.emitted('leaveTournament')).toEqual([]);
    $('tournamentConfirmOk').click();
    expect(socket.emitted('leaveTournament')).toHaveLength(1);
  });
});
