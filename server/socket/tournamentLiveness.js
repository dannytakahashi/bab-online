/**
 * Tournament liveness between rounds and in the lobby (owner 2026-11-15):
 *
 *   Ready deadline: READY_DEADLINE_MS after a round completes, the host's
 *   Begin starts the next round with the host and whoever is ready
 *   (TournamentState canBegin); members not ready sit it out and score the
 *   round's lowest (scoreMissedRound). At the deadline the room gets
 *   tournamentReadyUpdate {readyDeadlinePassed: true} (web enables Begin)
 *   and a notice.
 *
 *   Host hand-off: a connected host idle for HOST_IDLE_MS while every other
 *   connected member is ready (or, past the ready deadline, while any other
 *   member is ready: Begin would start without the idle host) loses the role
 *   to the next member (transferCreator, a ready one first), announced like
 *   a host leaving (tournamentPlayerLeft {newCreator}, which web and iOS
 *   1.2.0 already act on) plus a notice. Never during a round.
 *
 *   Server start: iOS 1.2.0's Begin needs every connected member ready, so
 *   past the deadline an iOS host (handed the role or not) cannot start
 *   with one member AFK. Past the deadline, a host idle for HOST_IDLE_MS
 *   after this wait's hand-off, or with no other member ready to hand to,
 *   gets the round started for them with the ready members (startNextRound,
 *   as a Begin without the host's own seat). At most one hand-off per wait,
 *   so the role never bounces between idle members.
 *
 * Timers live on the tournament (t.setTimer): every round start (beginStart)
 * and the deletion (retire) clear them, and each one re-checks its condition
 * when it fires. Env TOURNAMENT_READY_DEADLINE_MS / TOURNAMENT_HOST_IDLE_MS
 * override the defaults at every arm (0 disables), like AFK_TIMEOUT_MS.
 */

'use strict';

const gameManager = require('../game/GameManager');
const { socketLogger } = require('../utils/logger');

const READY_DEADLINE_MS = 2 * 60 * 1000;
const HOST_IDLE_MS = 3 * 60 * 1000;

function envMs(name, fallback, env = process.env) {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
const readyDeadlineMs = (env) => envMs('TOURNAMENT_READY_DEADLINE_MS', READY_DEADLINE_MS, env);
const hostIdleMs = (env) => envMs('TOURNAMENT_HOST_IDLE_MS', HOST_IDLE_MS, env);

/**
 * A server notice in tournament chat. `system: true` marks it for web, and
 * `type: 'system'` for iOS 1.2.0, whose ChatMessage.from already reads
 * `type` and shows a system line dim, without a name or a report/block
 * menu. A player's line carries neither, so a player named "System" (no
 * longer registrable: usernameRules RESERVED_NAMES) cannot pass for one.
 * The username stays for any reader of neither.
 */
function systemLine(message) {
    return { username: 'System', message, isSpectator: false, timestamp: Date.now(), system: true, type: 'system' };
}

/** Still the registered, undeleted tournament. */
function registered(t) {
    return !t.retired && gameManager.getTournamentById(t.tournamentId) === t;
}

/** tournamentReadyUpdate's payload (readyDeadlinePassed only between rounds). */
function readyUpdatePayload(t) {
    const payload = { players: t.getClientState().players, allReady: t.allPlayersReady() };
    if (t.phase === 'between_rounds') payload.readyDeadlinePassed = t.readyDeadlinePassed();
    return payload;
}

// ==================== ready deadline ====================

/**
 * Between rounds: start the deadline clock (the round just completed) or,
 * after a rolled-back start, re-arm what is left of it.
 */
function armReadyDeadline(io, t, { restart = true } = {}) {
    if (t.phase !== 'between_rounds' || !registered(t)) return;
    if (restart) {
        const ms = readyDeadlineMs();
        t.readyDeadlineAt = ms > 0 ? Date.now() + ms : null;
        t._changed?.();
    }
    if (t.readyDeadlineAt == null) return;
    const left = t.readyDeadlineAt - Date.now();
    if (left <= 0) return;
    t.setTimer('readyDeadline', left, () => onReadyDeadline(io, t));
}

function onReadyDeadline(io, t) {
    if (!registered(t) || !t.readyDeadlinePassed()) return;
    t.broadcast(io, 'tournamentReadyUpdate', readyUpdatePayload(t));
    if (!t.allPlayersReady()) {
        t.broadcast(io, 'tournamentMessage', systemLine('Players who are not ready will sit out the next round.'));
    }
    refreshHostIdle(io, t);
}

// ==================== host hand-off ====================

/** Connected members other than the host, and how many of them are ready. */
function readiness(t) {
    let others = 0;
    let ready = 0;
    for (const [socketId, player] of t.players) {
        if (socketId === t.createdBy || player.connected === false) continue;
        others++;
        if (t.readyPlayers.has(socketId)) ready++;
    }
    return { others, ready, hostReady: t.readyPlayers.has(t.createdBy) };
}

/** Past the deadline, the idle host's spell ends in a server start, not a hand-off. */
function startsInstead(t) {
    if (!t.readyDeadlinePassed()) return false;
    return t.handedOffThisWait || readiness(t).ready === 0;
}

/** The host could be waited on: idle, the others ready, not in a round. */
function hostIdleCondition(t) {
    if (t.phase !== 'lobby' && t.phase !== 'between_rounds') return false;
    const host = t.players.get(t.createdBy);
    if (!host || host.connected === false) return false;
    const { others, ready, hostReady } = readiness(t);
    if (others === 0) return false;
    if (ready === others) return true;
    if (!t.readyDeadlinePassed()) return false;
    // Past the deadline: someone to hand to, or someone to start with
    return startsInstead(t) ? ready + (hostReady ? 1 : 0) > 0 : ready > 0;
}

/**
 * Re-evaluate the idle-host clock after anything that changes readiness,
 * membership, the host or the phase. `hostActed`: the host did something
 * (ready / unready / chat), so the clock starts again.
 */
function refreshHostIdle(io, t, { hostActed = false } = {}) {
    if (!t || !registered(t)) return;
    if (hostActed) t.clearTimer('hostIdle');
    const ms = hostIdleMs();
    if (ms <= 0 || !hostIdleCondition(t)) {
        t.clearTimer('hostIdle');
        return;
    }
    if (t.hasTimer('hostIdle')) return;
    const host = t.createdBy;
    t.setTimer('hostIdle', ms, () => {
        if (!registered(t) || t.createdBy !== host || !hostIdleCondition(t)) {
            refreshHostIdle(io, t);
            return;
        }
        if (startsInstead(t)) startForIdleHost(io, t);
        else handOffHost(io, t);
    });
}

/** A member acted (ready / unready / chat): the host's action restarts its clock. */
function noteActivity(io, t, socketId) {
    if (!t) return;
    refreshHostIdle(io, t, { hostActed: t.createdBy === socketId });
}

function handOffHost(io, t) {
    const oldHost = t.players.get(t.createdBy);
    const oldName = oldHost?.username;
    const next = t.transferCreator({ preferReady: true });
    if (!next || next.username === oldName) return;
    socketLogger.info('Tournament host idle, role handed off', {
        tournamentId: t.tournamentId, from: oldName, to: next.username, phase: t.phase
    });
    // The same announcement as a host leaving; reason tells it apart
    t.broadcast(io, 'tournamentPlayerLeft', {
        username: oldName,
        players: t.getClientState().players,
        newCreator: next.username,
        reason: 'hostIdle'
    });
    t.broadcast(io, 'tournamentMessage', systemLine(`${oldName} was idle, so ${next.username} is now the host.`));
    if (t.phase === 'between_rounds') {
        t.handedOffThisWait = true;
        t._changed?.();
    }
    require('./gameLifecycle').emitLobbiesUpdated(io);
    refreshHostIdle(io, t);
}

/** Past the deadline: start the round the idle host has not begun. */
function startForIdleHost(io, t) {
    const name = t.players.get(t.createdBy)?.username;
    socketLogger.info('Tournament host idle past the ready deadline, round started by the server', {
        tournamentId: t.tournamentId, host: name, round: t.currentRound + 1
    });
    t.broadcast(io, 'tournamentMessage', systemLine(`${name} was idle, so the next round starts with the players who are ready.`));
    require('./tournamentHandlers').startNextRound(io, t).catch((error) => {
        socketLogger.error('Server start of a tournament round failed', { tournamentId: t.tournamentId, error: error.message });
    });
}

module.exports = {
    READY_DEADLINE_MS,
    HOST_IDLE_MS,
    readyDeadlineMs,
    hostIdleMs,
    systemLine,
    readyUpdatePayload,
    armReadyDeadline,
    refreshHostIdle,
    noteActivity,
    hostIdleCondition,
};
