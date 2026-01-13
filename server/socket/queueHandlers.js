/**
 * Queue management socket event handlers
 */

const gameManager = require('../game/GameManager');
const Deck = require('../game/Deck');
const { delay } = require('../utils/timing');

async function joinQueue(socket, io) {
    const result = gameManager.joinQueue(socket.id);

    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
    }

    // Broadcast updated queue to all
    io.emit('queueUpdate', { queuedUsers: result.queuedUsers || gameManager.getQueueStatus().queuedUsers });

    if (result.gameStarted) {
        console.log('Game is starting...');
        const game = result.game;

        // Join all players to the game room for targeted broadcasts
        const queuedSocketIds = result.queuedUsers.map(u => u.socketId);
        for (const socketId of queuedSocketIds) {
            game.joinToRoom(io, socketId);
        }

        // Wait before starting draw phase
        await delay(3500);

        // Initialize deck for draw phase
        const deck = new Deck();
        deck.shuffle();
        game.deck = deck;
        game.phase = 'drawing';

        // Broadcast to game room only
        game.broadcast(io, 'startDraw', { start: true });
    }
}

function leaveQueue(socket, io) {
    const result = gameManager.leaveQueue(socket.id);

    if (result.success) {
        io.emit('queueUpdate', { queuedUsers: result.queuedUsers });
    }
}

function handleDisconnect(socket, io) {
    const result = gameManager.handleDisconnect(socket.id);

    // Update queue display
    io.emit('queueUpdate', { queuedUsers: gameManager.getQueueStatus().queuedUsers });

    console.log(`Player disconnected: ${socket.id}`);

    // If player was in an active game, abort it
    if (result.wasInGame && result.game) {
        console.log('Aborting mid-game...');
        // Broadcast abort to game room only, then clean up room
        result.game.broadcast(io, 'abortGame', {});
        result.game.leaveAllFromRoom(io);
        gameManager.abortGame(result.gameId);
    }
}

module.exports = {
    joinQueue,
    leaveQueue,
    handleDisconnect
};
