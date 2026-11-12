/**
 * Sign-in sessions: per-device tokens ("stay signed in" across devices) and
 * the behaviour of accounts retired by scripts/merge-accounts.js.
 */

const bcrypt = require('bcryptjs');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null, cold: false, whenReady: null };
jest.mock('../../database', () => ({
    // cold: the server is up but connectDB has not assigned the collections yet
    getUsersCollection: () => (mockDb.cold ? undefined : mockDb.current.users),
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: (ms) => (mockDb.whenReady ? mockDb.whenReady(ms) : Promise.resolve(!mockDb.cold))
}));

jest.mock('../../game/GameManager', () => ({
    registerUser: jest.fn(),
    removeUserSocket: jest.fn(),
    handleDisconnect: jest.fn(() => ({})),
    releaseHeldLobbySeat: jest.fn(() => null),
    getOnlineUsernames: jest.fn(() => []),
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
        disconnect: jest.fn(),
        join: jest.fn(),
        leave: jest.fn()
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
    mockDb.cold = false;
    mockDb.whenReady = null;
    require('../signInThrottle')._reset();
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
        expect(lastEmit(socket, 'signUpResponse')).toEqual({ success: false, message: 'That name is taken.' });
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

    test('duplicates: a non-unique fallback keeps lookups indexed; a later boot drops it and retries unique', async () => {
        const { USERNAME_FALLBACK_INDEX } = jest.requireActual('../../database');
        let dups = true;
        const names = new Set(['_id_']);
        const collection = {
            indexes: jest.fn(async () => [...names].map(name => ({ name }))),
            dropIndex: jest.fn(async (name) => { names.delete(name); }),
            createIndex: jest.fn(async (keys, opts) => {
                if (opts.unique) {
                    if (dups) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
                    names.add('username_1');
                } else {
                    names.add(opts.name);
                }
            })
        };
        await ensureUsernameIndex(collection);
        expect([...names].sort()).toEqual(['_id_', USERNAME_FALLBACK_INDEX].sort());
        await ensureUsernameIndex(collection); // still duplicated: rebuilt
        expect([...names].sort()).toEqual(['_id_', USERNAME_FALLBACK_INDEX].sort());
        dups = false;
        await ensureUsernameIndex(collection);
        expect([...names].sort()).toEqual(['_id_', 'username_1']);
    });

    test('a non-duplicate failure builds no fallback', async () => {
        const collection = {
            indexes: jest.fn(async () => []),
            createIndex: jest.fn(async () => { throw Object.assign(new Error('not authorized'), { code: 13 }); })
        };
        await expect(ensureUsernameIndex(collection)).resolves.toBeUndefined();
        expect(collection.createIndex).toHaveBeenCalledTimes(1);
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

describe('cold start (connectDB still running)', () => {
    test('restoreSession waits for the database instead of failing (no forced sign-out)', async () => {
        const { sessionToken } = await signIn(connect());
        mockDb.cold = true;
        const waits = [];
        mockDb.whenReady = async (ms) => { waits.push(ms); mockDb.cold = false; return true; };
        expect(await restore(connect(), sessionToken)).toMatchObject({ success: true, username: 'Alan' });
        expect(waits).toEqual([10000]);
    });

    test('signIn and signUp wait too', async () => {
        mockDb.cold = true;
        mockDb.whenReady = async () => { mockDb.cold = false; return true; };
        expect(await signIn(connect())).toMatchObject({ success: true });
        mockDb.cold = true;
        const s = connect();
        await auth.signUp(s, io, { username: 'Late', password: 'pw' });
        expect(lastEmit(s, 'signUpResponse')).toMatchObject({ success: true, username: 'Late' });
    });

    test('still down after the wait: the same replies as before', async () => {
        mockDb.cold = true;
        mockDb.whenReady = async () => false;
        expect(await signIn(connect())).toEqual({ success: false, message: 'Database error. Try again.' });
        expect(await restore(connect(), '55555555-5555-4555-8555-555555555555'))
            .toEqual({ success: false, message: 'Database error. Try again.' });
        const s = connect();
        await auth.signUp(s, io, { username: 'Late', password: 'pw' });
        expect(lastEmit(s, 'signUpResponse')).toEqual({ success: false, message: 'Database not ready. Try again.' });
    });

    test('a token rejoin (web reload) waits too instead of "Not authenticated"', async () => {
        const { sessionToken } = await signIn(connect());
        mockDb.cold = true;
        mockDb.whenReady = async () => { mockDb.cold = false; return true; };
        const reconnect = require('../reconnectHandlers');
        const s = connect();
        await reconnect.rejoinGame(s, io, { gameId: 'gone', username: 'Alan', sessionToken });
        expect(lastEmit(s, 'rejoinFailed')).toEqual({ reason: 'Game no longer exists' });
    });

    test('database.whenReady times out to false before connectDB ever ran', async () => {
        const { whenReady } = jest.requireActual('../../database');
        await expect(whenReady(5)).resolves.toBe(false);
    });
});

describe('failed sign-in throttle', () => {
    const passwordHash = require('../../utils/passwordHash');
    const THROTTLED = { success: false, message: 'Too many failed sign-in attempts. Please wait a few minutes and try again.' };
    const from = (ip) => { const s = connect(); s.data.clientIp = ip; return s; };

    afterEach(() => jest.restoreAllMocks());

    test('the 11th wrong attempt for a pair is refused before any DB read or hash; another IP still works', async () => {
        for (let i = 0; i < 10; i++) {
            expect(await signIn(from('198.51.100.1'), 'Alan', 'wrong')).toEqual({ success: false, message: 'Invalid username or password!' });
        }
        const findOne = jest.spyOn(mockDb.current.users, 'findOne');
        const compare = jest.spyOn(passwordHash, 'compare');
        expect(await signIn(from('198.51.100.1'), 'Alan', 'pw')).toEqual(THROTTLED);
        expect(findOne).not.toHaveBeenCalled();
        expect(compare).not.toHaveBeenCalled();
        // The same person on the phone network signs in fine
        expect(await signIn(from('203.0.113.50'), 'Alan', 'pw')).toMatchObject({ success: true });
    });

    test('30 failures across 30 IPs lock the username, even with the right password', async () => {
        for (let i = 0; i < 30; i++) await signIn(from(`192.0.2.${i + 1}`), 'Alan', 'wrong');
        expect(await signIn(from('203.0.113.77'), 'Alan', 'pw')).toEqual(THROTTLED);
        expect(gameManager.registerUser).not.toHaveBeenCalled();
    });

    test('family NAT: 49 failures from one IP, then 6 family members sign in from it', async () => {
        const family = ['Mom', 'Dad', 'Kid1', 'Kid2', 'Gran', 'Pop'];
        const hash = await bcrypt.hash('pw', 4);
        for (const u of family) await mockDb.current.users.insertOne({ username: u, password: hash });
        const nat = '203.0.113.10';
        for (let i = 0; i < 49; i++) await signIn(from(nat), family[i % 6], 'typo');
        const replies = await Promise.all(family.map(u => signIn(from(nat), u, 'pw')));
        expect(replies.every(r => r.success === true)).toBe(true);
    });

    test('unknown usernames count; a merged-account redirect does not', async () => {
        for (let i = 0; i < 10; i++) await signIn(from('198.51.100.9'), 'Nobody', 'x');
        expect(await signIn(from('198.51.100.9'), 'Nobody', 'x')).toEqual(THROTTLED);
        for (let i = 0; i < 15; i++) {
            expect((await signIn(from('198.51.100.9'), 'Alan2', 'x')).message).toContain('Please sign in as Alan');
        }
    });

    test('database errors and a busy hash pool are not counted', async () => {
        jest.spyOn(mockDb.current.users, 'findOne').mockRejectedValue(new Error('db down'));
        for (let i = 0; i < 12; i++) await signIn(from('198.51.100.3'), 'Alan', 'pw');
        jest.restoreAllMocks();
        jest.spyOn(passwordHash, 'compare').mockRejectedValue(Object.assign(new Error('full'), { code: 'HASH_BUSY' }));
        for (let i = 0; i < 12; i++) {
            expect(await signIn(from('198.51.100.3'), 'Alan', 'pw')).toEqual({ success: false, message: 'Server is busy. Try again in a moment.' });
        }
        jest.restoreAllMocks();
        expect(await signIn(from('198.51.100.3'), 'Alan', 'pw')).toMatchObject({ success: true });
    });

    test('after a lockout, restoreSession with a saved token still works (never throttled)', async () => {
        const { sessionToken } = await signIn(from('198.51.100.4'), 'Alan', 'pw');
        for (let i = 0; i < 30; i++) await signIn(from(`192.0.2.${i + 100}`), 'Alan', 'wrong');
        // A new network is refused...
        expect(await signIn(from('198.51.100.40'), 'Alan', 'pw')).toEqual(THROTTLED);
        // ...saved sessions are never throttled, from any network
        for (let i = 0; i < 20; i++) {
            expect(await restore(from(i % 2 ? '198.51.100.4' : '198.51.100.41'), sessionToken)).toMatchObject({ success: true, username: 'Alan' });
        }
    });

    test('a username lockout from other IPs never blocks the household that signed in before', async () => {
        // Regression: the username key (30) applied before the hash, so an
        // outsider could keep a family member's correct password refused
        const home = '203.0.113.20';
        expect(await signIn(from(home), 'Alan', 'pw')).toMatchObject({ success: true });
        for (let i = 0; i < 30; i++) await signIn(from(`192.0.2.${i + 1}`), 'Alan', 'wrong');
        expect(await signIn(from('198.51.100.60'), 'Alan', 'pw')).toEqual(THROTTLED);
        expect(await signIn(from(home), 'Alan', 'pw')).toMatchObject({ success: true });
        // The household's own typos still lock its pair at 10
        for (let i = 0; i < 10; i++) await signIn(from(home), 'Alan', 'wrong');
        expect(await signIn(from(home), 'Alan', 'pw')).toEqual(THROTTLED);
    });

    test('a restored session marks its network known-good for password sign-in', async () => {
        const { sessionToken } = await signIn(from('198.51.100.70'), 'Alan', 'pw');
        const phoneNet = '203.0.113.21';
        expect(await restore(from(phoneNet), sessionToken)).toMatchObject({ success: true });
        for (let i = 0; i < 30; i++) await signIn(from(`192.0.2.${i + 50}`), 'Alan', 'wrong');
        expect(await signIn(from(phoneNet), 'Alan', 'pw')).toMatchObject({ success: true });
    });

    test('a success clears the pair', async () => {
        const ip = '198.51.100.5';
        for (let i = 0; i < 9; i++) await signIn(from(ip), 'Alan', 'wrong');
        expect(await signIn(from(ip), 'Alan', 'pw')).toMatchObject({ success: true });
        for (let i = 0; i < 10; i++) {
            expect(await signIn(from(ip), 'Alan', 'wrong')).toEqual({ success: false, message: 'Invalid username or password!' });
        }
        expect(await signIn(from(ip), 'Alan', 'pw')).toEqual(THROTTLED);
    });

    test('concurrent wrong attempts cannot overshoot the pair limit', async () => {
        const ip = '198.51.100.6';
        const replies = await Promise.all(Array.from({ length: 25 }, () => signIn(from(ip), 'Alan', 'wrong')));
        expect(replies.filter(r => r.message === 'Invalid username or password!')).toHaveLength(10);
        expect(replies.filter(r => r.message === THROTTLED.message)).toHaveLength(15);
    });

    test('no client IP: only the username key applies', async () => {
        for (let i = 0; i < 60; i++) await signIn(from(null), `ghost${i}`, 'x');
        expect(await signIn(from(null), 'Alan', 'pw')).toMatchObject({ success: true });
        // Regression: a null IP made one shared 'unknown|Alan' pair key with a
        // limit of 10, so 10 failures from anyone locked every null-IP device
        for (let i = 0; i < 10; i++) await signIn(from(null), 'Alan', 'wrong');
        expect(await signIn(from(null), 'Alan', 'pw')).toMatchObject({ success: true });
        for (let i = 0; i < 30; i++) await signIn(from(null), 'Alan', 'wrong');
        expect(await signIn(from(null), 'Alan', 'pw')).toEqual(THROTTLED);
    });
});

describe('a revoke always wins against a sign-in / restore / rejoin in flight', () => {
    const { REVOKE_ALL_SESSIONS, verifySession } = require('../../utils/sessionTokens');
    const { writePasswordHash } = require('../../admin/setPassword');

    // Run `revoke` right after the handler's read of the user document,
    // i.e. between its findOne and its write (the race window)
    function revokeAfterNextRead(revoke) {
        const users = mockDb.current.users;
        const original = users.findOne.bind(users);
        users.findOne = async (...args) => {
            const doc = await original(...args);
            users.findOne = original;
            await revoke();
            return doc;
        };
    }
    const signOutEverywhere = () => mockDb.current.users.updateOne({ username: 'Alan' }, REVOKE_ALL_SESSIONS);

    async function twoDevices() {
        const phone = await signIn(connect());
        const stolen = await signIn(connect());
        expect((await getUser('Alan')).sessionTokens).toHaveLength(2);
        return { phone: phone.sessionToken, stolen: stolen.sessionToken };
    }

    test('restoreSession racing sign out everywhere: refused, and no session comes back', async () => {
        const { phone, stolen } = await twoDevices();
        revokeAfterNextRead(signOutEverywhere);
        const s = connect();
        expect(await restore(s, stolen)).toEqual({ success: false, message: 'Invalid session token' });
        const user = await getUser('Alan');
        expect(user.sessionTokens).toBeUndefined();
        expect(verifySession(user, stolen)).toBeNull();
        expect(verifySession(user, phone)).toBeNull();
        expect(user.socketId).not.toBe(s.id);
        expect(s.data.sessionHash).toBeUndefined();
        expect(gameManager.registerUser).not.toHaveBeenCalledWith(s.id, 'Alan');
        // and the token stays dead afterwards
        expect(await restore(connect(), stolen)).toMatchObject({ success: false });
    });

    test('restoreSession racing a password reset (writePasswordHash): refused, nothing comes back', async () => {
        const { stolen } = await twoDevices();
        revokeAfterNextRead(async () => {
            const u = await mockDb.current.users.findOne({ username: 'Alan' });
            await writePasswordHash(mockDb.current, u, await bcrypt.hash('new', 4), { stampField: 'passwordResetByLinkAt' });
        });
        expect(await restore(connect(), stolen)).toMatchObject({ success: false });
        expect((await getUser('Alan')).sessionTokens).toBeUndefined();
    });

    test('signIn with the old password racing a reset: refused, and the old sessions stay revoked', async () => {
        const { phone, stolen } = await twoDevices();
        revokeAfterNextRead(async () => {
            const u = await mockDb.current.users.findOne({ username: 'Alan' });
            await writePasswordHash(mockDb.current, u, await bcrypt.hash('new', 4), { stampField: 'passwordResetByLinkAt' });
        });
        const s = connect();
        const reply = await signIn(s, 'Alan', 'pw');
        expect(reply).toEqual({ success: false, message: 'Your account was just signed out everywhere. Please sign in again.' });
        const user = await getUser('Alan');
        expect(user.sessionTokens).toBeUndefined();
        expect(verifySession(user, phone)).toBeNull();
        expect(verifySession(user, stolen)).toBeNull();
        expect(gameManager.registerUser).not.toHaveBeenCalledWith(s.id, 'Alan');
        // the new password works; the old one does not
        expect(await signIn(connect(), 'Alan', 'pw')).toMatchObject({ success: false });
        expect(await signIn(connect(), 'Alan', 'new')).toMatchObject({ success: true });
    });

    test('a token rejoin racing sign out everywhere is refused and writes nothing back', async () => {
        const { stolen } = await twoDevices();
        revokeAfterNextRead(signOutEverywhere);
        const { rejoinGame } = require('../reconnectHandlers');
        const s = connect();
        await rejoinGame(s, io, { gameId: 'g1', username: 'Alan', sessionToken: stolen });
        expect(lastEmit(s, 'rejoinFailed')).toEqual({ reason: 'Not authenticated' });
        expect((await getUser('Alan')).sessionTokens).toBeUndefined();
        expect(s.data.sessionHash).toBeUndefined();
    });

    test('a merge retiring the account bumps the epoch too (restore in flight cannot revive the tombstone)', async () => {
        const { stolen } = await twoDevices();
        revokeAfterNextRead(() => mockDb.current.users.updateOne(
            { username: 'Alan' },
            { $set: { mergedInto: 'Other' }, $unset: { sessionTokens: '', sessionToken: '' }, $inc: { sessionEpoch: 1 } }
        ));
        expect(await restore(connect(), stolen)).toMatchObject({ success: false });
        expect((await getUser('Alan')).sessionTokens).toBeUndefined();
    });

    test('without a revoke, restores and sign-ins keep working across epochs', async () => {
        await signOutEverywhere(); // epoch 1, no sessions
        const a = await signIn(connect());
        expect(a).toMatchObject({ success: true });
        expect(await restore(connect(), a.sessionToken)).toMatchObject({ success: true });
        expect((await getUser('Alan')).sessionEpoch).toBe(1);
    });
});

describe('a revoke landing AFTER the write but before the reply (RST-SOCK)', () => {
    const { writePasswordHash } = require('../../admin/setPassword');
    const { rejoinGame } = require('../reconnectHandlers');

    /**
     * A controllable database: the handler's next users.updateOne lands
     * (the write is applied) but its reply is held until release(). The
     * epoch filter cannot catch a revoke made meanwhile: the write landed
     * first.
     */
    function holdNextWriteReply() {
        const users = mockDb.current.users;
        const original = users.updateOne.bind(users);
        let release;
        let landed;
        const gate = new Promise(r => { release = r; });
        const writeLanded = new Promise(r => { landed = r; });
        users.updateOne = async (...args) => {
            users.updateOne = original;
            const res = await original(...args);
            landed();
            await gate;
            return res;
        };
        return { writeLanded, release };
    }

    // The CLI (scripts/set-password.js) revokes from another process: no
    // signOutUser at all, so only the re-check after registerUser sees it
    const cliReset = async () => {
        const u = await mockDb.current.users.findOne({ username: 'Alan' });
        await writePasswordHash(mockDb.current, u, await bcrypt.hash('new', 4), { stampField: 'passwordResetByAdminAt' });
    };

    function liveSocket() {
        const s = connect();
        s.connected = true;
        s.disconnect = jest.fn(() => { s.connected = false; io.sockets.sockets.delete(s.id); });
        return s;
    }

    test('restoreSession: the re-check after registerUser refuses it and undoes the registration', async () => {
        const { sessionToken } = await signIn(connect());
        const hold = holdNextWriteReply();
        const s = connect();
        const pending = restore(s, sessionToken);
        await hold.writeLanded;
        expect((await getUser('Alan')).socketId).toBe(s.id); // the write landed
        await cliReset();
        hold.release();
        expect(await pending).toEqual({ success: false, message: 'Invalid session token' });
        expect(gameManager.registerUser).toHaveBeenCalledWith(s.id, 'Alan');
        expect(gameManager.removeUserSocket).toHaveBeenCalledWith(s.id);
        expect(s.data.sessionHash).toBeUndefined();
        expect(s.data.username).toBeUndefined();
        expect(s.emit.mock.calls.filter(([e, d]) => e === 'restoreSessionResponse' && d.success)).toHaveLength(0);
    });

    test('signIn: the same re-check (a reset landing after its write)', async () => {
        const hold = holdNextWriteReply();
        const s = connect();
        const pending = signIn(s, 'Alan', 'pw');
        await hold.writeLanded;
        await cliReset();
        hold.release();
        expect(await pending).toEqual({ success: false, message: 'Your account was just signed out everywhere. Please sign in again.' });
        expect(gameManager.removeUserSocket).toHaveBeenCalledWith(s.id);
        expect(s.emit.mock.calls.filter(([e, d]) => e === 'signInResponse' && d.success)).toHaveLength(0);
    });

    test('restoreSession: a revoke whose sign-out runs while the write is in flight finds the socket by its claim', async () => {
        const { sessionToken } = await signIn(connect());
        const hold = holdNextWriteReply();
        const s = liveSocket();
        const pending = restore(s, sessionToken);
        await hold.writeLanded;
        // The game manager has not registered s yet and no socketId is passed:
        // only socket.data.username names it
        await cliReset();
        // the device that signed in first, and s (by its claim alone)
        expect(auth.signOutUser(io, 'Alan')).toBe(2);
        expect(s.emit).toHaveBeenCalledWith('forceLogout');
        expect(s.disconnect).toHaveBeenCalled();
        hold.release();
        expect(await pending).toBeUndefined(); // a closed socket gets no reply
        expect(gameManager.removeUserSocket).toHaveBeenCalledWith(s.id);
    });

    test('a token rejoin: claimed before its write, so a sign-out in flight closes it and it is never seated', async () => {
        const { sessionToken } = await signIn(connect());
        const hold = holdNextWriteReply();
        const s = liveSocket();
        const pending = rejoinGame(s, io, { gameId: 'g1', username: 'Alan', sessionToken });
        await hold.writeLanded;
        await cliReset();
        // the device that signed in first, and s (by its claim alone)
        expect(auth.signOutUser(io, 'Alan')).toBe(2);
        hold.release();
        await pending;
        expect(s.emit).toHaveBeenCalledWith('forceLogout');
        // dropped as disconnected: never looked up a game, never seated
        expect(gameManager.getGameById).not.toHaveBeenCalled();
        expect(s.emit.mock.calls.map(([e]) => e)).not.toContain('rejoinSuccess');
    });

    test('a refused attempt gives its claim back (signOutUser no longer names that socket)', async () => {
        const s = liveSocket();
        expect(await signIn(s, 'Alan', 'wrong')).toMatchObject({ success: false });
        expect(s.data.username).toBeUndefined();
        expect(auth.signOutUser(io, 'Alan')).toBe(0);
    });
});

describe('account deletion and the admin role', () => {
    async function del(username) {
        const socket = connect();
        gameManager.getUserBySocketId.mockReturnValue({ username });
        jest.useFakeTimers();
        try {
            await auth.deleteAccount(socket, io, { password: 'pw' });
        } finally {
            jest.useRealTimers();
        }
        return lastEmit(socket, 'deleteAccountResponse');
    }

    test('the only admin cannot delete their account (it would leave zero admins); nothing is removed', async () => {
        await mockDb.current.users.updateOne({ username: 'Alan' }, { $set: { isAdmin: true } });
        expect(await del('Alan')).toEqual({
            success: false,
            message: 'You are the only admin. Make someone else an admin before deleting your account.'
        });
        const alan = await getUser('Alan');
        expect(alan).toMatchObject({ username: 'Alan', isAdmin: true });
        expect(await mockDb.current.users.countDocuments({})).toBe(2);
    });

    test('with another admin left, an admin can delete their account', async () => {
        const pw = await bcrypt.hash('pw', 4);
        await mockDb.current.users.insertOne({ username: 'Bea', password: pw, isAdmin: true });
        await mockDb.current.users.updateOne({ username: 'Alan' }, { $set: { isAdmin: true } });
        expect(await del('Alan')).toEqual({ success: true });
        expect(await getUser('Alan')).toBeNull();
        expect(await mockDb.current.users.countDocuments({ isAdmin: true })).toBe(1);
    });

    test('two last admins deleting at the same moment: one stays', async () => {
        const pw = await bcrypt.hash('pw', 4);
        await mockDb.current.users.insertOne({ username: 'Bea', password: pw, isAdmin: true });
        await mockDb.current.users.updateOne({ username: 'Alan' }, { $set: { isAdmin: true } });
        const replies = await Promise.all([del('Alan'), del('Bea')]);
        expect(replies.filter(r => r.success)).toHaveLength(1);
        expect(await mockDb.current.users.countDocuments({ isAdmin: true })).toBe(1);
    });
});
