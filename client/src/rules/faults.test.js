import { describe, it, expect } from 'vitest';
import { handFaults, personalBid } from './faults.js';
import { formatFaultMessages } from '../ui/components/ScoreModal.js';
import { GameState } from '../state/GameState.js';

const playerData = {
  position: [1, 2, 3, 4],
  username: [{ username: 'ann' }, { username: 'bob' }, { username: 'cat' }, { username: 'dan' }],
};
// seats 1/3 = ann/cat, 2/4 = bob/dan
const lines = (opts) => formatFaultMessages({ playerData, handSize: 5, ...opts });

describe('personalBid (server getBidValue)', () => {
  it('a number is itself, every bore is 0, a missing bid 0', () => {
    expect(personalBid('3')).toBe(3);
    expect(personalBid(0)).toBe(0);
    for (const b of ['B', '2B', '3B', '4b']) expect(personalBid(b)).toBe(0);
    expect(personalBid(undefined)).toBe(0);
    expect(personalBid(null)).toBe(0);
  });
});

describe('handFaults / formatFaultMessages (owner 2026-11-19)', () => {
  it('a set team with ONE player short: one line, for that player only', () => {
    // ann/cat bid 2+1 = 3 and took 1+2 = 3: made, though ann was short
    const out = lines({
      myPosition: 1,
      bids: { 1: '2', 2: '1', 3: '1', 4: '0' },
      tricksByPosition: { 1: 1, 2: 1, 3: 2, 4: 1 },
      team1Tricks: 3, team2Tricks: 2,
    });
    // bob/dan bid 1, took 2: made too
    expect(out).toEqual([]);
    // ann bids 3 instead: 4 bid, 3 taken, set; ann short, cat took her 1
    const set = lines({
      myPosition: 1,
      bids: { 1: '3', 2: '1', 3: '1', 4: '0' },
      tricksByPosition: { 1: 1, 2: 1, 3: 2, 4: 1 },
      team1Tricks: 3, team2Tricks: 2,
    });
    expect(set).toEqual(['Fault: ann (bid 3, took 1)']);
  });

  it('a set team with BOTH players short: two lines, me then my partner', () => {
    const out = lines({
      myPosition: 2,
      bids: { 1: '1', 2: '2', 3: '0', 4: '2' },
      tricksByPosition: { 1: 2, 2: 1, 3: 1, 4: 1 },
      team1Tricks: 3, team2Tricks: 2,
    });
    expect(out).toEqual(['Fault: bob (bid 2, took 1)', 'Fault: dan (bid 2, took 1)']);
  });

  it('a made team with a short player: no line (the partner covered it)', () => {
    const out = lines({
      myPosition: 1,
      bids: { 1: '2', 2: '1', 3: '1', 4: '1' },
      // ann took 0 of her 2, cat took 3 of her 1: 3 >= 3, made
      tricksByPosition: { 1: 0, 2: 1, 3: 3, 4: 1 },
      team1Tricks: 3, team2Tricks: 2,
    });
    expect(out).toEqual([]);
  });

  it('a bore counts as 0 for its bidder: only the numeric partner can be at fault', () => {
    // seats 1/3 bid B + 2 on a 5-card hand: the team bid is the hand (5)
    const out = lines({
      myPosition: 3,
      bids: { 1: 'B', 2: '0', 3: '2', 4: '0' },
      tricksByPosition: { 1: 3, 2: 1, 3: 1, 4: 0 },
      team1Tricks: 4, team2Tricks: 1,
    });
    expect(out).toEqual(['Fault: cat (bid 2, took 1)']);
    // the partner made their 2: the set is nobody's fault by this rule
    expect(lines({
      myPosition: 3,
      bids: { 1: '2B', 2: '0', 3: '2', 4: '0' },
      tricksByPosition: { 1: 2, 2: 1, 3: 2, 4: 0 },
      team1Tricks: 4, team2Tricks: 1,
    })).toEqual([]);
  });

  it('both teams set: every short player, in the hand lines\' order (me, partner, opp1, opp2)', () => {
    const out = lines({
      myPosition: 4,
      bids: { 1: '2', 2: '2', 3: '1', 4: '2' },
      tricksByPosition: { 1: 1, 2: 1, 3: 1, 4: 2 },
      team1Tricks: 2, team2Tricks: 3,
    });
    // team 1 bid 3 took 2 (set: ann short); team 2 bid 4 took 3 (set: bob short)
    // me = 4 (dan), partner 2 (bob), opp1 = 1 (ann), opp2 = 3 (cat)
    expect(out).toEqual(['Fault: bob (bid 2, took 1)', 'Fault: ann (bid 2, took 1)']);
  });

  it('a spectator sees them too, in seat order from 1', () => {
    const hand = {
      bids: { 1: '2', 2: '2', 3: '1', 4: '2' },
      tricksByPosition: { 1: 1, 2: 1, 3: 1, 4: 2 },
      team1Tricks: 2, team2Tricks: 3,
    };
    // GameScene passes a spectator's position || 1; a null one reads as 1 too
    expect(lines({ myPosition: null, ...hand })).toEqual(['Fault: ann (bid 2, took 1)', 'Fault: bob (bid 2, took 1)']);
    expect(lines({ myPosition: 1, ...hand })).toEqual(lines({ myPosition: null, ...hand }));
  });

  it('no line when the seats are not known or disagree with the team count (no wrong blame)', () => {
    const bids = { 1: '3', 2: '0', 3: '0', 4: '0' };
    expect(lines({ myPosition: 1, bids, tricksByPosition: { 1: null, 2: 0, 3: null, 4: 0 }, team1Tricks: 1, team2Tricks: 4 })).toEqual([]);
    expect(lines({ myPosition: 1, bids, tricksByPosition: { 1: 0, 2: 4, 3: 0, 4: 0 }, team1Tricks: 1, team2Tricks: 4 })).toEqual([]);
    expect(lines({ myPosition: 1, bids, tricksByPosition: null })).toEqual([]);
    expect(formatFaultMessages()).toEqual([]);
  });

  it('a seat with no name reads P<seat>, never a team number', () => {
    const out = formatFaultMessages({
      myPosition: 1, playerData: null, handSize: 5,
      bids: { 1: '3', 2: '0', 3: '0', 4: '0' }, tricksByPosition: { 1: 1, 2: 4, 3: 0, 4: 0 },
      team1Tricks: 1, team2Tricks: 4,
    });
    expect(out).toEqual(['Fault: P1 (bid 3, took 1)']);
  });

  it('arrays (index = position - 1) work as well as by-position maps', () => {
    expect(handFaults({
      bids: ['3', '0', '0', '0'], tricksByPosition: [1, 4, 0, 0], team1Tricks: 1, team2Tricks: 4, handSize: 5,
    })).toEqual([{ position: 1, bid: 3, took: 1 }]);
  });
});

describe('fault lines from the tricks GameState counted', () => {
  const deal = (extra = {}) => ({
    gameId: 'g1', position: 2, currentHand: 3, dealer: 1, score1: 0, score2: 0,
    trump: { suit: 'hearts', rank: '9' },
    hand: [{ suit: 'spades', rank: 'A' }, { suit: 'clubs', rank: '4' }, { suit: 'hearts', rank: 'K' }],
    ...extra,
  });
  const finish = (state) => formatFaultMessages({
    myPosition: state.position, playerData, bids: { ...state.bids },
    tricksByPosition: { ...state.tricksByPosition }, handSize: state.currentHand,
    team1Tricks: [1, 3].reduce((n, p) => n + state.tricksByPosition[p], 0),
    team2Tricks: [2, 4].reduce((n, p) => n + state.tricksByPosition[p], 0),
  });

  it('each trickComplete winner is counted per seat: the set seat is named', () => {
    const state = new GameState();
    state.applyDeal(deal());
    [[2, '2'], [3, '0'], [4, '1'], [1, '1']].forEach(([position, bid]) => state.applyBid({ position, bid }));
    state.applyDoneBidding({ bids: ['1', '2', '0', '1'], lead: 2 });
    state.applyTrickComplete({ winner: 1 });
    state.applyTrickComplete({ winner: 4 });
    state.applyTrickComplete({ winner: 3, resumeInMs: 1000 });
    // team 2 (bob 2, dan 1 = 3) took 1: set; bob took 0 of 2, dan 1 of 1
    expect(finish(state)).toEqual(['Fault: bob (bid 2, took 0)']);
  });

  it('a redeal hand has none: all-zero bids are never set, and the redealt hand counts from 0', () => {
    const state = new GameState();
    state.applyDeal(deal());
    [[2, '0'], [3, '0'], [4, '0'], [1, '0']].forEach(([position, bid]) => state.applyBid({ position, bid }));
    expect(finish(state)).toEqual([]);
    state.applyDestroyHands();
    state.applyDeal(deal());
    expect(state.tricksByPosition).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0 });
    [[2, '0'], [3, '1'], [4, '0'], [1, '0']].forEach(([position, bid]) => state.applyBid({ position, bid }));
    state.applyDoneBidding({ bids: ['0', '0', '1', '0'], lead: 3 });
    state.applyTrickComplete({ winner: 3 });
    state.applyTrickComplete({ winner: 2 });
    state.applyTrickComplete({ winner: 4, resumeInMs: 1000 });
    expect(finish(state)).toEqual([]);
  });
});
