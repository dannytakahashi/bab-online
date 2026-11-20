/**
 * What a finished game's record carries for the Records superlatives
 * (2026-11-20, server/utils/superlatives.js):
 *   - statsDeltas.bags[pos]: tricks over the seat's own bid, summed per
 *     hand (rules.seatBags; no bags on a team with a bore) into
 *     game.seatBags {hands, byPos}, only when that counter saw every hand
 *     (seatBags.hands === handStats.totalHands; GameState starts it, a game
 *     adopted from a process without it has none, a stale one is not
 *     trusted). Beside byPosition, so no applyPendingStats $incs it into
 *     users.stats / botStats; never in playerStats (the release before
 *     spreads that into gameEnd) nor on the wire
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
        expect(rules.seatBags('1', 4, '0')).toBe(3);
        expect(rules.seatBags('3', 3, '1')).toBe(0);
        expect(rules.seatBags('5', 2, '1')).toBe(0);
        expect(rules.seatBags('0', 2, '3')).toBe(2);
        for (const bore of ['B', '2B', '3B', '4B']) expect(rules.seatBags(bore, 4, '0')).toBe(0);
        expect(rules.seatBags(undefined, 2)).toBe(2);
        expect(rules.seatBags('2', undefined, '1')).toBe(0);
    });

    test('nor does the partner of a bore: the team contract was every trick (as team1Bags / team2Bags count it)', () => {
        // 13 cards: seat 1 bores and takes 9, seat 3 bid 3 and takes 4
        expect(rules.seatBags('3', 4, 'B')).toBe(0);
        for (const bore of ['B', '2B', '3B', '4B']) expect(rules.seatBags('1', 5, bore)).toBe(0);
        expect(rules.seatBags('3', 4, undefined)).toBe(1);
    });
});

const codec = require('../../game/persist/gameCodec');

/** serialize + JSON, as the persist store writes it. */
const save = (game) => JSON.parse(JSON.stringify(codec.serialize(game, { tournamentId: null, getBot: () => null })));

/** A hand straight into the hand-end step (not the last unless `currentHand` 13). */
async function hand(game, io, bids, handTricks, { currentHand = 4 } = {}) {
    game.playerBids = bids;
    game.bids = { team1: Number(bids[0]) + Number(bids[2]), team2: Number(bids[1]) + Number(bids[3]) };
    game.team1Mult = 1;
    game.team2Mult = 1;
    game.tricks = { team1: handTricks[1] + handTricks[3], team2: handTricks[2] + handTricks[4] };
    game.handTricks = { ...handTricks };
    game.currentHand = currentHand;
    game.forcePhase('HAND_RESOLVING');
    await gameHandlers.handleHandComplete(game, io);
}

const byPos = (game) => [1, 2, 3, 4].map((p) => game.seatBags.byPos[p]);

describe('per hand: game.seatBags', () => {
    test('a hand adds each seat\'s bags (not the team net) and counts the hand; the next hand adds to it', async () => {
        const t = await setup();
        await bidAll(t, ['1', '2', '1', '1']);
        await playOut(t);
        // seat 1 took all 4 on a bid of 1; nobody else took a trick
        expect(t.game.seatBags).toEqual({ hands: 1, byPos: { 1: 3, 2: 0, 3: 0, 4: 0 } });
        expect(t.game.handStats.totalHands).toBe(1);
        // team1 bid 2 and took 4: net 2, but seat 1's own bags are 3
        expect(t.game.playerStats[1].totalTricks - t.game.playerStats[1].totalBids).toBe(3);
        expect((t.game.playerStats[1].totalTricks + t.game.playerStats[3].totalTricks)
            - (t.game.playerStats[1].totalBids + t.game.playerStats[3].totalBids)).toBe(2);
        // never in playerStats (the release before spreads it into gameEnd)
        for (const p of [1, 2, 3, 4]) expect(t.game.playerStats[p]).not.toHaveProperty('totalBags');

        await hand(t.game, t.io, ['0', '1', '2', '0'], { 1: 2, 2: 1, 3: 1, 4: 0 });
        expect(t.game.seatBags).toEqual({ hands: 2, byPos: { 1: 5, 2: 0, 3: 0, 4: 0 } });
        expect(t.game.handStats.totalHands).toBe(2);
    });

    test('a bore never bags, even taking every trick', async () => {
        const t = await setup();
        await bidAll(t, ['B', '0', '0', '0']);
        await playOut(t);
        expect(t.game.playerStats[1].totalTricks).toBe(4);
        expect(t.game.seatBags).toEqual({ hands: 1, byPos: { 1: 0, 2: 0, 3: 0, 4: 0 } });
    });

    test('the partner of a bore does not bag either; the other team still does', async () => {
        const t = await setup();
        const { game, io } = t;
        game.playerBids = ['B', '1', '0', '0'];
        game.bids = { team1: 4, team2: 1 };
        game.team1Mult = 2;
        game.team2Mult = 1;
        game.tricks = { team1: 3, team2: 1 };
        // seat 3 bid 0 and took 1: no bag (its team bored); seat 4 bid 0 and took 1: a bag
        game.handTricks = { 1: 2, 2: 0, 3: 1, 4: 1 };
        game.forcePhase('HAND_RESOLVING');
        await gameHandlers.handleHandComplete(game, io);
        expect(byPos(game)).toEqual([0, 0, 0, 1]);
    });

    test('a game adopted from a process without the counter (no state.seatBags) never starts one mid-game', async () => {
        const t = await setup();
        const doc = save(t.game);
        delete doc.state.seatBags; // as the release before saves it
        gameManager.abortGame(t.game.gameId);
        const game = codec.hydrate(doc).game;
        expect(game.seatBags).toBeNull();
        await hand(game, t.io, ['0', '1', '2', '0'], { 1: 2, 2: 1, 3: 1, 4: 0 });
        expect(game.seatBags).toBeNull();
        for (const p of [1, 2, 3, 4]) expect(game.playerStats[p]).not.toHaveProperty('totalBags');
        // its record has no bags: the superlatives fall back to each seat's net
        const rec = profile.buildGameEndRecord(game);
        expect(rec.statsDeltas).not.toHaveProperty('bags');
        expect(Object.keys(rec.statsDeltas.byPosition[1])).not.toContain('totalBags');
        expect(rec.statsDeltas.names).toEqual({ 1: t.names[0], 2: t.names[1], 3: t.names[2], 4: t.names[3] });
        // and saves it as null
        expect(save(game).state.seatBags).toBeNull();
        game._cancelAllTimers();
    });

    test('a new game starts the counter at 0; a save and restore keeps it; a missing or malformed one restores as none', async () => {
        const t = await setup();
        expect(t.game.seatBags).toEqual({ hands: 0, byPos: { 1: 0, 2: 0, 3: 0, 4: 0 } });
        t.game.seatBags.byPos[2] = 3;
        t.game.seatBags.hands = 1;
        const doc = save(t.game);
        expect(doc.state.seatBags).toEqual({ hands: 1, byPos: { 1: 0, 2: 3, 3: 0, 4: 0 } });
        for (const p of [1, 2, 3, 4]) expect(doc.state.playerStats[p]).not.toHaveProperty('totalBags');
        // still a v3 doc: the release before reads v3 only, and ignores the extra state key
        expect(doc.v).toBe(3);
        gameManager.abortGame(t.game.gameId);
        const restored = codec.hydrate(JSON.parse(JSON.stringify(doc))).game;
        expect(restored.seatBags).toEqual({ hands: 1, byPos: { 1: 0, 2: 3, 3: 0, 4: 0 } });
        expect(save(restored)).toEqual(codec.expectedAfterRestore(doc));
        restored._cancelAllTimers();
        for (const bad of [undefined, null, 7, { hands: -1, byPos: { 1: 0, 2: 0, 3: 0, 4: 0 } }, { hands: 1, byPos: { 1: 0, 2: 0, 3: 0 } },
            { hands: 1.5, byPos: { 1: 0, 2: 0, 3: 0, 4: 0 } }, { hands: 1, byPos: { 1: 0, 2: '1', 3: 0, 4: 0 } }]) {
            const d = JSON.parse(JSON.stringify(doc));
            if (bad === undefined) delete d.state.seatBags;
            else d.state.seatBags = bad;
            const g = codec.hydrate(d).game;
            expect(g.seatBags).toBeNull();
            expect(codec.expectedAfterRestore(d).state.seatBags).toBeNull();
            g._cancelAllTimers();
        }
    });

    test('a doc whose playerStats carry a pre-release totalBags restores without it (never on gameEnd)', async () => {
        const t = await setup({ handSize: 13 });
        await bidAll(t, ['1', '1', '1', '1']);
        const doc = save(t.game);
        for (const p of [1, 2, 3, 4]) doc.state.playerStats[p].totalBags = p;
        delete doc.state.seatBags;
        gameManager.abortGame(t.game.gameId);
        const game = codec.hydrate(doc).game;
        game._cancelAllTimers();
        for (const p of [1, 2, 3, 4]) expect(game.playerStats[p]).not.toHaveProperty('totalBags');
        expect(codec.expectedAfterRestore(doc).state.playerStats[1]).not.toHaveProperty('totalBags');
        const from = t.log.length;
        await hand(game, t.io, ['1', '1', '1', '1'], { 1: 13, 2: 0, 3: 0, 4: 0 }, { currentHand: 13 });
        await settle();
        const [end] = events(t.log.slice(from), 'gameEnd');
        for (const pos of ['1', '2', '3', '4']) expect(end.data.playerStats[pos]).not.toHaveProperty('totalBags');
        expect(mockDb.current.gameRecords.docs[0].statsDeltas).not.toHaveProperty('bags');
    });

    test('branch -> release before -> branch: the counter is dropped on the way, so the record carries no bags', async () => {
        const t = await setup();
        // hand 1 here: seat 1 bids 1, takes 3
        await hand(t.game, t.io, ['1', '0', '0', '1'], { 1: 3, 2: 0, 3: 0, 4: 1 });
        expect(t.game.seatBags.hands).toBe(1);
        const doc = save(t.game);
        gameManager.abortGame(t.game.gameId);
        // the release before adopts it (restoreFrom reads named fields only),
        // plays hand 2 and saves without the counter
        const old = codec.hydrate(doc).game;
        old.seatBags = null;
        await hand(old, t.io, ['1', '0', '0', '0'], { 1: 4, 2: 0, 3: 0, 4: 0 });
        const oldDoc = save(old);
        delete oldDoc.state.seatBags;
        gameManager.abortGame(old.gameId);
        old._cancelAllTimers();
        // back here for hand 3
        const back = codec.hydrate(oldDoc).game;
        expect(back.seatBags).toBeNull();
        await hand(back, t.io, ['1', '0', '0', '0'], { 1: 2, 2: 1, 3: 1, 4: 0 });
        expect(back.handStats.totalHands).toBe(3);
        expect(profile.buildGameEndRecord(back).statsDeltas).not.toHaveProperty('bags');
        back._cancelAllTimers();
    });

    test('a counter that missed hands (hands !== handStats.totalHands) is not written: a stale one kept across a hop', async () => {
        const t = await setup();
        await hand(t.game, t.io, ['1', '0', '0', '1'], { 1: 3, 2: 0, 3: 0, 4: 1 });
        const doc = save(t.game);
        gameManager.abortGame(t.game.gameId);
        // a process that kept the field but never added to it: hand 2 not counted
        const kept = codec.hydrate(doc).game;
        const stale = kept.seatBags;
        kept.seatBags = null;
        await hand(kept, t.io, ['1', '0', '0', '0'], { 1: 4, 2: 0, 3: 0, 4: 0 });
        kept.seatBags = stale;
        const keptDoc = save(kept);
        expect(keptDoc.state.seatBags).toEqual({ hands: 1, byPos: { 1: 2, 2: 0, 3: 0, 4: 0 } });
        gameManager.abortGame(kept.gameId);
        kept._cancelAllTimers();
        const back = codec.hydrate(keptDoc).game;
        await hand(back, t.io, ['1', '0', '0', '0'], { 1: 2, 2: 1, 3: 1, 4: 0 });
        // it counted hands 1 and 3 of 3: not every hand
        expect(back.seatBags.hands).toBe(2);
        expect(back.handStats.totalHands).toBe(3);
        const rec = profile.buildGameEndRecord(back);
        expect(rec.statsDeltas).not.toHaveProperty('bags');
        // the same game with the counter in step does carry them
        back.seatBags.hands = 3;
        expect(profile.buildGameEndRecord(back).statsDeltas.bags).toEqual({ 1: 3, 2: 1, 3: 1, 4: 0 });
        back._cancelAllTimers();
    });
});

describe('the record written at game end', () => {
    test('statsDeltas.bags carries the bags (not byPosition) and statsDeltas.names the seat names; neither users.stats nor gameEnd carries them', async () => {
        const t = await setup({ handSize: 13 });
        await bidAll(t, ['1', '1', '1', '1']);
        const from = t.log.length;
        await playOut(t);
        await settle();

        const end = events(t.log.slice(from), 'gameEnd');
        expect(end.length).toBeGreaterThan(0);
        for (const e of end) {
            for (const pos of ['1', '2', '3', '4']) {
                expect(e.data.playerStats[pos]).not.toHaveProperty('totalBags');
                expect(e.data.playerStats[pos]).not.toHaveProperty('seatBags');
            }
            expect(e.data).not.toHaveProperty('seatBags');
        }

        const docs = mockDb.current.gameRecords.docs;
        expect(docs).toHaveLength(1);
        const rec = docs[0];
        const [ann, bob, cat, dan] = t.names;
        expect(rec.statsDeltas.names).toEqual({ 1: ann, 2: bob, 3: cat, 4: dan });
        expect(rec.statsDeltas.bags).toEqual({ 1: 12, 2: 0, 3: 0, 4: 0 });
        // byPosition is exactly the 12 bucket counters (an older
        // applyPendingStats $incs every field of it)
        const { STAT_KEYS } = require('../../utils/statsScope');
        for (const p of [1, 2, 3, 4]) expect(Object.keys(rec.statsDeltas.byPosition[p]).sort()).toEqual([...STAT_KEYS].sort());
        // the stats were applied: the pending list (with its names) is gone,
        // the seat names stay
        expect(rec.statsPending).toBeUndefined();
        for (const name of t.names) {
            const user = mockDb.current.users.docs.find((d) => d.username === name);
            expect(user.stats.gamesPlayed).toBe(1);
            expect(user.stats).not.toHaveProperty('totalBags');
        }
    });

    test('a game adopted from the release before on its last hand ends with no bags in its record (names still written)', async () => {
        const t = await setup({ handSize: 13 });
        await bidAll(t, ['1', '1', '1', '1']);
        // the release before's doc, mid-hand: no counter
        const doc = save(t.game);
        delete doc.state.seatBags;
        gameManager.abortGame(t.game.gameId);
        const game = codec.hydrate(doc).game;
        game._cancelAllTimers();
        const from = t.log.length;
        await hand(game, t.io, ['1', '1', '1', '1'], { 1: 13, 2: 0, 3: 0, 4: 0 }, { currentHand: 13 });
        await settle();
        expect(game.seatBags).toBeNull();
        expect(events(t.log.slice(from), 'gameEnd')).toHaveLength(1);
        const docs = mockDb.current.gameRecords.docs;
        expect(docs).toHaveLength(1);
        expect(docs[0].statsDeltas).not.toHaveProperty('bags');
        expect(docs[0].statsDeltas.names).toEqual({ 1: t.names[0], 2: t.names[1], 3: t.names[2], 4: t.names[3] });
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
        t.game.seatBags = { hands: t.game.handStats.totalHands, byPos: { 1: 4, 2: 0, 3: 0, 4: 0 } };
        const rec = profile.buildGameEndRecord(t.game);
        expect(await profile.recordEndedGame(rec)).toBe(true);
        const stored = mockDb.current.gameRecords.docs[0];
        expect(stored.statsDeltas.names).toEqual({ 1: t.names[0], 2: t.names[1], 3: t.names[2], 4: t.names[3] });
        expect(stored.statsDeltas.bags).toEqual({ 1: 4, 2: 0, 3: 0, 4: 0 });
        expect(stored.statsDeltas.byPosition[1]).not.toHaveProperty('totalBags');
        const ann = mockDb.current.users.docs.find((d) => d.username === t.names[0]);
        expect(ann.stats.gamesPlayed).toBe(1);
        expect(ann.stats).not.toHaveProperty('totalBags');
    });
});
