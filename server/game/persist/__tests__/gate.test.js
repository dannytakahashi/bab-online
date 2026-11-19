/**
 * The restored-table gate (deploy survival PR 5, persist/restoreGame.js;
 * the plan's 2.5 steps 7-8 with owner answer c of 2026-11-16).
 *
 * A game adopted from its doc runs nothing by itself until its humans are
 * back: no bot action, AFK, progress watchdog, bid clock or hold, so a
 * TRICK_RESOLVING / HAND_RESOLVING table nobody returns to stays live with
 * resume null (snapshot resume.inMs null) and is never aborted as stalled.
 * The gate opens when every human seated before the deploy is back or has
 * passed the reconnect grace (then the usual Replace-with-Bot offer goes to
 * whoever is here), and opening runs the restore kick BEFORE the returning
 * socket's carrier is built: the carrier's resume.inMs is the fresh hold
 * (about TRICK_VIEW_MS) and its snapshot.seq counts the kick's events.
 */

// Integration test (real Socket.IO / two instances / chaos): CI's slower runners take
// 3-5 s on cases that run in about 2 s on a laptop, so the 5 s default is too tight.
jest.setTimeout(30000);
const mockDb = { current: null };
jest.mock('../../../database', () => require('../../../testUtils/persistHarness').databaseMock(mockDb));

const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const { Phase } = require('../../GamePhase');
const SeatState = require('../../SeatState');
const pacing = require('../../pacing');
const reconnectHandlers = require('../../../socket/reconnectHandlers');
const progressWatchdog = require('../../../socket/progressWatchdog');
const { makeIo, makeSocket } = require('../../../testUtils/gameDriver');
const { fixedBotDelays, silenceBotChat } = require('../../../testUtils/persistHarness');
const { playUntil, freshProcess } = require('../../../testUtils/restoredTables');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../../../utils/logger');
const restoreGame = require('../restoreGame');

let errorLogs;
let realRandom;

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
    expect(errorLogs).toEqual([]);
});

const botActions = (gameId) => [...botController.pendingActions.keys()].filter((k) => k.startsWith(`${gameId}:`) && !k.includes(':chat:'));
const after = (log, mark) => log.slice(mark);
const roomSeqBefore = (log, idx, room) => Math.max(0, ...log.slice(0, idx).filter((e) => e.to === room && e.data && Number.isInteger(e.data.seq)).map((e) => e.data.seq));

/** Adopt `doc` in a fresh process (after playUntil). */
function adopt(fixture) {
    freshProcess(mockDb, fixture.users, { gameId: fixture.gameId });
    fixedBotDelays(1000);
    silenceBotChat();
    const log = [];
    const io = makeIo(log);
    const game = restoreGame.adoptGame(io, fixture.doc);
    return { io, log, game };
}

async function rejoin(io, log, game, username, id) {
    const sock = makeSocket(id, log, io);
    gameManager.registerUser(sock.id, username);
    await reconnectHandlers.rejoinGame(sock, io, { gameId: game.gameId, username });
    return sock;
}

/** Nobody back for `ms`: still live, nothing armed, nothing done. */
async function nobodyBack(game, log, ms) {
    const mark = log.length;
    const stage = game.stage;
    for (let t = 0; t < ms; t += 10000) {
        await jest.advanceTimersByTimeAsync(10000);
        expect(gameManager.getGameById(game.gameId)).toBe(game);
        expect(game.stage).toBe(stage);
        expect(game.resume).toBeNull();
        expect(game.resumeInfo()).toBeNull();
        expect(game.hasTimer('resume')).toBe(false);
        expect(game.hasTimer(progressWatchdog.KEY)).toBe(false);
        expect(game.hasTimer('bidClock')).toBe(false);
        expect(game.timerKeys().filter((k) => k.startsWith('afk:'))).toEqual([]);
        expect(botActions(game.gameId)).toEqual([]);
        expect(restoreGame.isGated(game)).toBe(true);
    }
    const events = after(log, mark).map((e) => e.event);
    expect(events).not.toContain('abortGame');
    for (const e of ['cardPlayed', 'bidReceived', 'trickComplete', 'handComplete', 'updateTurn', 'bidClock']) expect(events).not.toContain(e);
}

describe('nobody back: a resolving table stays live, gated, with no hold and no watchdog', () => {
    for (const [stage, kind] of [[Phase.TRICK_RESOLVING, 'trick'], [Phase.HAND_RESOLVING, 'hand']]) {
        test(`${stage}: 5 min alone, then the first return kicks before the carrier`, async () => {
            const fixture = await playUntil({ mockDb, seed: 3, until: (g) => g.stage === stage && g.dealSeq >= 2 && g.currentHand !== 13 });
            const { io, log, game } = adopt(fixture);
            expect(game.stage).toBe(stage);
            // One "resumed" line, stored and broadcast
            expect(game.gameLog.filter((e) => e.message === restoreGame.RESUMED_LINE)).toHaveLength(1);
            expect(log.filter((e) => e.event === 'gameLogEntry' && e.data.message === restoreGame.RESUMED_LINE)).toHaveLength(1);
            await nobodyBack(game, log, 5 * 60000);
            // The seat passed grace with nobody here: no offer, no abort
            const pos = game.seatByUsername(fixture.users[0].username);
            expect(game.seat(pos).presence).toBe(SeatState.Presence.RESIGNABLE);

            const mark = log.length;
            const sock = await rejoin(io, log, game, fixture.users[0].username, 'back-1');
            const tail = after(log, mark);
            const carrierIdx = tail.findIndex((e) => e.to === `self:${sock.id}` && e.event === 'rejoinSuccess');
            expect(carrierIdx).toBeGreaterThanOrEqual(0);
            const snap = tail[carrierIdx].data.snapshot;
            const holdMs = kind === 'trick' ? pacing(game).TRICK_VIEW_MS : pacing(game).HAND_END_MS;
            expect(snap.resume).toEqual({ kind, inMs: holdMs });
            expect(snap.seq).toBe(roomSeqBefore(log, mark + carrierIdx, game.roomName));
            expect(restoreGame.isGated(game)).toBe(false);
            expect(game.hasTimer('resume')).toBe(true);
            expect(game.hasTimer(progressWatchdog.KEY)).toBe(true);
            expect(game.hasTimer(restoreGame.ABANDON_KEY)).toBe(false);
            // ...and the table moves on by itself after the hold
            await jest.advanceTimersByTimeAsync(holdMs + 10);
            expect(after(log, mark).map((e) => e.event)).toContain(kind === 'trick' ? 'trickComplete' : 'handComplete');
        });
    }
});

describe('the kick runs before the carrier', () => {
    test('PLAYING, a bot on turn: updateTurn precedes rejoinSuccess and snapshot.seq counts it; the bot then plays', async () => {
        const fixture = await playUntil({
            mockDb, seed: 5,
            until: (g) => g.stage === Phase.PLAYING && g.dealSeq >= 2 && g.seat(g.currentTurn).controller !== 'human' && g.playedCardsIndex > 0,
        });
        const { io, log, game } = adopt(fixture);
        await nobodyBack(game, log, 30000);
        const mark = log.length;
        const sock = await rejoin(io, log, game, fixture.users[0].username, 'back-2');
        const tail = after(log, mark);
        const turnIdx = tail.findIndex((e) => e.event === 'updateTurn' && e.to === game.roomName);
        const carrierIdx = tail.findIndex((e) => e.to === `self:${sock.id}` && e.event === 'rejoinSuccess');
        expect(turnIdx).toBeGreaterThanOrEqual(0);
        expect(turnIdx).toBeLessThan(carrierIdx);
        const snap = tail[carrierIdx].data.snapshot;
        expect(snap.seq).toBe(tail[turnIdx].data.seq);
        expect(botActions(game.gameId)).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(1100);
        expect(after(log, mark).map((e) => e.event)).toContain('cardPlayed');
    });

    test('BIDDING, the human on turn: no bid clock while gated, a fresh one from the kick', async () => {
        const fixture = await playUntil({
            mockDb, seed: 7,
            until: (g) => g.stage === Phase.BIDDING && g.dealSeq >= 2 && !g.resume && g.seat(g.currentTurn).controller === 'human',
        });
        const { io, log, game } = adopt(fixture);
        expect(game.bidClock).toBeNull();
        await nobodyBack(game, log, 5 * 60000);
        expect(game.bidClock).toBeNull();
        const mark = log.length;
        const sock = await rejoin(io, log, game, fixture.users[0].username, 'back-3');
        const pos = game.seatByOwnerSocket(sock.id);
        expect(game.currentTurn).toBe(pos);
        expect(game.bidClock).toMatchObject({ pos, running: false, startAt: Date.now() + SeatState.bidClockDelayMs() });
        expect(game.hasTimer('bidClock')).toBe(true);
        const tail = after(log, mark);
        expect(tail.findIndex((e) => e.event === 'updateTurn')).toBeLessThan(tail.findIndex((e) => e.event === 'rejoinSuccess'));
        await jest.advanceTimersByTimeAsync(SeatState.bidClockDelayMs());
        const clock = after(log, mark).filter((e) => e.event === 'bidClock');
        expect(clock.map((e) => [e.data.position, e.data.running, e.data.inMs])).toEqual([[pos, true, SeatState.bidClockMs()]]);
        // Bids '0' when it runs out, as a live clock would
        await jest.advanceTimersByTimeAsync(SeatState.bidClockMs() + 10);
        expect(game.playerBids[pos - 1]).toBe('0');
    });
});

describe('two humans: bots wait for both (owner answer c)', () => {
    const twoHumanFixture = () => playUntil({
        mockDb, seed: 11, humans: 2,
        until: (g) => g.stage === Phase.PLAYING && g.dealSeq >= 2 && g.seat(g.currentTurn).controller !== 'human',
    });

    test('the first back waits; the second back opens the gate, its kick before its carrier', async () => {
        const fixture = await twoHumanFixture();
        const { io, log, game } = adopt(fixture);
        const [a, b] = fixture.users.map((u) => u.username);
        await jest.advanceTimersByTimeAsync(10000);
        const markA = log.length;
        const sockA = await rejoin(io, log, game, a, 'back-a');
        const carrierA = after(log, markA).find((e) => e.event === 'rejoinSuccess');
        expect(carrierA.data.snapshot.resume).toBeNull();
        expect(restoreGame.isGated(game)).toBe(true);
        expect(restoreGame.waitingFor(game)).toEqual([game.seatByUsername(b)]);
        // The restored abandon is over (an owner is back); the gate is not
        expect(game.hasTimer(restoreGame.ABANDON_KEY)).toBe(false);
        await jest.advanceTimersByTimeAsync(20000);
        expect(after(log, markA).map((e) => e.event)).not.toContain('cardPlayed');
        expect(after(log, markA).map((e) => e.event)).not.toContain('updateTurn');
        expect(botActions(game.gameId)).toEqual([]);

        const markB = log.length;
        const sockB = await rejoin(io, log, game, b, 'back-b');
        const tail = after(log, markB);
        const turnIdx = tail.findIndex((e) => e.event === 'updateTurn');
        const carrierIdx = tail.findIndex((e) => e.to === `self:${sockB.id}` && e.event === 'rejoinSuccess');
        expect(turnIdx).toBeGreaterThanOrEqual(0);
        expect(turnIdx).toBeLessThan(carrierIdx);
        expect(tail[carrierIdx].data.snapshot.seq).toBe(tail[turnIdx].data.seq);
        expect(restoreGame.isGated(game)).toBe(false);
        await jest.advanceTimersByTimeAsync(1100);
        expect(after(log, markB).map((e) => e.event)).toContain('cardPlayed');
        expect(sockA.id).not.toBe(sockB.id);
    });

    test('a human who never comes back: after the grace the others get the Replace-with-Bot offer, then the bots go on', async () => {
        const fixture = await twoHumanFixture();
        const { io, log, game } = adopt(fixture);
        const [a, b] = fixture.users.map((u) => u.username);
        await jest.advanceTimersByTimeAsync(5000);
        const sockA = await rejoin(io, log, game, a, 'back-a2');
        const mark = log.length;
        // Still waiting for b, just before its grace runs out
        await jest.advanceTimersByTimeAsync(SeatState.RECONNECT_GRACE_MS - 5000 - 100);
        expect(restoreGame.isGated(game)).toBe(true);
        expect(after(log, mark).map((e) => e.event)).not.toContain('cardPlayed');
        await jest.advanceTimersByTimeAsync(200);
        const posB = game.seatByUsername(b);
        const tail = after(log, mark);
        const offerIdx = tail.findIndex((e) => e.event === 'resignationAvailable' && e.data.position === posB);
        const turnIdx = tail.findIndex((e) => e.event === 'updateTurn');
        expect(offerIdx).toBeGreaterThanOrEqual(0);
        expect(turnIdx).toBeGreaterThan(offerIdx);
        expect(game.gameLog.some((e) => e.message === `${b} failed to reconnect. You may replace them with a bot.`)).toBe(true);
        expect(restoreGame.isGated(game)).toBe(false);
        await jest.advanceTimersByTimeAsync(1100);
        expect(after(log, mark).map((e) => e.event)).toContain('cardPlayed');
        expect(game.seat(game.seatByOwnerSocket(sockA.id)).presence).toBe(SeatState.Presence.CONNECTED);
    });
});

describe('two humans, BIDDING: a turn that moves while gated arms no bid clock (bidClock.eligible)', () => {
    test('the returned human bids; the next seat, a human still in grace, gets no clock until its grace passes and the kick runs', async () => {
        const gameHandlers = require('../../../socket/gameHandlers');
        // The returned human (a) on turn, the other (b) next
        const fixture = await playUntil({
            mockDb, seed: 11, humans: 2,
            until: (g) => {
                if (g.stage !== Phase.BIDDING || g.dealSeq < 2 || g.resume) return false;
                const on = g.seat(g.currentTurn);
                const next = g.seat((g.currentTurn % 4) + 1);
                return on.controller === 'human' && next.controller === 'human' && g.playerBids[next.position - 1] == null;
            },
        });
        const { io, log, game } = adopt(fixture);
        const posA = game.currentTurn;
        const posB = (posA % 4) + 1;
        const ownerOf = (pos) => game.seat(pos).ownerUsername;
        const sockA = await rejoin(io, log, game, ownerOf(posA), 'back-a3');
        expect(game.seatByOwnerSocket(sockA.id)).toBe(posA);
        expect(restoreGame.isGated(game)).toBe(true);
        expect(restoreGame.waitingFor(game)).toEqual([posB]);
        const mark = log.length;
        await gameHandlers.playerBid(sockA, io, { bid: '1' });
        expect(game.playerBids[posA - 1]).toBe('1');
        expect(game.currentTurn).toBe(posB);
        // Well inside b's reconnect grace
        await jest.advanceTimersByTimeAsync(45000);
        expect(after(log, mark).filter((e) => e.event === 'bidClock')).toEqual([]);
        expect(game.hasTimer('bidClock')).toBe(false);
        expect(game.bidClock).toBeNull();
        expect(game.playerBids[posB - 1]).toBeUndefined();
        expect(restoreGame.isGated(game)).toBe(true);
        expect(game.seat(posB).presence).toBe(SeatState.Presence.GRACE);
        // b's grace passes: the offer, the gate opens, the kick arms a fresh clock for b
        await jest.advanceTimersByTimeAsync(SeatState.RECONNECT_GRACE_MS - 45000 + 500);
        expect(restoreGame.isGated(game)).toBe(false);
        expect(after(log, mark).some((e) => e.event === 'resignationAvailable' && e.data.position === posB)).toBe(true);
        expect(game.bidClock).toMatchObject({ pos: posB, running: false });
        expect(game.hasTimer('bidClock')).toBe(true);
        expect(game.playerBids[posB - 1]).toBeUndefined();
        // ...and it runs as a live clock would: announced after its pre-wait, '0' at its end
        await jest.advanceTimersByTimeAsync(SeatState.bidClockDelayMs() + SeatState.bidClockMs() + 10);
        expect(after(log, mark).filter((e) => e.event === 'bidClock' && e.data.running).map((e) => e.data.position)).toEqual([posB]);
        expect(game.playerBids[posB - 1]).toBe('0');
    });
});

describe('not a restored game', () => {
    test('isGated / openGateIfReady / holdsAbandon are inert', async () => {
        const fixture = await playUntil({ mockDb, seed: 2, until: (g) => g.stage === Phase.PLAYING && g.dealSeq >= 2 });
        const live = gameManager.getGameById(fixture.gameId);
        expect(live.restored).toBeUndefined();
        expect(restoreGame.isGated(live)).toBe(false);
        expect(restoreGame.holdsAbandon(live)).toBe(false);
        expect(restoreGame.waitingFor(live)).toEqual([]);
        expect(restoreGame.openGateIfReady(makeIo([]), live)).toBe(false);
    });
});
