/**
 * server/socket/upgradeGate.js: the old App Store iOS builds (1.0.0 build 1,
 * 1.1.0 build 2; MIN_IOS_BUILD 3) see only the update message and keep their
 * saved session; every other client (1.2.0 build 3+, browsers, a missing or
 * garbled User-Agent) is never gated. User-Agents below were captured from
 * simulator builds of cc9059f (1.0.0) and f05d264 (1.1.0) against a
 * header-logging server.
 */

const http = require('http');
const bcrypt = require('bcryptjs');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const gate = require('../upgradeGate');
const gameManager = require('../../game/GameManager');
const rateLimiter = require('../rateLimiter');
const { setupSocketHandlers } = require('../index');
const { makeSocket } = require('../../testUtils/gameDriver');
const { socketLogger } = require('../../utils/logger');
const { hashToken, verifySession, SESSION_TTL_MS } = require('../../utils/sessionTokens');

// Captured 2026-11-11 (socket.handshake.headers['user-agent'], polling handshake)
const UA_100 = 'BAB%20Online/1 CFNetwork/3896.200.61 Darwin/27.2.0';
const UA_110 = 'BAB%20Online/2 CFNetwork/3896.200.61 Darwin/27.2.0';
// 1.2.0: build 3 was uploaded but never submitted, build 4 is the release;
// the same URLSession form
const UA_120 = 'BAB%20Online/3 CFNetwork/3896.200.61 Darwin/27.2.0';
const UA_124 = 'BAB%20Online/4 CFNetwork/3896.200.61 Darwin/27.2.0';
// Every gated build: [label, User-Agent, build]
const OLD_BUILDS = [['1.0.0', UA_100, 1], ['1.1.0', UA_110, 2]];
// The built-in browser of the live check (Chromium) and common browsers
const BROWSERS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'node-XMLHttpRequest',
];
const GARBAGE = [
    undefined, null, '', ' ', 42, ['BAB%20Online/1 CFNetwork/1 Darwin/1'], {},
    'BAB%20Online/', 'BAB%20Online/1', 'BAB%20Online/1 CFNetwork/3896.200.61',
    'BAB%20Online/abc CFNetwork/3896.200.61 Darwin/27.2.0',
    'BAB%20Online/1.0 CFNetwork/3896.200.61 Darwin/27.2.0', // dotted build: never gated
    'BAB%20Online/-1 CFNetwork/3896.200.61 Darwin/27.2.0',
    'BAB%20Online/1234567890 CFNetwork/3896.200.61 Darwin/27.2.0',
    'xBAB%20Online/1 CFNetwork/3896.200.61 Darwin/27.2.0',
    ' BAB%20Online/1 CFNetwork/3896.200.61 Darwin/27.2.0',
    'BAB%20Onlinex/1 CFNetwork/3896.200.61 Darwin/27.2.0',
    'Mozilla/5.0 BAB%20Online/1 CFNetwork/3896.200.61 Darwin/27.2.0',
    'BAB%20Online/1 CFNetwork/abc Darwin/27.2.0',
    `BAB%20Online/1 CFNetwork/3896.200.61 Darwin/27.2.0 ${'x'.repeat(600)}`,
];

const MSG = gate.UPDATE_MESSAGE;
const MSG_OUT = gate.UPDATE_MESSAGE_SIGNED_OUT;

afterAll(() => rateLimiter.shutdown());

describe('parseIosUserAgent', () => {
    test('the captured simulator User-Agents', () => {
        expect(gate.parseIosUserAgent(UA_100)).toEqual({ client: 'ios', build: 1 });
        expect(gate.parseIosUserAgent(UA_110)).toEqual({ client: 'ios', build: 2 });
        expect(gate.parseIosUserAgent(UA_124)).toEqual({ client: 'ios', build: 4 });
        expect(gate.isOutdatedIosApp(UA_100)).toBe(true);
        expect(gate.isOutdatedIosApp(UA_110)).toBe(true);
        expect(gate.isOutdatedIosApp(UA_120)).toBe(false);
        expect(gate.isOutdatedIosApp(UA_124)).toBe(false);
        expect(gate.isOutdatedIosApp('BAB%20Online/17 CFNetwork/1500 Darwin/25.0.0')).toBe(false);
        // the same app on another iOS / CFNetwork, or the unencoded name
        for (const b of [1, 2]) {
            expect(gate.isOutdatedIosApp(`BAB%20Online/${b} CFNetwork/1568.100.1 Darwin/24.0.0`)).toBe(true);
            expect(gate.isOutdatedIosApp(`BAB Online/${b} CFNetwork/1568.100.1 Darwin/24.0.0`)).toBe(true);
        }
        expect(gate.isOutdatedIosApp('BAB Online/3 CFNetwork/1568.100.1 Darwin/24.0.0')).toBe(false);
    });

    test('the boundary: builds 1 and 2 (1.0.0, 1.1.0) are gated, 3 and later are not', () => {
        expect(gate.MIN_IOS_BUILD).toBe(3);
        const at = (b) => gate.isOutdatedIosApp(`BAB%20Online/${b} CFNetwork/3896.200.61 Darwin/27.2.0`);
        expect([0, 1, 2, 3, 4, 5, 100].map(at)).toEqual([true, true, true, false, false, false, false]);
    });

    test.each(BROWSERS)('browser: %s', (ua) => {
        expect(gate.parseIosUserAgent(ua)).toBeNull();
        expect(gate.isOutdatedIosApp(ua)).toBe(false);
    });

    test.each(GARBAGE.map((g) => [String(g).slice(0, 60), g]))('garbage / missing: %s', (_label, ua) => {
        expect(gate.parseIosUserAgent(ua)).toBeNull();
        expect(gate.isOutdatedIosApp(ua)).toBe(false);
    });

    test('the message fits a caption line and names the App Store', () => {
        expect(MSG.length).toBeLessThanOrEqual(90);
        expect(MSG).toMatch(/^Update required\. Please update BAB Online in the App Store\./);
        expect(MSG).toMatch(/stay signed in/);
        expect(MSG_OUT).not.toMatch(/signed in/);
    });
});

// ---------- the wired handlers (stub socket, contract-checked emits) ----------

const ALAN_TOKEN = '6f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';

beforeEach(async () => {
    jest.spyOn(socketLogger, 'info').mockImplementation(() => {});
    jest.spyOn(socketLogger, 'debug').mockImplementation(() => {});
    jest.spyOn(socketLogger, 'warn').mockImplementation(() => {});
    delete process.env.UPGRADE_GATE;
    mockDb.current = createMemoryDb({
        users: [{
            username: 'Alan', password: await bcrypt.hash('pw', 4),
            sessionTokens: [{ hash: hashToken(ALAN_TOKEN), createdAt: new Date(), lastUsedAt: new Date() }],
        }],
    });
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.UPGRADE_GATE;
});

let n = 0;
/** A stub socket with a handshake, wired through the real setupSocketHandlers. */
function wired(ua) {
    const log = [];
    const handlers = new Map();
    const socket = makeSocket(`gate-${++n}`, log);
    socket.handshake = { headers: ua === undefined ? {} : { 'user-agent': ua }, address: '203.0.113.9' };
    socket.on = (ev, fn) => handlers.set(ev, fn);
    socket.disconnect = jest.fn();
    setupSocketHandlers({ on: (ev, cb) => cb(socket) });
    const send = async (ev, d) => {
        const h = handlers.get(ev);
        if (h) await h(d);
        await new Promise((r) => setImmediate(r));
    };
    const emits = (event) => log.filter((l) => l.event === event);
    return { socket, log, handlers, send, emits };
}

function serverState() {
    return JSON.stringify({
        users: gameManager.currentUsers,
        online: gameManager.getOnlineUsernames(),
        main: [...gameManager.mainRoomSocketIds],
        lobbies: [...gameManager.lobbies.keys()],
        playerLobbies: [...gameManager.playerLobbies.keys()],
        games: [...gameManager.games.keys()],
        tournaments: [...gameManager.tournaments.keys()],
        messages: gameManager.mainRoomMessages.length,
    });
}

describe.each(OLD_BUILDS)('a %s socket', (_version, UA_OLD, BUILD) => {
    test('restoreSession: no restoreSessionResponse, a signInResponse failure; the DB token is kept, only its lastUsedAt moves', async () => {
        const users = mockDb.current.users;
        const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
        await users.updateOne({ username: 'Alan' }, { $set: { sessionTokens: [{ hash: hashToken('other-device'), createdAt: old, lastUsedAt: old },
            { hash: hashToken(ALAN_TOKEN), createdAt: old, lastUsedAt: old }] } });
        const before = await users.findOne({ username: 'Alan' });
        const writes = ['updateOne', 'updateMany', 'findOneAndUpdate', 'insertOne', 'deleteOne', 'deleteMany', 'replaceOne']
            .filter((m) => users[m]).map((m) => jest.spyOn(users, m));

        const w = wired(UA_OLD);
        expect([...w.handlers.keys()].sort()).toEqual(['chatMessage', 'disconnect', 'draw', 'joinMainRoom', 'leaveLobby', 'leaveTournament',
            'restoreSession', 'returnToTournament', 'signIn', 'signUp'].sort());
        await w.send('restoreSession', { username: 'Alan', sessionToken: ALAN_TOKEN });
        expect(w.emits('restoreSessionResponse')).toEqual([]);
        expect(w.emits('signInResponse').map((l) => l.data)).toEqual([{ success: false, message: MSG }]);
        expect(w.log.every((l) => l.to === `self:${w.socket.id}`)).toBe(true);
        // the one write: that entry's lastUsedAt (no socketId, no other field)
        const called = writes.filter((s) => s.mock.calls.length);
        expect(called).toHaveLength(1);
        expect(users.updateOne).toHaveBeenCalledTimes(1);
        writes.forEach((s) => s.mockRestore());
        const after = await users.findOne({ username: 'Alan' });
        expect(after.sessionTokens[1].lastUsedAt.getTime()).toBeGreaterThan(old.getTime());
        expect({ ...after, sessionTokens: after.sessionTokens.map((e, i) => (i === 1 ? { ...e, lastUsedAt: old } : e)) }).toEqual(before);
        expect(gameManager.getOnlineUsernames()).not.toContain('Alan');
        expect(w.socket.data.appBuild).toBe(BUILD);
        expect(w.socket.data.username).toBeUndefined();
        await w.send('disconnect');
    });

    test('a player who keeps opening the old build keeps the session the update restores (TTL refreshed)', async () => {
        const users = mockDb.current.users;
        const t0 = Date.now();
        const day = 24 * 3600 * 1000;
        const lastPreGate = new Date(t0 - 85 * day);
        await users.updateOne({ username: 'Alan' }, { $set: { sessionTokens: [{ hash: hashToken(ALAN_TOKEN), createdAt: lastPreGate, lastUsedAt: lastPreGate }] } });
        const w = wired(UA_OLD);
        await w.send('restoreSession', { username: 'Alan', sessionToken: ALAN_TOKEN });
        await w.send('disconnect');
        // they update 10 days later: 95 days after their last pre-gate use
        // (verifySession mutates the entry it accepts: a fresh read for each)
        expect(verifySession(await users.findOne({ username: 'Alan' }), ALAN_TOKEN, new Date(t0 + 10 * day))).not.toBeNull();
        // refreshed to now, not forever
        expect(verifySession(await users.findOne({ username: 'Alan' }), ALAN_TOKEN, new Date(t0 + SESSION_TTL_MS + day))).toBeNull();
    });

    test.each([
        ['an expired session', { token: ALAN_TOKEN, lastUsedAt: new Date(Date.now() - SESSION_TTL_MS - 1000) }],
        ['a token that is not one of the sessions (evicted)', { token: 'evicted-token', lastUsedAt: new Date() }],
        ['an unknown user', { token: ALAN_TOKEN, lastUsedAt: new Date(), username: 'Nobody' }],
    ])('%s: no write, and later pushes drop "stay signed in"', async (_l, { token, lastUsedAt, username = 'Alan' }) => {
        const users = mockDb.current.users;
        await users.updateOne({ username: 'Alan' }, { $set: { sessionTokens: [{ hash: hashToken(ALAN_TOKEN), createdAt: lastUsedAt, lastUsedAt }] } });
        const before = await users.findOne({ username: 'Alan' });
        const upd = jest.spyOn(users, 'updateOne');
        const w = wired(UA_OLD);
        await w.send('restoreSession', { username, sessionToken: token });
        expect(upd).not.toHaveBeenCalled();
        expect(await users.findOne({ username: 'Alan' })).toEqual(before);
        await w.send('signIn', { username, password: 'x' });
        expect(w.emits('signInResponse').map((l) => l.data.message)).toEqual([MSG, MSG_OUT]);
        await w.send('disconnect');
    });

    test('a database error leaves the message and the session alone', async () => {
        const users = mockDb.current.users;
        jest.spyOn(users, 'findOne').mockRejectedValue(new Error('db down'));
        const upd = jest.spyOn(users, 'updateOne');
        const w = wired(UA_OLD);
        await w.send('restoreSession', { username: 'Alan', sessionToken: ALAN_TOKEN });
        await w.send('signIn', { username: 'Alan', password: 'x' });
        expect(upd).not.toHaveBeenCalled();
        expect(w.emits('signInResponse').map((l) => l.data.message)).toEqual([MSG, MSG]);
        await w.send('disconnect');
    });

    test('signIn (even with the right password) and signUp fail with the update message', async () => {
        const w = wired(UA_OLD);
        await w.send('signIn', { username: 'Alan', password: 'pw' });
        await w.send('signUp', { username: 'Newbie', password: 'secret1' });
        expect(w.emits('signInResponse').map((l) => l.data)).toEqual([{ success: false, message: MSG_OUT }]);
        expect(w.emits('signUpResponse').map((l) => l.data)).toEqual([{ success: false, message: MSG_OUT }]);
        expect(await mockDb.current.users.findOne({ username: 'Newbie' })).toBeNull();
        expect(gameManager.getOnlineUsernames()).not.toContain('Alan');
        await w.send('disconnect');
    });

    test('every other event changes no state and never registers it as online', async () => {
        const before = serverState();
        const w = wired(UA_OLD);
        await w.send('restoreSession', { username: 'Alan', sessionToken: ALAN_TOKEN });
        for (const [ev, d] of [
            ['joinMainRoom'], ['mainRoomChat', { message: 'hi' }], ['createLobby', { name: 'x' }], ['joinQueue'],
            ['joinLobby', { lobbyId: 'nope' }], ['addBot'], ['playerReady'], ['createTournament'], ['joinTournament', { tournamentId: 't' }],
            ['rejoinGame', { gameId: 'g', username: 'Alan', sessionToken: ALAN_TOKEN }], ['playCard', { card: { suit: 'spades', rank: 'A' } }],
            ['playerBid', { bid: '1' }], ['deleteAccount', { password: 'pw' }], ['getProfile'], ['getLeaderboard'],
            ['requestSnapshot', {}], ['clientHello', { client: 'ios', version: _version, caps: ['avatarUrl'] }], ['voiceOffer', { to: 'x' }],
            ['chatMessage', { message: 'hello' }], ['blockUser', { username: 'Bob' }],
        ]) await w.send(ev, d);
        expect(serverState()).toBe(before);
        expect(gameManager.getUserBySocketId(w.socket.id)).toBeFalsy();
        expect(w.socket.data.client).toBeUndefined();
        // the only replies: the restore's update message and the empty main room
        expect([...new Set(w.log.map((l) => l.event))].sort()).toEqual(['mainRoomJoined', 'signInResponse']);
        const room = w.emits('mainRoomJoined')[0].data;
        expect(room).toMatchObject({ lobbies: [], onlineCount: 0, onlineUsers: [], inProgressGames: [], tournaments: [] });
        expect(room.recentMessages).toEqual([{ username: 'BAB Online', message: MSG, timestamp: expect.any(Number) }]);
        expect(room.messages).toEqual(room.recentMessages);
        await w.send('disconnect');
    });

    test('the ways out of a stale screen land in that main room: /leave, Tap to Draw, leaveLobby, leaveTournament, returnToTournament', async () => {
        const before = serverState();
        const w = wired(UA_OLD);
        await w.send('chatMessage', { message: ' /LEAVE ' });
        // 1.1.0's Leave cannot be reached during the draw (covered by the
        // overlay on phones, disabled on the Duo's bar): Tap to Draw is the way out
        await w.send('draw', { num: 17 });
        await w.send('leaveLobby');
        await w.send('leaveTournament');
        await w.send('returnToTournament');
        expect(w.log.map((l) => [l.event, l.data])).toEqual([
            ['leftGame', undefined], ['leftGame', undefined], ['leftLobby', {}], ['tournamentLeft', {}], ['tournamentLeft', {}],
        ]);
        expect(serverState()).toBe(before);
        await w.send('disconnect');
    });

    test('back in the main room: the joinMainRoom 1.1.0 sends after each way out gets the update-only room under both keys', async () => {
        // f05d264: leftGame -> joinMainRoom (casual) or returnToTournament
        // (tournament game) -> tournamentLeft -> joinMainRoom; leftLobby ->
        // MainRoomView.onAppear -> joinMainRoom; LobbySocketHandler reads
        // recentMessages ?? messages
        const w = wired(UA_OLD);
        await w.send('restoreSession', { username: 'Alan', sessionToken: ALAN_TOKEN });
        for (const [ev, d] of [['chatMessage', { message: '/leave' }], ['draw', { num: 3 }], ['returnToTournament'], ['leaveLobby'], ['leaveTournament']]) {
            await w.send(ev, d);
            await w.send('joinMainRoom');
        }
        const rooms = w.emits('mainRoomJoined').map((l) => l.data);
        expect(rooms).toHaveLength(5);
        for (const room of rooms) {
            expect(room).toMatchObject({ lobbies: [], onlineCount: 0, onlineUsers: [], inProgressGames: [], tournaments: [] });
            expect(room.messages).toEqual([{ username: 'BAB Online', message: MSG, timestamp: expect.any(Number) }]);
            expect(room.recentMessages).toEqual(room.messages);
        }
        expect(w.log.map((l) => l.event).filter((e) => e !== 'mainRoomJoined' && e !== 'signInResponse'))
            .toEqual(['leftGame', 'leftGame', 'tournamentLeft', 'leftLobby', 'tournamentLeft']);
        expect(w.emits('error')).toEqual([]);
        expect(gameManager.getOnlineUsernames()).not.toContain('Alan');
        await w.send('disconnect');
    });

    test('pushes after connect: 0.3 s, 2 s (+ main room, one log line), 5 s; none after disconnect', async () => {
        jest.useFakeTimers();
        const w = wired(UA_OLD);
        const at = () => w.log.map((l) => l.event);
        jest.advanceTimersByTime(299);
        expect(at()).toEqual([]);
        jest.advanceTimersByTime(1);
        expect(at()).toEqual(['signInResponse']);
        expect(w.log[0].data).toEqual({ success: false, message: MSG_OUT });
        // the app restores its session on connect: later pushes keep "stay signed in"
        w.handlers.get('restoreSession')({ username: 'Alan', sessionToken: ALAN_TOKEN });
        jest.advanceTimersByTime(1700);
        expect(at()).toEqual(['signInResponse', 'signInResponse', 'signInResponse', 'mainRoomJoined']);
        expect(w.emits('mainRoomJoined')[0].data.recentMessages[0].message).toBe(MSG);
        const gated = socketLogger.info.mock.calls.filter(([m]) => m === 'Upgrade gate: outdated iOS app');
        expect(gated).toEqual([['Upgrade gate: outdated iOS app', { socketId: w.socket.id, build: BUILD, username: 'Alan', savedSession: true }]]);
        expect(JSON.stringify(gated)).not.toContain(ALAN_TOKEN);
        jest.advanceTimersByTime(3000);
        expect(w.emits('signInResponse')).toHaveLength(4);
        expect(w.emits('signInResponse').map((l) => l.data.message)).toEqual([MSG_OUT, MSG, MSG, MSG]);

        const w2 = wired(UA_OLD);
        jest.advanceTimersByTime(500);
        w2.handlers.get('disconnect')();
        jest.advanceTimersByTime(10000);
        expect(w2.log.map((l) => l.event)).toEqual(['signInResponse']);
        w.handlers.get('disconnect')();
        // dropped before the main push with no username: one debug line only
        expect(socketLogger.info.mock.calls.filter(([m, d]) => /Upgrade gate/.test(m) && d.socketId === w2.socket.id)).toEqual([]);
        expect(socketLogger.debug.mock.calls.filter(([m, d]) => /Upgrade gate/.test(m) && d.socketId === w2.socket.id))
            .toEqual([['Upgrade gate: outdated iOS app (dropped at once)', { socketId: w2.socket.id, build: BUILD, username: null, savedSession: false }]]);
        // one that sent a username before dropping is an info line
        const w3 = wired(UA_OLD);
        w3.handlers.get('signIn')({ username: 'Zed', password: 'x' });
        w3.handlers.get('disconnect')();
        expect(socketLogger.info.mock.calls.filter(([m, d]) => /Upgrade gate/.test(m) && d.socketId === w3.socket.id))
            .toEqual([['Upgrade gate: outdated iOS app', { socketId: w3.socket.id, build: BUILD, username: 'Zed', savedSession: false }]]);
        expect(JSON.stringify(socketLogger.info.mock.calls)).not.toContain('"x"');
    });

    test('after the 5 s push, signInResponse again every REPEAT_MS while connected (Register -> Sign In clears it)', () => {
        jest.useFakeTimers();
        const w = wired(UA_OLD);
        const pushes = () => w.emits('signInResponse').length;
        jest.advanceTimersByTime(5000);
        expect(pushes()).toBe(3);
        jest.advanceTimersByTime(gate.REPEAT_MS - 1);
        expect(pushes()).toBe(3);
        jest.advanceTimersByTime(1);
        expect(pushes()).toBe(4);
        jest.advanceTimersByTime(gate.REPEAT_MS * 5);
        expect(pushes()).toBe(9);
        expect(w.emits('signInResponse').every((l) => l.data.success === false && l.data.message === MSG_OUT)).toBe(true);
        w.handlers.get('disconnect')();
        jest.advanceTimersByTime(gate.REPEAT_MS * 10);
        expect(pushes()).toBe(9);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('rate limit: at most EMIT_LIMIT emits per socket per window; the timed pushes leave REPLY_RESERVE for replies', () => {
        jest.useFakeTimers();
        const w = wired(UA_OLD);
        for (let i = 0; i < 50; i++) w.handlers.get('signIn')({ username: 'Alan', password: 'x' });
        expect(w.log).toHaveLength(gate.EMIT_LIMIT);
        jest.advanceTimersByTime(5000); // the pushes are over the limit too
        expect(w.log).toHaveLength(gate.EMIT_LIMIT);
        jest.advanceTimersByTime(gate.EMIT_WINDOW_MS);
        const n0 = w.log.length;
        w.handlers.get('signIn')({ username: 'Alan', password: 'x' });
        expect(w.log).toHaveLength(n0 + 1);
        w.handlers.get('disconnect')();

        // a quiet socket left on sign-in for 10 minutes: the timed pushes
        // never use the replies' reserve, and a burst of taps still gets
        // REPLY_RESERVE replies in any window
        const q = wired(UA_OLD);
        const inWindow = () => q.log.filter((l) => Date.now() - l.at < gate.EMIT_WINDOW_MS).length;
        for (let s = 0; s < 600; s++) {
            jest.advanceTimersByTime(1000);
            expect(inWindow()).toBeLessThanOrEqual(gate.EMIT_LIMIT - gate.REPLY_RESERVE);
        }
        const before = q.log.length;
        for (let i = 0; i < gate.REPLY_RESERVE; i++) q.handlers.get('signIn')({ username: 'Alan', password: 'x' });
        expect(q.log.length - before).toBe(gate.REPLY_RESERVE);
        q.handlers.get('disconnect')();
    });

    test.each(['off', 'OFF', 'false', '0', 'disabled'])('kill switch UPGRADE_GATE=%s: the real handlers run', async (v) => {
        process.env.UPGRADE_GATE = v;
        const w = wired(UA_OLD);
        expect(w.handlers.has('playCard')).toBe(true);
        await w.send('restoreSession', { username: 'Alan', sessionToken: ALAN_TOKEN });
        expect(w.emits('restoreSessionResponse').map((l) => l.data)).toEqual([expect.objectContaining({ success: true, username: 'Alan' })]);
        expect(w.socket.data.appBuild).toBe(BUILD);
        gameManager.removeUserSocket(w.socket.id);
    });

    test('UPGRADE_GATE=on (or anything else) keeps the gate', () => {
        process.env.UPGRADE_GATE = 'on';
        const w = wired(UA_OLD);
        expect(w.handlers.has('playCard')).toBe(false);
        w.handlers.get('disconnect')();
    });
});

describe('never gated', () => {
    test.each([['1.2.0 build 3', UA_120], ['1.2.0 build 4', UA_124], ['a later build', 'BAB%20Online/40 CFNetwork/3896.200.61 Darwin/27.2.0'],
        ...BROWSERS.map((b) => [b.slice(0, 50), b]), ['no User-Agent', undefined], ...GARBAGE.filter((g) => typeof g === 'string').map((g) => [g.slice(0, 50), g])])(
        '%s: the real handlers', async (_l, ua) => {
            const w = wired(ua);
            expect(w.handlers.has('playCard')).toBe(true);
            await w.send('restoreSession', { username: 'Alan', sessionToken: ALAN_TOKEN });
            expect(w.emits('restoreSessionResponse').map((l) => l.data.success)).toEqual([true]);
            expect(w.emits('signInResponse')).toEqual([]);
            gameManager.removeUserSocket(w.socket.id);
        });

    test('a socket with no handshake at all (stubs, old harnesses)', () => {
        const log = [];
        const socket = makeSocket('no-handshake', log);
        const handlers = new Map();
        socket.on = (ev, fn) => handlers.set(ev, fn);
        setupSocketHandlers({ on: (ev, cb) => cb(socket) });
        expect(handlers.has('playCard')).toBe(true);
    });

    test('every iOS socket records its build (adoption telemetry), gated or not', () => {
        const old = wired(UA_110);
        expect(old.socket.data.appBuild).toBe(2);
        expect(socketLogger.info).toHaveBeenCalledWith('iOS app connected', { socketId: old.socket.id, build: 2 });
        old.handlers.get('disconnect')();
        const web = wired(BROWSERS[0]);
        expect(web.socket.data.appBuild).toBeUndefined();
    });

    test.each([[3, UA_120], [4, UA_124]])('1.2.0 (build %i) is current: parsed, recorded, never gated', (build, ua) => {
        expect(gate.parseIosUserAgent(ua)).toEqual({ client: 'ios', build });
        const w = wired(ua);
        expect(w.socket.data.appBuild).toBe(build);
        expect(w.handlers.has('playCard')).toBe(true);
        expect(socketLogger.info).toHaveBeenCalledWith('iOS app connected', { socketId: w.socket.id, build });
    });
});

// ---------- a real Socket.IO server: polling handshake, websocket upgrade, reconnect ----------

describe('over a real Socket.IO connection', () => {
    let httpServer;
    let io;
    let url;
    beforeAll(async () => {
        httpServer = http.createServer();
        io = new Server(httpServer);
        setupSocketHandlers(io);
        await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
        url = `http://127.0.0.1:${httpServer.address().port}`;
    });
    afterAll(async () => {
        io.close();
        await new Promise((r) => httpServer.close(r));
    });

    const connect = (ua, opts = {}) => ioClient(url, {
        transports: ['polling', 'websocket'], forceNew: true, reconnectionDelay: 50, reconnectionDelayMax: 100,
        ...(ua ? { extraHeaders: { 'User-Agent': ua } } : {}), ...opts,
    });
    const once = (c, ev, ms = 3000) => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
        c.once(ev, (d) => { clearTimeout(t); resolve(d); });
    });
    // until the SERVER side of the socket runs on the websocket transport
    const upgraded = async (c) => {
        for (let i = 0; i < 200; i++) {
            if (io.sockets.sockets.get(c.id)?.conn.transport.name === 'websocket') return;
            await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error('no websocket upgrade');
    };
    const serverSocket = (c) => io.sockets.sockets.get(c.id);

    test.each(OLD_BUILDS)('%s: gated after the websocket upgrade and again after a reconnect', async (_v, UA_OLD) => {
        const c = connect(UA_OLD);
        await once(c, 'connect');
        await upgraded(c);
        expect(serverSocket(c).conn.transport.name).toBe('websocket');
        expect(serverSocket(c).handshake.headers['user-agent']).toBe(UA_OLD);
        const reply = once(c, 'signInResponse');
        c.emit('restoreSession', { username: 'Alan', sessionToken: ALAN_TOKEN });
        expect(await reply).toEqual({ success: false, message: MSG });
        // a dropped transport: the client reconnects with a new polling handshake
        c.io.engine.close();
        await once(c, 'connect');
        const again = once(c, 'signInResponse');
        c.emit('signIn', { username: 'Alan', password: 'pw' });
        expect(await again).toEqual({ success: false, message: MSG_OUT });
        expect(gameManager.getOnlineUsernames()).not.toContain('Alan');
        c.close();
    });

    test.each([['1.2.0 build 4', UA_124], ['1.2.0 build 3', UA_120], ['a browser', BROWSERS[0]], ['no User-Agent override', null], ['garbage', 'BAB%20Online/1.0 x']])(
        '%s: never gated, after the upgrade and after a reconnect', async (_l, ua) => {
            const c = connect(ua);
            let gated = false;
            c.on('signInResponse', (d) => { if (d && d.message === MSG) gated = true; });
            c.on('signInResponse', (d) => { if (d && d.message === MSG_OUT) gated = true; });
            await once(c, 'connect');
            await upgraded(c);
            for (let round = 0; round < 2; round++) {
                const reply = once(c, 'restoreSessionResponse');
                c.emit('restoreSession', { username: 'Alan', sessionToken: ALAN_TOKEN });
                expect((await reply).success).toBe(true);
                if (round === 0) {
                    c.io.engine.close();
                    await once(c, 'connect');
                }
            }
            expect(gated).toBe(false);
            gameManager.removeUserSocket(c.id);
            c.close();
        });
});
