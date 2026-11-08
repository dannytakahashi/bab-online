/**
 * Snapshot v2 delivery (contract/README.md "Snapshot v2").
 *
 * The v2 snapshot travels as a NEW field on payloads current clients
 * already handle (rejoinSuccess, restorePlayerState, actionRejected, the
 * spectator full state) and as the reply to the new requestSnapshot event
 * (stateSnapshot). Old clients ignore both. The viewer is always the
 * receiving socket. Snapshots attached to v1 payloads skip custom pictures
 * (customPics:false): those payloads already carry them in players[].pic.
 */

'use strict';

const gameManager = require('../game/GameManager');

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

/** The v2 snapshot of `game` as socket `sid` sees it. */
function snapshotFor(game, sid, opts = {}) {
    return game.getSnapshotV2(sid, { tournament: tournamentInfo(game.gameId), ...opts });
}

/**
 * The spectator full state (spectatorJoined to the joining socket): the 16
 * cc865b4 keys in their order, then four additive keys the SHIPPED iOS app
 * already reads in GameState.restoreFromSpectator but never got (so its
 * spectators showed no lead, trump never broken and 0-0 tricks):
 * leadPosition (the same raw value getClientState sends), trumpBroken,
 * teamTricks / oppTricks (spectators view from seat 1: team 1 is "team").
 * Web's spectator path reads none of them. Built after addSpectator
 * (spectatorCount includes the joiner).
 */
function spectatorJoinState(game) {
    const playerInfo = [];
    for (let pos = 1; pos <= 4; pos++) {
        const player = game.getPlayerByPosition(pos);
        if (player) {
            playerInfo.push({
                position: pos,
                username: player.username,
                pic: player.pic,
                socketId: player.socketId
            });
        }
    }
    return {
        gameId: game.gameId,
        players: playerInfo,
        trump: game.trump,
        currentHand: game.currentHand,
        dealer: game.dealer,
        phase: game.phase,
        bidding: game.bidding,
        currentTurn: game.currentTurn,
        bids: game.bids,
        playerBids: game.playerBids,
        tricks: game.tricks,
        score: game.score,
        playedCards: game.playedCards,
        isTrumpBroken: game.isTrumpBroken,
        gameLog: game.getGameLog(),
        spectatorCount: game.getSpectators().length,
        leadPosition: game.leadPosition,
        trumpBroken: game.isTrumpBroken,
        teamTricks: game.tricks.team1,
        oppTricks: game.tricks.team2
    };
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
 * (README R2) or whenever it wants to redraw from the truth.
 */
function requestSnapshot(socket, io, data) {
    const req = data && typeof data === 'object' ? data : {};
    const game = gameOf(socket.id);
    const reply = {
        snapshot: game && !game.isTerminal()
            ? snapshotFor(game, socket.id, { customPics: req.customPics !== false, log: req.log !== false })
            : null,
    };
    if (req.requestId !== undefined) reply.requestId = req.requestId;
    if (!reply.snapshot) reply.reason = 'not_in_game';
    socket.emit('stateSnapshot', reply);
}

module.exports = {
    tournamentInfo,
    snapshotFor,
    spectatorJoinState,
    requestSnapshot
};
