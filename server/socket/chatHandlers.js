/**
 * Chat socket event handlers
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');

function chatMessage(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);

    if (!game) {
        // Not in a game, can't chat
        socketLogger.debug('Chat rejected: not in a game', { socketId: socket.id });
        return;
    }

    const position = game.getPositionBySocketId(socket.id);

    if (!position) {
        socketLogger.debug('Chat rejected: no position', { socketId: socket.id });
        return;
    }

    // Get player info for username
    const player = game.getPlayerByPosition(position);
    const username = player ? player.username : 'Unknown';

    // Add to game log for reconnection persistence
    game.addLogEntry(`${username}: ${data.message}`, position, 'chat');

    // Broadcast to players in the same game only
    game.broadcast(io, 'chatMessage', {
        position,
        message: data.message,
        username
    });
}

module.exports = {
    chatMessage
};
