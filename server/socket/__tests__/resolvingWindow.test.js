/**
 * The server-timed holds (GameState.hold / scheduleResume, pacing.js):
 * TRICK_RESOLVING and HAND_RESOLVING return at once and resume on the
 * 'resume' game timer. Inside the window every action is rejected
 * deterministically (never queued), seat changes schedule nothing until
 * resume, a rejoin sees exactly the pre-resolution table and then gets the
 * resolution once, and an abort leaves nothing behind.
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
const seatLifecycle = require('../seatLifecycle');
const gameLifecycle = require('../gameLifecycle');
const pacing = require('../../game/pacing');
const { botController } = require('../../game/bot');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, logger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, logger]) {
        jest.spyOn(l, 'info').mockImplementation(() => {});
        jest.spyOn(l, 'debug').mockImplementation(() => {});
        jest.spyOn(l, 'warn').mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/**
 * Four human seats in PLAYING on a 2-card hand, all hearts (seat 4's 8 and
 * 9 win both tricks), seat 1 to lead.
 */
function setup() {
    seq++;
    const log = [];
    const io = makeIo(log);
    const ids = [1, 2, 3, 4].map((n) => `w${seq}-h${n}`);
    const names = ids.map((id) => `u_${id}`);
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
    game.forcePhase('PLAYING');
    game.currentTurn = 1;
    game.bids = { team1: 1, team2: 1 };
    game.playerBids = ['1', '0', '0', '1'];
    return { log, io, game, ids, names, sockets };
}

/** Play trick 1 (2, 4, 6, 8 of hearts): seat 4 wins. Returns in TRICK_RESOLVING. */
async function firstTrick(t) {
    const cards = [C('2', 'hearts'), C('4', 'hearts'), C('6', 'hearts'), C('8', 'hearts')];
    for (let i = 0; i < 4; i++) await gameHandlers.playCard(t.sockets[i], t.io, { card: cards[i] });
    expect(t.game.stage).toBe(Phase.TRICK_RESOLVING);
}

/** Trick 2 led by seat 4 (9, 3, 5, 7): the last trick of the hand. */
async function lastTrick(t) {
    const order = [[3, C('9', 'hearts')], [0, C('3', 'hearts')], [1, C('5', 'hearts')], [2, C('7', 'hearts')]];
    for (const [i, card] of order) await gameHandlers.playCard(t.sockets[i], t.io, { card });
    expect(t.game.stage).toBe(Phase.TRICK_RESOLVING);
}

const P = () => pacing();
const botKeys = (game, kind) => [...botController.pendingActions.keys()]
    .filter((k) => k.startsWith(`${game.gameId}:`) && (!kind || k.endsWith(`:${kind}`)));

describe('actions inside the window are rejected, never queued', () => {
    test('a play or a bid during HAND_RESOLVING gets not_your_turn and changes nothing', async () => {
        const t = setup();
        await firstTrick(t);
        await jest.advanceTimersByTimeAsync(P().TRICK_VIEW_MS);
        await lastTrick(t);
        await jest.advanceTimersByTimeAsync(P().TRICK_VIEW_MS);
        expect(t.game.stage).toBe(Phase.HAND_RESOLVING);
        expect(t.game.resumeInfo().kind).toBe('hand');
        const mark = t.log.length;
        await gameHandlers.playCard(t.sockets[3], t.io, { card: C('9', 'hearts') });
        await gameHandlers.playerBid(t.sockets[1], t.io, { bid: '1' });
        expect(t.log.slice(mark).map((l) => [l.event, l.data.reason])).toEqual([
            ['actionRejected', 'not_your_turn'], ['actionRejected', 'not_your_turn'],
        ]);
        expect(t.game.stage).toBe(Phase.HAND_RESOLVING);
        // ...and the hand resumes on time: handComplete, the next deal and its turn in one tick
        await jest.advanceTimersByTimeAsync(P().HAND_END_MS);
        const hc = events(t.log, 'handComplete');
        expect(hc).toHaveLength(1);
        expect(t.game.stage).toBe(Phase.BIDDING);
        const after = t.log.slice(t.log.indexOf(hc[0]));
        const turn = after.find((l) => l.event === 'updateTurn');
        expect(after.find((l) => l.event === 'gameStart').at).toBe(hc[0].at);
        expect(turn.at).toBe(hc[0].at);
    });
});

describe('rejoin during a hold', () => {
    test('TRICK_RESOLVING: the pre-resolution table, then trickComplete and updateTurn once', async () => {
        const t = setup();
        await firstTrick(t);
        await jest.advanceTimersByTimeAsync(Math.floor(P().TRICK_VIEW_MS / 2));
        const r = makeSocket(`w${seq}-r2`, t.log, t.io);
        gameManager.registerUser(r.id, t.names[1]);
        await reconnectHandlers.rejoinGame(r, t.io, { gameId: t.game.gameId, username: t.names[1] });
        const ok = t.log.find((l) => l.to === `self:${r.id}` && l.event === 'rejoinSuccess').data;
        // v1: exactly the in-window projection (4 cards, all played, next turn, uncounted)
        expect(ok.playedCards.filter(Boolean)).toHaveLength(4);
        expect(ok.currentTurn).toBe(1);
        expect(ok.tricks).toEqual({ team1: 0, team2: 0 });
        expect(ok.snapshot.turn).toBeNull();
        expect(ok.snapshot.trick.cards).toHaveLength(4);
        expect(ok.snapshot.tricks).toEqual({ team1: 0, team2: 0 });
        expect(t.io.rooms.get(t.game.roomName).has(r.id)).toBe(true);

        const mark = t.log.length;
        await jest.advanceTimersByTimeAsync(P().TRICK_VIEW_MS);
        const later = t.log.slice(mark).filter((l) => l.to === t.game.roomName).map((l) => l.event);
        expect(later.filter((e) => e === 'trickComplete')).toHaveLength(1);
        expect(later.indexOf('updateTurn')).toBeGreaterThan(later.indexOf('trickComplete'));
        expect(t.game.tricks).toEqual({ team1: 0, team2: 1 });
    });

    test('HAND_RESOLVING: the trick is counted once, the cards are off the table', async () => {
        const t = setup();
        await firstTrick(t);
        await jest.advanceTimersByTimeAsync(P().TRICK_VIEW_MS);
        await lastTrick(t);
        await jest.advanceTimersByTimeAsync(P().TRICK_VIEW_MS);
        expect(t.game.stage).toBe(Phase.HAND_RESOLVING);
        const r = makeSocket(`w${seq}-r3`, t.log, t.io);
        gameManager.registerUser(r.id, t.names[2]);
        await reconnectHandlers.rejoinGame(r, t.io, { gameId: t.game.gameId, username: t.names[2] });
        const ok = t.log.find((l) => l.to === `self:${r.id}` && l.event === 'rejoinSuccess').data;
        expect(ok.playedCards).toEqual([]);
        expect(ok.tricks).toEqual({ team1: 0, team2: 2 });
        expect(ok.snapshot.turn).toBeNull();
        await jest.advanceTimersByTimeAsync(P().HAND_END_MS);
        expect(events(t.log, 'handComplete')).toHaveLength(1);
        expect(t.log.some((l) => l.to === r.id && l.event === 'gameStart')).toBe(true);
    });
});

describe('seat changes inside the window', () => {
    test('/lazy on the winner\'s seat schedules its bot only at resume', async () => {
        const t = setup();
        await firstTrick(t);
        const traced = [];
        pacing.setTracer((kind, ms) => traced.push({ kind, ms }));
        chatHandlers.chatMessage(t.sockets[3], t.io, { message: '/lazy' });
        expect(t.game.seat(4).controller).toBe('lazyBot');
        expect(botKeys(t.game, 'play')).toEqual([]);
        await jest.advanceTimersByTimeAsync(P().TRICK_VIEW_MS);
        expect(botKeys(t.game, 'play')).toHaveLength(1);
        const play = traced.filter((x) => x.kind.startsWith('botPlay'));
        expect(play).toHaveLength(1);
        expect(play[0].ms).toBeGreaterThanOrEqual(P().BOT_LEAD_AFTER_TRICK[0]);
        await jest.advanceTimersByTimeAsync(P().BOT_LEAD_AFTER_TRICK[0] + P().BOT_LEAD_AFTER_TRICK[1]);
        const played = events(t.log, 'cardPlayed').pop().data;
        expect(played.position).toBe(4);
    });

    test('/active inside the window: no private updateTurn, no stale bot chat, the resume turn enables the seat', async () => {
        const t = setup();
        await firstTrick(t);
        chatHandlers.chatMessage(t.sockets[3], t.io, { message: '/lazy' });
        const bot = botController.getBot(t.game.gameId, t.game.seat(4).seatSocketId);
        botController.sendBotChat(t.io, t.game, bot, 'stale', 500);
        const mark = t.log.length;
        chatHandlers.chatMessage(t.sockets[3], t.io, { message: '/active' });
        expect(t.game.seat(4).controller).toBe('human');
        expect(t.log.slice(mark).some((l) => l.event === 'updateTurn')).toBe(false);
        expect(botKeys(t.game)).toEqual([]);
        await jest.advanceTimersByTimeAsync(P().TRICK_VIEW_MS + 1000);
        expect(t.log.slice(mark).some((l) => l.event === 'chatMessage')).toBe(false);
        const turn = t.log.slice(mark).find((l) => l.event === 'updateTurn');
        expect(turn.to).toBe(t.game.roomName);
        expect(turn.data.currentTurn).toBe(4);
        const before = t.log.length;
        await gameHandlers.playCard(t.sockets[3], t.io, { card: C('9', 'hearts') });
        expect(t.log.slice(before).map((l) => l.event)).toContain('cardPlayed');
    });

    test('a resign of the winner\'s seat inside the window: its bot leads at resume, not before', async () => {
        const t = setup();
        await firstTrick(t);
        t.io.sockets.sockets.delete(t.ids[3]);
        await queueHandlers.handleDisconnect(t.sockets[3], t.io);
        expect(t.game.seat(4).presence).toBe('grace');
        t.game.clearTimer('grace:4');
        seatLifecycle.onGraceExpired(t.io, t.game, 4);
        expect(t.game.seat(4).presence).toBe('resignable');
        await gameHandlers.forceResign(t.sockets[0], t.io, { position: 4 });
        expect(t.game.seat(4).controller).toBe('resignBot');
        expect(botKeys(t.game, 'play')).toEqual([]);
        expect(t.game.stage).toBe(Phase.TRICK_RESOLVING);
        await jest.advanceTimersByTimeAsync(P().TRICK_VIEW_MS);
        expect(botKeys(t.game, 'play')).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(P().BOT_LEAD_AFTER_TRICK[0] + P().BOT_LEAD_AFTER_TRICK[1]);
        expect(events(t.log, 'cardPlayed').pop().data.position).toBe(4);
    });
});

describe('abort inside the window', () => {
    test.each(['trick', 'hand'])('%s hold: nothing emitted after abortGame, nothing left behind', async (kind) => {
        const t = setup();
        await firstTrick(t);
        if (kind === 'hand') {
            await jest.advanceTimersByTimeAsync(P().TRICK_VIEW_MS);
            await lastTrick(t);
            await jest.advanceTimersByTimeAsync(P().TRICK_VIEW_MS);
            expect(t.game.stage).toBe(Phase.HAND_RESOLVING);
        } else {
            await jest.advanceTimersByTimeAsync(Math.floor(P().TRICK_VIEW_MS / 2));
        }
        expect(t.game.hasTimer('resume')).toBe(true);
        await gameLifecycle.abortGame(t.io, t.game, 'test');
        const idx = t.log.findIndex((l) => l.event === 'abortGame');
        await jest.advanceTimersByTimeAsync(P().GAME_END_MS + P().HAND_END_MS + P().TRICK_VIEW_MS);
        expect(t.log.slice(idx + 1).filter((l) => l.to === t.game.roomName)).toEqual([]);
        expect(t.game.pendingTimerCount).toBe(0);
        expect(t.game.resume).toBeNull();
        expect(botKeys(t.game)).toEqual([]);
    });
});
