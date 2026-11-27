/**
 * The voice room of a casual game: its players plus, since the family-lobby
 * work (owner 2026-11-16: lobbies of up to 8), capable spectators, who
 * always may talk (owner 2026-11-18: "we don't need the spectator voice
 * host toggle, just having it default on is good": no switch, so
 * spectatorsCanTalk is always true on the wire and every voice spectator's
 * canTalk is true). docs/claude/voice.md, "Spectator voice".
 *
 * Audio never reaches the server: this module only decides who is announced
 * to whom (voicePeerList / voicePeerJoined / voicePeerLeft), who may signal
 * whom (voiceHandlers.authorize -> voiceRoomOf) and what each capable
 * client is told (voiceSettings, private, unsequenced).
 *
 * State on a casual game (set in GameManager.startGameFromLobby only, so a
 * tournament table or the ambient demo never has it):
 *   game.casualVoice     {host, spectatorsCanTalk (always true), lastIo,
 *                         lobbyExtras, order}
 *   game.voiceSpectators Map socketId -> {username, order, fromLobby}
 * Both are keyed by socket and die with the game (GameManager._retire).
 *
 * Only sockets that sent the clientHello cap `casualSpectators` are ever
 * admitted as voice spectators or sent voiceSettings: every shipped iOS
 * build (caps ['avatarUrl'] only) and every cached pre-feature web tab sees
 * exactly today's wire.
 */

'use strict';

const gameManager = require('../game/GameManager');
const clientInfo = require('../socket/clientInfo');
const { Controller, Presence } = require('../game/SeatState');
const { socketLogger } = require('../utils/logger');

const CAP = 'casualSpectators';
/** Everyone in one voice mesh: players (seats or entrants) + voice spectators. */
const MAX_VOICE_PEOPLE = 8;
const isCasual = (game) => !!(game && game.casualVoice && !game.isTerminal?.());

function ioFor(game, io) {
    if (io && game?.casualVoice) game.casualVoice.lastIo = io;
    return io || game?.casualVoice?.lastIo || null;
}

/** Has the live socket `sid` announced casualSpectators? */
function capable(io, sid) {
    return clientInfo.socketHasCap(io, sid, CAP);
}

/**
 * Set up a casual game's voice state (GameManager.startGameFromLobby, and
 * gameCodec.hydrate for a restored game). spectatorsCanTalk is always true
 * (owner 2026-11-18): a value saved before the switch went (false) is not
 * kept.
 */
function initCasualVoice(game, { host = null, io = null, lobbyExtras = [] } = {}) {
    game.casualVoice = {
        host,
        spectatorsCanTalk: true,
        lastIo: io,
        lobbyExtras: new Set(lobbyExtras),
        order: 0,
    };
    game.voiceSpectators = new Map();
}

/**
 * The players' side of the voice room, [{socketId, username}]: before
 * seating (entrants set: CREATED / DRAWING / DRAW_RESOLVING) the human
 * entrants still connected; after it the seat owners whose socket is
 * attached (presence connected) and who play the seat or sit at it in lazy
 * mode (ownerView 'seat'), the same filter as seatLifecycle's reconnect
 * announcement. A watching owner (ownerView 'watch') is not in voice.
 */
function gameVoiceMembers(game) {
    if (!game) return [];
    if (game.entrants) {
        return [...game.entrants.values()]
            .filter((e) => !e.isBot && e.presence === 'connected')
            .map((e) => ({ socketId: e.socketId, username: e.username ?? null }));
    }
    return game.seatList()
        .filter((s) => s.presence === Presence.CONNECTED && s.ownerSocketId &&
            (s.controller === Controller.HUMAN || s.ownerView === 'seat'))
        .map((s) => ({ socketId: s.ownerSocketId, username: s.ownerUsername }));
}

/**
 * The players who hold a voice slot whatever their presence: every human
 * entrant that has not left before seating, every owned seat that is not
 * gone after it. A player in reconnect grace keeps their slot, so their
 * return (announced with no cap check) never makes a ninth.
 */
function humanSeatsOrEntrants(game) {
    if (game.entrants) {
        return [...game.entrants.values()].filter((e) => !e.isBot && e.presence !== 'left').length;
    }
    return game.seatList().filter((s) => s.ownerUsername && s.presence !== Presence.GONE).length;
}

const isMember = (game, sid) => gameVoiceMembers(game).some((m) => m.socketId === sid);

/**
 * The voice room `socketId` is in: `lobby:<id>` (a lobby seat), `game:<id>`
 * (mapped to a game: entrant, seat owner incl. a lazy owner's socket; a
 * tournament table's too), `game:<id>` for an admitted voice spectator, or
 * `tournament:<id>` for an admitted member of a tournament's voice room
 * (on its lobby screen with the cap tournamentVoice:
 * server/voice/tournamentVoice.js), `sfu:<id>` for an admitted member of a
 * tournament's SFU room (server/voice/sfu/sfuRoom.js: no mesh signal is
 * relayed there); null otherwise.
 */
function voiceRoomOf(socketId) {
    const lobbyId = gameManager.playerLobbies.get(socketId);
    if (lobbyId !== undefined) return `lobby:${lobbyId}`;
    const gameId = gameManager.playerGames.get(socketId);
    if (gameId !== undefined) return `game:${gameId}`;
    const watched = gameManager.spectatorGames.get(socketId);
    if (watched !== undefined) {
        const game = gameManager.games.get(watched);
        if (game?.voiceSpectators?.has(socketId)) return `game:${watched}`;
        return null;
    }
    return require('./tournamentVoice').roomOf(socketId);
}

function isVoiceSpectator(game, sid) {
    return !!game?.voiceSpectators?.has(sid);
}

/**
 * May voice spectator `sid` send audio? Every admitted voice spectator of a
 * live casual game may (owner 2026-11-18). A client that cannot (a refused
 * microphone) listens on its own; the server no longer gates spectator SDP.
 */
function mayTalk(game, sid) {
    return isCasual(game) && !!game.voiceSpectators?.has(sid);
}

/**
 * The voiceSettings payload for `sid`, or null (not a casual game). Every
 * field stays on the wire (shipped iOS 12-15 and cached web tabs read
 * them): spectatorsCanTalk is always true, canChange always false (there is
 * no switch to change, so those clients hide their in-game one), canTalk
 * true for a player and a voice spectator.
 */
function settingsFor(game, sid) {
    if (!isCasual(game)) return null;
    const cv = game.casualVoice;
    let role = 'none';
    if (isVoiceSpectator(game, sid)) role = 'spectator';
    else if (isMember(game, sid)) role = 'player';
    return {
        gameId: game.gameId,
        host: cv.host ?? null,
        spectatorsCanTalk: true,
        role,
        canTalk: role === 'player' || role === 'spectator',
        canChange: false,
    };
}

/** voiceSettings to `sid` (private, unsequenced), only when it is capable. */
function sendVoiceSettings(io, game, sid) {
    io = ioFor(game, io);
    if (!io || !capable(io, sid)) return false;
    const payload = settingsFor(game, sid);
    if (!payload) return false;
    io.to(sid).emit('voiceSettings', payload);
    return true;
}

/**
 * Every capable socket in the game's voice room gets voiceSettings. Call
 * after anything that changes who is in it: an owner dropping / returning,
 * an entrant leaving (a socket's role can change; the other fields are
 * fixed now that nobody can switch spectator talk).
 */
function refreshVoice(io, game) {
    if (!isCasual(game)) return;
    io = ioFor(game, io);
    if (!io) return;
    const targets = new Set(gameVoiceMembers(game).map((m) => m.socketId));
    for (const sid of game.voiceSpectators.keys()) targets.add(sid);
    for (const sid of targets) sendVoiceSettings(io, game, sid);
}

/** The loaded block lists of two sockets say they must not be paired (a missing list never excludes). */
function blockedPair(io, aSid, aName, bSid, bName) {
    const a = io?.sockets?.sockets?.get(aSid);
    const b = io?.sockets?.sockets?.get(bSid);
    const listA = a?.data?.blockedUsers;
    const listB = b?.data?.blockedUsers;
    return !!((listA instanceof Set && bName && listA.has(bName)) || (listB instanceof Set && aName && listB.has(aName)));
}

/** Voice spectators in admission order. */
function spectatorsInOrder(game) {
    return [...game.voiceSpectators.entries()]
        .sort((a, b) => a[1].order - b[1].order)
        .map(([socketId, e]) => ({ socketId, username: e.username, entry: e }));
}

/**
 * Announce `sid` (a newly admitted spectator) to the room: voicePeerList to
 * it (it offers, avoiding glare) and voicePeerJoined to each listed peer.
 * Peers: the players, plus the spectators admitted before it; pairs a
 * loaded block list excludes are left out.
 */
function announceSpectator(io, game, sid, username) {
    const me = game.voiceSpectators.get(sid);
    const peers = gameVoiceMembers(game).filter((m) => m.socketId !== sid);
    for (const s of spectatorsInOrder(game)) {
        if (s.socketId !== sid && s.entry.order < me.order) peers.push({ socketId: s.socketId, username: s.username });
    }
    const listed = peers.filter((p) => !blockedPair(io, sid, username, p.socketId, p.username));
    for (const p of listed) io.to(p.socketId).emit('voicePeerJoined', { socketId: sid, username });
    if (listed.length > 0) io.to(sid).emit('voicePeerList', { peers: listed });
}

/**
 * Admit `sid` (already a pure spectator of `game`) to the game's voice room.
 * Requires a casual game, the casualSpectators cap, no other membership
 * (activityOf) and a free slot (players holding one + voice spectators < 8).
 * A capable socket refused for want of a slot gets voiceSettings role none.
 * A newer socket of the same user replaces an older entry (a reload's
 * half-open socket). `fromLobby`: one of the lobby's extras (logged);
 * `announce` false at the lobby start (the lobby mesh already connects
 * every pair).
 * @returns {boolean} admitted
 */
function admitVoiceSpectator(io, game, sid, { fromLobby = false, announce = true } = {}) {
    if (!isCasual(game) || !game.isSpectator?.(sid)) return false;
    io = ioFor(game, io);
    if (!io || !capable(io, sid)) return false;
    if (gameManager.activityOf(sid) !== null) return false;
    const username = game.spectators.get(sid)?.username ?? gameManager.getUserBySocketId(sid)?.username ?? null;
    if (!username) return false;
    // Another tab of a player who is in voice at the table: one person,
    // one place in the mesh (it would hear itself)
    if (gameVoiceMembers(game).some((m) => m.username === username)) return false;

    if (game.voiceSpectators.has(sid)) {
        sendVoiceSettings(io, game, sid);
        return true;
    }
    for (const [other, e] of [...game.voiceSpectators]) {
        if (e.username === username) removeVoiceSpectator(io, game, other);
    }
    if (humanSeatsOrEntrants(game) + game.voiceSpectators.size >= MAX_VOICE_PEOPLE) {
        socketLogger.info('Voice: spectator not admitted, voice is full', { gameId: game.gameId, socketId: sid });
        sendVoiceSettings(io, game, sid);
        return false;
    }
    const cv = game.casualVoice;
    const entry = {
        username,
        order: ++cv.order,
        fromLobby: !!fromLobby || cv.lobbyExtras.has(username),
    };
    game.voiceSpectators.set(sid, entry);
    if (announce) announceSpectator(io, game, sid, username);
    sendVoiceSettings(io, game, sid);
    socketLogger.info('Voice: spectator admitted', { gameId: game.gameId, socketId: sid, fromLobby: entry.fromLobby });
    return true;
}

/**
 * Take `sid` out of the game's voice spectators (it stopped spectating, is
 * becoming a seat owner, or a newer socket replaced it): every voice member
 * and remaining spectator gets a private voicePeerLeft for it, never the
 * room. `bothWays` also tells `sid` to drop each of those peers (a spectator
 * turning into an owner must re-connect from the owner's peer list).
 */
function removeVoiceSpectator(io, game, sid, { bothWays = false } = {}) {
    if (!game?.voiceSpectators?.has(sid)) return false;
    io = ioFor(game, io);
    game.voiceSpectators.delete(sid);
    if (!io || game.isTerminal?.()) return true;
    const peers = new Set(gameVoiceMembers(game).map((m) => m.socketId));
    for (const other of game.voiceSpectators.keys()) peers.add(other);
    peers.delete(sid);
    for (const p of peers) {
        io.to(p).emit('voicePeerLeft', { socketId: sid });
        if (bothWays) io.to(sid).emit('voicePeerLeft', { socketId: p });
    }
    // The spectator count changed, which can free a slot
    return true;
}

/**
 * A player (entrant before seating) left the voice room without a seat
 * transition that announces it (a draw-phase disconnect or /leave): its
 * peers get a private voicePeerLeft, so up to 7 stale calls do not hang
 * until ICE gives up. Every game (not only casual ones): entrants are voice
 * peers today too.
 */
function playerLeftVoice(io, game, sid) {
    if (!io || !game || game.isTerminal?.()) return;
    const peers = new Set(gameVoiceMembers(game).map((m) => m.socketId));
    for (const s of game.voiceSpectators?.keys() || []) peers.add(s);
    peers.delete(sid);
    for (const p of peers) io.to(p).emit('voicePeerLeft', { socketId: sid });
    refreshVoice(io, game);
}

/**
 * setSpectatorsCanTalk in a casual game (shipped iOS 12-15 and cached web
 * tabs still send it): nothing changes (spectators always may talk, owner
 * 2026-11-18); the sender gets its voiceSettings back (spectatorsCanTalk
 * true, canChange false) so a switch waiting for its echo settles on, never
 * an error toast.
 * @returns {boolean} answered (a casual game the socket is in)
 */
function answerSpectatorsCanTalk(io, game, sid) {
    if (!isCasual(game)) return false;
    sendVoiceSettings(io, game, sid);
    return true;
}

/**
 * A block between two users who share a voice room ends their live call:
 * each socket gets a private voicePeerLeft for the other (authorize already
 * stops new signals). Lobby, player and spectator pairs alike.
 */
function endBlockedCall(io, aSid, bSid) {
    if (!io || !aSid || !bSid || aSid === bSid) return false;
    const room = voiceRoomOf(aSid);
    // A tournament's SFU room (server/voice/sfu/sfuRoom.js): no mesh call to
    // end (the blocker's new list already kept them apart there, an away
    // member too: sfuRoom.blockListChanged via rememberBlockList)
    if (typeof room === 'string' && room.startsWith('sfu:')) {
        return require('./sfu/sfuRoom').blockedPairFound(io, aSid, bSid);
    }
    // A legacy client still on the score screen shares no room with the
    // players back in the lobby, but its call with them lingers (play again)
    const shared = (room !== null && room === voiceRoomOf(bSid)) ||
        require('../socket/playAgain').isLingeringPair(aSid, bSid);
    if (!shared) return false;
    io.to(aSid).emit('voicePeerLeft', { socketId: bSid });
    io.to(bSid).emit('voicePeerLeft', { socketId: aSid });
    return true;
}

/** Drop the socket-keyed voice state of a retired game (GameManager._retire). */
function retire(game) {
    game?.voiceSpectators?.clear();
}

module.exports = {
    CAP,
    MAX_VOICE_PEOPLE,
    initCasualVoice,
    gameVoiceMembers,
    humanSeatsOrEntrants,
    voiceRoomOf,
    isVoiceSpectator,
    mayTalk,
    settingsFor,
    sendVoiceSettings,
    refreshVoice,
    admitVoiceSpectator,
    removeVoiceSpectator,
    playerLeftVoice,
    answerSpectatorsCanTalk,
    endBlockedCall,
    blockedPair,
    retire,
};
