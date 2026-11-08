/**
 * The bcryptjs worker pool (server/utils/passwordHash.js) with real
 * worker_threads: every existing hash format keeps verifying, crashes and a
 * missing Worker fall back inline, back pressure, and the event loop stays
 * free during a burst of cost-10 compares.
 */

process.env.BAB_HASH_POOL = '1';

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

const passwordHash = require('../passwordHash');
const { setPassword } = require('../../admin/setPassword');

jest.setTimeout(30000);

afterEach(async () => {
    jest.restoreAllMocks();
});

afterAll(async () => {
    await passwordHash._shutdown();
});

const to2a = (h) => h.replace(/^\$2b\$/, '$2a$');

describe('formats', () => {
    test.each([4, 10])('$2b$ and $2a$ hashes at cost %i verify; a wrong password does not', async (cost) => {
        const b = bcrypt.hashSync('secret', cost);
        expect(b).toMatch(/^\$2b\$/);
        const a = to2a(b);
        expect(await passwordHash.compare('secret', b)).toBe(true);
        expect(await passwordHash.compare('secret', a)).toBe(true);
        expect(await passwordHash.compare('Secret', b)).toBe(false);
        expect(await passwordHash.compare('Secret', a)).toBe(false);
        expect(passwordHash._workers().length).toBeGreaterThan(0);
    });

    test('hash() writes the same cost-10 bcrypt format bcryptjs reads', async () => {
        const h = await passwordHash.hash('fresh');
        expect(h).toMatch(/^\$2[ab]\$10\$/);
        expect(bcrypt.compareSync('fresh', h)).toBe(true);
    });

    test('a hash written by server/admin/setPassword (scripts/set-password.js) verifies', async () => {
        const db = createMemoryDb({ users: [{ username: 'Gus', password: 'old' }] });
        await setPassword(db, 'Gus', 'maple-otter-42');
        const stored = (await db.users.findOne({ username: 'Gus' })).password;
        expect(await passwordHash.compare('maple-otter-42', stored)).toBe(true);
    });

    test('a malformed or missing hash rejects', async () => {
        await expect(passwordHash.compare('pw', undefined)).rejects.toThrow();
        await expect(passwordHash.compare('pw', '$9z$10$' + 'x'.repeat(53))).rejects.toThrow();
    });
});

describe('sign-in through the real pool', () => {
    const auth = require('../../socket/authHandlers');
    const socket = () => ({ id: `ph-${Math.random()}`, data: {}, emit: jest.fn(), disconnect: jest.fn() });
    const io = { sockets: { sockets: new Map() } };
    const reply = (s) => s.emit.mock.calls.filter(([e]) => e === 'signInResponse').pop()[1];

    beforeEach(() => {
        mockDb.current = createMemoryDb({
            users: [
                { username: 'Hal', password: bcrypt.hashSync('pw', 10) },
                { username: 'Ivy', password: '$9z$10$' + 'x'.repeat(53) }
            ]
        });
    });

    test('a correct and a wrong password', async () => {
        const ok = socket();
        await auth.signIn(ok, io, { username: 'Hal', password: 'pw' });
        expect(reply(ok)).toMatchObject({ success: true, username: 'Hal' });
        const bad = socket();
        await auth.signIn(bad, io, { username: 'Hal', password: 'nope' });
        expect(reply(bad)).toEqual({ success: false, message: 'Invalid username or password!' });
    });

    test('a malformed stored hash still answers the old database-error reply', async () => {
        const s = socket();
        await auth.signIn(s, io, { username: 'Ivy', password: 'pw' });
        expect(reply(s)).toEqual({ success: false, message: 'Database error. Try again.' });
    });

    test('HASH_BUSY answers "Server is busy"', async () => {
        jest.spyOn(passwordHash, 'compare').mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'HASH_BUSY' }));
        const s = socket();
        await auth.signIn(s, io, { username: 'Hal', password: 'pw' });
        expect(reply(s)).toEqual({ success: false, message: 'Server is busy. Try again in a moment.' });
    });
});

describe('failure handling', () => {
    test('terminating a worker mid-job: that job and later jobs still resolve (inline re-run, respawn)', async () => {
        const h = bcrypt.hashSync('pw', 10);
        const jobs = [passwordHash.compare('pw', h), passwordHash.compare('no', h)];
        const live = passwordHash._workers();
        expect(live.length).toBeGreaterThan(0);
        await Promise.all(live.map(w => w.worker.terminate()));
        expect(await Promise.all(jobs)).toEqual([true, false]);
        expect(await passwordHash.compare('pw', h)).toBe(true);
        expect(passwordHash._workers().length).toBeGreaterThan(0);
    });

    test('more than 50 pending jobs reject with HASH_BUSY', async () => {
        const h = bcrypt.hashSync('pw', 4);
        const jobs = Array.from({ length: passwordHash.MAX_PENDING }, () => passwordHash.compare('pw', h));
        await expect(passwordHash.compare('pw', h)).rejects.toMatchObject({ code: 'HASH_BUSY' });
        expect((await Promise.all(jobs)).every(Boolean)).toBe(true);
        expect(await passwordHash.compare('pw', h)).toBe(true);
    });

    test('a Worker constructor that throws falls back to inline hashing', async () => {
        await passwordHash._shutdown();
        const wt = require('worker_threads');
        jest.spyOn(wt, 'Worker').mockImplementation(() => { throw new Error('no threads here'); });
        const h = bcrypt.hashSync('pw', 4);
        expect(await passwordHash.compare('pw', h)).toBe(true);
        expect(passwordHash._workers()).toEqual([]);
        expect(await passwordHash.hash('x', 4)).toMatch(/^\$2[ab]\$04\$/);
        jest.restoreAllMocks();
        await passwordHash._shutdown();
    });
});

describe('event loop', () => {
    async function maxGap(work) {
        let last = performance.now();
        let max = 0;
        const probe = setInterval(() => {
            const t = performance.now();
            max = Math.max(max, t - last);
            last = t;
        }, 1);
        try {
            await work();
        } finally {
            clearInterval(probe);
        }
        return max;
    }

    test('6 concurrent cost-10 compares leave the event loop free', async () => {
        const h = bcrypt.hashSync('pw', 10);
        await passwordHash.compare('pw', h); // spawn + warm
        await passwordHash.compare('pw', h);
        const t0 = performance.now();
        const gap = await maxGap(async () => {
            const res = await Promise.all(Array.from({ length: 6 }, (_, i) => passwordHash.compare(i % 3 ? 'pw' : 'x', h)));
            expect(res).toEqual([false, true, true, false, true, true]);
        });
        console.info(`passwordHash pool: 6 cost-10 compares, wall ${(performance.now() - t0).toFixed(0)} ms, max event-loop gap ${gap.toFixed(1)} ms`);
        expect(gap).toBeLessThan(50);
    });
});
