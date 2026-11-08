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
const { asyncHandler, syncHandler, rateLimiter } = require('../errorHandler');
const ambient = require('../../demo/ambientBots');
const Deck = require('../../game/Deck');
const { Phase } = require('../../game/GamePhase');
const { botController } = require('../../game/bot');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { makeIo, makeSocket, events, legalCards, legalBids, mulberry32 } = require('../../testUtils/gameDriver');
const {
    setupTournament, playTournament, liveTables, advanceUntil, newUser, creatorSocket,
} = require('../../testUtils/tournamentDriver');

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

/** A stub world: emit log, io, sockets by id, registered users. */
function world(tag) {
    const log = [];
    const io = makeIo(log);
    const sockets = new Map();
    const w = {
        log, io, sockets, pending: [],
        socket(id) {
            const s = makeSocket(id, log, io);
            // authHandlers.disconnectPreviousSocket calls socket.disconnect()
            s.disconnect = () => w.kill(s);
            sockets.set(id, s);
            return s;
        },
        user(id, username, { pic = 7, db = true } = {}) {
            gameManager.registerUser(id, username);
            if (db && !mockDb.current.users.docs.some((d) => d.username === username)) {
                mockDb.current.users._insert({ username, profilePic: pic });
            }
            return w.socket(id);
        },
        kill(s) {
            io.sockets.sockets.delete(s.id);
            for (const members of io.rooms.values()) members.delete(s.id);
            return queueHandlers.handleDisconnect(s, io);
        },
        tag,
    };
    return w;
}

const tick = () => jest.advanceTimersByTimeAsync(0);
const selfEvents = (w, sid, from = 0) => w.log.slice(from).filter((l) => l.to === `self:${sid}`).map((l) => l.event);

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

/** Where nothing more may be emitted for `game` once it ended. */
function expectSilentAfterTerminal(w, game) {
    const idx = w.log.findIndex((l) => l.to === game.roomName && (l.event === 'gameEnd' || l.event === 'abortGame'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(w.log.slice(idx + 1).filter((l) => l.to === game.roomName).map((l) => l.event)).toEqual([]);
}

/** Card that is not in `hand` (any of the 54). */
function cardNotIn(hand) {
    const deck = new Deck();
    return deck.cards.find((c) => !hand.some((h) => h.suit === c.suit && h.rank === c.rank));
}

async function playF1() {
    Math.random = mulberry32(8);
    const w = world('f1');
    const names = ['f1_ann', 'f1_bob', 'f1_cat', 'f1_dan'];
    const socks = names.map((n, i) => w.user(`f1-h${i}`, n));
    const owner = (game, pos) => w.sockets.get(game.seat(pos).ownerSocketId);
    let rejoins = 0;
    const rejoinAs = async (game, username, label) => {
        rejoins++;
        const s = w.user(`f1-${label}-${rejoins}`, username, { db: false });
        await reconnectHandlers.rejoinGame(s, w.io, { gameId: game.gameId, username });
        return s;
    };

    // Lobby
    for (const s of socks) mainRoomHandlers.joinMainRoom(s, w.io);
    mainRoomHandlers.createLobby(socks[0], w.io, { name: 'Contract table' });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    lobbyHandlers.lobbyChat(socks[1], w.io, { message: 'ready when you are' });
    await lobbyHandlers.playerReady(socks[3], w.io);
    lobbyHandlers.playerUnready(socks[3], w.io);
    const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    await jest.advanceTimersByTimeAsync(1500);
    const game = gameManager.getPlayerGame(socks[0].id);
    expect(game.stage).toBe(Phase.CREATED);
    await jest.advanceTimersByTimeAsync(2000);
    expect(game.stage).toBe(Phase.DRAWING);

    // A rejoin during the draw is refused (pinned: §8, items 16/23)
    const early = await rejoinAs(game, names[0], 'draw');
    expect(selfEvents(w, early.id)).toEqual(['rejoinFailed']);
    expect(w.log.find((l) => l.to === `self:${early.id}`).data.reason).toBe('Not a player in this game');

    for (const s of socks) w.pending.push(gameHandlers.draw(s, w.io, { num: 0 }));
    await advanceUntil(() => game.stage === Phase.TEAMS_ANNOUNCED, 50);

    // A rejoin during TEAMS_ANNOUNCED is accepted today (renders as a
    // half-state on v1 clients); the payload must still validate
    const firstPos = game.seatByUsername(names[0]);
    const r0 = await rejoinAs(game, names[0], 'teams');
    expect(game.seat(firstPos).ownerSocketId).toBe(r0.id);
    await advanceUntil(() => game.stage === Phase.BIDDING, 50);

    const done = {};
    let spectator = null;
    let bored = false;
    let zeroBids = 0;
    let guard = 0;
    while (!game.isTerminal() && guard++ < 20000) {
        const hands = game.handStats.totalHands;
        const stage = game.stage;

        if (hands === 1 && stage === Phase.BIDDING && !done.lazyActive) {
            done.lazyActive = true;
            const s = owner(game, 1);
            chatHandlers.chatMessage(s, w.io, { message: '/lazy' });
            chatHandlers.chatMessage(s, w.io, { message: '/lazy' }); // 'Already in lazy mode' error
            chatHandlers.chatMessage(s, w.io, { message: '/active' });
            chatHandlers.chatMessage(s, w.io, { message: '/bogus' });
            chatHandlers.chatMessage(s, w.io, { message: 'nice hand' });
        }
        if (hands === 2 && stage === Phase.BIDDING && !done.lazyWatch) {
            done.lazyWatch = true;
            const pos = 2;
            const username = game.seat(pos).ownerUsername;
            chatHandlers.chatMessage(owner(game, pos), w.io, { message: '/lazy' });
            const back = await rejoinAs(game, username, 'watch');
            expect(selfEvents(w, back.id)[0]).toBe('rejoinSuccess');
            await reconnectHandlers.rejoinGame(back, w.io, { gameId: game.gameId, username }); // idempotent
            chatHandlers.chatMessage(back, w.io, { message: '/active' });
            expect(game.seat(pos).controller).toBe('human');
        }
        if (hands === 3 && stage === Phase.PLAYING && !done.rejects) {
            const seat = game.seat(game.currentTurn);
            if (seat.controller === 'human' && seat.presence === 'connected') {
                const s = owner(game, seat.position);
                const hand = game.getHand(s.id);
                const mark = w.log.length;
                await gameHandlers.playCard(s, w.io, { card: cardNotIn(hand) });
                expect(selfEvents(w, s.id, mark)).toEqual(['actionRejected', 'restorePlayerState']);
                const legal = legalCards(game, s.id);
                const illegal = hand.find((c) => !legal.some((l) => l.suit === c.suit && l.rank === c.rank));
                if (illegal) {
                    await gameHandlers.playCard(s, w.io, { card: illegal });
                    done.rejects = true;
                }
                await gameHandlers.playerBid(s, w.io, { bid: '1' }); // not_your_turn (wrong stage)
            }
        }
        if (hands === 4 && stage === Phase.BIDDING && !done.resign) {
            done.resign = true;
            const pos = 3;
            const username = game.seat(pos).ownerUsername;
            await w.kill(owner(game, pos));
            await gameHandlers.forceResign(owner(game, 4), w.io, { position: pos }); // still in grace: error
            await jest.advanceTimersByTimeAsync(61000);
            expect(game.seat(pos).presence).toBe('resignable');
            // A returning socket of another seat gets the offer replayed privately
            const p4name = game.seat(4).ownerUsername;
            await rejoinAs(game, p4name, 'replay');
            await gameHandlers.forceResign(owner(game, 4), w.io, { position: pos });
            expect(game.seat(pos).controller).toBe('resignBot');
            const bot = game.seat(pos).bot;
            botController.sendBotChat(w.io, game, botController.getBot(game.gameId, bot.socketId), 'gg', 0);
            await rejoinAs(game, username, 'resigned');
            expect(game.seat(pos).ownerView).toBe('watch');
        }
        if (hands === 5 && stage === Phase.BIDDING && !spectator) {
            spectator = w.user('f1-spec', 'f1_fan');
            mainRoomHandlers.joinMainRoom(spectator, w.io);
            mainRoomHandlers.joinAsSpectator(spectator, w.io, { gameId: game.gameId });
            chatHandlers.chatMessage(spectator, w.io, { message: 'go team' });
            chatHandlers.chatMessage(spectator, w.io, { message: '/active' }); // an ordinary spectator: ignored
        }
        if (hands === 7 && stage === Phase.BIDDING && !done.leave) {
            done.leave = true;
            // The resigned owner (watch view) leaves for good; so does the spectator
            chatHandlers.chatMessage(owner(game, 3), w.io, { message: '/leave' });
            chatHandlers.chatMessage(spectator, w.io, { message: '/leave' });
        }

        if (stage === Phase.BIDDING || stage === Phase.PLAYING) {
            const seat = game.seat(game.currentTurn);
            if (seat.controller === 'human' && seat.presence === 'connected') {
                const s = owner(game, seat.position);
                if (stage === Phase.BIDDING) {
                    let bid;
                    if (zeroBids < 4) { bid = '0'; zeroBids++; }
                    else if (!bored && hands >= 1 && legalBids(game).includes('B')) { bid = 'B'; bored = true; }
                    else bid = legalBids(game).includes('1') ? '1' : '0';
                    w.pending.push(gameHandlers.playerBid(s, w.io, { bid }));
                } else {
                    const [card] = legalCards(game, s.id);
                    w.pending.push(gameHandlers.playCard(s, w.io, { card }));
                }
                await tick();
                continue;
            }
        }
        await jest.advanceTimersByTimeAsync(250);
    }
    if (game.stage !== Phase.ENDED) {
        throw new Error('F1 did not finish: ' + JSON.stringify({ stage: game.stage, hands: game.handStats.totalHands, turn: game.currentTurn, seats: game.presenceSummary(), bids: game.playerBids, done, guard }));
    }
    expect(done).toMatchObject({ lazyActive: true, lazyWatch: true, rejects: true, resign: true, leave: true });
    await Promise.all(w.pending);
    await Promise.all(starting);
    await jest.advanceTimersByTimeAsync(5000);
    expectSilentAfterTerminal(w, game);
    expect(events(w.log, 'destroyHands').length).toBeGreaterThan(0);
    expect(errorLogs).toEqual([]);
    return { w, game };
}

describe('(b) F1 full human game through the lobby', () => {
    test('13 hands with redeal, bore, lazy/active, watch rejoin, resign, rejects, spectator, /leave', async () => {
        const { w } = await playF1();
        const bySelf = (e) => events(w.log, e).filter((l) => l.to.startsWith('self:'));
        expect(bySelf('rejoinSuccess').length).toBeGreaterThanOrEqual(4);
        expect(events(w.log, 'chatMessage').some((l) => !('isSpectator' in l.data))).toBe(true); // bot chat
        expect(events(w.log, 'chatMessage').some((l) => l.data.isSpectator === true)).toBe(true);
    }, 120000);
});

// ==================== (c) F2: ambient bot games ====================

describe('(c) F2 ambient bot games', () => {
    test.each([11, 22, 33])('seed %i: a full bot game', async (seed) => {
        Math.random = mulberry32(seed);
        const w = world(`amb${seed}`);
        const game = ambient.startBotGame(w.io);
        for (let t = 0; t < 30 && gameManager.getGameById(game.gameId); t++) {
            await jest.advanceTimersByTimeAsync(60000);
            if (t === 0) ambient.announceGameVisible(w.io);
        }
        ambient.stopAmbientActivity();
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
        await w.kill(d);
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
