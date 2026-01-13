/**
 * Socket.IO setup and event routing
 * All handlers are wrapped with validation and error handling
 */

const authHandlers = require('./authHandlers');
const queueHandlers = require('./queueHandlers');
const gameHandlers = require('./gameHandlers');
const chatHandlers = require('./chatHandlers');
const { asyncHandler, syncHandler, safeHandler, rateLimiter } = require('./errorHandler');

function setupSocketHandlers(io) {
    io.on('connection', (socket) => {
        console.log(`Player connected: ${socket.id}`);

        // Auth events - with validation
        socket.on('signIn', (data) =>
            asyncHandler('signIn', authHandlers.signIn)(socket, io, data)
        );
        socket.on('signUp', (data) =>
            asyncHandler('signUp', authHandlers.signUp)(socket, io, data)
        );

        // Queue events - no data to validate
        socket.on('joinQueue', () =>
            safeHandler(queueHandlers.joinQueue)(socket, io, {})
        );
        socket.on('leaveQueue', () =>
            safeHandler(queueHandlers.leaveQueue)(socket, io, {})
        );

        // Game events - with validation
        socket.on('draw', (data) =>
            asyncHandler('draw', gameHandlers.draw)(socket, io, data)
        );
        socket.on('playerBid', (data) =>
            asyncHandler('playerBid', gameHandlers.playerBid)(socket, io, data)
        );
        socket.on('playCard', (data) =>
            asyncHandler('playCard', gameHandlers.playCard)(socket, io, data)
        );

        // Chat events - with validation
        socket.on('chatMessage', (data) =>
            syncHandler('chatMessage', chatHandlers.chatMessage)(socket, io, data)
        );

        // Disconnect - cleanup rate limiter and handle game state
        socket.on('disconnect', () => {
            try {
                // Clear rate limit data for this socket
                rateLimiter.clearSocket(socket.id);

                // Handle game/queue disconnect
                queueHandlers.handleDisconnect(socket, io);
            } catch (error) {
                console.error('Error in disconnect handler:', error);
            }
        });
    });
}

module.exports = { setupSocketHandlers };
