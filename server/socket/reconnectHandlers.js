/**
 * Reconnection socket event handlers
 */

const gameManager = require('../game/GameManager');
const { Controller, Presence } = require('../game/SeatState');
const seatLifecycle = require('./seatLifecycle');
const { socketLogger } = require('../utils/logger');
const { carrierFor } = require('./snapshotHandlers');
const { getUsersCollection } = require('../database');
const { verifySession } = require('../utils/sessionTokens');
const { rememberBlockList } = require('./voiceHandlers');
const { claimSocket, releaseClaim } = require('./authHandlers');
const { releaseIdentity } = require('./sessionIdentity');
const { deletedSince } = require('../admin/accountDelete');
const pointerResolve = require('./pointerResolve');

/**
 * A rejoin binds this socket to `username` and hands it that seat's hand, so
 * the caller must prove it is that user: either the socket already signed in
 * / restored a session as them, or the payload carries their session token
 * (the web client rejoins straight after a reload or reconnect, before any
 * restoreSession round trip).
 */
async function isAuthorizedForUser(io, socket, username, sessionToken) {
    // A name a panel merge is retiring right now cannot come back in
    // (adminHandlers applyMerge signs its sockets out first)
    if (gameManager.isMergeLocked?.(username)) return false;
    const authed = gameManager.getUserBySocketId(socket.id);
    if (authed && authed.username === username) return true;
    if (!sessionToken) return false;
    let previousClaim;
    let claimed = false;
    try {
        // Cold start (connectDB still running): wait like signIn/restoreSession
        // do, instead of refusing a web reload's rejoin
        let usersCollection = getUsersCollection();
        if (!usersCollection) {
            await require('../database').whenReady?.(10000);
            usersCollection = getUsersCollection();
        }
        const user = await usersCollection.findOne(
            { username },
            { projection: { sessionTokens: 1, sessionToken: 1, sessionEpoch: 1, blockedUsers: 1 } }
        );
        // Per-device tokens (server/utils/sessionTokens.js); also accepts and
        // migrates a legacy plaintext sessionToken
        const session = verifySession(user, sessionToken);
        if (!session) return false;
        // Signed in as another account until now: that identity goes first
        await releaseIdentity(io, socket, username);
        // Claimed before the write (authHandlers.claimSocket): a revoke
        // landing while it is in flight signs this socket out (signOutUser
        // finds it by the claim), and rejoinGame then sees it disconnected
        // before seating it. Everything from the write's reply to the seat's
        // registerUser is synchronous, so no revoke can slip in between.
        previousClaim = claimSocket(socket, username);
        claimed = true;
        // Only while no revoke landed since the read (session.filter): a
        // rejoin racing sign out everywhere / a password reset must not
        // write the revoked sessions back, and is refused instead
        const written = await usersCollection.updateOne({ username, ...session.filter }, session.update);
        if (written && written.matchedCount === 0) {
            releaseClaim(socket, username, previousClaim);
            return false;
        }
        if (gameManager.isMergeLocked?.(username)) {
            releaseClaim(socket, username, previousClaim);
            return false;
        }
        // This socket is now that user without a signIn / restoreSession
        // (a web reload rejoins first): load the block list the same way,
        // or voice signaling would have none to check
        rememberBlockList(socket, user.blockedUsers || []);
        // Lets a later restore from another device tell this one apart
        if (socket.data) socket.data.sessionHash = session.hash;
        return true;
    } catch (err) {
        if (claimed) releaseClaim(socket, username, previousClaim);
        socketLogger.error('Rejoin auth lookup failed', { username, error: err.message });
        return false;
    }
}

/** Whether the socket is still connected (socket.io sets connected=false on disconnect). */
function isLive(socket) {
    return socket.connected !== false;
}

/**
 * Handle a player attempting to rejoin a game after disconnect
 */
async function rejoinGame(socket, io, data) {
    const { gameId, username, sessionToken } = data;

    socketLogger.debug('Rejoin attempt', { username, gameId });

    if (!(await isAuthorizedForUser(io, socket, username, sessionToken))) {
        socketLogger.warn('Rejoin refused: not authenticated as user', { username, gameId, socketId: socket.id });
        socket.emit('rejoinFailed', { reason: 'Not authenticated' });
        return;
    }

    // The session lookup above awaits the DB: if the socket dropped meanwhile
    // its disconnect found nothing to clean up, so seating it now would leave
    // a 'connected' seat on a dead socket that never gets a grace timer
    if (!isLive(socket)) {
        socketLogger.info('Rejoin dropped: socket disconnected during auth', { username, gameId, socketId: socket.id });
        return;
    }

    // Find the game (the ambient demo game is "no longer exists" outside its
    // audience, AMBIENT_CHAT_USERS: no hint that it exists)
    const game = gameManager.getGameVisibleTo(gameId, username);
    if (!game) {
        // LIVE_PERSIST=on, shutting down: the table was handed off (or is
        // being), so the pointer stays and no failure is sent (the socket
        // closes in a moment and the client retries on the successor)
        if (pointerResolve.holdsPointers()) {
            socketLogger.info('Rejoin held: shutting down', { gameId, socketId: socket.id });
            return;
        }
        // LIVE_PERSIST=on: a game in no process's memory here may be saved
        // or held by another instance (pointerResolve): resolved, adopted
        // or parked; only a game that is really gone gets the failure
        if (pointerResolve.active() && !gameManager.getGameById(gameId)) {
            await pointerResolve.resolveThen(socket, gameId, 'rejoinGame', {
                onGame: () => {
                    // Awaited since the auth: the account may have been
                    // signed out or locked meanwhile (no revoke can land
                    // between the auth write and the seat otherwise)
                    if (!stillAuthorized(socket, username)) {
                        socketLogger.warn('Rejoin refused: not authenticated after the restore wait', { username, gameId, socketId: socket.id });
                        socket.emit('rejoinFailed', { reason: 'Not authenticated' });
                        return;
                    }
                    const found = gameManager.getGameVisibleTo(gameId, username);
                    if (found) return seatRejoin(socket, io, found, gameId, username);
                    return gameGone(socket, gameId, username);
                },
                onGone: () => gameGone(socket, gameId, username)
            });
            return;
        }
        await gameGone(socket, gameId, username);
        return;
    }

    seatRejoin(socket, io, game, gameId, username);
}

/** The socket is still the one `username` signed in or rejoined with, and the name is not locked. */
function stillAuthorized(socket, username) {
    if (gameManager.isMergeLocked?.(username)) return false;
    if (socket.data && socket.data.username === username) return true;
    const authed = gameManager.getUserBySocketId(socket.id);
    return Boolean(authed && authed.username === username);
}

/** The game is gone: the stale pointer cleared (scoped) and today's failure. */
async function gameGone(socket, gameId, username) {
    if (pointerResolve.holdsPointers()) {
        socketLogger.info('Rejoin held: shutting down', { gameId, socketId: socket.id });
        return;
    }
    socketLogger.debug('Rejoin failed: game not found', { gameId });
    // Clear the stale activeGameId from the database, scoped to this
    // game id: a pointer to another (live) game must stay
    if (username) {
        await gameManager.clearActiveGame(username, gameId);
    }
    socket.emit('rejoinFailed', { reason: 'Game no longer exists' });
}

/** rejoinGame once the game is found: the socket's seat (or a refusal). */
function seatRejoin(socket, io, game, gameId, username) {
    // A socket seated (or entered) in another game keeps that game: taking
    // this seat would overwrite its mapping and strand the other seat on a
    // socket whose disconnect that game never hears
    const mappedTo = gameManager.playerGames.get(socket.id);
    if (mappedTo !== undefined && mappedTo !== gameId) {
        socketLogger.warn('Rejoin refused: socket is in another game', { username, gameId, otherGameId: mappedTo });
        socket.emit('rejoinFailed', { reason: 'In another game' });
        return;
    }

    // Nor a lobby seat or another tournament (GameManager.activityOf)
    const other = gameManager.activityBesides(socket.id, gameId);
    if (other) {
        socketLogger.warn('Rejoin refused: socket belongs elsewhere', { username, gameId, kind: other.kind });
        socket.emit('rejoinFailed', { reason: other.kind === 'lobby' ? 'In a lobby' : other.kind === 'game' ? 'In another game' : 'In a tournament' });
        return;
    }

    const refuse = () => {
        const playersInGame = Array.from(game.players.values()).map(p => p.username);
        socketLogger.debug('Rejoin failed: player not in game', { username, playersInGame });
        // The names stay in the server log: rejoinFailed.debug told them
        // to whoever asked (V1_REMOVALS #15)
        socket.emit('rejoinFailed', { reason: 'Not a player in this game' });
    };

    // Before seats exist there is nothing to rejoin into yet
    if (game.entrants !== null) {
        refuse();
        return;
    }

    // The seat this user owns (human, lazy or resigned). A /leave is final.
    // A seat of an account deleted since the game was created is nobody's:
    // a new account that took the freed name never gets it (accountDelete)
    const position = deletedSince(username, game.createdAt) ? null : game.seatByUsername(username);
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
        socket.emit('rejoinSuccess', carrierFor(game, socket, {
            isLazy: true,
            tournamentId: tournamentId && gameManager.getTournamentById(tournamentId) ? tournamentId : null
        }));
        return;
    }
    seatLifecycle.watchSeat(io, game, position, socket, username, { via: 'rejoin' });
}

module.exports = {
    // Counted as a restore in flight for requestSnapshot's deferral (LIVE_PERSIST=on)
    rejoinGame: pointerResolve.tracked(rejoinGame)
};
