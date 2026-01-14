/**
 * Lobby socket event handlers
 * Handles pre-game lobby: ready status, chat, and leaving
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { delay } = require('../utils/timing');

/**
 * Handle player marking themselves as ready
 */
async function playerReady(socket, io) {
    const result = gameManager.setPlayerReady(socket.id);

    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
    }

    const lobby = result.lobby;

    // Broadcast ready status update to all lobby members
    lobby.players.forEach(player => {
        io.to(player.socketId).emit('playerReadyUpdate', {
            lobbyId: lobby.id,
            players: lobby.players,
            readySocketId: socket.id
        });
    });

    socketLogger.info('Player marked ready', {
        socketId: socket.id,
        lobbyId: lobby.id,
        readyCount: lobby.readyPlayers.size
    });

    // If all players are ready, start the game
    if (result.allReady) {
        socketLogger.info('All players ready, starting game', { lobbyId: lobby.id });

        // Small delay before transitioning to draw phase
        await delay(1500);

        const startResult = gameManager.startGameFromLobby(lobby.id);

        if (startResult.success) {
            const game = startResult.game;

            // Join all players to game room
            startResult.players.forEach(socketId => {
                const playerSocket = io.sockets.sockets.get(socketId);
                if (playerSocket) {
                    playerSocket.join(game.roomName);
                }
            });

            // Emit allPlayersReady to transition to draw phase
            startResult.players.forEach(socketId => {
                io.to(socketId).emit('allPlayersReady', {
                    gameId: game.gameId
                });
            });

            // After another delay, start the draw phase
            await delay(2000);

            game.phase = 'drawing';
            game.broadcast(io, 'startDraw', { start: true });
        }
    }
}

/**
 * Handle lobby chat message
 */
function lobbyChat(socket, io, data) {
    const { message } = data;

    if (!message || message.trim().length === 0) {
        return;
    }

    const result = gameManager.addLobbyMessage(socket.id, message.trim());

    if (!result.success) {
        socketLogger.debug('Lobby chat rejected', { socketId: socket.id, error: result.error });
        return;
    }

    const lobby = result.lobby;
    const chatMessage = result.chatMessage;

    // Broadcast message to all lobby members
    lobby.players.forEach(player => {
        io.to(player.socketId).emit('lobbyMessage', {
            lobbyId: lobby.id,
            username: chatMessage.username,
            message: chatMessage.message,
            timestamp: chatMessage.timestamp
        });
    });

    socketLogger.debug('Lobby chat message', {
        lobbyId: lobby.id,
        username: chatMessage.username
    });
}

/**
 * Handle player leaving lobby
 */
function leaveLobby(socket, io) {
    const result = gameManager.leaveLobby(socket.id);

    if (!result.success) {
        socket.emit('error', { message: result.error });
        return;
    }

    const lobby = result.lobby;
    const user = gameManager.getUserBySocketId(socket.id);

    socketLogger.info('Player left lobby', {
        socketId: socket.id,
        username: user?.username,
        lobbyId: lobby.id
    });

    // Notify leaving player they're back in queue/menu
    socket.emit('leftLobby', {});

    // Notify remaining players
    lobby.players.forEach(player => {
        io.to(player.socketId).emit('lobbyPlayerLeft', {
            lobbyId: lobby.id,
            players: lobby.players,
            leftUsername: user?.username || 'Unknown',
            needsMorePlayers: result.needsMorePlayers
        });
    });

    // If someone was pulled from queue to fill the slot
    if (result.filledFromQueue) {
        const newPlayer = result.filledFromQueue;

        // Notify the new player they've joined the lobby
        io.to(newPlayer.socketId).emit('lobbyCreated', {
            lobbyId: lobby.id,
            players: lobby.players,
            messages: lobby.messages
        });

        // Notify existing players about the new player
        lobby.players.forEach(player => {
            if (player.socketId !== newPlayer.socketId) {
                io.to(player.socketId).emit('lobbyPlayerJoined', {
                    lobbyId: lobby.id,
                    players: lobby.players,
                    newPlayer: {
                        socketId: newPlayer.socketId,
                        username: newPlayer.username
                    }
                });
            }
        });

        socketLogger.info('Filled lobby slot from queue', {
            lobbyId: lobby.id,
            newPlayerSocketId: newPlayer.socketId,
            newPlayerUsername: newPlayer.username
        });
    }
}

module.exports = {
    playerReady,
    lobbyChat,
    leaveLobby
};
