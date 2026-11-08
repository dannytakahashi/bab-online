/**
 * Chaos run over the real handlers: seeded random humans (draws, valid and
 * garbage bids/plays, /lazy /active /leave, disconnects, realistic and
 * multi-socket rejoins, commands from stale sockets and spectators,
 * spectators moving between tables, forceResign, aborts) against a table of
 * humans and bots, started through the real lobby countdown on even seeds,
 * with BAB_FSM_CHECK=1 so every stage and seat transition validates its
 * invariants. After every step the game must be consistent (stage + seat
 * invariants, owner sockets, the playerGames contract, registered seat bots,
 * no stale/spectator command changing a seat, no zombie table) and live;
 * once it ends or aborts nothing may be emitted into it and nothing may be
 * left behind; every resign offer comes a full grace period after its
 * seat's disconnect. Failures print the seed, the stage history, the seat
 * summary and the timer keys.
 *
 * CHAOS_SEEDS=<n> overrides the number of seeds (default 200).
 *
 * Also runs complete ambient bot games under CHECK mode and matches their
 * full stage history.
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
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const gameLifecycle = require('../gameLifecycle');
const ambient = require('../../demo/ambientBots');
const GamePhase = require('../../game/GamePhase');
const { botController } = require('../../game/bot');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { makeIo, makeSocket, events, legalCards, legalBids, mulberry32 } = require('../../testUtils/gameDriver');
const contractCheck = require('../../testUtils/contractCheck');
const { watchSeq } = require('../../testUtils/seqCheck');

const { Phase } = GamePhase;
const SEEDS = Number(process.env.CHAOS_SEEDS) || 200;
const MAX_STEPS = 400;

const GAME_EVENTS = new Set([
    'startDraw', 'playerDrew', 'youDrew', 'playerAssigned', 'positionUpdate', 'teamsAnnounced', 'createUI',
    'gameStart', 'updateTurn', 'bidReceived', 'doneBidding', 'rainbow', 'destroyHands', 'cardPlayed',
    'trickComplete', 'handComplete', 'gameEnd', 'abortGame', 'chatMessage', 'gameLogEntry',
    'playerDisconnected', 'playerReconnected', 'resignationAvailable', 'playerLazyMode', 'playerActiveMode',
    'playerResigned', 'spectatorJoined', 'restorePlayerState', 'rejoinSuccess',
]);

// gameLogger/socketLogger errors a chaos run may legitimately produce
const ERROR_WHITELIST = [];

let errorLogs;
let realRandom;

beforeAll(() => {
    process.env.BAB_FSM_CHECK = '1';
    realRandom = Math.random;
});

afterAll(() => {
    delete process.env.BAB_FSM_CHECK;
    Math.random = realRandom;
});

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
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

function botPending(gameId) {
    for (const key of botController.pendingActions.keys()) {
        if (key.startsWith(`${gameId}:`) && !key.includes(':chat:')) return true;
    }
    return false;
}

/** Every (controller, presence, ownerSocketId) of the seats, for the "commands from outsiders change nothing" oracle. */
const seatSnapshot = (game) => JSON.stringify(game.seatList().map((s) => [s.position, s.controller, s.presence, s.ownerSocketId]));

/**
 * One chaos run, with the seq invariants (testUtils/seqCheck.js) watched
 * over all its emits. Returns a failure description, or {ok}.
 */
async function runSeed(seed) {
    let seqWatch = null;
    contractCheck.setContext(`chaos seed ${seed}`);
    const result = await runSeedInner(seed, (io) => { seqWatch = watchSeq(io); });
    const seqResult = seqWatch ? seqWatch.stop() : { failures: [] };
    if (result.ok && seqResult.failures.length) return { seed, why: 'seq', failures: seqResult.failures.slice(0, 5) };
    return result;
}

async function runSeedInner(seed, onIo) {
    errorLogs.length = 0;
    GamePhase.resetViolations();
    const rand = mulberry32(seed);
    Math.random = rand;
    const pick = (arr) => (arr.length ? arr[Math.floor(rand() * arr.length)] : undefined);
    const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

    const log = [];
    const io = makeIo(log);
    // Record who was in a room at each room emit (for the resign-offer oracle)
    io.to = (room) => ({
        emit: (event, data) => log.push({ to: room, members: [...(io.rooms.get(room) || [])], event, data, at: Date.now() }),
    });
    onIo(io);
    const asyncErrors = [];
    const track = (p) => {
        if (p && typeof p.then === 'function') p.catch((err) => asyncErrors.push(err));
        return p;
    };

    // Humans: { username, current (the socket the harness plays it with),
    // stale (older live sockets of the same user), connected }
    const nHumans = randInt(2, 4);
    const humans = [];
    const allSockets = new Set();
    const deadSockets = new Set();
    const sockets = new Map();
    const newSocket = (id) => {
        const s = makeSocket(id, log, io);
        sockets.set(id, s);
        allSockets.add(id);
        return s;
    };
    const kill = (sid) => {
        io.sockets.sockets.delete(sid);
        for (const members of io.rooms.values()) members.delete(sid);
        deadSockets.add(sid);
    };
    for (let i = 0; i < nHumans; i++) {
        const username = `s${seed}_u${i}`;
        const sid = `s${seed}-h${i}`;
        gameManager.registerUser(sid, username);
        mockDb.current.users._insert({ username, profilePic: (i % 80) + 1 });
        newSocket(sid);
        humans.push({ username, current: sid, stale: [], connected: true });
    }
    // One human may never draw (the draw watchdog must still end the draw)
    const afk = rand() < 0.25 ? pick(humans) : null;

    // A second (frozen) table so spectators can move between games
    const dummyBots = [0, 1, 2, 3].map((i) => botController.createBot(`🤖 D${i}`, 'mary'));
    const dummy = gameManager.createGame(dummyBots.map((b) => b.socketId));
    dummyBots.forEach((b, i) => dummy.addPlayer(b.socketId, b.username, i + 1, 1, true)); // stays in CREATED

    // Even seeds start through the real lobby countdown (chaos runs during
    // CREATED); odd seeds open the draw directly
    let game;
    let starting = null;
    if (seed % 2 === 0) {
        const lobby = gameManager.createLobby(humans.map((h) => h.current));
        for (let i = nHumans; i < 4; i++) gameManager.addBotToLobby(lobby.id);
        starting = Promise.all(humans.map((h) => track(lobbyHandlers.playerReady(sockets.get(h.current), io))));
        await jest.advanceTimersByTimeAsync(1500);
        game = gameManager.getPlayerGame(humans[0].current);
        if (!game || game.stage !== Phase.CREATED) {
            return { seed, why: 'lobby countdown did not create the game', stage: game?.stage };
        }
    } else {
        const bots = Array.from({ length: 4 - nHumans }, (_, i) => botController.createBot(`🤖 C${i}`, 'mary'));
        game = gameManager.createGame([...humans.map((h) => h.current), ...bots.map((b) => b.socketId)]);
        bots.forEach((b) => botController.registerBot(game.gameId, b));
        humans.forEach((h) => sockets.get(h.current).join(game.roomName));
        gameLifecycle.beginDraw(io, game);
    }
    const gameId = game.gameId;

    let rejoinSeq = 0;
    let specSeq = 0;
    const spectators = [];       // live pure-spectator sockets we created
    const connectedHumans = () => humans.filter((h) => h.connected);
    const isConnectedSid = (sid) => humans.some((h) => h.connected && h.current === sid);
    const liveStale = () => humans.flatMap((h) => h.stale).filter((sid) => io.sockets.sockets.has(sid));
    let note = '';
    let outsiderBroke = null;

    /** `h`'s socket `sid` became the seat's owner: the previous one (if live) is stale now. */
    function promote(h, sid) {
        if (h.connected && h.current !== sid && io.sockets.sockets.has(h.current)) h.stale.push(h.current);
        h.stale = h.stale.filter((x) => x !== sid);
        h.current = sid;
        h.connected = true;
    }
    const gotSelf = (before, sid, event) => log.slice(before).some((l) => l.to === `self:${sid}` && l.event === event);

    /** rejoinGame from a fresh socket, or (with `existing`) from one of h's older live sockets. */
    async function rejoinAs(h, sid, existing = false) {
        const s = existing ? sockets.get(sid) : newSocket(sid);
        gameManager.registerUser(sid, h.username);
        const before = log.length;
        await track(reconnectHandlers.rejoinGame(s, io, { gameId, username: h.username }));
        if (gotSelf(before, sid, 'rejoinSuccess')) {
            promote(h, sid);
        } else if (!h.stale.includes(sid)) {
            h.stale.push(sid); // a live socket that owns nothing
        }
    }

    /** The human whose (stale or current) socket `sid` is. */
    const humanOf = (sid) => humans.find((h) => h.current === sid || h.stale.includes(sid));

    // The resign offer each socket holds (its last resignationAvailable, room
    // or private; any room playerResigned clears it, as both clients do)
    const heldOffer = new Map();
    let offersSeen = 0;
    const updateOffers = () => {
        for (; offersSeen < log.length; offersSeen++) {
            const l = log[offersSeen];
            if (l.event !== 'resignationAvailable' && l.event !== 'playerResigned') continue;
            const to = l.members || [String(l.to).replace(/^self:/, '')];
            for (const sid of to) {
                if (l.event === 'resignationAvailable') heldOffer.set(sid, l.data.position);
                else heldOffer.delete(sid);
            }
        }
    };

    /** A command from a socket that owns no seat must not change any seat. */
    function asOutsider(label, fn) {
        const before = seatSnapshot(game);
        const r = fn();
        track(r);
        if (!outsiderBroke && gameManager.getGameById(gameId) && seatSnapshot(game) !== before) {
            outsiderBroke = { label, before, after: seatSnapshot(game) };
        }
        return r;
    }

    const actions = [
        [6, function draw() {
            const h = pick(connectedHumans().filter((x) => x !== afk)); if (!h) return;
            track(gameHandlers.draw(sockets.get(h.current), io, { num: randInt(-3, 60) }));
        }],
        [12, function validBid() {
            if (game.stage !== Phase.BIDDING) return;
            const sid = game.positions[game.currentTurn];
            if (!isConnectedSid(sid)) return;
            track(gameHandlers.playerBid(sockets.get(sid), io, { bid: pick(legalBids(game)) }));
        }],
        [2, function randomBid() {
            const h = pick(connectedHumans()); if (!h) return;
            track(gameHandlers.playerBid(sockets.get(h.current), io, { bid: pick(['0', '1', '3', '7', '13', 'B', '2B', 'X', 99]) }));
        }],
        [20, function legalPlay() {
            if (game.stage !== Phase.PLAYING) return;
            const sid = game.positions[game.currentTurn];
            if (!isConnectedSid(sid)) return;
            const cards = legalCards(game, sid);
            if (!cards.length) return;
            track(gameHandlers.playCard(sockets.get(sid), io, { card: pick(cards) }));
        }],
        [2, function randomPlay() {
            const h = pick(connectedHumans()); if (!h) return;
            const hand = game.getHand(h.current);
            const card = hand.length && rand() < 0.7 ? pick(hand) : { suit: pick(['hearts', 'spades']), rank: pick(['2', 'K', 'HI']) };
            track(gameHandlers.playCard(sockets.get(h.current), io, { card }));
        }],
        [1.5, function slash() {
            const h = pick(connectedHumans()); if (!h) return;
            const m = pick(['/lazy', '/active', '/active', '/leave', 'hi']); note = m + ' ' + h.current;
            chatHandlers.chatMessage(sockets.get(h.current), io, { message: m });
        }],
        [0.8, function disconnect() {
            const h = pick(connectedHumans()); if (!h) return;
            h.connected = false; note = 'dc ' + h.current;
            kill(h.current);
            track(queueHandlers.handleDisconnect(sockets.get(h.current), io));
        }],
        [0.4, function watcherDisconnect() {
            const h = pick(connectedHumans().filter((x) => {
                const pos = game.seatByOwnerSocket(x.current);
                return pos && game.isBotControlled(pos);
            }));
            if (!h) return;
            h.connected = false; note = 'wdc ' + h.current;
            kill(h.current);
            track(queueHandlers.handleDisconnect(sockets.get(h.current), io));
        }],
        [1.5, async function realisticRejoin() {
            const h = pick(humans); if (!h) return;
            if (h.connected) {
                h.connected = false;
                kill(h.current);
                await track(queueHandlers.handleDisconnect(sockets.get(h.current), io));
            }
            await jest.advanceTimersByTimeAsync(randInt(0, 70000));
            if (!gameManager.getGameById(gameId)) return;
            rejoinSeq++;
            note = 'rrejoin ' + h.username;
            await rejoinAs(h, `${h.username}-r${rejoinSeq}`);
        }],
        [0.3, async function outage() {
            // Everyone's wifi drops a few seconds apart; past grace they come
            // back one by one (the first to return finds nobody to share offers with)
            note = 'outage';
            for (const h of connectedHumans()) {
                h.connected = false;
                kill(h.current);
                await track(queueHandlers.handleDisconnect(sockets.get(h.current), io));
                await jest.advanceTimersByTimeAsync(randInt(0, 8000));
                if (!gameManager.getGameById(gameId)) return;
            }
            await jest.advanceTimersByTimeAsync(randInt(50000, 70000));
            for (const h of humans.slice().sort(() => rand() - 0.5).slice(0, randInt(1, humans.length))) {
                if (!gameManager.getGameById(gameId)) return;
                rejoinSeq++;
                await rejoinAs(h, `${h.username}-r${rejoinSeq}`);
                await jest.advanceTimersByTimeAsync(randInt(0, 5000));
            }
            // ...and one of them may give up right away
            const quitter = rand() < 0.5 && pick(connectedHumans());
            if (quitter && gameManager.getGameById(gameId)) {
                chatHandlers.chatMessage(sockets.get(quitter.current), io, { message: '/leave' });
            }
        }],
        [2, async function multiShadowRejoin() {
            // A fresh socket rejoins while the old one may still be live
            const h = pick(humans);
            rejoinSeq++;
            note = 'rejoin ' + h.username;
            await rejoinAs(h, `${h.username}-r${rejoinSeq}`);
        }],
        [2, function staleCommand() {
            const sid = pick(liveStale()); if (!sid) return;
            const s = sockets.get(sid);
            const what = pick(['/active', '/leave', '/lazy', 'chat', 'draw', 'bid', 'play', 'forceResign']);
            note = `stale ${what} ${sid}`;
            // A spectating socket of the owner may take back a bot-controlled
            // seat that has no owner socket attached (phone -> laptop -> phone)
            const h = humanOf(sid);
            const pos = h && game.seatByUsername(h.username);
            if (what === '/active' && pos && game.isBotControlled(pos) && game.seatPresence(pos) === 'away' &&
                game.isSpectator(sid)) {
                chatHandlers.chatMessage(s, io, { message: what });
                if (game.seat(pos).ownerSocketId !== sid) outsiderBroke = outsiderBroke || { label: note + ' did not reclaim' };
                else promote(h, sid);
                return;
            }
            asOutsider(note, () => {
                if (what.startsWith('/')) return chatHandlers.chatMessage(s, io, { message: what });
                if (what === 'chat') return chatHandlers.chatMessage(s, io, { message: 'psst' });
                if (what === 'draw') return gameHandlers.draw(s, io, { num: 0 });
                if (what === 'bid') return gameHandlers.playerBid(s, io, { bid: '1' });
                if (what === 'play') return gameHandlers.playCard(s, io, { card: game.getHand(game.positions[game.currentTurn])[0] || { suit: 'hearts', rank: '2' } });
                return gameHandlers.forceResign(s, io, { position: randInt(1, 4) });
            });
        }],
        [1, function spectate() {
            specSeq++;
            const sid = `s${seed}-spec${specSeq}`;
            const s = newSocket(sid);
            // Half of them use an owner's username (must still get no seat rights)
            const name = rand() < 0.3 ? pick(humans).username + '_fan' : `s${seed}_spec${specSeq}`;
            gameManager.registerUser(sid, name);
            asOutsider('spectate ' + sid, () => mainRoomHandlers.joinAsSpectator(s, io, { gameId }));
            spectators.push(sid);
        }],
        [0.8, async function ownerSpectate() {
            // Another tab of an owner spectates the owner's own game, from the
            // main room or a tournament lobby (the latter is always a pure spectator)
            const h = pick(humans);
            specSeq++;
            const sid = `${h.username}-os${specSeq}`;
            const s = newSocket(sid);
            gameManager.registerUser(sid, h.username);
            const viaTournament = rand() < 0.4;
            note = `ownerSpectate ${sid}${viaTournament ? ' (tournament)' : ''}`;
            const before = log.length;
            if (viaTournament) tournamentHandlers.spectateTournamentGame(s, io, { gameId });
            else mainRoomHandlers.joinAsSpectator(s, io, { gameId });
            if (gotSelf(before, sid, 'rejoinSuccess')) promote(h, sid);
            else h.stale.push(sid);
        }],
        [1.2, async function staleRejoin() {
            // An older live socket of the owner (demoted watcher, owner-named
            // spectator, unmapped old seat socket) signs in again and rejoins
            const sid = pick(liveStale()); if (!sid) return;
            note = `staleRejoin ${sid}`;
            await rejoinAs(humanOf(sid), sid, true);
        }],
        [1.5, function spectatorCommand() {
            const sid = pick(spectators.filter((x) => io.sockets.sockets.has(x))); if (!sid) return;
            const s = sockets.get(sid);
            const what = pick(['/leave', '/active', '/lazy', 'chat', 'disconnect']);
            note = `spec ${what} ${sid}`;
            asOutsider(note, () => {
                if (what === 'disconnect') {
                    kill(sid);
                    return queueHandlers.handleDisconnect(s, io);
                }
                return chatHandlers.chatMessage(s, io, { message: what === 'chat' ? 'go team' : what });
            });
        }],
        [0.7, function spectateOther() {
            const sid = pick(spectators.filter((x) => io.sockets.sockets.has(x))); if (!sid) return;
            const target = gameManager.spectatorGames.get(sid) === dummy.gameId ? gameId : dummy.gameId;
            note = `spectate-other ${sid}`;
            asOutsider(note, () => mainRoomHandlers.joinAsSpectator(sockets.get(sid), io, { gameId: target }));
        }],
        [2, function forceResign() {
            const h = pick(connectedHumans()); if (!h) return;
            // Mostly the offer this client holds (what a real client sends)
            updateOffers();
            const held = heldOffer.get(h.current);
            const fp = held != null && rand() < 0.7 ? held : randInt(1, 4); note = 'fr ' + h.current + ' ' + fp;
            track(gameHandlers.forceResign(sockets.get(h.current), io, { position: fp }));
        }],
        [0.05, function abort() {
            track(gameLifecycle.abortGame(io, game, 'chaos'));
        }],
    ];
    const totalWeight = actions.reduce((n, [w]) => n + w, 0);
    const act = async () => {
        let r = rand() * totalWeight;
        for (const [w, fn] of actions) {
            r -= w;
            if (r <= 0) {
                try { await fn(); } catch (err) { asyncErrors.push(err); }
                const n = note; note = ''; return fn.name + (n ? '(' + n + ')' : '') + '@' + game.stage;
            }
        }
        return null;
    };

    const fail = (why, extra = {}) => ({
        seed, why, stage: game.stage, history: (game._history || []).join(' '),
        seats: game.presenceSummary(), seatHistory: (game._seatHistory || []).slice(-20), timers: game.timerKeys(), eventSeq: game.eventSeq, ...extra,
    });

    const liveness = () => {
        if (game.pendingTimerCount > 0 || botPending(gameId)) return true;
        if (game.stage === Phase.BIDDING || game.stage === Phase.PLAYING) {
            const seat = game.seat(game.currentTurn);
            if (seat && seat.controller === 'human') {
                // The owner is here to act
                if (seat.presence === 'connected') return true;
                // Its grace ran out: a connected owner holds an offer it can
                // act on (for some resignable seat; resigning that one re-offers the next)
                if (seat.presence === 'resignable') {
                    updateOffers();
                    const resignable = game.resignablePositions();
                    if (game.seatList().some((s) => s.presence === 'connected' && resignable.includes(heldOffer.get(s.ownerSocketId)))) return true;
                }
            }
        }
        // (DRAWING needs no special case: the draw watchdog is a pending timer)
        return false;
    };

    /** Seat / socket / mapping oracles. Returns a failure reason or null. */
    const consistency = () => {
        const seats = game.seatList();
        // Owner sockets are the harness's current live sockets, never a stale one
        const stale = new Set(humans.flatMap((h) => h.stale));
        for (const s of seats) {
            if (s.presence !== 'connected') continue;
            const h = humans.find((x) => x.username === s.ownerUsername);
            if (!io.sockets.sockets.has(s.ownerSocketId)) return `seat ${s.position} owned by dead socket ${s.ownerSocketId}`;
            if (!h || h.current !== s.ownerSocketId) return `seat ${s.position} owner ${s.ownerSocketId} is not ${h?.username}'s current socket ${h?.current}`;
            if (stale.has(s.ownerSocketId)) return `stale socket ${s.ownerSocketId} owns seat ${s.position}`;
        }
        // playerGames maps exactly: connected entrants, owner sockets, seat bots
        const expected = new Set();
        if (game.entrants) {
            for (const e of game.entrants.values()) if (e.presence === 'connected') expected.add(e.socketId);
        }
        for (const s of seats) {
            if (s.ownerSocketId) expected.add(s.ownerSocketId);
            if (s.controller !== 'human') expected.add(s.seatSocketId);
        }
        const actual = new Set(Array.from(gameManager.playerGames.entries()).filter(([, g]) => g === gameId).map(([sid]) => sid));
        const missing = [...expected].filter((x) => !actual.has(x));
        const extra = [...actual].filter((x) => !expected.has(x));
        if (missing.length || extra.length) return `playerGames mismatch: missing ${missing.join(',')} extra ${extra.join(',')}`;
        for (const [sid] of gameManager.spectatorGames) {
            if (!io.sockets.sockets.has(sid) && allSockets.has(sid)) return `spectatorGames holds dead socket ${sid}`;
        }
        // Every bot-controlled seat's bot is registered
        for (const s of seats) {
            if (s.bot && !botController.getBot(gameId, s.bot.socketId)) return `seat ${s.position} bot ${s.bot.socketId} not registered`;
            if (s.presence === 'resignable' && s.resignableAt - s.absentSince !== 60000) {
                return `seat ${s.position} resignable after ${s.resignableAt - s.absentSince}ms`;
            }
        }
        // No zombie: an owned table with nobody connected must be counting down
        if (seats.length === 4 && seats.some((s) => s.ownerUsername) && !game.hasPresentHuman()) {
            const counting = game.hasTimer('abandon') || seats.some((s) => game.hasTimer(`grace:${s.position}`));
            if (!counting) return 'zombie: owned table, nobody connected, no abandon/grace timer';
        }
        // Resign offers: while a seat is resignable, every connected owner
        // holds an offer for a seat that is still resignable (so forceResign
        // can always unstick the table)
        const resignable = game.resignablePositions();
        if (seats.length === 4 && resignable.length > 0 && !game.isTerminal()) {
            updateOffers();
            for (const s of seats) {
                if (s.presence !== 'connected') continue;
                const held = heldOffer.get(s.ownerSocketId);
                if (!resignable.includes(held)) return `owner ${s.ownerSocketId} of seat ${s.position} holds offer ${held}, resignable ${resignable.join(',')}`;
            }
        }
        if (outsiderBroke) return `outsider changed a seat: ${JSON.stringify(outsiderBroke)}`;
        return null;
    };

    let steps = 0;
    const trail = [];
    while (gameManager.getGameById(gameId) && steps < MAX_STEPS) {
        steps++;
        await jest.advanceTimersByTimeAsync(randInt(0, 2500));
        if (!gameManager.getGameById(gameId)) break;
        trail.push(await act());
        await jest.advanceTimersByTimeAsync(0);
        if (!gameManager.getGameById(gameId)) break;

        const { errors } = game.validateGameState();
        if (errors.length) return fail('invariant', { errors, trail: trail.slice(-15) });
        const broken = consistency();
        if (broken) return fail('consistency', { broken, trail: trail.slice(-15), humans });
        if (!liveness()) return fail('hang', { trail: trail.filter(t => !/^(draw|validBid|legalPlay|randomBid|randomPlay|spectate)/.test(t)), turn: game.currentTurn, humans, spectators: [...game.spectators.keys()] });
        if (asyncErrors.length) return fail('async error', { error: asyncErrors[0].stack });
    }
    // Still running after the step budget: tear it down to check teardown
    if (gameManager.getGameById(gameId)) await gameLifecycle.abortGame(io, game, 'chaos-end');

    const terminalIdx = log.findIndex((l) => l.to === game.roomName && (l.event === 'gameEnd' || l.event === 'abortGame'));
    for (let i = 0; i < 30; i++) {
        await jest.advanceTimersByTimeAsync(randInt(0, 2500));
        await act();
    }
    await jest.advanceTimersByTimeAsync(120000);
    if (starting) await starting;

    const roomEnds = log.filter((l) => l.to === game.roomName && (l.event === 'gameEnd' || l.event === 'abortGame'));
    if (roomEnds.length !== 1) return fail('terminal events', { events: roomEnds.map((l) => l.event) });
    if (terminalIdx < 0) return fail('no terminal event');
    const targets = new Set([game.roomName]);
    for (const id of allSockets) { targets.add(id); targets.add(`self:${id}`); }
    // (spectators may have moved on to the dummy table: its own emits are fine)
    const dead = log.slice(terminalIdx + 1).filter((l) => GAME_EVENTS.has(l.event) && targets.has(l.to) && l.data?.gameId !== dummy.gameId);
    if (dead.length) return fail('emit after terminal', { dead: dead.slice(0, 5).map((l) => `${l.to}:${l.event}`) });
    if (!game.isTerminal()) return fail('not terminal');
    if (Array.from(gameManager.playerGames.values()).includes(gameId)) return fail('playerGames leak');
    if (Array.from(gameManager.spectatorGames.values()).includes(gameId)) return fail('spectatorGames leak');
    if (botController.gamesBots.has(gameId)) return fail('gamesBots leak');
    if (Array.from(botController.pendingActions.keys()).some((k) => k.startsWith(`${gameId}:`))) return fail('pendingActions leak');
    if (game.pendingTimerCount !== 0) return fail('timer leak', { pending: game.pendingTimerCount });
    const leakedUsers = gameManager.currentUsers.filter((u) => deadSockets.has(u.socketId));
    if (leakedUsers.length) return fail('currentUsers leak', { leakedUsers });
    const nullDc = events(log, 'playerDisconnected').filter((l) => l.data.position == null);
    if (nullDc.length) return fail('playerDisconnected position:null');

    // Resign offers: each room offer for p comes a full grace period after
    // p's last playerDisconnected (1s slack: a draw-time disconnect is
    // announced after the 1s seating pause, its grace began at seating),
    // with p neither back nor resigned in between
    const lastDc = {};
    const resolved = {};
    for (const l of log) {
        if (l.to !== game.roomName) continue;
        const p = l.data?.position;
        if (l.event === 'playerDisconnected') { lastDc[p] = l.at; resolved[p] = false; }
        if (l.event === 'playerReconnected' || l.event === 'playerResigned') resolved[p] = true;
        if (l.event === 'resignationAvailable') {
            if (lastDc[p] == null || resolved[p] || l.at - lastDc[p] < 59000) {
                return fail('early or stale resign offer', { position: p, at: l.at, lastDc: lastDc[p], resolved: resolved[p] });
            }
        }
    }

    if (asyncErrors.length) return fail('async error', { error: asyncErrors[0].stack });
    const errs = errorLogs.filter((e) => !ERROR_WHITELIST.some((w) => String(e.msg).includes(w)));
    if (errs.length) return fail('error logged', { errors: errs.slice(0, 3) });
    const violations = GamePhase.getViolations();
    if (violations.length) return fail('violation', { violations: violations.slice(0, 3).map(({ stack, ...v }) => v) });
    gameManager.abortGame(dummy.gameId);
    const reason = (log.find((l) => l.to === game.roomName && l.event === 'abortGame') || {}).data?.reason;
    if (process.env.CHAOS_STATS) process.stdout.write(`seed ${seed} steps ${steps} hands ${game.handStats.totalHands} ${game.stage} ${reason || ''}\n`);
    return { ok: true, hands: game.handStats.totalHands, steps };
}

describe('chaos', () => {
    test(`${SEEDS} seeded chaos runs keep the FSM consistent, live and leak-free`, async () => {
        const processErrors = [];
        const onError = (err) => processErrors.push(err);
        process.on('unhandledRejection', onError);
        process.on('uncaughtException', onError);
        try {
            const failures = [];
            let deep = 0;
            for (let seed = 1; seed <= SEEDS; seed++) {
                const result = await runSeed(seed);
                if (!result.ok) {
                    failures.push(result);
                    if (failures.length >= 3) break;
                } else if (result.hands >= 1) {
                    deep++;
                }
                for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
                GamePhase.resetViolations();
                jest.clearAllTimers();
            }
            if (failures.length) {
                throw new Error(`chaos failures:\n${failures.map((f) => JSON.stringify(f, null, 2)).join('\n')}`);
            }
            expect(processErrors).toEqual([]);
            // Coverage: a good share of runs get past the first hand
            if (SEEDS >= 20) expect(deep).toBeGreaterThanOrEqual(Math.floor(SEEDS / 4));
        } finally {
            process.off('unhandledRejection', onError);
            process.off('uncaughtException', onError);
        }
    }, 600000);
});

describe('full ambient bot games under CHECK mode', () => {
    const HISTORY = /^CREATED DRAWING DRAW_RESOLVING TEAMS_ANNOUNCED( DEALING BIDDING( REDEAL DEALING BIDDING)* PLAYING( TRICK_RESOLVING PLAYING)* TRICK_RESOLVING HAND_RESOLVING){13} ENDED$/;

    test.each([11, 22, 33])('seed %i plays 13 hands to one gameEnd', async (seed) => {
        Math.random = mulberry32(seed);
        const log = [];
        const io = makeIo(log);
        const game = ambient.startBotGame(io);
        for (let t = 0; t < 30 && gameManager.getGameById(game.gameId); t++) {
            await jest.advanceTimersByTimeAsync(60000);
        }
        ambient.stopAmbientActivity();

        expect(events(log, 'gameEnd')).toHaveLength(1);
        expect(events(log, 'abortGame')).toHaveLength(0);
        expect(game._history.join(' ')).toMatch(HISTORY);
        expect(game.handStats.totalHands).toBe(13);
        expect(game.pendingTimerCount).toBe(0);
        expect(gameManager.getGameById(game.gameId)).toBeNull();
        expect(GamePhase.getViolations()).toEqual([]);
        expect(errorLogs).toEqual([]);
    }, 60000);
});
