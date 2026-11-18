/**
 * Bid clock checks for the chaos runs (dev/test only; server/socket/bidClock.js).
 *
 *   bidClockErrors(game)   per step: a running clock belongs to the open bid
 *                          turn of a human seat with its timer pending, and
 *                          no 'bidClock' timer is ever armed for a seat a bot
 *                          plays. Terminal and frozen games are skipped
 *                          (terminate / freeze cancel the timer silently).
 *   bidClockWireErrors(log, roomName)
 *                          over a finished run's room emits: a `running` is
 *                          never repeated without a `stopped` between, and a
 *                          seat's bidReceived / the next deal's gameStart
 *                          never arrive while its clock is announced as
 *                          running (the server always stops it first).
 *
 * Not in validateGameState: goLazy's seat transition runs before
 * bidClock.onTurn stops the clock, so a seat-edge invariant would fire in
 * between.
 */

'use strict';

const { Phase } = require('../game/GamePhase');

function bidClockErrors(game) {
    const errors = [];
    if (game.isTerminal() || game.frozen) return errors;
    const rec = game.bidClock;
    if (game.hasTimer('bidClock')) {
        if (!rec) errors.push('bidClock timer without a record');
        else {
            const seat = game.seat(rec.pos);
            if (!seat || seat.controller !== 'human') errors.push(`bidClock timer on a ${seat?.controller ?? 'missing'} seat ${rec.pos}`);
        }
    }
    if (rec?.running) {
        const seat = game.seat(rec.pos);
        if (game.stage !== Phase.BIDDING) errors.push(`bidClock running in ${game.stage}`);
        if (game.currentTurn !== rec.pos) errors.push(`bidClock running for ${rec.pos} on ${game.currentTurn}'s turn`);
        if (!seat || seat.controller !== 'human') errors.push(`bidClock running on a ${seat?.controller ?? 'missing'} seat`);
        if (!game.hasTimer('bidClock')) errors.push('bidClock running with no timer');
        if (game.turnKey() !== rec.turn) errors.push('bidClock running for another turn');
    }
    return errors;
}

function bidClockWireErrors(log, roomName) {
    const errors = [];
    let running = null; // position announced as running, or null
    for (const l of log) {
        if (l.to !== roomName) continue;
        if (l.event === 'bidClock') {
            if (l.data.running) {
                if (running != null) errors.push(`running for ${l.data.position} while ${running}'s clock runs`);
                running = l.data.position;
            } else {
                if (running !== l.data.position) errors.push(`stopped for ${l.data.position} while ${running ?? 'none'} runs`);
                running = null;
            }
        } else if (running != null && l.event === 'bidReceived' && l.data.position === running) {
            errors.push(`bidReceived for ${running} with its clock running`);
        } else if (running != null && (l.event === 'gameStart' || l.event === 'doneBidding' || l.event === 'destroyHands')) {
            errors.push(`${l.event} with ${running}'s clock running`);
        } else if (l.event === 'gameEnd' || l.event === 'abortGame') {
            running = null;
        }
    }
    return errors;
}

module.exports = { bidClockErrors, bidClockWireErrors };
