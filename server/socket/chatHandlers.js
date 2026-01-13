/**
 * Chat socket event handlers
 */

const gameManager = require('../game/GameManager');

function chatMessage(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);

    if (!game) {
        // Not in a game, can't chat
        return;
    }

    const position = game.getPositionBySocketId(socket.id);

    if (!position) {
        return;
    }

    console.log(`Chat message from ${socket.id}: ${data.message}`);

    // Broadcast to all players
    io.emit('chatMessage', {
        position,
        message: data.message
    });
}

module.exports = {
    chatMessage
};
