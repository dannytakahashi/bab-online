/**
 * Manages game queue and active game instances
 * Singleton pattern for server-wide coordination
 */

const { v4: uuidv4 } = require('uuid');
const GameState = require('./GameState');
const { getUsersCollection } = require('../database');
const { botController, BotPlayer } = require('./bot');

class GameManager {
    constructor() {
        // Queue of players waiting for a game
        this.queue = [];
        this.queuedUsers = [];

        // Main room (global chat + lobby browser)
        this.mainRoomMessages = [];       // Global chat history (capped at MAX_MAIN_ROOM_MESSAGES)
        this.mainRoomSocketIds = new Set(); // Players currently in main room

        // Lobbies (pre-game waiting rooms)
        this.lobbies = new Map();      // lobbyId → { players: [], readyPlayers: Set, messages: [] }
        this.playerLobbies = new Map(); // socketId → lobbyId

        // Active games
        this.games = new Map();        // gameId → GameState
        this.playerGames = new Map();  // socketId → gameId

        // Current users (logged in)
        this.currentUsers = [];        // [{ username, socketId }, ...]
    }

    // Constants
    static MAX_MAIN_ROOM_MESSAGES = 50;

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

        // Verify user is registered (prevents race condition with auth)
        const user = this.getUserBySocketId(socketId);
        if (!user) {
            return { success: false, error: 'User not registered yet' };
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

    // ==================== MAIN ROOM METHODS ====================

    /**
     * Add player to main room
     */
    joinMainRoom(socketId) {
        // Validate user is registered
        const user = this.getUserBySocketId(socketId);
        if (!user) {
            return { success: false, error: 'User not registered yet' };
        }

        // Remove from lobby if in one
        if (this.playerLobbies.has(socketId)) {
            this.leaveLobby(socketId);
        }

        this.mainRoomSocketIds.add(socketId);

        return {
            success: true,
            messages: this.mainRoomMessages,
            lobbies: this.getAllLobbies(),
            onlineCount: this.mainRoomSocketIds.size,
            username: user.username
        };
    }

    /**
     * Remove player from main room
     */
    leaveMainRoom(socketId) {
        this.mainRoomSocketIds.delete(socketId);
        return { success: true };
    }

    /**
     * Check if player is in main room
     */
    isInMainRoom(socketId) {
        return this.mainRoomSocketIds.has(socketId);
    }

    /**
     * Add message to main room chat
     */
    addMainRoomMessage(socketId, message) {
        const user = this.getUserBySocketId(socketId);
        if (!user) return { success: false, error: 'User not found' };

        const chatMessage = {
            username: user.username,
            message,
            timestamp: Date.now()
        };

        this.mainRoomMessages.push(chatMessage);

        // Cap message history
        if (this.mainRoomMessages.length > GameManager.MAX_MAIN_ROOM_MESSAGES) {
            this.mainRoomMessages.shift();
        }

        return { success: true, chatMessage };
    }

    /**
     * Get all socket IDs in main room
     */
    getMainRoomSocketIds() {
        return Array.from(this.mainRoomSocketIds);
    }

    /**
     * Get all lobbies for display
     */
    getAllLobbies() {
        const lobbies = [];
        for (const [lobbyId, lobby] of this.lobbies) {
            lobbies.push({
                id: lobbyId,
                name: lobby.name || `${lobby.players[0]?.username || 'Unknown'}'s Game`,
                playerCount: lobby.players.length,
                maxPlayers: 4,
                players: lobby.players.map(p => ({
                    username: p.username,
                    ready: p.ready
                })),
                createdAt: lobby.createdAt
            });
        }
        return lobbies;
    }

    /**
     * Create a named lobby from main room
     */
    createNamedLobby(socketId, name = null) {
        // Check if already in lobby
        if (this.playerLobbies.has(socketId)) {
            return { success: false, error: 'Already in lobby' };
        }

        // Check if already in game
        if (this.playerGames.has(socketId)) {
            return { success: false, error: 'Already in game' };
        }

        const user = this.getUserBySocketId(socketId);
        if (!user) {
            return { success: false, error: 'User not found' };
        }

        // Leave main room
        this.leaveMainRoom(socketId);

        const lobbyId = uuidv4();
        const lobby = {
            id: lobbyId,
            name: name || `${user.username}'s Game`,
            players: [{
                socketId,
                username: user.username,
                ready: false
            }],
            readyPlayers: new Set(),
            messages: [],
            createdAt: Date.now(),
            createdBy: user.username
        };

        this.lobbies.set(lobbyId, lobby);
        this.playerLobbies.set(socketId, lobbyId);

        return { success: true, lobby };
    }

    /**
     * Join a specific lobby by ID
     */
    joinSpecificLobby(socketId, lobbyId) {
        // Check if already in a lobby
        if (this.playerLobbies.has(socketId)) {
            return { success: false, error: 'Already in a lobby' };
        }

        // Check if already in game
        if (this.playerGames.has(socketId)) {
            return { success: false, error: 'Already in game' };
        }

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) {
            return { success: false, error: 'Lobby not found' };
        }

        if (lobby.players.length >= 4) {
            return { success: false, error: 'Lobby is full' };
        }

        const user = this.getUserBySocketId(socketId);
        if (!user) {
            return { success: false, error: 'User not found' };
        }

        // Leave main room
        this.leaveMainRoom(socketId);

        const newPlayer = {
            socketId,
            username: user.username,
            ready: false
        };

        lobby.players.push(newPlayer);
        this.playerLobbies.set(socketId, lobbyId);

        return { success: true, lobby, newPlayer };
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

    // ==================== BOT METHODS ====================

    /**
     * Check if a socketId belongs to a bot
     * @param {string} socketId
     * @returns {boolean}
     */
    isBot(socketId) {
        return BotPlayer.isBot(socketId);
    }

    /**
     * Add a bot to a lobby
     * @param {string} lobbyId - Lobby to add bot to
     * @param {string} botName - Bot username (default: "Mary")
     * @returns {Object} - { success, botPlayer, lobby, error? }
     */
    addBotToLobby(lobbyId, botName = '🤖 Mary') {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) {
            return { success: false, error: 'Lobby not found' };
        }

        if (lobby.players.length >= 4) {
            return { success: false, error: 'Lobby is full' };
        }

        // Count existing bots with same base name to add numbering
        const existingBots = lobby.players.filter(p =>
            p.isBot && p.username.startsWith(botName)
        );
        const botNumber = existingBots.length + 1;
        const finalBotName = botNumber > 1 ? `${botName} ${botNumber}` : botName;

        // Create a new bot with unique name
        const bot = botController.createBot(finalBotName);

        // Add bot to lobby as a player
        const botPlayer = {
            socketId: bot.socketId,
            username: bot.username,
            ready: false,
            isBot: true
        };

        lobby.players.push(botPlayer);
        // Don't add to playerLobbies since bots don't have real sockets

        return { success: true, botPlayer, lobby, bot };
    }

    /**
     * Remove a bot from a lobby
     * @param {string} lobbyId - Lobby ID
     * @param {string} botSocketId - Bot's socket ID
     * @returns {Object} - { success, lobby, error? }
     */
    removeBotFromLobby(lobbyId, botSocketId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) {
            return { success: false, error: 'Lobby not found' };
        }

        const botIndex = lobby.players.findIndex(p => p.socketId === botSocketId);
        if (botIndex === -1) {
            return { success: false, error: 'Bot not found in lobby' };
        }

        // Remove bot
        lobby.players.splice(botIndex, 1);
        lobby.readyPlayers.delete(botSocketId);

        // Reset all ready states when someone leaves
        lobby.readyPlayers.clear();
        lobby.players.forEach(p => p.ready = false);

        return { success: true, lobby };
    }

    /**
     * Set all bots in a lobby as ready
     * @param {string} lobbyId - Lobby ID
     */
    setBotsReady(lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return;

        for (const player of lobby.players) {
            if (player.isBot && !player.ready) {
                player.ready = true;
                lobby.readyPlayers.add(player.socketId);
            }
        }
    }

    // ==================== END BOT METHODS ====================

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
        // Remove from main room (if in main room)
        const wasInMainRoom = this.mainRoomSocketIds.has(socketId);
        this.leaveMainRoom(socketId);

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
                wasInMainRoom,
                wasInGame: true,
                game,
                gameId,
                // Don't abort immediately - give time to reconnect
                shouldAbort: false
            };
        }

        // Only remove from currentUsers if not in a game
        this.currentUsers = this.currentUsers.filter(u => u.socketId !== socketId);

        return { wasInLobby, wasInMainRoom, wasInGame: false, lobby: lobbyResult.lobby };
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

    // ==================== ACTIVE GAME TRACKING ====================

    /**
     * Set active game for a user in the database
     * Called when a game starts
     */
    async setActiveGame(username, gameId) {
        try {
            const usersCollection = getUsersCollection();
            if (!usersCollection) return;

            await usersCollection.updateOne(
                { username },
                { $set: { activeGameId: gameId, activeGameStartedAt: new Date() } }
            );
        } catch (error) {
            console.error('Failed to set active game:', error);
        }
    }

    /**
     * Clear active game for a user in the database
     * Called when a game ends or is aborted
     */
    async clearActiveGame(username) {
        try {
            const usersCollection = getUsersCollection();
            if (!usersCollection) return;

            await usersCollection.updateOne(
                { username },
                { $unset: { activeGameId: '', activeGameStartedAt: '' } }
            );
        } catch (error) {
            console.error('Failed to clear active game:', error);
        }
    }

    /**
     * Get active game for a user from the database
     */
    async getActiveGame(username) {
        try {
            const usersCollection = getUsersCollection();
            if (!usersCollection) return null;

            const user = await usersCollection.findOne({ username });
            return user?.activeGameId || null;
        } catch (error) {
            console.error('Failed to get active game:', error);
            return null;
        }
    }

    /**
     * Clear active game for all players in a game
     */
    async clearActiveGameForAll(gameId) {
        const game = this.games.get(gameId);
        if (!game) return;

        for (const [socketId, player] of game.players.entries()) {
            if (player.username) {
                await this.clearActiveGame(player.username);
            }
        }
    }
}

// Singleton instance
const gameManager = new GameManager();

module.exports = gameManager;
