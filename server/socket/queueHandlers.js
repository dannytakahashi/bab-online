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

        // Wait before starting draw phase
        await delay(3500);

        // Initialize deck for draw phase
        const game = result.game;
        const deck = new Deck();
        deck.shuffle();
        game.deck = deck;
        game.phase = 'drawing';

        io.emit('startDraw', { start: true });
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
        io.emit('abortGame');
        gameManager.abortGame(result.gameId);
    }
}

module.exports = {
    joinQueue,
    leaveQueue,
    handleDisconnect
};
