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
        test('adds player to queue', () => {
            const result = gameManager.joinQueue('socket1');
            expect(result.success).toBe(true);
            expect(result.queuePosition).toBe(1);
        });

        test('increments queue position', () => {
            gameManager.joinQueue('socket1');
            const result = gameManager.joinQueue('socket2');
            expect(result.queuePosition).toBe(2);
        });

        test('prevents duplicate joins', () => {
            gameManager.joinQueue('socket1');
            const result = gameManager.joinQueue('socket1');
            expect(result.success).toBe(false);
            expect(result.error).toBe('Already in queue');
        });

        test('starts game when 4 players join', () => {
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            const result = gameManager.joinQueue('socket4');

            expect(result.gameStarted).toBe(true);
            expect(result.game).toBeDefined();
            expect(result.players).toHaveLength(4);
        });

        test('prevents joining if already in game', () => {
            // Join and start a game
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            gameManager.joinQueue('socket4');

            // Try to join again
            const result = gameManager.joinQueue('socket1');
            expect(result.success).toBe(false);
            expect(result.error).toBe('Already in game');
        });

        test('queue continues for 5th player', () => {
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            gameManager.joinQueue('socket4'); // Game starts

            const result = gameManager.joinQueue('socket5');
            expect(result.success).toBe(true);
            expect(result.gameStarted).toBe(false);
            expect(result.queuePosition).toBe(1);
        });
    });

    describe('leaveQueue', () => {
        test('removes player from queue', () => {
            gameManager.joinQueue('socket1');
            const result = gameManager.leaveQueue('socket1');
            expect(result.success).toBe(true);
        });

        test('returns false if not in queue', () => {
            const result = gameManager.leaveQueue('nonexistent');
            expect(result.success).toBe(false);
        });

        test('updates queue positions', () => {
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.leaveQueue('socket1');

            const status = gameManager.getQueueStatus();
            expect(status.size).toBe(1);
        });
    });

    describe('getPlayerGame', () => {
        test('returns game for player in game', () => {
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            gameManager.joinQueue('socket4');

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
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            const result = gameManager.joinQueue('socket4');

            const gameId = gameManager.getPlayerGameId('socket1');
            expect(gameId).toBe(result.game.gameId);
        });

        test('returns undefined for player not in game', () => {
            const gameId = gameManager.getPlayerGameId('nonexistent');
            expect(gameId).toBeUndefined();
        });
    });

    describe('handleDisconnect', () => {
        test('removes from queue on disconnect', () => {
            gameManager.joinQueue('socket1');
            const result = gameManager.handleDisconnect('socket1');

            expect(result.wasInQueue).toBe(true);
            expect(gameManager.getQueueStatus().size).toBe(0);
        });

        test('returns wasInGame when in game', () => {
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            gameManager.joinQueue('socket4');

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
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            const result = gameManager.joinQueue('socket4');

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
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            const result = gameManager.joinQueue('socket4');

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
        test('returns correct queue size', () => {
            const status1 = gameManager.getQueueStatus();
            expect(status1.size).toBe(0);

            gameManager.joinQueue('socket1');
            const status2 = gameManager.getQueueStatus();
            expect(status2.size).toBe(1);
        });

        test('includes queued users with usernames', () => {
            gameManager.registerUser('socket1', 'player1');
            gameManager.joinQueue('socket1');

            const status = gameManager.getQueueStatus();
            expect(status.queuedUsers).toHaveLength(1);
            expect(status.queuedUsers[0].username).toBe('player1');
        });
    });

    describe('updatePlayerGameMapping', () => {
        test('updates socket ID mapping', () => {
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            const result = gameManager.joinQueue('socket4');

            const gameId = result.game.gameId;
            gameManager.updatePlayerGameMapping('socket1', 'newSocket1', gameId);

            expect(gameManager.getPlayerGameId('socket1')).toBeUndefined();
            expect(gameManager.getPlayerGameId('newSocket1')).toBe(gameId);
        });
    });

    describe('getGameById', () => {
        test('returns game when found', () => {
            gameManager.joinQueue('socket1');
            gameManager.joinQueue('socket2');
            gameManager.joinQueue('socket3');
            const result = gameManager.joinQueue('socket4');

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
