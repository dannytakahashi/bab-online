/**
 * Get Your Bid on the web (owner 2026-11-24; server/game/gameMode.js): a
 * three-seat table with no teams. GameState keeps the mode, each seat's
 * score and the deal's Forbidden Bid; state/gyb.js projects the words and
 * rows the table shows; the rules helpers take the seat count. The base
 * game's paths are unchanged (their own tests).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GameState, teamPlayerDataOf } from './GameState.js';
import {
  soloOrder, soloHeaderRows, formatSoloHandMessages, formatSoloGameEndMessages,
  soloOutcome, soloWinnerLine, soloResultRows, soloTally,
} from './gyb.js';
import { rotate, seatsAround, slotOf, seatLetter } from '../utils/positions.js';
import { gybForbidden, bidTotalsFor } from '../rules/bids.js';
import { isLegalMove } from '../rules/legality.js';
import { isOverTrump } from '../rules/overTrump.js';

const c = (rank, suit) => ({ rank, suit });
const PD = { position: [1, 2, 3], username: [{ username: 'ann' }, { username: 'bob' }, { username: 'cat' }], pics: [1, 2, 3] };

/** A dealt Get Your Bid table seen from `me`. */
function table(me = 3, { dealer = 1, handSize = 12 } = {}) {
  const s = new GameState();
  s.username = PD.username[me - 1].username;
  s.setMode('gyb');
  s.applyPositionUpdate({ positions: [1, 2, 3], usernames: PD.username, pics: PD.pics, isBot: [false, false, false] });
  s.applyDeal({
    gameId: 'g1', position: me, dealer, currentHand: handSize, trump: c('7', 'spades'),
    hand: Array.from({ length: handSize }, (_, i) => c(String(2 + (i % 9)), 'hearts')),
    score1: 0, score2: 0, hsiValues: {}, gyb: { scores: [0, 0, 0] },
  });
  return s;
}

describe('three seats', () => {
  it('turns go 1, 2, 3, 1; the base game is unchanged', () => {
    expect([1, 2, 3].map((p) => rotate(p, 3))).toEqual([2, 3, 1]);
    expect([1, 2, 3, 4].map((p) => rotate(p))).toEqual([2, 3, 4, 1]);
  });

  it('the others round a seat: the next in turn on the left, the one after on the right, no partner', () => {
    expect(seatsAround(1, 3)).toEqual({ partner: null, opp1: 2, opp2: 3 });
    expect(seatsAround(3, 3)).toEqual({ partner: null, opp1: 1, opp2: 2 });
    expect(seatsAround(1)).toEqual({ partner: 3, opp1: 2, opp2: 4 });
    expect([1, 2, 3].map((p) => slotOf(p, 2, 3))).toEqual(['opp2', 'self', 'opp1']);
    expect(slotOf(4, 2, 3)).toBeNull();
    expect([1, 2, 3, 4].map((p) => slotOf(p, 2))).toEqual(['opp2', 'self', 'opp1', 'partner']);
  });

  it('each seat has its own colour; the base game keeps its two teams', () => {
    expect([1, 2, 3].map((p) => seatLetter(p, 3))).toEqual(['a', 'b', 'c']);
    expect([1, 2, 3, 4].map((p) => seatLetter(p))).toEqual(['a', 'b', 'a', 'b']);
  });
});

describe('the rules the page mirrors', () => {
  it("the Forbidden Bid: the owner's example, the last bidder only, hands of 5 or more", () => {
    // seat 3 deals and bids last on the 12
    expect(gybForbidden({ 1: '5', 2: '4' }, 3, 12)).toEqual({ position: 3, bid: 3 });
    expect(gybForbidden(['5', '4'], 3, 12)).toEqual({ position: 3, bid: 3 });
    expect(gybForbidden({ 1: '5' }, 3, 12)).toBeNull();
    expect(gybForbidden({ 1: '5', 2: '4', 3: '2' }, 3, 12)).toEqual({ position: 3, bid: 3 });
    // seat 1 deals: its own bid is not counted
    expect(gybForbidden({ 2: '6', 3: '6' }, 1, 12)).toEqual({ position: 1, bid: 0 });
    for (const size of [1, 2, 3, 4]) expect(gybForbidden({ 1: '1', 2: '0' }, 3, size)).toBeNull();
    expect(gybForbidden({ 1: '1', 2: '0' }, 3, 5)).toEqual({ position: 3, bid: 4 });
    // the bids already exceed the hand: nothing is forbidden
    expect(gybForbidden({ 1: '4', 2: '3' }, 3, 6)).toBeNull();
  });

  it('a HI joker lead makes both other seats play their highest trump (no partner)', () => {
    const trump = c('5', 'hearts');
    const hand = [c('3', 'hearts'), c('Q', 'hearts'), c('2', 'clubs')];
    const lead = c('HI', 'joker');
    for (const me of [2, 3]) {
      expect(isLegalMove(c('3', 'hearts'), hand, lead, false, trump, true, me, 1, true).legal).toBe(false);
      expect(isLegalMove(c('Q', 'hearts'), hand, lead, false, trump, true, me, 1, true).legal).toBe(true);
    }
    // the base game: seat 3 is seat 1's partner
    expect(isLegalMove(c('3', 'hearts'), hand, lead, false, trump, true, 3, 1).legal).toBe(true);
  });

  it('an over-trump counts against any other seat', () => {
    const trump = c('5', 'hearts');
    // seats 1 and 3 would be partners in the base game
    const overThree = [{ position: 2, card: c('9', 'spades') }, { position: 1, card: c('6', 'hearts') }, { position: 3, card: c('K', 'hearts') }];
    expect(isOverTrump(overThree, trump)).toBe(false);
    expect(isOverTrump(overThree, trump, { solo: true })).toBe(true);
    // a lower trump over a trump is no over-trump at any table
    const under = [{ position: 2, card: c('9', 'spades') }, { position: 1, card: c('K', 'hearts') }, { position: 3, card: c('6', 'hearts') }];
    expect(isOverTrump(under, trump, { solo: true })).toBe(false);
  });

  it('bid totals: my own bid, and each of the other two (the next in turn first)', () => {
    expect(bidTotalsFor({ 1: '5', 2: '4', 3: '2' }, 3, 12, 3)).toEqual({ team: 2, opp: 9, opp1: 5, opp2: 4 });
    expect(bidTotalsFor(['5', '4', '2'], 1, 12, 3)).toEqual({ team: 5, opp: 6, opp1: 4, opp2: 2 });
  });
});

describe('GameState at a Get Your Bid table', () => {
  let s;
  beforeEach(() => { s = table(3, { dealer: 3 }); });

  it('is three seats with no partner, the others by name', () => {
    expect(s.mode).toBe('gyb');
    expect(s.seatCount).toBe(3);
    expect(s.isSolo).toBe(true);
    expect(s.getPartnerPosition()).toBeNull();
    expect(s.isTeammate(1)).toBe(false);
    expect([s.partnerName, s.opp1Name, s.opp2Name]).toEqual([null, 'ann', 'bob']);
    expect(s.hsiValues).toEqual({});
  });

  it('a new GameState, and a reset one, is the base game', () => {
    expect(new GameState().seatCount).toBe(4);
    s.reset();
    expect([s.mode, s.gyb, s.seatCount]).toEqual([null, null, 4]);
  });

  it('the Forbidden Bid appears once the other two have bid', () => {
    expect(s.gybForbidden()).toBeNull();
    s.applyBid({ position: 1, bid: '5' });
    expect(s.gybForbidden()).toBeNull();
    s.applyBid({ position: 2, bid: '4' });
    expect(s.gybForbidden()).toEqual({ position: 3, bid: 3 });
    expect(s.renderModel().gyb.forbidden).toEqual({ position: 3, bid: 3 });
    expect([s.teamBids, s.oppBids]).toEqual(['-', '5/4']);
  });

  it('a trick is three cards, and "mine" is my own seat only', () => {
    s.applyDoneBidding({ bids: ['5', '4', '2'], lead: 1 });
    for (const [position, card] of [[1, c('9', 'clubs')], [2, c('K', 'clubs')]]) s.applyCardPlayed({ position, card, trumpBroken: false });
    expect(s.stage).toBe('PLAYING');
    s.applyCardPlayed({ position: 3, card: s.myCards[0], trumpBroken: false });
    expect(s.stage).toBe('TRICK_RESOLVING');
    s.applyTrickComplete({ winner: 1 });
    // seat 1 is seat 3's "team" by parity in the base game: not here
    expect([s.teamTricks, s.oppTricks]).toEqual([0, 1]);
    expect(s.tricksByPosition).toMatchObject({ 1: 1, 2: 0, 3: 0 });
    expect(s.trickHistory[0].cards.map((x) => x.position)).toEqual([1, 2, 3]);
    for (const [position, card] of [[1, c('2', 'clubs')], [2, c('3', 'clubs')], [3, s.myCards[0]]]) s.applyCardPlayed({ position, card });
    s.applyTrickComplete({ winner: 3 });
    expect([s.teamTricks, s.oppTricks]).toEqual([1, 1]);
  });

  it('handComplete.gyb and gameEnd.gyb carry the scores', () => {
    const hand = {
      scores: [15, 0, 12], oldScores: [0, 0, 0], forbidden: { position: 3, bid: 3 },
      seats: [
        { position: 1, bid: 5, took: 5, points: 15, forbiddenHit: false },
        { position: 2, bid: 4, took: 5, points: 0, forbiddenHit: false },
        { position: 3, bid: 2, took: 2, points: 12, forbiddenHit: false },
      ],
    };
    s.applyHandComplete({ score: { team1: 0, team2: 0 }, team1Tricks: 7, team2Tricks: 5, team1OldScore: 0, team2OldScore: 0, gyb: hand });
    expect(s.gyb.scores).toEqual([15, 0, 12]);
    expect(s.gyb.made).toEqual([1, 0, 1]);
    expect(s.gyb.hands).toBe(1);
    // teamScore is my seat's, oppScore the best of the others
    expect([s.teamScore, s.oppScore]).toEqual([12, 15]);
    s.applyGameEnd({ score: { team1: 0, team2: 0 }, gyb: { scores: [120, 90, 120], winners: [1, 3], made: [9, 6, 9], hands: 13 } });
    expect(s.gyb.end.winners).toEqual([1, 3]);
    expect(s.gyb.scores).toEqual([120, 90, 120]);
  });

  it('a snapshot with gyb beside it restores the mode, scores and three-card tricks', () => {
    const fresh = new GameState();
    fresh.username = 'cat';
    const seat = (p, name) => ({ position: p, username: name, pic: p, hasCustomPic: false, customPic: null, ownerUsername: name, controller: 'human', presence: 'connected', isBot: false, lazy: false, offered: false, graceDeadline: null, resignableAt: null, cardsInHand: 10 });
    const snap = {
      v: 2, gameId: 'g9', seq: 40, serverTime: 1, stage: 'PLAYING', partial: [],
      viewer: { role: 'seat', position: 3, ownerView: 'seat', canAct: false },
      hand: [c('2', 'hearts')],
      deal: { handNo: 1, handSize: 12, dealer: 3, bidder: 1, dealSeq: 1 },
      trump: c('7', 'spades'), trumpBroken: false, turn: { position: 1, action: 'play' },
      bids: { byPosition: ['5', '4', '2', null], order: [1, 2, 3, 4], teamBids: { team1: 11, team2: 0 }, mults: { team1: 1, team2: 1 } },
      trick: { number: 3, leadPosition: null, cards: [] },
      tricks: { team1: 1, team2: 1 }, tricksByPosition: [0, 1, 1, 0], trickHistory: [],
      score: { team1: 0, team2: 0 }, rainbows: { team1: 0, team2: 0 }, hsi: null,
      seats: [seat(1, 'ann'), seat(2, 'bob'), seat(3, 'cat')], entrants: null, draw: null,
      spectatorCount: 0, watching: { spectators: [], count: 0 }, tournament: null, log: [], resume: null,
    };
    const gyb = {
      scores: [26, 16, 12], made: [2, 1, 1], hands: 2, forbidden: { position: 3, bid: 3 },
      trickHistory: [
        { winner: 2, lead: 1, cards: [c('9', 'clubs'), c('K', 'clubs'), c('2', 'clubs')] },
        { winner: 3, lead: 2, cards: [c('9', 'diamonds'), c('K', 'diamonds'), c('2', 'diamonds')] },
      ],
    };
    fresh.applySnapshot(snap, { gyb });
    expect(fresh.mode).toBe('gyb');
    expect(fresh.gyb.scores).toEqual([26, 16, 12]);
    expect(fresh.gybForbidden()).toEqual({ position: 3, bid: 3 });
    expect(fresh.trickHistory.map((t) => t.cards.map((x) => x.position))).toEqual([[1, 2, 3], [2, 3, 1]]);
    expect([fresh.teamTricks, fresh.oppTricks]).toEqual([1, 1]);
    expect([fresh.teamScore, fresh.oppScore]).toEqual([12, 26]);
    expect([fresh.opp1Name, fresh.opp2Name]).toEqual(['ann', 'bob']);
    // the same game's later snapshot without the key keeps the mode; another game's is the base game
    fresh.applySnapshot(snap);
    expect(fresh.mode).toBe('gyb');
    fresh.applySnapshot({ ...snap, gameId: 'other', seats: [], bids: { ...snap.bids, byPosition: [null, null, null, null] } });
    expect(fresh.mode).toBeNull();
  });
});

describe('what the table says', () => {
  it('the header rows: mine first, then the next in turn', () => {
    const s = table(3, { dealer: 3 });
    s.applyBid({ position: 1, bid: '5' });
    s.gyb.scores = [26, 16, 12];
    const rows = soloHeaderRows(s);
    expect(rows.map((r) => [r.position, r.name, r.score, r.bid, r.letter, r.mine])).toEqual([
      [3, 'cat', 12, '-', 'c', true],
      [1, 'ann', 26, '5', 'a', false],
      [2, 'bob', 16, '-', 'b', false],
    ]);
    // a spectator views from seat 1 and owns no row
    expect(soloHeaderRows(s, { spectator: true }).map((r) => [r.position, r.mine])).toEqual([[1, false], [2, false], [3, false]]);
    expect(soloOrder(2)).toEqual([2, 3, 1]);
  });

  it("the hand's lines are the server's words, seats 1 to 3", () => {
    expect(formatSoloHandMessages({
      scores: [15, 1, 12],
      seats: [
        { position: 3, bid: 2, took: 2, points: 12, forbiddenHit: false },
        { position: 1, bid: 5, took: 5, points: 15, forbiddenHit: false },
        { position: 2, bid: 4, took: 5, points: 1, forbiddenHit: true },
      ],
    }, PD)).toEqual([
      '--- HAND COMPLETE ---',
      'ann: Bid 5, Won 5, +15 → 15',
      'bob: Bid 4, Won 5 (Forbidden Bid), +1 → 1',
      'cat: Bid 2, Won 2, +12 → 12',
    ]);
  });

  it('the result: a win, a loss, a shared win, a spectator', () => {
    const win = { scores: [90, 120, 80], winners: [2], made: [5, 9, 4], hands: 13 };
    const tie = { scores: [120, 120, 80], winners: [1, 2], made: [9, 9, 4], hands: 13 };
    expect([soloOutcome(win, 2), soloOutcome(win, 1), soloOutcome(tie, 1), soloOutcome(tie, 3), soloOutcome(win, null)])
      .toEqual(['victory', 'defeat', 'tie', 'defeat', 'neutral']);
    expect(soloWinnerLine(win, PD)).toBe('bob wins!');
    expect(soloWinnerLine(tie, PD)).toBe('ann and bob tie!');
    expect(formatSoloGameEndMessages(win, PD, { myPosition: 2 })).toEqual(['=== GAME OVER ===', 'ann: 90', 'bob: 120', 'cat: 80', 'VICTORY']);
    expect(formatSoloGameEndMessages(win, PD, { myPosition: 1 })).toEqual(['=== GAME OVER ===', 'ann: 90', 'bob: 120', 'cat: 80', 'DEFEAT', 'bob wins!']);
    expect(formatSoloGameEndMessages(tie, PD, { myPosition: 1 }).slice(-2)).toEqual(['TIE GAME', 'ann and bob tie!']);
    expect(formatSoloGameEndMessages(win, PD, { isSpectator: true }).slice(-1)).toEqual(['bob wins!']);
    expect(soloResultRows(tie, PD, { myPosition: 2 }).map((r) => [r.name, r.score, r.winner, r.mine])).toEqual([
      ['ann', 120, true, false], ['bob', 120, true, true], ['cat', 80, false, false],
    ]);
  });

  it('the announcer names the three, the viewer first', () => {
    const s = table(2);
    expect(soloTally(' Tricks:', s, { 1: 2, 2: 1, 3: 0 })).toBe(' Tricks: bob 1, cat 0, ann 2.');
  });

  it("a lazy or resigned seat: every line and row names its owner, as the server's stored lines do", () => {
    // owner rule 2026-11-25 (people by player names): the seat shows the
    // bot, the header, the hand and game-over lines, the tally and the
    // score screen name the owner, so a reload or a spectator replaying
    // the stored log (gameHandlers.seatName) reads what the live table wrote
    const s = table(1);
    s.applySeatDisplay(2, { username: '🤖 Gina', pic: 8 });
    expect(s.playerData.username[1].username).toBe('🤖 Gina');
    const pd = teamPlayerDataOf(s);
    expect(soloHeaderRows(s).map((r) => r.name)).toEqual(['ann', 'bob', 'cat']);
    expect(formatSoloHandMessages({ scores: [0, 11, 0], seats: [{ position: 2, bid: 1, took: 1, points: 11, forbiddenHit: false }] }, pd))
      .toEqual(['--- HAND COMPLETE ---', 'bob: Bid 1, Won 1, +11 → 11']);
    const end = { scores: [10, 20, 5], winners: [2], made: [1, 2, 0], hands: 13 };
    expect(formatSoloGameEndMessages(end, pd, { myPosition: 1 })).toEqual(['=== GAME OVER ===', 'ann: 10', 'bob: 20', 'cat: 5', 'DEFEAT', 'bob wins!']);
    expect(soloResultRows(end, pd).map((r) => r.name)).toEqual(['bob', 'ann', 'cat']);
    expect(soloTally(' Tricks:', s, { 1: 0, 2: 1, 3: 0 })).toBe(' Tricks: ann 0, bob 1, cat 0.');
    // /active: the seat shows its owner again
    s.applySeatDisplay(2, { username: 'bob', pic: 2 });
    expect(soloHeaderRows(s).map((r) => r.name)).toEqual(['ann', 'bob', 'cat']);
  });
});
