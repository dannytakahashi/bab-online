/**
 * Profile replies and uploads with the avatar pipeline ON (roadmap item
 * 10; docs/avatars.md): leaderboard, search and profiles carry
 * customProfilePic null plus avatarUrls / avatarUrl for every socket
 * (V1_REMOVALS #19 B, F: the clientHello cap no longer picks a shape), and
 * new uploads are stored as the canonical WebP. Real sharp, real
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

/** No reply carries a picture inline any more (V1_REMOVALS #19 B). */
const noInline = (rows) => rows.every((r) => r.customProfilePic === undefined || r.customProfilePic === null);

test('leaderboard, 30 rows with 10 custom pictures: every socket the same <= 12 KB reply, customProfilePic null + avatarUrls (#19 B, F)', async () => {
    expect(PICS[0].length).toBeGreaterThan(40000);
    avatarStore.configure({ enabled: false });
    const off = await leaderboardBoth(10);
    profile._resetCachesForTests();
    avatarStore.configure({ enabled: true });
    const on = await leaderboardBoth(10);

    // no clientHello no longer means another shape (#19 F)
    expect(on.leg).toEqual(on.cap);
    expect(bytes(on.cap)).toBeLessThanOrEqual(12000);
    expect(Object.keys(on.cap.avatarUrls)).toHaveLength(10);
    for (const u of Object.values(on.cap.avatarUrls)) expect(u).toMatch(URL_RE);
    expect(noInline(on.cap.leaderboard)).toBe(true);
    // everything but the pictures is today's reply
    const strip = (rows) => rows.map(({ customProfilePic, ...rest }) => rest);
    expect(strip(on.cap.leaderboard)).toEqual(strip(off.leg.leaderboard));
    // pipeline off: no URL, and still no inline picture
    expect(off.cap).toEqual(off.leg);
    expect(off.cap.avatarUrls).toBeUndefined();
    expect(noInline(off.cap.leaderboard)).toBe(true);
    // the cache holds no long string
    const cached = profile._peekLeaderboardCache();
    const long = JSON.stringify(cached).match(/"[^"]{16385,}"/g);
    expect(long).toBeNull();
    report.push({ scenario: 'leaderboard 30 rows, 10 custom (~46 K chars each)', off: bytes(off.leg), on: bytes(on.cap) });
});

test('leaderboard with 0 and 30 custom pictures', async () => {
    const none = await leaderboardBoth(0);
    expect(none.cap).toEqual(none.leg);
    expect(none.cap.avatarUrls).toBeUndefined();
    profile._resetCachesForTests();
    const all = await leaderboardBoth(30);
    expect(all.leg).toEqual(all.cap);
    expect(bytes(all.cap)).toBeLessThanOrEqual(15000);
    expect(Object.keys(all.cap.avatarUrls)).toHaveLength(30);
    report.push({ scenario: 'leaderboard 30 rows, 30 custom', on: bytes(all.cap), noCustom: bytes(none.leg) });
});

test('throttled replies (over the soft limit) carry the same URLs for every socket', async () => {
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
    for (const l of [...capThrottled, ...legThrottled]) {
        expect(Object.keys(l.data.avatarUrls)).toHaveLength(5);
        expect(noInline(l.data.leaderboard)).toBe(true);
    }
    rateLimiter.clearSocket(cap.id);
    rateLimiter.clearSocket(leg.id);
});

test('search, 10 custom hits: <= 5 KB with avatarUrls for every socket; no inline row', async () => {
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
    expect(l).toEqual(c);
    report.push({ scenario: 'search, 10 custom hits', on: bytes(c) });
});

test('getProfile and getPlayerProfile: customProfilePic null + avatarUrl for every socket; a hostile stored picture has no URL', async () => {
    mockDb.current = createMemoryDb({ users: [...users(2), { username: 'eve', profilePic: 4, customProfilePic: fx.dataUrl(fx.SVG) }] });
    const cap = sock(true, 'player00');
    const leg = sock(false, 'player01');
    await profile.getProfile(cap, io);
    await profile.getProfile(leg, io);
    const c = lastTo(cap, 'profileResponse');
    const l = lastTo(leg, 'profileResponse');
    for (const r of [c, l]) {
        expect(r.profile.customProfilePic).toBeNull();
        expect(r.avatarUrl).toMatch(URL_RE);
        expect(Object.keys(r)).toEqual(['success', 'profile', 'avatarUrl']);
        expect(Object.keys(r.profile)).toEqual(['username', 'profilePic', 'customProfilePic', 'stats']);
    }

    await profile.getPlayerProfile(leg, io, { username: 'player00' });
    expect(lastTo(leg, 'playerProfileResponse').avatarUrl).toMatch(/^\/avatar\/player00\?v=/);
    await profile.getPlayerProfile(cap, io, { username: 'eve' });
    const eve = lastTo(cap, 'playerProfileResponse');
    expect(eve.avatarUrl).toBeUndefined();
    expect(eve.profile.customProfilePic).toBeNull();
    await profile.getPlayerProfile(leg, io, { username: 'player05' });
    expect(lastTo(leg, 'playerProfileResponse').profile.customProfilePic).toBeNull();
    report.push({ scenario: 'getProfile (~46 K-char custom)', off: bytes({ success: true, profile: { ...c.profile, customProfilePic: PICS[0] } }), on: bytes(c) });
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
        // the leaderboard re-reads (invalidated) and shows the new picture's URL
        await profile.getLeaderboard(leg, io);
        const after = lastTo(leg, 'leaderboardResponse');
        expect(after.leaderboard.find((x) => x.username === 'player03').customProfilePic).toBeNull();
        expect(after.avatarUrls).toEqual({ player03: r.avatarUrl });
        expect(before.avatarUrls).toBeUndefined();
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
        ['a progressive-JPEG scan bomb', async () => 'data:image/jpeg;base64,' + (await fx.scanBombJpeg(4096)).toString('base64')],
        ['a 3000x3000 PNG (over the 2048^2 upload cap)', async () => fx.dataUrl(await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#0a0' } }).png().toBuffer())],
    ])('%s is refused with a message and the DB is unchanged', async (name, make) => {
        await upload(s, { imageData: await make() });
        expect(lastTo(s, 'profilePicUploadResponse')).toEqual({ success: false, message: 'Could not read that image. Please try a PNG, JPEG, GIF or WebP.' });
        expect(stored()).toBeUndefined();
    });

    test('the 6th upload within 60 s is rate limited; Joi caps the string', async () => {
        const img = fx.dataUrl(await fx.avatarPng(64));
        for (let i = 0; i < 5; i++) await upload(s, { imageData: img });
        await upload(s, { imageData: img });
        const errs = log.filter((l) => l.to === `self:${s.id}` && l.event === 'serverError');
        expect(errs.map((e) => e.data.code)).toEqual(['rateLimit']);
        rateLimiter.clearSocket(s.id);
        await upload(s, { imageData: 'data:image/png;base64,' + 'A'.repeat(682700) });
        expect(log.filter((l) => l.to === `self:${s.id}` && l.event === 'serverError').pop().data.code).toBe('validation');
    });

    test('upload decodes run under the store semaphore: full queue or a second upload of the same account -> "Busy, try again"', async () => {
        const image = require('../../avatar/image');
        const img = fx.dataUrl(await fx.avatarPng(64));
        const real = image.derive;
        let release;
        let active = 0;
        let maxActive = 0;
        jest.spyOn(image, 'derive').mockImplementation(async (...a) => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => { release = r; });
            active--;
            return real(...a);
        });
        avatarStore.configure({ maxConcurrent: 1, maxQueue: 0 });
        const first = upload(s, { imageData: img });
        for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 1));
        // the same account again while its decode runs
        await upload(s, { imageData: img });
        expect(lastTo(s, 'profilePicUploadResponse')).toEqual({ success: false, message: 'Busy, try again' });
        // another account while the only slot is taken and nothing may queue
        const other = sock(true, 'player04');
        await upload(other, { imageData: img });
        expect(lastTo(other, 'profilePicUploadResponse')).toEqual({ success: false, message: 'Busy, try again' });
        expect(maxActive).toBe(1);
        release();
        await first;
        expect(lastTo(s, 'profilePicUploadResponse').success).toBe(true);
        expect(stored()).toMatch(/^data:image\/webp;base64,/);
        rateLimiter.clearSocket(other.id);
        // the account's in-flight mark is cleared: the next upload goes through
        release = null;
        const again = upload(s, { imageData: fx.dataUrl(await fx.avatarPng(64, 9)) });
        for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 1));
        release();
        await again;
        expect(lastTo(s, 'profilePicUploadResponse').success).toBe(true);
    });

    test('with the pipeline off the stored value and the echo are byte-identical to the upload', async () => {
        avatarStore.configure({ enabled: false });
        const img = fx.dataUrl(await fx.avatarPng(200));
        await upload(s, { imageData: img });
        expect(stored()).toBe(img);
        expect(lastTo(s, 'profilePicUploadResponse')).toEqual({ success: true, customProfilePic: img });
    });
});
