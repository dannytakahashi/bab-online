/**
 * A reload before the deal at a casual table (drawReload.test.js has the
 * why): allPlayersReady keeps the game's id from the countdown on, so a
 * reconnect or reload in the countdown or the draw rejoins that game instead
 * of re-entering the lobby or the main room.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPage, tick } from '../testing/fakePage.js';
import { REPO_ROOT } from '../testing/files.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

/** The server's rejoinSuccess to an entrant: a contract fixture's pre-seating snapshot. */
function entrantRejoin(name, gameId) {
  const fx = JSON.parse(readFileSync(resolve(REPO_ROOT, `contract/fixtures/v2/${name}.json`), 'utf8'));
  return { gameId, tournamentId: null, snapshot: { ...fx.snapshot, gameId } };
}

let page;

const me = { socketId: 'sock-1', username: 'me', ready: true };
const bots = ['a', 'b', 'c'].map((k) => ({ socketId: `bot:${k}`, username: `🤖 ${k}`, ready: true, isBot: true }));

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', lobbyId: 'L1' }, connected: true });
  page.socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
  page.socket.fire('lobbyCreated', { lobbyId: 'L1', name: 'Table', players: [me, ...bots], messages: [] });
});

describe('the game id from allPlayersReady on', () => {
  it('is kept at allPlayersReady (the countdown)', () => {
    expect(sessionStorage.getItem('gameId')).toBeNull();
    page.socket.fire('allPlayersReady', { gameId: 'g5' });
    expect(sessionStorage.getItem('gameId')).toBe('g5');
  });

  it('a reconnect in the countdown rejoins the game, not the lobby', async () => {
    const { socket } = page;
    socket.reconnect('sock-2');
    socket.clearEmits();
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toEqual([{ gameId: 'g5', username: 'me', sessionToken: 'tok-me' }]);
    expect(socket.emitted('joinLobby')).toEqual([]);
    expect(socket.emitted('joinMainRoom')).toEqual([]);
    socket.fire('rejoinSuccess', entrantRejoin('created-countdown', 'g5'));
    await tick();
    expect(page.session.screen).toBe('table');
    expect(page.session.isSpectator).toBe(false);
  });

  it('the draw keeps it', async () => {
    page.socket.fire('startDraw', { start: true });
    await tick();
    expect(page.session.screen).toBe('table');
    expect(sessionStorage.getItem('gameId')).toBe('g5');
  });

  it('a spectator tab keeps no id', () => {
    page.session.enterTable('spectator', 'g8');
    page.session.noteTableGame('g9');
    expect(sessionStorage.getItem('gameId')).toBeNull();
    expect(sessionStorage.getItem('spectatingGameId')).toBe('g8');
  });
});
