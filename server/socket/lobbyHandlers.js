/**
 * Lobby socket event handlers
 * Handles pre-game lobby: ready status, chat, and leaving
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { emitError } = require('./serverError');
const { beginDraw } = require('./gameLifecycle');
const { delay } = require('../utils/timing');
const pacing = require('../game/pacing');
const { botController, personalities } = require('../game/bot');
const { getDisplayName } = personalities;

/**
 * Handle player marking themselves as ready
 */
async function playerReady(socket, io) {
    const result = gameManager.setPlayerReady(socket.id);

    if (!result.success) {
        emitError(socket, { message: result.error }, 'playerReady');
        return;
    }

    const lobby = result.lobby;

    // Auto-ready all bots when we have 4 players and a human readies
    if (lobby.players.length === 4) {
        gameManager.setBotsReady(lobby.id);
    }

    // Broadcast ready status update to all lobby members (skip bots)
    lobby.players.forEach(player => {
        if (!gameManager.isBot(player.socketId)) {
            io.to(player.socketId).emit('playerReadyUpdate', {
                lobbyId: lobby.id,
                players: lobby.players,
                readySocketId: socket.id
            });
        }
    });

    socketLogger.info('Player marked ready', {
        socketId: socket.id,
        lobbyId: lobby.id,
        readyCount: lobby.readyPlayers.size
    });

    // Check if all players are ready (including auto-readied bots)
    const allReady = lobby.readyPlayers.size === 4;

    // If all players are ready, start the game
    if (allReady) {
        socketLogger.info('All players ready, starting game', { lobbyId: lobby.id });

        // Small delay before transitioning to draw phase. A raw delay: no
        // game exists yet, and startGameFromLobby re-validates the lobby
        const lobbyMs = pacing().LOBBY_START_MS;
        pacing.trace('lobby', lobbyMs);
        await delay(lobbyMs);

        const startResult = gameManager.startGameFromLobby(lobby.id);

        if (startResult.success) {
            const game = startResult.game;

            // Register bots with bot controller (reveal real personality names)
            for (const player of lobby.players) {
                if (player.isBot) {
                    const personality = gameManager.lobbyBotPersonality(lobby, player.socketId);
                    const realName = `🤖 ${getDisplayName(personality)}`;
                    const bot = botController.createBot(realName, personality);
                    bot.socketId = player.socketId; // Use existing socket ID
                    botController.registerBot(game.gameId, bot);
                }
            }

            // Join all human players to game room
            startResult.players.forEach(socketId => {
                if (!gameManager.isBot(socketId)) {
                    const playerSocket = io.sockets.sockets.get(socketId);
                    if (playerSocket) {
                        playerSocket.join(game.roomName);
                    }
                }
            });

            // Emit allPlayersReady to human players
            startResult.players.forEach(socketId => {
                if (!gameManager.isBot(socketId)) {
                    io.to(socketId).emit('allPlayersReady', {
                        gameId: game.gameId
                    });
                }
            });

            // After another delay, start the draw phase (false: the game
            // was aborted meanwhile)
            if (!(await game.hold('countdown', pacing(game).PREDRAW_COUNTDOWN_MS))) return;

            // Deck, startDraw, bot draws, and auto-draws for anyone who
            // left or disconnected during the countdown
            beginDraw(io, game);
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

    const { filterProfanity } = require('../utils/profanityFilter');
    const result = gameManager.addLobbyMessage(socket.id, filterProfanity(message.trim()));

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
 * Handle player unmarking themselves as ready
 */
function playerUnready(socket, io) {
    const result = gameManager.unsetPlayerReady(socket.id);

    if (!result.success) {
        emitError(socket, { message: result.error }, 'playerUnready');
        return;
    }

    const lobby = result.lobby;

    // Broadcast ready status update to all lobby members
    lobby.players.forEach(player => {
        io.to(player.socketId).emit('playerReadyUpdate', {
            lobbyId: lobby.id,
            players: lobby.players,
            unreadySocketId: socket.id
        });
    });

    socketLogger.info('Player marked unready', {
        socketId: socket.id,
        lobbyId: lobby.id,
        readyCount: lobby.readyPlayers.size
    });
}

/**
 * Handle player leaving lobby
 */
function leaveLobby(socket, io) {
    const result = gameManager.leaveLobby(socket.id);

    if (!result.success) {
        emitError(socket, { message: result.error }, 'leaveLobby');
        return;
    }

    const user = gameManager.getUserBySocketId(socket.id);

    // Auto-rejoin main room
    const mainRoomResult = gameManager.joinMainRoom(socket.id);
    socket.join('mainRoom');

    // Compute online users once so count and list always agree
    const onlineUsers = gameManager.getOnlineUsernames();

    // Notify leaving player they're back to main room
    socket.emit('leftLobby', {});
    socket.emit('mainRoomJoined', {
        messages: mainRoomResult.messages,
        lobbies: mainRoomResult.lobbies,
        onlineCount: onlineUsers.length,
        onlineUsers,
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });

    // Notify main room of updated lobby list
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies(),
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });

    // If lobby was deleted (no players left), nothing more to do
    if (result.lobbyDeleted) {
        socketLogger.info('Player left lobby (lobby deleted)', {
            socketId: socket.id,
            username: user?.username
        });
        return;
    }

    const lobby = result.lobby;

    socketLogger.info('Player left lobby', {
        socketId: socket.id,
        username: user?.username,
        lobbyId: lobby.id,
        remainingPlayers: lobby.players.length
    });

    // Notify remaining players
    lobby.players.forEach(player => {
        io.to(player.socketId).emit('lobbyPlayerLeft', {
            lobbyId: lobby.id,
            players: lobby.players,
            leftUsername: user?.username || 'Unknown',
            needsMorePlayers: result.needsMorePlayers
        });

        // Notify remaining human players that this peer left voice
        if (!gameManager.isBot(player.socketId)) {
            io.to(player.socketId).emit('voicePeerLeft', {
                socketId: socket.id
            });
        }
    });
}

/**
 * A user's lobby seat left an older socket of theirs (GameManager
 * takeOverLobbySeat moved it to the new socket, or evictStaleLobbySeat gave
 * up a seat in another lobby). Existing events only: the old socket gets
 * leftLobby (a half-open socket never receives it; a second live tab of the
 * same device goes back to the main room), and the lobby's other humans drop
 * the old socket's voice peer. On an eviction the remaining players also get
 * lobbyPlayerLeft, as for a leave. The caller sends lobbiesUpdated and the
 * join notifications.
 *
 * @param {Object} io
 * @param {Object} change { oldSocketId, newSocketId, lobby } for a takeover,
 *   { oldSocketId, newSocketId, leaveResult, username } for an eviction
 */
function releaseStaleLobbySeat(io, change) {
    if (!change || !change.oldSocketId) return;
    const { oldSocketId, newSocketId } = change;

    io.to(oldSocketId).emit('leftLobby', {});

    const leave = change.leaveResult;
    const lobby = leave ? (leave.lobbyDeleted ? null : leave.lobby) : change.lobby;
    if (!lobby) return;

    lobby.players.forEach(player => {
        if (player.socketId === newSocketId) return;
        if (leave) {
            io.to(player.socketId).emit('lobbyPlayerLeft', {
                lobbyId: lobby.id,
                players: lobby.players,
                leftUsername: change.username || 'Unknown',
                needsMorePlayers: leave.needsMorePlayers
            });
        }
        if (!gameManager.isBot(player.socketId)) {
            io.to(player.socketId).emit('voicePeerLeft', { socketId: oldSocketId });
        }
    });

    socketLogger.info(leave ? 'Stale lobby seat given up' : 'Lobby seat moved to new socket', {
        oldSocketId,
        newSocketId,
        lobbyId: lobby.id
    });
}

/**
 * Handle adding a bot to the lobby
 */
function addBot(socket, io) {
    const lobby = gameManager.getPlayerLobby(socket.id);

    if (!lobby) {
        emitError(socket, { message: 'Not in a lobby' }, 'addBot');
        return;
    }

    if (lobby.players.length >= 4) {
        emitError(socket, { message: 'Lobby is full' }, 'addBot');
        return;
    }

    const result = gameManager.addBotToLobby(lobby.id);

    if (!result.success) {
        emitError(socket, { message: result.error }, 'addBot');
        return;
    }

    socketLogger.info('Bot added to lobby', {
        lobbyId: lobby.id,
        botName: result.botPlayer.username,
        playerCount: lobby.players.length
    });

    // Broadcast updated player list to all human lobby members
    lobby.players.forEach(player => {
        if (!gameManager.isBot(player.socketId)) {
            io.to(player.socketId).emit('playerReadyUpdate', {
                lobbyId: lobby.id,
                players: lobby.players
            });
        }
    });

    // Also update main room lobby list
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies(),
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });
}

/**
 * Handle removing a bot from the lobby
 */
function removeBot(socket, io, data) {
    const { botSocketId } = data;

    const lobby = gameManager.getPlayerLobby(socket.id);

    if (!lobby) {
        emitError(socket, { message: 'Not in a lobby' }, 'removeBot');
        return;
    }

    const result = gameManager.removeBotFromLobby(lobby.id, botSocketId);

    if (!result.success) {
        emitError(socket, { message: result.error }, 'removeBot');
        return;
    }

    socketLogger.info('Bot removed from lobby', {
        lobbyId: lobby.id,
        botSocketId,
        playerCount: lobby.players.length
    });

    // Broadcast updated player list to all human lobby members
    lobby.players.forEach(player => {
        if (!gameManager.isBot(player.socketId)) {
            io.to(player.socketId).emit('playerReadyUpdate', {
                lobbyId: lobby.id,
                players: lobby.players
            });
        }
    });

    // Also update main room lobby list
    io.to('mainRoom').emit('lobbiesUpdated', {
        lobbies: gameManager.getAllLobbies(),
        inProgressGames: gameManager.getInProgressGames(),
        tournaments: gameManager.getAllTournaments()
    });
}

module.exports = {
    playerReady,
    playerUnready,
    lobbyChat,
    leaveLobby,
    releaseStaleLobbySeat,
    addBot,
    removeBot
};
