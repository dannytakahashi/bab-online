/**
 * Unit tests for GameManager
 * Note: GameManager is a singleton, so we need to reset between tests
 */

// Store original module
let gameManager;

beforeEach(() => {
    // Clear module cache to get fresh instance
    jest.resetModules();
    gameManager = require('../GameManager');
});

describe('GameManager', () => {
    describe('registerUser', () => {
        test('registers a new user', () => {
            gameManager.registerUser('socket1', 'player1');
            const user = gameManager.getUserBySocketId('socket1');
            expect(user).toBeDefined();
            expect(user.username).toBe('player1');
        });

        test('replaces existing user with same username', () => {
            gameManager.registerUser('socket1', 'player1');
            gameManager.registerUser('socket2', 'player1');

            const userByOldSocket = gameManager.getUserBySocketId('socket1');
            const userByNewSocket = gameManager.getUserBySocketId('socket2');

            expect(userByOldSocket).toBeUndefined();
            expect(userByNewSocket).toBeDefined();
            expect(userByNewSocket.username).toBe('player1');
        });
    });

    describe('getUserBySocketId', () => {
        test('returns user when found', () => {
            gameManager.registerUser('socket1', 'player1');
            const user = gameManager.getUserBySocketId('socket1');
            expect(user.username).toBe('player1');
        });

        test('returns undefined when not found', () => {
            const user = gameManager.getUserBySocketId('nonexistent');
            expect(user).toBeUndefined();
        });
    });

    describe('joinQueue', () => {
        test('creates lobby immediately for first player', () => {
            const result = gameManager.joinQueue('socket1');
            expect(result.success).toBe(true);
            expect(result.lobbyCreated).toBe(true);
            expect(result.lobby).toBeDefined();
            expect(result.lobby.players).toHaveLength(1);
        });

        test('subsequent players join existing lobby', () => {
            gameManager.joinQueue('socket1');
            const result = gameManager.joinQueue('socket2');
            expect(result.success).toBe(true);
            expect(result.joinedExisting).toBe(true);
            expect(result.lobby.players).toHaveLength(2);
        });

        test('prevents duplicate joins', () => {
            gameManager.joinQueue('socket1');
            const result = gameManager.joinQueue('socket1');
            expect(result.success).toBe(false);
            expect(result.error).toBe('Already in lobby');
        });

        test('lobby fills with 4 players', () => {
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            const result = gameManager.joinQueue('socket4');

            expect(result.success).toBe(true);
            expect(result.lobby.players).toHaveLength(4);
        });

        test('prevents joining if already in game', () => {
            // Create lobby with 4 players
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            gameManager.joinQueue('socket4');

            // Start game from lobby
            const lobby = gameManager.getPlayerLobby('socket1');
            lobby.players.forEach(p => gameManager.setPlayerReady(p.socketId));
            gameManager.startGameFromLobby(lobby.id);

            // Try to join again
            const result = gameManager.joinQueue('socket1');
            expect(result.success).toBe(false);
            expect(result.error).toBe('Already in game');
        });

        test('5th player creates new lobby', () => {
            // Fill first lobby
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            gameManager.joinQueue('socket4');

            // 5th player creates new lobby
            const result = gameManager.joinQueue('socket5');
            expect(result.success).toBe(true);
            expect(result.lobbyCreated).toBe(true);
            expect(result.lobby.players).toHaveLength(1);
        });
    });

    describe('leaveLobby', () => {
        test('removes player from lobby', () => {
            gameManager.joinQueue('socket1');
            const result = gameManager.leaveLobby('socket1');
            expect(result.success).toBe(true);
            expect(result.lobbyDeleted).toBe(true); // Last player, lobby deleted
        });

        test('returns error if not in lobby', () => {
            const result = gameManager.leaveLobby('nonexistent');
            expect(result.success).toBe(false);
        });

        test('lobby remains when other players exist', () => {
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            const result = gameManager.leaveLobby('socket1');

            expect(result.success).toBe(true);
            expect(result.lobby.players).toHaveLength(1);
        });
    });

    // Helper to create a game through lobby system
    function createGameFromLobby() {
        gameManager.joinQueue('socket1');
        gameManager.joinQueue('socket2');
        gameManager.joinQueue('socket3');
        gameManager.joinQueue('socket4');

        const lobby = gameManager.getPlayerLobby('socket1');
        lobby.players.forEach(p => gameManager.setPlayerReady(p.socketId));
        return gameManager.startGameFromLobby(lobby.id);
    }

    describe('getPlayerGame', () => {
        test('returns game for player in game', () => {
            createGameFromLobby();

            const game = gameManager.getPlayerGame('socket1');
            expect(game).toBeDefined();
        });

        test('returns null for player not in game', () => {
            const game = gameManager.getPlayerGame('nonexistent');
            expect(game).toBeNull();
        });
    });

    describe('getPlayerGameId', () => {
        test('returns game ID for player in game', () => {
            const result = createGameFromLobby();

            const gameId = gameManager.getPlayerGameId('socket1');
            expect(gameId).toBe(result.game.gameId);
        });

        test('returns undefined for player not in game', () => {
            const gameId = gameManager.getPlayerGameId('nonexistent');
            expect(gameId).toBeUndefined();
        });
    });

    describe('handleDisconnect', () => {
        test('removes from lobby on disconnect', () => {
            gameManager.joinQueue('socket1');
            const result = gameManager.handleDisconnect('socket1');

            expect(result.wasInLobby).toBe(true);
        });

        test('returns wasInGame when in game', () => {
            createGameFromLobby();

            const result = gameManager.handleDisconnect('socket1');
            expect(result.wasInGame).toBe(true);
            expect(result.shouldAbort).toBe(false); // Has grace period
        });

        test('returns wasInGame: false when not in game', () => {
            const result = gameManager.handleDisconnect('nonexistent');
            expect(result.wasInGame).toBe(false);
        });
    });

    describe('endGame', () => {
        test('removes game from games map', () => {
            const result = createGameFromLobby();

            const gameId = result.game.gameId;
            gameManager.endGame(gameId);

            // Game should be removed
            expect(gameManager.getGame(gameId)).toBeUndefined();
        });

        test('handles non-existent game', () => {
            // Should not throw
            gameManager.endGame('nonexistent');
        });
    });

    describe('abortGame', () => {
        test('removes game and returns socket IDs', () => {
            const result = createGameFromLobby();

            const gameId = result.game.gameId;
            const socketIds = gameManager.abortGame(gameId);

            expect(socketIds).toHaveLength(0); // pendingPlayers not yet assigned
            expect(gameManager.getGame(gameId)).toBeUndefined();
        });

        test('returns empty array for non-existent game', () => {
            const socketIds = gameManager.abortGame('nonexistent');
            expect(socketIds).toEqual([]);
        });
    });

    describe('getQueueStatus', () => {
        test('returns correct queue size (always 0 with lobby system)', () => {
            const status1 = gameManager.getQueueStatus();
            expect(status1.size).toBe(0);

            // Players now go directly to lobbies, not queue
            gameManager.joinQueue('socket1');
            const status2 = gameManager.getQueueStatus();
            expect(status2.size).toBe(0); // Queue is empty, player is in lobby
        });

        test('queuedUsers is empty with lobby system', () => {
            gameManager.registerUser('socket1', 'player1');
            gameManager.joinQueue('socket1');

            const status = gameManager.getQueueStatus();
            expect(status.queuedUsers).toHaveLength(0); // Players go to lobbies now
        });
    });

    describe('updatePlayerGameMapping', () => {
        test('updates socket ID mapping', () => {
            const result = createGameFromLobby();

            const gameId = result.game.gameId;
            gameManager.updatePlayerGameMapping('socket1', 'newSocket1', gameId);

            expect(gameManager.getPlayerGameId('socket1')).toBeUndefined();
            expect(gameManager.getPlayerGameId('newSocket1')).toBe(gameId);
        });
    });

    describe('getGameById', () => {
        test('returns game when found', () => {
            const result = createGameFromLobby();

            const game = gameManager.getGameById(result.game.gameId);
            expect(game).toBeDefined();
            expect(game.gameId).toBe(result.game.gameId);
        });

        test('returns null when not found', () => {
            const game = gameManager.getGameById('nonexistent');
            expect(game).toBeNull();
        });
    });
});
