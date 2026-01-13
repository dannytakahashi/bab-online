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

    // Broadcast to players in the same game only
    game.broadcast(io, 'chatMessage', {
        position,
        message: data.message
    });
}

module.exports = {
    chatMessage
};
