/**
 * Wire + RNG golden captured at fcdd885 (before the avatar pipeline,
 * roadmap item 10): two seeded real-handler games with NO custom picture.
 *
 *   A: seed 12, 1 human (profilePic 5) + 3 lobby bots
 *   B: seed 12, 2 humans who both saved profilePic 5 (the second one's pic
 *      collides and is re-rolled from Math.random) + 2 lobby bots
 *
 * Recorded per game: every dealt hand (by position), the trump sequence,
 * the seat pictures and their classes, the emit count and a sha256 of the
 * full wire log (recipient, event, JSON payload, in order). Any change to
 * the RNG order (pic fallbacks, bot personalities, the deck) or to any
 * payload byte shows here.
 *
 * Later commits assert the same golden with the avatar pipeline OFF (the
 * NODE_ENV=test default) and ON with no clientHello (invariants I3/I4 of
 * docs/avatars.md). UPDATE_WIRE_GOLDEN=1 rewrites the file — only ever at
 * fcdd885-equivalent wire behaviour.
 *
 * The executed contract/V1_REMOVALS.md entries change the wire on purpose,
 * so emits, bytes and the hash are taken over the wire AFTER `v1Projection`
 * (below), which undoes exactly those removals and nothing else: the golden
 * then still proves every other byte and the RNG order are fcdd885's. The
 * file was regenerated once at 71343c5 (raw wire still fcdd885's), with the
 * projection in place, before any removal ran.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createMemoryDb } = require('../../testUtils/memoryDb');

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

const fx = require('../../testUtils/avatarFixtures');

const FILE = path.join(__dirname, '__golden__', 'wireGolden.fcdd885.json');
const UPDATE = process.env.UPDATE_WIRE_GOLDEN === '1';

const SCENARIOS = {
    oneHuman: { seed: 12, opts: {} },
    collidingPics: {
        seed: 12,
        opts: { humans: [{ username: 'gold_a', profilePic: 5 }, { username: 'gold_b', profilePic: 5 }] },
    },
};

// The golden pins fcdd885's wire, which had standard pacing for every game:
// the solo overlay (pacing.js, a game with exactly one human) postdates it
// and changes oneHuman's resumeInMs values and timestamps, so it is turned
// off here the way production turns it off (UPGRADE_GATE=off). The solo
// timings have their own checks (pacing.test.js, pacingBudget.test.js).
const gateEnv = process.env.UPGRADE_GATE;

beforeEach(() => {
    process.env.UPGRADE_GATE = 'off';
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    if (gateEnv === undefined) delete process.env.UPGRADE_GATE; else process.env.UPGRADE_GATE = gateEnv;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

let CUSTOM;
beforeAll(async () => { CUSTOM = fx.dataUrl(await fx.avatarPng(200)); });

/**
 * The wire as it is with the executed V1_REMOVALS.md entries projected
 * away (each one names its entry). Applied to the fcdd885-equivalent wire
 * it only drops what the removals drop, so one golden pins both.
 */
const V1_DROPPED_EVENTS = new Set([
    'queueUpdate', // #2 the matchmaking queue
    'joinMainRoom', // #4 s2c joinMainRoom
    'serverError', // #1 phase A: the additive dual emit of app-level error
    'error', // #1 phase B: app-level error gone, serverError alone (these games send none, so a no-op kept as the record)
    'voiceRelayAudio', // #20 the web PCM relay (s2c gone; these games have no voice, so a no-op kept as the record)
]);
const DROP = Symbol('dropped by a V1 removal');
// The v1 client states whose players[] is playerInfoV1 (#14)
const LEGACY_STATE_EVENTS = new Set(['rejoinSuccess', 'restorePlayerState', 'spectatorJoined']);
function v1Projection(event, data, seatIds = new Map()) {
    if (V1_DROPPED_EVENTS.has(event)) return DROP;
    if (!data || typeof data !== 'object') return data;
    const d = { ...data };
    // #16 lobby bots' personality (every lobby payload's players[])
    if (Array.isArray(d.players)) {
        d.players = d.players.map((p) => {
            if (!p || typeof p !== 'object' || !('personality' in p)) return p;
            const { personality, ...rest } = p;
            return rest;
        });
    }
    if (event === 'rejoinFailed') delete d.debug; // #15
    if (event === 'mainRoomJoined') delete d.recentMessages; // #13
    if (event === 'chatMessage') delete d.type; // #12 (isSpectator stays)
    if (event === 'cardPlayed') { // #10: trump (a Bool) became trumpBroken; playerId dropped
        const broken = 'trumpBroken' in d ? d.trumpBroken : d.trump;
        delete d.trump; delete d.playerId; delete d.trumpBroken;
        d.trumpBroken = broken;
    }
    if (event === 'bidReceived' && d.bid != null) d.bid = String(d.bid); // #11
    // #14 socket ids: playerDrew.socketId, positionUpdate.usernames[].socketId
    // and the legacy states' players[].socketId are put back (in their
    // fcdd885 key order) from positionUpdate.sockets, which stays, so the
    // golden still pins every id; isBot (additive) is dropped
    if (event === 'playerDrew' && !('socketId' in d)) {
        const { username, card, drawOrder, ...rest } = d;
        return { username, card, drawOrder, socketId: seatIds.get(username), ...rest };
    }
    if (event === 'positionUpdate') {
        delete d.isBot;
        if (Array.isArray(d.usernames)) d.usernames = d.usernames.map((u, i) => ('socketId' in u ? u : { username: u.username, socketId: d.sockets[i] }));
    }
    if (LEGACY_STATE_EVENTS.has(event) && Array.isArray(d.players)) {
        d.players = d.players.map((p) => ('socketId' in p ? p : { position: p.position, username: p.username, pic: p.pic, socketId: seatIds.get(p.username) }));
    }
    return d;
}

/**
 * Removals executed after the golden was regenerated (71343c5) take emits or
 * keys out that the golden still holds. `v1Restore` puts each back exactly as
 * the old server sent it, built from the game at emit time (one block each,
 * naming its entry), so the golden keeps pinning everything else.
 */
const RESTORE_BEFORE = new WeakMap(); // wire record -> records the old server sent right before it
const RESTORED_DATA = new WeakMap(); // wire record -> its payload as the old server sent it
function v1Restore(rec, game) {
    // #7 playerAssigned {playerId, position}: handleDrawComplete sent one to
    // each connected human, in draw order, while seating; the next emit was
    // the seating positionUpdate (these scenarios have no draw-phase leaver,
    // whose takeover log line would have come between)
    if (rec.event === 'positionUpdate' && Array.isArray(game.drawIDs)) {
        const before = [];
        for (const sid of game.drawIDs) {
            const position = game.getPositionBySocketId(sid);
            const seat = position && game.seat(position);
            if (!seat || game.isBot(sid) || seat.presence !== 'connected' || seat.ownerSocketId !== sid) continue;
            before.push({ to: sid, members: [], event: 'playerAssigned', data: { playerId: sid, position } });
        }
        if (before.length) RESTORE_BEFORE.set(rec, before);
    }
    // #6 gameStart.players: the seat variant carried the seat socket ids in
    // deal order (game.getSocketIds()) right after gameId
    if (rec.event === 'gameStart' && rec.data && 'position' in rec.data && !('players' in rec.data)) {
        const { gameId, ...rest } = rec.data;
        RESTORED_DATA.set(rec, { gameId, players: game.getSocketIds(), ...rest });
    }
}

const picClass = (p) => (typeof p === 'number' ? 'number' : typeof p === 'string' && p.startsWith('data:image') ? 'custom' : String(p));

/**
 * Play one scenario in a FRESH module registry (server singletons such as
 * GameManager and BotController carry state from game to game, which would
 * make a scenario depend on the ones before it) and reduce it to its golden
 * record. `pipeline` switches the avatar pipeline on in that registry.
 */
async function capture(sc, { pipeline = false } = {}) {
    let rec;
    await jest.isolateModulesAsync(async () => {
        require('uuid').__reset();
        jest.setSystemTime(Date.UTC(2026, 0, 1, 12));
        mockDb.current = createMemoryDb({ users: [] });
        const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
        for (const l of [gameLogger, socketLogger, authLogger, logger]) {
            for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
        }
        if (pipeline) require('../../avatar/avatarStore').configure({ enabled: true });
        try {
            rec = await play(sc);
        } finally {
            require('../errorHandler').rateLimiter.shutdown();
        }
    });
    return rec;
}

async function play({ seed, opts }) {
    const { runGame } = require('../../testUtils/avatarHarness');
    const deals = [];
    const r = await runGame(seed, {
        ...opts,
        onEmit: (rec, ctx) => {
            if (ctx.game) v1Restore(rec, ctx.game);
            // One record per deal: the first gameStart of a deal (one shared seq)
            if (rec.event !== 'gameStart' || !ctx.game) return;
            if (deals.length && deals[deals.length - 1].seq === rec.data.seq) return;
            const g = ctx.game;
            const hands = {};
            for (let pos = 1; pos <= 4; pos++) {
                const sid = g.positions[pos];
                hands[pos] = (g.hands[sid] || []).map((c) => `${c.rank}${c.suit[0]}`).join(' ');
            }
            deals.push({ seq: rec.data.seq, trump: `${g.trump.rank}${g.trump.suit[0]}`, hands });
        },
    });
    const pu = r.wire.find((x) => x.event === 'positionUpdate');
    // #14: seat socket ids by username, from the positionUpdate.sockets that stays
    const seatIds = new Map(pu.data.usernames.map((u, i) => [u.username, pu.data.sockets[i]]));
    const hash = crypto.createHash('sha256');
    let emits = 0;
    let bytes = 0;
    for (const x of r.wire.flatMap((rec) => [...(RESTORE_BEFORE.get(rec) || []), rec])) {
        const data = v1Projection(x.event, RESTORED_DATA.get(x) ?? x.data, seatIds);
        if (data === DROP) continue;
        const json = JSON.stringify(data);
        emits++;
        bytes += json === undefined ? 0 : Buffer.byteLength(json);
        hash.update(`${x.to}|${(x.members || []).join(',')}|${x.event}|${json}\n`);
    }
    const rec = {
        emits,
        bytes,
        wireSha256: hash.digest('hex'),
        seatPics: pu.data.pics,
        seatPicClasses: pu.data.pics.map(picClass),
        trumps: deals.map((d) => d.trump),
        hands: deals.map((d) => d.hands),
        finalScore: r.game.score,
    };
    // not part of the golden (it did not exist at fcdd885)
    Object.defineProperty(rec, 'avatarVersions', { value: r.game.avatarVersions ? Object.fromEntries(r.game.avatarVersions) : null });
    return rec;
}

/** Golden of every scenario (run sequentially: one game world at a time). */
async function captureAll(scenarios = SCENARIOS, o) {
    const out = {};
    for (const [name, sc] of Object.entries(scenarios)) {
        out[name] = await capture(sc, o);
    }
    return out;
}

test('seeded no-custom-picture games are byte-identical to the fcdd885 golden (wire + RNG)', async () => {
    const got = await captureAll();
    for (const g of Object.values(got)) {
        expect(g.hands.length).toBeGreaterThanOrEqual(13); // 13 hands (+ any all-zero redeals)
        expect(g.seatPicClasses.every((c) => c === 'number')).toBe(true);
    }
    expect(got.collidingPics.seatPics.filter((p) => p === 5)).toHaveLength(1); // the collision was re-rolled
    if (UPDATE) {
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(got, null, 2) + '\n');
    }
    expect(got).toEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')));
}, 60000);

test('with the avatar pipeline ON and no clientHello the no-custom games are still byte-identical (I3, I4)', async () => {
    const got = await captureAll(SCENARIOS, { pipeline: true });
    expect(got).toEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')));
}, 60000);

test('a custom picture: the pipeline never changes the RNG (same hands, trumps, seat pictures); versions are hashed at seating', async () => {
    const sc = { custom: { seed: 12, opts: { humans: [{ username: 'gold_c', profilePic: 5, customProfilePic: CUSTOM }] } } };
    const off = (await captureAll(sc)).custom;
    const on = (await captureAll(sc, { pipeline: true })).custom;
    for (const k of ['hands', 'trumps', 'seatPicClasses', 'finalScore']) expect({ k, v: on[k] }).toEqual({ k, v: off[k] });
    expect(off.avatarVersions).toEqual({});
    expect(on.avatarVersions).toEqual({ gold_c: require('../../avatar/avatarStore').versionOf(CUSTOM) });
    expect(on.seatPicClasses.filter((c) => c === 'custom')).toHaveLength(1);
}, 60000);
