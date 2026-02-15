/**
 * Chat socket event handlers
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { botController, personalities } = require('../game/bot');
const { PERSONALITY_LIST, getDisplayName } = personalities;

/**
 * Process slash commands from chat input
 * @returns {boolean} true if message was a slash command (don't broadcast as chat)
 */
function handleSlashCommand(socket, io, game, position, message) {
    const command = message.trim().toLowerCase();

    if (command === '/lazy') {
        return handleLazyCommand(socket, io, game, position);
    } else if (command === '/active') {
        return handleActiveCommand(socket, io, game, position);
    } else if (command === '/leave') {
        return handleLeaveCommand(socket, io, game, position);
    }

    // Unknown slash command
    game.sendToPlayer(io, socket.id, 'error', { message: `Unknown command: ${message.trim().split(' ')[0]}` });
    return true; // Still don't broadcast as chat
}

function handleLazyCommand(socket, io, game, position) {
    // Check if player is a spectator
    if (game.isSpectator(socket.id)) {
        game.sendToPlayer(io, socket.id, 'error', { message: "Spectators can't use /lazy" });
        return true;
    }

    // Check if already in lazy mode
    if (game.isLazy(position)) {
        game.sendToPlayer(io, socket.id, 'error', { message: 'Already in lazy mode. Use /active to take back control.' });
        return true;
    }

    // Check if this position was resigned (can't lazy a bot-replaced position)
    if (game.isResigned(position)) {
        game.sendToPlayer(io, socket.id, 'error', { message: 'This position has been resigned.' });
        return true;
    }

    // Pick personality — reuse assigned one if exists, otherwise pick random
    let personality = game.assignedPersonality[position];
    if (!personality) {
        personality = PERSONALITY_LIST[Math.floor(Math.random() * PERSONALITY_LIST.length)];
    }
    const displayName = getDisplayName(personality);
    const botUsername = `🤖 ${displayName}`;

    // Create bot instance
    const bot = botController.createBot(botUsername, personality);
    const botPic = Math.floor(Math.random() * 82) + 1;
    bot.position = position;
    bot.pic = botPic;

    // Register bot with controller
    botController.registerBot(game.gameId, bot);

    // Initialize bot card memory
    bot.resetCardMemory(game.currentHand, game.trump);

    // Enable lazy mode on game state
    game.enableLazyMode(position, bot.socketId, bot.username, botPic, personality);

    // Broadcast playerLazyMode event
    const player = game.getPlayerByPosition(position);
    game.broadcast(io, 'playerLazyMode', {
        position,
        botUsername: bot.username,
        botPic,
        originalUsername: game.lazyPlayers[position]?.originalUsername
    });

    // Add game log entry
    const originalUsername = game.lazyPlayers[position]?.originalUsername || 'Unknown';
    game.addLogEntry(`${originalUsername} entered lazy mode. ${bot.username} is playing.`, null, 'system');
    game.broadcast(io, 'gameLogEntry', {
        message: `${originalUsername} entered lazy mode. ${bot.username} is playing.`,
        type: 'system'
    });

    socketLogger.info('Player entered lazy mode', {
        gameId: game.gameId, position, botUsername: bot.username
    });

    // If it's this player's turn, trigger bot action
    if (game.currentTurn === position) {
        const { triggerBotIfNeeded } = require('./gameHandlers');
        const actionType = game.bidding ? 'bid' : 'play';
        triggerBotIfNeeded(io, game, actionType);
    }

    return true;
}

function handleActiveCommand(socket, io, game, position) {
    // Check if player is a spectator
    if (game.isSpectator(socket.id)) {
        game.sendToPlayer(io, socket.id, 'error', { message: "Spectators can't use /active" });
        return true;
    }

    // Check if actually in lazy mode
    if (!game.isLazy(position)) {
        game.sendToPlayer(io, socket.id, 'error', { message: 'Not in lazy mode.' });
        return true;
    }

    const lazyInfo = game.getLazyBot(position);
    const originalUsername = lazyInfo?.originalUsername || 'Unknown';
    const originalPic = lazyInfo?.originalPic;

    // Clean up the bot from controller
    if (lazyInfo?.botSocketId) {
        const gameBots = botController.gamesBots.get(game.gameId);
        if (gameBots) {
            gameBots.delete(lazyInfo.botSocketId);
        }
    }

    // Disable lazy mode on game state (restores original player info)
    game.disableLazyMode(position);

    // Broadcast playerActiveMode event
    game.broadcast(io, 'playerActiveMode', {
        position,
        username: originalUsername,
        pic: originalPic
    });

    // Add game log entry
    game.addLogEntry(`${originalUsername} is back in control.`, null, 'system');
    game.broadcast(io, 'gameLogEntry', {
        message: `${originalUsername} is back in control.`,
        type: 'system'
    });

    socketLogger.info('Player returned to active mode', {
        gameId: game.gameId, position, username: originalUsername
    });

    return true;
}

function handleLeaveCommand(socket, io, game, position) {
    // Spectators just leave
    if (game.isSpectator(socket.id)) {
        game.removeSpectator(socket.id);
        game.leaveRoom(io, socket.id);
        socket.emit('leftGame');
        socket.emit('joinMainRoom');
        return true;
    }

    // If not already lazy, enable lazy mode first
    if (!game.isLazy(position)) {
        handleLazyCommand(socket, io, game, position);
    }

    // Leave the game room (but stay associated via lazyPlayers for rejoin)
    game.leaveRoom(io, socket.id);

    // Send player to main room
    socket.emit('leftGame');

    socketLogger.info('Player left game (lazy)', {
        gameId: game.gameId, position
    });

    return true;
}

function chatMessage(socket, io, data) {
    const game = gameManager.getPlayerGame(socket.id);

    // Also check if user is a spectator in any game
    let spectatorGame = null;
    if (!game) {
        // Check all games for spectator status
        for (const [, g] of gameManager.games) {
            if (g.isSpectator(socket.id)) {
                spectatorGame = g;
                break;
            }
        }
    }

    const activeGame = game || spectatorGame;

    if (!activeGame) {
        // Not in a game, can't chat
        socketLogger.debug('Chat rejected: not in a game', { socketId: socket.id });
        return;
    }

    // Handle slash commands
    if (data.message.startsWith('/')) {
        const position = activeGame.getPositionBySocketId(socket.id);
        // Spectators: /leave always works, /active works if they were an original player
        if (activeGame.isSpectator(socket.id)) {
            const command = data.message.trim().toLowerCase();
            if (command === '/leave') {
                handleLeaveCommand(socket, io, activeGame, null);
            } else if (command === '/active') {
                // Check if this spectator was an original player in lazy mode
                const spectator = activeGame.spectators.get(socket.id);
                const username = spectator?.username;
                const position = username ? activeGame.getOriginalPlayerPosition(username) : null;
                if (position && activeGame.isLazy(position)) {
                    // Re-associate socket with the player position
                    activeGame.updatePlayerSocket(position, socket.id, io);
                    // Update lazyPlayers to track new socket
                    activeGame.lazyPlayers[position].originalSocketId = socket.id;
                    // Remove from spectators
                    activeGame.removeSpectator(socket.id);
                    // Update game-player mapping
                    gameManager.updatePlayerGameMapping(null, socket.id, activeGame.gameId);
                    // Now run normal active command (disables lazy, broadcasts playerActiveMode)
                    handleActiveCommand(socket, io, activeGame, position);
                    // Send full game state so client can rebuild with hand
                    const clientState = activeGame.getClientState(socket.id);
                    socket.emit('rejoinSuccess', clientState);
                } else {
                    activeGame.sendToPlayer(io, socket.id, 'error', { message: "Spectators can't use /active" });
                }
            } else if (command === '/lazy') {
                activeGame.sendToPlayer(io, socket.id, 'error', { message: "Spectators can't use /lazy" });
            } else {
                activeGame.sendToPlayer(io, socket.id, 'error', { message: `Unknown command: ${data.message.trim().split(' ')[0]}` });
            }
            return;
        }
        if (position && handleSlashCommand(socket, io, activeGame, position, data.message)) {
            return;
        }
    }

    const position = activeGame.getPositionBySocketId(socket.id);

    // Get player info for username
    let username;
    if (activeGame.isSpectator(socket.id)) {
        const spectator = activeGame.spectators.get(socket.id);
        username = spectator?.username || 'Spectator';
    } else {
        if (!position) {
            socketLogger.debug('Chat rejected: no position', { socketId: socket.id });
            return;
        }
        const player = activeGame.getPlayerByPosition(position);
        username = player ? player.username : 'Unknown';
    }

    // Add to game log for reconnection persistence
    activeGame.addLogEntry(`${username}: ${data.message}`, position, 'chat');

    // Broadcast to players in the same game only
    activeGame.broadcast(io, 'chatMessage', {
        position,
        message: data.message,
        username,
        isSpectator: activeGame.isSpectator(socket.id)
    });
}

module.exports = {
    chatMessage
};
