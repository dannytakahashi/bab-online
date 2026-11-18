/**
 * The turn watchdog (owner, 2026-11-11: "turn timeout seems fine"): a
 * connected human who sits on their bid or play for AFK_TIMEOUT_MS (90 s,
 * every game with another human, tournaments too; never a solo casual
 * game, owner 2026-11-13) goes lazy exactly as with /lazy, announced
 * in the game log. Never during grace/disconnect, never for bot or lazy
 * seats; cleared by the seat's action, a turn change, /lazy, /active,
 * disconnect and abort. AFK_TIMEOUT_MS=0 disables it. /active on the same
 * turn resumes its clock (no fresh 90 s). At a tournament table with
 * another owner present the others are offered the seat instead (owner,
 * 2026-11-15).
 *
 * These cases idle human BID turns for 90 s to test the watchdog itself, so
 * the bid clock (socket/bidClock.js: bids 0 after 40 s, which ends the turn
 * and its watchdog) is off for this file (BID_CLOCK=off). How the two meet
 * with the clock on (defaults: the clock always bids first; the strike
 * rule) is in bidClock.test.js.
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
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const gameLifecycle = require('../gameLifecycle');
const tournamentHandlers = require('../tournamentHandlers');
const SeatState = require('../../game/SeatState');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events, legalCards } = require('../../testUtils/gameDriver');
const { setupTournament, liveTables, advanceUntil } = require('../../testUtils/tournamentDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
const AFK = SeatState.AFK_TIMEOUT_MS;
const TOP_UP = SeatState.AFK_RESUME_MIN_MS;
const afkLine = (log, name) => events(log, 'gameLogEntry').filter((e) => e.data.message.startsWith(`${name} was idle`));
let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.AFK_TIMEOUT_MS;
    process.env.BID_CLOCK = 'off';
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    delete process.env.AFK_TIMEOUT_MS;
    delete process.env.BID_CLOCK;
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/**
 * Four human seats on a 2-card hand. `stage` BIDDING (seat 1 to bid) or
 * PLAYING (seat 1 to lead, bids in). The turn is opened the way the server
 * opens it: updateTurn + triggerBotIfNeeded.
 */
function setup({ stage = Phase.BIDDING } = {}) {
    seq++;
    const log = [];
    const io = makeIo(log);
    const ids = [1, 2, 3, 4].map((n) => `afk${seq}-h${n}`);
    const names = ids.map((id, i) => `u${seq}_${i + 1}`);
    ids.forEach((id, i) => {
        gameManager.registerUser(id, names[i]);
        mockDb.current.users._insert({ username: names[i], profilePic: i + 1 });
    });
    const sockets = ids.map((id) => makeSocket(id, log, io));
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, names[i], i + 1, i + 1, false));
    sockets.forEach((s) => s.join(game.roomName));
    game.currentHand = 2;
    const hands = [
        [C('2', 'hearts'), C('3', 'hearts')],
        [C('4', 'hearts'), C('5', 'hearts')],
        [C('6', 'hearts'), C('7', 'hearts')],
        [C('8', 'hearts'), C('9', 'hearts')],
    ];
    ids.forEach((id, i) => game.setHand(id, hands[i]));
    game.trump = C('A', 'spades');
    game.bidder = 1;
    game.dealSeq = 1;
    game.currentTurn = 1;
    if (stage === Phase.PLAYING) {
        game.forcePhase('PLAYING');
        game.bids = { team1: 1, team2: 1 };
        game.playerBids = ['1', '0', '0', '1'];
        game.leadPosition = 1;
        gameHandlers.triggerBotIfNeeded(io, game, 'play');
    } else {
        game.forcePhase('BIDDING');
        game.playerBids = [];
        gameHandlers.triggerBotIfNeeded(io, game, 'bid');
    }
    return { log, io, game, ids, names, sockets };
}

describe('config', () => {
    test('90 s by default; AFK_TIMEOUT_MS overrides, 0 disables, garbage keeps the default', () => {
        expect(AFK).toBe(90000);
        expect(SeatState.afkTimeoutMs({})).toBe(90000);
        expect(SeatState.afkTimeoutMs({ AFK_TIMEOUT_MS: '5000' })).toBe(5000);
        expect(SeatState.afkTimeoutMs({ AFK_TIMEOUT_MS: '0' })).toBe(0);
        expect(SeatState.afkTimeoutMs({ AFK_TIMEOUT_MS: '-3' })).toBe(90000);
        expect(SeatState.afkTimeoutMs({ AFK_TIMEOUT_MS: 'soon' })).toBe(90000);
    });
});

describe('the watchdog fires', () => {
    test('at 90 s on a bid: the seat goes lazy (same events as /lazy), announced, and the bot bids', async () => {
        const t = setup();
        expect(t.game.hasTimer('afk:1')).toBe(true);
        await jest.advanceTimersByTimeAsync(AFK - 1);
        expect(t.game.seat(1).controller).toBe('human');
        expect(events(t.log, 'playerLazyMode')).toHaveLength(0);

        await jest.advanceTimersByTimeAsync(1);
        const seat = t.game.seat(1);
        expect(seat.controller).toBe('lazyBot');
        expect(seat.presence).toBe('connected');
        expect(seat.ownerSocketId).toBe(t.ids[0]);
        expect(seat.ownerView).toBe('seat');
        const lazy = events(t.log, 'playerLazyMode');
        expect(lazy).toHaveLength(1);
        expect(lazy[0]).toMatchObject({ to: t.game.roomName, data: { position: 1, originalUsername: t.names[0] } });
        const line = afkLine(t.log, t.names[0]);
        expect(line).toHaveLength(1);
        expect(line[0].data.message).toBe(`${t.names[0]} was idle and ${seat.bot.username} is playing for them. Type /active to return.`);
        expect(t.game.gameLog.some((e) => e.message === line[0].data.message)).toBe(true);

        // The bot bids for the seat (its think time), and the turn moves on
        await jest.advanceTimersByTimeAsync(5000);
        expect(t.game.playerBids[0]).toBeDefined();
        expect(events(t.log, 'bidReceived')[0].data.position).toBe(1);
        expect(t.game.currentTurn).toBe(2);
        // The next human's own watchdog runs from its turn
        expect(t.game.hasTimer('afk:2')).toBe(true);
        expect(t.game.hasTimer('afk:1')).toBe(false);
    });

    test('on a play too, and a late play from the owner is refused (the bot holds the seat)', async () => {
        const t = setup({ stage: Phase.PLAYING });
        expect(t.game.hasTimer('afk:1')).toBe(true);
        await jest.advanceTimersByTimeAsync(AFK);
        expect(t.game.seat(1).controller).toBe('lazyBot');
        const mark = t.log.length;
        await gameHandlers.playCard(t.sockets[0], t.io, { card: C('2', 'hearts') });
        expect(events(t.log.slice(mark), 'actionRejected')).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(5000);
        expect(events(t.log, 'cardPlayed')[0].data.position).toBe(1);
    });

    test('/active returns the seat; on the same turn the used-up clock gets one short top-up, not a fresh one', async () => {
        const t = setup({ stage: Phase.PLAYING });
        // /active lands while the turn is still seat 1's (before the lazy bot plays)
        await jest.advanceTimersByTimeAsync(AFK);
        expect(t.game.seat(1).controller).toBe('lazyBot');
        chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/active' });
        expect(t.game.seat(1).controller).toBe('human');
        expect(events(t.log, 'playerActiveMode')).toHaveLength(1);
        expect(t.game.currentTurn).toBe(1);
        expect(t.game.hasTimer('afk:1')).toBe(true);
        // Nothing was left of this turn's 90 s: the top-up, so the player can act
        await jest.advanceTimersByTimeAsync(TOP_UP - 1);
        expect(t.game.seat(1).controller).toBe('human');
        await jest.advanceTimersByTimeAsync(1);
        expect(t.game.seat(1).controller).toBe('lazyBot');
        expect(afkLine(t.log, t.names[0])).toHaveLength(2);
        // Only once per turn: a second /active gets what is left, nothing
        chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/active' });
        expect(t.game.seat(1).controller).toBe('human');
        await jest.advanceTimersByTimeAsync(0);
        expect(t.game.seat(1).controller).toBe('lazyBot');
        expect(afkLine(t.log, t.names[0])).toHaveLength(3);
    });

    test('/lazy then /active cannot reset the clock: the turn keeps what is left of its 90 s', async () => {
        const t = setup();
        await jest.advanceTimersByTimeAsync(60000);
        chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/lazy' });
        // /active before the bot's bid lands: still seat 1's turn
        chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/active' });
        expect(t.game.seat(1).controller).toBe('human');
        expect(t.game.currentTurn).toBe(1);
        expect(t.game.getBidCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(AFK - 60000 - 1);
        expect(t.game.seat(1).controller).toBe('human');
        await jest.advanceTimersByTimeAsync(1);
        expect(t.game.seat(1).controller).toBe('lazyBot');
        expect(afkLine(t.log, t.names[0])).toHaveLength(1);
    });

    test('repeating /lazy then /active near the end buys one top-up per turn, no more', async () => {
        const t = setup();
        await jest.advanceTimersByTimeAsync(AFK - 1000);
        for (let i = 0; i < 3; i++) {
            chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/lazy' });
            chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/active' });
        }
        expect(t.game.seat(1).controller).toBe('human');
        // 1 s was left: topped up to TOP_UP once (the later rounds keep that deadline)
        await jest.advanceTimersByTimeAsync(TOP_UP - 1);
        expect(t.game.seat(1).controller).toBe('human');
        await jest.advanceTimersByTimeAsync(1);
        expect(t.game.seat(1).controller).toBe('lazyBot');
    });

    test('after /lazy then /active, the seat\'s next turn gets the full 90 s', async () => {
        const t = setup();
        await jest.advanceTimersByTimeAsync(80000);
        chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/lazy' });
        chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/active' });
        expect(t.game.seat(1).controller).toBe('human');
        await gameHandlers.playerBid(t.sockets[0], t.io, { bid: '1' });
        for (const i of [1, 2, 3]) await gameHandlers.playerBid(t.sockets[i], t.io, { bid: '0' });
        await advanceUntil(() => t.game.stage === Phase.PLAYING && t.game.acceptsTurnInput() && !t.game.resume, 100, 30000);
        // Play opens with seat 1 (the high bid): a new turn, a new clock
        expect(t.game.currentTurn).toBe(1);
        expect(t.game.hasTimer('afk:1')).toBe(true);
        await jest.advanceTimersByTimeAsync(AFK - 1000);
        expect(t.game.seat(1).controller).toBe('human');
    });

    test('a tournament table with no other human to ask: lazy, as before (the round waits for every table)', async () => {
        const ctx = await setupTournament(1);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.entrants === null), 100, 120000);
        await ctx.starting;
        const [table] = liveTables(ctx.t);
        expect(gameManager.tournamentGames.get(table.gameId)).toBe(ctx.t.tournamentId);
        const pos = table.seatByOwnerSocket(ctx.sockets[0].id);
        // Its turn is open (not the first-hand hold, whose updateTurn comes after it)
        await advanceUntil(() => table.acceptsTurnInput() && table.currentTurn === pos && !table.resume, 100, 120000);
        expect(table.hasTimer(`afk:${pos}`)).toBe(true);
        await jest.advanceTimersByTimeAsync(AFK);
        expect(table.seat(pos).controller).toBe('lazyBot');
        expect(afkLine(ctx.log, ctx.usernames[0])).toHaveLength(1);
    });
});

describe('a solo casual game (owner, 2026-11-13: no 90 s boot when only bots wait)', () => {
    /** Seat 1 human, seats 2-4 native bots (the 1 human + 3 bots lobby game). */
    function setupSolo({ humans = 1 } = {}) {
        const ctx = setup();
        for (let pos = humans + 1; pos <= 4; pos++) {
            ctx.game.forceSeat(pos, { controller: 'bot', bot: { socketId: `bot:Solo${pos}:${seq}`, username: `🤖 Solo${pos}`, pic: pos, personality: 'mary' } });
        }
        gameHandlers.triggerBotIfNeeded(ctx.io, ctx.game, 'bid');
        return ctx;
    }

    test('one human with three bots: never armed, and the seat stays human past 90 s', async () => {
        const { log, game, names } = setupSolo();
        expect(game.currentTurn).toBe(1);
        expect(game.hasTimer('afk:1')).toBe(false);
        await jest.advanceTimersByTimeAsync(AFK * 3);
        expect(game.seat(1).controller).toBe('human');
        expect(afkLine(log, names[0])).toHaveLength(0);
    });

    test('two humans with two bots: still armed, and it fires at 90 s', async () => {
        const { log, game, names } = setupSolo({ humans: 2 });
        expect(game.hasTimer('afk:1')).toBe(true);
        await jest.advanceTimersByTimeAsync(AFK);
        expect(game.seat(1).controller).toBe('lazyBot');
        expect(afkLine(log, names[0])).toHaveLength(1);
    });
});

/**
 * Idle seat at a tournament table (owner, 2026-11-15): no automatic
 * takeover while another owner is here. The watchdog sends the existing
 * resign offer (resignationAvailable, privately, idle: true) to the OTHER
 * present owners, any of whom may forceResign the seat; the idle owner
 * acting first takes it down (playerReconnected, room-wide).
 */
describe('an idle seat at a tournament table', () => {
    const mapped = [];
    afterEach(() => {
        for (const id of mapped.splice(0)) gameManager.tournamentGames.delete(id);
    });
    function setupT(opts) {
        const t = setup(opts);
        gameManager.tournamentGames.set(t.game.gameId, `afk-t${seq}`);
        mapped.push(t.game.gameId);
        return t;
    }
    const offers = (log) => events(log, 'resignationAvailable');
    const idleLine = (log, name) => events(log, 'gameLogEntry').filter((e) => e.data.message === `${name} seems idle. You may replace them with a bot.`);
    const errors = (log) => events(log, 'serverError').map((e) => e.data.message);

    test('at 90 s the other present owners (only) get the offer; the seat stays human', async () => {
        const t = setupT();
        await jest.advanceTimersByTimeAsync(AFK - 1);
        expect(offers(t.log)).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(1);
        expect(t.game.seat(1).controller).toBe('human');
        expect(events(t.log, 'playerLazyMode')).toHaveLength(0);
        const sent = offers(t.log);
        expect(sent.map((e) => e.to).sort()).toEqual([t.ids[1], t.ids[2], t.ids[3]].sort());
        for (const e of sent) expect(e.data).toEqual({ position: 1, username: t.names[0], idle: true });
        // never to the idle owner or the room (spectators)
        expect(sent.some((e) => e.to === t.ids[0] || e.to === `self:${t.ids[0]}` || e.to === t.game.roomName)).toBe(false);
        expect(idleLine(t.log, t.names[0])).toHaveLength(1);
        expect(t.game.gameLog.some((e) => e.message === `${t.names[0]} seems idle. You may replace them with a bot.`)).toBe(true);
        expect(t.game.idleOffer).toMatchObject({ pos: 1 });
        // the offer does not change the seat: snapshots still show it connected
        expect(t.game.seat(1).presence).toBe('connected');
    });

    test('another owner confirms: forceResign puts a bot on the seat (the owner watches and may /active back)', async () => {
        const t = setupT();
        await jest.advanceTimersByTimeAsync(AFK);
        // the idle owner cannot take its own offer
        await gameHandlers.forceResign(t.sockets[0], t.io, { position: 1 });
        expect(t.game.seat(1).controller).toBe('human');
        const mark = t.log.length;
        await gameHandlers.forceResign(t.sockets[2], t.io, { position: 1 });
        const seat = t.game.seat(1);
        expect(seat).toMatchObject({ controller: 'lazyBot', presence: 'connected', ownerSocketId: t.ids[0], ownerView: 'seat' });
        const after = t.log.slice(mark).map((e) => e.event).filter((e) => ['playerReconnected', 'playerLazyMode', 'playerResigned'].includes(e));
        // the offer comes down first (iOS 1.2.0 keeps an offer through playerLazyMode)
        expect(after).toEqual(['playerReconnected', 'playerLazyMode']);
        expect(events(t.log.slice(mark), 'playerReconnected')[0]).toMatchObject({ to: t.game.roomName, data: { position: 1, username: t.names[0] } });
        expect(events(t.log, 'gameLogEntry').some((e) => e.data.message === `${t.names[0]} was idle and has been replaced. ${seat.bot.username} is playing for them. Type /active to return.`)).toBe(true);
        expect(t.game.idleOffer).toBeNull();
        // a second confirm (another holder) is refused: nothing is offered now
        await gameHandlers.forceResign(t.sockets[3], t.io, { position: 1 });
        expect(errors(t.log).slice(-1)).toEqual(['Player is not disconnected']);
        // the bot bids for the seat
        await jest.advanceTimersByTimeAsync(5000);
        expect(events(t.log, 'bidReceived')[0].data.position).toBe(1);
    });

    test('the idle owner acts first: the offer is withdrawn, the game goes on and a late confirm is refused', async () => {
        const t = setupT();
        await jest.advanceTimersByTimeAsync(AFK + 2000);
        const mark = t.log.length;
        await gameHandlers.playerBid(t.sockets[0], t.io, { bid: '1' });
        const names = t.log.slice(mark).map((e) => e.event);
        expect(names.indexOf('playerReconnected')).toBeGreaterThan(-1);
        expect(names.indexOf('playerReconnected')).toBeLessThan(names.indexOf('bidReceived'));
        expect(events(t.log.slice(mark), 'playerReconnected')[0]).toMatchObject({ to: t.game.roomName, data: { position: 1 } });
        expect(t.game.idleOffer).toBeNull();
        expect(t.game.currentTurn).toBe(2);
        await gameHandlers.forceResign(t.sockets[1], t.io, { position: 1 });
        expect(errors(t.log)).toEqual(['Player is not disconnected']);
        expect(t.game.seat(1).controller).toBe('human');
        expect(events(t.log, 'playerLazyMode')).toHaveLength(0);
        // nothing further is offered for seat 1
        await jest.advanceTimersByTimeAsync(10000);
        expect(offers(t.log).filter((e) => e.data.position === 1)).toHaveLength(3);
    });

    test('still idle: asked again every 90 s (one log line), and never auto-replaced', async () => {
        const t = setupT();
        await jest.advanceTimersByTimeAsync(AFK * 3);
        expect(offers(t.log)).toHaveLength(9);
        expect(idleLine(t.log, t.names[0])).toHaveLength(1);
        expect(t.game.seat(1).controller).toBe('human');
    });

    test('a lazy owner watching their bot is present: it is offered the seat and may confirm', async () => {
        const t = setupT();
        chatHandlers.chatMessage(t.sockets[1], t.io, { message: '/lazy' });
        await jest.advanceTimersByTimeAsync(AFK);
        expect(offers(t.log).map((e) => e.to)).toContain(t.ids[1]);
        await gameHandlers.forceResign(t.sockets[1], t.io, { position: 1 });
        expect(t.game.seat(1).controller).toBe('lazyBot');
    });

    test('no other human present (bots, or owners disconnected): no offer, lazy as before', async () => {
        const t = setupT();
        for (const i of [1, 2, 3]) {
            t.io.sockets.sockets.delete(t.ids[i]);
            await queueHandlers.handleDisconnect(t.sockets[i], t.io);
        }
        // their grace runs out after 60 s; seat 1 is still here, so it gets their offers
        await jest.advanceTimersByTimeAsync(AFK);
        expect(offers(t.log).every((e) => e.data.position !== 1)).toBe(true);
        expect(t.game.seat(1).controller).toBe('lazyBot');
        expect(afkLine(t.log, t.names[0])).toHaveLength(1);
        expect(idleLine(t.log, t.names[0])).toHaveLength(0);
    });

    test('a disconnected seat\'s standing offer goes first (clients hold one offer)', async () => {
        const t = setupT();
        t.io.sockets.sockets.delete(t.ids[3]);
        await queueHandlers.handleDisconnect(t.sockets[3], t.io);
        await jest.advanceTimersByTimeAsync(AFK);
        // seat 4 became resignable at 60 s and is offered room-wide; seat 1 is not offered
        expect(offers(t.log).map((e) => e.data.position)).toEqual([4]);
        expect(t.game.idleOffer).toBeNull();
        await gameHandlers.forceResign(t.sockets[1], t.io, { position: 4 });
        expect(t.game.seat(4).controller).toBe('resignBot');
        // seat 1 is still idle: offered at the next ask
        await jest.advanceTimersByTimeAsync(AFK);
        expect(offers(t.log).filter((e) => e.data.position === 1).map((e) => e.to).sort()).toEqual([t.ids[1], t.ids[2]].sort());
    });

    test('a seat going resignable while an idle offer stands replaces it on the clients', async () => {
        const t = setupT();
        await jest.advanceTimersByTimeAsync(40000);
        t.io.sockets.sockets.delete(t.ids[3]);
        await queueHandlers.handleDisconnect(t.sockets[3], t.io);
        await jest.advanceTimersByTimeAsync(AFK - 40000);
        expect(t.game.idleOffer).toMatchObject({ pos: 1 });
        const mark = t.log.length;
        await jest.advanceTimersByTimeAsync(40000); // seat 4's grace ends at 100 s
        const seen = t.log.slice(mark).filter((e) => ['playerReconnected', 'resignationAvailable'].includes(e.event)).map((e) => `${e.event}:${e.data.position}`);
        expect(seen).toEqual(['playerReconnected:1', 'resignationAvailable:4']);
        expect(t.game.idleOffer).toBeNull();
        expect(t.game.offerPos).toBe(4);
    });

    test('the idle owner dropping withdraws the offer; the grace path takes over', async () => {
        const t = setupT();
        await jest.advanceTimersByTimeAsync(AFK);
        const mark = t.log.length;
        t.io.sockets.sockets.delete(t.ids[0]);
        await queueHandlers.handleDisconnect(t.sockets[0], t.io);
        const seen = t.log.slice(mark).filter((e) => ['playerReconnected', 'playerDisconnected'].includes(e.event)).map((e) => e.event);
        expect(seen).toEqual(['playerReconnected', 'playerDisconnected']);
        expect(t.game.idleOffer).toBeNull();
        await gameHandlers.forceResign(t.sockets[1], t.io, { position: 1 });
        expect(errors(t.log)).toEqual(['Player is still reconnecting']);
    });

    test('/lazy then /active cannot dodge it: the offer comes back after the one short top-up', async () => {
        const t = setupT();
        await jest.advanceTimersByTimeAsync(AFK);
        chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/lazy' });
        expect(t.game.idleOffer).toBeNull();
        chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/active' });
        expect(t.game.seat(1).controller).toBe('human');
        await jest.advanceTimersByTimeAsync(TOP_UP - 1);
        expect(t.game.idleOffer).toBeNull();
        expect(offers(t.log)).toHaveLength(3);
        await jest.advanceTimersByTimeAsync(1);
        expect(t.game.idleOffer).toMatchObject({ pos: 1 });
        expect(offers(t.log)).toHaveLength(6);
    });

    test('dropping and coming back cannot dodge it either: the reconnect resumes the used-up clock', async () => {
        const t = setupT();
        await jest.advanceTimersByTimeAsync(AFK);
        expect(offers(t.log)).toHaveLength(3);
        t.io.sockets.sockets.delete(t.ids[0]);
        await queueHandlers.handleDisconnect(t.sockets[0], t.io);
        await jest.advanceTimersByTimeAsync(5000);
        mockDb.current.users.docs.find((d) => d.username === t.names[0]).sessionToken = 'tok';
        const again = makeSocket(`${t.ids[0]}-again`, t.log, t.io);
        await reconnectHandlers.rejoinGame(again, t.io, { gameId: t.game.gameId, username: t.names[0], sessionToken: 'tok' });
        expect(t.game.seat(1)).toMatchObject({ controller: 'human', presence: 'connected' });
        await jest.advanceTimersByTimeAsync(TOP_UP - 1);
        expect(t.game.idleOffer).toBeNull();
        await jest.advanceTimersByTimeAsync(1);
        expect(t.game.idleOffer).toMatchObject({ pos: 1 });
        expect(offers(t.log)).toHaveLength(6);
    });

    test('a stale idle offer (an earlier turn) does not let forceResign take the seat', async () => {
        const t = setupT();
        await jest.advanceTimersByTimeAsync(AFK);
        // Left behind without its withdrawal: it names a turn that is over
        t.game.idleOffer = { pos: 1, turn: 'an-earlier-turn' };
        await gameHandlers.forceResign(t.sockets[1], t.io, { position: 1 });
        expect(errors(t.log)).toEqual(['Player is not disconnected']);
        expect(t.game.seat(1).controller).toBe('human');
        expect(events(t.log, 'playerLazyMode')).toHaveLength(0);
    });

    test('a holder who comes back gets the standing offer replayed', async () => {
        const t = setupT();
        await jest.advanceTimersByTimeAsync(50000);
        t.io.sockets.sockets.delete(t.ids[1]);
        await queueHandlers.handleDisconnect(t.sockets[1], t.io);
        await jest.advanceTimersByTimeAsync(AFK - 50000);
        expect(offers(t.log).map((e) => e.to).sort()).toEqual([t.ids[2], t.ids[3]].sort());
        mockDb.current.users.docs.find((d) => d.username === t.names[1]).sessionToken = 'tok';
        const again = makeSocket(`${t.ids[1]}-again`, t.log, t.io);
        await reconnectHandlers.rejoinGame(again, t.io, { gameId: t.game.gameId, username: t.names[1], sessionToken: 'tok' });
        expect(events(t.log, 'resignationAvailable').filter((e) => e.to === `self:${again.id}`).map((e) => e.data))
            .toEqual([{ position: 1, username: t.names[0], idle: true }]);
        await gameHandlers.forceResign(again, t.io, { position: 1 });
        expect(t.game.seat(1).controller).toBe('lazyBot');
    });

    test('a real tournament: two humans and two filler bots at one table', async () => {
        const ctx = await setupTournament(2);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.entrants === null), 100, 120000);
        await ctx.starting;
        const [table] = liveTables(ctx.t);
        const [a, b] = ctx.sockets;
        const posA = table.seatByOwnerSocket(a.id);
        const posB = table.seatByOwnerSocket(b.id);
        expect(posA && posB).toBeTruthy();
        // b acts on its own turns at once; a sits on its first turn
        for (let i = 0; i < 2000 && !table.idleOffer; i++) {
            if (table.acceptsTurnInput() && table.currentTurn === posB && !table.resume) {
                if (table.stage === Phase.BIDDING) await gameHandlers.playerBid(b, ctx.io, { bid: '0' });
                else await gameHandlers.playCard(b, ctx.io, { card: legalCards(table, b.id)[0] });
            }
            await jest.advanceTimersByTimeAsync(500);
        }
        expect(table.isTerminal()).toBe(false);
        expect(table.idleOffer).toMatchObject({ pos: posA });
        const sent = events(ctx.log, 'resignationAvailable').filter((e) => e.data.position === posA);
        expect(sent.map((e) => e.to)).toEqual([b.id]);
        expect(table.seat(posA).controller).toBe('human');
        await gameHandlers.forceResign(b, ctx.io, { position: posA });
        expect(table.seat(posA)).toMatchObject({ controller: 'lazyBot', presence: 'connected', ownerUsername: ctx.usernames[0] });
    });

    test('a casual table is unchanged: lazy at 90 s, no offer', async () => {
        const t = setup();
        await jest.advanceTimersByTimeAsync(AFK);
        expect(offers(t.log)).toHaveLength(0);
        expect(t.game.seat(1).controller).toBe('lazyBot');
    });
});

describe('the watchdog does not fire', () => {
    test('an action at 89 s: the seat stays human and the next seat starts its own 90 s', async () => {
        const t = setup();
        await jest.advanceTimersByTimeAsync(AFK - 1000);
        await gameHandlers.playerBid(t.sockets[0], t.io, { bid: '1' });
        expect(t.game.hasTimer('afk:1')).toBe(false);
        expect(t.game.hasTimer('afk:2')).toBe(true);
        await jest.advanceTimersByTimeAsync(AFK - 1);
        expect(t.game.seat(1).controller).toBe('human');
        expect(t.game.seat(2).controller).toBe('human');
        await jest.advanceTimersByTimeAsync(1);
        expect(t.game.seat(1).controller).toBe('human');
        expect(t.game.seat(2).controller).toBe('lazyBot');
    });

    test('a play at 89 s counts too', async () => {
        const t = setup({ stage: Phase.PLAYING });
        await jest.advanceTimersByTimeAsync(AFK - 1000);
        await gameHandlers.playCard(t.sockets[0], t.io, { card: legalCards(t.game, t.ids[0])[0] });
        await jest.advanceTimersByTimeAsync(2000);
        expect(t.game.seat(1).controller).toBe('human');
        expect(events(t.log, 'playerLazyMode')).toHaveLength(0);
    });

    test('a rejected action does not reset the clock', async () => {
        const t = setup();
        await jest.advanceTimersByTimeAsync(AFK - 1000);
        await gameHandlers.playerBid(t.sockets[0], t.io, { bid: '9' }); // more than the hand
        expect(events(t.log, 'actionRejected')).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(1000);
        expect(t.game.seat(1).controller).toBe('lazyBot');
    });

    test('during grace: a disconnect clears it and the grace timers take over', async () => {
        const t = setup();
        await jest.advanceTimersByTimeAsync(1000);
        await queueHandlers.handleDisconnect(t.sockets[0], t.io);
        expect(t.game.seat(1).presence).toBe('grace');
        expect(t.game.hasTimer('afk:1')).toBe(false);
        await jest.advanceTimersByTimeAsync(AFK + 1000);
        expect(t.game.seat(1).controller).toBe('human');
        expect(t.game.seat(1).presence).toBe('resignable');
        expect(events(t.log, 'playerLazyMode')).toHaveLength(0);
    });

    test('a reconnect on its own turn resumes that turn\'s clock (the time away counts)', async () => {
        const t = setup();
        await queueHandlers.handleDisconnect(t.sockets[0], t.io);
        await jest.advanceTimersByTimeAsync(10000);
        mockDb.current.users.docs.find((d) => d.username === t.names[0]).sessionToken = 'tok';
        const again = makeSocket(`${t.ids[0]}-again`, t.log, t.io);
        await reconnectHandlers.rejoinGame(again, t.io, { gameId: t.game.gameId, username: t.names[0], sessionToken: 'tok' });
        expect(t.game.seat(1).presence).toBe('connected');
        expect(t.game.hasTimer('afk:1')).toBe(true);
        await jest.advanceTimersByTimeAsync(AFK - 10000 - 1);
        expect(t.game.seat(1).controller).toBe('human');
        await jest.advanceTimersByTimeAsync(1);
        expect(t.game.seat(1).controller).toBe('lazyBot');
    });

    test('a reconnect on a later turn of the same seat starts a fresh clock', async () => {
        const t = setup();
        await jest.advanceTimersByTimeAsync(AFK - 1000);
        await gameHandlers.playerBid(t.sockets[0], t.io, { bid: '1' });
        // Seat 2 bids, then seat 1 is not on turn again until play: drop and return mid-bidding
        await queueHandlers.handleDisconnect(t.sockets[0], t.io);
        for (const i of [1, 2, 3]) await gameHandlers.playerBid(t.sockets[i], t.io, { bid: '0' });
        mockDb.current.users.docs.find((d) => d.username === t.names[0]).sessionToken = 'tok';
        const again = makeSocket(`${t.ids[0]}-again`, t.log, t.io);
        await reconnectHandlers.rejoinGame(again, t.io, { gameId: t.game.gameId, username: t.names[0], sessionToken: 'tok' });
        await advanceUntil(() => t.game.stage === Phase.PLAYING && t.game.acceptsTurnInput() && !t.game.resume, 100, 30000);
        expect(t.game.currentTurn).toBe(1);
        await jest.advanceTimersByTimeAsync(AFK - 1000);
        expect(t.game.seat(1).controller).toBe('human');
    });

    test('for a lazy seat or a native bot seat', async () => {
        const t = setup();
        chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/lazy' });
        expect(t.game.seat(1).controller).toBe('lazyBot');
        expect(t.game.hasTimer('afk:1')).toBe(false);
        expect(afkLine(t.log, t.names[0])).toHaveLength(0);
        for (let p = 1; p <= 4; p++) {
            if (t.game.seat(p).controller !== 'human') continue;
            chatHandlers.chatMessage(t.sockets[p - 1], t.io, { message: '/lazy' });
        }
        // All four seats are bots now: no watchdog at any turn
        for (let i = 0; i < 40; i++) {
            await jest.advanceTimersByTimeAsync(1000);
            for (let p = 1; p <= 4; p++) expect(t.game.hasTimer(`afk:${p}`)).toBe(false);
        }
        // The bots did take those turns. Counted from the emitted bids, not
        // game.getBidCount(): after 40 s the hand may sit between deals with
        // its bids already cleared.
        const bidPositions = new Set(events(t.log, 'bidReceived').map((e) => e.data.position));
        expect([...bidPositions].sort()).toEqual([1, 2, 3, 4]);
        expect(afkLine(t.log, t.names[0])).toHaveLength(0);
        expect(events(t.log, 'playerLazyMode')).toHaveLength(4);
    });

    test('after an abort (and nothing follows it)', async () => {
        const t = setup();
        await gameLifecycle.abortGame(t.io, t.game, 'test');
        expect(t.game.pendingTimerCount).toBe(0);
        const mark = t.log.length;
        await jest.advanceTimersByTimeAsync(AFK * 2);
        expect(events(t.log.slice(mark), 'playerLazyMode')).toHaveLength(0);
        expect(t.game.seat(1).controller).toBe('human');
    });

    test('while a trick resolves (no turn is open)', async () => {
        const t = setup({ stage: Phase.PLAYING });
        for (let i = 0; i < 4; i++) {
            const sid = t.game.positions[t.game.currentTurn];
            await gameHandlers.playCard(t.sockets[t.ids.indexOf(sid)], t.io, { card: legalCards(t.game, sid)[0] });
        }
        expect(t.game.stage).toBe(Phase.TRICK_RESOLVING);
        for (let p = 1; p <= 4; p++) expect(t.game.hasTimer(`afk:${p}`)).toBe(false);
        // The trick resumes and the winner's turn opens with its own watchdog
        await jest.advanceTimersByTimeAsync(5000);
        expect(t.game.stage).toBe(Phase.PLAYING);
        expect(t.game.hasTimer(`afk:${t.game.currentTurn}`)).toBe(true);
    });

    test('AFK_TIMEOUT_MS=0 disables it', async () => {
        process.env.AFK_TIMEOUT_MS = '0';
        const t = setup();
        expect(t.game.hasTimer('afk:1')).toBe(false);
        await jest.advanceTimersByTimeAsync(AFK * 3);
        expect(t.game.seat(1).controller).toBe('human');
    });
});

/**
 * Crediting at game end. An AFK takeover is the /lazy transition
 * (seatGoLazy, controller lazyBot), so the human owner is credited exactly
 * as after a manual /lazy: users.stats, the gameRecords entry (and so the
 * leaderboard and records pages, which read those) and tournament round
 * scores all go through getOriginalPlayer / ownerUsername. The gameEnd
 * score screen lists getPlayerByPosition, i.e. the bot persona at a seat a
 * bot holds at the end, for /lazy and AFK alike (unchanged behaviour).
 */
describe('crediting at game end: an AFK seat counts like a /lazy seat', () => {
    const SUIT13 = (suit) => ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'].map((r) => C(r, suit));
    const TRUMPS = [C('HI', 'joker'), C('LO', 'joker'), ...SUIT13('spades').filter((c) => c.rank !== '3')];

    /** The last (13-card) hand, four humans, seat 1 to bid; seat 1 goes AFK or /lazy, the others act at once. */
    async function playLastHand(how) {
        seq++;
        const log = [];
        const io = makeIo(log);
        const ids = [1, 2, 3, 4].map((n) => `afkend${seq}-h${n}`);
        const names = ids.map((id, i) => `e${seq}_${i + 1}`);
        ids.forEach((id, i) => {
            gameManager.registerUser(id, names[i]);
            mockDb.current.users._insert({ username: names[i], profilePic: i + 1, stats: { gamesPlayed: 0, wins: 0, losses: 0 } });
        });
        const sockets = ids.map((id) => makeSocket(id, log, io));
        const game = gameManager.createGame(ids);
        ids.forEach((id, i) => game.addPlayer(id, names[i], i + 1, i + 1, false));
        sockets.forEach((s) => s.join(game.roomName));
        game.currentHand = 13;
        [TRUMPS, SUIT13('hearts'), SUIT13('diamonds'), SUIT13('clubs')].forEach((h, i) => game.setHand(ids[i], h.map((c) => ({ ...c }))));
        game.trump = C('3', 'spades');
        game.bidder = 1;
        game.dealSeq = 1;
        game.currentTurn = 1;
        game.forcePhase('BIDDING');
        game.playerBids = [];
        gameHandlers.triggerBotIfNeeded(io, game, 'bid');

        if (how === 'lazy') chatHandlers.chatMessage(sockets[0], io, { message: '/lazy' });
        else await jest.advanceTimersByTimeAsync(AFK);
        expect(game.seat(1).controller).toBe('lazyBot');
        expect(afkLine(log, names[0])).toHaveLength(how === 'afk' ? 1 : 0);
        const botName = events(log, 'playerLazyMode')[0].data.botUsername;

        for (let guard = 0; guard < 2000 && events(log, 'gameEnd').length === 0; guard++) {
            const pos = game.currentTurn;
            if (game.acceptsTurnInput() && pos !== 1 && game.seat(pos).controller === 'human') {
                const sid = game.positions[pos];
                if (game.stage === Phase.BIDDING) await gameHandlers.playerBid(sockets[pos - 1], io, { bid: '0' });
                else await gameHandlers.playCard(sockets[pos - 1], io, { card: legalCards(game, sid)[0] });
            } else {
                await jest.advanceTimersByTimeAsync(500);
            }
        }
        const end = events(log, 'gameEnd');
        expect(end).toHaveLength(1);
        // recordGameStats runs after gameEnd, in the background
        for (let i = 0; i < 50 && mockDb.current.gameRecords.docs.length === 0; i++) await jest.advanceTimersByTimeAsync(10);
        for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(10);
        return { game, names, botName, end: end[0].data };
    }

    const user = (name) => mockDb.current.users.docs.find((d) => d.username === name);

    test.each(['afk', 'lazy'])('%s: the owner gets the stats and the game record; the bot persona gets nothing', async (how) => {
        const { game, names, botName, end } = await playLastHand(how);
        expect(game.seat(1).controller).toBe('lazyBot');
        expect(game.seat(1).ownerUsername).toBe(names[0]);
        expect(botName).toMatch(/^🤖 /);

        // Score screen: the persona at the seat the bot held at the end
        expect(end.playerStats[1].username).toBe(botName);
        expect(end.playerStats[2].username).toBe(names[1]);

        // users.stats (leaderboard): one game for every human owner, seat 1 included
        const team1Won = end.score.team1 > end.score.team2;
        for (const [i, name] of names.entries()) {
            const s = user(name).stats;
            expect({ name, gamesPlayed: s.gamesPlayed }).toEqual({ name, gamesPlayed: 1 });
            const won = (i % 2 === 0) === team1Won;
            if (end.score.team1 !== end.score.team2) expect({ name, wins: s.wins, losses: s.losses }).toEqual({ name, wins: won ? 1 : 0, losses: won ? 0 : 1 });
        }
        expect(mockDb.current.users.docs.some((d) => d.username === botName)).toBe(false);

        // gameRecords (records page): the owner's name, never the bot's
        const [rec] = mockDb.current.gameRecords.docs;
        expect(rec.gameId).toBe(game.gameId);
        expect(rec.team1Players).toEqual([names[0], names[2]]);
        expect(rec.team2Players).toEqual([names[1], names[3]]);
    });
});
