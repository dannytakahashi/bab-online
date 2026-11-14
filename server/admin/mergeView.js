/**
 * The merge plan (accountMerge.planMerge) for the admin panel: the same
 * content formatPlan prints for the CLI, as data the panel renders
 * (planView), and a fingerprint of the WHOLE plan (planHash).
 *
 * Preview == apply: the panel previews a plan and gets its hash; to apply,
 * it sends the hash back with the typed confirmation, the server plans
 * again and applies only when the fresh plan has the same hash (anything
 * that changed in between — a new game record, a report, a block, a stat —
 * changes the hash, and the admin is asked to preview again). The view
 * leaves the stored picture's bytes out; the hash covers them.
 */

'use strict';

const crypto = require('crypto');
const { STAT_KEYS, countChanges } = require('./accountMerge');

const SUMMARY_KEYS = ['gamesPlayed', 'wins', 'losses', 'draws', 'totalPoints'];

function iso(d) {
    if (!d) return null;
    const t = new Date(d);
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function summary(stats) {
    const out = {};
    for (const k of SUMMARY_KEYS) out[k] = Number(stats?.[k]) || 0;
    return out;
}

const NOTES = {
    'add-stats': 'stats will be added',
    'already-merged': 'already merged, skipped',
    'no-stats': 'no stats to add'
};

const byId = (a, b) => String(a.id).localeCompare(String(b.id));

/** A stable, JSON-safe form of everything in the plan (for the hash). */
function canonical(plan) {
    return JSON.stringify({
        target: plan.target,
        sources: [...plan.sources].sort(),
        errors: plan.errors,
        warnings: [...plan.warnings].sort(),
        targetId: plan.targetId ? String(plan.targetId) : null,
        statsBefore: plan.statsBefore,
        statsAfter: plan.statsAfter,
        // the bot-game bucket: a change only there must change the hash too
        botStatsBefore: plan.botStatsBefore ?? null,
        botStatsAfter: plan.botStatsAfter ?? null,
        sourceAccounts: [...plan.sourceAccounts].sort(byId).map(s => ({ ...s, id: String(s.id), createdAt: iso(s.createdAt) })),
        profilePic: plan.profilePic,
        targetBlockedUsers: plan.targetBlockedUsers,
        gameRecords: [...plan.gameRecords].sort(byId).map(r => ({ ...r, id: String(r.id), completedAt: iso(r.completedAt) })),
        reports: [...plan.reports].sort(byId).map(r => ({ ...r, id: String(r.id) })),
        otherUsersBlocks: [...plan.otherUsersBlocks].sort(byId).map(u => ({ ...u, id: String(u.id) })),
        chainedTombstones: [...plan.chainedTombstones].sort(byId).map(t => ({ ...t, id: String(t.id) })),
        retire: [...plan.retire].sort(byId).map(r => ({ ...r, id: String(r.id) }))
    });
}

function planHash(plan) {
    return crypto.createHash('sha256').update(canonical(plan)).digest('hex');
}

/** What formatPlan prints, as data. */
function planView(plan) {
    const view = {
        target: plan.target,
        sources: [...plan.sources],
        errors: [...plan.errors],
        warnings: [...plan.warnings],
        accounts: [],
        statChanges: [],
        botStatChanges: [],
        profilePicFrom: null,
        targetBlockedUsers: null,
        gameRecords: [],
        reports: [],
        otherUsersBlocks: [],
        chainedTombstones: [],
        retire: [],
        changeCount: 0
    };
    if (plan.errors.length) return view;

    const targetCreated = typeof plan.targetId?.getTimestamp === 'function' ? iso(plan.targetId.getTimestamp()) : null;
    // stats = human games (as before), botStats = bot games (statsScope.js)
    view.accounts.push({ role: 'target', username: plan.target, createdAt: targetCreated, stats: summary(plan.statsBefore), botStats: summary(plan.botStatsBefore), note: null });
    for (const s of plan.sourceAccounts) {
        view.accounts.push({ role: 'source', username: s.username, createdAt: iso(s.createdAt), stats: summary(s.stats), botStats: summary(s.botStats), note: NOTES[s.action] || null });
    }
    view.accounts.push({ role: 'result', username: plan.target, createdAt: null, stats: summary(plan.statsAfter), botStats: summary(plan.botStatsAfter), note: null });
    view.statChanges = STAT_KEYS
        .filter(k => plan.statsAfter[k] !== plan.statsBefore[k])
        .map(k => ({ key: k, before: plan.statsBefore[k], after: plan.statsAfter[k] }));
    const botBefore = plan.botStatsBefore || {};
    const botAfter = plan.botStatsAfter || botBefore;
    view.botStatChanges = STAT_KEYS
        .filter(k => (Number(botAfter[k]) || 0) !== (Number(botBefore[k]) || 0))
        .map(k => ({ key: k, before: Number(botBefore[k]) || 0, after: Number(botAfter[k]) || 0 }));
    view.profilePicFrom = plan.profilePic ? plan.profilePic.from : null;
    view.targetBlockedUsers = plan.targetBlockedUsers
        ? { before: [...plan.targetBlockedUsers.before], after: [...plan.targetBlockedUsers.after] }
        : null;
    view.gameRecords = plan.gameRecords.map(r => ({
        gameId: String(r.gameId || r.id),
        completedAt: iso(r.completedAt),
        before: { team1: [...(r.before.team1Players || [])], team2: [...(r.before.team2Players || [])] },
        after: { team1: [...(r.after.team1Players || [])], team2: [...(r.after.team2Players || [])] }
    }));
    view.reports = plan.reports.map(r => ({
        id: String(r.id),
        reporter: String(r.before.reporter ?? ''),
        reported: String(r.before.reported ?? ''),
        newReporter: r.set.reporter || null,
        newReported: r.set.reported || null
    }));
    view.otherUsersBlocks = plan.otherUsersBlocks.map(u => ({ username: u.username, before: [...u.before], after: [...u.after] }));
    view.chainedTombstones = plan.chainedTombstones.map(t => ({ username: t.username, before: t.before }));
    view.retire = plan.retire.map(r => r.username);
    view.changeCount = countChanges(plan);
    return view;
}

module.exports = { planView, planHash, canonical };
