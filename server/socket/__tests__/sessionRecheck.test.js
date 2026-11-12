/**
 * Session re-check after a sign-in (authHandlers sessionGoneSince): only a
 * REVOKE (sessionEpoch moved) undoes a sign-in; another device's concurrent
 * session write replacing the sessionTokens array does not.
 */
const R = (p) => require('../../' + p);
const bcrypt = require('bcryptjs');
const { createMemoryDb, enableSort } = R('testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    getPasswordResetsCollection: () => mockDb.current.passwordResets,
    getAdminAuditCollection: () => mockDb.current.adminAudit,
    whenReady: async () => true
}));

const gameManager = R('game/GameManager');
const auth = R('socket/authHandlers');
const admin = R('socket/adminHandlers');
const { rejoinGame } = R('socket/reconnectHandlers');
const { asyncHandler, rateLimiter } = R('socket/errorHandler');
const { world } = R('testUtils/contractScenarios');

afterAll(() => rateLimiter.shutdown());
beforeAll(() => enableSort(true));
afterAll(() => enableSort(false));

let w, n = 0, PW, owner;
beforeEach(async () => {
    PW = await bcrypt.hash('pw', 4);
    mockDb.current = createMemoryDb({
        users: [
            { username: 'Owner', password: PW, isAdmin: true, stats: { gamesPlayed: 4 } },
            { username: 'Bea', password: PW, stats: { gamesPlayed: 2 } },
            { username: 'Cy', password: PW, stats: { gamesPlayed: 1 } }
        ]
    });
    gameManager.currentUsers = [];
    gameManager.mergeLocks?.clear();
    R('socket/signInThrottle')._reset();
    admin._resetForbiddenGate();
    w = world('pr');
    for (let i = 0; i <= n + 5; i++) rateLimiter.clearSocket(`pr-${i}`);
    owner = await signedIn('Owner');
});

const users = () => mockDb.current.users;
const resp = (s, ev) => w.log.filter(l => l.to === `self:${s.id}` && l.event === ev).pop()?.data;
const got = (s, ev) => w.log.some(l => l.to === `self:${s.id}` && l.event === ev);
const live = (s) => w.io.sockets.sockets.has(s.id);

async function signedIn(username) {
    const s = w.socket(`pr-${++n}`);
    await auth.signIn(s, w.io, { username, password: 'pw' });
    const r = resp(s, 'signInResponse');
    expect(r.success).toBe(true);
    s.sessionToken = r.sessionToken;
    return s;
}
async function restoredTab(username, token) {
    const s = w.socket(`pr-${++n}`);
    await auth.restoreSession(s, w.io, { username, sessionToken: token });
    expect(resp(s, 'restoreSessionResponse').success).toBe(true);
    return s;
}
let rid = 0;
async function request(socket, action, args) {
    const requestId = `q-${++rid}`;
    await asyncHandler('adminRequest', admin.adminRequest)(socket, w.io, { requestId, action, args });
    return w.log.filter(l => l.to === `self:${socket.id}` && l.event === 'adminResponse' && l.data.requestId === requestId).pop().data;
}

describe('sessionGoneSince: revoke vs concurrent write', () => {
    test('restore write lands, reset revoke lands before reply: socket is signed out, not seated', async () => {
        const a = await signedIn('Bea');
        const coll = users();
        const orig = coll.updateOne;
        let release; const gate = new Promise(r => { release = r; });
        let reached; const reachedP = new Promise(r => { reached = r; });
        coll.updateOne = async function (...args) {
            coll.updateOne = orig;
            const res = await orig.apply(coll, args); // lands
            reached();
            await gate; // reply held
            return res;
        };
        const x = w.socket(`pr-${++n}`);
        const p = auth.restoreSession(x, w.io, { username: 'Bea', sessionToken: a.sessionToken });
        await reachedP;
        // the reset by link: writePasswordHash + route signOutUser
        const { writePasswordHash } = R('admin/setPassword');
        const u = await coll.findOne({ username: 'Bea' });
        const out = await writePasswordHash(mockDb.current, u, PW, { stampField: 'passwordResetByLinkAt' });
        const kicked = auth.signOutUser(w.io, 'Bea', { socketId: out.socketId });
        release(); await p;
        expect(kicked).toBeGreaterThanOrEqual(1);
        expect(live(x)).toBe(false);
        expect(gameManager.getUserBySocketId(x.id)).toBeUndefined();
        expect(resp(x, 'restoreSessionResponse')?.success).not.toBe(true);
    });

    test('a password sign-in on device A racing device B restoring stays signed in (no revoke happened)', async () => {
        const b = await signedIn('Bea'); // device B token
        const coll = users();
        const origFind = coll.findOne, origUpd = coll.updateOne;
        // B's restore: hold its write until A's write has landed
        let releaseB; const gateB = new Promise(r => { releaseB = r; });
        let bWriteDone; const bWriteDoneP = new Promise(r => { bWriteDone = r; });
        coll.updateOne = async function (filter, update, ...rest) {
            const isA = update?.$set?.socketId === 'devA';
            if (!isA && update?.$set?.sessionTokens) {
                await gateB;
                const r = await origUpd.call(coll, filter, update, ...rest);
                bWriteDone();
                return r;
            }
            const r = await origUpd.call(coll, filter, update, ...rest);
            if (isA) { releaseB(); await bWriteDoneP; }
            return r;
        };
        const bTab = w.socket(`pr-${++n}`);
        const pB = auth.restoreSession(bTab, w.io, { username: 'Bea', sessionToken: b.sessionToken });
        const devA = w.socket('devA');
        await auth.signIn(devA, w.io, { username: 'Bea', password: 'pw' });
        await pB;
        coll.updateOne = origUpd; coll.findOne = origFind;
        expect(resp(devA, 'signInResponse')?.success).toBe(true);
        expect(live(devA)).toBe(true);
        expect(gameManager.getUserBySocketId(devA.id)?.username).toBe('Bea');
    });
});
