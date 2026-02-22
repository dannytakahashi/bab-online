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

// Grace period for reconnection (60 seconds)
const RECONNECT_GRACE_PERIOD = 60000;

async function handleDisconnect(socket, io) {
    const result = gameManager.handleDisconnect(socket.id);

    // Update queue display
    io.emit('queueUpdate', { queuedUsers: gameManager.getQueueStatus().queuedUsers });

    // Leave main room Socket.IO room
    socket.leave('mainRoom');

    // Notify main room of player leaving and update lobby list
    if (result.wasInMainRoom || result.wasInLobby || result.wasInTournament) {
        io.to('mainRoom').emit('lobbiesUpdated', {
            lobbies: gameManager.getAllLobbies(),
            inProgressGames: gameManager.getInProgressGames(),
            tournaments: gameManager.getAllTournaments()
        });
    }

    // If player was in a tournament lobby, notify remaining players
    if (result.wasInTournament && result.tournamentResult && !result.tournamentResult.deleted) {
        const tournament = result.tournamentResult.tournament;
        const user = gameManager.getUserBySocketId(socket.id);
        tournament.broadcast(io, 'tournamentPlayerLeft', {
            username: user?.username || 'Unknown',
            players: tournament.getClientState().players,
            newCreator: result.tournamentResult.newCreator ? result.tournamentResult.newCreator.username : null
        });
    }

    socketLogger.debug('Player disconnected', { socketId: socket.id });

    // If player was in an active game, give them time to reconnect
    if (result.wasInGame && result.game) {
        const position = result.game.getPositionBySocketId(socket.id);
        const player = result.game.getPlayerByPosition(position);
        const username = player?.username || `Player ${position}`;

        // If player is in lazy mode, bot is already playing — skip grace period
        if (result.wasLazy) {
            const lazyInfo = result.game.getLazyBot(position);
            const originalUsername = lazyInfo?.originalUsername || username;
            socketLogger.info('Lazy player disconnected, bot continues playing', {
                originalUsername, position, gameId: result.gameId
            });

            // Notify other players, but don't say "waiting for reconnection"
            const dcMessage = `${originalUsername} disconnected. Bot continues playing.`;
            result.game.addLogEntry(dcMessage, null, 'system');
            result.game.broadcast(io, 'gameLogEntry', {
                message: dcMessage,
                type: 'system'
            });

            // Check if all remaining humans are gone (bots, lazy, or disconnected)
            const disconnectedPositions = result.game.getDisconnectedPlayers();
            const hasConnectedHuman = Array.from(result.game.players.values()).some(
                p => !p.isBot &&
                     !result.game.isLazy(p.position) &&
                     !disconnectedPositions.includes(p.position)
            );

            if (!hasConnectedHuman) {
                socketLogger.warn('No connected humans remain, aborting game', { gameId: result.gameId });
                result.game.broadcast(io, 'abortGame', { reason: 'All players disconnected' });
                await gameManager.clearActiveGameForAll(result.gameId);
                result.game.leaveAllFromRoom(io);
                gameManager.abortGame(result.gameId);
                io.to('mainRoom').emit('lobbiesUpdated', {
                    lobbies: gameManager.getAllLobbies(),
                    inProgressGames: gameManager.getInProgressGames(),
                    tournaments: gameManager.getAllTournaments()
                });
            }
            return;
        }

        socketLogger.info('Player disconnected from game, waiting for reconnection', {
            username, position, gameId: result.gameId, gracePeriod: RECONNECT_GRACE_PERIOD / 1000
        });

        // Notify other players that someone disconnected
        result.game.broadcast(io, 'playerDisconnected', { position, username });

        // Add game log entry so players see it in the feed
        const dcMessage = `${username} disconnected. Waiting for reconnection...`;
        result.game.addLogEntry(dcMessage, null, 'system');
        result.game.broadcast(io, 'gameLogEntry', {
            message: dcMessage,
            type: 'system'
        });

        // Start a timer to abort if they don't reconnect
        // Clear any existing timer for this game (in case multiple disconnects)
        if (pendingAbortTimers.has(result.gameId)) {
            clearTimeout(pendingAbortTimers.get(result.gameId));
        }

        const timer = setTimeout(async () => {
            const checkResult = gameManager.checkGameAbort(result.gameId);
            if (checkResult.shouldAbort) {
                // Check if ALL human players are disconnected — if so, abort
                const disconnectedPositions = checkResult.game.getDisconnectedPlayers();
                const allHumansDisconnected = disconnectedPositions.length > 0 &&
                    Array.from(checkResult.game.players.values()).every(
                        p => p.isBot || disconnectedPositions.includes(p.position)
                    );

                if (allHumansDisconnected) {
                    socketLogger.warn('All humans disconnected, aborting game', { gameId: result.gameId });
                    checkResult.game.broadcast(io, 'abortGame', { reason: 'All players disconnected' });
                    await gameManager.clearActiveGameForAll(result.gameId);
                    checkResult.game.leaveAllFromRoom(io);
                    gameManager.abortGame(result.gameId);
                    io.to('mainRoom').emit('lobbiesUpdated', {
                        lobbies: gameManager.getAllLobbies(),
                        inProgressGames: gameManager.getInProgressGames(),
                        tournaments: gameManager.getAllTournaments()
                    });
                } else {
                    // Broadcast resignationAvailable to remaining connected players
                    for (const pos of disconnectedPositions) {
                        const disconnectedPlayer = checkResult.game.getPlayerByPosition(pos);
                        const dcUsername = disconnectedPlayer?.username || `Player ${pos}`;
                        socketLogger.info('Grace period expired, resignation available', {
                            gameId: result.gameId, position: pos, username: dcUsername
                        });
                        checkResult.game.broadcast(io, 'resignationAvailable', {
                            position: pos,
                            username: dcUsername
                        });

                        const expiredMsg = `${dcUsername} failed to reconnect. You may replace them with a bot.`;
                        checkResult.game.addLogEntry(expiredMsg, null, 'system');
                        checkResult.game.broadcast(io, 'gameLogEntry', { message: expiredMsg, type: 'system' });
                    }
                }
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
