/**
 * The bid clock (owner, 2026-11-18; socket/bidClock.js): a human-controlled
 * seat that has not bid 10 s into its bid turn gets a 30 s clock (room event
 * `bidClock`, unsequenced; the tune plays at the table); when it runs out
 * the server bids '0' for the seat through the normal bid path, after the
 * room line "<name> ran out of time.". Real lobby / tournament games over
 * the real handlers, fake timers, the contract guard on every emit.
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
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const gameLifecycle = require('../gameLifecycle');
const progressWatchdog = require('../progressWatchdog');
const bidClock = require('../bidClock');
const SeatState = require('../../game/SeatState');
const ambient = require('../../demo/ambientBots');
const { Phase } = require('../../game/GamePhase');
const pacing = require('../../game/pacing');
const { makeIo, events, mulberry32 } = require('../../testUtils/gameDriver');
const { world } = require('../../testUtils/contractScenarios');
const { setupTournament, liveTables, advanceUntil } = require('../../testUtils/tournamentDriver');
const { watchSeq } = require('../../testUtils/seqCheck');
const { bidClockErrors, bidClockWireErrors } = require('../../testUtils/bidClockCheck');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const DELAY = SeatState.BID_CLOCK_DELAY_MS;
const CLOCK = SeatState.BID_CLOCK_MS;
const realRandom = Math.random;
const ENV = ['BID_CLOCK', 'BID_CLOCK_MS', 'BID_CLOCK_DELAY_MS', 'BID_TIMEOUT_AFK_STRIKES', 'AFK_TIMEOUT_MS'];
let n = 0;

beforeEach(() => {
    jest.useFakeTimers();
    for (const k of ENV) delete process.env[k];
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    for (const k of ENV) delete process.env[k];
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

afterAll(() => require('../errorHandler').rateLimiter.shutdown());

/** The bidClock room events as short strings: 'running:2:30000', 'timeout:2', ... */
const clockLog = (log, from = 0) => events(log.slice(from), 'bidClock')
    .map((l) => (l.data.running ? `running:${l.data.position}:${l.data.inMs}` : `${l.data.reason}:${l.data.position}`));
const lines = (log, from = 0) => events(log.slice(from), 'gameLogEntry').map((l) => l.data.message);

/**
 * A real lobby game (`humans` humans + lobby bots) at its first open human
 * bid turn (after the first-hand hold). `stopAtHumanTurn` false: as soon as
 * bidding opens.
 */
async function table({ humans = 4, seed = 1, stopAtHumanTurn = true } = {}) {
    n++;
    Math.random = mulberry32(seed);
    const w = world(`bc${n}`);
    const names = Array.from({ length: humans }, (_, i) => `bc${n}_${'abcd'[i]}`);
    const socks = names.map((nm, i) => w.user(`bc${n}-h${i + 1}`, nm));
    mainRoomHandlers.createLobby(socks[0], w.io, { name: `Clock ${n}` });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    for (let i = humans; i < 4; i++) lobbyHandlers.addBot(socks[0], w.io);
    const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    const game = gameManager.getPlayerGame(socks[0].id);
    await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
    const draws = socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
    w.pending.push(...starting, ...draws);
    await advanceUntil(() => game.stage === Phase.BIDDING, 100);
    const t = {
        w, game, socks, names,
        owner: (pos) => w.sockets.get(game.seat(pos).ownerSocketId),
        humanOnTurn: () => game.stage === Phase.BIDDING && !game.resume && game.seat(game.currentTurn).controller === 'human' &&
            game.playerBids[game.currentTurn - 1] == null,
        bid: (value, pos = game.currentTurn) => gameHandlers.playerBid(t.owner(pos), w.io, { bid: value }),
        name: (pos) => game.seat(pos).ownerUsername,
    };
    if (stopAtHumanTurn) await advanceUntil(t.humanOnTurn, 50);
    return t;
}

/** Every human seat bids `value` at once until bidding ends (or `until`). */
async function bidAll(t, value = '1', until = () => t.game.stage !== Phase.BIDDING) {
    for (let guard = 0; !until() && guard < 200; guard++) {
        if (t.humanOnTurn()) await t.bid(value);
        else await jest.advanceTimersByTimeAsync(100);
    }
}

describe('the clock', () => {
    test('nothing in the first 10 s; then running to the room (players, a lazy watcher, a spectator), unsequenced', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        // a lazy owner at another seat, and a spectator
        const lazyPos = [1, 2, 3, 4].find((p) => p !== pos && p !== (pos % 4) + 1);
        chatHandlers.chatMessage(t.owner(lazyPos), w.io, { message: '/lazy' });
        const spec = w.user(`bc${n}-spec`, `bc${n}_fan`);
        mainRoomHandlers.joinAsSpectator(spec, w.io, { gameId: game.gameId });
        const mark = w.log.length;
        const seqBefore = game.eventSeq;
        expect(game.hasTimer('bidClock')).toBe(true);
        expect(game.bidClock).toMatchObject({ pos, running: false });

        await jest.advanceTimersByTimeAsync(DELAY - 1);
        expect(clockLog(w.log, mark)).toEqual([]);
        await jest.advanceTimersByTimeAsync(1);
        const [ev] = events(w.log.slice(mark), 'bidClock');
        expect(ev).toMatchObject({ to: game.roomName, data: { gameId: game.gameId, position: pos, running: true, inMs: CLOCK, durationMs: CLOCK } });
        expect('seq' in ev.data).toBe(false);
        expect(game.eventSeq).toBe(seqBefore);
        const room = w.io.rooms.get(game.roomName);
        for (const sid of [t.owner(1).id, t.owner(2).id, t.owner(3).id, t.owner(4).id, spec.id]) expect(room.has(sid)).toBe(true);
        expect(game.seat(lazyPos).controller).toBe('lazyBot');
        // the stall watchdog stays off on a human turn
        expect(game.hasTimer(progressWatchdog.KEY)).toBe(false);
        expect(bidClockErrors(game)).toEqual([]);
    });

    test('at 40 s the server bids 0: stopped {timeout}, "<name> ran out of time.", bidReceived, updateTurn; the next human gets its clock', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        const next = (pos % 4) + 1;
        const mark = w.log.length;
        await jest.advanceTimersByTimeAsync(DELAY + CLOCK - 1);
        expect(game.playerBids[pos - 1]).toBeUndefined();
        expect(game.hasTimer(`afk:${pos}`)).toBe(true);
        await jest.advanceTimersByTimeAsync(1);
        expect(game.playerBids[pos - 1]).toBe('0');
        const seq = w.log.slice(mark).filter((l) => l.to === game.roomName && l.event !== 'chatMessage').map((l) => l.event);
        expect(seq).toEqual(['bidClock', 'bidClock', 'gameLogEntry', 'bidReceived', 'updateTurn']);
        expect(clockLog(w.log, mark)).toEqual([`running:${pos}:${CLOCK}`, `timeout:${pos}`]);
        expect(lines(w.log, mark)).toContain(`${t.name(pos)} ran out of time.`);
        expect(events(w.log.slice(mark), 'bidReceived')[0].data).toMatchObject({ bid: '0', position: pos });
        // stored log: the system line, then the ordinary bid line; names, never team numbers
        const stored = game.gameLog.map((e) => e.message);
        const i = stored.indexOf(`${t.name(pos)} ran out of time.`);
        expect(stored[i + 1]).toBe(`${t.name(pos)} bid 0.`);
        expect(game.gameLog[i].type).toBe('system');
        expect(stored.join('\n')).not.toMatch(/Team \d|T[12]\b/);
        // the next (human) seat's turn: its own clock, the bidder's AFK cleared
        expect(game.currentTurn).toBe(next);
        expect(game.bidClock).toMatchObject({ pos: next, running: false });
        expect(game.hasTimer('bidClock')).toBe(true);
        expect(game.hasTimer(`afk:${pos}`)).toBe(false);
        expect(game.bidTimeouts[pos]).toBe(1);
    });

    test('a bid at 15 s stops it for everyone (before bidReceived); nothing more for that turn', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        const mark = w.log.length;
        await jest.advanceTimersByTimeAsync(15000);
        await t.bid('1');
        const after = w.log.slice(mark).filter((l) => l.to === game.roomName && ['bidClock', 'bidReceived'].includes(l.event))
            .map((l) => (l.event === 'bidClock' ? (l.data.running ? 'running' : l.data.reason) : 'bidReceived'));
        expect(after).toEqual(['running', 'bid', 'bidReceived']);
        // The next seat bids at once: no clock event for it, and nothing at 40 s
        await t.bid('1');
        await jest.advanceTimersByTimeAsync(DELAY - 100);
        expect(clockLog(w.log, mark)).toEqual([`running:${pos}:${CLOCK}`, `bid:${pos}`]);
    });

    test('a bid inside the 10 s pre-wait: no bidClock event at all', async () => {
        const t = await table();
        const { w } = t;
        const mark = w.log.length;
        await jest.advanceTimersByTimeAsync(5000);
        await t.bid('1');
        await bidAll(t);
        expect(t.game.stage).toBe(Phase.PLAYING);
        await jest.advanceTimersByTimeAsync(DELAY + CLOCK);
        expect(clockLog(w.log, mark)).toEqual([]);
        expect(t.game.hasTimer('bidClock')).toBe(false);
    });

    test('snapshots carry it only while it runs: requestSnapshot, a spectator joining mid-clock; a spectator joining in the pre-wait gets the live event', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        const ask = () => {
            const mark = w.log.length;
            snapshotHandlers.requestSnapshot(t.owner((pos % 4) + 1), w.io, {});
            return w.log.slice(mark).find((l) => l.event === 'stateSnapshot').data.snapshot;
        };
        await jest.advanceTimersByTimeAsync(5000);
        expect(ask()).not.toHaveProperty('bidClock');
        const early = w.user(`bc${n}-early`, `bc${n}_early`);
        mainRoomHandlers.joinAsSpectator(early, w.io, { gameId: game.gameId });
        await jest.advanceTimersByTimeAsync(5000);
        // in the room by then: the live running event reaches it
        expect(w.io.rooms.get(game.roomName).has(early.id)).toBe(true);
        expect(clockLog(w.log)).toEqual([`running:${pos}:${CLOCK}`]);
        await jest.advanceTimersByTimeAsync(7000);
        const s = ask();
        expect(s.bidClock).toEqual({ position: pos, inMs: CLOCK - 7000, durationMs: CLOCK });
        expect(s.turn).toEqual({ position: pos, action: 'bid' });
        const late = w.user(`bc${n}-late`, `bc${n}_late`);
        const mark = w.log.length;
        mainRoomHandlers.joinAsSpectator(late, w.io, { gameId: game.gameId });
        const full = w.log.slice(mark).find((l) => l.to === `self:${late.id}` && l.data && l.data.snapshot);
        expect(full.data.snapshot.bidClock).toEqual({ position: pos, inMs: CLOCK - 7000, durationMs: CLOCK });
        await t.bid('2');
        expect(ask()).not.toHaveProperty('bidClock');
    });

    test('a human bid in the same tick right after the timeout is refused (not_your_turn)', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        const late = t.owner(pos);
        await jest.advanceTimersByTimeAsync(DELAY + CLOCK);
        const mark = w.log.length;
        await gameHandlers.playerBid(late, w.io, { bid: '3' });
        const rej = w.log.slice(mark).find((l) => l.to === `self:${late.id}` && l.event === 'actionRejected');
        expect(rej.data).toMatchObject({ action: 'bid', reason: 'not_your_turn' });
        expect(game.playerBids[pos - 1]).toBe('0');
    });
});

describe('who gets a clock', () => {
    test('bots never: 1 human + 3 bots, the clock only ever names the human; an ambient bot game never makes a record', async () => {
        const t = await table({ humans: 1, seed: 4, stopAtHumanTurn: false });
        const { game, w } = t;
        const human = game.seatByUsername(t.names[0]);
        // Bots' turns: no record, no timer
        for (let guard = 0; guard < 400 && game.handStats.totalHands < 2; guard++) {
            const seat = game.seat(game.currentTurn);
            if (game.stage === Phase.BIDDING && seat.controller !== 'human') {
                expect(game.hasTimer('bidClock')).toBe(false);
            }
            if (t.humanOnTurn()) {
                // idle the first time, bid at 12 s the next
                if (game.handStats.totalHands === 0 && game.playerBids[human - 1] == null) {
                    await jest.advanceTimersByTimeAsync(DELAY + CLOCK);
                    continue;
                }
                await jest.advanceTimersByTimeAsync(12000);
                await t.bid('1');
                continue;
            }
            if (game.stage === Phase.PLAYING && game.seat(game.currentTurn).controller === 'human') {
                const s = t.owner(game.currentTurn);
                await gameHandlers.playCard(s, w.io, { card: require('../../testUtils/gameDriver').legalCards(game, s.id)[0] });
                continue;
            }
            await jest.advanceTimersByTimeAsync(250);
        }
        const all = events(w.log, 'bidClock');
        expect(all.length).toBeGreaterThan(2);
        expect(all.every((l) => l.data.position === human)).toBe(true);
        expect(bidClockWireErrors(w.log, game.roomName)).toEqual([]);

        const log = [];
        const io = makeIo(log);
        Math.random = mulberry32(5);
        const bots = ambient.startBotGame(io);
        for (let i = 0; i < 40 && !bots.isTerminal(); i++) {
            await jest.advanceTimersByTimeAsync(5000);
            expect(bots.bidClock).toBeNull();
            expect(bots.hasTimer('bidClock')).toBe(false);
        }
        expect(events(log, 'bidClock')).toEqual([]);
    }, 60000);

    test('a solo casual game: the clock applies (owner: every game) and never takes the seat over (AFK-exempt)', async () => {
        const t = await table({ humans: 1, seed: 6, stopAtHumanTurn: false });
        const { game, w } = t;
        const human = game.seatByUsername(t.names[0]);
        let timeouts = 0;
        for (let guard = 0; guard < 2000 && timeouts < 3; guard++) {
            if (t.humanOnTurn()) {
                await jest.advanceTimersByTimeAsync(DELAY + CLOCK);
                timeouts++;
                continue;
            }
            if (game.stage === Phase.PLAYING && game.seat(game.currentTurn).controller === 'human') {
                const s = t.owner(game.currentTurn);
                // plays reset the strikes: idle at bidding only, as a redeal would
                game.bidTimeouts[human] = timeouts;
                await gameHandlers.playCard(s, w.io, { card: require('../../testUtils/gameDriver').legalCards(game, s.id)[0] });
                game.bidTimeouts[human] = timeouts;
                continue;
            }
            await jest.advanceTimersByTimeAsync(250);
        }
        expect(timeouts).toBe(3);
        expect(lines(w.log).filter((m) => m === `${t.names[0]} ran out of time.`)).toHaveLength(3);
        expect(game.seat(human).controller).toBe('human');
        expect(events(w.log, 'playerLazyMode')).toEqual([]);
    }, 60000);
});

describe('controller changes, presence, AFK', () => {
    test('/lazy mid-clock stops it (controller) and the lazy bot bids; /active on the same turn resumes what is left, topped up once to 10 s', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        const s = t.owner(pos);
        const mark = w.log.length;
        await jest.advanceTimersByTimeAsync(DELAY + 25000); // 5 s left
        chatHandlers.chatMessage(s, w.io, { message: '/lazy' });
        expect(clockLog(w.log, mark)).toEqual([`running:${pos}:${CLOCK}`, `controller:${pos}`]);
        expect(game.hasTimer('bidClock')).toBe(false);
        // back before the bot's bid: 5 s left < 10 s, topped up to 10 s
        chatHandlers.chatMessage(s, w.io, { message: '/active' });
        expect(clockLog(w.log, mark).slice(2)).toEqual([`running:${pos}:${SeatState.BID_CLOCK_RESUME_MIN_MS}`]);
        await jest.advanceTimersByTimeAsync(6000); // 4 s left
        chatHandlers.chatMessage(s, w.io, { message: '/lazy' });
        chatHandlers.chatMessage(s, w.io, { message: '/active' });
        // no second top-up on this turn
        expect(clockLog(w.log, mark).slice(3)).toEqual([`controller:${pos}`, `running:${pos}:4000`]);
        await jest.advanceTimersByTimeAsync(4000);
        expect(game.playerBids[pos - 1]).toBe('0');
        expect(clockLog(w.log, mark).slice(5)).toEqual([`timeout:${pos}`]);

        // /lazy for good: the lazy bot bids (no timeout) on the next turn of that seat
        const p2 = game.currentTurn;
        await jest.advanceTimersByTimeAsync(DELAY + 1000);
        chatHandlers.chatMessage(t.owner(p2), w.io, { message: '/lazy' });
        await advanceUntil(() => game.playerBids[p2 - 1] != null, 100, 10000);
        expect(lines(w.log, mark).filter((m) => m.endsWith('ran out of time.'))).toHaveLength(1);
        expect(bidClockWireErrors(w.log, game.roomName)).toEqual([]);
    });

    test('/active during the pre-wait resumes the pre-wait (no early running)', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        const s = t.owner(pos);
        await jest.advanceTimersByTimeAsync(4000);
        chatHandlers.chatMessage(s, w.io, { message: '/lazy' });
        chatHandlers.chatMessage(s, w.io, { message: '/active' });
        expect(clockLog(w.log)).toEqual([]);
        await jest.advanceTimersByTimeAsync(DELAY - 4000 - 1);
        expect(clockLog(w.log)).toEqual([]);
        await jest.advanceTimersByTimeAsync(1);
        expect(clockLog(w.log)).toEqual([`running:${pos}:${CLOCK}`]);
    });

    test('a repeated trigger on the same open turn changes nothing (no re-send, no top-up)', async () => {
        const t = await table();
        const { game, w } = t;
        await jest.advanceTimersByTimeAsync(DELAY + 25000);
        const before = clockLog(w.log);
        const rec = { ...game.bidClock };
        gameHandlers.triggerBotIfNeeded(w.io, game, 'bid');
        bidClock.onTurn(w.io, game);
        expect(clockLog(w.log)).toEqual(before);
        expect(game.bidClock).toEqual(rec);
    });

    test('AFK first (AFK_TIMEOUT_MS < 40 s): the seat goes lazy, the clock stops (controller), no timeout bid', async () => {
        process.env.AFK_TIMEOUT_MS = '20000';
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        const mark = w.log.length;
        await jest.advanceTimersByTimeAsync(20000);
        expect(game.seat(pos).controller).toBe('lazyBot');
        expect(clockLog(w.log, mark)).toEqual([`running:${pos}:${CLOCK}`, `controller:${pos}`]);
        await advanceUntil(() => game.playerBids[pos - 1] != null, 100, 10000);
        expect(lines(w.log, mark).some((m) => m.endsWith('ran out of time.'))).toBe(false);
    });

    test('with the defaults the clock always bids before AFK could fire at bidding', async () => {
        const t = await table();
        const { game } = t;
        const pos = game.currentTurn;
        await jest.advanceTimersByTimeAsync(DELAY + CLOCK);
        expect(game.playerBids[pos - 1]).toBe('0');
        expect(game.seat(pos).controller).toBe('human');
        expect(game.hasTimer(`afk:${pos}`)).toBe(false);
    });

    test('a disconnect mid-clock: the clock keeps running through grace and bids 0; a reconnect resumes it from the rejoin snapshot', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        const name = t.name(pos);
        await jest.advanceTimersByTimeAsync(DELAY + 5000);
        await w.kill(t.owner(pos));
        expect(game.seat(pos).presence).toBe('grace');
        expect(game.bidClock.running).toBe(true);
        expect(game.hasTimer('bidClock')).toBe(true);
        await jest.advanceTimersByTimeAsync(10000); // T0+25 s
        const back = w.user(`bc${n}-back`, name, { db: false });
        const mark = w.log.length;
        await reconnectHandlers.rejoinGame(back, w.io, { gameId: game.gameId, username: name });
        const rj = w.log.slice(mark).find((l) => l.to === `self:${back.id}` && l.event === 'rejoinSuccess');
        expect(rj.data.snapshot.bidClock).toEqual({ position: pos, inMs: 15000, durationMs: CLOCK });
        // the reconnect did not restart or re-announce it
        expect(clockLog(w.log, mark)).toEqual([]);
        // and it still runs out on time
        await w.kill(back);
        await jest.advanceTimersByTimeAsync(15000);
        expect(game.playerBids[pos - 1]).toBe('0');
        expect(game.seat(pos).presence).toBe('grace');
        expect(lines(w.log)).toContain(`${name} ran out of time.`);
    });

    test('the turn reaching a disconnected seat arms it too; resigning that seat mid-clock stops it (controller) and the resign bot bids', async () => {
        const t = await table();
        const { game, w } = t;
        const p1 = game.currentTurn;
        const p2 = (p1 % 4) + 1;
        const p3 = (p2 % 4) + 1;
        await w.kill(t.owner(p2));
        await jest.advanceTimersByTimeAsync(DELAY + CLOCK); // p1 times out at 40 s
        expect(game.currentTurn).toBe(p2);
        expect(game.bidClock).toMatchObject({ pos: p2 });
        await jest.advanceTimersByTimeAsync(DELAY); // 50 s: p2's clock runs (grace still open)
        expect(game.bidClock.running).toBe(true);
        await jest.advanceTimersByTimeAsync(SeatState.RECONNECT_GRACE_MS - 50000 + 100); // grace over
        expect(game.seat(p2).presence).toBe('resignable');
        const mark = w.log.length;
        await gameHandlers.forceResign(t.owner(p3), w.io, { position: p2 });
        expect(game.seat(p2).controller).toBe('resignBot');
        expect(clockLog(w.log, mark)).toEqual([`controller:${p2}`]);
        await advanceUntil(() => game.playerBids[p2 - 1] != null, 100, 10000);
        expect(lines(w.log, mark).some((m) => m.startsWith(`${t.name(p2)} ran out`))).toBe(false);
    });

    test('reclaimSeat (/active from the spectating socket of an away lazy seat) on its open bid turn resumes the clock', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        const name = t.name(pos);
        const a = t.owner(pos);
        await jest.advanceTimersByTimeAsync(DELAY + 5000);
        chatHandlers.chatMessage(a, w.io, { message: '/lazy' });
        // a newer socket takes the (lazy) seat; the older one is demoted to a spectator
        const b = w.user(`bc${n}-b`, name, { db: false });
        await reconnectHandlers.rejoinGame(b, w.io, { gameId: game.gameId, username: name });
        expect(game.isSpectator(a.id)).toBe(true);
        // ...and drops: the seat is away, with no owner socket
        await w.kill(b);
        expect(game.seat(pos).presence).toBe('away');
        const mark = w.log.length;
        chatHandlers.chatMessage(a, w.io, { message: '/active' });
        expect(game.seat(pos)).toMatchObject({ controller: 'human', ownerSocketId: a.id });
        expect(clockLog(w.log, mark)).toEqual([`running:${pos}:25000`]);
        await jest.advanceTimersByTimeAsync(25000);
        expect(game.playerBids[pos - 1]).toBe('0');
    });
});

describe('deals, holds and the end', () => {
    test('the first hand: no clock during the deal-reveal hold; T0 is the hold\'s updateTurn; a bid inside the hold never starts one', async () => {
        const t = await table({ stopAtHumanTurn: false });
        const { game, w } = t;
        expect(game.resume && game.resume.kind).toBe('firstTurn');
        expect(game.hasTimer('bidClock')).toBe(false);
        const p1 = game.currentTurn;
        // the first bidder bids inside the hold
        await t.bid('1');
        expect(game.resume).toBeNull();
        const p2 = game.currentTurn;
        expect(game.bidClock).toMatchObject({ pos: p2, running: false });
        await jest.advanceTimersByTimeAsync(pacing().FIRST_HAND_TURN_MS + 100);
        expect(clockLog(w.log)).toEqual([]);
        expect(game.bidClock.pos).not.toBe(p1);

        // and a fresh game whose bidder waits out the hold: T0 = the hold's end
        const u = await table({ stopAtHumanTurn: false, seed: 2 });
        const start = Date.now();
        await advanceUntil(() => !u.game.resume, 50);
        const t0 = Date.now();
        expect(u.game.bidClock.startAt).toBe(t0 + DELAY);
        expect(t0 - start).toBeGreaterThan(0);
    });

    test('an all-zero redeal: three zeros and a timeout 0 redeal; the new deal\'s first bidder gets a fresh clock, nothing stale', async () => {
        const t = await table();
        const { game, w } = t;
        const deal = game.dealSeq;
        await t.bid('0');
        await t.bid('0');
        await t.bid('0');
        const last = game.currentTurn;
        await jest.advanceTimersByTimeAsync(DELAY + CLOCK);
        expect(lines(w.log)).toContain('All bids were zero. Redealing.');
        expect(lines(w.log)).toContain(`${t.name(last)} ran out of time.`);
        expect(game.dealSeq).toBe(deal + 1);
        expect(game.stage).toBe(Phase.BIDDING);
        expect(game.bidClock).toMatchObject({ pos: game.currentTurn, running: false, turn: game.turnKey() });
        expect(game.timerKeys().filter((k) => k === 'bidClock')).toEqual(['bidClock']);
        expect(bidClockWireErrors(w.log, game.roomName)).toEqual([]);
    });

    test('abortGame mid-clock and mid-pre-wait: nothing emitted afterwards, no bidClock timer left', async () => {
        for (const at of [DELAY + 5000, 3000]) {
            const t = await table({ seed: at });
            const { game, w } = t;
            await jest.advanceTimersByTimeAsync(at);
            await gameLifecycle.abortGame(w.io, game, 'test');
            const idx = w.log.findIndex((l) => l.to === game.roomName && l.event === 'abortGame');
            await jest.advanceTimersByTimeAsync(DELAY + CLOCK);
            expect(events(w.log.slice(idx), 'bidClock')).toEqual([]);
            expect(game.timerKeys()).not.toContain('bidClock');
            expect(game.bidClockInfo()).toBeNull();
            expect(bidClockErrors(game)).toEqual([]);
        }
    });

    test('freeze (the deploy handoff) cancels it silently', async () => {
        const t = await table();
        const { game, w } = t;
        await jest.advanceTimersByTimeAsync(DELAY + 1000);
        const mark = w.log.length;
        game.freeze();
        await jest.advanceTimersByTimeAsync(CLOCK);
        expect(clockLog(w.log, mark)).toEqual([]);
        expect(game.bidClock.running).toBe(false);
        expect(game.playerBids.filter((b) => b != null)).toEqual([]);
    });

    test('a stale firing is a no-op, and one for an announced clock stops it (turn)', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        expect(bidClock.start(w.io, game, 'not-this-turn')).toBe(false);
        expect(clockLog(w.log)).toEqual([]);
        await jest.advanceTimersByTimeAsync(DELAY);
        expect(game.bidClock.running).toBe(true);
        expect(bidClock.expire(w.io, game, 'not-this-turn')).toBe(false);
        expect(clockLog(w.log)).toEqual([`running:${pos}:${CLOCK}`, `turn:${pos}`]);
        expect(game.playerBids[pos - 1]).toBeUndefined();
    });

    test('the kill switch flipped mid-clock: the clock stops at its expiry (turn) and bids nothing', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        await jest.advanceTimersByTimeAsync(DELAY + 1000);
        process.env.BID_CLOCK = 'off';
        await jest.advanceTimersByTimeAsync(CLOCK);
        expect(clockLog(w.log)).toEqual([`running:${pos}:${CLOCK}`, `turn:${pos}`]);
        expect(game.playerBids[pos - 1]).toBeUndefined();
    });
});

describe('timeouts in a row (strike rule)', () => {
    test('four idle humans at a casual table: zeros, a redeal, then each seat goes lazy after its second timeout and the game goes on', async () => {
        const t = await table({ seed: 9 });
        const { game, w } = t;
        const seqWatch = watchSeq(w.io);
        // nobody acts: 4 timeouts -> redeal -> 4 more, each one a takeover
        await advanceUntil(() => game.stage === Phase.PLAYING, 1000, 8 * (DELAY + CLOCK) + 60000);
        expect(lines(w.log)).toContain('All bids were zero. Redealing.');
        const lazy = events(w.log, 'playerLazyMode');
        expect(lazy.map((l) => l.data.position).sort()).toEqual([1, 2, 3, 4]);
        for (const l of lazy) {
            const name = l.data.originalUsername;
            expect(lines(w.log).filter((m) => m === `${name} ran out of time.`)).toHaveLength(2);
            expect(lines(w.log)).toContain(`${name} was idle and ${l.data.botUsername} is playing for them. Type /active to return.`);
        }
        // the order contract/README.md "Bid clock" documents: the takeover's
        // playerLazyMode comes after the timeout's bidReceived '0' for that
        // seat and before whatever that bid triggers (updateTurn / doneBidding)
        const room = w.log.filter((l) => l.to === game.roomName);
        for (const l of room.filter((x) => x.event === 'playerLazyMode')) {
            const i = room.indexOf(l);
            const before = room.slice(0, i).filter((x) => ['bidReceived', 'updateTurn', 'doneBidding'].includes(x.event)).pop();
            expect(before.event).toBe('bidReceived');
            expect(before.data).toMatchObject({ bid: '0', position: l.data.position });
            const after = room.slice(i + 1).find((x) => ['bidReceived', 'updateTurn', 'doneBidding'].includes(x.event));
            expect(['updateTurn', 'doneBidding']).toContain(after.event);
        }
        expect(seqWatch.stop().failures).toEqual([]);
        expect(bidClockWireErrors(w.log, game.roomName)).toEqual([]);
    }, 60000);

    test('a bid or a card of the seat\'s own starts the count over; so does /active', async () => {
        const t = await table({ seed: 12 });
        const { game, w } = t;
        const pos = game.currentTurn;
        expect(pos).toBe(game.bidder);
        await jest.advanceTimersByTimeAsync(DELAY + CLOCK);
        expect(game.bidTimeouts[pos]).toBe(1);
        // the others bid 0 at once: a redeal, whose first bidder is `pos` again
        await t.bid('0');
        await t.bid('0');
        await t.bid('0');
        expect(game.dealSeq).toBe(2);
        expect(game.currentTurn).toBe(pos);
        await t.bid('1');
        expect(game.bidTimeouts[pos]).toBe(0);
        // a card: back to 0 as well
        await bidAll(t, '1');
        game.bidTimeouts[pos] = 1;
        const { legalCards } = require('../../testUtils/gameDriver');
        for (let g = 0; g < 20 && !(game.stage === Phase.PLAYING && game.currentTurn === pos); g++) {
            if (game.stage === Phase.PLAYING) {
                const o = t.owner(game.currentTurn);
                await gameHandlers.playCard(o, w.io, { card: legalCards(game, o.id)[0] });
            } else {
                await jest.advanceTimersByTimeAsync(200);
            }
        }
        const s = t.owner(pos);
        expect(game.bidTimeouts[pos]).toBe(1);
        await gameHandlers.playCard(s, w.io, { card: legalCards(game, s.id)[0] });
        expect(game.bidTimeouts[pos]).toBe(0);
        // /active (back in control) clears it too
        game.bidTimeouts[pos] = 1;
        chatHandlers.chatMessage(s, w.io, { message: '/lazy' });
        chatHandlers.chatMessage(s, w.io, { message: '/active' });
        expect(game.bidTimeouts[pos]).toBe(0);
    });

    test('BID_TIMEOUT_AFK_STRIKES=0 or AFK_TIMEOUT_MS=0 turns the rule off', async () => {
        process.env.BID_TIMEOUT_AFK_STRIKES = '0';
        const t = await table({ seed: 9 });
        await advanceUntil(() => events(t.w.log, 'bidClock').filter((l) => l.data.reason === 'timeout').length >= 6, 1000, 400000);
        expect(events(t.w.log, 'playerLazyMode')).toEqual([]);
        process.env.BID_TIMEOUT_AFK_STRIKES = '2';
        process.env.AFK_TIMEOUT_MS = '0';
        const u = await table({ seed: 9 });
        await advanceUntil(() => events(u.w.log, 'bidClock').filter((l) => l.data.reason === 'timeout' && l.data.gameId === u.game.gameId).length >= 6, 1000, 400000);
        expect(events(u.w.log, 'playerLazyMode').filter((l) => l.to === u.game.roomName)).toEqual([]);
    }, 60000);
});

describe('tournament tables', () => {
    test('the clock runs out there too (names in the line, no idle offer at bidding); a seat that keeps timing out is offered to the others when its next clock starts', async () => {
        const ctx = await setupTournament(4);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.entrants === null), 100, 120000);
        await ctx.starting;
        const [table] = liveTables(ctx.t);
        await advanceUntil(() => table.stage === Phase.BIDDING && !table.resume, 100, 60000);
        const pos = table.currentTurn;
        const name = table.seat(pos).ownerUsername;
        await jest.advanceTimersByTimeAsync(DELAY + CLOCK);
        expect(table.playerBids[pos - 1]).toBe('0');
        const msgs = () => events(ctx.log, 'gameLogEntry').filter((l) => l.to === table.roomName).map((l) => l.data.message);
        expect(msgs()).toContain(`${name} ran out of time.`);
        expect(events(ctx.log, 'resignationAvailable')).toEqual([]);
        // everyone idles: zeros, a redeal, second timeouts (no takeover at a
        // tournament table with owners present), another redeal; then the
        // first seat's next clock offers it to the other present owners
        await advanceUntil(() => events(ctx.log, 'resignationAvailable').some((l) => l.data.idle), 1000, 12 * (DELAY + CLOCK));
        expect(events(ctx.log, 'playerLazyMode')).toEqual([]);
        const offer = events(ctx.log, 'resignationAvailable').find((l) => l.data.idle);
        const idlePos = offer.data.position;
        expect(table.currentTurn).toBe(idlePos);
        expect(table.bidClock.running).toBe(true);
        expect(msgs()).toContain(`${offer.data.username} seems idle. You may replace them with a bot.`);
        // another owner confirms: replaced (lazy), the bot bids
        const other = ctx.sockets.find((s) => table.seat(idlePos).ownerSocketId !== s.id && table.seatByOwnerSocket(s.id));
        await gameHandlers.forceResign(other, ctx.io, { position: idlePos });
        expect(table.seat(idlePos).controller).toBe('lazyBot');
        expect(events(ctx.log, 'bidClock').filter((l) => l.to === table.roomName).map((l) => l.data.reason).pop()).toBe('controller');
    }, 120000);
});

describe('live persistence (DERIVED: never saved)', () => {
    test('a game saved mid-clock comes back with no clock and no strikes; the restore kick gives its human bidder a fresh one', async () => {
        const codec = require('../../game/persist/gameCodec');
        const { adoptForTest, kickRestored } = require('../../testUtils/restoreKit');
        const t = await table();
        const { game, w } = t;
        await jest.advanceTimersByTimeAsync(DELAY + CLOCK); // one timeout: a strike
        const pos = game.currentTurn;
        await jest.advanceTimersByTimeAsync(DELAY + 5000);
        expect(game.bidClock).toMatchObject({ pos, running: true });
        const doc = JSON.parse(JSON.stringify(codec.serialize(game)));
        expect(JSON.stringify(doc)).not.toMatch(/bidClock|bidTimeouts/);
        const name = t.name(pos);
        gameManager.games.delete(game.gameId);
        game.freeze();
        const restored = adoptForTest(doc, { io: w.io });
        expect(restored.bidClock).toBeNull();
        expect(restored.bidTimeouts).toEqual({});
        expect(restored.hasTimer('bidClock')).toBe(false);
        expect(restored.bidClockInfo()).toBeNull();
        const back = w.user(`bc${n}-restored`, name, { db: false });
        await reconnectHandlers.rejoinGame(back, w.io, { gameId: restored.gameId, username: name });
        const mark = w.log.length;
        kickRestored(w.io, restored);
        expect(restored.bidClock).toMatchObject({ pos, running: false, startAt: Date.now() + DELAY });
        await jest.advanceTimersByTimeAsync(DELAY);
        expect(clockLog(w.log, mark)).toEqual([`running:${pos}:${CLOCK}`]);
        gameManager.games.delete(restored.gameId);
        restored.freeze();
    });
});

describe('knobs', () => {
    test('defaults, env overrides read at every arm, 0 / garbage, the kill switch', () => {
        expect(SeatState.bidClockDelayMs({})).toBe(10000);
        expect(SeatState.bidClockMs({})).toBe(30000);
        expect(SeatState.bidClockMs({ BID_CLOCK_MS: '3000' })).toBe(3000);
        expect(SeatState.bidClockMs({ BID_CLOCK_MS: 'soon' })).toBe(30000);
        expect(SeatState.bidClockDelayMs({ BID_CLOCK_DELAY_MS: '-1' })).toBe(10000);
        expect(SeatState.bidTimeoutAfkStrikes({})).toBe(2);
        expect(SeatState.bidClockEnabled({})).toBe(true);
        for (const v of ['off', 'false', '0', 'disabled', 'no', ' OFF ']) expect(SeatState.bidClockEnabled({ BID_CLOCK: v })).toBe(false);
        expect(SeatState.bidClockEnabled({ BID_CLOCK: 'on' })).toBe(true);
        expect(SeatState.bidClockEnabled({ BID_CLOCK_MS: '0' })).toBe(false);
        expect(SeatState.bidClockEnabled({ BID_CLOCK_DELAY_MS: '0' })).toBe(false);
    });

    test.each([['BID_CLOCK', 'off'], ['BID_CLOCK_MS', '0'], ['BID_CLOCK_DELAY_MS', '0']])('%s=%s: no clock', async (k, v) => {
        process.env[k] = v;
        const t = await table();
        const pos = t.game.currentTurn;
        expect(t.game.hasTimer('bidClock')).toBe(false);
        await jest.advanceTimersByTimeAsync(DELAY + CLOCK + 1000);
        expect(clockLog(t.w.log)).toEqual([]);
        expect(t.game.playerBids[pos - 1]).toBeUndefined();
    });

    test('BID_CLOCK_DELAY_MS=1000 / BID_CLOCK_MS=3000: read when the turn opens', async () => {
        const t = await table();
        const { game, w } = t;
        const pos = game.currentTurn;
        // this turn was armed with the defaults
        process.env.BID_CLOCK_DELAY_MS = '1000';
        process.env.BID_CLOCK_MS = '3000';
        await jest.advanceTimersByTimeAsync(DELAY);
        expect(clockLog(w.log)).toEqual([`running:${pos}:${CLOCK}`]);
        await t.bid('1');
        const next = game.currentTurn;
        await jest.advanceTimersByTimeAsync(1000);
        expect(clockLog(w.log).slice(2)).toEqual([`running:${next}:3000`]);
        expect(events(w.log, 'bidClock').pop().data.durationMs).toBe(3000);
        await jest.advanceTimersByTimeAsync(3000);
        expect(game.playerBids[next - 1]).toBe('0');
    });
});
