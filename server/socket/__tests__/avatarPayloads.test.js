/**
 * Seat payloads with the avatar pipeline ON (roadmap item 10;
 * docs/avatars.md): real handlers, seeded games (avatarHarness), the
 * renditions pre-warmed under real timers before the game starts.
 *
 *   capable socket (clientHello caps ['avatarUrl']): custom slots null +
 *     avatarUrls; a gameStart well under 1.5 KB
 *   legacy socket (no hello: the App Store iOS build, cached old web): every
 *     custom slot is a small inline image the shipped app decodes (I1)
 *   room broadcasts (positionUpdate, playerActiveMode): ONE emit for all,
 *     legacy pics + additive avatarUrls (seq unchanged)
 *
 * Every emit also passes the always-on contract guard. AVATAR_REPORT=1
 * prints the byte table (docs/avatars.md "Measurements").
 */

const http = require('http');
const express = require('express');
const sharp = require('sharp');
const { createMemoryDb } = require('../../testUtils/memoryDb');
const fx = require('../../testUtils/avatarFixtures');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));
jest.mock('uuid', () => {
    let n = 0;
    return {
        v4: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
        __reset: () => { n = 0; },
    };
});

const HELLO = { client: 'web', version: '1.0.0', build: 'test', caps: ['avatarUrl'] };
const SEED = 12;
const REPORT = process.env.AVATAR_REPORT === '1';
const report = [];

let PIC200;
let PIC612;
beforeAll(async () => {
    PIC200 = fx.dataUrl(await fx.avatarPng(200, 1));
    PIC612 = fx.dataUrl(await fx.avatarPng(612, 3, 360));
});
afterAll(() => {
    if (REPORT) process.stdout.write(`\n${report.map((r) => JSON.stringify(r)).join('\n')}\n`);
});

/**
 * One scenario in a fresh module registry: users inserted, renditions
 * pre-warmed (real timers), then the seeded game under fake timers.
 * `capable(role, index)` says which sockets send clientHello first.
 */
async function play({ humans, spectators = [], capable = () => false, pipeline = true, prewarm = true, deriveNever = false, onStep } = {}) {
    let out;
    await jest.isolateModulesAsync(async () => {
        require('uuid').__reset();
        mockDb.current = createMemoryDb({ users: [] });
        const logger = require('../../utils/logger');
        for (const l of [logger.gameLogger, logger.socketLogger, logger.authLogger, logger.logger]) {
            for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
        }
        const store = require('../../avatar/avatarStore');
        const image = require('../../avatar/image');
        if (pipeline) store.configure({ enabled: true });
        if (deriveNever) jest.spyOn(image, 'derive').mockImplementation(() => new Promise(() => {}));
        if (pipeline && prewarm) {
            for (const h of humans) if (h.customProfilePic) await store.ensure(h.username, h.customProfilePic);
        }
        const clientInfo = require('../clientInfo');
        const { runGame } = require('../../testUtils/avatarHarness');
        jest.useFakeTimers();
        jest.setSystemTime(Date.UTC(2026, 0, 1, 12));
        try {
            const r = await runGame(SEED, {
                humans,
                spectators,
                onSocket: (s, role, i) => { if (capable(role, i)) clientInfo.handle(s, null, HELLO); },
                onStep: onStep && ((ctx) => onStep(ctx, { store })),
            });
            out = { ...r, store, versionOf: store.versionOf };
        } finally {
            jest.clearAllTimers();
            jest.useRealTimers();
            require('../errorHandler').rateLimiter.shutdown();
        }
    });
    return out;
}

const { receivedBy, bytesTo } = require('../../testUtils/avatarHarness');
const sizes = (recs) => recs.map((r) => r.bytes);
const posOf = (r, username) => r.wire.find((x) => x.event === 'positionUpdate').data.positions[
    r.wire.find((x) => x.event === 'positionUpdate').data.usernames.findIndex((u) => u.username === username)];
const URL_RE = /^\/avatar\/[^/?#\s]+\?v=[0-9a-f]{16}$/;

/** Every custom-picture string a recipient got in a pic slot. */
function customSlots(recs) {
    const out = [];
    const add = (event, p) => { if (typeof p === 'string') out.push({ event, p }); };
    for (const { event, data } of recs) {
        if (!data || typeof data !== 'object') continue;
        if (event === 'positionUpdate') data.pics.forEach((p) => add(event, p));
        if (event === 'gameStart') data.playerInfo.forEach((p) => add(event, p.pic));
        if (['rejoinSuccess', 'restorePlayerState', 'spectatorJoined'].includes(event) && data.players) data.players.forEach((p) => add(event, p.pic));
        if (event === 'playerActiveMode') add(event, data.pic);
        if (data.snapshot) data.snapshot.seats.forEach((s) => add(`${event}.snapshot`, s.customPic));
    }
    return out;
}

async function assertI1(recs, { maxChars = 16384 } = {}) {
    const slots = customSlots(recs);
    for (const { event, p } of slots) {
        expect({ event, url: p.startsWith('/avatar/') }).toEqual({ event, url: false });
        expect({ event, shape: fx.I1_RE.test(p), decodes: await fx.iosLegacyDecodes(p), small: p.length <= maxChars })
            .toEqual({ event, shape: true, decodes: true, small: true });
    }
    return slots.length;
}

async function fetchAvatar(r, url) {
    const { createAvatarRouter } = require('../../routes/avatar');
    const app = express();
    app.use(createAvatarRouter({ getUsersCollection: () => mockDb.current.users, avatarStore: r.store }));
    const server = http.createServer(app);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
        return { status: res.status, type: res.headers.get('content-type'), cc: res.headers.get('cache-control'), body: Buffer.from(await res.arrayBuffer()) };
    } finally {
        server.closeAllConnections();
        await new Promise((ok) => server.close(ok));
    }
}

test('one custom human (200 px) + 3 bots: capable vs legacy socket', async () => {
    const humans = [{ username: 'ava', profilePic: 5, customProfilePic: PIC200 }];
    const cap = await play({ humans, capable: (role) => role === 'human' });
    const leg = await play({ humans });
    const off = await play({ humans, pipeline: false });
    const sid = cap.socks[0].id;
    const pos = posOf(cap, 'ava');
    const url = `/avatar/ava?v=${cap.versionOf(PIC200)}`;

    // capable: null slot + avatarUrls, gameStart < 1.5 KB
    const capStarts = receivedBy(cap.wire, sid).filter((x) => x.event === 'gameStart');
    expect(capStarts.length).toBeGreaterThanOrEqual(13);
    for (const g of capStarts) {
        expect(g.bytes).toBeLessThanOrEqual(1500);
        expect(g.data.playerInfo.find((p) => p.position === pos).pic).toBeNull();
        expect(g.data.avatarUrls).toEqual({ [pos]: url });
        expect(g.data.avatarUrls[pos]).toMatch(URL_RE);
    }
    const res = await fetchAvatar(cap, url);
    expect([res.status, res.type, res.cc]).toEqual([200, 'image/webp', 'public, max-age=31536000, immutable']);
    const m = await sharp(res.body).metadata();
    expect([m.format, m.width]).toEqual(['webp', 200]);

    // legacy: today's keys, a small inline image the shipped app decodes
    const legRecs = receivedBy(leg.wire, leg.socks[0].id);
    const legStarts = legRecs.filter((x) => x.event === 'gameStart');
    for (const g of legStarts) {
        expect(g.bytes).toBeLessThanOrEqual(17500);
        expect(g.data.avatarUrls).toBeUndefined();
    }
    expect(await assertI1(legRecs)).toBeGreaterThan(13);

    // one positionUpdate for the room either way, pics inline + avatarUrls
    for (const r of [cap, leg]) {
        const pu = r.wire.filter((x) => x.event === 'positionUpdate');
        expect(pu).toHaveLength(1);
        expect(pu[0].data.avatarUrls).toEqual({ [pos]: url });
        expect(await fx.iosLegacyDecodes(pu[0].data.pics[pu[0].data.positions.indexOf(pos)])).toBe(true);
    }
    // same game, same seq numbering as with the pipeline off
    const seqs = (r) => r.wire.filter((x) => String(x.to).startsWith('game:')).map((x) => `${x.event}:${x.data.seq}`);
    expect(seqs(cap)).toEqual(seqs(off));

    const whole = { capable: bytesTo(cap.wire, sid), legacy: bytesTo(leg.wire, leg.socks[0].id), off: bytesTo(off.wire, off.socks[0].id) };
    expect(whole.capable).toBeLessThanOrEqual(100000);
    expect(whole.legacy).toBeLessThanOrEqual(250000);
    const g0 = (r, s) => receivedBy(r.wire, s).find((x) => x.event === 'gameStart').bytes;
    report.push({
        scenario: '1 custom (200 px) + 3 bots, the custom human\'s own socket',
        storedChars: PIC200.length,
        gameStart: { off: g0(off, off.socks[0].id), legacy: g0(leg, leg.socks[0].id), capable: g0(cap, sid) },
        positionUpdate: { off: off.wire.find((x) => x.event === 'positionUpdate').bytes, on: cap.wire.find((x) => x.event === 'positionUpdate').bytes },
        wholeGame: whole,
    });
});

test('mixed table: capable custom human, legacy custom human (612 px), capable spectator; disconnect/rejoin, lazy, /active', async () => {
    const humans = [
        { username: 'ava', profilePic: 5, customProfilePic: PIC200 },
        { username: 'bob', profilePic: 9, customProfilePic: PIC612 },
    ];
    const spectators = [{ username: 'sue' }];
    let stepDone = false;
    const steps = async (ctx, { store }) => {
        const g = ctx.game;
        if (stepDone || !g || g.dealSeq !== 3 || g.stage !== 'BIDDING') return;
        const avaPos = ctx.seats[0].pos;
        if (g.currentTurn === avaPos || ctx.seats[0].turn !== null) return;
        stepDone = true;
        const gameManager = require('../../game/GameManager');
        const queueHandlers = require('../queueHandlers');
        const reconnectHandlers = require('../reconnectHandlers');
        const chatHandlers = require('../chatHandlers');
        const clientInfo = require('../clientInfo');
        const { makeSocket } = require('../../testUtils/gameDriver');
        const newSock = (id) => {
            const s = makeSocket(id, ctx.log, ctx.io);
            gameManager.registerUser(id, 'ava');
            clientInfo.handle(s, null, HELLO);
            return s;
        };
        // 1. drop + rejoin on a new capable socket -> rejoinSuccess (human seat)
        const old = ctx.seats[0].sock;
        ctx.io.sockets.sockets.delete(old.id);
        for (const m of ctx.io.rooms.values()) m.delete(old.id);
        await queueHandlers.handleDisconnect(old, ctx.io);
        const a2 = newSock('ava-2');
        await reconnectHandlers.rejoinGame(a2, ctx.io, { gameId: g.gameId, username: 'ava' });
        // 2. /lazy, then a newer socket rejoins (watch view), then /active -> restorePlayerState + playerActiveMode
        chatHandlers.chatMessage(a2, ctx.io, { message: '/lazy' });
        const a3 = newSock('ava-3');
        await reconnectHandlers.rejoinGame(a3, ctx.io, { gameId: g.gameId, username: 'ava' });
        chatHandlers.chatMessage(a3, ctx.io, { message: '/active' });
        ctx.seats[0].sock = a3;
        ctx.marks = { a2: a2.id, a3: a3.id };
        // the store has both renditions (pipeline on)
        if (store.available()) expect(store.peek(store.versionOf(PIC612)).status).toBe('ok');
    };
    const r = await play({ humans, spectators, capable: (role, i) => role === 'spectator' || i === 0, onStep: steps });
    expect(stepDone).toBe(true);
    const ava = posOf(r, 'ava');
    const bob = posOf(r, 'bob');
    const urls = { [ava]: `/avatar/ava?v=${r.versionOf(PIC200)}`, [bob]: `/avatar/bob?v=${r.versionOf(PIC612)}` };

    // ONE positionUpdate (room), inline pics + avatarUrls
    const pu = r.wire.filter((x) => x.event === 'positionUpdate');
    expect(pu).toHaveLength(1);
    expect(pu[0].data.avatarUrls).toEqual(urls);

    // capable: the spectator and ava's sockets
    const spec = r.specs[0].id;
    const sj = receivedBy(r.wire, spec).find((x) => x.event === 'spectatorJoined' && x.data.players);
    expect(sj.data.avatarUrls).toEqual(urls);
    expect(sj.data.players.filter((p) => p.pic === null)).toHaveLength(2);
    const capRecs = [...receivedBy(r.wire, spec), ...receivedBy(r.wire, r.socks[0].id), ...receivedBy(r.wire, 'ava-2'), ...receivedBy(r.wire, 'ava-3')];
    for (const x of capRecs.filter((y) => y.event === 'gameStart')) {
        expect(x.bytes).toBeLessThanOrEqual(1500);
        expect(x.data.avatarUrls).toEqual(urls);
    }
    const rejoins = capRecs.filter((x) => x.event === 'rejoinSuccess');
    expect(rejoins).toHaveLength(2);
    expect(rejoins[0].data.avatarUrls).toEqual(urls);
    // the watch view of a lazy seat shows its bot (stock pic) at ava's position
    expect(rejoins[1].data.isLazy).toBe(true);
    expect(rejoins[1].data.avatarUrls).toEqual({ [bob]: urls[bob] });
    const restore = capRecs.find((x) => x.event === 'restorePlayerState');
    expect(restore.data.avatarUrls).toEqual(urls);
    expect(restore.data.players.filter((p) => typeof p.pic === 'string')).toEqual([]);
    // the attached snapshots carry seat avatarUrls
    expect(restore.data.snapshot.seats.find((s) => s.position === bob).avatarUrl).toBe(urls[bob]);

    // playerActiveMode: one room broadcast, inline pic + avatarUrl
    const am = r.wire.filter((x) => x.event === 'playerActiveMode');
    expect(am).toHaveLength(1);
    expect(am[0].data.avatarUrl).toBe(urls[ava]);
    expect(await fx.iosLegacyDecodes(am[0].data.pic)).toBe(true);

    // legacy: bob's socket — every custom slot decodes and is small
    const bobRecs = receivedBy(r.wire, r.socks[1].id);
    expect(await assertI1(bobRecs)).toBeGreaterThan(26);
    for (const x of bobRecs.filter((y) => y.event === 'gameStart')) {
        expect(x.data.avatarUrls).toBeUndefined();
        expect(x.bytes).toBeLessThanOrEqual(32000); // two inline renditions (the 612 px one ~15 K)
    }

    // the same table with the pipeline off (today), for the byte table
    stepDone = false;
    const off = await play({ humans, spectators, pipeline: false, onStep: steps });
    const offRecs = (sid) => receivedBy(off.wire, sid);
    const first = (recs, ev) => recs.find((x) => x.event === ev && (ev !== 'spectatorJoined' || x.data.players));
    const sum = (recs) => recs.reduce((a, x) => a + x.bytes, 0);
    const restoreOff = first([...offRecs('ava-3')], 'restorePlayerState');
    const sjOff = first(offRecs(off.specs[0].id), 'spectatorJoined');
    // capable: the same payload minus both stored pictures, plus two URLs (and the snapshot seat avatarUrls)
    const inlineSaved = PIC200.length + PIC612.length;
    expect(restore.bytes).toBeLessThanOrEqual(restoreOff.bytes - inlineSaved + 300);
    expect(sj.bytes).toBeLessThanOrEqual(sjOff.bytes - inlineSaved + 300);
    expect(first(receivedBy(r.wire, "ava-2"), "rejoinSuccess").bytes).toBeLessThanOrEqual(first(offRecs("ava-2"), "rejoinSuccess").bytes - inlineSaved + 300);
    report.push({
        scenario: 'mixed table (ava capable 200 px, bob legacy 612 px, capable spectator)',
        storedChars: { ava: PIC200.length, bob: PIC612.length },
        gameStart: {
            off: first(offRecs(off.socks[0].id), 'gameStart').bytes,
            capable: first(receivedBy(r.wire, r.socks[0].id), 'gameStart').bytes,
            legacyBob: first(bobRecs, 'gameStart').bytes,
            spectatorCapable: first(receivedBy(r.wire, spec), 'gameStart').bytes,
        },
        positionUpdate: { off: off.wire.find((x) => x.event === 'positionUpdate').bytes, on: pu[0].bytes },
        spectatorJoined: { off: sjOff.bytes, capable: sj.bytes },
        rejoinSuccess: { off: first(offRecs('ava-2'), 'rejoinSuccess').bytes, capable: first(receivedBy(r.wire, 'ava-2'), 'rejoinSuccess').bytes },
        restorePlayerState: { off: restoreOff.bytes, capable: restore.bytes },
        playerActiveMode: { off: first(off.wire, 'playerActiveMode').bytes, on: am[0].bytes },
        wholeGame: {
            off: { ava: sum(offRecs(off.socks[0].id)), bob: sum(offRecs(off.socks[1].id)), spectator: sum(offRecs(off.specs[0].id)) },
            on: { avaCapable: sum(receivedBy(r.wire, r.socks[0].id)), bobLegacy: sum(bobRecs), spectatorCapable: sum(receivedBy(r.wire, spec)) },
        },
    });
    expect(sum(bobRecs)).toBeLessThan(sum(offRecs(off.socks[1].id)) / 2);
});

test('a snapshot: customPics false keeps the slot null with avatarUrl; customPics true carries the small inline value', async () => {
    const humans = [{ username: 'ava', profilePic: 5, customProfilePic: PIC612 }];
    let snaps = null;
    const r = await play({
        humans,
        capable: () => true,
        onStep: async (ctx) => {
            if (snaps || !ctx.game || ctx.game.dealSeq !== 2) return;
            const { requestSnapshot } = require('../snapshotHandlers');
            const s = ctx.seats[0].sock;
            requestSnapshot(s, ctx.io, { customPics: false });
            requestSnapshot(s, ctx.io, { customPics: true });
            snaps = true;
        },
    });
    const got = receivedBy(r.wire, r.socks[0].id).filter((x) => x.event === 'stateSnapshot');
    expect(got).toHaveLength(2);
    const pos = posOf(r, 'ava');
    const [lean, full] = got.map((x) => x.data.snapshot.seats.find((s) => s.position === pos));
    expect(lean).toMatchObject({ hasCustomPic: true, customPic: null, avatarUrl: `/avatar/ava?v=${r.versionOf(PIC612)}` });
    expect(full.customPic.length).toBeLessThan(16384);
    expect(await fx.iosLegacyDecodes(full.customPic)).toBe(true);
    report.push({ scenario: 'stateSnapshot (612 px custom)', customPicsFalse: got[0].bytes, customPicsTrue: got[1].bytes, storedChars: PIC612.length });
});

test('rendition not ready (derive pending): exactly the raw stored value and no URL, for both kinds of socket', async () => {
    const humans = [{ username: 'ava', profilePic: 5, customProfilePic: PIC200 }, { username: 'bob', profilePic: 9 }];
    const r = await play({ humans, prewarm: false, deriveNever: true, capable: (role, i) => i === 0 });
    for (const sid of [r.socks[0].id, r.socks[1].id]) {
        const recs = receivedBy(r.wire, sid);
        const slots = customSlots(recs);
        expect(slots.length).toBeGreaterThan(13);
        for (const { p } of slots) expect(p).toBe(PIC200);
        expect(recs.some((x) => x.data && (x.data.avatarUrls || x.data.avatarUrl))).toBe(false);
    }
});

test('a hostile stored picture (SVG behind image/png) shows the placeholder to everyone and has no URL', async () => {
    const { PLACEHOLDER_INLINE } = require('../../avatar/placeholder');
    const humans = [{ username: 'eve', profilePic: 5, customProfilePic: fx.dataUrl(fx.SVG) }, { username: 'bob', profilePic: 9 }];
    const r = await play({ humans, capable: (role, i) => i === 1 });
    for (const sid of [r.socks[0].id, r.socks[1].id]) {
        const slots = customSlots(receivedBy(r.wire, sid));
        expect(slots.length).toBeGreaterThan(13);
        for (const { p } of slots) expect(p).toBe(PLACEHOLDER_INLINE);
    }
    expect(r.wire.some((x) => x.data && (x.data.avatarUrls || x.data.avatarUrl))).toBe(false);
    expect(await fx.iosLegacyDecodes(PLACEHOLDER_INLINE)).toBe(true);
});

test('AVATAR_LEGACY_INLINE=raw: legacy sockets get today\'s stored bytes, capable ones still the URL', async () => {
    let out;
    const humans = [{ username: 'ava', profilePic: 5, customProfilePic: PIC200 }, { username: 'bob', profilePic: 9 }];
    const r = await play({
        humans,
        capable: (role, i) => i === 1,
        onStep: async (ctx, { store }) => { if (!out) { store.configure({ legacyInline: 'raw' }); out = true; } },
    });
    const legacy = customSlots(receivedBy(r.wire, r.socks[0].id));
    for (const { p } of legacy) expect(p).toBe(PIC200);
    const cap = receivedBy(r.wire, r.socks[1].id).filter((x) => x.event === 'gameStart');
    expect(cap[0].data.avatarUrls).toBeDefined();
});
