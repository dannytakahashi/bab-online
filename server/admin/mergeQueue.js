/**
 * One queue for every write that changes which account a name belongs to:
 * the panel's merges, deletes and renames (adminHandlers) and a player's
 * own Delete account (authHandlers.deleteAccount). They run one after
 * another (single server process: an in-process queue is enough), so two
 * of them can never interleave on the same names: a self-delete waiting on
 * its password check cannot erase an account a rename moved meanwhile, and
 * a rename never re-points data a delete is erasing. A failed one does not
 * block the next.
 */

'use strict';

let mergeQueue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serializeMerges(fn) {
    const run = mergeQueue.then(fn, fn);
    mergeQueue = run.catch(() => {});
    return run;
}

module.exports = { serializeMerges };
