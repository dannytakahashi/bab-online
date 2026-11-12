/**
 * Against a REAL mongod (CI's mongo:6 service, or a local one): startup
 * indexes, query plans, the duplicate sign-up race, projections on the real
 * driver, and payload equality with the 3db87b1 handlers.
 *
 * Uses a scratch database bab_jest_item9_<pid>_<ts> that is dropped in
 * afterAll. Never touches 'babonline' (connectDB is never called). Only runs
 * against localhost; with no reachable mongod every test returns early and
 * passes.
 */

// Read before anything loads dotenv (server/database.js does)
const ENV_URI = process.env.MONGO_URI;

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

const mockHolder = { users: null, gameRecords: null, reports: null, passwordResets: null, adminAudit: null };
jest.mock('../database', () => {
    const actual = jest.requireActual('../database');
    return {
        ...actual,
        getDB: () => null,
        getUsersCollection: () => mockHolder.users,
        getGameRecordsCollection: () => mockHolder.gameRecords,
        getReportsCollection: () => mockHolder.reports,
        getPasswordResetsCollection: () => mockHolder.passwordResets,
        getAdminAuditCollection: () => mockHolder.adminAudit,
        whenReady: async () => true
    };
});

const database = require('../database');
const { dbLogger } = require('../utils/logger');
const auth = require('../socket/authHandlers');
const profile = require('../socket/profileHandlers');
const { makeIo, makeSocket } = require('../testUtils/gameDriver');
const { makeReference } = require('../testUtils/legacyProfileReference');

function baseUri() {
    if (!ENV_URI) return 'mongodb://localhost:27017';
    // Strip the path (database name) and query
    const m = /^(mongodb:\/\/[^/?]+)/.exec(ENV_URI);
    return m ? m[1] : null;
}

function isLocal(uri) {
    return /^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(uri || '');
}

let client = null;
let db = null;
const dbName = `bab_jest_item9_${process.pid}_${Date.now()}`;
const PIC = 'data:image/png;base64,' + 'Q'.repeat(500 * 1024);

beforeAll(async () => {
    const base = baseUri();
    if (!isLocal(base)) {
        console.info(`realMongo: MONGO_URI is not a localhost mongod, skipping`);
        return;
    }
    try {
        client = await new MongoClient(base, { serverSelectionTimeoutMS: 1500 }).connect();
        db = client.db(dbName);
    } catch (e) {
        client = null;
        console.info('realMongo: no mongod, skipping');
    }
}, 20000);

afterAll(async () => {
    if (!client) return;
    try {
        await db.dropDatabase();
    } finally {
        await client.close();
    }
});

const now = Date.now();
async function seed() {
    for (const name of ['users', 'gameRecords', 'reports']) {
        await db.collection(name).drop().catch(() => {});
    }
    mockHolder.users = db.collection('users');
    mockHolder.gameRecords = db.collection('gameRecords');
    mockHolder.reports = db.collection('reports');
    const stats = (g, w, extra = {}) => ({
        gamesPlayed: g, wins: w, losses: g - w, draws: 0, totalPoints: g * 230, totalTricksBid: g * 20,
        totalTricksTaken: g * 21, totalHands: g * 13, totalSets: g, totalSetPoints: -g * 40,
        totalFaults: g, totalHSI: g * 300, ...extra
    });
    const hash = await bcrypt.hash('pw', 4);
    await mockHolder.users.insertMany([
        { username: 'Alan', password: hash, profilePic: 3, customProfilePic: PIC, stats: stats(10, 6), blockedUsers: ['Mallory'] },
        { username: 'alan', password: hash, profilePic: 4, stats: stats(2, 1) },
        { username: 'OldAlan', mergedInto: 'Alan', mergedAt: new Date(now - 86400000) },
        { username: 'Bea', password: hash, profilePic: 5 },
        { username: 'Cy', password: hash, profilePic: 6, customProfilePic: PIC, stats: stats(4, 1) },
        { username: 'Dot', password: hash, profilePic: 7, stats: stats(0, 0) },
        { username: 'Eve', password: hash, stats: { gamesPlayed: 3, wins: 3 } }
    ]);
    const lastYear = new Date(new Date(now).getFullYear() - 1, 5, 15);
    // Natural (insertion) order is oldest first; the two 700s tie
    await mockHolder.gameRecords.insertMany([
        { gameId: 'g0', team1Score: 300, team2Score: -200, team1Players: ['Alan', 'Cy'], team2Players: ['Eve', 'alan'], completedAt: lastYear },
        { gameId: 'g1', team1Score: 120, team2Score: 90, team1Players: ['Bea', 'Cy'], team2Players: ['Alan', 'Eve'], completedAt: new Date(lastYear.getTime() + 86400000) },
        { gameId: 'g2', team1Score: 700, team2Score: 650, team1Players: ['Alan', 'Bea'], team2Players: ['Cy', 'Eve'], team1Bags: 3, team2Bags: 1, completedAt: new Date(now - 2000) },
        { gameId: 'g3', team1Score: 700, team2Score: 650, team1Players: ['alan', 'Cy'], team2Players: ['Bea', 'Eve'], team1Bags: 3, team2Bags: 1, completedAt: new Date(now - 1000) },
        { gameId: 'g4', team1Score: -50, team2Score: 210, team1Players: ['Eve', 'Cy'], team2Players: ['Alan', 'alan'], team1Bags: -1, team2Bags: 5, completedAt: new Date(now - 1500) }
    ]);
    await database.ensureIndexes(mockHolder);
}

/** Every {stage, indexName} in an explain plan (classic and SBE layouts). */
function walkPlan(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.stage) out.push({ stage: node.stage, indexName: node.indexName });
    for (const key of ['winningPlan', 'queryPlan', 'inputStage', 'shards']) {
        if (Array.isArray(node[key])) node[key].forEach(n => walkPlan(n, out));
        else if (node[key]) walkPlan(node[key], out);
    }
    if (Array.isArray(node.inputStages)) node.inputStages.forEach(n => walkPlan(n, out));
    return out;
}
const planOf = (explain) => walkPlan(explain.queryPlanner || explain);
const usesIndex = (stages, index) => stages.some(s => /IXSCAN$/.test(s.stage) && (!index || !s.indexName || s.indexName === index));

let log;
let io;
let n = 0;
const sock = () => makeSocket(`rm-${++n}`, log, io);
const last = (event) => log.filter(l => l.event === event).pop()?.data;

beforeEach(async () => {
    if (!client) return;
    log = [];
    io = makeIo(log);
    profile._resetCachesForTests?.();
    await seed();
});

describe('real mongod', () => {
    test('(a) ensureIndexes builds username_1 unique, is idempotent, and the hot queries use indexes', async () => {
        if (!client) return;
        const indexes = await mockHolder.users.indexes();
        expect(indexes.find(i => i.name === 'username_1')).toMatchObject({ unique: true, key: { username: 1 } });
        expect((await mockHolder.gameRecords.indexes()).map(i => i.name)).toContain('completedAt_-1');
        expect((await mockHolder.reports.indexes()).map(i => i.name)).toContain('createdAt_-1');

        const warn = jest.spyOn(dbLogger, 'warn');
        await database.ensureIndexes(mockHolder);
        expect(warn).not.toHaveBeenCalled();
        expect((await mockHolder.users.indexes()).length).toBe(indexes.length);
        warn.mockRestore();

        const plans = {};
        plans.byName = planOf(await mockHolder.users.find({ username: 'Alan' }).limit(1).explain('queryPlanner'));
        plans.byNameAndGame = planOf(await mockHolder.users.find({ username: 'Alan', activeGameId: 'g' }).explain('queryPlanner'));
        const four = ['Alan', 'alan', 'Cy', 'Eve'];
        plans.inAndGame = planOf(await mockHolder.users.find({ username: { $in: four }, activeGameId: 'g' }).explain('queryPlanner'));
        const upd = await db.command({
            explain: { update: 'users', updates: [{ q: { username: { $in: four }, activeGameId: 'g' }, u: { $unset: { activeGameId: '' } }, multi: true }] },
            verbosity: 'queryPlanner'
        });
        plans.updateMany = planOf(upd);
        const search = await mockHolder.users.find(
            { username: { $regex: 'lan', $options: 'i' }, mergedInto: { $exists: false } },
            { projection: { username: 1 } }
        ).limit(20).explain('executionStats');
        plans.search = planOf(search);
        plans.records = planOf(await mockHolder.gameRecords.find({ completedAt: { $gte: new Date(now - 86400000) } }).explain('queryPlanner'));

        for (const [name, stages] of Object.entries(plans)) {
            expect({ name, indexed: usesIndex(stages) }).toEqual({ name, indexed: true });
            expect({ name, collscan: stages.some(s => s.stage === 'COLLSCAN') }).toEqual({ name, collscan: false });
        }
        expect(usesIndex(plans.search, 'username_1')).toBe(true);
        expect(usesIndex(plans.records, 'completedAt_-1')).toBe(true);
        console.info('realMongo plans', JSON.stringify({
            ...Object.fromEntries(Object.entries(plans).map(([k, v]) => [k, v.map(s => s.stage).join('>')])),
            searchKeysExamined: search.executionStats.totalKeysExamined,
            searchDocsExamined: search.executionStats.totalDocsExamined
        }));
    });

    test('(b) concurrent sign-ups for one name: exactly one account, the loser is told the name is taken', async () => {
        if (!client) return;
        const a = sock();
        const b = sock();
        await Promise.all([
            auth.signUp(a, io, { username: 'Racer', password: 'pw' }),
            auth.signUp(b, io, { username: 'Racer', password: 'pw' })
        ]);
        const replies = log.filter(l => l.event === 'signUpResponse').map(l => l.data);
        expect(replies).toHaveLength(2);
        expect(replies.filter(r => r.success)).toHaveLength(1);
        expect(replies.filter(r => !r.success)).toEqual([{ success: false, message: 'That name is taken.' }]);
        expect(await mockHolder.users.countDocuments({ username: 'Racer' })).toBe(1);

        const c = sock();
        await auth.signUp(c, io, { username: 'Racer', password: 'pw' });
        expect(last('signUpResponse')).toEqual({ success: false, message: 'That name is taken.' });

        // The case-insensitive clash check (usernameRules.findNameClash) on a real mongod
        await auth.signUp(sock(), io, { username: 'rACER', password: 'pw' });
        expect(last('signUpResponse')).toEqual({ success: false, message: 'That name is taken: "Racer" already exists, and capital letters don\'t make a different name.' });
        await auth.signUp(sock(), io, { username: 'R.cer', password: 'pw' });
        expect(last('signUpResponse')).toMatchObject({ success: true, username: 'R.cer' });
    }, 20000);

    test('(c) existing exact duplicates: warn and continue without the unique index; the other indexes still build', async () => {
        if (!client) return;
        const users = db.collection('users_dups');
        const gameRecords = db.collection('gameRecords_dups');
        const reports = db.collection('reports_dups');
        await users.insertMany([{ username: 'Twin' }, { username: 'Twin' }]);
        await gameRecords.insertOne({ completedAt: new Date() });
        await reports.insertOne({ createdAt: new Date() });
        const warn = jest.spyOn(dbLogger, 'warn').mockImplementation(() => {});
        await expect(database.ensureIndexes({ users, gameRecords, reports })).resolves.toBeDefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/unique index on users\.username/);
        expect((await users.indexes()).map(i => i.name)).not.toContain('username_1');
        expect((await gameRecords.indexes()).map(i => i.name)).toContain('completedAt_-1');
        expect((await reports.indexes()).map(i => i.name)).toContain('createdAt_-1');
        // The non-unique fallback keeps username lookups on an index
        const fallback = database.USERNAME_FALLBACK_INDEX;
        expect((await users.indexes()).find(i => i.name === fallback)).toMatchObject({ key: { username: 1 } });
        expect(usesIndex(planOf(await users.find({ username: 'Twin' }).explain('queryPlanner')), fallback)).toBe(true);
        // Idempotent while the duplicates remain; once they are merged the
        // next boot swaps the fallback for the unique index
        await database.ensureIndexes({ users, gameRecords, reports });
        expect((await users.indexes()).map(i => i.name)).toContain(fallback);
        await users.deleteOne({ username: 'Twin' });
        warn.mockClear();
        await database.ensureIndexes({ users, gameRecords, reports });
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
        const names = (await users.indexes()).map(i => i.name);
        expect(names).toContain('username_1');
        expect(names).not.toContain(fallback);
    });

    test('(d) projected reads on the real driver keep every reply field; tombstones stay hidden', async () => {
        if (!client) return;
        const s = sock();
        await auth.signIn(s, io, { username: 'Alan', password: 'pw' });
        const signed = last('signInResponse');
        expect(signed).toEqual({ success: true, username: 'Alan', sessionToken: expect.any(String), blockedUsers: ['Mallory'] });

        await auth.restoreSession(sock(), io, { username: 'Alan', sessionToken: signed.sessionToken });
        expect(last('restoreSessionResponse')).toEqual({ success: true, username: 'Alan', blockedUsers: ['Mallory'] });

        const gameManager = require('../game/GameManager');
        const me = sock();
        gameManager.registerUser(me.id, 'Alan');
        await profile.getProfile(me, io);
        expect(last('profileResponse').profile).toMatchObject({ username: 'Alan', customProfilePic: PIC, stats: { gamesPlayed: 10, wins: 6 } });
        await profile.getPlayerProfile(me, io, { username: 'OldAlan' });
        expect(last('playerProfileResponse').profile).toMatchObject({ username: 'Alan', customProfilePic: PIC, stats: { gamesPlayed: 10 } });

        await profile.getLeaderboard(me, io);
        const rows = last('leaderboardResponse').leaderboard;
        expect(rows.find(r => r.username === 'Alan')).toMatchObject({ customProfilePic: PIC, gamesPlayed: 10, winRate: 60 });
        expect(rows.find(r => r.username === 'Cy').customProfilePic).toBe(PIC);
        expect(rows.map(r => r.username)).not.toContain('OldAlan');

        await profile.searchPlayers(me, io, { query: 'alan' });
        const found = last('searchPlayersResponse').players;
        expect(found.map(p => p.username).sort()).toEqual(['Alan', 'alan']);
        expect(found.find(p => p.username === 'Alan')).toEqual({ username: 'Alan', profilePic: 3, customProfilePic: PIC, gamesPlayed: 10, wins: 6 });
    });

    test('(e) leaderboard and search payloads deep-equal the 3db87b1 handlers on the same data', async () => {
        if (!client) return;
        const ref = makeReference(database);
        const a = sock();
        const b = sock();
        await ref.getLeaderboard(a, io);
        await profile.getLeaderboard(b, io);
        const before = log.filter(l => l.to === `self:${a.id}`).pop().data;
        const after = log.filter(l => l.to === `self:${b.id}`).pop().data;
        expect(after).toEqual(before);
        expect(JSON.stringify(after).length).toBe(JSON.stringify(before).length);

        for (const query of ['al', 'ALAN', 'y', 'nobody']) {
            await ref.searchPlayers(a, io, { query });
            await profile.searchPlayers(b, io, { query });
            const x = log.filter(l => l.to === `self:${a.id}`).pop().data;
            const y = log.filter(l => l.to === `self:${b.id}`).pop().data;
            expect({ query, y }).toEqual({ query, y: x });
        }
    });

    test('(f) records payload deep-equals the 3db87b1 handler, including tie-breaks per period', async () => {
        if (!client) return;
        const ref = makeReference(database);
        const a = sock();
        const b = sock();
        await ref.getRecords(a, io);
        await profile.getRecords(b, io);
        const before = log.filter(l => l.to === `self:${a.id}`).pop().data;
        const after = log.filter(l => l.to === `self:${b.id}`).pop().data;
        expect(after).toEqual(before);
        expect(after.totalGames).toBe(5);
        // allTime walks natural order (oldest tied game wins), thisMonth the
        // completedAt_-1 index (newest tied game wins)
        expect(after.records.allTime.highestScore).toEqual({ score: 700, players: ['Alan', 'Bea'] });
        expect(after.records.thisMonth.highestScore).toEqual({ score: 700, players: ['alan', 'Cy'] });
    });

    test('(g) admin panel: its indexes, one open reset link per player, and a link used exactly once under concurrency', async () => {
        if (!client) return;
        const { createResetLink, useResetLink, INVALID_LINK } = require('../admin/passwordReset');
        const { listAudit, recordAudit } = require('../admin/audit');
        const { setAdminFlag, listAdmins } = require('../admin/adminRole');
        for (const name of ['passwordResets', 'adminAudit']) await db.collection(name).drop().catch(() => {});
        const adb = {
            users: mockHolder.users, reports: mockHolder.reports, gameRecords: mockHolder.gameRecords,
            passwordResets: db.collection('passwordResets'), adminAudit: db.collection('adminAudit')
        };
        await database.ensureIndexes(adb);
        await database.ensureIndexes(adb); // idempotent

        const idx = Object.fromEntries((await adb.passwordResets.indexes()).map(i => [i.name, i]));
        expect(idx.tokenHash_1.unique).toBe(true);
        expect(idx.username_open_unique).toMatchObject({ unique: true, partialFilterExpression: { state: 'open' } });
        expect(idx.expiresAt_1.expireAfterSeconds).toBe(7 * 24 * 60 * 60);
        expect((await adb.adminAudit.indexes()).map(i => i.name)).toContain('at_-1__id_-1');
        expect((await adb.users.indexes()).find(i => i.name === 'isAdmin_partial')).toMatchObject({ partialFilterExpression: { isAdmin: true } });

        // The database itself keeps one open link per player: a second open
        // insert for Bea is a duplicate key
        await adb.passwordResets.insertOne({ tokenHash: 'a', username: 'Bea', state: 'open' });
        await expect(adb.passwordResets.insertOne({ tokenHash: 'b', username: 'Bea', state: 'open' })).rejects.toMatchObject({ code: 11000 });
        await adb.passwordResets.insertOne({ tokenHash: 'c', username: 'Bea', state: 'used' });
        await adb.passwordResets.deleteMany({});

        // Two admins making a link for the same player at once: one open link remains
        const made = await Promise.all([createResetLink(adb, 'Bea', { by: 'A' }), createResetLink(adb, 'Bea', { by: 'B' })]);
        expect(made).toHaveLength(2);
        expect(await adb.passwordResets.countDocuments({ username: 'Bea', state: 'open' })).toBe(1);

        // Concurrent double (quintuple) use of one link: exactly one success
        const { token } = await createResetLink(adb, 'Bea');
        const hash = (pw) => bcrypt.hash(pw, 4);
        const results = await Promise.all([1, 2, 3, 4, 5].map(i => useResetLink(adb, token, `pw-${i}`, { hash })));
        expect(results.filter(r => r.ok)).toHaveLength(1);
        expect(results.filter(r => r === INVALID_LINK)).toHaveLength(4);
        const winner = results.find(r => r.ok);
        const bea = await adb.users.findOne({ username: 'Bea' });
        const winning = [1, 2, 3, 4, 5].map(i => `pw-${i}`).filter(pw => bcrypt.compareSync(pw, bea.password));
        expect(winning).toHaveLength(1);
        expect(winner.username).toBe('Bea');
        expect(bea.sessionTokens).toBeUndefined();
        const tokenDoc = await adb.passwordResets.findOne({ tokenHash: require('../utils/sessionTokens').hashToken(token) });
        expect(tokenDoc.state).toBe('used');
        // Locking the account down (set-password.js / Sign out everywhere)
        // cancels an open link on the real driver; the used one stays used,
        // and the one-open-link index lets a new link in afterwards
        const { revokeOpenResetLinks } = require('../admin/setPassword');
        const leaked = await createResetLink(adb, 'Bea');
        expect(await revokeOpenResetLinks(adb, { username: 'Bea' })).toBe(1);
        expect(await useResetLink(adb, leaked.token, 'stranger', { hash })).toBe(INVALID_LINK);
        expect(tokenDoc.state).toBe((await adb.passwordResets.findOne({ _id: tokenDoc._id })).state);
        expect(await adb.passwordResets.countDocuments({ username: 'Bea', state: 'open' })).toBe(0);
        const fresh = await createResetLink(adb, 'Bea');
        expect(fresh.revoked).toBe(0);
        expect(await adb.passwordResets.countDocuments({ username: 'Bea', state: 'open' })).toBe(1);
        // The token itself is nowhere in the database
        for (const name of ['users', 'passwordResets', 'adminAudit']) {
            expect(JSON.stringify(await db.collection(name).find({}).toArray())).not.toContain(token);
        }

        // The audit page is read newest first through its index
        for (let i = 0; i < 3; i++) await recordAudit(adb, { actor: 'Bea', action: 'searchPlayers', result: 'ok', detail: `q${i}`, now: new Date(now + i) });
        expect((await listAudit(adb, { limit: 2 })).entries.map(e => e.detail)).toEqual(['q2', 'q1']);
        const plan = planOf(await adb.adminAudit.find({}).sort({ at: -1, _id: -1 }).limit(51).explain('queryPlanner'));
        expect(usesIndex(plan, 'at_-1__id_-1')).toBe(true);
        // Paging on (at, _id): entries sharing the boundary millisecond are all reached
        const same = new Date(now - 5000);
        for (let i = 0; i < 4; i++) await recordAudit(adb, { actor: 'Bea', action: 'tie', result: 'ok', detail: `t${i}`, now: same });
        const seen = [];
        let pg = await listAudit(adb, { limit: 2, before: new Date(now) });
        seen.push(...pg.entries);
        while (pg.hasMore) {
            const lastRow = pg.entries[pg.entries.length - 1];
            pg = await listAudit(adb, { limit: 2, before: new Date(lastRow.at), beforeId: lastRow.id });
            seen.push(...pg.entries);
        }
        expect(seen.map(e => e.detail)).toEqual(['t3', 't2', 't1', 't0']);

        // The last-admin guard on the real driver
        await setAdminFlag(adb, 'Bea', true);
        await expect(setAdminFlag(adb, 'Bea', false)).rejects.toMatchObject({ code: 'last_admin' });
        expect((await listAdmins(adb)).map(a => a.username)).toEqual(['Bea']);
    }, 20000); // real mongod, concurrent bcrypt + index builds: once 5.3 s under load

    test('(h) a revoke between a restore\'s read and its write wins on the real driver: no session comes back', async () => {
        if (!client) return;
        const { REVOKE_ALL_SESSIONS, verifySession } = require('../utils/sessionTokens');
        const users = mockHolder.users;
        const tokens = [];
        const device = () => Object.assign(sock(), { disconnect() {} }); // a second sign-in kicks the first
        for (let i = 0; i < 2; i++) {
            await auth.signIn(device(), io, { username: 'Alan', password: 'pw' });
            tokens.push(last('signInResponse').sessionToken);
        }
        expect((await users.findOne({ username: 'Alan' })).sessionTokens).toHaveLength(2);
        // Sign out everywhere lands right after the restore's findOne
        users.findOne = async function (...args) {
            delete users.findOne;
            const doc = await Object.getPrototypeOf(users).findOne.apply(users, args);
            await users.updateOne({ username: 'Alan' }, REVOKE_ALL_SESSIONS);
            return doc;
        };
        await auth.restoreSession(device(), io, { username: 'Alan', sessionToken: tokens[0] });
        expect(last('restoreSessionResponse')).toEqual({ success: false, message: 'Invalid session token' });
        const alan = await users.findOne({ username: 'Alan' });
        expect(alan.sessionTokens).toBeUndefined();
        expect(alan.sessionEpoch).toBe(1);
        for (const t of tokens) expect(verifySession(alan, t)).toBeNull();
        // Afterwards sessions work again on the new epoch
        await auth.signIn(device(), io, { username: 'Alan', password: 'pw' });
        const fresh = last('signInResponse').sessionToken;
        await auth.restoreSession(device(), io, { username: 'Alan', sessionToken: fresh });
        expect(last('restoreSessionResponse')).toMatchObject({ success: true });
    });
    test('(i) panel merges on the real driver: two merges of one source at once run one at a time; the retire filter refuses an in-game or merged-elsewhere source', async () => {
        if (!client) return;
        const { planMerge, applyMerge } = require('../admin/accountMerge');
        const admin = require('../socket/adminHandlers');
        const gameManager = require('../game/GameManager');
        for (const name of ['passwordResets', 'adminAudit']) await db.collection(name).drop().catch(() => {});
        mockHolder.passwordResets = db.collection('passwordResets');
        mockHolder.adminAudit = db.collection('adminAudit');
        const users = mockHolder.users;
        const adb = { users, gameRecords: mockHolder.gameRecords, reports: mockHolder.reports, passwordResets: mockHolder.passwordResets };
        try {
            // The retire filter itself ($exists / $or on the real server)
            const toBea = await planMerge(adb, { target: 'Bea', sources: ['Dot'] });
            await users.updateOne({ username: 'Dot' }, { $set: { activeGameId: 'g-live' } });
            const partial = await applyMerge(adb, toBea);
            expect(partial).toMatchObject({ retired: [], notRetired: ['Dot'] });
            expect((await users.findOne({ username: 'Dot' })).mergedInto).toBeUndefined();
            await users.updateOne({ username: 'Dot' }, { $unset: { activeGameId: '' } });
            const toEve = await planMerge(adb, { target: 'Eve', sources: ['alan'] });
            const toAlan = await planMerge(adb, { target: 'Alan', sources: ['alan'] });
            expect((await applyMerge(adb, toEve)).retired).toEqual(['alan']);
            expect((await applyMerge(adb, toAlan)).notRetired).toEqual(['alan']); // merged elsewhere: stays Eve's
            expect((await users.findOne({ username: 'alan' })).mergedInto).toBe('Eve');

            // Two admins merging the same source into two accounts at once,
            // through the panel: one runs, the other re-plans after it and is refused
            await users.updateOne({ username: 'Dot' }, { $set: { isAdmin: true } });
            const dot = sock();
            await auth.signIn(dot, io, { username: 'Dot', password: 'pw' });
            expect(last('signInResponse')).toMatchObject({ success: true });
            let rid = 0;
            const ask = async (action, args) => {
                const requestId = `rm-req-${++rid}`;
                await admin.adminRequest(dot, io, { requestId, action, args });
                return log.filter(l => l.event === 'adminResponse' && l.data.requestId === requestId).pop().data;
            };
            const cyBefore = (await users.findOne({ username: 'Cy' })).stats;
            const beaBefore = (await users.findOne({ username: 'Bea' })).stats || {};
            const eveBefore = (await users.findOne({ username: 'Eve' })).stats;
            const pBea = await ask('planMerge', { target: 'Bea', sources: ['Cy'] });
            const pEve = await ask('planMerge', { target: 'Eve', sources: ['Cy'] });
            expect(pBea.ok && pEve.ok).toBe(true);
            const [a, b] = await Promise.all([
                ask('applyMerge', { target: 'Bea', sources: ['Cy'], planHash: pBea.planHash, confirm: 'Bea' }),
                ask('applyMerge', { target: 'Eve', sources: ['Cy'], planHash: pEve.planHash, confirm: 'Eve' })
            ]);
            // whichever reached the merge queue first runs; the other re-plans after it
            const [win, lose] = a.ok ? [a, b] : [b, a];
            const winner = win.result.target;
            const loser = winner === 'Bea' ? 'Eve' : 'Bea';
            expect(win).toMatchObject({ ok: true, result: { retired: ['Cy'], statsMerged: ['Cy'] } });
            expect(lose).toMatchObject({ ok: false, error: 'refused' });
            expect(lose.message).toMatch(new RegExp(`already merged into "${winner}"`));
            const before = { Bea: beaBefore, Eve: eveBefore };
            expect((await users.findOne({ username: winner })).stats.gamesPlayed).toBe((before[winner].gamesPlayed || 0) + cyBefore.gamesPlayed);
            expect((await users.findOne({ username: loser })).stats || {}).toEqual(before[loser]);
            expect((await users.findOne({ username: loser })).mergedFrom || []).not.toContainEqual(expect.objectContaining({ username: 'Cy' }));
            expect((await users.findOne({ username: 'Cy' })).mergedInto).toBe(winner);
            // every game record of Cy was re-pointed, none left behind
            expect(await mockHolder.gameRecords.countDocuments({ $or: [{ team1Players: 'Cy' }, { team2Players: 'Cy' }] })).toBe(0);
            expect(await mockHolder.adminAudit.countDocuments({ action: 'applyMerge' })).toBe(2);
        } finally {
            gameManager.currentUsers = [];
            mockHolder.passwordResets = null;
            mockHolder.adminAudit = null;
        }
    });

    test('(j) the Players table on the real driver: every account newest first by _id, the projection reads no secret, the cap and the true total', async () => {
        if (!client) return;
        const { listPlayers } = require('../admin/players');
        const users = mockHolder.users;
        const all = await listPlayers({ users });
        expect(all.total).toBe(7);
        // insertion order = _id order: newest (Eve) first
        expect(all.players.map(p => p.username)).toEqual(['Eve', 'Dot', 'Cy', 'Bea', 'OldAlan', 'alan', 'Alan']);
        expect(all.players.find(p => p.username === 'OldAlan')).toMatchObject({ mergedInto: 'Alan', gamesPlayed: 0 });
        expect(JSON.stringify(all)).not.toMatch(/\$2[ab]\$|data:image|Mallory/);
        const capped = await listPlayers({ users }, { limit: 3 });
        expect(capped).toMatchObject({ total: 7, limit: 3 });
        expect(capped.players.map(p => p.username)).toEqual(['Eve', 'Dot', 'Cy']);
    });

    test('(k) admin delete on the real driver: records anonymized (arrayFilters), block lists pulled, reports marked, reset links revoked, tombstones gone; a tombstone delete frees only its name; an admin or in-game account is refused', async () => {
        if (!client) return;
        const admin = require('../socket/adminHandlers');
        const gameManager = require('../game/GameManager');
        for (const name of ['passwordResets', 'adminAudit']) await db.collection(name).drop().catch(() => {});
        mockHolder.passwordResets = db.collection('passwordResets');
        mockHolder.adminAudit = db.collection('adminAudit');
        await database.ensureIndexes(mockHolder);
        const users = mockHolder.users;
        try {
            await users.updateOne({ username: 'Dot' }, { $set: { isAdmin: true } });
            await users.updateOne({ username: 'Bea' }, { $set: { blockedUsers: ['Cy', 'Mallory'] } });
            await users.insertOne({ username: 'OldCy', mergedInto: 'Cy', mergedAt: new Date() });
            await mockHolder.reports.insertMany([
                { reporter: 'Cy', reported: 'Bea', reason: 'a', createdAt: new Date() },
                { reporter: 'Eve', reported: 'Cy', reason: 'b', createdAt: new Date() }
            ]);
            const dot = sock();
            await auth.signIn(dot, io, { username: 'Dot', password: 'pw' });
            expect(last('signInResponse')).toMatchObject({ success: true });
            let rid = 0;
            const ask = async (action, args) => {
                const requestId = `rm-del-${++rid}`;
                await admin.adminRequest(dot, io, { requestId, action, args });
                return log.filter(l => l.event === 'adminResponse' && l.data.requestId === requestId).pop().data;
            };
            expect(await ask('createResetLink', { username: 'Cy' })).toMatchObject({ ok: true });
            // refusals first: an admin, and an account the database shows in a game
            await users.updateOne({ username: 'Eve' }, { $set: { isAdmin: true } });
            expect(await ask('deleteAccount', { username: 'Eve', confirm: 'Eve' })).toMatchObject({ ok: false, error: 'refused' });
            await users.updateOne({ username: 'Eve' }, { $unset: { isAdmin: '' }, $set: { activeGameId: 'g-live' } });
            expect(await ask('deleteAccount', { username: 'Eve', confirm: 'Eve' })).toMatchObject({ ok: false, error: 'refused' });
            expect(await users.findOne({ username: 'Eve' })).not.toBeNull();

            const res = await ask('deleteAccount', { username: 'Cy', confirm: 'Cy' });
            expect(res).toMatchObject({ ok: true, kind: 'account', gameRecords: 5, reports: 2, blockLists: 1, resetLinks: 1, tombstones: 1 });
            expect(await users.findOne({ username: 'Cy' })).toBeNull();
            expect(await users.findOne({ username: 'OldCy' })).toBeNull();
            expect(await mockHolder.gameRecords.countDocuments({ $or: [{ team1Players: 'Cy' }, { team2Players: 'Cy' }] })).toBe(0);
            expect((await mockHolder.gameRecords.findOne({ gameId: 'g1' })).team1Players).toEqual(['Bea', '[deleted]']);
            expect((await users.findOne({ username: 'Bea' })).blockedUsers).toEqual(['Mallory']);
            const reps = await mockHolder.reports.find({}).toArray();
            expect(reps.map(r => [r.reporter, r.reported, Boolean(r.reporterDeletedAt), Boolean(r.reportedDeletedAt)])).toEqual([
                ['Cy', 'Bea', true, false], ['Eve', 'Cy', false, true]
            ]);
            expect(await mockHolder.passwordResets.countDocuments({ username: 'Cy', state: 'open' })).toBe(0);
            expect(await mockHolder.adminAudit.countDocuments({ action: 'deleteAccount', result: 'ok' })).toBe(1);
            // a tombstone: only that document; its kept account is unchanged
            const alanBefore = await users.findOne({ username: 'Alan' });
            expect(await ask('deleteAccount', { username: 'OldAlan', confirm: 'OldAlan' })).toMatchObject({ ok: true, kind: 'tombstone', mergedInto: 'Alan' });
            expect(await users.findOne({ username: 'OldAlan' })).toBeNull();
            expect(await users.findOne({ username: 'Alan' })).toEqual(alanBefore);
            // both names are free on the real unique index
            await users.insertOne({ username: 'OldAlan', password: 'x' });
            await users.insertOne({ username: 'Cy', password: 'x' });
        } finally {
            gameManager.currentUsers = [];
            gameManager.deletedUsernames.clear();
            mockHolder.passwordResets = null;
            mockHolder.adminAudit = null;
        }
    });
});
