/**
 * Sign-in sessions: per-device tokens ("stay signed in" across devices) and
 * the behaviour of accounts retired by scripts/merge-accounts.js.
 */

const bcrypt = require('bcryptjs');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports
}));

jest.mock('../../game/GameManager', () => ({
    registerUser: jest.fn(),
    handleDisconnect: jest.fn(),
    getGameById: jest.fn(() => null),
    getTournamentById: jest.fn(() => null),
    clearActiveGame: jest.fn(),
    clearActiveTournament: jest.fn(),
    getUserBySocketId: jest.fn(),
    deletedUsernames: new Set()
}));

const gameManager = require('../../game/GameManager');
const auth = require('../authHandlers');
const profile = require('../profileHandlers');
const { hashToken, MAX_SESSIONS, SESSION_TTL_MS } = require('../../utils/sessionTokens');

let io;
let socketCounter = 0;

function connect() {
    const socket = {
        id: `sock-${++socketCounter}`,
        data: {},
        emit: jest.fn(),
        disconnect: jest.fn()
    };
    io.sockets.sockets.set(socket.id, socket);
    return socket;
}

function lastEmit(socket, event) {
    const calls = socket.emit.mock.calls.filter(([e]) => e === event);
    return calls.length ? calls[calls.length - 1][1] : undefined;
}

async function getUser(username) {
    return mockDb.current.users.findOne({ username });
}

beforeEach(async () => {
    jest.clearAllMocks();
    io = { sockets: { sockets: new Map() } };
    mockDb.current = createMemoryDb({
        users: [
            { username: 'Alan', password: await bcrypt.hash('pw', 4), stats: { gamesPlayed: 5 } },
            { username: 'Alan2', mergedInto: 'Alan', mergedAt: new Date() }
        ]
    });
});

async function signIn(socket, username = 'Alan', password = 'pw') {
    await auth.signIn(socket, io, { username, password });
    return lastEmit(socket, 'signInResponse');
}

async function restore(socket, sessionToken, username = 'Alan') {
    await auth.restoreSession(socket, io, { username, sessionToken });
    return lastEmit(socket, 'restoreSessionResponse');
}

describe('per-device sessions', () => {
    test('signing in on a second device keeps the first device signed in', async () => {
        const phone = connect();
        const { sessionToken: phoneToken } = await signIn(phone);
        // Phone app is backgrounded: its socket goes away
        io.sockets.sockets.delete(phone.id);

        const laptop = connect();
        const { sessionToken: laptopToken } = await signIn(laptop);
        expect(laptopToken).not.toBe(phoneToken);

        // Back on the phone the next day: no password needed
        const phoneAgain = connect();
        expect(await restore(phoneAgain, phoneToken)).toMatchObject({ success: true, username: 'Alan' });

        const user = await getUser('Alan');
        expect(user.sessionTokens).toHaveLength(2);
        expect(user.socketId).toBe(phoneAgain.id);
    });

    test('only token hashes are stored', async () => {
        const { sessionToken } = await signIn(connect());
        const user = await getUser('Alan');
        expect(JSON.stringify(user)).not.toContain(sessionToken);
        expect(user.sessionTokens[0].hash).toBe(hashToken(sessionToken));
    });

    test(`keeps at most ${MAX_SESSIONS} devices, dropping the oldest`, async () => {
        const tokens = [];
        for (let i = 0; i < MAX_SESSIONS + 1; i++) {
            tokens.push((await signIn(connect())).sessionToken);
        }
        expect((await getUser('Alan')).sessionTokens).toHaveLength(MAX_SESSIONS);
        expect(await restore(connect(), tokens[0])).toMatchObject({ success: false });
        expect(await restore(connect(), tokens[MAX_SESSIONS])).toMatchObject({ success: true });
    });

    test('sessions unused for longer than the TTL expire', async () => {
        const { sessionToken } = await signIn(connect());
        const stale = new Date(Date.now() - SESSION_TTL_MS - 1000);
        await mockDb.current.users.updateOne(
            { username: 'Alan' },
            { $set: { 'sessionTokens.0.lastUsedAt': stale, 'sessionTokens.0.createdAt': stale } }
        );
        expect(await restore(connect(), sessionToken)).toMatchObject({ success: false, message: 'Invalid session token' });
    });

    test('a legacy single sessionToken still works and is migrated', async () => {
        const legacy = '11111111-1111-4111-8111-111111111111';
        await mockDb.current.users.updateOne({ username: 'Alan' }, { $set: { sessionToken: legacy } });

        expect(await restore(connect(), legacy)).toMatchObject({ success: true });
        const user = await getUser('Alan');
        expect(user).not.toHaveProperty('sessionToken');
        expect(user.sessionTokens.map(e => e.hash)).toEqual([hashToken(legacy)]);
        // Deploying this change must not sign out the device holding the old token
        await signIn(connect());
        expect(await restore(connect(), legacy)).toMatchObject({ success: true });
    });

    test('a wrong token is rejected', async () => {
        await signIn(connect());
        expect(await restore(connect(), '22222222-2222-4222-8222-222222222222')).toMatchObject({ success: false });
    });
});

describe('one live connection per user', () => {
    test('another device resuming its session takes over the connection', async () => {
        const phone = connect();
        const { sessionToken: phoneToken } = await signIn(phone);
        io.sockets.sockets.delete(phone.id);
        const laptop = connect();
        await signIn(laptop);

        const phoneAgain = connect();
        await restore(phoneAgain, phoneToken);

        expect(laptop.emit).toHaveBeenCalledWith('forceLogout');
        expect(laptop.disconnect).toHaveBeenCalled();
        expect(gameManager.handleDisconnect).toHaveBeenCalledWith(laptop.id);
    });

    test('the same device reconnecting does not kick its own lingering socket', async () => {
        const first = connect();
        const { sessionToken } = await signIn(first);
        // Network blip: new socket arrives before the server notices the old one died
        const second = connect();
        expect(await restore(second, sessionToken)).toMatchObject({ success: true });

        expect(first.emit).not.toHaveBeenCalledWith('forceLogout');
        expect(gameManager.handleDisconnect).not.toHaveBeenCalled();
    });

    test('signing in with a password still kicks a live socket elsewhere', async () => {
        const laptop = connect();
        await signIn(laptop);
        await signIn(connect());
        expect(laptop.emit).toHaveBeenCalledWith('forceLogout');
    });
});

describe('merged (retired) accounts', () => {
    test('sign-in tells the player which account to use', async () => {
        const res = await signIn(connect(), 'Alan2', 'anything');
        expect(res.success).toBe(false);
        expect(res.message).toContain('Please sign in as Alan');
        expect(gameManager.registerUser).not.toHaveBeenCalled();
    });

    test('sign-up cannot re-register the name and points to the kept account', async () => {
        const socket = connect();
        await auth.signUp(socket, io, { username: 'Alan2', password: 'new' });
        const res = lastEmit(socket, 'signUpResponse');
        expect(res.success).toBe(false);
        expect(res.message).toContain('sign in as Alan');
        expect(await mockDb.current.users.countDocuments({ username: 'Alan2' })).toBe(1);
    });

    test('session restore for a merged name fails with the redirect message', async () => {
        const res = await restore(connect(), '33333333-3333-4333-8333-333333333333', 'Alan2');
        expect(res).toMatchObject({ success: false });
        expect(res.message).toContain('Alan');
    });

    test('player search hides merged names; profile lookup follows the merge', async () => {
        const socket = connect();
        await profile.searchPlayers(socket, io, { query: 'alan' });
        expect(lastEmit(socket, 'searchPlayersResponse').players.map(p => p.username)).toEqual(['Alan']);

        await profile.getPlayerProfile(socket, io, { username: 'Alan2' });
        expect(lastEmit(socket, 'playerProfileResponse').profile.username).toBe('Alan');
    });

    test('deleting the kept account also removes its merged tombstones', async () => {
        const socket = connect();
        gameManager.getUserBySocketId.mockReturnValue({ username: 'Alan' });
        jest.useFakeTimers();
        try {
            await auth.deleteAccount(socket, io, { password: 'pw' });
        } finally {
            jest.useRealTimers();
        }
        expect(lastEmit(socket, 'deleteAccountResponse')).toEqual({ success: true });
        expect(await mockDb.current.users.countDocuments({})).toBe(0);
    });
});

describe('sign-up', () => {
    test('new accounts get a per-device session', async () => {
        const socket = connect();
        await auth.signUp(socket, io, { username: 'Newbie', password: 'pw' });
        const { sessionToken } = lastEmit(socket, 'signUpResponse');
        const user = await getUser('Newbie');
        expect(user).not.toHaveProperty('sessionToken');
        expect(user.sessionTokens.map(e => e.hash)).toEqual([hashToken(sessionToken)]);
        expect(await restore(connect(), sessionToken, 'Newbie')).toMatchObject({ success: true });
    });
});
