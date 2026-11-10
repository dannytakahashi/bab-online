import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameState, PHASE, getGameState, resetGameState } from './GameState.js';

describe('GameState', () => {
  let state;

  beforeEach(() => {
    state = new GameState();
  });

  describe('initialization', () => {
    it('starts with null player data', () => {
      expect(state.playerId).toBeNull();
      expect(state.username).toBeNull();
      expect(state.position).toBeNull();
    });

    it('starts in NONE phase', () => {
      expect(state.phase).toBe(PHASE.NONE);
    });

    it('starts with empty hand', () => {
      expect(state.myCards).toEqual([]);
    });
  });

  describe('setPlayer', () => {
    it('sets player identity', () => {
      state.setPlayer('id123', 'Alice', 1, 5);
      expect(state.playerId).toBe('id123');
      expect(state.username).toBe('Alice');
      expect(state.position).toBe(1);
      expect(state.pic).toBe(5);
    });

    it('emits playerSet event', () => {
      const handler = vi.fn();
      state.on('playerSet', handler);
      state.setPlayer('id123', 'Alice', 1);
      expect(handler).toHaveBeenCalledWith({
        playerId: 'id123',
        username: 'Alice',
        position: 1,
        pic: null,
      });
    });
  });

  describe('setCards', () => {
    it('sets player hand', () => {
      const cards = [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'hearts' },
      ];
      state.setCards(cards);
      expect(state.myCards).toHaveLength(2);
      expect(state.myCards[0].rank).toBe('A');
    });

    it('creates a copy of the cards array', () => {
      const cards = [{ rank: 'A', suit: 'spades' }];
      state.setCards(cards);
      cards.push({ rank: 'K', suit: 'hearts' });
      expect(state.myCards).toHaveLength(1);
    });

    it('emits handChanged event', () => {
      const handler = vi.fn();
      state.on('handChanged', handler);
      state.setCards([{ rank: 'A', suit: 'spades' }]);
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('setPhase', () => {
    it('changes game phase', () => {
      state.setPhase(PHASE.BIDDING);
      expect(state.phase).toBe(PHASE.BIDDING);
    });

    it('emits phaseChanged event', () => {
      const handler = vi.fn();
      state.on('phaseChanged', handler);
      state.setPhase(PHASE.PLAYING);
      expect(handler).toHaveBeenCalledWith({
        oldPhase: PHASE.NONE,
        newPhase: PHASE.PLAYING,
      });
    });
  });

  // A pending play/bid lives in MyAction now (MyAction.test.js): the hand
  // in GameState is the server's, edited only by the cardPlayed echo
  describe('a pending play never edits the hand (renderModel hides it)', () => {
    beforeEach(() => {
      state.setCards([
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'hearts' },
        { rank: 'Q', suit: 'diamonds' },
      ]);
      state.position = 1;
      state.trump = { suit: 'clubs', rank: '2' };
      state.handNo = 1;
    });

    it('the model moves the pending card from the hand to my trick slot', () => {
      const m = state.renderModel({ pendingCard: { rank: 'K', suit: 'hearts' } });
      expect(m.hand).toHaveLength(2);
      expect(m.hand.find((c) => c.rank === 'K')).toBeUndefined();
      expect(m.trick).toEqual([{ position: 1, card: { rank: 'K', suit: 'hearts' }, pending: true }]);
      expect(state.myCards).toHaveLength(3);
    });

    it('a pending card not in the hand changes nothing', () => {
      const m = state.renderModel({ pendingCard: { rank: '2', suit: 'clubs' } });
      expect(m.hand).toHaveLength(3);
      expect(m.trick).toEqual([]);
    });

    it('rollback is just the model without the pending card', () => {
      expect(state.renderModel().hand).toHaveLength(3);
    });

    it('the echo (applyCardPlayed at my seat) takes the card out of the hand', () => {
      state.applyCardPlayed({ card: { rank: 'A', suit: 'spades' }, position: 1 });
      expect(state.myCards).toHaveLength(2);
      expect(state.hasPlayedCard).toBe(true);
      expect(state.renderModel().trick).toEqual([{ position: 1, card: { rank: 'A', suit: 'spades' } }]);
    });
  });

  describe('recordBid', () => {
    beforeEach(() => {
      state.setPlayer('id', 'Alice', 1);
    });

    it('stores bid for position', () => {
      state.recordBid(1, '3');
      expect(state.bids[1]).toBe('3');
    });

    it('updates team bid summary', () => {
      state.recordBid(1, '3');
      state.recordBid(3, '2');
      expect(state.teamBids).toBe('3/2');
    });

    it('emits bidReceived event', () => {
      const handler = vi.fn();
      state.on('bidReceived', handler);
      state.recordBid(2, '4');
      expect(handler).toHaveBeenCalledWith({ position: 2, bid: '4' });
    });
  });

  describe('addPlayedCard', () => {
    it('adds card to played cards', () => {
      const card = { rank: 'A', suit: 'spades' };
      state.addPlayedCard(card, 1);
      expect(state.playedCards).toHaveLength(1);
      expect(state.playedCards[0]).toEqual({ card, position: 1 });
    });

    it('sets lead card on first play', () => {
      const card = { rank: 'A', suit: 'spades' };
      state.addPlayedCard(card, 2);
      expect(state.leadCard).toEqual(card);
      expect(state.leadPosition).toBe(2);
    });

    it('does not change lead on subsequent plays', () => {
      state.addPlayedCard({ rank: 'A', suit: 'spades' }, 1);
      state.addPlayedCard({ rank: 'K', suit: 'spades' }, 2);
      expect(state.leadPosition).toBe(1);
    });
  });

  describe('clearTrick', () => {
    it('clears played cards', () => {
      state.addPlayedCard({ rank: 'A', suit: 'spades' }, 1);
      state.clearTrick();
      expect(state.playedCards).toHaveLength(0);
      expect(state.leadCard).toBeNull();
      expect(state.leadPosition).toBeNull();
    });
  });

  describe('isMyTurn', () => {
    it('returns true when current turn matches position', () => {
      state.setPlayer('id', 'Alice', 2);
      state.setCurrentTurn(2);
      expect(state.isMyTurn()).toBe(true);
    });

    it('returns false when not my turn', () => {
      state.setPlayer('id', 'Alice', 2);
      state.setCurrentTurn(1);
      expect(state.isMyTurn()).toBe(false);
    });
  });

  describe('getPartnerPosition', () => {
    it('returns correct partner position', () => {
      state.setPlayer('id', 'Alice', 1);
      expect(state.getPartnerPosition()).toBe(3);

      state.setPlayer('id', 'Bob', 2);
      expect(state.getPartnerPosition()).toBe(4);
    });
  });

  describe('isLeading', () => {
    it('returns true when no cards played', () => {
      expect(state.isLeading()).toBe(true);
    });

    it('returns false when cards have been played', () => {
      state.addPlayedCard({ rank: 'A', suit: 'spades' }, 1);
      expect(state.isLeading()).toBe(false);
    });
  });

  describe('canAct', () => {
    it('my turn to bid until I bid; to play until I played; never lazy, spectating or pending', () => {
      state.position = 2;
      state.currentTurn = 2;
      state.stage = 'BIDDING';
      state.isBidding = true;
      expect(state.canAct()).toBe(true);
      expect(state.canAct({ pending: true })).toBe(false);
      state.bids[2] = '3';
      expect(state.canAct()).toBe(false);
      state.stage = 'PLAYING';
      state.isBidding = false;
      expect(state.canAct()).toBe(true);
      state.hasPlayedCard = true;
      expect(state.canAct()).toBe(false);
      state.hasPlayedCard = false;
      state.isLazy = true;
      expect(state.canAct()).toBe(false);
      state.isLazy = false;
      state.stage = 'TRICK_RESOLVING';
      expect(state.canAct()).toBe(false);
    });
  });

  describe('reset', () => {
    it('resets all state to initial values', () => {
      state.setPlayer('id', 'Alice', 1);
      state.setCards([{ rank: 'A', suit: 'spades' }]);
      state.setPhase(PHASE.PLAYING);

      state.reset();

      expect(state.playerId).toBeNull();
      expect(state.myCards).toEqual([]);
      expect(state.phase).toBe(PHASE.NONE);
    });

    it('clears all listeners on reset', () => {
      const handler = vi.fn();
      state.on('turnChanged', handler);
      state.reset();
      // Listener should be cleared, so this should not trigger handler
      state.setCurrentTurn(2);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('event system', () => {
    it('allows multiple listeners', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      state.on('turnChanged', handler1);
      state.on('turnChanged', handler2);

      state.setCurrentTurn(2);

      expect(handler1).toHaveBeenCalledWith(2);
      expect(handler2).toHaveBeenCalledWith(2);
    });

    it('unsubscribe function works', () => {
      const handler = vi.fn();
      const unsubscribe = state.on('turnChanged', handler);

      state.setCurrentTurn(1);
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      state.setCurrentTurn(2);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('off removes listener', () => {
      const handler = vi.fn();
      state.on('turnChanged', handler);
      state.off('turnChanged', handler);

      state.setCurrentTurn(1);
      expect(handler).not.toHaveBeenCalled();
    });

    it('handles listener errors gracefully', () => {
      const errorHandler = vi.fn(() => {
        throw new Error('Handler error');
      });
      const normalHandler = vi.fn();

      state.on('turnChanged', errorHandler);
      state.on('turnChanged', normalHandler);

      // Should not throw
      expect(() => state.setCurrentTurn(1)).not.toThrow();
      expect(normalHandler).toHaveBeenCalled();
    });
  });

  describe('event appliers (the one writer)', () => {
    const deal = (extra = {}) => ({
      gameId: 'g1', position: 2, seq: 7, currentHand: 3, dealer: 1, score1: 10, score2: 20,
      trump: { suit: 'hearts', rank: '9' },
      hand: [{ suit: 'spades', rank: 'A' }, { suit: 'clubs', rank: '4' }, { suit: 'hearts', rank: 'K' }],
      hsiValues: { 1: 1, 2: 2, 3: 3, 4: 4 },
      ...extra,
    });

    it('a deal opens bidding with every seat holding the hand size', () => {
      state.applyDeal(deal());
      expect(state.handNo).toBe(1);
      expect(state.dealSeq).toBe(1); // the server's deal number, not the seq
      expect(state.stage).toBe('BIDDING');
      expect(state.isBidding).toBe(true);
      expect(state.seatCards).toEqual({ 1: 3, 2: 3, 3: 3, 4: 3 });
      // seat 2 is team 2: score2 is mine
      expect([state.teamScore, state.oppScore]).toEqual([20, 10]);
    });

    it('bids, doneBidding, plays and the trick count are kept here, not in the scene (cli-8)', () => {
      state.applyDeal(deal());
      [[2, '1'], [3, '0'], [4, '2'], [1, 'B']].forEach(([position, bid]) => state.applyBid({ position, bid }));
      expect(state.tempBids).toEqual(['1', '0', '2', 'B']);
      expect(state.teamBids).toBe('1/2');
      state.applyDoneBidding({ bids: ['B', '1', '0', '2'], lead: 2 });
      expect(state.stage).toBe('PLAYING');
      expect(state.currentTurn).toBe(2);
      state.applyCardPlayed({ card: { suit: 'clubs', rank: '4' }, position: 2 });
      state.applyCardPlayed({ card: { suit: 'clubs', rank: 'Q' }, position: 3, trumpBroken: false });
      state.applyCardPlayed({ card: { suit: 'hearts', rank: '2' }, position: 4, trumpBroken: true });
      state.applyCardPlayed({ card: { suit: 'clubs', rank: '5' }, position: 1 });
      expect(state.stage).toBe('TRICK_RESOLVING');
      expect(state.trumpBroken).toBe(true);
      expect(state.myCards).toHaveLength(2);
      expect(state.seatCards).toEqual({ 1: 2, 2: 2, 3: 2, 4: 2 });
      state.applyTrickComplete({ winner: 4 });
      expect([state.teamTricks, state.oppTricks]).toEqual([1, 0]);
      expect(state.trickNo).toBe(2);
      expect(state.trickHistory).toHaveLength(1);
      expect(state.playedCards).toEqual([]);
      state.applyTrickComplete({ winner: 1, resumeInMs: 1000 });
      expect(state.stage).toBe('HAND_RESOLVING');
    });

    it('a zero-bid redeal keeps the hand number; the next deal is the next hand', () => {
      state.applyDeal(deal());
      state.applyDestroyHands();
      expect(state.stage).toBe('REDEAL');
      expect(state.myCards).toEqual([]);
      state.applyDeal(deal({ seq: 12 }));
      expect(state.handNo).toBe(1);
      expect(state.dealSeq).toBe(2);
      state.applyDeal(deal({ seq: 30 }));
      expect(state.handNo).toBe(2);
      expect(state.dealSeq).toBe(3);
    });
  });

  describe('applySnapshot (the only restore path)', () => {
    const seat = (position, cardsInHand, extra = {}) => ({
      position, username: `p${position}`, pic: position, hasCustomPic: false, customPic: null, ownerUsername: `p${position}`,
      controller: 'human', presence: 'connected', isBot: false, lazy: false, offered: false, graceDeadline: null,
      resignableAt: null, cardsInHand, ...extra,
    });
    const snap = (extra = {}) => ({
      v: 2, gameId: 'game123', seq: 40, stage: 'PLAYING', partial: [],
      viewer: { role: 'seat', position: 2, ownerView: 'seat', canAct: false },
      hand: [{ rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'hearts' }],
      deal: { handNo: 3, handSize: 8, dealer: 1, bidder: 2, dealSeq: 3 },
      trump: { suit: 'hearts', rank: '4' }, trumpBroken: true,
      turn: { position: 3, action: 'play' },
      bids: { byPosition: ['3', '2', '4', '1'], order: [2, 3, 4, 1], teamBids: { team1: 7, team2: 3 }, mults: { team1: 1, team2: 1 } },
      trick: { number: 6, leadPosition: 1, cards: [{ position: 1, card: { suit: 'clubs', rank: '9' } }, { position: 2, card: { suit: 'clubs', rank: 'J' } }] },
      tricks: { team1: 3, team2: 2 }, tricksByPosition: [2, 1, 1, 1],
      score: { team1: 50, team2: 30 }, rainbows: { team1: 0, team2: 0 }, hsi: [1, 2, 3, 4],
      seats: [seat(1, 2), seat(2, 2), seat(3, 3), seat(4, 3)],
      entrants: null, draw: null, spectatorCount: 0, tournament: null, log: [],
      ...extra,
    });

    it('replaces the table, relative to my seat', () => {
      state.applySnapshot(snap());
      expect(state.gameId).toBe('game123');
      expect(state.position).toBe(2);
      expect(state.handNo).toBe(3);
      expect(state.currentHand).toBe(8);
      expect(state.trump).toEqual({ suit: 'hearts', rank: '4' });
      expect(state.trumpBroken).toBe(true);
      expect(state.isBidding).toBe(false);
      expect(state.phase).toBe(PHASE.PLAYING);
      expect(state.myCards).toHaveLength(2);
      expect(state.currentTurn).toBe(3);
      expect(state.leadPosition).toBe(1);
      expect(state.hasPlayedCard).toBe(true);
      expect(state.trickNo).toBe(6);
      // seat 2 is team 2
      expect([state.teamTricks, state.oppTricks]).toEqual([2, 3]);
      expect([state.teamScore, state.oppScore]).toEqual([30, 50]);
      expect(state.seatCards).toEqual({ 1: 2, 2: 2, 3: 3, 4: 3 });
      expect(state.bids).toEqual({ 1: '3', 2: '2', 3: '4', 4: '1' });
      expect(state.partnerName).toBe('p4');
      // only counts are known: one face-down entry per trick, by team
      expect(state.trickHistory).toEqual([
        ...Array(3).fill({ winner: null, team: 1, cards: null }),
        ...Array(2).fill({ winner: null, team: 2, cards: null }),
      ]);
    });

    it('a spectator views from seat 1; a lazy watcher keeps the hand', () => {
      state.applySnapshot(snap({ viewer: { role: 'spectator', position: null, ownerView: null, canAct: false }, hand: null }));
      expect([state.isSpectator, state.position, state.myCards]).toEqual([true, 1, []]);
      expect(state.renderModel().hand).toBeNull();
      state.applySnapshot(snap({ viewer: { role: 'lazyWatcher', position: 2, ownerView: 'watch', canAct: false } }));
      expect([state.isSpectator, state.isLazy, state.myCards.length]).toEqual([false, true, 2]);
    });

    it('keeps the face-up trick history of the same deal when the counts agree', () => {
      state.applySnapshot(snap({ tricks: { team1: 0, team2: 0 }, trick: { number: 1, leadPosition: null, cards: [] } }));
      expect(state.trickHistory).toEqual([]);
      state.trickHistory = [{ winner: 1, cards: [] }];
      state.applySnapshot(snap({ tricks: { team1: 1, team2: 0 } }));
      expect(state.trickHistory).toHaveLength(1);
      state.applySnapshot(snap({ tricks: { team1: 2, team2: 0 } }));
      expect(state.trickHistory).toEqual([{ winner: null, team: 1, cards: null }, { winner: null, team: 1, cards: null }]);
      // same total, other split: not the history we kept
      state.trickHistory = [{ winner: 1, cards: [] }];
      state.applySnapshot(snap({ tricks: { team1: 0, team2: 1 } }));
      expect(state.trickHistory).toEqual([{ winner: null, team: 2, cards: null }]);
    });

    it('tricks won after a snapshot that only counted the earlier ones keep their cards', () => {
      state.applySnapshot(snap({ tricks: { team1: 1, team2: 1 }, trick: { number: 3, leadPosition: 2, cards: [] } }));
      [[2, '3'], [3, '4'], [4, '5'], [1, '6']].forEach(([position, rank]) =>
        state.applyCardPlayed({ card: { suit: 'clubs', rank }, position }));
      state.applyTrickComplete({ winner: 4 });
      expect(state.trickHistory).toHaveLength(3);
      expect(state.trickHistory[2]).toMatchObject({ winner: 4, cards: [{ position: 2 }, { position: 3 }, { position: 4 }, { position: 1 }] });
      const history = state.renderModel().history;
      expect(history.map((t) => [t.team, t.cards === null])).toEqual([[1, true], [2, true], [2, false]]);
      // a later snapshot of the same deal and counts keeps them
      state.applySnapshot(snap({ tricks: { team1: 1, team2: 2 }, trick: { number: 4, leadPosition: 4, cards: [] } }));
      expect(state.trickHistory[2].cards).toHaveLength(4);
    });
  });

  describe('toJSON', () => {
    it('returns serializable snapshot', () => {
      state.setPlayer('id', 'Alice', 1);
      state.setPhase(PHASE.BIDDING);

      const json = state.toJSON();

      expect(json.playerId).toBe('id');
      expect(json.username).toBe('Alice');
      expect(json.phase).toBe(PHASE.BIDDING);
    });
  });
});

describe('singleton', () => {
  it('getGameState returns same instance', () => {
    const state1 = getGameState();
    const state2 = getGameState();
    expect(state1).toBe(state2);
  });

  it('resetGameState resets the singleton', () => {
    const state = getGameState();
    state.setPhase(PHASE.PLAYING);

    resetGameState();

    expect(getGameState().phase).toBe(PHASE.NONE);
  });
});
