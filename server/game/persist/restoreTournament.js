/**
 * A restored tournament inside the server (deploy survival PR 6,
 * LIVE_PERSIST=on; the plan's PR 6 section). The adopter (adopt.js: the
 * sweep, the users lookup, the compare-and-set) hands a liveTournaments doc
 * to adoptTournament, adopts the round's live tables (restoreGame, with the
 * 5-minute tournament abandon: owner answer b) and claims its ENDED
 * tombstones, then calls normalizeRound. Everything after the claim is here:
 *
 *   adoptTournament(io, doc, opts)
 *       tournamentCodec.hydrate: every member comes back connected: false,
 *       keyed by the synthetic restored:<tid>:<username> (a GHOST until it
 *       reattaches by username: joinTournament, a table rejoin,
 *       returnToTournament). Members whose account is gone (deleted or
 *       merged: opts.removed) are removed (their scoreboard row stays, never
 *       a winner: getWinners takes members only); chat lines of deleted
 *       senders are dropped (opts.scrubFrom). Registered in GameManager
 *       (no playerTournaments entry for a synthetic id). Then:
 *         - the restored abandon ('restoreAbandon', RESTORE_ABANDON_MS, 10
 *           min, not for a complete tournament): at its end, unless the
 *           tournament completed meanwhile (its results-window cleanup
 *           owns it then), with nobody
 *           here and either nobody ever back or no table still running ->
 *           torn down like a cancel (deleteTournament, abortGame for every
 *           table, tournamentCancelled to the room, the members' pointers
 *           cleared scoped, its doc deleted); otherwise the normal rules
 *           go on (the window only ends)
 *         - the host grace ('restoreHostGrace', HOST_GRACE_MS, 60 s): a
 *           ghost host keeps the role (TournamentState
 *           recoverCreatorIfDisconnected leaves it) until it ends; then, if
 *           the host is still away and a member is here, transferCreator plus
 *           tournamentPlayerLeft {username, players, newCreator}
 *         - between rounds: a fresh ready deadline (now + the deadline, if
 *           the tournament had one: every member was away during the
 *           deploy), armed with armReadyDeadline({restart: false});
 *           handedOffThisWait is kept
 *         - complete: the results-window cleanup at max(completedAt + 10
 *           min - now, 30 s)
 *         - cut (Cut for a buck, codec v2): after RESTORE_CUT_LEAD_IN_MS
 *           (30 s) the gather's begin (participants: the members back by
 *           then), the winner again, or the interrupted round redrawn with
 *           the remaining cards reshuffled; "Cut for a buck continues in
 *           30 s after a server update." at the first member back
 *           (socket/cutForABuck.js afterRestore / noteBack)
 *       While the restored abandon is armed, GameManager
 *       deleteTournamentIfAbandoned counts the ghosts as present
 *       (restoreHolds), so a table aborting, or the last member back
 *       leaving again, does not delete it before the window ends.
 *       In the lobby the ghosts stay members until they come back or the
 *       host begins (beginTournament drops them: dropLobbyGhosts).
 *
 *   normalizeRound(io, t, {tableScores, kept, pending, ended})
 *       round_active only (never a frozen or retired tournament). kept: the
 *       round's tables live here now; pending: tables whose doc is still
 *       adoptable (the adoption did not finish it: a later sweep or the
 *       successor adopts it): like kept, never scored, never a rollback;
 *       ended: gameId -> the `ended` of an ENDED tombstone claimed for it.
 *       None kept or pending and none complete (every table was pre-deal, or the
 *       announce): the round is rolled back (rollbackRound, generalized: its
 *       games are dropped, their players' activeGameId cleared scoped).
 *       Otherwise every table of the round that is neither complete nor kept
 *       is scored with recordTableScores' rules: from its tombstone (a
 *       finished table: final scores; an aborted one: running scores), else
 *       from tableScores (the last running score the old instance saved: as
 *       an abort), else (pre-deal) its humans score 0 as an abort before
 *       seating; then markGameComplete, and completeRound plus
 *       broadcastRoundOutcome once the round is done. Never through
 *       handleAbortedTournamentGame (its delete would end the tournament).
 *
 * Nothing here runs for a tournament that was not adopted: every hook
 * elsewhere reads `t.restored` (DERIVED, tournamentCodec), undefined for
 * every other tournament, so LIVE_PERSIST off and write are unchanged.
 *
 * Server modules are required lazily (GameManager and tournamentHandlers
 * require this module).
 */

'use strict';

const { socketLogger } = require('../../utils/logger');
const { Presence } = require('../SeatState');

/** A restored tournament no member returns to is torn down after this. */
const RESTORE_ABANDON_MS = 10 * 60000;
/** A ghost host keeps the role this long after the restore. */
const HOST_GRACE_MS = 60000;
/**
 * A restored Cut for a buck waits this long for its members to come back,
 * then goes on: the gather's begin, the winner, or the interrupted round
 * redrawn (its cards were never revealed).
 */
const RESTORE_CUT_LEAD_IN_MS = 30000;
/** The results window after a restore lasts at least this long. */
const MIN_CLEANUP_MS = 30000;
const COMPLETED_TTL_MS = 10 * 60000;
const ABANDON_KEY = 'restoreAbandon';
const HOST_GRACE_KEY = 'restoreHostGrace';

const ghostPrefix = (t) => `restored:${t.tournamentId}:`;

/** True for a member entry keyed by its synthetic id (not back since the restore). */
function isGhost(t, socketId) {
    return !!t?.restored && typeof socketId === 'string' && socketId.startsWith(ghostPrefix(t));
}

/** The usernames of the members not back since the restore. */
function ghosts(t) {
    if (!t?.restored) return [];
    return [...t.players.entries()].filter(([sid]) => isGhost(t, sid)).map(([, p]) => p.username);
}

/**
 * Inside the restored window with ghosts still away:
 * GameManager.deleteTournamentIfAbandoned counts them as present.
 */
function restoreHolds(t) {
    return !!t?.restored && t.hasTimer(ABANDON_KEY) && ghosts(t).length > 0;
}

/**
 * Adopt a tournament doc in this process (the adopter's compare-and-set
 * already made it ours). Throws (a TournamentCodecError, 'already live',
 * no member left) and registers nothing when it does not restore.
 * @param {Object} io
 * @param {Object} doc - a liveTournaments doc (tournamentCodec shape plus the envelope)
 * @param {Object} [opts]
 * @param {number} [opts.now]
 * @param {string[]} [opts.removed] - members whose account is gone (deleted, merged)
 * @param {string[]} [opts.scrubFrom] - deleted chat senders
 * @returns {{tournament: TournamentState, tableScores: Object}}
 */
function adoptTournament(io, doc, { now = Date.now(), removed = [], scrubFrom = [], gameManager = require('../GameManager') } = {}) {
    const tid = doc?._id ?? doc?.tournamentId;
    if (typeof tid === 'string' && gameManager.tournaments.has(tid)) {
        throw new Error(`adoptTournament: ${tid} is already live here`);
    }
    const { hydrate } = require('./tournamentCodec');
    const { tournament: t, tableScores } = hydrate({ ...doc, tournamentId: tid });
    t.restored = { at: now, memberBack: false, hostGraceUntil: null };
    for (const name of removed) {
        const m = t.getPlayerByUsername(name);
        if (m) t.removePlayer(m.socketId);
    }
    for (const name of scrubFrom) t.scrubChatFrom(name);
    if (t.players.size === 0) {
        const err = new Error('adoptTournament: no member left');
        err.reason = 'empty';
        throw err;
    }
    if (!t.players.has(t.createdBy)) t.transferCreator();
    gameManager.tournaments.set(tid, t);
    const handlers = require('../../socket/tournamentHandlers');
    const liveness = require('../../socket/tournamentLiveness');
    if (t.phase === 'complete') {
        const at = Number.isFinite(t.completedAt) ? t.completedAt : now;
        handlers.scheduleTournamentCleanup(io, tid, Math.max(at + COMPLETED_TTL_MS - now, MIN_CLEANUP_MS));
        // The record again (idempotent by _id: E11000 when the old process
        // wrote it), for a crash between the finish and the insert
        handlers.recordTournament(t, t.cutResult || null).catch((err) =>
            socketLogger.error('recordTournament failed', { tournamentId: tid, error: err.message }));
    } else {
        t.setTimer(ABANDON_KEY, RESTORE_ABANDON_MS, () => onRestoreAbandon(io, t));
        t.restored.hostGraceUntil = now + HOST_GRACE_MS;
        t.setTimer(HOST_GRACE_KEY, HOST_GRACE_MS, () => onHostGraceEnd(io, t));
        // Cut for a buck (codec v2): it goes on after the lead-in, a line at
        // the first member back; ghosts are disconnected, so drawn for
        if (t.phase === 'cut') require('../../socket/cutForABuck').afterRestore(io, t, RESTORE_CUT_LEAD_IN_MS);
        if (t.phase === 'between_rounds' && t.readyDeadlineAt != null) {
            const ms = liveness.readyDeadlineMs();
            t.readyDeadlineAt = ms > 0 ? now + ms : null;
            t._changed();
            liveness.armReadyDeadline(io, t, { restart: false });
        }
    }
    socketLogger.info('Tournament adopted', { tournamentId: tid, phase: t.phase, round: t.currentRound, members: t.players.size, removed: removed.length });
    require('../../socket/gameLifecycle').emitLobbiesUpdated(io);
    return { tournament: t, tableScores: tableScores || {} };
}

/**
 * A member is back (TournamentState.reattachPlayerByUsername re-keyed a
 * ghost): the restored abandon is over; a host back ends its grace.
 */
function noteReattach(t, { wasGhost, isCreator }) {
    if (!t?.restored || !wasGhost) return;
    t.restored.memberBack = true;
    if (isCreator) {
        t.restored.hostGraceUntil = null;
        t.clearTimer(HOST_GRACE_KEY);
    }
}

/** The host grace ended: a host still away hands the role to a member who is here. */
function onHostGraceEnd(io, t) {
    if (!t.restored) return;
    t.restored.hostGraceUntil = null;
    const gm = require('../GameManager');
    if (gm.getTournamentById(t.tournamentId) !== t) return;
    const host = t.players.get(t.createdBy);
    if (host && host.connected !== false) return;
    if (t.getConnectedPlayerCount() === 0) return;
    const oldName = host?.username ?? t.creatorUsername;
    const next = t.transferCreator();
    if (!next || next.username === oldName) return;
    socketLogger.info('Restored tournament: the host did not come back, role handed on', { tournamentId: t.tournamentId });
    t.broadcast(io, 'tournamentPlayerLeft', {
        username: oldName,
        players: t.getClientState().players,
        newCreator: next.username
    });
    require('../../socket/tournamentLiveness').refreshHostIdle(io, t);
    require('../../socket/gameLifecycle').emitLobbiesUpdated(io);
}

/** 'restoreAbandon' fired: the restored window is over (see the header). */
function onRestoreAbandon(io, t) {
    if (!t.restored) return false;
    const gm = require('../GameManager');
    if (gm.getTournamentById(t.tournamentId) !== t) return false;
    // Completed since the restore: the results window ends it, never a cancel
    if (t.phase === 'complete') return false;
    if (t.getConnectedPlayerCount() > 0) return false;
    // Someone came back and a table still runs: its own rules end it
    if (t.restored.memberBack && gm.getTournamentLiveGames(t.tournamentId).length > 0) return false;
    socketLogger.warn('Restored tournament: nobody came back, tearing it down', { tournamentId: t.tournamentId, ms: RESTORE_ABANDON_MS });
    const { abortGame, emitLobbiesUpdated } = require('../../socket/gameLifecycle');
    const tables = gm.deleteTournament(t.tournamentId);
    for (const game of tables) {
        abortGame(io, game, 'Tournament cancelled').catch((err) =>
            socketLogger.error('abortGame failed', { gameId: game.gameId, error: err.message }));
    }
    io.to(t.roomName).emit('tournamentCancelled', {});
    for (const [sid] of t.spectators) t.leaveRoom(io, sid);
    emitLobbiesUpdated(io);
    gm.clearActiveTournamentForAll(t.tournamentId, t).catch(() => {});
    return true;
}

/**
 * beginTournament on a restored lobby: the ghosts still not back leave
 * (tournamentPlayerLeft each, their pointer cleared scoped).
 * @returns {string[]} the usernames dropped
 */
function dropLobbyGhosts(io, t) {
    if (!t?.restored || t.phase !== 'lobby') return [];
    const gm = require('../GameManager');
    const dropped = [];
    for (const [sid, p] of [...t.players.entries()]) {
        if (!isGhost(t, sid)) continue;
        t.removePlayer(sid);
        dropped.push(p.username);
        t.broadcast(io, 'tournamentPlayerLeft', { username: p.username, players: t.getClientState().players, newCreator: null });
        gm.clearActiveTournament(p.username, t.tournamentId).catch(() => {});
    }
    if (dropped.length) socketLogger.info('Restored lobby: members who did not come back dropped at begin', { tournamentId: t.tournamentId, dropped: dropped.length });
    return dropped;
}

// ---------- the round in play at the restore ----------

/**
 * A GameState-shaped view of a table that is gone, for recordTableScores:
 * {score, seats: [{username, position, gone}]} (a tombstone's `ended`, or
 * tableScores), or the round's humans before seating.
 */
function tableView(gameId, { score, seats, humans }) {
    const seated = Array.isArray(seats) && seats.some((s) => s && s.username);
    const byPos = new Map((seats || []).map((s) => [s.position, s]));
    return {
        gameId,
        score: { team1: score?.team1 ?? 0, team2: score?.team2 ?? 0 },
        seatList: () => (seated ? [1, 2, 3, 4] : []),
        getOriginalPlayer: (pos) => (byPos.get(pos)?.username ? { username: byPos.get(pos).username } : null),
        seat: (pos) => ({ presence: byPos.get(pos)?.gone ? Presence.GONE : Presence.CONNECTED }),
        entrants: seated ? null : new Map((humans || []).map((u, i) => [`restored-entrant:${i}`, { isBot: false, username: u, presence: 'connected' }]))
    };
}

/**
 * Score one gone table of `t` and mark it complete (no round completion).
 * @param {{ended?: Object, tableScore?: Object}} from
 * @returns {boolean} true if it was scored now
 */
function scoreGoneTable(t, gameId, { ended = null, tableScore = null } = {}) {
    const round = t.roundOfGame(gameId);
    if (!round || round.completedGames.has(gameId)) return false;
    const { recordTableScores } = require('../tournamentScoring');
    const humans = round.games.get(gameId)?.humanPlayers || [];
    if (ended) {
        recordTableScores(t, tableView(gameId, { score: ended.score, seats: ended.seats, humans }), { aborted: !!ended.aborted || !ended.record });
    } else if (tableScore) {
        recordTableScores(t, tableView(gameId, { score: tableScore.score, seats: tableScore.seats, humans }), { aborted: true });
    } else {
        recordTableScores(t, tableView(gameId, { humans }), { aborted: true });
    }
    t.markGameComplete(gameId);
    return true;
}

/** completeRound plus its outcome once every table of the current round is complete. */
async function completeIfDone(io, t) {
    if (t.frozen || t.retired) return false;
    if (t.phase !== 'round_active' || !t.isRoundComplete()) return false;
    t.completeRound();
    await require('../../socket/tournamentHandlers').broadcastRoundOutcome(io, t);
    return true;
}

/**
 * A table whose doc showed up after its tournament was adopted here (it was
 * pending then): an ENDED tombstone scores it now (the round completes if
 * it was the last one). Never for a table already complete.
 */
async function scoreLateTable(io, t, gameId, ended) {
    if (!scoreGoneTable(t, gameId, { ended })) return false;
    const round = t.roundOfGame(gameId);
    t.broadcast(io, 'tournamentGameComplete', {
        gameId,
        score: ended?.score || { team1: 0, team2: 0 },
        ...(ended?.aborted || !ended?.record ? { aborted: true } : {}),
        activeGames: t.getActiveGames(),
        scoreboard: t.getScoreboard(),
        currentRound: t.currentRound,
        totalRounds: t.totalRounds
    });
    if (round === t.getCurrentRound()) await completeIfDone(io, t);
    return true;
}

/** Roll the restored round back: nothing of it survived (pre-deal tables, or the announce). */
function rollbackRestoredRound(io, t, round) {
    const gm = require('../GameManager');
    for (const [gameId, data] of round.games) {
        gm.tournamentGames.delete(gameId);
        for (const u of data.humanPlayers || []) gm.clearActiveGame(u, gameId).catch(() => {});
    }
    // rollbackRound undoes a round with no games: these never played
    round.games.clear();
    require('../../socket/tournamentHandlers').rollbackRound(io, t, round.roundNumber);
}

/**
 * See the header. Never throws for one table: a table that fails to score
 * is logged and left (the round then waits for the abandon or a cancel).
 * @param {{tableScores?: Object, kept?: Set<string>, pending?: Set<string>, ended?: Map<string, Object>}} opts
 * @returns {Promise<'rolledBack'|'scored'|'none'>}
 */
async function normalizeRound(io, t, { tableScores = {}, kept = new Set(), pending = new Set(), ended = new Map() } = {}) {
    if (t.frozen || t.retired) return 'none';
    if (t.phase !== 'round_active') return 'none';
    const round = t.getCurrentRound();
    if (!round) return 'none';
    const ids = [...round.games.keys()];
    const anyComplete = round.completedGames.size > 0 || ids.some((id) => ended.has(id));
    const anyKept = ids.some((id) => kept.has(id) || pending.has(id));
    if (!anyKept && !anyComplete) {
        rollbackRestoredRound(io, t, round);
        socketLogger.info('Restored tournament: round rolled back', { tournamentId: t.tournamentId, round: round.roundNumber });
        return 'rolledBack';
    }
    let scored = 0;
    for (const id of ids) {
        if (round.completedGames.has(id) || kept.has(id) || pending.has(id)) continue;
        try {
            if (scoreGoneTable(t, id, { ended: ended.get(id) || null, tableScore: tableScores[id] || null })) scored++;
        } catch (err) {
            socketLogger.error('Restored tournament: a table could not be scored', { tournamentId: t.tournamentId, gameId: id, error: err.message });
        }
    }
    if (scored > 0) socketLogger.info('Restored tournament: tables scored', { tournamentId: t.tournamentId, round: round.roundNumber, scored });
    await completeIfDone(io, t);
    return scored > 0 ? 'scored' : 'none';
}

module.exports = {
    RESTORE_ABANDON_MS,
    RESTORE_CUT_LEAD_IN_MS,
    HOST_GRACE_MS,
    MIN_CLEANUP_MS,
    ABANDON_KEY,
    HOST_GRACE_KEY,
    adoptTournament,
    noteReattach,
    isGhost,
    ghosts,
    restoreHolds,
    dropLobbyGhosts,
    normalizeRound,
    scoreGoneTable,
    scoreLateTable,
    tableView
};
