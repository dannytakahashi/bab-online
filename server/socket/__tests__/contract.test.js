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
}));

const contract = require('../../../contract');
const contractCheck = require('../../testUtils/contractCheck');
const validators = require('../validators');
const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const authHandlers = require('../authHandlers');
const profileHandlers = require('../profileHandlers');
const safetyHandlers = require('../safetyHandlers');
const voiceHandlers = require('../voiceHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const { watchSeq } = require('../../testUtils/seqCheck');
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

beforeAll(() => contractCheck.resetObserved());
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

    test('the c2s events without a Joi schema are a frozen list (hardening is a separate item)', () => {
        const noJoi = contract.c2sNames().filter((n) => contract.schema.c2s[n].joi === null &&
            contract.schema.c2s[n].payload && Object.keys(contract.schema.c2s[n].payload.properties || {}).length > 0);
        expect(noJoi.sort()).toEqual(['getPlayerProfile', 'joinLobby', 'removeBot', 'searchPlayers',
            'voiceAnswer', 'voiceIceCandidate', 'voiceOffer', 'voiceRelayAudio'].sort());
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
        const bySelf = (e) => events(w.log, e).filter((l) => l.to.startsWith('self:'));
        expect(bySelf('rejoinSuccess').length).toBeGreaterThanOrEqual(4);
        const chats = events(w.log, 'chatMessage').map((l) => l.data);
        expect(chats.some((d) => d.username.startsWith('🤖') && d.isSpectator === false && d.type === 'player')).toBe(true); // bot chat
        expect(chats.some((d) => d.isSpectator === true && d.type === 'spectator')).toBe(true);
        expect(chats.every((d) => d.type === (d.isSpectator ? 'spectator' : 'player'))).toBe(true);
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
        mainRoomHandlers.getLobbies(d, w.io);
        mainRoomHandlers.createLobby(d, w.io, {});
        const lobbyId = gameManager.getPlayerLobby(d.id).id;
        mainRoomHandlers.joinLobby(e, w.io, { lobbyId });
        mainRoomHandlers.joinLobby(e, w.io, {}); // 'Lobby ID required'
        lobbyHandlers.addBot(d, w.io);
        const botId = gameManager.getPlayerLobby(d.id).players.find((p) => p.isBot).socketId;
        lobbyHandlers.removeBot(d, w.io, { botSocketId: botId });
        lobbyHandlers.lobbyChat(e, w.io, { message: 'yo' });
        lobbyHandlers.leaveLobby(e, w.io);
        lobbyHandlers.leaveLobby(d, w.io);
        lobbyHandlers.leaveLobby(d, w.io); // not in a lobby: error

        // Queue (handled, no client sends it)
        const q = w.user('e-q', 'e_quinn');
        const q2 = w.user('e-q2', 'e_quill');
        await queueHandlers.joinQueue(q, w.io);
        await queueHandlers.joinQueue(q2, w.io);
        gameManager.queue.push(q.id);
        gameManager.queuedUsers.push({ socketId: q.id, username: 'e_quinn' });
        queueHandlers.leaveQueue(q, w.io);

        // Voice relays
        voiceHandlers.voiceOffer(d, w.io, { targetSocketId: 'e-e', offer: { type: 'offer', sdp: 'v=0' } });
        voiceHandlers.voiceAnswer(e, w.io, { targetSocketId: 'e-d', answer: { type: 'answer', sdp: 'v=0' } });
        voiceHandlers.voiceIceCandidate(e, w.io, { targetSocketId: 'e-d', candidate: { candidate: 'c', sdpMLineIndex: 0, sdpMid: '0' } });
        voiceHandlers.voiceRelayAudio(e, w.io, { targetSocketId: 'e-d', audio: 'AAAA' });

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
});
