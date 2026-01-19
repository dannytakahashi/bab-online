/**
 * Socket.IO setup and event routing
 * All handlers are wrapped with validation and error handling
 */

const authHandlers = require('./authHandlers');
const queueHandlers = require('./queueHandlers');
const lobbyHandlers = require('./lobbyHandlers');
const mainRoomHandlers = require('./mainRoomHandlers');
const gameHandlers = require('./gameHandlers');
const chatHandlers = require('./chatHandlers');
const reconnectHandlers = require('./reconnectHandlers');
const { asyncHandler, syncHandler, safeHandler, rateLimiter } = require('./errorHandler');
const { socketLogger } = require('../utils/logger');

function setupSocketHandlers(io) {
    io.on('connection', (socket) => {
        socketLogger.debug('Player connected', { socketId: socket.id });

        // Auth events - with validation
        socket.on('signIn', (data) =>
            asyncHandler('signIn', authHandlers.signIn)(socket, io, data)
        );
        socket.on('signUp', (data) =>
            asyncHandler('signUp', authHandlers.signUp)(socket, io, data)
        );
        socket.on('restoreSession', (data) =>
            asyncHandler('restoreSession', authHandlers.restoreSession)(socket, io, data)
        );

        // Queue events - no data to validate
        socket.on('joinQueue', () =>
            safeHandler(queueHandlers.joinQueue)(socket, io, {})
        );
        socket.on('leaveQueue', () =>
            safeHandler(queueHandlers.leaveQueue)(socket, io, {})
        );

        // Main room events
        socket.on('joinMainRoom', () =>
            safeHandler(mainRoomHandlers.joinMainRoom)(socket, io, {})
        );
        socket.on('mainRoomChat', (data) =>
            syncHandler('chatMessage', mainRoomHandlers.mainRoomChat)(socket, io, data)
        );
        socket.on('createLobby', (data) =>
            safeHandler(mainRoomHandlers.createLobby)(socket, io, data || {})
        );
        socket.on('joinLobby', (data) =>
            safeHandler(mainRoomHandlers.joinLobby)(socket, io, data)
        );
        socket.on('getLobbies', () =>
            safeHandler(mainRoomHandlers.getLobbies)(socket, io, {})
        );

        // Lobby events
        socket.on('playerReady', () =>
            safeHandler(lobbyHandlers.playerReady)(socket, io, {})
        );
        socket.on('playerUnready', () =>
            safeHandler(lobbyHandlers.playerUnready)(socket, io, {})
        );
        socket.on('lobbyChat', (data) =>
            syncHandler('chatMessage', lobbyHandlers.lobbyChat)(socket, io, data)
        );
        socket.on('leaveLobby', () =>
            safeHandler(lobbyHandlers.leaveLobby)(socket, io, {})
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

        // Reconnection events
        socket.on('rejoinGame', (data) =>
            asyncHandler('rejoinGame', reconnectHandlers.rejoinGame)(socket, io, data)
        );

        // Disconnect - cleanup rate limiter and handle game state
        socket.on('disconnect', () => {
            try {
                // Clear rate limit data for this socket
                rateLimiter.clearSocket(socket.id);

                // Handle game/queue disconnect
                queueHandlers.handleDisconnect(socket, io);
            } catch (error) {
                socketLogger.error('Error in disconnect handler', {
                    socketId: socket.id,
                    error: error.message,
                    stack: error.stack
                });
            }
        });
    });
}

module.exports = { setupSocketHandlers };
