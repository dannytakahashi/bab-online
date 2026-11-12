/**
 * Socket disconnect handling. (The file kept its name from the matchmaking
 * queue, whose joinQueue / leaveQueue handlers are gone: V1_REMOVALS #2.)
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { emitLobbiesUpdated } = require('./gameLifecycle');
const { disconnectOwner } = require('./seatLifecycle');
const { lobbySeatSuspended, lobbySeatExpired } = require('./lobbyHandlers');

/**
 * A socket disconnected: drop it from the main room / lobby / tournament /
 * spectating (GameManager.handleDisconnect), then route an in-game socket to
 * its seat bookkeeping: a pre-seating entrant is marked disconnected (and
 * auto-drawn during the draw), a seat owner goes through
 * seatLifecycle.disconnectOwner (grace for a human seat, 'away' for a lazy /
 * resigned seat's watcher). Anything else mapped (a stale socket) is just
 * unmapped.
 *
 * A lobby seat is held for GameManager.LOBBY_SEAT_GRACE_MS (`lobbyGrace`,
 * on for a transport disconnect): a reload or a short drop re-enters the
 * same lobby and seat. sessionIdentity.releaseIdentity passes false (the
 * player switched accounts: the seat goes at once).
 */
async function handleDisconnect(socket, io, { lobbyGrace = true } = {}) {
    // Resolve the name before the socket's entry can go away
    const user = gameManager.getUserBySocketId(socket.id);
    const onlineBefore = gameManager.getOnlineUsernames().length;
    const result = gameManager.handleDisconnect(socket.id, {
        lobbyGrace,
        onLobbyGraceExpire: (expired) => lobbySeatExpired(io, expired)
    });
    if (result.lobbySuspended) lobbySeatSuspended(io, result.lobbySuspended.lobby, socket.id);

    // Leave main room Socket.IO room
    socket.leave('mainRoom');

    // Notify main room of player leaving and update lobby list
    if (result.wasInMainRoom || result.wasInLobby || result.wasInTournament || result.lobbySuspended) {
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

    if (result.wasInGame && result.game) routeGameDisconnect(socket, io, result);

    // Last: the routing above resolves names from the entrant / seat, not
    // from this (now dead) socket. Offline users drop out of the online list.
    gameManager.removeUserSocket(socket.id);

    // The user's last socket is gone: the main room's online count and list
    // shrink (new event; current clients keep their stale count, ctr-21). A
    // sign-out that keeps the socket open is not covered.
    const onlineUsers = gameManager.getOnlineUsernames();
    if (user && onlineUsers.length < onlineBefore) {
        io.to('mainRoom').emit('mainRoomPlayerLeft', {
            username: user.username,
            onlineCount: onlineUsers.length,
            onlineUsers
        });
    }
}

/** Route an in-game socket's disconnect to its entrant or seat-owner transition. */
function routeGameDisconnect(socket, io, result) {
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

module.exports = {
    handleDisconnect
};
