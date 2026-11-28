/**
 * The scorecard (owner 2026-11-27; server/game/scorecard.js): one row per
 * completed hand, built at the hand's end from the values it was scored
 * with, kept on the game (saved with it) and sent as handComplete's
 * scorecardRow and as the rows so far in the v2 snapshot and gameEnd (each
 * deal's gameStart says how many there are: scorecardRows); the game's
 * record keeps it.
 *
 * 1. The row builder over every scoring case (made, set, extra tricks, a
 *    zero bid taking tricks, a made bore, a set 2B, the rainbow bonus) and
 *    Get Your Bid's (the Forbidden Bid, no faults).
 * 2. The real handlers: the row on handComplete equals the game's and the
 *    score's change, faults equal the fault lines, an all-zero redeal adds
 *    no row, gameStart counts the rows, requestSnapshot / gameEnd / the
 *    record carry them,
 *    a codec round trip keeps it.
 * 3. Whole seeded games with bots, both modes: every row's points are what
 *    the scores changed by, the running totals end at the final scores,
 *    the 13 rows are the hands in play order.
 *
 * Every emit is checked against the socket contract (the contract guard).
 */

const crypto = require('crypto');
const { createMemoryDb } = require('../../testUtils/memoryDb');

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
const lobbyHandlers = require('../lobbyHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const clientInfo = require('../clientInfo');
const voice = require('../voiceHandlers');
const pacing = require('../../game/pacing');
const rules = require('../../game/rules');
const scorecard = require('../../game/scorecard');
const gameCodec = require('../../game/persist/gameCodec');
const { buildGameEndRecord } = require('../profileHandlers');
const { Phase } = require('../../game/GamePhase');
const { hashToken } = require('../../utils/sessionTokens');
const { makeIo, makeSocket, legalCards, mulberry32 } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const sid of Array.from(gameManager.lobbyGrace.keys())) gameManager._clearLobbyGrace(sid);
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.spectatorGames.clear();
    gameManager.startedLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.currentUsers = [];
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------- 1. rows

/**
 * A base-game hand scored as scoreClassicHand does (team bids from
 * BID_RANKS capped at the hand, the multipliers, calculateScore), then its
 * row: the builder sees exactly what the handler would.
 */
function scoredHand({ handSize, bids, took, rainbows = { team1: 0, team2: 0 }, score = { team1: 0, team2: 0 }, dealer = 4, trump = C('7', 'hearts') }) {
    const teamBids = {
        team1: Math.min(handSize, (rules.BID_RANKS[bids[0]] || 0) + (rules.BID_RANKS[bids[2]] || 0)),
        team2: Math.min(handSize, (rules.BID_RANKS[bids[1]] || 0) + (rules.BID_RANKS[bids[3]] || 0)),
    };
    const tricks = { team1: took[0] + took[2], team2: took[1] + took[3] };
    const mults = { team1: rules.calculateMultiplier(bids[0], bids[2]), team2: rules.calculateMultiplier(bids[1], bids[3]) };
    const oldScore = { ...score };
    const game = {
        currentHand: handSize, dealer, trump, bids: teamBids, tricks, playerBids: bids,
        handTricks: { 1: took[0], 2: took[1], 3: took[2], 4: took[3] },
        score: {
            team1: score.team1 + rules.calculateScore(teamBids.team1, tricks.team1, mults.team1, rainbows.team1),
            team2: score.team2 + rules.calculateScore(teamBids.team2, tricks.team2, mults.team2, rainbows.team2),
        },
    };
    const faults = rules.handFaults({ teamBids, teamTricks: tricks, playerBids: bids, handTricks: game.handTricks });
    return scorecard.classicRow(game, { oldScore, faults });
}

describe('the row builder', () => {
    test('made with extra tricks: +bid x 10 + one per extra trick, no fault', () => {
        const row = scoredHand({ handSize: 12, bids: ['3', '2', '2', '1'], took: [3, 3, 3, 3] });
        expect(row).toEqual({
            handNo: 1, handSize: 12, trump: C('7', 'hearts'), dealer: 4,
            bids: ['3', '2', '2', '1'], took: [3, 3, 3, 3],
            points: [51, 33], scores: [51, 33], faults: [], set: [false, false],
        });
    });

    test('a set team: -bid x 10, its short player at fault, the other team made', () => {
        const row = scoredHand({ handSize: 10, bids: ['2', '3', '2', '2'], took: [3, 1, 2, 4], score: { team1: 51, team2: 33 } });
        // team2 bid 5, took 5: made (seat 2 short, partner covered) -> no fault
        expect(row.points).toEqual([41, 50]);
        expect(row.faults).toEqual([]);
        const set = scoredHand({ handSize: 10, bids: ['2', '3', '2', '2'], took: [3, 1, 4, 2], score: { team1: 51, team2: 33 } });
        expect(set.handNo).toBe(2);
        expect(set.points).toEqual([43, -50]);
        expect(set.scores).toEqual([94, -17]);
        expect(set.faults).toEqual([2]);
        expect(set.set).toEqual([false, true]);
    });

    test('a zero bid that takes tricks: each trick is an extra point for the team', () => {
        // seat 4 bid 0 and took 2: team2 bid 1, took 3 -> 10 + 2
        const row = scoredHand({ handSize: 6, bids: ['2', '1', '1', '0'], took: [2, 1, 1, 2] });
        expect(row.points).toEqual([30, 12]);
        expect(row.faults).toEqual([]);
        expect(row.set).toEqual([false, false]);
        // and a set team whose zero bidder took a trick: only the short player is at fault
        const set = scoredHand({ handSize: 6, bids: ['2', '1', '0', '0'], took: [1, 3, 0, 2] });
        expect(set.points).toEqual([-20, 14]);
        expect(set.faults).toEqual([1]);
        expect(set.set).toEqual([true, false]);
    });

    test('a made bore: the whole hand x 10 x 2; the bore never at fault', () => {
        const row = scoredHand({ handSize: 4, bids: ['B', '0', '0', '0'], took: [4, 0, 0, 0], score: { team1: 82, team2: 47 } });
        expect(row.points).toEqual([80, 0]);
        expect(row.scores).toEqual([162, 47]);
        expect(row.bids[0]).toBe('B');
        expect(row.faults).toEqual([]);
        expect(row.set).toEqual([false, false]);
    });

    test('a set 2B: -hand x 10 x 4, its team set, the bore player not at fault (a bore counts as 0)', () => {
        const row = scoredHand({ handSize: 5, bids: ['1', 'B', '0', '2B'], took: [1, 0, 0, 4], score: { team1: 172, team2: 57 } });
        expect(row.points).toEqual([10, -200]);
        expect(row.scores).toEqual([182, -143]);
        expect(row.set).toEqual([false, true]);
        expect(row.faults).toEqual([]);
        expect(row.bids).toEqual(['1', 'B', '0', '2B']);
    });

    test('the rainbow bonus is in the points (+10, made or set)', () => {
        const made = scoredHand({ handSize: 4, bids: ['1', '1', '1', '0'], took: [1, 1, 1, 1], rainbows: { team1: 1, team2: 0 } });
        expect(made.points).toEqual([30, 11]);
        const set = scoredHand({ handSize: 4, bids: ['2', '1', '1', '0'], took: [1, 1, 1, 1], rainbows: { team1: 0, team2: 1 } });
        expect(set.points).toEqual([-30, 21]);
    });

    test('a joker turned (no trump) is the joker card', () => {
        const row = scoredHand({ handSize: 1, bids: ['0', '0', '1', '0'], took: [0, 0, 1, 0], trump: C('HI', 'joker') });
        expect(row.trump).toEqual(C('HI', 'joker'));
        expect(row.handNo).toBe(7);
    });

    test('Get Your Bid: three seats, each its own points and total, the Forbidden Bid, no fault', () => {
        const game = { currentHand: 5, dealer: 3, trump: C('2', 'clubs'), seatCount: 3 };
        const seats = [
            { position: 1, bid: 2, took: 2, points: 12 },
            { position: 2, bid: 1, took: 0, points: 0 },
            { position: 3, bid: 1, took: 3, points: 0 },
        ];
        const row = scorecard.gybRow(game, { seats, forbidden: { position: 3, bid: 2 }, scores: [40, 21, 7] });
        expect(row).toEqual({
            handNo: 9, handSize: 5, trump: C('2', 'clubs'), dealer: 3,
            bids: ['2', '1', '1'], took: [2, 0, 3], points: [12, 0, 0], scores: [40, 21, 7],
            faults: [], forbidden: { position: 3, bid: 2 },
        });
        expect(scorecard.gybRow(game, { seats, forbidden: null, scores: [1, 2, 3] }).forbidden).toBeNull();
    });

    test('appendRow keeps one row per hand; normalizeScorecard reads back only well-formed rows', () => {
        const g = { scorecard: [] };
        const r1 = scoredHand({ handSize: 12, bids: ['3', '2', '2', '1'], took: [3, 3, 3, 3] });
        scorecard.appendRow(g, r1);
        scorecard.appendRow(g, { ...r1, points: [0, 0] });
        expect(g.scorecard).toHaveLength(1);
        expect(scorecard.normalizeScorecard([r1, null, { handNo: 'x' }, 3])).toEqual([r1]);
        expect(scorecard.normalizeScorecard(undefined)).toEqual([]);
    });
});

// ------------------------------------------------------ 2. real handlers

const TOP_TRUMP = ['HI', 'LO', 'A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4']
    .map((r) => (r === 'HI' || r === 'LO' ? C(r, 'joker') : C(r, 'spades')));
const SUIT = (suit) => ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'].map((r) => C(r, suit));

function world() {
    seq++;
    const log = [];
    const io = makeIo(log);
    let n = 0;
    return {
        log, io,
        async connect(name) {
            const username = `${name}${seq}`;
            const token = crypto.randomUUID();
            const now = new Date();
            mockDb.current.users._insert({ username, profilePic: 3, sessionTokens: [{ hash: hashToken(token), createdAt: now, lastUsedAt: now }] });
            n++;
            const s = makeSocket(`sc${seq}-${username}-${n}`, log, io);
            s.username = username;
            await authHandlers.restoreSession(s, io, { username, sessionToken: token });
            mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
    };
}

/**
 * Four human seats in BIDDING with `handSize` cards, seat 1 to bid; seat 1
 * holds the top trumps, so it takes every trick.
 */
async function setup({ handSize = 4 } = {}) {
    const w = world();
    const sockets = [];
    for (const name of ['ann', 'bob', 'cat', 'dan']) sockets.push(await w.connect(name));
    const game = gameManager.createGame(sockets.map((s) => s.id));
    sockets.forEach((s, i) => game.addPlayer(s.id, s.username, i + 1, i + 1, false));
    sockets.forEach((s) => s.join(game.roomName));
    game.entrants = null;
    deal(game, sockets, handSize);
    return { ...w, game, sockets };
}

function deal(game, sockets, handSize) {
    game.currentHand = handSize;
    game.dealer = 4;
    const dealt = [TOP_TRUMP, SUIT('hearts'), SUIT('diamonds'), SUIT('clubs')].map((h) => h.slice(0, handSize));
    sockets.forEach((s, i) => game.setHand(s.id, dealt[i].map((c) => ({ ...c }))));
    game.trump = C('3', 'spades');
    game.forcePhase('BIDDING');
    game.bidder = 1;
    game.currentTurn = 1;
    game.playerBids = [];
}

async function bidAll(t, bids) {
    for (let i = 0; i < 4; i++) await gameHandlers.playerBid(t.sockets[i], t.io, { bid: bids[i] });
}

async function playOut(t, event = 'handComplete') {
    const from = t.log.length;
    for (let guard = 0; guard < 400 && t.log.slice(from).every((l) => l.event !== event); guard++) {
        if (t.game.stage === Phase.PLAYING) {
            const sid = t.game.positions[t.game.currentTurn];
            const socket = t.sockets.find((s) => s.id === sid);
            await gameHandlers.playCard(socket, t.io, { card: legalCards(t.game, sid)[0] });
        } else {
            await jest.advanceTimersByTimeAsync(5000);
        }
    }
    return t.log.slice(from);
}

const roomEvents = (t, list, event) => list.filter((l) => l.to === t.game.roomName && l.event === event).map((l) => l.data);
const toSocket = (list, s, event) => list.filter((l) => (l.to === s.id || l.to === `self:${s.id}`) && l.event === event).map((l) => l.data);

describe('the real handlers', () => {
    test('handComplete carries the row the game appended: the score change, the fault lines, the set team', async () => {
        const t = await setup();
        await bidAll(t, ['1', '2', '1', '1']);
        const out = await playOut(t);
        const [hc] = roomEvents(t, out, 'handComplete');
        expect(t.game.scorecard).toHaveLength(1);
        expect(hc.scorecardRow).toEqual(t.game.scorecard[0]);
        const row = hc.scorecardRow;
        expect(row).toMatchObject({ handNo: 5, handSize: 4, dealer: 4, trump: C('3', 'spades'), bids: ['1', '2', '1', '1'], took: [4, 0, 0, 0] });
        expect(row.points).toEqual([hc.score.team1 - hc.team1OldScore, hc.score.team2 - hc.team2OldScore]);
        expect(row.scores).toEqual([hc.score.team1, hc.score.team2]);
        // the "Fault:" lines' positions, in their order
        const faultLines = roomEvents(t, out, 'gameLogEntry').filter((d) => d.fault).map((d) => d.fault.position);
        expect(row.faults).toEqual(faultLines);
        expect(row.faults).toEqual([2, 4]);
        expect(row.set).toEqual([false, true]);
    });

    test('a made bore and a set 2B in one hand', async () => {
        const t = await setup();
        await bidAll(t, ['B', '2B', '0', '0']);
        const out = await playOut(t);
        const [hc] = roomEvents(t, out, 'handComplete');
        expect(hc.scorecardRow).toMatchObject({ bids: ['B', '2B', '0', '0'], took: [4, 0, 0, 0], points: [80, -160], set: [false, true], faults: [] });
    });

    test('an all-zero redeal adds no row; every deal\'s gameStart counts the rows so far', async () => {
        const t = await setup();
        await bidAll(t, ['1', '0', '0', '0']);
        const from = t.log.length;
        await playOut(t);
        expect(t.game.scorecard).toHaveLength(1);
        // hand 2 dealt by the handlers: every gameStart counts the one row
        await jest.advanceTimersByTimeAsync(10000);
        const starts = t.log.slice(from).filter((l) => l.event === 'gameStart').map((l) => l.data);
        expect(starts.length).toBeGreaterThanOrEqual(4);
        for (const s of starts) expect(s.scorecardRows).toBe(1);
        expect(t.game.stage).toBe(Phase.BIDDING);

        // every seat bids 0: redeal, no row
        const before = t.log.length;
        for (let i = 0; i < 4; i++) {
            const pos = t.game.currentTurn;
            const s = t.sockets.find((x) => x.id === t.game.positions[pos]);
            await gameHandlers.playerBid(s, t.io, { bid: '0' });
        }
        await jest.advanceTimersByTimeAsync(10000);
        expect(t.log.slice(before).some((l) => l.event === 'destroyHands')).toBe(true);
        expect(t.game.scorecard).toHaveLength(1);
        const redeal = t.log.slice(before).filter((l) => l.event === 'gameStart').map((l) => l.data);
        expect(redeal.length).toBeGreaterThan(0);
        for (const s of redeal) expect(s.scorecardRows).toBe(1);
    });

    test('requestSnapshot, the codec and the record carry it; gameEnd has every row', async () => {
        const t = await setup({ handSize: 13 });
        await bidAll(t, ['2', '1', '1', '0']);
        // the 13-card hand is the last: gameEnd follows
        const out = await playOut(t, 'gameEnd');
        const [end] = roomEvents(t, out, 'gameEnd');
        expect(end.scorecard).toEqual(t.game.scorecard);
        expect(end.scorecard).toHaveLength(1);
        expect(end.scorecard[0]).toMatchObject({ handNo: 13, handSize: 13, took: [13, 0, 0, 0] });
        expect(end.scorecard[0].scores).toEqual([end.score.team1, end.score.team2]);
        expect(end.handHistory).toBeUndefined();
        const record = buildGameEndRecord(t.game);
        expect(record.scorecard).toEqual(t.game.scorecard);
    });

    test('a mid-game snapshot and a codec round trip keep the rows', async () => {
        const t = await setup();
        await bidAll(t, ['1', '1', '0', '0']);
        await playOut(t);
        await jest.advanceTimersByTimeAsync(10000);
        expect(t.game.stage).toBe(Phase.BIDDING);
        const from = t.log.length;
        await snapshotHandlers.requestSnapshot(t.sockets[1], t.io, { requestId: 'r1' });
        const [reply] = toSocket(t.log.slice(from), t.sockets[1], 'stateSnapshot');
        expect(reply.snapshot.scorecard).toEqual(t.game.scorecard);
        expect(t.game.getSnapshotV2(t.sockets[0].id).scorecard).toEqual(t.game.scorecard);

        const doc = gameCodec.serialize(t.game);
        expect(doc.state.scorecard).toEqual(t.game.scorecard);
        const back = gameCodec.hydrate(doc).game;
        expect(back.scorecard).toEqual(t.game.scorecard);
        back._cancelAllTimers();
        // a doc saved before the scorecard restores as an empty card
        delete doc.state.scorecard;
        const old = gameCodec.hydrate(doc).game;
        expect(old.scorecard).toEqual([]);
        old._cancelAllTimers();
    });
});

// --------------------------------------------------- 3. whole seeded games

const WEB_CAPS = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'getYourBid'];

function lobbyWorld() {
    seq++;
    const log = [];
    const io = makeIo(log);
    return {
        log, io,
        user(name) {
            const id = `scw${seq}-${name}`;
            const s = makeSocket(id, log, io);
            gameManager.registerUser(id, name);
            voice.rememberBlockList(s, []);
            mockDb.current.users._insert({ username: name, profilePic: 3, blockedUsers: [] });
            clientInfo.handle(s, io, { client: 'web', version: '1', caps: WEB_CAPS });
            mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
    };
}

/**
 * One human (bids its first legal bid, or a seeded random one, and plays
 * its first legal card) and bots, a whole game: the human's gameStart /
 * handComplete / gameEnd as it received them.
 */
async function wholeGame(seed, { mode = null } = {}) {
    const rand = mulberry32(seed);
    jest.spyOn(Math, 'random').mockImplementation(rand);
    const w = lobbyWorld();
    const me = w.user(`sc${seq}_me`);
    mainRoomHandlers.createLobby(me, w.io, { name: 'Card', ...(mode && { mode }) });
    for (let i = 1; i < (mode ? 3 : 4); i++) await lobbyHandlers.addBot(me, w.io);
    lobbyHandlers.playerReady(me, w.io);
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    const game = gameManager.getPlayerGame(me.id);
    await jest.advanceTimersByTimeAsync(pacing(game).PREDRAW_COUNTDOWN_MS);
    const drew = gameHandlers.draw(me, w.io, { num: 0 });
    for (let i = 0; i < 20000 && !game.isTerminal(); i++) {
        const pos = game.seatByOwnerSocket(me.id);
        if (game.stage === Phase.BIDDING && game.currentTurn === pos && game.playerBids[pos - 1] == null) {
            const legal = [];
            for (const b of rules.BID_VALUES) if (game.isBidLegal(String(b))) legal.push(String(b));
            await gameHandlers.playerBid(me, w.io, { bid: legal[Math.floor(rand() * Math.min(legal.length, 4))] });
        } else if (game.stage === Phase.PLAYING && game.currentTurn === pos && !game.playedCards[pos - 1]) {
            await gameHandlers.playCard(me, w.io, { card: game.firstLegalCard(pos) });
        } else {
            await jest.advanceTimersByTimeAsync(250);
        }
    }
    await drew;
    expect(game.stage).toBe(Phase.ENDED);
    const mine = (event) => w.log.filter((l) => (l.to === me.id || l.to === `self:${me.id}` || l.to === game.roomName) && l.event === event).map((l) => l.data);
    return { game, hcs: mine('handComplete'), starts: mine('gameStart'), end: mine('gameEnd')[0], faults: w.log.filter((l) => l.to === game.roomName && (l.event === 'handComplete' || (l.event === 'gameLogEntry' && l.data.fault))) };
}

describe('whole seeded games: the running totals are the final scores', () => {
    test.each(Array.from({ length: 40 }, (_, i) => 100 + i))('base game, seed %i', async (seed) => {
        const { game, hcs, starts, end, faults } = await wholeGame(seed);
        const rows = end.scorecard;
        expect(rows).toEqual(game.scorecard);
        expect(rows.map((r) => r.handSize)).toEqual([...rules.HAND_PROGRESSION]);
        expect(rows.map((r) => r.handNo)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
        expect(hcs).toHaveLength(13);
        const total = [0, 0];
        rows.forEach((r, i) => {
            const hc = hcs[i];
            expect(hc.scorecardRow).toEqual(r);
            // (the stub io logs payloads by reference: hc.score is the live
            // score, so the change is read from the old scores)
            expect(r.points).toEqual([r.scores[0] - hc.team1OldScore, r.scores[1] - hc.team2OldScore]);
            if (i + 1 < hcs.length) expect(r.scores).toEqual([hcs[i + 1].team1OldScore, hcs[i + 1].team2OldScore]);
            total[0] += r.points[0];
            total[1] += r.points[1];
            expect(r.scores).toEqual(total);
            // the bids that hand: what the server recorded, in seat order
            expect(r.bids).toHaveLength(4);
            expect(r.took.reduce((a, b) => a + b, 0)).toBe(r.handSize);
        });
        expect(total).toEqual([end.score.team1, end.score.team2]);
        // the faults: exactly the fault lines after each handComplete
        let hand = -1;
        const byHand = [];
        for (const l of faults) {
            if (l.event === 'handComplete') byHand[++hand] = [];
            else byHand[hand].push(l.data.fault.position);
        }
        rows.forEach((r, i) => expect(r.faults).toEqual(byHand[i]));
        // every deal's gameStart counted the hands before it
        for (const s of starts) expect(s.scorecardRows).toBe(rules.HAND_PROGRESSION.indexOf(s.currentHand));
    }, 120000);

    test.each(Array.from({ length: 20 }, (_, i) => 200 + i))('Get Your Bid, seed %i', async (seed) => {
        const { game, hcs, end } = await wholeGame(seed, { mode: 'gyb' });
        const rows = end.scorecard;
        expect(rows).toEqual(game.scorecard);
        expect(rows).toHaveLength(13);
        const total = [0, 0, 0];
        rows.forEach((r, i) => {
            const hc = hcs[i];
            expect(hc.scorecardRow).toEqual(r);
            expect(r.points).toEqual(hc.gyb.seats.map((s) => s.points));
            expect(r.points).toEqual(hc.gyb.scores.map((s, k) => s - hc.gyb.oldScores[k]));
            expect(r.bids).toEqual(hc.gyb.seats.map((s) => String(s.bid)));
            expect(r.took).toEqual(hc.gyb.seats.map((s) => s.took));
            expect(r.forbidden).toEqual(hc.gyb.forbidden);
            expect(r.faults).toEqual([]);
            expect(r.set).toBeUndefined();
            for (let k = 0; k < 3; k++) total[k] += r.points[k];
            expect(r.scores).toEqual(total);
        });
        expect(total).toEqual(end.gyb.scores);
    }, 120000);
});
