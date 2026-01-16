/**
 * Centralized socket connection management with lifecycle handling
 * Fixes memory leaks by tracking and cleaning up event listeners
 * Supports game reconnection via sessionStorage
 */
class SocketManager {
    constructor() {
        this.socket = null;
        this.listeners = new Map();  // event -> Set of handlers
        this.connectionState = 'disconnected';
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this._currentGameId = null;
    }

    /**
     * Initialize socket connection
     * @returns {Promise<void>}
     */
    connect() {
        if (this.socket?.connected) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            this.socket = io({
                reconnection: true,
                reconnectionAttempts: this.maxReconnectAttempts,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000
            });

            this.socket.on('connect', () => {
                this.connectionState = 'connected';
                this.reconnectAttempts = 0;
                console.log('Socket connected:', this.socket.id);

                // Attempt to rejoin game if we were in one
                this.attemptRejoin();

                resolve();
            });

            this.socket.on('disconnect', (reason) => {
                this.connectionState = 'disconnected';
                console.log('Socket disconnected:', reason);
                this.handleDisconnect(reason);
            });

            this.socket.on('connect_error', (error) => {
                this.reconnectAttempts++;
                console.error('Connection error:', error);
                if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                    reject(error);
                }
            });

            this.socket.on('reconnect_attempt', (attemptNumber) => {
                console.log(`Reconnection attempt ${attemptNumber}/${this.maxReconnectAttempts}`);
            });

            this.socket.on('reconnect_failed', () => {
                console.log('Reconnection failed after all attempts');
                this.clearGameId();
            });

            // Server error handler
            this.socket.on('error', (error) => {
                console.error('Server error:', error);
                this.handleServerError(error);
            });
        });
    }

    // ========================================
    // Game ID Management for Reconnection
    // ========================================

    /**
     * Store game ID for reconnection
     * @param {string} gameId
     */
    setGameId(gameId) {
        this._currentGameId = gameId;
        sessionStorage.setItem('gameId', gameId);
        console.log('Game ID stored:', gameId);
    }

    /**
     * Clear game ID (call when game ends)
     */
    clearGameId() {
        this._currentGameId = null;
        sessionStorage.removeItem('gameId');
        console.log('Game ID cleared');
    }

    /**
     * Get stored game ID
     * @returns {string|null}
     */
    getGameId() {
        if (!this._currentGameId) {
            this._currentGameId = sessionStorage.getItem('gameId');
        }
        return this._currentGameId;
    }

    /**
     * Get stored username
     * @returns {string|null}
     */
    getUsername() {
        return sessionStorage.getItem('username');
    }

    /**
     * Attempt to rejoin a game after reconnection
     */
    attemptRejoin() {
        const gameId = this.getGameId();
        const username = this.getUsername();

        if (gameId && username) {
            console.log(`Attempting to rejoin game ${gameId} as ${username}`);
            this.emit('rejoinGame', { gameId, username });
        }
    }

    /**
     * Handle server errors
     * @param {Object} error
     */
    handleServerError(error) {
        // Handle race condition where joinMainRoom is called before user is registered
        if (error.message === 'User not registered yet') {
            console.log('User not registered yet, retrying joinMainRoom in 100ms...');
            setTimeout(() => {
                this.emit('joinMainRoom');
            }, 100);
            return;
        }

        let message = 'Something went wrong';
        switch (error.type) {
            case 'VALIDATION_ERROR':
            case 'validation':
                message = error.message || 'Invalid input';
                break;
            case 'AUTH_ERROR':
                message = 'Please sign in again';
                break;
            case 'RATE_LIMIT_ERROR':
            case 'rateLimit':
                message = 'Too many requests. Please slow down.';
                break;
            case 'GAME_STATE_ERROR':
                message = error.message || 'Game error occurred';
                break;
            default:
                message = 'Server error. Please try again.';
                break;
        }

        this.showError(message);
    }

    /**
     * Show error toast notification
     * @param {string} message
     * @param {number} duration - Duration in ms
     */
    showError(message, duration = 5000) {
        const existing = document.querySelector('.error-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'error-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    /**
     * Register event listener with tracking for cleanup
     * @param {string} event - Event name
     * @param {Function} handler - Event handler
     * @returns {Function} - Cleanup function to remove this listener
     */
    on(event, handler) {
        if (!this.socket) {
            console.error('Socket not connected');
            return () => {};
        }

        // Track listener for cleanup
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(handler);

        // Attach to socket
        this.socket.on(event, handler);

        // Return cleanup function
        return () => this.off(event, handler);
    }

    /**
     * Remove specific event listener
     * @param {string} event - Event name
     * @param {Function} handler - Handler to remove
     */
    off(event, handler) {
        if (!this.socket) return;

        this.socket.off(event, handler);

        const handlers = this.listeners.get(event);
        if (handlers) {
            handlers.delete(handler);
        }
    }

    /**
     * Remove ALL listeners for an event
     * @param {string} event - Event name
     */
    offAll(event) {
        if (!this.socket) return;

        const handlers = this.listeners.get(event);
        if (handlers) {
            handlers.forEach(handler => {
                this.socket.off(event, handler);
            });
            handlers.clear();
        }
    }

    /**
     * Clean up all game-related listeners
     * Call this between games/hands to prevent memory leaks
     */
    cleanupGameListeners() {
        const gameEvents = [
            'cardPlayed', 'updateTurn', 'bidReceived', 'doneBidding',
            'trickComplete', 'handComplete', 'gameEnd', 'rainbow',
            'positionUpdate', 'opponentCards', 'gameStart', 'yourHand',
            'trumpCard', 'dealerPosition'
        ];

        gameEvents.forEach(event => this.offAll(event));
        console.log('Game listeners cleaned up');
    }

    /**
     * Emit event to server
     * @param {string} event - Event name
     * @param {*} data - Data to send
     * @returns {boolean} - Success status
     */
    emit(event, data) {
        if (!this.socket?.connected) {
            console.error('Cannot emit: socket not connected');
            return false;
        }
        this.socket.emit(event, data);
        return true;
    }

    /**
     * Handle disconnection based on reason
     * @param {string} reason - Disconnect reason
     */
    handleDisconnect(reason) {
        if (reason === 'io server disconnect') {
            // Server initiated disconnect, need to reconnect manually
            this.socket.connect();
        }
        // For other reasons, socket.io handles reconnection automatically
    }

    /**
     * Get socket ID
     * @returns {string|undefined}
     */
    get id() {
        return this.socket?.id;
    }

    /**
     * Check if connected
     * @returns {boolean}
     */
    get connected() {
        return this.socket?.connected || false;
    }

    /**
     * Get current listener count for debugging
     * @returns {Object} - Map of event -> listener count
     */
    getListenerCounts() {
        const counts = {};
        for (const [event, handlers] of this.listeners) {
            counts[event] = handlers.size;
        }
        return counts;
    }

    /**
     * Disconnect and cleanup everything
     */
    disconnect() {
        if (this.socket) {
            // Remove all tracked listeners
            for (const [event, handlers] of this.listeners) {
                handlers.forEach(handler => this.socket.off(event, handler));
            }
            this.listeners.clear();

            this.socket.disconnect();
            this.socket = null;
        }
        this.connectionState = 'disconnected';
    }
}

// Singleton instance
const socketManager = new SocketManager();
export default socketManager;
