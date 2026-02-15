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

    // Find player by username — check current players first, then lazy/resigned
    let existingPlayer = game.getPlayerByUsername(username);
    let isLazyRejoin = false;

    if (!existingPlayer) {
        // Check if this user is in lazy mode or was resigned (their name was replaced by bot)
        const lazyPosition = game.getOriginalPlayerPosition(username);
        if (lazyPosition) {
            // This user has a lazy/resigned position — they're rejoining
            isLazyRejoin = true;
            existingPlayer = game.getPlayerByPosition(lazyPosition);
        }
    }

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

    // For lazy/resigned rejoins, player re-enters as spectator while bot keeps playing
    if (isLazyRejoin) {
        const position = existingPlayer.position;

        if (game.isLazy(position)) {
            // Already in lazy mode — just update the original socket ID
            const lazyInfo = game.lazyPlayers[position];
            lazyInfo.originalSocketId = socket.id;
        } else if (game.isResigned(position)) {
            // Resigned player reconnecting — convert resignation into lazy mode
            // so the bot keeps playing and the human can spectate / /active back
            const resignedInfo = game.resignedPlayers[position];
            const botSocketId = game.positions[position];
            const botPlayer = game.players.get(botSocketId);

            game.lazyPlayers[position] = {
                botSocketId,
                botUsername: botPlayer.username,
                botPic: botPlayer.pic,
                originalUsername: resignedInfo.username,
                originalPic: resignedInfo.pic,
                originalSocketId: socket.id,
                personality: game.assignedPersonality[position] || 'mary'
            };
        }

        // Register user with new socket
        gameManager.registerUser(socket.id, username);

        // Add as spectator so they can chat and use /active through the spectator path
        game.addSpectator(socket.id, username, null);
        socket.join(game.roomName);

        // Map the human's new socket to the game
        gameManager.updatePlayerGameMapping(null, socket.id, gameId);

        socketLogger.info('Player rejoined game in lazy mode', { username, gameId, position });

        // Send current game state (they'll be in lazy/spectator mode)
        // Use bot's socket ID to get correct position/hand, since the human isn't in the players map
        const currentBotSocketId = game.positions[position];
        const rejoinState = game.getClientState(currentBotSocketId);
        rejoinState.isLazy = true;
        socket.emit('rejoinSuccess', rejoinState);

        // Notify other players
        game.broadcast(io, 'playerReconnected', { position, username });

        const rcMessage = `${username} reconnected.`;
        game.addLogEntry(rcMessage, null, 'system');
        game.broadcast(io, 'gameLogEntry', { message: rcMessage, type: 'system' });
        return;
    }

    // Normal reconnection (not lazy)
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

    const rcMessage = `${username} reconnected.`;
    game.addLogEntry(rcMessage, null, 'system');
    game.broadcast(io, 'gameLogEntry', { message: rcMessage, type: 'system' });
}

module.exports = {
    rejoinGame
};
