/**
 * Account deletion and live chat (deploy survival PR 4, the plan's 2.8):
 * with LIVE_PERSIST write, accountDelete.forgetAccount drops the deleted
 * account's chat from every live game (lines whose internal `from` is the
 * name: as a player or a spectator) and every tournament (messages by
 * username, players' and spectators'), and the saved docs are rewritten
 * without them (the whole log, not a $push). System, bid and score lines
 * stay, and so do other people's and the bots' lines. With LIVE_PERSIST
 * off nothing in memory changes (today's behaviour).
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const { makeIo, makeSocket, mulberry32 } = require('../../../testUtils/gameDriver');
const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const liveStore = require('../liveStore');
const chatHandlers = require('../../../socket/chatHandlers');
const mainRoomHandlers = require('../../../socket/mainRoomHandlers');
const tournamentHandlers = require('../../../socket/tournamentHandlers');
const { forgetAccount } = require('../../../admin/accountDelete');
const { setupTournament, newUser } = require('../../../testUtils/tournamentDriver');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');

let realRandom;
let io;
let log;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(3);
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    log = [];
    io = makeIo(log);
});

afterEach(() => {
    liveStore._resetForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const db = () => mockDb.current;
const chatOf = (entries) => entries.filter((e) => e.type === 'chat').map((e) => [e.from, e.message]);

/** Hal and Ann seated with 2 bots, Sue spectating; each says something, a bot quips. */
async function chattyGame() {
    const ctx = await kit.startGame(io, log, { humans: ['Hal', 'Ann'] });
    const { game, sockets: [hal, ann] } = ctx;
    gameManager.registerUser('s-sue', 'Sue');
    db().users._insert({ username: 'Sue', profilePic: 4 });
    const sue = makeSocket('s-sue', log, io);
    mainRoomHandlers.joinAsSpectator(sue, io, { gameId: game.gameId });
    await chatHandlers.chatMessage(hal, io, { message: 'hal one' });
    await chatHandlers.chatMessage(ann, io, { message: 'ann one' });
    await chatHandlers.chatMessage(sue, io, { message: 'sue watching' });
    await chatHandlers.chatMessage(hal, io, { message: 'hal two' });
    const bot = botController.getGameBots(game.gameId)[0];
    game.addLogEntry('beep', bot.position, 'chat', { from: bot.username });
    game.addLogEntry('Something happened', null, 'system');
    return { ...ctx, hal, ann, sue, bot };
}

test('a deleted player: their chat leaves the game and the saved doc (whole log rewritten); everyone else\'s stays', async () => {
    const store = kit.installStore(mockDb);
    const { game, bot } = await chattyGame();
    await h.flushStore(store);
    const before = chatOf(kit.savedGame(db(), game.gameId).log);
    expect(before).toEqual([['Hal', 'Hal: hal one'], ['Ann', 'Ann: ann one'], ['Sue', 'Sue: sue watching'], ['Hal', 'Hal: hal two'], [bot.username, 'beep']]);
    const systemLines = game.gameLog.filter((e) => e.type !== 'chat').length;
    const updates = jest.spyOn(db().liveGames, 'updateOne');

    await forgetAccount(io, db(), 'Hal');
    await h.flushStore(store);

    const want = [['Ann', 'Ann: ann one'], ['Sue', 'Sue: sue watching'], [bot.username, 'beep']];
    expect(chatOf(game.gameLog)).toEqual(want);
    expect(game.gameLog.filter((e) => e.type !== 'chat')).toHaveLength(systemLines);
    const saved = kit.savedGame(db(), game.gameId);
    expect(chatOf(saved.log)).toEqual(want);
    expect(saved.log).toEqual(kit.plain(game.gameLog));
    expect(JSON.stringify(saved)).not.toContain('hal one');
    const [, update] = updates.mock.calls.at(-1);
    expect(update.$push).toBeUndefined();
    expect(update.$set.log).toBeDefined();
});

test('a deleted spectator: their chat goes too', async () => {
    const store = kit.installStore(mockDb);
    const { game } = await chattyGame();
    await h.flushStore(store);
    await forgetAccount(io, db(), 'Sue');
    await h.flushStore(store);
    expect(chatOf(game.gameLog).map(([from]) => from)).not.toContain('Sue');
    expect(JSON.stringify(kit.savedGame(db(), game.gameId))).not.toContain('sue watching');
    expect(chatOf(game.gameLog).filter(([from]) => from === 'Hal')).toHaveLength(2);
});

test('tournament chat: a deleted member\'s and a deleted spectator\'s messages leave the tournament and its doc', async () => {
    const store = kit.installStore(mockDb);
    const ctx = await setupTournament(3, { io, log });
    const [a, b] = ctx.usernames;
    const watcher = newUser(io, log, 'Wes');
    tournamentHandlers.spectateTournament(watcher, io, { tournamentId: ctx.t.tournamentId });
    tournamentHandlers.tournamentChat(ctx.sockets[0], io, { message: 'from a' });
    tournamentHandlers.tournamentChat(ctx.sockets[1], io, { message: 'from b' });
    tournamentHandlers.tournamentChat(watcher, io, { message: 'from wes' });
    await h.flushStore(store);
    const saved = () => kit.savedTournament(db(), ctx.t.tournamentId).state.messages.map((m) => [m.username, m.message, m.isSpectator]);
    expect(saved()).toEqual([[a, 'from a', false], [b, 'from b', false], ['Wes', 'from wes', true]]);

    await forgetAccount(io, db(), a);
    await forgetAccount(io, db(), 'Wes');
    await h.flushStore(store);
    expect(ctx.t.messages.map((m) => m.username)).toEqual([b]);
    expect(saved()).toEqual([[b, 'from b', false]]);
});

test('LIVE_PERSIST off: forgetAccount leaves live chat in memory as today', async () => {
    kit.installStore(mockDb, { mode: 'off' });
    const { game } = await chattyGame();
    const before = kit.plain(game.gameLog);
    await forgetAccount(io, db(), 'Hal');
    expect(kit.plain(game.gameLog)).toEqual(before);
});
