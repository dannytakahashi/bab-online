/**
 * Play again (owner 2026-11-16: an AUTOMATIC return, no button): when a
 * casual game that a lobby started ENDS, everyone still at the table whose
 * client announced the clientHello cap `playAgain` is moved, in the same
 * tick as gameEnd, into a recreated copy of that lobby (fresh id; same name,
 * host, settings, chat and lobby bots; nobody ready) and told so with the
 * private, unsequenced `lobbyReturn`. They chat there and play again by
 * tapping Ready (the family-lobby rules, unchanged).
 *
 * People not at the table at the end keep a place for PLAY_AGAIN_HOLD_MS
 * (default 2 minutes, read at every arm; 0: none, the moved still return):
 *   - a hold: a lobby row whose socket id is `away:<uuid>` plus a
 *     GameManager.lobbyGrace entry {lobbyId, username, timer, kind:
 *     'afterGame', offline}. Only for usernames whose socket had the cap at
 *     the start. The existing re-entry machinery claims it (joinLobby ->
 *     findStaleLobbySeat -> takeOverLobbySeat), from any client; an
 *     `offline` hold (no live socket at the end) is also claimed
 *     automatically by that user's next capable joinMainRoom
 *     (mainRoomHandlers). Expiry / "Don't wait" / sign-out remove it as a
 *     leave that keeps everyone's ready flags (GameManager.leaveLobby).
 *   - a reservation (lobby.afterGame.reserved): a seat owner on a client
 *     without the cap (every shipped iOS build, cached web tabs) gets no
 *     row, but strangers and Add Bot cannot take their place while it
 *     stands (GameManager.joinSpecificLobby / addBotToLobby); they come
 *     back with Join on the main-room card as today.
 * A legacy seat owner still on the score screen keeps their calls with the
 * returners ("lingering", lobby.afterGame.lingering) until they leave it
 * (joinMainRoom and the other entry points, a disconnect) or the lobby
 * starts or goes: then a private voicePeerLeft both ways.
 *
 * Never: an aborted game, a tournament table, the ambient demo (no
 * game.lobbyOrigin: only GameManager.startGameFromLobby records it), a game
 * nobody capable comes back from, PLAY_AGAIN=off. server/CLAUDE.md, Lobby
 * seats ("Play again"); docs/claude/voice.md, Play again voice.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const gameManager = require('../game/GameManager');
const clientInfo = require('./clientInfo');
const { Presence } = require('../game/SeatState');
const { botController } = require('../game/bot');
const { safeTimeout } = require('../utils/safeTimer');
const { socketLogger } = require('../utils/logger');
const { emitError } = require('./serverError');

const CAP = 'playAgain';
const CASUAL_CAP = 'casualSpectators';
const HOLD_KIND = 'afterGame';
const AWAY_PREFIX = 'away:';
const DEFAULT_HOLD_MS = 120000;
const RESERVED_MESSAGE = 'Saved for players coming back from the last game';

/** The feature switch: PLAY_AGAIN=off turns it off (read at every game end). */
function enabled(env = process.env) {
    return String(env.PLAY_AGAIN ?? '').trim().toLowerCase() !== 'off';
}

/**
 * How long a hold / reservation stands: PLAY_AGAIN_HOLD_MS (read at every
 * arm; 0: no holds or reservations; garbage keeps the default), the
 * TOURNAMENT_READY_DEADLINE_MS pattern.
 */
function holdMs(env = process.env) {
    const raw = env.PLAY_AGAIN_HOLD_MS;
    if (raw === undefined || raw === '') return DEFAULT_HOLD_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_HOLD_MS;
}

const isAwayId = (sid) => typeof sid === 'string' && sid.startsWith(AWAY_PREFIX);
const hasCap = (io, sid, cap = CAP) => clientInfo.socketHasCap(io, sid, cap);
const isLive = (io, sid) => !!sid && !!io?.sockets?.sockets?.has(sid);
const lobbyHandlers = () => require('./lobbyHandlers');
const emitLobbiesUpdated = (io) => require('./gameLifecycle').emitLobbiesUpdated(io);

/** A failure here must never take the game-end tail (stats, activeGameId) down with it. */
function guarded(label, fn) {
    try {
        return fn();
    } catch (err) {
        socketLogger.error('Play again failed', { step: label, error: err?.message, stack: err?.stack });
        return null;
    }
}

// ==================== recorded at the start ====================

/**
 * game.lobbyOrigin, recorded by GameManager.startGameFromLobby before the
 * lobby is deleted. Server-side only, never on the wire.
 * @param {Object} lobby
 * @param {Object|null} io
 * @param {string[]} extras - usernames of the lobby's extras (PR A)
 */
function originOf(lobby, io, extras = []) {
    const humans = lobby.players.filter((p) => !p.isBot);
    const caps = lobby.capable instanceof Set ? lobby.capable : new Set();
    const bots = new Map();
    for (const p of lobby.players) {
        if (p.isBot) bots.set(p.socketId, gameManager.lobbyBotPersonality(lobby, p.socketId));
    }
    return {
        lobbyId: lobby.id,
        name: lobby.name || `${humans[0]?.username || 'Unknown'}'s Game`,
        createdBy: lobby.createdBy ?? null,
        host: gameManager.lobbyHost(lobby),
        settings: { spectatorsCanTalk: lobby.settings?.spectatorsCanTalk !== false },
        messages: (lobby.messages || []).slice(-gameManager.constructor.MAX_LOBBY_MESSAGES).map((m) => ({ ...m })),
        // Row order: usernames for humans, the bot socket id for bots
        order: lobby.players.map((p) => (p.isBot ? p.socketId : p.username)),
        bots,
        playAgainUsers: new Set(humans.filter((p) => hasCap(io, p.socketId)).map((p) => p.username)),
        casualUsers: new Set(humans.filter((p) => caps.has(p.socketId)).map((p) => p.username)),
        extras: new Set(extras),
    };
}

// ==================== at gameEnd ====================

/**
 * Step 1 (gameHandlers, after terminate and BEFORE gameManager.endGame,
 * whose _retire clears the spectators and the voice room): a pure read of
 * who is where. Eligibility is checked later (open), after _retire: before
 * it every owner is still mapped to this game.
 * @returns {Object|null} null when the game cannot open a lobby
 */
function plan(game, io, { score = null, playerStats = null } = {}) {
    return guarded('plan', () => {
        const origin = game?.lobbyOrigin;
        if (!origin || !enabled()) return null;
        const owners = [];
        for (const s of game.seatList()) {
            if (!s.ownerUsername) continue; // a native bot seat
            owners.push({
                username: s.ownerUsername,
                position: s.position,
                presence: s.presence,
                socketId: s.presence === Presence.CONNECTED ? s.ownerSocketId : null,
            });
        }
        // Extras still watching: username -> socket (a voice spectator first)
        const watching = new Map();
        for (const [sid, sp] of game.spectators) {
            if (!origin.extras.has(sp.username)) continue;
            if (!watching.has(sp.username) || game.voiceSpectators?.has(sid)) watching.set(sp.username, sid);
        }
        // The voice room at the end: players in voice + voice spectators
        const gameVoice = require('../voice/gameVoice');
        const voice = new Map(gameVoice.gameVoiceMembers(game).map((m) => [m.socketId, m.username]));
        for (const [sid, e] of game.voiceSpectators || []) voice.set(sid, e.username);
        return {
            gameId: game.gameId,
            origin,
            owners,
            watching,
            voice,
            spectatorsCanTalk: game.casualVoice ? game.casualVoice.spectatorsCanTalk !== false : origin.settings.spectatorsCanTalk,
            lastGame: {
                gameId: game.gameId,
                score: score ? { team1: score.team1, team2: score.team2 } : { ...game.score },
                playerStats: playerStats || {},
            },
        };
    });
}

/** Every live socket signed in or claimed as `username`. */
function liveSocketsOf(io, username) {
    const ids = new Set((gameManager.currentUsers || []).filter((u) => u.username === username).map((u) => u.socketId));
    for (const [id, s] of io?.sockets?.sockets || []) {
        if (s?.data?.username === username) ids.add(id);
    }
    return [...ids].filter((id) => isLive(io, id));
}

/**
 * Is `username` free to come back (checked after _retire)? Not merge-locked,
 * not playing elsewhere, holding no lobby seat anywhere, and no live socket
 * of theirs belongs to anything (one username never holds rows in two
 * lobbies).
 */
function isFree(io, username) {
    if (gameManager.isMergeLocked(username)) return false;
    if (gameManager.findLiveActivity(username)) return false;
    if (gameManager.findStaleLobbySeat(username, null)) return false;
    return liveSocketsOf(io, username).every((sid) => gameManager.activityOf(sid) == null);
}

/** Can live socket `sid` be moved into the lobby as `username`? */
function movable(io, sid, username) {
    return isLive(io, sid) && hasCap(io, sid) &&
        gameManager.getUserBySocketId(sid)?.username === username &&
        gameManager.activityOf(sid) == null &&
        !gameManager.mainRoomSocketIds.has(sid);
}

/** Who comes back, and how (spec 1.2): username -> {kind, socketId?, position?, offline?, lingerSocketId?}. */
function classify(io, p, ms) {
    const { origin } = p;
    const people = new Map();
    const hold = (username, position) => {
        if (ms > 0) people.set(username, { kind: 'hold', position, offline: liveSocketsOf(io, username).length === 0 });
    };
    for (const o of p.owners) {
        const U = o.username;
        if (people.has(U) || o.presence === Presence.GONE || !isFree(io, U)) continue;
        const live = isLive(io, o.socketId);
        if (live && hasCap(io, o.socketId)) {
            if (movable(io, o.socketId, U)) {
                people.set(U, { kind: 'moved', socketId: o.socketId, position: o.position });
            } else {
                hold(U, o.position);
            }
        } else if (live) {
            // A legacy client still at the table (the score screen): a
            // reserved place, and its calls with the returners linger
            people.set(U, { kind: 'reserve', lingerSocketId: o.socketId, reserved: ms > 0 });
        } else if (origin.playAgainUsers.has(U)) {
            hold(U, o.position);
        } else if (ms > 0) {
            people.set(U, { kind: 'reserve', lingerSocketId: null, reserved: true });
        }
    }
    for (const U of origin.extras) {
        if (people.has(U) || !isFree(io, U)) continue;
        const sid = p.watching.get(U);
        if (sid && movable(io, sid, U)) {
            people.set(U, { kind: 'moved', socketId: sid, position: null });
        } else if (origin.playAgainUsers.has(U)) {
            hold(U, null);
        }
    }
    return people;
}

/** The lobby bots' generic name: the lowest free number (GameManager.addBotToLobby). */
function botName(taken) {
    for (let n = 1; ; n++) {
        const name = n > 1 ? `🤖 Bot ${n}` : '🤖 Bot';
        if (!taken.has(name)) return name;
    }
}

/**
 * Step 2 (gameHandlers, synchronously after gameManager.endGame, before
 * the first await): checks who is free, recreates the lobby, arms the
 * holds and reservations, then sends lobbyReturn to each moved socket
 * (after its gameEnd), the voice peer lists, and the main room's list.
 * @returns {Object|null} the new lobby
 */
function open(io, p) {
    if (!p) return null;
    return guarded('open', () => openLobby(io, p));
}

function openLobby(io, p) {
    const { origin } = p;
    const ms = holdMs();
    const people = classify(io, p, ms);
    if (![...people.values()].some((x) => x.kind === 'moved')) return null;

    const lobbyId = uuidv4();
    const rows = [];
    const capable = new Set();
    const botPersonalities = new Map();
    const holds = [];
    const takenBotNames = new Set();
    for (const key of origin.order) {
        if (origin.bots.has(key)) {
            const personality = origin.bots.get(key);
            const name = botName(takenBotNames);
            takenBotNames.add(name);
            const bot = botController.createBot(name, personality);
            rows.push({ socketId: bot.socketId, username: bot.username, ready: false, isBot: true });
            botPersonalities.set(bot.socketId, personality);
            continue;
        }
        const who = people.get(key);
        if (!who || who.kind === 'reserve') continue;
        if (rows.some((r) => !r.isBot && r.username === key)) continue;
        if (who.kind === 'moved') {
            rows.push({ socketId: who.socketId, username: key, ready: false });
            if (hasCap(io, who.socketId, CASUAL_CAP)) capable.add(who.socketId);
        } else {
            const awayId = `${AWAY_PREFIX}${uuidv4()}`;
            rows.push({ socketId: awayId, username: key, ready: false });
            if (origin.casualUsers.has(key)) capable.add(awayId);
            holds.push({ awayId, username: key, offline: who.offline });
        }
    }
    const moved = rows.filter((r) => !r.isBot && !isAwayId(r.socketId));
    const humans = rows.filter((r) => !r.isBot);
    const host = humans.some((r) => r.username === origin.host) ? origin.host : moved[0].username;

    const lobby = {
        id: lobbyId,
        name: origin.name,
        players: rows,
        readyPlayers: new Set(),
        messages: origin.messages.map((m) => ({ ...m })),
        createdAt: Date.now(),
        createdBy: origin.createdBy ?? undefined,
        host,
        hostProvisional: false,
        settings: { spectatorsCanTalk: p.spectatorsCanTalk !== false },
        capable,
        botPersonalities,
        afterGame: {
            fromGameId: p.gameId,
            reserved: new Map(),
            lingering: new Map(),
            io,
        },
    };
    if (lobby.createdBy === undefined) delete lobby.createdBy;

    // One claim per username: an older reservation elsewhere goes
    for (const U of people.keys()) dropReservations(U, { notify: true });

    gameManager.lobbies.set(lobbyId, lobby);
    for (const r of moved) {
        gameManager.playerLobbies.set(r.socketId, lobbyId);
        gameManager.leaveMainRoom(r.socketId);
    }
    for (const h of holds) {
        const timer = safeTimeout(() => releaseHold(null, h.awayId, 'expired'), ms, 'playAgainHold');
        timer.unref?.();
        gameManager.lobbyGrace.set(h.awayId, { lobbyId, username: h.username, timer, kind: HOLD_KIND, offline: h.offline });
    }
    const movedIds = new Set(moved.map((r) => r.socketId));
    // In the lobby's row order (`expected` lists them so)
    const byRow = [...people].sort((a, b) => origin.order.indexOf(a[0]) - origin.order.indexOf(b[0]));
    for (const [U, who] of byRow) {
        if (who.kind !== 'reserve') continue;
        if (who.reserved) {
            const timer = safeTimeout(() => endReservation(lobbyId, U, { reason: 'expired' }), ms, 'playAgainReservation');
            timer.unref?.();
            lobby.afterGame.reserved.set(U, { timer });
        }
        // Its calls with the returners (the voice room's moved members) linger
        if (who.lingerSocketId && p.voice.has(who.lingerSocketId)) {
            const peers = new Set([...movedIds].filter((sid) => p.voice.has(sid)));
            if (peers.size > 0) lobby.afterGame.lingering.set(who.lingerSocketId, { username: U, peers });
        }
    }
    gameManager._reassignHost(lobby);

    // lobbyReturn to each moved socket (its gameEnd went out first)
    const base = gameManager.lobbyWire(lobby, { messages: lobby.messages, name: lobby.name });
    const extras = gameManager.lobbyExtrasWire(lobby);
    for (const r of moved) {
        const position = people.get(r.username)?.position ?? null;
        io.to(r.socketId).emit('lobbyReturn', {
            ...base,
            ...extras,
            lastGame: { ...p.lastGame, position },
        });
    }

    voiceAtReturn(io, lobby, moved, p.voice);
    emitLobbiesUpdated(io);

    socketLogger.info('Play again: lobby reopened', {
        lobbyId,
        fromGameId: p.gameId,
        moved: moved.length,
        holds: holds.length,
        reserved: lobby.afterGame.reserved.size,
        lingering: lobby.afterGame.lingering.size,
        bots: botPersonalities.size,
    });
    return lobby;
}

/**
 * Voice at the return tick (spec 2.4). R: the moved sockets in row order.
 * Pairs within R are never touched; each r_i is given {r_j : j < i} and
 * each such r_j a voicePeerJoined{r_i} (a client skips a peer it is
 * connected to already; a missing pair gets exactly one offer, from the
 * later one). Every other socket of the game's voice room (main-room
 * spectators, owners not moved) except a lingering legacy owner drops its
 * calls with R (private voicePeerLeft both ways).
 */
function voiceAtReturn(io, lobby, moved, voice) {
    const { blockedPair } = require('../voice/gameVoice');
    const R = moved.map((r) => ({ socketId: r.socketId, username: r.username }));
    for (let i = 1; i < R.length; i++) {
        const me = R[i];
        const earlier = R.slice(0, i).filter((e) => !blockedPair(io, me.socketId, me.username, e.socketId, e.username));
        if (earlier.length === 0) continue;
        io.to(me.socketId).emit('voicePeerList', { peers: earlier });
        for (const e of earlier) io.to(e.socketId).emit('voicePeerJoined', { socketId: me.socketId, username: me.username });
    }
    const inR = new Set(R.map((r) => r.socketId));
    for (const sid of voice.keys()) {
        if (inR.has(sid) || lobby.afterGame.lingering.has(sid)) continue;
        for (const r of R) {
            io.to(r.socketId).emit('voicePeerLeft', { socketId: sid });
            io.to(sid).emit('voicePeerLeft', { socketId: r.socketId });
        }
    }
}

// ==================== holds ====================

/** Is `sid` a play-again hold row (an `away:` id with its grace entry)? */
function isHold(sid) {
    return isAwayId(sid) && gameManager.lobbyGrace.get(sid)?.kind === HOLD_KIND;
}

/** `username`'s offline hold, {awayId, lobbyId} or null (the joinMainRoom auto-claim). */
function offlineHoldFor(username) {
    if (!username) return null;
    for (const [awayId, held] of gameManager.lobbyGrace) {
        if (held.kind === HOLD_KIND && held.offline && held.username === username && gameManager.lobbies.has(held.lobbyId)) {
            return { awayId, lobbyId: held.lobbyId };
        }
    }
    return null;
}

/**
 * Give up hold `awayId` now (its timer, "Don't wait", a sign-out): a leave
 * that keeps the others' ready flags (lobbyPlayerLeft to the rest, the main
 * room's list; a lobby with no human left is deleted).
 */
function releaseHold(io, awayId, reason) {
    const held = gameManager.lobbyGrace.get(awayId);
    if (!held || held.kind !== HOLD_KIND) return false;
    const lobby = gameManager.lobbies.get(held.lobbyId);
    io = io || lobby?.afterGame?.io || null;
    const expired = gameManager.releaseHeldLobbySeat(awayId);
    if (expired && io) lobbyHandlers().lobbySeatExpired(io, expired);
    socketLogger.info('Play again: hold ended', { lobbyId: held.lobbyId, reason, lobbyDeleted: Boolean(expired?.leaveResult?.lobbyDeleted) });
    return !!expired;
}

// ==================== reservations ====================

/** playerReadyUpdate (plain) to the lobby's capable members: `expected` changed. */
function sendExpected(lobby) {
    const io = lobby?.afterGame?.io;
    if (!io) return;
    for (const p of lobby.players) {
        if (p.isBot || gameManager.playerLobbies.get(p.socketId) !== lobby.id || !lobby.capable?.has(p.socketId)) continue;
        io.to(p.socketId).emit('playerReadyUpdate', gameManager.lobbyWire(lobby, {}, { to: p.socketId }));
    }
}

function endReservation(lobbyId, username, { notify = true, reason = null } = {}) {
    const lobby = gameManager.lobbies.get(lobbyId);
    const rec = lobby?.afterGame?.reserved.get(username);
    if (!rec) return false;
    clearTimeout(rec.timer);
    lobby.afterGame.reserved.delete(username);
    if (notify) sendExpected(lobby);
    socketLogger.info('Play again: reservation ended', { lobbyId, reason });
    return true;
}

/**
 * `username` went somewhere else (created / joined a lobby or a
 * tournament) or comes back here: every reservation of theirs ends.
 * `joinedLobbyId`: the lobby they just joined (its join notifications
 * carry the new `expected`, so it is not sent again).
 */
function dropReservations(username, { joinedLobbyId = null, notify = true } = {}) {
    if (!username) return;
    for (const lobby of gameManager.lobbies.values()) {
        if (!lobby.afterGame?.reserved.has(username)) continue;
        endReservation(lobby.id, username, { notify: notify && lobby.id !== joinedLobbyId, reason: 'claimed' });
    }
}

/** Reserved usernames of `lobby` (empty when none). */
function reservedIn(lobby) {
    return lobby?.afterGame?.reserved || new Map();
}

/**
 * Do the reservations refuse `username` a new place in `lobby` (a join or
 * a bot)? While any stands, members + reservations may not pass 4.
 */
function reservationBlocks(lobby, username = null) {
    const reserved = reservedIn(lobby);
    if (reserved.size === 0 || (username && reserved.has(username))) return false;
    return lobby.players.length + reserved.size >= 4;
}

// ==================== lingering voice ====================

function endLingeringEntry(io, sid, entry, reason) {
    if (io) {
        for (const peer of entry.peers) {
            io.to(sid).emit('voicePeerLeft', { socketId: peer });
            io.to(peer).emit('voicePeerLeft', { socketId: sid });
        }
    }
    socketLogger.info('Play again: lingering voice ended', { socketId: sid, reason, peers: entry.peers.size });
}

/**
 * Socket `sid` left the score screen (joinMainRoom, another entry point, a
 * disconnect): its lingering calls end (private voicePeerLeft both ways).
 */
function endLingering(io, sid, reason = 'left') {
    if (!sid) return false;
    let ended = false;
    for (const lobby of gameManager.lobbies.values()) {
        const entry = lobby.afterGame?.lingering.get(sid);
        if (!entry) continue;
        lobby.afterGame.lingering.delete(sid);
        endLingeringEntry(io || lobby.afterGame.io, sid, entry, reason);
        ended = true;
    }
    return ended;
}

/** Do `a` and `b` share a lingering call (a block ends it: gameVoice.endBlockedCall)? */
function isLingeringPair(a, b) {
    for (const lobby of gameManager.lobbies.values()) {
        const lingering = lobby.afterGame?.lingering;
        if (!lingering) continue;
        if (lingering.get(a)?.peers.has(b) || lingering.get(b)?.peers.has(a)) return true;
    }
    return false;
}

// ==================== lobby start / delete ====================

/**
 * The lobby starts a game (GameManager.startGameFromLobby, before the
 * lobby is deleted) or is deleted (GameManager.leaveLobby): lingering
 * calls end, reservations and their timers go, every hold's grace is
 * cleared (a hold off the table becomes nothing, as a reload-held seat
 * does), and afterGame is deleted.
 */
function teardown(lobby, reason) {
    const ag = lobby?.afterGame;
    if (!ag) return;
    for (const [sid, entry] of ag.lingering) endLingeringEntry(ag.io, sid, entry, reason);
    ag.lingering.clear();
    for (const rec of ag.reserved.values()) clearTimeout(rec.timer);
    ag.reserved.clear();
    for (const p of lobby.players) {
        if (isHold(p.socketId)) gameManager._clearLobbyGrace(p.socketId);
    }
    delete lobby.afterGame;
}

const onLobbyStart = (lobby) => teardown(lobby, 'start');
const onLobbyGone = (lobby) => teardown(lobby, 'deleted');

// ==================== sign-outs and "Don't wait" ====================

/**
 * signOutUser (sign out everywhere, a password reset, self-delete, admin
 * merge / rename / delete): the user's holds and reservations end, and
 * any lingering call of theirs. sessionIdentity.releaseIdentity does not
 * come here: holds belong to the username, not to a tab.
 */
function releaseUser(io, username) {
    if (!username) return;
    return guarded('releaseUser', () => {
        for (const [awayId, held] of [...gameManager.lobbyGrace]) {
            if (held.kind === HOLD_KIND && held.username === username) releaseHold(io, awayId, 'signedOut');
        }
        dropReservations(username, { notify: true });
        for (const lobby of gameManager.lobbies.values()) {
            for (const [sid, entry] of [...(lobby.afterGame?.lingering || [])]) {
                if (entry.username === username) endLingering(io, sid, 'signedOut');
            }
        }
    });
}

/**
 * c2s releaseLobbyHold {username} ("Don't wait for <name>"): the host only;
 * while the host is away (a hold or a reload-held seat) any present member.
 * Releases that user's hold or reservation at once, as an expiry.
 */
async function releaseLobbyHold(socket, io, data) {
    const lobby = gameManager.getPlayerLobby(socket.id);
    if (!lobby) {
        emitError(socket, { message: 'Not in a lobby' }, 'releaseLobbyHold');
        return;
    }
    const user = gameManager.getUserBySocketId(socket.id);
    const host = gameManager.lobbyHost(lobby);
    const hostRow = lobby.players.find((p) => !p.isBot && p.username === host);
    const hostPresent = !!hostRow && gameManager.playerLobbies.get(hostRow.socketId) === lobby.id;
    if (!user || (hostPresent && host !== user.username)) {
        emitError(socket, { message: 'Only the host can do this' }, 'releaseLobbyHold');
        return;
    }
    const username = data.username;
    const row = lobby.players.find((p) => !p.isBot && p.username === username && isHold(p.socketId));
    if (row) {
        releaseHold(io, row.socketId, 'released');
        return;
    }
    if (endReservation(lobby.id, username, { reason: 'released' })) return;
    emitError(socket, { message: 'Nobody by that name is coming back' }, 'releaseLobbyHold');
}

module.exports = {
    CAP,
    HOLD_KIND,
    AWAY_PREFIX,
    DEFAULT_HOLD_MS,
    RESERVED_MESSAGE,
    enabled,
    holdMs,
    isAwayId,
    isHold,
    originOf,
    plan,
    open,
    offlineHoldFor,
    releaseHold,
    dropReservations,
    reservedIn,
    reservationBlocks,
    endLingering,
    isLingeringPair,
    onLobbyStart,
    onLobbyGone,
    releaseUser,
    releaseLobbyHold,
};
