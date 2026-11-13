/**
 * Seat lifecycle orchestration: who controls each seat and whether its
 * owner is present (the records live on GameState, see game/SeatState.js).
 *
 * Every function here has the shape (io, game, ...) and does its work in the
 * same order:
 *   1. the GameState seat transition (the only writer of seat state),
 *   2. playerGames / spectatorGames / room membership,
 *   3. emits,
 *   4. maybeAbort.
 * Socket handlers (queue, chat, reconnect, main room, game) only decide which
 * of these to call.
 *
 * playerGames contract for a game G: it maps exactly the connected entrants
 * (before seating), every seat's ownerSocketId, and every bot-controlled
 * seat's bot socket (incl. native bot seats). Dead and stale sockets are
 * never mapped; pure spectators live only in gameManager.spectatorGames and
 * game.spectators.
 */

const gameManager = require('../game/GameManager');
const { botController, personalities } = require('../game/bot');
const { Phase } = require('../game/GamePhase');
const SeatState = require('../game/SeatState');
const { socketLogger } = require('../utils/logger');
const { snapshotFor } = require('./snapshotHandlers');
const avatarWire = require('../avatar/avatarWire');
const { hasCap } = require('./clientInfo');

/** getClientState of seat socket `sid` as `socket` should receive it (avatars: docs/avatars.md). */
const stateFor = (game, sid, socket) => avatarWire.wireClientState(game, game.getClientState(sid), hasCap(socket, 'avatarUrl'));

const { PERSONALITY_LIST, getDisplayName } = personalities;
const { Controller, Presence, RECONNECT_GRACE_MS, ABANDON_MS, DRAW_WATCHDOG_MS, AFK_TIMEOUT_MS } = SeatState;

const logError = (what, game) => (err) =>
    socketLogger.error(`${what} failed`, { gameId: game.gameId, error: err.message, stack: err.stack });

function logEntry(io, game, message) {
    game.addLogEntry(message, null, 'system');
    game.broadcast(io, 'gameLogEntry', { message, type: 'system' });
}

/** Drop `sid` from playerGames if it still points at this game. */
function unmap(game, sid) {
    if (sid != null && gameManager.playerGames.get(sid) === game.gameId) gameManager.playerGames.delete(sid);
}

// ==================== bots for seats ====================

/**
 * Pick a bot personality whose name is not already at the table: not used by
 * any bot registered for the game (lobby, tournament, ambient, resign and
 * lazy bots) or held by a seat, and not shown as any seat's name. `preferred`
 * (the seat's last personality) is reused only while it is still free.
 * @param {GameState} game
 * @param {string|null} [preferred]
 * @returns {string} personality key
 */
function pickBotPersonality(game, preferred = null) {
    const used = new Set();
    for (const bot of botController.getGameBots(game.gameId)) {
        if (bot.personality) used.add(bot.personality);
    }
    const names = new Set();
    for (const s of game.seatList()) {
        if (s.bot?.personality) used.add(s.bot.personality);
        const shown = game.getPlayerByPosition(s.position);
        if (shown) names.add(shown.username);
    }
    for (const p of PERSONALITY_LIST) {
        if (names.has(`🤖 ${getDisplayName(p)}`)) used.add(p);
    }
    const free = PERSONALITY_LIST.filter(p => !used.has(p));
    // 5 personalities, at most 3 other seats: never empty in practice
    const pool = free.length > 0 ? free : PERSONALITY_LIST;
    if (preferred && pool.includes(preferred)) return preferred;
    return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * A fresh bot for seat `pos` (lazy, resign or draw-phase leaver), registered
 * with the controller and mapped to the game. The caller seats it.
 * @returns {BotPlayer}
 */
function createSeatBot(game, pos, preferred = null) {
    const personality = pickBotPersonality(game, preferred);
    const bot = botController.createBot(`🤖 ${getDisplayName(personality)}`, personality);
    bot.position = pos;
    bot.pic = Math.floor(Math.random() * 82) + 1;
    botController.registerBot(game.gameId, bot);
    bot.resetCardMemory(game.currentHand, game.trump);
    gameManager.playerGames.set(bot.socketId, game.gameId);
    return bot;
}

/** Undo createSeatBot for a bot that never got its seat. */
function discardSeatBot(game, bot) {
    botController.unregisterBot(game.gameId, bot.socketId);
    unmap(game, bot.socketId);
}

function triggerIfOnTurn(io, game, pos) {
    const actionType = game.actionTypeForTurn();
    if (game.currentTurn === pos && actionType) {
        const { triggerBotIfNeeded } = require('./gameHandlers');
        triggerBotIfNeeded(io, game, actionType);
    }
}

// ==================== tournaments ====================

/**
 * If the game belongs to a tournament, reattach the player's tournament
 * membership to their new socket and rejoin the tournament room.
 * @returns {Object|null} the tournament, or null
 */
function reattachTournament(io, socket, gameId, username) {
    const tournamentId = gameManager.tournamentGames.get(gameId);
    if (!tournamentId) return null;

    // Scope the reattach to THIS game's tournament — the same username can
    // linger as a ghost entry in an older tournament
    const tournament = gameManager.reattachTournamentPlayer(socket.id, username, tournamentId);
    if (tournament) {
        socket.join(tournament.roomName);
        // Let lobby viewers see the reconnect (and any creator handoff)
        const state = tournament.getClientState();
        tournament.broadcast(io, 'tournamentPlayerJoined', {
            username,
            players: state.players,
            scoreboard: state.scoreboard
        });
        socketLogger.info('Tournament membership reattached on rejoin', {
            username, tournamentId: tournament.tournamentId, gameId
        });
        return tournament;
    }
    // Game maps to a tournament but no membership entry matched (e.g. the
    // tournament was deleted) — still return whatever exists for the id
    return gameManager.getTournamentById(tournamentId);
}

// ==================== presence replay & resign offers ====================

/**
 * game.offerPos: the resign offer the present clients currently hold (the
 * last room-wide resignationAvailable, or the one replayPresenceTo handed a
 * returning socket when nobody held one), or null.
 */
function offer(io, game, pos) {
    game.broadcast(io, 'resignationAvailable', { position: pos, username: game.seat(pos).ownerUsername });
    game.offerPos = pos;
}

/**
 * Bring a socket that just (re)attached up to date on the other seats'
 * absences: playerDisconnected for each absent human seat (oldest first),
 * then the current resign offer. iOS shows its disconnect banner only while
 * it has a playerDisconnected entry, so the order matters.
 */
function replayPresenceTo(game, socket, ownPos) {
    const absent = game.seatList()
        .filter(s => s.position !== ownPos && (s.presence === Presence.GRACE || s.presence === Presence.RESIGNABLE))
        .sort((a, b) => (a.absentSince - b.absentSince) || (a.position - b.position));
    for (const s of absent) {
        socket.emit('playerDisconnected', { position: s.position, username: s.ownerUsername });
    }
    const resignable = game.resignablePositions().filter(p => p !== ownPos);
    if (resignable.length > 0) {
        const p = resignable.includes(game.offerPos) ? game.offerPos : resignable[0];
        socket.emit('resignationAvailable', { position: p, username: game.seat(p).ownerUsername });
        // Record the offer this socket now holds, so reofferAfter moves it
        // when p's owner comes back (or p is resigned). Not when the standing
        // offer is for the returner's own seat: reconnectOwner's
        // reofferAfter(ownPos) moves that one room-wide right after.
        if (game.offerPos !== ownPos) game.offerPos = p;
    }
}

/**
 * Clients hold one resign offer at a time (and clear it on ANY
 * playerResigned): after a resign, or after the offered seat came back,
 * offer the oldest remaining resignable seat, if anyone is here to act.
 */
function reofferAfter(io, game, pos, why) {
    if (why !== 'resign' && game.offerPos !== pos) return;
    const next = game.resignablePositions().find(p => p !== pos);
    if (next && game.hasPresentHuman()) {
        offer(io, game, next);
    } else {
        game.offerPos = null;
    }
}

// ==================== abort ====================

/**
 * The single presence-driven abort decision (synchronous). A seated table
 * with owners aborts at once when no owner can ever come back, and after
 * ABANDON_MS when no owner is connected. Ambient / native-bot tables (no
 * owners) are never presence-aborted. Pre-seating is handled by
 * handleDrawComplete (which calls this right after seating).
 * @returns {boolean} true if it aborted the game now
 */
function maybeAbort(io, game) {
    if (game.isTerminal() || game.seatList().length < 4) return false;
    const owned = game.seatList().filter(s => s.ownerUsername);
    if (owned.length === 0) return false;
    if (game.hasPresentHuman()) {
        game.clearTimer('abandon');
        return false;
    }
    const { abortGame } = require('./gameLifecycle');
    if (!owned.some(s => game.isReturnable(s.position))) {
        socketLogger.warn('All players left, aborting game', { gameId: game.gameId });
        abortGame(io, game, 'All players left').catch(logError('abortGame', game));
        return true;
    }
    if (!game.hasTimer('abandon')) {
        game.setTimer('abandon', ABANDON_MS, () => {
            if (game.hasPresentHuman()) return;
            socketLogger.warn('All players disconnected, aborting game', { gameId: game.gameId });
            return abortGame(io, game, 'All players disconnected');
        });
    }
    return false;
}

// ==================== disconnects ====================

/**
 * The owner socket `sid` of seat `pos` dropped (the caller checked
 * seatByOwnerSocket(sid) === pos).
 */
function disconnectOwner(io, game, pos, sid) {
    const seat = game.seat(pos);
    if (!seat) return;
    const username = seat.ownerUsername;
    if (seat.controller === Controller.HUMAN) {
        if (!game.seatDisconnect(pos, sid, { onGraceExpire: () => onGraceExpired(io, game, pos) })) return;
        unmap(game, sid);
        socketLogger.info('Player disconnected from game, waiting for reconnection', {
            username, position: pos, gameId: game.gameId, gracePeriod: RECONNECT_GRACE_MS / 1000
        });
        game.broadcast(io, 'playerDisconnected', { position: pos, username });
        game.broadcast(io, 'voicePeerLeft', { socketId: sid });
        logEntry(io, game, `${username} disconnected. Waiting for reconnection...`);
    } else {
        const view = seat.ownerView;
        if (!game.seatDisconnect(pos, sid)) return;
        unmap(game, sid);
        game.leaveRoom(io, sid);
        socketLogger.info('Bot-controlled seat owner disconnected, bot continues playing', {
            username, position: pos, gameId: game.gameId, view
        });
        if (view === 'seat') logEntry(io, game, `${username} disconnected. Bot continues playing.`);
    }
    maybeAbort(io, game);
}

/** grace:<pos> fired: the seat becomes resignable. */
function onGraceExpired(io, game, pos) {
    const seat = game.seat(pos);
    if (!seat || seat.presence !== Presence.GRACE) return;
    if (!game.seatGraceExpired(pos)) return;
    if (game.hasPresentHuman()) {
        socketLogger.info('Grace period expired, resignation available', {
            gameId: game.gameId, position: pos, username: seat.ownerUsername
        });
        offer(io, game, pos);
        logEntry(io, game, `${seat.ownerUsername} failed to reconnect. You may replace them with a bot.`);
    }
    // Nobody here: a returning player gets the offer through replayPresenceTo
    maybeAbort(io, game);
}

// ==================== returning owners ====================

/**
 * A socket about to become seat `pos`'s owner stops being a pure spectator
 * (of this or any other game) BEFORE the seat transition, so the transition's
 * own invariant check (an owner socket is never in game.spectators) holds
 * throughout. Only when the edge is legal: an illegal one fails closed
 * without touching the socket's spectating.
 */
function leaveSpectatingFor(io, game, pos, sid, event) {
    if (!SeatState.checkEdge(game.seat(pos), event).ok) return;
    gameManager.leaveSpectating(io, sid);
}

/**
 * The owner of a human seat is back on `socket` (from grace / resignable,
 * or with an older socket still attached: the newest socket owns the seat;
 * the old one is unmapped and taken out of the room without an emit).
 */
function reconnectOwner(io, game, pos, socket, username) {
    leaveSpectatingFor(io, game, pos, socket.id, 'reconnect');
    const oldSid = game.seatReconnect(pos, socket.id);
    if (oldSid == null) return false;
    if (oldSid !== socket.id) {
        game.leaveRoom(io, oldSid);
        unmap(game, oldSid);
    }
    gameManager.playerGames.set(socket.id, game.gameId);
    game.joinToRoom(io, socket.id);
    gameManager.registerUser(socket.id, username);
    const tournament = reattachTournament(io, socket, game.gameId, username);

    socketLogger.info('Player rejoined game', { username, gameId: game.gameId, position: pos });
    socket.emit('rejoinSuccess', {
        ...stateFor(game, socket.id, socket),
        tournamentId: tournament ? tournament.tournamentId : null,
        snapshot: snapshotFor(game, socket.id, { customPics: false }) // v2 (additive)
    });
    game.broadcast(io, 'playerReconnected', { position: pos, username });

    // Voice: the other connected owners at their seats
    const peers = [];
    for (const s of game.seatList()) {
        if (s.position === pos || s.presence !== Presence.CONNECTED) continue;
        if (s.controller !== Controller.HUMAN && s.ownerView !== 'seat') continue;
        peers.push({ socketId: s.ownerSocketId, username: game.getPlayerByPosition(s.position).username });
        io.to(s.ownerSocketId).emit('voicePeerJoined', { socketId: socket.id, username });
    }
    if (peers.length > 0) socket.emit('voicePeerList', { peers });

    logEntry(io, game, `${username} reconnected.`);
    replayPresenceTo(game, socket, pos);
    reofferAfter(io, game, pos, 'reconnect');
    // Back from grace on its own turn: the watchdog starts now (a newer
    // socket taking a connected seat keeps the running one)
    if (game.currentTurn === pos) armAfk(io, game, pos, { keep: true });
    maybeAbort(io, game);
    return true;
}

/**
 * The owner of a bot-controlled seat (lazy or resigned) attaches `socket` to
 * watch it while the bot plays. An older owner socket is demoted to a pure
 * spectator (keeps watching, loses /active and every other seat right),
 * unless it is parked (superseded by this socket): then it just leaves.
 * @param {Object} opts
 * @param {'rejoin'|'spectate'} opts.via
 */
function watchSeat(io, game, pos, socket, username, { via }) {
    leaveSpectatingFor(io, game, pos, socket.id, 'watch');
    const prev = game.seatWatch(pos, socket.id);
    const seat = game.seat(pos);
    if (seat?.ownerSocketId !== socket.id) return false;
    if (prev) {
        unmap(game, prev);
        // A parked socket (sessionIdentity: superseded by this one) is not
        // watching anything: it leaves like a gone one
        const prevSocket = io.sockets.sockets.get(prev);
        if (prevSocket && !prevSocket.data?.superseded) {
            gameManager.addSpectator(io, game, prev, username, null);
        } else {
            game.leaveRoom(io, prev);
        }
    }
    gameManager.playerGames.set(socket.id, game.gameId);
    game.joinToRoom(io, socket.id);
    gameManager.registerUser(socket.id, username);
    if (via === 'spectate') {
        socket.leave('mainRoom');
        gameManager.leaveMainRoom(socket.id);
    }

    // The seat's own view (position, hand) with the lazy flag
    const state = { ...stateFor(game, seat.seatSocketId, socket), isLazy: true };
    if (via === 'rejoin') {
        const tournament = reattachTournament(io, socket, game.gameId, username);
        state.tournamentId = tournament ? tournament.tournamentId : null;
    }
    state.snapshot = snapshotFor(game, socket.id, { customPics: false }); // v2 (additive)
    socketLogger.info('Owner watching bot-controlled seat', { username, gameId: game.gameId, position: pos, via });
    socket.emit('rejoinSuccess', state);
    if (via === 'rejoin') {
        game.broadcast(io, 'playerReconnected', { position: pos, username });
        logEntry(io, game, `${username} reconnected.`);
    } else {
        game.broadcast(io, 'spectatorJoined', { username, spectatorCount: game.getSpectators().length });
    }
    replayPresenceTo(game, socket, pos);
    maybeAbort(io, game);
    return true;
}

/**
 * /active from a pure spectator recorded under the owner's name (an older
 * socket that watchSeat demoted when a newer one took the seat, or another
 * tab of the owner) while the bot-controlled seat has NO live owner socket
 * (presence 'away'): the socket attaches to the seat and takes it back, as a
 * rejoin followed by /active would. With an owner socket attached the newest
 * socket keeps the seat and this is refused.
 */
function reclaimSeat(io, game, pos, socket, username) {
    const seat = game.seat(pos);
    if (!seat || seat.controller === Controller.HUMAN || seat.presence !== Presence.AWAY) return false;
    leaveSpectatingFor(io, game, pos, socket.id, 'watch');
    if (game.seatWatch(pos, socket.id) !== null || seat.ownerSocketId !== socket.id) return false;
    gameManager.playerGames.set(socket.id, game.gameId);
    game.joinToRoom(io, socket.id);
    gameManager.registerUser(socket.id, username);
    socketLogger.info('Owner reclaimed bot-controlled seat from a spectating socket', { username, gameId: game.gameId, position: pos });
    // ownerView is 'watch' now: goActive re-sends the seat's full state
    // (restorePlayerState) and the presence replay to this socket
    return goActive(io, game, pos, socket);
}

// ==================== turn watchdog (AFK) ====================

const afkKey = (pos) => `afk:${pos}`;

/** The seat whose turn it is can be watched: a connected human, turn open. */
function afkEligible(game, pos) {
    const seat = game.seat(pos);
    return !!seat && seat.controller === Controller.HUMAN && seat.presence === Presence.CONNECTED &&
        game.acceptsTurnInput() && game.currentTurn === pos;
}

/**
 * Arm the turn watchdog for `pos` (owner, 2026-11-11: 90 s, every game):
 * a connected human who neither bids nor plays within afkTimeoutMs() goes
 * lazy exactly as with /lazy. Called where a human turn opens
 * (triggerBotIfNeeded's human branch), when a seat comes back to a human on
 * its turn (reconnect, /active) — never during grace or disconnect (the
 * grace timers own those; a presence change clears it, GameState
 * _applySeatEdge). Every other seat's watchdog is cleared: the turn moved.
 * Cleared too by the seat's own bid/play (clearAfk), /lazy and /active
 * (controller change) and abort/end (terminate cancels every game timer;
 * setTimer's epoch guard).
 * @param {{keep?: boolean}} [opts] keep a watchdog already running for this
 *   same turn (a newer socket taking the seat does not restart the clock)
 */
function armAfk(io, game, pos, { keep = false } = {}) {
    for (let p = 1; p <= 4; p++) if (p !== pos) game.clearTimer(afkKey(p));
    const ms = SeatState.afkTimeoutMs();
    if (!ms || !afkEligible(game, pos)) {
        game.clearTimer(afkKey(pos));
        return false;
    }
    if (keep && game.hasTimer(afkKey(pos))) return true;
    const turn = game.turnKey();
    return game.setTimer(afkKey(pos), ms, () => onAfk(io, game, pos, turn));
}

/** The seat acted (or its turn is otherwise over): stop its watchdog. */
function clearAfk(game, pos) {
    if (pos) game.clearTimer(afkKey(pos));
}

/** The watchdog fired: still the same open turn of the same connected human? */
function onAfk(io, game, pos, turn) {
    if (!afkEligible(game, pos) || game.turnKey() !== turn) return false;
    socketLogger.info('Turn timeout: bot takes over an idle seat', { gameId: game.gameId, position: pos, ms: SeatState.afkTimeoutMs() });
    return goLazy(io, game, pos, { reason: 'afk' });
}

// ==================== lazy / active ====================

/**
 * /lazy: a bot plays the owner's (human, connected) seat.
 * @param {{reason?: 'afk'|'leave'}} [opts] 'afk': the turn watchdog fired;
 *   'leave': the first half of /leave at a human seat (same transition and
 *   events, each with its own log line: a leaver cannot /active back)
 */
function goLazy(io, game, pos, { reason = null } = {}) {
    const seat = game.seat(pos);
    const bot = createSeatBot(game, pos, seat.lastPersonality);
    if (game.seatGoLazy(pos, bot) == null) {
        discardSeatBot(game, bot);
        return false;
    }
    game.broadcast(io, 'playerLazyMode', {
        position: pos,
        botUsername: bot.username,
        botPic: bot.pic,
        originalUsername: seat.ownerUsername
    });
    const line = {
        afk: `${seat.ownerUsername} was idle and ${bot.username} is playing for them. Type /active to return.`,
        leave: `${seat.ownerUsername} left the game. ${bot.username} is playing for them.`
    }[reason] || `${seat.ownerUsername} entered lazy mode. ${bot.username} is playing.`;
    logEntry(io, game, line);
    socketLogger.info('Player entered lazy mode', { gameId: game.gameId, position: pos, botUsername: bot.username, reason: reason || 'command' });
    // Not while a trick or hand resolves: the next updateTurn re-triggers it
    triggerIfOnTurn(io, game, pos);
    return true;
}

/** /active from the owner socket: the seat is human again. */
function goActive(io, game, pos, socket) {
    const released = game.seatGoActive(pos, socket.id);
    if (!released) return false;
    const { bot, ownerView } = released;
    const seat = game.seat(pos);
    // Cancels its pending bid/play and chat timers too
    botController.unregisterBot(game.gameId, bot.socketId);
    unmap(game, bot.socketId);
    gameManager.leaveSpectating(null, socket.id); // defensive: owners are never spectators

    // One room broadcast: the legacy pic (small inline image for a custom
    // one) for everyone, plus the additive avatarUrl capable clients prefer
    const r = avatarWire.seatResolve(game, seat.ownerPic, seat.ownerUsername);
    const activeMode = { position: pos, username: seat.ownerUsername, pic: r.legacy };
    if (r.url) activeMode.avatarUrl = r.url;
    game.broadcast(io, 'playerActiveMode', activeMode);
    logEntry(io, game, `${seat.ownerUsername} is back in control.`);
    socketLogger.info('Player returned to active mode', { gameId: game.gameId, position: pos, username: seat.ownerUsername });

    if (ownerView === 'watch') {
        // The watching client switches from its lazy view to the seat
        socket.emit('restorePlayerState', {
            ...stateFor(game, socket.id, socket),
            snapshot: snapshotFor(game, socket.id, { customPics: false }) // v2 (additive)
        });
        replayPresenceTo(game, socket, pos);
    } else if (game.acceptsTurnInput()) {
        // Only while a turn is open (the post-trick updateTurn follows otherwise)
        game.sendToPlayer(io, socket.id, 'updateTurn', { currentTurn: game.currentTurn });
    }
    // Back on its own turn: a fresh watchdog (no-op on anyone else's turn)
    if (game.currentTurn === pos) armAfk(io, game, pos);
    maybeAbort(io, game);
    return true;
}

// ==================== resign / leave ====================

/** forceResign of a resignable human seat: a bot takes it over. */
function resignSeat(io, game, pos) {
    const seat = game.seat(pos);
    const oldUsername = seat.ownerUsername;
    const bot = createSeatBot(game, pos, null);
    const oldSid = game.seatResign(pos, bot);
    if (oldSid == null) {
        discardSeatBot(game, bot);
        return false;
    }
    unmap(game, oldSid);
    game.broadcast(io, 'playerResigned', {
        position: pos,
        oldUsername,
        botUsername: bot.username,
        botPic: bot.pic
    });
    logEntry(io, game, `${oldUsername} has been resigned. ${bot.username} is taking over.`);
    reofferAfter(io, game, pos, 'resign');
    triggerIfOnTurn(io, game, pos);
    maybeAbort(io, game);
    return true;
}

/** /leave from the owner socket: the bot keeps the seat, the owner is gone for good. */
function leaveSeat(io, game, pos, socket) {
    const seat = game.seat(pos);
    if (seat.controller === Controller.HUMAN && !goLazy(io, game, pos, { reason: 'leave' })) return false;
    if (!game.seatLeave(pos)) return false;
    game.leaveRoom(io, socket.id);
    unmap(game, socket.id);
    // Lets them create / join new lobbies and tournaments
    gameManager.clearActiveGame(seat.ownerUsername, game.gameId);
    // leftGame only, from either view (the watch view's extra s2c
    // joinMainRoom had no listener: V1_REMOVALS #4)
    socket.emit('leftGame');
    socketLogger.info('Player left game (permanent)', { gameId: game.gameId, position: pos });
    maybeAbort(io, game);
    return true;
}

// ==================== draw watchdog ====================

/**
 * Armed when the draw opens (gameLifecycle.beginDraw): DRAW_WATCHDOG_MS
 * later every entrant that still has not drawn (an idle connected human, or
 * anyone whose own draw never happened) gets a random card, so DRAWING can
 * never wedge. Disconnected / departed entrants are auto-drawn at once
 * elsewhere and bots draw within a few seconds, so in practice this only
 * catches a connected human who did not tap for 30s. handleDrawComplete
 * clears it.
 */
function startDrawWatchdog(io, game) {
    game.setTimer('draw:watchdog', DRAW_WATCHDOG_MS, () => {
        if (game.stage !== Phase.DRAWING) return;
        const { autoDraw, handleDrawComplete } = require('./gameHandlers');
        for (const e of game.entrants ? Array.from(game.entrants.values()) : []) {
            if (game.drawIDs.includes(e.socketId)) continue;
            const name = e.isBot ? (botController.getBot(game.gameId, e.socketId)?.username || 'Bot') : (e.username || 'Player');
            const d = autoDraw(io, game, e.socketId, name);
            if (d && !e.isBot && e.presence === 'connected' && io.sockets.sockets.has(e.socketId)) {
                // Same payload the drawer's own draw() would have sent
                game.sendToPlayer(io, e.socketId, 'youDrew', { card: d.card, drawOrder: d.drawOrder });
            }
            socketLogger.info('Draw watchdog auto-drew', { gameId: game.gameId, socketId: e.socketId, presence: e.presence });
        }
        if (game.drawIndex === 4) {
            return handleDrawComplete(io, game);
        }
    });
}

module.exports = {
    RECONNECT_GRACE_MS,
    ABANDON_MS,
    DRAW_WATCHDOG_MS,
    AFK_TIMEOUT_MS,
    armAfk,
    clearAfk,
    pickBotPersonality,
    createSeatBot,
    reattachTournament,
    disconnectOwner,
    onGraceExpired,
    reconnectOwner,
    watchSeat,
    reclaimSeat,
    goLazy,
    goActive,
    resignSeat,
    leaveSeat,
    maybeAbort,
    reofferAfter,
    replayPresenceTo,
    startDrawWatchdog
};
