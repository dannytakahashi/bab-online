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
    admin._resetForbiddenGate();
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

/** Another tab restored from `token` (the web client copies the saved session into every new tab). */
async function restoredTab(username, token) {
    const s = w.socket(`adm-${++n}`);
    await auth.restoreSession(s, w.io, { username, sessionToken: token });
    const res = w.log.filter(l => l.to === `self:${s.id}` && l.event === 'restoreSessionResponse').pop().data;
    expect(res.success).toBe(true);
    return s;
}

const gotEvent = (s, event) => w.log.some(l => l.to === `self:${s.id}` && l.event === event);

/** The next write of `coll` waits at the gate (it has not happened yet when `reached` resolves). */
function holdNextWrite(coll, method = 'updateOne') {
    const own = Object.prototype.hasOwnProperty.call(coll, method);
    const original = coll[method];
    let release;
    let reached;
    const gate = new Promise(r => { release = r; });
    const reachedP = new Promise(r => { reached = r; });
    coll[method] = async function (...args) {
        if (own) coll[method] = original; else delete coll[method];
        reached();
        await gate;
        return original.apply(coll, args);
    };
    return { reached: reachedP, release };
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
    listAudit: {},
    listPlayers: {},
    deleteAccount: { username: 'Cy', confirm: 'Cy' },
    renameAccount: { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' }
};
// The same with a target that does not exist
const MISSING = {
    ...ARGS,
    createResetLink: { username: 'Nobody' },
    signOutEverywhere: { username: 'Nobody' },
    planMerge: { target: 'Nobody', sources: ['Ghost'] },
    applyMerge: { target: 'Nobody', sources: ['Ghost'], planHash: 'b'.repeat(64), confirm: 'Nobody' },
    setAdmin: { username: 'Nobody', isAdmin: true },
    searchPlayers: { query: 'Nobody' },
    deleteAccount: { username: 'Nobody', confirm: 'Nobody' },
    renameAccount: { username: 'Nobody', newName: 'Ghost1', confirm: 'Ghost1' }
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
            // one per action: the repeats in the coalescing window are only counted
            else expect(entries.map(e => e.action)).toEqual([...ADMIN_ACTIONS]);
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
        expect(doc.sessionEpoch).toBe(1); // a restore in flight cannot write them back
        const again = w.socket(`adm-${++n}`);
        await auth.restoreSession(again, w.io, { username: 'Bea', sessionToken: bea.sessionToken });
        expect(w.log.filter(l => l.event === 'restoreSessionResponse').pop().data).toMatchObject({ success: false });
        expect(audit().pop()).toMatchObject({ action: 'signOutEverywhere', target: 'Bea', result: 'ok', detail: '1 saved session(s) revoked, 1 live connection(s) signed out' });
        expect(await request(owner, 'signOutEverywhere', { username: 'Old' })).toMatchObject({ ok: false, error: 'refused' });
    });

    test('sign out everywhere reaches EVERY tab of the player, including one restored from the same saved session (RST-DUPSOCK)', async () => {
        const mainRoom = require('../mainRoomHandlers');
        const first = await signedIn('Bea');
        mainRoom.joinMainRoom(first, w.io);
        const second = await restoredTab('Bea', first.sessionToken);
        mainRoom.joinMainRoom(second, w.io);
        // one game-manager entry per name, and users.socketId: only the second tab
        expect(gameManager.getUserBySocketId(first.id)).toBeUndefined();
        expect((await users().findOne({ username: 'Bea' })).socketId).toBe(second.id);
        expect(gameManager.mainRoomSocketIds.has(first.id)).toBe(true);

        const res = await request(owner, 'signOutEverywhere', { username: 'Bea' });
        expect(res).toMatchObject({ ok: true, disconnected: 2 });
        for (const s of [first, second]) {
            expect(gotEvent(s, 'forceLogout')).toBe(true);
            expect(w.io.sockets.sockets.has(s.id)).toBe(false);
            expect(gameManager.mainRoomSocketIds.has(s.id)).toBe(false);
        }
        expect([...(w.io.rooms.get('mainRoom') || [])]).not.toEqual(expect.arrayContaining([first.id]));
        // nobody else was touched
        expect(w.io.sockets.sockets.has(owner.id)).toBe(true);
    });

    test('search: rows for admins, tombstones marked, no password data', async () => {
        const res = await request(owner, 'searchPlayers', { query: 'O' });
        expect(res.players.map(p => [p.username, p.isAdmin, p.mergedInto, p.online])).toEqual([
            ['Owner', true, null, true],
            ['Old', false, 'Bea', false]
        ]);
        expect(JSON.stringify(res)).not.toMatch(/\$2[ab]\$|hash/i);
    });

    test('players table: every account newest first, tombstones marked, the true total, no password or session data', async () => {
        const res = await request(owner, 'listPlayers', {});
        expect(res).toMatchObject({ ok: true, total: 4, limit: 500 });
        // newest first: the fixture inserts Owner, Bea, Cy, Old in that order
        expect(res.players.map(p => p.username)).toEqual(['Old', 'Cy', 'Bea', 'Owner']);
        expect(res.players[0]).toMatchObject({ mergedInto: 'Bea', isAdmin: false, online: false, gamesPlayed: 0, lastSeenAt: null });
        expect(res.players[3]).toMatchObject({ username: 'Owner', isAdmin: true, online: true, gamesPlayed: 4, mergedInto: null });
        expect(res.players[3].lastSeenAt).toEqual(expect.any(String));
        expect(Object.keys(res.players[3]).sort()).toEqual(['createdAt', 'gamesPlayed', 'isAdmin', 'lastSeenAt', 'mergedInto', 'online', 'renameUnfinished', 'renamed', 'username']);
        expect(JSON.stringify(res)).not.toMatch(/\$2[ab]\$|hash|socketId|sessionToken|password/i);
        expect(audit().pop()).toMatchObject({ actor: 'Owner', action: 'listPlayers', target: null, result: 'ok', detail: '4 of 4 account(s)' });
    });

    describe('delete from the panel', () => {
        const linksOf = (name) => mockDb.current.passwordResets.all().filter(l => l.username === name);
        beforeEach(async () => {
            await mockDb.current.gameRecords.insertOne({ gameId: 'g1', team1Players: ['Cy', 'Bea'], team2Players: ['y', 'z'], completedAt: new Date() });
            await mockDb.current.gameRecords.insertOne({ gameId: 'g2', team1Players: ['p', 'q'], team2Players: ['r', 'Cy'], completedAt: new Date() });
            await mockDb.current.reports.insertOne({ reporter: 'Cy', reported: 'Bea', reason: 'r1', createdAt: new Date() });
            await mockDb.current.reports.insertOne({ reporter: 'Bea', reported: 'Cy', reason: 'r2', createdAt: new Date() });
            await users().updateOne({ username: 'Bea' }, { $set: { blockedUsers: ['Cy', 'Zed'] } });
            await users().insertOne({ username: 'CyOld', mergedInto: 'Cy', mergedAt: new Date() });
        });

        test('a normal account: both tabs signed out, records anonymized, block lists and reset links cleaned, reports kept and marked, its tombstones gone; one audit entry; the name can be signed up again', async () => {
            const cy = await signedIn('Cy');
            const cy2 = await restoredTab('Cy', cy.sessionToken);
            const bea = await signedIn('Bea');
            expect(await request(owner, 'createResetLink', { username: 'Cy' })).toMatchObject({ ok: true });
            const auditBefore = audit().length;
            const res = await request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' });
            expect(res).toMatchObject({
                ok: true, username: 'Cy', kind: 'account', mergedInto: null,
                gameRecords: 2, reports: 2, blockLists: 1, resetLinks: 1, tombstones: 1, signedOut: 2
            });
            for (const s of [cy, cy2]) {
                expect(gotEvent(s, 'forceLogout')).toBe(true);
                expect(w.io.sockets.sockets.has(s.id)).toBe(false);
            }
            expect(w.io.sockets.sockets.has(owner.id)).toBe(true);
            expect(await users().findOne({ username: 'Cy' })).toBeNull();
            expect(await users().findOne({ username: 'CyOld' })).toBeNull();
            const records = mockDb.current.gameRecords.all();
            expect(records.map(r => [r.team1Players, r.team2Players])).toEqual([
                [['[deleted]', 'Bea'], ['y', 'z']],
                [['p', 'q'], ['r', '[deleted]']]
            ]);
            expect(JSON.stringify(records)).not.toContain('"Cy"');
            // the blocker's saved list and live voice list; the client is not
            // told (C1: iOS 1.1.0 would show a "Block list updated." alert;
            // a dead name in its list is harmless)
            expect((await users().findOne({ username: 'Bea' })).blockedUsers).toEqual(['Zed']);
            expect([...bea.data.blockedUsers]).toEqual(['Zed']);
            expect(gotEvent(bea, 'blockListUpdated')).toBe(false);
            expect(linksOf('Cy').map(l => l.state)).toEqual(['revoked']);
            // reports stay for the record, marked
            const reps = mockDb.current.reports.all();
            expect(reps.map(r => [r.reporter, r.reported, Boolean(r.reporterDeletedAt), Boolean(r.reportedDeletedAt)])).toEqual([
                ['Cy', 'Bea', true, false],
                ['Bea', 'Cy', false, true]
            ]);
            const rows = (await request(owner, 'listReports', { status: 'all' })).reports;
            expect(rows.find(r => r.reason === 'r2')).toMatchObject({ reported: 'Cy', reportedDeleted: true, reporterDeleted: false });
            expect(gameManager.deletedUsernames.has('Cy')).toBe(true);
            // exactly one audit entry for the delete, names and counts only
            const entries = audit().slice(auditBefore);
            expect(entries.filter(e => e.action === 'deleteAccount')).toHaveLength(1);
            expect(entries.find(e => e.action === 'deleteAccount')).toMatchObject({ actor: 'Owner', target: 'Cy', result: 'ok', detail: expect.stringMatching(/^account deleted: 2 game record/) });
            expect(JSON.stringify(entries)).not.toMatch(/\$2[ab]\$|hash|token/i);
            // the name is free: nothing clashes with it any more (a new
            // sign-up would need 3+ characters; the tombstone test signs one up)
            const { findNameClash } = require('../../utils/usernameRules');
            expect(await findNameClash(users(), 'Cy')).toBeNull();
            expect(await findNameClash(users(), 'CyOld')).toBeNull();
            gameManager.deletedUsernames.delete('Cy');
        });

        test('the typed name must match exactly; a wrong one changes nothing', async () => {
            const before = JSON.stringify(users().all());
            expect(await request(owner, 'deleteAccount', { username: 'Cy', confirm: 'cy' })).toMatchObject({ ok: false, error: 'invalid' });
            expect(JSON.stringify(users().all())).toBe(before);
            expect(audit().pop()).toMatchObject({ action: 'deleteAccount', target: 'Cy', result: 'failed' });
            expect(await request(owner, 'deleteAccount', { username: 'Nobody', confirm: 'Nobody' })).toMatchObject({ ok: false, error: 'not_found' });
        });

        test('a tombstone: only that document goes, the name is free, the kept account is untouched', async () => {
            const beaBefore = JSON.stringify(await users().findOne({ username: 'Bea' }));
            const res = await request(owner, 'deleteAccount', { username: 'Old', confirm: 'Old' });
            expect(res).toMatchObject({ ok: true, username: 'Old', kind: 'tombstone', mergedInto: 'Bea', gameRecords: 0, tombstones: 0, signedOut: 0 });
            expect(await users().findOne({ username: 'Old' })).toBeNull();
            expect(JSON.stringify(await users().findOne({ username: 'Bea' }))).toBe(beaBefore);
            expect(audit().pop()).toMatchObject({ action: 'deleteAccount', target: 'Old', result: 'ok', detail: expect.stringMatching(/tombstone deleted/) });
            const s = w.socket(`adm-${++n}`);
            await auth.signUp(s, w.io, { username: 'Old', password: 'pw' });
            expect(w.log.filter(l => l.to === `self:${s.id}` && l.event === 'signUpResponse').pop().data).toMatchObject({ success: true });
        });

        test('refused: an admin (remove the flag first), the acting admin (self-delete), nothing changed', async () => {
            await users().updateOne({ username: 'Bea' }, { $set: { isAdmin: true } });
            const before = JSON.stringify([users().all(), mockDb.current.gameRecords.all()]);
            const asAdmin = await request(owner, 'deleteAccount', { username: 'Bea', confirm: 'Bea' });
            expect(asAdmin).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/is an admin\. Remove their admin first/) });
            const self = await request(owner, 'deleteAccount', { username: 'Owner', confirm: 'Owner' });
            expect(self).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/your own account.*profile/) });
            expect(JSON.stringify([users().all(), mockDb.current.gameRecords.all()])).toBe(before);
            expect(w.io.sockets.sockets.has(owner.id)).toBe(true);
        });

        test('refused: a player in a game still in its draw (memory), or one the database shows in a game; nothing written, not signed out, not locked', async () => {
            const cy = await signedIn('Cy');
            const others = ['P1', 'P2', 'P3'].map((u, i) => w.user(`adm-dg${i}-${n}`, u));
            const game = gameManager.createGame([cy.id, ...others.map(o => o.id)]);
            expect((await users().findOne({ username: 'Cy' })).activeGameId).toBeUndefined();
            const before = JSON.stringify([users().all(), mockDb.current.gameRecords.all()]);
            const res = await request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' });
            expect(res).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/"Cy" is in a game right now/) });
            expect(JSON.stringify([users().all(), mockDb.current.gameRecords.all()])).toBe(before);
            expect(gotEvent(cy, 'forceLogout')).toBe(false);
            expect(gameManager.isMergeLocked('Cy')).toBe(false);
            gameManager.abortGame(game.gameId, w.io);
            await users().updateOne({ username: 'Cy' }, { $set: { activeTournamentId: 't-elsewhere' } });
            expect(await request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' })).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/in a tournament/) });
            await users().updateOne({ username: 'Cy' }, { $unset: { activeTournamentId: '' } });
            expect(await request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' })).toMatchObject({ ok: true, kind: 'account' });
        });

        test('while it runs the name is locked and signed out; an account made an admin before the guarded write is refused and kept', async () => {
            const cy = await signedIn('Cy');
            const hold = holdNextWrite(users(), 'findOneAndUpdate'); // the lock-down write
            const pending = request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' });
            try {
                await hold.reached;
                expect(gotEvent(cy, 'forceLogout')).toBe(true);
                expect(gameManager.isMergeLocked('Cy')).toBe(true);
                const s = w.socket(`adm-${++n}`);
                await auth.signIn(s, w.io, { username: 'Cy', password: 'pw' });
                expect(w.log.filter(l => l.to === `self:${s.id}` && l.event === 'signInResponse').pop().data)
                    .toEqual({ success: false, message: auth.MERGE_LOCKED_MESSAGE });
                // another admin makes Cy an admin meanwhile (e.g. the CLI)
                await users().updateOne({ username: 'Cy' }, { $set: { isAdmin: true } });
            } finally {
                hold.release();
            }
            expect(await pending).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/changed while this ran/) });
            expect(gameManager.isMergeLocked('Cy')).toBe(false);
            const doc = await users().findOne({ username: 'Cy' });
            expect(doc).toMatchObject({ username: 'Cy', isAdmin: true });
            expect(mockDb.current.gameRecords.all()[0].team1Players).toEqual(['Cy', 'Bea']);
        });

        test('a failure partway says the account is not deleted yet; deleting again finishes it', async () => {
            const original = mockDb.current.gameRecords.updateMany;
            mockDb.current.gameRecords.updateMany = async () => { throw new Error('disk on fire'); };
            let res;
            try {
                res = await request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' });
            } finally {
                mockDb.current.gameRecords.updateMany = original;
            }
            expect(res).toMatchObject({ ok: false, error: 'server', message: expect.stringMatching(/stopped partway: "Cy" is signed out everywhere but not deleted yet\. Delete again/) });
            expect(JSON.stringify(res)).not.toContain('disk on fire');
            expect(await users().findOne({ username: 'Cy' })).not.toBeNull();
            expect(gameManager.isMergeLocked('Cy')).toBe(false);
            expect(await request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' })).toMatchObject({ ok: true, gameRecords: 2 });
            expect(await users().findOne({ username: 'Cy' })).toBeNull();
        });

        test('a delete sent while a merge of the same name is running waits for it (the merge queue): it then finds a tombstone; never stats merged from a deleted account', async () => {
            await users().updateOne({ username: 'Cy' }, { $set: { stats: { gamesPlayed: 3, wins: 1 } } });
            const plan = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            const hold = holdNextWrite(mockDb.current.gameRecords); // the merge's first write
            const merging = request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: plan.planHash, confirm: 'Bea' });
            let deleting;
            try {
                await hold.reached;
                deleting = request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' });
                await new Promise(r => setTimeout(r, 20)); // the delete gets as far as it can
                expect(await users().findOne({ username: 'Cy' })).not.toBeNull(); // it is waiting, not erasing
            } finally {
                hold.release();
            }
            const [m, d] = await Promise.all([merging, deleting]);
            expect(m).toMatchObject({ ok: true, result: { retired: ['Cy'], statsMerged: ['Cy'] } });
            expect(d).toMatchObject({ ok: true, kind: 'tombstone', mergedInto: 'Bea' });
            expect((await users().findOne({ username: 'Bea' })).stats.gamesPlayed).toBe(5);
            expect(await users().findOne({ username: 'Cy' })).toBeNull();
        });

        test('the player\'s own Delete account runs the same deletion: block lists, reset links, reports, tombstones, every other tab signed out', async () => {
            const cy = await signedIn('Cy');
            const cy2 = await restoredTab('Cy', cy.sessionToken);
            gameManager.registerUser(cy.id, 'Cy'); // the tab that asks is the registered one
            expect(await request(owner, 'createResetLink', { username: 'Cy' })).toMatchObject({ ok: true });
            jest.useFakeTimers();
            try {
                await auth.deleteAccount(cy, w.io, { password: 'pw' });
            } finally {
                jest.useRealTimers();
            }
            expect(w.log.filter(l => l.to === `self:${cy.id}` && l.event === 'deleteAccountResponse').pop().data).toEqual({ success: true });
            expect(gotEvent(cy, 'forceLogout')).toBe(false); // the asking tab gets its reply, then closes
            expect(gotEvent(cy2, 'forceLogout')).toBe(true);
            expect(await users().findOne({ username: 'Cy' })).toBeNull();
            expect(await users().findOne({ username: 'CyOld' })).toBeNull();
            // other players' blocks of the name stay (BLK-EVADE: deleting and
            // signing up again as Cy must not clear them)
            expect((await users().findOne({ username: 'Bea' })).blockedUsers).toEqual(['Cy', 'Zed']);
            expect(linksOf('Cy').map(l => l.state)).toEqual(['revoked']);
            expect(mockDb.current.reports.all().every(r => r.reporterDeletedAt || r.reportedDeletedAt)).toBe(true);
            expect(JSON.stringify(mockDb.current.gameRecords.all())).not.toContain('"Cy"');
            gameManager.deletedUsernames.delete('Cy');
        });
    });

    describe('rename from the panel', () => {
        const signInReply = async (username, password = 'pw') => {
            const s = w.socket(`adm-${++n}`);
            await auth.signIn(s, w.io, { username, password });
            return w.log.filter(l => l.to === `self:${s.id}` && l.event === 'signInResponse').pop().data;
        };
        /** Every place a string equal to `name` is stored, as "collection:username-or-id.path". */
        function scan(name) {
            const hits = [];
            const walk = (v, path, out) => {
                if (v === name) out.push(path);
                else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, out));
                else if (v && typeof v === 'object' && !(v instanceof Date) && !v._bsontype) {
                    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, out);
                }
            };
            for (const coll of ['users', 'gameRecords', 'reports', 'passwordResets']) {
                for (const doc of mockDb.current[coll].all()) {
                    const found = [];
                    walk({ ...doc, _id: undefined }, '', found);
                    for (const f of found) hits.push(`${coll}:${f}${coll === 'passwordResets' ? `(${doc.state})` : ''}`);
                }
            }
            return hits.sort();
        }
        beforeEach(async () => {
            await users().updateOne({ username: 'Cy' }, { $set: { stats: { gamesPlayed: 3, wins: 2, losses: 1, draws: 0, totalPoints: 300 }, blockedUsers: ['Zed'] } });
            await users().updateOne({ username: 'Bea' }, { $set: { blockedUsers: ['Cy', 'Zed'], adminSetBy: 'Cy' } });
            await mockDb.current.gameRecords.insertOne({ gameId: 'g1', team1Players: ['Cy', 'Bea'], team2Players: ['y', 'z'], completedAt: new Date() });
            await mockDb.current.gameRecords.insertOne({ gameId: 'g2', team1Players: ['p', 'q'], team2Players: ['r', 'Cy'], completedAt: new Date() });
            await mockDb.current.reports.insertOne({ reporter: 'Cy', reported: 'Bea', reason: 'r1', createdAt: new Date() });
            await mockDb.current.reports.insertOne({ reporter: 'Bea', reported: 'Cy', reason: 'r2', createdAt: new Date(), status: 'resolved', resolvedBy: 'Cy' });
            await users().insertOne({ username: 'CyOld', mergedInto: 'Cy', mergedAt: new Date() });
        });

        test('every place the name is a key moves (a full scan finds the old name only on the redirect and the link history); both tabs signed out, sessions revoked; the old name redirects; the new one signs in; the leaderboard shows it', async () => {
            const cy = await signedIn('Cy');
            const cy2 = await restoredTab('Cy', cy.sessionToken);
            const bea = await signedIn('Bea');
            expect(await request(owner, 'createResetLink', { username: 'Cy' })).toMatchObject({ ok: true });
            const auditBefore = audit().length;
            const res = await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' });
            expect(res).toMatchObject({
                ok: true, username: 'Cy', newName: 'Cyrus', resumed: false, oldNameKept: true,
                gameRecords: 2, reports: 3, otherUsersBlocks: 1, chainedTombstones: 1, adminSetBy: 1, resetLinks: 1, revokedSessions: 1, signedOut: 2
            });
            expect(scan('Cy')).toEqual(['passwordResets:username(revoked)', 'users:username']);
            expect(await users().findOne({ username: 'Cy' })).toMatchObject({ mergedInto: 'Cyrus', renamedBy: 'Owner', renamedAt: expect.any(Date) });
            const doc = await users().findOne({ username: 'Cyrus' });
            expect(doc).toMatchObject({ stats: { gamesPlayed: 3 }, blockedUsers: ['Zed'], sessionEpoch: 1 });
            expect(doc.sessionTokens).toBeUndefined();
            expect(doc.password).toBeDefined();
            expect(mockDb.current.gameRecords.all().map(r => [r.team1Players, r.team2Players])).toEqual([
                [['Cyrus', 'Bea'], ['y', 'z']], [['p', 'q'], ['r', 'Cyrus']]
            ]);
            expect(mockDb.current.reports.all().map(r => [r.reporter, r.reported, r.resolvedBy || null])).toEqual([
                ['Cyrus', 'Bea', null], ['Bea', 'Cyrus', 'Cyrus']
            ]);
            expect(await users().findOne({ username: 'Bea' })).toMatchObject({ blockedUsers: ['Cyrus', 'Zed'], adminSetBy: 'Cyrus' });
            expect(await users().findOne({ username: 'CyOld' })).toMatchObject({ mergedInto: 'Cyrus' });
            // the blocker's live socket has the new list (voice; the client's chat filter)
            expect([...bea.data.blockedUsers]).toEqual(['Cyrus', 'Zed']);
            expect(w.log.filter(l => l.to === `self:${bea.id}` && l.event === 'blockListUpdated').pop().data).toEqual({ success: true, blockedUsers: ['Cyrus', 'Zed'], silent: true });
            for (const s of [cy, cy2]) {
                expect(gotEvent(s, 'forceLogout')).toBe(true);
                expect(w.io.sockets.sockets.has(s.id)).toBe(false);
            }
            // the saved sign-in (username + token) stops working: the routine
            // reply, never the new name (REN-REDIRECT-DISCLOSE)
            const again = w.socket(`adm-${++n}`);
            await auth.restoreSession(again, w.io, { username: 'Cy', sessionToken: cy.sessionToken });
            expect(w.log.filter(l => l.to === `self:${again.id}` && l.event === 'restoreSessionResponse').pop().data)
                .toEqual({ success: false, message: 'Invalid session token' });
            const again2 = w.socket(`adm-${++n}`);
            await auth.restoreSession(again2, w.io, { username: 'Cyrus', sessionToken: cy.sessionToken });
            expect(w.log.filter(l => l.to === `self:${again2.id}` && l.event === 'restoreSessionResponse').pop().data).toMatchObject({ success: false });
            // the old name with the account's password is told the new one
            expect(await signInReply('Cy')).toEqual({ success: false, message: 'This account is now called Cyrus. Sign in as Cyrus.' });
            expect(await signInReply('Cyrus')).toMatchObject({ success: true, username: 'Cyrus' });
            // sign-up of the old name is refused (the redirect keeps the name)
            const up = w.socket(`adm-${++n}`);
            await auth.signUp(up, w.io, { username: 'CyOld', password: 'pw' });
            expect(w.log.filter(l => l.to === `self:${up.id}` && l.event === 'signUpResponse').pop().data.success).toBe(false);
            // the leaderboard (cache invalidated) shows the new name
            const profile = require('../profileHandlers');
            const lb = w.socket(`adm-${++n}`);
            await profile.getLeaderboard(lb, w.io);
            const board = w.log.filter(l => l.to === `self:${lb.id}` && l.event === 'leaderboardResponse').pop().data;
            expect(board.leaderboard.map(r => r.username)).toContain('Cyrus');
            expect(board.leaderboard.map(r => r.username)).not.toContain('Cy');
            // one audit entry, old -> new, no secret
            const entries = audit().slice(auditBefore).filter(e => e.action === 'renameAccount');
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ actor: 'Owner', target: 'Cy', result: 'ok', detail: expect.stringMatching(/^renamed Cy -> Cyrus: /) });
            expect(JSON.stringify(audit())).not.toMatch(/\$2[ab]\$|hash/i);
            // the table marks the redirect
            const list = await request(owner, 'listPlayers', {});
            expect(list.players.find(p => p.username === 'Cy')).toMatchObject({ mergedInto: 'Cyrus', renamed: true });
            expect(list.players.find(p => p.username === 'CyOld')).toMatchObject({ mergedInto: 'Cyrus', renamed: false });
            // and the admin can delete the redirect later, freeing the name
            expect(await request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' })).toMatchObject({ ok: true, kind: 'tombstone', mergedInto: 'Cyrus' });
        });

        test('the sign-up rules, taken ignoring case (tombstones too), a tombstone, the same name and a wrong confirmation are refused; nothing changes', async () => {
            const before = JSON.stringify([users().all(), mockDb.current.gameRecords.all(), mockDb.current.reports.all()]);
            const cases = [
                [{ newName: 'C', confirm: 'C' }, 'refused', /at least 3 characters/],
                [{ newName: ' Cyrus', confirm: ' Cyrus' }, 'refused', /start or end with a space/],
                [{ newName: 'Cy😀x', confirm: 'Cy😀x' }, 'refused', /emoji/],
                [{ newName: 'shit5', confirm: 'shit5' }, 'refused', /That username is not allowed/],
                [{ newName: 'bea', confirm: 'bea' }, 'refused', /That name is taken: "Bea" already exists/],
                [{ newName: 'BEA', confirm: 'BEA' }, 'refused', /taken/],
                [{ newName: 'old', confirm: 'old' }, 'refused', /an old name of "Bea"\. Delete that old name first/],
                [{ newName: 'Cyrus', confirm: 'cyrus' }, 'invalid', /exactly to confirm/],
                [{ newName: 'Cy', confirm: 'Cy' }, 'invalid', /same as the old one/],
                [{ newName: '', confirm: '' }, 'invalid', /exactly to confirm/]
            ];
            for (const [args, error, message] of cases) {
                const res = await request(owner, 'renameAccount', { username: 'Cy', ...args });
                expect({ args, res: { ok: res.ok, error: res.error } }).toEqual({ args, res: { ok: false, error } });
                expect(res.message).toMatch(message);
            }
            expect(await request(owner, 'renameAccount', { username: 'Old', newName: 'Olden', confirm: 'Olden' }))
                .toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/was merged into "Bea" and can't be renamed/) });
            expect(await request(owner, 'renameAccount', { username: 'Nobody', newName: 'Olden', confirm: 'Olden' })).toMatchObject({ ok: false, error: 'not_found' });
            expect(JSON.stringify([users().all(), mockDb.current.gameRecords.all(), mockDb.current.reports.all()])).toBe(before);
            expect(audit().pop()).toMatchObject({ action: 'renameAccount', result: 'failed' });
        });

        test('a case-only rename is allowed (the account matches itself), and the old spelling redirects', async () => {
            const res = await request(owner, 'renameAccount', { username: 'Bea', newName: 'BEA', confirm: 'BEA' });
            expect(res).toMatchObject({ ok: true, newName: 'BEA', chainedTombstones: 1 }); // "Old" pointed at Bea
            expect(await users().findOne({ username: 'Old' })).toMatchObject({ mergedInto: 'BEA' });
            expect(await signInReply('Bea')).toEqual({ success: false, message: 'This account is now called BEA. Sign in as BEA.' });
            expect(await signInReply('BEA')).toMatchObject({ success: true });
        });

        test('the new name is told only for the account\'s password: a wrong password, a sign-up, a restore and a profile of the old name never name it, nor of a merged name the rename re-pointed (REN-REDIRECT-DISCLOSE)', async () => {
            await users().updateOne({ username: 'Old' }, { $set: { stats: { gamesPlayed: 9 } } }); // a tombstone keeps nothing; harmless
            expect(await request(owner, 'renameAccount', { username: 'Bea', newName: 'Quiet', confirm: 'Quiet' })).toMatchObject({ ok: true, chainedTombstones: 1 });
            const replies = [];
            const ask = async (fn, event, args) => {
                const s = w.socket(`adm-${++n}`);
                await fn(s, w.io, args);
                const data = w.log.filter(l => l.to === `self:${s.id}` && l.event === event).pop().data;
                replies.push(data);
                return data;
            };
            // the owner of the account, who knows its password, is told
            expect(await signInReply('Bea')).toEqual({ success: false, message: 'This account is now called Quiet. Sign in as Quiet.' });
            expect(await signInReply('Old')).toEqual({ success: false, message: '"Old" was combined into your account "Quiet". Please sign in as Quiet.' });
            // anyone else is not
            expect(await ask(auth.signIn, 'signInResponse', { username: 'Bea', password: 'not-it' })).toEqual({ success: false, message: 'Invalid username or password!' });
            expect(await ask(auth.signIn, 'signInResponse', { username: 'Old', password: 'not-it' })).toEqual({ success: false, message: 'Invalid username or password!' });
            expect(await ask(auth.signUp, 'signUpResponse', { username: 'Bea', password: 'pw' })).toEqual({ success: false, message: 'That name is taken.' });
            expect(await ask(auth.signUp, 'signUpResponse', { username: 'Old', password: 'pw' })).toEqual({ success: false, message: 'That name is taken.' });
            expect(await ask(auth.signUp, 'signUpResponse', { username: 'bea', password: 'pw' })).toMatchObject({ success: false, message: expect.stringMatching(/"Bea" already exists/) });
            expect(await ask(auth.restoreSession, 'restoreSessionResponse', { username: 'Bea', sessionToken: 'x'.repeat(64) })).toEqual({ success: false, message: 'Invalid session token' });
            const profile = require('../profileHandlers');
            expect(await ask(profile.getPlayerProfile, 'playerProfileResponse', { username: 'Bea' })).toEqual({ success: false, message: 'Player not found' });
            expect(await ask(profile.getPlayerProfile, 'playerProfileResponse', { username: 'Old' })).toEqual({ success: false, message: 'Player not found' });
            expect(JSON.stringify(replies)).not.toContain('Quiet');
            // a wrong password on the old name counts as a failed sign-in
            const signInThrottle = require('../signInThrottle');
            const spy = jest.spyOn(signInThrottle, 'confirm');
            try {
                await ask(auth.signIn, 'signInResponse', { username: 'Bea', password: 'not-it' });
                expect(spy).toHaveBeenCalledTimes(1);
            } finally {
                spy.mockRestore();
            }
            // a merged name a rename did NOT touch still names its account
            await users().insertOne({ username: 'Dee', password: PW, stats: { gamesPlayed: 1 } });
            await users().insertOne({ username: 'DeeOld', mergedInto: 'Dee', mergedAt: new Date() });
            expect(await ask(profile.getPlayerProfile, 'playerProfileResponse', { username: 'DeeOld' })).toMatchObject({ success: true, profile: { username: 'Dee' } });
            expect(await ask(auth.signIn, 'signInResponse', { username: 'DeeOld', password: 'not-it' })).toEqual({ success: false, message: '"DeeOld" was combined into your account "Dee". Please sign in as Dee.' });
        });

        test('refused for a player in a game still in its draw (memory) or one the database shows in a game; nothing written, not signed out, not locked', async () => {
            const cy = await signedIn('Cy');
            const others = ['P1', 'P2', 'P3'].map((u, i) => w.user(`adm-rg${i}-${n}`, u));
            const game = gameManager.createGame([cy.id, ...others.map(o => o.id)]);
            const before = JSON.stringify([users().all(), mockDb.current.gameRecords.all()]);
            const res = await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' });
            expect(res).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/"Cy" is in a game right now/) });
            expect(JSON.stringify([users().all(), mockDb.current.gameRecords.all()])).toBe(before);
            expect(gotEvent(cy, 'forceLogout')).toBe(false);
            expect(gameManager.isMergeLocked('Cy')).toBe(false);
            expect(gameManager.isMergeLocked('Cyrus')).toBe(false);
            gameManager.abortGame(game.gameId, w.io);
            await users().updateOne({ username: 'Cy' }, { $set: { activeGameId: 'g-elsewhere' } });
            const signedOutBefore = w.log.filter(l => l.event === 'forceLogout').length;
            expect(await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' })).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/^"Cy" is in a game right now/) });
            expect(w.log.filter(l => l.event === 'forceLogout').length).toBe(signedOutBefore); // refused before anything
            expect(await users().findOne({ username: 'Cyrus' })).toBeNull();
        });

        test('a game the database shows by the time of the guarded write (another process) refuses the rename; nothing renamed', async () => {
            const hold = holdNextWrite(users(), 'findOneAndUpdate');
            const pending = request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' });
            try {
                await hold.reached;
                await users().updateOne({ username: 'Cy' }, { $set: { activeGameId: 'g-other-process' } });
            } finally {
                hold.release();
            }
            expect(await pending).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/changed while this ran.*Nothing was renamed/) });
            expect(await users().findOne({ username: 'Cyrus' })).toBeNull();
            expect(await users().findOne({ username: 'Cy' })).toMatchObject({ activeGameId: 'g-other-process' });
            expect(mockDb.current.gameRecords.all()[0].team1Players).toEqual(['Cy', 'Bea']);
        });

        test('while it runs both names are locked: no sign-in as the old name, no sign-up of the new one (any case)', async () => {
            const cy = await signedIn('Cy');
            const hold = holdNextWrite(users(), 'findOneAndUpdate'); // the guarded rename
            const pending = request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' });
            try {
                await hold.reached;
                expect(gotEvent(cy, 'forceLogout')).toBe(true);
                expect(await signInReply('Cy')).toEqual({ success: false, message: auth.MERGE_LOCKED_MESSAGE });
                const up = w.socket(`adm-${++n}`);
                await auth.signUp(up, w.io, { username: 'cyrus', password: 'pw' });
                expect(w.log.filter(l => l.to === `self:${up.id}` && l.event === 'signUpResponse').pop().data).toEqual({ success: false, message: 'That name is taken.' });
            } finally {
                hold.release();
            }
            expect(await pending).toMatchObject({ ok: true, newName: 'Cyrus' });
            expect(gameManager.isMergeLocked('Cy')).toBe(false);
            expect(gameManager.isMergeLocked('Cyrus')).toBe(false);
            expect(await users().countDocuments({ username: { $regex: '^cyrus$', $options: 'i' } })).toBe(1);
        });

        test('the new name appearing while the guarded write runs (a case variant from another process): refused, the old name put back, nothing else moved', async () => {
            const hold = holdNextWrite(users(), 'findOneAndUpdate');
            const pending = request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' });
            try {
                await hold.reached;
                await users().insertOne({ username: 'CYRUS', password: PW });
            } finally {
                hold.release();
            }
            const res = await pending;
            expect(res).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/"Cyrus" was taken while this ran\. Nothing was renamed/) });
            expect(await users().findOne({ username: 'Cy' })).toMatchObject({ stats: { gamesPlayed: 3 } });
            expect((await users().findOne({ username: 'Cy' })).mergedInto).toBeUndefined();
            expect(await users().findOne({ username: 'Cyrus' })).toBeNull();
            expect(mockDb.current.gameRecords.all()[0].team1Players).toEqual(['Cy', 'Bea']);
            expect(gameManager.isMergeLocked('Cy')).toBe(false);
        });

        test('a failure after the rename is reported as partial; renaming again with the same names finishes it', async () => {
            const original = mockDb.current.gameRecords.updateMany;
            mockDb.current.gameRecords.updateMany = async () => { throw new Error('disk on fire'); };
            let res;
            try {
                res = await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' });
            } finally {
                mockDb.current.gameRecords.updateMany = original;
            }
            expect(res).toMatchObject({ ok: false, error: 'server', message: expect.stringMatching(/"Cy" is now called "Cyrus".*stopped partway\. Rename Cy to Cyrus again to finish/) });
            expect(JSON.stringify(res)).not.toContain('disk on fire');
            expect(mockDb.current.gameRecords.all()[0].team1Players).toEqual(['Cy', 'Bea']);
            const done = await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' });
            expect(done).toMatchObject({ ok: true, resumed: true, gameRecords: 2, reports: 3, otherUsersBlocks: 1 });
            expect(scan('Cy')).toEqual(['users:username']);
            // a third time: nothing left to move
            expect(await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' })).toMatchObject({ ok: true, resumed: true, gameRecords: 0, reports: 0 });
            // a different new name for an old name is refused
            expect(await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyril', confirm: 'Cyril' })).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/now called "Cyrus"\. Rename "Cyrus" instead/) });
        });

        test('the player\'s own Delete account during an unfinished rename erases the OLD name too: its games, reports and tombstones, then its redirect (SELFDEL-PENDING)', async () => {
            const original = mockDb.current.gameRecords.updateMany;
            mockDb.current.gameRecords.updateMany = async () => { throw new Error('disk on fire'); };
            try {
                expect(await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' })).toMatchObject({ ok: false, error: 'server' });
            } finally {
                mockDb.current.gameRecords.updateMany = original;
            }
            expect(await users().findOne({ username: 'Cyrus' })).toMatchObject({ renamePending: { from: 'Cy' } });
            expect(mockDb.current.gameRecords.all()[0].team1Players).toEqual(['Cy', 'Bea']);
            const cyrus = await signedIn('Cyrus');
            gameManager.registerUser(cyrus.id, 'Cyrus');
            jest.useFakeTimers();
            try {
                await auth.deleteAccount(cyrus, w.io, { password: 'pw' });
            } finally {
                jest.useRealTimers();
            }
            expect(w.log.filter(l => l.to === `self:${cyrus.id}` && l.event === 'deleteAccountResponse').pop().data).toEqual({ success: true });
            expect(await users().findOne({ username: 'Cyrus' })).toBeNull();
            expect(await users().findOne({ username: 'Cy' })).toBeNull();
            expect(await users().findOne({ username: 'CyOld' })).toBeNull();
            try {
                // what stays under the freed old name is what a deletion of
                // the name keeps anyway: reports (marked deleted, below), who
                // resolved / set an admin (history), and other players'
                // blocks (a player's own delete keeps them, BLK-EVADE). No
                // game record, no account, no tombstone
                expect(scan('Cy')).toEqual(['reports:reported', 'reports:reporter', 'reports:resolvedBy', 'users:adminSetBy', 'users:blockedUsers[0]']);
                expect(JSON.stringify(mockDb.current.gameRecords.all())).not.toMatch(/"Cy"|"Cyrus"/);
                expect(mockDb.current.reports.all().every(r => r.reporterDeletedAt || r.reportedDeletedAt)).toBe(true);
                expect(gameManager.deletedUsernames.has('Cy')).toBe(true);
            } finally {
                gameManager.deletedUsernames.delete('Cy');
                gameManager.deletedUsernames.delete('Cyrus');
            }
        });

        test('a rename and a merge of the same name at once run one after the other: exactly one happens, the data stays whole', async () => {
            await users().insertOne({ username: 'Dee', password: PW, stats: { gamesPlayed: 1 } });
            const plan = await request(owner, 'planMerge', { target: 'Dee', sources: ['Cy'] });
            const owner2 = await signedIn('Owner');
            const [m, r] = await Promise.all([
                request(owner2, 'applyMerge', { target: 'Dee', sources: ['Cy'], planHash: plan.planHash, confirm: 'Dee' }),
                request(owner2, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' })
            ]);
            expect([m.ok, r.ok].filter(Boolean)).toHaveLength(1);
            const cy = await users().findOne({ username: 'Cy' });
            if (m.ok) {
                expect(r).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/merged into "Dee"/) });
                expect(cy.mergedInto).toBe('Dee');
                expect(await users().findOne({ username: 'Cyrus' })).toBeNull();
                expect((await users().findOne({ username: 'Dee' })).stats.gamesPlayed).toBe(4);
            } else {
                expect(m).toMatchObject({ ok: false });
                expect(cy).toMatchObject({ mergedInto: 'Cyrus', renamedAt: expect.any(Date) });
                expect((await users().findOne({ username: 'Dee' })).stats.gamesPlayed).toBe(1);
                expect((await users().findOne({ username: 'Cyrus' })).stats.gamesPlayed).toBe(3);
                expect(scan('Cy')).toEqual(['users:username']);
            }
        });
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

        test('a merge that throws after retiring: the admin is told it is partly applied, the retired name is signed out anyway', async () => {
            const cy = await signedIn('Cy');
            const prev = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            const resets = mockDb.current.passwordResets;
            resets.updateMany = async () => { throw new Error('transient'); }; // the last write, after the tombstone
            const res = await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: prev.planHash, confirm: 'Bea' });
            delete resets.updateMany;
            expect(res).toMatchObject({ ok: false, error: 'server' });
            expect(res.message).toMatch(/partly applied \(Cy retired and signed out\)/);
            expect(res.message).not.toMatch(/Nothing more was changed/);
            expect((await users().findOne({ username: 'Cy' })).mergedInto).toBe('Bea');
            expect(w.log.filter(l => l.to === `self:${cy.id}`).map(l => l.event)).toContain('forceLogout');
            expect(gameManager.getUserBySocketId(cy.id)).toBeUndefined();
            expect(audit().pop()).toMatchObject({ action: 'applyMerge', result: 'failed', detail: expect.stringMatching(/partly applied/) });
            // Preview again: nothing left to do
            const replan = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            expect(replan.plan.changeCount).toBe(0);
        });

        test('a merge that throws before retiring: the source was signed out before the first write, is not retired and can sign in again; preview + apply again finishes it', async () => {
            const cy = await signedIn('Cy');
            const prev = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            const recs = mockDb.current.gameRecords;
            recs.updateOne = async () => { throw new Error('transient'); };
            const res = await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: prev.planHash, confirm: 'Bea' });
            delete recs.updateOne;
            expect(res).toMatchObject({ ok: false, error: 'server' });
            expect(res.message).toMatch(/no account retired yet/);
            expect(w.log.filter(l => l.to === `self:${cy.id}`).map(l => l.event)).toContain('forceLogout');
            expect((await users().findOne({ username: 'Cy' })).mergedInto).toBeUndefined();
            expect(gameManager.isMergeLocked('Cy')).toBe(false); // the lock is released on failure
            const cy2 = await signedIn('Cy');
            const again = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            const done = await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: again.planHash, confirm: 'Bea' });
            expect(done).toMatchObject({ ok: true, result: { retired: ['Cy'], signedOut: 1 } });
            expect(w.io.sockets.sockets.has(cy2.id)).toBe(false);
        });

        test('"already complete" still signs out a retired name that is connected', async () => {
            const cy = await signedIn('Cy');
            const prev = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            const { applyMerge, planMerge } = require('../../admin/accountMerge');
            await applyMerge(mockDb.current, await planMerge(mockDb.current, { target: 'Bea', sources: ['Cy'] })); // e.g. the CLI, or an apply cut short
            expect(gameManager.getUserBySocketId(cy.id)).toBeDefined();
            const replan = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            expect(replan.planHash).not.toBe(prev.planHash);
            expect(await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: replan.planHash, confirm: 'Bea' }))
                .toMatchObject({ ok: false, error: 'refused', message: 'Nothing to do. This merge is already complete.' });
            expect(w.log.filter(l => l.to === `self:${cy.id}`).map(l => l.event)).toContain('forceLogout');
            expect(gameManager.getUserBySocketId(cy.id)).toBeUndefined();
        });

        test('a retired source\'s second tab (same saved session) is signed out too', async () => {
            const cy = await signedIn('Cy');
            const cy2 = await restoredTab('Cy', cy.sessionToken);
            const prev = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            const done = await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: prev.planHash, confirm: 'Bea' });
            expect(done).toMatchObject({ ok: true, result: { retired: ['Cy'], signedOut: 2 } });
            for (const s of [cy, cy2]) expect(w.io.sockets.sockets.has(s.id)).toBe(false);
        });

        describe('races (MRG-WIN)', () => {
            beforeEach(async () => {
                await users().insertOne({ username: 'Dee', password: PW, stats: { gamesPlayed: 1 } });
            });
            const statsOf = async (name) => (await users().findOne({ username: name })).stats || {};

            test('two merges of the same source into different accounts at once: one runs, the other is refused; stats counted once', async () => {
                const toBea = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
                const toDee = await request(owner, 'planMerge', { target: 'Dee', sources: ['Cy'] });
                const owner2 = await signedIn('Owner'); // a second admin tab (same account is fine)
                const [a, b] = await Promise.all([
                    request(owner2, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: toBea.planHash, confirm: 'Bea' }),
                    request(owner2, 'applyMerge', { target: 'Dee', sources: ['Cy'], planHash: toDee.planHash, confirm: 'Dee' })
                ]);
                // whichever reached the merge queue first runs; the other re-plans after it
                const [win, lose] = a.ok ? [a, b] : [b, a];
                const winner = win.result.target;
                const loser = winner === 'Bea' ? 'Dee' : 'Bea';
                expect(win).toMatchObject({ ok: true, result: { retired: ['Cy'], statsMerged: ['Cy'] } });
                expect(lose).toMatchObject({ ok: false, error: 'refused' });
                expect(lose.message).toMatch(new RegExp(`already merged into "${winner}"`));
                const before = { Bea: 2, Dee: 1 };
                expect((await statsOf(winner)).gamesPlayed).toBe(before[winner] + 3);
                expect((await statsOf(loser)).gamesPlayed).toBe(before[loser]);
                expect((await users().findOne({ username: loser })).mergedFrom).toBeUndefined();
                expect((await users().findOne({ username: 'Cy' })).mergedInto).toBe(winner);
                expect(mockDb.current.gameRecords.all()[0].team1Players).toEqual([winner, 'x']);
            });

            test('a source seated in a game still in its draw (no activeGameId yet) is refused before anything is written', async () => {
                const cy = await signedIn('Cy');
                const others = ['P1', 'P2', 'P3'].map((u, i) => w.user(`adm-g${i}-${n}`, u));
                const game = gameManager.createGame([cy.id, ...others.map(o => o.id)]);
                expect((await users().findOne({ username: 'Cy' })).activeGameId).toBeUndefined();
                const prev = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
                expect(prev.plan.errors).toEqual([]);
                const before = JSON.stringify([users().all(), mockDb.current.gameRecords.all()]);
                const res = await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: prev.planHash, confirm: 'Bea' });
                expect(res).toMatchObject({ ok: false, error: 'refused' });
                expect(res.message).toMatch(/"Cy" is in a game right now/);
                expect(JSON.stringify([users().all(), mockDb.current.gameRecords.all()])).toBe(before);
                expect(gotEvent(cy, 'forceLogout')).toBe(false); // still playing
                expect(gameManager.isMergeLocked('Cy')).toBe(false);
                // once that game is over the same preview applies
                gameManager.abortGame(game.gameId, w.io);
                const done = await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: prev.planHash, confirm: 'Bea' });
                expect(done).toMatchObject({ ok: true, result: { retired: ['Cy'] } });
            });

            test('while the merge runs the source is signed out and locked: no sign-in, restore, queue, lobby or tournament', async () => {
                const cy = await signedIn('Cy');
                const prev = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
                const hold = holdNextWrite(mockDb.current.gameRecords); // the apply's first write
                const pending = request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: prev.planHash, confirm: 'Bea' });
                try {
                    await hold.reached;
                    // signed out before the first write
                    expect(gotEvent(cy, 'forceLogout')).toBe(true);
                    expect(gameManager.getUserBySocketId(cy.id)).toBeUndefined();
                    expect(gameManager.isMergeLocked('Cy')).toBe(true);
                    // a fresh password sign-in and a restore of the saved session are refused
                    const s = w.socket(`adm-${++n}`);
                    await auth.signIn(s, w.io, { username: 'Cy', password: 'pw' });
                    expect(w.log.filter(l => l.to === `self:${s.id}` && l.event === 'signInResponse').pop().data)
                        .toEqual({ success: false, message: auth.MERGE_LOCKED_MESSAGE });
                    expect(gameManager.getUserBySocketId(s.id)).toBeUndefined();
                    const r = w.socket(`adm-${++n}`);
                    await auth.restoreSession(r, w.io, { username: 'Cy', sessionToken: cy.sessionToken });
                    expect(w.log.filter(l => l.to === `self:${r.id}` && l.event === 'restoreSessionResponse').pop().data).toMatchObject({ success: false });
                    expect(gameManager.getUserBySocketId(r.id)).toBeUndefined();
                    // a socket registered as Cy some other way still cannot start anything
                    const z = w.user(`adm-z-${n}`, 'Cy', { db: false });
                    expect(gameManager.joinQueue(z.id)).toMatchObject({ success: false });
                    expect(gameManager.createNamedLobby(z.id, 'x')).toMatchObject({ success: false });
                    expect(gameManager.createTournament(z.id, 't')).toMatchObject({ success: false });
                    gameManager.removeUserSocket(z.id);
                } finally {
                    hold.release(); // a failed check must not leave the merge queue blocked
                }
                expect(await pending).toMatchObject({ ok: true, result: { retired: ['Cy'], signedOut: 1 } });
                expect(gameManager.isMergeLocked('Cy')).toBe(false);
                expect((await users().findOne({ username: 'Cy' })).mergedInto).toBe('Bea');
            });

            test('a source the database shows in a game by retire time (e.g. set from another process) is not retired: reported as a partial merge', async () => {
                const prev = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
                const hold = holdNextWrite(mockDb.current.gameRecords);
                const pending = request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: prev.planHash, confirm: 'Bea' });
                try {
                    await hold.reached;
                    await users().updateOne({ username: 'Cy' }, { $set: { activeGameId: 'g-elsewhere' } });
                } finally {
                    hold.release();
                }
                const res = await pending;
                expect(res).toMatchObject({ ok: false, error: 'server' });
                expect(res.message).toMatch(/only partly applied: "Cy" could not be retired/);
                const cyDoc = await users().findOne({ username: 'Cy' });
                expect(cyDoc.mergedInto).toBeUndefined();
                expect(cyDoc.activeGameId).toBe('g-elsewhere');
                expect(cyDoc.password).toBeDefined();
                expect(audit().pop()).toMatchObject({ action: 'applyMerge', result: 'failed', detail: expect.stringMatching(/partly applied/) });
            });
        });

        test('find duplicates lists look-alike groups', async () => {
            await users().insertOne({ username: 'bea2', stats: { gamesPlayed: 1 } });
            const res = await request(owner, 'findDuplicates', {});
            expect(res.groups.map(g => g.map(u => u.username))).toEqual([['Bea', 'bea2']]);
        });
    });

    describe('review fixes (batch 2 findings)', () => {
        const passwordHash = require('../../utils/passwordHash');
        const { eraseAccount } = require('../../admin/accountDelete');
        const replyOf = (s, event) => w.log.filter(l => l.to === `self:${s.id}` && l.event === event).pop()?.data;
        const caseCount = (name) => users().countDocuments({ username: { $regex: `^${name}$`, $options: 'i' } });
        beforeEach(async () => {
            await users().updateOne({ username: 'Cy' }, { $set: { stats: { gamesPlayed: 3, wins: 1 } } });
            await mockDb.current.gameRecords.insertOne({ gameId: 'g1', team1Players: ['Cy', 'Bea'], team2Players: ['y', 'z'], completedAt: new Date() });
        });

        test('SD-RACE: a self-delete whose password check overlaps an admin rename deletes nothing; the renamed account and its redirect stay', async () => {
            const cy = await signedIn('Cy');
            const hold = holdNextWrite(passwordHash, 'compare');
            const deleting = auth.deleteAccount(cy, w.io, { password: 'pw' });
            try {
                await hold.reached;
                expect(await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' })).toMatchObject({ ok: true });
            } finally {
                hold.release();
            }
            await deleting;
            expect(replyOf(cy, 'deleteAccountResponse')).toEqual({ success: false, message: expect.stringMatching(/changed by an admin.*Nothing was deleted/) });
            expect(await users().findOne({ username: 'Cyrus' })).toMatchObject({ stats: { gamesPlayed: 3 }, password: expect.any(String) });
            expect(await users().findOne({ username: 'Cy' })).toMatchObject({ mergedInto: 'Cyrus' });
            expect(mockDb.current.gameRecords.all()[0].team1Players).toEqual(['Cyrus', 'Bea']);
            expect(gameManager.deletedUsernames.has('Cyrus')).toBe(false);
            expect(gameManager.deletedUsernames.has('Cy')).toBe(false);
        });

        test('SELFDEL-UNSERIALIZED: a self-delete waits for a panel rename of the same account already running (one queue), then is refused', async () => {
            const cy = await signedIn('Cy');
            const compare = holdNextWrite(passwordHash, 'compare');
            const deleting = auth.deleteAccount(cy, w.io, { password: 'pw' });
            await compare.reached;
            const write = holdNextWrite(users(), 'findOneAndUpdate'); // the rename's guarded write
            const renaming = request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' });
            try {
                await write.reached;
                compare.release();
                await new Promise(r => setTimeout(r, 30)); // the self-delete gets as far as it can
                expect(await users().findOne({ username: 'Cy' })).toMatchObject({ stats: { gamesPlayed: 3 } });
                expect(replyOf(cy, 'deleteAccountResponse')).toBeUndefined(); // waiting its turn
            } finally {
                compare.release();
                write.release();
            }
            expect(await renaming).toMatchObject({ ok: true, newName: 'Cyrus' });
            await deleting;
            expect(replyOf(cy, 'deleteAccountResponse')).toEqual({ success: false, message: expect.stringMatching(/changed by an admin/) });
            expect(await users().findOne({ username: 'Cyrus' })).toMatchObject({ stats: { gamesPlayed: 3 } });
        });

        test('SD-RACE: eraseAccount deletes the document only under the name it was given', async () => {
            const doc = await users().findOne({ username: 'Cy' });
            await users().updateOne({ _id: doc._id }, { $set: { username: 'Cyrus' } });
            await expect(eraseAccount(mockDb.current, { _id: doc._id, username: 'Cy' })).rejects.toThrow(/changed/);
            expect(await users().findOne({ username: 'Cyrus' })).toMatchObject({ stats: { gamesPlayed: 3 } });
        });

        test('BLK-EVADE: a player deleting their own account and signing up again as the same name stays blocked', async () => {
            await users().insertOne({ username: 'Hal', password: PW });
            await users().updateOne({ username: 'Bea' }, { $set: { blockedUsers: ['Hal'] } });
            const bea = await signedIn('Bea');
            const hal = await signedIn('Hal');
            jest.useFakeTimers();
            try {
                await auth.deleteAccount(hal, w.io, { password: 'pw' });
            } finally {
                jest.useRealTimers();
            }
            expect(replyOf(hal, 'deleteAccountResponse')).toEqual({ success: true });
            expect(await users().findOne({ username: 'Hal' })).toBeNull();
            const up = w.socket(`adm-${++n}`);
            await auth.signUp(up, w.io, { username: 'Hal', password: 'pw' });
            expect(replyOf(up, 'signUpResponse')).toMatchObject({ success: true });
            expect((await users().findOne({ username: 'Bea' })).blockedUsers).toEqual(['Hal']);
            expect([...bea.data.blockedUsers]).toEqual(['Hal']);
            expect(gotEvent(bea, 'blockListUpdated')).toBe(false);
        });

        test('Q-REAUTH: a delete queued behind a running merge is authorized again on its turn; an admin removed meanwhile gets the uniform refusal and nothing is deleted', async () => {
            await users().insertOne({ username: 'Dee', password: PW });
            const plan = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            const hold = holdNextWrite(mockDb.current.gameRecords); // the merge's first write
            const merging = request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: plan.planHash, confirm: 'Bea' });
            let deleting;
            try {
                await hold.reached;
                deleting = request(owner, 'deleteAccount', { username: 'Dee', confirm: 'Dee' });
                await new Promise(r => setTimeout(r, 20));
                await users().updateOne({ username: 'Owner' }, { $set: { isAdmin: false } });
            } finally {
                hold.release();
            }
            expect(await merging).toMatchObject({ ok: true });
            expect(await deleting).toEqual({ requestId: expect.any(String), action: 'deleteAccount', ok: false, error: 'forbidden', message: admin.FORBIDDEN_MESSAGE });
            expect(await users().findOne({ username: 'Dee' })).not.toBeNull();
        });

        test('SU-CASE: a sign-up of a case variant whose hash overlaps a rename to that name is undone after its insert', async () => {
            const hold = holdNextWrite(passwordHash, 'hash');
            const up = w.socket(`adm-${++n}`);
            const signing = auth.signUp(up, w.io, { username: 'cyrus', password: 'pw' });
            try {
                await hold.reached;
                expect(await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' })).toMatchObject({ ok: true });
            } finally {
                hold.release();
            }
            await signing;
            expect(replyOf(up, 'signUpResponse')).toEqual({ success: false, message: 'That name is taken.' });
            expect(await caseCount('cyrus')).toBe(1);
            expect(await users().findOne({ username: 'Cyrus' })).toMatchObject({ stats: { gamesPlayed: 3 } });
            expect(gameManager.getUserBySocketId(up.id)).toBeFalsy();
        });

        test('TOMB-REMERGE: after its merged name is deleted, a new account with that name merged into the same account has its stats added', async () => {
            const plan = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            expect(await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: plan.planHash, confirm: 'Bea' })).toMatchObject({ ok: true });
            expect((await users().findOne({ username: 'Bea' })).stats.gamesPlayed).toBe(5);
            expect(await request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' })).toMatchObject({ ok: true, kind: 'tombstone' });
            const bea = await users().findOne({ username: 'Bea' });
            expect(bea.mergedFrom.map(e => e.username)).not.toContain('Cy');
            expect(bea.mergedFromFreed).toEqual([expect.objectContaining({ username: 'Cy', stats: expect.objectContaining({ gamesPlayed: 3 }), nameFreedAt: expect.any(Date) })]);
            await users().insertOne({ username: 'Cy', password: PW, stats: { gamesPlayed: 7, wins: 2 } });
            const again = await request(owner, 'planMerge', { target: 'Bea', sources: ['Cy'] });
            expect(again.plan.errors).toEqual([]);
            expect(again.plan.accounts.find(a => a.role === 'result').stats.gamesPlayed).toBe(12);
            expect(await request(owner, 'applyMerge', { target: 'Bea', sources: ['Cy'], planHash: again.planHash, confirm: 'Bea' })).toMatchObject({ ok: true, result: { statsMerged: ['Cy'] } });
            expect((await users().findOne({ username: 'Bea' })).stats.gamesPlayed).toBe(12);
        });

        test('REN-NOREDIRECT-RESUME / C3 / RN-RESUME: the redirect write failing is finishable: the table flags it, deleting is refused until done, renaming again writes the redirect and moves the rest', async () => {
            const coll = users();
            coll.insertOne = async () => { delete coll.insertOne; throw new Error('network blip'); };
            let res;
            try {
                res = await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' });
            } finally {
                delete coll.insertOne;
            }
            expect(res).toMatchObject({ ok: false, error: 'server', message: expect.stringMatching(/Rename Cy to Cyrus again to finish/) });
            expect(await users().findOne({ username: 'Cy' })).toBeNull();
            expect(mockDb.current.gameRecords.all()[0].team1Players).toEqual(['Cy', 'Bea']);
            const list = await request(owner, 'listPlayers', {});
            expect(list.players.find(p => p.username === 'Cyrus')).toMatchObject({ renameUnfinished: 'Cy' });
            expect(list.players.find(p => p.username === 'Bea')).toMatchObject({ renameUnfinished: null });
            // the unfinished account can be neither renamed again nor deleted
            expect(await request(owner, 'renameAccount', { username: 'Cyrus', newName: 'Cyril', confirm: 'Cyril' })).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/unfinished rename from "Cy"/) });
            expect(await request(owner, 'deleteAccount', { username: 'Cyrus', confirm: 'Cyrus' })).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/unfinished rename/) });
            const done = await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' });
            expect(done).toMatchObject({ ok: true, resumed: true, oldNameKept: true, gameRecords: 1 });
            expect(await users().findOne({ username: 'Cy' })).toMatchObject({ mergedInto: 'Cyrus', renamedAt: expect.any(Date) });
            expect((await users().findOne({ username: 'Cyrus' })).renamePending).toBeUndefined();
            expect(mockDb.current.gameRecords.all()[0].team1Players).toEqual(['Cyrus', 'Bea']);
            expect((await request(owner, 'listPlayers', {})).players.find(p => p.username === 'Cyrus')).toMatchObject({ renameUnfinished: null });
        });

        test('RN-RESUME: the redirect of an unfinished rename cannot be deleted until the rename is finished', async () => {
            const original = mockDb.current.gameRecords.updateMany;
            mockDb.current.gameRecords.updateMany = async () => { throw new Error('disk on fire'); };
            try {
                expect(await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' })).toMatchObject({ ok: false, error: 'server' });
            } finally {
                mockDb.current.gameRecords.updateMany = original;
            }
            expect(await request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' })).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/has not finished/) });
            expect(await users().findOne({ username: 'Cy' })).toMatchObject({ mergedInto: 'Cyrus' });
            expect(await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' })).toMatchObject({ ok: true, resumed: true });
            expect(await request(owner, 'deleteAccount', { username: 'Cy', confirm: 'Cy' })).toMatchObject({ ok: true, kind: 'tombstone' });
        });

        test('C3: a new account that took the old name before the rename finished: finishing is refused, nothing of it moved', async () => {
            const coll = users();
            coll.insertOne = async () => { delete coll.insertOne; throw new Error('network blip'); };
            try {
                await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' });
            } finally {
                delete coll.insertOne;
            }
            await users().insertOne({ username: 'Cy', password: PW });
            const before = JSON.stringify([users().all(), mockDb.current.gameRecords.all()]);
            expect(await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' })).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/taken by a new account before the rename/) });
            expect(JSON.stringify([users().all(), mockDb.current.gameRecords.all()])).toBe(before);
        });

        test('REN-DELETED-REPORTS: a rename leaves reports about an earlier, deleted holder of the name alone; merge plans do too', async () => {
            await mockDb.current.reports.insertOne({ reporter: 'Bea', reported: 'Cy', reason: 'old', createdAt: new Date(), reportedDeletedAt: new Date() });
            await mockDb.current.reports.insertOne({ reporter: 'Cy', reported: 'Bea', reason: 'old2', createdAt: new Date(), reporterDeletedAt: new Date() });
            await mockDb.current.reports.insertOne({ reporter: 'Bea', reported: 'Cy', reason: 'new', createdAt: new Date() });
            await users().insertOne({ username: 'Dee', password: PW });
            const merge = await request(owner, 'planMerge', { target: 'Dee', sources: ['Cy'] });
            expect(merge.plan.reports.map(r => r.newReported || r.newReporter)).toEqual(['Dee']);
            expect(await request(owner, 'renameAccount', { username: 'Cy', newName: 'Cyrus', confirm: 'Cyrus' })).toMatchObject({ ok: true, reports: 1 });
            expect(mockDb.current.reports.all().map(r => [r.reason, r.reporter, r.reported])).toEqual([
                ['old', 'Bea', 'Cy'], ['old2', 'Cy', 'Bea'], ['new', 'Bea', 'Cyrus']
            ]);
        });

        test('REN-SELF / C2: an admin cannot rename their own account (they would be signed out before the answer); nothing changes', async () => {
            const res = await request(owner, 'renameAccount', { username: 'Owner', newName: 'Owner2', confirm: 'Owner2' });
            expect(res).toMatchObject({ ok: false, error: 'refused', message: expect.stringMatching(/cannot rename your own account/) });
            expect(gotEvent(owner, 'forceLogout')).toBe(false);
            expect(w.io.sockets.sockets.has(owner.id)).toBe(true);
            expect(await users().findOne({ username: 'Owner2' })).toBeNull();
            expect(await users().findOne({ username: 'Owner' })).toMatchObject({ isAdmin: true });
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

describe('refusals cannot flood the audit log', () => {
    test('a player looping forbidden requests over many sockets: one entry per action per window, then a count', async () => {
        const nowSpy = jest.spyOn(Date, 'now');
        let t = 1_000_000;
        nowSpy.mockImplementation(() => t);
        try {
            const before = logLines.length;
            for (let k = 0; k < 4; k++) {
                const s = await signedIn('Bea'); // a fresh socket each time: a fresh rate-limit window
                for (let i = 0; i < 50; i++) {
                    expect((await request(s, 'listAdmins', {})).error).toBe('forbidden');
                }
            }
            let entries = audit().filter(e => e.result === 'forbidden');
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ actor: 'Bea', action: 'listAdmins', detail: 'not an admin' });
            const refusedLines = logLines.slice(before).filter(l => l.includes('Admin request refused'));
            expect(refusedLines).toHaveLength(1);

            // Another action is its own key; another player too
            const s = await signedIn('Bea');
            await request(s, 'searchPlayers', { query: 'x' });
            await request(await signedIn('Cy'), 'listAdmins', {});
            expect(audit().filter(e => e.result === 'forbidden').map(e => `${e.actor}:${e.action}`))
                .toEqual(['Bea:listAdmins', 'Bea:searchPlayers', 'Cy:listAdmins']);

            // The next window: one new entry carrying how many were held back
            t += admin.FORBIDDEN_WINDOW_MS;
            expect((await request(s, 'listAdmins', {})).error).toBe('forbidden');
            entries = audit().filter(e => e.result === 'forbidden' && e.actor === 'Bea' && e.action === 'listAdmins');
            expect(entries.map(e => e.detail)).toEqual(['not an admin', 'not an admin (199 more refused in the window before)']);
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('an admin\'s own actions are never coalesced', async () => {
        const owner = await signedIn('Owner');
        for (let i = 0; i < 5; i++) await request(owner, 'listAdmins', {});
        expect(audit().filter(e => e.action === 'listAdmins' && e.result === 'ok')).toHaveLength(5);
    });
});
