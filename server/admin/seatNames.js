/**
 * gameRecords' per-seat names, `statsDeltas.names {<pos>: username}` (the
 * Records superlatives, profileHandlers.buildGameEndRecord, 2026-11-20),
 * renamed for an account rename (accountRename.renameEverywhere) or a
 * delete ('[deleted]', accountDelete.eraseAccount). accountMerge re-points
 * them in its own plan.
 *
 * One find (a single collection scan for the four paths together, as no
 * index covers them) and one bulkWrite of exact-match updates by _id, so a
 * rename costs one scan here, not one per seat. Each update matches only
 * while the seat still holds `from`, so it is safe to repeat.
 */

'use strict';

const SEAT_NAME_PATHS = Object.freeze([1, 2, 3, 4].map((pos) => `statsDeltas.names.${pos}`));

/**
 * @param {Object} gameRecords - the collection
 * @param {string} from - the name to replace
 * @param {string} to - its replacement
 * @returns {Promise<number>} seats rewritten
 */
async function renameSeatNames(gameRecords, from, to) {
    if (!gameRecords) return 0;
    const found = await gameRecords.find(
        { $or: SEAT_NAME_PATHS.map((path) => ({ [path]: from })) },
        { projection: { _id: 1, 'statsDeltas.names': 1 } }
    ).toArray();
    const ops = [];
    for (const rec of found) {
        const names = rec?.statsDeltas?.names;
        if (!names || typeof names !== 'object') continue;
        for (const [pos, path] of SEAT_NAME_PATHS.entries()) {
            if (names[pos + 1] !== from) continue;
            ops.push({ updateOne: { filter: { _id: rec._id, [path]: from }, update: { $set: { [path]: to } } } });
        }
    }
    if (ops.length === 0) return 0;
    const res = await gameRecords.bulkWrite(ops, { ordered: false });
    return res?.modifiedCount || 0;
}

module.exports = { SEAT_NAME_PATHS, renameSeatNames };
