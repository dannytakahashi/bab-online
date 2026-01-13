/**
 * Manages game queue and active game instances
 * Singleton pattern for server-wide coordination
 */

const { v4: uuidv4 } = require('uuid');
const GameState = require('./GameState');

class GameManager {
    constructor() {
        // Queue of players waiting for a game
        this.queue = [];
        this.queuedUsers = [];

        // Active games
        this.games = new Map();        // gameId → GameState
        this.playerGames = new Map();  // socketId → gameId

        // Current users (logged in)
        this.currentUsers = [];        // [{ username, socketId }, ...]
    }

    /**
     * Register a logged-in user
     */
    registerUser(socketId, username) {
        // Remove any existing entry for this username
        this.currentUsers = this.currentUsers.filter(u => u.username !== username);
        this.currentUsers.push({ username, socketId });
    }

    /**
     * Get user by socket ID
     */
    getUserBySocketId(socketId) {
        return this.currentUsers.find(u => u.socketId === socketId);
    }

    /**
     * Add player to matchmaking queue
     */
    joinQueue(socketId) {
        // Check if already in queue
        if (this.queue.includes(socketId)) {
            return { success: false, error: 'Already in queue' };
        }

        // Check if already in game
        if (this.playerGames.has(socketId)) {
            return { success: false, error: 'Already in game' };
        }

        this.queue.push(socketId);

        // Add to queuedUsers for display
        const user = this.getUserBySocketId(socketId);
        if (user) {
            this.queuedUsers.push(user);
        }

        // Check if we have enough players to start
        if (this.queue.length >= 4) {
            const players = this.queue.splice(0, 4);
            const game = this.createGame(players);
            return {
                success: true,
                gameStarted: true,
                game,
                players
            };
        }

        return {
            success: true,
            gameStarted: false,
            queuePosition: this.queue.length,
            queuedUsers: this.queuedUsers
        };
    }

    /**
     * Remove player from queue
     */
    leaveQueue(socketId) {
        const index = this.queue.indexOf(socketId);
        if (index !== -1) {
            this.queue.splice(index, 1);
            this.queuedUsers = this.queuedUsers.filter(u => u.socketId !== socketId);
            return { success: true, queuedUsers: this.queuedUsers };
        }
        return { success: false };
    }

    /**
     * Create new game with players
     */
    createGame(playerSocketIds) {
        const gameId = uuidv4();
        const game = new GameState(gameId);

        playerSocketIds.forEach((socketId) => {
            this.playerGames.set(socketId, gameId);
        });

        // Store socket IDs for later position assignment
        game.pendingPlayers = playerSocketIds;

        this.games.set(gameId, game);

        // Clear queued users who are now in game
        this.queuedUsers = this.queuedUsers.filter(
            u => !playerSocketIds.includes(u.socketId)
        );

        return game;
    }

    /**
     * Get game by ID
     */
    getGame(gameId) {
        return this.games.get(gameId);
    }

    /**
     * Get game that player is in
     */
    getPlayerGame(socketId) {
        const gameId = this.playerGames.get(socketId);
        return gameId ? this.games.get(gameId) : null;
    }

    /**
     * Get game ID for a player
     */
    getPlayerGameId(socketId) {
        return this.playerGames.get(socketId);
    }

    /**
     * Update player-game mapping when a player reconnects with new socket
     * @param {string} oldSocketId - Previous socket ID
     * @param {string} newSocketId - New socket ID
     * @param {string} gameId - Game ID
     */
    updatePlayerGameMapping(oldSocketId, newSocketId, gameId) {
        this.playerGames.delete(oldSocketId);
        this.playerGames.set(newSocketId, gameId);
    }

    /**
     * Find game by ID (for reconnection)
     * @param {string} gameId - Game ID to find
     * @returns {GameState|null}
     */
    getGameById(gameId) {
        return this.games.get(gameId) || null;
    }

    /**
     * Handle player disconnect - now with grace period for reconnection
     */
    handleDisconnect(socketId) {
        // Remove from queue (if in queue, not in game)
        const wasInQueue = this.leaveQueue(socketId).success;

        // Handle in-game disconnect - DON'T immediately abort
        const gameId = this.playerGames.get(socketId);
        if (gameId) {
            const game = this.games.get(gameId);
            if (game) {
                // Mark player as disconnected but keep their spot
                const position = game.getPositionBySocketId(socketId);
                if (position) {
                    game.markPlayerDisconnected(position);
                }
            }
            return {
                wasInQueue,
                wasInGame: true,
                game,
                gameId,
                // Don't abort immediately - give time to reconnect
                shouldAbort: false
            };
        }

        // Only remove from currentUsers if not in a game
        this.currentUsers = this.currentUsers.filter(u => u.socketId !== socketId);

        return { wasInQueue, wasInGame: false, queuedUsers: this.queuedUsers };
    }

    /**
     * Check if game should be aborted (called after grace period)
     */
    checkGameAbort(gameId) {
        const game = this.games.get(gameId);
        if (!game) return { shouldAbort: false };

        // Check if any player has been disconnected too long
        const disconnectedPlayers = game.getDisconnectedPlayers();
        if (disconnectedPlayers.length > 0) {
            return { shouldAbort: true, game, gameId };
        }
        return { shouldAbort: false };
    }

    /**
     * End and cleanup a game
     */
    endGame(gameId) {
        const game = this.games.get(gameId);
        if (!game) return;

        // Remove player mappings
        for (const socketId of game.players.keys()) {
            this.playerGames.delete(socketId);
        }

        this.games.delete(gameId);
    }

    /**
     * Abort a game (player disconnected mid-game)
     */
    abortGame(gameId) {
        const game = this.games.get(gameId);
        if (!game) return [];

        const socketIds = game.getSocketIds();

        // Remove player mappings
        for (const socketId of socketIds) {
            this.playerGames.delete(socketId);
        }

        this.games.delete(gameId);

        return socketIds;
    }

    /**
     * Get queue status
     */
    getQueueStatus() {
        return {
            size: this.queue.length,
            queuedUsers: this.queuedUsers
        };
    }
}

// Singleton instance
const gameManager = new GameManager();

module.exports = gameManager;
