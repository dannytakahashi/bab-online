/**
 * Per-game progress watchdog ('stall' game timer).
 *
 * A bot's turn or a resolving stage must always move on by itself: a bot
 * action that throws past its fallback, a lost bot timer or a continuation
 * that failed half-way would otherwise leave the table waiting until every
 * human leaves (a tournament round waits with it). Armed on every bot turn
 * (gameHandlers.triggerBotIfNeeded) and when a resolving stage opens
 * (DRAW_RESOLVING, TRICK_RESOLVING, HAND_RESOLVING); a human's turn clears
 * it, so a slow human is never touched here (the AFK watchdog owns that).
 *
 * No progress (same game.turnKey()) for STALL_MS: a bot turn is retried once
 * (its action is scheduled again); a resolving stage is not, since its
 * continuation may have half-run. Still no progress STALL_RETRY_MS later:
 * the game is aborted ('Game stalled'), which reports a tournament table as
 * an aborted game (no scores, the round can finish).
 *
 * The timeouts are not presentation delays and do not follow BAB_PACING:
 * every legitimate wait of every profile is a few seconds at most. Tests
 * inject shorter ones through GAME_STALL_MS / GAME_STALL_RETRY_MS (read at
 * every arm; 0 disables the watchdog).
 */

const SeatState = require('../game/SeatState');
const { Phase } = require('../game/GamePhase');
const { gameLogger } = require('../utils/logger');

const KEY = 'stall';
const STALL_MS = 90000;
const STALL_RETRY_MS = 30000;
const ABORT_REASON = 'Game stalled';

// Stages that only the server moves on (holds, deal, trick/hand resolution)
const RESOLVING = new Set([
    Phase.DRAW_RESOLVING, Phase.TEAMS_ANNOUNCED, Phase.DEALING, Phase.REDEAL,
    Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING
]);

function envMs(raw, fallback) {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function timeouts(env = process.env) {
    return {
        stallMs: envMs(env.GAME_STALL_MS, STALL_MS),
        retryMs: envMs(env.GAME_STALL_RETRY_MS, STALL_RETRY_MS)
    };
}

/** 'bot' | 'resolving' while the game must progress without a human, else null. */
function watched(game) {
    if (game.isTerminal()) return null;
    if (RESOLVING.has(game.stage)) return 'resolving';
    if (game.acceptsTurnInput()) {
        const seat = game.seat(game.currentTurn);
        if (seat && seat.controller !== SeatState.Controller.HUMAN) return 'bot';
    }
    return null;
}

function logMeta(game, kind, extra = {}) {
    const seat = game.seat(game.currentTurn);
    return {
        gameId: game.gameId, kind, stage: game.stage, position: game.currentTurn,
        controller: seat ? seat.controller : null, turnKey: game.turnKey(), ...extra
    };
}

/** (Re)start the watch for the game's current state; a human turn clears it. */
function arm(io, game) {
    const { stallMs } = timeouts();
    if (!stallMs || !watched(game)) {
        game.clearTimer(KEY);
        return false;
    }
    const key = game.turnKey();
    return game.setTimer(KEY, stallMs, () => onStall(io, game, key));
}

function disarm(game) {
    game.clearTimer(KEY);
}

function onStall(io, game, key) {
    const kind = watched(game);
    if (!kind) return false;
    // Moved on without passing an arm point (e.g. stuck in DEALING after a
    // hand resolved): watch the new state from now
    if (game.turnKey() !== key) return arm(io, game);
    const { retryMs } = timeouts();
    gameLogger.error('Game stalled', logMeta(game, kind, { retry: kind === 'bot', abortInMs: retryMs }));
    if (kind === 'bot') {
        // Schedules the seat's bot action again (and re-arms the full watch,
        // replaced right below by the shorter retry watch)
        const { triggerBotIfNeeded } = require('./gameHandlers');
        triggerBotIfNeeded(io, game, game.actionTypeForTurn());
    }
    if (game.isTerminal() || game.turnKey() !== key) return true;
    return game.setTimer(KEY, retryMs, () => onStillStalled(io, game, key));
}

function onStillStalled(io, game, key) {
    const kind = watched(game);
    if (!kind) return false;
    if (game.turnKey() !== key) return arm(io, game);
    gameLogger.error('Game stalled, aborting', logMeta(game, kind));
    const { abortGame } = require('./gameLifecycle');
    return abortGame(io, game, ABORT_REASON);
}

module.exports = {
    KEY,
    STALL_MS,
    STALL_RETRY_MS,
    ABORT_REASON,
    timeouts,
    watched,
    arm,
    disarm
};
