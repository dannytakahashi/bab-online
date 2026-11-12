/**
 * The web admin panel's socket API (owner, 2026-11-11: "allow me/my user
 * and anyone designated admin to be able to do things like the merge
 * duplicate accounts or send a password reset email etc. from ui").
 *
 * One request event and one reply:
 *   adminRequest  {requestId, action, args}
 *   adminResponse {requestId, action, ok: true, ...the action's fields}
 *               | {requestId, action, ok: false, error, message}
 *
 * Why socket events and not HTTP routes: the panel lives inside the
 * signed-in web app, whose socket is already authenticated (signIn /
 * restoreSession set the socket's user and socket.data.sessionHash), goes
 * through asyncHandler's validation, rate limit and error handling, and can
 * reach the target's live sockets (sign out everywhere) directly. There is
 * no cookie anywhere, so there is no CSRF surface to defend. The one HTTP
 * route of this feature is the player-facing reset page
 * (routes/passwordReset.js), which has no signed-in socket by design.
 * The iOS app never registers these (contract layout: excluded from Swift).
 *
 * AUTHORIZATION is checked on EVERY request, against the DATABASE at
 * request time (authorizeAdmin): the socket is signed in, its session is
 * still live (the user's sessionTokens still hold socket.data.sessionHash,
 * so a revoked session loses admin at once), it is the account's current
 * socket (users.socketId: a stale socket a newer sign-in replaced is
 * refused), the account exists, is not a merged tombstone, and has
 * isAdmin: true. Never a client flag, never a value cached at sign-in.
 * Anything else gets the same refusal for every action and every target
 * ({error:'forbidden', message: FORBIDDEN_MESSAGE}), checked before the
 * arguments are even read, so a non-admin learns nothing about any account.
 *
 * AUDIT: every request writes exactly one adminAudit entry (audit.js):
 * ok / failed for an admin, forbidden for a signed-in non-admin (a
 * signed-out socket has no name: server log only). The audit view itself
 * (listAudit) is not audited. Never a token, password or session hash.
 * Refusals are coalesced (forbiddenGate): at most one forbidden entry and
 * one log line per name and action every FORBIDDEN_WINDOW_MS, the next one
 * carrying how many were held back, so a player looping requests over many
 * sockets cannot grow adminAudit without bound or bury the admins' entries.
 */

'use strict';

const Joi = require('joi');
const database = require('../database');
const gameManager = require('../game/GameManager');
const { createModuleLogger } = require('../utils/logger');
const { hasLiveSession, REVOKE_ALL_SESSIONS } = require('../utils/sessionTokens');
const { AdminError } = require('../admin/adminError');
const { listAdmins, setAdminFlag } = require('../admin/adminRole');
const { createResetLink } = require('../admin/passwordReset');
const { revokeOpenResetLinks } = require('../admin/setPassword');
const { recordAudit, listAudit } = require('../admin/audit');
const { listReports, resolveReport } = require('../admin/reports');
const { searchPlayers, listPlayers } = require('../admin/players');
const { planMerge, applyMerge, countChanges, findDuplicateCandidates } = require('../admin/accountMerge');
const { planView, planHash } = require('../admin/mergeView');
const { eraseAccount, deleteTombstone, forgetAccount, refreshBlockLists } = require('../admin/accountDelete');
const { renameUserDoc, leaveRedirect, renameEverywhere, finishRename, unfinishedRenameOf, isRenameRedirect } = require('../admin/accountRename');
const { checkNewUsername, findNameClash, takenMessage } = require('../utils/usernameRules');
const { containsProfanitySubstring } = require('../utils/profanityFilter');
const { signOutUser } = require('./authHandlers');
const { serializeMerges } = require('../admin/mergeQueue');

const logger = createModuleLogger('admin');

const FORBIDDEN_MESSAGE = 'Not available.';

const name = () => Joi.string().min(1).max(50);

const ACTION_SCHEMAS = {
    searchPlayers: Joi.object({ query: name().required() }),
    createResetLink: Joi.object({ username: name().required() }),
    signOutEverywhere: Joi.object({ username: name().required() }),
    findDuplicates: Joi.object({}),
    planMerge: Joi.object({ target: name().required(), sources: Joi.array().items(name()).min(1).max(10).unique().required() }),
    applyMerge: Joi.object({
        target: name().required(),
        sources: Joi.array().items(name()).min(1).max(10).unique().required(),
        planHash: Joi.string().hex().length(64).required(),
        confirm: Joi.string().max(50).allow('').required()
    }),
    listReports: Joi.object({ status: Joi.string().valid('open', 'all').default('open') }),
    resolveReport: Joi.object({
        id: Joi.string().hex().length(24).required(),
        status: Joi.string().valid('resolved', 'dismissed').required(),
        note: Joi.string().max(500).allow('').default('')
    }),
    listAdmins: Joi.object({}),
    setAdmin: Joi.object({ username: name().required(), isAdmin: Joi.boolean().strict().required() }),
    listAudit: Joi.object({
        before: Joi.date().iso().optional(),
        beforeId: Joi.string().hex().length(24).optional(),
        limit: Joi.number().integer().min(1).max(100).default(50)
    }),
    listPlayers: Joi.object({}),
    deleteAccount: Joi.object({
        username: name().required(),
        confirm: Joi.string().max(50).allow('').required()
    }),
    // newName as typed (the sign-up rules run in the handler, so a bad
    // name gets their message, not a validation error)
    renameAccount: Joi.object({
        username: name().required(),
        newName: Joi.string().max(50).allow('').required(),
        confirm: Joi.string().max(50).allow('').required()
    })
};

const ACTIONS = Object.keys(ACTION_SCHEMAS);
if (ACTIONS.join() !== require('../admin/actions').ADMIN_ACTIONS.join()) {
    throw new Error('adminHandlers: ACTION_SCHEMAS must list server/admin/actions.js ADMIN_ACTIONS in order');
}
// Read-only views an admin opens all the time (the Audit tab itself, the
// Players table on every open/refresh) would bury the real actions; a
// refused (non-admin) request is still audited above
const NOT_AUDITED = new Set(['listAudit', 'listPlayers']);

function adminDb() {
    return {
        users: database.getUsersCollection(),
        gameRecords: database.getGameRecordsCollection(),
        reports: database.getReportsCollection(),
        passwordResets: database.getPasswordResetsCollection?.(),
        adminAudit: database.getAdminAuditCollection?.()
    };
}

const AUTHZ_PROJECTION = {
    username: 1, isAdmin: 1, mergedInto: 1, socketId: 1,
    'sessionTokens.hash': 1, 'sessionTokens.lastUsedAt': 1, 'sessionTokens.createdAt': 1, sessionToken: 1
};

/**
 * The admin check, from the database, at request time. Each line is one
 * condition (fault injection removes them one at a time: every one has a
 * test in adminPanel.test.js that fails without it).
 * @returns {Promise<{username: string}|null>}
 */
async function authorizeAdmin(socket) {
    const session = gameManager.getUserBySocketId(socket.id);
    if (!session) return null; // authz:signed-in
    const users = database.getUsersCollection();
    if (!users) return null;
    const user = await users.findOne({ username: session.username }, { projection: AUTHZ_PROJECTION });
    if (!user) return null; // authz:exists
    if (user.mergedInto) return null; // authz:tombstone
    if (user.isAdmin !== true) return null; // authz:flag
    if (user.socketId !== socket.id) return null; // authz:current-socket
    // (a socket with no session hash never passes: hasLiveSession(user, undefined) is false)
    if (!hasLiveSession(user, socket.data?.sessionHash)) return null; // authz:live-session
    return { username: user.username };
}

function isOnline(username) {
    return (gameManager.currentUsers || []).some(u => u.username === username);
}

const iso = (d) => new Date(d).toISOString();

/**
 * Panel merges, deletes and renames run one after another, with the
 * players' own Delete account (server/admin/mergeQueue.js), so two of them
 * can never interleave on the same names. A request waits its turn, then
 * is authorized AGAIN (queued): an admin whose flag was removed, or who was
 * signed out everywhere, while their request waited behind a slow merge
 * gets the uniform refusal and nothing runs.
 */
function queued(ctx, fn) {
    return serializeMerges(async () => {
        const now = ctx.socket ? await authorizeAdmin(ctx.socket) : ctx.actor;
        if (!now || now.username !== ctx.actor.username) throw new AdminError('forbidden', FORBIDDEN_MESSAGE);
        return fn();
    });
}

/**
 * applyMerge under the merge queue. Order: re-plan (stale_plan when it
 * differs from the preview) → refuse a source that is playing right now
 * (from memory: a game in its draw has no activeGameId yet) → lock the
 * sources' names and sign out their live sockets, in the same synchronous
 * step, so no game, lobby, tournament, sign-in or restore can start
 * for them until the merge is done → apply → unlock. A source whose retire
 * the database still refuses (accountMerge: in a game or merged elsewhere
 * meanwhile, e.g. by the CLI) is reported as a partial merge.
 */
async function applyMergeNow({ db, io, actor }, { target, sources, planHash: previewed }) {
    // Plan again right before writing: apply only what was previewed
    const plan = await planMerge(db, { target, sources });
    if (plan.errors.length) throw new AdminError('refused', plan.errors.join(' '));
    if (planHash(plan) !== previewed) {
        throw new AdminError('stale_plan', 'These accounts changed since the preview. Preview again before merging.');
    }
    // In-process caches see the merge at once (the CLI waits for the TTL)
    const invalidateCaches = () => {
        const profile = require('./profileHandlers');
        profile.invalidateLeaderboard?.();
        profile.invalidateRecords?.();
        const avatarStore = require('../avatar/avatarStore');
        for (const name of [target, ...plan.sources]) avatarStore.forgetUser?.(name);
    };
    if (countChanges(plan) === 0) {
        // Already complete (possibly by an earlier apply that stopped
        // after retiring): a source still connected is signed out now
        for (const name of plan.sources) signOutUser(io, name);
        throw new AdminError('refused', 'Nothing to do. This merge is already complete.');
    }
    // Playing right now, from memory (the plan saw only the database's
    // activeGameId / activeTournamentId, written after the draw): refused,
    // nothing written. From here to the lock below is synchronous
    for (const name of plan.sources) {
        const live = gameManager.findLiveActivity(name);
        if (live) {
            throw new AdminError('refused', `Source "${name}" is in ${live.kind === 'game' ? 'a game' : 'a tournament'} right now. Wait until it finishes and merge again.`);
        }
    }
    // Lock the names (no new sign-in, restore, rejoin, lobby or
    // tournament: GameManager.mergeLocks) and sign out every live socket
    // of a source now, before the first write
    gameManager.lockForMerge(plan.sources);
    let signedOut = 0;
    let result;
    try {
        for (const name of plan.sources) signedOut += signOutUser(io, name);
        result = await applyMerge(db, plan);
    } catch (error) {
        // Stopped partway: what ran before the throw is saved (renames,
        // stats, maybe tombstones). Never say "nothing changed": sign
        // out whatever is retired by now, refresh the caches, and send
        // the admin back to the preview (a retry plans what is left)
        logger.error('Merge stopped partway', { actor: actor.username, target, error: error.message });
        let retiredNow = [];
        try {
            retiredNow = (await db.users.find(
                { username: { $in: plan.sources }, mergedInto: target },
                { projection: { username: 1 } }
            ).toArray()).map(u => u.username);
        } catch { /* the database is struggling: sign out every source */
            retiredNow = [...plan.sources];
        }
        for (const name of retiredNow) signOutUser(io, name);
        invalidateCaches();
        const done = retiredNow.length ? `${retiredNow.join(', ')} retired and signed out` : 'no account retired yet';
        throw new AdminError('server', `The merge stopped partway and may be partly applied (${done}). Preview again to see what is left, then merge again.`);
    } finally {
        gameManager.unlockMerge(plan.sources);
    }
    // Backstop: nothing of a retired name should be connected by now
    for (const name of result.retired) signedOut += signOutUser(io, name);
    invalidateCaches();
    if (result.notRetired.length) {
        // The database refused to retire a source (in a game or a
        // tournament, or merged into another account, since the plan: the
        // CLI in another process can do that). Everything else ran
        logger.warn('Merge partly applied: a source was not retired', { actor: actor.username, target, notRetired: result.notRetired });
        const retired = result.retired.length ? `; retired: ${result.retired.join(', ')}` : '';
        throw new AdminError('server', `The merge is only partly applied: ${result.notRetired.map(n => `"${n}"`).join(', ')} could not be retired (in a game, or merged into another account, since the preview)${retired}. Preview again to see what is left, then merge again.`);
    }
    return {
        reply: {
            result: {
                target,
                statsMerged: result.statsMerged,
                retired: result.retired,
                gameRecords: result.gameRecords,
                reports: result.reports,
                otherUsersBlocks: result.otherUsersBlocks,
                chainedTombstones: result.chainedTombstones,
                profilePic: result.profilePic,
                signedOut
            }
        },
        target,
        detail: `merged ${sources.join(', ')}: retired ${result.retired.join(', ') || 'none'}; ${result.gameRecords} game record(s), ${result.reports} report(s); ${signedOut} signed out`
    };
}

/**
 * Delete an account from the panel, under the merge queue. The same
 * deletion as the player's own (server/admin/accountDelete.js eraseAccount
 * + forgetAccount); refused for an admin (remove the flag first), for the
 * acting admin (their profile's Delete account, with its password check),
 * and for a player in a game, a tournament or a draw (from memory first,
 * then the database's pointers in the guarded write). Order: refuse →
 * lock the name and sign out its live sockets in one synchronous step
 * (GameManager.mergeLocks: no sign-in, restore, rejoin, lobby or
 * tournament can start) → one guarded write that revokes every session
 * and refuses if the account became an admin, entered a game or was
 * merged meanwhile → erase → unlock → forget in memory.
 *
 * A tombstone (merged account or rename redirect) is only removed: that
 * frees its name and touches nothing on the account it points at.
 */
async function deleteAccountNow({ db, io, actor }, { username }) {
    const found = await db.users.findOne(
        { username },
        { projection: { username: 1, mergedInto: 1, isAdmin: 1, activeGameId: 1, activeTournamentId: 1, socketId: 1, renamePending: 1 } }
    );
    if (!found) throw new AdminError('not_found', `No account is named "${username}" (names are case-sensitive).`);
    const counts = { gameRecords: 0, reports: 0, blockLists: 0, resetLinks: 0, tombstones: 0, signedOut: 0 };
    if (!found.mergedInto && found.renamePending?.from) {
        throw new AdminError('refused', `"${username}" has an unfinished rename from "${found.renamePending.from}". Finish it first (Finish rename on its row), then delete the account.`);
    }
    if (found.mergedInto) {
        // The redirect of a rename that has not finished: its old name still
        // keys games, reports and block lists; freeing it would hand them to
        // whoever signs up next
        if (await unfinishedRenameOf(db, username)) {
            throw new AdminError('refused', `The rename of "${username}" to "${found.mergedInto}" has not finished. Finish it first (Finish rename on ${found.mergedInto}'s row), then delete the old name.`);
        }
        const gone = await deleteTombstone(db, username);
        if (!gone) throw new AdminError('refused', `"${username}" changed while this ran. Try again.`);
        require('../avatar/avatarStore').forgetUser?.(username);
        return {
            reply: { username, kind: 'tombstone', mergedInto: gone.mergedInto, ...counts },
            target: username,
            detail: `tombstone deleted (it pointed at ${gone.mergedInto}); the name is free; ${gone.mergedInto} not changed`
        };
    }
    if (username === actor.username) {
        throw new AdminError('refused', 'You cannot delete your own account here. Use Delete account on your profile (it asks for your password).');
    }
    if (found.isAdmin === true) {
        throw new AdminError('refused', `"${username}" is an admin. Remove their admin first, then delete the account.`);
    }
    if (found.activeGameId || found.activeTournamentId) {
        throw new AdminError('refused', `"${username}" is in ${found.activeGameId ? 'a game' : 'a tournament'} right now. Wait until it finishes and delete again.`);
    }
    // Playing right now, from memory (a game in its draw has no
    // activeGameId yet). From here to the lock is synchronous
    const live = gameManager.findLiveActivity(username);
    if (live) {
        throw new AdminError('refused', `"${username}" is in ${live.kind === 'game' ? 'a game' : 'a tournament'} right now. Wait until it finishes and delete again.`);
    }
    gameManager.lockForMerge([username]);
    let erased;
    try {
        counts.signedOut += signOutUser(io, username, { socketId: found.socketId });
        // The lock-down write: every saved session revoked (sessionEpoch
        // bumped, so a restore in flight cannot write them back), only
        // while the account is still a plain one that is not playing
        const locked = await db.users.findOneAndUpdate(
            {
                _id: found._id,
                username,
                mergedInto: { $exists: false },
                isAdmin: { $ne: true },
                activeGameId: { $exists: false },
                activeTournamentId: { $exists: false }
            },
            { $unset: { ...REVOKE_ALL_SESSIONS.$unset, socketId: '' }, $inc: { ...REVOKE_ALL_SESSIONS.$inc } },
            { returnDocument: 'before', projection: { socketId: 1 } }
        );
        if (!locked) {
            throw new AdminError('refused', `"${username}" changed while this ran (made an admin, in a game, or merged). Nothing was deleted.`);
        }
        if (locked.socketId) counts.signedOut += signOutUser(io, username, { socketId: locked.socketId });
        erased = await eraseAccount(db, found);
    } catch (error) {
        if (error instanceof AdminError) throw error;
        // Stopped partway: say what is true now. The user document goes
        // last, so while it is still there, deleting again finishes
        logger.error('Delete stopped partway', { actor: actor.username, target: username, error: error.message });
        let still = true;
        try {
            still = Boolean(await db.users.findOne({ username, mergedInto: { $exists: false } }, { projection: { _id: 1 } }));
        } catch { /* unknown: assume it is still there */ }
        throw new AdminError('server', still
            ? `The delete stopped partway: "${username}" is signed out everywhere but not deleted yet. Delete again to finish.`
            : `"${username}" is deleted, but the clean-up stopped partway (accounts merged into it may remain). Check the table.`);
    } finally {
        gameManager.unlockMerge([username]);
    }
    // Backstop: nothing of the name should be connected by now
    counts.signedOut += signOutUser(io, username);
    await forgetAccount(io, db, username, erased);
    Object.assign(counts, {
        gameRecords: erased.gameRecords, reports: erased.reports, blockLists: erased.blockLists,
        resetLinks: erased.resetLinks, tombstones: erased.tombstones
    });
    return {
        reply: { username, kind: 'account', mergedInto: null, ...counts },
        target: username,
        detail: `account deleted: ${counts.gameRecords} game record update(s) to [deleted], ${counts.reports} report(s) marked, ${counts.blockLists} block list(s) and ${counts.resetLinks} open reset link(s) cleared, ${counts.tombstones} tombstone(s) removed; ${counts.signedOut} signed out`
    };
}

/**
 * Rename an account from the panel, under the merge queue (a rename and a
 * merge or delete of the same names never interleave). Data steps:
 * server/admin/accountRename.js. Order: validate the new name (the sign-up
 * rules, the profanity filter, taken ignoring case incl. tombstones) →
 * refuse a tombstone and a player in a game, tournament or draw (memory,
 * then the database's pointers in the guarded write) → lock BOTH names
 * and sign out the account's live sockets in one synchronous step →
 * revoke open reset links → the guarded rename (sessions revoked) and its
 * clash re-check → the redirect at the old name → the shared documents →
 * unlock → caches, avatar store, the blockers' live lists.
 *
 * Renaming again with the same names after a partial failure finishes the
 * shared documents (`resumed`): found through the redirect, or through
 * `renamePending.from` on the renamed account when the redirect was never
 * written (it is written then). Refused for the acting admin's own
 * account (every tab of it, the panel's included, would be signed out
 * before the answer).
 */
async function renameAccountNow({ db, io, actor }, { username: from, newName: to }) {
    const now = new Date();
    if (from === to) throw new AdminError('invalid', 'The new name is the same as the old one.');
    const rule = checkNewUsername(to);
    if (!rule.ok) throw new AdminError('refused', rule.message);
    if (containsProfanitySubstring(to)) throw new AdminError('refused', 'That username is not allowed.');

    if (from === actor.username) {
        // Renaming signs every tab of the account out, the panel's own
        // included, before the answer could reach it
        throw new AdminError('refused', 'You cannot rename your own account here: it would sign you out before you see the result. Ask another admin to rename it.');
    }
    const user = await db.users.findOne(
        { username: from },
        { projection: { username: 1, mergedInto: 1, renamedAt: 1, activeGameId: 1, activeTournamentId: 1, socketId: 1, renamePending: 1 } }
    );

    const counts = { gameRecords: 0, reports: 0, otherUsersBlocks: 0, chainedTombstones: 0, adminSetBy: 0, resetLinks: 0, revokedSessions: 0, signedOut: 0 };
    const invalidate = (names) => {
        const profile = require('./profileHandlers');
        profile.invalidateLeaderboard?.();
        profile.invalidateRecords?.();
        const avatarStore = require('../avatar/avatarStore');
        for (const name of names) avatarStore.forgetUser?.(name);
    };

    // A rename that stopped partway (renamePending on the renamed account
    // names the old name): finish it, whether or not its redirect was
    // written. The old name may be a redirect to `to`, or free (the redirect
    // write itself failed, or the process stopped before it)
    const pending = await db.users.findOne({ username: to, mergedInto: { $exists: false }, 'renamePending.from': from }, { projection: { _id: 1 } });
    const oldNameFree = !user || (isRenameRedirect(user) && user.mergedInto === to);
    if (pending && !oldNameFree) {
        // A new account took the old name meanwhile (the CLI, another
        // process): its records cannot be told apart from the renamed
        // account's, so nothing is moved
        throw new AdminError('refused', `"${from}" was taken by a new account before the rename to "${to}" finished, so the games and reports under "${from}" cannot be moved. Nothing was changed.`);
    }
    const pendingTarget = pending;
    const redirectTarget = !pendingTarget && isRenameRedirect(user) && user.mergedInto === to
        ? await db.users.findOne({ username: to, mergedInto: { $exists: false } }, { projection: { _id: 1 } })
        : null;
    const target = pendingTarget || redirectTarget;
    if (target) {
        const locked = [from, to];
        gameManager.lockForMerge(locked);
        let moved;
        let oldNameKept = true;
        try {
            if (!user) oldNameKept = await leaveRedirect(db, from, to, { now, by: actor.username });
            if (!oldNameKept) {
                throw new AdminError('refused', `"${from}" was taken by a new account before the rename to "${to}" finished, so the games and reports under "${from}" cannot be moved. Nothing was changed.`);
            }
            moved = await renameEverywhere(db, from, to, { selfId: target._id });
            await finishRename(db, target._id, from);
        } catch (error) {
            if (error instanceof AdminError) throw error;
            logger.error('Rename resume stopped partway', { actor: actor.username, target: from, error: error.message });
            throw new AdminError('server', `"${from}" is called "${to}", but finishing the rename stopped partway again. Rename ${from} to ${to} again to finish.`);
        } finally {
            gameManager.unlockMerge(locked);
            invalidate([from, to]);
        }
        await refreshBlockLists(io, db, moved.blockers, { silent: true });
        Object.assign(counts, pick(moved));
        return {
            reply: { username: from, newName: to, resumed: true, oldNameKept, ...counts },
            target: from,
            detail: `renamed ${from} -> ${to} (finished): ${describeMoved(counts)}`
        };
    }
    if (!user) throw new AdminError('not_found', `No account is named "${from}" (names are case-sensitive).`);
    if (user.mergedInto) {
        throw new AdminError('refused', isRenameRedirect(user)
            ? `"${from}" is an old name: the account is now called "${user.mergedInto}". Rename "${user.mergedInto}" instead.`
            : `"${from}" was merged into "${user.mergedInto}" and can't be renamed. Rename "${user.mergedInto}" instead.`);
    }
    if (user.renamePending?.from) {
        throw new AdminError('refused', `"${from}" has an unfinished rename from "${user.renamePending.from}". Finish that first (Finish rename on its row).`);
    }

    const clash = await findNameClash(db.users, to);
    if (clash && String(clash._id) !== String(user._id)) {
        throw new AdminError('refused', clash.mergedInto
            ? `That name is taken by "${clash.username}", an old name of "${clash.mergedInto}". Delete that old name first if it should be free.`
            : takenMessage(to, clash));
    }
    if (user.activeGameId || user.activeTournamentId) {
        throw new AdminError('refused', `"${from}" is in ${user.activeGameId ? 'a game' : 'a tournament'} right now. Wait until it finishes and rename again.`);
    }
    // From memory (a game in its draw has no activeGameId yet); from here
    // to the lock is synchronous
    const live = gameManager.findLiveActivity(from);
    if (live) {
        throw new AdminError('refused', `"${from}" is in ${live.kind === 'game' ? 'a game' : 'a tournament'} right now. Wait until it finishes and rename again.`);
    }
    // Both names: nothing signs in, restores, rejoins or starts a game as
    // the old one, and nobody signs up as the new one, until it is done
    const locked = [from, to];
    gameManager.lockForMerge(locked);
    let renamed;
    let oldNameKept = false;
    try {
        counts.signedOut += signOutUser(io, from, { socketId: user.socketId });
        counts.resetLinks = await revokeOpenResetLinks(db, user, { now });
        renamed = await renameUserDoc(db, user, to, { now });
        if (!renamed.ok) {
            throw new AdminError('refused', renamed.reason === 'taken'
                ? `"${to}" was taken while this ran. Nothing was renamed; ${from} was signed out.`
                : `"${from}" changed while this ran (in a game, or merged). Nothing was renamed; ${from} was signed out.`);
        }
        counts.revokedSessions = renamed.revokedSessions;
        if (renamed.socketId) counts.signedOut += signOutUser(io, from, { socketId: renamed.socketId });
        oldNameKept = await leaveRedirect(db, from, to, { now, by: actor.username });
        const moved = await renameEverywhere(db, from, to, { selfId: user._id });
        await finishRename(db, user._id, from);
        Object.assign(counts, pick(moved));
        counts.blockers = moved.blockers;
    } catch (error) {
        if (error instanceof AdminError) throw error;
        logger.error('Rename stopped partway', { actor: actor.username, target: from, error: error.message });
        invalidate([from, to]);
        throw new AdminError('server', renamed?.ok
            ? `"${from}" is now called "${to}" (signed out everywhere), but updating its games, reports and block lists stopped partway. Rename ${from} to ${to} again to finish.`
            : `The rename stopped partway: "${from}" was signed out but not renamed. Try again.`);
    } finally {
        gameManager.unlockMerge(locked);
    }
    counts.signedOut += signOutUser(io, from); // backstop
    // The name now belongs to a live account: stop anonymizing it (a
    // deleted name re-used, as at sign-up)
    gameManager.deletedUsernames?.delete(to);
    invalidate([from, to]);
    const blockers = counts.blockers || [];
    delete counts.blockers;
    await refreshBlockLists(io, db, blockers, { silent: true });
    if (!oldNameKept) {
        logger.warn('Rename: the old name was taken before its redirect was written', { actor: actor.username, from, to });
    }
    return {
        reply: { username: from, newName: to, resumed: false, oldNameKept, ...counts },
        target: from,
        detail: `renamed ${from} -> ${to}: ${describeMoved(counts)}; ${counts.revokedSessions} saved session(s) revoked, ${counts.signedOut} signed out${counts.resetLinks ? `, ${counts.resetLinks} open reset link(s) cancelled` : ''}${oldNameKept ? '' : `; the old name was taken meanwhile (no redirect)`}`
    };
}

const pick = (m) => ({
    gameRecords: m.gameRecords, reports: m.reports, otherUsersBlocks: m.otherUsersBlocks,
    chainedTombstones: m.chainedTombstones, adminSetBy: m.adminSetBy
});
const describeMoved = (c) => `${c.gameRecords} game record update(s), ${c.reports} report field(s), ${c.otherUsersBlocks} block list(s), ${c.chainedTombstones} old name(s) re-pointed`;

/**
 * Each action: run(ctx, args) → {reply, target, detail}. `reply` is spread
 * into the ok response; target/detail go to the audit entry (names and
 * counts only).
 */
const RUN = {
    async searchPlayers({ db }, { query }) {
        const players = await searchPlayers(db, query, { isOnline });
        return { reply: { players }, target: null, detail: `query "${query.trim().slice(0, 50)}": ${players.length} found` };
    },

    async createResetLink({ db, actor }, { username }) {
        if (!db.passwordResets) throw new AdminError('refused', 'The database is not ready. Try again.');
        const { token, expiresAt, revoked } = await createResetLink(db, username, { by: actor.username });
        return {
            reply: { username, token, expiresAt: iso(expiresAt) },
            target: username,
            detail: `link valid until ${iso(expiresAt)}${revoked ? `; ${revoked} older link(s) revoked` : ''}`
        };
    },

    async signOutEverywhere({ db, io }, { username }) {
        const found = await db.users.findOne({ username }, { projection: { username: 1, mergedInto: 1 } });
        if (!found) throw new AdminError('not_found', `No account is named "${username}" (names are case-sensitive).`);
        if (found.mergedInto) throw new AdminError('refused', `"${username}" was merged into "${found.mergedInto}" and has no sessions.`);
        // A reset link that leaked must not outlive the lock-down: cancel
        // the open ones first (if this fails, nothing else was changed)
        const revokedLinks = await revokeOpenResetLinks(db, found);
        // One atomic revoke (sessionEpoch bumped: a restore or sign-in in
        // flight cannot write the sessions back); the document as it was
        // gives the count and the newest socketId to sign out
        const user = await db.users.findOneAndUpdate(
            { _id: found._id, mergedInto: { $exists: false } },
            REVOKE_ALL_SESSIONS,
            { returnDocument: 'before', projection: { socketId: 1, 'sessionTokens.hash': 1, sessionToken: 1 } }
        );
        if (!user) throw new AdminError('refused', `"${username}" changed while this ran. Try again.`);
        const revokedSessions = (user.sessionTokens?.length || 0) + (user.sessionToken ? 1 : 0);
        const disconnected = signOutUser(io, username, { socketId: user.socketId });
        return {
            reply: { username, revokedSessions, disconnected },
            target: username,
            detail: `${revokedSessions} saved session(s) revoked, ${disconnected} live connection(s) signed out${revokedLinks ? `; ${revokedLinks} open reset link(s) cancelled` : ''}`
        };
    },

    async findDuplicates({ db }) {
        const groups = (await findDuplicateCandidates(db)).map(g => g.map(u => ({
            username: u.username, gamesPlayed: u.gamesPlayed, createdAt: u.createdAt ? iso(u.createdAt) : null
        })));
        return { reply: { groups }, target: null, detail: `${groups.length} group(s)` };
    },

    async planMerge({ db }, { target, sources }) {
        const plan = await planMerge(db, { target, sources });
        const view = planView(plan);
        return {
            reply: { plan: view, planHash: planHash(plan) },
            target,
            detail: plan.errors.length ? `preview of ${sources.join(', ')}: ${plan.errors.length} error(s)` : `preview of ${sources.join(', ')}: ${view.changeCount} change(s)`
        };
    },

    async applyMerge(ctx, args) {
        if (args.confirm !== args.target) {
            throw new AdminError('invalid', `Type the kept account's name, ${args.target}, exactly to confirm.`);
        }
        // One panel merge at a time (the server is one process): a second
        // merge of the same source re-plans after the first is done, sees it
        // retired, and is refused instead of adding its stats twice
        return queued(ctx, () => applyMergeNow(ctx, args));
    },

    async listReports({ db }, { status }) {
        const reports = await listReports(db, { status });
        return { reply: { reports }, target: null, detail: `${status}: ${reports.length}` };
    },

    async resolveReport({ db, actor }, { id, status, note }) {
        const report = await resolveReport(db, id, { status, note, by: actor.username });
        return { reply: { report }, target: report.reported || id, detail: `report ${id} ${status}` };
    },

    async listAdmins({ db }) {
        const admins = (await listAdmins(db)).map(a => ({ username: a.username, adminSince: a.adminSince ? iso(a.adminSince) : null }));
        return { reply: { admins }, target: null, detail: `${admins.length} admin(s)` };
    },

    async setAdmin({ db, actor }, { username, isAdmin }) {
        const res = await setAdminFlag(db, username, isAdmin, { by: actor.username });
        return {
            reply: { username, isAdmin: res.isAdmin, changed: res.changed },
            target: username,
            detail: res.changed ? (isAdmin ? 'made admin' : 'admin removed') : (isAdmin ? 'already an admin' : 'was not an admin')
        };
    },

    async listAudit({ db }, { before, beforeId, limit }) {
        const page = await listAudit(db, { before: before || null, beforeId: beforeId || null, limit });
        return { reply: page, target: null, detail: null };
    },

    async deleteAccount(ctx, args) {
        if (args.confirm !== args.username) {
            throw new AdminError('invalid', `Type the account's name, ${args.username}, exactly to confirm.`);
        }
        return queued(ctx, () => deleteAccountNow(ctx, args));
    },

    async renameAccount(ctx, args) {
        const { newName } = args; // as typed: checkNewUsername refuses spaces at the ends
        if (args.confirm !== newName || !newName) {
            throw new AdminError('invalid', `Type the new name${newName ? `, ${newName},` : ''} exactly to confirm.`);
        }
        return queued(ctx, () => renameAccountNow(ctx, { username: args.username, newName }));
    },

    async listPlayers({ db }) {
        const { players, total, limit } = await listPlayers(db, { isOnline });
        return {
            reply: { players, total, limit },
            target: null,
            detail: `${players.length} of ${total} account(s)`
        };
    }
};

/**
 * Coalesce refusals: key = name (or '(signed out)') + action. The first
 * refusal in a window is audited and logged; the rest only counted, and the
 * count rides on the next window's first entry. Keyed by name, not socket,
 * so opening new sockets does not open new windows. Bounded: expired keys
 * are pruned once the map grows past FORBIDDEN_MAX_KEYS (and if every key is
 * live, it is cleared, which only means a few more entries).
 */
const FORBIDDEN_WINDOW_MS = 10 * 60 * 1000;
const FORBIDDEN_MAX_KEYS = 5000;
const forbiddenSeen = new Map();

function forbiddenGate(who, action, now = Date.now()) {
    const key = `${who === null ? '(signed out)' : `u:${who}`}|${action}`;
    const seen = forbiddenSeen.get(key);
    if (seen && now - seen.since < FORBIDDEN_WINDOW_MS) {
        seen.held++;
        return null;
    }
    if (forbiddenSeen.size >= FORBIDDEN_MAX_KEYS) {
        for (const [k, v] of forbiddenSeen) if (now - v.since >= FORBIDDEN_WINDOW_MS) forbiddenSeen.delete(k);
        if (forbiddenSeen.size >= FORBIDDEN_MAX_KEYS) forbiddenSeen.clear();
    }
    const held = seen ? seen.held : 0;
    forbiddenSeen.set(key, { since: now, held: 0 });
    return { held };
}

/** One refusal message for a failed write the admin may retry. */
const SERVER_MESSAGE = 'Something went wrong. Nothing more was changed; try again.';

async function adminRequest(socket, io, data) {
    const { requestId, action } = data;
    const reply = (payload) => socket.emit('adminResponse', { requestId, action, ...payload });
    const db = adminDb();

    const actor = await authorizeAdmin(socket);
    if (!actor) {
        const who = gameManager.getUserBySocketId(socket.id)?.username || null;
        reply({ ok: false, error: 'forbidden', message: FORBIDDEN_MESSAGE });
        const gate = forbiddenGate(who, action);
        if (!gate) return; // already audited in this window: counted only
        logger.warn('Admin request refused', { action, username: who, socketId: socket.id, ...(gate.held ? { heldBack: gate.held } : {}) });
        if (who) {
            const detail = gate.held ? `not an admin (${gate.held} more refused in the window before)` : 'not an admin';
            await recordAudit(db, { actor: who, action, target: null, result: 'forbidden', detail });
        }
        return;
    }

    const audit = (result, target, detail) => (NOT_AUDITED.has(action)
        ? Promise.resolve()
        : recordAudit(db, { actor: actor.username, action, target, result, detail }));

    const { error, value } = ACTION_SCHEMAS[action].validate(data.args || {}, { stripUnknown: true });
    if (error) {
        reply({ ok: false, error: 'invalid', message: `Invalid request: ${error.message}` });
        await audit('failed', null, 'invalid request');
        return;
    }

    try {
        const out = await RUN[action]({ db, io, actor, socket }, value);
        reply({ ok: true, ...out.reply });
        await audit('ok', out.target ?? null, out.detail ?? null);
        logger.info('Admin action', { actor: actor.username, action, target: out.target ?? null });
    } catch (e) {
        const target = value.username || value.target || value.id || null; // renameAccount: the old name
        if (e instanceof AdminError) {
            reply({ ok: false, error: e.code, message: e.message });
            await audit('failed', target, e.message);
            return;
        }
        logger.error('Admin action failed', { actor: actor.username, action, error: e.message });
        reply({ ok: false, error: 'server', message: SERVER_MESSAGE });
        await audit('failed', target, 'server error');
    }
}

module.exports = {
    adminRequest, authorizeAdmin, ACTIONS, ACTION_SCHEMAS, FORBIDDEN_MESSAGE, FORBIDDEN_WINDOW_MS,
    _resetForbiddenGate: () => forbiddenSeen.clear()
};
