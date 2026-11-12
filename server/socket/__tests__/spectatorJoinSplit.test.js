/**
 * V1_REMOVALS #8: spectatorJoined split in two. The joiner gets only its
 * own full state + v2 snapshot (socket.emit); the room notice
 * {username, spectatorCount} goes to everyone else (socket.to(room)) and
 * is sent FIRST, so the joiner's snapshot.seq already counts it and the
 * joiner's next room event is snapshot.seq + 1 (no seq gap, no resync on
 * web or iOS 1.2.0). An owner who watches their own lazy / resigned seat
 * via joinAsSpectator (watchSeat 'spectate') sends no notice at all.
 * Real handlers, stub io/sockets (gameDriver: every emit contract-checked).
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
const mainRoomHandlers = require('../mainRoomHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const { botController } = require('../../game/bot');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events, lazySeat } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let n = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager.spectatorGames.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/** Seated 4-human game in BIDDING (one card each). */
function table() {
    n++;
    const log = [];
    const io = makeIo(log);
    const sids = {};
    const sockets = {};
    for (let pos = 1; pos <= 4; pos++) {
        sids[pos] = `sj${n}-p${pos}`;
        gameManager.registerUser(sids[pos], `sj${n}user${pos}`);
    }
    const game = gameManager.createGame([1, 2, 3, 4].map((p) => sids[p]));
    for (let pos = 1; pos <= 4; pos++) {
        game.addPlayer(sids[pos], `sj${n}user${pos}`, pos, pos, false);
        sockets[pos] = makeSocket(sids[pos], log, io);
        sockets[pos].join(game.roomName);
    }
    for (let pos = 1; pos <= 4; pos++) game.setHand(game.positions[pos], [C(String(pos + 2), 'hearts')]);
    game.currentHand = 1;
    game.trump = C('A', 'spades');
    game.forcePhase(Phase.BIDDING);
    game.bidder = 3;
    game.currentTurn = 3;
    return { log, io, game, sids, sockets };
}

function viewer(t, username) {
    n++;
    const s = makeSocket(`sj-v${n}`, t.log, t.io);
    gameManager.registerUser(s.id, username);
    return s;
}

/**
 * Every spectatorJoined `sid` receives (self or room delivery), in order,
 * from log index `from` (the stub io has no per-emit membership: pass the
 * index from which `sid` is in the room).
 */
function received(t, sid, from = 0) {
    return events(t.log.slice(from), 'spectatorJoined').filter((l) => {
        if (l.to === `self:${sid}`) return true;
        if (l.to !== t.game.roomName || l.except === sid) return false;
        return (l.members || [...(t.io.rooms.get(l.to) || [])]).includes(sid);
    });
}

/** Room broadcasts (sequenced) that `sid` receives after log index `from`. */
function roomSeqsFor(t, sid, from) {
    return t.log.slice(from).filter((l) => l.to === t.game.roomName && l.except !== sid &&
        (t.io.rooms.get(l.to) || new Set()).has(sid) && l.data && Number.isInteger(l.data.seq)).map((l) => l.data.seq);
}

describe.each([
    ['joinAsSpectator', (s, t) => mainRoomHandlers.joinAsSpectator(s, t.io, { gameId: t.game.gameId })],
    ['spectateTournamentGame', (s, t) => tournamentHandlers.spectateTournamentGame(s, t.io, { gameId: t.game.gameId })],
])('%s', (_name, join) => {
    test('the joiner gets its full state only, never the notice; the room gets the notice', () => {
        const t = table();
        const fan = viewer(t, 'sjfan');
        join(fan, t);
        const mine = received(t, fan.id);
        expect(mine).toHaveLength(1);
        expect(mine[0].to).toBe(`self:${fan.id}`);
        expect(mine[0].data.snapshot).toBeTruthy();
        expect(mine[0].data.players).toBeTruthy();
        expect(mine[0].data).not.toHaveProperty('username');
        for (let pos = 1; pos <= 4; pos++) {
            const theirs = received(t, t.sids[pos]);
            expect(theirs).toHaveLength(1);
            expect(theirs[0].data).toEqual({ username: 'sjfan', spectatorCount: 1, seq: expect.any(Number) });
        }
    });

    test("the joiner's snapshot counts the notice: its next room event is snapshot.seq + 1", () => {
        const t = table();
        const before = t.game.eventSeq;
        const fan = viewer(t, 'sjfan2');
        join(fan, t);
        const notice = events(t.log, 'spectatorJoined').find((l) => l.to === t.game.roomName);
        const full = received(t, fan.id)[0].data;
        expect(notice.data.seq).toBe(before + 1);
        expect(full.snapshot.seq).toBe(notice.data.seq);
        expect(full.snapshot.spectatorCount).toBe(1);
        const from = t.log.length;
        chatHandlers.chatMessage(t.sockets[1], t.io, { message: 'hello watcher' });
        expect(roomSeqsFor(t, fan.id, from)).toEqual([full.snapshot.seq + 1]);
    });

    test('a second spectator: the first one gets its notice, the second does not', () => {
        const t = table();
        const a = viewer(t, 'sjfirst');
        const b = viewer(t, 'sjsecond');
        join(a, t);
        const bJoins = t.log.length;
        join(b, t);
        expect(received(t, a.id).map((l) => l.data.username ?? 'full')).toEqual(['full', 'sjsecond']);
        expect(received(t, b.id, bJoins).map((l) => l.data.username ?? 'full')).toEqual(['full']);
        expect(received(t, b.id, bJoins)[0].data.snapshot.spectatorCount).toBe(2);
    });
});

test("an owner watching their own lazy seat via joinAsSpectator sends no notice and bumps no seq", () => {
    const t = table();
    const bot = botController.createBot('🤖 Mary', 'mary');
    lazySeat(t.game, 2, bot, { presence: 'away' });
    gameManager.playerGames.delete(t.sids[2]);
    const phone = viewer(t, t.game.seat(2).ownerUsername);
    const before = t.game.eventSeq;
    mainRoomHandlers.joinAsSpectator(phone, t.io, { gameId: t.game.gameId }); // -> watchSeat via 'spectate'
    const rejoin = events(t.log, 'rejoinSuccess').find((l) => l.to === `self:${phone.id}`);
    expect(rejoin.data.isLazy).toBe(true);
    expect(events(t.log, 'spectatorJoined')).toEqual([]);
    expect(t.game.eventSeq).toBe(before);
    expect(rejoin.data.snapshot.seq).toBe(before);
});
