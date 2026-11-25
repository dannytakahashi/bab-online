/**
 * Socket disconnect handling. (The file kept its name from the matchmaking
 * queue, whose joinQueue / leaveQueue handlers are gone: V1_REMOVALS #2.)
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { emitLobbiesUpdated } = require('./gameLifecycle');
const { disconnectOwner } = require('./seatLifecycle');
const { lobbySeatSuspended, lobbySeatExpired, tableBotsReadied } = require('./lobbyHandlers');
const sessionIdentity = require('./sessionIdentity');
const playAgain = require('./playAgain');
const onlinePresence = require('./onlinePresence');

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
async function handleDisconnect(socket, io, { lobbyGrace = true, closed = true } = {}) {
    // Resolve the name before the socket's entry can go away
    const user = gameManager.getUserBySocketId(socket.id);
    // The user's live socket closed: a parked tab of theirs is told (after
    // a short delay, if nothing took the session back: sessionIdentity)
    if (closed && user) sessionIdentity.liveSocketClosed(io, socket, user.username);
    // An older app still on a score screen: its lingering calls with the
    // players back in the lobby end (play again)
    playAgain.endLingering(io, socket.id, 'disconnect');
    // Out of a tournament's voice room (its peers drop the calls)
    require('../voice/tournamentVoice').leaveSocket(io, socket.id);
    const wasOnline = onlinePresence.isOnline(user?.username);
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
        // A dropped member no longer holds up an idle host's hand-off
        require('./tournamentLiveness').refreshHostIdle(io, tournament);
        // Cut for a buck: an open draw is drawn for them now
        require('./cutForABuck').memberDisconnected(io, tournament, user?.username);
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

    // A sign-out from a lobby of more than 4 whose table it filled with bots
    if (result.lobbyBotsReadied && result.lobby) tableBotsReadied(io, result.lobby);

    // A pure spectator was already removed from its game; just the room
    if (result.spectatorGame) result.spectatorGame.leaveRoom(io, socket.id);

    socketLogger.debug('Player disconnected', { socketId: socket.id });

    if (result.wasInGame && result.game) routeGameDisconnect(socket, io, result);

    // Last: the routing above resolves names from the entrant / seat, not
    // from this (now dead) socket. Offline users drop out of the online list.
    gameManager.removeUserSocket(socket.id);

    // The user's last socket is gone: the main room's online count and list
    // shrink (mainRoomPlayerLeft: the web reads it from 2026-11-20, iOS from the
    // build after 1.2.3 (24); older iOS builds keep a stale list until the next join).
    // A forced sign-out outside a game dropped the entry already and is
    // announced by authHandlers.signOutSocket; an account switch on the
    // socket comes through here (releaseIdentity)
    if (user) onlinePresence.announceOffline(io, user.username, wasOnline);
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
        // Its voice peers drop the call now (private voicePeerLeft; before,
        // nothing told them and each call hung until ICE gave up)
        require('../voice/gameVoice').playerLeftVoice(io, game, socket.id);

        // Auto-draw for the disconnected player (random card); a no-op
        // if they already drew or the draw is no longer open
        const { autoDraw, handleDrawComplete } = require('./gameHandlers');
        if (autoDraw(io, game, socket.id, username) && game.drawIndex === game.seatCount) {
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
