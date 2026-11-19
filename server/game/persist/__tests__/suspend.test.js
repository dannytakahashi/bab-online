/**
 * GameState.suspend / unsuspend (deploy survival PR 5): the REVERSIBLE
 * holder self-fence (freeze() stays one-way). While suspended the game is
 * stopped in place with its epoch kept: no emit (broadcast, sendToPlayer,
 * unsequenced: no seq used), no timer, pause or bot action fires (each is
 * remembered with what was left of it; one started meanwhile waits for the
 * thaw), no turn input is taken, an abort waits for the thaw, and the codec
 * refuses to save it. unsuspend(io) puts everything back in due order, the
 * bid clock through bidClock.afterSuspend -> onTurn (its same-turn resume:
 * what is left, topped up once to BID_CLOCK_RESUME_MIN_MS; a running clock
 * is stopped and announced anew, since the clients' countdown ran on),
 * never dropped. A seat's grace is 60 s of unsuspended time.
 *
 * The continuation oracle: the same seeded game played twice, once as is
 * and once suspended at EVERY safe point (for the rest of a 500 ms step),
 * makes the same bot decisions and ends with the same score, stats and
 * gameRecords document. The humans play by a fixed rule and let the bid
 * clock bid for them on some deals (its deadline survives each suspension).
 * A deterministic driver, not chaosEngine: chaos actions are drawn from the
 * run's RNG against wall time, so any pause changes what the run does; the
 * chaos block below only checks that random suspensions keep every chaos
 * oracle (seq, FSM, leaks) green.
 */

const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const GamePhase = require('../../GamePhase');
const SeatState = require('../../SeatState');
const gameHandlers = require('../../../socket/gameHandlers');
const gameLifecycle = require('../../../socket/gameLifecycle');
const SeatLifecycle = require('../../../socket/seatLifecycle');
const profileHandlers = require('../../../socket/profileHandlers');
const { decisionLog } = require('../../../testUtils/persistHarness');
const { watchSafePoints } = require('../../../testUtils/restoreKit');
const { startTable, driveHumans, STEP_MS } = require('../../../testUtils/restoredTables');
const { runSeedInner } = require('../../../testUtils/chaosEngine');
const { watchSeq } = require('../../../testUtils/seqCheck');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');
const codec = require('../gameCodec');

const SEEDS = Number(process.env.PERSIST_SUSPEND_SEEDS) || 10;
const CHAOS_SEEDS = Number(process.env.PERSIST_SUSPEND_CHAOS_SEEDS) || 40;

let errorLogs;
let realRandom;
let asyncErrors;

beforeAll(() => {
    process.env.BAB_FSM_CHECK = '1';
    realRandom = Math.random;
});

afterAll(() => {
    delete process.env.BAB_FSM_CHECK;
    Math.random = realRandom;
});

beforeEach(() => {
    jest.useFakeTimers();
    errorLogs = [];
    asyncErrors = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        for (const m of ['warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const json = (v) => JSON.parse(JSON.stringify(v));
const track = (p) => {
    if (p && typeof p.then === 'function') p.catch((err) => asyncErrors.push(err));
    return p;
};

function outcome(game) {
    const record = mockDb.current.gameRecords.docs.find((d) => d.gameId === game.gameId) || null;
    const stored = record ? json(record) : null;
    if (stored) {
        for (const k of ['_id', 'completedAt', 'gameId', 'createdAt', 'durationMs', 'startedAt', 'endedAt']) delete stored[k];
    }
    return {
        stage: game.stage,
        score: json(game.score),
        rainbows: json(game.rainbows),
        handStats: json(game.handStats),
        playerStats: json(game.playerStats),
        trickHistory: json(game.trickHistory),
        record: stored,
    };
}

/** On these deals the humans let the bid clock bid for them. */
const waitOut = (game) => game.dealSeq % 4 === 2;

/**
 * One whole game. suspendAll: suspend at every safe point; the next step
 * checks nothing was emitted meanwhile and thaws it.
 */
async function playGame(seed, { suspendAll }) {
    const humans = seed % 3 === 0 ? 2 : 1;
    const decisions = decisionLog();
    const t = startTable({ mockDb, seed, humans, prefix: 'sus' });
    const { io, log, socks, game } = t;
    let suspendedAt = null;
    const stats = { suspensions: 0, clockResumes: 0, emitsWhileSuspended: 0, decisionsWhileSuspended: 0 };
    let decisionsAt = 0;
    const watch = watchSafePoints((g) => {
        if (!suspendAll || g !== game || g.isTerminal() || g.isSuspended) return;
        if (g.suspend()) {
            suspendedAt = log.length;
            decisionsAt = decisions.entries.length;
            stats.suspensions++;
        }
    });
    try {
        for (let i = 0; i < 40000 && !game.isTerminal(); i++) {
            await jest.advanceTimersByTimeAsync(STEP_MS);
            if (game.isSuspended) {
                stats.emitsWhileSuspended += log.length - suspendedAt;
                stats.decisionsWhileSuspended += decisions.entries.length - decisionsAt;
                expect(codec.serialize(game)).toBeNull();
                const runningBefore = game.bidClock?.running && game.hasTimer('bidClock') ? game.bidClock.endAt - Date.now() : null;
                const mark = log.length;
                game.unsuspend(io);
                if (runningBefore != null) {
                    // The same-turn resume re-announces the running clock
                    // with what was left of it (topped up once to the floor)
                    const floor = Math.min(SeatState.BID_CLOCK_RESUME_MIN_MS, game.bidClock.durationMs);
                    const ann = log.slice(mark).filter((e) => e.event === 'bidClock');
                    const want = Math.round(runningBefore < floor && game.bidClock.toppedUp ? floor : runningBefore);
                    expect(ann.map((e) => [e.data.running, e.data.running ? e.data.inMs : e.data.reason])).toEqual([[false, 'turn'], [true, want]]);
                    stats.clockResumes++;
                }
            }
            if (game.isTerminal()) break;
            track(driveHumans(io, game, socks, { skipBid: waitOut }));
        }
        await jest.advanceTimersByTimeAsync(5000); // the stats writes
    } finally {
        watch.stop();
        decisions.stop();
        t.done();
    }
    expect(game.stage).toBe(Phase.ENDED);
    const clock = log.filter((e) => e.event === 'bidClock' && e.data.reason === 'timeout').length;
    return {
        outcome: outcome(game),
        decisions: decisions.entries.map(({ gameId, ...rest }) => rest),
        timeouts: clock,
        stats,
    };
}

describe('suspend at every safe point: the same continuation', () => {
    test(`${SEEDS} seeds: identical bot decisions, score, stats and gameRecords doc; nothing emitted while suspended`, async () => {
        profileHandlers._setStatsRetryDelaysForTests([1, 1]);
        const failures = [];
        let totalSuspensions = 0;
        let totalTimeouts = 0;
        try {
            for (let seed = 1; seed <= SEEDS; seed++) {
                const ref = await playGame(seed, { suspendAll: false });
                const sus = await playGame(seed, { suspendAll: true });
                totalSuspensions += sus.stats.suspensions;
                totalTimeouts += sus.timeouts;
                expect(sus.stats.emitsWhileSuspended).toBe(0);
                expect(sus.stats.decisionsWhileSuspended).toBe(0);
                // The bid clock still bid for the waiting humans, as often
                expect(sus.timeouts).toBe(ref.timeouts);
                try {
                    expect({ decisions: sus.decisions, ...sus.outcome }).toEqual({ decisions: ref.decisions, ...ref.outcome });
                } catch (err) {
                    let at = 0;
                    while (at < ref.decisions.length && JSON.stringify(ref.decisions[at]) === JSON.stringify(sus.decisions[at])) at++;
                    failures.push({ seed, at, want: ref.decisions[at], got: sus.decisions[at], msg: err.message.slice(0, 800) });
                }
                expect(ref.outcome.record).not.toBeNull();
            }
        } finally {
            profileHandlers._setStatsRetryDelaysForTests();
        }
        expect(failures).toEqual([]);
        expect(totalSuspensions).toBeGreaterThan(SEEDS * 500);
        expect(totalTimeouts).toBeGreaterThan(0);
        expect(asyncErrors).toEqual([]);
        expect(errorLogs).toEqual([]);
    }, 600000);
});

/** A 1-human table at the human's open bid turn. */
async function atHumanBid(seed = 31) {
    const t = startTable({ mockDb, seed, humans: 1, prefix: 'sb' });
    const { game, io, socks } = t;
    const target = () => game.stage === Phase.BIDDING && !game.resume && game.seat(game.currentTurn).controller === 'human' &&
        game.playerBids[game.currentTurn - 1] == null && game.dealSeq >= 2;
    for (let i = 0; i < 4000 && !target(); i++) {
        await jest.advanceTimersByTimeAsync(100);
        if (!target()) track(driveHumans(io, game, socks));
    }
    expect(target()).toBe(true);
    return t;
}

describe('the bid clock across a suspension', () => {
    const DELAY = () => SeatState.bidClockDelayMs();
    const CLOCK = () => SeatState.bidClockMs();

    test('running with 25 s left: the same 25 s after the thaw, re-announced; bids 0 when they run out', async () => {
        const t = await atHumanBid();
        const { game, io, log } = t;
        const pos = game.currentTurn;
        await jest.advanceTimersByTimeAsync(DELAY() + 5000);
        expect(game.bidClock).toMatchObject({ pos, running: true });
        const left = game.bidClock.endAt - Date.now();
        expect(game.suspend()).toBe(true);
        expect(game.suspend()).toBe(false);
        const mark = log.length;
        await jest.advanceTimersByTimeAsync(60000);
        expect(log.length).toBe(mark);
        expect(game.playerBids[pos - 1]).toBeUndefined();
        expect(game.unsuspend(io)).toBe(true);
        expect(game.unsuspend(io)).toBe(false);
        const ann = log.slice(mark).filter((e) => e.event === 'bidClock');
        // stopped, then running again with what was left (the clients'
        // countdown ran on while nothing was emitted)
        expect(ann.map((e) => [e.data.running, e.data.running ? e.data.inMs : e.data.reason])).toEqual([[false, 'turn'], [true, left]]);
        await jest.advanceTimersByTimeAsync(left - 10);
        expect(game.playerBids[pos - 1]).toBeUndefined();
        await jest.advanceTimersByTimeAsync(20);
        expect(game.playerBids[pos - 1]).toBe('0');
        t.done();
    });

    test('running with 4 s left: topped up once to the resume floor (the same-turn resume rule)', async () => {
        const t = await atHumanBid(32);
        const { game, io, log } = t;
        const pos = game.currentTurn;
        await jest.advanceTimersByTimeAsync(DELAY() + CLOCK() - 4000);
        game.suspend();
        const mark = log.length;
        await jest.advanceTimersByTimeAsync(30000);
        game.unsuspend(io);
        const floor = Math.min(SeatState.BID_CLOCK_RESUME_MIN_MS, CLOCK());
        expect(log.slice(mark).filter((e) => e.event === 'bidClock' && e.data.running).map((e) => e.data.inMs)).toEqual([floor]);
        expect(game.bidClock.toppedUp).toBe(true);
        await jest.advanceTimersByTimeAsync(floor + 10);
        expect(game.playerBids[pos - 1]).toBe('0');
        t.done();
    });

    test('in its pre-wait: the rest of the pre-wait after the thaw, then the full clock', async () => {
        const t = await atHumanBid(33);
        const { game, io, log } = t;
        const pos = game.currentTurn;
        await jest.advanceTimersByTimeAsync(4000);
        expect(game.bidClock).toMatchObject({ pos, running: false });
        game.suspend();
        await jest.advanceTimersByTimeAsync(20000);
        const mark = log.length;
        game.unsuspend(io);
        expect(log.slice(mark).filter((e) => e.event === 'bidClock')).toEqual([]);
        await jest.advanceTimersByTimeAsync(DELAY() - 4000 - 10);
        expect(log.slice(mark).filter((e) => e.event === 'bidClock')).toEqual([]);
        await jest.advanceTimersByTimeAsync(20);
        expect(log.slice(mark).filter((e) => e.event === 'bidClock').map((e) => [e.data.running, e.data.inMs])).toEqual([[true, CLOCK()]]);
        t.done();
    });
});

describe('while suspended', () => {
    test('turn input is refused, timers started meanwhile wait for the thaw, an abort runs at the thaw', async () => {
        const t = await atHumanBid(34);
        const { game, io, log, socks } = t;
        const pos = game.currentTurn;
        game.suspend();
        const mark = log.length;
        await gameHandlers.playerBid(socks[0], io, { bid: '1' });
        expect(game.playerBids[pos - 1]).toBeUndefined();
        expect(log.slice(mark).map((e) => [e.event, e.data?.reason])).toEqual([['actionRejected', 'not_your_turn']]);
        // A timer set meanwhile is remembered with its full time
        let fired = 0;
        expect(game.setTimer('probe', 1000, () => { fired++; })).toBe(true);
        expect(game.hasTimer('probe')).toBe(true);
        await jest.advanceTimersByTimeAsync(5000);
        expect(fired).toBe(0);
        // An abort waits for the thaw (never while ownership is in doubt)
        expect(await gameLifecycle.abortGame(io, game, 'probe abort')).toBe(false);
        expect(game.stage).toBe(Phase.BIDDING);
        expect(gameManager.getGameById(game.gameId)).toBe(game);
        expect(log.slice(mark).filter((e) => e.event === 'abortGame')).toEqual([]);
        game.unsuspend(io);
        await jest.advanceTimersByTimeAsync(0);
        expect(game.stage).toBe(Phase.ABORTED);
        expect(log.filter((e) => e.event === 'abortGame').map((e) => e.data.reason)).toEqual(['probe abort']);
        expect(fired).toBe(0); // terminal: the remembered timer never runs
        t.done();
    });

    test('suspended then fenced (freeze): nothing remembered ever runs, abortGame is a no-op', async () => {
        const t = await atHumanBid(35);
        const { game, io, log } = t;
        const epoch = game.epoch;
        game.suspend();
        expect(game.epoch).toBe(epoch);
        expect(game.freeze()).toBe(true);
        expect(game.isSuspended).toBe(false);
        const mark = log.length;
        expect(await gameLifecycle.abortGame(io, game, 'fenced')).toBe(false);
        await jest.advanceTimersByTimeAsync(120000);
        expect(log.length).toBe(mark);
        expect(game.stage).toBe(Phase.BIDDING);
        expect([...botController.pendingActions.keys()].filter((k) => k.startsWith(`${game.gameId}:`))).toEqual([]);
        expect(game.unsuspend(io)).toBe(false);
        expect(gameManager.getGameById(game.gameId)).toBe(game);
        gameManager.games.delete(game.gameId);
        t.done();
    });

    // Chaos seeds 43, 76, 82, ... ("seat N resignable after 59740ms"): a
    // grace started while suspended was shortened by how long the table had
    // already been suspended when the owner dropped
    test('an owner who drops while suspended gets the full 60 s of grace from the thaw', async () => {
        const t = await atHumanBid(37);
        const { game, io, socks } = t;
        const pos = game.seatList().find((s) => s.controller === 'human').position;
        expect(game.suspend()).toBe(true);
        await jest.advanceTimersByTimeAsync(10000);
        const queueHandlers = require('../../../socket/queueHandlers');
        await queueHandlers.handleDisconnect(socks[0], io);
        const seat = game.seat(pos);
        expect(seat.presence).toBe('grace');
        await jest.advanceTimersByTimeAsync(5000);
        const thawAt = Date.now();
        game.unsuspend(io);
        expect(seat.absentSince).toBe(thawAt);
        expect(seat.graceDeadline).toBe(thawAt + 60000);
        await jest.advanceTimersByTimeAsync(60000 - 10);
        expect(seat.presence).toBe('grace');
        await jest.advanceTimersByTimeAsync(20);
        expect(seat.presence).toBe('resignable');
        expect(seat.resignableAt - seat.absentSince).toBe(60000);
        t.done();
    });

});

/** A table with `humans` connected human seats, in BIDDING with no hold open. */
async function seatedHumans(seed, humans) {
    const t = startTable({ mockDb, seed, humans, prefix: 'sp' });
    const { game, io, socks } = t;
    const target = () => game.stage === Phase.BIDDING && !game.resume;
    for (let i = 0; i < 4000 && !target(); i++) {
        await jest.advanceTimersByTimeAsync(100);
        if (!target()) track(driveHumans(io, game, socks));
    }
    expect(target()).toBe(true);
    const posOf = (sock) => game.seatByOwnerSocket(sock.id);
    const room = (from) => t.log.slice(from).filter((l) => l.to === game.roomName);
    /** ms of play, the given sockets driven every 500 ms */
    const play = async (ms, sockets) => {
        for (let left = ms; left > 0 && !game.isTerminal(); left -= 500) {
            await jest.advanceTimersByTimeAsync(Math.min(500, left));
            track(driveHumans(io, game, sockets));
        }
    };
    return { ...t, posOf, room, play };
}

// Presence changed while suspended is announced at the thaw (chaos seeds
// 43, 62, 76, ...: "early or stale resign offer"). Every emit is dropped
// while suspended, so the room never heard of a drop (or a return) that
// happened then; the resign offer a minute later followed no announced
// disconnect. unsuspend re-announces what changed, oldest absence first,
// then the resign offer if it moved
describe('presence across a suspension', () => {
    const queueHandlers = () => require('../../../socket/queueHandlers');
    const reconnectHandlers = () => require('../../../socket/reconnectHandlers');
    const { makeSocket } = require('../../../testUtils/gameDriver');

    test('an owner who drops while suspended: playerDisconnected at the thaw, the offer a full grace after it', async () => {
        const t = await seatedHumans(41, 2);
        const { game, io, socks, room, play } = t;
        const pos = t.posOf(socks[1]);
        expect(game.suspend()).toBe(true);
        const mark = t.log.length;
        await queueHandlers().handleDisconnect(socks[1], io);
        expect(game.seat(pos).presence).toBe('grace');
        await jest.advanceTimersByTimeAsync(2000);
        expect(room(mark)).toEqual([]);
        game.unsuspend(io);
        const dc = room(mark).filter((l) => l.event === 'playerDisconnected');
        expect(dc.map((l) => l.data)).toEqual([expect.objectContaining({ position: pos, username: game.seat(pos).ownerUsername })]);
        await play(61000, [socks[0]]);
        const offers = room(mark).filter((l) => l.event === 'resignationAvailable');
        expect(offers.map((l) => l.data.position)).toEqual([pos]);
        expect(offers[0].at - dc[0].at).toBeGreaterThanOrEqual(60000);
        t.done();
    });

    test('an owner who drops before and is back while suspended: playerReconnected at the thaw', async () => {
        const t = await seatedHumans(42, 2);
        const { game, io, socks, room } = t;
        const pos = t.posOf(socks[1]);
        const username = game.seat(pos).ownerUsername;
        const before = t.log.length;
        await queueHandlers().handleDisconnect(socks[1], io);
        expect(room(before).filter((l) => l.event === 'playerDisconnected').map((l) => l.data.position)).toEqual([pos]);
        await jest.advanceTimersByTimeAsync(1000);
        expect(game.suspend()).toBe(true);
        const back = makeSocket('sp42-h1-back', t.log, io);
        gameManager.registerUser(back.id, username);
        await reconnectHandlers().rejoinGame(back, io, { gameId: game.gameId, username });
        expect(game.seat(pos).presence).toBe('connected');
        const mark = t.log.length;
        game.unsuspend(io);
        const presence = room(mark).filter((l) => l.event === 'playerDisconnected' || l.event === 'playerReconnected');
        expect(presence.map((l) => [l.event, l.data.position])).toEqual([['playerReconnected', pos]]);
        t.done();
    });

    test('the offered owner is back while suspended: playerReconnected, then the offer moved meanwhile, at the thaw', async () => {
        const t = await seatedHumans(43, 3);
        const { game, io, socks, room, play } = t;
        const [p1, p2] = [t.posOf(socks[1]), t.posOf(socks[2])];
        await queueHandlers().handleDisconnect(socks[1], io);
        await play(1000, [socks[0]]);
        await queueHandlers().handleDisconnect(socks[2], io);
        await play(61000, [socks[0]]);
        expect(game.resignablePositions().sort()).toEqual([p1, p2].sort());
        // Each grace expiry offers its seat: the room holds p2's offer
        expect(game.offerPos).toBe(p2);
        expect(game.suspend()).toBe(true);
        const username = game.seat(p2).ownerUsername;
        const back = makeSocket('sp43-h2-back', t.log, io);
        gameManager.registerUser(back.id, username);
        await reconnectHandlers().rejoinGame(back, io, { gameId: game.gameId, username });
        // reofferAfter moved the offer to p1 (its broadcast dropped)
        expect(game.offerPos).toBe(p1);
        const mark = t.log.length;
        game.unsuspend(io);
        const told = room(mark).filter((l) => ['playerDisconnected', 'playerReconnected', 'resignationAvailable'].includes(l.event));
        expect(told.map((l) => [l.event, l.data.position])).toEqual([['playerReconnected', p2], ['resignationAvailable', p1]]);
        t.done();
    });

    test('an absent owner back and gone again while suspended: playerReconnected then playerDisconnected at the thaw (its new grace)', async () => {
        const t = await seatedHumans(45, 2);
        const { game, io, socks, room } = t;
        const pos = t.posOf(socks[1]);
        const username = game.seat(pos).ownerUsername;
        await queueHandlers().handleDisconnect(socks[1], io);
        await jest.advanceTimersByTimeAsync(1000);
        expect(game.suspend()).toBe(true);
        const back = makeSocket('sp45-h1-back', t.log, io);
        gameManager.registerUser(back.id, username);
        await reconnectHandlers().rejoinGame(back, io, { gameId: game.gameId, username });
        expect(game.seat(pos).presence).toBe('connected');
        await queueHandlers().handleDisconnect(back, io);
        expect(game.seat(pos).presence).toBe('grace');
        const mark = t.log.length;
        game.unsuspend(io);
        const told = room(mark).filter((l) => ['playerDisconnected', 'playerReconnected', 'resignationAvailable'].includes(l.event));
        // The live order: back, then gone again (the room held it as absent)
        expect(told.map((l) => [l.event, l.data.position])).toEqual([['playerReconnected', pos], ['playerDisconnected', pos]]);
        t.done();
    });

    // Chaos seeds 350 and 1136 (Node 26): a /lazy or a forceResign run while
    // suspended changed who plays the seat, but playerLazyMode /
    // playerResigned, the clock's `stopped` (350: 'bid clock wire') and the
    // moved offer (1136: an owner held a stale offer) were all dropped. A
    // refusal instead lost the web player's Replace with Bot (its dialog
    // closes on the tap) and let iOS's unreadable-table Leave exit locally
    // with the seat kept. Seat commands are HELD to the thaw (lead,
    // 2026-11-19): each runs then through its own handler, in arrival order,
    // re-validated, with its normal events; the sender is told privately
    const presenceEvents = ['playerDisconnected', 'playerReconnected', 'resignationAvailable'];
    const seatEvents = ['playerLazyMode', 'playerActiveMode', 'playerResigned', 'seatLeft'];
    const helds = (t, from) => t.log.slice(from).filter((l) => l.event === 'serverError')
        .map((l) => [l.to.replace(/^self:/, ''), l.data.handler, l.data.message]);

    test('seat commands (/lazy, /active, forceResign) held while suspended run at the thaw, in arrival order, with their normal events', async () => {
        const t = await seatedHumans(46, 3);
        const { game, io, socks, room, play } = t;
        const chat = require('../../../socket/chatHandlers');
        const [p0, p1, p2] = socks.map((sk) => t.posOf(sk));
        await queueHandlers().handleDisconnect(socks[2], io);
        await play(61000, [socks[0], socks[1]]);
        expect(game.resignablePositions()).toEqual([p2]);
        expect(game.offerPos).toBe(p2);
        chat.chatMessage(socks[1], io, { message: '/lazy' });
        await jest.advanceTimersByTimeAsync(0);
        expect(game.seat(p1).controller).toBe('lazyBot');
        const seats = () => JSON.stringify(game.seatList().map((st) => [st.position, st.controller, st.presence, st.ownerSocketId]));
        expect(game.suspend()).toBe(true);
        const before = seats();
        const mark = t.log.length;
        chat.chatMessage(socks[0], io, { message: '/lazy' });
        chat.chatMessage(socks[1], io, { message: '/active' });
        // The web player's Replace with Bot (its dialog is gone after the tap)
        await gameHandlers.forceResign(socks[0], io, { position: p2 });
        // Refused if run now ("Not in lazy mode."): told nothing now, and at
        // the thaw it runs after the /lazy above, so it acts
        chat.chatMessage(socks[0], io, { message: '/active' });
        await jest.advanceTimersByTimeAsync(2000);
        expect(seats()).toBe(before);
        expect(room(mark)).toEqual([]);
        expect(helds(t, mark)).toEqual([
            [socks[0].id, 'chatMessage', SeatLifecycle.HELD_LINE],
            [socks[1].id, 'chatMessage', SeatLifecycle.HELD_LINE],
            [socks[0].id, 'forceResign', SeatLifecycle.HELD_LINE],
        ]);
        const thaw = t.log.length;
        game.unsuspend(io);
        expect(room(thaw).filter((l) => seatEvents.includes(l.event))).toEqual([]); // not before the thaw returns
        await jest.advanceTimersByTimeAsync(0);
        expect(room(thaw).filter((l) => seatEvents.includes(l.event)).map((l) => [l.event, l.data.position])).toEqual([
            ['playerLazyMode', p0], ['playerActiveMode', p1], ['playerResigned', p2], ['playerActiveMode', p0],
        ]);
        expect(helds(t, thaw)).toEqual([]);
        expect(game.seatList().map((st) => [st.position, st.controller])).toEqual(
            expect.arrayContaining([[p0, 'human'], [p1, 'human'], [p2, 'resignBot']]));
        t.done();
    });

    test('/leave held while suspended takes effect at the thaw (seat gone, room told), from a human and from a lazy owner', async () => {
        const t = await seatedHumans(47, 3);
        const { game, io, socks, room } = t;
        const chat = require('../../../socket/chatHandlers');
        const [p0, p1] = [t.posOf(socks[0]), t.posOf(socks[1])];
        chat.chatMessage(socks[1], io, { message: '/lazy' });
        await jest.advanceTimersByTimeAsync(0);
        expect(game.seat(p1).controller).toBe('lazyBot');
        expect(game.suspend()).toBe(true);
        const mark = t.log.length;
        // (iOS's unreadable-table Leave: it exits locally after 3 s anyway)
        chat.chatMessage(socks[0], io, { message: '/leave' });
        chat.chatMessage(socks[1], io, { message: '/leave' });
        await jest.advanceTimersByTimeAsync(3000);
        expect(helds(t, mark)).toEqual([
            [socks[0].id, 'chatMessage', SeatLifecycle.HELD_LINE],
            [socks[1].id, 'chatMessage', SeatLifecycle.HELD_LINE],
        ]);
        expect(t.log.slice(mark).filter((l) => l.event === 'leftGame')).toEqual([]);
        expect([game.seat(p0).presence, game.seat(p1).presence]).toEqual(['connected', 'connected']);
        const thaw = t.log.length;
        game.unsuspend(io);
        await jest.advanceTimersByTimeAsync(0);
        expect([game.seat(p0).presence, game.seat(p1).presence]).toEqual(['gone', 'gone']);
        expect(room(thaw).filter((l) => seatEvents.includes(l.event)).map((l) => [l.event, l.data.position])).toEqual([
            ['playerLazyMode', p0], ['seatLeft', p0], ['seatLeft', p1],
        ]);
        expect(room(thaw).filter((l) => l.event === 'gameLogEntry').map((l) => l.data.message))
            .toContain(`${game.seat(p0).ownerUsername} left the game. ${game.seat(p0).bot.username} is playing for them.`);
        expect(t.log.slice(thaw).filter((l) => l.event === 'leftGame').map((l) => l.to)).toEqual([`self:${socks[0].id}`, `self:${socks[1].id}`]);
        expect(gameManager.playerGames.has(socks[0].id)).toBe(false);
        expect(gameManager.playerGames.has(socks[1].id)).toBe(false);
        t.done();
    });

    test('a held command stale by the thaw: forceResign on a seat whose owner came back gets its normal refusal; a socket gone meanwhile is dropped', async () => {
        const t = await seatedHumans(48, 3);
        const { game, io, socks, room, play } = t;
        const chat = require('../../../socket/chatHandlers');
        const [p1, p2] = [t.posOf(socks[1]), t.posOf(socks[2])];
        await queueHandlers().handleDisconnect(socks[2], io);
        await play(61000, [socks[0], socks[1]]);
        expect(game.resignablePositions()).toEqual([p2]);
        expect(game.suspend()).toBe(true);
        const mark = t.log.length;
        await gameHandlers.forceResign(socks[0], io, { position: p2 });
        chat.chatMessage(socks[1], io, { message: '/lazy' });
        expect(helds(t, mark).map((h) => h[1])).toEqual(['forceResign', 'chatMessage']);
        // p2's owner comes back; p1's socket drops
        const username = game.seat(p2).ownerUsername;
        const back = makeSocket('sp48-h2-back', t.log, io);
        gameManager.registerUser(back.id, username);
        await reconnectHandlers().rejoinGame(back, io, { gameId: game.gameId, username });
        io.sockets.sockets.delete(socks[1].id);
        await queueHandlers().handleDisconnect(socks[1], io);
        const thaw = t.log.length;
        game.unsuspend(io);
        await jest.advanceTimersByTimeAsync(0);
        expect(helds(t, thaw)).toEqual([[socks[0].id, 'forceResign', 'Player is not disconnected']]);
        expect(room(thaw).filter((l) => seatEvents.includes(l.event))).toEqual([]);
        expect(room(thaw).filter((l) => presenceEvents.includes(l.event)).map((l) => [l.event, l.data.position]))
            .toEqual([['playerReconnected', p2], ['playerDisconnected', p1]]);
        expect([game.seat(p1).controller, game.seat(p2).controller]).toEqual(['human', 'human']);
        t.done();
    });

    test('suspended then fenced: the held commands are dropped (the /leave is lost, the seat kept)', async () => {
        const t = await seatedHumans(49, 2);
        const { game, io, socks } = t;
        const chat = require('../../../socket/chatHandlers');
        const p0 = t.posOf(socks[0]);
        expect(game.suspend()).toBe(true);
        const mark = t.log.length;
        chat.chatMessage(socks[0], io, { message: '/leave' });
        expect(helds(t, mark)).toEqual([[socks[0].id, 'chatMessage', SeatLifecycle.HELD_LINE]]);
        expect(game.freeze()).toBe(true);
        expect(game.unsuspend(io)).toBe(false);
        await jest.advanceTimersByTimeAsync(5000);
        expect(t.log.length).toBe(mark + 1);
        expect(game.seat(p0)).toMatchObject({ controller: 'human', presence: 'connected', ownerSocketId: socks[0].id });
        expect(gameManager.playerGames.get(socks[0].id)).toBe(game.gameId);
        gameManager.games.delete(game.gameId);
        t.done();
    });

    // The offered seat's owner back and gone again while suspended: a
    // playerDisconnected alone kept the stale Replace with Bot on both
    // clients (web clears it on playerReconnected only; iOS's reducer keeps
    // a resignable seat's offer through playerDisconnected), and its tap got
    // "Player is still reconnecting" for the whole new grace
    test('the offered owner back and gone again while suspended: playerReconnected, then playerDisconnected, at the thaw', async () => {
        const t = await seatedHumans(44, 2);
        const { game, io, socks, room, play } = t;
        const pos = t.posOf(socks[1]);
        const username = game.seat(pos).ownerUsername;
        await queueHandlers().handleDisconnect(socks[1], io);
        await play(61000, [socks[0]]);
        expect(game.resignablePositions()).toEqual([pos]);
        expect(game.offerPos).toBe(pos);
        expect(game.suspend()).toBe(true);
        const back = makeSocket('sp44-h1-back', t.log, io);
        gameManager.registerUser(back.id, username);
        await reconnectHandlers().rejoinGame(back, io, { gameId: game.gameId, username });
        io.sockets.sockets.delete(back.id);
        await queueHandlers().handleDisconnect(back, io);
        expect(game.seat(pos).presence).toBe('grace');
        const mark = t.log.length;
        game.unsuspend(io);
        expect(room(mark).filter((l) => presenceEvents.includes(l.event)).map((l) => [l.event, l.data.position]))
            .toEqual([['playerReconnected', pos], ['playerDisconnected', pos]]);
        t.done();
    });

    test('nothing changed while suspended: nothing re-announced', async () => {
        const t = await seatedHumans(44, 2);
        const { game, io, socks, room, play } = t;
        const pos = t.posOf(socks[1]);
        await queueHandlers().handleDisconnect(socks[1], io);
        await play(61000, [socks[0]]);
        expect(game.resignablePositions()).toEqual([pos]);
        expect(game.offerPos).toBe(pos);
        expect(game.suspend()).toBe(true);
        await jest.advanceTimersByTimeAsync(1500);
        const mark = t.log.length;
        game.unsuspend(io);
        expect(room(mark).filter((l) => ['playerDisconnected', 'playerReconnected', 'resignationAvailable'].includes(l.event))).toEqual([]);
        t.done();
    });
});

describe('a frozen game', () => {
    test('a frozen game: abortGame emits, retires and clears nothing', async () => {
        const t = await atHumanBid(36);
        const { game, io, log } = t;
        game.freeze();
        const mark = log.length;
        expect(await gameLifecycle.abortGame(io, game, 'frozen')).toBe(false);
        expect(log.length).toBe(mark);
        expect(gameManager.getGameById(game.gameId)).toBe(game);
        gameManager.games.delete(game.gameId);
        t.done();
    });
});

describe('chaos runs with random suspensions keep every chaos oracle', () => {
    test(`${CHAOS_SEEDS} seeds`, async () => {
        const failures = [];
        for (let seed = 1; seed <= CHAOS_SEEDS && failures.length < 3; seed++) {
            let seqWatch = null;
            mockDb.current = require('../../../testUtils/memoryDb').createMemoryDb({ users: [] });
            // Suspend the table now and thaw it 0.1-3 s later (a plain
            // timer: the thaw always comes, as the store's re-read would)
            const extraActions = (ctx) => [[2, () => {
                const g = ctx.game;
                if (!g || g.isTerminal() || g.isSuspended || !g.suspend()) return;
                const io = ctx.io;
                setTimeout(() => g.unsuspend(io), ctx.randInt(100, 3000));
            }]];
            const result = await runSeedInner(seed, (io) => { seqWatch = watchSeq(io); }, { errorLogs, extraActions });
            const seq = seqWatch ? seqWatch.stop() : { failures: [] };
            if (!result.ok) failures.push(result);
            else if (seq.failures.length) failures.push({ seed, why: 'seq', failures: seq.failures.slice(0, 3) });
            for (const g of gameManager.games.values()) if (g.isSuspended) g.unsuspend(null);
            for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
            GamePhase.resetViolations();
            jest.clearAllTimers();
        }
        expect(failures).toEqual([]);
    }, 600000);

    // CI run 44594999016 (seed 6 on Node 24; seeds 142 and 246 on Node 26):
    // the step budget ran out while the table was suspended, so the run's
    // own 'chaos-end' abort was deferred to the thaw (as the plan says: an
    // abort never runs while ownership is in doubt). The table's one
    // abortGame came a moment later; the oracle must find it there
    test('the step budget runs out on a suspended table: the chaos-end abort waits for the thaw and is the terminal event', async () => {
        for (const seed of [7, 8]) {
            let seqWatch = null;
            mockDb.current = require('../../../testUtils/memoryDb').createMemoryDb({ users: [] });
            // Every draw picks the suspension (its weight dwarfs the built-in actions); the thaw comes 1.5 s later
            const extraActions = (ctx) => [[1e9, () => {
                const g = ctx.game;
                if (!g || g.isTerminal() || g.isSuspended || !g.suspend()) return;
                const io = ctx.io;
                setTimeout(() => g.unsuspend(io), 1500);
            }]];
            const abort = jest.spyOn(gameLifecycle, 'abortGame');
            const result = await runSeedInner(seed, (io) => { seqWatch = watchSeq(io); }, { errorLogs, extraActions, maxSteps: 1 });
            const seq = seqWatch.stop();
            // The pinned interleaving: the budget's abort met a suspended table and was deferred
            const end = abort.mock.calls.findIndex((c) => c[2] === 'chaos-end');
            expect(end).toBeGreaterThanOrEqual(0);
            await expect(abort.mock.results[end].value).resolves.toBe(false);
            abort.mockRestore();
            expect(result).toMatchObject({ ok: true, steps: 1 });
            expect(seq.failures).toEqual([]);
            for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
            GamePhase.resetViolations();
            jest.clearAllTimers();
        }
    });
});
