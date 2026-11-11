/**
 * A reload in the middle of a bore hand (events-bots-s14 seat1-rejoin's
 * snapshot, made a bore: seat 1 bid B with its partner's 2 on the 4-card
 * hand, my team has 2 tricks): GameScene.render sets the trick piles from
 * the snapshot, the bore counting as the whole hand (the old total, the bore
 * as 0, read 2 and "safe"), and the seat rings show the bore target and
 * each seat's own count from tricksByPosition.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1-r1' });
});

afterAll(() => vi.useRealTimers());

function boreRejoin() {
  const rejoin = JSON.parse(JSON.stringify(rec.logs['seat1-rejoin'][0].data));
  const s = rejoin.snapshot;
  expect([s.stage, s.deal.handSize, s.viewer.position]).toEqual(['PLAYING', 4, 1]);
  s.bids.byPosition = ['B', '0', '2', '0'];
  s.bids.teamBids = { team1: 4, team2: 0 };
  s.bids.mults = { team1: 2, team2: 1 };
  // two tricks in, both my team's: one each
  s.tricks = { team1: 2, team2: 0 };
  s.tricksByPosition = [1, 0, 1, 0];
  s.trick = { number: 3, leadPosition: null, cards: [] };
  s.hand = s.hand.slice(0, 2);
  s.seats.forEach((seat) => { seat.cardsInHand = 2; });
  s.turn = { position: 1, action: 'play' };
  delete s.trickHistory;
  return rejoin;
}

describe('a reload mid bore hand', () => {
  it('the pile counts the bore as the whole hand ("danger" at 2 of 4); the rings show the bore target and own counts', () => {
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    page.socket.fire('rejoinSuccess', boreRejoin());
    replay.advance(100);
    const tm = page.scene.trickManager;
    expect([tm._teamBidTotal, tm._oppBidTotal]).toEqual([4, 0]);
    expect(tm.pileBorders()).toEqual({ team: 'danger', opp: 'safe' });
    const pips = replay.livePips();
    expect(pips[1]).toEqual([4, 2, 0]);
    expect(pips[3]).toEqual([2, 1, 0]);
    expect(document.querySelector('.hud-avatar-ring[data-position="1"] .hud-pips').title).toBe('Team 2 of 4 (bore)');
    // a later render draws the same
    page.scene.render();
    expect([page.scene.trickManager._teamBidTotal, page.scene.trickManager._oppBidTotal]).toEqual([4, 0]);
    expect(replay.livePips()).toEqual(pips);
  });
});
