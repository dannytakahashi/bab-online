/**
 * Account merging for players who ended up with several accounts (usually
 * from forgetting a password and signing up again).
 *
 * Merging re-points everything keyed by the old usernames ("sources") to the
 * kept account ("target"), adds the sources' cached stats into the target's,
 * and turns each source user document into a tombstone:
 *   { username, mergedInto: <target>, mergedAt }
 * A tombstone keeps the name reserved (sign-up says "already taken"), cannot
 * sign in (no password; sign-in tells the player which account to use), and
 * is hidden from the leaderboard and player search.
 *
 * Everything is planned first (planMerge, used for --dry-run) and applied
 * from that plan (applyMerge). The whole operation is idempotent: re-running
 * a finished merge is a no-op, and re-running one that was interrupted picks
 * up where it stopped. Stats are guarded per source by the target's
 * `mergedFrom` audit log, so they can never be added twice.
 *
 * Where usernames live (keep in sync if new per-user data is added):
 *   users.username / users.stats / users.profilePic / users.customProfilePic
 *   users.blockedUsers (own list, and other users' lists naming the source)
 *   users.mergedInto (earlier tombstones that point at a source)
 *   gameRecords.team1Players / team2Players
 *   reports.reporter / reports.reported
 *   passwordResets.username (open links of a source are revoked, see below)
 * Not moved: adminAudit (a log of what happened, by the names of the time).
 * Tournament history is in-memory only (TournamentState), so nothing to move.
 *
 * Runs as a CLI in its own process: the running server's leaderboard and
 * records caches (profileHandlers.js) cannot see a merge, so the pages show
 * the pre-merge rows for at most their 60 s TTL. Its failed-sign-in counters
 * (socket/signInThrottle.js) are keyed by the submitted name and expire on
 * their own (15 min); nothing to move.
 */

const STAT_KEYS = [
    'wins', 'losses', 'draws', 'gamesPlayed', 'totalPoints',
    'totalTricksBid', 'totalTricksTaken', 'totalHands', 'totalSets',
    'totalSetPoints', 'totalFaults', 'totalHSI'
];

// Fields removed from a source when it becomes a tombstone
const TOMBSTONE_UNSET = [
    'password', 'sessionToken', 'sessionTokens', 'socketId', 'stats',
    'profilePic', 'customProfilePic', 'blockedUsers', 'activeGameId',
    'activeGameStartedAt', 'activeTournamentId',
    // a tombstone is never an admin (server/admin/adminRole.js)
    'isAdmin', 'adminSince', 'adminSetBy'
];

function pickStats(stats) {
    const out = {};
    for (const key of STAT_KEYS) out[key] = Number(stats?.[key]) || 0;
    return out;
}

function addStats(a, b) {
    const out = {};
    for (const key of STAT_KEYS) out[key] = (a[key] || 0) + (b[key] || 0);
    return out;
}

function renameAll(list, sources, target) {
    if (!Array.isArray(list)) return list;
    return list.map(name => (sources.includes(name) ? target : name));
}

function sameList(a, b) {
    return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function isTombstoneComplete(doc) {
    return Boolean(doc.mergedInto) && TOMBSTONE_UNSET.every(f => doc[f] === undefined);
}

/**
 * Work out exactly what a merge would change. Never writes.
 *
 * @param {{users, gameRecords, reports}} db - Mongo collections
 * @param {{target: string, sources: string[]}} request
 * @returns {Promise<Object>} plan (see formatPlan for a readable version)
 */
async function planMerge(db, { target, sources }) {
    const plan = {
        target,
        sources: [],
        errors: [],
        warnings: [],
        targetId: null,
        statsBefore: null,
        statsAfter: null,
        sourceAccounts: [],
        profilePic: null,
        targetBlockedUsers: null,
        gameRecords: [],
        reports: [],
        otherUsersBlocks: [],
        chainedTombstones: [],
        retire: []
    };

    const requested = [...new Set((sources || []).map(s => String(s)))];
    if (!target) plan.errors.push('No target account given.');
    if (requested.length === 0) plan.errors.push('No source accounts given.');
    if (requested.includes(target)) {
        plan.errors.push(`"${target}" is both the target and a source.`);
    }
    plan.sources = requested.filter(s => s !== target);
    if (plan.errors.length) return plan;

    const targetDoc = await db.users.findOne({ username: target });
    if (!targetDoc) {
        plan.errors.push(`Target account "${target}" does not exist.`);
        return plan;
    }
    if (targetDoc.mergedInto) {
        plan.errors.push(`Target "${target}" was itself merged into "${targetDoc.mergedInto}". Merge into "${targetDoc.mergedInto}" instead.`);
        return plan;
    }
    plan.targetId = targetDoc._id;

    const mergedFrom = new Set((targetDoc.mergedFrom || []).map(e => e.username));
    const sourceDocs = [];

    for (const name of plan.sources) {
        const doc = await db.users.findOne({ username: name });
        if (!doc) {
            plan.errors.push(`Source account "${name}" does not exist.`);
            continue;
        }
        if (doc.mergedInto && doc.mergedInto !== target) {
            plan.errors.push(`Source "${name}" was already merged into "${doc.mergedInto}", not "${target}".`);
            continue;
        }
        if (!doc.mergedInto && doc.isAdmin === true) {
            plan.errors.push(`Source "${name}" is an admin. Remove its admin flag first (the kept account does not inherit it).`);
            continue;
        }
        const statsDone = mergedFrom.has(name);
        if (!statsDone && !doc.mergedInto && (doc.activeGameId || doc.activeTournamentId)) {
            plan.errors.push(`Source "${name}" is in an active ${doc.activeGameId ? 'game' : 'tournament'}. Wait until it finishes and run again.`);
            continue;
        }
        if (!statsDone && doc.mergedInto === target) {
            plan.warnings.push(`"${name}" is already retired into "${target}" but has no merge record, so it has no stats left to add.`);
        }
        sourceDocs.push({ doc, statsDone });
    }
    if (plan.errors.length) return plan;

    // Stats: target's cached totals plus every source not yet merged
    plan.statsBefore = pickStats(targetDoc.stats);
    let statsAfter = { ...plan.statsBefore };
    for (const { doc, statsDone } of sourceDocs) {
        const hasStats = doc.stats !== undefined;
        const stats = pickStats(doc.stats);
        const action = statsDone ? 'already-merged' : (hasStats ? 'add-stats' : 'no-stats');
        if (action === 'add-stats') statsAfter = addStats(statsAfter, stats);
        plan.sourceAccounts.push({
            username: doc.username,
            id: doc._id,
            action,
            stats,
            createdAt: typeof doc._id?.getTimestamp === 'function' ? doc._id.getTimestamp() : null
        });
        if (!isTombstoneComplete(doc)) plan.retire.push({ username: doc.username, id: doc._id });
    }
    plan.statsAfter = statsAfter;

    // Profile picture: keep the target's custom photo; otherwise inherit the
    // first source's custom photo so the player doesn't lose their picture
    if (!targetDoc.customProfilePic) {
        const withPic = sourceDocs.find(({ doc, statsDone }) => !statsDone && doc.customProfilePic);
        if (withPic) {
            plan.profilePic = { from: withPic.doc.username, customProfilePic: withPic.doc.customProfilePic };
        }
    }

    // Target's own block list absorbs the sources' block lists
    const everyone = [target, ...plan.sources];
    const unionBlocked = [...new Set([
        ...(targetDoc.blockedUsers || []),
        ...sourceDocs.flatMap(({ doc }) => doc.blockedUsers || [])
    ])].filter(name => !everyone.includes(name));
    if (!sameList(unionBlocked, targetDoc.blockedUsers)) {
        plan.targetBlockedUsers = { before: targetDoc.blockedUsers || [], after: unionBlocked };
    }

    // Other players who blocked a source now block the target
    const blockers = await db.users.find({
        blockedUsers: { $in: plan.sources },
        username: { $nin: everyone }
    }).toArray();
    for (const doc of blockers) {
        const after = [...new Set(renameAll(doc.blockedUsers, plan.sources, target))];
        plan.otherUsersBlocks.push({ id: doc._id, username: doc.username, before: doc.blockedUsers, after });
    }

    // Tombstones from earlier merges that point at a source now point at the
    // target, so their sign-in message names the account that still exists
    const chained = await db.users.find({ mergedInto: { $in: plan.sources } }).toArray();
    for (const doc of chained) {
        plan.chainedTombstones.push({ id: doc._id, username: doc.username, before: doc.mergedInto });
    }

    // Game records
    const records = await db.gameRecords.find({
        $or: [
            { team1Players: { $in: plan.sources } },
            { team2Players: { $in: plan.sources } }
        ]
    }).toArray();
    for (const rec of records) {
        const after = {
            team1Players: renameAll(rec.team1Players, plan.sources, target),
            team2Players: renameAll(rec.team2Players, plan.sources, target)
        };
        const names = [...(after.team1Players || []), ...(after.team2Players || [])];
        if (names.filter(n => n === target).length > 1) {
            plan.warnings.push(`Game ${rec.gameId || rec._id} had more than one of these accounts at the table; "${target}" will appear in it twice.`);
        }
        plan.gameRecords.push({
            id: rec._id,
            gameId: rec.gameId,
            completedAt: rec.completedAt,
            before: { team1Players: rec.team1Players, team2Players: rec.team2Players },
            after
        });
    }

    // Reports (filed by or against a source)
    const reports = await db.reports.find({
        $or: [{ reporter: { $in: plan.sources } }, { reported: { $in: plan.sources } }]
    }).toArray();
    for (const rep of reports) {
        const set = {};
        if (plan.sources.includes(rep.reporter)) set.reporter = target;
        if (plan.sources.includes(rep.reported)) set.reported = target;
        plan.reports.push({ id: rep._id, before: { reporter: rep.reporter, reported: rep.reported }, set });
    }

    return plan;
}

function countChanges(plan) {
    return plan.sourceAccounts.filter(s => s.action === 'add-stats').length
        + (plan.profilePic ? 1 : 0)
        + (plan.targetBlockedUsers ? 1 : 0)
        + plan.otherUsersBlocks.length
        + plan.chainedTombstones.length
        + plan.gameRecords.length
        + plan.reports.length
        + plan.retire.length;
}

/**
 * Apply a plan from planMerge. Re-plan immediately before applying so the
 * plan reflects the current database.
 *
 * @returns {Promise<Object>} counts of what was written
 */
async function applyMerge(db, plan, { now = new Date() } = {}) {
    if (plan.errors.length) {
        throw new Error(`Refusing to merge: ${plan.errors.join(' ')}`);
    }
    const { target, sources } = plan;
    const result = {
        gameRecords: 0, reports: 0, otherUsersBlocks: 0, chainedTombstones: 0,
        statsMerged: [], profilePic: false, targetBlockedUsers: false, retired: []
    };

    // 1. Shared documents first. These are pure renames, so re-running them
    //    is harmless if anything later fails.
    for (const rec of plan.gameRecords) {
        await db.gameRecords.updateOne({ _id: rec.id }, { $set: rec.after });
        result.gameRecords++;
    }
    for (const rep of plan.reports) {
        await db.reports.updateOne({ _id: rep.id }, { $set: rep.set });
        result.reports++;
    }
    for (const u of plan.otherUsersBlocks) {
        await db.users.updateOne({ _id: u.id }, { $set: { blockedUsers: u.after } });
        result.otherUsersBlocks++;
    }
    for (const t of plan.chainedTombstones) {
        await db.users.updateOne({ _id: t.id }, { $set: { mergedInto: target } });
        result.chainedTombstones++;
    }

    // 2. Target account. The `mergedFrom.username` guard makes each source's
    //    stats addition happen at most once, even across concurrent runs.
    for (const src of plan.sourceAccounts) {
        if (src.action === 'already-merged') continue;
        const update = {
            $push: { mergedFrom: { username: src.username, stats: src.stats, mergedAt: now } }
        };
        if (src.action === 'add-stats') {
            const inc = {};
            for (const key of STAT_KEYS) if (src.stats[key]) inc[`stats.${key}`] = src.stats[key];
            if (Object.keys(inc).length) update.$inc = inc;
        }
        const res = await db.users.updateOne(
            { _id: plan.targetId, 'mergedFrom.username': { $ne: src.username } },
            update
        );
        if (res.modifiedCount) result.statsMerged.push(src.username);
    }
    if (plan.profilePic) {
        await db.users.updateOne(
            { _id: plan.targetId, customProfilePic: { $exists: false } },
            { $set: { customProfilePic: plan.profilePic.customProfilePic } }
        );
        result.profilePic = true;
    }
    if (plan.targetBlockedUsers) {
        await db.users.updateOne({ _id: plan.targetId }, { $set: { blockedUsers: plan.targetBlockedUsers.after } });
        result.targetBlockedUsers = true;
    }

    // 3. Retire sources last, after their stats are safely on the target
    for (const src of plan.retire) {
        const unset = {};
        for (const field of TOMBSTONE_UNSET) unset[field] = '';
        await db.users.updateOne(
            { _id: src.id, username: { $in: sources } },
            // sessionEpoch: a restore in flight cannot write the sessions back
            { $set: { mergedInto: target, mergedAt: now }, $unset: unset, $inc: { sessionEpoch: 1 } }
        );
        result.retired.push(src.username);
    }
    // A retired name can no longer use a reset link made for it (the link
    // page refuses a tombstone anyway; this closes the link itself)
    if (db.passwordResets && plan.retire.length) {
        await db.passwordResets.updateMany(
            { username: { $in: plan.retire.map(r => r.username) }, state: 'open' },
            { $set: { state: 'revoked', revokedAt: now } }
        );
    }

    return result;
}

function fmtStats(s) {
    return `${s.gamesPlayed} games, ${s.wins}W/${s.losses}L/${s.draws}D, ${s.totalPoints} pts`;
}

function fmtDate(d) {
    return d ? new Date(d).toISOString().slice(0, 10) : '?';
}

/** Human-readable description of a plan, for the CLI. */
function formatPlan(plan) {
    const lines = [];
    lines.push(`Merge ${plan.sources.map(s => `"${s}"`).join(', ')} into "${plan.target}"`);
    if (plan.errors.length) {
        lines.push('', 'ERRORS (nothing will be changed):');
        plan.errors.forEach(e => lines.push(`  ✗ ${e}`));
        return lines.join('\n');
    }

    lines.push('', 'Accounts:');
    lines.push(`  target  ${plan.target}: ${fmtStats(plan.statsBefore)}`);
    for (const s of plan.sourceAccounts) {
        const note = {
            'add-stats': 'stats will be added',
            'already-merged': 'already merged, skipped',
            'no-stats': 'no stats to add'
        }[s.action];
        lines.push(`  source  ${s.username} (created ${fmtDate(s.createdAt)}): ${fmtStats(s.stats)} (${note})`);
    }
    lines.push(`  result  ${plan.target}: ${fmtStats(plan.statsAfter)}`);
    const changed = STAT_KEYS.filter(k => plan.statsAfter[k] !== plan.statsBefore[k]);
    for (const k of changed) {
        lines.push(`            stats.${k}: ${plan.statsBefore[k]} → ${plan.statsAfter[k]}`);
    }

    if (plan.profilePic) lines.push('', `Profile photo: copy custom photo from "${plan.profilePic.from}" (target has none).`);
    if (plan.targetBlockedUsers) {
        lines.push('', `Block list of "${plan.target}": [${plan.targetBlockedUsers.before.join(', ')}] → [${plan.targetBlockedUsers.after.join(', ')}]`);
    }

    lines.push('', `Game records to re-point: ${plan.gameRecords.length}`);
    for (const r of plan.gameRecords) {
        lines.push(`  ${fmtDate(r.completedAt)} ${r.gameId || r.id}: [${r.before.team1Players.join(', ')}] vs [${r.before.team2Players.join(', ')}] → [${r.after.team1Players.join(', ')}] vs [${r.after.team2Players.join(', ')}]`);
    }

    lines.push('', `Reports to re-point: ${plan.reports.length}`);
    for (const r of plan.reports) {
        lines.push(`  ${r.id}: reporter ${r.before.reporter}, reported ${r.before.reported} → ${JSON.stringify(r.set)}`);
    }

    lines.push('', `Other players' block lists to update: ${plan.otherUsersBlocks.length}`);
    for (const u of plan.otherUsersBlocks) {
        lines.push(`  ${u.username}: [${u.before.join(', ')}] → [${u.after.join(', ')}]`);
    }

    if (plan.chainedTombstones.length) {
        lines.push('', 'Older merged accounts to re-point:');
        plan.chainedTombstones.forEach(t => lines.push(`  ${t.username}: mergedInto ${t.before} → ${plan.target}`));
    }

    lines.push('', `Accounts to retire (can't sign in, name stays reserved): ${plan.retire.length ? plan.retire.map(r => r.username).join(', ') : 'none (already retired)'}`);

    if (plan.warnings.length) {
        lines.push('', 'Warnings:');
        plan.warnings.forEach(w => lines.push(`  ! ${w}`));
    }

    const n = countChanges(plan);
    lines.push('', n === 0 ? 'Nothing to do. This merge is already complete.' : `${n} change(s) planned.`);
    return lines.join('\n');
}

/** Lowercase letters only: "Alan_2", "alan", "ALAN!" all become "alan". */
function nameKey(username) {
    const letters = String(username).toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');
    return letters || String(username).toLowerCase();
}

/**
 * Group active accounts whose names look alike (same letters ignoring case,
 * digits and punctuation, or one name extending another, e.g. "Alan" and
 * "AlanB"). A report to help spot duplicates. Review it by hand.
 */
async function findDuplicateCandidates(db, { minPrefix = 4 } = {}) {
    // Only what the report uses: never the custom photos (up to ~500 KB
    // each), passwords or sessions. The panel runs this inside the game
    // server, so a full-document scan would stall live games
    const users = await db.users.find(
        { mergedInto: { $exists: false } },
        { projection: { username: 1, 'stats.gamesPlayed': 1 } }
    ).toArray();
    const keys = users.map(u => nameKey(u.username));

    // Union-find over users that share a key or where one key prefixes another
    const parent = users.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < users.length; i++) {
        for (let j = i + 1; j < users.length; j++) {
            const [a, b] = keys[i].length <= keys[j].length ? [keys[i], keys[j]] : [keys[j], keys[i]];
            if (a === b || (a.length >= minPrefix && b.startsWith(a))) {
                parent[find(i)] = find(j);
            }
        }
    }

    const groups = new Map();
    users.forEach((u, i) => {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push({
            username: u.username,
            gamesPlayed: u.stats?.gamesPlayed || 0,
            createdAt: typeof u._id?.getTimestamp === 'function' ? u._id.getTimestamp() : null
        });
    });

    return [...groups.values()]
        .filter(g => g.length > 1)
        .map(g => g.sort((a, b) => b.gamesPlayed - a.gamesPlayed))
        .sort((a, b) => a[0].username.localeCompare(b[0].username));
}

function formatDuplicateGroups(groups) {
    if (!groups.length) return 'No look-alike usernames found.';
    const lines = [`${groups.length} group(s) of look-alike usernames (most-played first):`];
    for (const g of groups) {
        lines.push('');
        for (const u of g) {
            lines.push(`  ${u.username.padEnd(24)} ${String(u.gamesPlayed).padStart(5)} games   created ${fmtDate(u.createdAt)}`);
        }
    }
    return lines.join('\n');
}

module.exports = {
    STAT_KEYS,
    planMerge,
    applyMerge,
    formatPlan,
    countChanges,
    findDuplicateCandidates,
    formatDuplicateGroups,
    nameKey
};
