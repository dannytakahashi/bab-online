/**
 * The admin panel's data layer (server/admin/): the admin role and its
 * last-admin guard, one-time reset links, the audit log, reports, player
 * search, the merge plan view/hash, and scripts/set-admin.js.
 * (The socket API and its authorization: server/socket/__tests__/adminPanel.test.js;
 * the link page: server/__tests__/passwordResetRoute.test.js.)
 */

const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { createMemoryDb, MemoryCollection, enableSort } = require('../../testUtils/memoryDb');
const { listAdmins, setAdminFlag, isAdminDoc } = require('../adminRole');
const { createResetLink, useResetLink, RESET_TTL_MS, INVALID_LINK, INVALID_PASSWORD } = require('../passwordReset');
const { recordAudit, listAudit, redactDetail } = require('../audit');
const { listReports, resolveReport } = require('../reports');
const { searchPlayers, listPlayers, LIST_MAX } = require('../players');
const { planView, planHash } = require('../mergeView');
const { planMerge, applyMerge, formatPlan, countChanges } = require('../accountMerge');
const { hashToken } = require('../../utils/sessionTokens');

beforeAll(() => enableSort(true));
afterAll(() => enableSort(false));

const hashFast = (pw) => bcrypt.hash(pw, 4);

function makeDb(users = []) {
    const db = createMemoryDb({ users });
    db.passwordResets = new MemoryCollection();
    db.adminAudit = new MemoryCollection();
    return db;
}

describe('admin role', () => {
    let db;
    beforeEach(() => {
        db = makeDb([
            { username: 'Owner', isAdmin: true },
            { username: 'Bea' },
            { username: 'Old', mergedInto: 'Bea', mergedAt: new Date() },
            { username: 'Ghost', mergedInto: 'Bea', isAdmin: true } // a stale flag on a tombstone
        ]);
    });

    test('listAdmins lists live admins only (a tombstone with a stale flag is not one)', async () => {
        expect((await listAdmins(db)).map(a => a.username)).toEqual(['Owner']);
        expect(isAdminDoc({ username: 'Ghost', mergedInto: 'Bea', isAdmin: true })).toBe(false);
        expect(isAdminDoc({ username: 'Owner', isAdmin: 'true' })).toBe(false);
    });

    test('make and remove admin; unknown and merged names are refused', async () => {
        await expect(setAdminFlag(db, 'Bea', true, { by: 'Owner' })).resolves.toEqual({ username: 'Bea', isAdmin: true, changed: true });
        const bea = await db.users.findOne({ username: 'Bea' });
        expect(bea).toMatchObject({ isAdmin: true, adminSetBy: 'Owner' });
        await expect(setAdminFlag(db, 'Bea', true)).resolves.toMatchObject({ changed: false });
        await expect(setAdminFlag(db, 'Bea', false)).resolves.toEqual({ username: 'Bea', isAdmin: false, changed: true });
        expect((await db.users.findOne({ username: 'Bea' })).isAdmin).toBeUndefined();
        await expect(setAdminFlag(db, 'nobody', true)).rejects.toMatchObject({ code: 'not_found' });
        await expect(setAdminFlag(db, 'Old', true)).rejects.toMatchObject({ code: 'refused', message: '"Old" was merged into "Bea" and can\'t be an admin.' });
        expect((await db.users.findOne({ username: 'Old' })).isAdmin).toBeUndefined();
    });

    test('the last admin cannot be removed (the flag is put back), but the CLI may', async () => {
        await expect(setAdminFlag(db, 'Owner', false)).rejects.toMatchObject({ code: 'last_admin' });
        expect((await db.users.findOne({ username: 'Owner' })).isAdmin).toBe(true);
        await setAdminFlag(db, 'Bea', true);
        await expect(setAdminFlag(db, 'Owner', false)).resolves.toMatchObject({ changed: true });
        await expect(setAdminFlag(db, 'Bea', false)).rejects.toMatchObject({ code: 'last_admin' });
        await expect(setAdminFlag(db, 'Bea', false, { allowNoAdmins: true })).resolves.toMatchObject({ changed: true });
        expect(await listAdmins(db)).toEqual([]);
    });

    test('two admins removing each other at once never leaves zero admins', async () => {
        await setAdminFlag(db, 'Bea', true);
        const results = await Promise.allSettled([setAdminFlag(db, 'Owner', false), setAdminFlag(db, 'Bea', false)]);
        expect(results.filter(r => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
        expect((await listAdmins(db)).length).toBeGreaterThanOrEqual(1);
    });

    test('merging an admin away is refused, and a tombstone write unsets the flag', async () => {
        await setAdminFlag(db, 'Bea', true);
        await db.users.insertOne({ username: 'Bea2', isAdmin: true, adminSince: new Date() });
        const plan = await planMerge(db, { target: 'Bea', sources: ['Bea2'] });
        expect(plan.errors.join(' ')).toMatch(/Bea2" is an admin/);
        await setAdminFlag(db, 'Bea2', false);
        const ok = await planMerge(db, { target: 'Bea', sources: ['Bea2'] });
        expect(ok.errors).toEqual([]);
        await applyMerge(db, ok);
        const tomb = await db.users.findOne({ username: 'Bea2' });
        expect(tomb.mergedInto).toBe('Bea');
        expect('isAdmin' in tomb || 'adminSince' in tomb).toBe(false);
    });
});

describe('reset links', () => {
    let db;
    let now;
    beforeEach(async () => {
        now = new Date('2026-11-11T12:00:00Z');
        db = makeDb([
            { username: 'Bea', password: await hashFast('old'), sessionTokens: [{ hash: 'h1', createdAt: now, lastUsedAt: now }, { hash: 'h2', createdAt: now, lastUsedAt: now }], sessionToken: 'legacy' },
            { username: 'Old', mergedInto: 'Bea' }
        ]);
    });

    test('a link is 256 random bits, stored hashed only, valid 24 h', async () => {
        const link = await createResetLink(db, 'Bea', { now, by: 'Owner' });
        expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(link.expiresAt.getTime() - now.getTime()).toBe(RESET_TTL_MS);
        const [doc] = db.passwordResets.all();
        expect(doc).toMatchObject({ tokenHash: hashToken(link.token), username: 'Bea', state: 'open', createdBy: 'Owner' });
        expect(JSON.stringify(db.passwordResets.all())).not.toContain(link.token);
        const other = await createResetLink(db, 'Bea', { now });
        expect(other.token).not.toBe(link.token);
    });

    test('valid -> used: new password works, old fails, every session revoked; reuse refused', async () => {
        const { token } = await createResetLink(db, 'Bea', { now });
        const res = await useResetLink(db, token, 'new-pass', { now, hash: hashFast });
        // socketId: the connection the revoke found (none here)
        expect(res).toEqual({ ok: true, username: 'Bea', revokedSessions: 3, socketId: null });
        const bea = await db.users.findOne({ username: 'Bea' });
        expect(await bcrypt.compare('new-pass', bea.password)).toBe(true);
        expect(await bcrypt.compare('old', bea.password)).toBe(false);
        expect(bea.sessionTokens).toBeUndefined();
        expect(bea.sessionToken).toBeUndefined();
        expect(bea.passwordResetByLinkAt).toEqual(now);
        expect(db.passwordResets.all()[0]).toMatchObject({ state: 'used', usedAt: now });
        expect(await useResetLink(db, token, 'again', { now, hash: hashFast })).toBe(INVALID_LINK);
        expect(await bcrypt.compare('new-pass', (await db.users.findOne({ username: 'Bea' })).password)).toBe(true);
    });

    test('expired, unknown, malformed and superseded links are the same refusal', async () => {
        const first = await createResetLink(db, 'Bea', { now });
        const second = await createResetLink(db, 'Bea', { now });
        expect(second.revoked).toBe(1);
        expect(await useResetLink(db, first.token, 'pw', { now, hash: hashFast })).toBe(INVALID_LINK);
        const later = new Date(now.getTime() + RESET_TTL_MS);
        expect(await useResetLink(db, second.token, 'pw', { now: later, hash: hashFast })).toBe(INVALID_LINK);
        expect(await useResetLink(db, 'x'.repeat(43), 'pw', { now, hash: hashFast })).toBe(INVALID_LINK);
        expect(await useResetLink(db, 'short', 'pw', { now, hash: hashFast })).toBe(INVALID_LINK);
        expect(await useResetLink(db, null, 'pw', { now, hash: hashFast })).toBe(INVALID_LINK);
        // still valid one millisecond before expiry
        const edge = new Date(now.getTime() + RESET_TTL_MS - 1);
        expect(await useResetLink(db, second.token, 'pw', { now: edge, hash: hashFast })).toMatchObject({ ok: true });
    });

    test('the sign-up password rule applies (1-100 characters) and a refused password keeps the link', async () => {
        const { token } = await createResetLink(db, 'Bea', { now });
        expect(await useResetLink(db, token, '', { now, hash: hashFast })).toBe(INVALID_PASSWORD);
        expect(await useResetLink(db, token, 'p'.repeat(101), { now, hash: hashFast })).toBe(INVALID_PASSWORD);
        expect(await useResetLink(db, token, 42, { now, hash: hashFast })).toBe(INVALID_PASSWORD);
        expect(await useResetLink(db, token, 'p'.repeat(100), { now, hash: hashFast })).toMatchObject({ ok: true });
    });

    test('two tabs at once: exactly one success', async () => {
        const { token } = await createResetLink(db, 'Bea', { now });
        const results = await Promise.all([1, 2, 3].map(i => useResetLink(db, token, `pw${i}`, { now, hash: hashFast })));
        expect(results.filter(r => r.ok)).toHaveLength(1);
        expect(results.filter(r => r === INVALID_LINK)).toHaveLength(2);
    });

    test('no links for unknown or merged names; a merge closes the source\'s open link', async () => {
        await expect(createResetLink(db, 'nobody', { now })).rejects.toMatchObject({ code: 'not_found' });
        await expect(createResetLink(db, 'Old', { now })).rejects.toMatchObject({ code: 'refused' });
        await db.users.insertOne({ username: 'Bea2', password: 'x' });
        const { token } = await createResetLink(db, 'Bea2', { now });
        const plan = await planMerge(db, { target: 'Bea', sources: ['Bea2'] });
        await applyMerge(db, plan, { now });
        expect(db.passwordResets.all().find(r => r.username === 'Bea2').state).toBe('revoked');
        expect(await useResetLink(db, token, 'pw', { now, hash: hashFast })).toBe(INVALID_LINK);
    });

    test('a link whose account was merged after it was made is refused', async () => {
        await db.users.insertOne({ username: 'Bea2', password: 'x' });
        const { token } = await createResetLink(db, 'Bea2', { now });
        await db.users.updateOne({ username: 'Bea2' }, { $set: { mergedInto: 'Bea' } }); // e.g. an older CLI
        expect(await useResetLink(db, token, 'pw', { now, hash: hashFast })).toBe(INVALID_LINK);
    });

    test('a failed password write releases the link (a database hiccup does not burn it)', async () => {
        const { token } = await createResetLink(db, 'Bea', { now });
        const real = db.users.findOneAndUpdate.bind(db.users);
        db.users.findOneAndUpdate = jest.fn(async () => { throw new Error('write failed'); });
        await expect(useResetLink(db, token, 'pw', { now, hash: hashFast })).rejects.toThrow('write failed');
        db.users.findOneAndUpdate = real;
        expect(db.passwordResets.all()[0].state).toBe('open');
        expect(await useResetLink(db, token, 'pw', { now, hash: hashFast })).toMatchObject({ ok: true });
    });
});

describe('audit log', () => {
    test('entries newest first, paged, and token-looking text redacted', async () => {
        const db = makeDb();
        for (let i = 0; i < 5; i++) {
            await recordAudit(db, { actor: 'Owner', action: 'searchPlayers', target: null, result: 'ok', detail: `n=${i}`, now: new Date(2026, 0, 1, 0, i) });
        }
        const page = await listAudit(db, { limit: 3 });
        expect(page.entries.map(e => e.detail)).toEqual(['n=4', 'n=3', 'n=2']);
        expect(page.hasMore).toBe(true);
        const next = await listAudit(db, { limit: 3, before: new Date(page.entries[2].at) });
        expect(next.entries.map(e => e.detail)).toEqual(['n=1', 'n=0']);
        expect(next.hasMore).toBe(false);
        expect(redactDetail('token AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde ok')).toBe('token [redacted] ok');
    });

    test('redaction drops secrets by shape but keeps long usernames', () => {
        const crypto = require('crypto');
        const resetToken = crypto.randomBytes(32).toString('base64url');
        const session = require('uuid').v4();
        const sha = crypto.createHash('sha256').update('x').digest('hex');
        const bcryptHash = bcrypt.hashSync('pw', 4);
        // a bcrypt hash whose tail has a 43-character run between separators
        const splitHash = ['', '2b', '04', 'a'.repeat(43) + '.' + 'b'.repeat(9)].join('$');
        for (const secret of [resetToken, session, session.toUpperCase(), sha, bcryptHash, splitHash, 'Q'.repeat(51)]) {
            expect(redactDetail(`before ${secret} after`)).toBe('before [redacted] after');
            expect(redactDetail(`x:${secret};`)).toBe('x:[redacted];');
        }
        // valid usernames, up to the 50-character sign-up maximum, survive
        for (const name of ['abcdefghijklmnopqrstuvwxyz0123456789', 'A'.repeat(32), 'b'.repeat(42), 'c'.repeat(44), 'Long_Name-'.repeat(5)]) {
            expect(redactDetail(`merged ${name}: retired ${name}`)).toBe(`merged ${name}: retired ${name}`);
        }
    });

    test('paging back never skips entries that share the boundary millisecond', async () => {
        const db = makeDb();
        const t = new Date('2026-11-11T12:00:00.000Z');
        for (let i = 0; i < 5; i++) await recordAudit(db, { actor: 'a', action: 'x', result: 'ok', detail: `same-${i}`, now: t });
        await recordAudit(db, { actor: 'a', action: 'x', result: 'ok', detail: 'older', now: new Date(t.getTime() - 1) });
        await recordAudit(db, { actor: 'a', action: 'x', result: 'ok', detail: 'newer', now: new Date(t.getTime() + 1) });
        const seen = [];
        let page = await listAudit(db, { limit: 2 });
        seen.push(...page.entries);
        while (page.hasMore) {
            const last = page.entries[page.entries.length - 1];
            page = await listAudit(db, { limit: 2, before: new Date(last.at), beforeId: last.id });
            seen.push(...page.entries);
        }
        expect(seen.map(e => e.detail)).toEqual(['newer', 'same-4', 'same-3', 'same-2', 'same-1', 'same-0', 'older']);
        expect(new Set(seen.map(e => e.id)).size).toBe(7);
    });

    test('a failed audit write never throws', async () => {
        const db = makeDb();
        db.adminAudit.insertOne = async () => { throw new Error('down'); };
        await expect(recordAudit(db, { actor: 'a', action: 'x', result: 'ok' })).resolves.toBeUndefined();
        await expect(recordAudit({}, { actor: 'a', action: 'x', result: 'ok' })).resolves.toBeUndefined();
    });
});

describe('reports', () => {
    test('open reports newest first; resolve once with a note', async () => {
        const db = makeDb();
        await db.reports.insertOne({ reporter: 'A', reported: 'B', reason: 'spam', createdAt: new Date(2026, 0, 1) });
        await db.reports.insertOne({ reporter: 'C', reported: 'B', reason: 'rude', context: 'chat', createdAt: new Date(2026, 0, 2) });
        const open = await listReports(db);
        expect(open.map(r => r.reason)).toEqual(['rude', 'spam']);
        expect(open[0]).toMatchObject({ status: 'open', resolvedBy: null, note: null, context: 'chat' });
        const done = await resolveReport(db, open[0].id, { status: 'dismissed', note: 'not rude', by: 'Owner' });
        expect(done).toMatchObject({ status: 'dismissed', resolvedBy: 'Owner', note: 'not rude' });
        await expect(resolveReport(db, open[0].id, { status: 'resolved', by: 'Bea' })).rejects.toMatchObject({ code: 'refused' });
        expect((await listReports(db)).map(r => r.reason)).toEqual(['spam']);
        expect((await listReports(db, { status: 'all' }))).toHaveLength(2);
        await expect(resolveReport(db, 'nope', { status: 'resolved', by: 'x' })).rejects.toMatchObject({ code: 'not_found' });
        await expect(resolveReport(db, new ObjectId().toHexString(), { status: 'resolved', by: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    });
});

describe('player search', () => {
    test('rows carry only what an admin needs; tombstones marked; exact name first', async () => {
        const seen = new Date('2026-11-10T08:00:00Z');
        const db = makeDb([
            { username: 'Alanna', password: 'HASH', stats: { gamesPlayed: 3 }, sessionTokens: [{ hash: 'SECRET', lastUsedAt: seen }], customProfilePic: 'data:x' },
            { username: 'alan', password: 'HASH', isAdmin: true, stats: { gamesPlayed: 9 } },
            { username: 'Alan2', mergedInto: 'alan' }
        ]);
        const rows = await searchPlayers(db, 'Alan', { isOnline: (u) => u === 'alan' });
        expect(rows.map(r => r.username)).toEqual(['alan', 'Alanna', 'Alan2']);
        expect(rows[0]).toMatchObject({ isAdmin: true, online: true, gamesPlayed: 9, mergedInto: null, lastSeenAt: null });
        expect(rows[1]).toMatchObject({ isAdmin: false, online: false, gamesPlayed: 3, lastSeenAt: seen.toISOString() });
        expect(rows[2]).toMatchObject({ mergedInto: 'alan', isAdmin: false, online: false });
        expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'gamesPlayed', 'isAdmin', 'lastSeenAt', 'mergedInto', 'online', 'renameUnfinished', 'renamed', 'username']);
        expect(JSON.stringify(rows)).not.toMatch(/HASH|SECRET|data:x/);
        expect(await searchPlayers(db, '   ')).toEqual([]);
        expect(await searchPlayers(db, 'x'.repeat(51))).toEqual([]);
        expect(await searchPlayers(db, '.*')).toEqual([]); // regex-escaped
    });

    test('the Players table: every account newest first, capped, with the true total and the same rows', async () => {
        const at = (s) => ObjectId.createFromTime(Date.parse(s) / 1000);
        const db = makeDb([
            { _id: at('2026-06-01T00:00:00Z'), username: 'keyprobe00001', password: 'HASH' },
            { _id: at('2026-09-01T00:00:00Z'), username: 'Bea', password: 'HASH', stats: { gamesPlayed: 2 }, sessionTokens: [{ hash: 'SECRET' }] },
            { _id: at('2026-03-01T00:00:00Z'), username: 'Ann', isAdmin: true },
            { _id: at('2026-10-01T00:00:00Z'), username: 'Bea2', mergedInto: 'Bea', mergedAt: new Date() }
        ]);
        const all = await listPlayers(db, { isOnline: (u) => u === 'Bea' });
        expect(all.total).toBe(4);
        expect(all.limit).toBe(LIST_MAX);
        expect(LIST_MAX).toBe(500);
        expect(all.players.map(p => p.username)).toEqual(['Bea2', 'Bea', 'keyprobe00001', 'Ann']);
        expect(all.players[0]).toMatchObject({ mergedInto: 'Bea', online: false, createdAt: '2026-10-01T00:00:00.000Z' });
        expect(all.players[1]).toMatchObject({ online: true, gamesPlayed: 2 });
        expect(JSON.stringify(all)).not.toMatch(/HASH|SECRET/);
        const capped = await listPlayers(db, { limit: 2 });
        expect(capped).toMatchObject({ total: 4, limit: 2 });
        expect(capped.players.map(p => p.username)).toEqual(['Bea2', 'Bea']);
    });
});

describe('merge plan view and hash', () => {
    async function seed() {
        const db = makeDb([
            { username: 'Alan', stats: { gamesPlayed: 2, wins: 1 }, blockedUsers: ['Troll'] },
            { username: 'alan2', stats: { gamesPlayed: 3, wins: 2, totalPoints: 40 }, customProfilePic: 'data:image/png;base64,AAAA', blockedUsers: ['Pest'] },
            { username: 'Friend', blockedUsers: ['alan2'] }
        ]);
        await db.gameRecords.insertOne({ gameId: 'g1', team1Players: ['alan2', 'x'], team2Players: ['y', 'z'], completedAt: new Date(2026, 0, 3) });
        await db.reports.insertOne({ reporter: 'alan2', reported: 'Troll', reason: 'r', createdAt: new Date() });
        return db;
    }

    test('the view has formatPlan\'s content (and no picture bytes)', async () => {
        const db = await seed();
        const plan = await planMerge(db, { target: 'Alan', sources: ['alan2'] });
        const view = planView(plan);
        const text = formatPlan(plan);
        expect(view.accounts.map(a => [a.role, a.username, a.stats.gamesPlayed])).toEqual([['target', 'Alan', 2], ['source', 'alan2', 3], ['result', 'Alan', 5]]);
        expect(view.accounts[1].note).toBe('stats will be added');
        expect(view.accounts[0].createdAt).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT/)); // the kept account's _id time
        expect(text).toContain('stats will be added');
        expect(view.statChanges).toEqual(expect.arrayContaining([{ key: 'gamesPlayed', before: 2, after: 5 }, { key: 'wins', before: 1, after: 3 }]));
        for (const c of view.statChanges) expect(text).toContain(`stats.${c.key}: ${c.before} → ${c.after}`);
        expect(view.profilePicFrom).toBe('alan2');
        expect(view.targetBlockedUsers).toEqual({ before: ['Troll'], after: ['Troll', 'Pest'] });
        expect(view.gameRecords).toEqual([{ gameId: 'g1', completedAt: expect.any(String), before: { team1: ['alan2', 'x'], team2: ['y', 'z'] }, after: { team1: ['Alan', 'x'], team2: ['y', 'z'] } }]);
        expect(view.reports).toEqual([expect.objectContaining({ reporter: 'alan2', reported: 'Troll', newReporter: 'Alan', newReported: null })]);
        expect(view.otherUsersBlocks).toEqual([{ username: 'Friend', before: ['alan2'], after: ['Alan'] }]);
        expect(view.retire).toEqual(['alan2']);
        expect(view.changeCount).toBe(countChanges(plan));
        expect(text).toContain(`${view.changeCount} change(s) planned.`);
        expect(JSON.stringify(view)).not.toContain('base64');
    });

    test('the hash is stable for the same data and changes when anything in the plan does', async () => {
        const db = await seed();
        const h1 = planHash(await planMerge(db, { target: 'Alan', sources: ['alan2'] }));
        expect(planHash(await planMerge(db, { target: 'Alan', sources: ['alan2'] }))).toBe(h1);
        await db.gameRecords.insertOne({ gameId: 'g2', team1Players: ['alan2', 'q'], team2Players: ['r', 's'], completedAt: new Date() });
        const h2 = planHash(await planMerge(db, { target: 'Alan', sources: ['alan2'] }));
        expect(h2).not.toBe(h1);
        await db.users.updateOne({ username: 'alan2' }, { $inc: { 'stats.wins': 1 } });
        expect(planHash(await planMerge(db, { target: 'Alan', sources: ['alan2'] }))).not.toBe(h2);
    });

    test('an errored plan view carries only the errors', async () => {
        const db = await seed();
        const view = planView(await planMerge(db, { target: 'Alan', sources: ['nobody'] }));
        expect(view.errors).toEqual(['Source account "nobody" does not exist.']);
        expect(view.accounts).toEqual([]);
        expect(view.changeCount).toBe(0);
    });
});

describe('scripts/set-admin.js', () => {
    const { main, parseArgs } = require('../../../scripts/set-admin');
    let db;
    let out;
    let deps;
    let closed;
    beforeEach(() => {
        db = makeDb([{ username: 'Owner' }, { username: 'Bea', isAdmin: true }, { username: 'Old', mergedInto: 'Owner' }]);
        out = [];
        closed = 0;
        jest.spyOn(console, 'log').mockImplementation((...a) => out.push(a.join(' ')));
        jest.spyOn(console, 'error').mockImplementation((...a) => out.push(a.join(' ')));
        deps = {
            connect: async () => ({ client: { close: async () => { closed++; } }, uri: 'mongodb://localhost:27017/scratch', db }),
            confirm: jest.fn(async () => true)
        };
    });
    afterEach(() => jest.restoreAllMocks());

    test('--list is read-only and shows the current admins', async () => {
        const before = JSON.stringify(db.users.all());
        expect(await main(['--list'], deps)).toBe(0);
        expect(out.join('\n')).toMatch(/Database: mongodb:\/\/localhost:27017\/scratch[\s\S]*Current admins \(1\):\n {2}Bea/);
        expect(JSON.stringify(db.users.all())).toBe(before);
        expect(deps.confirm).not.toHaveBeenCalled();
        expect(closed).toBe(1);
    });

    test('apply: lists first, asks for ADMIN, then writes', async () => {
        expect(await main(['Owner'], deps)).toBe(0);
        expect(deps.confirm).toHaveBeenCalledWith(expect.stringContaining('Make "Owner" an admin?'), 'ADMIN');
        const text = out.join('\n');
        expect(text.indexOf('Current admins (1)')).toBeLessThan(text.indexOf('Done'));
        expect((await db.users.findOne({ username: 'Owner' })).isAdmin).toBe(true);
    });

    test('a declined confirmation changes nothing', async () => {
        deps.confirm.mockResolvedValue(false);
        expect(await main(['Owner'], deps)).toBe(1);
        expect((await db.users.findOne({ username: 'Owner' })).isAdmin).toBeUndefined();
    });

    test('--remove asks for REMOVE; removing the last admin is allowed with a warning', async () => {
        expect(await main(['Bea', '--remove'], deps)).toBe(0);
        expect(deps.confirm).toHaveBeenCalledWith(expect.any(String), 'REMOVE');
        expect((await db.users.findOne({ username: 'Bea' })).isAdmin).toBeUndefined();
        expect(out.join('\n')).toMatch(/there are no admins now/);
    });

    test('unknown and merged names are refused; no-ops say so', async () => {
        expect(await main(['nobody'], deps)).toBe(1);
        expect(await main(['Old'], deps)).toBe(1);
        expect(await main(['Bea'], deps)).toBe(0);
        expect(await main(['Owner', '--remove'], deps)).toBe(0);
        expect(deps.confirm).not.toHaveBeenCalled();
        expect(out.join('\n')).toMatch(/does not exist[\s\S]*merged into "Owner"[\s\S]*already an admin[\s\S]*not an admin/);
        expect(db.users.all().filter(u => u.isAdmin).map(u => u.username)).toEqual(['Bea']);
    });

    test('argument errors', async () => {
        expect(() => parseArgs(['a', 'b'])).toThrow('one username');
        expect(() => parseArgs(['--bogus'])).toThrow('Unknown option');
        expect(await main([], deps)).toBe(2);
        expect(await main(['--help'], deps)).toBe(0);
    });
});
