/**
 * Limits that outlive a socket, through the real auth handlers:
 * - sign-ups per client IP (IPv6 by its /64 and its /48) and server-wide
 *   (rateLimiter.buckets signUpIp / signUpNet48 / signUpGlobal), which a
 *   reconnect does not reset;
 * - the hash pool keeps room for compares, so a sign-up flood never turns
 *   a real sign-in into "Server is busy" (passwordHash MAX_PENDING_HASH,
 *   with a fake slow hasher);
 * - deleteAccount's password check counts in signInThrottle like a sign-in.
 */

const bcrypt = require('bcryptjs');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
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
    deletedUsernames: new Set(),
}));

const gameManager = require('../../game/GameManager');
const auth = require('../authHandlers');
const rateLimiter = require('../rateLimiter');
const signInThrottle = require('../signInThrottle');
const passwordHash = require('../../utils/passwordHash');
const { authLogger } = require('../../utils/logger');

const NETWORK = /^Too many new accounts from this network\. Please try again in \d+ minutes?\.$/;
const SERVER_WIDE = 'Too many new accounts are being created right now. Please try again in a few minutes.';
const SIGN_IN_THROTTLED = 'Too many failed sign-in attempts. Please wait a few minutes and try again.';
const DELETE_THROTTLED = 'Too many incorrect passwords. Please wait a few minutes and try again.';
const SIGN_UP_LIMIT = 'Too many sign-up attempts. Please wait a few minutes and try again.';
const HOUR = 3600000;

let io;
let n = 0;
let clock;
let names = 0;

function connect(ip = null) {
    const socket = { id: `al-${++n}`, data: { clientIp: ip }, emit: jest.fn(), disconnect: jest.fn(), join: jest.fn(), leave: jest.fn() };
    io.sockets.sockets.set(socket.id, socket);
    return socket;
}
const lastEmit = (socket, event) => {
    const calls = socket.emit.mock.calls.filter(([e]) => e === event);
    return calls.length ? calls[calls.length - 1][1] : undefined;
};
// Valid new names (digits only after the word, so no profanity substring by chance)
const freshName = () => `Acct ${++names}`;

async function signUp(socket, username = freshName()) {
    await auth.signUp(socket, io, { username, password: 'secret-pw' });
    return lastEmit(socket, 'signUpResponse');
}

const cheapHasher = (op, a, b) => (op === 'hash' ? bcrypt.hash(a, 4) : bcrypt.compare(a, b));

beforeEach(async () => {
    jest.clearAllMocks();
    // A clock far from every earlier test's, so the one-line-a-minute log throttle starts fresh
    clock = 1.9e12 + n * HOUR;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    for (const m of ['info', 'debug']) jest.spyOn(authLogger, m).mockImplementation(() => {});
    jest.spyOn(authLogger, 'warn').mockImplementation(() => {});
    rateLimiter._resetBuckets();
    rateLimiter.requests.clear();
    signInThrottle._reset();
    passwordHash._setRunnerForTests(cheapHasher);
    io = { sockets: { sockets: new Map() } };
    mockDb.current = createMemoryDb({
        users: [{ username: 'Alan', password: await bcrypt.hash('pw', 4), stats: { gamesPlayed: 1 } }],
    });
});

afterEach(() => {
    passwordHash._setRunnerForTests(null);
    jest.restoreAllMocks();
});

describe('sign-ups per client IP (rateLimiter.buckets.signUpIp)', () => {
    test('the production budget: 5 at once, then 5 an hour per IP; 20 at once, then 60 an hour server-wide', () => {
        expect(rateLimiter.buckets.signUpIp).toEqual({ burst: 5, perHour: 5, maxKeys: 10000 });
        expect(rateLimiter.buckets.signUpNet48).toEqual({ burst: 10, perHour: 10, maxKeys: 10000 });
        expect(rateLimiter.buckets.signUpGlobal).toMatchObject({ burst: 20, perHour: 60 });
    });

    test('sockets on the same IP share one bucket; another IP has its own', async () => {
        for (let i = 0; i < 5; i++) expect(await signUp(connect('203.0.113.7'))).toMatchObject({ success: true });
        const refused = await signUp(connect('203.0.113.7'));
        expect(refused.success).toBe(false);
        expect(refused.message).toMatch(NETWORK);
        expect(Object.keys(refused).sort()).toEqual(['message', 'success']);
        expect(await signUp(connect('198.51.100.20'))).toMatchObject({ success: true });
        expect(await mockDb.current.users.countDocuments({})).toBe(1 + 6);
    });

    test('a reconnect (a new socket, the old one cleared) does not reset it', async () => {
        for (let i = 0; i < 5; i++) {
            const s = connect('203.0.113.8');
            expect(await signUp(s)).toMatchObject({ success: true });
            rateLimiter.clearSocket(s.id); // the disconnect handler's cleanup
        }
        expect((await signUp(connect('203.0.113.8'))).message).toMatch(NETWORK);
    });

    test('an IPv6 address counts by its /64', async () => {
        const sameHome = ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:DB8:1:2:ffff::9', '2001:db8:1:2:0:0:0:abcd', '2001:db8:1:2::77'];
        for (const ip of sameHome) expect(await signUp(connect(ip))).toMatchObject({ success: true });
        expect((await signUp(connect('2001:db8:1:2:dead:beef::1'))).message).toMatch(NETWORK);
        expect(await signUp(connect('2001:db8:1:3::1'))).toMatchObject({ success: true });
    });

    test('IPv6 also counts by its /48: rotating /64s inside one allocation stops at 10; another /48 is apart', async () => {
        for (let i = 0; i < 10; i++) expect(await signUp(connect(`2001:db8:7:${(i + 1).toString(16)}::1`))).toMatchObject({ success: true });
        const refused = await signUp(connect('2001:db8:7:ff::1'));
        expect(refused.message).toMatch(NETWORK);
        expect(refused.message).toBe('Too many new accounts from this network. Please try again in 6 minutes.');
        expect(rateLimiter.bucketState.get('signUpIp').has('2001:db8:7:ff::/64')).toBe(false);
        expect(await signUp(connect('2001:db8:8:1::1'))).toMatchObject({ success: true });
        // IPv4 has no such tier
        expect(rateLimiter.bucketState.get('signUpNet48').size).toBe(2);
    });

    test('it refills: one more sign-up 12 minutes later, and the message says how long to wait', async () => {
        for (let i = 0; i < 5; i++) await signUp(connect('203.0.113.9'));
        expect((await signUp(connect('203.0.113.9'))).message).toBe('Too many new accounts from this network. Please try again in 12 minutes.');
        clock += 11 * 60000;
        expect((await signUp(connect('203.0.113.9'))).message).toBe('Too many new accounts from this network. Please try again in 1 minute.');
        clock += 60000;
        expect(await signUp(connect('203.0.113.9'))).toMatchObject({ success: true });
        expect((await signUp(connect('203.0.113.9'))).message).toMatch(NETWORK);
    });

    test('name refusals (rules, taken) never spend it; only an attempt that hashes does', async () => {
        const s = connect('203.0.113.10');
        for (const name of ['ab', 'alan', 'ALAN', '🤖 Mary']) expect((await signUp(s, name)).success).toBe(false);
        for (let i = 0; i < 5; i++) expect(await signUp(connect('203.0.113.10'))).toMatchObject({ success: true });
    });

    test('a busy hash pool gives the tokens back (the hash never ran)', async () => {
        const busy = Object.assign(new Error('full'), { code: 'HASH_BUSY' });
        jest.spyOn(passwordHash, 'hash').mockRejectedValueOnce(busy).mockRejectedValueOnce(busy);
        expect(await signUp(connect('203.0.113.11'))).toEqual({ success: false, message: 'Server is busy. Try again in a moment.' });
        expect(await signUp(connect('203.0.113.11'))).toEqual({ success: false, message: 'Server is busy. Try again in a moment.' });
        for (let i = 0; i < 5; i++) expect(await signUp(connect('203.0.113.11'))).toMatchObject({ success: true });
    });

    test('an unknown client IP skips the per-IP bucket (never one shared key); the server-wide one still applies', async () => {
        for (let i = 0; i < 8; i++) expect(await signUp(connect(null))).toMatchObject({ success: true });
    });

    test('a full key map never drops a spent key: refilled keys make room, else a new key is refused (fails closed)', () => {
        const cfg = rateLimiter.buckets.signUpIp;
        const saved = cfg.maxKeys;
        cfg.maxKeys = 3;
        try {
            for (const key of ['a', 'b', 'c']) for (let i = 0; i < 5; i++) expect(rateLimiter.take('signUpIp', key).ok).toBe(true);
            const refused = rateLimiter.take('signUpIp', 'd');
            expect(refused.ok).toBe(false);
            expect(refused.retryAfterMs).toBe(HOUR);
            expect([...rateLimiter.bucketState.get('signUpIp').keys()]).toEqual(['a', 'b', 'c']);
            expect(rateLimiter.take('signUpIp', 'a').ok).toBe(false); // still spent, not reset
            clock += HOUR; // all three refilled: the same as no entry, so they give way
            expect(rateLimiter.take('signUpIp', 'd').ok).toBe(true);
            expect([...rateLimiter.bucketState.get('signUpIp').keys()]).toEqual(['d']);
        } finally {
            cfg.maxKeys = saved;
        }
    });

    test('memory stays bounded: the sweep drops refilled buckets', async () => {
        await signUp(connect('203.0.113.12'));
        await signUp(connect('203.0.113.13'));
        expect(rateLimiter.bucketState.get('signUpIp').size).toBe(2);
        clock += HOUR / 5 - 1;
        rateLimiter.cleanup();
        expect(rateLimiter.bucketState.get('signUpIp').size).toBe(2);
        clock += 2;
        rateLimiter.cleanup();
        expect(rateLimiter.bucketState.get('signUpIp').size).toBe(0);
        clock += HOUR;
        rateLimiter.cleanup();
        expect(rateLimiter.bucketState.get('signUpGlobal').size).toBe(0);
    });
});

describe('the server-wide ceiling (rateLimiter.buckets.signUpGlobal)', () => {
    const ceilingLines = () => authLogger.warn.mock.calls.filter(([m]) => m === 'Sign-up ceiling reached: refusing new accounts server-wide');

    test('20 at once from many IPs, then refused with its own message and one warn line a minute', async () => {
        for (let i = 0; i < 20; i++) expect(await signUp(connect(`198.51.100.${i + 1}`))).toMatchObject({ success: true });
        expect(await signUp(connect('198.51.100.200'))).toEqual({ success: false, message: SERVER_WIDE });
        expect(ceilingLines()).toHaveLength(1);
        expect(ceilingLines()[0][1]).toMatchObject({ burst: 20, perHour: 60, refusedSinceLastLine: 0 });
        expect(await signUp(connect('198.51.100.201'))).toEqual({ success: false, message: SERVER_WIDE });
        expect(ceilingLines()).toHaveLength(1);
        clock += 30000;
        expect(await signUp(connect('198.51.100.202'))).toEqual({ success: false, message: SERVER_WIDE });
        clock += 30000; // one token back (60 an hour) and the log minute over
        expect(await signUp(connect('198.51.100.203'))).toMatchObject({ success: true });
        expect(await signUp(connect('198.51.100.204'))).toEqual({ success: false, message: SERVER_WIDE });
        expect(ceilingLines()).toHaveLength(2);
        expect(ceilingLines()[1][1]).toMatchObject({ refusedSinceLastLine: 2 });
    });

    test('a refusal by the ceiling writes no per-IP key (rotating addresses cannot fill the map)', async () => {
        for (let i = 0; i < 20; i++) await signUp(connect(`198.51.100.${i + 1}`));
        for (let i = 0; i < 50; i++) expect((await signUp(connect(`192.0.2.${i + 1}`))).message).toBe(SERVER_WIDE);
        for (let i = 0; i < 20; i++) expect((await signUp(connect(`2001:db8:9:${i.toString(16)}::1`))).message).toBe(SERVER_WIDE);
        expect(rateLimiter.bucketState.get('signUpIp').size).toBe(20);
        expect(rateLimiter.bucketState.get('signUpNet48')).toBeUndefined();
    });

    test('retrying on one socket after a ceiling refusal never spends the per-socket account budget', async () => {
        for (let i = 0; i < 20; i++) await signUp(connect(`198.51.100.${i + 1}`));
        const s = connect('203.0.113.70');
        for (let i = 0; i < 6; i++) expect((await signUp(s)).message).toBe(SERVER_WIDE);
        clock += HOUR / 20; // 3 server-wide tokens back
        for (let i = 0; i < 3; i++) expect(await signUp(s)).toMatchObject({ success: true });
        // signUpAccount (3 / 5 min) still caps that socket, checked before any bucket
        expect((await signUp(s)).message).toBe(SIGN_UP_LIMIT);
    });

    test('a refusal by the ceiling does not spend the IP\'s own budget', async () => {
        for (let i = 0; i < 20; i++) expect(await signUp(connect(`198.51.100.${i + 1}`))).toMatchObject({ success: true });
        for (let i = 0; i < 5; i++) expect((await signUp(connect('203.0.113.50'))).message).toBe(SERVER_WIDE);
        clock += HOUR / 12; // 5 server-wide tokens back; that IP still has its 5
        for (let i = 0; i < 5; i++) expect(await signUp(connect('203.0.113.50'))).toMatchObject({ success: true });
    });
});

describe('the hash pool keeps room for compares (passwordHash.MAX_PENDING_HASH)', () => {
    test('a sign-up flood fills only the hash share: a sign-in is still answered, and the flood gets "Server is busy"', async () => {
        expect(passwordHash.MAX_PENDING_HASH).toBeLessThan(passwordHash.MAX_PENDING);
        const saved = rateLimiter.buckets.signUpGlobal;
        rateLimiter.buckets.signUpGlobal = { burst: 1000, perHour: 1000, maxKeys: 1 };
        // A slow hasher: every new hash waits until released; compares run at once
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        passwordHash._setRunnerForTests(async (op, a, b) => {
            if (op === 'hash') {
                await gate;
                return bcrypt.hash(a, 4);
            }
            return bcrypt.compare(a, b);
        });
        try {
            const flood = Array.from({ length: passwordHash.MAX_PENDING + 10 }, (_, i) => {
                const s = connect(`198.51.100.${(i % 250) + 1}`);
                return signUp(s).then((reply) => reply);
            });
            for (let i = 0; i < 50 && passwordHash._pending().pendingHashes < passwordHash.MAX_PENDING_HASH; i++) {
                await new Promise((r) => setImmediate(r));
            }
            expect(passwordHash._pending().pendingHashes).toBe(passwordHash.MAX_PENDING_HASH);

            const player = connect('203.0.113.99');
            await auth.signIn(player, io, { username: 'Alan', password: 'pw' });
            expect(lastEmit(player, 'signInResponse')).toMatchObject({ success: true, username: 'Alan' });

            release();
            const replies = await Promise.all(flood);
            expect(replies.filter((r) => r.success)).toHaveLength(passwordHash.MAX_PENDING_HASH);
            expect(replies.filter((r) => !r.success).every((r) => r.message === 'Server is busy. Try again in a moment.')).toBe(true);
            expect(passwordHash._pending()).toEqual({ pending: 0, pendingHashes: 0 });
        } finally {
            rateLimiter.buckets.signUpGlobal = saved;
        }
    });

    test('compares still have the whole queue: 50 pending compares, then HASH_BUSY', async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        passwordHash._setRunnerForTests(async () => { await gate; return true; });
        const jobs = Array.from({ length: passwordHash.MAX_PENDING }, () => passwordHash.compare('pw', 'h'));
        await expect(passwordHash.compare('pw', 'h')).rejects.toMatchObject({ code: 'HASH_BUSY' });
        await expect(passwordHash.hash('pw')).rejects.toMatchObject({ code: 'HASH_BUSY' });
        release();
        expect(await Promise.all(jobs)).toHaveLength(passwordHash.MAX_PENDING);
    });

    test('hashes alone: 20 pending, then the 21st is refused while a compare is taken', async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        passwordHash._setRunnerForTests(async (op) => { if (op === 'hash') await gate; return op === 'hash' ? 'h' : true; });
        const jobs = Array.from({ length: passwordHash.MAX_PENDING_HASH }, () => passwordHash.hash('pw'));
        await expect(passwordHash.hash('pw')).rejects.toMatchObject({ code: 'HASH_BUSY' });
        expect(await passwordHash.compare('pw', 'h')).toBe(true);
        release();
        await Promise.all(jobs);
        expect(await passwordHash.hash('pw')).toBe('h');
    });
});

describe('deleteAccount counts in the failed-sign-in throttle', () => {
    async function del(socket, password) {
        gameManager.getUserBySocketId.mockReturnValue({ username: 'Alan' });
        await auth.deleteAccount(socket, io, { password });
        return lastEmit(socket, 'deleteAccountResponse');
    }

    test('wrong passwords across reconnects stop at the pair limit; then even the right one is refused before any hash', async () => {
        const ip = '203.0.113.60';
        for (let i = 0; i < signInThrottle.LIMITS.pair; i++) {
            expect(await del(connect(ip), 'guess')).toEqual({ success: false, message: 'Incorrect password' });
        }
        const compare = jest.spyOn(passwordHash, 'compare');
        expect(await del(connect(ip), 'pw')).toEqual({ success: false, message: DELETE_THROTTLED });
        expect(compare).not.toHaveBeenCalled();
        expect(await mockDb.current.users.countDocuments({ username: 'Alan' })).toBe(1);
        // The same counters as sign-in: a password sign-in from there is throttled too
        const s = connect(ip);
        await auth.signIn(s, io, { username: 'Alan', password: 'pw' });
        expect(lastEmit(s, 'signInResponse')).toEqual({ success: false, message: SIGN_IN_THROTTLED });
        // Another network is not locked out by that pair
        const other = connect('198.51.100.61');
        await auth.signIn(other, io, { username: 'Alan', password: 'pw' });
        expect(lastEmit(other, 'signInResponse')).toMatchObject({ success: true });
    });

    test('sign-in failures count against delete too, and a right password clears the pair', async () => {
        const ip = '203.0.113.62';
        for (let i = 0; i < signInThrottle.LIMITS.pair - 1; i++) {
            const s = connect(ip);
            await auth.signIn(s, io, { username: 'Alan', password: 'guess' });
        }
        // One failure left on the pair: a wrong delete spends it
        expect(await del(connect(ip), 'guess')).toEqual({ success: false, message: 'Incorrect password' });
        expect(await del(connect(ip), 'pw')).toEqual({ success: false, message: DELETE_THROTTLED });
        signInThrottle._reset();
        for (let i = 0; i < 3; i++) await del(connect(ip), 'guess');
        // Right password (deletion refused here as the only admin, so the account stays): the pair is clear again
        await mockDb.current.users.updateOne({ username: 'Alan' }, { $set: { isAdmin: true } });
        expect((await del(connect(ip), 'pw')).message).toMatch(/only admin/);
        for (let i = 0; i < signInThrottle.LIMITS.pair; i++) {
            expect(await del(connect(ip), 'guess')).toEqual({ success: false, message: 'Incorrect password' });
        }
    });

    test('not counted: no account', async () => {
        const ip = '203.0.113.64';
        gameManager.getUserBySocketId.mockReturnValue({ username: 'Ghost' });
        for (let i = 0; i < signInThrottle.LIMITS.pair + 2; i++) {
            const s = connect(ip);
            await auth.deleteAccount(s, io, { password: 'guess' });
            expect(lastEmit(s, 'deleteAccountResponse')).toEqual({ success: false, message: 'Account not found' });
        }
        expect(signInThrottle.check({ username: 'Ghost', ip }).ok).toBe(true);
    });

    test('not counted: a busy pool', async () => {
        const ip = '203.0.113.63';
        const busy = Object.assign(new Error('full'), { code: 'HASH_BUSY' });
        const spy = jest.spyOn(passwordHash, 'compare');
        for (let i = 0; i < signInThrottle.LIMITS.pair + 2; i++) spy.mockRejectedValueOnce(busy);
        for (let i = 0; i < signInThrottle.LIMITS.pair + 2; i++) {
            expect(await del(connect(ip), 'guess')).toEqual({ success: false, message: 'Server is busy. Try again in a moment.' });
        }
        await mockDb.current.users.updateOne({ username: 'Alan' }, { $set: { isAdmin: true } });
        expect((await del(connect(ip), 'pw')).message).toMatch(/only admin/);
    });
});
