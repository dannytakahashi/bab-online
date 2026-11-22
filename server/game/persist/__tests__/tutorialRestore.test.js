/**
 * The tutorial across a kill and restore (the LEAN tutorial, 2026-11-19): a
 * real 4-human game where one player turned the tutorial on and got its
 * welcome tip, a rule tip and the advice on the turn that is open when the
 * process dies. The game is saved (gameCodec.serialize, and through the
 * live store's write path), the module state goes (the advice cache, the
 * tutor's windows: assistHandlers._resetForTests), the doc is adopted and
 * the players rejoin on new sockets.
 *
 *  - the saved seat keys came back (tutorial, auto, tutorialEver, tips)
 *  - the rejoin on the restored turn re-pushes this turn's advice (source
 *    tutorial, the same turnKey) and assistState; no tip is repeated
 *  - the next own turn gets its advice; the snapshot's viewer.assist says
 *    the tutorial is on; the record marks the seat
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
const clientInfo = require('../../../socket/clientInfo');
const snapshotHandlers = require('../../../socket/snapshotHandlers');
const curriculum = require('../../assist/curriculum');

jest.setTimeout(30000);

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


const CAPS = { client: 'web', version: '1.0.0', caps: ['assist', 'tutorial'] };
const flush = () => jest.advanceTimersByTimeAsync(1);

test.each(['serialize', 'store'])('kill and restore with the tutorial on (%s): the keys come back, the rejoin re-pushes the advice, no tip repeats', async (path) => {
    const store = path === 'store' ? kit.installStore(mockDb) : null;
    Math.random = mulberry32(23);
    const w = world('tr2');
    const names = ['tr2_ann', 'tr2_bob', 'tr2_cat', 'tr2_dan'];
    const socks = names.map((n, i) => w.user(`tr2-h${i}`, n));
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

    const me = game.currentTurn;
    const myName = game.seat(me).ownerUsername;
    const owner = (pos) => w.sockets.get(game.seat(pos).ownerSocketId);
    clientInfo.handle(owner(me), w.io, CAPS);
    chatHandlers.chatMessage(owner(me), w.io, { message: '/tutorial on' });
    const tutorialHints = (sid, from = 0) => w.log.slice(from).filter((l) => l.event === 'assistHint' && l.to === sid && l.data.source === 'tutorial').map((l) => l.data);
    const killedKey = game.turnKey();
    const before = tutorialHints(owner(me).id);
    expect(before.map((x) => x.kind)).toEqual(['tip', 'tip', 'bid']);
    const saved = { ...game.assist[me] };
    expect(saved).toMatchObject({ user: myName, tutorial: true, auto: false, tutorialEver: true });
    expect(curriculum.has(saved.tips, 'T.welcome')).toBe(true);

    // ---- the process dies; its saved doc is adopted by a fresh one
    const gameId = game.gameId;
    let doc = JSON.parse(JSON.stringify(codec.serialize(game, { tournamentId: null, getBot: () => null })));
    if (store) {
        await h.flushStore(store);
        const stored = kit.savedGame(mockDb.current, gameId);
        expect(kit.comparable(stored)).toEqual(kit.comparable(doc));
        doc = { ...JSON.parse(JSON.stringify(stored)), gameId };
        liveStore._resetForTests();
    }
    expect(doc.state.assist[me]).toEqual(saved);
    gameManager.abortGame(gameId);
    gameManager._resetForTests();
    botController._resetForTests();
    assistHandlers._resetForTests();
    for (const s of socks) rateLimiter.clearSocket(s.id);
    mockDb.current.gameRecords.docs.length = 0;
    const mark = w.log.length;

    game = adoptForTest(doc, { io: w.io });
    expect(game.assist[me]).toEqual(saved);
    const back = [];
    for (let i = 0; i < 4; i++) {
        const s = w.user(`tr2-back${i}`, names[i]);
        if (names[i] === myName) clientInfo.handle(s, w.io, CAPS);
        await reconnectHandlers.rejoinGame(s, w.io, { gameId, username: names[i] });
        back.push(s);
    }
    kickRestored(w.io, game);
    await flush();
    expect(game.turnKey()).toBe(killedKey);
    const mine = back[names.indexOf(myName)];
    // the rejoin re-pushed this turn's advice, once; no tip again
    const after = tutorialHints(mine.id, mark);
    expect(after.map((x) => [x.kind, x.turnKey])).toEqual([['bid', killedKey]]);
    expect(after[0]).toMatchObject({ headline: before[2].headline, counted: false });
    expect(w.log.slice(mark).filter((l) => l.event === 'assistState' && l.to === mine.id).at(-1).data).toMatchObject({ tutorial: true, auto: false, assisted: true });
    expect(game.assist[me].tips).toBe(saved.tips);
    // the snapshot says it is on
    const m2 = w.log.length;
    snapshotHandlers.requestSnapshot(mine, w.io, {});
    expect(w.log.slice(m2).find((l) => l.event === 'stateSnapshot').data.snapshot.viewer.assist).toMatchObject({ tutorial: true });

    // the next own turn gets its advice
    const move = async () => {
        const s = owner(game.currentTurn);
        if (game.stage === Phase.BIDDING) {
            const bids = legalBids(game);
            await gameHandlers.playerBid(s, w.io, { bid: bids.includes('1') ? '1' : bids.find((b) => /^\d+$/.test(b)) });
        } else {
            await gameHandlers.playCard(s, w.io, { card: legalCards(game, s.id)[0] });
        }
        await flush();
        await advanceUntil(() => game.acceptsTurnInput() && !game.resume, 100);
        await flush();
    };
    await move();
    while (game.currentTurn !== me || !game.acceptsTurnInput()) await move();
    await flush();
    const next = tutorialHints(mine.id, mark).filter((x) => x.kind !== 'tip' && x.turnKey === game.turnKey());
    expect(next.length + (legalCards(game, mine.id).length === 1 ? 1 : 0)).toBe(1);
    // never counted; the record marks the seat (and moves it in a game its
    // team won: only a win moves it, owner 2026-11-21)
    expect(game.assist[me].help).toBe(0);
    game.score = me % 2 === 1 ? { team1: 300, team2: 100 } : { team1: 100, team2: 300 };
    const record = profile.buildGameEndRecord(game);
    expect(record.statsDeltas.assist).toEqual({ [me]: { help: 0, tutorial: true } });
    expect(record.statsDeltas.bucketByPosition).toEqual({ [me]: 'botStats' });
}, 60000);
