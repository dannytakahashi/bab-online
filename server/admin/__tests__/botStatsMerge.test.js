/**
 * Bot-game stats (users.botStats, server/utils/statsScope.js) through the
 * account merge: both buckets summed in ONE guarded write, recorded in
 * mergedFrom, dropped from the tombstone; the panel view and hash cover
 * them; bot personas in gameRecords.teamNBots are never re-pointed.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');
const {
    planMerge, applyMerge, formatPlan, countChanges,
    findDuplicateCandidates, formatDuplicateGroups
} = require('../accountMerge');
const { planView, planHash } = require('../mergeView');

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
            { username: 'Alan', password: 'h', stats: stats({ gamesPlayed: 5, wins: 3 }), botStats: stats({ gamesPlayed: 7, wins: 4, totalPoints: 1200 }) },
            { username: 'Alan2', password: 'h2', stats: stats({ gamesPlayed: 2, wins: 1 }), botStats: stats({ gamesPlayed: 3, wins: 2, totalPoints: 500 }) },
            // only bot games: still has stats to add
            { username: 'alan_b', password: 'h3', botStats: stats({ gamesPlayed: 4, losses: 4 }) },
            { username: 'Mary', password: 'h4' }
        ],
        gameRecords: [
            { gameId: 'b1', withBots: true, team1Players: ['Alan2'], team2Players: ['Mary'], team1Bots: ['🤖 Zach'], team2Bots: ['🤖 Ivy'], team1Score: 300, team2Score: 100, completedAt: new Date('2026-11-13') }
        ],
        reports: []
    });
}

const user = (db, name) => db.users.all().find(u => u.username === name);

test('the plan sums both buckets; a source with only botStats counts as add-stats', async () => {
    const db = seed();
    const plan = await planMerge(db, { target: 'Alan', sources: ['Alan2', 'alan_b'] });
    expect(plan.errors).toEqual([]);
    expect(plan.statsAfter).toMatchObject({ gamesPlayed: 7, wins: 4 });
    expect(plan.botStatsBefore).toMatchObject({ gamesPlayed: 7, wins: 4, totalPoints: 1200 });
    expect(plan.botStatsAfter).toMatchObject({ gamesPlayed: 14, wins: 6, losses: 4, totalPoints: 1700 });
    expect(plan.sourceAccounts.map(s => [s.username, s.action, s.botStats.gamesPlayed])).toEqual([['Alan2', 'add-stats', 3], ['alan_b', 'add-stats', 4]]);
    const text = formatPlan(plan);
    expect(text).toContain('bot games: 14 games, 6W/4L/0D, 1700 pts');
    expect(text).toContain('botStats.gamesPlayed: 7 → 14');
});

test('apply adds both buckets once (re-run is a no-op), mergedFrom records botStats, the tombstone drops botStats', async () => {
    const db = seed();
    const result = await applyMerge(db, await planMerge(db, { target: 'Alan', sources: ['Alan2', 'alan_b'] }));
    expect(result.statsMerged).toEqual(['Alan2', 'alan_b']);
    const alan = user(db, 'Alan');
    expect(alan.stats).toMatchObject({ gamesPlayed: 7, wins: 4 });
    expect(alan.botStats).toMatchObject({ gamesPlayed: 14, wins: 6, losses: 4, totalPoints: 1700 });
    expect(alan.mergedFrom.map(e => [e.username, e.stats.gamesPlayed, e.botStats.gamesPlayed])).toEqual([['Alan2', 2, 3], ['alan_b', 0, 4]]);
    for (const name of ['Alan2', 'alan_b']) {
        expect(user(db, name).botStats).toBeUndefined();
        expect(user(db, name).stats).toBeUndefined();
        expect(user(db, name).mergedInto).toBe('Alan');
    }
    // a bot game's humans are re-pointed, its bot personas never are
    const rec = db.gameRecords.all()[0];
    expect(rec.team1Players).toEqual(['Alan']);
    expect(rec.team1Bots).toEqual(['🤖 Zach']);
    expect(rec.team2Bots).toEqual(['🤖 Ivy']);

    const again = await planMerge(db, { target: 'Alan', sources: ['Alan2', 'alan_b'] });
    expect(countChanges(again)).toBe(0);
    await applyMerge(db, again);
    expect(user(db, 'Alan').botStats).toMatchObject({ gamesPlayed: 14, wins: 6 });
    expect(user(db, 'Alan').stats).toMatchObject({ gamesPlayed: 7, wins: 4 });
});

test('the botStats add goes in the same guarded write as the stats add and the audit entry', async () => {
    const db = seed();
    const plan = await planMerge(db, { target: 'Alan', sources: ['Alan2', 'alan_b'] });
    const spy = jest.spyOn(db.users, 'updateOne');
    await applyMerge(db, plan);
    const writes = spy.mock.calls.filter(([f]) => f['mergedFrom.username']);
    expect(writes).toHaveLength(2);
    expect(writes[0][1].$inc).toEqual({ 'stats.gamesPlayed': 2, 'stats.wins': 1, 'botStats.gamesPlayed': 3, 'botStats.wins': 2, 'botStats.totalPoints': 500 });
    expect(writes[1][1].$inc).toEqual({ 'botStats.gamesPlayed': 4, 'botStats.losses': 4 });
    expect(writes[1][1].$push.mergedFrom).toMatchObject({ username: 'alan_b', botStats: expect.objectContaining({ gamesPlayed: 4 }) });
});

test('planView shows botStats per account and the bot-game changes; a bot-only change changes the hash', async () => {
    const db = seed();
    const plan = await planMerge(db, { target: 'Alan', sources: ['Alan2'] });
    const view = planView(plan);
    expect(view.accounts.map(a => [a.role, a.stats.gamesPlayed, a.botStats.gamesPlayed])).toEqual([['target', 5, 7], ['source', 2, 3], ['result', 7, 10]]);
    expect(view.botStatChanges).toEqual(expect.arrayContaining([{ key: 'gamesPlayed', before: 7, after: 10 }, { key: 'totalPoints', before: 1200, after: 1700 }]));
    expect(view.statChanges).toEqual(expect.arrayContaining([{ key: 'gamesPlayed', before: 5, after: 7 }]));
    expect(view.statChanges.map(c => c.key)).not.toContain('totalPoints');

    const h1 = planHash(plan);
    expect(planHash(await planMerge(db, { target: 'Alan', sources: ['Alan2'] }))).toBe(h1);
    // only the target's bot-game bucket changes
    await db.users.updateOne({ username: 'Alan' }, { $inc: { 'botStats.wins': 1 } });
    const h2 = planHash(await planMerge(db, { target: 'Alan', sources: ['Alan2'] }));
    expect(h2).not.toBe(h1);
    // only the source's bot-game bucket changes
    await db.users.updateOne({ username: 'Alan2' }, { $inc: { 'botStats.draws': 1 } });
    expect(planHash(await planMerge(db, { target: 'Alan', sources: ['Alan2'] }))).not.toBe(h2);
});

test('an errored plan view carries an empty botStatChanges', async () => {
    const db = seed();
    const view = planView(await planMerge(db, { target: 'Alan', sources: ['nobody'] }));
    expect(view.botStatChanges).toEqual([]);
    expect(view.accounts).toEqual([]);
});

test('an existing tombstone (no botStats) still counts as complete', async () => {
    const db = createMemoryDb({
        users: [
            { username: 'Alan', password: 'h', stats: stats({ gamesPlayed: 1 }), mergedFrom: [{ username: 'Old', stats: stats({ gamesPlayed: 2 }), mergedAt: new Date() }] },
            { username: 'Old', mergedInto: 'Alan', mergedAt: new Date() }
        ],
        gameRecords: [],
        reports: []
    });
    const plan = await planMerge(db, { target: 'Alan', sources: ['Old'] });
    expect(plan.retire).toEqual([]);
    expect(countChanges(plan)).toBe(0);
});

test('findDuplicates reports bot games and sorts by all games played', async () => {
    const db = createMemoryDb({
        users: [
            { username: 'Alan', stats: stats({ gamesPlayed: 3 }) },
            { username: 'alan2', stats: stats({ gamesPlayed: 1 }), botStats: stats({ gamesPlayed: 9 }) }
        ]
    });
    const groups = await findDuplicateCandidates(db);
    expect(groups).toEqual([[
        { username: 'alan2', gamesPlayed: 1, botGamesPlayed: 9, createdAt: expect.any(Date) },
        { username: 'Alan', gamesPlayed: 3, botGamesPlayed: 0, createdAt: expect.any(Date) }
    ]]);
    expect(formatDuplicateGroups(groups)).toMatch(/alan2\s+1 games\s+9 bot games/);
});
