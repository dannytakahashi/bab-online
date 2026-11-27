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
 *   {username, socketId, sessionId, sessionSocket, trackName, localMid, pulls,
 *    recent, blocks, pending}
 *   socketId       the member's socket in the room, null while it is away
 *   sessionId      its Cloudflare session (null until it needs one: a muted
 *                  listener in a room where nobody talks makes none)
 *   sessionSocket  the socket that created or resumed that session
 *   trackName/localMid  its one published audio track (null until its first
 *                  unmute: a muted-at-start member pushes nothing)
 *   pulls          mid -> {sessionId, trackName, username}: what it pulls
 *                  (metrics, duplicates, a fallback when Cloudflare's GET fails)
 *   recent         its last RECENT_MAX earlier session ids, newest first (a
 *                  block also closes pulls of, and on, those)
 *   blocks         its block list (a Set of usernames) or null while unknown:
 *                  snapshotted from its socket at entry, kept current by
 *                  blockListChanged (voiceHandlers.rememberBlockList, from any
 *                  socket of the user), loaded from the user document when
 *                  missing; a pair with an unknown list is treated as blocked
 *                  (fail closed, like voiceHandlers.blockedBy)
 *   pending        `${sessionId}|${trackName}` of pulls asked and not yet answered
 * state: 'reconnecting' while it has a session that its current socket has
 * not resumed (it dropped, or came back on a new socket, or the server
 * restarted), else 'live'. A dropped member with a session stays listed as
 * reconnecting for config.graceMs() (38 s: Cloudflare keeps a session ~30-35 s
 * after its peer goes quiet), so a member back with the same session (an
 * ICE restart, a socket reconnect) costs nobody a re-pull; past the grace
 * its session is cleared (and, still away, it is gone).
 *
 * Revocation: only the server can stop a session from hearing the room (an
 * honest client closes its own pulls; a modified one need not). Whenever the
 * server stops holding a session for a member (it left the room, the room
 * closed, the session was replaced by a new one or a resume of another, the
 * grace ran out, sfuLeave), every remote track that session pulls is closed
 * at Cloudflare by force (GET sessions/{sid} lists them; the record of pulls
 * is the fallback when that fails), and the session id is remembered as
 * ended: an sfuResume of it answers session_gone. A pull Cloudflare answered
 * after its asker lost the session is closed the same way (sfuHandlers).
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
// Earlier sessions per member a block still looks at; sessions ended per room remembered
const RECENT_MAX = 4;
const ENDED_MAX = 1024;
// A missing block list is looked up again at most this often
const BLOCKS_RETRY_MS = 10000;
// Cloudflare: at most 64 tracks per request
const CLOSE_BATCH = 64;

const queues = createSessionQueues();
const bootId = () => require('../../utils/instanceId').bootId;

let statsTimer = null;

function sfuState(t) {
    const room = t.voiceRoom;
    if (!room.sfu) {
        room.sfu = {
            rev: 0,
            entries: new Map(),
            waiting: new Set(),
            ended: new Set(),
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

/**
 * `e`'s block list, or null while unknown (a lookup is started). Never the
 * socket's own Set: a copy, kept current by blockListChanged.
 */
function blocksOf(t, e) {
    if (e.blocks instanceof Set) return e.blocks;
    loadBlocks(t, e);
    return null;
}

/** Must `a` and `b` not hear each other? Either list names the other, or either is unknown (fail closed). */
function blocked(t, a, b) {
    const la = blocksOf(t, a);
    const lb = blocksOf(t, b);
    if (!la || !lb) return true;
    return la.has(b.username) || lb.has(a.username);
}

/** The block list a socket holds now, copied, or null. */
function socketBlocks(io, sid) {
    const list = io?.sockets?.sockets?.get(sid)?.data?.blockedUsers;
    return list instanceof Set ? new Set(list) : null;
}

/** Fill in `e`'s unknown block list: its socket's, else the user document's. */
function loadBlocks(t, e) {
    if (e.blocksLoading || (e.blocksTriedAt && Date.now() - e.blocksTriedAt < BLOCKS_RETRY_MS)) return;
    e.blocksLoading = true;
    e.blocksTriedAt = Date.now();
    Promise.resolve().then(async () => {
        let list = socketBlocks(sfuState(t).io, e.socketId);
        if (!list) {
            let users = null;
            try {
                users = require('../../database').getUsersCollection();
            } catch (_) {
                users = null;
            }
            const doc = users ? await users.findOne({ username: e.username }, { projection: { blockedUsers: 1 } }) : null;
            list = doc ? new Set(doc.blockedUsers || []) : null;
        }
        e.blocksLoading = false;
        if (list && !(e.blocks instanceof Set) && sfuState(t).entries.get(e.username) === e) setBlocks(t, e, list);
        else if (!list) socketLogger.warn('Voice SFU: block list unknown, the member is kept apart', { tournamentId: t.tournamentId, username: e.username });
    }).catch((err) => {
        e.blocksLoading = false;
        socketLogger.warn('Voice SFU: block list lookup failed', { tournamentId: t.tournamentId, username: e.username, error: err?.message });
    });
}

/**
 * `e`'s block list is now `next`: every pair whose standing changed hears
 * it (a new block: `left` both ways and the force close; an unblock, or a
 * list that was unknown: `joined` both ways).
 */
function setBlocks(t, e, next) {
    const s = sfuState(t);
    const before = new Map();
    for (const o of s.entries.values()) if (o !== e) before.set(o, blocked(t, e, o));
    e.blocks = next;
    for (const [o, was] of before) {
        if (s.entries.get(o.username) !== o) continue;
        const now = blocked(t, e, o);
        if (!was && now) hidePair(t, e, o);
        else if (was && !now) showPair(t, e, o);
    }
}

/** Tell `to` (if its socket is live) `event` for `about`. */
function tellOne(t, to, about, event) {
    const s = sfuState(t);
    if (!s.io || !liveSocket(s.io, to.socketId)) return;
    s.io.to(to.socketId).emit('sfuMember', { tournamentId: t.tournamentId, bootId: bootId(), rev: ++s.rev, event, member: wire(about) });
}

/** A new block between `a` and `b`: each hears the other left; BLOCK_ENFORCE_MS later their pulls of each other are closed by force. */
function hidePair(t, a, b) {
    tellOne(t, a, b, 'left');
    tellOne(t, b, a, 'left');
    const seeds = { [a.username]: [a.sessionId, ...a.recent], [b.username]: [b.sessionId, ...b.recent] };
    const timer = safeTimeout(() => enforceBlock(t, a.username, b.username, seeds), BLOCK_ENFORCE_MS, 'sfuBlockEnforce');
    if (timer && typeof timer.unref === 'function') timer.unref();
    socketLogger.info('Voice SFU: blocked pair kept apart', { tournamentId: t.tournamentId, a: a.username, b: b.username, away: [a, b].filter((e) => e.socketId === null).length });
}

/** `a` and `b` may hear each other again: each gets the other's record. */
function showPair(t, a, b) {
    tellOne(t, a, b, 'joined');
    tellOne(t, b, a, 'joined');
}

/**
 * A socket's block list was set (voiceHandlers.rememberBlockList: sign-in,
 * blockUser / unblockUser, a lookup, a rename): the user's SFU entries take
 * it, from whichever socket of the user it came.
 */
function blockListChanged(socket, list) {
    const username = gameManager.getUserBySocketId(socket?.id)?.username;
    if (!username) return;
    for (const t of gameManager.tournaments.values()) {
        if (!registered(t) || !isSfuRoom(t) || !t.voiceRoom.sfu) continue;
        const e = t.voiceRoom.sfu.entries.get(username);
        if (e) setBlocks(t, e, new Set(list));
    }
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
        ? [...s.entries.values()].filter((e) => e !== me && !blocked(t, me, e)).map(wire)
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
        if (other === entry || !liveSocket(io, other.socketId) || blocked(t, entry, other)) continue;
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
    dropSession(t, entry, 'session_gone', 'grace');
    if (entry.socketId === null) {
        s.entries.delete(entry.username);
        announce(s.io, t, entry, 'left');
    } else {
        announce(s.io, t, entry, 'session');
    }
}

/** Forget `entry`'s session (its queued work answered `reason`; `why`: see retire). */
function dropSession(t, entry, reason, why) {
    const sessionId = entry.sessionId;
    const known = [...entry.pulls.keys()];
    if (sessionId) queues.drop(sessionId, reason);
    entry.sessionId = null;
    entry.sessionSocket = null;
    entry.trackName = null;
    entry.localMid = null;
    entry.pulls.clear();
    if (sessionId) retire(t, entry, sessionId, why, known);
}

/**
 * `sessionId` is no longer `entry`'s: remember it (recent, the room's ended
 * set) and close every track it pulls at Cloudflare by force (`known`: the
 * recorded mids, used if Cloudflare cannot list them). `why` 'session_gone'
 * (a 410): nothing to close.
 */
function retire(t, entry, sessionId, why, known = []) {
    const s = sfuState(t);
    entry.recent = [sessionId, ...entry.recent.filter((x) => x !== sessionId)].slice(0, RECENT_MAX);
    s.ended.add(sessionId);
    if (s.ended.size > ENDED_MAX) s.ended.delete(s.ended.values().next().value);
    if (why !== 'session_gone') revokePulls(t, sessionId, why, known);
}

/** Did this process end `sessionId` in `t`'s room (left, replaced, past the grace, sfuLeave, 410)? */
function wasEnded(t, sessionId) {
    return !!t?.voiceRoom?.sfu && t.voiceRoom.sfu.ended.has(sessionId);
}

/**
 * The mids of `sessionId`'s remote tracks that `pick(track)` keeps, from
 * Cloudflare (GET sessions/{sid}); null when the session is gone (410);
 * `fallback` when the GET fails otherwise.
 */
async function remoteMids(t, sessionId, pick, fallback) {
    const g = await cf.getSession(sessionId);
    countCall(t, 'get', g);
    if (!g.ok) return g.error?.code === 'session_gone' ? null : fallback;
    return g.body.tracks.filter((tr) => tr.location === 'remote' && tr.mid && pick(tr)).map((tr) => tr.mid);
}

/** tracks/close force on `mids` (batches of 64). @returns {Promise<boolean>} every call ok */
async function forceClose(t, sessionId, mids, op) {
    let ok = true;
    for (let i = 0; i < mids.length; i += CLOSE_BATCH) {
        const r = await cf.close(sessionId, mids.slice(i, i + CLOSE_BATCH), { force: true });
        countCall(t, op, r);
        if (!r.ok) ok = false;
    }
    return ok;
}

/** Queue (server work, after anything running) the force close of every track `sessionId` pulls. */
function revokePulls(t, sessionId, why, known = []) {
    queues.run(sessionId, async () => {
        const mids = await remoteMids(t, sessionId, () => true, known);
        if (!mids || mids.length === 0) return null;
        const ok = await forceClose(t, sessionId, mids, 'close(revoke)');
        socketLogger.info('Voice SFU: pulls revoked', { tournamentId: t.tournamentId, why, tracks: mids.length, ok });
        return null;
    }, { internal: true });
}

/** Queue the force close of `mids` on `sessionId` (a pull Cloudflare answered after its asker lost the session). */
function closeLate(t, sessionId, mids, why) {
    if (!mids.length) return;
    queues.run(sessionId, async () => {
        const ok = await forceClose(t, sessionId, mids, 'close(late)');
        socketLogger.info('Voice SFU: late pulls closed', { tournamentId: t.tournamentId, why, tracks: mids.length, ok });
        return null;
    }, { internal: true });
}

function removeEntry(io, t, entry, { tell = true } = {}) {
    const s = sfuState(t);
    clearGrace(entry);
    if (entry.sessionId) {
        const known = [...entry.pulls.keys()];
        queues.drop(entry.sessionId, 'not_in_room');
        retire(t, entry, entry.sessionId, 'left', known);
    }
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
            const e = {
                username, socketId, sessionId: null, sessionSocket: null, trackName: null, localMid: null, pulls: new Map(), graceTimer: null,
                recent: [], blocks: socketBlocks(io, socketId), blocksLoading: false, blocksTriedAt: 0, pending: new Set(),
            };
            s.entries.set(username, e);
            sendRoster(io, t, socketId, e, 'admitted');
            announce(io, t, e, 'joined');
            continue;
        }
        if (entry.socketId === socketId) continue;
        const was = stateOf(entry);
        const oldSocket = entry.socketId;
        entry.socketId = socketId;
        // A list kept current by blockListChanged wins over a socket's
        // (possibly older) copy; an unknown one takes the socket's
        if (!(entry.blocks instanceof Set)) {
            const list = socketBlocks(io, socketId);
            if (list) setBlocks(t, entry, list);
        }
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
    const known = [...entry.pulls.keys()];
    if (old && old !== sessionId) queues.drop(old, 'superseded');
    clearGrace(entry);
    entry.sessionId = sessionId;
    entry.sessionSocket = entry.socketId;
    entry.trackName = null;
    entry.localMid = null;
    entry.pulls.clear();
    if (old && old !== sessionId) retire(t, entry, old, 'superseded', known);
    s.stats.sessions++;
    announce(io, t, entry, 'session');
}

/** The member re-registered a session it holds (after a reconnect or a deploy). */
function resume(io, t, entry, { sessionId, trackName, mid, pulls = [] }) {
    const same = entry.sessionId === sessionId;
    const old = entry.sessionId;
    const known = [...entry.pulls.keys()];
    if (old && !same) queues.drop(old, 'superseded');
    const was = stateOf(entry);
    const changed = !same || entry.trackName !== trackName;
    clearGrace(entry);
    entry.sessionId = sessionId;
    entry.sessionSocket = entry.socketId;
    entry.trackName = trackName;
    entry.localMid = trackName ? mid : null;
    if (!same) entry.pulls.clear();
    if (old && !same) retire(t, entry, old, 'superseded', known);
    // A pull it says it holds of someone it is blocked with (a block made
    // while it was away, or after a restart): closed by force
    const barred = [];
    for (const p of pulls) {
        entry.pulls.set(p.mid, { sessionId: p.sessionId, trackName: p.trackName, username: usernameOfTrack(t, p.sessionId, p.trackName) });
        const owner = ownerOfSession(t, p.sessionId);
        if (owner && owner !== entry && blocked(t, entry, owner)) barred.push(p.mid);
    }
    if (barred.length) {
        for (const m of barred) entry.pulls.delete(m);
        closeLate(t, sessionId, barred, 'blocked');
    }
    if (changed) announce(io, t, entry, 'session');
    else if (was === 'reconnecting') announce(io, t, entry, 'resumed');
}

function usernameOfTrack(t, sessionId, trackName) {
    for (const e of sfuState(t).entries.values()) if (e.sessionId === sessionId && e.trackName === trackName) return e.username;
    return null;
}

/** The member whose current or recent session is `sessionId`, or null. */
function ownerOfSession(t, sessionId) {
    for (const e of sfuState(t).entries.values()) if (e.sessionId === sessionId || e.recent.includes(sessionId)) return e;
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
    dropSession(t, entry, reason, reason === 'session_gone' ? 'session_gone' : 'leave');
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
    const held = new Set([...entry.pulls.values()].map((p) => `${p.sessionId}|${p.trackName}`));
    for (const tr of tracks) {
        const key = `${tr.sessionId}|${tr.trackName}`;
        const owner = [...s.entries.values()].find((e) => e.sessionId === tr.sessionId && e.trackName === tr.trackName && e.trackName);
        const out = { username: owner?.username ?? null, sessionId: tr.sessionId, trackName: tr.trackName };
        let code = null;
        let description = null;
        if (seen.has(key)) code = 'duplicate';
        else if (!owner) code = 'not_in_room';
        else if (owner === entry) code = 'own_track';
        else if (blocked(t, entry, owner)) code = 'blocked';
        // Cloudflare lets one session pull the same track again and again
        // (seen live 2026-11-26): a track this session pulls already, or
        // whose pull is still being asked, is refused, so one client cannot
        // multiply the room's egress
        else if (held.has(key) || entry.pending.has(key)) {
            code = 'duplicate';
            const mid = [...entry.pulls.entries()].find(([, p]) => `${p.sessionId}|${p.trackName}` === key)?.[0];
            description = mid !== undefined ? `already pulled as mid ${mid}` : 'a pull of it is in progress';
        }
        // ... and a session's open pulls at most the room's ceiling (a
        // backstop: distinct tracks are fewer than the members)
        else if (entry.pulls.size + entry.pending.size + allowed.length >= config.roomMax()) code = 'too_many_pulls';
        seen.add(key);
        if (code) refused.push({ ...out, mid: null, errorCode: code, errorDescription: description });
        else allowed.push(out);
    }
    for (const a of allowed) entry.pending.add(`${a.sessionId}|${a.trackName}`);
    s.stats.refused += refused.length;
    return { allowed, refused };
}

/** The pulls checkPulls reserved for `allowed` are answered (or never asked). */
function releasePulls(entry, allowed) {
    for (const a of allowed) entry.pending.delete(`${a.sessionId}|${a.trackName}`);
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

/** Every SFU room's stats line now (a shutdown or handoff: the 60 s line would be lost). */
function logAllStats(why) {
    for (const t of gameManager.tournaments.values()) {
        try {
            if (isSfuRoom(t)) logStats(t, why);
        } catch (_) { /* never in a shutdown's way */ }
    }
}

function ensureStatsTimer() {
    if (statsTimer) return;
    statsTimer = safeInterval(() => {
        for (const t of gameManager.tournaments.values()) if (isSfuRoom(t)) logStats(t, 'periodic');
    }, STATS_LOG_MS, 'sfuRoomStats');
    if (typeof statsTimer.unref === 'function') statsTimer.unref();
}

/**
 * gameVoice.endBlockedCall for two sockets of one SFU room. The block itself
 * was handled when the blocker's list changed (blockListChanged, called by
 * rememberBlockList before blockUser ends calls): `left` both ways and the
 * force close, for a member away in its grace as well.
 * @returns {boolean} they shared an SFU room
 */
function blockedPairFound(io, aSid, bSid) {
    const a = memberOf(aSid);
    const b = memberOf(bSid);
    return !!(a && b && a.t === b.t);
}

/**
 * The force close of a blocked pair's pulls of each other, BLOCK_ENFORCE_MS
 * after both were told (each client closes its own first; this is the
 * backstop for one that did not). Resolved when each job runs, from
 * Cloudflare's own list of what each session pulls: every remote track on
 * a session of one (current or recent, or `seeds`: those at the block)
 * whose source is a session of the other. Never from a username stored with
 * a pull (unknown for a pull re-registered before its publisher resumed).
 */
function enforceBlock(t, aName, bName, seeds = {}) {
    if (!registered(t) || !isSfuRoom(t) || !t.voiceRoom.sfu) return;
    const s = t.voiceRoom.sfu;
    const sessionsOf = (name) => {
        const e = s.entries.get(name);
        return new Set([...(seeds[name] || []), ...(e ? [e.sessionId, ...e.recent] : [])].filter(Boolean));
    };
    for (const [sub, pub] of [[aName, bName], [bName, aName]]) {
        for (const sessionId of sessionsOf(sub)) {
            queues.run(sessionId, async () => {
                const pubs = sessionsOf(pub);
                const e = s.entries.get(sub);
                const current = e && e.sessionId === sessionId ? e : null;
                const known = current ? [...current.pulls.entries()].filter(([, p]) => pubs.has(p.sessionId)).map(([mid]) => mid) : [];
                const mids = await remoteMids(t, sessionId, (tr) => pubs.has(tr.sessionId), known);
                if (!mids || mids.length === 0) return null;
                const ok = await forceClose(t, sessionId, mids, 'close(block)');
                if (ok && current && current.sessionId === sessionId) for (const mid of mids) current.pulls.delete(mid);
                socketLogger.info('Voice SFU: blocked pair pulls closed by force', { tournamentId: t.tournamentId, tracks: mids.length, ok });
                return null;
            }, { internal: true });
        }
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
    releasePulls,
    pulledOk,
    closeLate,
    wasEnded,
    blockListChanged,
    logAllStats,
    countCall,
    logStats,
    blockedPairFound,
    stateOf,
    wire,
    rosterFor,
    _resetForTests,
};
