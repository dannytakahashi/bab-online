/**
 * The over-the-shoulder view (owner 2026-11-21; server/socket/shoulderView.js,
 * docs/claude/spectators.md "Over-the-shoulder view"): real lobby-born
 * games over the real handlers (stub io / sockets: every emit is
 * contract-checked), with the live emit scan (testUtils/shoulderCheck.js)
 * on for every test: no socket without the cap shoulderView ever gets
 * shoulder data, a watcher gets only its watched seat's hand / HSI / hints,
 * no seat owner gets another seat's hand.
 *
 * Covered: the accepted reply and the next deals' gameStart, switching and
 * stopping, every refusal (not_spectating, unavailable: suspended or
 * frozen, not_dealt, tournament (also once the map entry is gone),
 * own_seat: a player's second tab, a /leave'd owner), a socket without
 * the cap getting nothing at all, the
 * mirrored /help and tutorial hints, who watches which hand
 * (spectatorsUpdated wide copy / snapshot watching), and every way a watch
 * ends (/leave, joinMainRoom, spectating another game, disconnect, a hello
 * without the cap, /active reclaim, a rejoin, the game's end).
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const queueHandlers = require('../queueHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const clientInfo = require('../clientInfo');
const shoulderView = require('../shoulderView');
const assistHandlers = require('../assistHandlers');
const rateLimiter = require('../rateLimiter');
const gameLifecycle = require('../gameLifecycle');
const pacing = require('../../game/pacing');
const { Phase } = require('../../game/GamePhase');
const { SPECTATORS_COALESCE_MS } = require('../../game/spectatorRoster');
const { world } = require('../../testUtils/contractScenarios');
const { advanceUntil, setupTournament, liveTables } = require('../../testUtils/tournamentDriver');
const { events, mulberry32, legalBids } = require('../../testUtils/gameDriver');
const { watchShoulders, shouldersInvariant } = require('../../testUtils/shoulderCheck');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const realRandom = Math.random;
let scan = null;
let currentIo = null;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    assistHandlers._resetForTests();
    process.env.BID_CLOCK = 'off'; // tests idle bid turns
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    scan = watchShoulders(() => currentIo, { ownerHsi: 'own' });
});

afterEach(() => {
    scan.stop();
    expect(scan.failures).toEqual([]);
    delete process.env.BID_CLOCK;
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    gameManager.spectatorGames.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
    currentIo = null;
});
afterAll(() => rateLimiter.shutdown());

const hello = (w, s, caps) => clientInfo.handle(s, w.io, { client: 'web', version: '1.0.0', caps });
const SHOULDER = ['avatarUrl', 'shoulderView'];

/** Four humans through the real lobby to the first open bid turn. */
async function table(tag, seed, w = world(tag)) {
    Math.random = mulberry32(seed);
    currentIo = w.io;
    const names = [1, 2, 3, 4].map((i) => `${tag}_p${i}`);
    const socks = names.map((n, i) => w.user(`${tag}-h${i}`, n));
    mainRoomHandlers.createLobby(socks[0], w.io, { name: `${tag} table` });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    const pending = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    const game = gameManager.getPlayerGame(socks[0].id);
    return { w, game, names, socks, pending, lobbyId };
}

async function toBidding(t) {
    await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
    t.pending.push(...t.socks.map((s) => gameHandlers.draw(s, t.w.io, { num: 0 })));
    await advanceUntil(() => t.game.stage === Phase.BIDDING && !t.game.resume, 100);
}

async function dealt(tag, seed, w) {
    const t = await table(tag, seed, w);
    await toBidding(t);
    return t;
}

const owner = (t, pos) => t.w.sockets.get(t.game.seat(pos).ownerSocketId);

/** A signed-in spectator of t.game (with caps). */
function spectator(t, id, username, caps = SHOULDER) {
    const s = t.w.user(id, username);
    if (caps) hello(t.w, s, caps);
    mainRoomHandlers.joinAsSpectator(s, t.w.io, { gameId: t.game.gameId });
    expect(t.game.isSpectator(s.id)).toBe(true);
    return s;
}

/** watchHand; returns what came back to the socket. */
function watch(t, s, position, extra = {}) {
    const from = t.w.log.length;
    shoulderView.watchHand(s, t.w.io, { gameId: t.game.gameId, position, ...extra });
    return t.w.log.slice(from).filter((l) => l.to === `self:${s.id}`);
}

const seatHand = (game, pos) => game.getHand(game.positions[pos]).map((c) => ({ suit: c.suit, rank: c.rank }));
const to = (t, s, event, from = 0) => t.w.log.slice(from).filter((l) => (l.to === s.id || l.to === `self:${s.id}`) && l.event === event);

/** Let the coalesced spectator list go out. */
async function settle() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    jest.advanceTimersByTime(SPECTATORS_COALESCE_MS);
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** All four seats bid 0: the all-zero redeal (a fresh gameStart). */
async function redeal(t) {
    const dealSeq = t.game.dealSeq;
    while (t.game.stage === Phase.BIDDING && t.game.dealSeq === dealSeq) {
        await gameHandlers.playerBid(owner(t, t.game.currentTurn), t.w.io, { bid: '0' });
    }
    await advanceUntil(() => t.game.dealSeq > dealSeq && t.game.stage === Phase.BIDDING, 100);
}

describe('watchHand accepted', () => {
    test('the reply: stateSnapshot reason watchHand with viewer.shoulder; role and position stay the spectator\'s', async () => {
        const t = await dealt('sv1', 201);
        const s = spectator(t, 'sv1-spec', 'sv1_fan');
        const got = watch(t, s, 2, { requestId: 'w1' });
        expect(got.map((l) => l.event)).toEqual(['stateSnapshot']);
        const { snapshot, reason, requestId } = got[0].data;
        expect({ reason, requestId }).toEqual({ reason: 'watchHand', requestId: 'w1' });
        expect(snapshot.viewer).toMatchObject({ role: 'spectator', position: null, canAct: false });
        expect(snapshot.viewer.shoulder).toEqual({ position: 2, hand: seatHand(t.game, 2), hsi: t.game.hsiValues[2] });
        expect(snapshot.hand).toBeNull();
        expect(snapshot.hsi).toBeNull();
        expect(snapshot.partial).toEqual(['log']);
        expect(t.game.shoulders.get(s.id)).toBe(2);
        // a requestSnapshot carries it too
        const from = t.w.log.length;
        snapshotHandlers.requestSnapshot(s, t.w.io, { log: false });
        expect(to(t, s, 'stateSnapshot', from)[0].data.snapshot.viewer.shoulder.position).toBe(2);
        expect(to(t, s, 'stateSnapshot', from)[0].data).not.toHaveProperty('reason');
        await Promise.all(t.pending);
    });

    test('every deal: the watcher\'s gameStart carries the watched seat\'s new hand and HSI; other spectators and seats get exactly what they got before', async () => {
        const t = await dealt('sv2', 202);
        const s = spectator(t, 'sv2-spec', 'sv2_fan');
        const plain = spectator(t, 'sv2-plain', 'sv2_plain', null); // no hello: a shipped build
        const capNoWatch = spectator(t, 'sv2-cap', 'sv2_cap');
        watch(t, s, 3);
        const from = t.w.log.length;
        await redeal(t);
        const starts = events(t.w.log.slice(from), 'gameStart');
        const mine = starts.filter((l) => l.to === s.id);
        expect(mine).toHaveLength(1);
        expect(mine[0].data.hand).toEqual([]);
        expect(mine[0].data.shoulder).toEqual({ position: 3, hand: seatHand(t.game, 3), hsi: t.game.hsiValues[3] });
        const seat3 = starts.find((l) => l.to === owner(t, 3).id);
        expect(mine[0].data.shoulder.hand).toEqual(seat3.data.hand);
        for (const other of [plain, capNoWatch]) {
            const g = starts.find((l) => l.to === other.id);
            expect(g.data).not.toHaveProperty('shoulder');
            expect(g.data.hand).toEqual([]);
        }
        expect(scan.counts.gameStartShoulders).toBe(1);
        await Promise.all(t.pending);
    });

    test('switching seats and stopping: one seat at a time, the next deal follows the switch, a stop drops it', async () => {
        const t = await dealt('sv3', 203);
        const s = spectator(t, 'sv3-spec', 'sv3_fan');
        expect(watch(t, s, 1)[0].data.snapshot.viewer.shoulder.position).toBe(1);
        expect(watch(t, s, 4)[0].data.snapshot.viewer.shoulder).toEqual({ position: 4, hand: seatHand(t.game, 4), hsi: t.game.hsiValues[4] });
        let from = t.w.log.length;
        await redeal(t);
        expect(to(t, s, 'gameStart', from).map((l) => l.data.shoulder.position)).toEqual([4]);
        const stop = watch(t, s, null);
        expect(stop.map((l) => l.event)).toEqual(['stateSnapshot']);
        expect(stop[0].data.reason).toBe('watchHand');
        expect(stop[0].data.snapshot.viewer).not.toHaveProperty('shoulder');
        expect(t.game.shoulders.has(s.id)).toBe(false);
        from = t.w.log.length;
        await redeal(t);
        expect(to(t, s, 'gameStart', from).map((l) => 'shoulder' in l.data)).toEqual([false]);
        await Promise.all(t.pending);
    });

    test('cards leave the watched hand through the public cardPlayed (no new event)', async () => {
        const t = await dealt('sv4', 204);
        const s = spectator(t, 'sv4-spec', 'sv4_fan');
        while (t.game.stage === Phase.BIDDING) {
            const bids = legalBids(t.game);
            await gameHandlers.playerBid(owner(t, t.game.currentTurn), t.w.io, { bid: bids.includes('1') ? '1' : bids[0] });
        }
        const pos = t.game.currentTurn;
        watch(t, s, pos);
        const before = seatHand(t.game, pos);
        const from = t.w.log.length;
        const { legalCards } = require('../../testUtils/gameDriver');
        const card = legalCards(t.game, owner(t, pos).id)[0];
        await gameHandlers.playCard(owner(t, pos), t.w.io, { card });
        const played = events(t.w.log.slice(from), 'cardPlayed');
        expect(played).toHaveLength(1);
        expect(played[0].to).toBe(t.game.roomName);
        expect(played[0].data).toMatchObject({ position: pos, card: { suit: card.suit, rank: card.rank } });
        expect(t.w.log.slice(from).filter((l) => l.to === s.id || l.to === `self:${s.id}`).map((l) => l.event)).toEqual([]);
        const after = watch(t, s, pos)[0].data.snapshot.viewer.shoulder.hand;
        expect(after).toEqual(before.filter((c) => !(c.suit === card.suit && c.rank === card.rank)));
        await Promise.all(t.pending);
    });
});

describe('refusals (watchHandRefused; nothing changes)', () => {
    const refusalOf = (got) => {
        expect(got.map((l) => l.event)).toEqual(['watchHandRefused']);
        return got[0].data;
    };

    test('no cap: a spectator that never sent it (a shipped build) gets nothing at all, not even a refusal', async () => {
        const t = await dealt('sr1', 211);
        const s = spectator(t, 'sr1-spec', 'sr1_fan', null);
        expect(watch(t, s, 2)).toEqual([]);
        expect(watch(t, s, null)).toEqual([]);
        expect(t.game.shoulders.size).toBe(0);
        await Promise.all(t.pending);
    });

    test('unavailable: a suspended table (self-fence) answers no hand on any path, nor does a frozen one', async () => {
        const t = await dealt('sr8', 218);
        hello(t.w, owner(t, t.game.currentTurn), ['assist']);
        const s = spectator(t, 'sr8-spec', 'sr8_fan');
        watch(t, s, 2);
        expect(t.game.suspend()).toBe(true);
        expect(refusalOf(watch(t, s, 3))).toMatchObject({ reason: 'unavailable', message: shoulderView.REFUSALS.unavailable });
        expect(t.game.shoulders.get(s.id)).toBe(2); // a refused switch keeps the watch
        // a direct snapshot reply (not behind the suspended emit gate) carries no hand
        let from = t.w.log.length;
        snapshotHandlers.requestSnapshot(s, t.w.io, { log: false });
        const snap = to(t, s, 'stateSnapshot', from)[0].data.snapshot;
        expect(snap.viewer).not.toHaveProperty('shoulder');
        expect(shoulderView.watchersOf(t.w.io, t.game, 2)).toEqual([]);
        t.game.unsuspend(t.w.io);
        // the watch is still there after the thaw
        from = t.w.log.length;
        snapshotHandlers.requestSnapshot(s, t.w.io, { log: false });
        expect(to(t, s, 'stateSnapshot', from)[0].data.snapshot.viewer.shoulder.position).toBe(2);
        t.game.freeze();
        expect(refusalOf(watch(t, s, 2)).reason).toBe('unavailable');
        from = t.w.log.length;
        snapshotHandlers.requestSnapshot(s, t.w.io, { log: false });
        expect(to(t, s, 'stateSnapshot', from).every((l) => !l.data.snapshot || !('shoulder' in l.data.snapshot.viewer))).toBe(true);
        // a stop is always accepted, even on a frozen table: no reply (no snapshot leaves it), the watch is gone
        expect(watch(t, s, null)).toEqual([]);
        expect(t.game.shoulders.has(s.id)).toBe(false);
        await Promise.all(t.pending);
    });

    test('a stop sent while the table is suspended is done: no reply then, and the watch does not come back at the thaw', async () => {
        const t = await dealt('sr10', 220);
        const s = spectator(t, 'sr10-spec', 'sr10_fan');
        watch(t, s, 2);
        expect(t.game.suspend()).toBe(true);
        expect(watch(t, s, null)).toEqual([]);
        expect(t.game.shoulders.has(s.id)).toBe(false);
        t.game.unsuspend(t.w.io);
        const from = t.w.log.length;
        snapshotHandlers.requestSnapshot(s, t.w.io, { log: false });
        expect(to(t, s, 'stateSnapshot', from)[0].data.snapshot.viewer).not.toHaveProperty('shoulder');
        // and a new watch after the thaw works as before
        expect(watch(t, s, 3)[0].data.snapshot.viewer.shoulder.position).toBe(3);
        await Promise.all(t.pending);
    });

    test('tournament: a table whose tournament was cancelled while it was suspended stays a tournament table', async () => {
        Math.random = mulberry32(219);
        const ctx = await setupTournament(4);
        currentIo = ctx.io;
        const starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t)[0].stage === Phase.BIDDING, 100, 60000);
        await starting;
        const game = liveTables(ctx.t)[0];
        expect(game.tournamentId).toBe(ctx.t.tournamentId);
        const { newUser } = require('../../testUtils/tournamentDriver');
        const s = newUser(ctx.io, ctx.log, 'sr9_fan');
        clientInfo.handle(s, ctx.io, { client: 'web', version: '1', caps: SHOULDER });
        await tournamentHandlers.spectateTournamentGame(s, ctx.io, { gameId: game.gameId });
        expect(game.isSpectator(s.id)).toBe(true);
        // the holder self-fence suspends the table; the creator cancels meanwhile
        expect(game.suspend()).toBe(true);
        const creator = ctx.sockets.find((x) => ctx.t.createdBy === x.id) || ctx.sockets[0];
        await tournamentHandlers.cancelTournament(creator, ctx.io);
        expect(gameManager.tournamentGames.has(game.gameId)).toBe(false);
        expect(game.isTerminal()).toBe(false);
        const ask = () => {
            const from = ctx.log.length;
            shoulderView.watchHand(s, ctx.io, { gameId: game.gameId, position: 1 });
            return ctx.log.slice(from).filter((l) => l.to === `self:${s.id}`).map((l) => [l.event, l.data.reason]);
        };
        expect(ask()).toEqual([['watchHandRefused', 'unavailable']]);
        // not suspended either: still refused as a tournament table (the game's own mark)
        game._suspended = null; // the thaw's state without running its deferred abort
        expect(ask()).toEqual([['watchHandRefused', 'tournament']]);
        expect(game.shoulders.size).toBe(0);
    }, 60000);

    test('not_spectating: a seat owner, an unknown game, another game\'s spectator', async () => {
        const t = await dealt('sr2', 212);
        hello(t.w, owner(t, 1), SHOULDER);
        expect(refusalOf(watch(t, owner(t, 1), 2)).reason).toBe('not_spectating');
        const s = t.w.user('sr2-spec', 'sr2_fan');
        hello(t.w, s, SHOULDER);
        const from = t.w.log.length;
        shoulderView.watchHand(s, t.w.io, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', position: 1 });
        expect(to(t, s, 'watchHandRefused', from)[0].data.reason).toBe('not_spectating');
        // a spectator of the game, refused for another gameId
        mainRoomHandlers.joinAsSpectator(s, t.w.io, { gameId: t.game.gameId });
        const from2 = t.w.log.length;
        shoulderView.watchHand(s, t.w.io, { gameId: '6f1c2b8e-7f0a-4c55-9d3e-2a1b0c9d8e7f', position: null });
        expect(to(t, s, 'watchHandRefused', from2)[0].data.reason).toBe('not_spectating');
        await Promise.all(t.pending);
    });

    test('not_dealt: before the first gameStart (CREATED, the draw); accepted once dealt', async () => {
        const t = await table('sr3', 213);
        expect(t.game.stage).toBe(Phase.CREATED);
        const s = spectator(t, 'sr3-spec', 'sr3_fan');
        expect(refusalOf(watch(t, s, 1)).reason).toBe('not_dealt');
        await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
        expect(t.game.stage).toBe(Phase.DRAWING);
        expect(refusalOf(watch(t, s, 1)).reason).toBe('not_dealt');
        t.pending.push(...t.socks.map((x) => gameHandlers.draw(x, t.w.io, { num: 0 })));
        await advanceUntil(() => t.game.stage === Phase.BIDDING && !t.game.resume, 100);
        expect(watch(t, s, 1)[0].event).toBe('stateSnapshot');
        await Promise.all(t.pending);
    });

    test('tournament: never at a tournament table', async () => {
        Math.random = mulberry32(214);
        const ctx = await setupTournament(4);
        currentIo = ctx.io;
        const starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t)[0].stage === Phase.BIDDING, 100, 60000);
        await starting;
        const game = liveTables(ctx.t)[0];
        const { newUser } = require('../../testUtils/tournamentDriver');
        const s = newUser(ctx.io, ctx.log, 'sr4_fan');
        clientInfo.handle(s, ctx.io, { client: 'web', version: '1', caps: SHOULDER });
        await tournamentHandlers.spectateTournamentGame(s, ctx.io, { gameId: game.gameId });
        expect(game.isSpectator(s.id)).toBe(true);
        const from = ctx.log.length;
        shoulderView.watchHand(s, ctx.io, { gameId: game.gameId, position: 1 });
        const got = ctx.log.slice(from).filter((l) => l.to === `self:${s.id}`);
        expect(got.map((l) => [l.event, l.data.reason])).toEqual([['watchHandRefused', 'tournament']]);
        expect(game.shoulders.size).toBe(0);
    }, 60000);

    test('own_seat: a player\'s second tab spectating may watch only that player\'s seat', async () => {
        const t = await dealt('sr5', 215);
        const name = t.game.seat(2).ownerUsername;
        const tab = t.w.user('sr5-tab2', name);
        hello(t.w, tab, SHOULDER);
        mainRoomHandlers.joinAsSpectator(tab, t.w.io, { gameId: t.game.gameId });
        expect(t.game.isSpectator(tab.id)).toBe(true);
        expect(t.game.seat(2).ownerSocketId).not.toBe(tab.id);
        expect(refusalOf(watch(t, tab, 1))).toEqual({ gameId: t.game.gameId, position: 1, reason: 'own_seat', ownPosition: 2, message: shoulderView.REFUSALS.own_seat });
        expect(watch(t, tab, 2)[0].data.snapshot.viewer.shoulder.position).toBe(2);
        // a refused switch keeps the current watch
        expect(refusalOf(watch(t, tab, 3)).reason).toBe('own_seat');
        expect(t.game.shoulders.get(tab.id)).toBe(2);
        // the badge never lists an owner's own tab
        await settle();
        expect(events(t.w.log, 'spectatorsUpdated').flatMap((l) => l.data.spectators.map((e) => e.username))).not.toContain(name);
        await Promise.all(t.pending);
    });

    test('own_seat: a /leave\'d owner watching from a new socket (gone seats count)', async () => {
        const t = await dealt('sr6', 216);
        const leaver = owner(t, 4);
        const name = t.game.seat(4).ownerUsername;
        chatHandlers.chatMessage(leaver, t.w.io, { message: '/leave' });
        expect(t.game.seat(4).presence).toBe('gone');
        const back = t.w.user('sr6-back', name);
        hello(t.w, back, SHOULDER);
        mainRoomHandlers.joinAsSpectator(back, t.w.io, { gameId: t.game.gameId });
        expect(t.game.isSpectator(back.id)).toBe(true);
        expect(refusalOf(watch(t, back, 3)).ownPosition).toBe(4);
        expect(watch(t, back, 4)[0].data.snapshot.viewer.shoulder.position).toBe(4);
        await Promise.all(t.pending);
    });

    test('a malformed payload is the wrapper\'s serverError validation (Joi), a flood its rateLimit', async () => {
        const t = await dealt('sr7', 217);
        const s = spectator(t, 'sr7-spec', 'sr7_fan');
        const { syncHandler } = require('../errorHandler');
        const send = (data) => syncHandler('watchHand', shoulderView.watchHand)(s, t.w.io, data);
        for (const bad of [{ gameId: t.game.gameId, position: 5 }, { gameId: t.game.gameId, position: '2' }, { gameId: t.game.gameId }, { position: 1 }]) {
            const from = t.w.log.length;
            send(bad);
            expect(to(t, s, 'serverError', from).map((l) => l.data.code)).toEqual(['validation']);
        }
        let limited = 0;
        for (let i = 0; i < 25; i++) {
            const from = t.w.log.length;
            send({ gameId: t.game.gameId, position: (i % 4) + 1 });
            if (to(t, s, 'serverError', from).some((l) => l.data.code === 'rateLimit')) limited++;
        }
        expect(limited).toBeGreaterThan(0);
        await Promise.all(t.pending);
    });
});

describe('the watched seat\'s hints (assistHint watched)', () => {
    test('/help answers go to the seat\'s watchers without the note; never to other watchers, plain spectators, or as status', async () => {
        const t = await dealt('sh1', 221);
        const pos = t.game.currentTurn;
        const other = (pos % 4) + 1;
        hello(t.w, owner(t, pos), ['assist']);
        const w1 = spectator(t, 'sh1-w1', 'sh1_w1');
        const w2 = spectator(t, 'sh1-w2', 'sh1_w2');
        const plain = spectator(t, 'sh1-plain', 'sh1_plain', null);
        watch(t, w1, pos);
        watch(t, w2, other);
        const from = t.w.log.length;
        for (let i = 0; i < 3; i++) {
            rateLimiter.clearSocket(owner(t, pos).id);
            chatHandlers.chatMessage(owner(t, pos), t.w.io, { message: '/help' });
            // repeat asks on the same turn: answered, not counted
        }
        const hints = events(t.w.log.slice(from), 'assistHint');
        const mine = hints.filter((l) => l.to === owner(t, pos).id);
        const mirrored = hints.filter((l) => l.to === w1.id);
        expect(mine.length).toBeGreaterThan(0);
        expect(mirrored).toHaveLength(mine.length);
        mirrored.forEach((m, i) => {
            const { note, ...rest } = mine[i].data;
            expect(m.data).toEqual({ ...rest, watched: pos });
        });
        expect(hints.some((l) => l.to === w2.id || l.to === plain.id)).toBe(false);
        // a watcher asking is still "for players only" (status, never mirrored)
        const from2 = t.w.log.length;
        hello(t.w, w1, [...SHOULDER, 'assist']);
        chatHandlers.chatMessage(w1, t.w.io, { message: '/help' });
        const asked = events(t.w.log.slice(from2), 'assistHint');
        expect(asked.map((l) => [l.to, l.data.kind, 'watched' in l.data])).toEqual([[w1.id, 'status', false]]);
        // the owner's client without the cap assist gets lines; its watchers still get the hint
        hello(t.w, owner(t, pos), []);
        const from3 = t.w.log.length;
        rateLimiter.clearSocket(owner(t, pos).id);
        chatHandlers.chatMessage(owner(t, pos), t.w.io, { message: '?help' });
        expect(events(t.w.log.slice(from3), 'assistHint').map((l) => l.to)).toEqual([w1.id]);
        expect(events(t.w.log.slice(from3), 'gameLogEntry').some((l) => l.to === owner(t, pos).id)).toBe(true);
        await Promise.all(t.pending);
    });

    test('the tutorial: its advice and rule tips are mirrored, its system tips (T.welcome) are not', async () => {
        const t = await dealt('sh2', 222);
        const pos = t.game.currentTurn;
        hello(t.w, owner(t, pos), ['assist', 'tutorial']);
        const w1 = spectator(t, 'sh2-w1', 'sh2_w1');
        watch(t, w1, pos);
        const from = t.w.log.length;
        chatHandlers.chatMessage(owner(t, pos), t.w.io, { message: '/tutorial on' });
        // the tutor steps on the next updateTurn: play the deal on
        for (let i = 0; i < 12 && t.game.stage === Phase.BIDDING; i++) {
            await jest.advanceTimersByTimeAsync(0);
            const bids = legalBids(t.game);
            await gameHandlers.playerBid(owner(t, t.game.currentTurn), t.w.io, { bid: bids.includes('1') ? '1' : bids[0] });
            await jest.advanceTimersByTimeAsync(0);
        }
        await jest.advanceTimersByTimeAsync(0);
        const hints = events(t.w.log.slice(from), 'assistHint');
        const ownTips = hints.filter((l) => l.to === owner(t, pos).id && l.data.kind === 'tip');
        const ownAdvice = hints.filter((l) => l.to === owner(t, pos).id && l.data.source === 'tutorial' && (l.data.kind === 'bid' || l.data.kind === 'card'));
        const mirrored = hints.filter((l) => l.to === w1.id);
        expect(ownTips.map((l) => l.data.tipId)).toContain('T.welcome');
        expect(ownAdvice.length).toBeGreaterThan(0);
        expect(mirrored.filter((l) => l.data.kind === 'tip').length).toBeGreaterThan(0);
        expect(mirrored.some((l) => l.data.tipId === 'T.welcome')).toBe(false);
        expect(mirrored.filter((l) => l.data.kind === 'tip').map((l) => l.data.tipId))
            .toEqual(ownTips.map((l) => l.data.tipId).filter((id) => !['T.welcome', 'T.graduate', 'T.done'].includes(id)));
        expect(mirrored.filter((l) => l.data.kind !== 'tip')).toHaveLength(ownAdvice.length);
        expect(mirrored.every((l) => l.data.watched === pos && !('actions' in l.data) && !('note' in l.data))).toBe(true);
        expect(scan.counts.mirrored).toBe(mirrored.length);
        await Promise.all(t.pending);
    });
});

describe('who watches which hand', () => {
    test('actionRejected: a capable seat owner\'s snapshot carries who watches which hand too', async () => {
        const t = await dealt('sw2', 232);
        const s = spectator(t, 'sw2-spec', 'sw2_fan');
        watch(t, s, 1);
        const notOnTurn = (t.game.currentTurn % 4) + 1;
        hello(t.w, owner(t, notOnTurn), SHOULDER);
        const from = t.w.log.length;
        await gameHandlers.playerBid(owner(t, notOnTurn), t.w.io, { bid: '1' });
        const rej = to(t, owner(t, notOnTurn), 'actionRejected', from);
        expect(rej).toHaveLength(1);
        expect(rej[0].data.snapshot.watching.spectators).toEqual([expect.objectContaining({ username: 'sw2_fan', shoulder: 1 })]);
        await Promise.all(t.pending);
    });

    test('spectatorsUpdated: the room copy is unchanged; capable sockets also get the wide copy with shoulder', async () => {
        const t = await dealt('sw1', 231);
        hello(t.w, owner(t, 1), SHOULDER); // a capable player sees it too
        const s = spectator(t, 'sw1-spec', 'sw1_fan');
        const plain = spectator(t, 'sw1-plain', 'sw1_plain', null);
        await settle();
        const from = t.w.log.length;
        watch(t, s, 3);
        await settle();
        const ups = events(t.w.log.slice(from), 'spectatorsUpdated');
        // only who watches which hand changed: the wide copy alone, to the capable sockets
        expect(ups.map((l) => l.to).sort()).toEqual([owner(t, 1).id, s.id].sort());
        for (const u of ups) expect(u.data.spectators).toEqual([{ username: 'sw1_fan', pic: 7, shoulder: 3 }, { username: 'sw1_plain', pic: 7 }]);
        // a join while someone watches: room copy (plain) then the wide copy
        const from2 = t.w.log.length;
        spectator(t, 'sw1-late', 'sw1_late', null);
        await settle();
        const ups2 = events(t.w.log.slice(from2), 'spectatorsUpdated');
        expect(ups2[0].to).toBe(t.game.roomName);
        expect(ups2[0].data.spectators.some((e) => 'shoulder' in e)).toBe(false);
        expect(ups2.slice(1).map((l) => l.to).sort()).toEqual([owner(t, 1).id, s.id].sort());
        expect(ups2.slice(1).every((l) => l.data.spectators[0].shoulder === 3)).toBe(true);
        // snapshot watching: wide for a capable viewer, plain otherwise
        const f3 = t.w.log.length;
        snapshotHandlers.requestSnapshot(owner(t, 1), t.w.io, { log: false });
        snapshotHandlers.requestSnapshot(plain, t.w.io, { log: false });
        const [capSnap, plainSnap] = events(t.w.log.slice(f3), 'stateSnapshot').map((l) => l.data.snapshot);
        expect(capSnap.watching.spectators[0]).toMatchObject({ username: 'sw1_fan', shoulder: 3 });
        expect(plainSnap.watching.spectators.some((e) => 'shoulder' in e)).toBe(false);
        // the stop: capable sockets get the list without shoulder
        const f4 = t.w.log.length;
        watch(t, s, null);
        await settle();
        const ups3 = events(t.w.log.slice(f4), 'spectatorsUpdated');
        expect(ups3.map((l) => l.to).sort()).toEqual([owner(t, 1).id, s.id].sort());
        expect(ups3.every((l) => l.data.spectators.every((e) => !('shoulder' in e)))).toBe(true);
        // nobody watching: a join sends the room copy only
        const f5 = t.w.log.length;
        spectator(t, 'sw1-later', 'sw1_later', null);
        await settle();
        expect(events(t.w.log.slice(f5), 'spectatorsUpdated').map((l) => l.to)).toEqual([t.game.roomName]);
        await Promise.all(t.pending);
    });
});

describe('a watch ends with the socket\'s spectating (never stale)', () => {
    const watching = async (tag, seed) => {
        const t = await dealt(tag, seed);
        const s = spectator(t, `${tag}-spec`, `${tag}_fan`);
        watch(t, s, 2);
        expect(t.game.shoulders.get(s.id)).toBe(2);
        return { t, s };
    };
    const noStale = (t) => expect(shouldersInvariant(t.w.io, t.game)).toEqual([]);

    test('/leave, joinMainRoom, spectating another game, a disconnect', async () => {
        let { t, s } = await watching('se1', 241);
        chatHandlers.chatMessage(s, t.w.io, { message: '/leave' });
        expect(t.game.shoulders.size).toBe(0);
        noStale(t);
        await Promise.all(t.pending);

        ({ t, s } = await watching('se2', 242));
        mainRoomHandlers.joinMainRoom(s, t.w.io);
        expect(t.game.shoulders.size).toBe(0);
        await Promise.all(t.pending);

        ({ t, s } = await watching('se3', 243));
        const other = await dealt('se3b', 244, t.w); // the same io: one process
        mainRoomHandlers.joinAsSpectator(s, t.w.io, { gameId: other.game.gameId });
        expect(t.game.shoulders.size).toBe(0);
        expect(other.game.shoulders.size).toBe(0);
        await Promise.all([...t.pending, ...other.pending]);

        ({ t, s } = await watching('se4', 245));
        t.w.kill(s);
        expect(t.game.shoulders.size).toBe(0);
        await Promise.all(t.pending);
    }, 60000);

    test('a hello without the cap ends it (and nothing more is sent)', async () => {
        const { t, s } = await watching('se5', 246);
        hello(t.w, s, ['avatarUrl']);
        expect(t.game.shoulders.size).toBe(0);
        const from = t.w.log.length;
        await redeal(t);
        expect(to(t, s, 'gameStart', from).map((l) => 'shoulder' in l.data)).toEqual([false]);
        await Promise.all(t.pending);
    });

    test('a lazy owner back by joinAsSpectator watches its seat as its owner (mapped, a lazy watcher): never a shoulder', async () => {
        const t = await dealt('se6', 247);
        const name = t.game.seat(2).ownerUsername;
        const first = owner(t, 2);
        chatHandlers.chatMessage(first, t.w.io, { message: '/lazy' });
        t.w.kill(first); // the lazy seat is away now
        expect(t.game.seat(2).presence).toBe('away');
        const tab = t.w.user('se6-tab', name);
        hello(t.w, tab, SHOULDER);
        mainRoomHandlers.joinAsSpectator(tab, t.w.io, { gameId: t.game.gameId });
        expect(t.game.isSpectator(tab.id)).toBe(false);
        expect(t.game.seat(2).ownerSocketId).toBe(tab.id);
        expect(refusalOf2(watch(t, tab, 2))).toBe('not_spectating');
        expect(t.game.shoulders.size).toBe(0);
        noStale(t);
        await Promise.all(t.pending);
    });

    test('a pure spectator of the owner\'s name reclaims an away seat with /active: its watch is cleared', async () => {
        const t = await dealt('se7', 248);
        const name = t.game.seat(3).ownerUsername;
        const tab = t.w.user('se7-tab', name);
        hello(t.w, tab, SHOULDER);
        mainRoomHandlers.joinAsSpectator(tab, t.w.io, { gameId: t.game.gameId });
        expect(t.game.isSpectator(tab.id)).toBe(true);
        expect(watch(t, tab, 3)[0].event).toBe('stateSnapshot');
        // the seat's socket goes lazy and drops: the away seat the tab may reclaim
        const first = owner(t, 3);
        chatHandlers.chatMessage(first, t.w.io, { message: '/lazy' });
        t.w.kill(first);
        expect(t.game.seat(3).presence).toBe('away');
        expect(t.game.shoulders.get(tab.id)).toBe(3);
        chatHandlers.chatMessage(tab, t.w.io, { message: '/active' });
        expect(t.game.seat(3).ownerSocketId).toBe(tab.id);
        expect(t.game.shoulders.has(tab.id)).toBe(false);
        const from = t.w.log.length;
        await redeal(t);
        const g = to(t, tab, 'gameStart', from);
        expect(g.map((l) => [l.data.position, 'shoulder' in l.data])).toEqual([[3, false]]);
        noStale(t);
        await Promise.all(t.pending);
    });

    test('a rejoin from the watching socket (the owner in grace): cleared, it owns the seat', async () => {
        const t = await dealt('se8', 249);
        const name = t.game.seat(1).ownerUsername;
        const tab = t.w.user('se8-tab', name);
        hello(t.w, tab, SHOULDER);
        mainRoomHandlers.joinAsSpectator(tab, t.w.io, { gameId: t.game.gameId });
        expect(t.game.isSpectator(tab.id)).toBe(true);
        watch(t, tab, 1);
        t.w.kill(owner(t, 1)); // grace
        await reconnectHandlers.rejoinGame(tab, t.w.io, { gameId: t.game.gameId, username: name });
        expect(t.game.seat(1).ownerSocketId).toBe(tab.id);
        expect(t.game.shoulders.has(tab.id)).toBe(false);
        noStale(t);
        await Promise.all(t.pending);
    });

    test('the game\'s end clears every watch (retire)', async () => {
        const { t } = await watching('se9', 250);
        const game = t.game;
        gameLifecycle.abortGame(t.w.io, game, 'test');
        expect(game.shoulders.size).toBe(0);
        await Promise.all(t.pending);
    });

    const refusalOf2 = (got) => got.find((l) => l.event === 'watchHandRefused')?.data.reason;
});
