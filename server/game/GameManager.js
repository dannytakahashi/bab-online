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

        // Lobbies (pre-game waiting rooms)
        this.lobbies = new Map();      // lobbyId → { players: [], readyPlayers: Set, messages: [] }
        this.playerLobbies = new Map(); // socketId → lobbyId

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
     * Add player to lobby (creates one immediately or joins existing)
     */
    joinQueue(socketId) {
        // Check if already in lobby
        if (this.playerLobbies.has(socketId)) {
            return { success: false, error: 'Already in lobby' };
        }

        // Check if already in game
        if (this.playerGames.has(socketId)) {
            return { success: false, error: 'Already in game' };
        }

        // Find an existing open lobby (less than 4 players)
        let openLobby = null;
        for (const [lobbyId, lobby] of this.lobbies) {
            if (lobby.players.length < 4) {
                openLobby = lobby;
                break;
            }
        }

        if (openLobby) {
            // Join existing lobby
            const result = this.addPlayerToLobby(socketId, openLobby.id);
            return {
                success: true,
                lobbyCreated: false,
                joinedExisting: true,
                lobby: openLobby,
                players: openLobby.players.map(p => p.socketId)
            };
        } else {
            // Create new lobby with just this player
            const lobby = this.createLobby([socketId]);
            return {
                success: true,
                lobbyCreated: true,
                lobby,
                players: [socketId]
            };
        }
    }

    /**
     * Add a player to an existing lobby
     */
    addPlayerToLobby(socketId, lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };
        if (lobby.players.length >= 4) return { success: false, error: 'Lobby is full' };

        const user = this.getUserBySocketId(socketId);
        const newPlayer = {
            socketId,
            username: user?.username || 'Unknown',
            ready: false
        };

        lobby.players.push(newPlayer);
        this.playerLobbies.set(socketId, lobbyId);

        return { success: true, lobby, newPlayer };
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

    // ==================== LOBBY METHODS ====================

    /**
     * Create a new lobby with 4 players
     */
    createLobby(playerSocketIds) {
        const lobbyId = uuidv4();
        const players = playerSocketIds.map(socketId => {
            const user = this.getUserBySocketId(socketId);
            return {
                socketId,
                username: user?.username || 'Unknown',
                ready: false
            };
        });

        const lobby = {
            id: lobbyId,
            players,
            readyPlayers: new Set(),
            messages: [],
            createdAt: Date.now()
        };

        this.lobbies.set(lobbyId, lobby);

        // Map each player to this lobby
        playerSocketIds.forEach(socketId => {
            this.playerLobbies.set(socketId, lobbyId);
        });

        // Clear queued users who are now in lobby
        this.queuedUsers = this.queuedUsers.filter(
            u => !playerSocketIds.includes(u.socketId)
        );

        return lobby;
    }

    /**
     * Get lobby a player is in
     */
    getPlayerLobby(socketId) {
        const lobbyId = this.playerLobbies.get(socketId);
        return lobbyId ? this.lobbies.get(lobbyId) : null;
    }

    /**
     * Get lobby by ID
     */
    getLobbyById(lobbyId) {
        return this.lobbies.get(lobbyId);
    }

    /**
     * Mark player as ready in lobby
     * Returns { allReady, lobby } if successful
     */
    setPlayerReady(socketId) {
        const lobbyId = this.playerLobbies.get(socketId);
        if (!lobbyId) return { success: false, error: 'Not in a lobby' };

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        // Mark player as ready
        lobby.readyPlayers.add(socketId);
        const player = lobby.players.find(p => p.socketId === socketId);
        if (player) player.ready = true;

        // Check if all players are ready
        const allReady = lobby.readyPlayers.size === 4;

        return { success: true, allReady, lobby };
    }

    /**
     * Unset player ready status in their current lobby
     */
    unsetPlayerReady(socketId) {
        const lobbyId = this.playerLobbies.get(socketId);
        if (!lobbyId) return { success: false, error: 'Not in a lobby' };

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        // Mark player as not ready
        lobby.readyPlayers.delete(socketId);
        const player = lobby.players.find(p => p.socketId === socketId);
        if (player) player.ready = false;

        return { success: true, lobby };
    }

    /**
     * Add chat message to lobby
     */
    addLobbyMessage(socketId, message) {
        const lobbyId = this.playerLobbies.get(socketId);
        if (!lobbyId) return { success: false, error: 'Not in a lobby' };

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        const user = this.getUserBySocketId(socketId);
        const chatMessage = {
            username: user?.username || 'Unknown',
            message,
            timestamp: Date.now()
        };

        lobby.messages.push(chatMessage);

        return { success: true, lobby, chatMessage };
    }

    /**
     * Handle player leaving lobby
     * Returns remaining players or null if lobby should be dissolved
     */
    leaveLobby(socketId) {
        const lobbyId = this.playerLobbies.get(socketId);
        if (!lobbyId) return { success: false, error: 'Not in a lobby' };

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        // Remove player from lobby
        lobby.players = lobby.players.filter(p => p.socketId !== socketId);
        lobby.readyPlayers.delete(socketId);
        this.playerLobbies.delete(socketId);

        // If lobby is now empty, delete it
        if (lobby.players.length === 0) {
            this.lobbies.delete(lobbyId);
            return {
                success: true,
                lobby: null,
                lobbyDeleted: true,
                playerLeft: socketId
            };
        }

        // Reset all ready states when someone leaves
        lobby.readyPlayers.clear();
        lobby.players.forEach(p => p.ready = false);

        return {
            success: true,
            lobby,
            playerLeft: socketId,
            needsMorePlayers: lobby.players.length < 4
        };
    }

    /**
     * Try to fill an empty lobby slot from the queue
     */
    fillLobbyFromQueue(lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby || lobby.players.length >= 4) return null;

        // Get next player from queue
        if (this.queue.length === 0) return null;

        const socketId = this.queue.shift();
        const user = this.getUserBySocketId(socketId);

        // Remove from queuedUsers
        this.queuedUsers = this.queuedUsers.filter(u => u.socketId !== socketId);

        // Add to lobby
        lobby.players.push({
            socketId,
            username: user?.username || 'Unknown',
            ready: false
        });
        this.playerLobbies.set(socketId, lobbyId);

        return { socketId, username: user?.username };
    }

    /**
     * Convert lobby to game when all players are ready
     */
    startGameFromLobby(lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        if (lobby.readyPlayers.size !== 4) {
            return { success: false, error: 'Not all players ready' };
        }

        // Get player socket IDs
        const playerSocketIds = lobby.players.map(p => p.socketId);

        // Remove lobby mappings
        playerSocketIds.forEach(socketId => {
            this.playerLobbies.delete(socketId);
        });
        this.lobbies.delete(lobbyId);

        // Create the actual game
        const game = this.createGame(playerSocketIds);

        return { success: true, game, players: playerSocketIds };
    }

    // ==================== END LOBBY METHODS ====================

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
        // Remove from lobby (if in lobby, not in game)
        const lobbyResult = this.leaveLobby(socketId);
        const wasInLobby = lobbyResult.success;

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
                wasInLobby,
                wasInGame: true,
                game,
                gameId,
                // Don't abort immediately - give time to reconnect
                shouldAbort: false
            };
        }

        // Only remove from currentUsers if not in a game
        this.currentUsers = this.currentUsers.filter(u => u.socketId !== socketId);

        return { wasInLobby, wasInGame: false, lobby: lobbyResult.lobby };
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
