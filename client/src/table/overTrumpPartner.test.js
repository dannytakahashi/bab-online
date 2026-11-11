/**
 * Over a PARTNER's trump there is no OT (owner 2026-11-11), on the real
 * page and scene: events-bots-s12, seat 1, the trick 3:6d 4:Qd 1:3s 2:As
 * of overTrumpEffect.test.js with seat 4's Qd changed to the 9 of spades.
 * Seat 4 ruffs with the 9, I under-trump with my 3, seat 2 (seat 4's
 * partner) plays the ace: the ace beats my 3 but takes the trick from its
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
  it('9 of spades by seat 4, my 3, then seat 2\'s ace: no OT; the trick goes to seat 2', () => {
    const i = log.findIndex((e) => e.event === 'cardPlayed' && card(e) === '2:As' && e.data.seq === 209);
    const plays = [];
    for (let k = i; plays.length < 4; k--) if (log[k].event === 'cardPlayed') plays.unshift(k);
    expect(plays.map((k) => card(log[k]))).toEqual(['3:6d', '4:Qd', '1:3s', '2:As']);
    log[plays[1]].data.card = { suit: 'spades', rank: '9' };

    const impacts = vi.spyOn(page.scene.effectsManager, 'showImpactEvent');
    replay.replayLog(page, log, { to: plays[3] + 1 });
    replay.advance(200);
    expect(page.gameState.currentTrick.map((c) => `${c.position}:${c.card.rank}${c.card.suit[0]}`))
      .toEqual(['3:6d', '4:9s', '1:3s', '2:As']);
    expect(impacts.mock.calls.filter((c) => c[0] === 'ot')).toHaveLength(0);

    // the recorded trickComplete (seat 2 wins either way) and the next trick
    replay.replayLog(page, log, { from: plays[3] + 1 });
    replay.advance(500);
    expect(impacts.mock.calls.filter((c) => c[0] === 'ot')).toHaveLength(0);
  });
});
