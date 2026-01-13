/**
 * Socket.IO setup and event routing
 */

const authHandlers = require('./authHandlers');
const queueHandlers = require('./queueHandlers');
const gameHandlers = require('./gameHandlers');
const chatHandlers = require('./chatHandlers');

function setupSocketHandlers(io) {
    io.on('connection', (socket) => {
        console.log(`Player connected: ${socket.id}`);

        // Auth events
        socket.on('signIn', (data) => authHandlers.signIn(socket, io, data));
        socket.on('signUp', (data) => authHandlers.signUp(socket, io, data));

        // Queue events
        socket.on('joinQueue', () => queueHandlers.joinQueue(socket, io));
        socket.on('leaveQueue', () => queueHandlers.leaveQueue(socket, io));

        // Game events
        socket.on('draw', (data) => gameHandlers.draw(socket, io, data));
        socket.on('playerBid', (data) => gameHandlers.playerBid(socket, io, data));
        socket.on('playCard', (data) => gameHandlers.playCard(socket, io, data));

        // Chat events
        socket.on('chatMessage', (data) => chatHandlers.chatMessage(socket, io, data));

        // Disconnect
        socket.on('disconnect', () => {
            queueHandlers.handleDisconnect(socket, io);
        });
    });
}

module.exports = { setupSocketHandlers };
