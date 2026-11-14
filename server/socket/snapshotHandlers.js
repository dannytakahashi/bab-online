/**
 * Snapshot v2 delivery (contract/README.md "Snapshot v2").
 *
 * The v2 snapshot travels as a NEW field on payloads current clients
 * already handle (rejoinSuccess, restorePlayerState, actionRejected, the
 * spectator full state) and as the reply to the new requestSnapshot event
 * (stateSnapshot). Old clients ignore both. The viewer is always the
 * receiving socket. Snapshots attached to v1 payloads skip custom pictures
 * (customPics:false): those payloads carry them in players[].pic. Since
 * V1_REMOVALS #9 those payloads carry only the snapshot plus the few v1
 * keys a client still reads (carrierFor).
 */

'use strict';

const gameManager = require('../game/GameManager');
const avatarWire = require('../avatar/avatarWire');
const { hasCap } = require('./clientInfo');

/** Tournament context of a game for the snapshot, or null. */
function tournamentInfo(gameId) {
    const tid = gameManager.tournamentGames.get(gameId);
    const t = tid ? gameManager.getTournamentById(tid) : null;
    if (!t) return null;
    return {
        tournamentId: tid,
        name: t.name,
        roundNumber: t.roundOfGame(gameId)?.roundNumber ?? null,
        totalRounds: t.totalRounds,
    };
}

/**
 * Display name of a bot entrant before it draws (entrant records hold no
 * bot names; the BotController does, and playerDrew shows exactly this).
 */
function botNameFor(gameId) {
    const { botController } = require('../game/bot'); // lazy: avoids a require cycle
    return (socketId) => botController.getBot(gameId, socketId)?.username ?? null;
}

/** The v2 snapshot of `game` as socket `sid` sees it. */
function snapshotFor(game, sid, opts = {}) {
    return game.getSnapshotV2(sid, {
        tournament: tournamentInfo(game.gameId),
        botName: botNameFor(game.gameId),
        avatarResolve: (pic, username) => avatarWire.seatResolve(game, pic, username),
        ...opts,
    });
}

/** players[] of a snapshot carrier: {position, username, pic, socketId} per seat. */
function carrierPlayers(game) {
    const players = [];
    for (let pos = 1; pos <= 4; pos++) {
        const player = game.getPlayerByPosition(pos);
        if (player) {
            players.push({
                position: pos,
                username: player.username,
                pic: player.pic,
                socketId: player.socketId
            });
        }
    }
    return players;
}

/**
 * A snapshot carrier (rejoinSuccess, restorePlayerState, the spectator full
 * state) for `socket`: the v2 snapshot plus only the v1 keys a client still
 * reads (V1_REMOVALS #9, 2026-11-12). Until then each carried the whole
 * legacy getClientState (22 keys) or spectator state (16 + 4 aliases).
 *   - players[] {position, username, pic, socketId}: iOS 1.2.0 reads pic
 *     (R5: the snapshot withholds custom pictures, customPics:false, and
 *     has no URL while a rendition is pending / failed or with
 *     AVATAR_PIPELINE=off) and socketId (voice glow fallback);
 *     WirePayloads.RejoinEnvelope.hints. Web lets it win for names and
 *     pictures (tableSync.applyTableSnapshot).
 *   - avatarUrls (capable sockets, when there is a URL): iOS 1.2.0 hints.
 *   - gameId; isLazy (rejoinSuccess); trump (spectator full state): what a
 *     web page from before #233 (2026-11-12) routes on (onRejoinSuccess
 *     data.gameId / data.isLazy, onSpectatorJoined data.players &&
 *     data.trump), so a tab left open across the deploy still rejoins and
 *     spectates. Current web and iOS 1.2.0 take them from the snapshot.
 *   - tournamentId (rejoinSuccess): web and iOS 1.2.0 (passed in `extra`).
 * `extra` keys go between those and the snapshot, which is last.
 */
function carrierFor(game, socket, extra = {}) {
    const base = avatarWire.wireClientState(game, { gameId: game.gameId, players: carrierPlayers(game) }, hasCap(socket, 'avatarUrl'));
    return {
        ...base,
        ...extra,
        snapshot: snapshotFor(game, socket.id, { customPics: false })
    };
}

/** getClientState's isLazy for seat socket `sid` (the rejoinSuccess value). */
function wireIsLazy(game, sid) {
    const position = game.seatBySocket(sid);
    return position ? game.wireLazy(position) : false;
}

/**
 * A pure spectator just joined `game` (joinAsSpectator,
 * spectateTournamentGame): spectatorJoined split in two (V1_REMOVALS #8).
 *   1. The notice {username, spectatorCount} to the room EXCEPT the joiner
 *      (sequenced, socket.to(room)).
 *   2. The joiner's own full state + v2 snapshot (socket.emit), built after
 *      the notice, so snapshot.seq already counts it and the joiner's next
 *      room event is snapshot.seq + 1 (no gap, no resync).
 * Until then the notice went to the whole room after the full state, so
 * the joiner also logged "<itself> joined as a spectator" (ctr-17). Both
 * clients take a payload with a snapshot (or players + trump) as the full
 * state and anything else as the notice, so neither needs a change.
 */
function sendSpectatorJoin(game, socket, username) {
    game.broadcastExcept(socket, 'spectatorJoined', {
        username,
        spectatorCount: game.getSpectators().length
    });
    socket.emit('spectatorJoined', carrierFor(game, socket, { trump: game.trump }));
}

/** The game a socket belongs to: mapped (seat owner, entrant) or spectating. */
function gameOf(socketId) {
    const game = gameManager.getPlayerGame(socketId);
    if (game) return game;
    const gameId = gameManager.spectatorGames.get(socketId);
    const spectated = gameId ? gameManager.getGameById(gameId) : null;
    return spectated && spectated.isSpectator(socketId) ? spectated : null;
}

/**
 * requestSnapshot {requestId?, customPics?, log?} -> stateSnapshot
 * {snapshot, requestId?, reason?}. A v2 client sends it on a seq gap
 * (README R2) or whenever it wants to redraw from the truth. Custom
 * (data-URL, up to ~500KB each) seat pictures are OPT-IN (customPics:
 * true): a gap resync should not re-ship every picture.
 */
function requestSnapshot(socket, io, data) {
    const req = data && typeof data === 'object' ? data : {};
    const game = gameOf(socket.id);
    const reply = {
        snapshot: game && !game.isTerminal()
            ? snapshotFor(game, socket.id, { customPics: req.customPics === true, log: req.log !== false })
            : null,
    };
    if (req.requestId !== undefined) reply.requestId = req.requestId;
    if (!reply.snapshot) reply.reason = 'not_in_game';
    socket.emit('stateSnapshot', reply);
}

module.exports = {
    tournamentInfo,
    botNameFor,
    snapshotFor,
    carrierFor,
    wireIsLazy,
    sendSpectatorJoin,
    requestSnapshot
};
