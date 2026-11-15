/**
 * Bot failures and the progress watchdog (progressWatchdog.js).
 *
 * Bot bids and plays go through the same GameState.applyBid / applyPlay as a
 * human's; a strategy that throws or picks something the rules refuse is
 * logged, counted (botController.fallbacks) and replaced by rules.safeBid /
 * the first legal card, so the game still completes. A bot turn that never
 * acts (a lost action) or a resolving stage that never moves on is retried
 * (bot turns) after GAME_STALL_MS and aborted ('Game stalled') after
 * GAME_STALL_RETRY_MS more; a tournament table aborted that way still lets
 * its round finish. A slow human turn is never touched.
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
const gameLifecycle = require('../gameLifecycle');
const tournamentHandlers = require('../tournamentHandlers');
const progressWatchdog = require('../progressWatchdog');
const rules = require('../../game/rules');
const pacing = require('../../game/pacing');
const BotPlayer = require('../../game/bot/BotPlayer');
const { botController } = require('../../game/bot');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events, legalCards } = require('../../testUtils/gameDriver');
const { setupTournament, liveTables, advanceUntil } = require('../../testUtils/tournamentDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
const STALL = progressWatchdog.STALL_MS;
const RETRY = progressWatchdog.STALL_RETRY_MS;
let seq = 0;
let errorLog;

// Whole bot games (the play search included) on fake timers
jest.setTimeout(60000);

beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.GAME_STALL_MS;
    delete process.env.GAME_STALL_RETRY_MS;
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    errorLog = [];
    jest.spyOn(gameLogger, 'error').mockImplementation((msg, meta) => errorLog.push({ msg, meta, at: Date.now() }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    pacing.setPacingForTests('zero');
    botController.fallbacks.bid = 0;
    botController.fallbacks.play = 0;
});

afterEach(() => {
    delete process.env.GAME_STALL_MS;
    delete process.env.GAME_STALL_RETRY_MS;
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const logged = (msg) => errorLog.filter((e) => e.msg === msg);

/**
 * A real game from the draw on: `humans` connected humans (seats by the
 * draw) and native bots for the rest.
 */
function startGame({ humans = 0 } = {}) {
    seq++;
    const log = [];
    const io = makeIo(log);
    const ids = Array.from({ length: humans }, (_, i) => `bf${seq}-h${i + 1}`);
    ids.forEach((id) => {
        gameManager.registerUser(id, `bf${seq}_${id}`);
        mockDb.current.users._insert({ username: `bf${seq}_${id}`, profilePic: 4 });
    });
    const sockets = ids.map((id) => makeSocket(id, log, io));
    const bots = Array.from({ length: 4 - humans }, (_, i) => botController.createBot(`🤖 F${i}`, 'mary'));
    const game = gameManager.createGame([...ids, ...bots.map((b) => b.socketId)]);
    bots.forEach((b) => botController.registerBot(game.gameId, b));
    sockets.forEach((s) => s.join(game.roomName));
    gameLifecycle.beginDraw(io, game);
    for (const s of sockets) gameHandlers.draw(s, io, { num: 0 });
    return { log, io, game, ids, sockets, bots };
}

/** The humans act at once on every turn of theirs (bid 1 if legal, else 0; first legal card). */
async function driveHumans(ctx) {
    const { game, io, sockets } = ctx;
    if (!game.acceptsTurnInput() || game.resume) return;
    const s = sockets.find((x) => game.getPositionBySocketId(x.id) === game.currentTurn);
    if (!s || game.seat(game.currentTurn).controller !== 'human') return;
    if (game.stage === Phase.BIDDING) {
        await gameHandlers.playerBid(s, io, { bid: rules.isValidBid('1', game.playerBids, game.currentHand) ? '1' : '0' });
    } else {
        await gameHandlers.playCard(s, io, { card: legalCards(game, s.id)[0] });
    }
}

async function playUntil(ctx, pred, cap = 600000) {
    let t = 0;
    while (!pred() && t < cap) {
        await driveHumans(ctx);
        await jest.advanceTimersByTimeAsync(500);
        t += 500;
    }
    if (!pred()) throw new Error(`playUntil: never met (stage ${ctx.game.stage})`);
}

/** Every card played was legal when it was played (applyPlay's own verdicts). */
function recordPlays(game) {
    const verdicts = [];
    const real = game.applyPlay.bind(game);
    jest.spyOn(game, 'applyPlay').mockImplementation((...args) => {
        const r = real(...args);
        verdicts.push(r.ok);
        return r;
    });
    return verdicts;
}

describe('rules: the shared legality and fallbacks', () => {
    const trump = C('A', 'spades');
    const lead = { leadCard: null, isLeading: true, trump, trumpBroken: false, position: 2, leadPosition: null };

    test('isLegalPlay: card must be in hand; no trump lead before trump is broken unless trump tight', () => {
        const hand = [C('3', 'spades'), C('4', 'hearts')];
        expect(rules.isLegalPlay(C('3', 'spades'), hand, lead)).toBe(false);
        expect(rules.isLegalPlay(C('4', 'hearts'), hand, lead)).toBe(true);
        expect(rules.isLegalPlay(C('5', 'hearts'), hand, lead)).toBe(false);
        expect(rules.isLegalPlay(C('3', 'spades'), [C('3', 'spades'), C('HI', 'joker')], lead)).toBe(true);
    });

    test('isLegalPlay: follow suit', () => {
        const follow = { ...lead, isLeading: false, leadCard: C('9', 'hearts'), leadPosition: 1 };
        const hand = [C('3', 'clubs'), C('4', 'hearts')];
        expect(rules.isLegalPlay(C('3', 'clubs'), hand, follow)).toBe(false);
        expect(rules.isLegalPlay(C('4', 'hearts'), hand, follow)).toBe(true);
    });

    test('firstLegalCard: hand order, null for an empty hand', () => {
        expect(rules.firstLegalCard([C('3', 'spades'), C('4', 'hearts'), C('5', 'hearts')], lead)).toEqual(C('4', 'hearts'));
        expect(rules.firstLegalCard([], lead)).toBeNull();
    });

    test('safeBid: 0, or 1 for the last bidder over three zeros (no endless redeal)', () => {
        expect(rules.safeBid([])).toBe('0');
        expect(rules.safeBid(['0', '0', undefined, undefined])).toBe('0');
        expect(rules.safeBid(['0', '0', '0', undefined])).toBe('1');
        expect(rules.safeBid([undefined, '0', '0', '0'])).toBe('1');
        expect(rules.safeBid(['0', 'B', '0', undefined])).toBe('0');
    });
});

describe('GameState.applyPlay keeps the human refusal shape', () => {
    test('an illegal card is refused and moves to the end of the hand (fixture-pinned); a legal one is played', () => {
        const ids = ['ap-1', 'ap-2', 'ap-3', 'ap-4'];
        const game = gameManager.createGame(ids);
        ids.forEach((id, i) => game.addPlayer(id, `ap${i}`, i + 1, i + 1, false));
        game.currentHand = 2;
        game.trump = C('A', 'spades');
        game.forcePhase('PLAYING');
        game.currentTurn = 1;
        game.setHand('ap-1', [C('3', 'spades'), C('4', 'hearts')]);
        expect(game.applyPlay(1, C('3', 'spades'), 'ap-1')).toEqual({ ok: false, reason: 'illegal_card' });
        expect(game.getHand('ap-1')).toEqual([C('4', 'hearts'), C('3', 'spades')]);
        expect(game.applyPlay(1, C('9', 'clubs'), 'ap-1')).toEqual({ ok: false, reason: 'invalid_play', error: 'Card not in hand' });
        expect(game.applyPlay(2, C('4', 'hearts'), 'ap-2')).toEqual({ ok: false, reason: 'not_your_turn' });
        expect(game.applyPlay(1, C('4', 'hearts'), 'ap-1')).toEqual({ ok: true });
        expect(game.playedCards[0]).toEqual(C('4', 'hearts'));
        expect(game.leadPosition).toBe(1);
        expect(game.getHand('ap-1')).toEqual([C('3', 'spades')]);
    });

    test('applyBid: turn, repeat and value checks; the bid is normalized', () => {
        const ids = ['ab-1', 'ab-2', 'ab-3', 'ab-4'];
        const game = gameManager.createGame(ids);
        ids.forEach((id, i) => game.addPlayer(id, `ab${i}`, i + 1, i + 1, false));
        game.currentHand = 2;
        game.forcePhase('BIDDING');
        game.playerBids = [];
        game.currentTurn = 1;
        expect(game.applyBid(2, '1')).toEqual({ ok: false, reason: 'not_your_turn' });
        expect(game.applyBid(1, '3')).toEqual({ ok: false, reason: 'invalid_bid', bid: '3' });
        expect(game.applyBid(1, '2b')).toEqual({ ok: false, reason: 'invalid_bid', bid: '2B' });
        expect(game.applyBid(1, 'b')).toEqual({ ok: true, bid: 'B' });
        expect(game.applyBid(1, '1')).toEqual({ ok: false, reason: 'already_bid' });
    });
});

describe('bot fallbacks: the game completes', () => {
    test('a strategy that throws on every card: the first legal card is played', async () => {
        jest.spyOn(BotPlayer.prototype, 'decideCard').mockImplementation(() => { throw new Error('boom'); });
        const ctx = startGame();
        const verdicts = recordPlays(ctx.game);
        await playUntil(ctx, () => ctx.game.isTerminal());
        expect(events(ctx.log, 'gameEnd')).toHaveLength(1);
        // 13 hands, 1+2+...: 91 cards per seat
        expect(events(ctx.log, 'cardPlayed')).toHaveLength(364);
        expect(verdicts.every(Boolean)).toBe(true);
        expect(botController.fallbacks.play).toBe(364);
        const line = logged('Bot play refused, playing the first legal card')[0];
        expect(line.meta).toMatchObject({ gameId: ctx.game.gameId, reason: 'strategy_threw', error: 'boom', stage: Phase.PLAYING });
        expect(line.meta.position).toBeGreaterThanOrEqual(1);
        expect(logged('Game stalled')).toEqual([]);
    });

    test('a strategy that picks illegal cards or cards it does not hold: refused and replaced', async () => {
        const real = BotPlayer.prototype.decideCard;
        let n = 0;
        jest.spyOn(BotPlayer.prototype, 'decideCard').mockImplementation(function (hand, playedCards, leadCard, leadPosition, trump, trumpBroken, ...rest) {
            n++;
            const isLeading = !playedCards.some(Boolean);
            const trick = { leadCard, isLeading, trump, trumpBroken, position: this.position, leadPosition };
            const illegal = hand.find((c) => !rules.isLegalPlay(c, hand, trick));
            if (illegal) return illegal;
            if (n % 3 === 0) return C('A', 'nonsense');
            return real.call(this, hand, playedCards, leadCard, leadPosition, trump, trumpBroken, ...rest);
        });
        const ctx = startGame();
        const verdicts = recordPlays(ctx.game);
        await playUntil(ctx, () => ctx.game.isTerminal());
        expect(events(ctx.log, 'gameEnd')).toHaveLength(1);
        expect(events(ctx.log, 'cardPlayed')).toHaveLength(364);
        expect(verdicts.every(Boolean)).toBe(true);
        const reasons = new Set(logged('Bot play refused, playing the first legal card').map((e) => e.meta.reason));
        expect(reasons).toEqual(new Set(['illegal_card', 'invalid_play']));
        expect(botController.fallbacks.play).toBeGreaterThan(0);
        expect(logged('Bot play refused, playing the first legal card').some((e) => typeof e.meta.chosen === 'string')).toBe(true);
    });

    test('a bid strategy that throws or bids what the rules refuse: the safe bid, and no endless redeal', async () => {
        let n = 0;
        jest.spyOn(BotPlayer.prototype, 'decideBid').mockImplementation(() => {
            n++;
            if (n % 2) throw new Error('bid boom');
            return '13'; // refused below the 13-card hand
        });
        const ctx = startGame();
        await playUntil(ctx, () => ctx.game.isTerminal());
        expect(events(ctx.log, 'gameEnd')).toHaveLength(1);
        const bids = events(ctx.log, 'bidReceived').map((e) => e.data.bid);
        expect(new Set(bids)).toEqual(new Set(['0', '1', '13']));
        const reasons = new Set(logged('Bot bid refused, bidding the safe bid').map((e) => e.meta.reason));
        expect(reasons).toEqual(new Set(['strategy_threw', 'invalid_bid']));
        expect(botController.fallbacks.bid).toBeGreaterThan(0);
    });
});

describe('progress watchdog', () => {
    test('config: 90 s + 30 s by default, env overrides, 0 disables', () => {
        expect(STALL).toBe(90000);
        expect(RETRY).toBe(30000);
        expect(progressWatchdog.timeouts({})).toEqual({ stallMs: 90000, retryMs: 30000 });
        expect(progressWatchdog.timeouts({ GAME_STALL_MS: '500', GAME_STALL_RETRY_MS: '200' })).toEqual({ stallMs: 500, retryMs: 200 });
        expect(progressWatchdog.timeouts({ GAME_STALL_MS: 'soon' }).stallMs).toBe(90000);
    });

    /** Drop the bot actions `drop(n)` says to (n counts every schedule). */
    function loseBotActions(drop) {
        const real = botController.scheduleBotAction.bind(botController);
        const dropped = [];
        let n = 0;
        jest.spyOn(botController, 'scheduleBotAction').mockImplementation((io, game, type, handler) => {
            n++;
            if (drop(n, game, type)) {
                dropped.push({ n, at: Date.now(), gameId: game.gameId, type });
                return;
            }
            real(io, game, type, handler);
        });
        return dropped;
    }

    test('a bot action that never happens, with a connected human at the table: retried at 90 s, aborted 30 s later', async () => {
        const dropped = loseBotActions(() => true);
        const ctx = startGame({ humans: 1 });
        await playUntil(ctx, () => dropped.length > 0);
        const t0 = dropped[0].at;
        const turn = ctx.game.turnKey();

        await jest.advanceTimersByTimeAsync(STALL - 1000);
        expect(ctx.game.isTerminal()).toBe(false);
        expect(logged('Game stalled')).toEqual([]);

        await jest.advanceTimersByTimeAsync(1000);
        const [stalled] = logged('Game stalled');
        expect(stalled.at - t0).toBe(STALL);
        expect(stalled.meta).toMatchObject({ gameId: ctx.game.gameId, kind: 'bot', retry: true, turnKey: turn });
        // The retry scheduled the bot action again (and lost it again)
        expect(dropped).toHaveLength(2);
        expect(ctx.game.isTerminal()).toBe(false);

        await jest.advanceTimersByTimeAsync(RETRY);
        expect(ctx.game.stage).toBe(Phase.ABORTED);
        const [aborted] = logged('Game stalled, aborting');
        expect(aborted.at - t0).toBe(STALL + RETRY);
        expect(aborted.meta).toMatchObject({ gameId: ctx.game.gameId, kind: 'bot' });
        expect(events(ctx.log, 'abortGame').map((e) => e.data.reason)).toEqual([progressWatchdog.ABORT_REASON]);
        expect(gameManager.getGameById(ctx.game.gameId)).toBeFalsy();
        expect(ctx.game.pendingTimerCount).toBe(0);
    });

    test('a state that moved on without an arm point is stalled 30 s after the next firing, not 90 s', async () => {
        const dropped = loseBotActions(() => true);
        const ctx = startGame();
        await playUntil(ctx, () => dropped.length > 0);
        const t0 = dropped[0].at;
        // The turn rotates but nothing triggers the next bot (e.g. a
        // continuation that failed after the rotate)
        ctx.game.currentTurn = (ctx.game.currentTurn % 4) + 1;
        const turn = ctx.game.turnKey();

        await jest.advanceTimersByTimeAsync(t0 + STALL + RETRY - 1 - Date.now());
        expect(logged('Game stalled')).toEqual([]);
        await jest.advanceTimersByTimeAsync(1);
        const [stalled] = logged('Game stalled');
        expect(stalled.at - t0).toBe(STALL + RETRY);
        expect(stalled.meta).toMatchObject({ kind: 'bot', retry: true, turnKey: turn });

        await jest.advanceTimersByTimeAsync(RETRY);
        expect(ctx.game.stage).toBe(Phase.ABORTED);
        expect(logged('Game stalled, aborting')[0].at - t0).toBe(STALL + 2 * RETRY);
    });

    test('a bot bid retried after its bid was recorded is skipped as stale, not a fallback', async () => {
        const dropped = loseBotActions(() => true);
        const ctx = startGame();
        await playUntil(ctx, () => dropped.length > 0);
        expect(ctx.game.stage).toBe(Phase.BIDDING);
        const pos = ctx.game.currentTurn;
        const bot = ctx.bots.find((b) => ctx.game.getPositionBySocketId(b.socketId) === pos);
        ctx.game.recordBid(pos, '1');
        expect(botController.processBotBid(ctx.io, ctx.game, bot)).toBe(false);
        expect(ctx.game.playerBids[pos - 1]).toBe('1');
        expect(botController.fallbacks.bid).toBe(0);
        expect(errorLog).toEqual([]);
    });

    test('a lost bot action that the retry recovers: the game completes, nothing aborted', async () => {
        const dropped = loseBotActions((n) => n === 5);
        const ctx = startGame();
        await playUntil(ctx, () => ctx.game.isTerminal());
        expect(dropped).toHaveLength(1);
        expect(logged('Game stalled')).toHaveLength(1);
        expect(logged('Game stalled, aborting')).toEqual([]);
        expect(events(ctx.log, 'gameEnd')).toHaveLength(1);
        expect(events(ctx.log, 'abortGame')).toEqual([]);
    });

    test('a resolving stage whose continuation is lost: no retry, aborted at 90 + 30 s', async () => {
        const ctx = startGame();
        const real = ctx.game.scheduleResume.bind(ctx.game);
        let lostAt = null;
        jest.spyOn(ctx.game, 'scheduleResume').mockImplementation((kind, ...rest) => {
            if (kind === 'trick' && lostAt === null) {
                lostAt = Date.now();
                return true; // the trick never resolves
            }
            return real(kind, ...rest);
        });
        await playUntil(ctx, () => lostAt !== null);
        expect(ctx.game.stage).toBe(Phase.TRICK_RESOLVING);
        await jest.advanceTimersByTimeAsync(STALL);
        expect(logged('Game stalled')[0].meta).toMatchObject({ kind: 'resolving', retry: false, stage: Phase.TRICK_RESOLVING });
        expect(ctx.game.isTerminal()).toBe(false);
        await jest.advanceTimersByTimeAsync(RETRY);
        expect(ctx.game.stage).toBe(Phase.ABORTED);
        expect(logged('Game stalled, aborting')[0].at - lostAt).toBe(STALL + RETRY);
    });

    test('a slow human turn is never touched (solo game: no AFK either)', async () => {
        const ctx = startGame({ humans: 1 });
        const human = ctx.sockets[0];
        // Bots play until it is the human's turn
        let t = 0;
        while (!(ctx.game.acceptsTurnInput() && !ctx.game.resume && ctx.game.getPositionBySocketId(human.id) === ctx.game.currentTurn) && t < 60000) {
            await jest.advanceTimersByTimeAsync(100);
            t += 100;
        }
        const turn = ctx.game.turnKey();
        expect(ctx.game.hasTimer(progressWatchdog.KEY)).toBe(false);
        await jest.advanceTimersByTimeAsync(10 * (STALL + RETRY));
        expect(ctx.game.turnKey()).toBe(turn);
        expect(ctx.game.isTerminal()).toBe(false);
        expect(logged('Game stalled')).toEqual([]);
        // ...and the game goes on when the human acts
        await playUntil(ctx, () => ctx.game.turnKey() !== turn);
    });

    test('GAME_STALL_MS shortens it (tests and drills); 0 disables it', async () => {
        process.env.GAME_STALL_MS = '2000';
        process.env.GAME_STALL_RETRY_MS = '1000';
        loseBotActions(() => true);
        const ctx = startGame();
        await playUntil(ctx, () => ctx.game.isTerminal(), 20000);
        expect(events(ctx.log, 'abortGame').map((e) => e.data.reason)).toEqual(['Game stalled']);

        process.env.GAME_STALL_MS = '0';
        const quiet = startGame();
        await jest.advanceTimersByTimeAsync(10 * (STALL + RETRY));
        expect(quiet.game.isTerminal()).toBe(false);
        expect(quiet.game.hasTimer(progressWatchdog.KEY)).toBe(false);
    });

    test('a stuck tournament table is aborted and the round still finishes (no scores for it)', async () => {
        const ctx = await setupTournament(8); // two 4-human tables
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.entrants === null), 100, 120000);
        await ctx.starting;
        const [stuck, other] = liveTables(ctx.t);
        // Every action at the stuck table is lost; its owners stay connected
        loseBotActions((n, game) => game.gameId === stuck.gameId);
        for (const g of [stuck, other]) {
            for (const seat of g.seatList()) {
                chatHandlers.chatMessage(ctx.sockets.find((s) => s.id === seat.ownerSocketId), ctx.io, { message: '/lazy' });
            }
        }
        const stuckNames = stuck.seatList().map((s) => s.ownerUsername);
        const otherNames = other.seatList().map((s) => s.ownerUsername);
        await advanceUntil(() => ctx.t.phase !== 'round_active', 1000, 600000);

        expect(stuck.stage).toBe(Phase.ABORTED);
        expect(other.stage).toBe(Phase.ENDED);
        expect(events(ctx.log, 'abortGame').filter((e) => e.to === stuck.roomName).map((e) => e.data.reason)).toEqual(['Game stalled']);
        const results = events(ctx.log, 'tournamentGameComplete');
        expect(results.find((e) => e.data.gameId === stuck.gameId).data.aborted).toBe(true);
        expect(results.find((e) => e.data.gameId === other.gameId).data.aborted).toBeUndefined();
        expect(events(ctx.log, 'tournamentRoundComplete')).toHaveLength(1);
        // Aborted: nothing recorded for its players (the abort rule); the
        // finished table's players have their round
        for (const name of stuckNames) expect(ctx.t.scoreboard[name]?.roundDetails ?? []).toEqual([]);
        for (const name of otherNames) expect(ctx.t.scoreboard[name].roundDetails.map((d) => d.gameId)).toEqual([other.gameId]);
    });
});
