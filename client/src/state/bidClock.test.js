/**
 * The bid clock's state (state/bidClock.js, GameState.applyBidClock and
 * the snapshot's bidClock): a running event sets a deadline on this page's
 * monotonic clock, every clearing event clears it, a snapshot copies it
 * (or clears it when absent), and a malformed one is dropped with a
 * warning while the snapshot still applies.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GameState } from './GameState.js';
import { parseSnapshotV2 } from './snapshotV2.js';
import { tableSnapshotOf } from './tableSync.js';
import {
  setBidClockNow, bidClockNow, parseBidClockEvent, validBidClock, countdownMs, countdownSeconds, clockFrom,
  secondsToBid, sameClock, BID_CLOCK_UI_MARGIN_MS, TUNE_RESYNC_MS,
} from './bidClock.js';

// The repo root (vitest's config root is client/)
const ROOT = existsSync(resolve(process.cwd(), 'contract')) ? process.cwd() : resolve(process.cwd(), '..');
const fixture = JSON.parse(readFileSync(resolve(ROOT, 'contract/fixtures/v2/bid-clock-running.json'), 'utf8'));

let now;
beforeEach(() => {
  now = 5000;
  setBidClockNow(() => now);
});
afterAll(() => setBidClockNow(null));

const G = 'g1';
const run = (position, inMs, durationMs = 30000, gameId = G) => ({ gameId, position, running: true, inMs, durationMs });
const stop = (position, reason = 'bid') => ({ gameId: G, position, running: false, reason });

describe('the helpers', () => {
  it('bidClockNow is the injected clock, else performance.now', () => {
    expect(bidClockNow()).toBe(5000);
    setBidClockNow(null);
    expect(typeof bidClockNow()).toBe('number');
  });

  it('parseBidClockEvent / validBidClock check the wire shape', () => {
    expect(parseBidClockEvent(run(2, 1000))).toEqual({ gameId: G, position: 2, running: true, inMs: 1000, durationMs: 30000 });
    expect(parseBidClockEvent(stop(3, 'timeout'))).toEqual({ gameId: G, position: 3, running: false, reason: 'timeout' });
    for (const bad of [null, 'x', {}, run(0, 1), run(5, 1), run(1, -1), run(1, 1.5), run(1, 1, 0), { ...run(1, 1), running: 'yes' }]) {
      expect(parseBidClockEvent(bad)).toBe(null);
    }
    expect(validBidClock({ position: 1, inMs: 0, durationMs: 1 })).toBe(true);
    expect(validBidClock({ position: 1, inMs: '5', durationMs: 1 })).toBe(false);
    expect(validBidClock([])).toBe(false);
  });

  it('the countdown ends BID_CLOCK_UI_MARGIN_MS before the deadline, in whole seconds (ceil), never below 0', () => {
    expect(BID_CLOCK_UI_MARGIN_MS).toBe(750);
    const c = clockFrom({ position: 1, inMs: 30000, durationMs: 30000 }, 0);
    expect(c).toEqual({ position: 1, deadline: 30000, durationMs: 30000 });
    expect(countdownMs(c, 0)).toBe(29250);
    expect(countdownSeconds(c, 0)).toBe(30);
    expect(countdownSeconds(c, 249)).toBe(30);
    expect(countdownSeconds(c, 250)).toBe(29);
    expect(countdownSeconds(c, 29249)).toBe(1);
    expect(countdownSeconds(c, 29250)).toBe(0);
    expect(countdownSeconds(c, 40000)).toBe(0);
  });
});

describe('GameState.applyBidClock', () => {
  let s;
  beforeEach(() => {
    s = new GameState();
    s.applyDeal({ gameId: G, position: 1, currentHand: 3, hand: [], trump: { suit: 'spades', rank: '5' } });
    s.applyTurn({ currentTurn: 2 });
  });

  it('running sets the seat\'s clock from now; the render model carries a copy', () => {
    const v = s.version;
    expect(s.applyBidClock(run(2, 30000))).toBe(true);
    expect(s.bidClock).toEqual({ position: 2, deadline: 35000, durationMs: 30000 });
    expect(s.version).toBeGreaterThan(v);
    const m = s.renderModel();
    expect(m.bidClock).toEqual(s.bidClock);
    m.bidClock.deadline = 0;
    expect(s.bidClock.deadline).toBe(35000);
    // a later running (a resume) replaces it
    now = 9000;
    s.applyBidClock(run(2, 10000));
    expect(s.bidClock.deadline).toBe(19000);
  });

  it('stopped clears it for that seat only; another game\'s or a malformed event is ignored', () => {
    s.applyBidClock(run(2, 30000));
    expect(s.applyBidClock(stop(3))).toBe(false);
    expect(s.bidClock).toBeTruthy();
    expect(s.applyBidClock(run(2, 1000, 30000, 'other'))).toBe(false);
    expect(s.applyBidClock({ gameId: G, position: 2 })).toBe(false);
    expect(s.bidClock.deadline).toBe(35000);
    expect(s.applyBidClock(stop(2, 'timeout'))).toBe(true);
    expect(s.bidClock).toBe(null);
    expect(s.renderModel().bidClock).toBe(null);
  });

  const clears = {
    'the seat\'s bid': (st) => st.applyBid({ position: 2, bid: '0' }),
    'the turn moving on': (st) => st.applyTurn({ currentTurn: 3 }),
    doneBidding: (st) => st.applyDoneBidding({ bids: ['1', '1', '1', '1'], lead: 1 }),
    'a deal': (st) => st.applyDeal({ gameId: G, position: 1, currentHand: 3, hand: [], trump: null }),
    destroyHands: (st) => st.applyDestroyHands(),
    'the hand reset': (st) => st.resetForNewHand(),
    gameEnd: (st) => st.applyGameEnd({}),
    'my socket dropping': (st) => st.clearBidClock(),
    'the table reset': (st) => st.reset(),
  };
  for (const [what, act] of Object.entries(clears)) {
    it(`is cleared by ${what}`, () => {
      s.applyBidClock(run(2, 30000));
      act(s);
      expect(s.bidClock).toBe(null);
    });
  }

  it('is kept by another seat\'s bid and a repeated updateTurn to the bidder', () => {
    s.applyBidClock(run(2, 30000));
    s.applyBid({ position: 1, bid: '2' });
    s.applyTurn({ currentTurn: 2 });
    expect(s.bidClock).toBeTruthy();
  });
});

describe('the snapshot\'s bidClock', () => {
  it('the fixture\'s clock is copied by the parser and applied relative to receipt', () => {
    const parsed = parseSnapshotV2(fixture.snapshot, { strict: true });
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.snapshot.bidClock).toEqual({ position: 2, inMs: 15000, durationMs: 30000 });
    const s = new GameState();
    s.applySnapshot(parsed.snapshot);
    expect(s.bidClock).toEqual({ position: 2, deadline: 20000, durationMs: 30000 });
  });

  it('absent: no clock (and a snapshot without one clears a clock the page had)', () => {
    const { bidClock: _gone, ...without } = fixture.snapshot;
    const parsed = parseSnapshotV2(without);
    expect(parsed.ok).toBe(true);
    expect('bidClock' in parsed.snapshot).toBe(false);
    const s = new GameState();
    s.bidClock = { position: 2, deadline: 1, durationMs: 30000 };
    s.applySnapshot(parsed.snapshot);
    expect(s.bidClock).toBe(null);
  });

  it('malformed: dropped with a warning, the snapshot still applies', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = { ...fixture.snapshot, bidClock: { position: 9, inMs: 'soon', durationMs: 30000 } };
    const parsed = parseSnapshotV2(raw);
    expect(parsed.ok).toBe(true);
    expect('bidClock' in parsed.snapshot).toBe(false);
    expect(parsed.warnings.some((w) => w.startsWith('$.bidClock'))).toBe(true);
    // through the restore path's parser: logged, and the table is there
    const snap = tableSnapshotOf({ snapshot: raw });
    expect(snap?.stage).toBe('BIDDING');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the countdown\'s words and "the same clock"', () => {
  it('secondsToBid: singular at 1, as iOS BidCountdownModel.announcement', () => {
    expect(secondsToBid(1)).toBe('1 second to bid');
    expect(secondsToBid(0)).toBe('0 seconds to bid');
    expect(secondsToBid(27)).toBe('27 seconds to bid');
  });

  it('sameClock: the same seat with the deadline within TUNE_RESYNC_MS', () => {
    const a = { position: 2, deadline: 10000, durationMs: 30000 };
    expect(sameClock(a, { ...a, deadline: 10000 + TUNE_RESYNC_MS })).toBe(true);
    expect(sameClock(a, { ...a, deadline: 10000 - TUNE_RESYNC_MS })).toBe(true);
    expect(sameClock(a, { ...a, deadline: 10000 + TUNE_RESYNC_MS + 1 })).toBe(false);
    expect(sameClock(a, { ...a, position: 3 })).toBe(false);
    expect(sameClock(null, a)).toBe(false);
    expect(sameClock(a, null)).toBe(false);
  });
});
