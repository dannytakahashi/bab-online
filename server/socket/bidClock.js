/**
 * The bid clock (owner, 2026-11-18: "thinking music"; every game, casual and
 * tournament). A human-controlled seat whose bid turn has been open
 * BID_CLOCK_DELAY_MS (10 s) without a bid gets a BID_CLOCK_MS (30 s) clock:
 * the room gets `bidClock {running: true, inMs, durationMs}` (UNSEQUENCED,
 * GameState.emitUnsequenced) and the clients play the tune (bidclock.m4a,
 * exactly that long) and show the bidder a countdown. When it runs out the
 * server bids '0' for the seat through gameHandlers.placeBid, the path a
 * human bid takes (applyBid, clearAfk, the log line, bidReceived, the turn
 * advance, the redeal / doneBidding), after the room line
 * "<name> ran out of time.". Any bid, a controller change (a bot takes the
 * seat) or a turn change stops it with `bidClock {running: false, reason}`.
 *
 * Rules (server/CLAUDE.md "Bid clock"):
 * - Only a HUMAN controller on its own open bid turn; presence is NOT
 *   checked (a disconnected bidder's clock keeps running: a dropped player
 *   must not hold the table longer than an idle one, and grace (60 s) is
 *   longer than the whole clock).
 * - One record per game (`game.bidClock`, DERIVED: never saved) and one
 *   timer key ('bidClock', for both the pre-wait and the clock). The record
 *   is keyed by game.turnKey(): a same-turn return to human control
 *   (/active, reclaimSeat) resumes it (what is left, topped up once per turn
 *   to BID_CLOCK_RESUME_MIN_MS), a new turn arms a fresh one.
 * - Timers only through game.setTimer (cancelled by terminate / freeze;
 *   nothing is emitted after end or abort); every firing re-checks the turn,
 *   so a stale firing is a no-op (and stops an announced clock).
 * - Strike rule (critic C1): BID_TIMEOUT_AFK_STRIKES timeouts in a row
 *   count as idle, since the clock always bids before the AFK watchdog
 *   (90 s) could fire at bidding. A casual game runs the AFK takeover right
 *   after the bid lands (goLazy 'afk'); a tournament table with another
 *   owner present offers the seat (offerIdle) when its next clock starts.
 *   Never in a solo casual game (afkExempt), never for a disconnected seat
 *   (grace / resign own it), never with AFK disabled (AFK_TIMEOUT_MS=0).
 *
 * Bots never arm it and the clock draws no RNG (only the strike rule's
 * takeover picks a bot persona, as AFK does), so bot-only games, sims and
 * seeded recordings whose humans act at once are unchanged.
 */

'use strict';

const SeatState = require('../game/SeatState');
const { Phase } = require('../game/GamePhase');
const { gameLogger } = require('../utils/logger');
const restoreGame = require('../game/persist/restoreGame');

const { Controller, Presence } = SeatState;
const KEY = 'bidClock';

/** May the seat on turn have a bid clock right now? */
function eligible(game) {
    if (!SeatState.bidClockEnabled()) return false;
    if (game.stage !== Phase.BIDDING || game.isTerminal?.() || game.frozen) return false;
    // A restored table's gate (persist/restoreGame.js): the kick arms a fresh one
    if (restoreGame.isGated(game)) return false;
    // The first hand's deal reveal: the turn opens (T0) when the hold ends
    if (game.resume && game.resume.kind === 'firstTurn') return false;
    const pos = game.currentTurn;
    const seat = game.seat(pos);
    return !!seat && seat.controller === Controller.HUMAN && game.playerBids[pos - 1] == null;
}

function runningPayload(game, rec, inMs) {
    return { gameId: game.gameId, position: rec.pos, running: true, inMs: Math.max(0, Math.round(inMs)), durationMs: rec.durationMs };
}

/**
 * A turn opened, or the controller of the seat on turn changed: arm, keep,
 * resume or stop the clock. Called first thing in triggerBotIfNeeded (every
 * turn of every stage, so the end of bidding stops it too) and from goActive
 * when the seat comes back on its own turn.
 */
function onTurn(io, game) {
    const rec = game.bidClock;
    const pos = game.currentTurn;
    const turn = game.turnKey();
    const same = !!rec && rec.pos === pos && rec.turn === turn;
    if (!eligible(game)) {
        const seat = game.seat(pos);
        const toBot = same && !!seat && seat.controller !== Controller.HUMAN;
        stop(io, game, toBot ? 'controller' : 'turn');
        // Keep a same-turn record (a return to human control resumes it)
        if (!same) game.bidClock = null;
        return false;
    }
    if (same) {
        // Already armed for this very turn (a repeat trigger): nothing to do
        if (game.hasTimer(KEY)) return true;
        return resume(io, game);
    }
    if (rec) stop(io, game, 'turn');
    const delay = SeatState.bidClockDelayMs();
    const ms = SeatState.bidClockMs();
    const now = Date.now();
    game.bidClock = { pos, turn, startAt: now + delay, endAt: now + delay + ms, durationMs: ms, running: false, toppedUp: false };
    return game.setTimer(KEY, delay, () => start(io, game, turn));
}

/** The pre-wait is over: announce the clock to the room. */
function start(io, game, turn) {
    const rec = game.bidClock;
    if (!rec || rec.turn !== turn || game.turnKey() !== turn || !eligible(game)) {
        if (rec?.running) stop(io, game, 'turn');
        return false;
    }
    const now = Date.now();
    rec.running = true;
    const left = Math.max(0, rec.endAt - now);
    game.emitUnsequenced(io, 'bidClock', runningPayload(game, rec, left));
    gameLogger.debug('Bid clock started', { gameId: game.gameId, position: rec.pos, inMs: left });
    strikeOffer(io, game, rec.pos, turn);
    return game.setTimer(KEY, left, () => expire(io, game, turn));
}

/**
 * The same open turn came back to human control (/active, reclaimSeat)
 * with no timer pending: the pre-wait or the clock goes on from where it
 * was (the time under the bot counts), topped up once per turn so the
 * returning player can still act.
 */
function resume(io, game) {
    const rec = game.bidClock;
    const turn = rec.turn;
    const now = Date.now();
    if (now < rec.startAt) {
        return game.setTimer(KEY, rec.startAt - now, () => start(io, game, turn));
    }
    const floor = Math.min(SeatState.BID_CLOCK_RESUME_MIN_MS, rec.durationMs);
    let left = rec.endAt - now;
    if (left < floor && !rec.toppedUp) {
        rec.endAt = now + floor;
        rec.toppedUp = true;
        left = floor;
    }
    if (left <= 0) {
        // Ran out and already topped up this turn: bid at once (from a timer,
        // not inside the caller's seat transition), no running {inMs: 0}
        return game.setTimer(KEY, 0, () => expire(io, game, turn));
    }
    rec.running = true;
    game.emitUnsequenced(io, 'bidClock', runningPayload(game, rec, left));
    gameLogger.debug('Bid clock resumed', { gameId: game.gameId, position: rec.pos, inMs: left });
    return game.setTimer(KEY, left, () => expire(io, game, turn));
}

/**
 * The game thawed from a suspension (GameState.unsuspend, the holder
 * self-fence) with this clock's timer pending: re-arm it through onTurn's
 * same-turn resume, never drop it. The clients' countdown ran on while the
 * game was suspended and nothing was emitted, so a running clock is first
 * stopped ('turn') and then announced again with what is left of it (its
 * deadline moved by the suspended time; topped up once to
 * BID_CLOCK_RESUME_MIN_MS like any same-turn resume). A pre-wait simply
 * goes on.
 */
function afterSuspend(io, game) {
    if (game.bidClock?.running) stop(io, game, 'turn');
    return onTurn(io, game);
}

/** The clock ran out: bid '0' for the seat (placeBid stops it with reason 'timeout'). */
function expire(io, game, turn) {
    const rec = game.bidClock;
    if (!rec || rec.turn !== turn || game.turnKey() !== turn || !eligible(game)) {
        if (rec?.running) stop(io, game, 'turn');
        return false;
    }
    const pos = rec.pos;
    gameLogger.info('Bid clock ran out: bidding 0', { gameId: game.gameId, position: pos });
    // Lazily: gameHandlers requires this module
    const { placeBid } = require('./gameHandlers');
    const r = placeBid(io, game, pos, '0', { timedOut: true });
    if (!r.ok) {
        // '0' is always legal on an open turn; a refusal means the turn moved
        gameLogger.warn('Bid clock: the timeout bid was refused', { gameId: game.gameId, position: pos, reason: r.reason });
        if (game.bidClock?.running) stop(io, game, 'turn');
        return false;
    }
    return r.done;
}

/**
 * Stop the clock (and its pending pre-wait / expiry). Emits `stopped` only
 * when a `running` went out; idempotent. The record stays (a same-turn
 * resume reads it); onTurn replaces it on a new turn.
 */
function stop(io, game, reason) {
    game.clearTimer(KEY);
    const rec = game.bidClock;
    if (!rec || !rec.running) return false;
    rec.running = false;
    game.emitUnsequenced(io, 'bidClock', { gameId: game.gameId, position: rec.pos, running: false, reason });
    return true;
}

/** A new deal: no clock carries over (dealHand, beside resetForNewHand). */
function reset(io, game) {
    stop(io, game, 'turn');
    game.bidClock = null;
}

// ==================== strike rule (timeouts in a row) ====================

/** The seat bid or played on its own: its timeouts in a row start over. */
function clearStrikes(game, pos) {
    if (game.bidTimeouts && game.bidTimeouts[pos]) game.bidTimeouts[pos] = 0;
}

/** Count a timeout for `pos`; returns the new count. */
function addStrike(game, pos) {
    if (!game.bidTimeouts) game.bidTimeouts = {};
    game.bidTimeouts[pos] = (game.bidTimeouts[pos] || 0) + 1;
    return game.bidTimeouts[pos];
}

/** Has the seat timed out often enough in a row to count as idle? */
function struckOut(game, pos) {
    const n = SeatState.bidTimeoutAfkStrikes();
    if (!n || !SeatState.afkTimeoutMs()) return false;
    return (game.bidTimeouts?.[pos] || 0) >= n;
}

/** Strike-rule conditions shared by both actions: a connected human, AFK applies. */
function strikeApplies(game, pos) {
    const seatLifecycle = require('./seatLifecycle');
    const seat = game.seat(pos);
    return !!seat && seat.controller === Controller.HUMAN && seat.presence === Presence.CONNECTED &&
        struckOut(game, pos) && !seatLifecycle.afkExempt(game);
}

/**
 * Right after a timeout bid landed (placeBid, the turn already advanced):
 * at a casual table a seat that struck out goes lazy as after an AFK
 * takeover. A tournament table with another owner present keeps the seat
 * (owner, 2026-11-15: no automatic takeover there) and offers it when its
 * next clock starts (strikeOffer).
 */
function afterTimeout(io, game, pos) {
    const n = addStrike(game, pos);
    if (!strikeApplies(game, pos)) return false;
    const seatLifecycle = require('./seatLifecycle');
    const gameManager = require('../game/GameManager');
    if (gameManager.tournamentGames.has(game.gameId) && seatLifecycle.idleOfferHolders(game, pos).length > 0) return false;
    gameLogger.info('Bid clock: timeouts in a row, bot takes over an idle seat', { gameId: game.gameId, position: pos, timeouts: n });
    return seatLifecycle.goLazy(io, game, pos, { reason: 'afk' });
}

/**
 * The clock of a struck-out seat at a tournament table started: the other
 * present owners get the idle-seat offer for this turn (offerIdle, as the
 * AFK watchdog would make it), so they may replace it before it bids 0.
 */
function strikeOffer(io, game, pos, turn) {
    if (!strikeApplies(game, pos)) return false;
    const seatLifecycle = require('./seatLifecycle');
    const gameManager = require('../game/GameManager');
    if (!gameManager.tournamentGames.has(game.gameId) || seatLifecycle.idleOfferHolders(game, pos).length === 0) return false;
    return seatLifecycle.offerIdle(io, game, pos, turn);
}

module.exports = {
    KEY,
    eligible,
    onTurn,
    start,
    resume,
    afterSuspend,
    expire,
    stop,
    reset,
    clearStrikes,
    afterTimeout,
};
