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

    // Compute online users once so count and list always agree
    const onlineUsers = gameManager.getOnlineUsernames();

    // Send initial state to the player
    socket.emit('mainRoomJoined', {
        messages: result.messages,
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

    // Check if this user is actually a lazy player for this game
    const lazyPosition = game.getOriginalPlayerPosition(user.username);
    if (lazyPosition && game.isLazy(lazyPosition) && !game.lazyPlayers[lazyPosition].permanentLeave) {
        // Update originalSocketId so /active will recognize this socket
        game.lazyPlayers[lazyPosition].originalSocketId = socket.id;

        // Leave main room
        socket.leave('mainRoom');
        gameManager.leaveMainRoom(socket.id);

        // Register user with new socket
        gameManager.registerUser(socket.id, user.username);

        // Add as spectator (so they can chat and use /active)
        game.addSpectator(socket.id, user.username, null);
        game.joinToRoom(io, socket.id);

        // Map socket to game
        gameManager.updatePlayerGameMapping(null, socket.id, gameId);

        // Send full game state with isLazy flag (same as reconnectHandlers lazy rejoin)
        const currentBotSocketId = game.positions[lazyPosition];
        const rejoinState = game.getClientState(currentBotSocketId);
        rejoinState.isLazy = true;
        socket.emit('rejoinSuccess', rejoinState);

        // Notify other players
        game.broadcast(io, 'spectatorJoined', {
            username: user.username,
            spectatorCount: game.getSpectators().length
        });

        socketLogger.info('Lazy player rejoined via spectate', {
            socketId: socket.id,
            username: user.username,
            gameId,
            position: lazyPosition
        });
        return;
    }

    // Leave main room
    socket.leave('mainRoom');
    gameManager.leaveMainRoom(socket.id);

    // Add as spectator
    game.addSpectator(socket.id, user.username, null);

    // Join the game's socket room (so they receive broadcasts)
    game.joinToRoom(io, socket.id);

    // Build player info for the spectator
    const playerInfo = [];
    for (let pos = 1; pos <= 4; pos++) {
        const player = game.getPlayerByPosition(pos);
        if (player) {
            playerInfo.push({
                position: pos,
                username: player.username,
                pic: player.pic,
                socketId: player.socketId
            });
        }
    }

    // Send spectator join success with game state (but no hand!)
    socket.emit('spectatorJoined', {
        gameId: game.gameId,
        players: playerInfo,
        trump: game.trump,
        currentHand: game.currentHand,
        dealer: game.dealer,
        phase: game.phase,
        bidding: game.bidding,
        currentTurn: game.currentTurn,
        bids: game.bids,
        playerBids: game.playerBids,
        tricks: game.tricks,
        score: game.score,
        playedCards: game.playedCards,
        isTrumpBroken: game.isTrumpBroken,
        gameLog: game.getGameLog(),
        spectatorCount: game.getSpectators().length
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
