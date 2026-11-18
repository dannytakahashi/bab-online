import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { registerGameHandlers } from './gameHandlers.js';
import { SocketManager } from '../socket/SocketManager.js';
import { SERVER_EVENTS } from '../constants/events.js';
import { resetGameState } from '../state/GameState.js';
import { resetMyAction } from '../state/MyAction.js';
import { resetSeqGate } from '../state/SeqGate.js';
import { resetTableSounds } from '../audio/tableSounds.js';
import { setBidClockNow } from '../state/bidClock.js';

function createMockSocket() {
  const listeners = new Map();
  return {
    on: vi.fn((event, cb) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
    }),
    off: vi.fn(),
    emit: vi.fn(),
    _trigger: (event, data) => listeners.get(event)?.forEach((cb) => cb(data)),
  };
}

describe('game exit handlers', () => {
  let socket;
  let manager;

  beforeEach(() => {
    sessionStorage.clear();
    socket = createMockSocket();
    manager = new SocketManager(socket);
  });

  it('LEFT_GAME clears the in-memory gameId so a reconnect does not rejoin the left game', () => {
    const onLeftGame = vi.fn();
    registerGameHandlers(manager, { onLeftGame });
    manager.setGameId('game123');

    socket._trigger(SERVER_EVENTS.LEFT_GAME, {});

    expect(onLeftGame).toHaveBeenCalled();
    expect(manager.gameId).toBeNull();
    expect(sessionStorage.getItem('gameId')).toBeNull();
  });

  it('REJOIN_FAILED clears the gameId, except for the duplicate request\'s "Already connected"', () => {
    const onRejoinFailed = vi.fn();
    registerGameHandlers(manager, { onRejoinFailed });
    manager.setGameId('game123');

    // the page load sends rejoinGame twice; the seat is live on this socket
    socket._trigger(SERVER_EVENTS.REJOIN_FAILED, { reason: 'Already connected' });
    expect(manager.gameId).toBe('game123');
    expect(sessionStorage.getItem('gameId')).toBe('game123');

    socket._trigger(SERVER_EVENTS.REJOIN_FAILED, { reason: 'Game no longer exists' });
    expect(manager.gameId).toBeNull();
    expect(sessionStorage.getItem('gameId')).toBeNull();
    expect(onRejoinFailed).toHaveBeenCalledTimes(2);
  });

  it('ABORT_GAME clears the gameId as well', () => {
    const onAbortGame = vi.fn();
    registerGameHandlers(manager, { onAbortGame });
    manager.setGameId('game123');

    socket._trigger(SERVER_EVENTS.ABORT_GAME, {});

    expect(onAbortGame).toHaveBeenCalled();
    expect(manager.gameId).toBeNull();
  });
});

afterAll(() => setBidClockNow(null));

describe('bidClock (unsequenced)', () => {
  const G = 'g1';
  let socket;
  let manager;
  let state;
  let myAction;
  let onBidClock;
  let onBidTimedOut;
  let now;
  let seq;
  const fire = (event, data) => socket._trigger(event, { ...data, seq: ++seq });
  const clockEvent = (data) => socket._trigger(SERVER_EVENTS.BID_CLOCK, { gameId: G, ...data });

  beforeEach(() => {
    sessionStorage.clear();
    now = 1000;
    seq = 0;
    setBidClockNow(() => now);
    state = resetGameState();
    myAction = resetMyAction({ emit: () => {}, setTimer: () => 0, clearTimer: () => {} });
    resetSeqGate({ requestSnapshot: vi.fn(), setTimer: () => 1, clearTimer: () => {} });
    resetTableSounds({ sound: () => ({ play: () => true, start: () => null, duration: () => null }) });
    socket = createMockSocket();
    manager = new SocketManager(socket);
    onBidClock = vi.fn();
    onBidTimedOut = vi.fn();
    registerGameHandlers(manager, { onBidClock, onBidTimedOut });
    fire(SERVER_EVENTS.GAME_START, { gameId: G, position: 1, currentHand: 2, hand: [], trump: { suit: 'spades', rank: '5' } });
    fire(SERVER_EVENTS.UPDATE_TURN, { currentTurn: 1 });
  });

  it('applies on arrival (no seq) and hands the clock to the view', () => {
    clockEvent({ position: 1, running: true, inMs: 30000, durationMs: 30000 });
    expect(state.bidClock).toEqual({ position: 1, deadline: 31000, durationMs: 30000 });
    expect(onBidClock).toHaveBeenLastCalledWith({ position: 1, deadline: 31000, durationMs: 30000 });
    clockEvent({ position: 1, running: false, reason: 'bid' });
    expect(onBidClock).toHaveBeenLastCalledWith(null);
    expect(onBidTimedOut).not.toHaveBeenCalled();
  });

  it('my own timeout tells me (the toast); another seat\'s, a lazy seat\'s or a spectator\'s view does not', () => {
    clockEvent({ position: 1, running: true, inMs: 30000, durationMs: 30000 });
    clockEvent({ position: 1, running: false, reason: 'timeout' });
    expect(onBidTimedOut).toHaveBeenCalledTimes(1);
    clockEvent({ position: 2, running: false, reason: 'timeout' });
    state.applyMyLazy(true);
    clockEvent({ position: 1, running: false, reason: 'timeout' });
    state.applyMyLazy(false);
    state.isSpectator = true;
    clockEvent({ position: 1, running: false, reason: 'timeout' });
    state.isSpectator = false;
    clockEvent({ gameId: 'other', position: 1, running: false, reason: 'timeout' });
    expect(onBidTimedOut).toHaveBeenCalledTimes(1);
  });

  it('a bid of mine still pending when the timeout\'s bid 0 lands is settled, never stuck', () => {
    clockEvent({ position: 1, running: true, inMs: 30000, durationMs: 30000 });
    expect(myAction.submitBid('3', 1)).toBe(true);
    expect(myAction.isPending('bid')).toBe(true);
    clockEvent({ position: 1, running: false, reason: 'timeout' });
    fire(SERVER_EVENTS.BID_RECEIVED, { position: 1, bid: '0' });
    expect(myAction.isPending('bid')).toBe(false);
    expect(state.bids[1]).toBe('0');
    // or the server refused it (not_your_turn): its snapshot settles it too
    expect(myAction.submitBid('3', 1)).toBe(true);
    socket._trigger(SERVER_EVENTS.ACTION_REJECTED, { action: 'bid', reason: 'not_your_turn' });
    expect(myAction.isPending('bid')).toBe(false);
  });
});
