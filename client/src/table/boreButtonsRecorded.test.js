/**
 * The owner's bore sequence in a recorded real-handler game
 * (events-presence-s21, seat 3 = ios_di after a reconnect, the real page
 * and scene): bot seat 4 bids B, seat 1 (my partner) bids 1, bot seat 2
 * bids 2B, then my turn. The 3B button must be on. Then the same table
 * from a resync (a ping's snapshot: GameScene.render) and from a rejoin on
 * the live page (rejoinSuccess with the snapshot); a fresh page's reload
 * is boreButtonsReload.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ownerTurnIndex, snapshotAtOwnerTurn, boreStates, OWNER_BORES } from '../testing/ownerBores.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let log;
let turnAt;

const clone = (x) => JSON.parse(JSON.stringify(x));

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-presence-s21');
  log = rec.logs['seat3-rejoin'];
  page = await replay.realTablePage({ username: 'ios_di', socketId: 'ios-q3-r1', session: { gameId: rec.gameId } });
  turnAt = ownerTurnIndex(rec);
});

afterAll(() => vi.useRealTimers());

describe('recorded: B by bot 4, 1 by my partner, 2B by bot 2, my turn', () => {
  it('the recording has the owner\'s order', () => {
    expect(turnAt).toBeGreaterThan(0);
    const bids = log.slice(turnAt - 6, turnAt).filter((e) => e.event === 'bidReceived').map((e) => `${e.data.position}:${e.data.bid}`);
    expect(bids).toEqual(['4:B', '1:1', '2:2B']);
  });

  it('live: 3B is on at my turn', () => {
    replay.replayLog(page, log, { to: turnAt + 1 });
    // the bots bid within 1.9 s of the deal: my turn opens before the trump
    // has flipped (the previous hand's whisk, then the deal), and the sheet
    // is built at the flip, from the bids already on the table
    expect(boreStates(page.scene)).toBeNull();
    replay.advance(600);
    expect(page.gameState.position).toBe(3);
    expect(page.gameState.tempBids).toEqual(['B', '1', '2B']);
    expect(boreStates(page.scene)).toEqual(OWNER_BORES);
  });

  it('a resync (ping reply) re-renders the sheet with 3B on', () => {
    page.socket.fire('stateSnapshot', { snapshot: snapshotAtOwnerTurn(rec), requestId: 'ping-1' });
    replay.advance(300);
    expect(page.gameState.tempBids).toEqual(['B', '1', '2B']);
    expect(boreStates(page.scene)).toEqual(OWNER_BORES);
  });

  it('a rejoin on the live page (rejoinSuccess with the snapshot) keeps 3B on', () => {
    const rejoin = clone(log[0].data);
    rejoin.snapshot = snapshotAtOwnerTurn(rec);
    page.socket.fire('rejoinSuccess', rejoin);
    replay.advance(3000);
    expect(page.gameState.tempBids).toEqual(['B', '1', '2B']);
    expect(boreStates(page.scene)).toEqual(OWNER_BORES);
  });

  it('the scripted player\'s recorded bid (1) then closes the sheet', () => {
    replay.replayLog(page, log, { from: turnAt + 1, to: turnAt + 4 });
    replay.advance(300);
    expect(boreStates(page.scene)).toBeNull();
  });
});
