/**
 * Queue management socket event handlers
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { Phase } = require('../game/GamePhase');
const { abortGame, emitLobbiesUpdated } = require('./gameLifecycle');

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
        const joiningUsername = lobby.players.find(p => p.socketId === socket.id)?.username;
        const existingHumans = [];
        lobby.players.forEach(player => {
            if (player.socketId !== socket.id) {
                io.to(player.socketId).emit('lobbyPlayerJoined', {
                    lobbyId: lobby.id,
                    players: lobby.players,
                    newPlayer: {
                        socketId: socket.id,
                        username: joiningUsername
                    }
                });

                // Send voicePeerJoined to existing human players
                if (!gameManager.isBot(player.socketId)) {
                    existingHumans.push({ socketId: player.socketId, username: player.username });
                    io.to(player.socketId).emit('voicePeerJoined', {
                        socketId: socket.id,
                        username: joiningUsername
                    });
                }
            }
        });

        // Send voicePeerList to the joining player
        if (existingHumans.length > 0) {
            socket.emit('voicePeerList', { peers: existingHumans });
        }
    }
}

function leaveQueue(socket, io) {
    const result = gameManager.leaveQueue(socket.id);

    if (result.success) {
        io.emit('queueUpdate', { queuedUsers: result.queuedUsers });
    }
}

// Grace period for reconnection (60 seconds)
const RECONNECT_GRACE_PERIOD = 60000;

async function handleDisconnect(socket, io) {
    const result = gameManager.handleDisconnect(socket.id);

    // Leave main room Socket.IO room
    socket.leave('mainRoom');

    // Notify main room of player leaving and update lobby list
    if (result.wasInMainRoom || result.wasInLobby || result.wasInTournament) {
        emitLobbiesUpdated(io);
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

    // Emit voicePeerLeft for lobby disconnect
    if (result.wasInLobby && !result.wasInGame && result.lobby) {
        result.lobby.players.forEach(player => {
            if (!gameManager.isBot(player.socketId)) {
                io.to(player.socketId).emit('voicePeerLeft', {
                    socketId: socket.id
                });
            }
        });
    }

    socketLogger.debug('Player disconnected', { socketId: socket.id });

    // If player was in an active game, give them time to reconnect
    if (result.wasInGame && result.game) {
        const position = result.game.getPositionBySocketId(socket.id);

        // Handle disconnect during draw phase (player has no position yet)
        if (!position && (result.game.stage === Phase.DRAWING || result.game.stage === Phase.DRAW_RESOLVING)) {
            const user = gameManager.getUserBySocketId(socket.id);
            const username = user?.username || 'Player';

            // Auto-draw for the disconnected player (random card); a no-op
            // if they already drew or the draw is no longer open
            const { autoDraw, handleDrawComplete } = require('./gameHandlers');
            if (autoDraw(io, result.game, socket.id, username) && result.game.drawIndex === 4) {
                // This draw completed the phase
                handleDrawComplete(io, result.game).catch(err =>
                    socketLogger.error('handleDrawComplete failed', { gameId: result.gameId, error: err.message, stack: err.stack })
                );
            }

            // Store username for lookup during handleDrawComplete
            if (!result.game._pendingUsernames) result.game._pendingUsernames = {};
            result.game._pendingUsernames[socket.id] = username;

            // Mark this socket as needing replacement after draw completes
            if (!result.game._drawPhaseDisconnects) result.game._drawPhaseDisconnects = {};
            result.game._drawPhaseDisconnects[socket.id] = { username };

            // Log disconnect. No playerDisconnected here: there is no seat yet
            // (iOS would file position:null under 0 and never clear it);
            // handleDrawComplete sends it with the real position.
            const dcMessage = `${username} disconnected during card draw.`;
            result.game.addLogEntry(dcMessage, null, 'system');
            result.game.broadcast(io, 'gameLogEntry', { message: dcMessage, type: 'system' });

            return;
        }

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
                await abortGame(io, result.game, 'All players disconnected');
            }
            return;
        }

        socketLogger.info('Player disconnected from game, waiting for reconnection', {
            username, position, gameId: result.gameId, gracePeriod: RECONNECT_GRACE_PERIOD / 1000
        });

        // Notify other players that someone disconnected
        result.game.broadcast(io, 'playerDisconnected', { position, username });
        result.game.broadcast(io, 'voicePeerLeft', { socketId: socket.id });

        // Add game log entry so players see it in the feed
        const dcMessage = `${username} disconnected. Waiting for reconnection...`;
        result.game.addLogEntry(dcMessage, null, 'system');
        result.game.broadcast(io, 'gameLogEntry', {
            message: dcMessage,
            type: 'system'
        });

        startReconnectGraceTimer(io, result.gameId);
    }
}

/**
 * Start (or restart) the reconnect grace timer for a game. When it expires,
 * an all-disconnected table is aborted; otherwise the connected players are
 * offered a bot replacement (resignationAvailable) for each disconnected seat.
 * Used for in-game disconnects and for seats whose player disconnected during
 * the draw (started once positions are assigned).
 */
function startReconnectGraceTimer(io, gameId) {
    const game = gameManager.getGameById(gameId);
    if (!game) return;

    // One timer per game, owned by the game: restarting replaces it, and it
    // never fires once the game has ended or aborted
    game.setTimer('reconnectGrace', RECONNECT_GRACE_PERIOD, async () => {
        const checkResult = gameManager.checkGameAbort(gameId);
        if (!checkResult.shouldAbort) return;

        // Check if ALL human players are disconnected — if so, abort
        const disconnectedPositions = checkResult.game.getDisconnectedPlayers();
        const allHumansDisconnected = disconnectedPositions.length > 0 &&
            Array.from(checkResult.game.players.values()).every(
                p => p.isBot || disconnectedPositions.includes(p.position)
            );

        if (allHumansDisconnected) {
            socketLogger.warn('All humans disconnected, aborting game', { gameId });
            await abortGame(io, checkResult.game, 'All players disconnected');
        } else {
            // Broadcast resignationAvailable to remaining connected players
            for (const pos of disconnectedPositions) {
                const disconnectedPlayer = checkResult.game.getPlayerByPosition(pos);
                const dcUsername = disconnectedPlayer?.username || `Player ${pos}`;
                socketLogger.info('Grace period expired, resignation available', {
                    gameId, position: pos, username: dcUsername
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
    });
}

/**
 * Cancel abort timer when player reconnects
 */
function cancelAbortTimer(gameId) {
    const game = gameManager.getGameById(gameId);
    if (game && game.hasTimer('reconnectGrace')) {
        game.clearTimer('reconnectGrace');
        socketLogger.debug('Abort timer cancelled', { gameId });
    }
}

module.exports = {
    joinQueue,
    leaveQueue,
    handleDisconnect,
    cancelAbortTimer,
    startReconnectGraceTimer
};
