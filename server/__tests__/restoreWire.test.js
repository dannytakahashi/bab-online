/**
 * The wire across restarts (deploy survival PR 5, LIVE_PERSIST=on; the
 * plan's PR 5 "restoreWire.test.js"): one table restarted by every kind
 * (handoff, throw, mongo-stall, kill; deployKit: the real store, handoff,
 * crash release and adoption), with a seated owner, a lazy owner watching
 * its bot and a spectator coming back each time, and an owner who never
 * does (rejoinGame,
 * joinAsSpectator, requestSnapshot), played on to gameEnd. Every s2c
 * payload any instance sent:
 *   - is an event of the contract (no new event) and validates against it
 *   - validates against contract/v1-baseline.schema.json and every
 *     contract/baselines/ios-*.schema.json that knows the event (their
 *     enums pin snapshot resume.kind and seat presence: no new resume kind
 *     or presence; also checked against the oldest frozen build's enums
 *     directly)
 * and the restart's own lines are exactly the owner's texts.
 */

// Integration test (real Socket.IO / two instances / chaos): CI's slower runners take
// 3-5 s on cases that run in about 2 s on a laptop, so the 5 s default is too tight.
jest.setTimeout(30000);
const fs = require('fs');
const path = require('path');

const mockDb = { current: null };
jest.mock('../database', () => require('../testUtils/persistHarness').databaseMock(mockDb));

const h = require('../testUtils/persistHarness');
const kit = require('../testUtils/liveStoreKit');
const { createDeploy } = require('../testUtils/deployKit');
const { makeSocket, mulberry32 } = require('../testUtils/gameDriver');
const contract = require('../../contract');
const { compile } = require('../../contract/lib/validate');
const contractCheck = require('../testUtils/contractCheck');
const gameManager = require('../game/GameManager');
const { botController } = require('../game/bot');
const { Phase } = require('../game/GamePhase');
const liveStore = require('../game/persist/liveStore');
const { RESUMED_LINE } = require('../game/persist/restoreGame');
const shutdown = require('../utils/shutdown');
const profileHandlers = require('../socket/profileHandlers');
const chatHandlers = require('../socket/chatHandlers');
const mainRoomHandlers = require('../socket/mainRoomHandlers');
const reconnectHandlers = require('../socket/reconnectHandlers');
const snapshotHandlers = require('../socket/snapshotHandlers');
const { gameLogger, socketLogger, authLogger, logger, dbLogger } = require('../utils/logger');

const SIGNALS = ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection'];
const BASELINE_DIR = path.join(__dirname, '../../contract/baselines');
const BASELINES = [
    ['v1-baseline', require('../../contract/v1-baseline.schema.json')],
    ...fs.readdirSync(BASELINE_DIR).filter((f) => /^ios-.*\.schema\.json$/.test(f)).sort()
        .map((f) => [f.replace(/\.schema\.json$/, ''), JSON.parse(fs.readFileSync(path.join(BASELINE_DIR, f), 'utf8'))])
].map(([n, schema]) => [n, asReader(schema)]);

let realRandom;
let listenersBefore;

beforeEach(() => {
    realRandom = Math.random;
    Math.random = mulberry32(73);
    listenersBefore = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
    jest.useFakeTimers();
    mockDb.current = h.liveDb();
    for (const l of [gameLogger, socketLogger, authLogger, logger, dbLogger]) {
        for (const m of ['error', 'info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    for (const s of SIGNALS) {
        for (const fn of process.listeners(s)) if (!listenersBefore[s].includes(fn)) process.removeListener(s, fn);
    }
    mockDb.current.faults.clear();
    liveStore._resetForTests();
    profileHandlers._resetStatsWritesForTests();
    shutdown._resetShutdownStateForTests({ abandonRetries: true });
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

/**
 * A shipped schema as its clients read it: a key the server added since is
 * ignored (Codable / the web reader), so `additionalProperties: false`
 * goes; required keys, types and enums stay.
 */
function asReader(schema) {
    const visit = (v) => {
        if (Array.isArray(v)) return v.map(visit);
        if (!v || typeof v !== 'object') return v;
        const out = {};
        for (const [k, x] of Object.entries(v)) {
            if (k === 'additionalProperties' && x === false) continue;
            out[k] = visit(x);
        }
        return out;
    };
    return visit(schema);
}

/** A baseline's validator for s2c `event` (null when the build does not know it). */
function validatorOf(schema, event, cache) {
    if (cache.has(event)) return cache.get(event);
    const entry = Object.prototype.hasOwnProperty.call(schema.s2c, event) ? schema.s2c[event] : null;
    let fn = null;
    if (entry) {
        if (entry.payload === null) fn = (d) => (d === undefined ? [] : [{ path: '$', message: 'expected no payload' }]);
        else {
            const inner = compile(entry.payload, schema.$defs);
            fn = entry.optionalPayload ? (d) => (d === undefined ? [] : inner(d)) : inner;
        }
    }
    cache.set(event, fn);
    return fn;
}

/** The snapshot resume kinds and seat presences in a wire payload (anywhere in it). */
function enumsIn(wire, out) {
    const visit = (v) => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v)) { v.forEach(visit); return; }
        if (v.resume && typeof v.resume === 'object' && typeof v.resume.kind === 'string') out.resume.add(v.resume.kind);
        if (typeof v.presence === 'string' && Object.prototype.hasOwnProperty.call(v, 'position')) out.presence.add(v.presence);
        for (const x of Object.values(v)) visit(x);
    };
    visit(wire);
}

describe('restoreWire', () => {
    test('every s2c payload of a table restarted by every kind validates against the contract, v1-baseline and every iOS baseline', async () => {
        const wire = [];
        const off = contractCheck.onEmit((entry, w) => { wire.push({ event: entry.event, to: entry.to, data: w }); });
        try {
            const db = mockDb.current;
            const deploy = createDeploy({ holder: mockDb, db });
            const A = await deploy.boot();
            // Joe never comes back after the first restart: his seat shows grace, then resignable
            const { game, sockets } = await kit.startGame(A.io, A.log, { humans: ['Hal', 'Ivy', 'Joe'] });
            const id = game.gameId;
            for (const u of ['Hal', 'Ivy', 'Joe']) await db.users.updateOne({ username: u }, { $set: { activeGameId: id } });
            db.users._insert({ username: 'Fan', profilePic: 7 });
            const fan = makeSocket('fan-0', A.log, A.io);
            gameManager.registerUser(fan.id, 'Fan');
            mainRoomHandlers.joinAsSpectator(fan, A.io, { gameId: id });
            await chatHandlers.chatMessage(sockets[0], A.io, { message: 'before the deploy' });
            await chatHandlers.chatMessage(fan, A.io, { message: 'watching' });
            await chatHandlers.chatMessage(sockets[1], A.io, { message: '/lazy' });
            await h.flushStore(A.store);
            let n = 0;
            const comeBack = async (inst) => {
                n++;
                const hal = makeSocket(`hal-${n}`, inst.log, inst.io);
                gameManager.registerUser(hal.id, 'Hal');
                await reconnectHandlers.rejoinGame(hal, inst.io, { gameId: id, username: 'Hal' });
                const ivy = makeSocket(`ivy-${n}`, inst.log, inst.io);
                gameManager.registerUser(ivy.id, 'Ivy');
                await reconnectHandlers.rejoinGame(ivy, inst.io, { gameId: id, username: 'Ivy' });
                const f = makeSocket(`fan-${n}`, inst.log, inst.io);
                gameManager.registerUser(f.id, 'Fan');
                mainRoomHandlers.joinAsSpectator(f, inst.io, { gameId: id });
                snapshotHandlers.requestSnapshot(hal, inst.io, {});
                await jest.advanceTimersByTimeAsync(0);
                return { hal, ivy, f };
            };
            const kinds = ['handoff', 'throw', 'mongo-stall', 'kill'];
            let last = null;
            for (const kind of kinds) {
                const g = gameManager.games.get(id);
                expect(g && !g.isTerminal()).toBe(true);
                await deploy.restart({ kind, abandonStalled: kind === 'mongo-stall' });
                const restored = await deploy.waitAdopted(id, { cap: 30000 });
                if (!restored) {
                    const d = kit.savedGame(db, id);
                    throw new Error(`${kind}: not adopted; doc ${JSON.stringify(d && { owner: d.owner, released: d.released, kind: d.kind })}; outcomes ${JSON.stringify(deploy.outcomes.slice(-1))}; stage ${g.stage}`);
                }
                last = await comeBack(deploy.current());
                // Hal plays on through the restored table for a while (his bot not; he acts on his turns)
                await chatHandlers.chatMessage(last.hal, deploy.current().io, { message: `after the ${kind}` });
                // Past Joe's grace: the gate opens and the next write resets
                // adoptAttempts (back-to-back quick deaths are a crash loop, discarded)
                await jest.advanceTimersByTimeAsync(65000);
            }
            // Hal replaces Joe with a bot (the usual offer) and goes lazy too: the bots finish the game
            const restored = gameManager.games.get(id);
            const joe = restored.seatList().find((s) => s.ownerUsername === 'Joe');
            expect(joe.presence).toBe('resignable');
            await require('../socket/gameHandlers').forceResign(last.hal, deploy.current().io, { position: joe.position });
            await chatHandlers.chatMessage(last.hal, deploy.current().io, { message: '/lazy' });
            await kit.advanceUntil(() => restored.isTerminal(), { step: 1000, cap: 3 * 3600000 });
            await jest.advanceTimersByTimeAsync(30000);
            expect(restored.stage).toBe(Phase.ENDED);
            expect(deploy.exits).toEqual([0, 1, 0]);
            expect(deploy.harness.deadEmits()).toEqual([]);
            deploy.close();
        } finally {
            off();
        }

        // Every event is the contract's and validates against it
        const names = new Set(contract.s2cNames());
        const unknown = [...new Set(wire.map((e) => e.event).filter((e) => !names.has(e)))];
        expect(unknown).toEqual([]);
        const bad = [];
        for (const e of wire) {
            const r = contract.validateS2C(e.event, e.data);
            if (!r.ok) bad.push({ schema: 'contract', event: e.event, errors: r.errors.slice(0, 2) });
        }
        // ... and against every baseline that knows it
        const covered = {};
        for (const [name, schema] of BASELINES) {
            const cache = new Map();
            covered[name] = 0;
            for (const e of wire) {
                const fn = validatorOf(schema, e.event, cache);
                if (!fn) continue;
                covered[name]++;
                const errors = fn(e.data);
                if (errors.length && bad.length < 20) bad.push({ schema: name, event: e.event, to: e.to, errors: errors.slice(0, 2) });
            }
        }
        expect(bad).toEqual([]);
        for (const [name] of BASELINES) expect(covered[name]).toBeGreaterThan(100);
        // every frozen iOS build (contract/baselines: the builds MIN_IOS_BUILD
        // lets connect; additiveOnly.test.js requires the floor build's)
        expect(BASELINES[0][0]).toBe('v1-baseline');
        const ios = BASELINES.filter(([n]) => /^ios-/.test(n));

        // No new resume kind or presence (the oldest frozen build's enums)
        const seen = { resume: new Set(), presence: new Set() };
        for (const e of wire) enumsIn(e.data, seen);
        for (const p of ['connected', 'grace', 'away']) expect(seen.presence.has(p)).toBe(true);
        const build = ([n]) => Number(/-b(\d+)$/.exec(n)[1]);
        const oldest = ios.length ? ios.reduce((a, b) => (build(b) < build(a) ? b : a))[1] : null;
        if (oldest) {
            expect([...seen.resume].filter((k) => !oldest.$defs.snapshotV2.properties.resume.properties.kind.enum.includes(k))).toEqual([]);
            expect([...seen.presence].filter((p) => !oldest.$defs.seatV2.properties.presence.enum.includes(p))).toEqual([]);
        }

        // The restart's own lines, exactly the owner's texts
        const lines = new Set(wire.filter((e) => e.event === 'gameLogEntry').map((e) => e.data.message));
        expect(lines.has(shutdown.CONTINUE_NOTICE)).toBe(true);
        expect(lines.has(RESUMED_LINE)).toBe(true);
        expect(shutdown.CONTINUE_NOTICE).toBe('The server is updating. This game will continue in a few seconds.');
        expect(RESUMED_LINE).toBe('This game resumed after a server update.');
        const crashLine = 'The server hit an error and is restarting. This game should continue in a moment, possibly a move earlier.';
        const unknownLine = "This game was interrupted by a server update. If it isn't back in a few seconds, it won't count toward stats.";
        expect(lines.has(crashLine)).toBe(true);
        expect(lines.has(unknownLine)).toBe(true);
        expect(wire.filter((e) => e.event === 'rejoinFailed')).toEqual([]);
        expect(wire.filter((e) => e.event === 'stateSnapshot' && e.data?.snapshot === null)).toEqual([]);
    });
});
