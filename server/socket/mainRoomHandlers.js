/**
 * Main room socket event handlers
 * Handles global chat and lobby browsing before joining a game lobby
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { Controller, Presence } = require('../game/SeatState');
const seatLifecycle = require('./seatLifecycle');
const { spectatorJoinState, snapshotFor } = require('./snapshotHandlers');
const { hasCap } = require('./clientInfo');
const { releaseStaleLobbySeat } = require('./lobbyHandlers');

/**
 * Handle player joining the main room
 */
function joinMainRoom(socket, io) {
    // Back in the main room: a pure spectator stops watching its game
    // (never affects a seat owner's socket)
    gameManager.leaveSpectating(io, socket.id);

    const result = gameManager.joinMainRoom(socket.id);

    if (!result.success) {
        socket.emit('error', { message: result.error || 'Failed to join main room' });
        return;
    }

    // Join the Socket.IO room for main room broadcasts
    socket.join('mainRoom');

    // Compute online users once so count and list always agree
    const onlineUsers = gameManager.getOnlineUsernames();

    // Send initial state to the player.
    // recentMessages duplicates messages: the iOS client reads that key for
    // the chat history replay (web reads messages) — keep both populated.
    socket.emit('mainRoomJoined', {
        messages: result.messages,
        recentMessages: result.messages,
        lobbies: result.lobbies,
        onlineCount: onlineUsers.length,
        onlineUsers,
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });

    // Notify others of new player
    socket.to('mainRoom').emit('mainRoomPlayerJoined', {
        username: result.username,
        onlineCount: onlineUsers.length,
        onlineUsers
    });

    socketLogger.info('Player joined main room', {
        socketId: socket.id,
        username: result.username,
        onlineCount: onlineUsers.length
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

    const { filterProfanity } = require('../utils/profanityFilter');
    const result = gameManager.addMainRoomMessage(socket.id, filterProfanity(message.trim()));

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

    const { filterProfanity } = require('../utils/profanityFilter');
    const result = gameManager.createNamedLobby(socket.id, name ? filterProfanity(name) : name);

    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
    }

    // A seat this user held elsewhere from an older socket was given up
    if (result.evicted) {
        releaseStaleLobbySeat(io, { ...result.evicted, newSocketId: socket.id, username: result.lobby.createdBy });
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
        lobbies: gameManager.getAllLobbies(),
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
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

    // Re-entry from a new socket: the seat moved here from the older one
    // (or a seat in another lobby was given up). The joined notifications
    // below carry the updated list.
    if (result.replacedSocketId) {
        releaseStaleLobbySeat(io, { oldSocketId: result.replacedSocketId, newSocketId: socket.id, lobby });
    } else if (result.evicted) {
        releaseStaleLobbySeat(io, { ...result.evicted, newSocketId: socket.id, username: result.newPlayer.username });
    }

    // Leave main room Socket.IO room
    socket.leave('mainRoom');

    // Notify the joining player (with the seats held for a reconnect)
    socket.emit('lobbyCreated', {
        lobbyId: lobby.id,
        players: lobby.players,
        messages: lobby.messages,
        name: lobby.name,
        ...gameManager.reconnectingField(lobby.id)
    });

    // Notify existing players in the lobby
    const existingHumans = [];
    lobby.players.forEach(player => {
        if (player.socketId !== socket.id) {
            io.to(player.socketId).emit('lobbyPlayerJoined', {
                lobbyId: lobby.id,
                players: lobby.players,
                newPlayer: result.newPlayer
            });

            // Send voicePeerJoined to existing human players
            if (!gameManager.isBot(player.socketId)) {
                existingHumans.push({ socketId: player.socketId, username: player.username });
                io.to(player.socketId).emit('voicePeerJoined', {
                    socketId: socket.id,
                    username: result.newPlayer.username
                });
            }
        }
    });

    // Send voicePeerList to the joining player
    if (existingHumans.length > 0) {
        socket.emit('voicePeerList', { peers: existingHumans });
    }

    // Notify main room of updated lobbies
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies(),
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
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
    const inProgressGames = gameManager.getInProgressGames();
    socket.emit('lobbiesUpdated', { lobbies, inProgressGames, tournaments: gameManager.getAllTournaments() });
}

/**
 * Handle player joining a game as a spectator
 */
function joinAsSpectator(socket, io, data) {
    const { gameId } = data;

    const game = gameManager.getGameById(gameId);
    if (!game) {
        socket.emit('error', { message: 'Game not found' });
        return;
    }

    const user = gameManager.getUserBySocketId(socket.id);
    if (!user) {
        socket.emit('error', { message: 'User not found' });
        return;
    }

    // An owner of this game comes back to their own seat, not as a spectator
    const ownPos = game.seatByUsername(user.username);
    const ownSeat = ownPos ? game.seat(ownPos) : null;
    if (ownSeat && ownSeat.controller !== Controller.HUMAN &&
        (ownSeat.presence === Presence.CONNECTED || ownSeat.presence === Presence.AWAY)) {
        // Lazy or resigned seat: watch it while the bot plays (/active works)
        seatLifecycle.watchSeat(io, game, ownPos, socket, user.username, { via: 'spectate' });
        return;
    }
    if (ownSeat && ownSeat.controller === Controller.HUMAN &&
        (ownSeat.presence === Presence.GRACE || ownSeat.presence === Presence.RESIGNABLE)) {
        socket.leave('mainRoom');
        gameManager.leaveMainRoom(socket.id);
        seatLifecycle.reconnectOwner(io, game, ownPos, socket, user.username);
        return;
    }

    // A pure spectator (of one game at a time), in the game's room
    if (!gameManager.addSpectator(io, game, socket.id, user.username, null)) {
        socketLogger.warn('Spectate refused: socket is in a game', { socketId: socket.id, gameId });
        socket.emit('error', { message: 'Leave your current game before spectating another' });
        return;
    }

    // Leave main room
    socket.leave('mainRoom');
    gameManager.leaveMainRoom(socket.id);

    // Send spectator join success with game state (but no hand!), then the
    // v2 snapshot (additive), BEFORE the room notice
    socket.emit('spectatorJoined', {
        ...spectatorJoinState(game, { capable: hasCap(socket, 'avatarUrl') }),
        snapshot: snapshotFor(game, socket.id, { customPics: false })
    });

    // Notify other players
    game.broadcast(io, 'spectatorJoined', {
        username: user.username,
        spectatorCount: game.getSpectators().length
    });

    socketLogger.info('Player joined as spectator', {
        socketId: socket.id,
        username: user.username,
        gameId
    });
}

module.exports = {
    joinMainRoom,
    mainRoomChat,
    createLobby,
    joinLobby,
    getLobbies,
    joinAsSpectator
};
