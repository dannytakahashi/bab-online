/**
 * Cut for a buck through the real handlers (stub sockets, fake timers, the
 * in-memory DB, standard pacing): the start after the last table (game end
 * and abort paths), the exact event order and one tournamentComplete, who
 * takes part, the draw window and the away rule, presence (disconnect,
 * reconnect, leave, the last member, cancel in every stage), spectators,
 * members without the cap (auto-drawn, private lines, the projection), the
 * all-legacy and kill-switch paths (today's wire), the draw's refusals,
 * the round cap, a deterministic redraw / reshuffle, the final winners
 * snapshot and the secrecy guard. Every emit is checked against the
 * contract by the always-on guard; the cut events against the iOS b39 / b40
 * baselines too.
 */

'use strict';

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const tournamentHandlers = require('../tournamentHandlers');
const cutForABuck = require('../cutForABuck');
const { validate } = require('../validators');
const rateLimiter = require('../rateLimiter');
const contract = require('../../../contract');
const { compile } = require('../../../contract/lib/validate');
const cutGuard = require('../../testUtils/cutGuard');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { events, mulberry32 } = require('../../testUtils/gameDriver');
const { kill, newUser, creatorSocket, liveTables, advanceUntil, setupTournament, playTournament } = require('../../testUtils/tournamentDriver');
const { giveCap, card, deckOf, setupCut, playToCut, toStage, socketOf, drawAll } = require('../../testUtils/cutDriver');
const { abortGame } = require('../gameLifecycle');

let errorLogs;
let realRandom;
let recordSpy;
beforeAll(() => { realRandom = Math.random; });

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        jest.spyOn(l, 'warn').mockImplementation(() => {});
        jest.spyOn(l, 'info').mockImplementation(() => {});
        jest.spyOn(l, 'debug').mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    recordSpy = jest.spyOn(tournamentHandlers, 'recordTournament');
    Math.random = mulberry32(11);
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    cutForABuck.setEngineOptionsForTests({});
    delete process.env.CUT_FOR_A_BUCK;
    delete process.env.CUT_MAX_ROUNDS;
    delete process.env.CUT_DRAW_MS;
    tournamentHandlers._resetCleanupTimersForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const CUT_EVENTS = ['cutForABuckStart', 'cutForABuckRound', 'cutForABuckDrew', 'cutForABuckLeft', 'cutForABuckReveal', 'cutForABuckWinner'];
const cutLog = (ctx) => ctx.log.filter((l) => CUT_EVENTS.includes(l.event) || l.event === 'tournamentComplete');
const roomLines = (ctx) => events(ctx.log, 'tournamentMessage').filter((l) => l.to === ctx.t.roomName && l.data.system).map((l) => l.data.message);
const privateLines = (ctx, socket) => ctx.log.filter((l) => l.to === socket.id && l.event === 'tournamentMessage').map((l) => l.data.message);
const selfOf = (ctx, socket, event) => ctx.log.filter((l) => l.to === `self:${socket.id}` && l.event === event).map((l) => l.data);

/**
 * A shipped schema as its clients read it (restoreWire.test.js asReader): a
 * key the server added since is ignored, so additionalProperties: false
 * goes; required keys, types and enums stay.
 */
function asReader(v) {
    if (Array.isArray(v)) return v.map(asReader);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
        if (k === 'additionalProperties' && x === false) continue;
        out[k] = asReader(x);
    }
    return out;
}

/** Validate a payload against an iOS baseline's schema, as that build reads it (null: an event it does not know). */
function baselineCheck(build, event, data) {
    const base = asReader(require(`../../../contract/baselines/ios-${build}.schema.json`));
    const e = base.s2c[event];
    if (!e || !e.payload) return null; // the build does not know the event (ignored)
    return compile(e.payload, base.$defs)(data);
}

describe('the start, the order of events, one tournamentComplete', () => {
    test('after the last gameEnd: gather, rounds, the winner, then tournamentComplete with the result (and the record once)', async () => {
        const ctx = await setupCut(3);
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('9h', '3s', 'Kd', '5c', 'Qh') });
        await playToCut(ctx);
        expect(ctx.t.phase).toBe('cut');
        expect(ctx.t.cut.stage).toBe('gather');
        expect(ctx.t.completedAt).toBeNull();
        expect(ctx.t.finalWinners).toEqual(ctx.t.getWinners());
        expect(ctx.t.finalMembers).toEqual(ctx.usernames);
        // tournamentGameComplete, then the start, its line and lobbiesUpdated
        const lastGameComplete = ctx.log.map((l) => l.event).lastIndexOf('tournamentGameComplete');
        const after = ctx.log.slice(lastGameComplete).map((l) => (l.event === 'tournamentMessage' ? `line:${l.data.message.slice(0, 15)}` : l.event));
        expect(after.slice(0, 4)).toEqual(['tournamentGameComplete', 'cutForABuckStart', 'line:Cut for a buck!', 'lobbiesUpdated']);
        const start = events(ctx.log, 'cutForABuckStart')[0];
        expect(start.data).toEqual({ candidates: ctx.usernames, startsInMs: 15000, deckCount: 54 });
        expect(start.to).toBe(ctx.t.roomName);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(0);
        // the main room sees "round_active" plus cut: true
        expect(gameManager.getAllTournaments().find((x) => x.id === ctx.t.tournamentId)).toMatchObject({ phase: 'round_active', cut: true });

        await toStage(ctx, 'drawing');
        expect(roomLines(ctx)).toContain('Cut for a buck: 3 players.');
        const round1 = events(ctx.log, 'cutForABuckRound')[0].data;
        expect(round1).toEqual({ round: 1, participants: ctx.usernames, alive: ctx.usernames, deckCount: 54, reshuffled: false, closesInMs: 15000 });
        drawAll(ctx, Object.fromEntries(ctx.usernames.map((u, i) => [u, i])));
        const drew = events(ctx.log, 'cutForABuckDrew').map((l) => l.data);
        expect(drew).toEqual(ctx.usernames.map((u, i) => ({ round: 1, username: u, slot: i, auto: false })));
        const reveal1 = events(ctx.log, 'cutForABuckReveal')[0].data;
        expect(reveal1).toEqual({
            round: 1,
            draws: [{ username: ctx.usernames[0], slot: 0, card: card('9h') }, { username: ctx.usernames[1], slot: 1, card: card('3s') }, { username: ctx.usernames[2], slot: 2, card: card('Kd') }],
            eliminated: [ctx.usernames[1]], redraw: false, alive: [ctx.usernames[0], ctx.usernames[2]], nextInMs: 4000,
        });
        expect(ctx.t.cut.stage).toBe('reveal');
        await toStage(ctx, 'drawing');
        // round 2: the deck lost its three cards: 5c, Qh in front
        drawAll(ctx, { [ctx.usernames[0]]: 0, [ctx.usernames[2]]: 1 });
        const reveal2 = events(ctx.log, 'cutForABuckReveal')[1].data;
        expect(reveal2.draws.map((d) => d.card)).toEqual([card('5c'), card('Qh')]);
        expect(reveal2).toMatchObject({ eliminated: [ctx.usernames[0]], alive: [ctx.usernames[2]], nextInMs: 6000 });
        const winner = events(ctx.log, 'cutForABuckWinner')[0].data;
        expect(winner).toEqual({ winner: ctx.usernames[2], participants: ctx.usernames, rounds: 2 });
        expect(roomLines(ctx)).toContain(`${ctx.usernames[2]} won cut for a buck.`);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(0);

        await jest.advanceTimersByTimeAsync(6000);
        const complete = events(ctx.log, 'tournamentComplete');
        expect(complete).toHaveLength(1);
        expect(complete[0].data.winners).toEqual(ctx.t.finalWinners);
        expect(complete[0].data.cutForABuck).toEqual(winner);
        expect(ctx.t.phase).toBe('complete');
        expect(ctx.t.cut).toBeNull();
        expect(ctx.t.cutResult).toEqual(winner);
        expect(ctx.t.completedAt).not.toBeNull();
        // after the complete: lobbiesUpdated
        const iComplete = ctx.log.indexOf(complete[0]);
        expect(ctx.log.slice(iComplete).some((l) => l.event === 'lobbiesUpdated')).toBe(true);
        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(recordSpy.mock.calls[0][1]).toEqual(winner);
        // the whole order
        expect(cutLog(ctx).map((l) => l.event)).toEqual([
            'cutForABuckStart', 'cutForABuckRound', 'cutForABuckDrew', 'cutForABuckDrew', 'cutForABuckDrew', 'cutForABuckReveal',
            'cutForABuckRound', 'cutForABuckDrew', 'cutForABuckDrew', 'cutForABuckReveal', 'cutForABuckWinner', 'tournamentComplete',
        ]);
        // a cap member coming back: the complete phase's state has the result
        tournamentHandlers.returnToTournament(ctx.sockets[0], ctx.io);
        const joined = selfOf(ctx, ctx.sockets[0], 'tournamentJoined').at(-1);
        expect(joined).toMatchObject({ phase: 'complete', winners: ctx.t.finalWinners, cutForABuck: winner });
        // nothing more, ever
        await jest.advanceTimersByTimeAsync(60000);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        expect(errorLogs).toEqual([]);
    }, 120000);

    test('through the abort path: the last table aborted', async () => {
        const ctx = await setupCut(2);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.entrants === null), 100, 60000);
        await ctx.starting;
        for (const g of liveTables(ctx.t)) await abortGame(ctx.io, g, 'Game stalled');
        await jest.advanceTimersByTimeAsync(100);
        expect(ctx.t.phase).toBe('cut');
        expect(events(ctx.log, 'cutForABuckStart')).toHaveLength(1);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(0);
        // the abort path's abandon check holds during the cut
        expect(gameManager.getTournamentById(ctx.t.tournamentId)).toBe(ctx.t);
    }, 60000);
});

describe('who takes part', () => {
    test('disconnected at the end of the gather: out; back in time: in; left: out (named in the begin line)', async () => {
        const ctx = await setupCut(5);
        await playToCut(ctx);
        const [a, b, c, d, e] = ctx.usernames;
        // b drops for good, c drops and comes back, d leaves the tournament
        await kill(ctx.io, socketOf(ctx, b));
        await kill(ctx.io, socketOf(ctx, c));
        const back = newUserAs(ctx, c);
        await tournamentHandlers.joinTournament(back, ctx.io, { tournamentId: ctx.t.tournamentId });
        ctx.sockets[ctx.usernames.indexOf(c)] = back;
        await tournamentHandlers.leaveTournament(socketOf(ctx, d), ctx.io);
        await toStage(ctx, 'drawing');
        // member order (a reattach re-keys the member, at the end)
        const order = Array.from(ctx.t.players.values(), (p) => p.username);
        expect(ctx.t.cut.engine.participants).toEqual(order.filter((u) => [a, c, e].includes(u)));
        expect(roomLines(ctx)).toContain(`Cut for a buck: 3 players. ${b} was not back in time.`);
        // the reattached member got the cut as it stood (phase cut, the gather)
        const joined = selfOf(ctx, back, 'tournamentJoined').at(-1);
        expect(joined.phase).toBe('cut');
        expect(joined.cut).toMatchObject({ stage: 'gather', candidates: ctx.usernames, round: 0, alive: [], drawn: [] });
    }, 120000);

    test('a member who sat the last round out takes part', async () => {
        const ctx = await setupCut(3, { rounds: 2 });
        // round 1
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await playRoundOut(ctx);
        expect(ctx.t.phase).toBe('between_rounds');
        // round 2 past the ready deadline without the third member
        const host = creatorSocket(ctx);
        const sitter = ctx.sockets.find((s) => s !== host);
        for (const s of ctx.sockets) if (s !== sitter) tournamentHandlers.tournamentReady(s, ctx.io);
        await jest.advanceTimersByTimeAsync(121000);
        ctx.starting = tournamentHandlers.beginNextRound(host, ctx.io);
        await playRoundOut(ctx);
        expect(ctx.t.phase).toBe('cut');
        const sitterName = gameManager.getUserBySocketId(sitter.id).username;
        expect(ctx.t.scoreboard[sitterName].roundDetails.at(-1).missed).toBe(true);
        await toStage(ctx, 'drawing');
        expect(ctx.t.cut.engine.participants).toContain(sitterName);
        expect(ctx.t.cut.engine.participants).toHaveLength(3);
    }, 180000);
});

describe('the draw window, the away rule and presence', () => {
    test('15 s then auto-draws; two timeouts in a row make a player away (drawn at the open) until they draw by hand', async () => {
        const ctx = await setupCut(3);
        // every round a redraw: three 7s, three 8s, three 9s, ...
        // the server's own draws take the lowest free slot
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('7s', '7h', '7d', '8s', '8h', '8d', '9s', '9h', '9d', 'Ts', 'Th', 'Td'), randomInt: () => 0 });
        await playToCut(ctx);
        await toStage(ctx, 'drawing');
        const [a, b, c] = ctx.usernames;
        const draws = (round) => events(ctx.log, 'cutForABuckDrew').filter((l) => l.data.round === round).map((l) => [l.data.username, l.data.auto]);
        // round 1: a and b draw, c times out
        cutForABuck.draw(socketOf(ctx, a), ctx.io, { round: 1, slot: 0 });
        cutForABuck.draw(socketOf(ctx, b), ctx.io, { round: 1, slot: 1 });
        await jest.advanceTimersByTimeAsync(14900);
        expect(events(ctx.log, 'cutForABuckReveal')).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(200);
        expect(draws(1)).toEqual([[a, false], [b, false], [c, true]]);
        expect(ctx.t.cut.strikes[c]).toBe(1);
        // round 2: c times out again (a second strike)
        await toStage(ctx, 'drawing');
        cutForABuck.draw(socketOf(ctx, a), ctx.io, { round: 2, slot: 0 });
        cutForABuck.draw(socketOf(ctx, b), ctx.io, { round: 2, slot: 1 });
        await jest.advanceTimersByTimeAsync(15100);
        expect(ctx.t.cut.strikes[c]).toBe(2);
        // round 3: c is away, drawn for at the open
        await toStage(ctx, 'drawing');
        expect(draws(3)).toEqual([[c, true]]);
        cutForABuck.draw(socketOf(ctx, a), ctx.io, { round: 3, slot: 0 });
        cutForABuck.draw(socketOf(ctx, b), ctx.io, { round: 3, slot: 1 });
        // back to the lobby screen: no longer away
        tournamentHandlers.returnToTournament(socketOf(ctx, c), ctx.io);
        expect(ctx.t.cut.strikes[c]).toBeUndefined();
        expect(errorLogs).toEqual([]);
    }, 120000);

    test('an away player who taps Draw (already drawn for at the open) is no longer away: the next round waits for them', async () => {
        const ctx = await setupCut(3);
        // every card a 7: every round a redraw, nobody ever out
        const sevens = Array.from({ length: 54 }, () => card('7s'));
        cutForABuck.setEngineOptionsForTests({ deck: sevens, shuffle: (cards) => cards.slice(), randomInt: () => 0 });
        await playToCut(ctx);
        const [a, b, c] = ctx.usernames;
        const handDraw = (u, round = ctx.t.cut.engine.round) => cutForABuck.draw(socketOf(ctx, u), ctx.io, { round, slot: null });
        const draws = (round) => events(ctx.log, 'cutForABuckDrew').filter((l) => l.data.round === round).map((l) => [l.data.username, l.data.auto]);
        for (let r = 1; r <= 2; r++) {
            await toStage(ctx, 'drawing');
            handDraw(a); handDraw(b);
            await jest.advanceTimersByTimeAsync(15000); // c times out
        }
        expect(ctx.t.cut.strikes[c]).toBe(2);
        // round 3: away, drawn for at the open; c (still on the lobby) taps Draw
        await toStage(ctx, 'drawing');
        expect(ctx.t.cut.engine.round).toBe(3);
        expect(draws(3)).toEqual([[c, true]]);
        handDraw(c); // the draw itself is dropped (a repeat) ...
        expect(draws(3)).toEqual([[c, true]]);
        expect(ctx.t.cut.strikes[c]).toBeUndefined(); // ... but c is back
        handDraw(a); handDraw(b);
        // round 4 waits for c, who draws by hand
        await toStage(ctx, 'drawing');
        expect(ctx.t.cut.engine.round).toBe(4);
        expect(draws(4)).toEqual([]);
        handDraw(c); handDraw(a); handDraw(b);
        expect(draws(4)).toEqual([[c, false], [a, false], [b, false]]);
        // a tap that lands in the reveal (a stale round) counts too
        ctx.t.cut.strikes[c] = 2;
        expect(ctx.t.cut.stage).toBe('reveal');
        handDraw(c, 4);
        expect(ctx.t.cut.strikes[c]).toBeUndefined();
        await toStage(ctx, 'drawing');
        expect(draws(5)).toEqual([]);
        expect(errorLogs).toEqual([]);
    }, 120000);

    test('a disconnect mid-round draws for them at once; a reconnect lands in the cut', async () => {
        const ctx = await setupCut(3);
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('7s', '7h', '7d', '8s', '8h', '8d') });
        await playToCut(ctx);
        await toStage(ctx, 'drawing');
        const [a, b, c] = ctx.usernames;
        cutForABuck.draw(socketOf(ctx, a), ctx.io, { round: 1, slot: 4 });
        await kill(ctx.io, socketOf(ctx, b));
        expect(events(ctx.log, 'cutForABuckDrew').map((l) => [l.data.username, l.data.auto])).toEqual([[a, false], [b, true]]);
        // still in the tournament (not deleted: the cut holds it)
        expect(gameManager.getTournamentById(ctx.t.tournamentId)).toBe(ctx.t);
        const back = newUserAs(ctx, b);
        await tournamentHandlers.joinTournament(back, ctx.io, { tournamentId: ctx.t.tournamentId });
        const joined = selfOf(ctx, back, 'tournamentJoined').at(-1);
        expect(joined.phase).toBe('cut');
        expect(joined.cut).toMatchObject({ stage: 'drawing', round: 1, alive: [a, b, c], deckCount: 54 });
        expect(joined.cut.drawn).toEqual([{ username: a, slot: 4 }, { username: b, slot: expect.any(Number) }]);
        // c draws: the reveal (a tie: 7s)
        cutForABuck.draw(socketOf(ctx, c), ctx.io, { round: 1, slot: null });
        expect(events(ctx.log, 'cutForABuckReveal')).toHaveLength(1);
        ctx.sockets[1] = back;
        // round 2: b draws by hand from the new socket
        await toStage(ctx, 'drawing');
        cutForABuck.draw(back, ctx.io, { round: 2, slot: 0 });
        expect(events(ctx.log, 'cutForABuckDrew').filter((l) => l.data.round === 2).map((l) => [l.data.username, l.data.auto])).toEqual([[b, false]]);
    }, 120000);

    test('everyone disconnected: the cut runs itself to the end and the tournament completes', async () => {
        const ctx = await setupCut(3);
        await playToCut(ctx);
        await toStage(ctx, 'drawing');
        for (const s of [...ctx.sockets]) await kill(ctx.io, s);
        expect(gameManager.getTournamentById(ctx.t.tournamentId)).toBe(ctx.t);
        await advanceUntil(() => ctx.t.phase === 'complete', 500, 600000);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        expect(events(ctx.log, 'tournamentComplete')[0].data.cutForABuck.winner).toBeTruthy();
    }, 120000);

    test('a top scorer who leaves during the cut is still the winner', async () => {
        const ctx = await setupCut(3);
        await playToCut(ctx);
        const top = ctx.t.finalWinners[0];
        await tournamentHandlers.leaveTournament(socketOf(ctx, top), ctx.io);
        expect(ctx.t.getWinners()).not.toContain(top);
        await advanceUntil(() => ctx.t.phase === 'complete', 500, 600000);
        expect(events(ctx.log, 'tournamentComplete')[0].data.winners).toContain(top);
    }, 120000);
});

describe('leaving and cancelling', () => {
    test('a player still in leaves mid-round: cutForABuckLeft with the freed slot, then the reveal; one left: the winner', async () => {
        const ctx = await setupCut(3);
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('7s', '7h', '7d', '8s', '8h') });
        await playToCut(ctx);
        await toStage(ctx, 'drawing');
        const [a, b, c] = ctx.usernames;
        cutForABuck.draw(socketOf(ctx, a), ctx.io, { round: 1, slot: 0 });
        cutForABuck.draw(socketOf(ctx, b), ctx.io, { round: 1, slot: 1 });
        await tournamentHandlers.leaveTournament(socketOf(ctx, b), ctx.io);
        expect(events(ctx.log, 'cutForABuckLeft').map((l) => l.data)).toEqual([{ round: 1, username: b, alive: [a, c], freedSlot: 1 }]);
        cutForABuck.draw(socketOf(ctx, c), ctx.io, { round: 1, slot: 1 });
        const reveal = events(ctx.log, 'cutForABuckReveal')[0].data;
        expect(reveal.draws.map((d) => [d.username, d.card])).toEqual([[a, card('7s')], [c, card('7h')]]);
        expect(reveal.redraw).toBe(true);
        // round 2: a leaves before drawing: c wins at once
        await toStage(ctx, 'drawing');
        await tournamentHandlers.leaveTournament(socketOf(ctx, a), ctx.io);
        expect(events(ctx.log, 'cutForABuckWinner').map((l) => l.data)).toEqual([{ winner: c, participants: [a, b, c], rounds: 2 }]);
        await jest.advanceTimersByTimeAsync(6000);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
    }, 120000);

    test('the last member leaving completes the tournament first (and records it)', async () => {
        const ctx = await setupCut(2);
        await playToCut(ctx);
        await toStage(ctx, 'drawing');
        await tournamentHandlers.leaveTournament(ctx.sockets[0], ctx.io);
        // one left alive: the winner, announced
        const won = events(ctx.log, 'cutForABuckWinner').map((l) => l.data);
        expect(won).toHaveLength(1);
        // the last member (the winner) leaves in the hold: the announced result stands
        await tournamentHandlers.leaveTournament(ctx.sockets[1], ctx.io);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        expect(events(ctx.log, 'tournamentComplete')[0].data.cutForABuck).toEqual(won[0]);
        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(recordSpy.mock.calls[0][1]).toEqual(won[0]);
        expect(gameManager.getTournamentById(ctx.t.tournamentId)).toBeNull();
        expect(errorLogs).toEqual([]);
    }, 120000);

    test('the last member leaving before a winner: no cut result (and a record)', async () => {
        const ctx = await setupCut(2);
        await playToCut(ctx);
        // the gather: one leaves (not in the cut yet), then the other
        await tournamentHandlers.leaveTournament(ctx.sockets[0], ctx.io);
        expect(ctx.t.cut.stage).toBe('gather');
        await tournamentHandlers.leaveTournament(ctx.sockets[1], ctx.io);
        expect(events(ctx.log, 'cutForABuckWinner')).toHaveLength(0);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        expect(events(ctx.log, 'tournamentComplete')[0].data.cutForABuck).toBeUndefined();
        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(recordSpy.mock.calls[0][1]).toBeNull();
        expect(gameManager.getTournamentById(ctx.t.tournamentId)).toBeNull();
    }, 120000);

    test('the winner leaves in the hold: the tournament completes with that result', async () => {
        const ctx = await setupCut(3);
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('As', '2s', '2h') }); // the two 2s out together
        await playToCut(ctx);
        await toStage(ctx, 'drawing');
        const [a] = ctx.usernames;
        drawAll(ctx, Object.fromEntries(ctx.usernames.map((u, i) => [u, i])));
        const won = events(ctx.log, 'cutForABuckWinner').map((l) => l.data);
        expect(won).toEqual([{ winner: a, participants: ctx.usernames, rounds: 1 }]);
        await tournamentHandlers.leaveTournament(socketOf(ctx, a), ctx.io);
        expect(ctx.t.cut.engine.alive.size).toBe(0);
        await jest.advanceTimersByTimeAsync(6000);
        const complete = events(ctx.log, 'tournamentComplete');
        expect(complete).toHaveLength(1);
        expect(complete[0].data.cutForABuck).toEqual(won[0]);
        expect(recordSpy.mock.calls[0][1]).toEqual(won[0]);
        expect(errorLogs).toEqual([]);
    }, 120000);

    test.each(['gather', 'drawing', 'reveal', 'winner'])('the host cancels in the %s stage: the tournament completes (no cut result before a winner, the announced one after)', async (stage) => {
        const ctx = await setupCut(2);
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('7s', '7h', '2s', '9s') });
        await playToCut(ctx);
        if (stage !== 'gather') await toStage(ctx, 'drawing');
        if (stage === 'reveal') drawAll(ctx, { [ctx.usernames[0]]: 0, [ctx.usernames[1]]: 1 });
        if (stage === 'winner') {
            drawAll(ctx, { [ctx.usernames[0]]: 0, [ctx.usernames[1]]: 1 });
            await toStage(ctx, 'drawing');
            drawAll(ctx, { [ctx.usernames[0]]: 0, [ctx.usernames[1]]: 1 });
        }
        expect(ctx.t.cut.stage).toBe(stage);
        const host = creatorSocket(ctx);
        const hostName = gameManager.getUserBySocketId(host.id).username;
        await tournamentHandlers.cancelTournament(host, ctx.io);
        expect(events(ctx.log, 'tournamentCancelled')).toHaveLength(0);
        const complete = events(ctx.log, 'tournamentComplete');
        expect(complete).toHaveLength(1);
        expect(ctx.t.phase).toBe('complete');
        expect(recordSpy).toHaveBeenCalledTimes(1);
        if (stage === 'winner') {
            // announced before the Cancel: it stands, and nothing reads as cut short
            const won = events(ctx.log, 'cutForABuckWinner').map((l) => l.data);
            expect(won).toHaveLength(1);
            expect(roomLines(ctx)).not.toContain(`${hostName} ended cut for a buck.`);
            expect(complete[0].data.cutForABuck).toEqual(won[0]);
            expect(recordSpy.mock.calls[0][1]).toEqual(won[0]);
        } else {
            expect(roomLines(ctx)).toContain(`${hostName} ended cut for a buck.`);
            expect(complete[0].data.cutForABuck).toBeUndefined();
            expect(recordSpy.mock.calls[0][1]).toBeNull();
        }
        await jest.advanceTimersByTimeAsync(30000);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        expect(cutLog(ctx).filter((l) => l.at > complete[0].at && l.event !== 'tournamentComplete')).toEqual([]);
        expect(errorLogs).toEqual([]);
    }, 120000);
});

describe('spectators and members without the cap', () => {
    test('a legacy member: phase round_active, drawn for at every open, the rounds as private lines; a spectator: the events, draws dropped', async () => {
        const ctx = await setupCut(3, { capable: 2 });
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('9h', '3s', 'Ts', 'HI', '4d', '4c') });
        await playToCut(ctx);
        const [a, b, c] = ctx.usernames;
        const legacy = socketOf(ctx, c);
        const watcher = newUser(ctx.io, ctx.log, `${a}_watch`);
        tournamentHandlers.spectateTournament(watcher, ctx.io, { tournamentId: ctx.t.tournamentId });
        expect(selfOf(ctx, watcher, 'tournamentJoined').at(-1)).toMatchObject({ phase: 'round_active', isSpectator: true });
        expect(selfOf(ctx, watcher, 'tournamentJoined').at(-1).cut).toBeUndefined();
        // the legacy member's own view
        tournamentHandlers.returnToTournament(legacy, ctx.io);
        const legacyState = selfOf(ctx, legacy, 'tournamentJoined').at(-1);
        expect(legacyState.phase).toBe('round_active');
        expect(legacyState.cut).toBeUndefined();
        expect(legacyState.currentRound).toBe(legacyState.totalRounds);
        await toStage(ctx, 'drawing');
        // drawn for at the open
        expect(events(ctx.log, 'cutForABuckDrew').map((l) => [l.data.username, l.data.auto])).toEqual([[c, true]]);
        // a spectator's draw is dropped (no event, no error)
        cutForABuck.draw(watcher, ctx.io, { round: 1, slot: 0 });
        expect(events(ctx.log, 'cutForABuckDrew')).toHaveLength(1);
        expect(selfOf(ctx, watcher, 'serverError')).toEqual([]);
        // c drew slot ? (random): the others take 0 and 1 unless taken
        drawAll(ctx);
        const reveal = events(ctx.log, 'cutForABuckReveal')[0].data;
        const text = (cd) => (cd.suit === 'joker' ? `${cd.rank} joker` : `${cd.rank}${{ spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' }[cd.suit]}`);
        const line = `Round 1: ${reveal.draws.map((d) => `${d.username} ${text(d.card)}`).join(', ')}. ${reveal.eliminated.join(' and ')} ${reveal.eliminated.length === 1 ? 'is' : 'are'} out.`;
        expect(privateLines(ctx, legacy)).toEqual([line]);
        expect(privateLines(ctx, watcher)).toEqual([line]);
        expect(privateLines(ctx, socketOf(ctx, a))).toEqual([]);
        // the room lines reach everyone; the spectator got every cut event (room)
        expect(events(ctx.log, 'cutForABuckReveal')[0].members).toContain(watcher.id);
    }, 120000);

    test('a player who is out keeps watching to the winner: every later round\'s events reach them, exactly as a spectator\'s', async () => {
        // owner 2026-11-25: once out, a player watches the rest like a spectator
        const ctx = await setupCut(4);
        // round 1: b out (3); round 2: a out (5); round 3: d out (2), c wins
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('9h', '3s', 'Kd', 'Qh', '5c', '8d', 'Jh', 'As', '2c') });
        await playToCut(ctx);
        const [a, b, c, d] = ctx.usernames;
        const out = socketOf(ctx, b);
        const watcher = newUser(ctx.io, ctx.log, `${a}_watch`);
        tournamentHandlers.spectateTournament(watcher, ctx.io, { tournamentId: ctx.t.tournamentId });
        await toStage(ctx, 'drawing');
        drawAll(ctx, { [a]: 0, [b]: 1, [c]: 2, [d]: 3 });
        const firstReveal = events(ctx.log, 'cutForABuckReveal')[0];
        expect(firstReveal.data.eliminated).toEqual([b]);
        const fromIdx = ctx.log.indexOf(firstReveal) + 1;
        // b is out: their draws are dropped from now on (no event, no error)
        await toStage(ctx, 'drawing');
        cutForABuck.draw(out, ctx.io, { round: 2, slot: 0 });
        expect(events(ctx.log, 'cutForABuckDrew').filter((l) => l.data.round === 2)).toHaveLength(0);
        drawAll(ctx, { [a]: 0, [c]: 1, [d]: 2 });
        expect(events(ctx.log, 'cutForABuckReveal')[1].data.eliminated).toEqual([a]);
        // b back on the tournament screen mid-cut: the state shows them out, the cut going on
        tournamentHandlers.returnToTournament(out, ctx.io);
        const back = selfOf(ctx, out, 'tournamentJoined').at(-1);
        expect(back.phase).toBe('cut');
        expect(back.cut.alive).toEqual([c, d]);
        expect(back.cut.out).toEqual(expect.arrayContaining([expect.objectContaining({ username: b, round: 1 }), expect.objectContaining({ username: a, round: 2 })]));
        await toStage(ctx, 'drawing');
        drawAll(ctx, { [c]: 0, [d]: 1 });
        expect(events(ctx.log, 'cutForABuckWinner')[0].data.winner).toBe(c);
        await jest.advanceTimersByTimeAsync(6000);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        // every cut event after b's elimination went to the room with b (and
        // a, out a round later) in it, the same events the spectator got
        const later = ctx.log.slice(fromIdx).filter((l) => CUT_EVENTS.includes(l.event) || l.event === 'tournamentComplete');
        const kinds = later.map((l) => (l.event === 'cutForABuckRound' || l.event === 'cutForABuckReveal' ? `${l.event}:${l.data.round}` : l.event));
        expect(kinds).toEqual([
            'cutForABuckRound:2', 'cutForABuckDrew', 'cutForABuckDrew', 'cutForABuckDrew', 'cutForABuckReveal:2',
            'cutForABuckRound:3', 'cutForABuckDrew', 'cutForABuckDrew', 'cutForABuckReveal:3', 'cutForABuckWinner', 'tournamentComplete',
        ]);
        for (const l of later) {
            expect(l.to).toBe(ctx.t.roomName);
            expect(l.members).toEqual(expect.arrayContaining([out.id, watcher.id]));
        }
        expect(later.filter((l) => ctx.log.indexOf(l) > ctx.log.indexOf(events(ctx.log, 'cutForABuckReveal')[1])).every((l) => l.members.includes(socketOf(ctx, a).id))).toBe(true);
        // the room lines too ("c won cut for a buck."), and nothing private instead
        const winLine = ctx.log.find((l) => l.event === 'tournamentMessage' && l.data.message === `${c} won cut for a buck.`);
        expect(winLine.members).toEqual(expect.arrayContaining([out.id, watcher.id]));
        expect(privateLines(ctx, out)).toEqual([]);
        expect(selfOf(ctx, out, 'serverError')).toEqual([]);
    }, 120000);

    test('legacy lines: a redraw and a reshuffle', () => {
        expect(cutForABuck.revealLines({ round: 4, redraw: true, draws: [{ username: 'a', card: card('7s') }, { username: 'b', card: card('7h') }], eliminated: [] }))
            .toEqual(['Round 4: everyone tied on 7s, so draw again.']);
        expect(cutForABuck.revealLines({ round: 2, redraw: false, draws: [{ username: 'alice', card: card('9h') }, { username: 'bob', card: card('3s') }, { username: 'carol', card: card('3d') }], eliminated: ['bob', 'carol'] }))
            .toEqual(['Round 2: alice 9♥, bob 3♠, carol 3♦. bob and carol are out.']);
        expect(cutForABuck.revealLines({ round: 1, redraw: false, draws: [{ username: 'a', card: card('LO') }, { username: 'b', card: card('HI') }, { username: 'c', card: card('Th') }], eliminated: ['c'] }))
            .toEqual(['Round 1: a LO joker, b HI joker, c 10♥. c is out.']);
        expect(cutForABuck.revealLines({ round: 3, redraw: true, draws: [{ username: 'a', card: card('Ks') }, { username: 'b', card: card('Kh') }], eliminated: [] }))
            .toEqual(['Round 3: everyone tied on kings, so draw again.']);
    });

    test('a reshuffle through the handlers: the round says so and legacy sockets get the line', async () => {
        const ctx = await setupCut(3, { capable: 2 });
        // ties of three until the deck has 2 cards left: 7s x3 rounds..., use a
        // deck whose first 51 cards come in rank triples
        const triples = [];
        for (const r of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']) triples.push(`${r}s`, `${r}h`, `${r}d`);
        cutForABuck.setEngineOptionsForTests({ deck: deckOf(...triples), shuffle: (cards) => cards.map((x) => ({ ...x })) });
        await playToCut(ctx);
        const legacy = socketOf(ctx, ctx.usernames[2]);
        for (let round = 1; round <= 13; round++) {
            await toStage(ctx, 'drawing');
            // the legacy member was drawn for at the open (random slot): the
            // cap members take the two lowest free slots of the triple
            const e = ctx.t.cut.engine;
            const taken = new Set([...e.pending.values()].map((p) => p.slot));
            const free = [0, 1, 2].filter((s) => !taken.has(s));
            // force the legacy draw into the triple too
            const lp = e.pending.get(ctx.usernames[2]);
            if (lp.slot > 2) {
                e.undraw(ctx.usernames[2]);
                e.draw(ctx.usernames[2], free.pop(), { auto: true });
            }
            const left = [0, 1, 2].filter((s) => ![...e.pending.values()].some((p) => p.slot === s));
            cutForABuck.draw(ctx.sockets[0], ctx.io, { round, slot: left[0] });
            cutForABuck.draw(ctx.sockets[1], ctx.io, { round, slot: left[1] });
            expect(events(ctx.log, 'cutForABuckReveal').at(-1).data.redraw).toBe(true);
        }
        // 54 - 39 = 15 left; ... keep tying is impossible, so just check the
        // engine reshuffles when it must: drop the deck to 2 cards
        const e = ctx.t.cut.engine;
        expect(e.deckCount).toBe(15);
        cutGuard.skip('test setup moves cards to the table by hand');
        await toStage(ctx, 'drawing');
        e.cancelRound();
        const moved = e.deck.splice(2);
        e.table.set(ctx.usernames[0], [...(e.table.get(ctx.usernames[0]) || []), ...moved]);
        e.assertValid();
        cutForABuck.openRound(ctx.io, ctx.t);
        const round = events(ctx.log, 'cutForABuckRound').at(-1).data;
        expect(round).toMatchObject({ reshuffled: true, deckCount: 54 });
        expect(privateLines(ctx, legacy)).toContain('Reshuffling: the deck ran out.');
    }, 180000);
});

describe('no cut: today\'s wire', () => {
    const plainComplete = async (ctx) => {
        await playToCut(ctx);
        expect(ctx.t.phase).toBe('complete');
        expect(cutLog(ctx).map((l) => l.event)).toEqual(['tournamentComplete']);
        const data = events(ctx.log, 'tournamentComplete')[0].data;
        expect(Object.keys(data).filter((k) => k !== 'pairings')).toEqual(['scoreboard', 'winners']);
        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(recordSpy.mock.calls[0][1]).toBeNull();
        return data;
    };

    test('an all-legacy tournament: no cut, the payloads of before', async () => {
        const ctx = await setupCut(3, { capable: 0 });
        const data = await plainComplete(ctx);
        expect(data.winners).toEqual(ctx.t.getWinners());
        // the complete phase's state is the same for a legacy socket
        tournamentHandlers.returnToTournament(ctx.sockets[0], ctx.io);
        const joined = selfOf(ctx, ctx.sockets[0], 'tournamentJoined').at(-1);
        expect(joined.phase).toBe('complete');
        expect('cutForABuck' in joined).toBe(false);
        expect('cut' in joined).toBe(false);
    }, 120000);

    test('fewer than 2 connected members: no cut', async () => {
        const ctx = await setupCut(1);
        await plainComplete(ctx);
    }, 120000);

    test('CUT_FOR_A_BUCK=off: no cut', async () => {
        process.env.CUT_FOR_A_BUCK = 'off';
        const ctx = await setupCut(3);
        await plainComplete(ctx);
        // a cap member's complete state carries the null result
        tournamentHandlers.returnToTournament(ctx.sockets[0], ctx.io);
        expect(selfOf(ctx, ctx.sockets[0], 'tournamentJoined').at(-1).cutForABuck).toBeNull();
    }, 120000);

    test('the gather ends with fewer than 2 here: "Not enough players" and the tournament completes', async () => {
        const ctx = await setupCut(2);
        await playToCut(ctx);
        await kill(ctx.io, ctx.sockets[1]);
        await advanceUntil(() => ctx.t.phase === 'complete', 100, 60000);
        expect(roomLines(ctx)).toContain('Not enough players for cut for a buck.');
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        expect(events(ctx.log, 'tournamentComplete')[0].data.cutForABuck).toBeUndefined();
    }, 120000);
});

describe('voice in the complete phase', () => {
    test('a member with cutForABuck (and tournamentVoice) enters the room after the cut; one without cutForABuck does not', async () => {
        const ctx = await setupCut(3, { capable: 2, extraCaps: ['tournamentVoice'] });
        giveCap(ctx.sockets[2], ['tournamentVoice']);
        await playToCut(ctx);
        await advanceUntil(() => ctx.t.phase === 'cut' && ctx.t.cut.stage === 'drawing', 100, 30000);
        await tournamentHandlers.cancelTournament(creatorSocket(ctx), ctx.io);
        expect(ctx.t.phase).toBe('complete');
        for (const s of ctx.sockets) tournamentHandlers.returnToTournament(s, ctx.io);
        const room = ctx.t.voiceRoom.members;
        expect(room.has(ctx.sockets[0].id)).toBe(true);
        expect(room.has(ctx.sockets[1].id)).toBe(true);
        expect(room.has(ctx.sockets[2].id)).toBe(false);
    }, 120000);
});

describe('the draw: refusals, Joi, the rate limit', () => {
    test('stale, repeated, not a player still in, no tournament: dropped silently', async () => {
        const ctx = await setupCut(3);
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('2s', '9h', '9d', 'Ks', 'Qs') });
        await playToCut(ctx);
        const [a, b, c] = ctx.usernames;
        // the gather: no round open
        cutForABuck.draw(socketOf(ctx, a), ctx.io, { round: 1, slot: 0 });
        await toStage(ctx, 'drawing');
        cutForABuck.draw(socketOf(ctx, a), ctx.io, { round: 2, slot: 0 }); // stale / future
        cutForABuck.draw(socketOf(ctx, a), ctx.io, { round: 1, slot: 0 });
        cutForABuck.draw(socketOf(ctx, a), ctx.io, { round: 1, slot: 3 }); // repeat
        const stranger = newUser(ctx.io, ctx.log, `${a}_x`);
        cutForABuck.draw(stranger, ctx.io, { round: 1, slot: 3 });
        expect(events(ctx.log, 'cutForABuckDrew').map((l) => l.data.username)).toEqual([a]);
        cutForABuck.draw(socketOf(ctx, b), ctx.io, { round: 1, slot: 1 });
        cutForABuck.draw(socketOf(ctx, c), ctx.io, { round: 1, slot: 2 });
        expect(events(ctx.log, 'cutForABuckReveal')[0].data.eliminated).toEqual([a]);
        await toStage(ctx, 'drawing');
        cutForABuck.draw(socketOf(ctx, a), ctx.io, { round: 2, slot: 0 }); // eliminated
        expect(events(ctx.log, 'cutForABuckDrew').filter((l) => l.data.round === 2)).toEqual([]);
        for (const s of [...ctx.sockets, stranger]) expect(selfOf(ctx, s, 'serverError')).toEqual([]);
    }, 120000);

    test('Joi: round 1..10000, slot 0..107 or null; 10 draws per 10 s', () => {
        expect(validate('cutForABuckDraw', { round: 1, slot: 0 })).toEqual({ round: 1, slot: 0 });
        expect(validate('cutForABuckDraw', { round: 3, slot: null })).toEqual({ round: 3, slot: null });
        expect(validate('cutForABuckDraw', { round: 2 })).toEqual({ round: 2 });
        for (const bad of [{ round: 0, slot: 1 }, { round: 10001 }, { round: 1, slot: -1 }, { round: 1, slot: 108 }, { round: 1, slot: 2.5 }, { round: '1' }, { slot: 1 }, null]) {
            expect(() => validate('cutForABuckDraw', bad)).toThrow();
        }
        let allowed = 0;
        for (let i = 0; i < 15; i++) if (rateLimiter.check('s-cut-rate', 'cutForABuckDraw')) allowed++;
        expect(allowed).toBe(10);
    });
});

describe('the round cap and the kill switch read at each start', () => {
    test('CUT_MAX_ROUNDS: a uniformly random player still in wins, with an error log', async () => {
        process.env.CUT_MAX_ROUNDS = '2';
        const ctx = await setupCut(3);
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('7s', '7h', '7d', '8s', '8h', '8d'), randomInt: () => 1 });
        await playToCut(ctx);
        for (let r = 1; r <= 2; r++) {
            await toStage(ctx, 'drawing');
            drawAll(ctx, Object.fromEntries(ctx.usernames.map((u, i) => [u, i])));
        }
        await toStage(ctx, 'winner');
        expect(events(ctx.log, 'cutForABuckWinner')[0].data).toEqual({ winner: ctx.usernames[1], participants: ctx.usernames, rounds: 2 });
        expect(errorLogs.map((l) => l.msg)).toEqual(['Cut for a buck: round cap reached, a random winner']);
        errorLogs.length = 0;
    }, 120000);
});

describe('secrecy', () => {
    test('no pending card ever reaches a socket; the guard catches one that does', async () => {
        const ctx = await setupCut(3);
        await playToCut(ctx);
        await toStage(ctx, 'drawing');
        cutForABuck.draw(ctx.sockets[0], ctx.io, { round: 1, slot: 5 });
        // a reattach mid-round: drawn slots only
        tournamentHandlers.returnToTournament(ctx.sockets[0], ctx.io);
        expect(cutGuard._take()).toEqual([]);
        const pending = ctx.t.cut.engine.pendingCards()[0];
        // a synthetic leak (straight into the guard: the contract would refuse the key)
        cutGuard.checkEntry({ event: 'cutForABuckDrew', to: ctx.t.roomName }, { round: 1, username: ctx.usernames[0], slot: 5, auto: false, card: pending });
        const caught = cutGuard._take();
        expect(caught).toHaveLength(1);
        expect(caught[0]).toMatchObject({ event: 'cutForABuckDrew', card: `${pending.suit}:${pending.rank}` });
        // after the reveal the same card is fine
        drawAll(ctx);
        cutGuard.checkEntry({ event: 'tournamentJoined', to: 'self:x' }, { cut: { lastReveal: { draws: [{ card: pending }] } } });
        expect(cutGuard._take()).toEqual([]);
    }, 120000);
});

describe('the iOS baselines', () => {
    test('every cut payload and the changed tournament payloads validate against b39 and b40 (the events they know)', async () => {
        const ctx = await setupCut(3, { capable: 2 });
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('7s', '7h', '7d', '2s', 'Kh', 'Qh') });
        await playToCut(ctx);
        await toStage(ctx, 'drawing');
        drawAll(ctx);
        await toStage(ctx, 'drawing');
        await tournamentHandlers.leaveTournament(ctx.sockets[1], ctx.io);
        drawAll(ctx);
        await advanceUntil(() => ctx.t.phase === 'complete', 200, 120000);
        tournamentHandlers.returnToTournament(ctx.sockets[2], ctx.io);
        const checked = new Set();
        for (const build of ['1.2.5-b39', '1.2.6-b40']) {
            for (const l of ctx.log) {
                if (!(CUT_EVENTS.includes(l.event) || l.event.startsWith('tournament') || l.event === 'lobbiesUpdated')) continue;
                const errors = baselineCheck(build, l.event, l.data);
                if (errors === null) continue;
                checked.add(l.event);
                expect({ build, event: l.event, errors }).toEqual({ build, event: l.event, errors: [] });
            }
        }
        expect([...checked]).toEqual(expect.arrayContaining(['tournamentComplete', 'tournamentJoined', 'tournamentMessage', 'lobbiesUpdated']));
    }, 120000);
});

/** A new stub socket signed in as an existing member (a reconnect). */
function newUserAs(ctx, username) {
    const id = `${username}-back-${Math.floor(Math.random() * 1e9)}`;
    gameManager.registerUser(id, username);
    const { makeSocket } = require('../../testUtils/gameDriver');
    const s = makeSocket(id, ctx.log, ctx.io);
    giveCap(s);
    return s;
}

/** Drive the round just begun (ctx.starting) to its end with every human /lazy. */
async function playRoundOut(ctx) {
    const chatHandlers = require('../chatHandlers');
    await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.entrants === null), 100, 120000);
    await ctx.starting;
    const tables = liveTables(ctx.t);
    for (let step = 0; step < 800 && ctx.t.phase === 'round_active'; step++) {
        for (const g of tables) {
            if (g.isTerminal()) continue;
            for (const seat of g.seatList()) {
                if (seat.controller !== 'human' || seat.presence !== 'connected') continue;
                const s = ctx.sockets.find((x) => x.id === seat.ownerSocketId);
                if (s) chatHandlers.chatMessage(s, ctx.io, { message: '/lazy' });
            }
        }
        await jest.advanceTimersByTimeAsync(5000);
    }
}

void setupTournament;
void playTournament;
void contract;
