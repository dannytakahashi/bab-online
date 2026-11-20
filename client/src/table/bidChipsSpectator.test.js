/**
 * The game log's bid chips row (#gameFeed .log-tricks) for a pure spectator
 * who comes in before the first deal (events-humans-s13: spectatorJoined at
 * DRAWING, then every deal live; two all-zero redeals, a bore, a seat's
 * /lazy and /active): the row comes with each deal and follows the bids and
 * the tricks to the game end without a refresh (owner 2026-11-19: "when
 * spectating I don't see it unless I refresh"). A spectator's gameStart has
 * no hand (hand: []): the row used to be drawn from data.hand.length, so it
 * came up empty and stayed empty. Colours: seats 1/3 team A (blue) first,
 * as the spectator's score header; expectedChips works it out from the
 * server's own bids at each checkpoint.
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
  rec = replay.loadRecording('events-humans-s13');
  page = await replay.realTablePage({ username: 'ios_fan', socketId: 'ios-spec' });
});

afterAll(() => vi.useRealTimers());

describe('bid chips row, spectator from the draw', () => {
  it('matches the server at every live checkpoint, every deal, redeals included', () => {
    const log = rec.logs.spectator;
    expect(log[0].event).toBe('spectatorJoined');
    expect(log[0].data.snapshot.stage).toBe('DRAWING');
    const firstDeal = log.find((e) => e.event === 'gameStart');
    expect(firstDeal.data.hand).toEqual([]);
    const { results, bad } = replay.replayChips(page, rec, 'spectator');
    expect(page.session.role).toBe('spectator');
    expect(bad.slice(0, 3)).toEqual([]);
    expect(results.length).toBeGreaterThan(150);
    // the first deal shows the row (no refresh)
    const first = results.find((r) => r.handNo === 1);
    expect(first.live).not.toBe('hidden');
    expect(first.live.length).toBeGreaterThan(0);
    // every hand of the game had the row, both teams' colours, an overbid
    const hands = new Set(results.filter((r) => r.live !== 'hidden').map((r) => r.handNo));
    expect(hands.size).toBeGreaterThanOrEqual(12);
    expect(results.some((r) => /a/.test(r.live) && /b/.test(r.live))).toBe(true);
    expect(results.some((r) => r.stage === 'HAND_RESOLVING' && r.live === 'hidden')).toBe(true);
    expect(page.session.screen).toBe('gameEnd');
  });
});
