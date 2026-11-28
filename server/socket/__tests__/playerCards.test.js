/**
 * playerCards -> playerCardsResponse (2026-11-27): the pictures of the
 * Players page's online list (web PlayerSearchPage, the iOS Players sheet).
 * The online list itself stays names only; a client asks for the search
 * rows of the names it shows. Shape, parity with searchPlayers' rows and
 * avatarUrls (real sharp, the avatar pipeline on), merged accounts, unknown
 * names, the 100-name cap, repeats, the rate limit, invalid payloads, and
 * that only the asking socket is answered.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports
}));

const profile = require('../profileHandlers');
const avatarStore = require('../../avatar/avatarStore');
const { asyncHandler, rateLimiter } = require('../errorHandler');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');
const fx = require('../../testUtils/avatarFixtures');
const { authLogger, logger, socketLogger } = require('../../utils/logger');

const URL_RE = /^\/avatar\/[^/?#\s]+\?v=[0-9a-f]{16}$/;
const stats = (g, w) => ({ gamesPlayed: g, wins: w, losses: g - w, totalPoints: g * 200 });

let log;
let io;
let n = 0;
let PIC;
const sock = () => makeSocket(`cards-${++n}`, log, io);
const to = (s, event) => log.filter((l) => l.to === `self:${s.id}` && l.event === event).map((l) => l.data);
const lastTo = (s, event) => to(s, event).pop();
const cards = asyncHandler('playerCards', profile.playerCards);

beforeAll(async () => {
    PIC = fx.dataUrl(await fx.avatarPng(110, 140));
});
afterAll(() => rateLimiter.shutdown());

beforeEach(() => {
    log = [];
    io = makeIo(log);
    profile._resetCachesForTests();
    avatarStore._reset();
    avatarStore.configure({ enabled: true });
    for (const l of [authLogger, logger, socketLogger]) for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    mockDb.current = createMemoryDb({
        users: [
            { username: 'ann', profilePic: 2, stats: stats(4, 3) },
            { username: 'ben', profilePic: 30, customProfilePic: PIC, stats: stats(2, 1) },
            { username: 'cat', stats: stats(0, 0) },
            { username: 'dan', profilePic: 5 },
            { username: 'oldann', profilePic: 9, mergedInto: 'ann', mergedAt: new Date() },
            { username: 'eve', profilePic: 4, customProfilePic: fx.dataUrl(fx.SVG) },
        ],
    });
});
afterEach(() => {
    jest.restoreAllMocks();
    avatarStore._reset();
});

test('the named players\' search rows, in the order asked, with a custom picture as its URL', async () => {
    const s = sock();
    await cards(s, io, { usernames: ['dan', 'ben', 'ann', 'cat'] });
    const reply = lastTo(s, 'playerCardsResponse');
    expect(Object.keys(reply)).toEqual(['success', 'players', 'avatarUrls']);
    expect(reply.success).toBe(true);
    expect(reply.players).toEqual([
        { username: 'dan', profilePic: 5, customProfilePic: null, gamesPlayed: 0, wins: 0 },
        { username: 'ben', profilePic: 30, customProfilePic: null, gamesPlayed: 2, wins: 1 },
        { username: 'ann', profilePic: 2, customProfilePic: null, gamesPlayed: 4, wins: 3 },
        // no picture stored: stock 1, as search answers it
        { username: 'cat', profilePic: 1, customProfilePic: null, gamesPlayed: 0, wins: 0 },
    ]);
    expect(Object.keys(reply.avatarUrls)).toEqual(['ben']);
    expect(reply.avatarUrls.ben).toMatch(URL_RE);
});

test('a row is exactly the row searchPlayers answers for the same player, and so is its avatarUrls entry', async () => {
    const s = sock();
    for (const name of ['ann', 'ben', 'cat', 'dan', 'eve']) {
        await profile.searchPlayers(s, io, { query: name });
        const search = lastTo(s, 'searchPlayersResponse');
        const searchRow = search.players.find((p) => p.username === name);
        await profile.playerCards(s, io, { usernames: [name] });
        const card = lastTo(s, 'playerCardsResponse');
        expect(card.players).toEqual([searchRow]);
        expect(card.avatarUrls?.[name]).toEqual(search.avatarUrls?.[name]);
    }
    // a hostile stored picture (an SVG) has no URL in either: the stock slot, as search
    expect(lastTo(s, 'playerCardsResponse')).toEqual({ success: true, players: [{ username: 'eve', profilePic: 4, customProfilePic: null, gamesPlayed: 0, wins: 0 }] });
});

test('the pipeline off: no avatarUrls, as search', async () => {
    avatarStore.configure({ enabled: false });
    const s = sock();
    await profile.playerCards(s, io, { usernames: ['ben'] });
    expect(lastTo(s, 'playerCardsResponse')).toEqual({ success: true, players: [{ username: 'ben', profilePic: 30, customProfilePic: null, gamesPlayed: 2, wins: 1 }] });
});

test('a merged account is left out as search leaves it out; an unknown name is simply absent', async () => {
    const s = sock();
    await cards(s, io, { usernames: ['oldann', 'ghost', 'ann', '🤖 Mary', 'ANN'] });
    expect(lastTo(s, 'playerCardsResponse')).toEqual({ success: true, players: [{ username: 'ann', profilePic: 2, customProfilePic: null, gamesPlayed: 4, wins: 3 }] });
    await profile.searchPlayers(s, io, { query: 'oldann' });
    expect(lastTo(s, 'searchPlayersResponse').players).toEqual([]);
    // nobody known: an empty list, never a failure
    await cards(s, io, { usernames: ['ghost'] });
    expect(lastTo(s, 'playerCardsResponse')).toEqual({ success: true, players: [] });
});

test('repeats are answered once, and one DB read serves the whole list', async () => {
    const find = jest.spyOn(mockDb.current.users, 'find');
    const s = sock();
    await cards(s, io, { usernames: ['ann', 'dan', 'ann', 'dan', 'ann'] });
    expect(lastTo(s, 'playerCardsResponse').players.map((p) => p.username)).toEqual(['ann', 'dan']);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0]).toEqual({ username: { $in: ['ann', 'dan'] }, mergedInto: { $exists: false } });
});

test('up to 100 names a request: 100 pass, 101 is a validation error; the handler itself never reads more than 100', async () => {
    expect(profile.PLAYER_CARDS_MAX).toBe(100);
    const many = Array.from({ length: 101 }, (_, i) => `p${i}`);
    mockDb.current = createMemoryDb({ users: many.map((u, i) => ({ username: u, profilePic: (i % 82) + 1 })) });
    const s = sock();
    await cards(s, io, { usernames: many.slice(0, 100) });
    expect(lastTo(s, 'playerCardsResponse').players).toHaveLength(100);
    await cards(s, io, { usernames: many });
    expect(to(s, 'playerCardsResponse')).toHaveLength(1);
    expect(lastTo(s, 'serverError')).toMatchObject({ code: 'validation', handler: 'playerCards' });
    // called around Joi (a test, a future caller): the first 100 distinct names
    await profile.playerCards(s, io, { usernames: many });
    expect(lastTo(s, 'playerCardsResponse').players.map((p) => p.username)).toEqual(many.slice(0, 100));
});

test('invalid payloads are validation errors with no reply', async () => {
    const s = sock();
    const bad = [undefined, null, {}, { usernames: [] }, { usernames: 'ann' }, { usernames: [''] }, { usernames: [5] },
        { usernames: [null] }, { usernames: ['x'.repeat(51)] }, { usernames: { 0: 'ann' } }];
    for (const data of bad) await cards(s, io, data);
    expect(to(s, 'playerCardsResponse')).toEqual([]);
    const errors = to(s, 'serverError');
    expect(errors).toHaveLength(bad.length);
    for (const e of errors) expect(e).toMatchObject({ code: 'validation', handler: 'playerCards' });
    // extra keys are dropped (stripUnknown), the request answered
    await cards(s, io, { usernames: ['ann'], scope: 'all', extra: 1 });
    expect(lastTo(s, 'playerCardsResponse').players.map((p) => p.username)).toEqual(['ann']);
});

test('the 21st request in 10 s gets the rateLimit error', async () => {
    const s = sock();
    for (let i = 0; i < 20; i++) await cards(s, io, { usernames: ['ann'] });
    expect(to(s, 'playerCardsResponse')).toHaveLength(20);
    await cards(s, io, { usernames: ['ann'] });
    expect(to(s, 'playerCardsResponse')).toHaveLength(20);
    expect(lastTo(s, 'serverError')).toEqual({ code: 'rateLimit', message: 'Too many requests, please slow down', handler: 'playerCards' });
    // the budget is per socket and its own: search and another socket are unaffected
    await asyncHandler('searchPlayers', profile.searchPlayers)(s, io, { query: 'ann' });
    expect(lastTo(s, 'searchPlayersResponse').success).toBe(true);
    const other = sock();
    await cards(other, io, { usernames: ['ann'] });
    expect(lastTo(other, 'playerCardsResponse').success).toBe(true);
});

test('only the asking socket is answered; a DB failure is a quiet failure reply', async () => {
    const a = sock();
    const b = sock();
    await cards(a, io, { usernames: ['ann'] });
    const replies = log.filter((l) => l.event === 'playerCardsResponse');
    expect(replies.map((l) => l.to)).toEqual([`self:${a.id}`]);
    expect(to(b, 'playerCardsResponse')).toEqual([]);
    jest.spyOn(mockDb.current.users, 'find').mockImplementationOnce(() => { throw new Error('down'); });
    jest.spyOn(authLogger, 'error').mockImplementation(() => {});
    await cards(a, io, { usernames: ['ann'] });
    expect(lastTo(a, 'playerCardsResponse')).toEqual({ success: false, message: 'Database error' });
    expect(to(a, 'serverError')).toEqual([]);
});

test('the socket registers playerCards through asyncHandler with its schema and limit', () => {
    const src = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');
    expect(src).toContain("asyncHandler('playerCards', profileHandlers.playerCards)");
    expect(require('../validators').schemas.playerCards).toBeDefined();
});
