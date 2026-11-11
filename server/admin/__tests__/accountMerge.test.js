const { createMemoryDb } = require('../../testUtils/memoryDb');
const {
    planMerge, applyMerge, formatPlan, countChanges,
    findDuplicateCandidates, formatDuplicateGroups, nameKey
} = require('../accountMerge');

function stats(overrides = {}) {
    return {
        wins: 0, losses: 0, draws: 0, gamesPlayed: 0, totalPoints: 0,
        totalTricksBid: 0, totalTricksTaken: 0, totalHands: 0, totalSets: 0,
        totalSetPoints: 0, totalFaults: 0, totalHSI: 0, ...overrides
    };
}

function seed() {
    return createMemoryDb({
        users: [
            {
                username: 'Alan', password: 'hash-a', sessionToken: 'tok-a', profilePic: 5,
                stats: stats({ wins: 3, losses: 2, gamesPlayed: 5, totalPoints: 900, totalHands: 65 }),
                blockedUsers: ['Troll']
            },
            {
                username: 'Alan2', password: 'hash-a2', sessionTokens: [{ hash: 'x' }], socketId: 'sock-a2',
                profilePic: 9, customProfilePic: 'data:image/png;base64,AAAA',
                stats: stats({ wins: 1, losses: 1, draws: 1, gamesPlayed: 3, totalPoints: 400, totalHands: 39, totalHSI: 12.5 }),
                blockedUsers: ['Spammer', 'Alan']
            },
            {
                username: 'alan_b', password: 'hash-ab',
                stats: stats({ wins: 2, gamesPlayed: 2, totalPoints: 300, totalHands: 26 })
            },
            { username: 'Mary', password: 'hash-m', stats: stats({ gamesPlayed: 10 }), blockedUsers: ['Alan2', 'Bob'] },
            { username: 'Bob', password: 'hash-b', stats: stats({ gamesPlayed: 4 }), blockedUsers: ['alan_b', 'Alan'] },
            { username: 'Old', mergedInto: 'Alan2', mergedAt: new Date('2026-01-01') }
        ],
        gameRecords: [
            { gameId: 'g1', team1Players: ['Alan2', 'Mary'], team2Players: ['Bob', 'Sue'], team1Score: 300, team2Score: 200, completedAt: new Date('2026-10-01') },
            { gameId: 'g2', team1Players: ['Mary', 'Bob'], team2Players: ['alan_b', 'Sue'], team1Score: 100, team2Score: 250, completedAt: new Date('2026-10-02') },
            { gameId: 'g3', team1Players: ['Mary', 'Bob'], team2Players: ['Alan', 'Sue'], team1Score: 100, team2Score: 120, completedAt: new Date('2026-10-03') }
        ],
        reports: [
            { reporter: 'Alan2', reported: 'Troll', reason: 'spam', createdAt: new Date() },
            { reporter: 'Mary', reported: 'alan_b', reason: 'other', createdAt: new Date() },
            { reporter: 'Mary', reported: 'Bob', reason: 'other', createdAt: new Date() }
        ]
    });
}

const user = (db, name) => db.users.all().find(u => u.username === name);

describe('planMerge', () => {
    test('describes every change without writing anything', async () => {
        const db = seed();
        const before = JSON.stringify([db.users.all(), db.gameRecords.all(), db.reports.all()]);

        const plan = await planMerge(db, { target: 'Alan', sources: ['Alan2', 'alan_b'] });

        expect(plan.errors).toEqual([]);
        expect(plan.statsAfter).toMatchObject({ wins: 6, losses: 3, draws: 1, gamesPlayed: 10, totalPoints: 1600, totalHands: 130, totalHSI: 12.5 });
        expect(plan.gameRecords.map(r => r.gameId).sort()).toEqual(['g1', 'g2']);
        expect(plan.reports).toHaveLength(2);
        expect(plan.otherUsersBlocks.map(u => u.username).sort()).toEqual(['Bob', 'Mary']);
        expect(plan.chainedTombstones.map(t => t.username)).toEqual(['Old']);
        expect(plan.profilePic.from).toBe('Alan2');
        expect(plan.targetBlockedUsers.after.sort()).toEqual(['Spammer', 'Troll']);
        expect(plan.retire.map(r => r.username)).toEqual(['Alan2', 'alan_b']);

        const text = formatPlan(plan);
        expect(text).toContain('stats.gamesPlayed: 5 → 10');
        expect(text).toContain('[Alan2, Mary] vs [Bob, Sue] → [Alan, Mary] vs [Bob, Sue]');
        expect(text).toContain('Accounts to retire');

        expect(JSON.stringify([db.users.all(), db.gameRecords.all(), db.reports.all()])).toBe(before);
    });

    test.each([
        [{ target: 'Nobody', sources: ['Alan2'] }, 'Target account "Nobody" does not exist'],
        [{ target: 'Alan', sources: ['Ghost'] }, 'Source account "Ghost" does not exist'],
        [{ target: 'Alan', sources: ['Alan'] }, 'both the target and a source'],
        [{ target: 'Alan', sources: [] }, 'No source accounts'],
        [{ target: 'Old', sources: ['Alan'] }, 'was itself merged into "Alan2"']
    ])('refuses invalid request %j', async (request, message) => {
        const plan = await planMerge(seed(), request);
        expect(plan.errors.join(' ')).toContain(message);
        expect(formatPlan(plan)).toContain('nothing will be changed');
        await expect(applyMerge(seed(), plan)).rejects.toThrow('Refusing to merge');
    });

    test('refuses a source already merged into a different account', async () => {
        const plan = await planMerge(seed(), { target: 'Mary', sources: ['Old'] });
        expect(plan.errors.join(' ')).toContain('already merged into "Alan2"');
    });

    test('refuses while a source is in an active game', async () => {
        const db = seed();
        await db.users.updateOne({ username: 'alan_b' }, { $set: { activeGameId: 'live-1' } });
        const plan = await planMerge(db, { target: 'Alan', sources: ['alan_b'] });
        expect(plan.errors.join(' ')).toContain('is in an active game');
    });
});

describe('applyMerge', () => {
    test('re-points records, combines stats, and retires the sources', async () => {
        const db = seed();
        const now = new Date('2026-11-07T12:00:00Z');
        const plan = await planMerge(db, { target: 'Alan', sources: ['Alan2', 'alan_b'] });
        const result = await applyMerge(db, plan, { now });

        expect(result.statsMerged).toEqual(['Alan2', 'alan_b']);
        expect(result.retired).toEqual(['Alan2', 'alan_b']);

        const alan = user(db, 'Alan');
        expect(alan.stats).toMatchObject({ wins: 6, losses: 3, draws: 1, gamesPlayed: 10, totalPoints: 1600, totalHSI: 12.5 });
        expect(alan.password).toBe('hash-a');
        expect(alan.sessionToken).toBe('tok-a');
        expect(alan.customProfilePic).toBe('data:image/png;base64,AAAA');
        expect(alan.blockedUsers.sort()).toEqual(['Spammer', 'Troll']);
        expect(alan.mergedFrom.map(e => e.username)).toEqual(['Alan2', 'alan_b']);
        expect(alan.mergedFrom[0].stats.gamesPlayed).toBe(3);

        for (const name of ['Alan2', 'alan_b']) {
            const tomb = user(db, name);
            expect(tomb).toMatchObject({ username: name, mergedInto: 'Alan', mergedAt: now });
            expect(tomb.sessionEpoch).toBe(1); // a restore in flight cannot write sessions back
            for (const gone of ['password', 'sessionToken', 'sessionTokens', 'socketId', 'stats', 'customProfilePic', 'blockedUsers']) {
                expect(tomb).not.toHaveProperty(gone);
            }
        }
        expect(user(db, 'Old').mergedInto).toBe('Alan');

        const records = Object.fromEntries(db.gameRecords.all().map(r => [r.gameId, r]));
        expect(records.g1.team1Players).toEqual(['Alan', 'Mary']);
        expect(records.g2.team2Players).toEqual(['Alan', 'Sue']);
        expect(records.g3.team2Players).toEqual(['Alan', 'Sue']);

        const reports = db.reports.all();
        expect(reports.map(r => `${r.reporter}>${r.reported}`)).toEqual(['Alan>Troll', 'Mary>Alan', 'Mary>Bob']);

        expect(user(db, 'Mary').blockedUsers).toEqual(['Alan', 'Bob']);
        expect(user(db, 'Bob').blockedUsers).toEqual(['Alan']);

        // Leaderboard query (stats.gamesPlayed > 0) no longer sees the sources
        const board = await db.users.find({ 'stats.gamesPlayed': { $gt: 0 } }).toArray();
        expect(board.map(u => u.username).sort()).toEqual(['Alan', 'Bob', 'Mary']);
    });

    test('is idempotent: a second run plans nothing and changes nothing', async () => {
        const db = seed();
        await applyMerge(db, await planMerge(db, { target: 'Alan', sources: ['Alan2', 'alan_b'] }));
        const snapshot = JSON.stringify([db.users.all(), db.gameRecords.all(), db.reports.all()]);

        const again = await planMerge(db, { target: 'Alan', sources: ['Alan2', 'alan_b'] });
        expect(again.errors).toEqual([]);
        expect(countChanges(again)).toBe(0);
        expect(formatPlan(again)).toContain('Nothing to do');
        expect(again.sourceAccounts.every(s => s.action === 'already-merged')).toBe(true);

        await applyMerge(db, again);
        expect(JSON.stringify([db.users.all(), db.gameRecords.all(), db.reports.all()])).toBe(snapshot);
    });

    test('applying the same stale plan twice never double-counts stats', async () => {
        const db = seed();
        const plan = await planMerge(db, { target: 'Alan', sources: ['Alan2'] });
        await applyMerge(db, plan);
        await applyMerge(db, plan);
        expect(user(db, 'Alan').stats.gamesPlayed).toBe(8);
        expect(user(db, 'Alan').mergedFrom).toHaveLength(1);
    });

    test('resumes an interrupted merge (stats moved, source not yet retired)', async () => {
        const db = seed();
        const plan = await planMerge(db, { target: 'Alan', sources: ['Alan2'] });
        // Simulate a crash right after the stats step
        await db.users.updateOne(
            { username: 'Alan' },
            { $inc: { 'stats.gamesPlayed': 3 }, $push: { mergedFrom: { username: 'Alan2', stats: plan.sourceAccounts[0].stats } } }
        );

        const resumed = await planMerge(db, { target: 'Alan', sources: ['Alan2'] });
        expect(resumed.sourceAccounts[0].action).toBe('already-merged');
        expect(resumed.retire.map(r => r.username)).toEqual(['Alan2']);
        await applyMerge(db, resumed);

        expect(user(db, 'Alan').stats.gamesPlayed).toBe(8);
        expect(user(db, 'Alan2').mergedInto).toBe('Alan');
    });

    test('picks up game records written to a retired name after the merge', async () => {
        const db = seed();
        await applyMerge(db, await planMerge(db, { target: 'Alan', sources: ['alan_b'] }));
        await db.gameRecords.insertOne({ gameId: 'late', team1Players: ['alan_b', 'Mary'], team2Players: ['Bob', 'Sue'] });

        const again = await planMerge(db, { target: 'Alan', sources: ['alan_b'] });
        expect(again.gameRecords.map(r => r.gameId)).toEqual(['late']);
        await applyMerge(db, again);
        expect(db.gameRecords.all().find(r => r.gameId === 'late').team1Players).toEqual(['Alan', 'Mary']);
        expect(user(db, 'Alan').stats.gamesPlayed).toBe(7);
    });

    test('keeps the target\'s own custom photo', async () => {
        const db = seed();
        await db.users.updateOne({ username: 'Alan' }, { $set: { customProfilePic: 'data:image/png;base64,MINE' } });
        const plan = await planMerge(db, { target: 'Alan', sources: ['Alan2'] });
        expect(plan.profilePic).toBeNull();
        await applyMerge(db, plan);
        expect(user(db, 'Alan').customProfilePic).toBe('data:image/png;base64,MINE');
    });

    test('warns when two merged accounts sat at the same table', async () => {
        const db = seed();
        await db.gameRecords.insertOne({ gameId: 'both', team1Players: ['Alan', 'Mary'], team2Players: ['Alan2', 'Bob'] });
        const plan = await planMerge(db, { target: 'Alan', sources: ['Alan2'] });
        expect(plan.warnings.join(' ')).toContain('Game both');
    });
});

describe('findDuplicateCandidates', () => {
    test('groups look-alike names and ignores retired accounts', async () => {
        const db = createMemoryDb({
            users: [
                { username: 'Alan', stats: stats({ gamesPlayed: 40 }) },
                { username: 'alan2', stats: stats({ gamesPlayed: 3 }) },
                { username: 'AlanB' },
                { username: 'Al' },
                { username: 'Mary', stats: stats({ gamesPlayed: 9 }) },
                { username: 'Bob' },
                { username: 'Alan_old', mergedInto: 'Alan' }
            ]
        });
        const groups = await findDuplicateCandidates(db);
        expect(groups).toHaveLength(1);
        expect(groups[0].map(u => u.username)).toEqual(['Alan', 'alan2', 'AlanB']);
        expect(groups[0][0].createdAt).toBeInstanceOf(Date);
        expect(formatDuplicateGroups(groups)).toContain('1 group(s)');
        expect(formatDuplicateGroups([])).toContain('No look-alike');
    });

    test('reads only the name and games played (no photos, passwords or sessions); same groups', async () => {
        const db = createMemoryDb({
            users: [
                { username: 'Alan', password: 'h', customProfilePic: 'data:image/png;base64,' + 'Q'.repeat(1000), sessionTokens: [{ hash: 'x' }], stats: stats({ gamesPlayed: 40, wins: 3 }) },
                { username: 'alan2', customProfilePic: 'data:image/png;base64,QQ', stats: stats({ gamesPlayed: 3 }) }
            ]
        });
        const loaded = [];
        const find = db.users.find.bind(db.users);
        db.users.find = (filter, options) => {
            const cursor = find(filter, options);
            const toArray = cursor.toArray;
            cursor.toArray = async () => { const rows = await toArray(); loaded.push(...rows); return rows; };
            return cursor;
        };
        const groups = await findDuplicateCandidates(db);
        expect(groups).toEqual([[
            { username: 'Alan', gamesPlayed: 40, createdAt: expect.any(Date) },
            { username: 'alan2', gamesPlayed: 3, createdAt: expect.any(Date) }
        ]]);
        expect(loaded).toHaveLength(2);
        for (const doc of loaded) {
            expect(Object.keys(doc).sort()).toEqual(['_id', 'stats', 'username']);
            expect(Object.keys(doc.stats)).toEqual(['gamesPlayed']);
        }
    });

    test('nameKey folds case, digits, and punctuation', () => {
        expect(nameKey('Alan_2')).toBe('alan');
        expect(nameKey('ALAN!')).toBe('alan');
        expect(nameKey('1234')).toBe('1234');
    });
});
