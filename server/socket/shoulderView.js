/**
 * Over-the-shoulder view (owner 2026-11-21; docs/claude/spectators.md,
 * "Over-the-shoulder view"): a pure spectator whose client sent the
 * clientHello cap `shoulderView` may watch one seat's hand, read-only: the
 * table that seat sees (its hand and HSI, its /help and tutorial cards as
 * they come; the bid clock and bid bubble are public already).
 *
 * Fairness (owner): never at a tournament table; a spectating socket whose
 * username owns a seat at this table (gone seats included: a player's
 * second tab, a demoted older socket, a /leave'd owner watching) may watch
 * only that seat; the table sees who watches which hand
 * (spectatorsUpdated / snapshot `watching` entries carry `shoulder`, to
 * capable sockets only). Being watched changes no stats.
 *
 * State: `game.shoulders` (socketId -> position), DERIVED (gameCodec): it
 * goes with the socket's spectator entry (GameState.removeSpectator: leave,
 * disconnect, spectating another game, becoming a seat owner by /active,
 * a rejoin or a reclaim), with a hello that drops the cap, and at retire.
 * Every read re-checks the rules (`watchedPosition`), so a stale entry is
 * never served.
 *
 * Wire (contract c2s watchHand, s2c watchHandRefused; additive keys
 * stateSnapshot.reason 'watchHand', snapshot viewer.shoulder, spectator
 * gameStart.shoulder, assistHint.watched, spectatorEntry.shoulder):
 *   watchHand {gameId, position: 1-4 | null, requestId?}
 *     accepted -> stateSnapshot {snapshot (log left out: partial ['log']),
 *       reason: 'watchHand', requestId?}; viewer.shoulder {position, hand,
 *       hsi} present while watching, absent after a stop (position null);
 *       then the coalesced spectatorsUpdated.
 *     refused  -> watchHandRefused {gameId, position, reason, message,
 *       ownPosition?}; nothing changes (a current shoulder stays).
 * A socket without the cap never receives any shoulder data.
 */

'use strict';

const gameManager = require('../game/GameManager');
const { Phase } = require('../game/GamePhase');
const clientInfo = require('./clientInfo');
const { socketLogger } = require('../utils/logger');

const CAP = 'shoulderView';

/** Stages before the first deal: no hand to watch yet. */
const PRE_DEAL = new Set([Phase.CREATED, Phase.DRAWING, Phase.DRAW_RESOLVING, Phase.TEAMS_ANNOUNCED]);

/** watchHandRefused reasons and the messages clients may show. */
const REFUSALS = Object.freeze({
    capability: 'This app cannot show a player\'s hand.',
    not_spectating: 'You are not watching this game.',
    tournament: 'Hands are hidden at tournament tables.',
    ended: 'This game is over.',
    not_dealt: 'The cards have not been dealt yet.',
    own_seat: 'You have a seat at this table: you can watch only your own hand.',
});

const isPos = (p) => Number.isInteger(p) && p >= 1 && p <= 4;

/** Is `sid` a pure spectator of `game` (spectating it, never mapped)? */
function isPureSpectator(game, sid) {
    return !!game && game.isSpectator(sid) &&
        gameManager.spectatorGames.get(sid) === game.gameId &&
        !gameManager.playerGames.has(sid);
}

/**
 * The seat a spectating socket's user owns at `game` (the spectator
 * entry's recorded name, and the signed-in name when it differs), or null.
 * Gone seats count: seatByUsername reads every seat record.
 */
function ownSeatOf(game, sid) {
    const recorded = game.spectators.get(sid)?.username ?? null;
    const authed = gameManager.getUserBySocketId(sid)?.username ?? null;
    return game.seatByUsername(recorded) || game.seatByUsername(authed) || null;
}

/**
 * Why `socket` may not watch `position` (null = stop watching) at `game`,
 * or null when it may. Order: the cap, a pure spectator of that game, a
 * tournament table, ended, not dealt, the own-seat rule.
 * @returns {{reason: string, ownPosition?: number}|null}
 */
function refusal(game, socket, position) {
    if (!clientInfo.hasCap(socket, CAP)) return { reason: 'capability' };
    if (!game || !isPureSpectator(game, socket.id)) return { reason: 'not_spectating' };
    if (position === null) return null; // stopping is always allowed
    if (gameManager.tournamentGames.has(game.gameId)) return { reason: 'tournament' };
    if (game.isTerminal()) return { reason: 'ended' };
    if (PRE_DEAL.has(game.stage)) return { reason: 'not_dealt' };
    const own = ownSeatOf(game, socket.id);
    if (own && own !== position) return { reason: 'own_seat', ownPosition: own };
    return null;
}

/**
 * The position `socket` watches at `game` right now, or null. Re-checks
 * every rule (cap included), so a stale entry is never served.
 */
function watchedPosition(game, socket) {
    if (!game || !socket || !game.shoulders) return null;
    const pos = game.shoulders.get(socket.id);
    if (!isPos(pos)) return null;
    return refusal(game, socket, pos) ? null : pos;
}

/** watchedPosition by socket id (the live socket from io; a bot or unknown id: null). */
function watchedPositionOf(io, game, sid) {
    if (!game || !game.shoulders || !game.shoulders.has(sid)) return null;
    return watchedPosition(game, io?.sockets?.sockets?.get(sid));
}

/** The watched seat's private table: {position, hand, hsi} (HSI of that seat only). */
function shoulderPayload(game, position) {
    const seatSid = game.positions?.[position];
    const hand = (seatSid ? game.hands?.[seatSid] || [] : []).map((c) => ({ suit: c.suit, rank: c.rank }));
    const hsi = game.hsiValues?.[position];
    return { position, hand, hsi: typeof hsi === 'number' ? hsi : null };
}

/** The live sockets watching seat `position` (capable, every rule holding). */
function watchersOf(io, game, position) {
    const out = [];
    if (!game?.shoulders || game.shoulders.size === 0) return out;
    for (const [sid, pos] of game.shoulders) {
        if (pos === position && watchedPositionOf(io, game, sid) === position) out.push(sid);
    }
    return out;
}

/**
 * Mirror a hint the watched seat's owner just got to its watchers:
 * assistHint with `watched: position`, without the asker-only `note`
 * (the last-free-use warning, the crossing) and `actions` (Keep / Turn off).
 * Called for kind bid / card / tip (a rule tip; never a system tip nor a
 * status reply).
 */
function mirrorHint(io, game, position, payload) {
    const sids = watchersOf(io, game, position);
    if (sids.length === 0) return;
    const { note, actions, ...rest } = payload;
    const mirrored = { ...rest, watched: position };
    for (const sid of sids) game.sendToPlayer(io, sid, 'assistHint', mirrored);
}

/** A hello without the cap: the socket's shoulder goes (its next deal sends none anyway). */
function capDropped(io, socket) {
    if (clientInfo.hasCap(socket, CAP)) return;
    const gameId = gameManager.spectatorGames.get(socket.id);
    const game = gameId ? gameManager.getGameById(gameId) : null;
    if (!game || !game.shoulders.delete(socket.id)) return;
    require('../game/spectatorRoster').spectatorsChanged(io, game);
}

/**
 * c2s watchHand {gameId, position, requestId?} (Joi-validated; rate limit
 * 'watchHand').
 */
function watchHand(socket, io, data) {
    const position = data.position === undefined ? null : data.position;
    const game = gameManager.getGameById(data.gameId);
    const refused = refusal(game, socket, position);
    if (refused) {
        socket.emit('watchHandRefused', {
            gameId: data.gameId,
            position,
            reason: refused.reason,
            message: REFUSALS[refused.reason],
            ...(refused.ownPosition && { ownPosition: refused.ownPosition }),
        });
        return;
    }
    const before = game.shoulders.get(socket.id) ?? null;
    if (position === null) game.shoulders.delete(socket.id);
    else game.shoulders.set(socket.id, position);
    socketLogger.debug('watchHand', { gameId: game.gameId, socketId: socket.id, position });

    const { snapshotFor, hideChatFrom } = require('./snapshotHandlers'); // lazy: snapshotHandlers requires this module
    const reply = {
        snapshot: snapshotFor(game, socket.id, { log: false, hideChatFrom: hideChatFrom(socket), socket }),
        reason: 'watchHand',
    };
    if (data.requestId !== undefined) reply.requestId = data.requestId;
    socket.emit('stateSnapshot', reply);
    if (before !== position) require('../game/spectatorRoster').spectatorsChanged(io, game);
}

module.exports = {
    CAP,
    REFUSALS,
    refusal,
    watchedPosition,
    watchedPositionOf,
    shoulderPayload,
    watchersOf,
    mirrorHint,
    capDropped,
    watchHand,
};
