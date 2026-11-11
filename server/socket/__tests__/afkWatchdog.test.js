/**
 * The turn watchdog (owner, 2026-11-11: "turn timeout seems fine"): a
 * connected human who sits on their bid or play for AFK_TIMEOUT_MS (90 s,
 * every game, tournaments too) goes lazy exactly as with /lazy, announced
 * in the game log. Never during grace/disconnect, never for bot or lazy
 * seats; cleared by the seat's action, a turn change, /lazy, /active,
 * disconnect and abort. AFK_TIMEOUT_MS=0 disables it.
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
const afkLine = (log, name) => events(log, 'gameLogEntry').filter((e) => e.data.message.startsWith(`${name} was idle`));
let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.AFK_TIMEOUT_MS;
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    delete process.env.AFK_TIMEOUT_MS;
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

    test('/active returns the seat; back on its turn it gets a fresh 90 s', async () => {
        process.env.AFK_TIMEOUT_MS = '5000';
        const t = setup({ stage: Phase.PLAYING });
        // Hold the lazy bot: /active lands while the turn is still seat 1's
        await jest.advanceTimersByTimeAsync(5000);
        expect(t.game.seat(1).controller).toBe('lazyBot');
        chatHandlers.chatMessage(t.sockets[0], t.io, { message: '/active' });
        expect(t.game.seat(1).controller).toBe('human');
        expect(events(t.log, 'playerActiveMode')).toHaveLength(1);
        expect(t.game.currentTurn).toBe(1);
        expect(t.game.hasTimer('afk:1')).toBe(true);
        await jest.advanceTimersByTimeAsync(4999);
        expect(t.game.seat(1).controller).toBe('human');
        await jest.advanceTimersByTimeAsync(1);
        expect(t.game.seat(1).controller).toBe('lazyBot');
        expect(afkLine(t.log, t.names[0])).toHaveLength(2);
    });

    test('a tournament table: every game, tournaments included', async () => {
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

    test('a reconnect on its own turn starts a fresh watchdog', async () => {
        const t = setup();
        await queueHandlers.handleDisconnect(t.sockets[0], t.io);
        await jest.advanceTimersByTimeAsync(10000);
        mockDb.current.users.docs.find((d) => d.username === t.names[0]).sessionToken = 'tok';
        const again = makeSocket(`${t.ids[0]}-again`, t.log, t.io);
        await reconnectHandlers.rejoinGame(again, t.io, { gameId: t.game.gameId, username: t.names[0], sessionToken: 'tok' });
        expect(t.game.seat(1).presence).toBe('connected');
        expect(t.game.hasTimer('afk:1')).toBe(true);
        await jest.advanceTimersByTimeAsync(AFK - 1);
        expect(t.game.seat(1).controller).toBe('human');
        await jest.advanceTimersByTimeAsync(1);
        expect(t.game.seat(1).controller).toBe('lazyBot');
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
