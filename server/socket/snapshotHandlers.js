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
        ...opts,
    });
}

/**
 * The spectator full state (spectatorJoined to the joining socket): the 16
 * cc865b4 keys in their order, then four additive keys iOS
 * GameState.restoreFromSpectator reads:
 *   - trumpBroken, teamTricks, oppTricks: read by the App Store build (since
 *     Feb 2026) but never sent, so its spectators saw trump never broken and
 *     0-0 (or a previous game's) trick counts. Sending them CHANGES what the
 *     shipped app shows - knowingly, as a fix (spectators view from seat 1:
 *     team 1 is "team"; later trickComplete increments use position % 2).
 *   - leadPosition (the same raw value getClientState sends): read only by
 *     iOS source builds after 10d1538 (2026-11-07); the App Store build
 *     ignores it and infers the lead from the first non-null card.
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
    spectatorJoinState,
    requestSnapshot
};
