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

  describe('optimisticPlayCard', () => {
    beforeEach(() => {
      state.setCards([
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'hearts' },
        { rank: 'Q', suit: 'diamonds' },
      ]);
    });

    it('removes card from hand', () => {
      const result = state.optimisticPlayCard({ rank: 'K', suit: 'hearts' });
      expect(result).toBe(true);
      expect(state.myCards).toHaveLength(2);
      expect(state.myCards.find((c) => c.rank === 'K')).toBeUndefined();
    });

    it('returns false for card not in hand', () => {
      const result = state.optimisticPlayCard({ rank: '2', suit: 'clubs' });
      expect(result).toBe(false);
      expect(state.myCards).toHaveLength(3);
    });

    it('stores previous state for rollback', () => {
      state.optimisticPlayCard({ rank: 'A', suit: 'spades' });
      expect(state._previousCards).toHaveLength(3);
      expect(state._pendingCard).toEqual({ rank: 'A', suit: 'spades' });
    });
  });

  describe('rollbackCardPlay', () => {
    it('restores hand after rejected play', () => {
      state.setCards([
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'hearts' },
      ]);
      state.optimisticPlayCard({ rank: 'A', suit: 'spades' });
      expect(state.myCards).toHaveLength(1);

      state.rollbackCardPlay();
      expect(state.myCards).toHaveLength(2);
    });

    it('emits cardPlayRolledBack event', () => {
      state.setCards([{ rank: 'A', suit: 'spades' }]);
      state.optimisticPlayCard({ rank: 'A', suit: 'spades' });

      const handler = vi.fn();
      state.on('cardPlayRolledBack', handler);
      state.rollbackCardPlay();
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('confirmCardPlay', () => {
    it('clears pending state', () => {
      state.setCards([{ rank: 'A', suit: 'spades' }]);
      state.optimisticPlayCard({ rank: 'A', suit: 'spades' });
      state.confirmCardPlay();
      expect(state._pendingCard).toBeNull();
      expect(state._previousCards).toBeNull();
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

  describe('hasPendingAction', () => {
    it('returns false initially', () => {
      expect(state.hasPendingAction()).toBe(false);
    });

    it('returns true with pending card', () => {
      state.setCards([{ rank: 'A', suit: 'spades' }]);
      state.optimisticPlayCard({ rank: 'A', suit: 'spades' });
      expect(state.hasPendingAction()).toBe(true);
    });

    it('returns true with pending bid', () => {
      state.optimisticBid('3');
      expect(state.hasPendingAction()).toBe(true);
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

    it('emits reset event', () => {
      const handler = vi.fn();
      state.on('reset', handler);
      state.reset();
      expect(handler).toHaveBeenCalled();
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

  describe('restoreFromRejoin', () => {
    it('restores state from rejoin data', () => {
      const rejoinData = {
        gameId: 'game123',
        position: 2,
        currentHand: 8,
        trump: { suit: 'hearts' },
        trumpBroken: true,
        dealer: 1,
        isBidding: false,
        currentTurn: 3,
        hand: [
          { rank: 'A', suit: 'spades' },
          { rank: 'K', suit: 'hearts' },
        ],
        bids: { 1: '3', 2: '2', 3: '4', 4: '1' },
        teamTricks: 3,
        oppTricks: 2,
        teamScore: 50,
        oppScore: 30,
      };

      state.restoreFromRejoin(rejoinData);

      expect(state.gameId).toBe('game123');
      expect(state.position).toBe(2);
      expect(state.currentHand).toBe(8);
      expect(state.trump).toEqual({ suit: 'hearts' });
      expect(state.trumpBroken).toBe(true);
      expect(state.isBidding).toBe(false);
      expect(state.myCards).toHaveLength(2);
      expect(state.phase).toBe(PHASE.PLAYING);
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
