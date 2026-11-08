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

    test('losing a concurrent sign-up race (duplicate key) reports the name as taken', async () => {
        const socket = connect();
        // Both sign-ups passed the findOne check; the unique index rejects this insert
        jest.spyOn(mockDb.current.users, 'insertOne').mockRejectedValueOnce(
            Object.assign(new Error('E11000 duplicate key error collection: babonline.users index: username_1'), { code: 11000 })
        );
        await auth.signUp(socket, io, { username: 'Racer', password: 'pw' });
        expect(lastEmit(socket, 'signUpResponse')).toEqual({ success: false, message: 'Username already taken!' });
        expect(gameManager.registerUser).not.toHaveBeenCalled();
        expect(socket.data.sessionHash).toBeUndefined();
    });
});

describe('users.username unique index', () => {
    const { ensureUsernameIndex } = jest.requireActual('../../database');

    test('is created unique on username', async () => {
        const collection = { createIndex: jest.fn(async () => 'username_1') };
        await ensureUsernameIndex(collection);
        expect(collection.createIndex).toHaveBeenCalledWith({ username: 1 }, { unique: true });
    });

    test('existing duplicate usernames do not crash startup', async () => {
        const collection = {
            createIndex: jest.fn(async () => {
                throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
            })
        };
        await expect(ensureUsernameIndex(collection)).resolves.toBeUndefined();
    });
});

describe('projected sign-in reads', () => {
    const legacy = '44444444-4444-4444-8444-444444444444';
    const bigPic = 'data:image/png;base64,' + 'A'.repeat(4096);

    beforeEach(async () => {
        await mockDb.current.users.insertOne({
            username: 'Cara',
            password: await bcrypt.hash('pw', 4),
            customProfilePic: bigPic,
            profilePic: 9,
            stats: { gamesPlayed: 2, wins: 1 },
            mergedFrom: [{ username: 'OldCara', mergedAt: new Date() }],
            activeGameId: 'G1',
            activeTournamentId: 'T1',
            blockedUsers: ['Mallory'],
            sessionToken: legacy
        });
    });

    afterEach(() => jest.restoreAllMocks());

    test('signIn reads without the picture/stats/audit log and replies exactly as before (active game)', async () => {
        const spy = jest.spyOn(mockDb.current.users, 'findOne');
        gameManager.getGameById.mockImplementation((id) => (id === 'G1' ? { gameId: 'G1' } : null));
        const res = await signIn(connect(), 'Cara', 'pw');
        expect(res).toEqual({
            success: true, username: 'Cara', sessionToken: expect.any(String),
            activeGameId: 'G1', blockedUsers: ['Mallory']
        });
        const read = await spy.mock.results[0].value;
        expect(read).not.toHaveProperty('customProfilePic');
        expect(read).not.toHaveProperty('stats');
        expect(read).not.toHaveProperty('mergedFrom');
        expect(read).toMatchObject({ activeGameId: 'G1', activeTournamentId: 'T1', blockedUsers: ['Mallory'], sessionToken: legacy });
        expect(typeof read.password).toBe('string');
        gameManager.getGameById.mockImplementation(() => null);
    });

    test('signIn with a stale game and a live tournament: scoped clear, tournament reply', async () => {
        gameManager.getTournamentById.mockImplementation((id) => (id === 'T1' ? { id: 'T1' } : null));
        const res = await signIn(connect(), 'Cara', 'pw');
        expect(res).toEqual({
            success: true, username: 'Cara', sessionToken: expect.any(String),
            activeTournamentId: 'T1', blockedUsers: ['Mallory']
        });
        expect(gameManager.clearActiveGame).toHaveBeenCalledWith('Cara', 'G1');
        expect(gameManager.clearActiveTournament).not.toHaveBeenCalled();
        gameManager.getTournamentById.mockImplementation(() => null);
    });

    test('signIn with nothing live clears both pointers, scoped to their ids', async () => {
        const res = await signIn(connect(), 'Cara', 'pw');
        expect(res).toEqual({ success: true, username: 'Cara', sessionToken: expect.any(String), blockedUsers: ['Mallory'] });
        expect(gameManager.clearActiveGame).toHaveBeenCalledWith('Cara', 'G1');
        expect(gameManager.clearActiveTournament).toHaveBeenCalledWith('Cara', 'T1');
    });

    test('restoreSession reads without the password too, replies as before and still migrates the legacy token', async () => {
        const spy = jest.spyOn(mockDb.current.users, 'findOne');
        gameManager.getGameById.mockImplementation((id) => (id === 'G1' ? { gameId: 'G1' } : null));
        const res = await restore(connect(), legacy, 'Cara');
        expect(res).toEqual({ success: true, username: 'Cara', activeGameId: 'G1', blockedUsers: ['Mallory'] });
        const read = await spy.mock.results[0].value;
        expect(read).not.toHaveProperty('password');
        expect(read).not.toHaveProperty('customProfilePic');
        const user = await getUser('Cara');
        expect(user).not.toHaveProperty('sessionToken');
        expect(user.sessionTokens.map(e => e.hash)).toEqual([hashToken(legacy)]);
        expect(user.customProfilePic).toBe(bigPic);
        gameManager.getGameById.mockImplementation(() => null);
    });

    test('a user document without a password hash is an ordinary failed sign-in', async () => {
        await mockDb.current.users.insertOne({ username: 'NoHash' });
        const res = await signIn(connect(), 'NoHash', 'pw');
        expect(res).toEqual({ success: false, message: 'Invalid username or password!' });
    });

    test('profile and player profile still carry the picture and stats', async () => {
        const socket = connect();
        gameManager.getUserBySocketId.mockReturnValue({ username: 'Cara' });
        await profile.getProfile(socket, io);
        expect(lastEmit(socket, 'profileResponse').profile).toEqual({
            username: 'Cara', profilePic: 9, customProfilePic: bigPic, stats: { gamesPlayed: 2, wins: 1 }
        });
        await profile.getPlayerProfile(socket, io, { username: 'Cara' });
        expect(lastEmit(socket, 'playerProfileResponse').profile.customProfilePic).toBe(bigPic);
    });
});
