/**
 * server/avatar/avatarStore.js: byte-bounded LRU, one derive per version,
 * the derive semaphore, the version hash, owners / missing bookkeeping and
 * the off switch. Real timers throughout (sharp runs on the libuv
 * threadpool, which fake timers do not drive).
 */

const crypto = require('crypto');
const image = require('../image');
const store = require('../avatarStore');
const fx = require('../../testUtils/avatarFixtures');
const { logger } = require('../../utils/logger');

const MB = 1024 * 1024;
const fakePic = (i) => `data:image/png;base64,${Buffer.from(`pic-${i}-`.padEnd(24, 'x')).toString('base64')}`;

beforeEach(() => {
    store._reset();
    store.configure({ enabled: true });
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    store._reset();
    jest.restoreAllMocks();
});

/** image.derive replaced by a fake that returns an `n`-byte "WebP". */
function fakeDerive(n = 1000, { gate } = {}) {
    let active = 0;
    const seen = { calls: 0, maxActive: 0 };
    jest.spyOn(image, 'derive').mockImplementation(async () => {
        seen.calls++;
        active++;
        seen.maxActive = Math.max(seen.maxActive, active);
        if (gate) await gate();
        active--;
        return { status: 'ok', webp: Buffer.alloc(n, 7), width: 200, height: 200 };
    });
    return seen;
}

test('with the pipeline off warm and ensure are no-ops', async () => {
    store.configure({ enabled: false });
    const spy = jest.spyOn(image, 'derive');
    expect(store.available()).toBe(false);
    expect(store.warm('a', fakePic(1))).toBeNull();
    expect(await store.ensure('a', fakePic(1))).toBeNull();
    expect(store.peek(store.versionOf(fakePic(1)))).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
});

test('the default is off under Jest (NODE_ENV=test or a Jest worker)', () => {
    store._reset();
    expect(store.available()).toBe(false);
});

test('versionOf: 16 hex of sha256("bab-avatar-r1\\n" + raw), stable', () => {
    const raw = fakePic(3);
    const want = crypto.createHash('sha256').update(`bab-avatar-r1\n${raw}`).digest('hex').slice(0, 16);
    expect(store.RENDITION_REV).toBe('r1');
    expect(store.versionOf(raw)).toBe(want);
    expect(store.versionOf(raw)).toMatch(/^[0-9a-f]{16}$/);
    expect(store.versionOf(fakePic(4))).not.toBe(want);
});

test('the LRU is bounded by bytes: 40+ MB of renditions into a 32 MB budget', async () => {
    store.configure({ cacheBytes: 32 * MB });
    fakeDerive(MB); // 1 MB webp + 1.33 MB inline per entry
    for (let i = 0; i < 18; i++) await store.ensure(`u${i}`, fakePic(i));
    const s = store.stats();
    expect(s.derives).toBe(18);
    expect(s.bytes).toBeLessThanOrEqual(32 * MB);
    expect(s.entries).toBeLessThan(18);
    expect(s.evictions).toBe(18 - s.entries);
    // oldest gone, newest kept; a peek refreshes recency
    expect(store.peek(store.versionOf(fakePic(0)))).toBeUndefined();
    expect(store.peek(store.versionOf(fakePic(17))).status).toBe('ok');
});

test('one derive for 10 concurrent ensure calls of the same picture', async () => {
    const seen = fakeDerive();
    const raw = fakePic(1);
    const all = await Promise.all(Array.from({ length: 10 }, () => store.ensure('a', raw)));
    expect(seen.calls).toBe(1);
    expect(new Set(all).size).toBe(1);
    expect(all[0].owners.has('a')).toBe(true);
});

test('at most 2 derives run at once; a full queue makes warm a no-op and ensure reject with AVATAR_BUSY', async () => {
    let release;
    const gate = () => new Promise((r) => { release = release || []; release.push(r); });
    const seen = fakeDerive(1000, { gate });
    store.configure({ maxQueue: 1 });
    const a = store.ensure('a', fakePic(1));
    const b = store.ensure('b', fakePic(2));
    const c = store.ensure('c', fakePic(3)); // queued
    await new Promise((r) => setImmediate(r));
    expect(seen.maxActive).toBe(2);
    const v4 = store.warm('d', fakePic(4));
    expect(store.peek(v4)).toBeUndefined(); // nothing started
    await expect(store.ensure('e', fakePic(5))).rejects.toMatchObject({ code: 'AVATAR_BUSY' });
    expect(store.stats().busy).toBe(2);
    while (release.length) release.shift()();
    await Promise.all([a, b]);
    await new Promise((r) => setImmediate(r));
    while (release.length) release.shift()();
    expect((await c).status).toBe('ok');
    expect(seen.maxActive).toBe(2);
});

test('warm is synchronous and never throws; peek reports pending until the rendition is in', async () => {
    fakeDerive();
    const raw = fakePic(9);
    const v = store.warm('a', raw);
    expect(v).toBe(store.versionOf(raw));
    expect(store.peek(v)).toEqual({ status: 'pending' });
    expect(store.warm('a', 42)).toBeNull();
    await store.ensure('a', raw);
    expect(store.peek(v).status).toBe('ok');
    expect(store.peek(v).owners.has('a')).toBe(true);
});

test('forgetUser drops the owner from every version and the missing mark', async () => {
    fakeDerive();
    const e = await store.ensure('kim', fakePic(1));
    store.markMissing('kim');
    expect(store.isMissing('kim')).toBe(true);
    store.forgetUser('kim');
    expect(e.owners.has('kim')).toBe(false);
    expect(store.isMissing('kim')).toBe(false);
});

test('missing: 60 s TTL, at most 5,000 names', () => {
    let t = 1000;
    store.configure({ now: () => t });
    store.markMissing('x');
    t += 59999;
    expect(store.isMissing('x')).toBe(true);
    t += 1;
    expect(store.isMissing('x')).toBe(false);
    for (let i = 0; i < 5100; i++) store.markMissing(`n${i}`);
    expect(store.stats().missing).toBe(5000);
    expect(store.isMissing('n0')).toBe(false);
    expect(store.isMissing('n5099')).toBe(true);
});

test('real sharp: a stored PNG becomes an inline WebP the shipped app decodes; hostile and non-image values are classified', async () => {
    const raw = fx.dataUrl(await fx.avatarPng(200));
    const e = await store.ensure('kim', raw);
    expect(e.status).toBe('ok');
    expect(e.inline).toMatch(fx.I1_RE);
    expect(e.inline.length).toBeLessThan(16384);
    expect(await fx.iosLegacyDecodes(e.inline)).toBe(true);
    expect((await store.ensure('x', fx.dataUrl(fx.SVG))).status).toBe('hostile');
    expect((await store.ensure('x', fx.dataUrl(fx.bombPng())))).toMatchObject({ status: 'hostile', reason: 'pixels' });
    expect((await store.ensure('x', 'data:image/svg+xml;base64,PHN2Zz4='))).toMatchObject({ status: 'hostile', reason: 'format' });
    expect((await store.ensure('x', 'data:image/png;base64,iVBORw0KGgo='))).toMatchObject({ status: 'undecodable' });
    // no raw string is retained by any entry
    expect(JSON.stringify(Object.keys(e))).not.toMatch(/raw/);
});

test('uploads decode under the same semaphore: never more than 2 decodes at once, busy when the queue is full', async () => {
    const gates = [];
    const seen = fakeDerive(1000, { gate: () => new Promise((r) => gates.push(r)) });
    // 6 stored-picture warms + 6 uploads compete for the same 2 slots
    for (let i = 0; i < 6; i++) store.warm(`u${i}`, fakePic(i));
    const uploads = Array.from({ length: 6 }, () => store.deriveUpload(Buffer.from('x')));
    for (let i = 0; i < 50 && gates.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
    expect(seen.maxActive).toBe(2);
    expect(store.stats()).toMatchObject({ running: 2, queued: 10 });
    while (seen.calls < 12) {
        gates.splice(0).forEach((g) => g());
        await new Promise((r) => setTimeout(r, 1));
    }
    gates.splice(0).forEach((g) => g());
    expect((await Promise.all(uploads)).map((r) => r.status)).toEqual(Array(6).fill('ok'));
    expect(seen.maxActive).toBe(2);
    expect(image.derive.mock.calls.slice(-1)[0][1]).toEqual({ strict: true });

    store.configure({ maxConcurrent: 1, maxQueue: 0 });
    let release;
    image.derive.mockImplementation(() => new Promise((r) => { release = () => r({ status: 'undecodable' }); }));
    const running = store.deriveUpload(Buffer.from('a'));
    expect(await store.deriveUpload(Buffer.from('b'))).toEqual({ status: 'busy' });
    await new Promise((r) => setImmediate(r));
    release();
    expect(await running).toEqual({ status: 'undecodable' });
    image.derive.mockRejectedValueOnce(new Error('boom'));
    expect(await store.deriveUpload(Buffer.from('c'))).toEqual({ status: 'error' });
});

test('a transient failure (timeout, thrown derive) is cached for 60 s only, then derived again; verdicts stay cached', async () => {
    let t = 5_000_000;
    store.configure({ now: () => t });
    const spy = jest.spyOn(image, 'derive')
        .mockResolvedValueOnce({ status: 'error' })
        .mockRejectedValueOnce(new Error('VipsImage: out of memory'))
        .mockResolvedValue({ status: 'ok', webp: Buffer.alloc(500, 1), width: 200, height: 200 });
    const pic = fakePic(1);
    const v = store.versionOf(pic);
    expect((await store.ensure('kim', pic)).status).toBe('error');
    expect(store.peek(v).status).toBe('error');
    store.warm('kim', pic); // inside the window: no new derive
    expect(spy).toHaveBeenCalledTimes(1);
    t += store.ERROR_TTL_MS;
    expect(store.peek(v)).toBeUndefined();
    expect((await store.ensure('kim', pic)).status).toBe('error'); // the thrown one: transient too
    t += store.ERROR_TTL_MS;
    store.warm('kim', pic);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.peek(v).status).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(store.stats().errors).toBe(2);

    spy.mockResolvedValue({ status: 'undecodable' });
    const bad = fakePic(2);
    await store.ensure('ivy', bad);
    t += 10 * store.ERROR_TTL_MS;
    expect(store.peek(store.versionOf(bad)).status).toBe('undecodable');
    expect(spy).toHaveBeenCalledTimes(4);
});
