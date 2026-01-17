import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SocketManager,
  CONNECTION_STATE,
  getSocketManager,
  initializeSocketManager,
  resetSocketManager,
} from './SocketManager.js';

// Mock socket for testing
function createMockSocket() {
  const listeners = new Map();

  return {
    id: 'test-socket-id',
    on: vi.fn((event, callback) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event).add(callback);
    }),
    off: vi.fn((event, callback) => {
      const eventListeners = listeners.get(event);
      if (eventListeners) {
        eventListeners.delete(callback);
      }
    }),
    emit: vi.fn(),
    // Helper to trigger events in tests
    _trigger: (event, data) => {
      const eventListeners = listeners.get(event);
      if (eventListeners) {
        eventListeners.forEach((cb) => cb(data));
      }
    },
    _getListeners: () => listeners,
  };
}

describe('SocketManager', () => {
  let manager;
  let mockSocket;

  beforeEach(() => {
    mockSocket = createMockSocket();
    manager = new SocketManager(mockSocket);
    // Clear sessionStorage
    sessionStorage.clear();
  });

  describe('initialization', () => {
    it('starts disconnected', () => {
      const manager = new SocketManager();
      expect(manager.state).toBe(CONNECTION_STATE.DISCONNECTED);
    });

    it('stores socket reference', () => {
      expect(manager.socket).toBe(mockSocket);
    });

    it('gets socket id', () => {
      expect(manager.id).toBe('test-socket-id');
    });
  });

  describe('on', () => {
    it('registers global listener', () => {
      const callback = vi.fn();
      manager.on('testEvent', callback);

      expect(mockSocket.on).toHaveBeenCalledWith('testEvent', callback);
    });

    it('returns unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = manager.on('testEvent', callback);

      unsubscribe();

      expect(mockSocket.off).toHaveBeenCalledWith('testEvent', callback);
    });

    it('tracks listener for cleanup', () => {
      const callback = vi.fn();
      manager.on('testEvent', callback);

      const counts = manager.getListenerCounts();
      expect(counts.testEvent).toBe(1);
    });
  });

  describe('onGame', () => {
    it('registers game-specific listener', () => {
      const callback = vi.fn();
      manager.onGame('gameEvent', callback);

      expect(mockSocket.on).toHaveBeenCalledWith('gameEvent', callback);
    });

    it('tracks listener separately from global', () => {
      const globalCb = vi.fn();
      const gameCb = vi.fn();

      manager.on('event', globalCb);
      manager.onGame('event', gameCb);

      expect(manager.getListenerCounts().event).toBe(2);
    });
  });

  describe('off', () => {
    it('removes listener from socket', () => {
      const callback = vi.fn();
      manager.on('testEvent', callback);
      manager.off('testEvent', callback);

      expect(mockSocket.off).toHaveBeenCalledWith('testEvent', callback);
    });

    it('removes from both global and game listeners', () => {
      const callback = vi.fn();
      manager.on('event1', callback);
      manager.onGame('event2', callback);

      manager.off('event1', callback);
      manager.off('event2', callback);

      expect(manager.getTotalListenerCount()).toBe(0);
    });
  });

  describe('offAll', () => {
    it('removes all listeners for an event', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      manager.on('testEvent', cb1);
      manager.on('testEvent', cb2);

      manager.offAll('testEvent');

      expect(mockSocket.off).toHaveBeenCalledWith('testEvent', cb1);
      expect(mockSocket.off).toHaveBeenCalledWith('testEvent', cb2);
    });
  });

  describe('cleanupGameListeners', () => {
    it('removes all game listeners', () => {
      const gameCb1 = vi.fn();
      const gameCb2 = vi.fn();
      const globalCb = vi.fn();

      manager.onGame('event1', gameCb1);
      manager.onGame('event2', gameCb2);
      manager.on('event3', globalCb);

      manager.cleanupGameListeners();

      expect(mockSocket.off).toHaveBeenCalledWith('event1', gameCb1);
      expect(mockSocket.off).toHaveBeenCalledWith('event2', gameCb2);
      // Global listener should NOT be removed
      expect(mockSocket.off).not.toHaveBeenCalledWith('event3', globalCb);
    });

    it('clears game listener tracking', () => {
      manager.onGame('event1', vi.fn());
      manager.onGame('event2', vi.fn());

      manager.cleanupGameListeners();

      // Only global listeners remain tracked
      expect(manager.getTotalListenerCount()).toBe(0);
    });
  });

  describe('emit', () => {
    it('emits event to socket', () => {
      manager.emit('testEvent', { foo: 'bar' });

      expect(mockSocket.emit).toHaveBeenCalledWith('testEvent', { foo: 'bar' });
    });

    it('handles missing socket gracefully', () => {
      const manager = new SocketManager(null);

      // Should not throw
      expect(() => manager.emit('test', {})).not.toThrow();
    });
  });

  describe('game ID management', () => {
    it('setGameId stores in memory and sessionStorage', () => {
      manager.setGameId('game123');

      expect(manager.gameId).toBe('game123');
      expect(sessionStorage.getItem('gameId')).toBe('game123');
    });

    it('clearGameId removes from both', () => {
      manager.setGameId('game123');
      manager.clearGameId();

      expect(manager.gameId).toBeNull();
      expect(sessionStorage.getItem('gameId')).toBeNull();
    });

    it('gets gameId from sessionStorage if not in memory', () => {
      sessionStorage.setItem('gameId', 'stored-game');

      const manager = new SocketManager(mockSocket);
      expect(manager.gameId).toBe('stored-game');
    });
  });

  describe('username', () => {
    it('gets username from sessionStorage', () => {
      sessionStorage.setItem('username', 'testuser');

      expect(manager.username).toBe('testuser');
    });
  });

  describe('connection state', () => {
    it('isConnected returns true when connected', () => {
      manager._state = CONNECTION_STATE.CONNECTED;
      expect(manager.isConnected).toBe(true);
    });

    it('isConnected returns false when disconnected', () => {
      manager._state = CONNECTION_STATE.DISCONNECTED;
      expect(manager.isConnected).toBe(false);
    });
  });

  describe('onStateChange', () => {
    it('registers state change listener', () => {
      const callback = vi.fn();
      manager.onStateChange(callback);

      manager._setState(CONNECTION_STATE.CONNECTED);

      expect(callback).toHaveBeenCalledWith('stateChanged', {
        oldState: CONNECTION_STATE.DISCONNECTED,
        newState: CONNECTION_STATE.CONNECTED,
      });
    });

    it('returns unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = manager.onStateChange(callback);

      unsubscribe();
      manager._setState(CONNECTION_STATE.CONNECTED);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('getListenerCounts', () => {
    it('returns counts by event', () => {
      manager.on('event1', vi.fn());
      manager.on('event1', vi.fn());
      manager.on('event2', vi.fn());
      manager.onGame('event2', vi.fn());

      const counts = manager.getListenerCounts();

      expect(counts.event1).toBe(2);
      expect(counts.event2).toBe(2);
    });
  });

  describe('getTotalListenerCount', () => {
    it('returns total across all events', () => {
      manager.on('event1', vi.fn());
      manager.on('event2', vi.fn());
      manager.onGame('event3', vi.fn());

      expect(manager.getTotalListenerCount()).toBe(3);
    });
  });
});

describe('singleton functions', () => {
  beforeEach(() => {
    resetSocketManager();
    sessionStorage.clear();
  });

  it('getSocketManager returns same instance', () => {
    const sm1 = getSocketManager();
    const sm2 = getSocketManager();

    expect(sm1).toBe(sm2);
  });

  it('initializeSocketManager sets up socket', () => {
    const mockSocket = createMockSocket();
    const manager = initializeSocketManager(mockSocket);

    expect(manager.socket).toBe(mockSocket);
  });

  it('resetSocketManager clears singleton', () => {
    const sm1 = getSocketManager();
    resetSocketManager();
    const sm2 = getSocketManager();

    expect(sm1).not.toBe(sm2);
  });
});
