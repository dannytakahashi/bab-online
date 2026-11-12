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
    setupTournament, playTournament, liveTables, advanceUntil, newUser, creatorSocket,
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
    'error#validation': 'dead: only validators.withValidation emits it, and nothing calls withValidation (the wrappers send error#handler)',
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
            const m = new RegExp(`socket\\.on\\('${name}',[^\\n]*\\n\\s*(asyncHandler|syncHandler|safeHandler)\\((?:'([a-zA-Z]+)')?`).exec(indexSrc);
            expect({ name, registered: !!m }).toEqual({ name, registered: true });
            const key = m[2] || null;
            expect({ name, joi: entry.joi }).toEqual({ name, joi: key && validators.schemas[key] ? key : null });
            expect({ name, rateLimit: entry.rateLimit }).toEqual({ name, rateLimit: key && rateLimiter.limits[key] ? key : null });
        }
    });

    test('every documented client payload passes the schema and, where wrapped, Joi', () => {
        for (const name of contract.c2sNames()) {
            const entry = contract.schema.c2s[name];
            expect(Array.isArray(entry.examples) && entry.examples.length > 0).toBe(true);
            for (const ex of entry.examples) {
                expect({ name, ex, ...contract.validateC2S(name, ex) }).toMatchObject({ name, ok: true });
                if (entry.joi) expect(() => validators.validate(entry.joi, ex)).not.toThrow();
            }
            if (entry.optionalPayload) expect(contract.validateC2S(name, undefined).ok).toBe(true);
        }
    });

    test('every documented rejected payload fails BOTH the schema and Joi (the schema never admits what Joi refuses)', () => {
        let n = 0;
        for (const name of contract.c2sNames()) {
            const entry = contract.schema.c2s[name];
            for (const bad of entry.invalid || []) {
                n++;
                expect({ name, bad, schemaOk: contract.validateC2S(name, bad).ok }).toEqual({ name, bad, schemaOk: false });
                expect(entry.joi).not.toBeNull();
                expect(() => validators.validate(entry.joi, bad)).toThrow();
            }
        }
        // Every Joi-wrapped event with a payload has negative examples
        const withPayload = contract.c2sNames().filter((n2) => {
            const e = contract.schema.c2s[n2];
            return e.joi && Object.keys(e.payload?.properties || {}).length > 0;
        });
        expect(withPayload.filter((n2) => !(contract.schema.c2s[n2].invalid || []).length)).toEqual([]);
        expect(n).toBeGreaterThan(50);
        // Both clients always send position with bids and plays (Joi requires it)
        expect(contract.schema.c2s.playerBid.payload.required).toEqual(expect.arrayContaining(['bid', 'position']));
        expect(contract.schema.c2s.playCard.payload.required).toEqual(expect.arrayContaining(['card', 'position']));
    });

    test('the c2s events without a Joi schema are a frozen list (hardening is a separate item)', () => {
        const noJoi = contract.c2sNames().filter((n) => contract.schema.c2s[n].joi === null &&
            contract.schema.c2s[n].payload && Object.keys(contract.schema.c2s[n].payload.properties || {}).length > 0);
        expect(noJoi.sort()).toEqual(['getPlayerProfile', 'joinLobby', 'removeBot', 'searchPlayers',
            'voiceAnswer', 'voiceIceCandidate', 'voiceOffer', 'voiceRelayAudio'].sort());
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
        expect(mine[1]).toMatchObject({ event: 'error', data: { type: 'validation', handler: 'requestSnapshot' } });
        expect(mine.filter((l) => l.event === 'error' && l.data.type === 'rateLimit')).toHaveLength(2);
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

    test('spectating during the draw, then a cancel', async () => {
        Math.random = mulberry32(6);
        const ctx = await setupTournament(2);
        const watcher = newUser(ctx.io, ctx.log, 'f3_drawwatch');
        tournamentHandlers.tournamentChat(ctx.sockets[1], ctx.io, { message: 'hi' });
        tournamentHandlers.tournamentUnready(ctx.sockets[1], ctx.io);
        tournamentHandlers.tournamentReady(ctx.sockets[1], ctx.io);
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

// ==================== (e) non-game handlers ====================

describe('(e) non-game handlers', () => {
    test('auth, profile, safety, main room, lobby, queue, voice, errors', async () => {
        jest.useRealTimers();
        const w = world('e');
        const a = w.socket('e-a');
        await authHandlers.signUp(a, w.io, { username: 'e_alice', password: 'pw1' });
        await authHandlers.signUp(a, w.io, { username: 'e_alice', password: 'pw1' }); // taken
        const b = w.socket('e-b');
        await authHandlers.signIn(b, w.io, { username: 'e_alice', password: 'nope' });
        await authHandlers.signIn(b, w.io, { username: 'e_alice', password: 'pw1' }); // kicks a: forceLogout
        expect(selfEvents(w, 'e-a')).toContain('forceLogout');
        const token = w.log.filter((l) => l.event === 'signInResponse' && l.data.success).pop().data.sessionToken;
        const c = w.socket('e-c');
        await authHandlers.restoreSession(c, w.io, { username: 'e_alice', sessionToken: token });
        await authHandlers.restoreSession(c, w.io, { username: 'e_nobody', sessionToken: token });

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
        await profileHandlers.getPlayerProfile(c, w.io, { username: 'e_alice' });
        await profileHandlers.getPlayerProfile(c, w.io, { username: 'e_ghost' });
        await profileHandlers.getPlayerProfile(c, w.io, { username: 'e_vet' });
        const board = events(w.log, 'leaderboardResponse').pop().data;
        expect(board.leaderboard.map((r) => r.username)).toContain('e_vet');
        expect(contract.validateS2C('leaderboardResponse', { ...board, leaderboard: board.leaderboard.map((r) => ({ ...r, winRate: String(r.winRate) })) }).ok).toBe(false);
        const records = events(w.log, 'recordsResponse').pop().data;
        expect(records).toMatchObject({ success: true, totalGames: 3 });
        expect(records.records.allTime).toMatchObject({ highestScore: { score: 312 }, biggestWin: { margin: 352 }, mostBags: { bags: 3 } });
        expect(records.records.thisMonth).not.toBeNull();
        expect(contract.validateS2C('recordsResponse', { ...records, records: { ...records.records, allTime: { ...records.records.allTime, highestScore: { players: [] } } } }).ok).toBe(false);
        expect(contract.validateS2C('recordsResponse', { ...records, records: { thisMonth: null } }).ok).toBe(false);

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
        voiceHandlers.voiceRelayAudio(e, w.io, { targetSocketId: 'e-d', audio: Buffer.alloc(1364) });
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
        const errs = events(w.log, 'error').map((l) => l.data.type);
        expect(errs).toEqual(expect.arrayContaining(['rateLimit', 'validation']));
        rateLimiter.clearSocket('e-r');

        // Account deletion, and the last socket of a user going away
        await authHandlers.deleteAccount(c, w.io, { password: 'wrong' });
        await authHandlers.deleteAccount(c, w.io, { password: 'pw1' });
        const online = gameManager.getOnlineUsernames().length;
        await w.kill(d);
        const left = events(w.log, 'mainRoomPlayerLeft');
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
        await authHandlers.signUp(a, w.io, { username: 'e2_ann', password: 'pw1' });
        const token = events(w.log, 'signUpResponse').pop().data.sessionToken;
        const users = mockDb.current.users;
        const doc = () => users.docs.find((d) => d.username === 'e2_ann');

        // A live game the user is recorded in
        const game = gameManager.createGame(['e2-x1', 'e2-x2', 'e2-x3', 'e2-x4']);
        doc().activeGameId = game.gameId;
        const b = w.socket('e2-b');
        await authHandlers.signIn(b, w.io, { username: 'e2_ann', password: 'pw1' });
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
        await authHandlers.signIn(d, w.io, { username: 'e2_ann', password: 'pw1' });
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

        // A handler throwing something unexpected: error {type:'server', handler}
        await asyncHandler('searchPlayers', async () => { throw new Error('boom'); })(u, w.io, { query: 'x' });
        expect(events(w.log, 'error').pop()).toMatchObject({
            to: `self:${u.id}`, data: { type: 'server', message: 'An error occurred processing your request', handler: 'searchPlayers' },
        });
        expect(contract.validateS2C('error', { type: 'server', message: 'm', handlr: 'searchPlayers' }).ok).toBe(false);
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
