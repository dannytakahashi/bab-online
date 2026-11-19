/**
 * /help across a kill and restore (plan H2b row, "once H2c lands"; section
 * 10 item 6): a real 4-human game where one player has used /help 3 times,
 * the 3rd on the turn that is open when the process dies. The game is
 * saved, twice over: by gameCodec.serialize, and through the live store's
 * write path (a LIVE_PERSIST=write store over a liveDb: the liveGames doc
 * it wrote, the doc a restore reads). Then the process's module state goes (the advice
 * cache, the budget, the rate limits: assistHandlers._resetForTests,
 * GameManager / bots reset) and the doc is adopted in its place
 * (restoreKit.adoptForTest); the players rejoin on new sockets.
 *
 *  - a re-ask on the restored turn is answered but NOT counted (the saved
 *    lastHelpKey still matches the restored game's turnKey)
 *  - the next own turn's ask is the 4th use: it crosses, and the room line
 *    "<name> used /help. This game now counts as bot-assisted for <name>."
 *    appears exactly once, also in the restored game's log
 *  - the record built at the end routes that seat to botStats
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../../../testUtils/persistHarness');
const kit = require('../../../testUtils/liveStoreKit');
const liveStore = require('../liveStore');

const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const pacing = require('../../pacing');
const codec = require('../gameCodec');
const gameHandlers = require('../../../socket/gameHandlers');
const chatHandlers = require('../../../socket/chatHandlers');
const lobbyHandlers = require('../../../socket/lobbyHandlers');
const mainRoomHandlers = require('../../../socket/mainRoomHandlers');
const reconnectHandlers = require('../../../socket/reconnectHandlers');
const assistHandlers = require('../../../socket/assistHandlers');
const profile = require('../../../socket/profileHandlers');
const rateLimiter = require('../../../socket/rateLimiter');
const { world } = require('../../../testUtils/contractScenarios');
const { adoptForTest, kickRestored } = require('../../../testUtils/restoreKit');
const { advanceUntil } = require('../../../testUtils/tournamentDriver');
const { legalCards, legalBids, mulberry32 } = require('../../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../../utils/logger');

const realRandom = Math.random;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    assistHandlers._resetForTests();
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    liveStore._resetForTests();
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});
afterAll(() => rateLimiter.shutdown());

test.each(['serialize', 'store'])('kill and restore after 3 uses (%s): a re-ask on the restored turn is free, the 4th crosses and says so once', async (path) => {
    const store = path === 'store' ? kit.installStore(mockDb) : null;
    Math.random = mulberry32(17);
    const w = world('ar');
    const names = ['ar_ann', 'ar_bob', 'ar_cat', 'ar_dan'];
    const socks = names.map((n, i) => w.user(`ar-h${i}`, n));
    mainRoomHandlers.createLobby(socks[0], w.io, { name: 'restore table' });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    const pending = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    let game = gameManager.getPlayerGame(socks[0].id);
    await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
    pending.push(...socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 })));
    await advanceUntil(() => game.stage === Phase.BIDDING && !game.resume, 100);
    await Promise.all(pending);

    const asker = game.currentTurn;
    const askerName = game.seat(asker).ownerUsername;
    const owner = (pos) => w.sockets.get(game.seat(pos).ownerSocketId);
    const ask = () => {
        rateLimiter.clearSocket(owner(asker).id);
        chatHandlers.chatMessage(owner(asker), w.io, { message: '?help' });
    };
    /** One move by the seat on turn, then wait for the next open turn. */
    const move = async () => {
        const s = owner(game.currentTurn);
        if (game.stage === Phase.BIDDING) {
            const bids = legalBids(game);
            await gameHandlers.playerBid(s, w.io, { bid: bids.includes('1') ? '1' : bids.find((b) => /^\d+$/.test(b)) });
        } else {
            await gameHandlers.playCard(s, w.io, { card: legalCards(game, s.id)[0] });
        }
        await advanceUntil(() => game.acceptsTurnInput() && !game.resume, 100);
    };
    // 3 counted uses; the 3rd on the turn still open when the process dies
    while (game.assist[asker].help < 3) {
        if (game.currentTurn === asker) ask();
        if (game.assist[asker].help < 3) await move();
    }
    expect(game.currentTurn).toBe(asker);
    const killedKey = game.turnKey();
    expect(game.assist[asker]).toMatchObject({ user: askerName, help: 3, lastHelpKey: killedKey });

    // ---- the process dies; its saved doc is adopted by a fresh one
    const gameId = game.gameId;
    let doc = JSON.parse(JSON.stringify(codec.serialize(game, { tournamentId: null, getBot: () => null })));
    if (store) {
        // what the store wrote is what a restore reads: the counters went through it
        await h.flushStore(store);
        const stored = kit.savedGame(mockDb.current, gameId);
        expect(kit.comparable(stored)).toEqual(kit.comparable(doc));
        doc = { ...JSON.parse(JSON.stringify(stored)), gameId };
        liveStore._resetForTests(); // the process (and its store) dies
    }
    expect(doc.state.assist[asker]).toMatchObject({ help: 3, lastHelpKey: killedKey });
    gameManager.abortGame(gameId);
    gameManager._resetForTests();
    botController._resetForTests();
    assistHandlers._resetForTests();
    for (const s of socks) rateLimiter.clearSocket(s.id);
    mockDb.current.gameRecords.docs.length = 0;
    const mark = w.log.length;

    game = adoptForTest(doc, { io: w.io });
    const back = [];
    for (let i = 0; i < 4; i++) {
        const s = w.user(`ar-back${i}`, names[i]);
        await reconnectHandlers.rejoinGame(s, w.io, { gameId, username: names[i] });
        back.push(s);
    }
    kickRestored(w.io, game);
    expect(game.turnKey()).toBe(killedKey);
    expect(game.seat(asker).ownerSocketId).toBe(back[names.indexOf(askerName)].id);

    // a re-ask on the restored turn: the answer, not counted, no notice
    ask();
    const notices = () => w.log.slice(mark).filter((l) => l.event === 'gameLogEntry' && l.to === game.roomName && /used \/help/.test(l.data.message)).map((l) => l.data.message);
    const mine = () => w.log.slice(mark).filter((l) => l.event === 'gameLogEntry' && l.to === owner(asker).id).map((l) => l.data.message);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatch(/\(Help 3 of 3 free\)$/);
    expect(game.assist[asker].help).toBe(3);
    expect(notices()).toEqual([]);

    // the next own turn: the 4th use crosses
    await move();
    while (game.currentTurn !== asker || !game.acceptsTurnInput()) await move();
    ask();
    expect(game.assist[asker].help).toBe(4);
    expect(mine().at(-1)).toMatch(/\(Help 4: this game counts as bot-assisted for you\)$/);
    const crossed = `${askerName} used /help. This game now counts as bot-assisted for ${askerName}.`;
    expect(notices()).toEqual([crossed]);
    expect(game.gameLog.filter((e) => e.message === crossed)).toHaveLength(1);
    // asking again on that turn changes nothing
    ask();
    expect(notices()).toEqual([crossed]);

    // the record the end would write routes the asker's seat to botStats
    const record = profile.buildGameEndRecord(game);
    expect(record.statsDeltas.bucketByPosition).toEqual({ [asker]: 'botStats' });
    expect(record.statsDeltas.assist).toEqual({ [asker]: { help: 4 } });
}, 60000);
