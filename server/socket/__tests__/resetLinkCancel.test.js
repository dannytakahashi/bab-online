/**
 * A reset link that leaked (texted to the wrong number, read off a lost
 * phone) stops working as soon as the account is locked down: the panel's
 * Sign out everywhere and the owner's `scripts/set-password.js`
 * (setPassword) both cancel the account's open links
 * (setPassword.revokeOpenResetLinks), not only a newer link.
 */

const bcrypt = require('bcryptjs');
const { createMemoryDb } = require('../../testUtils/memoryDb');

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
const { world } = require('../../testUtils/contractScenarios');
const { createResetLink, useResetLink, INVALID_LINK } = require('../../admin/passwordReset');
const { setPassword, revokeOpenResetLinks } = require('../../admin/setPassword');

afterAll(() => rateLimiter.shutdown());

const hash = (pw) => bcrypt.hash(pw, 4);
let w;
let n = 0;
let owner;

beforeEach(async () => {
    const PW = await bcrypt.hash('pw', 4);
    mockDb.current = createMemoryDb({
        users: [
            { username: 'Owner', password: PW, isAdmin: true },
            { username: 'Bea', password: PW },
            { username: 'Cy', password: PW }
        ]
    });
    gameManager.currentUsers = [];
    require('../signInThrottle')._reset();
    admin._resetForbiddenGate();
    w = world('rlc');
    owner = await signedIn('Owner');
});

async function signedIn(username) {
    const s = w.socket(`rlc-${++n}`);
    rateLimiter.clearSocket(s.id);
    await auth.signIn(s, w.io, { username, password: 'pw' });
    expect(w.log.filter(l => l.to === `self:${s.id}` && l.event === 'signInResponse').pop().data.success).toBe(true);
    return s;
}

let rid = 0;
async function request(socket, action, args) {
    const requestId = `q-${++rid}`;
    await asyncHandler('adminRequest', admin.adminRequest)(socket, w.io, { requestId, action, args });
    return w.log.filter(l => l.to === `self:${socket.id}` && l.event === 'adminResponse' && l.data.requestId === requestId).pop().data;
}

const db = () => mockDb.current;
const linkState = async (username) => (await db().passwordResets.findOne({ username, state: { $ne: 'revoked' } }))?.state || 'revoked';

test('Sign out everywhere cancels the player\'s open reset link (and only theirs); audited', async () => {
    const made = await request(owner, 'createResetLink', { username: 'Bea' });
    expect(made.ok).toBe(true);
    const other = await createResetLink(db(), 'Cy');

    const res = await request(owner, 'signOutEverywhere', { username: 'Bea' });
    expect(res).toMatchObject({ ok: true, username: 'Bea' });

    expect(await useResetLink(db(), made.token, 'stranger-pw', { hash })).toBe(INVALID_LINK);
    const bea = await db().users.findOne({ username: 'Bea' });
    expect(await bcrypt.compare('pw', bea.password)).toBe(true); // the leaked link changed nothing
    expect(await linkState('Bea')).toBe('revoked');
    expect(db().passwordResets.all().find(d => d.username === 'Bea').revokedAt).toBeInstanceOf(Date);

    // another player's link is untouched
    expect(await useResetLink(db(), other.token, 'cy-new', { hash })).toMatchObject({ ok: true, username: 'Cy' });

    const entry = db().adminAudit.all().filter(e => e.action === 'signOutEverywhere').pop();
    expect(entry).toMatchObject({ result: 'ok', target: 'Bea' });
    expect(entry.detail).toMatch(/; 1 open reset link\(s\) cancelled$/);
    expect(JSON.stringify(db().adminAudit.all())).not.toContain(made.token);

    // a link made AFTER the lock-down works as usual
    const fresh = await request(owner, 'createResetLink', { username: 'Bea' });
    expect(await useResetLink(db(), fresh.token, 'bea-new', { hash })).toMatchObject({ ok: true, username: 'Bea' });
});

test('Sign out everywhere with no open link keeps its audit detail as before', async () => {
    await request(owner, 'signOutEverywhere', { username: 'Bea' });
    const entry = db().adminAudit.all().filter(e => e.action === 'signOutEverywhere').pop();
    expect(entry.detail).toBe('0 saved session(s) revoked, 0 live connection(s) signed out');
});

test('the CLI setPassword cancels the open link: the leaked link cannot overwrite the new password', async () => {
    const { token } = await createResetLink(db(), 'Bea');
    const result = await setPassword(db(), 'Bea', 'maple-otter-42', { rounds: 4 });
    expect(result).toEqual({ username: 'Bea', revokedSessions: 0, revokedLinks: 1 });

    expect(await useResetLink(db(), token, 'stranger-pw', { hash })).toBe(INVALID_LINK);
    const bea = await db().users.findOne({ username: 'Bea' });
    expect(await bcrypt.compare('maple-otter-42', bea.password)).toBe(true);
    expect(await linkState('Bea')).toBe('revoked');
});

test('revokeOpenResetLinks: used links stay used, no collection is nothing to do', async () => {
    const { token } = await createResetLink(db(), 'Bea');
    expect(await useResetLink(db(), token, 'bea-new', { hash })).toMatchObject({ ok: true });
    expect(await revokeOpenResetLinks(db(), { username: 'Bea' })).toBe(0);
    expect(db().passwordResets.all()[0].state).toBe('used');
    expect(await revokeOpenResetLinks({ users: db().users }, { username: 'Bea' })).toBe(0);
});
