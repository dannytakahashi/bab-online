/**
 * Player reports (`reports`, filed by safetyHandlers.reportUser) as the
 * admin panel reviews them. A report without `status` is open; an admin
 * closes it as resolved or dismissed with a note:
 *   { status, resolvedBy, resolvedAt, resolutionNote }
 */

'use strict';

const { ObjectId } = require('mongodb');
const { AdminError } = require('./adminError');

const LIST_MAX = 100;

function iso(d) {
    return d ? new Date(d).toISOString() : null;
}

function reportRow(r) {
    return {
        id: String(r._id),
        reporter: String(r.reporter ?? ''),
        reported: String(r.reported ?? ''),
        reason: String(r.reason ?? ''),
        context: String(r.context ?? ''),
        createdAt: iso(r.createdAt),
        status: r.status === 'resolved' || r.status === 'dismissed' ? r.status : 'open',
        resolvedBy: r.resolvedBy || null,
        resolvedAt: iso(r.resolvedAt),
        note: r.resolutionNote === undefined || r.resolutionNote === null ? null : String(r.resolutionNote)
    };
}

/** Newest first; status 'open' (default) or 'all'. */
async function listReports(db, { status = 'open' } = {}) {
    const filter = status === 'open' ? { status: { $exists: false } } : {};
    const rows = await db.reports.find(filter).sort({ createdAt: -1 }).limit(LIST_MAX).toArray();
    return rows.map(reportRow);
}

function parseId(id) {
    try {
        if (!/^[0-9a-f]{24}$/i.test(String(id))) throw new Error('bad id');
        return new ObjectId(String(id));
    } catch {
        throw new AdminError('not_found', 'That report does not exist.');
    }
}

/**
 * Close an open report. Refuses one already closed (two admins at once:
 * the first wins, the second is told).
 */
async function resolveReport(db, id, { status, note = '', by, now = new Date() }) {
    const _id = parseId(id);
    const res = await db.reports.updateOne(
        { _id, status: { $exists: false } },
        { $set: { status, resolvedBy: by, resolvedAt: now, resolutionNote: note } }
    );
    const doc = await db.reports.findOne({ _id });
    if (!doc) throw new AdminError('not_found', 'That report does not exist.');
    if (!res.modifiedCount) {
        throw new AdminError('refused', `That report was already ${doc.status} by ${doc.resolvedBy || 'another admin'}.`);
    }
    return reportRow(doc);
}

module.exports = { listReports, resolveReport, reportRow, LIST_MAX };
