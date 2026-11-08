/**
 * Chat socket event handlers (in-game chat and the /lazy /active /leave
 * slash commands).
 *
 * The sender's role decides what a message may do:
 *   owner      the socket in a seat's ownerSocketId (human at the seat, or the
 *              owner of a lazy / resigned seat watching it, in 'seat' or
 *              'watch' view)
 *   entrant    a mapped socket before seats exist (countdown, draw)
 *   spectator  a pure spectator (gameManager.spectatorGames), incl. a stale
 *              shadow demoted when a newer socket took the seat
 * Anything else that is mapped (a bot or stale socket) is ignored.
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');
const { Controller, Presence } = require('../game/SeatState');
const seatLifecycle = require('./seatLifecycle');

/** @returns {{game, role, pos}|null} */
function resolveSender(socketId) {
    const game = gameManager.getPlayerGame(socketId);
    if (game) {
        const pos = game.seatByOwnerSocket(socketId);
        if (pos) return { game, role: 'owner', pos };
        if (game.entrant(socketId)) return { game, role: 'entrant', pos: null };
        return null;
    }
    const gameId = gameManager.spectatorGames.get(socketId);
    const spectated = gameId ? gameManager.getGameById(gameId) : null;
    if (spectated && spectated.isSpectator(socketId)) return { game: spectated, role: 'spectator', pos: null };
    return null;
}

function sendError(io, game, socket, message) {
    game.sendToPlayer(io, socket.id, 'error', { message });
}

/** Slash commands from a seat owner. */
function ownerCommand(socket, io, game, pos, message) {
    const command = message.trim().toLowerCase();
    const seat = game.seat(pos);

    if (seat.controller === Controller.HUMAN) {
        if (command === '/lazy') {
            seatLifecycle.goLazy(io, game, pos);
        } else if (command === '/active') {
            sendError(io, game, socket, 'Not in lazy mode.');
        } else if (command === '/leave') {
            seatLifecycle.leaveSeat(io, game, pos, socket);
        } else {
            sendError(io, game, socket, `Unknown command: ${message.trim().split(' ')[0]}`);
        }
        return;
    }

    // Bot-controlled seat (lazy, or resigned and rejoined)
    if (command === '/active') {
        seatLifecycle.goActive(io, game, pos, socket);
    } else if (command === '/leave') {
        seatLifecycle.leaveSeat(io, game, pos, socket);
    } else if (seat.ownerView === 'seat') {
        if (command === '/lazy') {
            sendError(io, game, socket, 'Already in lazy mode. Use /active to take back control.');
        } else {
            sendError(io, game, socket, `Unknown command: ${message.trim().split(' ')[0]}`);
        }
    }
    // Watch view: /lazy and unknown commands are ignored (spectator-shaped client)
}

/**
 * A pure spectator: /leave stops spectating. /active takes back the seat of
 * the user this spectator was recorded as (server-side, at joinAsSpectator
 * or when a newer socket demoted it) if that seat is bot-controlled with no
 * owner socket attached; otherwise the owner is told why not. Everything else
 * is ignored.
 */
function spectatorCommand(socket, io, game, message) {
    const command = message.trim().toLowerCase();
    if (command === '/leave') {
        gameManager.leaveSpectating(io, socket.id);
        socket.emit('leftGame');
        socket.emit('joinMainRoom');
        return;
    }
    if (command !== '/active') return;
    const username = game.spectators.get(socket.id)?.username;
    const authed = gameManager.getUserBySocketId(socket.id);
    if (!username || (authed && authed.username !== username)) return;
    const pos = game.seatByUsername(username);
    const seat = pos ? game.seat(pos) : null;
    if (!seat) return; // an ordinary spectator
    if (seat.controller !== Controller.HUMAN && seat.presence === Presence.AWAY) {
        seatLifecycle.reclaimSeat(io, game, pos, socket, username);
    } else if (seat.presence !== Presence.GONE) {
        sendError(io, game, socket, 'Your seat is controlled from another connection. Reconnect to take it back.');
    }
}

/**
 * Leave during the draw phase, before positions exist. Mirrors the
 * disconnect-during-draw handling: auto-draw a card for the leaver so the
 * phase can complete, mark the entrant 'left' (handleDrawComplete seats a
 * bot for it), and send them out.
 */
function handleDrawPhaseLeave(socket, io, game) {
    // Idempotent: a second leave from the same socket changes nothing
    const entrant = game.entrant(socket.id);
    if (!entrant || entrant.presence === 'left') return;

    const user = gameManager.getUserBySocketId(socket.id);
    const username = entrant.username || user?.username || 'Player';

    // No-op if they already drew (or the draw is no longer open)
    const { autoDraw } = require('./gameHandlers');
    const drewNow = autoDraw(io, game, socket.id, username);

    game.markEntrantLeft(socket.id);

    const msg = `${username} left during card draw.`;
    game.addLogEntry(msg, null, 'system');
    game.broadcast(io, 'gameLogEntry', { message: msg, type: 'system' });

    game.leaveRoom(io, socket.id);
    if (gameManager.playerGames.get(socket.id) === game.gameId) gameManager.playerGames.delete(socket.id);
    const owner = entrant.username || user?.username;
    if (owner) gameManager.clearActiveGame(owner, game.gameId);
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
    const sender = resolveSender(socket.id);
    if (!sender) {
        socketLogger.debug('Chat rejected: not in a game', { socketId: socket.id });
        return;
    }
    const { game, role, pos } = sender;
    const isCommand = data.message.startsWith('/');

    if (role === 'spectator') {
        if (isCommand) {
            spectatorCommand(socket, io, game, data.message);
            return;
        }
    } else if (role === 'entrant') {
        // Before seats exist only /leave does anything
        if (isCommand && data.message.trim().toLowerCase() === '/leave') {
            handleDrawPhaseLeave(socket, io, game);
        } else {
            socketLogger.debug('Chat rejected: no position', { socketId: socket.id });
        }
        return;
    } else if (isCommand) {
        ownerCommand(socket, io, game, pos, data.message);
        return;
    }

    // Plain chat. A seat-view owner speaks from the seat; a watching owner
    // and spectators speak as spectators.
    let position = null;
    let username;
    let isSpectator = true;
    if (role === 'spectator') {
        username = game.spectators.get(socket.id)?.username || 'Spectator';
    } else {
        const seat = game.seat(pos);
        if (seat.controller === Controller.HUMAN || seat.ownerView === 'seat') {
            position = pos;
            isSpectator = false;
            // The sender is the human, also while their bot plays the seat
            // (clients match it against block lists and their own name)
            username = seat.ownerUsername;
        } else {
            username = seat.ownerUsername;
        }
    }

    const { filterProfanity } = require('../utils/profanityFilter');
    const cleanMessage = filterProfanity(data.message);

    // Add to game log for reconnection persistence
    game.addLogEntry(`${username}: ${cleanMessage}`, position, 'chat');

    // Broadcast to players in the same game only
    game.broadcast(io, 'chatMessage', {
        position,
        message: cleanMessage,
        username,
        isSpectator
    });
}

module.exports = {
    chatMessage
};
