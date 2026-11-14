/**
 * Seat payloads with the avatar pipeline ON (roadmap item 10;
 * docs/avatars.md): real handlers, seeded games (avatarHarness), the
 * renditions pre-warmed under real timers before the game starts.
 *
 * Since contract/V1_REMOVALS.md #19 (2026-11-12) every recipient gets the
 * same shape, whether or not it sent clientHello caps ['avatarUrl'] (#19 F):
 * a picture slot (positionUpdate.pics, gameStart.playerInfo[].pic, the v1
 * states' players[].pic, playerActiveMode.pic, snapshot seats' customPic) is
 * a stock number or null, never a data URL (#19 A, C); a custom picture is
 * only its URL in avatarUrls / avatarUrl, once its rendition exists. Room
 * broadcasts stay ONE emit (seq unchanged).
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

// several seeded games per test (with and without the pipeline): ~1-4 s each alone, slower in a full parallel run
jest.setTimeout(30000);

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
const posOf = (r, username) => r.wire.find((x) => x.event === 'positionUpdate').data.positions[
    r.wire.find((x) => x.event === 'positionUpdate').data.usernames.findIndex((u) => u.username === username)];
const URL_RE = /^\/avatar\/[^/?#\s]+\?v=[0-9a-f]{16}$/;

/** Every picture slot a recipient got, with the event it came in. */
function slots(recs) {
    const out = [];
    const add = (event, p) => out.push({ event, p });
    for (const { event, data } of recs) {
        if (!data || typeof data !== 'object') continue;
        if (event === 'positionUpdate') data.pics.forEach((p) => add(event, p));
        if (event === 'gameStart') data.playerInfo.forEach((p) => add(event, p.pic));
        if (['rejoinSuccess', 'restorePlayerState', 'spectatorJoined'].includes(event) && data.players) data.players.forEach((p) => add(event, p.pic));
        if (event === 'playerActiveMode') add(event, data.pic);
        if (data.snapshot) data.snapshot.seats.forEach((s) => add(`${event}.snapshot.customPic`, s.customPic));
    }
    return out;
}

/** #19 A, C: no slot is ever a string (a data URL or anything else); returns how many custom slots were null. */
function assertNoInline(recs) {
    const all = slots(recs);
    const strings = all.filter(({ p }) => typeof p === 'string');
    expect(strings.map(({ event, p }) => `${event}: ${p.slice(0, 40)}`)).toEqual([]);
    for (const { event, p } of all) expect({ event, ok: p === null || Number.isInteger(p) }).toEqual({ event, ok: true });
    return all.length;
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

test('one custom human (200 px) + 3 bots: with or without clientHello, a null slot + avatarUrls and nothing inline', async () => {
    const humans = [{ username: 'ava', profilePic: 5, customProfilePic: PIC200 }];
    const cap = await play({ humans, capable: (role) => role === 'human' });
    const leg = await play({ humans });
    const off = await play({ humans, pipeline: false });
    const sid = cap.socks[0].id;
    const pos = posOf(cap, 'ava');
    const url = `/avatar/ava?v=${cap.versionOf(PIC200)}`;

    for (const r of [cap, leg]) {
        const recs = receivedBy(r.wire, r.socks[0].id);
        const starts = recs.filter((x) => x.event === 'gameStart');
        expect(starts.length).toBeGreaterThanOrEqual(13);
        for (const g of starts) {
            expect(g.bytes).toBeLessThanOrEqual(1500);
            expect(g.data.playerInfo.find((p) => p.position === pos).pic).toBeNull();
            expect(g.data.avatarUrls).toEqual({ [pos]: url });
        }
        expect(assertNoInline(recs)).toBeGreaterThan(13);
        // one positionUpdate for the room: null at the custom seat + avatarUrls
        const pu = r.wire.filter((x) => x.event === 'positionUpdate');
        expect(pu).toHaveLength(1);
        expect(pu[0].data.avatarUrls).toEqual({ [pos]: url });
        expect(pu[0].data.pics[pu[0].data.positions.indexOf(pos)]).toBeNull();
    }
    // without clientHello the wire is byte for byte the same (#19 F)
    expect(receivedBy(leg.wire, leg.socks[0].id).map((x) => JSON.stringify(x.data))).toEqual(receivedBy(cap.wire, sid).map((x) => JSON.stringify(x.data)));
    const res = await fetchAvatar(cap, url);
    expect([res.status, res.type, res.cc]).toEqual([200, 'image/webp', 'public, max-age=31536000, immutable']);
    const m = await sharp(res.body).metadata();
    expect([m.format, m.width]).toEqual(['webp', 200]);

    // pipeline off: no URL, the custom seat still null (no inline copy either)
    const offRecs = receivedBy(off.wire, off.socks[0].id);
    assertNoInline(offRecs);
    expect(off.wire.some((x) => x.data && (x.data.avatarUrls || x.data.avatarUrl))).toBe(false);
    // same game, same seq numbering as with the pipeline off
    const seqs = (r) => r.wire.filter((x) => String(x.to).startsWith('game:')).map((x) => `${x.event}:${x.data.seq}`);
    expect(seqs(cap)).toEqual(seqs(off));

    const whole = { on: bytesTo(cap.wire, sid), off: bytesTo(off.wire, off.socks[0].id) };
    expect(whole.on).toBeLessThanOrEqual(100000);
    const g0 = (r, s) => receivedBy(r.wire, s).find((x) => x.event === 'gameStart').bytes;
    report.push({
        scenario: '1 custom (200 px) + 3 bots, the custom human\'s own socket',
        storedChars: PIC200.length,
        gameStart: { off: g0(off, off.socks[0].id), on: g0(cap, sid) },
        positionUpdate: { off: off.wire.find((x) => x.event === 'positionUpdate').bytes, on: cap.wire.find((x) => x.event === 'positionUpdate').bytes },
        wholeGame: whole,
    });
});

test('mixed table: two custom humans (one never says hello), a spectator; disconnect/rejoin, lazy, /active: nothing inline for anyone', async () => {
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
        // 1. drop + rejoin on a new socket -> rejoinSuccess (human seat)
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
        // the store has both renditions (pipeline on)
        if (store.available()) expect(store.peek(store.versionOf(PIC612)).status).toBe('ok');
    };
    const r = await play({ humans, spectators, capable: (role, i) => role === 'spectator' || i === 0, onStep: steps });
    expect(stepDone).toBe(true);
    const ava = posOf(r, 'ava');
    const bob = posOf(r, 'bob');
    const urls = { [ava]: `/avatar/ava?v=${r.versionOf(PIC200)}`, [bob]: `/avatar/bob?v=${r.versionOf(PIC612)}` };

    // ONE positionUpdate (room), null custom slots + avatarUrls
    const pu = r.wire.filter((x) => x.event === 'positionUpdate');
    expect(pu).toHaveLength(1);
    expect(pu[0].data.avatarUrls).toEqual(urls);

    const spec = r.specs[0].id;
    const sj = receivedBy(r.wire, spec).find((x) => x.event === 'spectatorJoined' && x.data.players);
    expect(sj.data.avatarUrls).toEqual(urls);
    expect(sj.data.players.filter((p) => p.pic === null)).toHaveLength(2);
    const recsOf = (id) => receivedBy(r.wire, id);
    const avaRecs = [...recsOf(r.socks[0].id), ...recsOf('ava-2'), ...recsOf('ava-3')];
    const bobRecs = recsOf(r.socks[1].id); // bob never sent clientHello
    for (const recs of [recsOf(spec), avaRecs, bobRecs]) {
        expect(assertNoInline(recs)).toBeGreaterThan(26);
        for (const x of recs.filter((y) => y.event === 'gameStart')) {
            expect(x.bytes).toBeLessThanOrEqual(1500);
            expect(x.data.avatarUrls).toEqual(urls);
        }
    }
    const rejoins = avaRecs.filter((x) => x.event === 'rejoinSuccess');
    expect(rejoins).toHaveLength(2);
    expect(rejoins[0].data.avatarUrls).toEqual(urls);
    // the watch view of a lazy seat shows its bot (stock pic) at ava's position
    expect(rejoins[1].data.isLazy).toBe(true);
    expect(rejoins[1].data.avatarUrls).toEqual({ [bob]: urls[bob] });
    const restore = avaRecs.find((x) => x.event === 'restorePlayerState');
    expect(restore.data.avatarUrls).toEqual(urls);
    // the attached snapshots carry seat avatarUrls, never customPic, and no partial 'customPics'
    expect(restore.data.snapshot.seats.find((s) => s.position === bob)).toMatchObject({ hasCustomPic: true, customPic: null, avatarUrl: urls[bob] });
    expect(restore.data.snapshot.partial).not.toContain('customPics');

    // playerActiveMode: one room broadcast, pic null + avatarUrl
    const am = r.wire.filter((x) => x.event === 'playerActiveMode');
    expect(am).toHaveLength(1);
    expect(am[0].data).toMatchObject({ pic: null, avatarUrl: urls[ava] });

    // the same table with the pipeline off, for the byte table
    stepDone = false;
    const off = await play({ humans, spectators, pipeline: false, onStep: steps });
    const first = (recs, ev) => recs.find((x) => x.event === ev && (ev !== 'spectatorJoined' || x.data.players));
    const sum = (recs) => recs.reduce((a, x) => a + x.bytes, 0);
    assertNoInline(receivedBy(off.wire, off.specs[0].id));
    report.push({
        scenario: 'mixed table (ava 200 px with hello, bob 612 px without, spectator)',
        storedChars: { ava: PIC200.length, bob: PIC612.length },
        gameStart: { off: first(receivedBy(off.wire, off.socks[0].id), 'gameStart').bytes, on: first(recsOf(r.socks[0].id), 'gameStart').bytes, bob: first(bobRecs, 'gameStart').bytes },
        positionUpdate: { off: off.wire.find((x) => x.event === 'positionUpdate').bytes, on: pu[0].bytes },
        spectatorJoined: { off: first(receivedBy(off.wire, off.specs[0].id), 'spectatorJoined').bytes, on: sj.bytes },
        restorePlayerState: { on: restore.bytes },
        playerActiveMode: { on: am[0].bytes },
        wholeGame: { ava: sum(recsOf(r.socks[0].id)), bob: sum(bobRecs), spectator: sum(recsOf(spec)) },
    });
    expect(sum(bobRecs)).toBeLessThan(120000);
});

test('a snapshot: customPics true or false, the seat is null + avatarUrl; partial never lists customPics (#19 C)', async () => {
    const humans = [{ username: 'ava', profilePic: 5, customProfilePic: PIC612 }];
    let snaps = null;
    const r = await play({
        humans,
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
    for (const x of got) {
        expect(x.data.snapshot.seats.find((s) => s.position === pos)).toMatchObject({ hasCustomPic: true, customPic: null, avatarUrl: `/avatar/ava?v=${r.versionOf(PIC612)}` });
        expect(x.data.snapshot.partial).not.toContain('customPics');
    }
    expect(got[1].bytes).toBe(got[0].bytes);
    report.push({ scenario: 'stateSnapshot (612 px custom)', customPicsFalse: got[0].bytes, customPicsTrue: got[1].bytes, storedChars: PIC612.length });
});

test('rendition not ready (derive pending): the slot is null and there is no URL yet, for every socket', async () => {
    const humans = [{ username: 'ava', profilePic: 5, customProfilePic: PIC200 }, { username: 'bob', profilePic: 9 }];
    const r = await play({ humans, prewarm: false, deriveNever: true, capable: (role, i) => i === 0 });
    for (const sid of [r.socks[0].id, r.socks[1].id]) {
        const recs = receivedBy(r.wire, sid);
        expect(assertNoInline(recs)).toBeGreaterThan(13);
        expect(recs.some((x) => x.data && (x.data.avatarUrls || x.data.avatarUrl))).toBe(false);
    }
});

test('a hostile stored picture (SVG behind image/png): null for everyone, no URL, no placeholder image', async () => {
    const humans = [{ username: 'eve', profilePic: 5, customProfilePic: fx.dataUrl(fx.SVG) }, { username: 'bob', profilePic: 9 }];
    const r = await play({ humans, capable: (role, i) => i === 1 });
    for (const sid of [r.socks[0].id, r.socks[1].id]) expect(assertNoInline(receivedBy(r.wire, sid))).toBeGreaterThan(13);
    expect(r.wire.some((x) => x.data && (x.data.avatarUrls || x.data.avatarUrl))).toBe(false);
});
