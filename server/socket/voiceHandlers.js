/**
 * Voice chat signaling relay handlers.
 * Forwards WebRTC signaling messages (SDP offers/answers, ICE candidates)
 * between peers, and hands out ICE servers (getVoiceIceServers: Cloudflare
 * TURN credentials, else STUN). Audio never touches the game server: it goes
 * peer to peer or through Cloudflare's TURN relay. The old web PCM fallback
 * (voiceRelayAudio) is gone: TURN replaced it (2026-11-11) and the handler
 * was removed a day after that deploy (contract/V1_REMOVALS.md #20); a
 * voiceRelayAudio packet now reaches no handler.
 *
 * Authorization (roadmap 30, security part): a message is forwarded only
 * when
 *   - its target is a connected socket id (never a room: io.to('mainRoom')
 *     would reach everyone), other than the sender;
 *   - both sockets are signed in and in the same voice room
 *     (gameVoice.voiceRoomOf): a lobby (playerLobbies), or a game (playerGames:
 *     entrants, seat owners incl. a lazy/resigned owner's socket; plus, in a
 *     casual game, the capable spectators admitted to its voice room,
 *     game.voiceSpectators) — exactly the peers voicePeerList /
 *     voicePeerJoined announce. Any other pure spectator is refused (a
 *     legacy client never starts voice for one);
 *   - neither user has blocked the other (socket.data.blockedUsers, loaded
 *     at sign-in / restore / sign-up / rejoinGame's token check and kept by
 *     blockUser / unblockUser; a signed-in socket without one is refused,
 *     fail closed, while it is loaded);
 *   - the sender is inside the event's per-socket rate limit
 *     (rateLimiter keys voiceOffer, voiceAnswer, voiceIceCandidate;
 *     checked here, so the wrapper stays safeHandler);
 *   - the payload passes its Joi schema (validators.schemas.voiceOffer,
 *     ... ; V1_REMOVALS #18), also checked here.
 * (Until 2026-11-18 a voice spectator who might not talk was relayed only
 * listen-only SDP; spectators always may talk now, so nothing is gated.)
 * Anything else is dropped silently: the contract has no rejection event
 * for voice and both clients treat a lost signal as a peer that never
 * answers.
 */

const { socketLogger } = require('../utils/logger');
const gameManager = require('../game/GameManager');
const { rateLimiter } = require('./errorHandler');
const { validate } = require('./validators');
const turnCredentials = require('../voice/turnCredentials');
const gameVoice = require('../voice/gameVoice');

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

    const room = gameVoice.voiceRoomOf(socket.id);
    // A tournament's SFU room: audio goes through Cloudflare, never peer to
    // peer, so no mesh signal is relayed there (server/voice/sfu/)
    if (typeof room === 'string' && room.startsWith('sfu:')) return refuse('sfu_room');
    if (room === null || room !== gameVoice.voiceRoomOf(targetSocketId)) return refuse('not_peers');

    // Both lists are consulted (no short circuit), so a missing one starts loading either way
    const senderBlocks = blockedBy(socket, to.username);
    const targetBlocks = blockedBy(target, from.username);
    if (senderBlocks || targetBlocks) return refuse('blocked');
    return target;
}

/**
 * `data` checked against the event's Joi schema, or null: a malformed
 * signal is dropped silently like every other refusal (never error).
 */
function checked(socket, event, data) {
    try {
        return validate(event, data);
    } catch (_) {
        socketLogger.debug('Voice signal dropped', { event, from: socket.id, reason: 'invalid' });
        return null;
    }
}

function voiceOffer(socket, io, data) {
    const { targetSocketId, offer } = data || {};
    if (!targetSocketId || !offer) return;
    if (!authorize(socket, io, 'voiceOffer', targetSocketId)) return;
    if (!checked(socket, 'voiceOffer', data)) return;

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
    if (!checked(socket, 'voiceAnswer', data)) return;

    io.to(targetSocketId).emit('voiceAnswer', {
        fromSocketId: socket.id,
        answer
    });
}

function voiceIceCandidate(socket, io, data) {
    const { targetSocketId, candidate } = data || {};
    if (!targetSocketId || !candidate) return;
    if (!authorize(socket, io, 'voiceIceCandidate', targetSocketId)) return;
    if (!checked(socket, 'voiceIceCandidate', data)) return;

    io.to(targetSocketId).emit('voiceIceCandidate', {
        fromSocketId: socket.id,
        candidate
    });
}

/**
 * getVoiceIceServers {requestId?} -> voiceIceServers {iceServers, turn,
 * expiresInSec, requestId?} to this socket only (server/voice/turnCredentials.js).
 * TURN credentials go only to a signed-in socket that is a voice peer right
 * now (in a voice room: a lobby, an entrant / seat owner of a game, or an
 * admitted voice spectator: the sockets the relays above accept; no new
 * exposure, a lone lobby creator already gets them); anyone else gets the
 * public STUN servers, as does
 * every failure. Joi and the wrapper's rateLimiter.getVoiceIceServers
 * limit run first (index.js). The reply never carries the API token, and
 * nothing here logs a credential.
 */
async function getVoiceIceServers(socket, io, data) {
    const requestId = typeof data?.requestId === 'string' ? data.requestId : undefined;
    const reply = (answer) => socket.emit('voiceIceServers', requestId !== undefined ? { ...answer, requestId } : answer);
    const user = gameManager.getUserBySocketId(socket.id);
    const isPeer = gameVoice.voiceRoomOf(socket.id) !== null;
    if (!user?.username || !isPeer) {
        socketLogger.debug('Voice ICE servers: STUN only', { socketId: socket.id, reason: user?.username ? 'not_a_voice_peer' : 'not_signed_in' });
        reply(turnCredentials.stunOnly());
        return;
    }
    const answer = await turnCredentials.getIceServers(user.username);
    // Signed out or replaced while Cloudflare answered: no credentials
    if (gameManager.getUserBySocketId(socket.id)?.username !== user.username) {
        reply(turnCredentials.stunOnly());
        return;
    }
    reply(answer);
}

/**
 * setSpectatorsCanTalk {spectatorsCanTalk} (Joi + rate limit in the
 * wrapper): accepted and ignored since 2026-11-18 (owner: "we don't need
 * the spectator voice host toggle, just having it default on is good").
 * Spectators always may talk; shipped iOS 12-15 and cached web tabs still
 * show a switch and send this. The sender gets the unchanged settings back
 * and never an error (an old lobby switch shows Off until its own 5 s echo
 * timeout puts it back On: the echo repeats the value it holds): in a lobby a
 * playerReadyUpdate with settings {spectatorsCanTalk: true} to it alone
 * (lobbyHandlers.setLobbySpectatorsCanTalk), in a casual game its
 * voiceSettings (spectatorsCanTalk true, canChange false: those clients
 * then hide the in-game switch). Anywhere else: dropped (debug log).
 */
function setSpectatorsCanTalk(socket, io, data) {
    socketLogger.debug('setSpectatorsCanTalk ignored (spectators always may talk)', { socketId: socket.id, asked: data?.spectatorsCanTalk });
    if (require('./lobbyHandlers').setLobbySpectatorsCanTalk(socket, io)) return;
    const watched = gameManager.spectatorGames.get(socket.id);
    const game = gameManager.getPlayerGame(socket.id) ?? (watched !== undefined ? gameManager.games.get(watched) : null);
    gameVoice.answerSpectatorsCanTalk(io, game, socket.id);
}

/** Remember the signed-in user's block list on the socket (voice checks it per message). */
function rememberBlockList(socket, blockedUsers) {
    if (!socket || !socket.data) return;
    socket.data.blockedUsers = new Set(Array.isArray(blockedUsers) ? blockedUsers : []);
    // A tournament's SFU room keeps each member's list per username (a member
    // away in its reconnect grace has no socket): it takes the new one, and a
    // new block between two of its members is enforced there
    try {
        require('../voice/sfu/sfuRoom').blockListChanged(socket, socket.data.blockedUsers);
    } catch (error) {
        socketLogger.error('Voice SFU: block list update failed', { error: error?.message });
    }
}

module.exports = {
    voiceOffer,
    voiceAnswer,
    voiceIceCandidate,
    getVoiceIceServers,
    setSpectatorsCanTalk,
    rememberBlockList
};
