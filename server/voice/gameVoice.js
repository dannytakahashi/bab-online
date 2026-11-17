/**
 * The voice room of a casual game: its players plus, since the family-lobby
 * work (owner 2026-11-16: lobbies of up to 8, "Spectators can talk"),
 * capable spectators. docs/claude/voice.md, "Spectator voice".
 *
 * Audio never reaches the server: this module only decides who is announced
 * to whom (voicePeerList / voicePeerJoined / voicePeerLeft), who may signal
 * whom (voiceHandlers.authorize -> voiceRoomOf), which spectator SDP is
 * relayed (gateSignal: server/voice/sdpDirection.js) and what each capable
 * client is told (voiceSettings, private, unsequenced).
 *
 * State on a casual game (set in GameManager.startGameFromLobby only, so a
 * tournament table or the ambient demo never has it):
 *   game.casualVoice     {host, spectatorsCanTalk, lastIo, lobbyExtras,
 *                         requested, lastAppliedAt}
 *   game.voiceSpectators Map socketId -> {username, order, fromLobby,
 *                         canTalk (last computed), gateSince}
 *   game.voiceOfferDir   Map `${spectator}>${peer}` -> {dir: 'listen'|'send', at}
 * All three are keyed by socket and die with the game (GameManager._retire).
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
const sdpDirection = require('./sdpDirection');
const { socketLogger } = require('../utils/logger');

const CAP = 'casualSpectators';
/** Everyone in one voice mesh: players (seats or entrants) + voice spectators. */
const MAX_VOICE_PEOPLE = 8;
/** At most one applied spectatorsCanTalk change per game per this long (leading + trailing). */
const COALESCE_MS = 3000;
/** After a spectator loses the right to talk: pairs it did not re-offer listen-only are torn down. */
const BACKSTOP_MS = 8000;

const SETTINGS_TIMER = 'voice:settings';
const BACKSTOP_TIMER = 'voice:backstop';

let gateDrops = 0;

const isCasual = (game) => !!(game && game.casualVoice && !game.isTerminal?.());

function ioFor(game, io) {
    if (io && game?.casualVoice) game.casualVoice.lastIo = io;
    return io || game?.casualVoice?.lastIo || null;
}

/** Has the live socket `sid` announced casualSpectators? */
function capable(io, sid) {
    return clientInfo.socketHasCap(io, sid, CAP);
}

/** Set up a casual game's voice state (GameManager.startGameFromLobby). */
function initCasualVoice(game, { host = null, spectatorsCanTalk = true, io = null, lobbyExtras = [] } = {}) {
    game.casualVoice = {
        host,
        spectatorsCanTalk: spectatorsCanTalk !== false,
        lastIo: io,
        lobbyExtras: new Set(lobbyExtras),
        requested: null,
        lastAppliedAt: 0,
        order: 0,
    };
    game.voiceSpectators = new Map();
    game.voiceOfferDir = new Map();
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
 * (mapped to a game: entrant, seat owner incl. a lazy owner's socket), or
 * `game:<id>` for an admitted voice spectator; null otherwise.
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
    }
    return null;
}

function isVoiceSpectator(game, sid) {
    return !!game?.voiceSpectators?.has(sid);
}

/** A connected, capable player (seat owner / entrant in voice): who can switch spectator talk. */
function capableMembers(game, io) {
    return gameVoiceMembers(game).filter((m) => capable(io, m.socketId));
}

/**
 * Owner Q3 default: the host controls the switch while seated, connected
 * and capable; otherwise any connected capable seat owner / entrant does.
 */
function canChange(game, sid, io = null) {
    if (!isCasual(game)) return false;
    io = ioFor(game, io);
    const controllers = capableMembers(game, io);
    if (!controllers.some((m) => m.socketId === sid)) return false;
    const host = game.casualVoice.host;
    const hostControls = host != null && controllers.some((m) => m.username === host);
    return !hostControls || controllers.find((m) => m.socketId === sid).username === host;
}

/** Someone at the table could turn spectator talk off (owner Q3). */
function hasCapableController(game, io = null) {
    return capableMembers(game, ioFor(game, io)).length > 0;
}

/**
 * May voice spectator `sid` send audio? spectatorsCanTalk, and either it
 * came from the game's own lobby or a capable player could turn it off: in
 * a game whose players are all legacy a main-room stranger only listens
 * (nobody there could silence them; owner Q1/Q3).
 */
function mayTalk(game, sid, io = null) {
    const e = game?.voiceSpectators?.get(sid);
    if (!e || !isCasual(game) || !game.casualVoice.spectatorsCanTalk) return false;
    return e.fromLobby || hasCapableController(game, io);
}

/** The voiceSettings payload for `sid`, or null (not a casual game). */
function settingsFor(game, sid, io = null) {
    if (!isCasual(game)) return null;
    const cv = game.casualVoice;
    let role = 'none';
    if (isVoiceSpectator(game, sid)) role = 'spectator';
    else if (isMember(game, sid)) role = 'player';
    return {
        gameId: game.gameId,
        host: cv.host ?? null,
        spectatorsCanTalk: cv.spectatorsCanTalk,
        role,
        canTalk: role === 'player' ? true : role === 'spectator' ? mayTalk(game, sid, io) : false,
        canChange: role === 'player' ? canChange(game, sid, io) : false,
    };
}

/** voiceSettings to `sid` (private, unsequenced), only when it is capable. */
function sendVoiceSettings(io, game, sid) {
    io = ioFor(game, io);
    if (!io || !capable(io, sid)) return false;
    const payload = settingsFor(game, sid, io);
    if (!payload) return false;
    io.to(sid).emit('voiceSettings', payload);
    return true;
}

/**
 * Every capable socket in the game's voice room gets voiceSettings, after
 * the spectators' talk modes are recomputed (a spectator that just lost the
 * right to talk arms the backstop). Call after anything that can change a
 * mode or who controls the switch: an applied change, an owner dropping /
 * returning, an entrant leaving.
 */
function refreshVoice(io, game) {
    if (!isCasual(game)) return;
    io = ioFor(game, io);
    recomputeTalk(io, game);
    if (!io) return;
    const targets = new Set(gameVoiceMembers(game).map((m) => m.socketId));
    for (const sid of game.voiceSpectators.keys()) targets.add(sid);
    for (const sid of targets) sendVoiceSettings(io, game, sid);
}

function recomputeTalk(io, game) {
    const now = Date.now();
    let armed = false;
    for (const [sid, e] of game.voiceSpectators) {
        const can = mayTalk(game, sid, io);
        if (e.canTalk && !can) {
            e.gateSince = now;
            armed = true;
        } else if (can) {
            e.gateSince = null;
        }
        e.canTalk = can;
    }
    if (armed) armBackstop(game, BACKSTOP_MS);
}

function armBackstop(game, ms) {
    game.setTimer(BACKSTOP_TIMER, Math.max(0, ms), () => runBackstop(game));
}

/**
 * Is the call s keeps with p listen-only on s's side? The last SDP s relayed
 * to p (its offer or answer: every local description of s passes the gate
 * and is recorded, a newer one replacing the older) said so. Its age does
 * not matter: a spectator that never tapped to talk built its calls
 * listen-only long before the switch went off and has nothing to re-offer.
 */
function settledListenOnly(game, s, p) {
    const rec = game.voiceOfferDir.get(`${s}>${p}`);
    return !!(rec && rec.dir === 'listen');
}

/**
 * The server's only lever on a P2P call it cannot see: BACKSTOP_MS after a
 * spectator lost the right to talk, every pair (spectator s, player p) whose
 * last offer or answer from s was not listen-only is torn down
 * (private voicePeerLeft both ways) and s is announced to p again, so s
 * offers anew (gated). An honest client re-offers within a few seconds and
 * never triggers it.
 */
function runBackstop(game) {
    if (!isCasual(game)) return;
    const io = game.casualVoice.lastIo;
    if (!io) return;
    const now = Date.now();
    let next = null;
    for (const [s, e] of game.voiceSpectators) {
        if (e.gateSince == null) continue;
        if (mayTalk(game, s, io)) {
            e.gateSince = null;
            continue;
        }
        const due = e.gateSince + BACKSTOP_MS;
        if (due > now) {
            next = next == null ? due : Math.min(next, due);
            continue;
        }
        e.gateSince = null;
        for (const p of gameVoiceMembers(game)) {
            if (p.socketId === s || settledListenOnly(game, s, p.socketId)) continue;
            socketLogger.info('Voice: spectator kept sending after losing talk, call torn down', { gameId: game.gameId, spectator: s, peer: p.socketId });
            io.to(s).emit('voicePeerLeft', { socketId: p.socketId });
            io.to(p.socketId).emit('voicePeerLeft', { socketId: s });
            io.to(p.socketId).emit('voicePeerJoined', { socketId: s, username: e.username });
            io.to(s).emit('voicePeerList', { peers: [{ socketId: p.socketId, username: p.username }] });
        }
    }
    if (next != null) armBackstop(game, next - now);
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
 * Peers: the players, plus the spectators admitted before it while
 * spectators may talk; pairs a loaded block list excludes are left out.
 */
function announceSpectator(io, game, sid, username) {
    const me = game.voiceSpectators.get(sid);
    const peers = gameVoiceMembers(game).filter((m) => m.socketId !== sid);
    if (game.casualVoice.spectatorsCanTalk) {
        for (const s of spectatorsInOrder(game)) {
            if (s.socketId !== sid && s.entry.order < me.order) peers.push({ socketId: s.socketId, username: s.username });
        }
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
 * half-open socket). `fromLobby`: one of the lobby's extras (talks under the
 * switch alone); `announce` false at the lobby start (the lobby mesh already
 * connects every pair); `priorTalk`: it held a mic before (the lobby), so
 * an OFF switch arms the backstop for its old calls.
 * @returns {boolean} admitted
 */
function admitVoiceSpectator(io, game, sid, { fromLobby = false, announce = true, priorTalk = false } = {}) {
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
        canTalk: !!priorTalk,
        gateSince: null,
    };
    game.voiceSpectators.set(sid, entry);
    if (announce) announceSpectator(io, game, sid, username);
    recomputeTalk(io, game);
    sendVoiceSettings(io, game, sid);
    socketLogger.info('Voice: spectator admitted', { gameId: game.gameId, socketId: sid, fromLobby: entry.fromLobby, canTalk: entry.canTalk });
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
    for (const key of [...game.voiceOfferDir.keys()]) {
        if (key.startsWith(`${sid}>`) || key.endsWith(`>${sid}`)) game.voiceOfferDir.delete(key);
    }
    if (!io || game.isTerminal?.()) return true;
    const peers = new Set(gameVoiceMembers(game).map((m) => m.socketId));
    for (const other of game.voiceSpectators.keys()) peers.add(other);
    peers.delete(sid);
    for (const p of peers) {
        io.to(p).emit('voicePeerLeft', { socketId: sid });
        if (bothWays) io.to(sid).emit('voicePeerLeft', { socketId: p });
    }
    // The spectator count changed, which can free a slot; the modes of the
    // others are unchanged
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
 * A capable controller asks for spectatorsCanTalk = `value`. Coalesced per
 * game: applied at once when nothing was applied in the last COALESCE_MS,
 * else once at the end of that window with the latest value asked (the last
 * wins). An unchanged value applies nothing; the controllers still get
 * voiceSettings so a switch waiting for its echo settles.
 */
function requestSpectatorsCanTalk(io, game, value) {
    if (!isCasual(game)) return false;
    io = ioFor(game, io);
    const cv = game.casualVoice;
    cv.requested = !!value;
    if (game.hasTimer(SETTINGS_TIMER)) return true;
    const wait = cv.lastAppliedAt + COALESCE_MS - Date.now();
    if (wait <= 0) {
        applySpectatorsCanTalk(io, game, cv.requested);
    } else {
        game.setTimer(SETTINGS_TIMER, wait, () => applySpectatorsCanTalk(game.casualVoice.lastIo, game, game.casualVoice.requested));
    }
    return true;
}

function applySpectatorsCanTalk(io, game, value) {
    if (!isCasual(game)) return;
    const cv = game.casualVoice;
    if (value === cv.spectatorsCanTalk) {
        for (const m of capableMembers(game, io)) sendVoiceSettings(io, game, m.socketId);
        return;
    }
    cv.spectatorsCanTalk = value;
    cv.lastAppliedAt = Date.now();
    socketLogger.info('Voice: spectator talk changed', { gameId: game.gameId, spectatorsCanTalk: value });
    // Spectator <-> spectator pairs: off, they drop each other (both
    // capable: they keep a mute by username); on, the later-admitted one of
    // each pair is announced the earlier ones and offers
    const specs = spectatorsInOrder(game);
    if (io) {
        if (!value) {
            for (let i = 0; i < specs.length; i++) {
                for (let j = i + 1; j < specs.length; j++) {
                    io.to(specs[i].socketId).emit('voicePeerLeft', { socketId: specs[j].socketId });
                    io.to(specs[j].socketId).emit('voicePeerLeft', { socketId: specs[i].socketId });
                }
            }
        } else {
            for (let j = 1; j < specs.length; j++) {
                const later = specs[j];
                const earlier = specs.slice(0, j)
                    .filter((s) => !blockedPair(io, later.socketId, later.username, s.socketId, s.username))
                    .map((s) => ({ socketId: s.socketId, username: s.username }));
                for (const e of earlier) io.to(e.socketId).emit('voicePeerJoined', { socketId: later.socketId, username: later.username });
                if (earlier.length) io.to(later.socketId).emit('voicePeerList', { peers: earlier });
            }
        }
    }
    refreshVoice(io, game);
}

/**
 * The SDP gate (voiceOffer / voiceAnswer): a voice spectator who may not
 * talk may relay only listen-only SDP. Players and lobby members are never
 * gated. Every relayed spectator signal is recorded for the backstop.
 * @returns {boolean} relay it
 */
function gateSignal(io, fromSid, targetSid, sdp) {
    const gameId = gameManager.spectatorGames.get(fromSid);
    const game = gameId !== undefined ? gameManager.games.get(gameId) : null;
    if (!isVoiceSpectator(game, fromSid)) return true;
    const dir = sdpDirection.summary(sdp);
    if (dir === 'send' && !mayTalk(game, fromSid, io)) {
        gateDrops++;
        socketLogger.debug('Voice signal dropped', { from: fromSid, target: targetSid, reason: 'spectator_may_not_send' });
        if (gateDrops === 1 || gateDrops % 50 === 0) {
            socketLogger.info('Voice: spectator SDP gate drops', { count: gateDrops, gameId: game.gameId });
        }
        return false;
    }
    game.voiceOfferDir.set(`${fromSid}>${targetSid}`, { dir, at: Date.now() });
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
    game?.voiceOfferDir?.clear();
}

module.exports = {
    CAP,
    MAX_VOICE_PEOPLE,
    COALESCE_MS,
    BACKSTOP_MS,
    initCasualVoice,
    gameVoiceMembers,
    humanSeatsOrEntrants,
    voiceRoomOf,
    isVoiceSpectator,
    canChange,
    hasCapableController,
    mayTalk,
    settingsFor,
    sendVoiceSettings,
    refreshVoice,
    admitVoiceSpectator,
    removeVoiceSpectator,
    playerLeftVoice,
    requestSpectatorsCanTalk,
    gateSignal,
    endBlockedCall,
    blockedPair,
    retire,
    _gateDrops: () => gateDrops,
};
