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

    // The first player opens a named lobby, the rest join it (the
    // matchmaking queue that used to do this is gone: V1_REMOVALS #2)
    function join(socketId) {
        const open = [...gameManager.lobbies.values()].find((l) => l.players.length < 4);
        return open ? gameManager.joinSpecificLobby(socketId, open.id) : gameManager.createNamedLobby(socketId);
    }

    describe('lobbies', () => {
        test('the first player opens a lobby', () => {
            gameManager.registerUser('socket1', 'player1');
            const result = join('socket1');
            expect(result.success).toBe(true);
            expect(result.lobby.players).toHaveLength(1);
            expect(result.lobby.name).toBe("player1's Game");
        });

        test('the next player joins it', () => {
            gameManager.registerUser('socket1', 'player1');
            gameManager.registerUser('socket2', 'player2');
            join('socket1');
            const result = join('socket2');
            expect(result.success).toBe(true);
            expect(result.lobby.players).toHaveLength(2);
        });

        test('prevents duplicate joins', () => {
            gameManager.registerUser('socket1', 'player1');
            const { lobby } = join('socket1');
            // the same lobby again (a re-sent join after a restore): that lobby, no second seat
            expect(gameManager.joinSpecificLobby('socket1', lobby.id)).toMatchObject({ success: true, alreadySeated: true });
            expect(lobby.players.filter((p) => p.socketId === 'socket1')).toHaveLength(1);
            gameManager.registerUser('socket9', 'player9');
            const other = gameManager.createNamedLobby('socket9');
            expect(gameManager.joinSpecificLobby('socket1', other.lobby.id)).toMatchObject({ success: false, error: 'Already in a lobby' });
            expect(gameManager.createNamedLobby('socket1')).toMatchObject({ success: false, error: 'Already in lobby' });
        });

        test('a full lobby takes no fifth player', () => {
            for (let i = 1; i <= 5; i++) gameManager.registerUser(`socket${i}`, `player${i}`);
            for (let i = 1; i <= 4; i++) join(`socket${i}`);
            const lobby = gameManager.getPlayerLobby('socket1');
            expect(lobby.players).toHaveLength(4);
            expect(gameManager.joinSpecificLobby('socket5', lobby.id).success).toBe(false);
        });

        test('prevents opening a lobby while in a game', () => {
            for (let i = 1; i <= 4; i++) gameManager.registerUser(`socket${i}`, `player${i}`);
            for (let i = 1; i <= 4; i++) join(`socket${i}`);
            const lobby = gameManager.getPlayerLobby('socket1');
            lobby.players.forEach(p => gameManager.setPlayerReady(p.socketId));
            gameManager.startGameFromLobby(lobby.id);
            expect(gameManager.createNamedLobby('socket1')).toMatchObject({ success: false, error: 'Already in game' });
        });

        test('the matchmaking queue is gone', () => {
            for (const k of ['joinQueue', 'leaveQueue', 'getQueueStatus', 'fillLobbyFromQueue', 'addPlayerToLobby']) {
                expect({ k, fn: typeof gameManager[k] }).toEqual({ k, fn: 'undefined' });
            }
            expect(gameManager.queue).toBeUndefined();
            expect(gameManager.queuedUsers).toBeUndefined();
        });
    });

    describe('leaveLobby', () => {
        test('removes player from lobby', () => {
            gameManager.registerUser('socket1', 'player1');
            join('socket1');
            const result = gameManager.leaveLobby('socket1');
            expect(result.success).toBe(true);
            expect(result.lobbyDeleted).toBe(true); // Last player, lobby deleted
        });

        test('returns error if not in lobby', () => {
            const result = gameManager.leaveLobby('nonexistent');
            expect(result.success).toBe(false);
        });

        test('lobby remains when other players exist', () => {
            gameManager.registerUser('socket1', 'player1');
            gameManager.registerUser('socket2', 'player2');
            join('socket1');
            join('socket2');
            const result = gameManager.leaveLobby('socket1');

            expect(result.success).toBe(true);
            expect(result.lobby.players).toHaveLength(1);
        });
    });

    // Helper to create a game through lobby system
    function createGameFromLobby() {
        gameManager.registerUser('socket1', 'player1');
        gameManager.registerUser('socket2', 'player2');
        gameManager.registerUser('socket3', 'player3');
        gameManager.registerUser('socket4', 'player4');
        join('socket1');
        join('socket2');
        join('socket3');
        join('socket4');

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
            gameManager.registerUser('socket1', 'player1');
            join('socket1');
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

            expect(socketIds).toHaveLength(0); // entrants only: no seats yet
            expect(gameManager.getGame(gameId)).toBeUndefined();
        });

        test('returns empty array for non-existent game', () => {
            const socketIds = gameManager.abortGame('nonexistent');
            expect(socketIds).toEqual([]);
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
