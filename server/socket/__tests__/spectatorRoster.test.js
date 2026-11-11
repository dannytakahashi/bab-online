/**
 * Who is watching (owner, 2026-11-11: the table's spectator badge):
 * spectatorsUpdated to the game room on every join, leave and disconnect,
 * coalesced, unsequenced, never after end/abort; seat owners are never
 * listed; snapshot v2 `watching` carries the same list. Real handlers, stub
 * io/sockets (gameDriver: every emit is contract-checked), fake timers.
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
const queueHandlers = require('../queueHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const gameLifecycle = require('../gameLifecycle');
const { botController } = require('../../game/bot');
const { Phase } = require('../../game/GamePhase');
const { SPECTATORS_COALESCE_MS } = require('../../game/spectatorRoster');
const { SPECTATOR_LIST_MAX } = require('../../game/spectatorWire');
const { makeIo, makeSocket, events, lazySeat } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;
let fresh = 0;

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
function table(log = [], io = makeIo(log)) {
    seq++;
    const sids = {};
    const sockets = {};
    for (let pos = 1; pos <= 4; pos++) {
        sids[pos] = `sr${seq}-p${pos}`;
        gameManager.registerUser(sids[pos], `user${pos}`);
        mockDb.current.users._insert({ username: `user${pos}`, profilePic: pos });
    }
    const game = gameManager.createGame([1, 2, 3, 4].map((p) => sids[p]));
    for (let pos = 1; pos <= 4; pos++) {
        game.addPlayer(sids[pos], `user${pos}`, pos, pos, false);
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

/** A signed-in socket (with a saved picture) not in any game. */
function viewer(t, username, pic = 7) {
    fresh++;
    const s = makeSocket(`sr-v${fresh}`, t.log, t.io);
    gameManager.registerUser(s.id, username);
    if (pic != null) mockDb.current.users._insert({ username, profilePic: pic });
    return s;
}

const watch = (t, s, game = t.game) => mainRoomHandlers.joinAsSpectator(s, t.io, { gameId: game.gameId });
/** spectatorsUpdated payloads sent to `game`'s room. */
const updates = (t, game = t.game) => events(t.log, 'spectatorsUpdated').filter((l) => l.to === game.roomName).map((l) => l.data);
const names = (u) => u.spectators.map((x) => x.username);
/** Let the picture lookups land, then the coalescing window pass. */
async function settle() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    jest.advanceTimersByTime(SPECTATORS_COALESCE_MS);
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('spectatorsUpdated: every join, leave and disconnect path', () => {
    test('joinAsSpectator: one update to the room with the name, saved picture and count', async () => {
        const t = table();
        watch(t, viewer(t, 'fan1', 12));
        expect(updates(t)).toEqual([]); // coalesced: not in the same tick
        await settle();
        expect(updates(t)).toEqual([{ gameId: t.game.gameId, spectators: [{ username: 'fan1', pic: 12 }], count: 1 }]);
    });

    test('spectateTournamentGame lists the joiner too', async () => {
        const t = table();
        tournamentHandlers.spectateTournamentGame(viewer(t, 'fan2', 3), t.io, { gameId: t.game.gameId });
        await settle();
        expect(updates(t).map(names)).toEqual([['fan2']]);
    });

    test('/leave, joinMainRoom and spectating another game each update the list', async () => {
        const t = table();
        const other = table(t.log, t.io);
        const a = viewer(t, 'fanA');
        const b = viewer(t, 'fanB');
        const c = viewer(t, 'fanC');
        watch(t, a);
        watch(t, b);
        watch(t, c);
        await settle();
        expect(updates(t).map(names)).toEqual([['fanA', 'fanB', 'fanC']]);

        chatHandlers.chatMessage(a, t.io, { message: '/leave' });
        await settle();
        expect(updates(t).map(names).at(-1)).toEqual(['fanB', 'fanC']);

        mainRoomHandlers.joinMainRoom(b, t.io);
        await settle();
        expect(updates(t).map(names).at(-1)).toEqual(['fanC']);

        watch(t, c, other.game);
        await settle();
        expect(updates(t).at(-1)).toEqual({ gameId: t.game.gameId, spectators: [], count: 0 });
        expect(updates(other).map(names)).toEqual([['fanC']]);
    });

    test('returnToTournament stops spectating and updates the list', async () => {
        const t = table();
        const s = viewer(t, 'tfan');
        watch(t, s);
        await settle();
        // a tournament member who watched another table goes back to its lobby
        const created = gameManager.createTournament(s.id, 'Cup');
        expect(created.success).toBe(true);
        tournamentHandlers.returnToTournament(s, t.io);
        await settle();
        expect(updates(t).at(-1).count).toBe(0);
        gameManager.deleteTournament(created.tournament.tournamentId);
    });

    test('a disconnect (and a forceLogout, whose bookkeeping has no io) updates the list', async () => {
        const t = table();
        const a = viewer(t, 'dropA');
        const b = viewer(t, 'dropB');
        watch(t, a);
        watch(t, b);
        await settle();
        t.io.sockets.sockets.delete(a.id);
        await queueHandlers.handleDisconnect(a, t.io);
        await settle();
        expect(updates(t).map(names).at(-1)).toEqual(['dropB']);
        gameManager.handleDisconnect(b.id); // authHandlers.disconnectPreviousSocket
        await settle();
        expect(updates(t).at(-1).count).toBe(0);
    });

    test('a burst (spectators leaving together) is one emit; a join and leave inside one window sends the settled list once', async () => {
        const t = table();
        const fans = [1, 2, 3, 4, 5].map((i) => viewer(t, `burst${i}`));
        for (const f of fans) watch(t, f);
        await settle();
        expect(updates(t)).toHaveLength(1);
        for (const f of fans) chatHandlers.chatMessage(f, t.io, { message: '/leave' });
        await settle();
        expect(updates(t)).toHaveLength(2);
        expect(updates(t)[1].count).toBe(0);

        const quick = viewer(t, 'quick', null);
        watch(t, quick);
        chatHandlers.chatMessage(quick, t.io, { message: '/leave' });
        await settle();
        // one emit, the settled (empty) list: a snapshot inside the window may have shown 'quick'
        expect(updates(t)).toHaveLength(3);
        expect(updates(t)[2]).toEqual({ gameId: t.game.gameId, spectators: [], count: 0 });
        await settle();
        expect(updates(t)).toHaveLength(3);
    });

    test('a snapshot taken inside a join-and-leave window is corrected by the flush', async () => {
        const t = table();
        const blink = viewer(t, 'blink', null);
        watch(t, blink); // a flush is now pending
        snapshotHandlers.requestSnapshot(t.sockets[1], t.io, { requestId: 'mid' });
        const snap = events(t.log, 'stateSnapshot').filter((l) => l.to === `self:${t.sockets[1].id}`).at(-1).data.snapshot;
        expect(snap.watching).toEqual({ spectators: [{ username: 'blink', pic: null }], count: 1 });
        chatHandlers.chatMessage(blink, t.io, { message: '/leave' }); // back to the last-sent (empty) list
        await settle();
        // seat 1's badge would keep "1 watching" without this
        expect(updates(t)).toEqual([{ gameId: t.game.gameId, spectators: [], count: 0 }]);
    });

    test('unsequenced: no seq on the wire and no eventSeq bump', async () => {
        const t = table();
        const before = t.game.eventSeq;
        watch(t, viewer(t, 'seqfan'));
        const afterNotice = t.game.eventSeq; // the spectatorJoined notice is sequenced, as before
        expect(afterNotice).toBe(before + 1);
        await settle();
        expect(t.game.eventSeq).toBe(afterNotice);
        expect(updates(t)[0]).not.toHaveProperty('seq');
    });

    test('the list is capped at 50 names; count is the true total', async () => {
        const t = table();
        for (let i = 0; i < SPECTATOR_LIST_MAX + 10; i++) watch(t, viewer(t, `many${i}`, null));
        await settle();
        const u = updates(t).at(-1);
        expect(u.spectators).toHaveLength(SPECTATOR_LIST_MAX);
        expect(u.count).toBe(SPECTATOR_LIST_MAX + 10);
        expect(u.spectators[0]).toEqual({ username: 'many0', pic: null });
    });

    test('one entry per person: a second tab of the same spectator is not counted twice', async () => {
        const t = table();
        watch(t, viewer(t, 'twotabs'));
        watch(t, viewer(t, 'twotabs', null));
        await settle();
        expect(updates(t).at(-1)).toMatchObject({ count: 1, spectators: [{ username: 'twotabs' }] });
    });
});

describe('seat owners are never listed', () => {
    test('a lazy owner watching their seat from another socket is not a spectator (and sends no update)', async () => {
        const t = table();
        const bot = botController.createBot('🤖 Mary', 'mary');
        lazySeat(t.game, 2, bot, { presence: 'away' });
        gameManager.playerGames.delete(t.sids[2]);
        const phone = viewer(t, 'user2', null);
        watch(t, phone); // -> watchSeat via 'spectate'
        await settle();
        expect(t.game.spectatorList()).toEqual([]);
        expect(updates(t)).toEqual([]);
    });

    test("an owner's second tab, a /leave'd owner and a demoted older socket stay off the list", async () => {
        const t = table();
        const fan = viewer(t, 'realfan');
        watch(t, fan);
        // seat 1's owner opens the table in a second tab: a pure spectator socket under their name
        watch(t, viewer(t, 'user1', null));
        // seat 4 leaves for good, then comes back to watch
        chatHandlers.chatMessage(t.sockets[4], t.io, { message: '/leave' });
        watch(t, viewer(t, 'user4', null));
        await settle();
        expect(t.game.spectators.size).toBe(3); // the old socket count keeps its meaning
        expect(updates(t).map(names).at(-1)).toEqual(['realfan']);
        expect(t.game.spectatorList().map((x) => x.username)).toEqual(['realfan']);
    });
});

describe('never after end or abort', () => {
    test('a join just before the abort sends no update; the retired game sends nothing more', async () => {
        const t = table();
        const s = viewer(t, 'late');
        watch(t, s);
        await gameLifecycle.abortGame(t.io, t.game, 'test');
        await settle();
        const abortAt = t.log.findIndex((l) => l.event === 'abortGame');
        expect(abortAt).toBeGreaterThan(-1);
        expect(t.log.slice(abortAt).filter((l) => l.event === 'spectatorsUpdated')).toEqual([]);
        expect(updates(t)).toEqual([]);
        expect(t.game.hasTimer('spectators')).toBe(false);
    });
});

describe('snapshot v2 watching', () => {
    test('a seat owner and a spectator see who is watching in requestSnapshot; spectatorCount keeps its old meaning', async () => {
        const t = table();
        const fan = viewer(t, 'snapfan', 9);
        watch(t, fan);
        watch(t, viewer(t, 'user3', null)); // seat 3's second tab: counted as a socket, not listed
        await settle();
        for (const s of [t.sockets[1], fan]) {
            snapshotHandlers.requestSnapshot(s, t.io, { requestId: 'r' });
            const reply = events(t.log, 'stateSnapshot').filter((l) => l.to === `self:${s.id}`).at(-1).data;
            expect(reply.snapshot.watching).toEqual({ spectators: [{ username: 'snapfan', pic: 9 }], count: 1 });
            expect(reply.snapshot.spectatorCount).toBe(2);
        }
    });

    test("the spectator's own full state carries the list at once (its picture is looked up after)", () => {
        const t = table();
        watch(t, viewer(t, 'firstfan'));
        const s = viewer(t, 'secondfan', null);
        watch(t, s);
        const own = events(t.log, 'spectatorJoined').find((l) => l.to === `self:${s.id}`).data;
        expect(own.snapshot.watching.spectators.map((x) => x.username)).toEqual(['firstfan', 'secondfan']);
        expect(own.snapshot.watching.count).toBe(2);
    });
});
