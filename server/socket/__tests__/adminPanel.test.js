/**
 * The admin panel's socket API (server/socket/adminHandlers.js) on the real
 * auth handlers and game manager, every emit checked by the contract guard:
 *
 *   - the authorization matrix: every action x {signed out, non-admin,
 *     admin removed mid-session, merged tombstone, stale socket, revoked
 *     session, deleted account, admin}; a refusal is byte-identical for
 *     every action and target (no account information), with no side
 *     effects;
 *   - audit: each request writes exactly one entry with the right fields
 *     and no secret; the reset token appears in no log line and no audit
 *     entry;
 *   - sign out everywhere, reset links, merges from the panel (preview ==
 *     apply, a stale preview refused, typed confirmation, the tombstone
 *     redirect afterwards), reports, admins and the last-admin guard;
 *   - isAdmin on signInResponse / restoreSessionResponse (display only).
 */

const bcrypt = require('bcryptjs');
const Transport = require('winston-transport');
const { createMemoryDb, enableSort } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    getPasswordResetsCollection: () => mockDb.current.passwordResets,
    getAdminAuditCollection: () => mockDb.current.adminAudit,
    whenReady: async () => true
}));

const gameManager = require('../../game/GameManager');
const auth = require('../authHandlers');
const admin = require('../adminHandlers');
const { asyncHandler, rateLimiter } = require('../errorHandler');
const { logger } = require('../../utils/logger');
const { world } = require('../../testUtils/contractScenarios');
const { hashToken } = require('../../utils/sessionTokens');
const { ADMIN_ACTIONS } = require('../../admin/actions');

afterAll(() => rateLimiter.shutdown());

// Every log line of the process, as text (the token must be in none of them)
const logLines = [];
class Capture extends Transport {
    log(info, cb) {
        logLines.push(JSON.stringify(info));
        cb();
    }
}
// every level (debug included) reaches the capture; the console stays at its own level
const capture = new Capture({ level: 'debug' });
let savedLevel;
let consoleLevels;
beforeAll(() => {
    savedLevel = logger.level;
    consoleLevels = logger.transports.map(t => [t, t.level]);
    for (const [t] of consoleLevels) t.level = savedLevel;
    logger.level = 'debug';
    logger.add(capture);
    enableSort(true);
});
afterAll(() => {
    logger.remove(capture);
    logger.level = savedLevel;
    for (const [t, l] of consoleLevels) t.level = l;
    enableSort(false);
});

let w;
let n = 0;
let PW;

beforeEach(async () => {
    PW = await bcrypt.hash('pw', 4);
    mockDb.current = createMemoryDb({
        users: [
            { username: 'Owner', password: PW, isAdmin: true, stats: { gamesPlayed: 4 } },
            { username: 'Bea', password: PW, stats: { gamesPlayed: 2 } },
            { username: 'Cy', password: PW },
            { username: 'Old', mergedInto: 'Bea', mergedAt: new Date() }
        ]
    });
    gameManager.currentUsers = [];
    require('../signInThrottle')._reset();
    w = world('adm');
    for (const id of [...rateLimiterKeys()]) rateLimiter.clearSocket(id);
});

function* rateLimiterKeys() {
    for (let i = 0; i <= n; i++) yield `adm-${i}`;
}

const users = () => mockDb.current.users;
const audit = () => mockDb.current.adminAudit.all();

/** A socket signed in with the real signIn (socketId, sessionHash, registered). */
async function signedIn(username) {
    const s = w.socket(`adm-${++n}`);
    await auth.signIn(s, w.io, { username, password: 'pw' });
    const res = w.log.filter(l => l.to === `self:${s.id}` && l.event === 'signInResponse').pop().data;
    expect(res.success).toBe(true);
    s.sessionToken = res.sessionToken;
    return s;
}

let rid = 0;
/** Send one adminRequest through the real wrapper; resolve its adminResponse. */
async function request(socket, action, args) {
    const requestId = `r-${++rid}`;
    const payload = args === undefined ? { requestId, action } : { requestId, action, args };
    await asyncHandler('adminRequest', admin.adminRequest)(socket, w.io, payload);
    const replies = w.log.filter(l => l.to === `self:${socket.id}` && l.event === 'adminResponse' && l.data.requestId === requestId);
    expect(replies).toHaveLength(1);
    return replies[0].data;
}

// Valid arguments for every action (targets that exist)
const ARGS = {
    searchPlayers: { query: 'Be' },
    createResetLink: { username: 'Bea' },
    signOutEverywhere: { username: 'Bea' },
    findDuplicates: {},
    planMerge: { target: 'Bea', sources: ['Cy'] },
    applyMerge: { target: 'Bea', sources: ['Cy'], planHash: 'a'.repeat(64), confirm: 'Bea' },
    listReports: { status: 'all' },
    resolveReport: { id: 'a'.repeat(24), status: 'resolved', note: 'x' },
    listAdmins: {},
    setAdmin: { username: 'Bea', isAdmin: true },
    listAudit: {}
};
// The same with a target that does not exist
const MISSING = {
    ...ARGS,
    createResetLink: { username: 'Nobody' },
    signOutEverywhere: { username: 'Nobody' },
    planMerge: { target: 'Nobody', sources: ['Ghost'] },
    applyMerge: { target: 'Nobody', sources: ['Ghost'], planHash: 'b'.repeat(64), confirm: 'Nobody' },
    setAdmin: { username: 'Nobody', isAdmin: true },
    searchPlayers: { query: 'Nobody' }
};

test('the action list is the contract\'s and the handlers\'', () => {
    expect(admin.ACTIONS).toEqual([...ADMIN_ACTIONS]);
    expect(Object.keys(ARGS)).toEqual([...ADMIN_ACTIONS]);
});

describe('authorization matrix', () => {
    // Each state: build a socket that must be refused. `why` names the check
    const STATES = {
        'signed out': async () => w.socket(`adm-${++n}`),
        'non-admin': async () => signedIn('Bea'),
        'admin removed mid-session': async () => {
            const s = await signedIn('Owner');
            await users().updateOne({ username: 'Owner' }, { $unset: { isAdmin: '' } });
            return s;
        },
        'merged tombstone (flag and sessions left on it)': async () => {
            const s = await signedIn('Owner');
            await users().updateOne({ username: 'Owner' }, { $set: { mergedInto: 'Bea' } });
            return s;
        },
        'stale socket (a newer socket restored the same session)': async () => {
            const s = await signedIn('Owner');
            const newer = w.socket(`adm-${++n}`);
            await auth.restoreSession(newer, w.io, { username: 'Owner', sessionToken: s.sessionToken });
            expect((await users().findOne({ username: 'Owner' })).socketId).toBe(newer.id);
            return s;
        },
        'not the account\'s current socket (registered by a game rejoin, the session restored elsewhere)': async () => {
            const s = await signedIn('Owner');
            const rejoined = w.socket(`adm-${++n}`);
            rejoined.data.sessionHash = s.data.sessionHash; // rejoinGame's verifySession sets it
            gameManager.registerUser(rejoined.id, 'Owner'); // seatLifecycle does, without users.socketId
            return rejoined;
        },
        'revoked session (set-password signed every device out, socket still open)': async () => {
            const s = await signedIn('Owner');
            await users().updateOne({ username: 'Owner' }, { $unset: { sessionTokens: '', sessionToken: '' } });
            return s;
        },
        'registered socket with no session hash': async () => {
            const s = w.socket(`adm-${++n}`);
            gameManager.registerUser(s.id, 'Owner');
            await users().updateOne({ username: 'Owner' }, { $set: { socketId: s.id, sessionTokens: [{ hash: hashToken('t'), createdAt: new Date(), lastUsedAt: new Date() }] } });
            return s;
        },
        'deleted account (socket still registered)': async () => {
            const s = await signedIn('Owner');
            await users().deleteOne({ username: 'Owner' });
            return s;
        }
    };

    for (const [state, make] of Object.entries(STATES)) {
        test(`${state}: every action gets the one uniform refusal, nothing changes`, async () => {
            const s = await make();
            const before = JSON.stringify({ u: users().all(), r: mockDb.current.reports.all(), p: mockDb.current.passwordResets.all() });
            const shapes = new Set();
            for (const action of ADMIN_ACTIONS) {
                for (const args of [ARGS[action], MISSING[action], { junk: 1 }]) {
                    const res = await request(s, action, args);
                    const { requestId, ...rest } = res;
                    expect(rest).toEqual({ action, ok: false, error: 'forbidden', message: admin.FORBIDDEN_MESSAGE });
                    shapes.add(JSON.stringify({ ...rest, action: null }));
                }
            }
            expect(shapes.size).toBe(1); // existing and missing targets look the same
            expect(JSON.stringify({ u: users().all(), r: mockDb.current.reports.all(), p: mockDb.current.passwordResets.all() })).toBe(before);
            // forbidden attempts are audited by name; a signed-out socket has none
            const entries = audit();
            expect(entries.every(e => e.result === 'forbidden' && e.target === null && e.detail === 'not an admin')).toBe(true);
            // no name to log: never signed in, or replaced by the newer socket in the registry
            if (state === 'signed out' || state.startsWith('stale socket')) expect(entries).toEqual([]);
            else expect(entries).toHaveLength(ADMIN_ACTIONS.length * 3);
        });
    }

    test('an admin is authorized for every action (no forbidden reply)', async () => {
        const s = await signedIn('Owner');
        for (const action of ADMIN_ACTIONS) {
            const res = await request(s, action, ARGS[action]);
            expect({ action, error: res.error }).not.toEqual({ action, error: 'forbidden' });
        }
    });

    test('the flag is read at request time: granted mid-session works at once, removed fails at once', async () => {
        const s = await signedIn('Bea');
        expect((await request(s, 'listAdmins', {})).error).toBe('forbidden');
        await users().updateOne({ username: 'Bea' }, { $set: { isAdmin: true } });
        expect((await request(s, 'listAdmins', {})).ok).toBe(true);
        await users().updateOne({ username: 'Bea' }, { $set: { isAdmin: 'yes' } }); // only the boolean true counts
        expect((await request(s, 'listAdmins', {})).error).toBe('forbidden');
    });

    test('a client cannot claim the flag: isAdmin in the payload or on socket.data changes nothing', async () => {
        const s = await signedIn('Bea');
        s.data.isAdmin = true;
        const res = await request(s, 'setAdmin', { username: 'Bea', isAdmin: true, asAdmin: true });
        expect(res.error).toBe('forbidden');
        expect((await users().findOne({ username: 'Bea' })).isAdmin).toBeUndefined();
    });

    test('bad envelopes are the wrapper\'s validation error; bad args (admins only) are invalid', async () => {
        const s = await signedIn('Owner');
        await asyncHandler('adminRequest', admin.adminRequest)(s, w.io, { requestId: 'x', action: 'dropDatabase' });
        expect(w.log.filter(l => l.event === 'error').pop().data).toMatchObject({ type: 'validation', handler: 'adminRequest' });
        const res = await request(s, 'setAdmin', { username: 'Bea', isAdmin: 'true' });
        expect(res).toMatchObject({ ok: false, error: 'invalid' });
        expect(audit().pop()).toMatchObject({ actor: 'Owner', action: 'setAdmin', result: 'failed', detail: 'invalid request' });
    });
});

describe('isAdmin on the sign-in replies (display only)', () => {
    test('present and true for an admin, absent otherwise', async () => {
        const o = await signedIn('Owner');
        const b = await signedIn('Bea');
        const reply = (s, ev) => w.log.filter(l => l.to === `self:${s.id}` && l.event === ev).pop().data;
        expect(reply(o, 'signInResponse').isAdmin).toBe(true);
        expect('isAdmin' in reply(b, 'signInResponse')).toBe(false);
        const r = w.socket(`adm-${++n}`);
        await auth.restoreSession(r, w.io, { username: 'Owner', sessionToken: o.sessionToken });
        expect(reply(r, 'restoreSessionResponse')).toMatchObject({ success: true, isAdmin: true });
        const rb = w.socket(`adm-${++n}`);
        await auth.restoreSession(rb, w.io, { username: 'Bea', sessionToken: b.sessionToken });
        expect('isAdmin' in reply(rb, 'restoreSessionResponse')).toBe(false);
    });
});

describe('actions', () => {
    let owner;
    beforeEach(async () => {
        owner = await signedIn('Owner');
    });

    test('every request writes exactly one audit entry with who, what, target, when, result (listAudit none)', async () => {
        const cases = [
            ['searchPlayers', { query: 'Bea' }, null, 'ok'],
            ['createResetLink', { username: 'Bea' }, 'Bea', 'ok'],
            ['createResetLink', { username: 'Old' }, 'Old', 'failed'],
            ['signOutEverywhere', { username: 'Cy' }, 'Cy', 'ok'],
            ['findDuplicates', {}, null, 'ok'],
            ['planMerge', { target: 'Bea', sources: ['Cy'] }, 'Bea', 'ok'],
            ['applyMerge', { target: 'Bea', sources: ['Cy'], planHash: 'a'.repeat(64), confirm: 'nope' }, 'Bea', 'failed'],
            ['listReports', {}, null, 'ok'],
            ['resolveReport', { id: 'a'.repeat(24), status: 'resolved' }, 'a'.repeat(24), 'failed'],
            ['listAdmins', {}, null, 'ok'],
            ['setAdmin', { username: 'Cy', isAdmin: true }, 'Cy', 'ok'],
            ['setAdmin', { username: 'Nobody', isAdmin: true }, 'Nobody', 'failed']
        ];
        for (const [action, args, target, result] of cases) {
            const before = audit().length;
            const t0 = Date.now();
            await request(owner, action, args);
            const after = audit();
            expect({ action, added: after.length - before }).toEqual({ action, added: 1 });
            const e = after[after.length - 1];
            expect(e).toMatchObject({ actor: 'Owner', action, target, result });
            expect(e.at.getTime()).toBeGreaterThanOrEqual(t0 - 5);
        }
        const before = audit().length;
        const page = await request(owner, 'listAudit', { limit: 100 });
        expect(audit().length).toBe(before);
        expect(page.entries).toHaveLength(before);
        expect(page.entries[0].action).toBe('setAdmin'); // newest first
    });

    test('reset link: the token goes to the admin once and nowhere else (no log, no audit, stored hashed)', async () => {
        const res = await request(owner, 'createResetLink', { username: 'Bea' });
        expect(res).toMatchObject({ ok: true, username: 'Bea', token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
        expect(new Date(res.expiresAt).getTime() - Date.now()).toBeGreaterThan(23.9 * 3600 * 1000);
        const { token } = res;
        expect(logLines.length).toBeGreaterThan(0);
        expect(logLines.filter(l => l.includes(token))).toEqual([]);
        expect(JSON.stringify(audit())).not.toContain(token);
        expect(JSON.stringify(mockDb.current.passwordResets.all())).not.toContain(token);
        expect(JSON.stringify(users().all())).not.toContain(token);
        expect(audit().pop().detail).toMatch(/^link valid until /);
        // a second link revokes the first
        const again = await request(owner, 'createResetLink', { username: 'Bea' });
        expect(again.token).not.toBe(token);
        expect(audit().pop().detail).toMatch(/1 older link\(s\) revoked/);
        // never for a tombstone or an unknown name
        expect(await request(owner, 'createResetLink', { username: 'Old' })).toMatchObject({ ok: false, error: 'refused' });
        expect(await request(owner, 'createResetLink', { username: 'nobody' })).toMatchObject({ ok: false, error: 'not_found' });
    });

    test('sign out everywhere: sessions revoked, the live socket gets forceLogout and is closed, its token no longer restores', async () => {
        const bea = await signedIn('Bea');
        require('../mainRoomHandlers').joinMainRoom(bea, w.io);
        expect(gameManager.mainRoomSocketIds.has(bea.id)).toBe(true);
        const res = await request(owner, 'signOutEverywhere', { username: 'Bea' });
        expect(res).toMatchObject({ ok: true, username: 'Bea', revokedSessions: 1, disconnected: 1 });
        expect(w.log.filter(l => l.to === `self:${bea.id}`).map(l => l.event)).toContain('forceLogout');
        expect(w.io.sockets.sockets.has(bea.id)).toBe(false);
        expect(gameManager.mainRoomSocketIds.has(bea.id)).toBe(false);
        expect(gameManager.getUserBySocketId(bea.id)).toBeUndefined();
        const doc = await users().findOne({ username: 'Bea' });
        expect(doc.sessionTokens).toBeUndefined();
        const again = w.socket(`adm-${++n}`);
        await auth.restoreSession(again, w.io, { username: 'Bea', sessionToken: bea.sessionToken });
        expect(w.log.filter(l => l.event === 'restoreSessionResponse').pop().data).toMatchObject({ success: false });
        expect(audit().pop()).toMatchObject({ action: 'signOutEverywhere', target: 'Bea', result: 'ok', detail: '1 saved session(s) revoked, 1 live connection(s) signed out' });
        expect(await request(owner, 'signOutEverywhere', { username: 'Old' })).toMatchObject({ ok: false, error: 'refused' });
    });

    test('search: rows for admins, tombstones marked, no password data', async () => {
        const res = await request(owner, 'searchPlayers', { query: 'O' });
        expect(res.players.map(p => [p.username, p.isAdmin, p.mergedInto, p.online])).toEqual([
            ['Owner', true, null, true],
            ['Old', false, 'Bea', false]
        ]);
        expect(JSON.stringify(res)).not.toMatch(/\$2[ab]\$|hash/i);
    });

    describe('merge from the panel', () => {
        beforeEach(async () => {
            await users().updateOne({ username: 'Cy' }, { $set: { stats: { gamesPlayed: 3, wins: 1 } } });
            await mockDb.current.gameRecords.insertOne({ gameId: 'g1', team1Players: ['Cy', 'x'], team2Players: ['y', 'z'], completedAt: new Date() });
        });

        test('preview, typed confirmation, apply == preview; the tombstone redirects at sign-in', async () => {
            const cy = await signedIn('Cy');
            const prev = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            expect(prev).toMatchObject({ ok: true, plan: { target: 'Bea', sources: ['Cy'], errors: [], retire: ['Cy'] } });
            expect(prev.plan.accounts.find(a => a.role === 'result').stats.gamesPlayed).toBe(5);

            const wrong = await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: prev.planHash, confirm: 'bea' });
            expect(wrong).toMatchObject({ ok: false, error: 'invalid' });
            expect((await users().findOne({ username: 'Cy' })).mergedInto).toBeUndefined();

            const done = await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: prev.planHash, confirm: 'Bea' });
            expect(done).toMatchObject({ ok: true, result: { target: 'Bea', retired: prev.plan.retire, statsMerged: ['Cy'], gameRecords: prev.plan.gameRecords.length, reports: prev.plan.reports.length, otherUsersBlocks: prev.plan.otherUsersBlocks.length, signedOut: 1 } });
            const bea = await users().findOne({ username: 'Bea' });
            expect(bea.stats.gamesPlayed).toBe(prev.plan.accounts.find(a => a.role === 'result').stats.gamesPlayed);
            expect(mockDb.current.gameRecords.all()[0].team1Players).toEqual(prev.plan.gameRecords[0].after.team1);
            // Cy's live socket was signed out; signing in as Cy now names the kept account
            expect(w.log.filter(l => l.to === `self:${cy.id}`).map(l => l.event)).toContain('forceLogout');
            const s = w.socket(`adm-${++n}`);
            await auth.signIn(s, w.io, { username: 'Cy', password: 'pw' });
            expect(w.log.filter(l => l.event === 'signInResponse').pop().data).toEqual({ success: false, message: '"Cy" was combined into your account "Bea". Please sign in as Bea.' });
            // and the same merge again: nothing to do
            const replan = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            expect(replan.plan.changeCount).toBe(0);
            expect(await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: replan.planHash, confirm: 'Bea' })).toMatchObject({ ok: false, error: 'refused' });
        });

        test('a preview that went stale (data changed after it) is refused and nothing is written', async () => {
            const prev = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            await mockDb.current.gameRecords.insertOne({ gameId: 'g2', team1Players: ['Cy', 'q'], team2Players: ['r', 's'], completedAt: new Date() });
            const before = JSON.stringify([users().all(), mockDb.current.gameRecords.all()]);
            const res = await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: prev.planHash, confirm: 'Bea' });
            expect(res).toMatchObject({ ok: false, error: 'stale_plan' });
            expect(JSON.stringify([users().all(), mockDb.current.gameRecords.all()])).toBe(before);
            expect(audit().pop()).toMatchObject({ action: 'applyMerge', result: 'failed' });
        });

        test('plan errors are shown, not applied; an admin source is refused', async () => {
            await users().updateOne({ username: 'Cy' }, { $set: { isAdmin: true } });
            const prev = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            expect(prev.plan.errors.join(' ')).toMatch(/is an admin/);
            const res = await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: prev.planHash, confirm: 'Bea' });
            expect(res).toMatchObject({ ok: false, error: 'refused' });
        });

        test('find duplicates lists look-alike groups', async () => {
            await users().insertOne({ username: 'bea2', stats: { gamesPlayed: 1 } });
            const res = await request(owner, 'findDuplicates', {});
            expect(res.groups.map(g => g.map(u => u.username))).toEqual([['Bea', 'bea2']]);
        });
    });

    test('reports: list newest first, resolve with a note, a second resolve is refused', async () => {
        await mockDb.current.reports.insertOne({ reporter: 'Bea', reported: 'Cy', reason: 'spam', context: 'chat', createdAt: new Date(Date.now() - 1000) });
        await mockDb.current.reports.insertOne({ reporter: 'Cy', reported: 'Bea', reason: 'rude', createdAt: new Date() });
        const list = await request(owner, 'listReports', {});
        expect(list.reports.map(r => r.reason)).toEqual(['rude', 'spam']);
        const res = await request(owner, 'resolveReport', { id: list.reports[1].id, status: 'resolved', note: 'warned them' });
        expect(res.report).toMatchObject({ status: 'resolved', resolvedBy: 'Owner', note: 'warned them', reported: 'Cy' });
        expect(audit().pop()).toMatchObject({ action: 'resolveReport', target: 'Cy', result: 'ok' });
        expect((await request(owner, 'listReports', {})).reports.map(r => r.reason)).toEqual(['rude']);
        expect(await request(owner, 'resolveReport', { id: list.reports[1].id, status: 'dismissed' })).toMatchObject({ ok: false, error: 'refused' });
    });

    test('admins: make and remove; the last admin cannot remove their own flag', async () => {
        expect(await request(owner, 'setAdmin', { username: 'Owner', isAdmin: false })).toMatchObject({ ok: false, error: 'last_admin' });
        expect((await users().findOne({ username: 'Owner' })).isAdmin).toBe(true);
        expect(await request(owner, 'setAdmin', { username: 'Bea', isAdmin: true })).toMatchObject({ ok: true, isAdmin: true, changed: true });
        expect((await request(owner, 'listAdmins', {})).admins.map(a => a.username)).toEqual(['Bea', 'Owner']);
        expect(await request(owner, 'setAdmin', { username: 'Bea', isAdmin: false })).toMatchObject({ ok: true, isAdmin: false, changed: true });
        expect(await request(owner, 'setAdmin', { username: 'Old', isAdmin: true })).toMatchObject({ ok: false, error: 'refused' });
        // with a second admin, removing yourself works, and the next request is refused
        await request(owner, 'setAdmin', { username: 'Bea', isAdmin: true });
        expect(await request(owner, 'setAdmin', { username: 'Owner', isAdmin: false })).toMatchObject({ ok: true, changed: true });
        expect((await request(owner, 'listAdmins', {})).error).toBe('forbidden');
    });

    test('a database failure mid-action is a generic server refusal, audited, nothing leaked', async () => {
        const real = mockDb.current.reports.find;
        mockDb.current.reports.find = () => { throw new Error('connection reset by peer 10.0.0.5'); };
        const res = await request(owner, 'listReports', {});
        mockDb.current.reports.find = real;
        expect(res).toMatchObject({ ok: false, error: 'server' });
        expect(res.message).not.toMatch(/10\.0\.0\.5/);
        expect(audit().pop()).toMatchObject({ action: 'listReports', result: 'failed', detail: 'server error' });
    });
});
