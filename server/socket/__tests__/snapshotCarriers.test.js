/**
 * V1_REMOVALS #9: the snapshot carriers (rejoinSuccess, restorePlayerState,
 * the spectator full state) send the v2 snapshot plus only the v1 keys a
 * client still reads (snapshotHandlers.carrierFor):
 *   - players[] {position, username, pic}: iOS 1.2.0 reads pic, web lets
 *     it win for names (its socketId went with V1_REMOVALS #14; since #19
 *     A pic is a stock number or null);
 *   - gameId, isLazy (rejoinSuccess), trump (spectator): a pre-#233 web
 *     page routes on them;
 *   - tournamentId (rejoinSuccess), avatarUrls (capable, with a URL).
 * Every emit path, exact key sets, and the values that replaced the legacy
 * ones are in the snapshot. Real handlers, stub io (contract-checked).
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const chatHandlers = require('../chatHandlers');
const gameHandlers = require('../gameHandlers');
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
const CUSTOM = 'data:image/webp;base64,AAAA';
let n = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn', 'error']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager.spectatorGames.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/** Seated 4-human game in BIDDING; seat 2 has a custom picture. */
function table() {
    n++;
    const log = [];
    const io = makeIo(log);
    const sids = {};
    const sockets = {};
    const names = {};
    for (let pos = 1; pos <= 4; pos++) {
        sids[pos] = `sc${n}-p${pos}`;
        names[pos] = `sc${n}u${pos}`;
        gameManager.registerUser(sids[pos], names[pos]);
    }
    const game = gameManager.createGame([1, 2, 3, 4].map((p) => sids[p]));
    for (let pos = 1; pos <= 4; pos++) {
        game.addPlayer(sids[pos], names[pos], pos, pos === 2 ? CUSTOM : pos, false);
        sockets[pos] = makeSocket(sids[pos], log, io);
        sockets[pos].join(game.roomName);
    }
    for (let pos = 1; pos <= 4; pos++) game.setHand(game.positions[pos], [C(String(pos + 2), 'hearts'), C(String(pos + 6), 'clubs')]);
    game.currentHand = 2;
    game.trump = C('A', 'spades');
    game.forcePhase(Phase.BIDDING);
    game.bidder = 3;
    game.currentTurn = 3;
    return { log, io, game, sids, sockets, names };
}

async function drop(t, socket) {
    t.io.sockets.sockets.delete(socket.id);
    for (const members of t.io.rooms.values()) members.delete(socket.id);
    await queueHandlers.handleDisconnect(socket, t.io);
}

function newSocket(t, username) {
    n++;
    const s = makeSocket(`sc-s${n}`, t.log, t.io);
    gameManager.registerUser(s.id, username);
    return s;
}

const mine = (t, s, event) => t.log.filter((l) => l.to === `self:${s.id}` && l.event === event).map((l) => l.data);
const keys = (d) => Object.keys(d).sort();

/**
 * players[] as every carrier sends it: the seat display identity, no socket
 * id (#14), and no inline picture (#19 A: a custom picture's slot is null,
 * its URL in avatarUrls once a rendition exists; the pipeline is off here).
 */
function expectPlayers(t, data) {
    expect(data.players).toEqual([1, 2, 3, 4].map((pos) => {
        const p = t.game.getPlayerByPosition(pos);
        return { position: pos, username: p.username, pic: typeof p.pic === 'number' ? p.pic : null };
    }));
    expect(data.players.find((p) => p.position === 2).pic).toBeNull();
    expect(JSON.stringify(data)).not.toContain(CUSTOM);
    // the snapshot carries no inline picture either (#19 C)
    const seat2 = data.snapshot.seats.find((s) => s.position === 2);
    expect(seat2).toMatchObject({ hasCustomPic: true, customPic: null });
    expect(data.snapshot.partial || []).not.toContain('customPics');
}

test('rejoinSuccess (reconnectOwner): gameId, players, isLazy, tournamentId, snapshot', async () => {
    const t = table();
    await drop(t, t.sockets[1]);
    const s = newSocket(t, t.names[1]);
    await reconnectHandlers.rejoinGame(s, t.io, { gameId: t.game.gameId, username: t.names[1] });
    const [ok] = mine(t, s, 'rejoinSuccess');
    expect(keys(ok)).toEqual(['gameId', 'isLazy', 'players', 'snapshot', 'tournamentId']);
    expect(ok).toMatchObject({ gameId: t.game.gameId, isLazy: false, tournamentId: null });
    expect(ok.snapshot.viewer).toMatchObject({ role: 'seat', position: 1 });
    expect(ok.snapshot.hand).toEqual(t.game.getHand(s.id));
    expectPlayers(t, ok);
});

test('rejoinSuccess (watchSeat via rejoin, and the idempotent repeat): isLazy true', async () => {
    const t = table();
    chatHandlers.chatMessage(t.sockets[1], t.io, { message: '/lazy' });
    await drop(t, t.sockets[1]);
    const s = newSocket(t, t.names[1]);
    await reconnectHandlers.rejoinGame(s, t.io, { gameId: t.game.gameId, username: t.names[1] });
    await reconnectHandlers.rejoinGame(s, t.io, { gameId: t.game.gameId, username: t.names[1] });
    const oks = mine(t, s, 'rejoinSuccess');
    expect(oks).toHaveLength(2);
    for (const ok of oks) {
        expect(keys(ok)).toEqual(['gameId', 'isLazy', 'players', 'snapshot', 'tournamentId']);
        expect(ok).toMatchObject({ isLazy: true, tournamentId: null });
        expect(ok.snapshot.viewer).toMatchObject({ role: 'lazyWatcher', position: 1 });
        expectPlayers(t, ok);
    }
});

test('rejoinSuccess (watchSeat via joinAsSpectator): no tournamentId; then /active sends restorePlayerState', async () => {
    const t = table();
    chatHandlers.chatMessage(t.sockets[1], t.io, { message: '/lazy' });
    await drop(t, t.sockets[1]);
    const s = newSocket(t, t.names[1]);
    mainRoomHandlers.joinAsSpectator(s, t.io, { gameId: t.game.gameId });
    const [ok] = mine(t, s, 'rejoinSuccess');
    expect(keys(ok)).toEqual(['gameId', 'isLazy', 'players', 'snapshot']);
    expect(ok.isLazy).toBe(true);

    chatHandlers.chatMessage(s, t.io, { message: '/active' });
    const [restore] = mine(t, s, 'restorePlayerState');
    expect(keys(restore)).toEqual(['gameId', 'players', 'snapshot']);
    expect(restore.snapshot.viewer).toMatchObject({ role: 'seat', position: 1 });
    expectPlayers(t, restore);
});

test('restorePlayerState after a card not in the hand: gameId, players, snapshot', async () => {
    const t = table();
    for (const pos of [3, 4, 1, 2]) await gameHandlers.playerBid(t.sockets[pos], t.io, { bid: '1', position: pos });
    expect(t.game.stage).toBe(Phase.PLAYING);
    const lead = t.game.currentTurn;
    await gameHandlers.playCard(t.sockets[lead], t.io, { card: C('HI', 'joker'), position: lead });
    const [restore] = mine(t, t.sockets[lead], 'restorePlayerState');
    expect(keys(restore)).toEqual(['gameId', 'players', 'snapshot']);
    expect(restore.snapshot.hand).toEqual(t.game.getHand(t.sids[lead]));
    expectPlayers(t, restore);
});

test('spectatorJoined full state: gameId, players, trump, snapshot', () => {
    const t = table();
    const fan = newSocket(t, 'scfan');
    mainRoomHandlers.joinAsSpectator(fan, t.io, { gameId: t.game.gameId });
    const [full] = mine(t, fan, 'spectatorJoined');
    expect(keys(full)).toEqual(['gameId', 'players', 'snapshot', 'trump']);
    expect(full.trump).toEqual(C('A', 'spades'));
    expect(full.snapshot.viewer.role).toBe('spectator');
    expectPlayers(t, full);
    // no legacy key left on any carrier this socket got
    expect(events(t.log, 'spectatorJoined').some((l) => 'playedCards' in l.data || 'gameLog' in l.data)).toBe(false);
});
