/**
 * The deploy-survival test harness (server/testUtils/persistHarness.js):
 * each piece does what the persist tests will rely on, over real bot games.
 */

const mockDb = { current: null };
jest.mock('../../database', () => require('../persistHarness').databaseMock(mockDb));

const h = require('../persistHarness');
const { mulberry32, makeIo } = require('../gameDriver');
const gameManager = require('../../game/GameManager');
const { botController } = require('../../game/bot');
const BotPlayer = require('../../game/bot/BotPlayer');
const gameLifecycle = require('../../socket/gameLifecycle');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

let realRandom;

beforeEach(() => {
    realRandom = Math.random;
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    botController.clearAll();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

/** A 4-bot table on `mods`, drawn through the real lifecycle. */
function startBotGame(mods, io) {
    const bots = [0, 1, 2, 3].map((i) => mods.botController.createBot(`🤖 P${i}`, ['mary', 'sharon', 'mike', 'danny'][i]));
    const game = mods.gameManager.createGame(bots.map((b) => b.socketId));
    bots.forEach((b) => mods.botController.registerBot(game.gameId, b));
    mods.gameLifecycle.beginDraw(io, game);
    return game;
}

const ownMods = () => ({ gameManager, botController, gameLifecycle });

describe('makeRng', () => {
    test("is gameDriver's mulberry32 stream, and a saved state resumes it exactly", () => {
        const a = h.makeRng(42);
        const b = mulberry32(42);
        for (let i = 0; i < 50; i++) expect(a.next()).toBe(b());
        const state = a.getState();
        const ahead = [a.next(), a.next(), a.next()];
        const fork = h.makeRng(0);
        fork.setState(state);
        expect([fork.next(), fork.next(), fork.next()]).toEqual(ahead);
    });

    test('install() replaces Math.random and gives back a restore', () => {
        const before = Math.random;
        const rng = h.makeRng(7);
        const restore = rng.install();
        const expected = mulberry32(7);
        expect(Math.random()).toBe(expected());
        restore();
        expect(Math.random).toBe(before);
    });
});

describe('bot determinism helpers', () => {
    test('fixedBotDelays: fixed values per action and no Math.random drawn', () => {
        h.fixedBotDelays({ bid: 300, play: 200 });
        const random = jest.spyOn(Math, 'random');
        const bot = new BotPlayer('🤖 T', 'mary');
        expect(bot.getActionDelay('bid', {})).toBe(300);
        expect(bot.getActionDelay('play', {})).toBe(200);
        expect(bot.getActionDelay('draw', {})).toBe(1000);
        expect(random).not.toHaveBeenCalled();
    });

    test('silenceBotChat: a quip sets no timer and draws no Math.random', () => {
        h.silenceBotChat();
        const random = jest.spyOn(Math, 'random');
        const before = botController.pendingActions.size;
        botController.sendBotChat(makeIo([]), { gameId: 'g', epoch: 0 }, { socketId: 'bot:x:1' }, 'hi');
        expect(botController.pendingActions.size).toBe(before);
        expect(random).not.toHaveBeenCalled();
    });

    test('decisionLog + fixed delays + silent chat + a seeded RNG: the same seed makes the same decisions', async () => {
        const run = async () => {
            h.makeRng(1234).install();
            const spies = [h.fixedBotDelays(500), h.silenceBotChat()];
            const decisions = h.decisionLog();
            const game = startBotGame(ownMods(), makeIo([]));
            await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
            decisions.stop();
            spies.forEach((s) => s.mockRestore());
            gameManager.abortGame(game.gameId);
            return decisions.entries.map(({ gameId, ...rest }) => {
                expect(gameId).toBe(game.gameId);
                return rest;
            });
        };
        const first = await run();
        const second = await run();
        expect(first.filter((d) => d.kind === 'bid').length).toBeGreaterThan(4);
        expect(first.filter((d) => d.kind === 'play').length).toBeGreaterThan(8);
        expect(second).toEqual(first);
        // stop() put the real methods back
        expect(Object.prototype.hasOwnProperty.call(BotPlayer.prototype, 'decideBid')).toBe(true);
        expect(BotPlayer.prototype.decideBid.toString()).not.toMatch(/entries\.push/);
    }, 60000);
});

describe('liveDb and databaseMock', () => {
    test('the server collections plus liveGames, liveTournaments, serverInstances, behind the database getters', async () => {
        const database = require('../../database');
        expect(h.LIVE_COLLECTIONS).toEqual(['liveGames', 'liveTournaments', 'serverInstances']);
        await database.getLiveGamesCollection().insertOne({ _id: 'g1', rev: 1 });
        expect(mockDb.current.liveGames.all()).toEqual([{ _id: 'g1', rev: 1 }]);
        expect(database.getUsersCollection()).toBe(mockDb.current.users);
        expect(database.getServerInstancesCollection()).toBe(mockDb.current.serverInstances);
        expect(database.getLiveTournamentsCollection()).toBe(mockDb.current.liveTournaments);
        await expect(database.getLiveGamesCollection().insertOne({ _id: 'g1' })).rejects.toMatchObject({ code: 11000 });
    });

    test('seeded from the argument', async () => {
        const db = h.liveDb({ liveGames: [{ _id: 'a' }], users: [{ username: 'u' }] });
        expect(await db.liveGames.findOne({ _id: 'a' })).toEqual({ _id: 'a' });
        expect(await db.users.countDocuments({})).toBe(1);
    });

    test('stall: ops wait until release, then apply late and in order', async () => {
        const db = mockDb.current;
        db.faults.stall({ collections: 'liveGames' });
        let settled = false;
        const write = db.liveGames.insertOne({ _id: 'x' }).then(() => { settled = true; });
        const other = await db.users.findOne({});
        expect(other).toBeNull(); // other collections unaffected
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(db.faults.stalledCount()).toBe(1);
        expect(db.liveGames.all()).toEqual([]);
        db.faults.release();
        await write;
        expect(db.liveGames.all()).toEqual([{ _id: 'x' }]);
        expect(db.faults.stalledCount()).toBe(0);
    });

    test('fail and lostReply: rejects with a MongoNetworkError, lostReply after applying; times counts calls', async () => {
        const db = mockDb.current;
        db.faults.fail({ collections: ['liveGames'], ops: ['updateOne'], times: 1 });
        await db.liveGames.insertOne({ _id: 'g', rev: 1 });
        await expect(db.liveGames.updateOne({ _id: 'g' }, { $set: { rev: 2 } })).rejects.toMatchObject({ name: 'MongoNetworkError' });
        expect(db.liveGames.all()[0].rev).toBe(1);
        await db.liveGames.updateOne({ _id: 'g' }, { $set: { rev: 3 } });
        expect(db.liveGames.all()[0].rev).toBe(3);

        db.faults.fail({ ops: 'updateOne', lostReply: true, times: 1 });
        await expect(db.liveGames.updateOne({ _id: 'g' }, { $set: { rev: 4 } })).rejects.toMatchObject({ name: 'MongoNetworkError' });
        expect(db.liveGames.all()[0].rev).toBe(4);

        db.faults.fail({ ops: 'find' });
        await expect(db.liveGames.find({}).toArray()).rejects.toMatchObject({ name: 'MongoNetworkError' });
        db.faults.clear();
        expect(await db.liveGames.find({}).toArray()).toHaveLength(1);
        expect(db.faults.calls.map((c) => c.outcome)).toEqual(['ok', 'failed', 'ok', 'lostReply', 'failed', 'ok']);
    });
});

describe('flushStore', () => {
    test('pumps until the store reports nothing pending twice in a row', async () => {
        let pending = 0;
        const store = {
            pending: () => pending,
            markDirty() { pending++; setImmediate(() => { pending--; }); },
        };
        store.markDirty();
        store.markDirty();
        const turns = await h.flushStore(store);
        expect(pending).toBe(0);
        expect(turns).toBeGreaterThanOrEqual(2);
    });

    test('throws when the store never settles', async () => {
        await expect(h.flushStore({ pending: () => 1 }, { rounds: 5 })).rejects.toThrow(/still 1 pending/);
    });

    test('works on real timers too, and without a store', async () => {
        jest.useRealTimers();
        expect(h.fakeTimersOn()).toBe(false);
        expect(await h.flushStore(null)).toBe(3);
        jest.useFakeTimers();
        expect(h.fakeTimersOn()).toBe(true);
    });
});

describe('createMonoClock', () => {
    test('counts from its own start, jumps forward only, and freezes', () => {
        jest.advanceTimersByTime(5000);
        const a = h.createMonoClock();
        jest.advanceTimersByTime(1000);
        const b = h.createMonoClock({ offset: 50 });
        expect(a.now()).toBe(1000);
        expect(b.now()).toBe(50);
        a.jump(500);
        expect(a.now()).toBe(1500);
        expect(() => a.jump(-1)).toThrow(/never goes back/);
        a.freeze();
        jest.advanceTimersByTime(3000);
        expect(a.now()).toBe(1500);
        expect(a.frozen).toBe(true);
        a.thaw();
        jest.advanceTimersByTime(200);
        expect(a.now()).toBe(1700);
        expect(b.now()).toBe(50 + 3200);
    });
});

describe('authoritative', () => {
    test('keyed by position, no socket ids; equal for the same state, different once play moves on', async () => {
        h.makeRng(99).install();
        h.fixedBotDelays(500);
        h.silenceBotChat();
        const game = startBotGame(ownMods(), makeIo([]));
        await jest.advanceTimersByTimeAsync(60000);
        const a = h.authoritative(game);
        expect(a).toEqual(h.authoritative(game));
        expect(JSON.stringify(a)).not.toMatch(/bot:/);
        expect(Object.keys(a.hands)).toEqual(['1', '2', '3', '4']);
        expect(a.seats[1]).toMatchObject({ controller: 'bot', ownerUsername: null, gone: false });
        expect(a.seats[1]).not.toHaveProperty('presence');
        expect(h.authoritative(game, { presence: true }).seats[1].presence).toBe('none');
        expect(h.authoritative(game, { gameManager }).tournamentId).toBeNull();
        expect(Array.isArray(h.authoritative(game, { log: true }).log)).toBe(true);
        await jest.advanceTimersByTimeAsync(30000);
        expect(h.authoritative(game)).not.toEqual(a);
    }, 60000);
});

describe('createPersistHarness: restarts', () => {
    test('a kill resets the singletons; nothing of the old process runs or emits later', async () => {
        const harness = h.createPersistHarness({ db: mockDb.current });
        const first = await harness.boot();
        const game = startBotGame(first.mods, first.io);
        await jest.advanceTimersByTimeAsync(20000);
        expect(first.log.length).toBeGreaterThan(0);
        const logged = first.log.length;

        const second = await harness.restart({ kind: 'kill' });
        expect(second).toBe(harness.current);
        expect(second.bootId).not.toBe(first.bootId);
        expect(second.deploymentId).not.toBe(first.deploymentId);
        expect(first.dead).toBe(true);
        expect(gameManager.games.size).toBe(0);
        expect(gameManager.playerGames.size).toBe(0);
        expect(botController.gamesBots.size).toBe(0);
        expect(botController.pendingActions.size).toBe(0);
        expect(game.pendingTimerCount).toBe(0);

        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(first.log.length).toBe(logged);
        expect(harness.deadEmits()).toEqual([]);
        // A new game runs on the reset singletons and logs to the new io
        startBotGame(second.mods, second.io);
        await jest.advanceTimersByTimeAsync(20000);
        expect(second.log.length).toBeGreaterThan(0);
    }, 60000);

    test('the singleton resets refuse to run outside Jest', () => {
        const saved = process.env.JEST_WORKER_ID;
        delete process.env.JEST_WORKER_ID;
        try {
            expect(() => gameManager._resetForTests()).toThrow(/Jest only/);
            expect(() => botController._resetForTests()).toThrow(/Jest only/);
        } finally {
            process.env.JEST_WORKER_ID = saved;
        }
    });

    test('an emit from a dead instance is caught in afterDeath, not its log', async () => {
        const harness = h.createPersistHarness({ db: mockDb.current });
        const first = await harness.boot();
        await harness.restart({ kind: 'kill', sameDeployment: true });
        expect(harness.current.deploymentId).toBe(first.deploymentId);
        first.io.to('game:x').emit('gameLogEntry', { message: 'late', type: 'system' });
        first.socket('s1').emit('serverShutdown', { message: 'late' });
        expect(first.log).toEqual([]);
        expect(harness.deadEmits().map((e) => [e.instance, e.event])).toEqual([['i1', 'gameLogEntry'], ['i1', 'serverShutdown']]);
    });

    test('each kind runs its hooks in order; mongo-stall holds the db for stallMs during the handoff', async () => {
        const calls = [];
        const db = mockDb.current;
        const hooks = {
            start: async (inst) => { calls.push(`start ${inst.name}`); },
            handoff: async (inst) => {
                calls.push(`handoff ${inst.name}`);
                const t0 = Date.now();
                await db.liveGames.insertOne({ _id: inst.bootId });
                calls.push(`flushed after ${Date.now() - t0}`);
            },
            crash: async (inst) => { calls.push(`crash ${inst.name}`); },
            stop: async (inst, kind) => { calls.push(`stop ${inst.name} ${kind}`); },
        };
        const harness = h.createPersistHarness({ db, hooks });
        await harness.boot();
        await harness.restart({ kind: 'handoff' });
        await harness.restart({ kind: 'throw' });
        await harness.restart({ kind: 'kill' });
        await harness.restart({ kind: 'mongo-stall', stallMs: 13000 });
        expect(calls).toEqual([
            'start i1',
            'handoff i1', 'flushed after 0', 'stop i1 handoff', 'start i2',
            'crash i2', 'stop i2 throw', 'start i3',
            'stop i3 kill', 'start i4',
            'handoff i4', 'flushed after 13000', 'stop i4 mongo-stall', 'start i5',
        ]);
        expect(db.faults.stalledCount()).toBe(0);
        await expect(harness.restart({ kind: 'reboot' })).rejects.toThrow(/restart kind/);
    });
});

describe('twoInstances', () => {
    test('two processes at once: separate singletons, one db', async () => {
        const { A, B, kill } = h.twoInstances({ gapMs: 2000 });
        expect(A.mods.gameManager).toBe(gameManager);
        expect(B.mods.gameManager).not.toBe(A.mods.gameManager);
        expect(B.mods.botController).not.toBe(A.mods.botController);
        expect(B.startedAt - A.startedAt).toBe(2000);
        expect(B.bootId).not.toBe(A.bootId);
        expect(B.deploymentId).not.toBe(A.deploymentId);

        expect(B.clock).not.toBe(A.clock);
        expect(h.twoInstances({ sameDeployment: true }).B.deploymentId).not.toBe(A.deploymentId);
        const same = h.twoInstances({ sameDeployment: true });
        expect(same.B.deploymentId).toBe(same.A.deploymentId);

        const ga = startBotGame(A.mods, A.io);
        expect(B.mods.gameManager.games.has(ga.gameId)).toBe(false);

        // Both reach the same db through the mocked database module
        await require('../../database').getLiveGamesCollection().insertOne({ _id: 'from-A' });
        let bDatabase;
        jest.isolateModules(() => { bDatabase = require('../../database'); });
        expect(await bDatabase.getLiveGamesCollection().findOne({ _id: 'from-A' })).toEqual({ _id: 'from-A' });

        await jest.advanceTimersByTimeAsync(20000);
        kill(A);
        expect(A.dead).toBe(true);
        expect(A.mods.gameManager.games.size).toBe(0);
        await jest.advanceTimersByTimeAsync(20000);
        expect(A.afterDeath).toEqual([]);
    }, 60000);

    test("LIMIT (Jest): B's lazy requires resolve to A's modules, so a table cannot be played on B.mods", async () => {
        // If this starts failing, Jest or the server changed: update the
        // twoInstances doc in persistHarness.js before relying on B tables
        const { B } = h.twoInstances();
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(B.mods.logger.gameLogger, m).mockImplementation(() => {});
        const gb = startBotGame(B.mods, B.io);
        await jest.advanceTimersByTimeAsync(40000);
        // The draw's continuation (BotController.processBotDraw's lazy
        // require of gameHandlers) runs A's handlers, which ask A's
        // BotController for B's bots: the dealt table stalls on its first bot turn
        expect(gb.stage).toBe('BIDDING');
        expect(gameLogger.warn.mock.calls.map((c) => c[0])).toContain('Bot not found for scheduled action');
        B.mods.gameManager.abortGame(gb.gameId);
        B.mods.botController.clearAll();
    }, 60000);
});
