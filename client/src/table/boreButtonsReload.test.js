/**
 * A reload in the middle of the owner's bore sequence (events-presence-s21,
 * seat 3 = ios_di): a fresh page restores its session and rejoins at my
 * turn, after bot seat 4's B, my partner's 1 and bot seat 2's 2B. The sheet
 * is built from the snapshot's bids (GameState.applySnapshot tempBids from
 * bids.order) with 3B on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { snapshotAtOwnerTurn, boreStates, OWNER_BORES } from '../testing/ownerBores.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-presence-s21');
  page = await replay.realTablePage({ username: 'ios_di', socketId: 'ios-q3-r2', session: { gameId: rec.gameId } });
});

afterAll(() => vi.useRealTimers());

describe('a reload at my bid turn after the opponents\' B and 2B', () => {
  it('the rejoined table shows the sheet with only 3B on, and a click sends 3B', () => {
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_di', activeGameId: rec.gameId, blockedUsers: [] });
    const rejoin = JSON.parse(JSON.stringify(rec.logs['seat3-rejoin'][0].data));
    rejoin.snapshot = snapshotAtOwnerTurn(rec);
    page.socket.fire('rejoinSuccess', rejoin);
    replay.advance(3000);
    expect(page.session.screen).toBe('table');
    expect(page.gameState.tempBids).toEqual(['B', '1', '2B']);
    expect(boreStates(page.scene)).toEqual(OWNER_BORES);
    page.socket.clearEmits();
    page.scene.bidManager.boreButtons['3B'].click();
    expect(page.socket.emitted('playerBid').map((d) => d.bid)).toEqual(['3B']);
  });
});
