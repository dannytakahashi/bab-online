/**
 * Who is watching: `spectatorsUpdated {gameId, spectators, count}` to the
 * game room whenever GameState.spectatorList() may have changed (owner,
 * 2026-11-11: the table's spectator badge, seen by every viewer).
 *
 *   - spectatorsChanged(io, game) is called by GameManager.addSpectator /
 *     leaveSpectating (every join, leave, spectate-another-game, round
 *     start, /active reclaim and watchSeat demotion goes through them) and
 *     by queueHandlers.handleDisconnect (GameManager.handleDisconnect has
 *     no io). Without an io it uses the one the game was last scheduled
 *     with (the forceLogout path).
 *   - Coalesced: at most one emit per game per SPECTATORS_COALESCE_MS, on
 *     the game's own timer (`spectators`), so nothing is sent after
 *     end/abort (terminate cancels game timers; emitUnsequenced drops a
 *     terminal game's emits too). The payload is read when the timer fires
 *     and skipped only when the list never differed from the last one sent
 *     during the window (a watchSeat demotion of an owner's socket, a
 *     picture that did not change). A join and leave inside one window
 *     still sends the settled list: a snapshot taken in between (reload,
 *     requestSnapshot, the joiner's own full state) read the list live and
 *     showed the joiner, and only this emit corrects it.
 *   - Unsequenced (contract `seq: false`, GameState.emitUnsequenced): the
 *     payload is the whole list, and a sequenced event the App Store build
 *     ignores would open a gap in its seq gate on every change.
 *   - Pictures: GameManager.addSpectator stores pic null; lookupPic reads
 *     the spectator's saved picture (no RNG, no random fallback) and marks
 *     the list changed when it lands.
 */

'use strict';

const { spectatorsWire } = require('./spectatorWire');
const avatarWire = require('../avatar/avatarWire');
const avatarStore = require('../avatar/avatarStore');
const { getUsersCollection } = require('../database');
const { gameLogger } = require('../utils/logger');

const SPECTATORS_COALESCE_MS = 250;
const TIMER_KEY = 'spectators';
const EVENT = 'spectatorsUpdated';

const ioOf = new WeakMap(); // game -> io it was last scheduled with
const lastSent = new WeakMap(); // game -> JSON of the last {spectators, count} sent
// games whose list differed from lastSent at some change inside the pending
// window: a snapshot may have shown that list, so the flush must send
const mustSend = new WeakSet();

/** The list as `game`'s room gets it (no gameId). */
function listWire(game) {
    return spectatorsWire(game.spectatorList(), (pic, username) => avatarWire.seatResolve(game, pic, username));
}

/** The spectatorsUpdated payload for `game` right now. */
function payloadFor(game) {
    return { gameId: game.gameId, ...listWire(game) };
}

const EMPTY = JSON.stringify({ spectators: [], count: 0 });

const sentJson = (game) => lastSent.get(game) ?? EMPTY;

function flush(io, game) {
    const { gameId, ...rest } = payloadFor(game);
    const json = JSON.stringify(rest);
    const force = mustSend.has(game);
    mustSend.delete(game);
    if (!force && json === sentJson(game)) return;
    lastSent.set(game, json);
    game.emitUnsequenced(io, EVENT, { gameId, ...rest });
}

/** The list of `game` may have changed: one coalesced emit within ~250 ms. */
function spectatorsChanged(io, game) {
    if (!game || typeof game.isTerminal !== 'function' || game.isTerminal()) return;
    if (io) ioOf.set(game, io);
    const target = io || ioOf.get(game);
    if (!target) return;
    // every change calls here after it lands, so this sees each list a
    // snapshot inside the window could have read
    if (!mustSend.has(game) && JSON.stringify(listWire(game)) !== sentJson(game)) mustSend.add(game);
    if (game.hasTimer(TIMER_KEY)) return; // the pending flush reads the list when it fires
    game.setTimer(TIMER_KEY, SPECTATORS_COALESCE_MS, () => flush(target, game));
}

/**
 * Look up `username`'s saved picture for its spectator entry on `socketId`
 * (fire and forget). Lands only while that socket still spectates `game`
 * under that name.
 */
async function lookupPic(io, game, socketId, username) {
    const users = getUsersCollection();
    if (!users || !username) return;
    let pic = null;
    try {
        const user = await users.findOne({ username }, { projection: { profilePic: 1, customProfilePic: 1 } });
        if (user && user.customProfilePic) {
            avatarStore.warm(username, user.customProfilePic);
            pic = user.customProfilePic;
        } else if (user && user.profilePic) {
            pic = user.profilePic;
        }
    } catch (error) {
        gameLogger.warn('Spectator picture lookup failed', { gameId: game.gameId, error: error.message });
        return;
    }
    const entry = game.spectators.get(socketId);
    if (pic == null || !entry || entry.username !== username || entry.pic === pic) return;
    entry.pic = pic;
    spectatorsChanged(io, game);
}

module.exports = { spectatorsChanged, lookupPic, payloadFor, listWire, SPECTATORS_COALESCE_MS, EVENT };
