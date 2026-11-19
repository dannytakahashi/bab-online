/**
 * restoreGame.adoptGame (deploy survival PR 5): the production form of
 * restoreKit.adoptForTest. A game doc becomes a live game in this process:
 * registered (games, tournamentGames), its bots back under their saved
 * socket ids with the card memory a bot that watched the hand live has,
 * mapped in playerGames, the owners' custom pictures warmed, exactly one
 * "This game resumed after a server update." line (stored and broadcast),
 * the gate closed and the restored abandon armed. The adopter's users
 * lookup (liveStore) names the senders to scrub; a bot persona ('🤖 …',
 * safetyHandlers.isBotName) is never looked up and never scrubbed, so an
 * adopted game keeps its bot quips. It never touches Mongo.
 */

// Integration test (real Socket.IO / two instances / chaos): CI's slower runners take
// 3-5 s on cases that run in about 2 s on a laptop, so the 5 s default is too tight.
jest.setTimeout(30000);
const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const gameManager = require('../../GameManager');
const GameState = require('../../GameState');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const avatarStore = require('../../../avatar/avatarStore');
const { makeIo } = require('../../../testUtils/gameDriver');
const { playUntil, freshProcess } = require('../../../testUtils/restoredTables');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');
const restoreGame = require('../restoreGame');
const { CodecError } = require('../gameCodec');

let errorLogs;
let realRandom;

beforeAll(() => {
    process.env.BAB_FSM_CHECK = '1';
    realRandom = Math.random;
});

afterAll(() => {
    delete process.env.BAB_FSM_CHECK;
    Math.random = realRandom;
});

beforeEach(() => {
    jest.useFakeTimers();
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        for (const m of ['warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
    expect(errorLogs).toEqual([]);
});

const json = (v) => JSON.parse(JSON.stringify(v));

/** A log line exactly as GameState.addLogEntry writes it. */
function line(message, position, type, from) {
    const g = new GameState('line-maker');
    g.addLogEntry(message, position, type, from === undefined ? {} : { from });
    return json(g.gameLog[0]);
}

describe('bots and card memory', () => {
    const points = {
        'mid-trick (2 cards down, tricks already won)': (g) => g.stage === Phase.PLAYING && g.dealSeq >= 2 && g.playedCardsIndex === 2 && g.trickHistory.length >= 2,
        'TRICK_RESOLVING': (g) => g.stage === Phase.TRICK_RESOLVING && g.dealSeq >= 2 && g.trickHistory.length >= 1,
        'the opening lead of a deal': (g) => g.stage === Phase.PLAYING && g.dealSeq >= 3 && g.cardIndex === 0,
    };
    for (const [name, until] of Object.entries(points)) {
        test(`${name}: persisted ids, mapped, card memory equal to a bot that watched the hand`, async () => {
            const fixture = await playUntil({ mockDb, seed: 41, until });
            freshProcess(mockDb, fixture.users, { gameId: fixture.gameId });
            const log = [];
            const game = restoreGame.adoptGame(makeIo(log), fixture.doc);
            expect(gameManager.getGameById(game.gameId)).toBe(game);
            expect(fixture.doc.bots).toHaveLength(3);
            for (const b of fixture.doc.bots) {
                const bot = botController.getBot(game.gameId, b.socketId);
                expect(bot).toBeTruthy();
                expect(bot.position).toBe(b.position);
                expect(bot.personality).toBe(b.personality);
                expect(bot.partnerHistory).toEqual(b.partnerHistory);
                expect(gameManager.playerGames.get(b.socketId)).toBe(game.gameId);
                expect(json(bot.cardMemory)).toEqual(fixture.memory[b.position]);
            }
            // One "resumed" line, stored and broadcast once
            expect(game.gameLog.filter((e) => e.message === restoreGame.RESUMED_LINE)).toHaveLength(1);
            expect(game.gameLog[game.gameLog.length - 1]).toMatchObject({ message: restoreGame.RESUMED_LINE, type: 'system' });
            expect(log.filter((e) => e.event === 'gameLogEntry').map((e) => e.data.message)).toEqual([restoreGame.RESUMED_LINE]);
            // Gated, the restored abandon armed, nothing else but the graces
            expect(restoreGame.isGated(game)).toBe(true);
            expect(game.timerKeys().sort()).toEqual(['grace:' + game.seatByUsername(fixture.users[0].username), restoreGame.ABANDON_KEY].sort());
            expect([...botController.pendingActions.keys()].filter((k) => k.startsWith(`${game.gameId}:`))).toEqual([]);
        });
    }
});

describe('chat on adoption', () => {
    test("bot quips stay: a 'from' that isBotName is never looked up or scrubbed", async () => {
        const fixture = await playUntil({ mockDb, seed: 42, until: (g) => g.stage === Phase.PLAYING && g.dealSeq >= 2 });
        const human = fixture.users[0].username;
        const botName = fixture.doc.bots[0].username;
        expect(botName.startsWith('🤖 ')).toBe(true);
        const doc = json(fixture.doc);
        doc.log.push(
            line(`${botName}: nice one`, fixture.doc.bots[0].position, 'chat', botName),
            line(`${human}: thanks`, 1, 'chat', human),
            line('Spectator: hi', null, 'chat', 'Spectator'),
            line('gone_user: bye', null, 'chat', 'gone_user'),
        );
        doc.logTotal += 4;
        // What the adopter looks up in users: owners and senders, never a bot
        const names = restoreGame.lookupNames(doc);
        expect(names).toEqual(expect.arrayContaining([human, 'Spectator', 'gone_user']));
        expect(names.some((n) => n.startsWith('🤖 '))).toBe(false);
        expect(new Set(names).size).toBe(names.length);

        freshProcess(mockDb, fixture.users, { gameId: fixture.gameId });
        // A lookup that found nobody for the bot persona must not delete its lines
        const game = restoreGame.adoptGame(makeIo([]), doc, { scrubFrom: ['gone_user', botName] });
        const chat = game.gameLog.filter((e) => e.type === 'chat').map((e) => e.from);
        expect(chat).toEqual([botName, human, 'Spectator']);
    });
});

describe('pictures', () => {
    test("an owner's custom picture (not in the doc) comes from the adopter's lookup and is warmed", async () => {
        const fixture = await playUntil({ mockDb, seed: 43, until: (g) => g.stage === Phase.BIDDING && g.dealSeq >= 2 });
        const human = fixture.users[0].username;
        const doc = json(fixture.doc);
        const pos = Object.keys(doc.state.seats).find((p) => doc.state.seats[p].ownerUsername === human);
        doc.state.seats[pos].ownerPic = null; // a custom picture is never saved
        const pic = 'data:image/png;base64,iVBORw0KGgo=';
        freshProcess(mockDb, fixture.users, { gameId: fixture.gameId });
        const game = restoreGame.adoptGame(makeIo([]), doc, { ownerPics: { [human]: pic, nobody: 7 } });
        expect(game.seat(Number(pos)).ownerPic).toBe(pic);
        expect(game.avatarVersions).toBeInstanceOf(Map);
        if (avatarStore.available()) expect(game.avatarVersions.get(human)).toBe(avatarStore.versionOf(pic));
        // A saved stock picture is kept
        const fixture2 = await playUntil({ mockDb, seed: 44, until: (g) => g.stage === Phase.BIDDING && g.dealSeq >= 2 });
        freshProcess(mockDb, fixture2.users, { gameId: fixture2.gameId });
        const saved = Object.values(fixture2.doc.state.seats).find((s) => s.ownerUsername === fixture2.users[0].username).ownerPic;
        const game2 = restoreGame.adoptGame(makeIo([]), fixture2.doc, { ownerPics: { [fixture2.users[0].username]: pic } });
        expect(game2.seat(game2.seatByUsername(fixture2.users[0].username)).ownerPic).toBe(saved);
    });
});

describe('refusals register nothing', () => {
    test('a game already live here, and a doc that does not restore', async () => {
        const fixture = await playUntil({ mockDb, seed: 45, until: (g) => g.stage === Phase.PLAYING && g.dealSeq >= 2 });
        freshProcess(mockDb, fixture.users, { gameId: fixture.gameId });
        const io = makeIo([]);
        const game = restoreGame.adoptGame(io, fixture.doc);
        const timers = game.timerKeys().sort();
        expect(() => restoreGame.adoptGame(io, fixture.doc)).toThrow(/already live/);
        expect(gameManager.getGameById(game.gameId)).toBe(game);
        expect(game.timerKeys().sort()).toEqual(timers);

        freshProcess(mockDb, fixture.users, { gameId: fixture.gameId });
        const bad = { ...json(fixture.doc), v: 99 };
        expect(() => restoreGame.adoptGame(io, bad)).toThrow(CodecError);
        expect(gameManager.games.size).toBe(0);
        expect(botController.gamesBots.size).toBe(0);
        expect(gameManager.playerGames.size).toBe(0);
        await jest.advanceTimersByTimeAsync(restoreGame.RESTORE_ABANDON_MS + 1000);
    });
});
