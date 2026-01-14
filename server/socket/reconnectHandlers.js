/**
 * Reconnection socket event handlers
 */

const gameManager = require('../game/GameManager');
const { cancelAbortTimer } = require('./queueHandlers');
const { socketLogger } = require('../utils/logger');

/**
 * Handle a player attempting to rejoin a game after disconnect
 */
async function rejoinGame(socket, io, data) {
    const { gameId, username } = data;

    socketLogger.debug('Rejoin attempt', { username, gameId });

    // Find the game
    const game = gameManager.getGameById(gameId);
    if (!game) {
        socketLogger.debug('Rejoin failed: game not found', { gameId });
        // Clear stale activeGameId from database
        if (username) {
            await gameManager.clearActiveGame(username);
        }
        socket.emit('rejoinFailed', { reason: 'Game no longer exists' });
        return;
    }

    // Find player by username
    const existingPlayer = game.getPlayerByUsername(username);
    if (!existingPlayer) {
        const playersInGame = Array.from(game.players.values()).map(p => p.username);
        socketLogger.debug('Rejoin failed: player not in game', { username, playersInGame });
        socket.emit('rejoinFailed', {
            reason: 'Not a player in this game',
            debug: { lookingFor: username, playersInGame }
        });
        return;
    }

    // Check if this is actually a reconnect (different socket ID)
    if (existingPlayer.socketId === socket.id) {
        socketLogger.debug('Rejoin failed: already connected', { username });
        socket.emit('rejoinFailed', { reason: 'Already connected' });
        return;
    }

    // Update socket ID mapping
    const oldSocketId = game.updatePlayerSocket(existingPlayer.position, socket.id, io);
    gameManager.updatePlayerGameMapping(oldSocketId, socket.id, gameId);

    // Clear disconnected status for this player
    game.clearPlayerDisconnected(existingPlayer.position);

    // Cancel the abort timer if no more disconnected players
    if (game.getDisconnectedPlayers().length === 0) {
        cancelAbortTimer(gameId);
    }

    // Register user with new socket
    gameManager.registerUser(socket.id, username);

    socketLogger.info('Player rejoined game', { username, gameId, position: existingPlayer.position });

    // Send current game state to rejoining player
    const gameState = game.getClientState(socket.id);
    socket.emit('rejoinSuccess', gameState);

    // Notify other players
    game.broadcast(io, 'playerReconnected', {
        position: existingPlayer.position,
        username
    });
}

module.exports = {
    rejoinGame
};
