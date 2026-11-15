/**
 * Account changes of 2026-11-15 on the real auth handlers and game manager
 * (memoryDb, every emit checked by the contract guard):
 *
 *   - Delete account: refused while the player is in a live game (its draw
 *     included) or tournament; the deleted name is held 30 days (sign-in,
 *     restore and sign-up treat it as taken / unknown; a lapsed hold frees
 *     itself); no new account with the name can take a seat of a game the
 *     deleted account sat in (rejoinGame, spectate, /active);
 *   - restoreSessionResponse `retryable: true` for passing failures only;
 *   - changePassword: rules, throttle, other devices signed out and their
 *     sessions revoked, this device kept, reset links cancelled, the race
 *     with a reset; the 8-character rule for new passwords, old short ones
 *     still sign in;
 *   - the one-time passwordReset notice after a reset by link or admin.
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
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const chatHandlers = require('../chatHandlers');
const { asyncHandler, rateLimiter } = require('../errorHandler');
const { world } = require('../../testUtils/contractScenarios');
const { hashToken } = require('../../utils/sessionTokens');
const { forgetAccount, NAME_HOLD_MS } = require('../../admin/accountDelete');
const { createResetLink, useResetLink } = require('../../admin/passwordReset');
const { setPassword } = require('../../admin/setPassword');
const { validate } = require('../validators');
const signInThrottle = require('../signInThrottle');

afterAll(() => rateLimiter.shutdown());

const OLD_PW = 'pw'; // an existing account's short password: still signs in
let PW;
let w;
let n = 0;

beforeEach(async () => {
    PW = await bcrypt.hash(OLD_PW, 4);
    mockDb.current = createMemoryDb({
        users: [
            { username: 'Bea', password: PW, stats: { gamesPlayed: 2 } },
            { username: 'Cy', password: PW },
            { username: 'Dee', password: PW }
        ]
    });
    gameManager.currentUsers = [];
    signInThrottle._reset();
    w = world('acc');
    for (let i = 0; i <= n; i++) rateLimiter.clearSocket(`acc-${i}`);
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id, w.io);
    for (const t of Array.from(gameManager.tournaments.values())) gameManager.deleteTournament?.(t.tournamentId);
    jest.useRealTimers();
});

const users = () => mockDb.current.users;
const reply = (s, event) => w.log.filter(l => l.to === `self:${s.id}` && l.event === event).pop()?.data;
const gotEvent = (s, event) => w.log.some(l => l.to === `self:${s.id}` && l.event === event);

async function signedIn(username, password = OLD_PW) {
    const s = w.socket(`acc-${++n}`);
    await auth.signIn(s, w.io, { username, password });
    const res = reply(s, 'signInResponse');
    expect(res).toMatchObject({ success: true });
    s.sessionToken = res.sessionToken;
    return s;
}

async function restore(username, sessionToken) {
    const s = w.socket(`acc-${++n}`);
    await auth.restoreSession(s, w.io, { username, sessionToken });
    s.reply = reply(s, 'restoreSessionResponse');
    return s;
}

async function deleteOwn(s, password = OLD_PW) {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
        await auth.deleteAccount(s, w.io, { password });
    } finally {
        jest.useRealTimers();
    }
    return reply(s, 'deleteAccountResponse');
}

/** A seated game (4 humans at positions 1-4), the hands irrelevant. */
function seatedGame(names, { first = null } = {}) {
    const socks = names.map((u, i) => (i === 0 && first) || w.user(`acc-g${i}-${++n}`, u, { db: false }));
    const game = gameManager.createGame(socks.map(s => s.id));
    socks.forEach((s, i) => game.addPlayer(s.id, names[i], i + 1, 1, false));
    return { game, socks };
}

describe('Delete account: refused while playing', () => {
    test('a game still in its draw, then a seated game (a /leave\'d seat too), then a tournament; nothing deleted, the name never left locked', async () => {
        const cy = await signedIn('Cy');
        const others = ['P1', 'P2', 'P3'].map((u, i) => w.user(`acc-dg${i}-${++n}`, u));
        const drawing = gameManager.createGame([cy.id, ...others.map(o => o.id)]);
        expect(await deleteOwn(cy)).toEqual({ success: false, message: "You're in a game right now. Delete your account after it ends." });
        expect(await users().findOne({ username: 'Cy' })).toMatchObject({ password: PW });
        expect(gameManager.isMergeLocked('Cy')).toBe(false);
        gameManager.abortGame(drawing.gameId, w.io);

        // seated, then gone (a /leave keeps the seat in the name until the game ends)
        const { game } = seatedGame(['Cy', 'Q1', 'Q2', 'Q3'], { first: cy });
        const pos = game.seatByUsername('Cy');
        game.forceSeat(pos, { presence: 'gone', controller: 'lazyBot', bot: { socketId: 'bot:Mary:t1', username: '🤖 Mary' } });
        expect(await deleteOwn(cy)).toMatchObject({ success: false, message: expect.stringMatching(/in a game right now/) });
        gameManager.abortGame(game.gameId, w.io);

        const created = gameManager.createTournament(cy.id, 'T');
        expect(created).toMatchObject({ success: true });
        expect(await deleteOwn(cy)).toEqual({
            success: false,
            message: "You're in a tournament right now. Leave it (or wait until it ends), then delete your account."
        });
        expect(gameManager.isMergeLocked('Cy')).toBe(false);
        expect(await users().findOne({ username: 'Cy' })).toMatchObject({ password: PW });
        gameManager.leaveTournament?.(cy.id);
        gameManager.deleteTournament(created.tournament.tournamentId);
        expect(await deleteOwn(cy)).toEqual({ success: true });
    });

    test('while the deletion runs the name is locked (no lobby, no tournament, no sign-in); unlocked after', async () => {
        const cy = await signedIn('Cy');
        const coll = mockDb.current.gameRecords;
        const original = coll.updateMany.bind(coll);
        let seenLocked = null;
        coll.updateMany = async (...args) => {
            seenLocked = gameManager.isMergeLocked('Cy');
            coll.updateMany = original;
            return original(...args);
        };
        expect(await deleteOwn(cy)).toEqual({ success: true });
        expect(seenLocked).toBe(true);
        expect(gameManager.isMergeLocked('Cy')).toBe(false);
    });
});

describe('the deleted name is held', () => {
    test('30 days: sign-in is the unknown-user reply (counted), restore "User not found", sign-up taken in any case; the hold carries nothing else', async () => {
        const cy = await signedIn('Cy');
        const token = cy.sessionToken;
        expect(await deleteOwn(cy)).toEqual({ success: true });
        const held = await users().findOne({ username: 'Cy' });
        expect(Object.keys(held).sort()).toEqual(['_id', 'deletedAt', 'mergedInto', 'nameHeldUntil', 'username']);
        expect(held.nameHeldUntil - held.deletedAt).toBe(NAME_HOLD_MS);

        const s = w.socket(`acc-${++n}`);
        await auth.signIn(s, w.io, { username: 'Cy', password: OLD_PW });
        expect(reply(s, 'signInResponse')).toEqual({ success: false, message: 'Invalid username or password!' });
        expect((await restore('Cy', token)).reply).toEqual({ success: false, message: 'User not found' });
        await auth.signUp(s, w.io, { username: 'Cy', password: 'long-enough' });
        // "Cy" is 2 characters: the name rules answer first; a 3+ name shows the hold
        expect(reply(s, 'signUpResponse')).toMatchObject({ success: false });

        const dee = await signedIn('Dee');
        expect(await deleteOwn(dee)).toEqual({ success: true });
        await auth.signUp(s, w.io, { username: 'Dee', password: 'long-enough' });
        expect(reply(s, 'signUpResponse')).toEqual({ success: false, message: 'That name is taken.' });
        await auth.signUp(s, w.io, { username: 'DEE', password: 'long-enough' });
        expect(reply(s, 'signUpResponse')).toEqual({ success: false, message: 'That name is taken: "Dee" already exists, and capital letters don\'t make a different name.' });
        expect(await users().countDocuments({ username: { $regex: '^dee$', $options: 'i' } })).toBe(1);
    });

    test('a lapsed hold frees itself at the next sign-up (before the TTL index runs)', async () => {
        const dee = await signedIn('Dee');
        expect(await deleteOwn(dee)).toEqual({ success: true });
        await users().updateOne({ username: 'Dee' }, { $set: { nameHeldUntil: new Date(Date.now() - 1000) } });
        const s = w.socket(`acc-${++n}`);
        await auth.signUp(s, w.io, { username: 'Dee', password: 'long-enough' });
        expect(reply(s, 'signUpResponse')).toMatchObject({ success: true, username: 'Dee' });
        expect(await users().findOne({ username: 'Dee' })).toMatchObject({ password: expect.any(String) });
        expect(await users().findOne({ username: 'Dee' })).not.toHaveProperty('mergedInto');
    });

    test('rejoinGame, spectate and /active never hand a deleted owner\'s seat to a new account with the name', async () => {
        const { game } = seatedGame(['Zed', 'Q1', 'Q2', 'Q3']);
        const pos = game.seatByUsername('Zed');
        // The deletion of a seated player is refused; this is the defence in
        // depth for any path that frees the name while the game lives
        // (an admin freeing the hold at once, a process that skipped the check)
        await forgetAccount(w.io, { users: users() }, 'Zed');
        await users().insertOne({ username: 'Zed', password: PW }); // a new account, same name
        const z = await signedIn('Zed');
        await reconnectHandlers.rejoinGame(z, w.io, { gameId: game.gameId, username: 'Zed' });
        expect(reply(z, 'rejoinFailed')).toEqual({ reason: 'Not a player in this game' });
        expect(game.seat(pos).ownerSocketId).not.toBe(z.id);

        // a bot-played seat: spectating does not make the new account its owner
        game.forceSeat(pos, { controller: 'lazyBot', presence: 'away', bot: { socketId: 'bot:Mary:t2', username: '🤖 Mary' } });
        await mainRoomHandlers.joinAsSpectator(z, w.io, { gameId: game.gameId });
        expect(game.seat(pos).ownerSocketId).not.toBe(z.id);
        chatHandlers.chatMessage(z, w.io, { message: '/active' });
        expect(game.seat(pos).ownerSocketId).not.toBe(z.id);

        // a game created after the deletion is the new account's to play
        const later = seatedGame(['Zed', 'R1', 'R2', 'R3']).game;
        later.createdAt = Date.now() + 1;
        const z2 = await signedIn('Zed');
        await reconnectHandlers.rejoinGame(z2, w.io, { gameId: later.gameId, username: 'Zed' });
        expect(reply(z2, 'rejoinFailed')).toBeUndefined();
    });
});

describe('restoreSessionResponse retryable', () => {
    test('a database error and a merge lock are retryable; a bad token, an unknown user and a revoked session are not', async () => {
        const bea = await signedIn('Bea');
        const token = bea.sessionToken;
        const findOne = users().findOne.bind(users());
        users().findOne = async () => { throw new Error('connection reset'); };
        expect((await restore('Bea', token)).reply).toEqual({ success: false, message: 'Database error. Try again.', retryable: true });
        users().findOne = findOne;

        gameManager.lockForMerge(['Bea']);
        try {
            expect((await restore('Bea', token)).reply).toEqual({ success: false, message: 'This account is being updated. Please try again in a minute.', retryable: true });
        } finally {
            gameManager.unlockMerge(['Bea']);
        }
        // and the token still works once the lock is gone
        expect((await restore('Bea', token)).reply).toMatchObject({ success: true, username: 'Bea' });

        expect((await restore('Bea', '11111111-1111-4111-8111-111111111111')).reply).toEqual({ success: false, message: 'Invalid session token' });
        expect((await restore('Nobody', token)).reply).toEqual({ success: false, message: 'User not found' });
    });

    test('the re-check read failing after the write is retryable too (it used to say "Invalid session token")', async () => {
        const bea = await signedIn('Bea');
        const findOne = users().findOne.bind(users());
        let calls = 0;
        users().findOne = async (...args) => {
            if (++calls === 2) throw new Error('timeout'); // sessionGoneSince's read
            return findOne(...args);
        };
        try {
            expect((await restore('Bea', bea.sessionToken)).reply).toEqual({ success: false, message: 'Database error. Try again.', retryable: true });
        } finally {
            users().findOne = findOne;
        }
    });
});

describe('changePassword', () => {
    const change = async (s, current, next) => {
        await asyncHandler('changePassword', auth.changePassword)(s, w.io, { current, next });
        return reply(s, 'changePasswordResponse');
    };

    test('Joi takes 1-100 (the rule message comes from the handler); a missing field is a validation error', () => {
        expect(() => validate('changePassword', { current: 'x', next: 'y' })).not.toThrow();
        expect(() => validate('changePassword', { current: 'x' })).toThrow();
        expect(() => validate('changePassword', { current: '', next: 'long-enough' })).toThrow();
        expect(() => validate('changePassword', { current: 'x', next: 'n'.repeat(101) })).toThrow();
    });

    test('success: this device stays signed in, every other socket is signed out and every other saved session revoked, open reset links cancelled', async () => {
        const laptop = await signedIn('Bea'); // another device's saved session (token L)
        const phone = await signedIn('Bea'); // this device (token P); the laptop's socket is kicked
        const tab2 = await restore('Bea', phone.sessionToken); // a second tab of this device: phone's socket is parked
        expect(tab2.reply).toMatchObject({ success: true });
        const link = await createResetLink(mockDb.current, 'Bea', { by: 'Owner' });
        const before = await users().findOne({ username: 'Bea' });
        expect(before.sessionTokens).toHaveLength(2);
        const mark = w.log.length;

        expect(await change(tab2, OLD_PW, 'brand-new-pw')).toEqual({ success: true, message: 'Password changed. Your other devices were signed out.' });
        const after = await users().findOne({ username: 'Bea' });
        expect(await bcrypt.compare('brand-new-pw', after.password)).toBe(true);
        expect(after.sessionTokens.map(t => t.hash)).toEqual([hashToken(phone.sessionToken)]);
        expect(after.sessionEpoch).toBe((before.sessionEpoch || 0) + 1);
        expect(after.passwordChangedAt).toBeInstanceOf(Date);
        const since = w.log.slice(mark);
        expect(since.some(l => l.to === `self:${tab2.id}` && l.event === 'forceLogout')).toBe(false);
        expect(since.some(l => l.to === `self:${phone.id}` && l.event === 'forceLogout')).toBe(true);
        expect(w.io.sockets.sockets.has(tab2.id)).toBe(true);
        expect(w.io.sockets.sockets.has(phone.id)).toBe(false);
        expect(gameManager.getUserBySocketId(tab2.id)).toMatchObject({ username: 'Bea' });
        expect(mockDb.current.passwordResets.all().find(r => r.username === 'Bea').state).toBe('revoked');
        expect(await useResetLink(mockDb.current, link.token, 'leaked-link-pw', { hash: (p) => bcrypt.hash(p, 4) })).toMatchObject({ ok: false });

        // the laptop's saved session is gone; this device's still restores
        expect((await restore('Bea', laptop.sessionToken)).reply).toEqual({ success: false, message: 'Invalid session token' });
        expect((await restore('Bea', phone.sessionToken)).reply).toMatchObject({ success: true });
        // and the new password signs in, the old one no longer
        const s = w.socket(`acc-${++n}`);
        await auth.signIn(s, w.io, { username: 'Bea', password: OLD_PW });
        expect(reply(s, 'signInResponse')).toMatchObject({ success: false });
        expect((await signedIn('Bea', 'brand-new-pw')).sessionToken).toEqual(expect.any(String));
    });

    test('refusals: short, too long, unchanged, not signed in; none counts as a failed sign-in', async () => {
        const bea = await signedIn('Bea');
        expect(await change(bea, OLD_PW, 'short7!')).toEqual({ success: false, message: 'Password must be 8-100 characters.' });
        expect(await change(bea, 'same-password', 'same-password')).toEqual({ success: false, message: 'Choose a new password that is different from the current one.' });
        const anon = w.socket(`acc-${++n}`);
        expect(await change(anon, OLD_PW, 'brand-new-pw')).toEqual({ success: false, message: 'Not signed in' });
        expect(await users().findOne({ username: 'Bea' })).toMatchObject({ password: PW });
        // eight is enough
        expect(await change(bea, OLD_PW, '12345678')).toMatchObject({ success: true });
    });

    test('a wrong current password counts like a failed sign-in: throttled after the pair limit, across sockets', async () => {
        const bea = await signedIn('Bea');
        bea.data.clientIp = '203.0.113.9'; // the (ip, username) pair: 10 failures
        for (let i = 0; i < 10; i++) {
            rateLimiter.clearSocket(bea.id);
            expect(await change(bea, `wrong-${i}`, 'brand-new-pw')).toEqual({ success: false, message: 'Your current password is incorrect.' });
        }
        rateLimiter.clearSocket(bea.id);
        expect(await change(bea, OLD_PW, 'brand-new-pw')).toEqual({ success: false, message: 'Too many incorrect passwords. Please wait a few minutes and try again.' });
        const s = w.socket(`acc-${++n}`);
        s.data.clientIp = '203.0.113.9';
        await auth.signIn(s, w.io, { username: 'Bea', password: OLD_PW });
        expect(reply(s, 'signInResponse')).toMatchObject({ success: false, message: expect.stringMatching(/Too many failed sign-in attempts/) });
    });

    test('the wrapper limit: 5 a socket per 5 minutes, then serverError', async () => {
        const bea = await signedIn('Bea');
        for (let i = 0; i < 5; i++) await change(bea, OLD_PW, 'short');
        await asyncHandler('changePassword', auth.changePassword)(bea, w.io, { current: OLD_PW, next: 'brand-new-pw' });
        expect(reply(bea, 'serverError')).toMatchObject({ code: 'rateLimit' });
    });

    test('a reset that lands while the new hash is computed wins: nothing is written', async () => {
        const bea = await signedIn('Bea');
        const passwordHash = require('../../utils/passwordHash');
        const real = passwordHash.hash;
        passwordHash.hash = async (...args) => {
            passwordHash.hash = real;
            await setPassword(mockDb.current, 'Bea', 'maple-otter-42', { rounds: 4 });
            return real(...args);
        };
        expect(await change(bea, OLD_PW, 'brand-new-pw')).toEqual({ success: false, message: 'Your password was changed somewhere else meanwhile. Sign in again and try again.' });
        expect(await bcrypt.compare('maple-otter-42', (await users().findOne({ username: 'Bea' })).password)).toBe(true);
    });
});

describe('new passwords need 8 characters; old short ones still sign in', () => {
    test('sign-up refuses 7, takes 8; a 2-character legacy password signs in', async () => {
        const s = w.socket(`acc-${++n}`);
        await auth.signUp(s, w.io, { username: 'Newbie', password: '1234567' });
        expect(reply(s, 'signUpResponse')).toEqual({ success: false, message: 'Password must be 8-100 characters.' });
        expect(await users().findOne({ username: 'Newbie' })).toBeNull();
        await auth.signUp(s, w.io, { username: 'Newbie', password: '12345678' });
        expect(reply(s, 'signUpResponse')).toMatchObject({ success: true, username: 'Newbie' });
        expect((await signedIn('Cy', OLD_PW)).sessionToken).toEqual(expect.any(String));
    });
});

describe('passwordReset notice', () => {
    test('after a reset link: on the next sign-in only, with by and at; then gone', async () => {
        const link = await createResetLink(mockDb.current, 'Bea', { by: 'Owner' });
        const at = new Date('2026-11-14T09:30:00Z');
        expect(await useResetLink(mockDb.current, link.token, 'from-the-link', { now: at, hash: (p) => bcrypt.hash(p, 4) })).toMatchObject({ ok: true });
        const s = await signedIn('Bea', 'from-the-link');
        expect(reply(s, 'signInResponse')).toMatchObject({ success: true, passwordReset: { by: 'link', at: at.toISOString() } });
        expect(await users().findOne({ username: 'Bea' })).not.toHaveProperty('passwordResetNotice');
        expect((await restore('Bea', s.sessionToken)).reply).not.toHaveProperty('passwordReset');
        expect(reply(await signedIn('Bea', 'from-the-link'), 'signInResponse')).not.toHaveProperty('passwordReset');
    });

    test('after an admin set a password (scripts/set-password.js): by admin; a restore that comes first tells it too', async () => {
        const bea = await signedIn('Bea');
        await setPassword(mockDb.current, 'Bea', 'maple-otter-42', { rounds: 4 });
        // every session was revoked, so the notice reaches the next sign-in
        expect((await restore('Bea', bea.sessionToken)).reply).toMatchObject({ success: false });
        const s = await signedIn('Bea', 'maple-otter-42');
        expect(reply(s, 'signInResponse').passwordReset).toMatchObject({ by: 'admin', at: expect.any(String) });
        // a restore with the notice still pending (its sign-in reply lost) carries it once
        await users().updateOne({ username: 'Bea' }, { $set: { passwordResetNotice: { by: 'admin', at: new Date() } } });
        expect((await restore('Bea', s.sessionToken)).reply).toMatchObject({ success: true, passwordReset: { by: 'admin' } });
        expect((await restore('Bea', s.sessionToken)).reply).not.toHaveProperty('passwordReset');
    });
});
