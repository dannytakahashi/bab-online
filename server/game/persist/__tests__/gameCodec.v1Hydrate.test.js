/**
 * Codec v2 (/help, plan H2b) and v3 (a log entry's fault, 2026-11-19)
 * against the docs written before them. CODEC_V 2 added state.assist (game.assist, assistState.js); a game the old
 * process saved as v1 must survive the deploy that brings v2:
 *
 *   - __fixtures__/gameDoc.v1.json holds real v1 docs, written by the v1
 *     codec at safe points of chaos runs (one per restore stage; a
 *     lobby-born game, lazy and bot seats among them). Each hydrates,
 *     passes validateGameState and validateSeats, every seat starts with
 *     the default assist (no /help use yet), the bid clock is fresh
 *     (DERIVED: no clock, no strikes), and serialize(hydrate(v1)) is the
 *     doc as v2 writes it (expectedAfterRestore: v 2, default assist).
 *   - That v2 doc hydrates again to the same doc (v2 is stable).
 *   - A v2 doc's assist is normalized on the way in: missing positions,
 *     wrong types, negative counts and unknown keys become the defaults.
 *   - A v3 log entry's fault {position, bid, took} round-trips; a v1 or v2
 *     doc's log has none (nothing to convert).
 *   - Any version but 1, 2 and 3 is a CodecError('version').
 *   - A fresh GameState has the default assist (and serialize writes it).
 */

const { createMemoryDb } = require('../../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const GameState = require('../../GameState');
const { validateSeats } = require('../../SeatState');
const { defaultAssist, defaultAssistSeat, ASSIST_SEAT_KEYS } = require('../../assistState');
const { gameLogger, socketLogger, authLogger, logger } = require('../../../utils/logger');
const codec = require('../gameCodec');
const V1_DOCS = require('../__fixtures__/gameDoc.v1.json');

const json = (v) => JSON.parse(JSON.stringify(v));
const NOW = 1_800_000_000_000;

let errorLogs;
const restoredGames = [];

beforeAll(() => {
    process.env.BAB_FSM_CHECK = '1';
});

afterAll(() => {
    delete process.env.BAB_FSM_CHECK;
});

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        for (const m of ['warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    for (const g of restoredGames.splice(0)) g._cancelAllTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    expect(errorLogs).toEqual([]);
});

/** hydrate + a re-serialize that finds the restored bots in the doc. */
function restore(doc) {
    const out = codec.hydrate(json(doc), { now: NOW });
    restoredGames.push(out.game);
    const again = codec.serialize(out.game, {
        tournamentId: out.tournamentId,
        getBot: (sid) => out.bots.find((b) => b.socketId === sid) || null,
    });
    return { ...out, again };
}

describe('the v1 fixture', () => {
    test('is real v1: one doc per restore stage, no assist, bots and a lobby-born game among them', () => {
        expect(V1_DOCS.map((d) => d.stage).sort()).toEqual([...codec.SAVE_STAGES].sort());
        for (const d of V1_DOCS) {
            expect(d.v).toBe(1);
            expect(d.state).not.toHaveProperty('assist');
        }
        expect(V1_DOCS.some((d) => d.state.lobbyOrigin)).toBe(true);
        expect(V1_DOCS.some((d) => d.bots.length > 0)).toBe(true);
        expect(V1_DOCS.some((d) => Object.values(d.state.seats).some((s) => s.controller === 'lazyBot'))).toBe(true);
    });
});

describe('a v1 doc hydrates under the current CODEC_V (3)', () => {
    test.each(V1_DOCS.map((d) => [d.stage, d]))('%s', (stage, doc) => {
        expect(codec.CODEC_V).toBe(3);
        const { game, again } = restore(doc);
        expect(game.stage).toBe(stage);
        expect(game.validateGameState().errors).toEqual([]);
        expect(validateSeats(game)).toEqual([]);
        expect(game.eventSeq).toBe(doc.state.eventSeq + codec.EVENT_SEQ_OFFSET);
        // No /help use yet on any seat
        expect(game.assist).toEqual(defaultAssist());
        // The bid clock is DERIVED: a fresh one comes with the restore kick
        expect(game.bidClock).toBeNull();
        expect(game.bidTimeouts).toEqual({});
        // Written back as v3: the same doc with the default assist
        expect(again.v).toBe(3);
        expect(again.state.assist).toEqual(defaultAssist());
        expect(again).toEqual(codec.expectedAfterRestore(doc));
    });

    test('the v3 doc it becomes hydrates again to itself', () => {
        for (const doc of V1_DOCS) {
            const first = restore(doc).again;
            const second = restore(first).again;
            expect(second).toEqual(codec.expectedAfterRestore(first));
        }
    });

    test('expectedAfterRestore upgrades only the version and the assist (and no bag counter: none in the doc)', () => {
        const doc = V1_DOCS[0];
        const out = codec.expectedAfterRestore(doc);
        const { v, state: { assist, seatBags, ...state }, ...rest } = out;
        expect(v).toBe(3);
        expect(assist).toEqual(defaultAssist());
        expect(seatBags).toBeNull();
        expect(restore(doc).game.seatBags).toBeNull();
        const plainRestore = json(doc);
        plainRestore.state.eventSeq += codec.EVENT_SEQ_OFFSET;
        expect(Object.keys(state).sort()).toEqual(Object.keys(plainRestore.state).sort());
        const { v: _v, state: _s, ...oldRest } = plainRestore;
        expect(rest).toEqual(oldRest);
    });
});

describe('a v2 doc carries game.assist', () => {
    test('a non-default assist round-trips', () => {
        const base = restore(V1_DOCS[1]).again;
        const assist = defaultAssist();
        assist[1] = { user: 's2_u3', help: 4, lastHelpKey: '3|PLAYING|1|4|9', tutorial: false, auto: false, tutorialEver: false, tips: 0 };
        assist[4] = { user: 's2_u1', help: 2, lastHelpKey: '3|BIDDING|4|3|0', tutorial: true, auto: true, tutorialEver: true, tips: 37 };
        const doc = { ...base, state: { ...base.state, assist } };
        const { game, again } = restore(doc);
        expect(game.assist).toEqual(assist);
        expect(again.state.assist).toEqual(assist);
        expect(again).toEqual(codec.expectedAfterRestore(doc));
    });

    test('a malformed assist is normalized on the way in', () => {
        const base = restore(V1_DOCS[0]).again;
        const doc = {
            ...base,
            state: {
                ...base.state,
                assist: {
                    1: { user: 7, help: -2, lastHelpKey: 5, tutorial: 'yes', auto: 1, tutorialEver: null, tips: 1.5, extra: 'x' },
                    2: null,
                    3: { help: 3 },
                    9: { user: 'nobody', help: 99 },
                },
            },
        };
        const { game, again } = restore(doc);
        const want = defaultAssist();
        want[3].help = 3;
        expect(game.assist).toEqual(want);
        expect(again.state.assist).toEqual(want);
        for (let pos = 1; pos <= 4; pos++) expect(Object.keys(game.assist[pos])).toEqual([...ASSIST_SEAT_KEYS]);
    });

    test('a doc without assist at all (as v1) gets the defaults', () => {
        const base = restore(V1_DOCS[2]).again;
        const { assist: _drop, ...state } = base.state;
        const { game } = restore({ ...base, state });
        expect(game.assist).toEqual(defaultAssist());
    });
});

describe('a v3 doc carries a log entry\'s fault (2026-11-19)', () => {
    test('a fault line round-trips with its fault, the other lines without one, and a snapshot replays it', () => {
        const base = restore(V1_DOCS[1]).again;
        const fault = { position: 3, bid: 4, took: 1 };
        const line = { message: 'Fault: s2_u3 (bid 4, took 1)', playerPosition: null, type: 'system', timestamp: NOW - 5, fault };
        const doc = { ...base, log: [...base.log, line], logTotal: base.logTotal + 1 };
        const { game, again } = restore(doc);
        expect(game.gameLog.at(-1)).toEqual(line);
        expect(game.gameLog.slice(0, -1).every((e) => !('fault' in e))).toBe(true);
        expect(again.log.at(-1)).toEqual(line);
        expect(again).toEqual(codec.expectedAfterRestore(doc));
        const snapLog = game.getSnapshotV2(null).log;
        expect(snapLog.at(-1)).toEqual({ message: line.message, type: 'system', position: null, at: line.timestamp, fault });
        expect(snapLog.filter((e) => e.fault)).toHaveLength(1);
    });

    test('a v1 / v2 doc (no fault anywhere) hydrates with no fault on any line', () => {
        for (const v of [1, 2]) {
            const doc = { ...json(V1_DOCS[3]), v };
            const { game } = restore(doc);
            expect(game.gameLog.some((e) => 'fault' in e)).toBe(false);
            expect(game.getSnapshotV2(null).log.some((e) => 'fault' in e)).toBe(false);
        }
    });
});

describe('versions', () => {
    test('hydrate reads 1, 2 and 3, and nothing else', () => {
        expect(codec.READ_VERSIONS).toEqual([1, 2, 3]);
        const doc = json(V1_DOCS[0]);
        for (const v of [0, 4, codec.CODEC_V + 1, '1', '2', '3', null, undefined, 1.5]) {
            expect(() => codec.hydrate({ ...doc, v })).toThrow(expect.objectContaining({ reason: 'version' }));
        }
        for (const v of [1, 2, 3]) restoredGames.push(codec.hydrate({ ...doc, v }, { now: NOW }).game);
    });
});

describe('a fresh game', () => {
    test('starts with the default assist, one record per position', () => {
        const game = new GameState('g-assist-fresh');
        expect(game.assist).toEqual(defaultAssist());
        expect(Object.keys(game.assist)).toEqual(['1', '2', '3', '4']);
        expect(game.assist[1]).toEqual(defaultAssistSeat());
        // Records are separate objects (a count on one seat is not on another)
        game.assist[1].help++;
        expect(game.assist[2].help).toBe(0);
        expect(new GameState('g-assist-fresh-2').assist[1].help).toBe(0);
    });
});
