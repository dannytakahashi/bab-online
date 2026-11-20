/**
 * The Records superlatives' seat names (gameRecords.statsDeltas.names
 * {pos: username}, 2026-11-20, profileHandlers.buildGameEndRecord) stay in
 * step with team1Players / team2Players through an admin rename
 * (accountRename.renameEverywhere), an account merge (accountMerge) and an
 * account deletion (accountDelete.eraseAccount: '[deleted]'). Records
 * without a names map (before 2026-11-20) are left exactly as they were.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');
const { renameEverywhere } = require('../accountRename');
const { eraseAccount, DELETED_NAME } = require('../accountDelete');
const { planMerge, applyMerge, countChanges, formatPlan } = require('../accountMerge');
const { planView, planHash } = require('../mergeView');
const { computeSuperlatives } = require('../../utils/superlatives');

const seat = (o = {}) => ({ gamesPlayed: 1, totalHands: 13, totalHSI: 1300, totalSets: 2, totalTricksBid: 20, totalTricksTaken: 24, totalBags: 4, ...o });

/** Ann/Cat vs Ben/Dan with a names map; a legacy record without one; a solo bot game. */
function seed() {
    return createMemoryDb({
        users: [
            { username: 'Ann', password: 'h1' },
            { username: 'Ann2', password: 'h2' },
            { username: 'Ben', password: 'h3' },
            { username: 'Cat', password: 'h4' },
            { username: 'Dan', password: 'h5' }
        ],
        gameRecords: [
            {
                gameId: 'g-names', team1Players: ['Ann', 'Cat'], team2Players: ['Ben', 'Dan'], team1Score: 300, team2Score: 100,
                completedAt: new Date('2026-11-20T10:00:00Z'),
                statsDeltas: { bucket: 'stats', byPosition: { 1: seat(), 2: seat(), 3: seat(), 4: seat() }, names: { 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' } }
            },
            {
                gameId: 'g-legacy', team1Players: ['Ann', 'Cat'], team2Players: ['Ben', 'Dan'], team1Score: 200, team2Score: 250,
                completedAt: new Date('2026-11-16T10:00:00Z'),
                statsDeltas: { bucket: 'stats', byPosition: { 1: seat(), 2: seat(), 3: seat(), 4: seat() } }
            },
            {
                gameId: 'g-solo', withBots: true, team1Players: ['Ann2'], team2Players: [], team1Bots: ['🤖 Zach'], team2Bots: ['🤖 Ivy', '🤖 Mary'],
                team1Score: 400, team2Score: 100, completedAt: new Date('2026-11-20T11:00:00Z'),
                statsDeltas: { bucket: 'botStats', byPosition: { 1: seat() }, names: { 1: 'Ann2' } }
            }
        ],
        reports: []
    });
}

const rec = (db, gameId) => db.gameRecords.all().find((r) => r.gameId === gameId);

test('a rename re-points the names map with the teams; a legacy record (no map) is only renamed in its teams', async () => {
    const db = seed();
    const ann = db.users.all().find((u) => u.username === 'Ann');
    const out = await renameEverywhere(db, 'Ann', 'Anna', { selfId: ann._id });
    expect(out.gameRecords).toBe(2); // counted once per team array, as before
    expect(rec(db, 'g-names').statsDeltas.names).toEqual({ 1: 'Anna', 2: 'Ben', 3: 'Cat', 4: 'Dan' });
    expect(rec(db, 'g-names').team1Players).toEqual(['Anna', 'Cat']);
    expect(rec(db, 'g-legacy').team1Players).toEqual(['Anna', 'Cat']);
    expect(rec(db, 'g-legacy').statsDeltas).not.toHaveProperty('names');
    // the other records' names are untouched
    expect(rec(db, 'g-solo').statsDeltas.names).toEqual({ 1: 'Ann2' });
    // safe to repeat
    await renameEverywhere(db, 'Ann', 'Anna', { selfId: ann._id });
    expect(rec(db, 'g-names').statsDeltas.names[1]).toBe('Anna');
});

test('a deletion makes the seat [deleted] in the names map too, and the superlatives never name it', async () => {
    const db = seed();
    const ann = db.users.all().find((u) => u.username === 'Ann');
    await eraseAccount(db, ann);
    expect(rec(db, 'g-names').statsDeltas.names).toEqual({ 1: DELETED_NAME, 2: 'Ben', 3: 'Cat', 4: 'Dan' });
    expect(rec(db, 'g-names').team1Players).toEqual([DELETED_NAME, 'Cat']);
    expect(rec(db, 'g-legacy').team1Players).toEqual([DELETED_NAME, 'Cat']);
    expect(rec(db, 'g-legacy').statsDeltas).not.toHaveProperty('names');
    const names = computeSuperlatives(db.gameRecords.all(), { minGames: 1 }).flatMap((s) => s.names);
    expect(names).not.toContain(DELETED_NAME);
    expect(names).not.toContain('Ann');
});

test('a merge re-points the names map with the teams (plan, view, hash, apply; re-run is a no-op)', async () => {
    const db = seed();
    const plan = await planMerge(db, { target: 'Ann', sources: ['Ann2'] });
    expect(plan.errors).toEqual([]);
    const solo = plan.gameRecords.find((r) => r.gameId === 'g-solo');
    expect(solo.after).toEqual({ team1Players: ['Ann'], team2Players: [], 'statsDeltas.names': { 1: 'Ann' } });
    // records that do not name a source are not in the plan
    expect(plan.gameRecords.map((r) => r.gameId)).toEqual(['g-solo']);
    expect(formatPlan(plan)).toContain('g-solo');
    expect(planView(plan).gameRecords[0].after).toEqual({ team1: ['Ann'], team2: [] });
    expect(typeof planHash(plan)).toBe('string');

    await applyMerge(db, plan);
    expect(rec(db, 'g-solo').statsDeltas.names).toEqual({ 1: 'Ann' });
    expect(rec(db, 'g-solo').statsDeltas.byPosition[1]).toEqual(seat());
    expect(rec(db, 'g-solo').team1Players).toEqual(['Ann']);
    expect(rec(db, 'g-solo').team1Bots).toEqual(['🤖 Zach']);
    expect(countChanges(await planMerge(db, { target: 'Ann', sources: ['Ann2'] }))).toBe(0);
});

test('a merge finds a record that names a source only in its names map (kept in step anyway)', async () => {
    const db = seed();
    // out of step on purpose: teams already re-pointed, the map not
    await db.gameRecords.updateOne({ gameId: 'g-solo' }, { $set: { team1Players: ['Ann'] } });
    expect(rec(db, 'g-solo').team1Players).toEqual(['Ann']);
    const plan = await planMerge(db, { target: 'Ann', sources: ['Ann2'] });
    expect(plan.gameRecords.map((r) => r.gameId)).toEqual(['g-solo']);
    await applyMerge(db, plan);
    expect(rec(db, 'g-solo').statsDeltas.names).toEqual({ 1: 'Ann' });
});

test('a merge of two players who sat at one table: the map names the target twice; the superlatives count the game once', async () => {
    const db = seed();
    // Ann2 played seat 3 of g-names in this variant
    await db.gameRecords.updateOne({ gameId: 'g-names' }, { $set: { team1Players: ['Ann', 'Ann2'], 'statsDeltas.names.3': 'Ann2' } });
    const plan = await planMerge(db, { target: 'Ann', sources: ['Ann2'] });
    expect(plan.warnings.join(' ')).toContain('g-names');
    await applyMerge(db, plan);
    expect(rec(db, 'g-names').statsDeltas.names).toEqual({ 1: 'Ann', 2: 'Ben', 3: 'Ann', 4: 'Dan' });
    // g-names and g-solo by the map, g-legacy rebuilt from its teams: 3 games
    const all = computeSuperlatives(db.gameRecords.all(), { minGames: 3 });
    expect(all.find((s) => s.id === 'botFriends')).toEqual({ id: 'botFriends', title: 'Some of my best friends are bots', names: ['Ann'], detail: '1 solo game' });
});
