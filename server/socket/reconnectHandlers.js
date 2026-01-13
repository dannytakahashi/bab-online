/**
 * Reconnection socket event handlers
 */

const gameManager = require('../game/GameManager');
const { cancelAbortTimer } = require('./queueHandlers');

/**
 * Handle a player attempting to rejoin a game after disconnect
 */
async function rejoinGame(socket, io, data) {
    const { gameId, username } = data;

    console.log(`[REJOIN] Attempt: ${username} trying to rejoin game ${gameId}`);
    console.log(`[REJOIN] Data received:`, JSON.stringify(data));

    // Find the game
    const game = gameManager.getGameById(gameId);
    if (!game) {
        console.log(`[REJOIN] Failed: game ${gameId} not found`);
        socket.emit('rejoinFailed', { reason: 'Game no longer exists' });
        return;
    }

    // Debug: Log all players in the game
    console.log(`[REJOIN] Game found. Players in game:`);
    for (const [socketId, player] of game.players.entries()) {
        console.log(`  - socketId: ${socketId}, username: ${player.username}, position: ${player.position}`);
    }

    // Find player by username
    const existingPlayer = game.getPlayerByUsername(username);
    if (!existingPlayer) {
        // Collect player names for debugging
        const playersInGame = [];
        for (const [sid, p] of game.players.entries()) {
            playersInGame.push(p.username);
        }
        console.log(`[REJOIN] Failed: ${username} not found. Players in game: ${playersInGame.join(', ')}`);
        socket.emit('rejoinFailed', {
            reason: 'Not a player in this game',
            debug: { lookingFor: username, playersInGame }
        });
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

    // Clear disconnected status for this player
    game.clearPlayerDisconnected(existingPlayer.position);

    // Cancel the abort timer if no more disconnected players
    if (game.getDisconnectedPlayers().length === 0) {
        cancelAbortTimer(gameId);
    }

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
