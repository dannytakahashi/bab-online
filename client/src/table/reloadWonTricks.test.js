/**
 * A reload mid-hand after tricks were won, from a server that sends the
 * snapshot's trickHistory (events-bots-s14, seat 1, the real page and
 * scene): the stacks are drawn as before the reload, my team's tricks face
 * up with their own cards, the opponents' face down (as when collected
 * live), and a later render keeps them. Without trickHistory (an older
 * server) they stay face-down placeholders: reloadFaces.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getCardImageKey } from '../utils/cards.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s14');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1-r2' });
});

afterAll(() => vi.useRealTimers());

const C = (rank, suit) => ({ rank, suit });
/** Each stack's cards: 'cardBack' or the face frame. */
const stacks = (history) => history.map((t) => t.cards.map((c) => (/^back-(red|blue)$/.test(c.frame?.name || '') ? 'cardBack' : c.frame?.name)));

// two tricks already won before the reload: seat 1 (my team) took the first
// (seat 2 led), seat 4 the second (seat 1 led); cards in play order
const WON = [
  { winner: 1, lead: 2, cards: [C('3', 'clubs'), C('7', 'clubs'), C('Q', 'clubs'), C('A', 'clubs')] },
  { winner: 4, lead: 1, cards: [C('4', 'diamonds'), C('5', 'diamonds'), C('6', 'diamonds'), C('K', 'diamonds')] },
];

describe('a reload after tricks were won, with the snapshot\'s trickHistory', () => {
  it('my team\'s won trick is face up with its cards, the opponents\' face down; a re-render keeps them', () => {
    const log = rec.logs['seat1-rejoin'];
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    const rejoin = JSON.parse(JSON.stringify(log[0].data));
    rejoin.snapshot.tricks = { team1: 1, team2: 1 };
    rejoin.snapshot.trickHistory = WON;
    page.socket.fire('rejoinSuccess', rejoin);
    replay.advance(100);

    const tm = page.scene.trickManager;
    expect(stacks(tm._teamTrickHistory)).toEqual([WON[0].cards.map(getCardImageKey)]);
    expect(stacks(tm._oppTrickHistory)).toEqual([['cardBack', 'cardBack', 'cardBack', 'cardBack']]);
    // GameState keeps them as the live history (positions from the lead)
    expect(page.gameState.trickHistory[0]).toEqual({
      winner: 1,
      cards: [2, 3, 4, 1].map((position, k) => ({ position, card: WON[0].cards[k] })),
    });

    page.scene.director.fastForward('visible');
    page.scene.render();
    expect(stacks(page.scene.trickManager._teamTrickHistory)).toEqual([WON[0].cards.map(getCardImageKey)]);
    expect(page.scene.trickManager.spriteCounts()).toMatchObject({ teamStacks: 1, oppStacks: 1, stackCards: 8 });
  });

  it('a history that disagrees with the counts is not used (placeholders)', () => {
    const log = rec.logs['seat1-rejoin'];
    const snapshot = JSON.parse(JSON.stringify(log[0].data.snapshot));
    snapshot.tricks = { team1: 2, team2: 1 };
    snapshot.trickHistory = WON;
    page.socket.fire('stateSnapshot', { snapshot, requestId: 'ping-test-1' });
    replay.advance(100);
    const tm = page.scene.trickManager;
    expect(stacks(tm._teamTrickHistory).flat().every((k) => k === 'cardBack')).toBe(true);
    expect(tm._teamTrickHistory).toHaveLength(2);
  });
});
