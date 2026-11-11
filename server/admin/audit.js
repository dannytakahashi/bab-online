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

const { createModuleLogger } = require('../utils/logger');

const logger = createModuleLogger('admin');

const MAX_DETAIL = 300;
const LIST_MAX = 100;
// Anything long and token-like (base64url / hex runs of 32+ characters)
const TOKENISH = /[A-Za-z0-9_-]{32,}/g;

function redactDetail(detail) {
    if (detail === null || detail === undefined) return null;
    return String(detail).replace(TOKENISH, '[redacted]').slice(0, MAX_DETAIL);
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
 * Newest first, LIST_MAX at most; `before` (a Date) pages back.
 * @returns {Promise<{entries: Object[], hasMore: boolean}>}
 */
async function listAudit(db, { before = null, limit = 50 } = {}) {
    const n = Math.max(1, Math.min(LIST_MAX, limit));
    const filter = before ? { at: { $lt: before } } : {};
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
