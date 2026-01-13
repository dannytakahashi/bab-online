/**
 * Centralized socket connection management with lifecycle handling
 * Fixes memory leaks by tracking and cleaning up event listeners
 */
class SocketManager {
    constructor() {
        this.socket = null;
        this.listeners = new Map();  // event -> Set of handlers
        this.connectionState = 'disconnected';
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
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
                reconnectionDelay: 1000
            });

            this.socket.on('connect', () => {
                this.connectionState = 'connected';
                this.reconnectAttempts = 0;
                console.log('Socket connected:', this.socket.id);
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
        });
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
