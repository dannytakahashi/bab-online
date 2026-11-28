/**
 * The socket contract (contract/events.schema.json) against the real
 * handlers. Every emit of every scenario below is validated by the
 * always-on contract guard (server/testUtils/contractGuard.js); this file
 * adds what the guard cannot see on its own:
 *   (a) the c2s registrations equal the schema's c2s names, and every
 *       documented client payload passes the schema and its Joi schema
 *   (b) F1: a full human game through the lobby with every seat / presence
 *       path the clients know
 *   (c) F2: full ambient bot games
 *   (d) F3: a full tournament, spectating during the draw and mid-hand, a
 *       cancel
 *   (e) the non-game handlers (auth, profile, safety, main room, lobby,
 *       queue, voice, rate limit / validation errors)
 *   (g) nothing is emitted into a game after its terminal event
 * and a coverage assertion: every active / deprecated s2c event is observed
 * here or listed in NOT_EXERCISED with a reason.
 *
 * bot/sim/simulate.js never touches handlers or io, so the ambient games
 * (c) stand in for a bot-sim run.
 */

const fs = require('fs');
const path = require('path');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    getPasswordResetsCollection: () => mockDb.current.passwordResets,
    getAdminAuditCollection: () => mockDb.current.adminAudit,
}));

const contract = require('../../../contract');
const contractCheck = require('../../testUtils/contractCheck');
const validators = require('../validators');
const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const authHandlers = require('../authHandlers');
const profileHandlers = require('../profileHandlers');
const badgeAwards = require('../badgeAwards');
const safetyHandlers = require('../safetyHandlers');
const voiceHandlers = require('../voiceHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const adminHandlers = require('../adminHandlers');
const { watchSeq } = require('../../testUtils/seqCheck');
const { watchPacing } = require('../../testUtils/pacingInvariants');
const { asyncHandler, syncHandler, rateLimiter } = require('../errorHandler');
const ambient = require('../../demo/ambientBots');
const { Phase } = require('../../game/GamePhase');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { events, mulberry32 } = require('../../testUtils/gameDriver');
const {
    setupTournament, playTournament, liveTables, advanceUntil, newUser, newIo, creatorSocket,
} = require('../../testUtils/tournamentDriver');
const {
    world, selfEvents, expectSilentAfterTerminal, playF1, watchSnapshots,
} = require('../../testUtils/contractScenarios');

// Active / deprecated s2c events these scenarios do not reach, with why
const NOT_EXERCISED = {
    serverShutdown: 'utils/shutdown.js gracefulShutdown exits the process',
};

const realRandom = Math.random;
let errorLogs;

// Variants of anyOf payloads (event#variant) these scenarios do not reach, with why
const NOT_EXERCISED_VARIANTS = {
};

const observedVariants = new Map();
let stopVariants = null;
beforeAll(() => {
    contractCheck.resetObserved();
    stopVariants = contractCheck.onEmit((entry, wire) => {
        for (const v of contract.variantsOf(entry.event, wire)) {
            observedVariants.set(`${entry.event}#${v}`, (observedVariants.get(`${entry.event}#${v}`) || 0) + 1);
        }
    });
});
afterAll(() => stopVariants && stopVariants());
// The rate limiter's cleanup interval would keep a single-file run alive
afterAll(() => rateLimiter.shutdown());

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
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});


// ==================== (a) c2s registrations ====================

describe('(a) client -> server events', () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const voiceSrc = fs.readFileSync(path.join(__dirname, '..', 'voiceHandlers.js'), 'utf8');
    const clientErrorSrc = fs.readFileSync(path.join(__dirname, '..', 'clientErrorHandlers.js'), 'utf8');

    function registrations() {
        const names = [];
        const fakeSocket = { id: 'reg', on: (ev) => names.push(ev) };
        const { setupSocketHandlers } = require('../index');
        setupSocketHandlers({ on: (ev, cb) => cb(fakeSocket) });
        return names;
    }

    test('the registered handlers are exactly the schema c2s events plus disconnect', () => {
        const names = registrations();
        expect(new Set(names).size).toBe(names.length);
        const schemaNames = contract.c2sNames().filter((n) => contract.schema.c2s[n].status !== 'clientOnly');
        expect(names.sort()).toEqual([...schemaNames, ...contract.builtins.c2s].sort());
    });

    test('joi / rateLimit metadata matches the wrapper each handler is registered with', () => {
        for (const name of contract.c2sNames()) {
            const entry = contract.schema.c2s[name];
            const m = new RegExp(`socket\\.on\\('${name}',[^\\n]*\\n\\s*(asyncHandler|syncHandler|safeHandler)\\((?:'([a-zA-Z]+)')?([^\\n]*)`).exec(indexSrc);
            expect({ name, registered: !!m }).toEqual({ name, registered: true });
            const key = m[2] || null;
            // safeHandler(fn, { limit: 'key' }): a limit with no schema
            const limitKey = key || (/\{ limit: '([a-zA-Z]+)' \}/.exec(m[3]) || [])[1] || null;
            expect({ name, joi: entry.joi }).toEqual({ name, joi: key && validators.schemas[key] ? key : null });
            expect({ name, rateLimit: entry.rateLimit }).toEqual({ name, rateLimit: limitKey && rateLimiter.limits[limitKey] ? limitKey : null });
        }
    });

    test('every documented client payload passes the schema and, where wrapped, Joi', () => {
        for (const name of contract.c2sNames()) {
            const entry = contract.schema.c2s[name];
            expect(Array.isArray(entry.examples) && entry.examples.length > 0).toBe(true);
            const joi = entry.joi || entry.joiInHandler;
            for (const ex of entry.examples) {
                expect({ name, ex, ...contract.validateC2S(name, ex) }).toMatchObject({ name, ok: true });
                if (joi) expect(() => validators.validate(joi, ex)).not.toThrow();
            }
            if (entry.optionalPayload) expect(contract.validateC2S(name, undefined).ok).toBe(true);
        }
    });

    test('every documented rejected payload fails BOTH the schema and Joi (the schema never admits what Joi refuses)', () => {
        let n = 0;
        for (const name of contract.c2sNames()) {
            const entry = contract.schema.c2s[name];
            const joi = entry.joi || entry.joiInHandler;
            for (const bad of entry.invalid || []) {
                n++;
                expect({ name, bad, schemaOk: contract.validateC2S(name, bad).ok }).toEqual({ name, bad, schemaOk: false });
                expect(joi).toBeTruthy();
                expect(() => validators.validate(joi, bad)).toThrow();
            }
        }
        // Every Joi-wrapped event with a payload has negative examples
        const withPayload = contract.c2sNames().filter((n2) => {
            const e = contract.schema.c2s[n2];
            return (e.joi || e.joiInHandler) && Object.keys(e.payload?.properties || {}).length > 0;
        });
        expect(withPayload.filter((n2) => !(contract.schema.c2s[n2].invalid || []).length)).toEqual([]);
        expect(n).toBeGreaterThan(50);
        // Both clients always send position with bids and plays (Joi requires it)
        expect(contract.schema.c2s.playerBid.payload.required).toEqual(expect.arrayContaining(['bid', 'position']));
        expect(contract.schema.c2s.playCard.payload.required).toEqual(expect.arrayContaining(['card', 'position']));
    });

    test('every c2s event with a payload has a Joi schema (V1_REMOVALS #18): the wrapper\'s, or one its handler checks', () => {
        const noJoi = contract.c2sNames().filter((n) => contract.schema.c2s[n].joi === null && !contract.schema.c2s[n].joiInHandler &&
            contract.schema.c2s[n].payload && Object.keys(contract.schema.c2s[n].payload.properties || {}).length > 0);
        expect(noJoi).toEqual([]);
        // joiInHandler only where the handler drops a bad payload silently (voice, client error
        // reports), and only with no wrapper schema
        const inHandler = contract.c2sNames().filter((n) => contract.schema.c2s[n].joiInHandler);
        const SFU = ['sfuClose', 'sfuIceRestart', 'sfuLeave', 'sfuPull', 'sfuPush', 'sfuRenegotiate', 'sfuResume', 'sfuSession'];
        expect(inHandler.sort()).toEqual(['clientError', ...SFU, 'voiceAnswer', 'voiceIceCandidate', 'voiceOffer'].sort());
        const sfuHandlers = require('../sfuHandlers');
        for (const n of inHandler) {
            expect({ n, joi: contract.schema.c2s[n].joi }).toEqual({ n, joi: null });
            if (n === 'clientError') {
                expect({ n, src: /validate\('clientError', data\)/.test(clientErrorSrc) }).toEqual({ n, src: true });
                continue;
            }
            // The SFU requests: one table of ops, each validated by its own event's schema
            // (sfuHandlers.handle: validate(spec.event, raw)), answered sfuReply invalid
            if (SFU.includes(n)) {
                expect({ n, op: sfuHandlers.OPS[n]?.event, joi: contract.schema.c2s[n].joiInHandler }).toEqual({ n, op: n, joi: n });
                expect(/validate\(spec\.event, raw\)/.test(fs.readFileSync(path.join(__dirname, '..', 'sfuHandlers.js'), 'utf8'))).toBe(true);
                continue;
            }
            expect({ n, src: new RegExp(`checked\\(socket, '${n}', data\\)`).test(voiceSrc) }).toEqual({ n, src: true });
        }
    });

    test('every test suite that records socket emits has them contract-checked', () => {
        // A local stub io/socket (emit -> log.push) must call instrument(log),
        // or come from gameDriver / tournamentDriver (which do)
        const dir = __dirname;
        const unguarded = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).filter((f) => {
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            const localStub = /function makeIo\(|function makeSocket\(/.test(src);
            return localStub && !/instrument\(log\)/.test(src);
        });
        expect(unguarded).toEqual([]);
    });

    test('production server code never requires contract/', () => {
        const hits = [];
        const walk = (dir) => {
            for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, f.name);
                if (f.isDirectory()) {
                    if (f.name === '__tests__' || f.name === 'testUtils' || f.name === 'node_modules') continue;
                    walk(p);
                } else if (f.name.endsWith('.js') && /require\([^)]*contract/.test(fs.readFileSync(p, 'utf8'))) {
                    hits.push(p);
                }
            }
        };
        walk(path.join(__dirname, '..', '..'));
        expect(hits).toEqual([]);
    });
});

// ==================== (b) F1: a full human game ====================


describe('(b) F1 full human game through the lobby', () => {
    test('13 hands with redeal, bore, lazy/active, watch rejoin, resign, rejects, spectator, /leave', async () => {
        let watcher = null;
        let seqWatch = null;
        let paceWatch = null;
        const asked = {};
        const ask = (w, s, data) => {
            const mark = w.log.length;
            snapshotHandlers.requestSnapshot(s, w.io, data);
            return w.log.slice(mark).find((l) => l.to === `self:${s.id}` && l.event === 'stateSnapshot').data;
        };
        const { w } = await playF1({
            errorLogs,
            hooks: {
                onWorld(wd) {
                    watcher = watchSnapshots(wd);
                    seqWatch = watchSeq(wd.io);
                    paceWatch = watchPacing({ requireResumeInMs: true });
                },
                // (f) requestSnapshot from a seat, a lazy watcher and a spectator
                async onStep(wd, game, { hands, stage }) {
                    const own = (pos) => wd.sockets.get(game.seat(pos).ownerSocketId);
                    if (hands === 1 && stage === Phase.PLAYING && !asked.seat) {
                        asked.seat = ask(wd, own(1), { requestId: 'seat-1' });
                        expect(asked.seat).toMatchObject({ requestId: 'seat-1', snapshot: { viewer: { role: 'seat', position: 1 } } });
                        expect(asked.seat.snapshot.partial).toEqual([]);
                    }
                    const s3 = game.seat(3);
                    if (s3.controller === 'resignBot' && s3.ownerSocketId && !asked.lazy) {
                        asked.lazy = ask(wd, own(3), { requestId: 9, log: false });
                        expect(asked.lazy.snapshot).toMatchObject({ viewer: { role: 'lazyWatcher', position: 3, ownerView: 'watch' }, partial: ['log'], log: [] });
                        expect(asked.lazy.snapshot.hand).toHaveLength(game.getHand(s3.seatSocketId).length);
                    }
                    const specId = [...game.spectators.keys()][0];
                    if (specId && !asked.spectator) {
                        asked.spectator = ask(wd, wd.sockets.get(specId), undefined);
                        expect(asked.spectator.snapshot).toMatchObject({ viewer: { role: 'spectator', position: null }, hand: null });
                        expect('requestId' in asked.spectator).toBe(false);
                    }
                },
            },
        });
        expect(Object.keys(asked).sort()).toEqual(['lazy', 'seat', 'spectator']);
        // (h) snapshot invariants over the whole game
        const result = watcher.stop();
        expect(result.failures).toEqual([]);
        expect(result.checked).toBeGreaterThan(5);
        expect(result.delivered).toBeGreaterThan(5);
        // (g) seq: per game strictly increasing, one value per deal, no gap per receiver
        const sq = seqWatch.stop();
        expect(sq.failures).toEqual([]);
        expect(sq.games).toBeGreaterThanOrEqual(1);
        // (i) resume holds: nothing actionable while a trick is held;
        // trickComplete/updateTurn and handComplete/gameStart/updateTurn share a tick
        const pw = paceWatch.stop();
        expect(pw.failures).toEqual([]);
        expect(pw.checked).toBeGreaterThan(300);
        const bySelf = (e) => events(w.log, e).filter((l) => l.to.startsWith('self:'));
        expect(bySelf('rejoinSuccess').length).toBeGreaterThanOrEqual(4);
        const chats = events(w.log, 'chatMessage').map((l) => l.data);
        expect(chats.some((d) => d.username.startsWith('🤖') && d.isSpectator === false)).toBe(true); // bot chat
        expect(chats.some((d) => d.isSpectator === true)).toBe(true);
        expect(chats.every((d) => typeof d.isSpectator === 'boolean' && !('type' in d))).toBe(true); // type dropped (V1_REMOVALS #12)
    }, 120000);
});

// ==================== (b2) the bid clock ====================

describe('(b2) bid clock', () => {
    test('running, stopped {timeout | bid | controller}, a same-turn resume, snapshots mid-clock; seq and snapshot invariants hold', async () => {
        const SeatState = require('../../game/SeatState');
        const pacing = require('../../game/pacing');
        Math.random = mulberry32(31);
        const w = world('b2');
        const seqWatch = watchSeq(w.io);
        const snaps = watchSnapshots(w);
        const names = ['b2_ann', 'b2_bob', 'b2_cat', 'b2_dan'];
        const socks = names.map((n, i) => w.user(`b2-h${i}`, n));
        mainRoomHandlers.createLobby(socks[0], w.io, { name: 'Clock table' });
        const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
        for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
        const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
        const game = gameManager.getPlayerGame(socks[0].id);
        await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
        const draws = socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
        await advanceUntil(() => game.stage === Phase.BIDDING && !game.resume, 100);
        const spec = w.user('b2-spec', 'b2_fan');
        mainRoomHandlers.joinAsSpectator(spec, w.io, { gameId: game.gameId });
        const owner = (pos) => w.sockets.get(game.seat(pos).ownerSocketId);
        const clockEvents = () => events(w.log, 'bidClock').map((l) => (l.data.running ? `running:${l.data.position}` : `${l.data.reason}:${l.data.position}`));
        const ask = (s) => {
            const mark = w.log.length;
            snapshotHandlers.requestSnapshot(s, w.io, { requestId: 'b2' });
            return w.log.slice(mark).find((l) => l.event === 'stateSnapshot').data.snapshot;
        };

        // 1. the seat on turn idles: running at 10 s, a snapshot mid-clock, the timeout bid 0
        const p1 = game.currentTurn;
        await jest.advanceTimersByTimeAsync(SeatState.BID_CLOCK_DELAY_MS);
        expect(clockEvents()).toEqual([`running:${p1}`]);
        expect(ask(spec).bidClock).toEqual({ position: p1, inMs: SeatState.BID_CLOCK_MS, durationMs: SeatState.BID_CLOCK_MS });
        await jest.advanceTimersByTimeAsync(SeatState.BID_CLOCK_MS);
        expect(game.playerBids[p1 - 1]).toBe('0');
        expect(clockEvents()).toEqual([`running:${p1}`, `timeout:${p1}`]);
        // 2. the next seat bids mid-tune
        const p2 = game.currentTurn;
        await jest.advanceTimersByTimeAsync(SeatState.BID_CLOCK_DELAY_MS + 5000);
        await gameHandlers.playerBid(owner(p2), w.io, { bid: '1' });
        expect(clockEvents().slice(2)).toEqual([`running:${p2}`, `bid:${p2}`]);
        expect(ask(spec)).not.toHaveProperty('bidClock');
        // 3. the next seat goes /lazy mid-tune and /active again before its bot bids
        const p3 = game.currentTurn;
        await jest.advanceTimersByTimeAsync(SeatState.BID_CLOCK_DELAY_MS + 5000);
        chatHandlers.chatMessage(owner(p3), w.io, { message: '/lazy' });
        chatHandlers.chatMessage(owner(p3), w.io, { message: '/active' });
        expect(clockEvents().slice(4)).toEqual([`running:${p3}`, `controller:${p3}`, `running:${p3}`]);
        await gameHandlers.playerBid(owner(p3), w.io, { bid: '1' });
        // the rest bid at once: no clock
        while (game.stage === Phase.BIDDING) {
            await gameHandlers.playerBid(owner(game.currentTurn), w.io, { bid: '1' });
        }
        expect(clockEvents().slice(7)).toEqual([`bid:${p3}`]);
        await jest.advanceTimersByTimeAsync(1000);
        // every bidClock went to the room unsequenced
        expect(events(w.log, 'bidClock').every((l) => l.to === game.roomName && !('seq' in l.data))).toBe(true);
        const sq = seqWatch.stop();
        expect(sq.failures).toEqual([]);
        const sn = snaps.stop();
        expect(sn.failures).toEqual([]);
        await Promise.all([...starting, ...draws]);
    }, 60000);
});

// ==================== (b3) /help ====================

describe('(b3) /help', () => {
    test('assistHint (bid, status) to a cap socket, private gameLogEntry lines elsewhere, the room notice; seq and snapshot invariants hold', async () => {
        const pacing = require('../../game/pacing');
        const clientInfo = require('../clientInfo');
        Math.random = mulberry32(37);
        const w = world('b3');
        const seqWatch = watchSeq(w.io);
        const snaps = watchSnapshots(w);
        const names = ['b3_ann', 'b3_bob', 'b3_cat', 'b3_dan'];
        const socks = names.map((n, i) => w.user(`b3-h${i}`, n));
        mainRoomHandlers.createLobby(socks[0], w.io, { name: 'Help table' });
        const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
        for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
        const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
        const game = gameManager.getPlayerGame(socks[0].id);
        await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
        const draws = socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
        await advanceUntil(() => game.stage === Phase.BIDDING && !game.resume, 100);
        const spec = w.user('b3-spec', 'b3_fan');
        mainRoomHandlers.joinAsSpectator(spec, w.io, { gameId: game.gameId });
        const owner = (pos) => w.sockets.get(game.seat(pos).ownerSocketId);
        const say = (s, message) => chatHandlers.chatMessage(s, w.io, { message });
        const p1 = game.currentTurn;
        const p2 = (p1 % 4) + 1;
        clientInfo.handle(owner(p1), w.io, { client: 'web', version: '1.0.0', caps: ['assist'] });

        const mark = w.log.length;
        say(owner(p1), '/help');                 // a bid suggestion, counted
        say(owner(p1), '?help');                 // the same turn again: not counted
        say(owner(p2), '?help');                 // off turn, no cap: the status line
        say(spec, '?help');                      // players only
        const hints = w.log.slice(mark).filter((l) => l.event === 'assistHint');
        expect(hints.map((l) => [l.to, l.data.kind, l.data.counted])).toEqual([[owner(p1).id, 'bid', true], [owner(p1).id, 'bid', false]]);
        const privateLines = w.log.slice(mark).filter((l) => l.event === 'gameLogEntry' && !l.to.startsWith('game:'));
        expect(privateLines.map((l) => l.to)).toEqual([owner(p2).id, spec.id]);
        expect(privateLines.every((l) => !('seq' in l.data))).toBe(true);
        const notices = w.log.slice(mark).filter((l) => l.event === 'gameLogEntry' && l.to === game.roomName);
        expect(notices.map((l) => l.data.message)).toEqual([`${game.seat(p1).ownerUsername} used /help.`]);
        expect(w.log.slice(mark).some((l) => l.event === 'chatMessage')).toBe(false);

        await gameHandlers.playerBid(owner(p1), w.io, { bid: '1' });
        say(owner(p1), '/help');                 // off turn now, with the cap: kind status
        expect(events(w.log, 'assistHint').at(-1).data).toMatchObject({ kind: 'status', counted: false, uses: 1 });
        say(owner(p2), '?help');                 // on turn, no cap: the answer line, then the notice
        expect(w.log.at(-2)).toMatchObject({ to: owner(p2).id, event: 'gameLogEntry', data: { type: 'system' } });
        expect(w.log.at(-2).data.message).toMatch(/^Suggested \(only you see this\): Bid .*\(Help 1 of 3 free\)$/);
        expect(w.log.at(-1)).toMatchObject({ to: game.roomName, event: 'gameLogEntry', data: { message: `${game.seat(p2).ownerUsername} used /help.` } });
        while (game.stage === Phase.BIDDING) {
            await gameHandlers.playerBid(owner(game.currentTurn), w.io, { bid: '1' });
        }
        await jest.advanceTimersByTimeAsync(1000);
        const sq = seqWatch.stop();
        expect(sq.failures).toEqual([]);
        const sn = snaps.stop();
        expect(sn.failures).toEqual([]);
        await Promise.all([...starting, ...draws]);
    }, 60000);
});

// ==================== (b4) the tutorial ====================

describe('(b4) the tutorial', () => {
    test('auto-start for a new account with the cap tutorial: assistState, tips and advice (assistHint source tutorial), /tutorial off; seq and snapshot invariants hold', async () => {
        const pacing = require('../../game/pacing');
        const clientInfo = require('../clientInfo');
        Math.random = mulberry32(41);
        const w = world('b4');
        const seqWatch = watchSeq(w.io);
        const snaps = watchSnapshots(w);
        const names = ['b4_ann', 'b4_bob', 'b4_cat', 'b4_dan'];
        const socks = names.map((n, i) => w.user(`b4-h${i}`, n));
        // b4_ann is a new account (sign-up wrote users.tutorial 'pending') on a client that renders tips
        socks[0].data.tutorialFlag = 'pending';
        clientInfo.handle(socks[0], w.io, { client: 'web', version: '1.0.0', caps: ['assist', 'tutorial'] });
        mainRoomHandlers.createLobby(socks[0], w.io, { name: 'Tutorial table' });
        const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
        for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
        const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
        const game = gameManager.getPlayerGame(socks[0].id);
        await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
        const draws = socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
        await advanceUntil(() => game.stage === Phase.BIDDING && !game.resume, 100);
        await jest.advanceTimersByTimeAsync(1); // the tutor's setImmediate
        const me = game.seatByOwnerSocket(socks[0].id);
        const owner = (pos) => w.sockets.get(game.seat(pos).ownerSocketId);
        expect(events(w.log, 'assistState').map((l) => [l.to, l.data.tutorial, l.data.auto])[0]).toEqual([socks[0].id, true, true]);
        expect(events(w.log, 'gameLogEntry').some((l) => l.data.message === 'b4_ann is playing with the tutorial.')).toBe(true);
        expect(events(w.log, 'assistHint').filter((l) => l.data.kind === 'tip').map((l) => l.data.tipId)[0]).toBe('T.welcome');
        // Bid to the tutorial seat's turn: its advice comes after the updateTurn
        while (game.stage === Phase.BIDDING && game.currentTurn !== me) {
            await gameHandlers.playerBid(owner(game.currentTurn), w.io, { bid: '1' });
            await jest.advanceTimersByTimeAsync(1);
        }
        const advice = events(w.log, 'assistHint').filter((l) => l.data.source === 'tutorial' && l.data.kind === 'bid');
        expect(advice).toHaveLength(1);
        expect(advice[0].data).toMatchObject({ counted: false, uses: 0 });
        chatHandlers.chatMessage(socks[0], w.io, { message: '/tutorial off' });
        expect(events(w.log, 'assistState').at(-1).data).toMatchObject({ tutorial: false, auto: false, assisted: true });
        while (game.stage === Phase.BIDDING) {
            await gameHandlers.playerBid(owner(game.currentTurn), w.io, { bid: '1' });
        }
        await jest.advanceTimersByTimeAsync(1000);
        const sq = seqWatch.stop();
        expect(sq.failures).toEqual([]);
        const sn = snaps.stop();
        expect(sn.failures).toEqual([]);
        await Promise.all([...starting, ...draws]);
    }, 60000);
});

// ==================== (b5) the over-the-shoulder view ====================

describe('(b5) the over-the-shoulder view', () => {
    test('watchHand: stateSnapshot reason watchHand (viewer.shoulder), watchHandRefused, the redeal\'s gameStart shoulder, a mirrored assistHint, the wide spectatorsUpdated; seq and snapshot invariants hold', async () => {
        const pacing = require('../../game/pacing');
        const clientInfo = require('../clientInfo');
        const shoulderView = require('../shoulderView');
        const { SPECTATORS_COALESCE_MS } = require('../../game/spectatorRoster');
        process.env.BID_CLOCK = 'off';
        Math.random = mulberry32(41);
        const w = world('b5');
        const seqWatch = watchSeq(w.io);
        const snaps = watchSnapshots(w);
        const names = ['b5_ann', 'b5_bob', 'b5_cat', 'b5_dan'];
        const socks = names.map((n, i) => w.user(`b5-h${i}`, n));
        mainRoomHandlers.createLobby(socks[0], w.io, { name: 'Shoulder table' });
        const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
        for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
        const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
        const game = gameManager.getPlayerGame(socks[0].id);
        const fan = w.user('b5-fan', 'b5_fan');
        clientInfo.handle(fan, w.io, { client: 'web', version: '1.0.0', caps: ['avatarUrl', 'shoulderView'] });
        await mainRoomHandlers.joinAsSpectator(fan, w.io, { gameId: game.gameId });
        shoulderView.watchHand(fan, w.io, { gameId: game.gameId, position: 1 }); // CREATED: not_dealt
        await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
        const draws = socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
        await advanceUntil(() => game.stage === Phase.BIDDING && !game.resume, 100);
        const owner = (pos) => w.sockets.get(game.seat(pos).ownerSocketId);
        const pos = game.currentTurn;
        clientInfo.handle(owner(pos), w.io, { client: 'web', version: '1.0.0', caps: ['assist'] });
        const plain = w.user('b5-plain', 'b5_plain');
        await mainRoomHandlers.joinAsSpectator(plain, w.io, { gameId: game.gameId });
        await jest.advanceTimersByTimeAsync(SPECTATORS_COALESCE_MS);

        const mark = w.log.length;
        shoulderView.watchHand(plain, w.io, { gameId: game.gameId, position: pos });   // no cap: dropped silently
        shoulderView.watchHand(fan, w.io, { gameId: game.gameId, position: pos, requestId: 'b5-w1' });
        chatHandlers.chatMessage(owner(pos), w.io, { message: '/help' });            // mirrored to fan
        await jest.advanceTimersByTimeAsync(SPECTATORS_COALESCE_MS);                 // the wide copy alone
        const mine = w.log.slice(mark).filter((l) => l.to === `self:${fan.id}` || l.to === fan.id).map((l) => l.event);
        expect(mine).toEqual(['stateSnapshot', 'assistHint', 'spectatorsUpdated']);
        expect(w.log.slice(mark).filter((l) => l.to === `self:${plain.id}` || l.to === plain.id).map((l) => l.event)).toEqual([]);

        // the all-zero redeal: the watcher's spectator gameStart carries the seat's new hand
        const dealSeq = game.dealSeq;
        while (game.stage === Phase.BIDDING && game.dealSeq === dealSeq) {
            await gameHandlers.playerBid(owner(game.currentTurn), w.io, { bid: '0' });
        }
        await advanceUntil(() => game.dealSeq > dealSeq && game.stage === Phase.BIDDING, 100);
        const start = events(w.log, 'gameStart').filter((l) => l.to === fan.id).at(-1);
        expect(start.data.shoulder.position).toBe(pos);
        shoulderView.watchHand(fan, w.io, { gameId: game.gameId, position: null });
        await jest.advanceTimersByTimeAsync(SPECTATORS_COALESCE_MS);
        while (game.stage === Phase.BIDDING) {
            await gameHandlers.playerBid(owner(game.currentTurn), w.io, { bid: '1' });
        }
        await jest.advanceTimersByTimeAsync(1000);
        const sq = seqWatch.stop();
        expect(sq.failures).toEqual([]);
        const sn = snaps.stop();
        expect(sn.failures).toEqual([]);
        delete process.env.BID_CLOCK;
        await Promise.all([...starting, ...draws]);
    }, 60000);
});

// ==================== (f) requestSnapshot ====================

describe('(f) requestSnapshot -> stateSnapshot', () => {
    test('an entrant during DRAWING, an unmapped socket; Joi, rate limit and the index registration', async () => {
        Math.random = mulberry32(3);
        const w = world('f');
        const socks = ['f_a', 'f_b', 'f_c', 'f_d'].map((n, i) => w.user(`f-h${i}`, n));
        mainRoomHandlers.createLobby(socks[0], w.io, {});
        const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
        for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
        const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
        await jest.advanceTimersByTimeAsync(3500);
        const game = gameManager.getPlayerGame(socks[0].id);
        expect(game.stage).toBe(Phase.DRAWING);
        const watcher = watchSnapshots(w);
        await gameHandlers.draw(socks[1], w.io, { num: 3 });
        const before = w.log.length;
        snapshotHandlers.requestSnapshot(socks[1], w.io, {});
        const reply = w.log.slice(before).find((l) => l.event === 'stateSnapshot').data;
        expect(reply.snapshot).toMatchObject({ stage: 'DRAWING', viewer: { role: 'entrant', position: null }, seats: [], hand: null });
        expect(reply.snapshot.draw.viewerDrawOrder).toBe(1);
        expect(reply.snapshot.draw.drawn).toHaveLength(1);
        expect(reply.snapshot.entrants).toHaveLength(4);

        // Through the real registration: Joi, rate limit, no payload
        const handlers = new Map();
        const fake = Object.assign(w.socket('f-reg'), { on: (ev, cb) => handlers.set(ev, cb) });
        gameManager.registerUser(fake.id, 'f_reg');
        require('../index').setupSocketHandlers({ on: (ev, cb) => cb(fake) });
        const mark = w.log.length;
        handlers.get('requestSnapshot')(undefined);
        handlers.get('requestSnapshot')({ requestId: 'x'.repeat(65) });
        for (let i = 0; i < 10; i++) handlers.get('requestSnapshot')({ requestId: i });
        const mine = w.log.slice(mark).filter((l) => l.to === `self:${fake.id}`);
        expect(mine[0]).toMatchObject({ event: 'stateSnapshot', data: { snapshot: null, reason: 'not_in_game' } });
        expect(mine[1]).toMatchObject({ event: 'serverError', data: { code: 'validation', handler: 'requestSnapshot' } });
        expect(mine.filter((l) => l.event === 'serverError' && l.data.code === 'rateLimit')).toHaveLength(2);
        rateLimiter.clearSocket(fake.id);

        // (the 4th draw awaits the seating pauses: never await it under fake timers)
        const draws = [socks[0], socks[2], socks[3]].map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
        await advanceUntil(() => game.stage === Phase.BIDDING, 100);
        await jest.advanceTimersByTimeAsync(2000); // the first-hand pause
        expect(watcher.stop().failures).toEqual([]);
        await Promise.all([...starting, ...draws]);
        expect(errorLogs).toEqual([]);
    });
});

// ==================== (f2) family lobby: extras and spectator voice ====================

describe('(f2) family lobby of 6 capable clients', () => {
    test('extras watch from CREATED, voiceSettings, the old switch ignored in the lobby and in the game, a main-room spectator', async () => {
        Math.random = mulberry32(5);
        const w = world('f2');
        const clientInfo = require('../clientInfo');
        const capable = (s) => clientInfo.handle(s, w.io, { client: 'web', version: '1', caps: ['avatarUrl', 'casualSpectators'] });
        const socks = ['f2_a', 'f2_b', 'f2_c', 'f2_d', 'f2_e', 'f2_f'].map((n, i) => {
            const s = w.user(`f2-h${i}`, n);
            capable(s);
            return s;
        });
        mainRoomHandlers.createLobby(socks[0], w.io, {});
        const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
        for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
        expect(gameManager.getLobbyById(lobbyId).players).toHaveLength(6);
        // The host's old switch in the lobby (iOS 12-15): ignored, answered
        voiceHandlers.setSpectatorsCanTalk(socks[0], w.io, { spectatorsCanTalk: false });
        voiceHandlers.setSpectatorsCanTalk(socks[0], w.io, { spectatorsCanTalk: true });
        const starting = socks.slice(0, 4).map((s) => lobbyHandlers.playerReady(s, w.io));
        // A fifth Ready while the table is full: refused, list re-sent
        await lobbyHandlers.playerReady(socks[4], w.io);
        await jest.advanceTimersByTimeAsync(1600);
        const game = gameManager.getPlayerGame(socks[0].id);
        expect(game.voiceSpectators.size).toBe(2);
        expect(events(w.log, 'voiceSettings').length).toBeGreaterThan(0);
        // A main-room spectator (capable) joins voice (muted, may talk)
        const m = w.user('f2-m', 'f2_m');
        capable(m);
        mainRoomHandlers.joinMainRoom(m, w.io);
        mainRoomHandlers.joinAsSpectator(m, w.io, { gameId: game.gameId });
        expect(game.voiceSpectators.has(m.id)).toBe(true);
        // The host's old in-game switch: ignored, its voiceSettings back
        voiceHandlers.setSpectatorsCanTalk(socks[0], w.io, { spectatorsCanTalk: false });
        expect(game.casualVoice.spectatorsCanTalk).toBe(true);
        expect(events(w.log, 'voiceSettings').every((l) => l.data.spectatorsCanTalk === true && l.data.canChange === false)).toBe(true);
        await jest.advanceTimersByTimeAsync(3500);
        const draws = socks.slice(0, 4).map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
        await advanceUntil(() => game.stage === Phase.BIDDING, 100);
        await jest.advanceTimersByTimeAsync(2000);
        await Promise.all([...starting, ...draws]);
        expect(errorLogs).toEqual([]);
    });
});

// ==================== (f3) play again ====================

describe('(f3) play again after a lobby-born casual game', () => {
    test('lobbyReturn with a hold (returning) and a reservation (expected), auto-claim, releaseLobbyHold, the lingering call', async () => {
        Math.random = mulberry32(9);
        const w = world('f3');
        const clientInfo = require('../clientInfo');
        const { playLobbyGame } = require('../../testUtils/playAgainDriver');
        const hello = (s, caps) => clientInfo.handle(s, w.io, { client: 'web', version: '1', caps });
        const full = ['avatarUrl', 'casualSpectators', 'playAgain'];
        const socks = ['f3_a', 'f3_b', 'f3_c', 'f3_d'].map((n, i) => {
            const s = w.user(`f3-h${i}`, n);
            s.data.username = n;
            hello(s, i === 3 ? ['avatarUrl'] : full);
            mainRoomHandlers.joinMainRoom(s, w.io);
            return s;
        });
        mainRoomHandlers.createLobby(socks[0], w.io, { name: 'F3' });
        const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
        for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
        await playLobbyGame(w.io, socks, {
            before: async () => {
                await chatHandlers.chatMessage(socks[2], w.io, { message: '/lazy' });
                await w.kill(socks[2]);
            },
        });
        expect(events(w.log, 'lobbyReturn')).toHaveLength(2);
        const back = gameManager.getPlayerLobby(socks[0].id);
        expect(back.afterGame.reserved.has('f3_d')).toBe(true);
        // The offline player is back on a capable client: auto-claimed
        const again = w.user('f3-h2b', 'f3_c', { db: false });
        again.data.username = 'f3_c';
        hello(again, full);
        mainRoomHandlers.joinMainRoom(again, w.io);
        expect(gameManager.playerLobbies.get(again.id)).toBe(back.id);
        // The host stops waiting for the legacy player; it leaves its score screen
        await require('../playAgain').releaseLobbyHold(socks[0], w.io, { username: 'f3_d' });
        mainRoomHandlers.joinMainRoom(socks[3], w.io);
        expect(errorLogs).toEqual([]);
    });
});

// ==================== (c) F2: ambient bot games ====================

describe('(c) F2 ambient bot games', () => {
    test.each([11, 22, 33])('seed %i: a full bot game', async (seed) => {
        Math.random = mulberry32(seed);
        const w = world(`amb${seed}`);
        const seqWatch = watchSeq(w.io);
        const game = ambient.startBotGame(w.io);
        for (let t = 0; t < 30 && gameManager.getGameById(game.gameId); t++) {
            await jest.advanceTimersByTimeAsync(60000);
            if (t === 0) ambient.announceGameVisible(w.io);
        }
        ambient.stopAmbientActivity();
        expect(seqWatch.stop().failures).toEqual([]);
        expect(events(w.log, 'gameEnd')).toHaveLength(1);
        expectSilentAfterTerminal(w, game);
        expect(errorLogs).toEqual([]);
    }, 60000);
});

// ==================== (d) F3: tournament ====================

describe('(d) F3 tournament', () => {
    test('a full tournament with a mid-hand spectator', async () => {
        Math.random = mulberry32(5);
        const ctx = await setupTournament(1);
        const seqWatch = watchSeq(ctx.io);
        const snapWatch = watchSnapshots({ io: ctx.io, sockets: new Map(ctx.sockets.map((s) => [s.id, s])) });
        const watcher = newUser(ctx.io, ctx.log, 'f3_watcher');
        const { allTables } = await playTournament(ctx, {
            async round(round, c, tables) {
                if (round !== 1) return;
                await advanceUntil(() => [Phase.BIDDING, Phase.PLAYING].includes(tables[0].stage), 100);
                tournamentHandlers.spectateTournament(watcher, c.io, { tournamentId: c.t.tournamentId });
                tournamentHandlers.spectateTournamentGame(watcher, c.io, { gameId: tables[0].gameId });
                tournamentHandlers.tournamentChat(watcher, c.io, { message: 'watching' });
                tournamentHandlers.returnToTournament(watcher, c.io);
            },
        });
        expect(allTables).toHaveLength(4);
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        expect(seqWatch.stop().failures).toEqual([]);
        expect(snapWatch.stop().failures).toEqual([]);
        expect(errorLogs).toEqual([]);
    }, 120000);

    test('a tournament voice room past its cap: tournamentVoiceStatus to the one waiting in line, then when it is let in', async () => {
        const saved = process.env.TOURNAMENT_VOICE_MAX;
        process.env.TOURNAMENT_VOICE_MAX = '2';
        try {
            const { io, log } = newIo();
            const caps = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'tournamentVoice', 'tournamentVoiceStatus'];
            const s = ['f3v_a', 'f3v_b', 'f3v_c'].map((name) => {
                const x = newUser(io, log, name);
                x.data.client = { client: 'web', version: '1', build: null, caps };
                voiceHandlers.rememberBlockList(x, []);
                return x;
            });
            tournamentHandlers.createTournament(s[0], io);
            const t = gameManager.getPlayerTournament(s[0].id);
            for (const x of s.slice(1)) await tournamentHandlers.joinTournament(x, io, { tournamentId: t.tournamentId });
            await tournamentHandlers.leaveTournament(s[0], io);
            const status = log.filter((l) => l.event === 'tournamentVoiceStatus').map((l) => [l.to, l.data]);
            // every admitted member is told so on entry; the one in line is told it waits, then that it is in
            expect(status).toEqual([
                [s[0].id, { admitted: true, cap: 2 }],
                [s[1].id, { admitted: true, cap: 2 }],
                [s[2].id, { admitted: false, cap: 2 }],
                [s[2].id, { admitted: true, cap: 2 }],
            ]);
            expect(errorLogs).toEqual([]);
        } finally {
            if (saved === undefined) delete process.env.TOURNAMENT_VOICE_MAX;
            else process.env.TOURNAMENT_VOICE_MAX = saved;
        }
    });

    test('spectating during the draw, then a cancel', async () => {
        Math.random = mulberry32(6);
        const ctx = await setupTournament(2);
        const watcher = newUser(ctx.io, ctx.log, 'f3_drawwatch');
        tournamentHandlers.tournamentChat(ctx.sockets[1], ctx.io, { message: 'hi' });
        tournamentHandlers.tournamentUnready(ctx.sockets[1], ctx.io);
        tournamentHandlers.tournamentReady(ctx.sockets[1], ctx.io);
        // The host's round count (2026-11-25): tournamentSettingsUpdated + a system line
        tournamentHandlers.setTournamentRounds(creatorSocket(ctx), ctx.io, { totalRounds: 3 });
        expect(events(ctx.log, 'tournamentSettingsUpdated').map((l) => l.data.totalRounds)).toEqual([3]);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).some((g) => g.stage === Phase.DRAWING), 50, 30000);
        const table = liveTables(ctx.t).find((g) => g.stage === Phase.DRAWING);
        tournamentHandlers.spectateTournamentGame(watcher, ctx.io, { gameId: table.gameId });
        const full = ctx.log.find((l) => l.to === `self:${watcher.id}` && l.event === 'spectatorJoined');
        expect(full.data.trump).toBeNull();
        await tournamentHandlers.cancelTournament(creatorSocket(ctx), ctx.io);
        await ctx.starting;
        await jest.advanceTimersByTimeAsync(5000);
        expect(events(ctx.log, 'tournamentCancelled')).toHaveLength(1);
        const third = await setupTournament(2);
        await tournamentHandlers.leaveTournament(third.sockets[0], third.io); // creator leaves: handoff
        await tournamentHandlers.leaveTournament(third.sockets[1], third.io); // last one: deleted
        expect(errorLogs).toEqual([]);
    }, 60000);
});

// ==================== (d2) Cut for a buck ====================

describe('(d2) Cut for a buck', () => {
    test('a 1-round tournament of 3 with the cap, a legacy spectator: start, rounds, draws, a leave, reveals, the winner, tournamentComplete', async () => {
        const cutForABuck = require('../cutForABuck');
        const { giveCap, deckOf, drawAll } = require('../../testUtils/cutDriver');
        Math.random = mulberry32(77);
        const ctx = await setupTournament(3);
        ctx.sockets.forEach((s) => giveCap(s));
        tournamentHandlers.setTournamentRounds(creatorSocket(ctx), ctx.io, { totalRounds: 1 });
        cutForABuck.setEngineOptionsForTests({ deck: deckOf('7s', '7h', '7d', '2s', 'Kh') });
        const watcher = newUser(ctx.io, ctx.log, 'd2_watcher');
        await playTournament(ctx);
        expect(ctx.t.phase).toBe('cut');
        tournamentHandlers.spectateTournament(watcher, ctx.io, { tournamentId: ctx.t.tournamentId });
        await advanceUntil(() => ctx.t.cut.stage === 'drawing', 100, 30000);
        tournamentHandlers.returnToTournament(ctx.sockets[0], ctx.io);
        drawAll(ctx, Object.fromEntries(ctx.usernames.map((u, i) => [u, i])));
        await advanceUntil(() => ctx.t.cut.stage === 'drawing', 100, 30000);
        cutForABuck.draw(ctx.sockets[2], ctx.io, { round: 2, slot: 0 });
        await tournamentHandlers.leaveTournament(ctx.sockets[2], ctx.io);
        drawAll(ctx, { [ctx.usernames[0]]: 0, [ctx.usernames[1]]: 1 });
        await advanceUntil(() => ctx.t.phase === 'complete', 100, 30000);
        tournamentHandlers.returnToTournament(ctx.sockets[0], ctx.io);
        for (const e of ['cutForABuckStart', 'cutForABuckRound', 'cutForABuckDrew', 'cutForABuckLeft', 'cutForABuckReveal', 'cutForABuckWinner']) {
            expect({ e, n: events(ctx.log, e).length > 0 }).toEqual({ e, n: true });
        }
        expect(events(ctx.log, 'tournamentComplete')).toHaveLength(1);
        expect(events(ctx.log, 'tournamentComplete')[0].data.cutForABuck).toBeDefined();
        cutForABuck.setEngineOptionsForTests({});
        expect(errorLogs).toEqual([]);
    }, 120000);
});

// ==================== (e) non-game handlers ====================

describe('(d3) Cloudflare SFU voice in a tournament room', () => {
    // A fake Cloudflare (server/testUtils/fakeCloudflare.js); every sfuReply
    // variant, sfuRoster and sfuMember through the real handlers
    const sfuHandlers = require('../sfuHandlers');
    const cf = require('../../voice/sfu/cloudflareClient');
    const { createFakeCloudflare } = require('../../testUtils/fakeCloudflare');
    const KEYS = ['VOICE_SFU', 'CF_SFU_APP_ID', 'CF_SFU_APP_SECRET', 'CF_SFU_API_BASE'];

    test('session, push, pull, renegotiate, close, ICE restart, resume, leave and a refusal', async () => {
        const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
        const fake = createFakeCloudflare();
        cf._setFetchForTests(fake.fetch);
        Object.assign(process.env, fake.env());
        try {
            const { io, log } = newIo();
            const caps = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'tournamentVoice', 'sfuVoice'];
            const [a, b] = ['d3_a', 'd3_b'].map((name) => {
                const x = newUser(io, log, name);
                x.data.client = { client: 'web', version: '1', build: null, caps };
                voiceHandlers.rememberBlockList(x, []);
                return x;
            });
            tournamentHandlers.createTournament(a, io);
            const t = gameManager.getPlayerTournament(a.id);
            await tournamentHandlers.joinTournament(b, io, { tournamentId: t.tournamentId });
            let n = 0;
            const ask = async (s, ev, data = {}) => {
                const requestId = `d3-${++n}`;
                await sfuHandlers[ev](s, io, { requestId, ...data });
                return log.filter((l) => l.event === 'sfuReply' && l.data.requestId === requestId).at(-1).data;
            };
            const offer = { type: 'offer', sdp: 'v=0 offer' };
            const sa = await ask(a, 'sfuSession');
            await ask(a, 'sfuPush', { sessionId: sa.sessionId, offer, mid: '0', trackName: 'mic' });
            const sb = await ask(b, 'sfuSession');
            const pull = await ask(b, 'sfuPull', { sessionId: sb.sessionId, tracks: [{ sessionId: sa.sessionId, trackName: 'mic' }] });
            expect(pull.tracks[0].mid).toBe('0');
            await ask(b, 'sfuRenegotiate', { sessionId: sb.sessionId, answer: { type: 'answer', sdp: 'v=0 answer' } });
            await ask(b, 'sfuClose', { sessionId: sb.sessionId, mids: ['0'], offer });
            await ask(a, 'sfuIceRestart', { sessionId: sa.sessionId, offer });
            await ask(a, 'sfuResume', { sessionId: sa.sessionId, sessionToken: sa.sessionToken, trackName: 'mic', mid: '0' });
            await ask(b, 'sfuLeave', { sessionId: sb.sessionId });
            const refused = await ask(b, 'sfuPush', { sessionId: sb.sessionId, offer, mid: '0', trackName: 'mic' });
            expect(refused).toMatchObject({ ok: false, error: { code: 'not_your_session' } });
            expect(log.filter((l) => l.event === 'sfuReply').map((l) => (l.data.ok ? l.data.op : 'error'))).toEqual(
                ['session', 'push', 'session', 'pull', 'renegotiate', 'close', 'iceRestart', 'resume', 'leave', 'error']);
            expect(events(log, 'sfuRoster').length).toBeGreaterThan(1);
            expect(events(log, 'sfuMember').map((l) => l.data.event)).toEqual(expect.arrayContaining(['joined', 'session', 'published', 'session']));
            await tournamentHandlers.cancelTournament(a, io);
            expect(errorLogs).toEqual([]);
        } finally {
            cf._setFetchForTests(null);
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    });
});

describe('(e) non-game handlers', () => {
    test('auth, profile, safety, main room, lobby, queue, voice, errors', async () => {
        jest.useRealTimers();
        const w = world('e');
        const a = w.socket('e-a');
        await authHandlers.signUp(a, w.io, { username: 'e_alice', password: 'pw1-long' });
        await authHandlers.signUp(a, w.io, { username: 'e_alice', password: 'pw1-long' }); // taken
        const b = w.socket('e-b');
        await authHandlers.signIn(b, w.io, { username: 'e_alice', password: 'nope' });
        await authHandlers.signIn(b, w.io, { username: 'e_alice', password: 'pw1-long' }); // kicks a: forceLogout
        expect(selfEvents(w, 'e-a')).toContain('forceLogout');
        const token = w.log.filter((l) => l.event === 'signInResponse' && l.data.success).pop().data.sessionToken;
        const c = w.socket('e-c');
        await authHandlers.restoreSession(c, w.io, { username: 'e_alice', sessionToken: token });
        await authHandlers.restoreSession(c, w.io, { username: 'e_nobody', sessionToken: token });
        // Change password: a wrong current one, a short new one, then a real change
        await authHandlers.changePassword(c, w.io, { current: 'nope', next: 'pw2-longer' });
        await authHandlers.changePassword(c, w.io, { current: 'pw1-long', next: 'short' });
        await authHandlers.changePassword(c, w.io, { current: 'pw1-long', next: 'pw2-longer' });
        expect(events(w.log, 'changePasswordResponse').map((l) => l.data.success)).toEqual([false, false, true]);

        // DB content, so the leaderboard rows and records periods are validated
        // non-empty: a player with games, a game this month, an old one and a
        // legacy record without bags
        mockDb.current.users._insert({
            username: 'e_vet', profilePic: 4, customProfilePic: null,
            stats: { gamesPlayed: 5, wins: 3, totalPoints: 412, totalTricksBid: 30, totalTricksTaken: 33, totalHands: 65,
                totalSets: 4, totalSetPoints: 120, totalFaults: 1, totalHSI: 310 },
        });
        const rec = (gameId, t1, t2, completedAt, bags = true) => ({
            gameId, team1Score: t1, team2Score: t2, team1Players: ['e_vet', 'e_zed'], team2Players: ['e_bob', '[deleted]'],
            ...(bags ? { team1Bags: 3, team2Bags: -1 } : {}), completedAt,
        });
        mockDb.current.gameRecords._insert(rec('g-now', 312, -40, new Date()));
        mockDb.current.gameRecords._insert(rec('g-old', 150, 220, new Date('2020-03-01T00:00:00Z')));
        mockDb.current.gameRecords._insert(rec('g-legacy', 90, 80, new Date('2019-05-01T00:00:00Z'), false));

        // Profile
        await profileHandlers.getProfile(c, w.io);
        await profileHandlers.updateProfilePic(c, w.io, { profilePic: 12 });
        await profileHandlers.updateProfilePic(c, w.io, { profilePic: 99 });
        await profileHandlers.uploadProfilePic(c, w.io, { imageData: 'data:image/png;base64,iVBORw0KGgo=' });
        await profileHandlers.uploadProfilePic(c, w.io, { imageData: 'nope' });
        await profileHandlers.getLeaderboard(c, w.io);
        await profileHandlers.getRecords(c, w.io);
        await profileHandlers.searchPlayers(c, w.io, { query: 'e_' });
        await profileHandlers.searchPlayers(c, w.io, {});
        // the Players page's online list pictures (2026-11-27): known names
        // in the order asked, an unknown one absent; a DB failure
        await profileHandlers.playerCards(c, w.io, { usernames: ['e_vet', 'e_ghost', 'e_vet'] });
        expect(events(w.log, 'playerCardsResponse').pop().data.players.map((p) => p.username)).toEqual(['e_vet']);
        const cardsFind = jest.spyOn(mockDb.current.users, 'find').mockImplementationOnce(() => { throw new Error('down'); });
        await profileHandlers.playerCards(c, w.io, { usernames: ['e_vet'] });
        cardsFind.mockRestore();
        expect(events(w.log, 'playerCardsResponse').pop().data).toEqual({ success: false, message: 'Database error' });
        await profileHandlers.getPlayerProfile(c, w.io, { username: 'e_alice' });
        await profileHandlers.getPlayerProfile(c, w.io, { username: 'e_ghost' });
        await profileHandlers.getPlayerProfile(c, w.io, { username: 'e_vet' });
        // Badges (cap `badges`): a record that newly earns one tells the
        // player's live socket (badgesAwarded), and the profile replies of
        // such a socket list the earned ones; without the cap, neither
        expect(events(w.log, 'profileResponse').pop().data).not.toHaveProperty('badges');
        const helloBefore = c.data.client;
        c.data.client = { client: 'web', version: '1', build: null, caps: ['badges'] };
        badgeAwards.setIo(w.io);
        const earning = { gameId: 'g-now', completedAt: new Date(), statsDeltas: { bucket: 'stats', byPosition: {}, names: { 1: 'e_alice' }, badges: { 1: ['felted'] } } };
        await badgeAwards.awardAndNotify(earning, { users: mockDb.current.users, gameRecords: mockDb.current.gameRecords });
        await badgeAwards.awardAndNotify(earning, { users: mockDb.current.users, gameRecords: mockDb.current.gameRecords }); // a replay: nothing new
        expect(events(w.log, 'badgesAwarded').map((l) => [l.to, l.data.badges.map((x) => x.id)])).toEqual([['self:e-c', ['felted']]]);
        await profileHandlers.getProfile(c, w.io);
        expect(events(w.log, 'profileResponse').pop().data.badges.map((x) => x.id)).toEqual(['felted']);
        await profileHandlers.getPlayerProfile(c, w.io, { username: 'e_vet' });
        expect(events(w.log, 'playerProfileResponse').pop().data.badges).toEqual([]);
        expect(contract.validateS2C('badgesAwarded', { gameId: 'g-now', badges: [] }).ok).toBe(false);
        c.data.client = helloBefore;
        const board = events(w.log, 'leaderboardResponse').pop().data;
        expect(board.leaderboard.map((r) => r.username)).toContain('e_vet');
        expect(contract.validateS2C('leaderboardResponse', { ...board, leaderboard: board.leaderboard.map((r) => ({ ...r, winRate: String(r.winRate) })) }).ok).toBe(false);
        const records = events(w.log, 'recordsResponse').pop().data;
        expect(records).toMatchObject({ success: true, totalGames: 3 });
        expect(records.records.allTime).toMatchObject({ highestScore: { score: 312 }, biggestWin: { margin: 352 }, mostBags: { bags: 3 } });
        expect(records.records.thisMonth).not.toBeNull();
        expect(contract.validateS2C('recordsResponse', { ...records, records: { ...records.records, allTime: { ...records.records.allTime, highestScore: { players: [] } } } }).ok).toBe(false);
        expect(contract.validateS2C('recordsResponse', { ...records, records: { thisMonth: null } }).ok).toBe(false);
        // periodGames (additive 2026-11-14): three non-negative ints, allTime = totalGames
        expect(records.periodGames).toEqual({ allTime: 3, thisYear: expect.any(Number), thisMonth: expect.any(Number) });
        expect(records.periodGames.thisMonth).toBeGreaterThan(0);
        for (const bad of [{ allTime: 3, thisYear: 1 }, { ...records.periodGames, thisMonth: -1 }, { ...records.periodGames, thisYear: '2' }, { ...records.periodGames, today: 1 }, null]) {
            expect(contract.validateS2C('recordsResponse', { ...records, periodGames: bad }).ok).toBe(false);
        }
        // payload-less replies carry no scope (today's shape)
        expect(board.scope).toBeUndefined();
        expect(records.scope).toBeUndefined();

        // Stats scopes (server/utils/statsScope.js): a bot game and a bot-game
        // bucket, read in every scope; the echoed `scope` is validated by the guard
        mockDb.current.users._insert({
            username: 'e_solo', profilePic: 6, customProfilePic: null,
            botStats: { gamesPlayed: 2, wins: 1, losses: 1, draws: 0, totalPoints: 300, totalTricksBid: 12, totalTricksTaken: 13, totalHands: 26,
                totalSets: 1, totalSetPoints: -20, totalFaults: 0, totalHSI: 90 },
        });
        mockDb.current.gameRecords._insert({
            gameId: 'g-bots', withBots: true, team1Score: 410, team2Score: 120, team1Players: ['e_solo'], team2Players: [],
            team1Bots: ['🤖 Mary'], team2Bots: ['🤖 Zach', '🤖 Mike'], team1Bags: 2, team2Bags: 0, completedAt: new Date(),
        });
        profileHandlers.invalidateLeaderboard();
        profileHandlers.invalidateRecords();
        for (const scope of ['bots', 'all', 'human', 'nonsense']) {
            const s = w.socket(`e-scope-${scope}`);
            await profileHandlers.getLeaderboard(s, w.io, { scope });
            await profileHandlers.getRecords(s, w.io, { scope });
            await profileHandlers.getPlayerProfile(s, w.io, { username: 'e_solo', scope });
            const expected = scope === 'nonsense' ? 'human' : scope;
            for (const ev of ['leaderboardResponse', 'recordsResponse', 'playerProfileResponse']) {
                expect({ ev, scope: events(w.log, ev).pop().data.scope }).toEqual({ ev, scope: expected });
            }
        }
        await profileHandlers.getProfile(c, w.io, { scope: 'bots' });
        expect(events(w.log, 'profileResponse').pop().data).toMatchObject({ success: true, scope: 'bots' });
        const botRecords = events(w.log, 'recordsResponse').filter((e) => e.data.scope === 'bots').pop().data;
        expect(botRecords.records.allTime.highestScore).toEqual({ score: 410, players: ['e_solo', '🤖 Mary'] });
        expect(contract.validateS2C('leaderboardResponse', { ...board, scope: 'robots' }).ok).toBe(false);

        // Safety
        await safetyHandlers.reportUser(c, w.io, { username: 'e_bob', reason: 'spam', context: '' });
        await safetyHandlers.reportUser(c, w.io, { username: 'e_alice', reason: 'self' });
        await safetyHandlers.blockUser(c, w.io, { username: 'e_bob' });
        await safetyHandlers.unblockUser(c, w.io, { username: 'e_bob' });
        await safetyHandlers.blockUser(c, w.io, { username: 'e_alice' });

        // Main room and lobbies
        const d = w.user('e-d', 'e_dora');
        const e = w.user('e-e', 'e_eve');
        mainRoomHandlers.joinMainRoom(c, w.io);
        mainRoomHandlers.joinMainRoom(d, w.io);
        mainRoomHandlers.mainRoomChat(d, w.io, { message: 'hello room' });
        ambient.maybePostChat(w.io);
        mainRoomHandlers.createLobby(d, w.io, {});
        const lobbyId = gameManager.getPlayerLobby(d.id).id;
        mainRoomHandlers.joinLobby(e, w.io, { lobbyId });
        mainRoomHandlers.joinLobby(e, w.io, {}); // 'Lobby ID required'
        lobbyHandlers.addBot(d, w.io);
        const botId = gameManager.getPlayerLobby(d.id).players.find((p) => p.isBot).socketId;
        lobbyHandlers.removeBot(d, w.io, { botSocketId: botId });
        lobbyHandlers.lobbyChat(e, w.io, { message: 'yo' });
        // Voice relays between the two lobby members (voiceHandlers only
        // forwards between peers of one lobby or game)
        voiceHandlers.voiceOffer(d, w.io, { targetSocketId: 'e-e', offer: { type: 'offer', sdp: 'v=0' } });
        voiceHandlers.voiceAnswer(e, w.io, { targetSocketId: 'e-d', answer: { type: 'answer', sdp: 'v=0' } });
        voiceHandlers.voiceIceCandidate(e, w.io, { targetSocketId: 'e-d', candidate: { candidate: 'c', sdpMLineIndex: 0, sdpMid: '0' } });
        // ICE servers (no TURN env here: the STUN answer; TURN shape in voiceIceServers.test.js)
        await voiceHandlers.getVoiceIceServers(e, w.io, { requestId: 'ice-1' });
        await voiceHandlers.getVoiceIceServers(e, w.io, undefined);
        lobbyHandlers.leaveLobby(e, w.io);
        lobbyHandlers.leaveLobby(d, w.io);
        lobbyHandlers.leaveLobby(d, w.io); // not in a lobby: error

        // Wrapper errors: rate limit and validation
        const r = w.socket('e-r');
        const signIn = asyncHandler('signIn', authHandlers.signIn);
        for (let i = 0; i < 6; i++) await signIn(r, w.io, { username: 'e_none', password: 'x' });
        await asyncHandler('playerBid', gameHandlers.playerBid)(r, w.io, { bid: 'X' });
        syncHandler('chatMessage', mainRoomHandlers.mainRoomChat)(r, w.io, { message: 'not in room' });
        const errs = events(w.log, 'serverError').map((l) => l.data.code);
        expect(errs).toEqual(expect.arrayContaining(['rateLimit', 'validation']));
        rateLimiter.clearSocket('e-r');

        // Account deletion, and the last socket of a user going away
        await authHandlers.deleteAccount(c, w.io, { password: 'wrong' });
        await authHandlers.deleteAccount(c, w.io, { password: 'pw2-longer' });
        const online = gameManager.getOnlineUsernames().length;
        // Only d's own: the device kicks above (b by a's password sign-in, c's
        // restore) already sent e_alice's (onlinePresence)
        const fromKill = w.log.length;
        await w.kill(d);
        const left = events(w.log.slice(fromKill), 'mainRoomPlayerLeft');
        expect(left).toHaveLength(1);
        expect(left[0]).toMatchObject({ to: 'mainRoom', data: { username: 'e_dora', onlineCount: online - 1 } });
        expect(left[0].data.onlineUsers).not.toContain('e_dora');
        await w.kill(e);
        expect(errorLogs.filter((x) => !/Failed|failed|Error/.test(String(x.msg)))).toEqual([]);
    }, 30000);
});

describe('(e) auth responses that drive auto-rejoin', () => {
    test('signIn / restoreSession with a live activeGameId, then with a live activeTournamentId', async () => {
        jest.useRealTimers();
        const w = world('e2');
        const a = w.socket('e2-a');
        await authHandlers.signUp(a, w.io, { username: 'e2_ann', password: 'pw1-long' });
        const token = events(w.log, 'signUpResponse').pop().data.sessionToken;
        const users = mockDb.current.users;
        const doc = () => users.docs.find((d) => d.username === 'e2_ann');

        // A live game the user is recorded in
        const game = gameManager.createGame(['e2-x1', 'e2-x2', 'e2-x3', 'e2-x4']);
        doc().activeGameId = game.gameId;
        const b = w.socket('e2-b');
        await authHandlers.signIn(b, w.io, { username: 'e2_ann', password: 'pw1-long' });
        const c = w.socket('e2-c');
        await authHandlers.restoreSession(c, w.io, { username: 'e2_ann', sessionToken: token });
        const signIn1 = events(w.log, 'signInResponse').pop().data;
        const restore1 = events(w.log, 'restoreSessionResponse').pop().data;
        expect(signIn1).toMatchObject({ success: true, activeGameId: game.gameId });
        expect(restore1).toMatchObject({ success: true, activeGameId: game.gameId });
        expect('activeTournamentId' in signIn1 || 'activeTournamentId' in restore1).toBe(false);

        // The game is gone; a live tournament the user is in
        gameManager.abortGame(game.gameId);
        // (created by another player: the sign-ins below kick e2_ann's older sockets)
        const host = w.user('e2-host', 'e2_host');
        tournamentHandlers.createTournament(host, w.io);
        const tid = gameManager.playerTournaments.get(host.id);
        expect(tid).toBeTruthy();
        doc().activeTournamentId = tid;
        const d = w.socket('e2-d');
        await authHandlers.signIn(d, w.io, { username: 'e2_ann', password: 'pw1-long' });
        const e = w.socket('e2-e');
        await authHandlers.restoreSession(e, w.io, { username: 'e2_ann', sessionToken: token });
        const signIn2 = events(w.log, 'signInResponse').pop().data;
        const restore2 = events(w.log, 'restoreSessionResponse').pop().data;
        expect(signIn2).toMatchObject({ success: true, activeTournamentId: tid });
        expect(restore2).toMatchObject({ success: true, activeTournamentId: tid });
        expect('activeGameId' in signIn2 || 'activeGameId' in restore2).toBe(false);

        // The guard validated them; a type change would not pass
        for (const [ev, data] of [['signInResponse', signIn1], ['restoreSessionResponse', restore1]]) {
            expect(contract.validateS2C(ev, data).ok).toBe(true);
            expect(contract.validateS2C(ev, { ...data, activeGameId: 42 }).ok).toBe(false);
        }
        for (const [ev, data] of [['signInResponse', signIn2], ['restoreSessionResponse', restore2]]) {
            expect(contract.validateS2C(ev, { ...data, activeTournamentId: 42 }).ok).toBe(false);
        }
        expect(errorLogs).toEqual([]);
    });
});

describe('(e) failure variants and rarely reached emit sites', () => {
    test('profile / leaderboard / records failures, an unexpected handler error, a lobby member dropping', async () => {
        jest.useRealTimers();
        const w = world('e3');
        // Profile: a socket with no signed-in user
        await profileHandlers.getProfile(w.socket('e3-anon'), w.io);
        expect(events(w.log, 'profileResponse').pop().data).toEqual({ success: false, message: 'User not found' });
        // Leaderboard: the DB query throws
        const u = w.user('e3-u', 'e3_una');
        const find = mockDb.current.users.find;
        mockDb.current.users.find = () => { throw new Error('db down'); };
        await profileHandlers.getLeaderboard(u, w.io);
        mockDb.current.users.find = find;
        expect(events(w.log, 'leaderboardResponse').pop().data).toEqual({ success: false, message: 'Database error' });
        // Records: no gameRecords collection
        const records = mockDb.current.gameRecords;
        mockDb.current.gameRecords = null;
        await profileHandlers.getRecords(u, w.io);
        mockDb.current.gameRecords = records;
        expect(events(w.log, 'recordsResponse').pop().data).toEqual({ success: false, message: 'Database not available' });

        // A handler throwing something unexpected: serverError {code:'server', handler}
        await asyncHandler('searchPlayers', async () => { throw new Error('boom'); })(u, w.io, { query: 'x' });
        expect(events(w.log, 'serverError').pop()).toMatchObject({
            to: `self:${u.id}`, data: { code: 'server', message: 'An error occurred processing your request', handler: 'searchPlayers' },
        });
        expect(contract.validateS2C('serverError', { code: 'server', message: 'm', handlr: 'searchPlayers' }).ok).toBe(false);
        // #1 phase B: the app-level error event is gone from the contract
        expect(contract.validateS2C('error', { message: 'm' }).ok).toBe(false);
        rateLimiter.clearSocket(u.id);

        // A lobby member drops while others are still in the lobby:
        // voicePeerLeft to each remaining human (queueHandlers.handleDisconnect)
        const a = w.user('e3-a', 'e3_amy');
        const b = w.user('e3-b', 'e3_ben');
        mainRoomHandlers.createLobby(a, w.io, {});
        mainRoomHandlers.joinLobby(b, w.io, { lobbyId: gameManager.getPlayerLobby(a.id).id });
        lobbyHandlers.addBot(a, w.io);
        const mark = w.log.length;
        await w.kill(b);
        const left = w.log.slice(mark).filter((l) => l.event === 'voicePeerLeft');
        expect(left).toEqual([expect.objectContaining({ to: a.id, data: { socketId: b.id } })]);
        expect(contract.validateS2C('voicePeerLeft', { socketID: b.id }).ok).toBe(false);
        expect(errorLogs.map((x) => x.msg)).toEqual(['Error fetching leaderboard', 'boom']);
    });
});

// ==================== (e2) admin panel ====================

describe('(e2) admin panel', () => {
    test('every adminResponse variant, and isAdmin on the sign-in replies', async () => {
        // the blocker (adm_bea, signed out by then: adm_owner's live socket stands in) gets the unasked blockListUpdated
        const users_block = async (users) => {
            await users.updateOne({ username: 'adm_owner' }, { $set: { blockedUsers: ['adm_cy'] } });
        };
        jest.useRealTimers();
        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash('pw', 4);
        const w = world('adm');
        mockDb.current.users._insert({ username: 'adm_owner', password: hash, isAdmin: true });
        mockDb.current.users._insert({ username: 'adm_bea', password: hash, stats: { gamesPlayed: 2 } });
        mockDb.current.users._insert({ username: 'adm_bea2', password: hash, stats: { gamesPlayed: 1 } });
        mockDb.current.users._insert({ username: 'adm_old', mergedInto: 'adm_bea' });
        const signIn = async (id, username) => {
            const s = w.socket(id);
            await authHandlers.signIn(s, w.io, { username, password: 'pw' });
            return s;
        };
        const owner = await signIn('adm-o', 'adm_owner');
        const signedIn = w.log.filter((l) => l.event === 'signInResponse' && l.to === 'self:adm-o').pop().data;
        expect(signedIn.isAdmin).toBe(true);
        const restorer = w.socket('adm-r');
        await authHandlers.restoreSession(restorer, w.io, { username: 'adm_owner', sessionToken: signedIn.sessionToken });
        expect(w.log.filter((l) => l.event === 'restoreSessionResponse').pop().data.isAdmin).toBe(true);
        const bea = await signIn('adm-b', 'adm_bea');

        let rid = 0;
        const req = async (s, action, args) => {
            const requestId = `c-${++rid}`;
            await asyncHandler('adminRequest', adminHandlers.adminRequest)(s, w.io, { requestId, action, args });
            return w.log.filter((l) => l.event === 'adminResponse' && l.data.requestId === requestId).pop().data;
        };
        expect((await req(bea, 'listAdmins', {})).error).toBe('forbidden');
        expect((await req(restorer, 'searchPlayers', { query: 'adm' })).players.length).toBe(4);
        expect(await req(restorer, 'listPlayers', {})).toMatchObject({ ok: true, total: 4, limit: 500 });
        expect((await req(restorer, 'createResetLink', { username: 'adm_bea' })).ok).toBe(true);
        expect((await req(restorer, 'signOutEverywhere', { username: 'adm_bea' })).disconnected).toBe(1);
        expect((await req(restorer, 'findDuplicates', {})).groups.length).toBe(1);
        mockDb.current.gameRecords._insert({ gameId: 'adm-g', team1Players: ['adm_bea2', 'x'], team2Players: ['y', 'z'], completedAt: new Date() });
        mockDb.current.reports._insert({ reporter: 'adm_bea2', reported: 'adm_owner', reason: 'r', createdAt: new Date() });
        const prev = await req(restorer, 'planMerge', { target: 'adm_bea', sources: ['adm_bea2'] });
        expect(prev.plan.changeCount).toBeGreaterThan(0);
        expect((await req(restorer, 'applyMerge', { target: 'adm_bea', sources: ['adm_bea2'], planHash: prev.planHash, confirm: 'adm_bea' })).ok).toBe(true);
        const reports = (await req(restorer, 'listReports', { status: 'all' })).reports;
        expect((await req(restorer, 'resolveReport', { id: reports[0].id, status: 'dismissed', note: 'ok' })).report.status).toBe('dismissed');
        expect((await req(restorer, 'setAdmin', { username: 'adm_bea', isAdmin: true })).changed).toBe(true);
        expect((await req(restorer, 'listAdmins', {})).admins.length).toBe(2);
        expect((await req(restorer, 'listAudit', {})).entries.length).toBeGreaterThan(5);
        expect((await req(restorer, 'setAdmin', { username: 'adm_old', isAdmin: true })).error).toBe('refused');
        expect(await req(restorer, 'deleteAccount', { username: 'adm_old', confirm: 'adm_old' })).toMatchObject({ ok: true, kind: 'tombstone' });
        mockDb.current.users._insert({ username: 'adm_cy', password: hash, blockedUsers: [] });
        await users_block(mockDb.current.users);
        expect(await req(restorer, 'deleteAccount', { username: 'adm_cy', confirm: 'adm_cy' })).toMatchObject({ ok: true, kind: 'account', blockLists: 1 });
        expect(await req(restorer, 'renameAccount', { username: 'adm_bea', newName: 'adm_bee', confirm: 'adm_bee' })).toMatchObject({ ok: true, newName: 'adm_bee', oldNameKept: true });
        const tomb = (await req(restorer, 'listPlayers', {})).players.find((p) => p.username === 'adm_bea');
        expect(tomb).toMatchObject({ mergedInto: 'adm_bee', renamed: true });
        const signInOld = w.socket('adm-old');
        await authHandlers.signIn(signInOld, w.io, { username: 'adm_bea', password: 'pw' });
        expect(w.log.filter((l) => l.event === 'signInResponse' && l.to === 'self:adm-old').pop().data).toEqual({ success: false, message: 'This account is now called adm_bee. Sign in as adm_bee.' });
        void owner;
    });
});

// ==================== upgrade gate ====================

describe('upgrade gate', () => {
    /** A stub socket with an iOS User-Agent through the gate (BAB_MIN_IOS_BUILD for the call). */
    const gated = (build, minBuild) => {
        const gate = require('../upgradeGate');
        const { makeSocket } = require('../../testUtils/gameDriver');
        const log = [];
        const socket = makeSocket(`gated-${build}`, log);
        socket.handshake = { headers: { 'user-agent': `BAB%20Online/${build} CFNetwork/3896.200.61 Darwin/27.2.0` } };
        const handlers = new Map();
        socket.on = (ev, fn) => handlers.set(ev, fn);
        const prev = process.env.BAB_MIN_IOS_BUILD;
        if (minBuild) process.env.BAB_MIN_IOS_BUILD = String(minBuild);
        try {
            expect(gate.gate(socket)).toBe(true);
        } finally {
            if (prev === undefined) delete process.env.BAB_MIN_IOS_BUILD; else process.env.BAB_MIN_IOS_BUILD = prev;
        }
        return { gate, log, handlers };
    };

    test('a gated iOS 1.2.6 (40) socket (MIN_IOS_BUILD 41) gets the update toast with the main push and the Account sheet refusals', () => {
        const { gate, log, handlers } = gated(40);
        jest.advanceTimersByTime(2100);
        expect(events(log, 'serverError').map((l) => l.data)).toEqual([{ code: 'rejected', message: gate.UPDATE_MESSAGE_SIGNED_OUT, handler: null }]);
        expect(events(log, 'updateRequired')).toEqual([]);
        handlers.get('deleteAccount')({ password: 'pw' });
        handlers.get('changePassword')({});
        expect(events(log, 'deleteAccountResponse').map((l) => l.data)).toEqual([{ success: false, message: gate.UPDATE_MESSAGE_SIGNED_OUT }]);
        expect(events(log, 'changePasswordResponse').map((l) => l.data)).toEqual([{ success: false, message: gate.UPDATE_MESSAGE_SIGNED_OUT }]);
        handlers.get('disconnect')();
    });

    test('a gated build 41 (BAB_MIN_IOS_BUILD 42) gets updateRequired with the main push, never the toast', () => {
        const { gate, log, handlers } = gated(41, 42);
        jest.advanceTimersByTime(2100);
        const update = events(log, 'updateRequired');
        expect(update).toHaveLength(1);
        expect(update[0].data).toEqual({ message: gate.UPDATE_MESSAGE_SIGNED_OUT, url: gate.APP_STORE_URL });
        expect(events(log, 'serverError')).toEqual([]);
        handlers.get('disconnect')();
    });
});

// ==================== coverage ====================

describe('coverage', () => {
    test('every active / deprecated s2c event was observed (or is NOT_EXERCISED with a reason)', () => {
        const observed = contractCheck.observed();
        const missing = [];
        const stale = [];
        for (const name of contract.s2cNames()) {
            const { status } = contract.schema.s2c[name];
            if (status !== 'active' && status !== 'deprecated') continue;
            if (observed.has(name)) {
                if (NOT_EXERCISED[name]) stale.push(name);
            } else if (!NOT_EXERCISED[name]) {
                missing.push(name);
            }
        }
        expect({ missing, stale }).toEqual({ missing: [], stale: [] });
        expect([...contractCheck.unknownEvents()]).toEqual([]);
    });

    test('every variant of an active / deprecated s2c event was observed (or is NOT_EXERCISED_VARIANTS with a reason)', () => {
        const missing = [];
        const stale = [];
        for (const key of contract.s2cVariants()) {
            const [event] = key.split('#');
            const { status } = contract.schema.s2c[event];
            if (status !== 'active' && status !== 'deprecated') continue;
            if (NOT_EXERCISED[event]) continue; // the whole event is unreached
            if (observedVariants.has(key)) {
                if (NOT_EXERCISED_VARIANTS[key]) stale.push(key);
            } else if (!NOT_EXERCISED_VARIANTS[key]) {
                missing.push(key);
            }
        }
        expect({ missing, stale }).toEqual({ missing: [], stale: [] });
    });
});

describe('test files named in this file exist', () => {
    it('every *.test.js it points a reader to is in server/socket/__tests__', () => {
        const src = fs.readFileSync(__filename, 'utf8');
        const named = [...new Set(src.match(/\b[A-Za-z][\w-]*\.test\.js\b/g) || [])];
        const missing = named.filter((n) => !fs.existsSync(path.join(__dirname, n)));
        expect(missing).toEqual([]);
    });
});
