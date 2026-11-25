/**
 * Tournament voice (owner 2026-11-24: "in a tournament nobody had voice,
 * even with two humans at the same table"; docs/claude/voice.md,
 * "Tournament voice"). Two voice rooms, both whole-room, muted at the
 * start, no voice alone (the clients' rule), and neither has casual voice
 * (no casualVoice, voiceSettings or voice spectators: gameVoice.js):
 *
 *   1. A round's table: game:<id>, the seat owners (gameVoice.voiceRoomOf
 *      maps them already; offers relayed there before this module too).
 *      What was missing was the announcement: `announceTable` gives each
 *      connected human owner, at seating (right after positionUpdate), the
 *      owners before it in seat order (voicePeerList; it offers) and each
 *      of those a voicePeerJoined (the playAgain.voiceAtReturn pattern: one
 *      offer per pair, from the later one; shipped iOS ignores
 *      voicePeerJoined). Only table-capable sockets (`tableCapable`).
 *   2. The tournament room: tournament:<id>, the members on the tournament
 *      lobby screen (the lobby phase, between rounds, sitting a round out,
 *      back from a finished table while the others play). The membership is
 *      the record `tournament.voiceRoom` (socket-keyed, never saved:
 *      tournamentCodec DERIVED), entered when the server sends the member
 *      tournamentCreated / tournamentJoined (create, join, a reattach by
 *      username, returnToTournament) and left on everything that takes the
 *      socket off that screen: seated at a round's table, leaveTournament, a
 *      disconnect, joinMainRoom / a lobby / spectating, the tournament
 *      cancelled or cleaned up. Only sockets that sent the clientHello cap
 *      `tournamentVoice` enter (shipped iOS 1.2.5 (39) and older never start
 *      voice on their tournament lobby screen, so a web peer would offer to
 *      one and wait; cached web tabs from before it neither).
 *
 * Every change of the room goes through `change`: who was admitted before
 * and after, then voicePeerLeft (private, both ways) for every pair that
 * no longer shares the room, and for each newcomer, in entry order, a
 * voicePeerList of the admitted members before it (it offers) and a
 * voicePeerJoined to each of them. A member whose client entered the lobby
 * screen again (tournamentJoined while in the record) is listed again
 * (`relist`): its session may be new; a client skips a peer it is
 * connected to already.
 *
 * At most MAX_VOICE_PEOPLE (8, as a family lobby's mesh; the signaling rate
 * limits and the web's audio pool are sized for 7 calls each) are admitted,
 * the first 8 to enter; a tournament has no size limit, so the rest wait in
 * the record, unannounced, and the next in line is admitted (listed) when
 * an admitted member leaves.
 */

'use strict';

const gameManager = require('../game/GameManager');
const clientInfo = require('../socket/clientInfo');
const { socketLogger } = require('../utils/logger');

const CAP = 'tournamentVoice';
const TABLE_CAP = 'casualSpectators';
// iOS's muted start (VoiceChatManager isSelfMuted = true) arrived in 1.2.3 (18);
// `assist` is sent from 1.2.3 (19)
const MUTED_START_CAP = 'assist';
const MUTED_START_IOS_BUILD = 18;
const MAX_ROOM = 8;

const lazyGameVoice = () => require('./gameVoice');

/**
 * May `sid` be announced at a tournament table? The cap tournamentVoice
 * (this web bundle on, iOS from its next build), or an iOS build that starts
 * voice there MUTED: casualSpectators from a client that is not the web,
 * plus the cap `assist` (iOS 1.2.3 (19) and later, incl. the shipped 1.2.5
 * (39)) or an iOS build number of 18 or more (1.2.3 (18), the first with the
 * voice defaults: mic muted to start, no voice while the only human). Those
 * builds start voice at a tournament table on their own (GameContainerView,
 * once positionUpdate shows another human) and clear buffered peers and
 * offers on teardown, which was the old stale-socket worry (C10). iOS 1.2.2
 * (12) to 1.2.3 (17) send the same three caps (avatarUrl, casualSpectators,
 * playAgain) but start voice at every seat with the mic LIVE (the App
 * Store's 1.2.2 (13) among them; TestFlight's "1.2.3 (17)" is build 16's
 * code): announced, they would talk to the whole table, opponents included,
 * before anyone chose to (owner: starting muted). A web bundle without
 * tournamentVoice (a tab cached from before 2026-11-24) never starts voice
 * there: listed, it would buffer the peers forever, and an offer to it would
 * end as "voice unavailable" on the other side.
 */
function tableCapable(io, sid) {
    if (!sid || typeof sid !== 'string' || sid.startsWith('bot:')) return false;
    const socket = io?.sockets?.sockets?.get(sid);
    if (!socket) return false;
    if (clientInfo.hasCap(socket, CAP)) return true;
    const client = socket.data?.client;
    if (!client || client.client === 'web' || !clientInfo.hasCap(socket, TABLE_CAP)) return false;
    if (clientInfo.hasCap(socket, MUTED_START_CAP)) return true;
    return client.client === 'ios' && iosBuild(socket) >= MUTED_START_IOS_BUILD;
}

/** The iOS build number the socket reported (clientHello's build, else the User-Agent's), or NaN. */
function iosBuild(socket) {
    const hello = Number.parseInt(socket.data?.client?.build, 10);
    if (Number.isFinite(hello)) return hello;
    const ua = Number(socket.data?.appBuild);
    return Number.isFinite(ua) ? ua : NaN;
}

/**
 * Table voice at seating (gameHandlers.handleDrawComplete, right after
 * positionUpdate): the table's connected human owners at their seats, in
 * seat order; h_i gets voicePeerList of h_0..h_{i-1} and each of those a
 * voicePeerJoined{h_i}. A pair a loaded block list excludes is left out.
 * Why at seating and not at the assignment: both clients learn the other
 * human (their no-voice-alone company) only from positionUpdate, and a list
 * sent before the table's startDraw would reach a web page still on the
 * tournament lobby, whose room session the startDraw tears down with every
 * buffered peer, so the call would never be made.
 * @returns {number} pairs announced
 */
function announceTable(io, game) {
    seatingPending.delete(game);
    if (!io || !game?.tournamentId || game.isTerminal?.()) return 0;
    const { gameVoiceMembers, blockedPair } = lazyGameVoice();
    const humans = gameVoiceMembers(game).filter((m) => tableCapable(io, m.socketId));
    let pairs = 0;
    for (let i = 1; i < humans.length; i++) {
        const me = humans[i];
        const earlier = humans.slice(0, i).filter((e) => !blockedPair(io, me.socketId, me.username, e.socketId, e.username));
        if (earlier.length === 0) continue;
        io.to(me.socketId).emit('voicePeerList', { peers: earlier.map((e) => ({ socketId: e.socketId, username: e.username })) });
        for (const e of earlier) io.to(e.socketId).emit('voicePeerJoined', { socketId: me.socketId, username: me.username });
        pairs += earlier.length;
    }
    if (pairs > 0) socketLogger.info('Voice: tournament table announced', { gameId: game.gameId, humans: humans.length, pairs });
    return pairs;
}

/*
 * A tournament table between its seats' creation and its seating's
 * positionUpdate (gameHandlers.handleDrawComplete's reveal hold): an owner
 * back at its seat then (seatLifecycle.announceOwnerVoice) is listed to
 * nobody, since announceTable lists every connected owner a moment later;
 * listed both then, a pair whose rejoiner sits earlier would get a
 * voicePeerList each way and both sides would offer (shipped iOS answers a
 * crossing offer by closing its own call). Never saved: a restored table is
 * past its seating.
 */
const seatingPending = new WeakSet();

/** handleDrawComplete, the seats made and the reveal hold begun (a tournament table only). */
function holdSeating(game) {
    if (game?.tournamentId) seatingPending.add(game);
}

/** Is `game` in its reveal hold (its owners not announced yet)? */
function seatingHeld(game) {
    return !!game && seatingPending.has(game);
}

// ==================== the tournament room ====================

function record(t) {
    if (!t.voiceRoom) t.voiceRoom = { order: 0, members: new Map() };
    return t.voiceRoom;
}

/** Still the registered, live tournament (a cancelled or cleaned-up one has no room). */
function registered(t) {
    return !!t && !t.retired && gameManager.tournaments.get(t.tournamentId) === t;
}

/** The admitted members, in entry order: [{socketId, username}] (at most MAX_ROOM). */
function admitted(t) {
    if (!t?.voiceRoom) return [];
    return [...t.voiceRoom.members.entries()]
        .sort((a, b) => a[1].order - b[1].order)
        .slice(0, MAX_ROOM)
        .map(([socketId, e]) => ({ socketId, username: e.username }));
}

/**
 * Apply `mutate(members)` to the room, then tell the sockets: every pair
 * that was admitted together and no longer is gets voicePeerLeft both ways
 * (a disconnected socket's copy goes nowhere); every newly admitted member,
 * in entry order, voicePeerList of the admitted ones before it, and each of
 * those voicePeerJoined.
 */
function change(io, t, mutate) {
    const before = admitted(t);
    mutate(record(t).members);
    const after = admitted(t);
    if (!io) return;
    const afterIds = new Set(after.map((p) => p.socketId));
    const beforeIds = new Set(before.map((p) => p.socketId));
    const told = new Set();
    for (const gone of before.filter((p) => !afterIds.has(p.socketId))) {
        for (const other of before) {
            if (other.socketId === gone.socketId) continue;
            const key = [gone.socketId, other.socketId].sort().join('|');
            if (told.has(key)) continue;
            told.add(key);
            io.to(other.socketId).emit('voicePeerLeft', { socketId: gone.socketId });
            io.to(gone.socketId).emit('voicePeerLeft', { socketId: other.socketId });
        }
    }
    const { blockedPair } = lazyGameVoice();
    const present = before.filter((p) => afterIds.has(p.socketId));
    for (const me of after.filter((p) => !beforeIds.has(p.socketId))) {
        const listed = present.filter((p) => !blockedPair(io, me.socketId, me.username, p.socketId, p.username));
        if (listed.length > 0) {
            io.to(me.socketId).emit('voicePeerList', { peers: listed });
            for (const p of listed) io.to(p.socketId).emit('voicePeerJoined', { socketId: me.socketId, username: me.username });
        }
        present.push(me);
    }
}

/** Is `sid` where the tournament room is: a member of `t`, connected, in no lobby or game, not spectating? */
function onLobbyScreen(io, t, sid) {
    if (gameManager.playerTournaments.get(sid) !== t.tournamentId) return false;
    if (gameManager.playerGames.has(sid) || gameManager.playerLobbies.has(sid) || gameManager.spectatorGames.has(sid)) return false;
    const player = t.players.get(sid);
    return !!player && player.connected !== false && !!io?.sockets?.sockets?.get(sid);
}

/**
 * The member `sid` was just sent tournamentCreated / tournamentJoined (it
 * shows the tournament lobby): it enters the room (or, already in it, is
 * listed again). Nothing for a socket without the cap, outside the lobby
 * screen, or in a complete tournament for a socket without the cap
 * cutForABuck (its results window takes no new voice there: those clients
 * show a results overlay, not a room). Any older entry
 * of the same user (a reattach on a new socket while the old one is still
 * half-open) goes, and the new socket takes its place in line.
 */
function enter(io, t, sid) {
    if (!io || !registered(t)) return false;
    if (!clientInfo.socketHasCap(io, sid, CAP) || !onLobbyScreen(io, t, sid)) return false;
    // The complete phase (Cut for a buck, 2026-11-25): a client with the cap
    // cutForABuck shows the final results in the lobby, with its mic; one
    // without it shows its results overlay, never a room
    if (t.phase === 'complete' && !clientInfo.socketHasCap(io, sid, 'cutForABuck')) return false;
    const username = t.players.get(sid)?.username ?? gameManager.getUserBySocketId(sid)?.username ?? null;
    if (!username) return false;
    // Another room this socket was in (a finished tournament's) goes first
    leaveSocket(io, sid, { except: t });
    const room = record(t);
    if (room.members.has(sid)) {
        relist(io, t, sid);
        return true;
    }
    change(io, t, (members) => {
        // A newer socket of the same user keeps that entry's place in line
        let order = null;
        for (const [other, e] of [...members]) {
            if (e.username !== username) continue;
            order = order === null ? e.order : Math.min(order, e.order);
            members.delete(other);
        }
        members.set(sid, { username, order: order ?? ++room.order });
    });
    const inVoice = admitted(t).some((p) => p.socketId === sid);
    socketLogger.info('Voice: tournament room entered', { tournamentId: t.tournamentId, socketId: sid, admitted: inVoice, members: room.members.size });
    return true;
}

/** `sid` (already admitted) is listed again: voicePeerList of every other admitted member, voicePeerJoined to each. */
function relist(io, t, sid) {
    const all = admitted(t);
    const me = all.find((p) => p.socketId === sid);
    if (!me) return;
    const { blockedPair } = lazyGameVoice();
    const listed = all.filter((p) => p.socketId !== sid && !blockedPair(io, sid, me.username, p.socketId, p.username));
    if (listed.length === 0) return;
    io.to(sid).emit('voicePeerList', { peers: listed });
    for (const p of listed) io.to(p.socketId).emit('voicePeerJoined', { socketId: sid, username: me.username });
}

/** `sids` leave `t`'s room (seated at a round's table, a leave, a disconnect). */
function leave(io, t, sids) {
    const list = [].concat(sids).filter(Boolean);
    if (!t?.voiceRoom || !list.some((sid) => t.voiceRoom.members.has(sid))) return false;
    change(io, t, (members) => {
        for (const sid of list) members.delete(sid);
    });
    return true;
}

/**
 * `username`'s tournament membership moved to the socket `keepSid` (a rejoin
 * at its table on another tab: seatLifecycle.reattachTournament): any other
 * socket of that user still in `t`'s room no longer belongs to `t` and
 * leaves it (voicePeerLeft both ways; it held a place and every newcomer
 * would list it, and an offer to it is refused not_peers).
 */
function leaveUser(io, t, username, keepSid) {
    if (!t?.voiceRoom || !username) return false;
    const stale = [...t.voiceRoom.members.entries()]
        .filter(([sid, e]) => sid !== keepSid && e.username === username && gameManager.playerTournaments.get(sid) !== t.tournamentId)
        .map(([sid]) => sid);
    return stale.length > 0 && leave(io, t, stale);
}

/** `sid` leaves whatever tournament room holds it (but `except`). */
function leaveSocket(io, sid, { except = null } = {}) {
    let left = false;
    for (const t of gameManager.tournaments.values()) {
        if (t === except || !t.voiceRoom?.members.has(sid)) continue;
        left = leave(io, t, sid) || left;
    }
    return left;
}

/** Everyone leaves (cancel, the results window's end). */
function closeRoom(io, t) {
    if (!t?.voiceRoom || t.voiceRoom.members.size === 0) return;
    change(io, t, (members) => members.clear());
}

/**
 * The voice room `sid` is in through a tournament, or null: an admitted
 * member of a registered tournament it still belongs to, on the lobby
 * screen (gameVoice.voiceRoomOf asks this last, after lobby / game /
 * voice spectator).
 */
function roomOf(sid) {
    const tid = gameManager.playerTournaments.get(sid);
    if (tid === undefined) return null;
    const t = gameManager.tournaments.get(tid);
    if (!registered(t) || !t.voiceRoom?.members.has(sid)) return null;
    if (gameManager.playerGames.has(sid) || gameManager.playerLobbies.has(sid) || gameManager.spectatorGames.has(sid)) return null;
    return admitted(t).some((p) => p.socketId === sid) ? `tournament:${tid}` : null;
}

module.exports = {
    CAP,
    MAX_ROOM,
    tableCapable,
    announceTable,
    holdSeating,
    seatingHeld,
    admitted,
    enter,
    relist,
    leave,
    leaveUser,
    leaveSocket,
    closeRoom,
    roomOf,
};
