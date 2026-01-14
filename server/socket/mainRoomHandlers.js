/**
 * Main room socket event handlers
 * Handles global chat and lobby browsing before joining a game lobby
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');

/**
 * Handle player joining the main room
 */
function joinMainRoom(socket, io) {
    const result = gameManager.joinMainRoom(socket.id);

    if (!result.success) {
        socket.emit('error', { message: result.error || 'Failed to join main room' });
        return;
    }

    // Join the Socket.IO room for main room broadcasts
    socket.join('mainRoom');

    // Send initial state to the player
    socket.emit('mainRoomJoined', {
        messages: result.messages,
        lobbies: result.lobbies,
        onlineCount: result.onlineCount
    });

    // Notify others of new player
    socket.to('mainRoom').emit('mainRoomPlayerJoined', {
        username: result.username,
        onlineCount: result.onlineCount
    });

    socketLogger.info('Player joined main room', {
        socketId: socket.id,
        username: result.username,
        onlineCount: result.onlineCount
    });
}

/**
 * Handle main room chat message
 */
function mainRoomChat(socket, io, data) {
    const { message } = data;

    if (!message || message.trim().length === 0) {
        return;
    }

    if (!gameManager.isInMainRoom(socket.id)) {
        socket.emit('error', { message: 'Not in main room' });
        return;
    }

    const result = gameManager.addMainRoomMessage(socket.id, message.trim());

    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
    }

    // Broadcast to all in main room
    io.to('mainRoom').emit('mainRoomMessage', {
        username: result.chatMessage.username,
        message: result.chatMessage.message,
        timestamp: result.chatMessage.timestamp
    });

    socketLogger.debug('Main room chat', {
        username: result.chatMessage.username
    });
}

/**
 * Handle player creating a new game lobby
 */
function createLobby(socket, io, data) {
    const { name } = data || {};

    const result = gameManager.createNamedLobby(socket.id, name);

    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
    }

    // Leave main room Socket.IO room
    socket.leave('mainRoom');

    // Notify the player
    socket.emit('lobbyCreated', {
        lobbyId: result.lobby.id,
        players: result.lobby.players,
        messages: result.lobby.messages,
        name: result.lobby.name
    });

    // Notify main room of new lobby
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies()
    });

    socketLogger.info('Player created lobby', {
        socketId: socket.id,
        lobbyId: result.lobby.id,
        lobbyName: result.lobby.name
    });
}

/**
 * Handle player joining a specific lobby
 */
function joinLobby(socket, io, data) {
    const { lobbyId } = data;

    if (!lobbyId) {
        socket.emit('error', { message: 'Lobby ID required' });
        return;
    }

    const result = gameManager.joinSpecificLobby(socket.id, lobbyId);

    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
    }

    const lobby = result.lobby;

    // Leave main room Socket.IO room
    socket.leave('mainRoom');

    // Notify the joining player
    socket.emit('lobbyCreated', {
        lobbyId: lobby.id,
        players: lobby.players,
        messages: lobby.messages,
        name: lobby.name
    });

    // Notify existing players in the lobby
    lobby.players.forEach(player => {
        if (player.socketId !== socket.id) {
            io.to(player.socketId).emit('lobbyPlayerJoined', {
                lobbyId: lobby.id,
                players: lobby.players,
                newPlayer: result.newPlayer
            });
        }
    });

    // Notify main room of updated lobbies
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies()
    });

    socketLogger.info('Player joined lobby', {
        socketId: socket.id,
        lobbyId: lobby.id,
        playerCount: lobby.players.length
    });
}

/**
 * Handle player requesting current lobby list
 */
function getLobbies(socket, io) {
    const lobbies = gameManager.getAllLobbies();
    socket.emit('lobbiesUpdated', { lobbies });
}

module.exports = {
    joinMainRoom,
    mainRoomChat,
    createLobby,
    joinLobby,
    getLobbies
};
