/**
 * Chat socket event handlers
 */

const gameManager = require('../game/GameManager');

function chatMessage(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);

    if (!game) {
        // Not in a game, can't chat
        console.log(`Chat rejected: ${socket.id} not in a game`);
        return;
    }

    const position = game.getPositionBySocketId(socket.id);

    if (!position) {
        console.log(`Chat rejected: ${socket.id} has no position`);
        return;
    }

    console.log(`Chat message from position ${position}: ${data.message}`);

    // Broadcast to players in the same game only
    game.broadcast(io, 'chatMessage', {
        position,
        message: data.message
    });
}

module.exports = {
    chatMessage
};
