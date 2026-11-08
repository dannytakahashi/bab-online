/**
 * Queue management socket event handlers
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { emitLobbiesUpdated } = require('./gameLifecycle');
const { disconnectOwner } = require('./seatLifecycle');

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

/**
 * A socket disconnected: drop it from the main room / lobby / tournament /
 * spectating (GameManager.handleDisconnect), then route an in-game socket to
 * its seat bookkeeping: a pre-seating entrant is marked disconnected (and
 * auto-drawn during the draw), a seat owner goes through
 * seatLifecycle.disconnectOwner (grace for a human seat, 'away' for a lazy /
 * resigned seat's watcher). Anything else mapped (a stale socket) is just
 * unmapped.
 */
async function handleDisconnect(socket, io) {
    // Resolve the name before the socket's entry can go away
    const user = gameManager.getUserBySocketId(socket.id);
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

    // A pure spectator was already removed from its game; just the room
    if (result.spectatorGame) result.spectatorGame.leaveRoom(io, socket.id);

    socketLogger.debug('Player disconnected', { socketId: socket.id });

    if (result.wasInGame && result.game) {
        const game = result.game;

        // Before seats exist (CREATED countdown, draw, draw resolution): a
        // CREATED departure auto-draws when the draw opens
        // (gameLifecycle.beginDraw); handleDrawComplete seats it.
        const entrant = game.entrant(socket.id);
        if (entrant) {
            game.markEntrantDisconnected(socket.id);
            if (gameManager.playerGames.get(socket.id) === game.gameId) gameManager.playerGames.delete(socket.id);
            const username = entrant.username || 'Player';

            // Auto-draw for the disconnected player (random card); a no-op
            // if they already drew or the draw is no longer open
            const { autoDraw, handleDrawComplete } = require('./gameHandlers');
            if (autoDraw(io, game, socket.id, username) && game.drawIndex === 4) {
                // This draw completed the phase
                handleDrawComplete(io, game).catch(err =>
                    socketLogger.error('handleDrawComplete failed', { gameId: result.gameId, error: err.message, stack: err.stack })
                );
            }

            // No playerDisconnected here: there is no seat yet (iOS would
            // file position:null under 0 and never clear it);
            // handleDrawComplete sends it with the real position.
            const dcMessage = `${username} disconnected during card draw.`;
            game.addLogEntry(dcMessage, null, 'system');
            game.broadcast(io, 'gameLogEntry', { message: dcMessage, type: 'system' });
            return;
        }

        const position = game.seatByOwnerSocket(socket.id);
        if (position) {
            disconnectOwner(io, game, position, socket.id);
            return;
        }

        // Mapped but owning nothing (a stale socket): just unmap it
        if (gameManager.playerGames.get(socket.id) === game.gameId) gameManager.playerGames.delete(socket.id);
    }
}

module.exports = {
    joinQueue,
    leaveQueue,
    handleDisconnect
};
