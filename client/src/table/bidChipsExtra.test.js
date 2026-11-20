/**
 * The game log's bid chips row for a family lobby's extra (spectatorJoined
 * at CREATED with viewer.position null, then the room's startDraw, the
 * teams and the deal): the spectator's gameStart has no hand (hand: []),
 * so the row is drawn from its currentHand; it fills with the bids (seats
 * 1/3 blue first, as the spectator's score header, never coral for seats
 * 1/3), clears on an all-zero redeal and comes back with the redeal's deal.
 * The flow of spectatorScoreHeaderExtra.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../testing/files.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let replay;
let page;

const deal = () => ({
  gameId: 'g9',
  trump: { suit: 'clubs', rank: '2' },
  score1: 0,
  score2: 0,
  dealer: 1,
  currentHand: 12,
  hand: [],
  playerInfo: ['ann', 'bob', 'cat', 'dan'].map((username, i) => ({ position: i + 1, username, pic: i + 1 })),
});

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  page = await replay.realTablePage({ username: 'me_extra', socketId: 'sock-x' });
  const { mainRoomPayload } = await import('../testing/fakePage.js');
  page.socket.fire('mainRoomJoined', mainRoomPayload());
});

afterAll(() => vi.useRealTimers());

describe('bid chips row, a family lobby\'s extra', () => {
  it('in from CREATED, through the draw: the first deal shows the row (12 chips, none bid)', () => {
    const fx = JSON.parse(readFileSync(resolve(REPO_ROOT, 'contract/fixtures/v2/created-countdown.json'), 'utf8'));
    const snapshot = { ...fx.snapshot, gameId: 'g9', viewer: { role: 'spectator', position: null, ownerView: null, canAct: false } };
    page.socket.fire('spectatorJoined', { gameId: 'g9', players: [], trump: null, snapshot });
    replay.advance(50);
    expect(page.session.role).toBe('spectator');
    expect(replay.liveChips()).toBe('hidden');
    page.socket.fire('startDraw', { start: true });
    page.socket.fire('positionUpdate', {
      positions: [1, 2, 3, 4],
      sockets: ['s-a', 's-b', 's-c', 's-d'],
      usernames: ['ann', 'bob', 'cat', 'dan'].map((username, i) => ({ username, socketId: `s-${'abcd'[i]}` })),
      pics: [1, 2, 3, 4],
    });
    page.socket.fire('teamsAnnounced', { team1: ['ann', 'cat'], team2: ['bob', 'dan'], resumeInMs: 3000 });
    replay.advance(100);
    page.socket.fire('createUI', {});
    replay.advance(3000);
    page.socket.fire('gameStart', deal());
    replay.advance(5000);
    expect(replay.liveChips()).toBe('............');
  });

  it('the bids fill it by absolute team: seats 1/3 blue first, seats 2/4 coral, a bore the hand (overbid past 12)', () => {
    page.socket.fire('bidReceived', { position: 2, bid: '3' });
    page.socket.fire('bidReceived', { position: 3, bid: '4' });
    replay.advance(100);
    expect(replay.liveChips()).toBe('aaaabbb.....');
    page.socket.fire('bidReceived', { position: 4, bid: 'B' });
    replay.advance(100);
    expect(replay.liveChips()).toBe('aaaabbbbbbbbBBBB');
  });

  it('an all-zero redeal clears the bids; its deal draws the row again', () => {
    page.socket.fire('destroyHands', {});
    replay.advance(100);
    expect(replay.liveChips()).toBe('............');
    page.socket.fire('gameStart', deal());
    replay.advance(5000);
    expect(replay.liveChips()).toBe('............');
    page.socket.fire('bidReceived', { position: 1, bid: '2' });
    replay.advance(100);
    expect(replay.liveChips()).toBe('aa..........');
  });
});
