/**
 * Who a socket is. Identity is per SOCKET: a socket is signed in as at most
 * one account (GameManager.registerUser keeps one entry per username AND
 * per socket), and `socket.data.username` is the account it is (or is about
 * to be) signed in as.
 *
 * releaseIdentity: a socket that signs in, restores or signs up as another
 * account (sign out, then sign in as B on the same socket) first stops
 * being the old one completely: registration, claim, session hash, block
 * list, main room, lobby seat (left at once, no grace: the player chose to
 * switch), spectating, tournament presence and game seat (the old
 * account's seat gets its reconnect grace, as if that player dropped), and
 * every Socket.IO room. So an admin signing out B never reaches A's game,
 * and signing out A never reaches the socket that is B now.
 */

const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');

/** The account `socket` is now: its registration, else its claim. */
function currentIdentity(socket) {
    const registered = gameManager.getUserBySocketId(socket.id);
    if (registered) return registered.username;
    const claimed = socket.data?.username;
    return claimed == null ? null : claimed;
}

/**
 * May a sign-out of `username` touch this socket? Not when the socket is
 * signed in as (or claims) another account now: users.socketId of the old
 * account can still name a socket that switched accounts.
 */
function belongsTo(socketId, sock, username) {
    const registered = gameManager.getUserBySocketId(socketId);
    if (registered && registered.username !== username) return false;
    const claimed = sock?.data?.username;
    return claimed == null || claimed === username;
}

/** Every room the socket is in except its own (real Socket.IO, or the test stub's io.rooms). */
function roomsOf(io, socket) {
    if (socket.rooms && typeof socket.rooms[Symbol.iterator] === 'function') return [...socket.rooms];
    const rooms = [];
    if (io?.rooms instanceof Map) {
        for (const [room, members] of io.rooms) if (members.has(socket.id)) rooms.push(room);
    }
    return rooms;
}

/**
 * Before `socket` becomes `nextUsername`: if it is another account now,
 * tear that identity down (see the header). Returns the old name, or null
 * when there was nothing to release.
 */
async function releaseIdentity(io, socket, nextUsername) {
    const previous = currentIdentity(socket);
    if (previous == null || previous === nextUsername) return null;

    // The disconnect bookkeeping, for a socket that stays connected; lazy
    // require (queueHandlers -> lobbyHandlers / seatLifecycle)
    // A failure here must not leave the socket half A: log it, and the
    // registration and claim below still go
    try {
        const { handleDisconnect } = require('./queueHandlers');
        await handleDisconnect(socket, io, { lobbyGrace: false });
    } catch (error) {
        authLogger.error('Releasing the previous identity failed', { from: previous, error: error.message });
    }

    for (const room of roomsOf(io, socket)) {
        if (room !== socket.id) socket.leave(room);
    }
    gameManager.removeUserSocket(socket.id);
    if (socket.data) {
        delete socket.data.sessionHash;
        delete socket.data.blockedUsers;
        socket.data.username = undefined;
    }
    authLogger.info('Socket switched accounts: previous identity released', { from: previous, to: nextUsername });
    return previous;
}

module.exports = {
    currentIdentity,
    belongsTo,
    releaseIdentity
};
