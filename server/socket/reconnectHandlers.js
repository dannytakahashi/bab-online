/**
 * Reconnection socket event handlers
 */

const gameManager = require('../game/GameManager');
const { Controller, Presence } = require('../game/SeatState');
const seatLifecycle = require('./seatLifecycle');
const { socketLogger } = require('../utils/logger');
const { getUsersCollection } = require('../database');
const { verifySession } = require('../utils/sessionTokens');

/**
 * A rejoin binds this socket to `username` and hands it that seat's hand, so
 * the caller must prove it is that user: either the socket already signed in
 * / restored a session as them, or the payload carries their session token
 * (the web client rejoins straight after a reload or reconnect, before any
 * restoreSession round trip).
 */
async function isAuthorizedForUser(socket, username, sessionToken) {
    const authed = gameManager.getUserBySocketId(socket.id);
    if (authed && authed.username === username) return true;
    if (!sessionToken) return false;
    try {
        const usersCollection = getUsersCollection();
        const user = await usersCollection.findOne(
            { username },
            { projection: { sessionTokens: 1, sessionToken: 1 } }
        );
        // Per-device tokens (server/utils/sessionTokens.js); also accepts and
        // migrates a legacy plaintext sessionToken
        const session = verifySession(user, sessionToken);
        if (!session) return false;
        // Lets a later restore from another device tell this one apart
        if (socket.data) socket.data.sessionHash = session.hash;
        await usersCollection.updateOne({ username }, session.update);
        return true;
    } catch (err) {
        socketLogger.error('Rejoin auth lookup failed', { username, error: err.message });
        return false;
    }
}

/**
 * Handle a player attempting to rejoin a game after disconnect
 */
async function rejoinGame(socket, io, data) {
    const { gameId, username, sessionToken } = data;

    socketLogger.debug('Rejoin attempt', { username, gameId });

    if (!(await isAuthorizedForUser(socket, username, sessionToken))) {
        socketLogger.warn('Rejoin refused: not authenticated as user', { username, gameId, socketId: socket.id });
        socket.emit('rejoinFailed', { reason: 'Not authenticated' });
        return;
    }

    // Find the game
    const game = gameManager.getGameById(gameId);
    if (!game) {
        socketLogger.debug('Rejoin failed: game not found', { gameId });
        // Clear stale activeGameId from database
        if (username) {
            await gameManager.clearActiveGame(username);
        }
        socket.emit('rejoinFailed', { reason: 'Game no longer exists' });
        return;
    }

    const refuse = () => {
        const playersInGame = Array.from(game.players.values()).map(p => p.username);
        socketLogger.debug('Rejoin failed: player not in game', { username, playersInGame });
        socket.emit('rejoinFailed', {
            reason: 'Not a player in this game',
            debug: { lookingFor: username, playersInGame }
        });
    };

    // Before seats exist there is nothing to rejoin into yet
    if (game.entrants !== null) {
        refuse();
        return;
    }

    // The seat this user owns (human, lazy or resigned). A /leave is final.
    const position = game.seatByUsername(username);
    const seat = position ? game.seat(position) : null;
    if (!seat || seat.presence === Presence.GONE) {
        refuse();
        return;
    }

    if (seat.controller === Controller.HUMAN) {
        if (seat.seatSocketId === socket.id) {
            socketLogger.debug('Rejoin failed: already connected', { username });
            socket.emit('rejoinFailed', { reason: 'Already connected' });
            return;
        }
        // From grace / resignable, or replacing a still-live older socket
        seatLifecycle.reconnectOwner(io, game, position, socket, username);
        return;
    }

    // Bot-controlled seat: the owner watches while the bot plays
    if (seat.ownerSocketId === socket.id) {
        // Same socket asking again: idempotent, never rejoinFailed (the web
        // client drops its game on any rejoinFailed)
        const tournamentId = gameManager.tournamentGames.get(gameId) || null;
        socket.emit('rejoinSuccess', {
            ...game.getClientState(seat.seatSocketId),
            isLazy: true,
            tournamentId: tournamentId && gameManager.getTournamentById(tournamentId) ? tournamentId : null
        });
        return;
    }
    seatLifecycle.watchSeat(io, game, position, socket, username, { via: 'rejoin' });
}

module.exports = {
    rejoinGame
};
