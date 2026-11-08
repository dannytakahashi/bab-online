/**
 * Chat socket event handlers
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { abortGame } = require('./gameLifecycle');
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

    // If it's this player's turn, trigger bot action (not while a trick or
    // hand resolves: the next updateTurn re-triggers it)
    const actionType = game.actionTypeForTurn();
    if (game.currentTurn === position && actionType) {
        const { triggerBotIfNeeded } = require('./gameHandlers');
        triggerBotIfNeeded(io, game, actionType);
    }

    return true;
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.resendTurn=true] - re-send updateTurn to the
 *   returning socket so it can act if it is already their turn (the pending
 *   lazy-bot action is dropped). The spectator path sends restorePlayerState
 *   instead, which carries the turn and hand.
 */
function handleActiveCommand(socket, io, game, position, { resendTurn = true } = {}) {
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

    // Drop the lazy bot's pending action for this seat
    game.clearTimer('lazy:' + position);

    // Clean up the bot from controller
    if (lazyInfo?.botSocketId) {
        const gameBots = botController.gamesBots.get(game.gameId);
        if (gameBots) {
            gameBots.delete(lazyInfo.botSocketId);
        }
    }

    // Disable lazy mode on game state (restores original player info)
    game.disableLazyMode(position);

    // A resigned seat (converted to lazy on rejoin) carries the resign bot's
    // player entry, which updatePlayerSocket moved onto this socket. Make the
    // seat fully human again, or sendToPlayer skips it (no next-hand cards)
    // and the resign bot's pending action could still fire for it.
    if (game.isResigned(position)) {
        const seatSocketId = game.positions[position];
        const seat = game.players.get(seatSocketId);
        if (seat) seat.isBot = false;
        delete game.resignedPlayers[position];
        if (lazyInfo?.botSocketId) {
            botController.cancelBotActions(game.gameId, lazyInfo.botSocketId);
            if (gameManager.playerGames.get(lazyInfo.botSocketId) === game.gameId) {
                gameManager.playerGames.delete(lazyInfo.botSocketId);
            }
        }
    }

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

    // Only while a turn is open (not during trick/hand resolution: the next
    // updateTurn follows shortly)
    if (resendTurn && game.acceptsTurnInput()) {
        game.sendToPlayer(io, socket.id, 'updateTurn', { currentTurn: game.currentTurn });
    }

    return true;
}

/**
 * After a permanent leave: abort if no human is left to play for; otherwise,
 * if nobody present could forceResign the disconnected seats, give those a
 * fresh grace period (theirs may already have run out while the leaver was
 * still there) after which the game aborts unless one of them is back.
 */
function checkRemainingHumans(io, game) {
    const goneForGood = (p) => p.isBot || game.isResigned(p.position) ||
        (game.isLazy(p.position) && game.lazyPlayers[p.position].permanentLeave);
    const seats = Array.from(game.players.values());

    if (seats.every(goneForGood)) {
        socketLogger.warn('All humans permanently left, aborting game', { gameId: game.gameId });
        // The synchronous part (broadcast, retire, lobbiesUpdated) runs now;
        // DB clears and tournament follow-up continue in the background
        abortGame(io, game, 'All players left').catch(err =>
            socketLogger.error('Abort failed', { gameId: game.gameId, error: err.message, stack: err.stack })
        );
    } else {
        const { ensureGraceIfAbandoned } = require('./queueHandlers');
        ensureGraceIfAbandoned(io, game);
    }
}

function handleLeaveCommand(socket, io, game, position) {
    // Spectators just leave
    if (game.isSpectator(socket.id)) {
        const spectator = game.spectators.get(socket.id);
        game.removeSpectator(socket.id);
        game.leaveRoom(io, socket.id);
        // A rejoin shadow is mapped to the game; free it for new lobbies
        if (gameManager.playerGames.get(socket.id) === game.gameId) {
            gameManager.playerGames.delete(socket.id);
        }
        socket.emit('leftGame');
        socket.emit('joinMainRoom');

        // The rejoin shadow of a lazy/resigned seat leaving is that human
        // leaving for good: the bot keeps the seat and the table must not
        // wait for them
        const seat = spectator?.username ? game.getOriginalPlayerPosition(spectator.username) : null;
        const lazyInfo = seat ? game.lazyPlayers[seat] : null;
        if (lazyInfo && lazyInfo.originalSocketId === socket.id && !lazyInfo.permanentLeave) {
            lazyInfo.permanentLeave = true;
            gameManager.clearActiveGame(spectator.username, game.gameId);
            socketLogger.info('Player left game from spectator view (permanent)', { gameId: game.gameId, position: seat });
            checkRemainingHumans(io, game);
        }
        return true;
    }

    // If not already lazy, enable lazy mode first
    if (!game.isLazy(position)) {
        handleLazyCommand(socket, io, game, position);
    }

    // Mark as permanent leave (bot keeps playing, but player can't /active back)
    game.lazyPlayers[position].permanentLeave = true;

    // Leave the game room (bot continues via lazyPlayers entry)
    game.leaveRoom(io, socket.id);

    // Remove in-memory player→game mapping so the player can create/join lobbies
    gameManager.playerGames.delete(socket.id);

    // Clear activeGameId in DB so the player can create new lobbies / join tournaments
    const user = gameManager.getUserBySocketId(socket.id);
    if (user) {
        gameManager.clearActiveGame(user.username);
    }

    // Send player to main room
    socket.emit('leftGame');

    socketLogger.info('Player left game (permanent)', {
        gameId: game.gameId, position
    });

    checkRemainingHumans(io, game);

    return true;
}

/**
 * Leave during the draw phase, before positions exist. Mirrors the
 * disconnect-during-draw handling: auto-draw a card for the leaver so the
 * phase can complete, mark their seat for bot replacement, and send them out.
 */
function handleDrawPhaseLeave(socket, io, game) {
    // Idempotent: a second leave from the same socket changes nothing
    if (game._drawPhaseDisconnects?.[socket.id]?.left) return;

    const user = gameManager.getUserBySocketId(socket.id);
    const username = user?.username || 'Player';

    // No-op if they already drew (or the draw is no longer open)
    const { autoDraw } = require('./gameHandlers');
    const drewNow = autoDraw(io, game, socket.id, username);

    // Mark the seat for bot replacement once positions are assigned
    // (handleDrawComplete seats a bot for `left` entries)
    if (!game._pendingUsernames) game._pendingUsernames = {};
    game._pendingUsernames[socket.id] = username;
    if (!game._drawPhaseDisconnects) game._drawPhaseDisconnects = {};
    game._drawPhaseDisconnects[socket.id] = { username, left: true };

    const msg = `${username} left during card draw.`;
    game.addLogEntry(msg, null, 'system');
    game.broadcast(io, 'gameLogEntry', { message: msg, type: 'system' });

    game.leaveRoom(io, socket.id);
    gameManager.playerGames.delete(socket.id);
    if (user) {
        gameManager.clearActiveGame(user.username);
    }
    socket.emit('leftGame');

    socketLogger.info('Player left during draw phase', { gameId: game.gameId, username });

    // Only when this leave supplied the 4th card: if the leaver had already
    // drawn, the 4th draw has already started handleDrawComplete
    if (drewNow && game.drawIndex === 4) {
        const { handleDrawComplete } = require('./gameHandlers');
        handleDrawComplete(io, game).catch(err =>
            socketLogger.error('handleDrawComplete failed', { gameId: game.gameId, error: err.message, stack: err.stack })
        );
    }
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
                if (position && activeGame.isLazy(position) && !activeGame.lazyPlayers[position].permanentLeave) {
                    // Re-associate socket with the player position
                    activeGame.updatePlayerSocket(position, socket.id, io);
                    // Update lazyPlayers to track new socket
                    activeGame.lazyPlayers[position].originalSocketId = socket.id;
                    // Remove from spectators
                    activeGame.removeSpectator(socket.id);
                    // Update game-player mapping
                    gameManager.updatePlayerGameMapping(null, socket.id, activeGame.gameId);
                    // Now run normal active command (disables lazy, broadcasts playerActiveMode)
                    handleActiveCommand(socket, io, activeGame, position, { resendTurn: false });
                    // Send full game state so client can transition from spectator to player
                    socket.emit('restorePlayerState', activeGame.getClientState(socket.id));
                } else {
                    return; // Pure spectator can't use /active, silently ignore
                }
            } else {
                return; // Silently ignore /lazy, unknown commands for pure spectators
            }
            return;
        }
        // /leave works during the draw phase too, before positions exist
        if (!position && activeGame.isPreSeating() &&
            data.message.trim().toLowerCase() === '/leave') {
            handleDrawPhaseLeave(socket, io, activeGame);
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

    const { filterProfanity } = require('../utils/profanityFilter');
    const cleanMessage = filterProfanity(data.message);

    // Add to game log for reconnection persistence
    activeGame.addLogEntry(`${username}: ${cleanMessage}`, position, 'chat');

    // Broadcast to players in the same game only
    activeGame.broadcast(io, 'chatMessage', {
        position,
        message: cleanMessage,
        username,
        isSpectator: activeGame.isSpectator(socket.id)
    });
}

module.exports = {
    chatMessage
};
