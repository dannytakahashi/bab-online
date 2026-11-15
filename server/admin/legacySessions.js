/**
 * One-off: fold every legacy plaintext `users.sessionToken` into the hashed
 * `sessionTokens` list and $unset it (scripts/migrate-legacy-session-tokens.js).
 *
 * The server already does this on a token's next use (sessionTokens.js
 * verifySession) and accepts a legacy token meanwhile with no expiry, so a
 * token that is never used again stays readable in the database forever.
 * The write here is the one verifySession would make: the legacy entry is
 * hashed in with lastUsedAt = now (its 90 days start now; the device stays
 * signed in), expired entries dropped. Tombstones hold no sessions: theirs
 * is only unset. Each write is guarded on the same token and sessionEpoch
 * (a sign-in, restore or revoke in between wins; counted as `raced`).
 * Counts only: never a name, token or hash.
 */

const { verifySession, sessionStateFilter } = require('../utils/sessionTokens');

const LEGACY = { sessionToken: { $exists: true } };

/**
 * @param {{users: Object}} db
 * @param {{apply?: boolean, now?: Date}} [opts]
 * @returns {Promise<{found: number, accounts: number, tombstones: number, migrated: number, unset: number, raced: number}>}
 */
async function migrateLegacySessionTokens(db, { apply = false, now = new Date() } = {}) {
    const rows = await db.users.find(LEGACY, {
        projection: { _id: 1, sessionToken: 1, sessionTokens: 1, sessionEpoch: 1, mergedInto: 1 }
    }).toArray();
    const counts = { found: rows.length, accounts: 0, tombstones: 0, migrated: 0, unset: 0, raced: 0 };
    for (const user of rows) {
        const tombstone = Boolean(user.mergedInto);
        if (tombstone) counts.tombstones++;
        else counts.accounts++;
        if (!apply) continue;

        const filter = { _id: user._id, sessionToken: user.sessionToken, ...sessionStateFilter(user) };
        // A non-string legacy value can never be presented: just drop it
        const verified = !tombstone && typeof user.sessionToken === 'string' && user.sessionToken
            ? verifySession(user, user.sessionToken, now)
            : null;
        const update = verified ? verified.update : { $unset: { sessionToken: '' } };
        const result = await db.users.updateOne(filter, update);
        if (result.matchedCount === 0) counts.raced++;
        else if (verified) counts.migrated++;
        else counts.unset++;
    }
    return counts;
}

module.exports = { migrateLegacySessionTokens };
