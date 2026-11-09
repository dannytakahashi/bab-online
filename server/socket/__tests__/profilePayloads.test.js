/**
 * Profile replies and uploads with the avatar pipeline ON (roadmap item
 * 10; docs/avatars.md): leaderboard (both shapes cached together), search,
 * profiles, and new uploads stored as the canonical WebP. Real sharp, real
 * timers, memoryDb. AVATAR_REPORT=1 prints the byte table.
 */

const sharp = require('sharp');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports
}));

const gameManager = require('../../game/GameManager');
const profile = require('../profileHandlers');
const clientInfo = require('../clientInfo');
const avatarStore = require('../../avatar/avatarStore');
const { PLACEHOLDER_INLINE } = require('../../avatar/placeholder');
const { asyncHandler, rateLimiter } = require('../errorHandler');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');
const fx = require('../../testUtils/avatarFixtures');
const { authLogger, logger } = require('../../utils/logger');

const REPORT = process.env.AVATAR_REPORT === '1';
const report = [];
const HELLO = { client: 'web', version: '1.0.0', caps: ['avatarUrl'] };
const URL_RE = /^\/avatar\/[^/?#\s]+\?v=[0-9a-f]{16}$/;

let log;
let io;
let n = 0;
let PICS;
const sock = (capable, username) => {
    const s = makeSocket(`pp-${++n}`, log, io);
    if (capable) clientInfo.handle(s, io, HELLO);
    if (username) gameManager.registerUser(s.id, username);
    return s;
};
const lastTo = (s, event) => log.filter((l) => l.to === `self:${s.id}` && l.event === event).pop()?.data;
const bytes = (d) => Buffer.byteLength(JSON.stringify(d));
const stats = (g, w) => ({ gamesPlayed: g, wins: w, losses: g - w, totalPoints: g * 200, totalTricksBid: g * 10, totalTricksTaken: g * 11, totalHands: g * 13, totalSets: g, totalSetPoints: -g * 30, totalFaults: 0, totalHSI: g * 100 });

/** 30 leaderboard users; the first `custom` have a ~46 K-char custom picture. */
function users(custom) {
    return Array.from({ length: 30 }, (_, i) => ({
        username: `player${String(i).padStart(2, '0')}`,
        profilePic: (i % 82) + 1,
        stats: stats(10 + i, 5),
        ...(i < custom ? { customProfilePic: PICS[i] } : {}),
    }));
}

beforeAll(async () => {
    PICS = [];
    for (let i = 0; i < 30; i++) PICS.push(fx.dataUrl(await fx.avatarPng(110, 100 + i)));
});
afterAll(() => {
    rateLimiter.shutdown();
    if (REPORT) process.stdout.write(`\n${report.map((r) => JSON.stringify(r)).join('\n')}\n`);
});

beforeEach(() => {
    log = [];
    io = makeIo(log);
    profile._resetCachesForTests();
    avatarStore._reset();
    avatarStore.configure({ enabled: true });
    for (const l of [authLogger, logger]) for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    jest.restoreAllMocks();
    avatarStore._reset();
});

async function leaderboardBoth(custom) {
    mockDb.current = createMemoryDb({ users: users(custom) });
    const cap = sock(true);
    const leg = sock(false);
    await profile.getLeaderboard(cap, io);
    await profile.getLeaderboard(leg, io);
    return { cap: lastTo(cap, 'leaderboardResponse'), leg: lastTo(leg, 'leaderboardResponse') };
}

test('leaderboard, 30 rows with 10 custom pictures: capable <= 12 KB, legacy <= 200 KB; both shapes from one fill', async () => {
    expect(PICS[0].length).toBeGreaterThan(40000);
    avatarStore.configure({ enabled: false });
    const off = await leaderboardBoth(10);
    profile._resetCachesForTests();
    avatarStore.configure({ enabled: true });
    const on = await leaderboardBoth(10);

    expect(bytes(on.cap)).toBeLessThanOrEqual(12000);
    expect(bytes(on.leg)).toBeLessThanOrEqual(200000);
    expect(Object.keys(on.cap.avatarUrls)).toHaveLength(10);
    for (const u of Object.values(on.cap.avatarUrls)) expect(u).toMatch(URL_RE);
    expect(on.leg.avatarUrls).toBeUndefined();
    for (const row of on.cap.leaderboard) {
        expect(row.customProfilePic ?? null).toBeNull();
    }
    for (const row of on.leg.leaderboard.filter((r) => r.customProfilePic)) {
        expect(row.customProfilePic.length).toBeLessThanOrEqual(16384);
        expect(await fx.iosLegacyDecodes(row.customProfilePic)).toBe(true);
    }
    // everything but the pictures is today's reply
    const strip = (rows) => rows.map(({ customProfilePic, ...rest }) => rest);
    expect(strip(on.cap.leaderboard)).toEqual(strip(off.leg.leaderboard));
    expect(strip(on.leg.leaderboard)).toEqual(strip(off.leg.leaderboard));
    // pipeline off: both sockets get exactly today's payload
    expect(off.cap).toEqual(off.leg);
    // the cache holds no long string
    const cached = profile._peekLeaderboardCache();
    const long = JSON.stringify(cached).match(/"[^"]{16385,}"/g);
    expect(long).toBeNull();
    report.push({ scenario: 'leaderboard 30 rows, 10 custom (~46 K chars each)', off: bytes(off.leg), legacy: bytes(on.leg), capable: bytes(on.cap) });
});

test('leaderboard with 0 and 30 custom pictures', async () => {
    const none = await leaderboardBoth(0);
    expect(none.cap).toEqual(none.leg);
    expect(none.cap.avatarUrls).toBeUndefined();
    profile._resetCachesForTests();
    const all = await leaderboardBoth(30);
    expect(bytes(all.leg)).toBeLessThanOrEqual(30 * (300 + 16384));
    expect(bytes(all.cap)).toBeLessThanOrEqual(15000);
    avatarStore.configure({ enabled: false });
    profile._resetCachesForTests();
    const allOff = await leaderboardBoth(30);
    report.push({ scenario: 'leaderboard 30 rows, 30 custom', off: bytes(allOff.leg), legacy: bytes(all.leg), capable: bytes(all.cap), noCustom: bytes(none.leg) });
});

test('throttled replies (over the soft limit) still pick the shape per socket', async () => {
    mockDb.current = createMemoryDb({ users: users(5) });
    const cap = sock(true);
    const leg = sock(false);
    await profile.getLeaderboard(cap, io); // fills the cache
    for (const s of [cap, leg]) {
        for (let i = 0; i < 11; i++) await profile.getLeaderboard(s, io);
    }
    const capThrottled = log.filter((l) => l.to === `self:${cap.id}` && l.event === 'leaderboardResponse');
    const legThrottled = log.filter((l) => l.to === `self:${leg.id}` && l.event === 'leaderboardResponse');
    expect(capThrottled.length).toBe(12);
    for (const l of capThrottled) expect(Object.keys(l.data.avatarUrls)).toHaveLength(5);
    for (const l of legThrottled) {
        expect(l.data.avatarUrls).toBeUndefined();
        expect(l.data.leaderboard.filter((r) => r.customProfilePic)).toHaveLength(5);
    }
    rateLimiter.clearSocket(cap.id);
    rateLimiter.clearSocket(leg.id);
});

test('search, 10 custom hits: capable <= 5 KB with avatarUrls; legacy rows inline', async () => {
    mockDb.current = createMemoryDb({ users: users(10) });
    const cap = sock(true);
    const leg = sock(false);
    await profile.searchPlayers(cap, io, { query: 'player0' });
    await profile.searchPlayers(leg, io, { query: 'player0' });
    const c = lastTo(cap, 'searchPlayersResponse');
    const l = lastTo(leg, 'searchPlayersResponse');
    expect(c.players).toHaveLength(10);
    expect(bytes(c)).toBeLessThanOrEqual(5000);
    expect(Object.keys(c.avatarUrls)).toHaveLength(10);
    expect(c.players.every((p) => p.customProfilePic === null)).toBe(true);
    expect(l.avatarUrls).toBeUndefined();
    for (const p of l.players) expect(await fx.iosLegacyDecodes(p.customProfilePic)).toBe(true);
    avatarStore.configure({ enabled: false });
    const o = sock(false);
    await profile.searchPlayers(o, io, { query: 'player0' });
    report.push({ scenario: 'search, 10 custom hits', off: bytes(lastTo(o, 'searchPlayersResponse')), legacy: bytes(l), capable: bytes(c) });
});

test('getProfile and getPlayerProfile in both shapes; a hostile stored picture gives the placeholder', async () => {
    mockDb.current = createMemoryDb({ users: [...users(2), { username: 'eve', profilePic: 4, customProfilePic: fx.dataUrl(fx.SVG) }] });
    const cap = sock(true, 'player00');
    const leg = sock(false, 'player01');
    await profile.getProfile(cap, io);
    await profile.getProfile(leg, io);
    const c = lastTo(cap, 'profileResponse');
    const l = lastTo(leg, 'profileResponse');
    expect(c.profile.customProfilePic).toBeNull();
    expect(c.avatarUrl).toMatch(URL_RE);
    expect(l.avatarUrl).toBeUndefined();
    expect(await fx.iosLegacyDecodes(l.profile.customProfilePic)).toBe(true);
    expect(Object.keys(l)).toEqual(['success', 'profile']);
    expect(Object.keys(l.profile)).toEqual(['username', 'profilePic', 'customProfilePic', 'stats']);

    await profile.getPlayerProfile(cap, io, { username: 'player01' });
    expect(lastTo(cap, 'playerProfileResponse').avatarUrl).toMatch(/^\/avatar\/player01\?v=/);
    await profile.getPlayerProfile(cap, io, { username: 'eve' });
    const eve = lastTo(cap, 'playerProfileResponse');
    expect(eve.avatarUrl).toBeUndefined();
    expect(eve.profile.customProfilePic).toBe(PLACEHOLDER_INLINE);
    await profile.getPlayerProfile(leg, io, { username: 'player05' });
    expect(lastTo(leg, 'playerProfileResponse').profile.customProfilePic).toBeNull();
    report.push({ scenario: 'getProfile (~46 K-char custom)', off: bytes({ success: true, profile: { ...l.profile, customProfilePic: PICS[0] } }), legacy: bytes(l), capable: bytes(c) });
});

describe('uploads', () => {
    const upload = (s, data) => asyncHandler('uploadProfilePic', profile.uploadProfilePic)(s, io, data);
    let s;
    beforeEach(() => {
        mockDb.current = createMemoryDb({ users: users(0) });
        s = sock(true, 'player03');
    });
    afterEach(() => rateLimiter.clearSocket(s.id));
    const stored = () => mockDb.current.users.docs.find((d) => d.username === 'player03').customProfilePic;

    test('a valid PNG is stored as a WebP data URL <= 256 px; the echo carries avatarUrl; versions change', async () => {
        const leg = sock(false);
        await profile.getLeaderboard(leg, io);
        const before = lastTo(leg, 'leaderboardResponse');
        await upload(s, { imageData: fx.dataUrl(await fx.avatarPng(612, 3, 360)) });
        const r = lastTo(s, 'profilePicUploadResponse');
        expect(r.success).toBe(true);
        expect(r.customProfilePic).toBe(stored());
        expect(stored()).toMatch(/^data:image\/webp;base64,/);
        expect(stored().length).toBeLessThanOrEqual(16384);
        const m = await sharp(Buffer.from(stored().split(',')[1], 'base64')).metadata();
        expect([m.format, m.width <= 256, m.height <= 256]).toEqual(['webp', true, true]);
        expect(await fx.iosLegacyDecodes(stored())).toBe(true);
        expect(r.avatarUrl).toBe(`/avatar/player03?v=${avatarStore.versionOf(stored())}`);
        expect(avatarStore.peek(avatarStore.versionOf(stored())).owners.has('player03')).toBe(true);
        // the leaderboard re-reads (invalidated) and shows the new picture
        await profile.getLeaderboard(leg, io);
        const after = lastTo(leg, 'leaderboardResponse');
        expect(after.leaderboard.find((x) => x.username === 'player03').customProfilePic).toBe(stored());
        expect(before.leaderboard.find((x) => x.username === 'player03').customProfilePic).toBeNull();
        const v1 = avatarStore.versionOf(stored());
        await upload(s, { imageData: fx.dataUrl(await fx.avatarPng(200, 77)) });
        expect(avatarStore.versionOf(stored())).not.toBe(v1);
        expect(lastTo(s, 'profilePicUploadResponse').avatarUrl).toContain(avatarStore.versionOf(stored()));
    });

    test.each([
        ['a 12000x12000 decode bomb', () => fx.dataUrl(fx.bombPng())],
        ['SVG behind image/png', () => fx.dataUrl(fx.SVG)],
        ['garbage', () => 'data:image/png;base64,' + Buffer.from('not an image at all, sorry').toString('base64')],
        ['a truncated PNG', async () => fx.dataUrl((await fx.avatarPng(200)).subarray(0, 3000))],
    ])('%s is refused with a message and the DB is unchanged', async (name, make) => {
        await upload(s, { imageData: await make() });
        expect(lastTo(s, 'profilePicUploadResponse')).toEqual({ success: false, message: 'Could not read that image. Please try a PNG, JPEG, GIF or WebP.' });
        expect(stored()).toBeUndefined();
    });

    test('the 6th upload within 60 s is rate limited; Joi caps the string', async () => {
        const img = fx.dataUrl(await fx.avatarPng(64));
        for (let i = 0; i < 5; i++) await upload(s, { imageData: img });
        await upload(s, { imageData: img });
        const errs = log.filter((l) => l.to === `self:${s.id}` && l.event === 'error');
        expect(errs.map((e) => e.data.type)).toEqual(['rateLimit']);
        rateLimiter.clearSocket(s.id);
        await upload(s, { imageData: 'data:image/png;base64,' + 'A'.repeat(682700) });
        expect(log.filter((l) => l.to === `self:${s.id}` && l.event === 'error').pop().data.type).toBe('validation');
    });

    test('with the pipeline off the stored value and the echo are byte-identical to the upload', async () => {
        avatarStore.configure({ enabled: false });
        const img = fx.dataUrl(await fx.avatarPng(200));
        await upload(s, { imageData: img });
        expect(stored()).toBe(img);
        expect(lastTo(s, 'profilePicUploadResponse')).toEqual({ success: true, customProfilePic: img });
    });
});
