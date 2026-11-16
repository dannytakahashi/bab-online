/**
 * The ENDED tombstone's record (deploy survival, PR 3): serializeEnded,
 * taken where the terminal claim will run (gameEnd, right after
 * gameManager.endGame and before recordGameStats), holds exactly the
 * gameRecords document writeGameStats then inserts for the same game: one
 * builder (profileHandlers.buildGameEndRecord). Each case is a game on its
 * 13th hand's HAND_RESOLVING (a synthetic codec doc, adopted and kicked),
 * played out to the real gameEnd: a human game, a bot game, a game with a
 * resigned seat, a lazy seat (still a human game), a tournament table and
 * an owner who deleted their account mid-game. An aborted game's tombstone
 * holds no record by default; a record built once and handed to both
 * serializeEnded and recordGameStats(game, {record}) is the very object
 * inserted.
 */

const { createMemoryDb } = require('../../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const profileHandlers = require('../../../socket/profileHandlers');
const { makeIo, events } = require('../../../testUtils/gameDriver');
const { adoptForTest, kickRestored } = require('../../../testUtils/restoreKit');
const { gameLogger, socketLogger, authLogger, logger } = require('../../../utils/logger');
const codec = require('../gameCodec');

const NOW = 1_800_000_000_000;

beforeAll(() => { process.env.BAB_FSM_CHECK = '1'; });
afterAll(() => { delete process.env.BAB_FSM_CHECK; });

beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    profileHandlers._setStatsRetryDelaysForTests([1, 1]);
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    profileHandlers._setStatsRetryDelaysForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const BOTS = {
    1: { socketId: 'bot:mary:1', username: '🤖 Mary', pic: 11, personality: 'mary' },
    2: { socketId: 'bot:sharon:2', username: '🤖 Sharon', pic: 12, personality: 'sharon' },
    3: { socketId: 'bot:danny:3', username: '🤖 Danny', pic: 13, personality: 'danny' },
    4: { socketId: 'bot:mike:4', username: '🤖 Mike', pic: 14, personality: 'mike' },
};

function seat(pos, kind) {
    const owner = { ownerUsername: `p${pos}`, ownerPic: 30 + pos };
    const base = { lastPersonality: null, resignedAt: null, leftAt: null, gone: false, bot: null };
    switch (kind) {
        case 'human': return { ...base, ...owner, controller: 'human', presence: 'connected' };
        case 'lazy': return { ...base, ...owner, controller: 'lazyBot', presence: 'connected', bot: { ...BOTS[pos] }, lastPersonality: BOTS[pos].personality };
        case 'resigned': return { ...base, ...owner, controller: 'resignBot', presence: 'gone', bot: { ...BOTS[pos] }, lastPersonality: BOTS[pos].personality, resignedAt: NOW - 9000, leftAt: NOW - 8000, gone: true };
        default: return { ...base, controller: 'bot', presence: 'none', ownerUsername: null, ownerPic: null, bot: { ...BOTS[pos] }, lastPersonality: BOTS[pos].personality };
    }
}

/** The 13-card hand resolved: bids, tricks and running stats in place. */
function lastHandDoc(gameId, kinds, { tournamentId = null } = {}) {
    const seats = {};
    const bots = [];
    for (let pos = 1; pos <= 4; pos++) {
        seats[pos] = seat(pos, kinds[pos - 1]);
        if (seats[pos].bot) bots.push({ ...seats[pos].bot, position: pos, partnerHistory: [{ bid: 2, tricks: 3 }] });
    }
    return {
        v: codec.CODEC_V,
        gameId,
        stage: Phase.HAND_RESOLVING,
        tournamentId,
        state: {
            createdAt: NOW - 3_600_000,
            eventSeq: 900,
            dealSeq: 13,
            currentHand: 13,
            dealer: 4,
            bidder: 1,
            bids: { team1: 7, team2: 5 },
            playerBids: ['4', '3', '3', '2'],
            team1Mult: 1,
            team2Mult: 1,
            currentTurn: 3,
            leadPosition: 3,
            leadCard: { suit: 'clubs', rank: '9' },
            playedCards: [null, null, null, null],
            playedCardsIndex: 0,
            trump: { suit: 'spades', rank: '7' },
            isTrumpBroken: true,
            cardIndex: 52,
            tricks: { team1: 6, team2: 7 },
            trickHistory: [],
            score: { team1: 310, team2: 280 },
            rainbows: { team1: 0, team2: 0 },
            handStats: { totalHands: 12, team1Sets: 2, team2Sets: 3, team1SetPoints: 90, team2SetPoints: 140 },
            playerStats: {
                1: { totalBids: 30, totalTricks: 31, setsCaused: 1, totalHSI: 120 },
                2: { totalBids: 25, totalTricks: 22, setsCaused: 2, totalHSI: 101 },
                3: { totalBids: 28, totalTricks: 27, setsCaused: 1, totalHSI: 115 },
                4: { totalBids: 26, totalTricks: 24, setsCaused: 1, totalHSI: 99 },
            },
            handTricks: { 1: 3, 2: 4, 3: 3, 4: 3 },
            hsiValues: { 1: 10, 2: 9, 3: 11, 4: 8 },
            hands: { 1: [], 2: [], 3: [], 4: [] },
            seats,
            seatOrder: [1, 2, 3, 4],
        },
        log: [],
        logTotal: 0,
        bots,
    };
}

/**
 * Play `doc` out to gameEnd. Returns the tombstone serializeEnded built at
 * the claim point and the document writeGameStats inserted.
 */
async function endAndCompare(doc) {
    const log = [];
    const io = makeIo(log);
    for (let pos = 1; pos <= 4; pos++) {
        const s = doc.state.seats[pos];
        if (s.ownerUsername) mockDb.current.users._insert({ username: s.ownerUsername, profilePic: 1 });
    }
    const game = adoptForTest(doc, { io, now: NOW });
    let ended = null;
    const endGame = gameManager.endGame.bind(gameManager);
    jest.spyOn(gameManager, 'endGame').mockImplementation((gameId, ioArg) => {
        const r = endGame(gameId, ioArg);
        // The claim point: after endGame, before recordGameStats
        if (gameId === game.gameId) ended = codec.serializeEnded(game, profileHandlers.buildGameEndRecord(game));
        return r;
    });
    const inserted = [];
    const insertOne = mockDb.current.gameRecords.insertOne.bind(mockDb.current.gameRecords);
    jest.spyOn(mockDb.current.gameRecords, 'insertOne').mockImplementation((d, ...rest) => {
        inserted.push(JSON.parse(JSON.stringify(d)));
        return insertOne(d, ...rest);
    });

    kickRestored(io, game);
    await jest.advanceTimersByTimeAsync(30000);
    expect(game.stage).toBe(Phase.ENDED);
    expect(events(log, 'gameEnd')).toHaveLength(1);
    expect(ended).not.toBeNull();
    return { game, ended, inserted };
}

const asStored = (record) => JSON.parse(JSON.stringify(record));

describe('serializeEnded holds the record writeGameStats inserts', () => {
    const cases = [
        ['a human game', ['human', 'human', 'human', 'human'], 'stats'],
        ['a bot game', ['human', 'bot', 'human', 'bot'], 'botStats'],
        ['a game with a resigned seat', ['human', 'human', 'resigned', 'human'], 'botStats'],
        ['a game with a lazy seat (a human game)', ['human', 'lazy', 'human', 'human'], 'stats'],
    ];
    test.each(cases)('%s', async (_label, kinds, bucket) => {
        const { game, ended, inserted } = await endAndCompare(lastHandDoc(`g-ended-${kinds.join('-')}`, kinds));
        expect(inserted).toHaveLength(1);
        expect(asStored(ended.record)).toEqual(inserted[0]);
        expect(ended.record.statsDeltas.bucket).toBe(bucket);
        expect(ended.score).toEqual({ team1: game.score.team1, team2: game.score.team2 });
        expect(ended.seats).toEqual([1, 2, 3, 4].map((position) => ({
            username: game.getOriginalPlayer(position).username,
            position,
            gone: kinds[position - 1] === 'resigned',
        })));
        expect(ended.tournamentId).toBeNull();
        expect(ended.aborted).toBe(false);
    });

    test('a tournament table', async () => {
        const { ended, inserted } = await endAndCompare(lastHandDoc('g-ended-t', ['human', 'bot', 'human', 'bot'], { tournamentId: 't-1' }));
        expect(asStored(ended.record)).toEqual(inserted[0]);
        expect(ended.tournamentId).toBe('t-1');
    });

    test('an owner who deleted their account mid-game', async () => {
        gameManager.deletedUsernames.add('p2');
        const { ended, inserted } = await endAndCompare(lastHandDoc('g-ended-del', ['human', 'human', 'human', 'human']));
        expect(asStored(ended.record)).toEqual(inserted[0]);
        expect(ended.record.team2Players).toContain('[deleted]');
        expect(ended.record.statsPending.map((p) => p.username)).not.toContain('p2');
    });

    test('a game with no human owner records nothing, in both', async () => {
        const { ended, inserted } = await endAndCompare(lastHandDoc('g-ended-bots', ['bot', 'bot', 'bot', 'bot']));
        expect(ended.record).toBeNull();
        expect(inserted).toEqual([]);
    });

    test('serializeEnded builds the record itself when none is passed', async () => {
        const { game, ended } = await endAndCompare(lastHandDoc('g-ended-own', ['human', 'bot', 'human', 'human']));
        const own = codec.serializeEnded(game);
        expect({ ...own.record, completedAt: null }).toEqual({ ...ended.record, completedAt: null });
    });
});

describe('an aborted game', () => {
    test('its tombstone holds no record unless one is passed (abortGame never records stats)', () => {
        const doc = lastHandDoc('g-aborted', ['human', 'human', 'bot', 'human']);
        const game = adoptForTest(doc, { io: makeIo([]), now: NOW });
        // A human game: the builder alone would make a stats record for it
        expect(profileHandlers.buildGameEndRecord(game)).not.toBeNull();
        gameManager.abortGame(game.gameId);
        expect(game.stage).toBe(Phase.ABORTED);
        const tomb = codec.serializeEnded(game, undefined, { tournamentId: 't-9' });
        expect(tomb.record).toBeNull();
        expect(tomb.aborted).toBe(true);
        expect(tomb.tournamentId).toBe('t-9');
        expect(tomb.score).toEqual({ team1: 310, team2: 280 });
    });
});

describe('one record object for the tombstone and the insert', () => {
    test('recordGameStats(game, {record}) inserts the record it is handed, completedAt and pending list included', async () => {
        const doc = lastHandDoc('g-one-record', ['human', 'human', 'human', 'bot']);
        for (const u of ['p1', 'p2', 'p3']) mockDb.current.users._insert({ username: u, profilePic: 1 });
        const game = adoptForTest(doc, { io: makeIo([]), now: NOW });
        const record = profileHandlers.buildGameEndRecord(game);
        const tomb = codec.serializeEnded(game, record, { tournamentId: null });
        expect(tomb.record).toBe(record);
        const built = asStored(record);
        // Between the two: the clock moves and an owner deletes their
        // account. A second build would differ in both.
        jest.setSystemTime(NOW + 5000);
        gameManager.deletedUsernames.add('p2');
        expect({ ...asStored(profileHandlers.buildGameEndRecord(game)), completedAt: null }).not.toEqual({ ...built, completedAt: null });
        const handed = [];
        const insertOne = mockDb.current.gameRecords.insertOne.bind(mockDb.current.gameRecords);
        jest.spyOn(mockDb.current.gameRecords, 'insertOne').mockImplementation((d, ...rest) => {
            handed.push(d);
            return insertOne(d, ...rest);
        });
        await profileHandlers.recordGameStats(game, { record });
        expect(handed).toHaveLength(1);
        expect(handed[0]).toBe(record);
        expect(asStored(handed[0])).toEqual(asStored(tomb.record));
        expect(handed[0].completedAt).toEqual(new Date(NOW));
        expect(handed[0].statsPending.map((p) => p.username)).toContain('p2');
    });

    test('recordGameStats(game, {record: null}) records nothing', async () => {
        const game = adoptForTest(lastHandDoc('g-no-record', ['human', 'bot', 'human', 'bot']), { io: makeIo([]), now: NOW });
        const insert = jest.spyOn(mockDb.current.gameRecords, 'insertOne');
        await profileHandlers.recordGameStats(game, { record: null });
        expect(insert).not.toHaveBeenCalled();
    });
});
