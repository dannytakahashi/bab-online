/**
 * Queue management socket event handlers
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
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
        // Before seats exist (CREATED countdown, draw, draw resolution): no
        // seat to mark yet. A CREATED departure auto-draws when the draw opens
        // (gameLifecycle.beginDraw); handleDrawComplete seats it.
        const entrant = result.game.entrant(socket.id);
        if (entrant) {
            const username = entrant.username || 'Player';

            // Auto-draw for the disconnected player (random card); a no-op
            // if they already drew or the draw is no longer open
            const { autoDraw, handleDrawComplete } = require('./gameHandlers');
            if (autoDraw(io, result.game, socket.id, username) && result.game.drawIndex === 4) {
                // This draw completed the phase
                handleDrawComplete(io, result.game).catch(err =>
                    socketLogger.error('handleDrawComplete failed', { gameId: result.gameId, error: err.message, stack: err.stack })
                );
            }

            // handleDrawComplete seats it as a disconnected seat (never
            // downgrades a /leave)
            result.game.markEntrantDisconnected(socket.id);

            // Log disconnect. No playerDisconnected here: there is no seat yet
            // (iOS would file position:null under 0 and never clear it);
            // handleDrawComplete sends it with the real position.
            const dcMessage = `${username} disconnected during card draw.`;
            result.game.addLogEntry(dcMessage, null, 'system');
            result.game.broadcast(io, 'gameLogEntry', { message: dcMessage, type: 'system' });

            return;
        }

        // A mapped socket without a seat once seats exist is a watcher (a
        // lazy/resigned human's rejoin shadow, or a spectator who /active'd
        // nothing yet): drop it quietly — there is no seat to report
        if (!position) {
            result.game.removeSpectator(socket.id);
            if (gameManager.playerGames.get(socket.id) === result.game.gameId) {
                gameManager.playerGames.delete(socket.id);
            }
            // A lazy human's shadow may have been the last human able to
            // forceResign a disconnected seat
            ensureGraceIfAbandoned(io, result.game);
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

        // Abort when no human is left who could reconnect the table or
        // forceResign the disconnected seats (see isHumanPresent)
        const disconnectedPositions = checkResult.game.getDisconnectedPlayers();

        if (!hasPresentHuman(io, checkResult.game)) {
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
 * Is the human behind this seat still at the table? Not for bots and
 * resigned seats, disconnected seats, and lazy seats whose human left for
 * good or whose watching socket (the seat socket or a rejoin shadow) is gone.
 */
function isHumanPresent(io, game, player) {
    if (player.isBot || game.isResigned(player.position)) return false;
    if (game.isPlayerDisconnected(player.position)) return false;
    if (game.isLazy(player.position)) {
        const info = game.lazyPlayers[player.position];
        if (info.permanentLeave) return false;
        return !!io.sockets.sockets.get(info.originalSocketId);
    }
    return true;
}

function hasPresentHuman(io, game) {
    return Array.from(game.players.values()).some(p => isHumanPresent(io, game, p));
}

/**
 * Call when a human silently stops being present (leave, shadow
 * disconnect). If disconnected seats remain and nobody present could
 * forceResign them, (re)start the grace period: their own may already have
 * run out, and the game must abort rather than wait forever.
 */
function ensureGraceIfAbandoned(io, game) {
    if (game.isTerminal() || hasPresentHuman(io, game)) return;
    if (game.getDisconnectedPlayers().length > 0 && !game.hasTimer('reconnectGrace')) {
        startReconnectGraceTimer(io, game.gameId);
    }
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
    startReconnectGraceTimer,
    ensureGraceIfAbandoned
};
