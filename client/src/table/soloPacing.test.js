/**
 * Solo pacing on the web table (server/game/pacing.js SOLO, owner
 * 2026-11-11): a recorded 1-human game (events-bots-s12, seat 1) carries
 * the solo timings (trick view 1.0 s, bot lead 0.5-0.7 s after the collect,
 * next hand 0.5 s after the last trick). Replayed at the recording's own
 * clock through the real page and GameScene (testing/fakePhaser.js), no
 * bot lead arrives while a trick is still being collected, no card while
 * the hand is still being dealt, no deal during a collect, and the table
 * never has to fast-forward to catch up.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let log;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s12');
  log = rec.logs.seat1;
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
});

afterAll(() => vi.useRealTimers());

describe('a solo game at the recorded clock', () => {
  it('is recorded with the solo timings', () => {
    const fourth = log.filter((e) => e.event === 'cardPlayed' && e.data.resumeInMs !== undefined).map((e) => e.data.resumeInMs);
    const lastTrick = log.filter((e) => e.event === 'trickComplete' && e.data.resumeInMs !== undefined).map((e) => e.data.resumeInMs);
    expect(fourth.length).toBeGreaterThan(20);
    expect(new Set(fourth)).toEqual(new Set([1000]));
    expect([...new Set(lastTrick)]).toEqual([500]); // next hand (seat 1's log stops before the game end)
  });

  it('no bot lead lands on a trick still being collected, no card on a hand being dealt; nothing fast-forwards', () => {
    const scene = () => page.scene;
    const seen = { cards: 0, botLeads: 0, deals: 0, onCollect: [], whileDealing: [], dealWhileCollecting: [] };
    let trickCards = 0;
    const ff0 = page.scene.director.stats.fastForwards;
    replay.replayLog(page, log, {
      before: (e) => {
        if (e.dir !== 's2c') return;
        const s = scene();
        if (e.event === 'cardPlayed') {
          seen.cards++;
          // A bot's lead (the first card after trickComplete) is the server's
          // pacing; the scripted human leads at once, which a web player
          // cannot (the hand stays dimmed until the collect lands)
          const botLead = trickCards === 0 && String(e.data.playerId).startsWith('bot:');
          if (botLead) seen.botLeads++;
          if (botLead && s.trickManager.isCollecting()) seen.onCollect.push(e.i);
          if (s.cardManager._isDealing) seen.whileDealing.push(e.i);
          trickCards = (trickCards + 1) % 4;
        }
        if (e.event === 'gameStart' && e.data.hand) {
          seen.deals++;
          if (s.trickManager.isCollecting()) seen.dealWhileCollecting.push(e.i);
        }
      },
    });
    replay.advance(2000);
    expect(seen.cards).toBe(145); // five hands: seat 1 then leaves (the fixture's rejoin part)
    expect(seen.deals).toBe(5);
    expect(seen.botLeads).toBeGreaterThan(15);
    expect(seen.onCollect).toEqual([]);
    expect(seen.whileDealing).toEqual([]);
    expect(seen.dealWhileCollecting).toEqual([]);
    expect(page.scene.director.stats.fastForwards).toBe(ff0);
  });
});
