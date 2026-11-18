/**
 * Test kit for the deploy-survival codec tests (server/game/persist/__tests__):
 *
 *   watchSafePoints(onSafePoint, {onChange})
 *       The persist store's hooks (plan 2.3): GameState.nextSeq,
 *       _applyTransition and _afterSeat mark the game dirty, and the store
 *       serializes once the synchronous run that changed it is over. Here
 *       `onSafePoint(game)` runs in a microtask queued at the first change
 *       of a run (one per game per run), the earliest point the store's
 *       setImmediate could see; `onChange(game, what)` runs synchronously
 *       at every change (a stage only a run passes through, like DEALING,
 *       is visible only there). stop() puts the methods back.
 *
 *   adoptForTest(doc, {io, gameManager, botController})
 *       What the real adoption (PR 5) will do with a game doc, minus the
 *       store and the gate: hydrate, register the game (games,
 *       tournamentGames), recreate its bots under their saved socket ids
 *       (position, pic, partnerHistory; card memory replayed from
 *       trickHistory and the open trick), map them.
 *
 *   kickRestored(io, game)
 *       The restore kick (plan 2.5 step 8): TRICK_RESOLVING and
 *       HAND_RESOLVING re-schedule their hold, BIDDING / PLAYING broadcast
 *       updateTurn and trigger the seat on turn.
 *
 * Server modules are required lazily (tests mock ../database first).
 */

'use strict';

/**
 * @param {Function} onSafePoint - (game) => void, after the run that changed it
 * @param {{onChange?: Function}} [opts] - (game, what) => void, synchronously
 * @returns {{stop: Function}}
 */
function watchSafePoints(onSafePoint, { onChange = null } = {}) {
    const GameState = require('../game/GameState');
    const proto = GameState.prototype;
    const queued = new WeakSet();
    const mark = (game, what) => {
        if (onChange) onChange(game, what);
        if (queued.has(game)) return;
        queued.add(game);
        Promise.resolve().then(() => {
            queued.delete(game);
            onSafePoint(game);
        });
    };
    const originals = {
        nextSeq: proto.nextSeq,
        _applyTransition: proto._applyTransition,
        _afterSeat: proto._afterSeat
    };
    proto.nextSeq = function (...args) {
        const r = originals.nextSeq.apply(this, args);
        mark(this, 'seq');
        return r;
    };
    proto._applyTransition = function (...args) {
        const r = originals._applyTransition.apply(this, args);
        if (r) mark(this, 'stage');
        return r;
    };
    proto._afterSeat = function (...args) {
        const r = originals._afterSeat.apply(this, args);
        mark(this, 'seat');
        return r;
    };
    return {
        stop() {
            Object.assign(proto, originals);
        }
    };
}

/**
 * @param {Object} doc - a gameCodec document (JSON round-tripped)
 * @param {{io?: Object, gameManager?: Object, botController?: Object, now?: number}} [opts]
 * @returns {GameState}
 */
function adoptForTest(doc, { io = null, gameManager = require('../game/GameManager'),
    botController = require('../game/bot').botController, now } = {}) {
    const { hydrate } = require('../game/persist/gameCodec');
    const seatLifecycle = require('../socket/seatLifecycle');
    const { openTrick } = require('../game/tableView');
    const { game, bots, tournamentId } = hydrate(doc, {
        now,
        onGraceExpire: io ? (g, pos) => seatLifecycle.onGraceExpired(io, g, pos) : null
    });
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
    return game;
}

/** The restore kick for an adopted game whose first owner is back. */
function kickRestored(io, game) {
    const { Phase } = require('../game/GamePhase');
    const gameHandlers = require('../socket/gameHandlers');
    const progressWatchdog = require('../socket/progressWatchdog');
    const pacing = require('../game/pacing');
    if (game.stage === Phase.TRICK_RESOLVING) {
        game.scheduleResume('trick', pacing(game).TRICK_VIEW_MS, () => gameHandlers.resumeTrick(io, game), 'trickView');
        progressWatchdog.arm(io, game);
        return;
    }
    if (game.stage === Phase.HAND_RESOLVING) {
        const lastHand = game.currentHand === 13;
        const ms = lastHand ? pacing(game).GAME_END_MS : pacing(game).HAND_END_MS;
        game.scheduleResume('hand', ms, () => gameHandlers.handleHandComplete(game, io), lastHand ? 'gameEnd' : 'handEnd');
        progressWatchdog.arm(io, game);
        return;
    }
    const actionType = game.actionTypeForTurn();
    if (!actionType) return;
    game.broadcast(io, 'updateTurn', { currentTurn: game.currentTurn });
    gameHandlers.triggerBotIfNeeded(io, game, actionType);
}

module.exports = { watchSafePoints, adoptForTest, kickRestored };
