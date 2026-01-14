/**
 * Queue management socket event handlers
 */

const gameManager = require('../game/GameManager');
const Deck = require('../game/Deck');
const { delay } = require('../utils/timing');
const { socketLogger } = require('../utils/logger');

async function joinQueue(socket, io) {
    const result = gameManager.joinQueue(socket.id);

    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
    }

    const lobby = result.lobby;
    socketLogger.info('Player joined lobby', {
        socketId: socket.id,
        lobbyId: lobby.id,
        playerCount: lobby.players.length,
        isNewLobby: result.lobbyCreated
    });

    if (result.lobbyCreated) {
        // New lobby created - send lobbyCreated to the joining player
        socket.emit('lobbyCreated', {
            lobbyId: lobby.id,
            players: lobby.players,
            messages: lobby.messages
        });
    } else if (result.joinedExisting) {
        // Joined existing lobby - send lobbyCreated to the new player
        socket.emit('lobbyCreated', {
            lobbyId: lobby.id,
            players: lobby.players,
            messages: lobby.messages
        });

        // Notify existing players that someone joined
        lobby.players.forEach(player => {
            if (player.socketId !== socket.id) {
                io.to(player.socketId).emit('lobbyPlayerJoined', {
                    lobbyId: lobby.id,
                    players: lobby.players,
                    newPlayer: {
                        socketId: socket.id,
                        username: lobby.players.find(p => p.socketId === socket.id)?.username
                    }
                });
            }
        });
    }
}

function leaveQueue(socket, io) {
    const result = gameManager.leaveQueue(socket.id);

    if (result.success) {
        io.emit('queueUpdate', { queuedUsers: result.queuedUsers });
    }
}

// Track pending abort timers by gameId
const pendingAbortTimers = new Map();

// Grace period for reconnection (30 seconds)
const RECONNECT_GRACE_PERIOD = 30000;

function handleDisconnect(socket, io) {
    const result = gameManager.handleDisconnect(socket.id);

    // Update queue display
    io.emit('queueUpdate', { queuedUsers: gameManager.getQueueStatus().queuedUsers });

    // Leave main room Socket.IO room
    socket.leave('mainRoom');

    // Notify main room of player leaving and update lobby list
    if (result.wasInMainRoom || result.wasInLobby) {
        io.to('mainRoom').emit('lobbiesUpdated', {
            lobbies: gameManager.getAllLobbies()
        });
    }

    socketLogger.debug('Player disconnected', { socketId: socket.id });

    // If player was in an active game, give them time to reconnect
    if (result.wasInGame && result.game) {
        const position = result.game.getPositionBySocketId(socket.id);
        const player = result.game.getPlayerByPosition(position);
        const username = player?.username || `Player ${position}`;
        socketLogger.info('Player disconnected from game, waiting for reconnection', {
            username, position, gameId: result.gameId, gracePeriod: RECONNECT_GRACE_PERIOD / 1000
        });

        // Notify other players that someone disconnected
        result.game.broadcast(io, 'playerDisconnected', { position, username });

        // Start a timer to abort if they don't reconnect
        // Clear any existing timer for this game (in case multiple disconnects)
        if (pendingAbortTimers.has(result.gameId)) {
            clearTimeout(pendingAbortTimers.get(result.gameId));
        }

        const timer = setTimeout(async () => {
            const checkResult = gameManager.checkGameAbort(result.gameId);
            if (checkResult.shouldAbort) {
                socketLogger.warn('Grace period expired, aborting game', { gameId: result.gameId });
                checkResult.game.broadcast(io, 'abortGame', { reason: 'Player did not reconnect' });
                // Clear active game for all players
                await gameManager.clearActiveGameForAll(result.gameId);
                checkResult.game.leaveAllFromRoom(io);
                gameManager.abortGame(result.gameId);
            }
            pendingAbortTimers.delete(result.gameId);
        }, RECONNECT_GRACE_PERIOD);

        pendingAbortTimers.set(result.gameId, timer);
    }
}

/**
 * Cancel abort timer when player reconnects
 */
function cancelAbortTimer(gameId) {
    if (pendingAbortTimers.has(gameId)) {
        clearTimeout(pendingAbortTimers.get(gameId));
        pendingAbortTimers.delete(gameId);
        socketLogger.debug('Abort timer cancelled', { gameId });
    }
}

module.exports = {
    joinQueue,
    leaveQueue,
    handleDisconnect,
    cancelAbortTimer
};
