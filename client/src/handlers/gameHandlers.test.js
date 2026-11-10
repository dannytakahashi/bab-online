import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerGameHandlers } from './gameHandlers.js';
import { SocketManager } from '../socket/SocketManager.js';
import { SERVER_EVENTS } from '../constants/events.js';

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
