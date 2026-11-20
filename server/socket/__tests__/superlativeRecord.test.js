/**
 * What a finished game's record carries for the Records superlatives
 * (2026-11-20, server/utils/superlatives.js):
 *   - statsDeltas.byPosition[pos].totalBags: tricks over the seat's own bid,
 *     summed per hand (rules.seatBags; a bore never bags), record-only: it
 *     is never $inc'd into users.stats / botStats and never on gameEnd
 *   - statsDeltas.names {pos: username}: the durable seat -> player map
 *     (statsPending leaves the record once the stats are applied)
 *
 * Real handlers (bids, plays, the hand-end hold, gameEnd, recordGameStats),
 * in-memory DB, stub io, fake timers; every emit is checked against the
 * socket contract.
 */

const crypto = require('crypto');
const { createMemoryDb } = require('../../testUtils/memoryDb');

jest.setTimeout(30000);

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const authHandlers = require('../authHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const profile = require('../profileHandlers');
const rules = require('../../game/rules');
const { Phase } = require('../../game/GamePhase');
const { hashToken } = require('../../utils/sessionTokens');
const { makeIo, makeSocket, events, legalCards } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    gameManager.deletedUsernames.clear();
    profile._resetCachesForTests();
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager.mainRoomSocketIds.clear();
    gameManager.spectatorGames.clear();
    gameManager.currentUsers = [];
    gameManager.deletedUsernames.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const TOP_TRUMP = ['HI', 'LO', 'A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4']
    .map((r) => (r === 'HI' || r === 'LO' ? C(r, 'joker') : C(r, 'spades')));
const SUIT = (suit) => ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'].map((r) => C(r, suit));

/**
 * Four signed-in human seats (ann bob cat dan at 1-4) in BIDDING with
 * `handSize` cards, seat 1 to bid. Seat 1 holds the top trumps, so it takes
 * every trick.
 */
async function setup({ handSize = 4 } = {}) {
    seq++;
    const log = [];
    const io = makeIo(log);
    const sockets = [];
    for (const name of ['ann', 'bob', 'cat', 'dan']) {
        const username = `${name}${seq}`;
        const token = crypto.randomUUID();
        const now = new Date();
        mockDb.current.users._insert({ username, profilePic: 3, sessionTokens: [{ hash: hashToken(token), createdAt: now, lastUsedAt: now }] });
        const s = makeSocket(`sr${seq}-${username}`, log, io);
        s.username = username;
        await authHandlers.restoreSession(s, io, { username, sessionToken: token });
        mainRoomHandlers.joinMainRoom(s, io);
        sockets.push(s);
    }
    const game = gameManager.createGame(sockets.map((s) => s.id));
    sockets.forEach((s, i) => game.addPlayer(s.id, s.username, i + 1, i + 1, false));
    sockets.forEach((s) => s.join(game.roomName));
    game.entrants = null;
    game.currentHand = handSize;
    game.dealer = 4;
    const dealt = [TOP_TRUMP, SUIT('hearts'), SUIT('diamonds'), SUIT('clubs')].map((h) => h.slice(0, handSize));
    sockets.forEach((s, i) => game.setHand(s.id, dealt[i].map((c) => ({ ...c }))));
    game.trump = C('3', 'spades');
    game.forcePhase('BIDDING');
    game.bidder = 1;
    game.currentTurn = 1;
    game.playerBids = [];
    return { log, io, game, sockets, names: sockets.map((s) => s.username) };
}

async function bidAll(t, bids) {
    for (let i = 0; i < 4; i++) await gameHandlers.playerBid(t.sockets[i], t.io, { bid: bids[i] });
}

/** Play the hand out (first legal card) through the hand-end hold. */
async function playOut(t) {
    const from = t.log.length;
    for (let guard = 0; guard < 300 && t.log.slice(from).every((l) => l.event !== 'handComplete'); guard++) {
        if (t.game.stage === Phase.PLAYING) {
            const sid = t.game.positions[t.game.currentTurn];
            const socket = t.sockets.find((s) => s.id === sid);
            await gameHandlers.playCard(socket, t.io, { card: legalCards(t.game, sid)[0] });
        } else {
            await jest.advanceTimersByTimeAsync(5000);
        }
    }
    expect(t.log.slice(from).filter((l) => l.event === 'handComplete')).toHaveLength(1);
}

/** Let the background end-of-game writes settle. */
async function settle() {
    for (let i = 0; i < 20; i++) await jest.advanceTimersByTimeAsync(100);
}

describe('rules.seatBags', () => {
    test('tricks over the own bid, never below 0; a bore bids the whole hand, so it never bags', () => {
        expect(rules.seatBags('1', 4, 4)).toBe(3);
        expect(rules.seatBags('3', 3, 6)).toBe(0);
        expect(rules.seatBags('5', 2, 6)).toBe(0);
        expect(rules.seatBags('0', 2, 6)).toBe(2);
        for (const bore of ['B', '2B', '3B', '4B']) expect(rules.seatBags(bore, 4, 4)).toBe(0);
        expect(rules.seatBags(undefined, 2, 4)).toBe(2);
        expect(rules.seatBags('2', undefined, 4)).toBe(0);
    });
});

describe('per hand: playerStats.totalBags', () => {
    test('a hand adds each seat\'s bags (not the team net); the next hand adds to it', async () => {
        const t = await setup();
        await bidAll(t, ['1', '2', '1', '1']);
        await playOut(t);
        // seat 1 took all 4 on a bid of 1; nobody else took a trick
        expect([1, 2, 3, 4].map((p) => t.game.playerStats[p].totalBags)).toEqual([3, 0, 0, 0]);
        // team1 bid 2 and took 4: net 2, but seat 1's own bags are 3
        expect(t.game.playerStats[1].totalTricks - t.game.playerStats[1].totalBids).toBe(3);
        expect((t.game.playerStats[1].totalTricks + t.game.playerStats[3].totalTricks)
            - (t.game.playerStats[1].totalBids + t.game.playerStats[3].totalBids)).toBe(2);

        // A second hand, straight into the hand-end step
        const { game, io } = t;
        game.playerBids = ['0', '1', '2', '0'];
        game.bids = { team1: 2, team2: 1 };
        game.team1Mult = 1;
        game.team2Mult = 1;
        game.tricks = { team1: 3, team2: 1 };
        game.handTricks = { 1: 2, 2: 1, 3: 1, 4: 0 };
        game.forcePhase('HAND_RESOLVING');
        await gameHandlers.handleHandComplete(game, io);
        expect([1, 2, 3, 4].map((p) => game.playerStats[p].totalBags)).toEqual([5, 0, 0, 0]);
    });

    test('a bore never bags, even taking every trick', async () => {
        const t = await setup();
        await bidAll(t, ['B', '0', '0', '0']);
        await playOut(t);
        expect(t.game.playerStats[1].totalTricks).toBe(4);
        expect([1, 2, 3, 4].map((p) => t.game.playerStats[p].totalBags)).toEqual([0, 0, 0, 0]);
    });
});

describe('the record written at game end', () => {
    test('byPosition carries totalBags and statsDeltas.names the seat names; neither users.stats nor gameEnd carries totalBags', async () => {
        const t = await setup({ handSize: 13 });
        await bidAll(t, ['1', '1', '1', '1']);
        const from = t.log.length;
        await playOut(t);
        await settle();

        const end = events(t.log.slice(from), 'gameEnd');
        expect(end.length).toBeGreaterThan(0);
        for (const e of end) {
            for (const pos of ['1', '2', '3', '4']) expect(e.data.playerStats[pos]).not.toHaveProperty('totalBags');
        }

        const docs = mockDb.current.gameRecords.docs;
        expect(docs).toHaveLength(1);
        const rec = docs[0];
        const [ann, bob, cat, dan] = t.names;
        expect(rec.statsDeltas.names).toEqual({ 1: ann, 2: bob, 3: cat, 4: dan });
        expect([1, 2, 3, 4].map((p) => rec.statsDeltas.byPosition[p].totalBags)).toEqual([12, 0, 0, 0]);
        // the stats were applied: the pending list (with its names) is gone,
        // the seat names stay
        expect(rec.statsPending).toBeUndefined();
        for (const name of t.names) {
            const user = mockDb.current.users.docs.find((d) => d.username === name);
            expect(user.stats.gamesPlayed).toBe(1);
            expect(user.stats).not.toHaveProperty('totalBags');
        }
    });

    test('a player deleted mid-game is [deleted] in the names map, as in teamNPlayers', async () => {
        const t = await setup({ handSize: 4 });
        gameManager.deletedUsernames.add(t.names[2]);
        const rec = profile.buildGameEndRecord(t.game);
        expect(rec.statsDeltas.names).toEqual({ 1: t.names[0], 2: t.names[1], 3: '[deleted]', 4: t.names[3] });
        expect(rec.team1Players).toEqual([t.names[0], '[deleted]']);
        expect(rec.statsPending.map((e) => e.username)).not.toContain(t.names[2]);
    });

    test('the deploy-survival path inserts the same prebuilt record, names map and all (recordEndedGame)', async () => {
        const t = await setup({ handSize: 4 });
        t.game.playerStats[1].totalBags = 4;
        const rec = profile.buildGameEndRecord(t.game);
        expect(await profile.recordEndedGame(rec)).toBe(true);
        const stored = mockDb.current.gameRecords.docs[0];
        expect(stored.statsDeltas.names).toEqual({ 1: t.names[0], 2: t.names[1], 3: t.names[2], 4: t.names[3] });
        expect(stored.statsDeltas.byPosition[1].totalBags).toBe(4);
        const ann = mockDb.current.users.docs.find((d) => d.username === t.names[0]);
        expect(ann.stats.gamesPlayed).toBe(1);
        expect(ann.stats).not.toHaveProperty('totalBags');
    });
});
