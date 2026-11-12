/**
 * The admin audit log: one `adminAudit` document per admin action, shown
 * newest first in the panel's Audit tab.
 *
 *   { at, actor, action, target, result: 'ok'|'failed'|'forbidden', detail }
 *
 * actor: the admin's username (for 'forbidden', the signed-in player who
 * tried). target: the account (or report id) acted on, or null. detail: one
 * short human-readable line (counts, the reason a request failed).
 *
 * NEVER put a reset token, a password, a session token or a hash in here:
 * callers build `detail` from counts and names only (adminHandlers.js), and
 * redactDetail drops anything that looks like a token as a last guard.
 *
 * Writing never throws: a failed audit write is logged and the action's
 * reply still goes out (the action already happened).
 */

'use strict';

const { ObjectId } = require('mongodb');
const { createModuleLogger } = require('../utils/logger');

const logger = createModuleLogger('admin');

const MAX_DETAIL = 300;
const LIST_MAX = 100;
// The secrets this server handles, by shape, so a long USERNAME (up to 50
// characters; sign-up once allowed them) is never mistaken for one:
//   a reset token (32 random bytes as base64url: exactly 43 characters),
//   a session token (a UUID), a bcrypt hash, and any token-like run longer
//   than a username can be (51+: SHA-256 hex hashes and the like).
const T = 'A-Za-z0-9_-';
// (bcrypt first: its '.' and '/' split it into runs the others could half-match)
const SECRET_SHAPES = [
    /\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}/g,
    /(?<![A-Za-z0-9_-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_-])/gi,
    new RegExp(`(?<![${T}])[${T}]{43}(?![${T}])`, 'g'),
    new RegExp(`[${T}]{51,}`, 'g')
];

function redactDetail(detail) {
    if (detail === null || detail === undefined) return null;
    let out = String(detail);
    for (const re of SECRET_SHAPES) out = out.replace(re, '[redacted]');
    return out.slice(0, MAX_DETAIL);
}

/**
 * @param {{adminAudit}} db
 * @param {{actor: string|null, action: string, target?: string|null, result: string, detail?: string|null, now?: Date}} entry
 */
async function recordAudit(db, { actor, action, target = null, result, detail = null, now = new Date() }) {
    try {
        if (!db.adminAudit) throw new Error('adminAudit collection not ready');
        await db.adminAudit.insertOne({
            at: now,
            actor: actor || null,
            action,
            target: target === undefined ? null : target,
            result,
            detail: redactDetail(detail)
        });
    } catch (error) {
        logger.warn('Admin audit write failed', { action, result, error: error.message });
    }
}

/**
 * Newest first ({at: -1, _id: -1}), LIST_MAX at most. Paging back: `before`
 * (a Date) and `beforeId` (the id of the last entry shown), the cursor of
 * that sort, so entries sharing the boundary's millisecond are not skipped.
 * `before` alone (an older client) still pages by time.
 * @returns {Promise<{entries: Object[], hasMore: boolean}>}
 */
async function listAudit(db, { before = null, beforeId = null, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(LIST_MAX, limit));
    let filter = {};
    if (before && beforeId && ObjectId.isValid(beforeId)) {
        filter = { $or: [{ at: { $lt: before } }, { at: before, _id: { $lt: new ObjectId(beforeId) } }] };
    } else if (before) {
        filter = { at: { $lt: before } };
    }
    const rows = await db.adminAudit.find(filter).sort({ at: -1, _id: -1 }).limit(n + 1).toArray();
    return {
        entries: rows.slice(0, n).map(r => ({
            id: String(r._id),
            at: new Date(r.at).toISOString(),
            actor: r.actor || null,
            action: String(r.action),
            target: r.target === null || r.target === undefined ? null : String(r.target),
            result: ['ok', 'failed', 'forbidden'].includes(r.result) ? r.result : 'failed',
            detail: r.detail === null || r.detail === undefined ? null : String(r.detail)
        })),
        hasMore: rows.length > n
    };
}

module.exports = { recordAudit, listAudit, redactDetail, LIST_MAX };
