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
 *                             taken, leaderboard and search skip it, a later
 *                             rename or merge re-points it); the new name is
 *                             told ONLY at sign-in with the account's
 *                             password ("This account is now called X. Sign
 *                             in as X."): a wrong password, a sign-up, a
 *                             restore and getPlayerProfile never name it (a
 *                             player renamed on request may be getting away
 *                             from someone; authHandlers.hidesNewName); the
 *                             admin can delete it later to free the name
 *   gameRecords               team1Players / team2Players
 *   reports                   reporter, reported, resolvedBy (not a report
 *                             marked reporterDeletedAt / reportedDeletedAt:
 *                             that side was an earlier, deleted holder of
 *                             the name, not this account)
 *   users.blockedUsers        other players' lists (de-duplicated)
 *   users.mergedInto          tombstones that pointed at the old name (merged
 *                             accounts, earlier renames) point at the new one,
 *                             marked `targetRenamedAt` (the new name stays
 *                             private on them too)
 *   users.adminSetBy          who made someone an admin
 * Not renamed: adminAudit (a log of what happened, by the names of the
 * time; the rename's own entry links old -> new) and passwordResets'
 * createdBy (history). Tournament history is in memory only.
 *
 * Order: the guarded rename first (the step that can be refused: the name
 * appeared meanwhile, the account entered a game or was merged; it also
 * sets `renamePending: {from, at}`), then a re-check for a case-variant
 * clash that puts the old name back, then the redirect, then the shared
 * documents, then renamePending is cleared. The shared documents are pure
 * renames: when a step after the guarded write fails (the redirect's
 * insert included), renaming again with the same names finishes them
 * (renamePending, or the redirect, shows the rename happened: `resumed`),
 * and the panel's row for the account offers Finish rename while
 * renamePending is set.
 *
 * The case-variant race with a sign-up: the rename re-checks after ITS
 * write, and signUp re-checks after ITS insert (authHandlers.signUp); of
 * two writes racing, the later one's re-check sees the earlier one, so a
 * case variant of the new name can never stay beside it (the unique index
 * only catches the exact name, and a database on the non-unique fallback
 * index catches nothing).
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
async function renameUserDoc(db, user, to, { now = new Date() } = {}) {
    let before;
    try {
        before = await db.users.findOneAndUpdate(
            {
                _id: user._id,
                username: user.username,
                mergedInto: { $exists: false },
                renamePending: { $exists: false },
                activeGameId: { $exists: false },
                activeTournamentId: { $exists: false }
            },
            {
                $set: { username: to, renamePending: { from: user.username, at: now } },
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
        await db.users.updateOne({ _id: user._id, username: to }, { $set: { username: user.username }, $unset: { renamePending: '' } });
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
async function renameEverywhere(db, from, to, { selfId, now = new Date() }) {
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
        for (const [field, deletedMark] of [['reporter', 'reporterDeletedAt'], ['reported', 'reportedDeletedAt'], ['resolvedBy', null]]) {
            const filter = deletedMark ? { [field]: from, [deletedMark]: { $exists: false } } : { [field]: from };
            const res = await db.reports.updateMany(filter, { $set: { [field]: to } });
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
    // targetRenamedAt: a merged name now pointing at the NEW name keeps it
    // private like the redirect (authHandlers.hidesNewName)
    const chained = await db.users.updateMany({ mergedInto: from }, { $set: { mergedInto: to, targetRenamedAt: now } });
    out.chainedTombstones = chained?.modifiedCount || 0;
    const setBy = await db.users.updateMany({ adminSetBy: from }, { $set: { adminSetBy: to } });
    out.adminSetBy = setBy?.modifiedCount || 0;
    return out;
}

/** Step 4: the rename is complete (renameEverywhere ran to its end). */
async function finishRename(db, id, from) {
    await db.users.updateOne({ _id: id, 'renamePending.from': from }, { $unset: { renamePending: '' } });
}

/**
 * The live account whose rename from `oldName` has not finished, or null
 * (its redirect must not be deleted yet: the old name still keys games,
 * reports and block lists).
 */
async function unfinishedRenameOf(db, oldName) {
    return db.users.findOne(
        { 'renamePending.from': oldName, mergedInto: { $exists: false } },
        { projection: { username: 1 } }
    );
}

module.exports = { renameUserDoc, leaveRedirect, renameEverywhere, finishRename, unfinishedRenameOf, revokeOpenResetLinks, isRenameRedirect };
