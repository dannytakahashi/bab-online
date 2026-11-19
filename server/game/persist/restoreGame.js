/**
 * A restored table inside the game (deploy survival PR 5, LIVE_PERSIST=on;
 * the plan's 2.5 steps 5-9 with the owner answers of 2026-11-16). The
 * persist store (liveStore: the adoption sweep, its users lookup, the CAS)
 * hands a live game doc to adoptGame; everything after that is here:
 *
 *   adoptGame(io, doc, opts)
 *       gameCodec.hydrate, then register the game (GameManager.games and
 *       tournamentGames), recreate its bots under their saved socket ids
 *       (position, pic, partnerHistory; card memory replayed from
 *       trickHistory and the open trick, as a seat bot made now would have
 *       it), map them in playerGames, warm the owners' custom pictures,
 *       add the one log line RESUMED_LINE (stored and broadcast as any
 *       system line), close the GATE and arm the restored abandon. It never
 *       touches Mongo: the store passes what its users lookup found
 *       (ownerPics, scrubFrom).
 *
 *   The gate (isGated). Until it opens nothing runs by itself: no bot
 *       action (gameHandlers.triggerBotIfNeeded only clears the watchdogs),
 *       no AFK clock (seatLifecycle.afkEligible), no progress watchdog
 *       (progressWatchdog.watched), no bid clock (bidClock.eligible), and
 *       no hold: a TRICK_RESOLVING / HAND_RESOLVING table keeps `resume`
 *       null (snapshot resume.inMs null) instead of counting down to
 *       nothing, and is never aborted as stalled. Only the reconnect grace
 *       timers hydrate armed and the restored abandon run. A returned human
 *       may still act on their own open turn (the next bot waits).
 *
 *   openGateIfReady(io, game)
 *       From every seat return path (seatLifecycle reconnectOwner,
 *       watchSeat, reclaimSeat, onGraceExpired). Owner rule (2026-11-16,
 *       answer c): bots wait for ALL the humans seated before the deploy.
 *       The gate opens once an owner is present at the table (connected:
 *       at the seat or watching a bot-played one) and no restored human
 *       seat is still waiting (human, in its first reconnect grace, never
 *       back since the restore: its seat socket is still the synthetic
 *       restored:<gameId>:<pos>). A human who does not come back within the
 *       normal grace is no longer waited for: onGraceExpired makes the usual
 *       Replace-with-Bot offer to whoever is here, then the gate opens, so
 *       nobody is stuck. Opening runs the restore KICK (kick below) BEFORE
 *       the caller builds its reconnect carrier, so the snapshot's seq
 *       counts the kick's events and its resume.inMs is the fresh hold.
 *       The first owner back (gate open or not) also cancels the restored
 *       abandon; from then on the table follows the normal presence rules
 *       (seatLifecycle.maybeAbort).
 *
 *   kick(io, game)
 *       TRICK_RESOLVING / HAND_RESOLVING schedule their hold again
 *       (TRICK_VIEW_MS, then resumeTrick; HAND_END_MS or GAME_END_MS, then
 *       handleHandComplete) and arm the progress watchdog; BIDDING /
 *       PLAYING broadcast updateTurn and run gameHandlers.triggerBotIfNeeded,
 *       whose first step is bidClock.onTurn: a restored human bidder gets a
 *       fresh bid clock (T0 = the kick; the clock is DERIVED, gameCodec), a
 *       human on turn a fresh AFK clock, a bot its action. A hold already
 *       open (one a returned human started while the gate was closed) is
 *       left to its own continuation. testUtils/restoreKit.kickRestored is
 *       this.
 *
 *   The restored abandon ('restoreAbandon' game timer, opts.abandonMs:
 *       RESTORE_ABANDON_MS, 10 min, for a casual table; PR 6 passes
 *       RESTORE_ABANDON_TOURNAMENT_MS, 5 min, owner answer b). A restored
 *       table nobody comes back to is aborted ('All players disconnected':
 *       gameLifecycle.abortGame, so pointers are cleared and no stats or
 *       gameRecords are written) when it fires. While it is armed
 *       seatLifecycle.maybeAbort does not start its own abandon window, so
 *       a grace that runs out with nobody here never aborts sooner.
 *
 * Nothing here runs for a game that was not adopted: every hook elsewhere
 * is `isGated(game)` / `game.restored` (DERIVED, gameCodec), false or
 * undefined for every other game, so LIVE_PERSIST off and write are
 * unchanged.
 *
 * Server modules are required lazily: seatLifecycle, gameHandlers,
 * progressWatchdog and bidClock require this module for isGated.
 */

'use strict';

const { Phase } = require('../GamePhase');
const { Controller, Presence } = require('../SeatState');
const { gameLogger } = require('../../utils/logger');

/** The adoption's game-log line (owner answer a, 2026-11-16). */
const RESUMED_LINE = 'This game resumed after a server update.';
const ABANDON_KEY = 'restoreAbandon';
/** A restored casual table nobody returns to (decision 4). */
const RESTORE_ABANDON_MS = 10 * 60000;
/** A restored tournament table (owner answer b; PR 6 passes it as abandonMs). */
const RESTORE_ABANDON_TOURNAMENT_MS = 5 * 60000;
const ABANDON_REASON = 'All players disconnected';

const restoredPrefix = (game) => `restored:${game.gameId}:`;
const isBotName = (name) => require('../../socket/safetyHandlers').isBotName(name);

/** True while the restored table waits for its humans (nothing runs by itself). */
function isGated(game) {
    return !!game && !!game.restored && game.restored.gated === true;
}

/**
 * The positions of restored human seats still waited for: human, in grace,
 * never back since the restore (the seat socket is still the synthetic one).
 * @returns {number[]}
 */
function waitingFor(game) {
    if (!game?.restored) return [];
    const prefix = restoredPrefix(game);
    return game.seatList()
        .filter((s) => s.controller === Controller.HUMAN && s.presence === Presence.GRACE &&
            typeof s.seatSocketId === 'string' && s.seatSocketId.startsWith(prefix))
        .map((s) => s.position);
}

/**
 * The restored abandon is still the table's only abandon window (no owner
 * back yet): seatLifecycle.maybeAbort starts no window of its own.
 */
function holdsAbandon(game) {
    return !!game?.restored && !game.restored.ownerBack && game.hasTimer(ABANDON_KEY);
}

/**
 * The account names the adopter must look up for `doc` (seat owners, then
 * chat senders), never a bot persona (isBotName: a bot quip's `from` is
 * '🤖 …', never in users) and never twice.
 * @returns {string[]}
 */
function lookupNames(doc) {
    const out = new Set();
    for (const s of Object.values(doc?.state?.seats || {})) {
        if (s && typeof s.ownerUsername === 'string' && !isBotName(s.ownerUsername)) out.add(s.ownerUsername);
    }
    for (const e of Array.isArray(doc?.log) ? doc.log : []) {
        if (e && e.type === 'chat' && typeof e.from === 'string' && !isBotName(e.from)) out.add(e.from);
    }
    return Array.from(out);
}

const isCustomPic = (p) => typeof p === 'string' && p.startsWith('data:image');

/** `doc` with the owners' current custom pictures where it saved none. */
function withOwnerPics(doc, ownerPics) {
    const seats = doc?.state?.seats;
    if (!seats || !ownerPics) return doc;
    let changed = false;
    const next = {};
    for (const [pos, s] of Object.entries(seats)) {
        const pic = s && s.ownerUsername != null && s.ownerPic == null ? ownerPics[s.ownerUsername] : undefined;
        if (isCustomPic(pic) || Number.isInteger(pic)) {
            next[pos] = { ...s, ownerPic: pic };
            changed = true;
        } else {
            next[pos] = s;
        }
    }
    return changed ? { ...doc, state: { ...doc.state, seats: next } } : doc;
}

/** Start deriving the owners' custom pictures; the versions avatarWire maps at emit time. */
function warmAvatars(game) {
    const avatarStore = require('../../avatar/avatarStore');
    game.avatarVersions = new Map();
    if (!avatarStore.available()) return;
    for (const s of game.seatList()) {
        if (!s.ownerUsername || !isCustomPic(s.ownerPic)) continue;
        avatarStore.warm(s.ownerUsername, s.ownerPic);
        game.avatarVersions.set(s.ownerUsername, avatarStore.versionOf(s.ownerPic));
    }
}

/**
 * Adopt a live game doc in this process (the store's CAS already made it
 * ours). Throws (a gameCodec CodecError, or 'already live') and registers
 * nothing when the doc does not restore: the caller discards it.
 * @param {Object} io
 * @param {Object} doc - a gameCodec document
 * @param {Object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.abandonMs=RESTORE_ABANDON_MS] - the restored abandon
 *   (RESTORE_ABANDON_TOURNAMENT_MS for a tournament table, PR 6)
 * @param {Object} [opts.ownerPics] - {username: picture} from the adopter's
 *   users lookup: an owner's custom picture (the doc saves stock ones only)
 * @param {string[]} [opts.scrubFrom] - deleted senders whose chat lines go
 *   (never a bot persona's)
 * @returns {GameState}
 */
function adoptGame(io, doc, { now = Date.now(), abandonMs = RESTORE_ABANDON_MS, ownerPics = null, scrubFrom = null,
    gameManager = require('../GameManager'), botController = require('../bot').botController } = {}) {
    if (doc && typeof doc.gameId === 'string' && gameManager.games.has(doc.gameId)) {
        throw new Error(`adoptGame: ${doc.gameId} is already live here`);
    }
    const { hydrate } = require('./gameCodec');
    const seatLifecycle = require('../../socket/seatLifecycle');
    const { openTrick } = require('../tableView');
    const { game, bots, tournamentId } = hydrate(withOwnerPics(doc, ownerPics), {
        now,
        onGraceExpire: (g, pos) => seatLifecycle.onGraceExpired(io, g, pos)
    });
    // The gate first: nothing below may start a turn
    game.restored = { at: now, gated: true, ownerBack: false, abandonMs, openedAt: null };
    gameManager.games.set(game.gameId, game);
    if (tournamentId) gameManager.tournamentGames.set(game.gameId, tournamentId);
    for (const b of bots) {
        const bot = botController.createBot(b.username, b.personality);
        bot.socketId = b.socketId;
        bot.position = b.position;
        bot.pic = b.pic;
        bot.partnerHistory = (b.partnerHistory || []).map((h) => ({ ...h }));
        botController.registerBot(game.gameId, bot);
        bot.resetCardMemory(game.currentHand, game.trump);
        bot.replayCardMemory(game.trump, game.trickHistory, openTrick(game));
        gameManager.playerGames.set(bot.socketId, game.gameId);
    }
    for (const name of scrubFrom || []) {
        if (typeof name === 'string' && !isBotName(name)) game.scrubChatFrom(name);
    }
    warmAvatars(game);
    game.addLogEntry(RESUMED_LINE, null, 'system');
    game.broadcast(io, 'gameLogEntry', { message: RESUMED_LINE, type: 'system' });
    game.setTimer(ABANDON_KEY, abandonMs, () => onRestoreAbandon(io, game));
    gameLogger.info('Game adopted', { gameId: game.gameId, stage: game.stage, tournamentId, abandonMs });
    require('../../socket/gameLifecycle').emitLobbiesUpdated(io);
    return game;
}

/** 'restoreAbandon' fired: nobody came back since the restore. */
function onRestoreAbandon(io, game) {
    const r = game.restored;
    if (!r || r.ownerBack || game.isTerminal()) return false;
    if (game.hasPresentHuman()) {
        r.ownerBack = true;
        return false;
    }
    gameLogger.warn('Restored game: nobody came back, aborting', { gameId: game.gameId, ms: r.abandonMs });
    return require('../../socket/gameLifecycle').abortGame(io, game, ABANDON_REASON);
}

/**
 * A seat's owner came back, or a restored seat's grace ran out: the first
 * owner back cancels the restored abandon, and the gate opens (running the
 * kick) once an owner is here and no restored human is still waited for.
 * The callers that send a reconnect carrier call this before building it.
 * @returns {boolean} true if the gate opened now
 */
function openGateIfReady(io, game) {
    const r = game?.restored;
    if (!r || game.isTerminal() || game.frozen) return false;
    // The holder self-fence: decided once the game thaws
    if (game.isSuspended) {
        game.deferWhileSuspended(() => openGateIfReady(io, game));
        return false;
    }
    const present = game.hasPresentHuman();
    if (present && !r.ownerBack) {
        r.ownerBack = true;
        game.clearTimer(ABANDON_KEY);
    }
    if (!r.gated || !present) return false;
    const waiting = waitingFor(game);
    if (waiting.length > 0) {
        gameLogger.info('Restored game: waiting for its players', { gameId: game.gameId, waiting });
        return false;
    }
    r.gated = false;
    r.openedAt = Date.now();
    gameLogger.info('Restored game: everyone is back, resuming', { gameId: game.gameId, stage: game.stage });
    kick(io, game);
    return true;
}

/**
 * The restore kick: start what the restore left unarmed (see the header).
 * @returns {boolean} false when there was nothing to start
 */
function kick(io, game) {
    if (!game || game.isTerminal() || game.frozen) return false;
    const gameHandlers = require('../../socket/gameHandlers');
    const progressWatchdog = require('../../socket/progressWatchdog');
    const pacing = require('../pacing');
    if (game.stage === Phase.TRICK_RESOLVING) {
        if (!game.hasTimer('resume')) {
            game.scheduleResume('trick', pacing(game).TRICK_VIEW_MS, () => gameHandlers.resumeTrick(io, game), 'trickView');
        }
        progressWatchdog.arm(io, game);
        return true;
    }
    if (game.stage === Phase.HAND_RESOLVING) {
        if (!game.hasTimer('resume')) {
            const lastHand = game.currentHand === 13;
            const ms = lastHand ? pacing(game).GAME_END_MS : pacing(game).HAND_END_MS;
            game.scheduleResume('hand', ms, () => gameHandlers.handleHandComplete(game, io), lastHand ? 'gameEnd' : 'handEnd');
        }
        progressWatchdog.arm(io, game);
        return true;
    }
    const actionType = game.actionTypeForTurn();
    if (!actionType) return false;
    // An open hold (the first hand's firstTurn) sends the turn when it ends
    if (game.resume) return false;
    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });
    gameHandlers.triggerBotIfNeeded(io, game, actionType);
    return true;
}

module.exports = {
    RESUMED_LINE,
    ABANDON_KEY,
    ABANDON_REASON,
    RESTORE_ABANDON_MS,
    RESTORE_ABANDON_TOURNAMENT_MS,
    adoptGame,
    isGated,
    openGateIfReady,
    kick,
    waitingFor,
    holdsAbandon,
    lookupNames
};
