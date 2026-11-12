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
 *
 * Supersede: one live connection per user. When a socket signs in or
 * restores as a user whose previous socket is still connected with the
 * SAME saved session (the web copies the device's session into every new
 * tab; also a reload or reconnect whose old socket the server has not
 * dropped yet), that older socket is told `sessionSuperseded` (additive
 * s2c; web: a full-screen "open in another tab" notice with Use here) and
 * parked: every event it sends except signIn / signUp / restoreSession /
 * clientHello is refused with sessionSuperseded again (at most one a
 * second; never `error`, which iOS 1.1.0 would toast and resync), it leaves
 * the main room and spectating, and its lobby seat is held for its grace
 * (GameManager.suspendLobbySeat) so the newest socket can take it. A game
 * seat moves with the newest socket's rejoin, as before. It keeps its
 * claim (socket.data.username), so signOutUser still reaches it. A
 * previous socket with a DIFFERENT session (another device) gets
 * forceLogout, the documented rule. Restoring or signing in again on the
 * parked socket takes the session back (and parks the other one).
 */

const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');

const SUPERSEDED_REASON = 'newerConnection';
// Events a parked socket may still send: taking the session back, or
// signing in as someone else
const ALLOWED_WHILE_SUPERSEDED = new Set(['restoreSession', 'signIn', 'signUp', 'clientHello']);
const REFUSAL_EVERY_MS = 1000;

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
        delete socket.data.superseded;
        socket.data.username = undefined;
    }
    authLogger.info('Socket switched accounts: previous identity released', { from: previous, to: nextUsername });
    return previous;
}

/**
 * Right after registerUser(socket, username) reported `displacedId` (the
 * socket the name was registered on): park it at once, so its actions are
 * dropped (not 'User not registered yet') while the sign-in is re-checked.
 * Undone by cancelSupersede, made visible by confirmSupersede.
 */
function markSuperseding(io, displacedId, bySocket, username) {
    const old = displacedId && displacedId !== bySocket.id ? io?.sockets?.sockets?.get(displacedId) : null;
    if (!old || old.connected === false || !old.data) return null;
    if (old.data.username != null && old.data.username !== username) return null;
    if (!old.data.superseded) old.data.superseded = { by: bySocket.id, pending: true };
    return old;
}

function cancelSupersede(old) {
    if (old?.data?.superseded?.pending) delete old.data.superseded;
}

/**
 * The sign-in on `bySocket` stands: the parked socket is told and leaves
 * what one live connection per user allows only once (see the header).
 * Another device's socket (a different session hash) is signed out.
 * @returns {'superseded'|'signedOut'|null}
 */
function confirmSupersede(io, old, bySocket) {
    if (!old || old.connected === false || !old.data) return null;
    // It took the session back meanwhile (two restores racing: the later
    // registration wins), or is another account now
    if (gameManager.getUserBySocketId(old.id)) return null;
    const username = bySocket.data?.username;
    if (old.data.username != null && username != null && old.data.username !== username) return null;
    const oldHash = old.data.sessionHash;
    const newHash = bySocket.data?.sessionHash;
    if (oldHash && newHash && oldHash !== newHash) {
        delete old.data.superseded;
        require('./authHandlers').signOutSocket(io, old.id);
        authLogger.info('User logged out from another device', { username: old.data.username });
        return 'signedOut';
    }
    old.data.superseded = { by: bySocket.id, at: Date.now() };

    // Not online twice: out of the main room and its count, not watching
    gameManager.leaveMainRoom(old.id);
    old.leave?.('mainRoom');
    gameManager.leaveSpectating(io, old.id);
    // A lobby seat waits for the newest socket (or Use here) for its grace
    const { lobbySeatSuspended, lobbySeatExpired } = require('./lobbyHandlers');
    const held = gameManager.suspendLobbySeat(old.id, (expired) => lobbySeatExpired(io, expired));
    if (held) lobbySeatSuspended(io, held.lobby, old.id);
    if (held) require('./gameLifecycle').emitLobbiesUpdated(io);

    old.emit('sessionSuperseded', { reason: SUPERSEDED_REASON });
    authLogger.info('Older connection superseded by a newer one of the same session', {
        username: old.data.username, heldLobbySeat: Boolean(held)
    });
    return 'superseded';
}

/**
 * This socket is the user's live connection again (it signed in /
 * restored), unless a newer one registered while its sign-in was being
 * re-checked (that one's confirmSupersede parks this socket next).
 */
function clearSuperseded(socket) {
    if (!socket?.data?.superseded) return;
    const registered = gameManager.getUserBySocketId(socket.id);
    if (registered && registered.username === socket.data.username) delete socket.data.superseded;
}

/**
 * Socket.IO packet middleware (socket.use): a parked socket's events are
 * dropped, except ALLOWED_WHILE_SUPERSEDED, and answered with
 * sessionSuperseded {reason, refused} at most once a second (nothing while
 * the sign-in that parks it is still being re-checked).
 */
function supersededGate(socket) {
    return (packet, next) => {
        const parked = socket.data?.superseded;
        const event = Array.isArray(packet) ? packet[0] : undefined;
        if (!parked || ALLOWED_WHILE_SUPERSEDED.has(event)) return next();
        if (parked.pending) return undefined;
        const now = Date.now();
        if (!parked.noticeAt || now - parked.noticeAt >= REFUSAL_EVERY_MS) {
            parked.noticeAt = now;
            socket.emit('sessionSuperseded', { reason: SUPERSEDED_REASON, refused: String(event).slice(0, 64) });
        }
        return undefined;
    };
}

module.exports = {
    currentIdentity,
    belongsTo,
    releaseIdentity,
    markSuperseding,
    cancelSupersede,
    confirmSupersede,
    clearSuperseded,
    supersededGate,
    ALLOWED_WHILE_SUPERSEDED,
    SUPERSEDED_REASON
};
