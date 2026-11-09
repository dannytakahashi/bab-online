/**
 * GET/HEAD /avatar/:username?v= (server/routes/avatar.js) over real HTTP:
 * express on an ephemeral port, Node's fetch, memoryDb, real sharp.
 */

const http = require('http');
const express = require('express');
const sharp = require('sharp');
const { createMemoryDb } = require('../testUtils/memoryDb');
const { createAvatarRouter } = require('../routes/avatar');
const avatarStore = require('../avatar/avatarStore');
const image = require('../avatar/image');
const fx = require('../testUtils/avatarFixtures');
const { logger } = require('../utils/logger');

let server;
let base;
let db;
let KIM;
let t = 1_000_000;
let router;

async function start({ limits } = {}) {
    if (server) await stop();
    const app = express();
    // the page CSP, as server/index.js sets it for every response
    app.use((req, res, next) => { res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:"); next(); });
    router = createAvatarRouter({ getUsersCollection: () => db && db.users, avatarStore, now: () => t, limits });
    app.use(router);
    app.use((req, res) => res.status(418).end('fell through'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
}

beforeAll(async () => {
    KIM = fx.dataUrl(await fx.avatarPng(612, 3, 360));
});

beforeEach(async () => {
    t = 1_000_000;
    avatarStore._reset();
    avatarStore.configure({ enabled: true, now: () => t });
    db = createMemoryDb({
        users: [
            { username: 'kim', profilePic: 3, customProfilePic: KIM },
            { username: 'ivy', profilePic: 12 },
            { username: 'old_kim', mergedInto: 'kim' },
            { username: 'evil', customProfilePic: fx.dataUrl(fx.HTML) },
            { username: 'svg', customProfilePic: fx.dataUrl(fx.SVG) },
            { username: 'Zoë & co', customProfilePic: KIM },
        ],
    });
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await start();
});

afterEach(() => {
    jest.restoreAllMocks();
    avatarStore._reset();
});
afterAll(() => stop());

function stop() {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
}

const get = (path, init) => fetch(base + path, init);
const V = () => avatarStore.versionOf(KIM);
const headersOf = (res) => {
    const h = Object.fromEntries(res.headers.entries());
    delete h.date;
    delete h.connection;
    delete h['keep-alive'];
    return h;
};

test('200: sharp WebP <= 256 px with the exact headers; immutable only when v is current', async () => {
    const res = await get(`/avatar/kim?v=${V()}`);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(headersOf(res)).toEqual({
        'content-type': 'image/webp',
        'content-length': String(body.length),
        etag: `"${V()}"`,
        vary: 'Accept',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-site',
        'content-security-policy': "default-src 'none'; sandbox",
        'content-disposition': 'inline; filename="avatar.webp"',
        'cache-control': 'public, max-age=31536000, immutable',
    });
    const m = await sharp(body).metadata();
    expect([m.format, m.width, m.height]).toEqual(['webp', 256, 256]);
    expect(body.length).toBeLessThan(KIM.length / 10);

    for (const q of ['', '?v=0123456789abcdef', '?v=nothex', '?v=a&v=b']) {
        const r = await get(`/avatar/kim${q}`);
        expect({ q, status: r.status, cc: r.headers.get('cache-control'), etag: r.headers.get('etag') })
            .toEqual({ q, status: 200, cc: 'public, max-age=60, must-revalidate', etag: `"${V()}"` });
    }
});

test('304 on If-None-Match; HEAD works; names are percent-decoded', async () => {
    const r304 = await get(`/avatar/kim?v=${V()}`, { headers: { 'If-None-Match': `"${V()}"` } });
    expect(r304.status).toBe(304);
    expect(r304.headers.get('etag')).toBe(`"${V()}"`);
    expect(r304.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await r304.arrayBuffer()).byteLength).toBe(0);
    const head = await get(`/avatar/kim?v=${V()}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('image/webp');
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(1000);
    const spaced = await get(`/avatar/${encodeURIComponent('Zoë & co')}`);
    expect(spaced.status).toBe(200);
    const post = await get('/avatar/kim', { method: 'POST' });
    expect(post.status).toBe(418); // not routed
});

test('every miss is the same byte-identical 404 (no reason leaks); stored bytes are never served', async () => {
    const misses = ['/avatar/nobody', '/avatar/ivy', '/avatar/old_kim', '/avatar/evil', '/avatar/svg',
        '/avatar/..%2F..%2Fpackage.json', '/avatar/%00', '/avatar/%E0%A4%A', `/avatar/${'a'.repeat(51)}`,
        '/avatar/', '/avatar', '/avatar/a/b', `/avatar/nobody?v=${V()}`];
    const seen = [];
    for (const m of misses) {
        const r = await get(m);
        seen.push({ m, status: r.status, headers: headersOf(r), body: await r.text() });
    }
    const want = {
        status: 404,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            'x-content-type-options': 'nosniff',
            'cross-origin-resource-policy': 'same-site',
            'content-security-policy': "default-src 'none'; sandbox",
            'cache-control': 'public, max-age=60',
            'content-length': '9',
        },
        body: 'Not found',
    };
    for (const s of seen) expect(s).toEqual({ m: s.m, ...want });

    // deleted: the account goes (deleteAccount: deleteOne + forgetUser)
    expect((await get(`/avatar/kim?v=${V()}`)).status).toBe(200);
    await db.users.deleteOne({ username: 'kim' });
    avatarStore.forgetUser('kim');
    const gone = await get(`/avatar/kim?v=${V()}`);
    expect({ status: gone.status, headers: headersOf(gone), body: await gone.text() }).toEqual(want);

    // pipeline off
    avatarStore.configure({ enabled: false });
    const off = await get(`/avatar/${encodeURIComponent('Zoë & co')}`);
    expect({ status: off.status, headers: headersOf(off), body: await off.text() }).toEqual(want);
});

test('the missing cache stops repeat lookups for 60 s; a fresh versioned hit makes no DB read', async () => {
    const spy = jest.spyOn(db.users, 'findOne');
    for (let i = 0; i < 5; i++) expect((await get('/avatar/nobody')).status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
    t += 60001;
    await get('/avatar/nobody');
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockClear();
    await get('/avatar/kim'); // first sight: lookup + derive, owner confirmed
    expect(spy).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) expect((await get(`/avatar/kim?v=${V()}`)).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    // after 10 minutes the owner is re-checked once
    t += 10 * 60 * 1000;
    await get(`/avatar/kim?v=${V()}`);
    expect(spy).toHaveBeenCalledTimes(2);
    // a picture change (forgetUser) re-checks at once
    avatarStore.forgetUser('kim');
    await get(`/avatar/kim?v=${V()}`);
    expect(spy).toHaveBeenCalledTimes(3);
});

test('per-IP token bucket: the 121st burst request from one client gets 429; an unknown IP is never bucketed', async () => {
    const as = (ip) => ({ headers: { 'X-Real-IP': ip } }); // the peer is loopback (a proxy peer): X-Real-IP is the client
    for (let i = 0; i < 120; i++) expect((await get('/avatar/nobody', as('203.0.113.5'))).status).toBe(404);
    const limited = await get('/avatar/nobody', as('203.0.113.5'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect((await get('/avatar/nobody', as('198.51.100.7'))).status).toBe(404); // another client
    t += 1000; // refills 2/s
    expect((await get('/avatar/nobody', as('203.0.113.5'))).status).toBe(404);
    expect((await get('/avatar/nobody', as('203.0.113.5'))).status).toBe(404);
    expect((await get('/avatar/nobody', as('203.0.113.5'))).status).toBe(429);
    // no usable X-Real-IP behind a proxy peer: null IP, global bounds only
    for (let i = 0; i < 130; i++) expect((await get('/avatar/nobody')).status).toBe(404);
    expect(router._stats().ips).toBe(2);
});

test('saturation: more than 8 concurrent DB lookups (after a short wait), or a full derive queue, answer 503 (no-store)', async () => {
    await start({ limits: { lookupWaitMs: 100 } });
    let open = [];
    jest.spyOn(db.users, 'findOne').mockImplementation(() => new Promise((r) => open.push(() => r(null))));
    const pending = Array.from({ length: 8 }, (_, i) => get(`/avatar/u${i}`));
    for (let i = 0; open.length < 8 && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
    expect(open.length).toBe(8);
    const ninth = await get('/avatar/u9');
    expect(ninth.status).toBe(503);
    expect(ninth.headers.get('retry-after')).toBe('5');
    expect(ninth.headers.get('cache-control')).toBe('no-store');
    open.forEach((f) => f());
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual(Array(8).fill(404));
    jest.restoreAllMocks();
    jest.spyOn(logger, 'warn').mockImplementation(() => {});

    // derive queue full (two different pictures: one derive running, none may queue)
    await db.users.updateOne({ username: 'Zoë & co' }, { $set: { customProfilePic: fx.dataUrl(fx.bombPng(64, 64)) } });
    avatarStore.configure({ maxConcurrent: 1, maxQueue: 0 });
    let release;
    jest.spyOn(image, 'derive').mockImplementation(() => new Promise((r) => { release = () => r({ status: 'undecodable' }); }));
    const first = get('/avatar/kim');
    while (!release) await new Promise((r) => setTimeout(r, 5));
    const busy = await get(`/avatar/${encodeURIComponent('Zoë & co')}?v=0000000000000000`);
    expect(busy.status).toBe(503);
    release();
    expect((await first).status).toBe(404);
    open = [];
});

test('no database yet: 503, never a 404 that a client could cache', async () => {
    db = null;
    const r = await get('/avatar/kim');
    expect(r.status).toBe(503);
    expect(r.headers.get('cache-control')).toBe('no-store');
});

test('a lookup waits for a free slot instead of failing; concurrent requests for one name share one findOne', async () => {
    await start({ limits: { maxLookups: 1 } });
    const real = db.users.findOne.bind(db.users);
    const spy = jest.spyOn(db.users, 'findOne').mockImplementation(async (...a) => {
        await new Promise((r) => setTimeout(r, 30));
        return real(...a);
    });
    // 30 requests for kim (no v: no fast path) plus one for ivy behind them, one slot
    const kims = Array.from({ length: 30 }, () => get('/avatar/kim'));
    const ivy = get('/avatar/ivy');
    expect((await Promise.all(kims)).map((r) => r.status)).toEqual(Array(30).fill(200));
    expect((await ivy).status).toBe(404); // waited for the slot, then a real answer
    expect(spy.mock.calls.map((c) => c[0].username).sort()).toEqual(['ivy', 'kim']);
    expect(router._stats()).toMatchObject({ lookups: 0, waiting: 0, pending: 0 });

    // stale owner marks (a leaderboard left open 11 minutes): one shared re-check, no 503s
    spy.mockClear();
    t += 11 * 60 * 1000;
    const again = await Promise.all(Array.from({ length: 30 }, () => get(`/avatar/kim?v=${V()}`)));
    expect(again.map((r) => r.status)).toEqual(Array(30).fill(200));
    expect(spy).toHaveBeenCalledTimes(1);
});

test('a browser whose Accept lacks image/webp (Safari on macOS 10.15) gets a PNG of the same rendition; Vary: Accept', async () => {
    const SAFARI_CATALINA = 'image/png,image/svg+xml,image/*;q=0.8,video/*;q=0.8,*/*;q=0.5';
    const res = await get(`/avatar/kim?v=${V()}`, { headers: { Accept: SAFARI_CATALINA } });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('vary')).toBe('Accept');
    expect(res.headers.get('etag')).toBe(`"${V()}-png"`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="avatar.png"');
    const m = await sharp(body).metadata();
    expect([m.format, m.width, m.height, m.hasAlpha]).toEqual(['png', 256, 256, true]);
    const r304 = await get(`/avatar/kim?v=${V()}`, { headers: { Accept: SAFARI_CATALINA, 'If-None-Match': `"${V()}-png"` } });
    expect(r304.status).toBe(304);
    // cached: a second PNG request encodes nothing new
    const toPng = jest.spyOn(image, 'toPng');
    expect((await get(`/avatar/kim?v=${V()}`, { headers: { Accept: SAFARI_CATALINA } })).status).toBe(200);
    expect(toPng).not.toHaveBeenCalled();
    // Chrome, Firefox, Safari 14+ on macOS 11+, no Accept, */*: WebP
    for (const accept of ['image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8', 'image/avif,image/webp,*/*',
        'image/webp,image/png,image/svg+xml,image/*;q=0.8,video/*;q=0.8,*/*;q=0.5', '*/*', undefined]) {
        const r = await get(`/avatar/kim?v=${V()}`, accept ? { headers: { Accept: accept } } : undefined);
        expect({ accept, type: r.headers.get('content-type'), vary: r.headers.get('vary') }).toEqual({ accept, type: 'image/webp', vary: 'Accept' });
    }
});

test('a transient derive failure (libvips timeout) answers 503, is not cached as a miss, and is derived again after 60 s', async () => {
    const derive = jest.spyOn(image, 'derive').mockResolvedValueOnce({ status: 'error' });
    const first = await get('/avatar/kim');
    expect(first.status).toBe(503);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect((await get('/avatar/kim')).status).toBe(503); // within the 60 s retry window: no derive storm
    expect(derive).toHaveBeenCalledTimes(1);
    t += avatarStore.ERROR_TTL_MS + 1;
    expect((await get('/avatar/kim')).status).toBe(200);
    expect(derive).toHaveBeenCalledTimes(2);
});
