/**
 * Username rules for new sign-ups (owner, 2026-11-11; server/utils/usernameRules.js)
 * through the real signUp handler: the full format matrix, the
 * case-insensitive "taken" check against the names that exist today, and
 * that existing accounts (including ones the new rules would refuse) still
 * sign in, restore and resolve exactly as before.
 */

const bcrypt = require('bcryptjs');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

jest.mock('../../game/GameManager', () => ({
    registerUser: jest.fn(),
    // one socket signs up several accounts in a row: each releases the last
    // (sessionIdentity.releaseIdentity)
    removeUserSocket: jest.fn(),
    handleDisconnect: jest.fn(() => ({})),
    releaseHeldLobbySeat: jest.fn(() => null),
    getOnlineUsernames: jest.fn(() => []),
    getGameById: jest.fn(() => null),
    getTournamentById: jest.fn(() => null),
    clearActiveGame: jest.fn(),
    clearActiveTournament: jest.fn(),
    getUserBySocketId: jest.fn(),
    deletedUsernames: new Set(),
}));

const auth = require('../authHandlers');
const profile = require('../profileHandlers');
const { validate } = require('../validators');
const rules = require('../../utils/usernameRules');
const { authLogger } = require('../../utils/logger');

// Names that exist in production today, plus legacy shapes the new rules refuse
const EXISTING = ['Alan T', 'JoAnn Jameson', 'Danny', 'Al', 'x', 'An Exceptionally Long Legacy Name', 'trailing ', 'Ünïcode'];

let io;
let n = 0;
const connect = () => {
    const socket = { id: `s-${++n}`, data: {}, emit: jest.fn(), disconnect: jest.fn(), join: jest.fn(), leave: jest.fn() };
    io.sockets.sockets.set(socket.id, socket);
    return socket;
};
const lastEmit = (socket, event) => {
    const calls = socket.emit.mock.calls.filter(([e]) => e === event);
    return calls.length ? calls[calls.length - 1][1] : undefined;
};
async function signUp(username, password = 'secret') {
    const socket = connect();
    await auth.signUp(socket, io, { username, password });
    return lastEmit(socket, 'signUpResponse');
}

beforeEach(async () => {
    jest.clearAllMocks();
    for (const m of ['info', 'warn', 'debug']) jest.spyOn(authLogger, m).mockImplementation(() => {});
    io = { sockets: { sockets: new Map() } };
    const password = await bcrypt.hash('pw', 4);
    mockDb.current = createMemoryDb({
        users: [
            ...EXISTING.map((username) => ({ username, password, stats: { gamesPlayed: 1 } })),
            { username: 'alan2', mergedInto: 'Alan T', mergedAt: new Date() },
        ],
    });
});

afterEach(() => jest.restoreAllMocks());

describe('the format matrix (checkNewUsername)', () => {
    const M = rules.MESSAGES;
    test.each([
        // accepted
        ['Bob', true],
        ['bob', true],
        ['Alan B', true],
        ['Jo-Ann', true],
        ['J.R. Smith', true],
        ['mary_2', true],
        ['007', true],
        ['abc', true],
        ['A'.repeat(20), true],
        ['a b c d e f g h i j', true],
        // refused
        ['', M.empty],
        ['   ', M.empty],
        [null, M.empty],
        [42, M.empty],
        ['ab', M.tooShort],
        ['A'.repeat(21), M.tooLong],
        [' Bob', M.edgeSpace],
        ['Bob ', M.edgeSpace],
        ['Bob\t', M.edgeSpace],
        ['Al  T', M.doubleSpace],
        ['_bob', M.start],
        ['-bob', M.start],
        ['.bob', M.start],
        ['🤖 Mary', M.botPrefix],
        ['🤖Mary', M.botPrefix],
        [' 🤖 Mary', M.botPrefix],
        ['🤖 Bot 2', M.botPrefix],
        ['Mary 🤖', M.emoji],
        ['Cool😎', M.emoji],
        ['flag🇺🇸', M.emoji],
        ['heart❤️', M.emoji],
        ['Zoë', M.characters],
        ['Ünïcode', M.characters],
        ['bob@home', M.characters],
        ['bob!', M.characters],
        ['tab\there', M.characters],
        ['line\nbreak', M.characters],
        ['ｆｕｌｌ', M.characters],
        ['zero​width', M.characters],
    ])('%p -> %p', (name, expected) => {
        const r = rules.checkNewUsername(name);
        if (expected === true) expect(r).toEqual({ ok: true });
        else expect(r).toMatchObject({ ok: false, message: expected });
    });

    test('every existing production-style name with a space passes as a new name too', () => {
        for (const name of ['Alan T', 'JoAnn Jameson']) expect(rules.checkNewUsername(name)).toEqual({ ok: true });
    });
});

describe('findNameClash: exactness comes from the stored name', () => {
    // A collection whose exact lookup misses and whose case-insensitive
    // lookup then finds `stored`: what a sign-up sees when a concurrent
    // sign-up inserts the same name between its two findOne calls
    const racing = (stored) => {
        let call = 0;
        return { findOne: async () => (++call === 1 ? null : stored) };
    };

    test('the same name inserted between the two lookups is an exact clash ("That name is taken.")', async () => {
        const clash = await rules.findNameClash(racing({ username: 'Racer' }), 'Racer');
        expect(clash).toEqual({ username: 'Racer', exact: true });
        expect(rules.takenMessage('Racer', clash)).toBe(rules.MESSAGES.taken);
    });

    test('a tombstone with the same name found that way keeps the merged-account redirect (exact)', async () => {
        const clash = await rules.findNameClash(racing({ username: 'alan2', mergedInto: 'Alan T' }), 'alan2');
        expect(clash).toMatchObject({ exact: true, mergedInto: 'Alan T' });
    });

    test('a real case variant is still not exact and names the account that exists', async () => {
        const clash = await rules.findNameClash(racing({ username: 'Racer' }), 'rACER');
        expect(clash).toEqual({ username: 'Racer', exact: false });
        expect(rules.takenMessage('rACER', clash)).toMatch(/"Racer" already exists/);
    });
});

describe('sign-up through the handler', () => {
    test('a valid new name registers (and the reply carries it exactly)', async () => {
        const res = await signUp('Alan B');
        expect(res).toMatchObject({ success: true, username: 'Alan B', autoLoggedIn: true });
        expect(await mockDb.current.users.countDocuments({ username: 'Alan B' })).toBe(1);
    });

    test.each([
        ['ab', rules.MESSAGES.tooShort],
        ['🤖 Mary', rules.MESSAGES.botPrefix],
        ['Bob ', rules.MESSAGES.edgeSpace],
        ['Zoë', rules.MESSAGES.characters],
        ['A'.repeat(21), rules.MESSAGES.tooLong],
    ])('%p is refused with a specific message and writes nothing', async (name, message) => {
        const before = await mockDb.current.users.countDocuments({});
        expect(await signUp(name)).toEqual({ success: false, message });
        expect(await mockDb.current.users.countDocuments({})).toBe(before);
    });

    test('a name longer than 20 but within Joi (50) gets the rule message, not a validation error', () => {
        expect(() => validate('signUp', { username: 'A'.repeat(30), password: 'pw' })).not.toThrow();
    });

    test.each([
        ['Alan T', 'That name is taken.'],
        ['alan T', 'Alan T'],
        ['ALAN T', 'Alan T'],
        ['alan t', 'Alan T'],
        ['joann jameson', 'JoAnn Jameson'],
        ['DANNY', 'Danny'],
        ['Trailing', 'trailing '],
    ])('%p clashes with an existing account ignoring case and surrounding whitespace', async (name, shown) => {
        const res = await signUp(name);
        expect(res.success).toBe(false);
        if (shown === 'That name is taken.') expect(res.message).toBe(shown);
        else expect(res.message).toBe(`That name is taken: "${shown}" already exists, and capital letters don't make a different name.`);
        expect(await mockDb.current.users.countDocuments({ username: name })).toBe(name === 'Alan T' ? 1 : 0);
    });

    test('a merged tombstone keeps its redirect; a case variant of it names the kept account', async () => {
        expect((await signUp('alan2')).message).toContain('Please sign in as Alan T');
        expect((await signUp('ALAN2')).message).toBe('That name is taken: "Alan T" already exists, and capital letters don\'t make a different name.');
    });

    test('regex characters in a new name are matched literally', async () => {
        await mockDb.current.users.insertOne({ username: 'JxR Smith', password: 'x' });
        // '.' would match 'x' if it were not escaped
        expect(await signUp('J.R Smith')).toMatchObject({ success: true });
        expect(await signUp('j.r smith')).toMatchObject({ success: false });
    });

    test('Alan / Alan T / Alan Tx are different names', async () => {
        expect(await signUp('Alan')).toMatchObject({ success: true });
        expect(await signUp('Alan Tx')).toMatchObject({ success: true });
    });
});

describe('existing accounts are untouched', () => {
    test.each(EXISTING)('%p still signs in (exact) and restores its session', async (username) => {
        const socket = connect();
        await auth.signIn(socket, io, { username, password: 'pw' });
        const res = lastEmit(socket, 'signInResponse');
        expect(res).toMatchObject({ success: true, username });
        const again = connect();
        await auth.restoreSession(again, io, { username, sessionToken: res.sessionToken });
        expect(lastEmit(again, 'restoreSessionResponse')).toMatchObject({ success: true, username });
    });

    test('sign-in stays exact: a case variant is an unknown user', async () => {
        const socket = connect();
        await auth.signIn(socket, io, { username: 'alan t', password: 'pw' });
        expect(lastEmit(socket, 'signInResponse')).toMatchObject({ success: false });
    });

    test('profile lookup stays exact on the stored name', async () => {
        const socket = connect();
        await profile.getPlayerProfile(socket, io, { username: 'JoAnn Jameson' });
        expect(lastEmit(socket, 'playerProfileResponse').profile.username).toBe('JoAnn Jameson');
    });
});

describe('the sign-up budget (one socket, through the real asyncHandler wrapper)', () => {
    const { asyncHandler, rateLimiter } = require('../errorHandler');
    const wrapped = asyncHandler('signUp', auth.signUp);
    let socket;
    const attempt = async (username) => {
        socket.emit.mockClear();
        await wrapped(socket, io, { username, password: 'secret' });
        return { reply: lastEmit(socket, 'signUpResponse'), error: lastEmit(socket, 'serverError') };
    };

    beforeEach(() => { socket = connect(); });
    afterEach(() => rateLimiter.clearSocket(socket.id));

    test('names refused by the rules or as taken never lock the player out: the next good name registers', async () => {
        for (const name of ['ab', '🤖 Mary', 'Bob ', 'Zoë', 'A'.repeat(21), 'alan t', 'DANNY', 'Alan T']) {
            const { reply, error } = await attempt(name);
            expect(error).toBeUndefined();
            expect(reply.success).toBe(false);
            expect(reply.message).not.toMatch(/Too many/);
        }
        const { reply, error } = await attempt('Alan B');
        expect(error).toBeUndefined();
        expect(reply).toMatchObject({ success: true, username: 'Alan B' });
    });

    test('cheap refusals still have a cap: past rateLimiter.signUp the wrapper answers error rateLimit', async () => {
        const { max } = rateLimiter.limits.signUp;
        expect(max).toBeGreaterThanOrEqual(10);
        for (let i = 0; i < max; i++) expect((await attempt('ab')).reply.success).toBe(false);
        const over = await attempt('Fresh Name');
        expect(over.reply).toBeUndefined();
        expect(over.error).toMatchObject({ code: 'rateLimit', handler: 'signUp' });
        expect(await mockDb.current.users.countDocuments({ username: 'Fresh Name' })).toBe(0);
    });

    test('an attempt that hashes and inserts spends the account budget (3 / 5 min); the 4th is refused before any hash', async () => {
        expect(rateLimiter.limits.signUpAccount).toEqual({ max: 3, windowMs: 300000 });
        for (const name of ['Acct One', 'Acct Two', 'Acct Three']) {
            expect((await attempt(name)).reply).toMatchObject({ success: true, username: name });
        }
        const hash = jest.spyOn(require('../../utils/passwordHash'), 'hash');
        const fourth = await attempt('Acct Four');
        expect(fourth.error).toBeUndefined();
        expect(fourth.reply).toEqual({ success: false, message: 'Too many sign-up attempts. Please wait a few minutes and try again.' });
        expect(hash).not.toHaveBeenCalled();
        expect(await mockDb.current.users.countDocuments({ username: 'Acct Four' })).toBe(0);
        // A refusal by the rules still gets its own message, not the budget one
        expect((await attempt('ab')).reply.message).toBe(rules.MESSAGES.tooShort);
    });
});
