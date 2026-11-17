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
const pacing = require('../game/pacing');
const { socketLogger } = require('../utils/logger');
const { carrierFor, wireIsLazy } = require('./snapshotHandlers');
const avatarWire = require('../avatar/avatarWire');
const { randomStockPic } = require('../avatar/stockAvatars');
const gameVoice = require('../voice/gameVoice');

const { PERSONALITY_LIST, getDisplayName } = personalities;
const { Controller, Presence, RECONNECT_GRACE_MS, ABANDON_MS, SOLO_ABANDON_MS, DRAW_WATCHDOG_MS, AFK_TIMEOUT_MS, AFK_RESUME_MIN_MS } = SeatState;

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
    bot.pic = randomStockPic();
    botController.registerBot(game.gameId, bot);
    bot.resetCardMemory(game.currentHand, game.trump);
    bot.replayCardMemory(game.trump, game.trickHistory, openTrick(game));
    gameManager.playerGames.set(bot.socketId, game.gameId);
    return bot;
}

/**
 * The cards on the table in play order from the lead, as the bots were told
 * them (cardPlayed), or null. Through TRICK_RESOLVING the 4th card is still
 * here: resumeTrick moves the trick to trickHistory and advances the bots.
 */
function openTrick(game) {
    if (!game.playedCardsIndex || !game.leadPosition) return null;
    const cards = [];
    for (let k = 0; k < 4; k++) {
        const c = game.playedCards[((game.leadPosition - 1 + k) % 4)];
        if (!c) break;
        cards.push(c);
    }
    return { lead: game.leadPosition, cards };
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
    // Clients hold one offer: an idle-seat offer gives way to this one
    withdrawIdleOffer(io, game);
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
        // (offerIdle never runs while a resignable seat is offered)
        // Record the offer this socket now holds, so reofferAfter moves it
        // when p's owner comes back (or p is resigned). Not when the standing
        // offer is for the returner's own seat: reconnectOwner's
        // reofferAfter(ownPos) moves that one room-wide right after.
        if (game.offerPos !== ownPos) game.offerPos = p;
    } else if (game.idleOffer && game.idleOffer.pos !== ownPos) {
        sendIdleOffer(socket, game, game.idleOffer.pos);
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
 * abandonMs when no owner is connected. Ambient / native-bot tables (no
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
        const ms = abandonMs(game, owned);
        if (ms !== ABANDON_MS) socketLogger.info('Solo game: waiting for its players', { gameId: game.gameId, ms });
        game.setTimer('abandon', ms, () => {
            if (game.hasPresentHuman()) return;
            socketLogger.warn('All players disconnected, aborting game', { gameId: game.gameId });
            return abortGame(io, game, 'All players disconnected');
        });
    }
    return false;
}

/**
 * How long a table with nobody connected waits (decided when the wait
 * starts: while nobody is here no seat can leave for good, be resigned or
 * change controller). Owner, 2026-11-15: a casual game whose every owner
 * can still come back (one human + bots, or every human only away) waits
 * SOLO_ABANDON_MS, since nobody else is kept waiting; once an owner has
 * left for good, and at every tournament table (the round waits for it),
 * ABANDON_MS. Only while a human seat (grace / resignable) holds the
 * table: when every owner's seat is bot-played, the bots would finish an
 * unattended game in the owners' names, so 60 s as before.
 */
function abandonMs(game, owned) {
    if (gameManager.tournamentGames.has(game.gameId)) return ABANDON_MS;
    if (!owned.every(s => game.isReturnable(s.position))) return ABANDON_MS;
    return owned.some(s => s.controller === Controller.HUMAN) ? SOLO_ABANDON_MS : ABANDON_MS;
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
        // An idle offer for this seat is moot: grace and its own offer follow
        withdrawIdleOffer(io, game, pos);
        socketLogger.info('Player disconnected from game, waiting for reconnection', {
            username, position: pos, gameId: game.gameId, gracePeriod: RECONNECT_GRACE_MS / 1000
        });
        game.broadcast(io, 'playerDisconnected', { position: pos, username });
        game.broadcast(io, 'voicePeerLeft', { socketId: sid });
        logEntry(io, game, `${username} disconnected. Waiting for reconnection...`);
        // Who controls spectator talk (and so who may talk) can change
        gameVoice.refreshVoice(io, game);
    } else {
        const view = seat.ownerView;
        if (!game.seatDisconnect(pos, sid)) return;
        unmap(game, sid);
        game.leaveRoom(io, sid);
        socketLogger.info('Bot-controlled seat owner disconnected, bot continues playing', {
            username, position: pos, gameId: game.gameId, view
        });
        if (view === 'seat') {
            logEntry(io, game, `${username} disconnected. Bot continues playing.`);
            // A lazy owner at its seat was in the voice room: who controls
            // spectator talk (and so who may talk) can change
            gameVoice.refreshVoice(io, game);
        }
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
    // A voice spectator (casual game) drops its spectator-era calls both
    // ways first: as an owner it connects again from the owner's peer list
    // (a web client ignores a list entry it is "already connected" to)
    const watched = gameManager.games.get(gameManager.spectatorGames.get(sid));
    if (watched) gameVoice.removeVoiceSpectator(io, watched, sid, { bothWays: true });
    gameManager.leaveSpectating(io, sid);
}

/**
 * Voice for an owner back at its seat (`socket`, seat `pos`): the other
 * connected owners at their seats and, in a casual game, the voice
 * spectators (who always hear the players; a loaded block list leaves a
 * pair out) get voicePeerJoined, and the owner gets them all in
 * voicePeerList (it offers). Then every capable socket of the room gets
 * voiceSettings (the controller of spectator talk may have changed).
 */
function announceOwnerVoice(io, game, pos, socket, username) {
    const peers = [];
    for (const s of game.seatList()) {
        if (s.position === pos || s.presence !== Presence.CONNECTED) continue;
        if (s.controller !== Controller.HUMAN && s.ownerView !== 'seat') continue;
        peers.push({ socketId: s.ownerSocketId, username: game.getPlayerByPosition(s.position).username });
        io.to(s.ownerSocketId).emit('voicePeerJoined', { socketId: socket.id, username });
    }
    for (const [sid, e] of game.voiceSpectators || []) {
        if (sid === socket.id || gameVoice.blockedPair(io, socket.id, username, sid, e.username)) continue;
        peers.push({ socketId: sid, username: e.username });
        io.to(sid).emit('voicePeerJoined', { socketId: socket.id, username });
    }
    if (peers.length > 0) socket.emit('voicePeerList', { peers });
    gameVoice.refreshVoice(io, game);
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
    socket.emit('rejoinSuccess', carrierFor(game, socket, {
        isLazy: wireIsLazy(game, socket.id),
        tournamentId: tournament ? tournament.tournamentId : null
    }));
    // This playerReconnected takes any idle offer for the seat down too; the
    // still running watchdog makes it again if the seat stays idle
    if (game.idleOffer?.pos === pos) game.idleOffer = null;
    game.broadcast(io, 'playerReconnected', { position: pos, username });

    // Voice: the other connected owners at their seats (and the voice
    // spectators of a casual game)
    announceOwnerVoice(io, game, pos, socket, username);

    logEntry(io, game, `${username} reconnected.`);
    replayPresenceTo(game, socket, pos);
    reofferAfter(io, game, pos, 'reconnect');
    // Back from grace on its own turn: what is left of this turn's clock
    // (dropping cannot buy a fresh 90 s; a newer socket taking a connected
    // seat keeps the running one)
    if (game.currentTurn === pos) armAfk(io, game, pos, { keep: true, resume: true });
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
    const voiceBefore = new Set(gameVoice.gameVoiceMembers(game).map(m => m.socketId));
    const prev = game.seatWatch(pos, socket.id);
    const seat = game.seat(pos);
    if (seat?.ownerSocketId !== socket.id) return false;
    if (prev) {
        // The demoted socket (lazy at its seat: a voice member) leaves the
        // voice room: its calls end both ways (the newer socket watches and
        // holds no voice; nothing announced it)
        if (voiceBefore.has(prev)) {
            const peers = new Set(gameVoice.gameVoiceMembers(game).map(m => m.socketId));
            for (const sid of game.voiceSpectators?.keys() || []) peers.add(sid);
            peers.delete(prev);
            peers.delete(socket.id);
            for (const p of peers) {
                io.to(p).emit('voicePeerLeft', { socketId: prev });
                io.to(prev).emit('voicePeerLeft', { socketId: p });
            }
        }
        unmap(game, prev);
        // It was in the voice room: who controls spectator talk (and so
        // who may talk) can change
        if (voiceBefore.has(prev)) gameVoice.refreshVoice(io, game);
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

    // The seat's own view (the snapshot: role lazyWatcher, the hand) with the lazy flag
    const extra = { isLazy: true };
    if (via === 'rejoin') {
        const tournament = reattachTournament(io, socket, game.gameId, username);
        extra.tournamentId = tournament ? tournament.tournamentId : null;
    }
    const state = carrierFor(game, socket, extra);
    socketLogger.info('Owner watching bot-controlled seat', { username, gameId: game.gameId, position: pos, via });
    socket.emit('rejoinSuccess', state);
    if (via === 'rejoin') {
        game.broadcast(io, 'playerReconnected', { position: pos, username });
        logEntry(io, game, `${username} reconnected.`);
    }
    // via 'spectate': no spectatorJoined notice (V1_REMOVALS #8). The owner
    // watches their own seat; it is not a spectator (spectatorCount and the
    // spectator list never count it), so "<owner> joined as a spectator"
    // was wrong, and nothing else in the notice changed.
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
    if (!goActive(io, game, pos, socket, { voice: false })) return false;
    // At the seat again: the same voice peer list as a reconnect (it had
    // none: a reclaimed seat sat silent until the next reconnect)
    announceOwnerVoice(io, game, pos, socket, username);
    return true;
}

// ==================== turn watchdog (AFK) ====================

const afkKey = (pos) => `afk:${pos}`;

/** The seat whose turn it is can be watched: a connected human, turn open. */
function afkEligible(game, pos) {
    const seat = game.seat(pos);
    return !!seat && seat.controller === Controller.HUMAN && seat.presence === Presence.CONNECTED &&
        game.acceptsTurnInput() && game.currentTurn === pos && !afkExempt(game);
}

/**
 * A solo casual game (owner, 2026-11-13: "in a solo game (player plus 3
 * bots) the player shouldn't get booted to spectating after 90s"): the
 * watchdog only keeps other humans from waiting, and nobody waits there.
 * Solo = one human owner (pacing.humanOwnerCount: a lazy, resigned or
 * disconnected owner counts, a /leave'd one does not), read at every arm and
 * at firing, so a game that still has a second human keeps it. A tournament
 * table keeps it even with one human: the round waits for every table.
 */
function afkExempt(game) {
    return pacing.humanOwnerCount(game) <= 1 && !gameManager.tournamentGames.has(game.gameId);
}

/**
 * Arm the turn watchdog for `pos` (owner, 2026-11-11: 90 s, every game with
 * another human waiting; a solo casual game never arms it: afkExempt):
 * a connected human who neither bids nor plays within afkTimeoutMs() goes
 * lazy exactly as with /lazy (at a tournament table with another owner
 * present, the others are offered the seat instead: offerIdle).
 * Called where a human turn opens
 * (triggerBotIfNeeded's human branch), when a seat comes back to a human on
 * its turn (reconnect, /active) — never during grace or disconnect (the
 * grace timers own those; a presence change clears it, GameState
 * _applySeatEdge). Every other seat's watchdog is cleared: the turn moved.
 * Cleared too by the seat's own bid/play (clearAfk), /lazy and /active
 * (controller change) and abort/end (terminate cancels every game timer;
 * setTimer's epoch guard).
 * @param {{keep?: boolean, resume?: boolean}} [opts] keep: a watchdog
 *   already running for this same turn stays (a newer socket taking the
 *   seat does not restart the clock); resume: on the turn the clock was
 *   last started for, run only what is left of it (/active and a reconnect
 *   from grace, so neither /lazy then /active nor a drop buys a fresh
 *   90 s), topped up once per turn to AFK_RESUME_MIN_MS when it already
 *   ran out (a returning player can still act before it fires again)
 */
function armAfk(io, game, pos, { keep = false, resume = false } = {}) {
    for (let p = 1; p <= 4; p++) if (p !== pos) game.clearTimer(afkKey(p));
    const full = SeatState.afkTimeoutMs();
    if (!full || !afkEligible(game, pos)) {
        game.clearTimer(afkKey(pos));
        return false;
    }
    if (keep && game.hasTimer(afkKey(pos))) return true;
    const turn = game.turnKey();
    const now = Date.now();
    const clock = game.afkClock;
    let ms = full;
    if (resume && clock && clock.pos === pos && clock.turn === turn) {
        ms = clock.deadline - now;
        const floor = Math.min(AFK_RESUME_MIN_MS, full);
        if (ms < floor && !clock.toppedUp) {
            ms = floor;
            clock.deadline = now + floor;
            clock.toppedUp = true;
        }
        ms = Math.max(0, ms);
    } else {
        game.afkClock = { pos, turn, deadline: now + full };
    }
    return game.setTimer(afkKey(pos), ms, () => onAfk(io, game, pos, turn));
}

/** The seat acted (or its turn is otherwise over): stop its watchdog and take its idle offer down. */
function clearAfk(io, game, pos) {
    if (!pos) return;
    game.clearTimer(afkKey(pos));
    withdrawIdleOffer(io, game, pos);
}

/** The watchdog fired: still the same open turn of the same connected human? */
function onAfk(io, game, pos, turn) {
    if (!afkEligible(game, pos) || game.turnKey() !== turn) return false;
    // A tournament table (owner, 2026-11-15): no automatic takeover while
    // another owner is here to decide; with nobody to ask, as before
    if (gameManager.tournamentGames.has(game.gameId) && idleOfferHolders(game, pos).length > 0) {
        return offerIdle(io, game, pos, turn);
    }
    socketLogger.info('Turn timeout: bot takes over an idle seat', { gameId: game.gameId, position: pos, ms: SeatState.afkTimeoutMs() });
    return goLazy(io, game, pos, { reason: 'afk' });
}

// ==================== idle seat offer (tournament tables) ====================

/** The other seats' owners with a live socket here: who an idle offer goes to. */
function idleOfferHolders(game, pos) {
    return game.seatList()
        .filter(s => s.position !== pos && s.presence === Presence.CONNECTED)
        .map(s => s.ownerSocketId);
}

/**
 * The existing "Replace with Bot" offer, private (never the idle owner's
 * socket, never a spectator). `idle` (additive) lets the web say "seems
 * idle" instead of "did not reconnect"; iOS 1.2.0 ignores it.
 */
function sendIdleOffer(target, game, pos) {
    target.emit('resignationAvailable', { position: pos, username: game.seat(pos).ownerUsername, idle: true });
}

/**
 * The watchdog fired for a connected owner on their own turn at a
 * tournament table with another owner present: those owners get the
 * resign offer for the seat and any of them may forceResign it
 * (replaceIdleSeat). Asked again every afkTimeoutMs() while the seat stays
 * idle (a holder who pressed Wait, or whose resync dropped the offer, sees
 * it again; once nobody is left to ask, onAfk falls back to lazy). Clients
 * hold one offer, so a disconnected seat's standing offer goes first.
 */
function offerIdle(io, game, pos, turn) {
    const ms = SeatState.afkTimeoutMs();
    if (ms) game.setTimer(afkKey(pos), ms, () => onAfk(io, game, pos, turn));
    if (game.offerPos != null && game.resignablePositions().includes(game.offerPos)) return false;
    const first = !(game.idleOffer && game.idleOffer.pos === pos && game.idleOffer.turn === turn);
    game.idleOffer = { pos, turn };
    const holders = idleOfferHolders(game, pos);
    for (const sid of holders) sendIdleOffer(io.to(sid), game, pos);
    if (first) {
        const name = game.seat(pos).ownerUsername;
        socketLogger.info('Turn timeout at a tournament table: offering the idle seat', {
            gameId: game.gameId, position: pos, holders: holders.length, ms
        });
        logEntry(io, game, `${name} seems idle. You may replace them with a bot.`);
    }
    return true;
}

/** forceResign may take this seat: its idle offer stands for this very turn. */
function idleOfferStands(game, pos) {
    const o = game.idleOffer;
    return !!o && o.pos === pos && afkEligible(game, pos) && game.turnKey() === o.turn;
}

/**
 * Take an idle offer down (the owner acted, dropped, went lazy or left, or
 * a disconnected seat's offer replaces it): one room playerReconnected for
 * the seat, which both clients already handle with no line of their own
 * (web dismissResignationDialog(pos); iOS 1.2.0 the seat back to connected,
 * its offer cleared). A no-op unless an idle offer stands (for `pos`).
 */
function withdrawIdleOffer(io, game, pos = null) {
    const o = game.idleOffer;
    if (!o || (pos != null && o.pos !== pos)) return false;
    game.idleOffer = null;
    game.broadcast(io, 'playerReconnected', { position: o.pos, username: game.seat(o.pos).ownerUsername });
    return true;
}

/**
 * Another present owner confirmed the idle offer: a bot plays the seat as
 * after an AFK takeover (the /lazy transition, so the owner, still here,
 * watches and may /active back; credited like /lazy).
 */
function replaceIdleSeat(io, game, pos) {
    return goLazy(io, game, pos, { reason: 'replaced' });
}

// ==================== lazy / active ====================

/**
 * /lazy: a bot plays the owner's (human, connected) seat.
 * @param {{reason?: 'afk'|'leave'|'replaced'}} [opts] 'afk': the turn watchdog fired;
 *   'replaced': another owner confirmed an idle offer (replaceIdleSeat);
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
    // Before playerLazyMode: iOS 1.2.0 keeps an offer through it
    withdrawIdleOffer(io, game, pos);
    game.broadcast(io, 'playerLazyMode', {
        position: pos,
        botUsername: bot.username,
        botPic: bot.pic,
        originalUsername: seat.ownerUsername
    });
    const line = {
        afk: `${seat.ownerUsername} was idle and ${bot.username} is playing for them. Type /active to return.`,
        replaced: `${seat.ownerUsername} was idle and has been replaced. ${bot.username} is playing for them. Type /active to return.`,
        leave: `${seat.ownerUsername} left the game. ${bot.username} is playing for them.`
    }[reason] || `${seat.ownerUsername} entered lazy mode. ${bot.username} is playing.`;
    logEntry(io, game, line);
    socketLogger.info('Player entered lazy mode', { gameId: game.gameId, position: pos, botUsername: bot.username, reason: reason || 'command' });
    // Not while a trick or hand resolves: the next updateTurn re-triggers it
    triggerIfOnTurn(io, game, pos);
    return true;
}

/** /active from the owner socket: the seat is human again. */
function goActive(io, game, pos, socket, { voice = true } = {}) {
    const released = game.seatGoActive(pos, socket.id);
    if (!released) return false;
    const { bot, ownerView } = released;
    const seat = game.seat(pos);
    // Cancels its pending bid/play and chat timers too
    botController.unregisterBot(game.gameId, bot.socketId);
    unmap(game, bot.socketId);
    gameManager.leaveSpectating(null, socket.id); // defensive: owners are never spectators

    // One room broadcast: a stock number or null (V1_REMOVALS #19: no
    // inline picture), plus the additive avatarUrl of a custom picture
    const r = avatarWire.seatResolve(game, seat.ownerPic, seat.ownerUsername);
    const activeMode = { position: pos, username: seat.ownerUsername, pic: avatarWire.slot(seat.ownerPic) };
    if (r.url) activeMode.avatarUrl = r.url;
    game.broadcast(io, 'playerActiveMode', activeMode);
    logEntry(io, game, `${seat.ownerUsername} is back in control.`);
    socketLogger.info('Player returned to active mode', { gameId: game.gameId, position: pos, username: seat.ownerUsername });

    if (ownerView === 'watch') {
        // The watching client switches from its lazy view to the seat
        socket.emit('restorePlayerState', carrierFor(game, socket));
        replayPresenceTo(game, socket, pos);
        // At the seat again, so in the voice room: who controls spectator
        // talk can change (reclaimSeat passes voice false: its
        // announceOwnerVoice refreshes)
        if (voice) gameVoice.refreshVoice(io, game);
    } else if (game.acceptsTurnInput()) {
        // Only while a turn is open (the post-trick updateTurn follows otherwise)
        game.sendToPlayer(io, socket.id, 'updateTurn', { currentTurn: game.currentTurn });
    }
    // Back on its own turn: what is left of this turn's clock (no-op on
    // anyone else's turn)
    if (game.currentTurn === pos) armAfk(io, game, pos, { resume: true });
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

/**
 * /leave from the owner socket: the bot keeps the seat, the owner is gone
 * for good. `notify` false skips the leftGame (leaveTournament late in
 * DRAW_RESOLVING: tournamentLeft follows).
 */
function leaveSeat(io, game, pos, socket, { notify = true } = {}) {
    const seat = game.seat(pos);
    if (seat.controller === Controller.HUMAN && !goLazy(io, game, pos, { reason: 'leave' })) return false;
    if (!game.seatLeave(pos)) return false;
    game.leaveRoom(io, socket.id);
    unmap(game, socket.id);
    // Out of the voice room for good: who controls spectator talk (and so
    // whether a main-room spectator may still talk) can change; a spectator
    // that just lost the right arms the backstop
    gameVoice.refreshVoice(io, game);
    // Lets them create / join new lobbies and tournaments
    gameManager.clearActiveGame(seat.ownerUsername, game.gameId);
    // leftGame only, from either view (the watch view's extra s2c
    // joinMainRoom had no listener: V1_REMOVALS #4)
    if (notify) socket.emit('leftGame');
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
    SOLO_ABANDON_MS,
    DRAW_WATCHDOG_MS,
    AFK_TIMEOUT_MS,
    armAfk,
    clearAfk,
    idleOfferStands,
    replaceIdleSeat,
    withdrawIdleOffer,
    pickBotPersonality,
    createSeatBot,
    openTrick,
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
