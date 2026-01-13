/**
 * Reconnection socket event handlers
 */

const gameManager = require('../game/GameManager');

/**
 * Handle a player attempting to rejoin a game after disconnect
 */
async function rejoinGame(socket, io, data) {
    const { gameId, username } = data;

    console.log(`Rejoin attempt: ${username} trying to rejoin game ${gameId}`);

    // Find the game
    const game = gameManager.getGameById(gameId);
    if (!game) {
        console.log(`Rejoin failed: game ${gameId} not found`);
        socket.emit('rejoinFailed', { reason: 'Game no longer exists' });
        return;
    }

    // Find player by username
    const existingPlayer = game.getPlayerByUsername(username);
    if (!existingPlayer) {
        console.log(`Rejoin failed: ${username} not found in game ${gameId}`);
        socket.emit('rejoinFailed', { reason: 'Not a player in this game' });
        return;
    }

    // Check if this is actually a reconnect (different socket ID)
    if (existingPlayer.socketId === socket.id) {
        console.log(`Rejoin: ${username} already connected with same socket`);
        socket.emit('rejoinFailed', { reason: 'Already connected' });
        return;
    }

    // Update socket ID mapping
    const oldSocketId = game.updatePlayerSocket(existingPlayer.position, socket.id, io);
    gameManager.updatePlayerGameMapping(oldSocketId, socket.id, gameId);

    // Register user with new socket
    gameManager.registerUser(socket.id, username);

    console.log(`Rejoin success: ${username} rejoined game ${gameId} at position ${existingPlayer.position}`);

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
