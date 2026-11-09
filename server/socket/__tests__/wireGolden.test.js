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

const gameManager = require('../../game/GameManager');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { runGame } = require('../../testUtils/avatarHarness');

const FILE = path.join(__dirname, '__golden__', 'wireGolden.fcdd885.json');
const UPDATE = process.env.UPDATE_WIRE_GOLDEN === '1';

const SCENARIOS = {
    oneHuman: { seed: 12, opts: {} },
    collidingPics: {
        seed: 12,
        opts: { humans: [{ username: 'gold_a', profilePic: 5 }, { username: 'gold_b', profilePic: 5 }] },
    },
};

beforeEach(() => {
    require('uuid').__reset();
    jest.useFakeTimers();
    jest.setSystemTime(Date.UTC(2026, 0, 1, 12));
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

afterAll(() => require('../errorHandler').rateLimiter.shutdown());

const picClass = (p) => (typeof p === 'number' ? 'number' : typeof p === 'string' && p.startsWith('data:image') ? 'custom' : String(p));

/** Play one scenario and reduce it to its golden record. */
async function capture({ seed, opts }) {
    const deals = [];
    const r = await runGame(seed, {
        ...opts,
        onEmit: (rec, ctx) => {
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
    const hash = crypto.createHash('sha256');
    for (const x of r.wire) hash.update(`${x.to}|${(x.members || []).join(',')}|${x.event}|${JSON.stringify(x.data)}\n`);
    return {
        emits: r.wire.length,
        bytes: r.wire.reduce((a, x) => a + x.bytes, 0),
        wireSha256: hash.digest('hex'),
        seatPics: pu.data.pics,
        seatPicClasses: pu.data.pics.map(picClass),
        trumps: deals.map((d) => d.trump),
        hands: deals.map((d) => d.hands),
        finalScore: r.game.score,
    };
}

/** Golden of every scenario (run sequentially: one game world at a time). */
async function captureAll() {
    const out = {};
    for (const [name, sc] of Object.entries(SCENARIOS)) {
        require('uuid').__reset();
        mockDb.current = createMemoryDb({ users: [] });
        out[name] = await capture(sc);
    }
    return out;
}

module.exports = { captureAll, FILE };

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
