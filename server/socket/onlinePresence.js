/**
 * The main room's online list: every signed-in user, wherever they are
 * (GameManager.getOnlineUsernames, one currentUsers entry per username).
 * Main-room members learn it changed from two broadcasts to 'mainRoom',
 * each carrying the fresh count and list (both clients treat
 * mainRoomPlayerJoined as a list refresh only, no chat line):
 *
 * - mainRoomPlayerJoined: a socket joined the main room
 *   (mainRoomHandlers.joinMainRoom), or a name came online that was not
 *   (announceOnline: a sign-in, sign-up, session restore or token rejoin).
 *   The second matters for a player who reconnects straight into a game
 *   or tournament: their client never sends joinMainRoom, and without it
 *   nobody saw them come back until some other join refreshed the list.
 * - mainRoomPlayerLeft: a name went offline (announceOffline: its last
 *   socket closed, or a sign-out dropped its entry).
 */

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');

/** Has `username` a currentUsers entry (getOnlineUsernames' source)? */
const isOnline = (username) => username != null && (gameManager.currentUsers || []).some((u) => u.username === username);

function emitList(io, event, username) {
    // A bare stub io (some unit tests) has no rooms to tell
    if (typeof io?.to !== 'function') return false;
    // Called inside sign-in / sign-out paths: a failed list refresh must
    // never fail those
    try {
        const onlineUsers = gameManager.getOnlineUsernames();
        io.to('mainRoom').emit(event, { username, onlineCount: onlineUsers.length, onlineUsers });
        return true;
    } catch (error) {
        socketLogger.error('Online list broadcast failed', { event, error: error.message });
        return false;
    }
}

/**
 * After a registration stands: `wasOnline` is isOnline(username) read
 * before registerUser. A name that was offline and is online now is
 * announced; a second socket / tab of a user already online is not. A
 * client that then joins the main room sends one more (identical) refresh:
 * cheaper than guessing where it goes (a game, a tournament, a held
 * play-again lobby, the tutorial). Returns whether it emitted.
 */
function announceOnline(io, username, wasOnline) {
    if (wasOnline || !isOnline(username)) return false;
    return emitList(io, 'mainRoomPlayerJoined', username);
}

/** The counterpart: `wasOnline` read before the entry was dropped. */
function announceOffline(io, username, wasOnline) {
    if (!wasOnline || isOnline(username)) return false;
    return emitList(io, 'mainRoomPlayerLeft', username);
}

module.exports = { isOnline, announceOnline, announceOffline };
