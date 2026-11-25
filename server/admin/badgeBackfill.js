/**
 * Badges backfill (owner 2026-11-25: "assign 500 and 400 to players Records
 * confirm have scored that high. Also Felted"): the badges the stored data
 * proves a player already earned before badges existed.
 *
 *   five-hundred / four-hundred / felted   from the human game records
 *       (gameRecords without withBots: teamNScore and teamNPlayers; 500
 *       also earns 400), dated by the first game that earned each;
 *   chemistry   20 human game records with the same partner on one team,
 *       dated by the 20th;
 *   century     users.stats.gamesPlayed >= 100 (the human bucket), dated
 *       when the backfill runs (the 100th game is not recorded as such).
 *
 * Nothing else can be backfilled: the other badges need what happened
 * inside a game, which no record holds. A bot game never counts (the
 * leaderboard's rule), '[deleted]' and names with no live account are
 * skipped, and a badge a player already has is left as it is (its date
 * too). plan() only reads; apply() writes each award with the guarded
 * $push the game end uses (`badges.id: {$ne: id}`), so running it twice,
 * or while games end, awards nothing twice. Used by
 * scripts/backfill-badges.js.
 */

'use strict';

const { LIMITS, isBadgeId } = require('../game/badges');
const { DELETED_NAME } = require('./nameHold');

const RECORD_PROJECTION = { _id: 0, gameId: 1, completedAt: 1, team1Score: 1, team2Score: 1, team1Players: 1, team2Players: 1 };
const isName = (v) => typeof v === 'string' && v.length > 0 && v !== DELETED_NAME;
const timeOf = (r) => (r.completedAt instanceof Date ? r.completedAt.getTime() : 0);

/** The badges one team's final score proves. */
function scoreBadges(score) {
    if (typeof score !== 'number' || !Number.isFinite(score)) return [];
    const ids = [];
    if (score >= LIMITS.fiveHundred) ids.push('five-hundred');
    if (score >= LIMITS.fourHundred) ids.push('four-hundred');
    if (score < 0) ids.push('felted');
    return ids;
}

/**
 * What the backfill would award. Reads only.
 * @param {{users: Collection, gameRecords: Collection}} db
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{records: number, players: number, awards: Array<{username, id, at, gameId?}>, skipped: string[]}>}
 */
async function plan(db, { now = new Date() } = {}) {
    const records = await db.gameRecords.find({ withBots: { $ne: true } }, { projection: RECORD_PROJECTION }).toArray();
    records.sort((a, b) => timeOf(a) - timeOf(b));

    // username -> badge id -> {at, gameId}: the first game that earned it
    const earned = new Map();
    const note = (username, id, record) => {
        if (!earned.has(username)) earned.set(username, new Map());
        const mine = earned.get(username);
        if (!mine.has(id)) mine.set(id, { at: record.completedAt instanceof Date ? record.completedAt : now, gameId: record.gameId });
    };
    const together = new Map();
    for (const record of records) {
        for (const n of [1, 2]) {
            const players = [...new Set((Array.isArray(record[`team${n}Players`]) ? record[`team${n}Players`] : []).filter(isName))];
            for (const id of scoreBadges(record[`team${n}Score`])) for (const username of players) note(username, id, record);
            if (players.length === 2) {
                const key = JSON.stringify([...players].sort());
                const games = (together.get(key) || 0) + 1;
                together.set(key, games);
                if (games === LIMITS.chemistryGames) for (const username of players) note(username, 'chemistry', record);
            }
        }
    }

    const users = await db.users.find(
        { mergedInto: { $exists: false } },
        { projection: { username: 1, badges: 1, 'stats.gamesPlayed': 1 } }
    ).toArray();
    const byName = new Map(users.filter((u) => isName(u.username)).map((u) => [u.username, u]));
    for (const u of byName.values()) {
        if ((u.stats?.gamesPlayed || 0) >= LIMITS.centuryGames) note(u.username, 'century', { completedAt: now });
    }

    const awards = [];
    const skipped = [];
    for (const [username, mine] of earned) {
        const user = byName.get(username);
        if (!user) {
            skipped.push(username);
            continue;
        }
        const has = new Set((Array.isArray(user.badges) ? user.badges : []).map((b) => b?.id));
        for (const [id, { at, gameId }] of mine) {
            if (!isBadgeId(id) || has.has(id)) continue;
            const award = { username, id, at };
            if (typeof gameId === 'string') award.gameId = gameId;
            awards.push(award);
        }
    }
    awards.sort((a, b) => a.username.localeCompare(b.username) || a.id.localeCompare(b.id));
    return { records: records.length, players: byName.size, awards, skipped: skipped.sort() };
}

/**
 * Write a plan's awards.
 * @returns {Promise<{awarded: number, already: number}>}
 */
async function apply(db, awards) {
    const out = { awarded: 0, already: 0 };
    for (const { username, id, at, gameId } of awards) {
        const entry = { id, at, backfilled: true };
        if (gameId) entry.gameId = gameId;
        const res = await db.users.updateOne(
            { username, mergedInto: { $exists: false }, 'badges.id': { $ne: id } },
            { $push: { badges: entry } }
        );
        if (res?.modifiedCount > 0) out.awarded++;
        else out.already++;
    }
    return out;
}

module.exports = { plan, apply, scoreBadges };
