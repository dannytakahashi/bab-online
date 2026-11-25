/**
 * Tournament voice (owner 2026-11-24: "in a tournament nobody had voice,
 * even with two humans at the same table"; server/voice/tournamentVoice.js,
 * docs/claude/voice.md "Tournament voice"), through real tournaments on the
 * handlers (stub io / sockets, fake timers, the in-memory DB):
 *   - a round's table: its connected human owners are announced to each
 *     other at seating (one voicePeerList / voicePeerJoined per pair, from
 *     the later seat), offers relay both ways; a 1-human table, a socket
 *     without a table cap, a cached web tab and a blocked pair get nothing;
 *     a drop during the draw is a voicePeerLeft; a rejoin is unchanged
 *   - the tournament room (tournament:<id>): members on the lobby screen
 *     with the cap tournamentVoice; join / leave / disconnect / reattach,
 *     seated at a round (out), back from a finished table (in), offers in
 *     the room and refused across tournaments, cancel / complete / the
 *     results window's end, at most 8, shipped iOS (casualSpectators
 *     without tournamentVoice) never listed
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const tournamentHandlers = require('../tournamentHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const gameLifecycle = require('../gameLifecycle');
const voice = require('../voiceHandlers');
const safety = require('../safetyHandlers');
const gameVoice = require('../../voice/gameVoice');
const tournamentVoice = require('../../voice/tournamentVoice');
const { rateLimiter } = require('../errorHandler');
const { Phase } = require('../../game/GamePhase');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { newIo, kill, newUser, liveTables, advanceUntil } = require('../../testUtils/tournamentDriver');

// The caps each client sends (clientHello)
const WEB = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'tournamentVoice'];
const OLD_WEB = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView'];
const IOS_SHIPPED = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial']; // 1.2.5 (39)
const IOS_LEGACY = ['avatarUrl']; // before 1.2.2 (12)
const KINDS = {
    web: { client: 'web', caps: WEB },
    oldWeb: { client: 'web', caps: OLD_WEB },
    ios: { client: 'ios', caps: IOS_SHIPPED },
    iosLegacy: { client: 'ios', caps: IOS_LEGACY },
    iosNext: { client: 'ios', caps: [...IOS_SHIPPED, 'tournamentVoice'] },
};
const VOICE = new Set(['voicePeerList', 'voicePeerJoined', 'voicePeerLeft', 'voiceSettings']);
// SDP built from obviously fake parts (never secret-shaped)
const OFFER = { type: 'offer', sdp: ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=sendrecv', ''].join('\r\n') };

let seq = 0;
let made = 0;

beforeEach(() => {
    seq++;
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    tournamentHandlers._resetCleanupTimersForTests();
    rateLimiter.clearAll?.();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/** A signed-in socket that said hello as `kind` (block list loaded). */
function member(ctx, name, kind = 'web', blocked = []) {
    const s = newUser(ctx.io, ctx.log, name);
    s.data.client = { client: KINDS[kind].client, version: '1', build: null, caps: KINDS[kind].caps };
    voice.rememberBlockList(s, blocked);
    s.username = name;
    return s;
}

/** A tournament made by `kinds[0]`'s socket, joined by the rest in order (not ready); blocks: index -> indexes it blocked. */
async function tournament(kinds, { io = null, blocks = {} } = {}) {
    const ctx = io ? { ...io } : newIo();
    const tag = `t${seq}x${++made}`;
    const names = kinds.map((k, i) => `p${i}_${tag}`);
    const sockets = kinds.map((k, i) => member(ctx, names[i], k, (blocks[i] || []).map((j) => names[j])));
    tournamentHandlers.createTournament(sockets[0], ctx.io);
    const t = gameManager.getPlayerTournament(sockets[0].id);
    for (const s of sockets.slice(1)) await tournamentHandlers.joinTournament(s, ctx.io, { tournamentId: t.tournamentId });
    return { ...ctx, t, sockets };
}

/** Voice events after `mark`, as [event, to, data]. */
// a private emit is io.to(sid) or socket.emit (self:<sid>): both are that socket
const voiceSince = (ctx, mark) => ctx.log.slice(mark).filter((l) => VOICE.has(l.event))
    .map((l) => [l.event, typeof l.to === 'string' ? l.to.replace(/^self:/, '') : l.to, l.data]);
const listsTo = (ctx, mark, sid) => voiceSince(ctx, mark).filter(([e, to]) => e === 'voicePeerList' && to === sid).map(([, , d]) => d.peers.map((p) => p.socketId));
const joinedTo = (ctx, mark, sid) => voiceSince(ctx, mark).filter(([e, to]) => e === 'voicePeerJoined' && to === sid).map(([, , d]) => d.socketId);
const leftTo = (ctx, mark, sid) => voiceSince(ctx, mark).filter(([e, to]) => e === 'voicePeerLeft' && to === sid).map(([, , d]) => d.socketId);

/** Every pair announced after `mark`: "offerer>listed" from the lists, checked against voicePeerJoined. */
function pairsSince(ctx, mark) {
    const ev = voiceSince(ctx, mark);
    const pairs = [];
    for (const [e, to, d] of ev) {
        if (e !== 'voicePeerList') continue;
        for (const p of d.peers) pairs.push(`${to}>${p.socketId}`);
    }
    const joined = ev.filter(([e]) => e === 'voicePeerJoined').map(([, to, d]) => `${d.socketId}>${to}`);
    expect(joined.sort()).toEqual([...pairs].sort());
    return pairs;
}

/** An offer from `a` to `b` reaches b? */
function relays(ctx, a, b) {
    const mark = ctx.log.length;
    voice.voiceOffer(a, ctx.io, { targetSocketId: b.id, offer: OFFER });
    return ctx.log.slice(mark).some((l) => l.event === 'voiceOffer' && l.to === b.id && l.data.fromSocketId === a.id);
}

function readyAll(ctx) {
    for (const s of ctx.sockets) {
        if (gameManager.getPlayerTournament(s.id) === ctx.t) tournamentHandlers.tournamentReady(s, ctx.io);
    }
}

/** Begin round 1 and run until every table is seated and dealt. */
async function startRound1(ctx) {
    readyAll(ctx);
    const creator = ctx.sockets.find((s) => s.id === ctx.t.createdBy);
    const starting = tournamentHandlers.beginTournament(creator, ctx.io);
    await advanceUntil(() => liveTables(ctx.t).length > 0 &&
        liveTables(ctx.t).every((g) => [Phase.BIDDING, Phase.PLAYING].includes(g.stage)), 100, 120000);
    await starting;
    return liveTables(ctx.t);
}

const humansAt = (game) => game.seatList().filter((s) => s.ownerSocketId && s.controller === 'human').map((s) => s.ownerSocketId);
const sock = (ctx, sid) => ctx.sockets.find((s) => s.id === sid);
const roomIds = (t) => tournamentVoice.admitted(t).map((p) => p.socketId);

// ==================== the table ====================

describe('a tournament table', () => {
    test('2 humans + 2 bots: one pairing at seating, from the later seat, offers relay both ways, no casual voice', async () => {
        const ctx = await tournament(['web', 'ios']);
        const mark = ctx.log.length;
        const [table] = await startRound1(ctx);
        const humans = humansAt(table);
        expect(humans).toHaveLength(2);
        // shipped iOS was never in the tournament room: nothing to leave there
        expect(voiceSince(ctx, mark).filter(([e]) => e === 'voicePeerLeft')).toEqual([]);
        const seatMark = ctx.log.findIndex((l, i) => i >= mark && l.event === 'positionUpdate');
        expect(seatMark).toBeGreaterThan(-1);
        // exactly one pair, announced after positionUpdate: the later owner in seat order lists the earlier
        expect(pairsSince(ctx, seatMark)).toEqual([`${humans[1]}>${humans[0]}`]);
        expect(pairsSince(ctx, mark)).toHaveLength(1);
        // never casual voice at a tournament table
        expect(voiceSince(ctx, mark).filter(([e]) => e === 'voiceSettings')).toEqual([]);
        expect(table.casualVoice).toBeUndefined();
        const [a, b] = humans.map((sid) => sock(ctx, sid));
        expect(gameVoice.voiceRoomOf(a.id)).toBe(`game:${table.gameId}`);
        expect(relays(ctx, b, a)).toBe(true);
        expect(relays(ctx, a, b)).toBe(true);
    });

    test('4 humans: every pair exactly once (6), each listed by the later seat', async () => {
        const ctx = await tournament(['web', 'web', 'ios', 'iosNext']);
        const mark = ctx.log.length;
        const [table] = await startRound1(ctx);
        const humans = humansAt(table);
        expect(humans).toHaveLength(4);
        const seatMark = ctx.log.findIndex((l, i) => i >= mark && l.event === 'positionUpdate');
        const pairs = pairsSince(ctx, seatMark);
        expect(pairs).toHaveLength(6);
        const expected = [];
        for (let i = 1; i < 4; i++) for (let j = 0; j < i; j++) expected.push(`${humans[i]}>${humans[j]}`);
        expect(pairs.sort()).toEqual(expected.sort());
        expect(listsTo(ctx, seatMark, humans[0])).toEqual([]);
        expect(listsTo(ctx, seatMark, humans[3])).toEqual([[humans[0], humans[1], humans[2]]]);
        for (const x of humans) for (const y of humans) if (x !== y) expect(relays(ctx, sock(ctx, x), sock(ctx, y))).toBe(true);
    });

    test('a 1-human table gets no voice event at all', async () => {
        const ctx = await tournament(['web']);
        const mark = ctx.log.length;
        await startRound1(ctx);
        expect(voiceSince(ctx, mark)).toEqual([]);
    });

    test('sockets without a table cap are never announced: iOS before 1.2.2 (12), a cached web tab', async () => {
        for (const other of ['iosLegacy', 'oldWeb']) {
            const ctx = await tournament(['web', other]);
            const mark = ctx.log.length;
            await startRound1(ctx);
            expect(voiceSince(ctx, mark).filter(([e]) => e !== 'voicePeerLeft')).toEqual([]);
            for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
        }
        // shipped iOS (casualSpectators, not the web) is announced
        expect(tournamentVoice.tableCapable({ sockets: { sockets: new Map([['x', { data: { client: KINDS.ios } }]]) } }, 'x')).toBe(true);
    });

    test('a blocked pair is left out; the others at the table are still paired', async () => {
        // p0 blocked p1
        const ctx = await tournament(['web', 'web', 'web'], { blocks: { 0: [1] } });
        const [p0, p1, p2] = ctx.sockets;
        const mark = ctx.log.length;
        await startRound1(ctx);
        const pairs = pairsSince(ctx, ctx.log.findIndex((l, i) => i >= mark && l.event === 'positionUpdate'));
        const unordered = pairs.map((p) => p.split('>').sort().join('|'));
        expect(unordered).not.toContain([p0.id, p1.id].sort().join('|'));
        expect(unordered.sort()).toEqual([[p0.id, p2.id].sort().join('|'), [p1.id, p2.id].sort().join('|')].sort());
        expect(relays(ctx, p0, p1)).toBe(false);
    });

    test('a drop during the draw: voicePeerLeft to the other entrant, not announced at seating; the rejoin lists it as before', async () => {
        const ctx = await tournament(['web', 'web']);
        readyAll(ctx);
        const starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t)[0].stage === Phase.DRAWING, 50, 60000);
        const [table] = liveTables(ctx.t);
        const [a, b] = ctx.sockets;
        const mark = ctx.log.length;
        await kill(ctx.io, b);
        expect(leftTo(ctx, mark, a.id)).toContain(b.id);
        await advanceUntil(() => [Phase.BIDDING, Phase.PLAYING].includes(table.stage), 100, 120000);
        await starting;
        expect(voiceSince(ctx, mark).filter(([e]) => e === 'voicePeerList' || e === 'voicePeerJoined')).toEqual([]);
        // back on a new socket: the reconnect's owner list (seatLifecycle.announceOwnerVoice), unchanged
        const back = newUser(ctx.io, ctx.log, b.username);
        back.data.client = { client: 'web', version: '1', build: null, caps: WEB };
        voice.rememberBlockList(back, []);
        ctx.sockets.push(back);
        const m2 = ctx.log.length;
        await reconnectHandlers.rejoinGame(back, ctx.io, { gameId: table.gameId, username: b.username });
        expect(listsTo(ctx, m2, back.id)).toEqual([[a.id]]);
        expect(joinedTo(ctx, m2, a.id)).toEqual([back.id]);
        expect(relays(ctx, back, a)).toBe(true);
        // a member at a table is never in the tournament room
        expect(roomIds(ctx.t)).toEqual([]);
    });
});

// ==================== the tournament room ====================

describe('the tournament room', () => {
    test('join: each newcomer lists the members before it; offers relay in the room; leave and disconnect tell the rest', async () => {
        const ctx = await tournament(['web', 'web', 'web']);
        const [a, b, c] = ctx.sockets;
        // the creator was alone; b listed a; c listed a and b
        expect(listsTo(ctx, 0, a.id)).toEqual([]);
        expect(listsTo(ctx, 0, b.id)).toEqual([[a.id]]);
        expect(listsTo(ctx, 0, c.id)).toEqual([[a.id, b.id]]);
        expect(joinedTo(ctx, 0, a.id)).toEqual([b.id, c.id]);
        expect(pairsSince(ctx, 0)).toHaveLength(3);
        expect(gameVoice.voiceRoomOf(a.id)).toBe(`tournament:${ctx.t.tournamentId}`);
        expect(relays(ctx, c, a)).toBe(true);
        expect(relays(ctx, a, b)).toBe(true);

        let mark = ctx.log.length;
        await tournamentHandlers.leaveTournament(c, ctx.io);
        expect(leftTo(ctx, mark, a.id)).toEqual([c.id]);
        expect(leftTo(ctx, mark, b.id)).toEqual([c.id]);
        expect(gameVoice.voiceRoomOf(c.id)).toBeNull();
        expect(relays(ctx, a, c)).toBe(false);

        mark = ctx.log.length;
        await kill(ctx.io, b);
        expect(leftTo(ctx, mark, a.id)).toEqual([b.id]);
        expect(roomIds(ctx.t)).toEqual([a.id]);
    });

    test('shipped iOS (casualSpectators, no tournamentVoice) and old web tabs are never listed in the room; offers to them are refused', async () => {
        const ctx = await tournament(['web', 'ios', 'oldWeb', 'iosLegacy', 'web']);
        const [a, ios, old, legacy, e] = ctx.sockets;
        const listed = voiceSince(ctx, 0).flatMap(([ev, to, d]) => (ev === 'voicePeerList' ? [to, ...d.peers.map((p) => p.socketId)] : ev === 'voicePeerJoined' ? [to, d.socketId] : []));
        for (const s of [ios, old, legacy]) expect(listed).not.toContain(s.id);
        expect(listsTo(ctx, 0, e.id)).toEqual([[a.id]]);
        expect(relays(ctx, a, ios)).toBe(false);
        expect(gameVoice.voiceRoomOf(ios.id)).toBeNull();
        expect(roomIds(ctx.t)).toEqual([a.id, e.id]);
    });

    test('a returnToTournament from the lobby lists the member again; another tournament\'s members are not peers', async () => {
        const one = await tournament(['web', 'web']);
        const two = await tournament(['web', 'web'], { io: { io: one.io, log: one.log } });
        const [a, b] = one.sockets;
        const mark = one.log.length;
        tournamentHandlers.returnToTournament(b, one.io, {});
        expect(listsTo(one, mark, b.id)).toEqual([[a.id]]);
        expect(joinedTo(one, mark, a.id)).toEqual([b.id]);
        expect(leftTo(one, mark, a.id)).toEqual([]);
        expect(relays(one, a, two.sockets[0])).toBe(false);
        expect(relays(two, two.sockets[1], two.sockets[0])).toBe(true);
    });

    test('at most 8 in the room: the 9th waits unlisted and is admitted when one leaves', async () => {
        const ctx = await tournament(Array(9).fill('web'));
        const s = ctx.sockets;
        expect(roomIds(ctx.t)).toEqual(s.slice(0, 8).map((x) => x.id));
        expect(listsTo(ctx, 0, s[8].id)).toEqual([]);
        expect(joinedTo(ctx, 0, s[0].id)).not.toContain(s[8].id);
        expect(relays(ctx, s[8], s[0])).toBe(false);
        const mark = ctx.log.length;
        await tournamentHandlers.leaveTournament(s[3], ctx.io);
        expect(leftTo(ctx, mark, s[0].id)).toEqual([s[3].id]);
        expect(listsTo(ctx, mark, s[8].id)).toEqual([[0, 1, 2, 4, 5, 6, 7].map((i) => s[i].id)]);
        expect(relays(ctx, s[8], s[0])).toBe(true);
    });

    test('a newer socket of the same user (the old one half-open) takes its place in a full room', async () => {
        const ctx = await tournament(Array(9).fill('web'));
        const s = ctx.sockets;
        const back = newUser(ctx.io, ctx.log, s[2].username);
        back.data.client = { client: 'web', version: '1', build: null, caps: WEB };
        voice.rememberBlockList(back, []);
        const mark = ctx.log.length;
        await tournamentHandlers.joinTournament(back, ctx.io, { tournamentId: ctx.t.tournamentId });
        expect(roomIds(ctx.t)).toEqual([0, 1].map((i) => s[i].id).concat(back.id, [3, 4, 5, 6, 7].map((i) => s[i].id)));
        expect(leftTo(ctx, mark, s[0].id)).toEqual([s[2].id]);
        expect(listsTo(ctx, mark, back.id)).toEqual([[0, 1, 3, 4, 5, 6, 7].map((i) => s[i].id)]);
        // the one waiting still waits
        expect(listsTo(ctx, mark, s[8].id)).toEqual([]);
        expect(relays(ctx, s[2], s[0])).toBe(false);
    });

    test('a blocked pair in the room is never listed (both ways) and a block ends their call', async () => {
        const ctx = await tournament(['web', 'web', 'web'], { blocks: { 2: [0] } });
        const [a, b, c] = ctx.sockets;
        expect(listsTo(ctx, 0, c.id)).toEqual([[b.id]]);
        expect(relays(ctx, a, c)).toBe(false);
        // b blocks a: their room call ends
        const mark = ctx.log.length;
        await safety.blockUser(b, ctx.io, { username: a.username });
        expect(leftTo(ctx, mark, a.id)).toContain(b.id);
        expect(leftTo(ctx, mark, b.id)).toContain(a.id);
    });

    test('a round moves the seated out of the room (voicePeerLeft both ways), a finished table\'s members come back by returnToTournament while the others play', async () => {
        // 5 members: tables of 3 and 2
        const ctx = await tournament(Array(5).fill('web'));
        const mark = ctx.log.length;
        const tables = await startRound1(ctx);
        expect(tables).toHaveLength(2);
        expect(roomIds(ctx.t)).toEqual([]);
        // every room pair was told both ways
        for (const x of ctx.sockets) {
            expect(leftTo(ctx, mark, x.id).sort()).toEqual(ctx.sockets.filter((y) => y !== x).map((y) => y.id).sort());
        }
        const small = tables.find((g) => humansAt(g).length === 2);
        const big = tables.find((g) => g !== small);
        const [h1, h2] = humansAt(small).map((sid) => sock(ctx, sid));
        await gameLifecycle.abortGame(ctx.io, small, 'test');
        expect(ctx.t.phase).toBe('round_active');
        // not in the room until the client is back on the lobby screen
        expect(gameVoice.voiceRoomOf(h1.id)).toBeNull();
        const m2 = ctx.log.length;
        tournamentHandlers.returnToTournament(h1, ctx.io, {});
        tournamentHandlers.returnToTournament(h2, ctx.io, {});
        expect(listsTo(ctx, m2, h1.id)).toEqual([]);
        expect(listsTo(ctx, m2, h2.id)).toEqual([[h1.id]]);
        expect(relays(ctx, h2, h1)).toBe(true);
        // the members still playing are no peers of the room
        const player = sock(ctx, humansAt(big)[0]);
        expect(relays(ctx, h1, player)).toBe(false);
        expect(gameVoice.voiceRoomOf(player.id)).toBe(`game:${big.gameId}`);
        // spectating a table takes h1 out; returning puts it back
        const m3 = ctx.log.length;
        tournamentHandlers.spectateTournamentGame(h1, ctx.io, { gameId: big.gameId });
        expect(leftTo(ctx, m3, h2.id)).toEqual([h1.id]);
        tournamentHandlers.returnToTournament(h1, ctx.io, {});
        expect(listsTo(ctx, m3, h1.id)).toEqual([[h2.id]]);
    });

    test('a member back on a new socket between rounds (a reattach) replaces its old entry', async () => {
        const ctx = await tournament(['web', 'web']);
        const [a, b] = ctx.sockets;
        const [table] = await startRound1(ctx);
        await gameLifecycle.abortGame(ctx.io, table, 'test');
        expect(ctx.t.phase).toBe('between_rounds');
        tournamentHandlers.returnToTournament(a, ctx.io, {});
        tournamentHandlers.returnToTournament(b, ctx.io, {});
        let mark = ctx.log.length;
        await kill(ctx.io, b);
        expect(leftTo(ctx, mark, a.id)).toEqual([b.id]);
        const back = newUser(ctx.io, ctx.log, b.username);
        back.data.client = { client: 'web', version: '1', build: null, caps: WEB };
        voice.rememberBlockList(back, []);
        mark = ctx.log.length;
        await tournamentHandlers.joinTournament(back, ctx.io, { tournamentId: ctx.t.tournamentId });
        expect(listsTo(ctx, mark, back.id)).toEqual([[a.id]]);
        expect(roomIds(ctx.t)).toEqual([a.id, back.id]);
    });

    test('joinMainRoom leaves the room; cancel closes it for everyone', async () => {
        const ctx = await tournament(['web', 'web', 'web']);
        const [a, b, c] = ctx.sockets;
        let mark = ctx.log.length;
        mainRoomHandlers.joinMainRoom(c, ctx.io);
        expect(leftTo(ctx, mark, a.id)).toEqual([c.id]);
        mark = ctx.log.length;
        await tournamentHandlers.cancelTournament(a, ctx.io);
        expect(leftTo(ctx, mark, a.id)).toEqual([b.id]);
        expect(leftTo(ctx, mark, b.id)).toEqual([a.id]);
        expect(gameVoice.voiceRoomOf(a.id)).toBeNull();
        expect(relays(ctx, a, b)).toBe(false);
    });

    test('complete: no newcomers; the members already in keep the room until the results window ends', async () => {
        // 5 members, one round: tables of 3 and 2
        const ctx = await tournament(Array(5).fill('web'));
        ctx.t.totalRounds = 1;
        const tables = await startRound1(ctx);
        const small = tables.find((g) => humansAt(g).length === 2);
        const big = tables.find((g) => g !== small);
        const smallHumans = humansAt(small).map((sid) => sock(ctx, sid));
        const bigHumans = humansAt(big).map((sid) => sock(ctx, sid));
        await gameLifecycle.abortGame(ctx.io, small, 'test');
        for (const s of smallHumans) tournamentHandlers.returnToTournament(s, ctx.io, {});
        expect(roomIds(ctx.t)).toEqual(smallHumans.map((s) => s.id));
        let mark = ctx.log.length;
        await gameLifecycle.abortGame(ctx.io, big, 'test');
        expect(ctx.t.phase).toBe('complete');
        expect(leftTo(ctx, mark, smallHumans[0].id)).toEqual([]);
        tournamentHandlers.returnToTournament(bigHumans[0], ctx.io, {});
        expect(listsTo(ctx, mark, bigHumans[0].id)).toEqual([]);
        expect(roomIds(ctx.t)).toEqual(smallHumans.map((s) => s.id));
        expect(relays(ctx, smallHumans[0], smallHumans[1])).toBe(true);
        // the results window (10 min) ends: everyone leaves
        mark = ctx.log.length;
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
        expect(gameManager.getTournamentById(ctx.t.tournamentId)).toBeNull();
        expect(leftTo(ctx, mark, smallHumans[0].id)).toEqual([smallHumans[1].id]);
        expect(leftTo(ctx, mark, smallHumans[1].id)).toEqual([smallHumans[0].id]);
        expect(gameVoice.voiceRoomOf(smallHumans[0].id)).toBeNull();
    });

    test('the room gets TURN like any voice room (a voice peer), a member who is alone too', async () => {
        const ctx = await tournament(['web', 'ios']);
        expect(gameVoice.voiceRoomOf(ctx.sockets[0].id)).toBe(`tournament:${ctx.t.tournamentId}`);
        expect(gameVoice.voiceRoomOf(ctx.sockets[1].id)).toBeNull();
    });
});
