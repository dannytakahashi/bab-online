/**
 * The tournament history's usernames (tournamentRecords, 2026-11-25) through
 * an admin rename (accountRename.renameEverywhere), an account merge
 * (accountMerge plan / view / hash / apply, the CLI's formatPlan) and an
 * account deletion (accountDelete.eraseAccount: '[deleted]'): every place a
 * record holds a name (players, winners, scoreboard usernames, the Cut for
 * a buck participants and winner, the host), exact matches only, safe to
 * repeat, the counts in the results; the profile counts and Lucky Buck
 * afterwards.
 */

'use strict';

const { createMemoryDb } = require('../../testUtils/memoryDb');
const { renameEverywhere } = require('../accountRename');
const { eraseAccount, DELETED_NAME } = require('../accountDelete');
const { planMerge, applyMerge, countChanges, formatPlan } = require('../accountMerge');
const { planView, planHash } = require('../mergeView');
const { renameInTournamentRecords, findTournamentRecordsNaming } = require('../tournamentRecordNames');
const { createSuperlatives } = require('../../utils/superlatives');

const row = (username, totalScore) => ({ username, totalScore, roundScores: [totalScore] });

function seed() {
    return createMemoryDb({
        users: [
            { username: 'Ann', password: 'h1' },
            { username: 'Ann2', password: 'h2' },
            { username: 'Ben', password: 'h3' },
            { username: 'Annie', password: 'h4' }
        ],
        tournamentRecords: [
            {
                _id: 't-cut', v: 1, name: "Ann's Tournament", creatorUsername: 'Ann',
                createdAt: new Date('2026-11-25T09:00:00Z'), completedAt: new Date('2026-11-25T10:00:00Z'),
                totalRounds: 1, roundsPlayed: 1, players: ['Ann', 'Ben', 'Annie'], winners: ['Ann'],
                scoreboard: [row('Ann', 300), row('Ben', 100), row('Annie', 50)],
                cut: { winner: 'Ann', participants: ['Ann', 'Ben', 'Annie'], rounds: 3 }
            },
            {
                _id: 't-two', v: 1, name: 'Cup', creatorUsername: 'Ben',
                createdAt: new Date('2026-11-24T09:00:00Z'), completedAt: new Date('2026-11-24T10:00:00Z'),
                totalRounds: 2, roundsPlayed: 2, players: ['Ben', 'Ann2'], winners: ['Ann2'],
                // Ann played two rounds and left: only in the standings
                scoreboard: [row('Ann2', 500), row('Ann', 400), row('Ben', 100)],
                cut: { winner: 'Ann2', participants: ['Ben', 'Ann2'], rounds: 1 }
            },
            {
                _id: 't-none', v: 1, name: 'Plain', creatorUsername: 'Ben',
                createdAt: new Date('2026-11-23T09:00:00Z'), completedAt: new Date('2026-11-23T10:00:00Z'),
                totalRounds: 1, roundsPlayed: 1, players: ['Ben', 'Annie'], winners: ['Ben'],
                scoreboard: [row('Ben', 200), row('Annie', 10)], cut: null
            }
        ]
    });
}

const rec = (db, id) => db.tournamentRecords.all().find((r) => r._id === id);
const names = (r) => ({
    players: r.players, winners: r.winners, scoreboard: r.scoreboard.map((s) => s.username),
    cut: r.cut, creatorUsername: r.creatorUsername
});

test('a rename moves the name in every field of every record that holds it, and nothing else (Annie is not Ann)', async () => {
    const db = seed();
    const ann = db.users.all().find((u) => u.username === 'Ann');
    const out = await renameEverywhere(db, 'Ann', 'Anna', { selfId: ann._id });
    expect(out.tournamentRecords).toBe(2);
    expect(names(rec(db, 't-cut'))).toEqual({
        players: ['Anna', 'Ben', 'Annie'], winners: ['Anna'], scoreboard: ['Anna', 'Ben', 'Annie'],
        cut: { winner: 'Anna', participants: ['Anna', 'Ben', 'Annie'], rounds: 3 }, creatorUsername: 'Anna'
    });
    expect(names(rec(db, 't-two')).scoreboard).toEqual(['Ann2', 'Anna', 'Ben']);
    expect(names(rec(db, 't-two')).players).toEqual(['Ben', 'Ann2']);
    expect(rec(db, 't-none')).toEqual(seed().tournamentRecords.all().find((r) => r._id === 't-none'));
    // the other fields are untouched
    expect(rec(db, 't-cut').scoreboard[0]).toEqual(row('Anna', 300));
    // safe to repeat
    const again = await renameEverywhere(db, 'Ann', 'Anna', { selfId: ann._id });
    expect(again.tournamentRecords).toBe(0);
    expect(names(rec(db, 't-cut')).players).toEqual(['Anna', 'Ben', 'Annie']);
});

test('a deletion makes it [deleted] everywhere; Lucky Buck and the profile counts never name it', async () => {
    const db = seed();
    const ann = db.users.all().find((u) => u.username === 'Ann');
    const out = await eraseAccount(db, ann);
    expect(out.tournamentRecords).toBe(2);
    expect(names(rec(db, 't-cut'))).toEqual({
        players: [DELETED_NAME, 'Ben', 'Annie'], winners: [DELETED_NAME], scoreboard: [DELETED_NAME, 'Ben', 'Annie'],
        cut: { winner: DELETED_NAME, participants: [DELETED_NAME, 'Ben', 'Annie'], rounds: 3 }, creatorUsername: DELETED_NAME
    });
    expect(names(rec(db, 't-two')).scoreboard).toEqual(['Ann2', DELETED_NAME, 'Ben']);
    expect(await db.tournamentRecords.countDocuments({ players: 'Ann' })).toBe(0);
    expect(await db.tournamentRecords.countDocuments({ 'cut.participants': 'Ann' })).toBe(0);
    const acc = createSuperlatives();
    for (const r of db.tournamentRecords.all()) acc.addCut(r);
    acc.addCut({ cut: { winner: DELETED_NAME, participants: [DELETED_NAME] } });
    expect(acc.result().flatMap((s) => s.names)).not.toContain(DELETED_NAME);
});

test('a merge plans the records naming a source (plan, formatPlan, view, hash, count), applies them, and a re-run is a no-op', async () => {
    const db = seed();
    const before = await planMerge(db, { target: 'Ben', sources: ['Ann'] });
    const plan = await planMerge(db, { target: 'Ann', sources: ['Ann2'] });
    expect(plan.errors).toEqual([]);
    expect(plan.tournamentRecords).toEqual([{ id: 't-two', name: 'Cup', completedAt: new Date('2026-11-24T10:00:00Z') }]);
    expect(formatPlan(plan)).toContain('Tournament records to re-point: 1');
    expect(formatPlan(plan)).toContain('2026-11-24 t-two: Cup');
    expect(planView(plan).tournamentRecords).toEqual([{ id: 't-two', name: 'Cup', completedAt: '2026-11-24T10:00:00.000Z' }]);
    expect(planHash(plan)).not.toBe(planHash({ ...plan, tournamentRecords: [] }));
    expect(countChanges(plan)).toBe(countChanges({ ...plan, tournamentRecords: [] }) + 1);
    expect(before.tournamentRecords.map((t) => t.id).sort()).toEqual(['t-cut', 't-two']);

    const result = await applyMerge(db, plan);
    expect(result.tournamentRecords).toBe(1);
    expect(names(rec(db, 't-two'))).toEqual({
        players: ['Ben', 'Ann'], winners: ['Ann'], scoreboard: ['Ann', 'Ann', 'Ben'],
        cut: { winner: 'Ann', participants: ['Ben', 'Ann'], rounds: 1 }, creatorUsername: 'Ben'
    });
    // Ann's two entries in t-two's standings: the record counts once for her
    expect(await db.tournamentRecords.countDocuments({ 'scoreboard.username': 'Ann' })).toBe(2);
    const again = await planMerge(db, { target: 'Ann', sources: ['Ann2'] });
    expect(again.tournamentRecords).toEqual([]);
    expect(countChanges(again)).toBe(0);
});

test('without the collection (an older caller): nothing to do, nothing thrown', async () => {
    const db = seed();
    delete db.tournamentRecords;
    expect(await renameInTournamentRecords(undefined, 'Ann', 'Anna')).toBe(0);
    expect(await findTournamentRecordsNaming(undefined, ['Ann'])).toEqual([]);
    const ann = db.users.all().find((u) => u.username === 'Ann');
    expect((await renameEverywhere(db, 'Ann', 'Anna', { selfId: ann._id })).tournamentRecords).toBe(0);
    const plan = await planMerge(db, { target: 'Ben', sources: ['Ann2'] });
    expect(plan.tournamentRecords).toEqual([]);
    expect((await applyMerge(db, plan)).tournamentRecords).toBe(0);
});
