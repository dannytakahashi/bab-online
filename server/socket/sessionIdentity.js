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
 * second; never serverError, which a client would toast and resync), it leaves
 * the main room and spectating, and its lobby seat is held for its grace
 * (GameManager.suspendLobbySeat) so the newest socket can take it. A game
 * seat moves with the newest socket's rejoin, as before. It keeps its
 * claim (socket.data.username), so signOutUser still reaches it. A
 * previous socket with a DIFFERENT session (another device) gets
 * forceLogout, the documented rule. Restoring or signing in again on the
 * parked socket takes the session back (and parks the other one), with its
 * lobby seat if that is still held for it (clearSuperseded). A parked
 * socket that signs in as another account gives its held seat up at once
 * (releaseIdentity).
 *
 * The other tab closed (2026-11-11, session-quirks follow-up): when the
 * user's LIVE socket disconnects while a parked socket of that same user
 * is still connected, the parked socket(s) are told `sessionSuperseded
 * {reason: 'otherClosed'}` (additive variant; web: "The other BAB Online
 * tab was closed. Use here to continue.") OTHER_CLOSED_DELAY_MS later, and
 * only if no socket holds the session by then: a reload of the active tab
 * drops its old socket and re-takes the session within moments, so it
 * never flashes. Nothing is taken back by itself (the parked tab still
 * waits for Use here, else a reload of the other tab would flip-flop);
 * when a socket takes the session after that, the parked ones told
 * 'otherClosed' are told 'newerConnection' again (reparkClosedNotices).
 * Only that user's own parked sockets are told. iOS 1.1.0 never has a
 * parked socket (it never shares a token between live sockets).
 * Limitation (review 2026-11-12): a parked tab never restores, so after
 * its socket reconnects (a deploy, a network blip) the new socket has no
 * data.username / data.superseded and parkedSocketsOf cannot find it: it
 * is told nothing more (the web notice then says only that the other tab
 * may still be open). Profile Sign Out is client-only (no token revoked):
 * a parked web tab signs itself out when the device's saved session is
 * gone, before it offers to continue.
 */

const gameManager = require('../game/GameManager');
const { authLogger } = require('../utils/logger');

const SUPERSEDED_REASON = 'newerConnection';
const OTHER_CLOSED_REASON = 'otherClosed';
// Long enough for a reload of the active tab to re-take the session
const OTHER_CLOSED_DELAY_MS = 2000;
const otherClosedTimers = new Map(); // username -> timeout
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
        // A seat held for this very socket (it was parked: confirmSupersede)
        // has no mapping, so the leave below misses it: given up here, at once
        const expired = gameManager.releaseHeldLobbySeat(socket.id);
        if (expired) require('./lobbyHandlers').lobbySeatExpired(io, expired, { tellOld: false });
        const { handleDisconnect } = require('./queueHandlers');
        // (the socket stays connected: no 'otherClosed' for its parked tabs)
        await handleDisconnect(socket, io, { lobbyGrace: false, closed: false });
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
function clearSuperseded(socket, io = null) {
    if (!socket?.data?.superseded) return;
    const registered = gameManager.getUserBySocketId(socket.id);
    if (!registered || registered.username !== socket.data.username) return;
    delete socket.data.superseded;
    // Its lobby seat, if still held for it (no newer socket took it), is
    // its own again in place (a re-sent joinLobby then just gets the lobby)
    const resumed = gameManager.resumeHeldLobbySeat(socket.id, registered.username);
    if (resumed && io) {
        socket.leave?.('mainRoom');
        require('./lobbyHandlers').lobbySeatResumed(io, resumed.lobby, socket.id, registered.username);
    }
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
            // the reason it was last told: a refusal never changes its text
            socket.emit('sessionSuperseded', { reason: parked.reason || SUPERSEDED_REASON, refused: String(event).slice(0, 64) });
        }
        return undefined;
    };
}

/** The user's parked (told, not pending) sockets that are still connected. */
function parkedSocketsOf(io, username, exceptId = null) {
    const sockets = io?.sockets?.sockets;
    if (!sockets || username == null) return [];
    const out = [];
    for (const s of sockets.values()) {
        if (!s || s.id === exceptId || s.connected === false || !s.data) continue;
        if (s.data.username !== username) continue;
        const parked = s.data.superseded;
        if (!parked || parked.pending) continue;
        // registered: that is the live socket, not a parked one
        if (gameManager.getUserBySocketId(s.id)) continue;
        out.push(s);
    }
    return out;
}

/** Does a connected socket hold the user's session (registered as them)? */
function hasLiveSocket(io, username) {
    const entry = gameManager.currentUsers.find((u) => u.username === username);
    if (!entry) return false;
    const live = io?.sockets?.sockets?.get(entry.socketId);
    return Boolean(live) && live.connected !== false;
}

function cancelOtherClosed(username) {
    const timer = otherClosedTimers.get(username);
    if (timer) clearTimeout(timer);
    otherClosedTimers.delete(username);
}

/**
 * queueHandlers.handleDisconnect, for a socket that closed (not one
 * switching accounts): when it was `username`'s live socket and a parked
 * socket of that user is still connected, tell the parked ones the other
 * tab closed, OTHER_CLOSED_DELAY_MS from now (see the header).
 * @returns {boolean} whether the notice was scheduled
 */
function liveSocketClosed(io, socket, username) {
    if (username == null || !socket || socket.data?.superseded) return false;
    if (parkedSocketsOf(io, username, socket.id).length === 0) return false;
    cancelOtherClosed(username);
    const timer = setTimeout(() => {
        otherClosedTimers.delete(username);
        tellOtherClosed(io, username);
    }, OTHER_CLOSED_DELAY_MS);
    timer.unref?.();
    otherClosedTimers.set(username, timer);
    return true;
}

/** The delay is over: nobody holds the session, so the parked sockets are told. */
function tellOtherClosed(io, username) {
    if (hasLiveSocket(io, username)) return 0;
    let told = 0;
    for (const s of parkedSocketsOf(io, username)) {
        if (s.data.superseded.reason === OTHER_CLOSED_REASON) continue;
        s.data.superseded.reason = OTHER_CLOSED_REASON;
        s.emit('sessionSuperseded', { reason: OTHER_CLOSED_REASON });
        told++;
    }
    if (told) authLogger.info('Parked connection told the live one closed', { username, told });
    return told;
}

/**
 * A sign-in / restore stands on `bySocket`: a socket holds the session
 * again, so the parked ones told 'otherClosed' are told 'newerConnection'
 * (the web notice says "open in another tab" again) and any pending
 * 'otherClosed' is dropped.
 */
function reparkClosedNotices(io, bySocket) {
    const username = bySocket?.data?.username;
    if (username == null) return 0;
    cancelOtherClosed(username);
    let told = 0;
    for (const s of parkedSocketsOf(io, username, bySocket.id)) {
        if (s.data.superseded.reason !== OTHER_CLOSED_REASON) continue;
        s.data.superseded = { by: bySocket.id, at: Date.now() };
        s.emit('sessionSuperseded', { reason: SUPERSEDED_REASON });
        told++;
    }
    return told;
}

/** For tests. */
function _resetOtherClosedTimers() {
    for (const timer of otherClosedTimers.values()) clearTimeout(timer);
    otherClosedTimers.clear();
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
    liveSocketClosed,
    tellOtherClosed,
    reparkClosedNotices,
    _resetOtherClosedTimers,
    ALLOWED_WHILE_SUPERSEDED,
    SUPERSEDED_REASON,
    OTHER_CLOSED_REASON,
    OTHER_CLOSED_DELAY_MS
};
