/**
 * Test kit for the restored-table tests (deploy survival PR 5:
 * server/game/persist/__tests__/gate, restoreAbandon, suspend, adoptGame):
 *
 *   playUntil({seed, humans, until, nth, prefix})
 *       A casual table (GameManager.createGame, as the fork test builds
 *       it: `humans` humans, bots in the other seats) played with fixed
 *       bot delays and silent bot chat, the humans by a fixed rule
 *       (driveHumans), until the nth safe point where until(game) holds.
 *       Returns the codec doc taken there (JSON round-tripped), the users,
 *       each bot's card memory at that point (a bot that watched the hand
 *       live) and the RNG state. The caller's freshProcess() then resets
 *       the singletons, as a new process would start.
 *
 *   freshProcess(mockDb, users, {gameId})
 *       GameManager / BotController reset, timers cleared, a new memoryDb
 *       with `users` (each with activeGameId = gameId when given).
 *
 *   startTable({mockDb, seed, humans, prefix})
 *       The table playUntil plays, for a test that drives it itself.
 *
 *   driveHumans(io, game, sockets, {skipBid})
 *       Every human seat on turn whose owner socket is in `sockets` acts:
 *       smallest legal numeric bid by deal (unless skipBid(game, pos): the
 *       bid clock bids for it), first legal card. Nothing while the game is
 *       suspended. Returns the handler promise (or null).
 *
 * The calling test mocks ../database over mockDb.current, uses Jest's fake
 * timers and installs its own logger spies. Server modules are required
 * lazily.
 */

'use strict';

const { createMemoryDb } = require('./memoryDb');
const { makeIo, makeSocket, legalCards, legalBids } = require('./gameDriver');
const { makeRng, fixedBotDelays, silenceBotChat } = require('./persistHarness');

const STEP_MS = 500;
const json = (v) => JSON.parse(JSON.stringify(v));
const PERSONALITIES = ['zach', 'mary', 'danny', 'sharon', 'mike'];

function driveHumans(io, game, sockets, { skipBid = null } = {}) {
    const gameHandlers = require('../socket/gameHandlers');
    const { Phase } = require('../game/GamePhase');
    for (const socket of sockets) {
        const pos = game.seatByOwnerSocket(socket.id);
        if (!pos || game.currentTurn !== pos || game.seat(pos).controller !== 'human') continue;
        if (game.isSuspended) return null;
        if (game.stage === Phase.BIDDING && game.playerBids[pos - 1] == null && !game.resume) {
            if (skipBid && skipBid(game, pos)) continue;
            const numeric = legalBids(game).filter((b) => /^\d+$/.test(b)).map(Number).sort((a, b) => a - b);
            const bid = String(numeric[(game.dealSeq || 0) % Math.min(3, numeric.length)] ?? 0);
            return gameHandlers.playerBid(socket, io, { bid });
        }
        if (game.stage === Phase.PLAYING) {
            const cards = legalCards(game, socket.id);
            if (cards.length) return gameHandlers.playCard(socket, io, { card: cards[0] });
        }
    }
    return null;
}

function freshProcess(mockDb, users, { gameId = null } = {}) {
    const gameManager = require('../game/GameManager');
    const { botController } = require('../game/bot');
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const u of users) mockDb.current.users._insert({ ...u, ...(gameId && { activeGameId: gameId }) });
}

/**
 * A casual table being played (the first half of playUntil): fixed bot
 * delays, silent bot chat, a seeded Math.random (installed until done()).
 * @returns {{io, log, socks, users, game, pending: Promise[], rng, done: Function}}
 */
function startTable({ mockDb, seed = 1, humans = 1, prefix = 'rt' }) {
    const gameManager = require('../game/GameManager');
    const { botController } = require('../game/bot');
    const gameHandlers = require('../socket/gameHandlers');
    const gameLifecycle = require('../socket/gameLifecycle');

    const users = Array.from({ length: humans }, (_, i) => ({ username: `${prefix}${seed}_${'abcd'[i]}`, profilePic: 5 + i }));
    freshProcess(mockDb, users);
    const delays = fixedBotDelays(1000);
    const chat = silenceBotChat();
    const rng = makeRng(seed * 7919);
    const uninstall = rng.install();
    const log = [];
    const io = makeIo(log);
    const socks = users.map((u, i) => {
        const s = makeSocket(`${prefix}${seed}-h${i}`, log, io);
        gameManager.registerUser(s.id, u.username);
        return s;
    });
    const bots = Array.from({ length: 4 - humans }, (_, i) => {
        const p = PERSONALITIES[(seed + i) % PERSONALITIES.length];
        return botController.createBot(`🤖 ${p[0].toUpperCase()}${p.slice(1)}`, p);
    });
    const game = gameManager.createGame([...socks.map((s) => s.id), ...bots.map((b) => b.socketId)]);
    bots.forEach((b) => botController.registerBot(game.gameId, b));
    for (const s of socks) s.join(game.roomName);
    const pending = [];
    gameLifecycle.beginDraw(io, game);
    socks.forEach((s, i) => pending.push(gameHandlers.draw(s, io, { num: i })));
    const done = () => {
        uninstall();
        delays.mockRestore();
        chat.mockRestore();
        for (const p of pending) p?.catch?.(() => {});
    };
    return { io, log, socks, users, game, pending, rng, done };
}

/**
 * @param {Object} opts
 * @param {Object} opts.mockDb - the test's database mock holder
 * @param {number} [opts.seed=1]
 * @param {number} [opts.humans=1]
 * @param {Function} opts.until - (game) => boolean, at a safe point
 * @param {number} [opts.nth=1]
 * @param {string} [opts.prefix='rt']
 * @param {number} [opts.maxSteps=6000]
 */
async function playUntil({ mockDb, seed = 1, humans = 1, until, nth = 1, prefix = 'rt', maxSteps = 6000 }) {
    const gameManager = require('../game/GameManager');
    const { botController } = require('../game/bot');
    const codec = require('../game/persist/gameCodec');
    const { watchSafePoints } = require('./restoreKit');
    const t = startTable({ mockDb, seed, humans, prefix });
    const { io, socks, users, game, pending, rng } = t;

    let count = 0;
    let found = null;
    const watch = watchSafePoints((g) => {
        if (found || g !== game || gameManager.getGameById(g.gameId) !== g || !until(g)) return;
        if (++count < nth) return;
        const doc = codec.serialize(g);
        if (!doc) return;
        const memory = {};
        for (const b of botController.getGameBots(g.gameId)) memory[b.position] = json(b.cardMemory);
        found = { doc: json(doc), memory, rng: rng.getState(), eventSeq: g.eventSeq };
    });
    try {
        for (let i = 0; i < maxSteps && !found; i++) {
            await jest.advanceTimersByTimeAsync(STEP_MS);
            if (found || game.isTerminal()) break;
            const p = driveHumans(io, game, socks);
            if (p) pending.push(p);
        }
    } finally {
        watch.stop();
        t.done();
    }
    if (!found) throw new Error(`playUntil: never reached (seed ${seed}, stage ${game.stage})`);
    return { ...found, users, gameId: game.gameId };
}

module.exports = { STEP_MS, startTable, playUntil, freshProcess, driveHumans };
