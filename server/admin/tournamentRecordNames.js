/**
 * The tournament history's usernames (tournamentRecords, one document per
 * completed tournament: server/game/tournamentRecord.js), renamed for an
 * account rename (accountRename.renameEverywhere), a merge (each source to
 * the kept account: accountMerge.applyMerge, the panel and the CLI) and a
 * deletion ('[deleted]': accountDelete.eraseAccount).
 *
 * Where a record holds a name: players[], winners[], scoreboard[].username,
 * cut.participants[], cut.winner, creatorUsername. One updateMany per
 * field, exact matches only (array elements through arrayFilters), so a
 * repeat is a no-op: safe to run again after a failure partway. A merge
 * that leaves one person twice in a record (two of their accounts played
 * the same tournament) keeps both entries; the profile counts each
 * document once (countDocuments).
 */

'use strict';

/** Every place a record holds a username, as a match filter for `name`. */
function namingFilter(name) {
    return {
        $or: [
            { players: name },
            { winners: name },
            { 'scoreboard.username': name },
            { 'cut.participants': name },
            { 'cut.winner': name },
            { creatorUsername: name }
        ]
    };
}

/**
 * The records that name any of `names` (a merge plan's list), newest first.
 * @returns {Promise<Array<{id: string, name: string, completedAt: Date|null}>>}
 */
async function findTournamentRecordsNaming(tournamentRecords, names) {
    if (!tournamentRecords || !Array.isArray(names) || names.length === 0) return [];
    const docs = await tournamentRecords.find(
        { $or: names.flatMap((n) => namingFilter(n).$or) },
        { projection: { _id: 1, name: 1, completedAt: 1 } }
    ).toArray();
    return docs.map((d) => ({ id: String(d._id), name: typeof d.name === 'string' ? d.name : '', completedAt: d.completedAt || null }));
}

/**
 * Rename `from` to `to` in every tournament record.
 * @param {Object} tournamentRecords - the collection (absent: nothing to do)
 * @returns {Promise<number>} the records that named `from`
 */
async function renameInTournamentRecords(tournamentRecords, from, to) {
    if (!tournamentRecords || from === to) return 0;
    const n = await tournamentRecords.countDocuments(namingFilter(from));
    if (n === 0) return 0;
    for (const field of ['players', 'winners', 'cut.participants']) {
        await tournamentRecords.updateMany(
            { [field]: from },
            { $set: { [`${field}.$[n]`]: to } },
            { arrayFilters: [{ n: from }] }
        );
    }
    await tournamentRecords.updateMany(
        { 'scoreboard.username': from },
        { $set: { 'scoreboard.$[s].username': to } },
        { arrayFilters: [{ 's.username': from }] }
    );
    await tournamentRecords.updateMany({ 'cut.winner': from }, { $set: { 'cut.winner': to } });
    await tournamentRecords.updateMany({ creatorUsername: from }, { $set: { creatorUsername: to } });
    return n;
}

module.exports = { namingFilter, findTournamentRecordsNaming, renameInTournamentRecords };
