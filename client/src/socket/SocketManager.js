/**
 * Socket.IO connection manager with listener tracking.
 *
 * Provides centralized socket management with:
 * - Listener tracking for proper cleanup
 * - Game-specific listener cleanup between games
 * - Connection state management
 * - Reconnection support
 */

import { CLIENT_EVENTS, SERVER_EVENTS } from '../constants/events.js';

// Connection states
export const CONNECTION_STATE = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
};

/**
 * Socket manager with listener lifecycle management.
 */
export class SocketManager {
  /**
   * @param {Object} socket - Socket.IO socket instance (or null for testing)
   */
  constructor(socket = null) {
    this._socket = socket;
    this._state = CONNECTION_STATE.DISCONNECTED;
    this._gameId = null;

    // Track listeners by category for cleanup
    this._globalListeners = new Map(); // Persist across games
    this._gameListeners = new Map(); // Cleanup between games
    this._stateListeners = new Set(); // Connection state listeners

    // iOS Safari background/foreground reconnection
    this._hiddenAt = null;
    this._isForceReconnecting = false;
  }

  /**
   * Get underlying socket instance.
   */
  get socket() {
    return this._socket;
  }

  /**
   * Get socket ID.
   */
  get id() {
    return this._socket?.id || null;
  }

  /**
   * Get connection state.
   */
  get state() {
    return this._state;
  }

  /**
   * Check if connected.
   */
  get isConnected() {
    return this._state === CONNECTION_STATE.CONNECTED;
  }

  /**
   * Get stored game ID.
   */
  get gameId() {
    return this._gameId || sessionStorage.getItem('gameId');
  }

  /**
   * Get stored username.
   */
  get username() {
    return sessionStorage.getItem('username');
  }

  // ============================================
  // Connection Management
  // ============================================

  /**
   * Initialize socket with connection handlers.
   * @param {Object} socket - Socket.IO socket instance
   */
  initialize(socket) {
    this._socket = socket;
    this._setupConnectionHandlers();
  }

  /**
   * Set up built-in connection handlers.
   */
  _setupConnectionHandlers() {
    if (!this._socket) return;

    this._socket.on(SERVER_EVENTS.CONNECT, () => {
      this._setState(CONNECTION_STATE.CONNECTED);
      this._tryRejoin();
    });

    this._socket.on(SERVER_EVENTS.DISCONNECT, (reason) => {
      this._setState(CONNECTION_STATE.DISCONNECTED);
      this._emitStateChange('disconnect', { reason });
    });

    this._socket.on(SERVER_EVENTS.RECONNECT_ATTEMPT, (attemptNumber) => {
      this._setState(CONNECTION_STATE.RECONNECTING);
      this._emitStateChange('reconnecting', { attempt: attemptNumber });
    });

    this._socket.on(SERVER_EVENTS.RECONNECT_FAILED, () => {
      this._setState(CONNECTION_STATE.DISCONNECTED);
      this.clearGameId();
      this._emitStateChange('reconnectFailed');
    });

    this._setupVisibilityHandler();
  }

  /**
   * Set connection state and notify listeners.
   */
  _setState(state) {
    const oldState = this._state;
    this._state = state;
    this._emitStateChange('stateChanged', { oldState, newState: state });
  }

  /**
   * Emit state change to listeners.
   */
  _emitStateChange(event, data = {}) {
    this._stateListeners.forEach((callback) => {
      try {
        callback(event, data);
      } catch (err) {
        console.error('Error in state listener:', err);
      }
    });
  }

  /**
   * Attempt to rejoin game after reconnection.
   */
  _tryRejoin() {
    const gameId = this.gameId;
    const username = this.username;

    if (gameId && username) {
      console.log(`Attempting to rejoin game ${gameId} as ${username}`);
      this.emit(CLIENT_EVENTS.REJOIN_GAME, { gameId, username });
    }
  }

  /**
   * Set up visibility change handler for iOS Safari background/foreground.
   *
   * iOS kills WebSocket connections when Safari is backgrounded, but
   * Socket.IO's frozen heartbeat timer doesn't detect it immediately.
   * This forces a clean disconnect/reconnect cycle when returning from
   * background after >5 seconds, triggering the normal rejoin flow.
   */
  _setupVisibilityHandler() {
    if (typeof document === 'undefined') return;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._hiddenAt = Date.now();
      } else {
        if (!this._hiddenAt) return;

        const hiddenDuration = Date.now() - this._hiddenAt;
        this._hiddenAt = null;

        // Only force reconnect if hidden >5s and player is in a game
        if (hiddenDuration > 5000 && this.gameId) {
          this._forceReconnect();
        }
      }
    });
  }

  /**
   * Force a clean disconnect/reconnect cycle.
   * Triggers the existing connect → _tryRejoin() → rejoinGame flow.
   */
  _forceReconnect() {
    if (this._isForceReconnecting) return;
    this._isForceReconnecting = true;

    console.log('Force reconnecting after background (iOS Safari workaround)');
    this._socket.disconnect();

    setTimeout(() => {
      this._socket.connect();
      this._isForceReconnecting = false;
    }, 100);
  }

  // ============================================
  // Game ID Management
  // ============================================

  /**
   * Store game ID for reconnection.
   */
  setGameId(gameId) {
    this._gameId = gameId;
    sessionStorage.setItem('gameId', gameId);
  }

  /**
   * Clear game ID.
   */
  clearGameId() {
    this._gameId = null;
    sessionStorage.removeItem('gameId');
  }

  // ============================================
  // Listener Management
  // ============================================

  /**
   * Register a global listener (persists across games).
   * @param {string} event - Event name
   * @param {Function} callback - Handler function
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    return this._addListener(event, callback, this._globalListeners);
  }

  /**
   * Register a game-specific listener (cleaned up between games).
   * @param {string} event - Event name
   * @param {Function} callback - Handler function
   * @returns {Function} Unsubscribe function
   */
  onGame(event, callback) {
    return this._addListener(event, callback, this._gameListeners);
  }

  /**
   * Add a listener to a tracking map.
   */
  _addListener(event, callback, listenerMap) {
    if (!this._socket) {
      console.warn('Socket not initialized');
      return () => {};
    }

    // Track the listener
    if (!listenerMap.has(event)) {
      listenerMap.set(event, new Set());
    }
    listenerMap.get(event).add(callback);

    // Register with socket
    this._socket.on(event, callback);

    // Return unsubscribe function
    return () => this._removeListener(event, callback, listenerMap);
  }

  /**
   * Remove a listener from tracking and socket.
   */
  _removeListener(event, callback, listenerMap) {
    const listeners = listenerMap.get(event);
    if (listeners) {
      listeners.delete(callback);
    }

    if (this._socket) {
      this._socket.off(event, callback);
    }
  }

  /**
   * Remove a specific listener.
   */
  off(event, callback) {
    this._removeListener(event, callback, this._globalListeners);
    this._removeListener(event, callback, this._gameListeners);
  }

  /**
   * Remove all listeners for an event.
   */
  offAll(event) {
    this._removeAllListeners(event, this._globalListeners);
    this._removeAllListeners(event, this._gameListeners);
  }

  /**
   * Remove all listeners for an event from a map.
   */
  _removeAllListeners(event, listenerMap) {
    const listeners = listenerMap.get(event);
    if (listeners && this._socket) {
      listeners.forEach((callback) => {
        this._socket.off(event, callback);
      });
      listenerMap.delete(event);
    }
  }

  /**
   * Clean up all game-specific listeners.
   * Call this when a game ends or player returns to lobby.
   */
  cleanupGameListeners() {
    this._gameListeners.forEach((listeners, event) => {
      listeners.forEach((callback) => {
        if (this._socket) {
          this._socket.off(event, callback);
        }
      });
    });
    this._gameListeners.clear();
    console.log('Game listeners cleaned up');
  }

  /**
   * Subscribe to connection state changes.
   * @param {Function} callback - Called with (event, data)
   * @returns {Function} Unsubscribe function
   */
  onStateChange(callback) {
    this._stateListeners.add(callback);
    return () => this._stateListeners.delete(callback);
  }

  // ============================================
  // Emit
  // ============================================

  /**
   * Emit an event to the server.
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  emit(event, data) {
    if (!this._socket) {
      console.warn('Socket not initialized');
      return;
    }

    this._socket.emit(event, data);
  }

  // ============================================
  // Debug
  // ============================================

  /**
   * Get listener counts for debugging.
   */
  getListenerCounts() {
    const counts = {};

    this._globalListeners.forEach((listeners, event) => {
      counts[event] = (counts[event] || 0) + listeners.size;
    });

    this._gameListeners.forEach((listeners, event) => {
      counts[event] = (counts[event] || 0) + listeners.size;
    });

    return counts;
  }

  /**
   * Get total listener count.
   */
  getTotalListenerCount() {
    let total = 0;

    this._globalListeners.forEach((listeners) => {
      total += listeners.size;
    });

    this._gameListeners.forEach((listeners) => {
      total += listeners.size;
    });

    return total;
  }
}

// Singleton instance
let instance = null;

/**
 * Get or create the SocketManager singleton.
 */
export function getSocketManager() {
  if (!instance) {
    instance = new SocketManager();
  }
  return instance;
}

/**
 * Initialize the singleton with a socket.
 * @param {Object} socket - Socket.IO socket instance
 */
export function initializeSocketManager(socket) {
  const manager = getSocketManager();
  manager.initialize(socket);
  return manager;
}

/**
 * Reset the singleton (for testing).
 */
export function resetSocketManager() {
  if (instance) {
    instance.cleanupGameListeners();
    instance._globalListeners.clear();
    instance._stateListeners.clear();
  }
  instance = null;
}
