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
        for (const socketId of result.players) {
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

// Track pending abort timers by gameId
const pendingAbortTimers = new Map();

// Grace period for reconnection (30 seconds)
const RECONNECT_GRACE_PERIOD = 30000;

function handleDisconnect(socket, io) {
    const result = gameManager.handleDisconnect(socket.id);

    // Update queue display
    io.emit('queueUpdate', { queuedUsers: gameManager.getQueueStatus().queuedUsers });

    console.log(`Player disconnected: ${socket.id}`);

    // If player was in an active game, give them time to reconnect
    if (result.wasInGame && result.game) {
        const position = result.game.getPositionBySocketId(socket.id);
        const player = result.game.getPlayerByPosition(position);
        const username = player?.username || `Player ${position}`;
        console.log(`Player ${username} at position ${position} disconnected from game ${result.gameId}. Waiting ${RECONNECT_GRACE_PERIOD/1000}s for reconnection...`);

        // Notify other players that someone disconnected
        result.game.broadcast(io, 'playerDisconnected', { position, username });

        // Start a timer to abort if they don't reconnect
        // Clear any existing timer for this game (in case multiple disconnects)
        if (pendingAbortTimers.has(result.gameId)) {
            clearTimeout(pendingAbortTimers.get(result.gameId));
        }

        const timer = setTimeout(() => {
            const checkResult = gameManager.checkGameAbort(result.gameId);
            if (checkResult.shouldAbort) {
                console.log(`Grace period expired. Aborting game ${result.gameId}...`);
                checkResult.game.broadcast(io, 'abortGame', { reason: 'Player did not reconnect' });
                checkResult.game.leaveAllFromRoom(io);
                gameManager.abortGame(result.gameId);
            }
            pendingAbortTimers.delete(result.gameId);
        }, RECONNECT_GRACE_PERIOD);

        pendingAbortTimers.set(result.gameId, timer);
    }
}

/**
 * Cancel abort timer when player reconnects
 */
function cancelAbortTimer(gameId) {
    if (pendingAbortTimers.has(gameId)) {
        clearTimeout(pendingAbortTimers.get(gameId));
        pendingAbortTimers.delete(gameId);
        console.log(`Abort timer cancelled for game ${gameId}`);
    }
}

module.exports = {
    joinQueue,
    leaveQueue,
    handleDisconnect,
    cancelAbortTimer
};
