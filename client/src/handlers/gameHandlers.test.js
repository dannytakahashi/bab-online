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

  it('ABORT_GAME clears the gameId as well', () => {
    const onAbortGame = vi.fn();
    registerGameHandlers(manager, { onAbortGame });
    manager.setGameId('game123');

    socket._trigger(SERVER_EVENTS.ABORT_GAME, {});

    expect(onAbortGame).toHaveBeenCalled();
    expect(manager.gameId).toBeNull();
  });
});
