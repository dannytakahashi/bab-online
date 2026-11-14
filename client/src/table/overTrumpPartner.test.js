/**
 * Over a PARTNER's trump there is no OT (owner 2026-11-11), on the real
 * page and scene: events-bots-s12, seat 1, the recorded trick 3:Ks 4:Ad
 * 1:7d 2:4c of overTrumpEffect.test.js (hand 1, trump diamonds) with seat
 * 4's ace changed to the 10 of diamonds and seat 2's club to the ace.
 * Seat 4 ruffs with the 10, I under-trump with my 7, seat 2 (seat 4's
 * partner) plays the ace: the ace beats my 7 but takes the trick from its
 * own partner. The pre-2026-11-11 detector (the ace vs the card just
 * before it) showed an OT here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let log;

const card = (e) => `${e.data.position}:${e.data.card.rank}${e.data.card.suit[0]}`;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  const rec = replay.loadRecording('events-bots-s12');
  log = JSON.parse(JSON.stringify(rec.logs.seat1));
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
});

afterAll(() => vi.useRealTimers());

describe('an ace over the partner\'s ruff shows no OT', () => {
  it('10 of diamonds by seat 4, my 7, then seat 2\'s ace: no OT', () => {
    const i = log.findIndex((e) => e.event === 'cardPlayed' && card(e) === '2:4c' && e.data.seq === 108);
    const plays = [];
    for (let k = i; plays.length < 4; k--) if (log[k].event === 'cardPlayed') plays.unshift(k);
    expect(plays.map((k) => card(log[k]))).toEqual(['3:Ks', '4:Ad', '1:7d', '2:4c']);
    log[plays[1]].data.card = { suit: 'diamonds', rank: '10' };
    log[plays[3]].data.card = { suit: 'diamonds', rank: 'A' };

    const impacts = vi.spyOn(page.scene.effectsManager, 'showImpactEvent');
    replay.replayLog(page, log, { to: plays[3] + 1 });
    replay.advance(200);
    expect(page.gameState.currentTrick.map((c) => `${c.position}:${c.card.rank}${c.card.suit[0]}`))
      .toEqual(['3:Ks', '4:10d', '1:7d', '2:Ad']);
    expect(impacts.mock.calls.filter((c) => c[0] === 'ot')).toHaveLength(0);

    // the recorded trickComplete (the opponents win either way) and the next trick
    replay.replayLog(page, log, { from: plays[3] + 1 });
    replay.advance(500);
    expect(impacts.mock.calls.filter((c) => c[0] === 'ot')).toHaveLength(0);
  });
});
