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
function startBotGame(mods, io, personalities = ['mary', 'sharon', 'mike', 'danny']) {
    const bots = [0, 1, 2, 3].map((i) => mods.botController.createBot(`🤖 P${i}`, personalities[i]));
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

    test('an immediate made while the fake clock ticks (1 ms later) is reached through pendingImmediates', async () => {
        let immediate = null;
        let writes = 0;
        const store = {
            pending: () => (immediate ? 1 : 0),
            pendingImmediates: () => (immediate ? 1 : 0),
            markDirty() { immediate = setImmediate(() => { immediate = null; writes++; }); },
        };
        setTimeout(() => store.markDirty(), 10);
        await jest.advanceTimersByTimeAsync(10);
        await jest.advanceTimersByTimeAsync(0);
        expect(immediate).not.toBeNull();
        await h.flushStore(store);
        expect(writes).toBe(1);
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
        expect(Object.keys(a.hands)).toEqual(['1', '2', '3', '4']);
        expect(a.seats[1]).toMatchObject({
            controller: 'bot', ownerUsername: null, ownerPic: null, gone: false,
            lastPersonality: game.seats[1].bot.personality, resignedAt: null, leftAt: null,
        });
        expect(['mary', 'sharon', 'mike', 'danny']).toContain(a.seats[1].lastPersonality);
        // A bot's socket id is persisted and restored as is, so it is compared
        expect(a.seats[1].bot.socketId).toBe(game.seats[1].bot.socketId);
        expect(a.seats[1].bot.socketId).toMatch(/^bot:/);
        expect(a.seats[1].bot.partnerHistory).toEqual([]);
        expect(a.dealSeq).toBe(game.dealSeq);
        expect(a.dealSeq).toBeGreaterThanOrEqual(1);
        expect(a.seats[1]).not.toHaveProperty('presence');
        expect(h.authoritative(game, { presence: true }).seats[1].presence).toBe('none');
        expect(h.authoritative(game, { gameManager }).tournamentId).toBeNull();
        expect(Array.isArray(h.authoritative(game, { log: true }).log)).toBe(true);
        await jest.advanceTimersByTimeAsync(30000);
        expect(h.authoritative(game)).not.toEqual(a);
    }, 60000);

    test('a restore that drops dealSeq, a seat field or a bot\'s partnerHistory is not equal', async () => {
        h.makeRng(5).install();
        h.fixedBotDelays(300);
        h.silenceBotChat();
        // Zach is the personality that keeps a partnerHistory
        const game = startBotGame(ownMods(), makeIo([]), ['zach', 'zach', 'zach', 'zach']);
        // Past the first hand, so partnerHistory has entries
        for (let t = 0; t < 40 && game.handStats.totalHands < 1; t++) await jest.advanceTimersByTimeAsync(5000);
        const a = h.authoritative(game);
        expect(a.seats[1].bot.partnerHistory.length).toBeGreaterThan(0);

        const drop = (mutate) => {
            const saved = { dealSeq: game.dealSeq, lastPersonality: game.seats[2].lastPersonality };
            const bot = botController.getBot(game.gameId, game.seats[3].bot.socketId);
            const history = bot.partnerHistory;
            mutate(bot);
            const changed = h.authoritative(game);
            game.dealSeq = saved.dealSeq;
            game.seats[2].lastPersonality = saved.lastPersonality;
            bot.partnerHistory = history;
            return changed;
        };
        expect(drop(() => { game.dealSeq = null; })).not.toEqual(a);
        expect(drop(() => { game.seats[2].lastPersonality = null; })).not.toEqual(a);
        expect(drop((bot) => { bot.partnerHistory = []; })).not.toEqual(a);
        expect(h.authoritative(game)).toEqual(a);
        // Bots registered elsewhere (another instance): partnerHistory null
        expect(h.authoritative(game, { botController: { getBot: () => null } }).seats[1].bot.partnerHistory).toBeNull();
    }, 60000);
});

describe('createPersistHarness: restarts', () => {
    test('a kill resets the singletons; nothing of the old process runs or emits later', async () => {
        const harness = h.createPersistHarness({ db: mockDb.current, holder: mockDb });
        const first = await harness.boot();
        expect(mockDb.current).toBe(first.db);
        const game = startBotGame(first.mods, first.io);
        await jest.advanceTimersByTimeAsync(20000);
        expect(first.log.length).toBeGreaterThan(0);
        const logged = first.log.length;
        const alive = game.aliveCheck();

        const second = await harness.restart({ kind: 'kill' });
        expect(second).toBe(harness.current);
        expect(mockDb.current).toBe(second.db);
        expect(second.bootId).not.toBe(first.bootId);
        expect(second.deploymentId).not.toBe(first.deploymentId);
        expect(first.dead).toBe(true);
        expect(gameManager.games.size).toBe(0);
        expect(gameManager.playerGames.size).toBe(0);
        expect(botController.gamesBots.size).toBe(0);
        expect(botController.pendingActions.size).toBe(0);
        expect(game.pendingTimerCount).toBe(0);
        // An awaited continuation of the dead process sees its game gone
        expect(alive()).toBe(false);

        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(first.log.length).toBe(logged);
        expect(harness.deadEmits()).toEqual([]);
        // A new game runs on the reset singletons and logs to the new io
        startBotGame(second.mods, second.io);
        await jest.advanceTimersByTimeAsync(20000);
        expect(second.log.length).toBeGreaterThan(0);
    }, 60000);

    test('a kill ends play-again holds and reservations, bot quip cooldowns and voice counters', async () => {
        const { safeTimeout } = require('../../utils/safeTimer');
        const gameVoice = require('../../voice/gameVoice');
        const harness = h.createPersistHarness({ db: mockDb.current, holder: mockDb });
        await harness.boot();
        // A play-again lobby as playAgain.openLobby leaves it: a hold (a
        // lobbyGrace entry of kind afterGame) and a reservation (its timer
        // on the lobby, not in lobbyGrace)
        const holdExpired = jest.fn();
        const reservationExpired = jest.fn();
        gameManager.lobbies.set('L1', {
            id: 'L1', players: [], readyPlayers: new Set(), messages: [],
            afterGame: { fromGameId: 'g0', reserved: new Map([['bob', { timer: safeTimeout(reservationExpired, 120000, 'test') }]]), lingering: new Map(), unsettled: new Set(), io: null },
        });
        gameManager.lobbyGrace.set('away:x', { lobbyId: 'L1', username: 'amy', timer: safeTimeout(holdExpired, 120000, 'test'), kind: 'afterGame', offline: true });
        gameManager.startedLobbies.set('L0', { gameId: 'g0', extras: new Set(['cat']) });
        botController.sentABoyTricks.set('g0', 1);
        botController.chatRoll = () => 0;
        // One SDP gate drop: a voice spectator who may not talk offers to send
        const GameState = require('../../game/GameState');
        const casual = new GameState('gv');
        gameVoice.initCasualVoice(casual, { spectatorsCanTalk: false });
        casual.voiceSpectators.set('spec-sid', { username: 'cat', fromLobby: false, gateSince: null });
        gameManager.games.set('gv', casual);
        gameManager.spectatorGames.set('spec-sid', 'gv');
        const sendSdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=sendrecv', 'a=mid:0', ''].join('\r\n');
        expect(gameVoice.gateSignal(null, 'spec-sid', 'seat-sid', sendSdp)).toBe(false);
        expect(gameVoice._gateDrops()).toBeGreaterThan(0);
        const voiceReset = jest.spyOn(gameVoice, '_resetForTests');

        await harness.restart({ kind: 'kill' });
        expect(gameManager.lobbies.size).toBe(0);
        expect(gameManager.lobbyGrace.size).toBe(0);
        expect(gameManager.startedLobbies.size).toBe(0);
        expect(botController.sentABoyTricks.size).toBe(0);
        expect(botController.chatRoll(new (require('../../game/GameState'))('g1'), 'x')).toBeGreaterThan(0);
        expect(voiceReset).toHaveBeenCalledTimes(1);
        expect(gameVoice._gateDrops()).toBe(0);
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(holdExpired).not.toHaveBeenCalled();
        expect(reservationExpired).not.toHaveBeenCalled();
    });

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

    test('a Jest spy on gameManager survives a restart', async () => {
        const spy = jest.spyOn(gameManager, 'clearActiveGameForAll').mockResolvedValue();
        const harness = h.createPersistHarness({ db: mockDb.current, holder: mockDb });
        await harness.boot();
        await harness.restart({ kind: 'kill' });
        await gameManager.clearActiveGameForAll({ gameId: 'g' });
        expect(gameManager.clearActiveGameForAll).toBe(spy);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(gameManager.games).toBeInstanceOf(Map);
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

    test('each kind runs its hooks in order; a deploy announces the successor before the handoff', async () => {
        const calls = [];
        const db = mockDb.current;
        const beats = (inst) => db.serverInstances.all().find((d) => d._id === inst.bootId)?.beatSeq ?? null;
        const hooks = {
            announce: async (inst, ctx) => {
                calls.push(`announce ${inst.name} (${ctx.kind})`);
                await inst.db.serverInstances.insertOne({ _id: inst.bootId, startedAt: inst.startedAt, beatSeq: 0 });
                inst.beat = setInterval(() => { inst.db.serverInstances.updateOne({ _id: inst.bootId }, { $inc: { beatSeq: 1 } }); }, 3000);
            },
            handoff: async (inst, { successor }) => {
                const t0 = Date.now();
                const seen = await inst.db.serverInstances.findOne({ _id: successor.bootId });
                calls.push(`handoff ${inst.name} sees ${seen ? seen._id === successor.bootId && successor.name : 'nothing'} after ${Date.now() - t0}`);
                if (Date.now() > t0) calls.push(`successor beat ${beats(successor)} times meanwhile`);
            },
            crash: async (inst, ctx) => { calls.push(`crash ${inst.name} successor ${ctx.successor}`); },
            stop: async (inst, { kind }) => { calls.push(`stop ${inst.name} ${kind}`); },
            reap: async (inst, { kind }) => {
                clearInterval(inst.beat);
                calls.push(`reap ${inst.name} ${kind} dead ${inst.dead}`);
            },
            start: async (inst) => { calls.push(`start ${inst.name}`); },
        };
        const harness = h.createPersistHarness({ db, hooks });
        await harness.boot();
        await harness.restart({ kind: 'handoff' });
        await harness.restart({ kind: 'throw' });
        await harness.restart({ kind: 'kill' });
        await harness.restart({ kind: 'mongo-stall', stallMs: 13000 });
        expect(calls).toEqual([
            'announce i1 (boot)', 'start i1',
            'announce i2 (handoff)', 'handoff i1 sees i2 after 0', 'stop i1 handoff', 'reap i1 handoff dead true', 'start i2',
            'crash i2 successor null', 'stop i2 throw', 'reap i2 throw dead true', 'announce i3 (throw)', 'start i3',
            'reap i3 kill dead true', 'announce i4 (kill)', 'start i4',
            // Only the old process's Mongo stalls: the successor keeps beating
            'announce i5 (mongo-stall)', 'handoff i4 sees i5 after 13000', 'successor beat 4 times meanwhile',
            'stop i4 mongo-stall', 'reap i4 mongo-stall dead true', 'start i5',
        ]);
        expect(db.faults.stalledCount()).toBe(0);
        await expect(harness.restart({ kind: 'reboot' })).rejects.toThrow(/restart kind/);
    });

    test('a process-wide module starts fresh: shutdown state, connection stats, LIVE_PERSIST mode, cleanup timers', async () => {
        const shutdown = require('../../utils/shutdown');
        const connectionStats = require('../../utils/connectionStats');
        const livePersistSwitch = require('../../utils/livePersistSwitch');
        const tournamentHandlers = require('../../socket/tournamentHandlers');
        jest.spyOn(process, 'exit').mockImplementation(() => {});
        const listenersBefore = Object.fromEntries(['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'].map((s) => [s, process.listeners(s)]));
        const hooks = {
            // The real SIGTERM path (no io): shuttingDown is set in this module
            handoff: async () => {
                const { shutdown: run } = shutdown.setupGracefulShutdown({ close: (cb) => cb?.() }, null, { settleMs: 0, drainMs: 0 });
                const done = run('SIGTERM', 0);
                expect(shutdown.isShuttingDown()).toBe(true);
                await jest.advanceTimersByTimeAsync(0);
                await done;
            },
        };
        try {
            const harness = h.createPersistHarness({ db: mockDb.current, holder: mockDb, hooks, mode: 'write' });
            await harness.boot();
            expect(livePersistSwitch.bootLivePersistMode()).toBe('write');
            connectionStats.noteConnection();
            expect(connectionStats.connectionStats().connectionsTotal).toBe(1);
            const lookups = jest.spyOn(gameManager, 'getTournamentById');
            tournamentHandlers.scheduleTournamentCleanup(makeIo([]), 't-dead', 1000);

            await harness.restart({ kind: 'handoff', mode: 'on' });
            expect(shutdown.isShuttingDown()).toBe(false);
            expect(connectionStats.connectionStats().connectionsTotal).toBe(0);
            expect(livePersistSwitch.bootLivePersistMode()).toBe('on');
            await jest.advanceTimersByTimeAsync(5000);
            expect(lookups).not.toHaveBeenCalled();
        } finally {
            for (const [s, before] of Object.entries(listenersBefore)) {
                for (const fn of process.listeners(s)) if (!before.includes(fn)) process.removeListener(s, fn);
            }
        }
    });
});

describe('a dead process is cut off from the db', () => {
    const profile = require('../../socket/profileHandlers');
    const NAMES = ['Ann', 'Ben', 'Cat', 'Dan'];

    /** A finished 4-human game (the shape recordGameStats reads). */
    const finishedGame = (gameId = 'g-dead') => {
        const seats = [1, 2, 3, 4].map((position) => ({ position, controller: 'human', ownerUsername: NAMES[position - 1] }));
        return {
            gameId,
            score: { team1: 420, team2: 150 },
            seatList: () => seats,
            seat: (pos) => seats[pos - 1],
            getOriginalPlayer: (pos) => ({ username: NAMES[pos - 1] }),
            handStats: { totalHands: 13, team1Sets: 1, team2Sets: 3, team1SetPoints: 20, team2SetPoints: 90 },
            playerStats: Object.fromEntries([1, 2, 3, 4].map((p) => [p, { totalBids: 3, totalTricks: 3, setsCaused: 0, totalHSI: 100 }])),
        };
    };
    const gamesPlayed = () => mockDb.current.base.users.all().map((u) => u.stats?.gamesPlayed ?? 0);

    beforeEach(() => {
        mockDb.current = h.liveDb({ users: NAMES.map((username) => ({ username })) });
        for (const m of ['error', 'warn']) jest.spyOn(require('../../utils/logger').authLogger, m).mockImplementation(() => {});
    });

    afterEach(() => profile._setStatsRetryDelaysForTests());

    test.each([
        ['released (it was on the wire: applies late)', false, 1],
        ['abandoned (never sent)', true, 0],
    ])('a stalled end-of-game insert, then a kill: %s; the dead chain writes nothing more, the successor credits once', async (_, abandonStalled, lateRecords) => {
        const db = mockDb.current;
        const harness = h.createPersistHarness({ db, holder: mockDb });
        await harness.boot();
        db.faults.stall({ collections: 'gameRecords', ops: 'insertOne' });
        profile.recordGameStats(finishedGame());
        await jest.advanceTimersByTimeAsync(0);
        expect(db.faults.stalledCount()).toBe(1);

        await harness.restart({ kind: 'kill', abandonStalled });
        db.faults.release();
        await jest.advanceTimersByTimeAsync(60000);
        expect(db.gameRecords.all()).toHaveLength(lateRecords);
        expect(gamesPlayed()).toEqual([0, 0, 0, 0]);
        // A late insert's continuation reached for users through its dead connection
        expect(harness.deadDbOps().every((op) => op.instance === 'i1')).toBe(true);
        if (lateRecords) expect(harness.deadDbOps().map((op) => op.collection)).toContain('users');

        // The successor's own chain (not the dead one's): one record, +1 each
        await profile.recordGameStats(finishedGame());
        expect(db.gameRecords.all()).toHaveLength(1);
        expect(gamesPlayed()).toEqual([1, 1, 1, 1]);
    });

    test("a dead process's retry never runs", async () => {
        const db = mockDb.current;
        profile._setStatsRetryDelaysForTests([1000, 1000]);
        const harness = h.createPersistHarness({ db, holder: mockDb });
        await harness.boot();
        db.faults.fail({ collections: 'gameRecords', ops: 'insertOne', times: 1 });
        profile.recordGameStats(finishedGame());
        await jest.advanceTimersByTimeAsync(0);
        const inserts = () => db.faults.calls.filter((c) => c.collection === 'gameRecords' && c.op === 'insertOne');
        expect(inserts().map((c) => c.outcome)).toEqual(['failed']);

        await harness.restart({ kind: 'kill' });
        await jest.advanceTimersByTimeAsync(10000);
        expect(inserts().map((c) => c.outcome)).toEqual(['failed']);
        expect(harness.deadDbOps()).toEqual([]);
        expect(db.gameRecords.all()).toEqual([]);
    });

    test("the gameRecords.gameId unique index: a second record for one game is E11000", async () => {
        const db = mockDb.current;
        await db.gameRecords.insertOne({ gameId: 'g1' });
        await expect(db.gameRecords.insertOne({ gameId: 'g1' })).rejects.toMatchObject({
            code: 11000, keyPattern: { gameId: 1 }, keyValue: { gameId: 'g1' },
        });
        await db.gameRecords.insertOne({ note: 'no gameId' });
        await db.gameRecords.insertOne({ note: 'no gameId either' });
        expect(db.gameRecords.all()).toHaveLength(3);
    });

    test('faults per instance, and abandon', async () => {
        const db = mockDb.current;
        const a = { name: 'A', dead: false, deadDbOps: [] };
        const b = { name: 'B', dead: false, deadDbOps: [] };
        const ca = db.connect(a);
        const cb = db.connect(b);
        db.faults.stall({ instances: 'A' });
        let aDone = false;
        ca.liveGames.insertOne({ _id: 'from-A' }).then(() => { aDone = true; });
        await cb.liveGames.insertOne({ _id: 'from-B' });
        await db.liveGames.insertOne({ _id: 'shared' });
        expect(db.liveGames.all().map((d) => d._id)).toEqual(['from-B', 'shared']);
        expect(db.faults.stalledCount()).toBe(1);
        expect(db.faults.abandon({ instances: 'A' })).toBe(1);
        db.faults.release();
        await jest.advanceTimersByTimeAsync(0);
        expect(aDone).toBe(false);
        expect(db.liveGames.all().map((d) => d._id)).toEqual(['from-B', 'shared']);
        expect(db.faults.calls.map((c) => [c.instance ?? '-', c.outcome])).toEqual([
            ['A', 'stalled'], ['B', 'ok'], ['-', 'ok'], ['A', 'abandoned'],
        ]);
        // A dead owner's op is dropped and recorded; the connection reads the same docs
        a.dead = true;
        let settled = false;
        ca.liveGames.deleteOne({ _id: 'from-B' }).then(() => { settled = true; });
        await jest.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        expect(a.deadDbOps).toEqual([{ collection: 'liveGames', op: 'deleteOne' }]);
        expect(ca.liveGames.all()).toHaveLength(2);
        expect(ca.base).toBe(db);
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

describe('chaosEngine on harness instances', () => {
    const { runSeedInner } = require('../chaosEngine');
    let errorLogs;

    beforeEach(() => {
        errorLogs = [];
        for (const l of [gameLogger, socketLogger, authLogger, logger]) {
            jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        }
    });

    test("opts.instance runs the seed on that instance's io and log", async () => {
        const harness = h.createPersistHarness({ db: mockDb.current, holder: mockDb });
        const inst = await harness.boot();
        let seen = null;
        const result = await runSeedInner(3, (io) => { seen = io; }, { errorLogs, instance: inst });
        expect(result).toMatchObject({ ok: true });
        expect(seen).toBe(inst.io);
        expect(inst.log.length).toBeGreaterThan(0);
        // Room emits carry who was in the room (the engine's recorder on this io)
        expect(inst.log.some((e) => Array.isArray(e.members))).toBe(true);
    }, 60000);

    test('ctx.swapIo moves later actions to the new io; the old io keeps writing to its own log', async () => {
        const harness = h.createPersistHarness({ db: mockDb.current, holder: mockDb });
        const A = await harness.boot();
        const B = h.createInstance({ name: 'B', mods: A.mods });
        let swapAt = null;
        let ctxRef = null;
        await runSeedInner(4, () => {}, {
            errorLogs,
            instance: A,
            extraActions: (ctx) => {
                ctxRef = ctx;
                return [[5, function swap() {
                    if (swapAt !== null) return;
                    swapAt = Date.now();
                    ctx.swapIo(B);
                    ctx.newSocket('after-swap');
                }]];
            },
        });
        expect(swapAt).not.toBeNull();
        expect(ctxRef.io).toBe(B.io);
        expect(ctxRef.log).toBe(B.log);
        expect(B.io.sockets.sockets.has('after-swap')).toBe(true);
        expect(A.io.sockets.sockets.has('after-swap')).toBe(false);
        expect(B.log.length).toBeGreaterThan(0);
        expect(B.log.every((e) => e.at >= swapAt)).toBe(true);
        // The old io's room recorder is still bound to A's log: once A is
        // dead its emits land in A's afterDeath, never in B's log
        A.dead = true;
        A.io.to('game:x').emit('gameLogEntry', { message: 'old io', type: 'system' });
        expect(A.afterDeath).toEqual([expect.objectContaining({ to: 'game:x', members: [], event: 'gameLogEntry' })]);
        expect(B.log.some((e) => e.data?.message === 'old io')).toBe(false);
        expect(() => ctxRef.swapIo({})).toThrow(/swapIo/);
    }, 60000);
});
