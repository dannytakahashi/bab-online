/**
 * Voice chat signaling relay handlers.
 * Forwards WebRTC signaling messages (SDP offers/answers, ICE candidates)
 * between peers, plus the web client's PCM fallback (voiceRelayAudio) for
 * peers whose P2P connection failed. Audio otherwise never touches the server.
 *
 * Authorization (roadmap 30, security part): a message is forwarded only
 * when
 *   - its target is a connected socket id (never a room: io.to('mainRoom')
 *     would reach everyone), other than the sender;
 *   - both sockets are signed in and share a lobby (playerLobbies) or a game
 *     (playerGames: entrants, seat owners incl. a lazy/resigned owner's
 *     socket) — exactly the peers voicePeerList / voicePeerJoined announce.
 *     Pure spectators never get a peer list, and neither client starts voice
 *     for one (web: lobby/seat; iOS 1.1.0: holdsSeat), so they are refused;
 *   - neither user has blocked the other (socket.data.blockedUsers, loaded
 *     at sign-in / restore / sign-up / rejoinGame's token check and kept by
 *     blockUser / unblockUser; a signed-in socket without one is refused,
 *     fail closed, while it is loaded);
 *   - the sender is inside the event's per-socket rate limit
 *     (rateLimiter keys voiceOffer, voiceAnswer, voiceIceCandidate,
 *     voiceRelayAudio; checked here, so the wrapper stays safeHandler).
 * Anything else is dropped silently: the contract has no rejection event
 * for voice and both clients treat a lost signal as a peer that never
 * answers.
 */

const { socketLogger } = require('../utils/logger');
const gameManager = require('../game/GameManager');
const { rateLimiter } = require('./errorHandler');

/** Largest relayed PCM chunk (web sends 4096 input frames as 8 kHz Int16: <= 8 KB). */
const MAX_RELAY_BYTES = 64 * 1024;

/**
 * Has `sock`'s user blocked `username`? Each side is checked against its
 * OWN list (the sender's for "I blocked them", the target's for "they
 * blocked me"). Fails closed: a signed-in socket with no list loaded
 * counts as blocking everyone (every path that signs a socket in loads it:
 * signIn, restoreSession, signUp, rejoinGame's token check), and a load is
 * started so a later signal can pass once the list is known.
 */
function blockedBy(sock, username) {
    const list = sock?.data?.blockedUsers;
    if (!(list instanceof Set)) {
        loadBlockList(sock);
        return true;
    }
    return !!(username && list.has(username));
}

/**
 * Fill in a missing block list from the user document (once per socket at
 * a time). Logged as a warning: a sign-in path that skips rememberBlockList
 * is a bug to fix there.
 */
function loadBlockList(sock) {
    if (!sock?.data || sock.data.blockListLoading) return;
    const user = gameManager.getUserBySocketId(sock.id);
    if (!user?.username) return;
    socketLogger.warn('Voice: signed-in socket without a block list, loading it', { socketId: sock.id, username: user.username });
    let users;
    try {
        users = require('../database').getUsersCollection();
    } catch (_) {
        users = null;
    }
    if (!users) return;
    sock.data.blockListLoading = true;
    Promise.resolve()
        .then(() => users.findOne({ username: user.username }, { projection: { blockedUsers: 1 } }))
        .then((doc) => {
            // Still the same user, and no fresher list arrived meanwhile
            if (!(sock.data.blockedUsers instanceof Set) && gameManager.getUserBySocketId(sock.id)?.username === user.username) {
                rememberBlockList(sock, doc?.blockedUsers || []);
            }
        })
        .catch((err) => socketLogger.error('Voice: block list load failed', { socketId: sock.id, error: err.message }))
        .finally(() => { sock.data.blockListLoading = false; });
}

/**
 * May `socket` send `event` to `targetSocketId`? Returns the target socket
 * or null (and logs why at debug).
 */
function authorize(socket, io, event, targetSocketId) {
    const refuse = (reason) => {
        socketLogger.debug('Voice signal dropped', { event, from: socket.id, target: typeof targetSocketId === 'string' ? targetSocketId : null, reason });
        return null;
    };
    if (typeof targetSocketId !== 'string' || targetSocketId === '') return refuse('bad_target');
    if (!rateLimiter.check(socket.id, event)) return refuse('rate_limited');
    if (targetSocketId === socket.id) return refuse('self');
    const target = io.sockets?.sockets?.get(targetSocketId);
    if (!target) return refuse('not_a_socket');

    const from = gameManager.getUserBySocketId(socket.id);
    const to = gameManager.getUserBySocketId(targetSocketId);
    if (!from || !to) return refuse('not_signed_in');

    const lobby = gameManager.playerLobbies.get(socket.id);
    const game = gameManager.playerGames.get(socket.id);
    const sameLobby = lobby !== undefined && lobby === gameManager.playerLobbies.get(targetSocketId);
    const sameGame = game !== undefined && game === gameManager.playerGames.get(targetSocketId);
    if (!sameLobby && !sameGame) return refuse('not_peers');

    // Both lists are consulted (no short circuit), so a missing one starts loading either way
    const senderBlocks = blockedBy(socket, to.username);
    const targetBlocks = blockedBy(target, from.username);
    if (senderBlocks || targetBlocks) return refuse('blocked');
    return target;
}

function voiceOffer(socket, io, data) {
    const { targetSocketId, offer } = data || {};
    if (!targetSocketId || !offer) return;
    if (!authorize(socket, io, 'voiceOffer', targetSocketId)) return;

    // Look up username server-side — don't trust client payload
    const user = gameManager.getUserBySocketId(socket.id);

    io.to(targetSocketId).emit('voiceOffer', {
        fromSocketId: socket.id,
        offer,
        username: user?.username
    });
}

function voiceAnswer(socket, io, data) {
    const { targetSocketId, answer } = data || {};
    if (!targetSocketId || !answer) return;
    if (!authorize(socket, io, 'voiceAnswer', targetSocketId)) return;

    io.to(targetSocketId).emit('voiceAnswer', {
        fromSocketId: socket.id,
        answer
    });
}

function voiceIceCandidate(socket, io, data) {
    const { targetSocketId, candidate } = data || {};
    if (!targetSocketId || !candidate) return;
    if (!authorize(socket, io, 'voiceIceCandidate', targetSocketId)) return;

    io.to(targetSocketId).emit('voiceIceCandidate', {
        fromSocketId: socket.id,
        candidate
    });
}

function relayBytes(audio) {
    if (audio == null) return 0;
    if (typeof audio === 'string') return audio.length;
    if (typeof audio.byteLength === 'number') return audio.byteLength;
    if (Array.isArray(audio)) return audio.length * 2;
    return 0;
}

function voiceRelayAudio(socket, io, data) {
    const { targetSocketId, audio } = data || {};
    if (!targetSocketId || !audio) return;
    if (relayBytes(audio) > MAX_RELAY_BYTES) return;
    if (!authorize(socket, io, 'voiceRelayAudio', targetSocketId)) return;

    io.to(targetSocketId).emit('voiceRelayAudio', {
        fromSocketId: socket.id,
        audio
    });
}

/** Remember the signed-in user's block list on the socket (voice checks it per message). */
function rememberBlockList(socket, blockedUsers) {
    if (!socket || !socket.data) return;
    socket.data.blockedUsers = new Set(Array.isArray(blockedUsers) ? blockedUsers : []);
}

module.exports = {
    voiceOffer,
    voiceAnswer,
    voiceIceCandidate,
    voiceRelayAudio,
    rememberBlockList,
    MAX_RELAY_BYTES
};
