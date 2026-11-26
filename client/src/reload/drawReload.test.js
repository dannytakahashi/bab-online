/**
 * A reload before the deal at a casual table (live check 2026-11-26): the
 * server writes activeGameId only at seating for a lobby game, so the restore
 * names no game, and the tab used to land in the main room with only
 * Spectate for its own table. allPlayersReady now keeps the game's id
 * (ClientSession.noteTableGame, sessionStorage gameId), so the reloaded page
 * sends rejoinGame for it, and the server takes the entrant over
 * (seatLifecycle.reconnectEntrant): rejoinSuccess with the pre-seating
 * snapshot (viewer.role 'entrant'). This file: the page reloaded mid-draw
 * (drawReloadKeep.test.js: the id kept from allPlayersReady on).
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

beforeAll(async () => {
  page = await loadPage({ session: { username: 'me', sessionToken: 'tok-me', gameId: 'g6' }, connected: true });
});

describe('the page reloaded during the draw at a casual table', () => {
  it('rejoins the game it was drawing for, not the main room', () => {
    page.socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(page.socket.emitted('rejoinGame')).toEqual([{ gameId: 'g6', username: 'me', sessionToken: 'tok-me' }]);
    expect(page.socket.emitted('joinMainRoom')).toEqual([]);
  });

  it('the entrant snapshot puts it back at the draw as a player', async () => {
    page.socket.fire('rejoinSuccess', entrantRejoin('draw-in-progress', 'g6'));
    await tick();
    expect(page.session.screen).toBe('table');
    expect(page.session.isSpectator).toBe(false);
    expect(sessionStorage.getItem('gameId')).toBe('g6');
  });
});
