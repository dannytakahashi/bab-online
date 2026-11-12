/**
 * Renaming an account from the admin panel (owner, 2026-11-11: "ability to
 * rename accounts from the admin panel (so I can do it for people when
 * requested)"). The orchestration (refusals, the name lock, signing out,
 * the merge queue) is adminHandlers renameAccount; this is the data.
 *
 * The new name follows the sign-up rules (checkNewUsername, the profanity
 * filter) and must not clash, ignoring case, with any stored name,
 * tombstones included (findNameClash); only the account itself may match
 * (a case-only rename, "alan" -> "Alan").
 *
 * Where the name is a key, and what happens to it (keep in step with
 * accountMerge.js, the other writer of these fields):
 *   users.username            the ONE guarded write (below)
 *   users.sessionTokens       revoked with it (REVOKE_ALL_SESSIONS, the
 *                             sessionEpoch path): every saved sign-in names
 *                             the old username, so the player signs in once
 *                             with the new name and the same password
 *   passwordResets            open links revoked first; used / revoked ones
 *                             keep the old name (history)
 *   the old name              a redirect tombstone { username: old,
 *                             mergedInto: new, mergedAt, renamedAt, renamedBy }:
 *                             every tombstone path works on it (sign-up says
 *                             taken, profile / avatar follow it, leaderboard
 *                             and search skip it, a later rename or merge
 *                             re-points it) and sign-in / restore say "This
 *                             account is now called X. Sign in as X."; the
 *                             admin can delete it later to free the name
 *   gameRecords               team1Players / team2Players
 *   reports                   reporter, reported, resolvedBy
 *   users.blockedUsers        other players' lists (de-duplicated)
 *   users.mergedInto          tombstones that pointed at the old name (merged
 *                             accounts, earlier renames) point at the new one
 *   users.adminSetBy          who made someone an admin
 * Not renamed: adminAudit (a log of what happened, by the names of the
 * time; the rename's own entry links old -> new) and passwordResets'
 * createdBy (history). Tournament history is in memory only.
 *
 * Order: the guarded rename first (the step that can be refused: the name
 * appeared meanwhile, the account entered a game or was merged), then a
 * re-check for a case-variant clash (a sign-up racing the rename; the
 * unique index only catches the exact name, and a database running on the
 * non-unique fallback index catches nothing) that puts the old name back,
 * then the redirect, then the shared documents. Those are pure renames:
 * when one fails, renaming again with the same names finishes them (the
 * redirect shows the rename happened: `resume`).
 */

'use strict';

const { REVOKE_ALL_SESSIONS } = require('../utils/sessionTokens');
const { revokeOpenResetLinks } = require('./setPassword');

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is this tombstone the redirect a rename left (not a merge)? */
function isRenameRedirect(doc) {
    return Boolean(doc && doc.mergedInto && doc.renamedAt);
}

function renameList(list, from, to) {
    return [...new Set((list || []).map(n => (n === from ? to : n)))];
}

/**
 * Step 1: the guarded rename of the user document, with every saved
 * session revoked, then the clash re-check.
 * @returns {Promise<{ok: true, revokedSessions: number, socketId: string|null}
 *          | {ok: false, reason: 'changed'|'taken'}>}
 */
async function renameUserDoc(db, user, to) {
    let before;
    try {
        before = await db.users.findOneAndUpdate(
            {
                _id: user._id,
                username: user.username,
                mergedInto: { $exists: false },
                activeGameId: { $exists: false },
                activeTournamentId: { $exists: false }
            },
            {
                $set: { username: to },
                $unset: { ...REVOKE_ALL_SESSIONS.$unset, socketId: '' },
                $inc: { ...REVOKE_ALL_SESSIONS.$inc }
            },
            { returnDocument: 'before', projection: { socketId: 1, 'sessionTokens.hash': 1, sessionToken: 1 } }
        );
    } catch (error) {
        if (error && error.code === 11000) return { ok: false, reason: 'taken' };
        throw error;
    }
    if (!before) return { ok: false, reason: 'changed' };
    // A case variant (or, without the unique index, the exact name) that
    // appeared while the write was in flight: put the old name back
    const clash = await db.users.findOne(
        { _id: { $ne: user._id }, username: { $regex: `^\\s*${escapeRegex(to)}\\s*$`, $options: 'i' } },
        { projection: { username: 1 } }
    );
    if (clash) {
        await db.users.updateOne({ _id: user._id, username: to }, { $set: { username: user.username } });
        return { ok: false, reason: 'taken' };
    }
    return {
        ok: true,
        revokedSessions: (before.sessionTokens?.length || 0) + (before.sessionToken ? 1 : 0),
        socketId: typeof before.socketId === 'string' ? before.socketId : null
    };
}

/**
 * Step 2: the redirect at the old name. False when the name was taken in
 * the gap (a sign-up the name lock did not stop: the CLI, another process).
 */
async function leaveRedirect(db, from, to, { now, by }) {
    try {
        await db.users.insertOne({ username: from, mergedInto: to, mergedAt: now, renamedAt: now, renamedBy: by || null });
        return true;
    } catch (error) {
        if (error && error.code === 11000) return false;
        throw error;
    }
}

/**
 * Step 3: every shared document that names the old name. Safe to repeat.
 * @returns {Promise<{gameRecords: number, reports: number, otherUsersBlocks: number, blockers: string[], chainedTombstones: number, adminSetBy: number}>}
 */
async function renameEverywhere(db, from, to, { selfId }) {
    const out = { gameRecords: 0, reports: 0, otherUsersBlocks: 0, blockers: [], chainedTombstones: 0, adminSetBy: 0 };
    if (db.gameRecords) {
        for (const team of ['team1Players', 'team2Players']) {
            const res = await db.gameRecords.updateMany(
                { [team]: from },
                { $set: { [`${team}.$[p]`]: to } },
                { arrayFilters: [{ p: from }] }
            );
            out.gameRecords += res?.modifiedCount || 0;
        }
    }
    if (db.reports) {
        for (const field of ['reporter', 'reported', 'resolvedBy']) {
            const res = await db.reports.updateMany({ [field]: from }, { $set: { [field]: to } });
            out.reports += res?.modifiedCount || 0;
        }
    }
    const blockers = await db.users.find(
        { blockedUsers: from, _id: { $ne: selfId } },
        { projection: { username: 1, blockedUsers: 1 } }
    ).toArray();
    for (const doc of blockers) {
        await db.users.updateOne({ _id: doc._id }, { $set: { blockedUsers: renameList(doc.blockedUsers, from, to) } });
        out.otherUsersBlocks++;
        out.blockers.push(doc.username);
    }
    // the account's own list cannot name itself
    await db.users.updateOne({ _id: selfId, blockedUsers: to }, { $pull: { blockedUsers: to } });
    const chained = await db.users.updateMany({ mergedInto: from }, { $set: { mergedInto: to } });
    out.chainedTombstones = chained?.modifiedCount || 0;
    const setBy = await db.users.updateMany({ adminSetBy: from }, { $set: { adminSetBy: to } });
    out.adminSetBy = setBy?.modifiedCount || 0;
    return out;
}

module.exports = { renameUserDoc, leaveRedirect, renameEverywhere, revokeOpenResetLinks, isRenameRedirect };
