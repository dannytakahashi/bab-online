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
const { recordAudit, listAudit } = require('../admin/audit');
const { listReports, resolveReport } = require('../admin/reports');
const { searchPlayers } = require('../admin/players');
const { planMerge, applyMerge, countChanges, findDuplicateCandidates } = require('../admin/accountMerge');
const { planView, planHash } = require('../admin/mergeView');
const { signOutUser } = require('./authHandlers');

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
    })
};

const ACTIONS = Object.keys(ACTION_SCHEMAS);
if (ACTIONS.join() !== require('../admin/actions').ADMIN_ACTIONS.join()) {
    throw new Error('adminHandlers: ACTION_SCHEMAS must list server/admin/actions.js ADMIN_ACTIONS in order');
}
const NOT_AUDITED = new Set(['listAudit']);

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
            detail: `${revokedSessions} saved session(s) revoked, ${disconnected} live connection(s) signed out`
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

    async applyMerge({ db, io, actor }, { target, sources, planHash: previewed, confirm }) {
        if (confirm !== target) {
            throw new AdminError('invalid', `Type the kept account's name, ${target}, exactly to confirm.`);
        }
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
        let result;
        try {
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
        }
        // Retired names cannot keep playing on a connection signed in
        // before the merge (their stats would land on a tombstone)
        let signedOut = 0;
        for (const name of result.retired) signedOut += signOutUser(io, name);
        invalidateCaches();
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
        const out = await RUN[action]({ db, io, actor }, value);
        reply({ ok: true, ...out.reply });
        await audit('ok', out.target ?? null, out.detail ?? null);
        logger.info('Admin action', { actor: actor.username, action, target: out.target ?? null });
    } catch (e) {
        const target = value.username || value.target || value.id || null;
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
