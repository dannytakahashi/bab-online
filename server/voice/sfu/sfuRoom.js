/**
 * The SFU roster of a tournament's voice room (VOICE_SFU=tournament;
 * docs/claude/voice.md, "SFU voice (server)").
 *
 * Membership is tournamentVoice.js's: who is in the room (`t.voiceRoom.members`,
 * entered at tournamentCreated / tournamentJoined, left when seated, on a
 * leave, a disconnect, the main room, a cancel ...), in entry order. In an
 * SFU room the admitted members are the first config.roomMax() of the
 * members whose client sent the clientHello cap `sfuVoice` (recorded at
 * entry: `member.sfu`); a member without it is in the room but gets no voice
 * there at all (never a mesh peer list: an old client cannot be bridged into
 * an SFU room; PR 4 adds its "update to use voice" note).
 *
 * This module keeps, per username (a member's sockets change, its media
 * session at Cloudflare does not), `t.voiceRoom.sfu.entries`:
 *   {username, socketId, sessionId, sessionSocket, trackName, localMid, pulls}
 *   socketId       the member's socket in the room, null while it is away
 *   sessionId      its Cloudflare session (null until it needs one: a muted
 *                  listener in a room where nobody talks makes none)
 *   sessionSocket  the socket that created or resumed that session
 *   trackName/localMid  its one published audio track (null until its first
 *                  unmute: a muted-at-start member pushes nothing)
 *   pulls          mid -> {sessionId, trackName, username}: what it pulls
 *                  (for metrics and to enforce a block)
 * state: 'reconnecting' while it has a session that its current socket has
 * not resumed (it dropped, or came back on a new socket, or the server
 * restarted), else 'live'. A dropped member with a session stays listed as
 * reconnecting for config.graceMs() (38 s: Cloudflare keeps a session ~30-35 s
 * after its peer goes quiet), so a member back with the same session (an
 * ICE restart, a socket reconnect) costs nobody a re-pull; past the grace
 * its session is cleared (and, still away, it is gone).
 *
 * Events (all private, unsequenced; every one carries this process's
 * bootId, so a client sees a server restart, and the room's rev):
 *   sfuRoster  the full roster for one socket: on entry, on a re-entry of
 *              its lobby screen, when it is let in from the line or put in
 *              it (status admitted | waiting | out)
 *   sfuMember  one member's new record to every other admitted member
 *              (event joined | session | published | unpublished |
 *              reconnecting | resumed | left); a blocked pair never sees
 *              each other
 */

'use strict';

const gameManager = require('../../game/GameManager');
const config = require('./config');
const { createSessionQueues } = require('./sessionQueue');
const cf = require('./cloudflareClient');
const { safeTimeout, safeInterval } = require('../../utils/safeTimer');
const { socketLogger } = require('../../utils/logger');

const CAP = 'sfuVoice';
// A blocked pair's pulls still open this long after both were told (each
// client closes its own pull of the other first; this is the backstop)
const BLOCK_ENFORCE_MS = 5000;
const STATS_LOG_MS = 60000;

const queues = createSessionQueues();
const lazyGameVoice = () => require('../gameVoice');
const bootId = () => require('../../utils/instanceId').bootId;

let statsTimer = null;

function sfuState(t) {
    const room = t.voiceRoom;
    if (!room.sfu) {
        room.sfu = {
            rev: 0,
            entries: new Map(),
            waiting: new Set(),
            io: null,
            stats: newStats(),
        };
    }
    return room.sfu;
}

function newStats() {
    return { calls: 0, errors: 0, sessionGone: 0, timeouts: 0, byOp: {}, sessions: 0, pushed: 0, pulled: 0, pullErrors: 0, refused: 0, dirty: false };
}

const isSfuRoom = (t) => t?.voiceRoom?.mode === 'sfu';
const liveSocket = (io, sid) => !!sid && !!io?.sockets?.sockets?.get(sid);
const stateOf = (e) => (e.sessionId && e.sessionSocket !== e.socketId ? 'reconnecting' : 'live');
const wire = (e) => ({ username: e.username, sessionId: e.sessionId, trackName: e.trackName, state: stateOf(e) });

function registered(t) {
    return !!t && !t.retired && gameManager.tournaments.get(t.tournamentId) === t;
}

function blocked(io, a, b) {
    return lazyGameVoice().blockedPair(io, a.socketId, a.username, b.socketId, b.username);
}

/** The admitted and waiting SFU members of `t`, from the room record: [{socketId, username}] each, in entry order. */
function lineup(t) {
    const all = [...t.voiceRoom.members.entries()]
        .filter(([, m]) => m.sfu === true)
        .sort((a, b) => a[1].order - b[1].order)
        .map(([socketId, m]) => ({ socketId, username: m.username }));
    const cap = config.roomMax();
    return { admitted: all.slice(0, cap), waiting: all.slice(cap), cap };
}

function rosterFor(io, t, me, status) {
    const s = sfuState(t);
    const members = me
        ? [...s.entries.values()].filter((e) => e !== me && !blocked(io, me, e)).map(wire)
        : [];
    return {
        tournamentId: t.tournamentId,
        bootId: bootId(),
        rev: s.rev,
        status,
        cap: config.roomMax(),
        graceMs: config.graceMs(),
        self: me ? { sessionId: me.sessionId, trackName: me.trackName, state: stateOf(me) } : null,
        members,
    };
}

function sendRoster(io, t, sid, me, status) {
    if (!io || !liveSocket(io, sid)) return;
    io.to(sid).emit('sfuRoster', rosterFor(io, t, me, status));
}

/** `entry`'s new record to every other admitted member with a live socket (blocked pairs left out). */
function announce(io, t, entry, event) {
    const s = sfuState(t);
    s.rev++;
    if (!io) return;
    const payload = { tournamentId: t.tournamentId, bootId: bootId(), rev: s.rev, event, member: wire(entry) };
    for (const other of s.entries.values()) {
        if (other === entry || !liveSocket(io, other.socketId) || blocked(io, entry, other)) continue;
        io.to(other.socketId).emit('sfuMember', payload);
    }
}

function clearGrace(entry) {
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
}

function startGrace(t, entry) {
    if (entry.graceTimer) return;
    const timer = safeTimeout(() => graceOver(t, entry), config.graceMs(), 'sfuGrace');
    if (timer && typeof timer.unref === 'function') timer.unref();
    entry.graceTimer = timer;
}

function graceOver(t, entry) {
    entry.graceTimer = null;
    if (!registered(t) || !isSfuRoom(t)) return;
    const s = sfuState(t);
    if (s.entries.get(entry.username) !== entry || stateOf(entry) !== 'reconnecting') return;
    socketLogger.info('Voice SFU: reconnect grace over', { tournamentId: t.tournamentId, username: entry.username, away: entry.socketId === null });
    dropSession(entry, 'session_gone');
    if (entry.socketId === null) {
        s.entries.delete(entry.username);
        announce(s.io, t, entry, 'left');
    } else {
        announce(s.io, t, entry, 'session');
    }
}

/** Forget `entry`'s session (its queued work answered `reason`). */
function dropSession(entry, reason) {
    if (entry.sessionId) queues.drop(entry.sessionId, reason);
    entry.sessionId = null;
    entry.sessionSocket = null;
    entry.trackName = null;
    entry.localMid = null;
    entry.pulls.clear();
}

function removeEntry(io, t, entry, { tell = true } = {}) {
    const s = sfuState(t);
    clearGrace(entry);
    if (entry.sessionId) queues.drop(entry.sessionId, 'not_in_room');
    queues.drop(`member:${t.tournamentId}:${entry.username}`, 'not_in_room');
    s.entries.delete(entry.username);
    if (tell) announce(io, t, entry, 'left');
    if (liveSocket(io, entry.socketId)) sendRoster(io, t, entry.socketId, null, 'out');
}

/**
 * The room record changed (tournamentVoice.change in an SFU room): bring the
 * roster in line. `closing`: the room closes (cancel, the results window's
 * end): everyone is removed, nobody kept as reconnecting.
 */
function sync(io, t, { closing = false } = {}) {
    const s = sfuState(t);
    if (io) s.io = io;
    const { admitted, waiting, cap } = lineup(t);
    const inRoom = new Map(admitted.map((p) => [p.username, p.socketId]));
    // The room's last stats line, with who was still in it
    if (closing) logStats(t, 'closed');

    // Gone from the room: dropped with a session = reconnecting; else left
    for (const entry of [...s.entries.values()]) {
        if (inRoom.has(entry.username)) continue;
        const dropped = !closing && entry.sessionId && !liveSocket(io, entry.socketId);
        if (dropped) {
            if (entry.socketId !== null) {
                const was = stateOf(entry);
                entry.socketId = null;
                startGrace(t, entry);
                if (was !== 'reconnecting') announce(io, t, entry, 'reconnecting');
            }
            continue;
        }
        removeEntry(io, t, entry, { tell: !closing });
    }

    // In the room: new members, and members on a new socket
    for (const { socketId, username } of admitted) {
        s.waiting.delete(socketId);
        const entry = s.entries.get(username);
        if (!entry) {
            const e = { username, socketId, sessionId: null, sessionSocket: null, trackName: null, localMid: null, pulls: new Map(), graceTimer: null };
            s.entries.set(username, e);
            sendRoster(io, t, socketId, e, 'admitted');
            announce(io, t, e, 'joined');
            continue;
        }
        if (entry.socketId === socketId) continue;
        const was = stateOf(entry);
        const oldSocket = entry.socketId;
        entry.socketId = socketId;
        if (stateOf(entry) === 'reconnecting') startGrace(t, entry);
        // An older socket of this user still open hears it is out
        if (oldSocket && liveSocket(io, oldSocket)) sendRoster(io, t, oldSocket, null, 'out');
        sendRoster(io, t, socketId, entry, 'admitted');
        if (stateOf(entry) !== was) announce(io, t, entry, stateOf(entry) === 'reconnecting' ? 'reconnecting' : 'resumed');
    }

    // The line past the ceiling (only SFU-capable members wait in it)
    const waitingIds = new Set(waiting.map((p) => p.socketId));
    for (const sid of [...s.waiting]) if (!waitingIds.has(sid)) s.waiting.delete(sid);
    for (const { socketId } of waiting) {
        if (s.waiting.has(socketId)) continue;
        s.waiting.add(socketId);
        sendRoster(io, t, socketId, null, 'waiting');
    }
    if (waiting.length > 0) socketLogger.info('Voice SFU: room full', { tournamentId: t.tournamentId, cap, waiting: waiting.length });
    ensureStatsTimer();
}

/** The socket drew its lobby screen again (tournamentJoined while in the room): its roster again. */
function relist(io, t, sid) {
    const s = sfuState(t);
    const me = [...s.entries.values()].find((e) => e.socketId === sid);
    if (me) return sendRoster(io, t, sid, me, 'admitted');
    if (s.waiting.has(sid)) return sendRoster(io, t, sid, null, 'waiting');
    return undefined;
}

/** Is `sid` an admitted member of `t`'s SFU room? */
function isMember(t, sid) {
    if (!isSfuRoom(t) || !t.voiceRoom.sfu) return false;
    for (const e of t.voiceRoom.sfu.entries.values()) if (e.socketId === sid) return true;
    return false;
}

/** `sid`'s SFU membership: {t, entry} or null. */
function memberOf(sid) {
    const tid = gameManager.playerTournaments.get(sid);
    if (tid === undefined) return null;
    const t = gameManager.tournaments.get(tid);
    if (!registered(t) || !isSfuRoom(t) || !t.voiceRoom.sfu) return null;
    if (gameManager.playerGames.has(sid) || gameManager.playerLobbies.has(sid) || gameManager.spectatorGames.has(sid)) return null;
    for (const e of t.voiceRoom.sfu.entries.values()) if (e.socketId === sid) return { t, entry: e };
    return null;
}

/** Is `entry` (still) the live record that owns `sessionId` on `sid`? */
function ownsSession(t, entry, sid, sessionId) {
    return registered(t) && isSfuRoom(t) && sfuState(t).entries.get(entry.username) === entry &&
        entry.socketId === sid && entry.sessionId === sessionId && entry.sessionSocket === sid;
}

/** The member made a new Cloudflare session on its socket. */
function setSession(io, t, entry, sessionId) {
    const s = sfuState(t);
    const old = entry.sessionId;
    if (old && old !== sessionId) queues.drop(old, 'superseded');
    clearGrace(entry);
    entry.sessionId = sessionId;
    entry.sessionSocket = entry.socketId;
    entry.trackName = null;
    entry.localMid = null;
    entry.pulls.clear();
    s.stats.sessions++;
    announce(io, t, entry, 'session');
}

/** The member re-registered a session it holds (after a reconnect or a deploy). */
function resume(io, t, entry, { sessionId, trackName, mid, pulls = [] }) {
    const same = entry.sessionId === sessionId;
    if (entry.sessionId && !same) queues.drop(entry.sessionId, 'superseded');
    const was = stateOf(entry);
    const changed = !same || entry.trackName !== trackName;
    clearGrace(entry);
    entry.sessionId = sessionId;
    entry.sessionSocket = entry.socketId;
    entry.trackName = trackName;
    entry.localMid = trackName ? mid : null;
    if (!same) entry.pulls.clear();
    for (const p of pulls) entry.pulls.set(p.mid, { sessionId: p.sessionId, trackName: p.trackName, username: usernameOfTrack(t, p.sessionId, p.trackName) });
    if (changed) announce(io, t, entry, 'session');
    else if (was === 'reconnecting') announce(io, t, entry, 'resumed');
}

function usernameOfTrack(t, sessionId, trackName) {
    for (const e of sfuState(t).entries.values()) if (e.sessionId === sessionId && e.trackName === trackName) return e.username;
    return null;
}

/** The member's track is published (its push answered with no track error). */
function published(io, t, entry, trackName, mid) {
    entry.trackName = trackName;
    entry.localMid = mid;
    sfuState(t).stats.pushed++;
    announce(io, t, entry, 'published');
}

/** Tracks closed on the member's session: its own (unpublished) and / or pulls. */
function closed(io, t, entry, mids) {
    const set = new Set(mids.map(String));
    for (const mid of set) entry.pulls.delete(mid);
    if (entry.localMid && set.has(entry.localMid)) {
        entry.trackName = null;
        entry.localMid = null;
        announce(io, t, entry, 'unpublished');
    }
}

/** The member said it is done with its session (sfuLeave), or Cloudflare answered 410 on it. */
function endSession(io, t, entry, reason) {
    if (!entry.sessionId) return;
    dropSession(entry, reason);
    clearGrace(entry);
    announce(io, t, entry, 'session');
}

/**
 * Which of `tracks` ({sessionId, trackName}) may `entry` pull? Only the
 * current published track of another member of the same room (live or
 * reconnecting), never one of a blocked pair.
 * @returns {{allowed: Array, refused: Array}}
 */
function checkPulls(io, t, entry, tracks) {
    const s = sfuState(t);
    const allowed = [];
    const refused = [];
    const seen = new Set();
    for (const tr of tracks) {
        const key = `${tr.sessionId}|${tr.trackName}`;
        const owner = [...s.entries.values()].find((e) => e.sessionId === tr.sessionId && e.trackName === tr.trackName && e.trackName);
        const out = { username: owner?.username ?? null, sessionId: tr.sessionId, trackName: tr.trackName };
        let code = null;
        if (seen.has(key)) code = 'duplicate';
        else if (!owner) code = 'not_in_room';
        else if (owner === entry) code = 'own_track';
        else if (blocked(io, entry, owner)) code = 'blocked';
        // Cloudflare lets one session pull the same track again and again
        // (seen live 2026-11-26): at most the room's ceiling of open pulls,
        // so one client cannot multiply the room's egress
        else if (entry.pulls.size + allowed.length >= config.roomMax()) code = 'too_many_pulls';
        seen.add(key);
        if (code) refused.push({ ...out, mid: null, errorCode: code, errorDescription: null });
        else allowed.push(out);
    }
    s.stats.refused += refused.length;
    return { allowed, refused };
}

/** Pulls Cloudflare answered with a mid and no error: remember them. */
function pulledOk(t, entry, results) {
    const s = sfuState(t);
    for (const r of results) {
        if (r.mid && !r.errorCode) {
            entry.pulls.set(r.mid, { sessionId: r.sessionId, trackName: r.trackName, username: r.username });
            s.stats.pulled++;
        } else {
            s.stats.pullErrors++;
        }
    }
}

/** Count one Cloudflare call of this room (metrics; never a body). */
function countCall(t, op, r) {
    if (!t?.voiceRoom) return;
    const st = sfuState(t).stats;
    st.calls++;
    st.dirty = true;
    st.byOp[op] = (st.byOp[op] || 0) + 1;
    if (r && !r.ok) {
        st.errors++;
        if (r.error?.code === 'session_gone') st.sessionGone++;
        if (r.error?.code === 'timeout') st.timeouts++;
    }
}

function logStats(t, why) {
    const s = t?.voiceRoom?.sfu;
    if (!s || !s.stats.dirty) return;
    const { dirty, byOp, ...counts } = s.stats;
    const tracks = [...s.entries.values()].reduce((n, e) => n + e.pulls.size, 0);
    socketLogger.info('Voice SFU: room stats', {
        tournamentId: t.tournamentId, why, members: s.entries.size,
        publishing: [...s.entries.values()].filter((e) => e.trackName).length,
        pullsOpen: tracks, ...counts, byOp: { ...byOp },
    });
    s.stats.dirty = false;
}

function ensureStatsTimer() {
    if (statsTimer) return;
    statsTimer = safeInterval(() => {
        for (const t of gameManager.tournaments.values()) if (isSfuRoom(t)) logStats(t, 'periodic');
    }, STATS_LOG_MS, 'sfuRoomStats');
    if (typeof statsTimer.unref === 'function') statsTimer.unref();
}

/**
 * A block between two members of an SFU room (safetyHandlers.blockUser via
 * gameVoice.endBlockedCall): each is told the other left (they close their
 * pulls of each other); BLOCK_ENFORCE_MS later any pull between them still
 * open is closed at Cloudflare by force (a client that ignored it).
 * @returns {boolean} they shared an SFU room
 */
function blockedPairFound(io, aSid, bSid) {
    const a = memberOf(aSid);
    const b = memberOf(bSid);
    if (!a || !b || a.t !== b.t) return false;
    const t = a.t;
    const payload = (e) => ({ tournamentId: t.tournamentId, bootId: bootId(), rev: ++sfuState(t).rev, event: 'left', member: wire(e) });
    io.to(aSid).emit('sfuMember', payload(b.entry));
    io.to(bSid).emit('sfuMember', payload(a.entry));
    const timer = safeTimeout(() => enforceBlock(t, a.entry, b.entry), BLOCK_ENFORCE_MS, 'sfuBlockEnforce');
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
}

function enforceBlock(t, a, b) {
    if (!registered(t) || !isSfuRoom(t)) return;
    for (const [sub, pub] of [[a, b], [b, a]]) {
        if (!sub.sessionId) continue;
        const mids = [...sub.pulls.entries()].filter(([, p]) => p.username === pub.username).map(([mid]) => mid);
        if (mids.length === 0) continue;
        const sessionId = sub.sessionId;
        queues.run(sessionId, async () => {
            if (sub.sessionId !== sessionId) return null;
            const r = await cf.close(sessionId, mids, { force: true });
            countCall(t, 'close(block)', r);
            if (r.ok) for (const mid of mids) sub.pulls.delete(mid);
            socketLogger.info('Voice SFU: blocked pair pulls closed by force', { tournamentId: t.tournamentId, tracks: mids.length, ok: r.ok, status: r.status });
            return null;
        });
    }
}

/** Tests only: forget the queues and the stats timer. */
function _resetForTests() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
}

module.exports = {
    CAP,
    BLOCK_ENFORCE_MS,
    queues,
    isSfuRoom,
    sync,
    relist,
    isMember,
    memberOf,
    ownsSession,
    setSession,
    resume,
    published,
    closed,
    endSession,
    checkPulls,
    pulledOk,
    countCall,
    logStats,
    blockedPairFound,
    stateOf,
    wire,
    rosterFor,
    _resetForTests,
};
