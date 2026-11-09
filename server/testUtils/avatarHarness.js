/**
 * One seeded, real-handler game for the wire tests (wireGolden.test.js,
 * avatarPayloads.test.js): pacingHarness.runGame generalised to 1-2 human
 * seats with chosen pictures, optional spectators and a per-emit hook.
 * With the defaults (one human `pace_<seed>` with profilePic 5 + 3 lobby
 * bots) it plays exactly pacingHarness.runGame's game.
 *
 * Virtual time (Jest modern fake timers), memoryDb, seeded Math.random
 * (mulberry32). Every human draws as soon as startDraw arrives and answers
 * its updateTurn at +0 ms with decisions from a non-registered BotPlayer
 * under its own seeded RNG, so the game's RNG stream does not depend on
 * the humans.
 *
 * Every emit is recorded at push time in its wire form (JSON round trip)
 * with the room members at that moment, so per-recipient byte counts are
 * exact. The calling test must jest.mock('../database') with a memoryDb and
 * use fake timers.
 */

'use strict';

const gameManager = require('../game/GameManager');
const gameHandlers = require('../socket/gameHandlers');
const mainRoomHandlers = require('../socket/mainRoomHandlers');
const lobbyHandlers = require('../socket/lobbyHandlers');
const BotPlayer = require('../game/bot/BotPlayer');
const { botController } = require('../game/bot');
const { Phase } = require('../game/GamePhase');
const contractCheck = require('./contractCheck');
const { makeIo, makeSocket, legalCards, legalBids, mulberry32 } = require('./gameDriver');

const sameCard = (a, b) => a && b && a.suit === b.suit && a.rank === b.rank;

/**
 * @param {number} seed
 * @param {Object} [opts]
 * @param {Array<{username?, profilePic?, customProfilePic?, sid?}>} [opts.humans]
 *   one entry per human seat (1 or 2; default one `pace_<seed>`, pic 5)
 * @param {Array<{username, sid?}>} [opts.spectators] - join with
 *   joinAsSpectator once the table is seated (after positionUpdate)
 * @param {Function} [opts.onSocket] - (socket, role, index) when a socket
 *   is created (e.g. to send clientHello)
 * @param {Function} [opts.onEmit] - (rec, ctx) for every recorded emit
 * @param {Function} [opts.onStep] - async (ctx) once per driver step, between
 *   emits (no timer runs meanwhile): e.g. disconnect / rejoin / lazy; a test
 *   that moves a human to a new socket sets ctx.seats[i].sock
 * @returns {Promise<{wire, log, game, socks, specs, io}>} wire: [{to,
 *   members, event, data, bytes}] in emit order (bot targets left out)
 */
async function runGame(seed, opts = {}) {
    const humans = opts.humans || [{ username: `pace_${seed}`, profilePic: 5 }];
    const spectators = opts.spectators || [];
    const realRandom = Math.random;
    Math.random = mulberry32(seed);

    const log = [];
    const io = makeIo(log);
    // Room emits record who is in the room at that moment
    io.to = (room) => ({
        emit: (event, data) => log.push({ to: room, members: [...(io.rooms.get(room) || [])], event, data, at: Date.now() }),
    });
    const wire = [];
    const ctx = { io, log, wire, game: null, socks: [], specs: [] };
    const off = contractCheck.onEmit((entry, w) => {
        const json = w === undefined ? '' : JSON.stringify(w);
        const rec = { to: entry.to, members: entry.members || null, event: entry.event, data: w, bytes: Buffer.byteLength(json) };
        wire.push(rec);
        if (opts.onEmit) opts.onEmit(rec, ctx);
    });

    let game = null;
    let pending = [];
    try {
        const users = require('../database').getUsersCollection();
        const socks = humans.map((h, i) => {
            const username = h.username || `pace_${seed}${i ? `_${i}` : ''}`;
            const sid = h.sid || `pace-${seed}-h${i ? i : ''}`;
            gameManager.registerUser(sid, username);
            const doc = { username, profilePic: h.profilePic ?? 5 };
            if (h.customProfilePic) doc.customProfilePic = h.customProfilePic;
            users._insert(doc);
            const s = makeSocket(sid, log, io);
            if (opts.onSocket) opts.onSocket(s, 'human', i);
            return s;
        });
        ctx.socks = socks;
        for (const s of socks) mainRoomHandlers.joinMainRoom(s, io);
        mainRoomHandlers.createLobby(socks[0], io, { name: 'Pace' });
        const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
        for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, io, { lobbyId });
        for (let i = socks.length; i < 4; i++) lobbyHandlers.addBot(socks[0], io);
        pending = socks.map((s) => lobbyHandlers.playerReady(s, io));
        while (!(game = gameManager.getPlayerGame(socks[0].id))) await jest.advanceTimersToNextTimerAsync();
        ctx.game = game;

        const seats = socks.map((s, i) => ({
            sock: s,
            bot: new BotPlayer('🤖 Human', 'mary'),
            rand: mulberry32(((seed * 7919) ^ 0x5bd1e995) + i),
            pos: null,
            drew: false,
            turn: null,
        }));
        ctx.seats = seats;
        const withRng = (rand, fn) => {
            const r = Math.random;
            Math.random = rand;
            try { return fn(); } finally { Math.random = r; }
        };
        let seen = 0;
        let steps = 0;
        let endAt = null;
        let spectated = false;

        const scan = () => {
            for (; seen < log.length; seen++) {
                const l = log[seen];
                if (l.event === 'gameEnd' && endAt === null) endAt = l.at;
                if (l.event === 'positionUpdate' && !spectated) spectated = 'due';
                for (const st of seats) {
                    if (l.event === 'startDraw' && !st.drew) st.turn = 'draw';
                    if (l.event === 'playerAssigned' && (l.to === st.sock.id || l.to === `self:${st.sock.id}`)) st.pos = l.data.position;
                    if (l.event === 'updateTurn' && l.to === game.roomName && l.data.currentTurn === st.pos) st.turn = seen;
                }
            }
        };

        while (endAt === null && steps++ < 200000) {
            scan();
            if (endAt !== null) break;
            if (opts.onStep) await opts.onStep(ctx);
            if (spectated === 'due') {
                spectated = true;
                for (const [i, sp] of spectators.entries()) {
                    const sid = sp.sid || `pace-${seed}-s${i}`;
                    gameManager.registerUser(sid, sp.username);
                    const s = makeSocket(sid, log, io);
                    if (opts.onSocket) opts.onSocket(s, 'spectator', i);
                    ctx.specs.push(s);
                    await mainRoomHandlers.joinAsSpectator(s, io, { gameId: game.gameId });
                }
                continue;
            }
            const st = seats.find((x) => x.turn !== null);
            if (st && st.turn === 'draw') {
                st.turn = null;
                st.drew = true;
                gameHandlers.draw(st.sock, io, { num: 0 });
                await jest.advanceTimersByTimeAsync(0);
                continue;
            }
            if (st) {
                st.turn = null;
                const sid = st.sock.id;
                const pos = st.pos;
                st.bot.position = pos;
                if (game.stage === Phase.BIDDING && game.currentTurn === pos) {
                    const c = {
                        teamScore: pos % 2 ? game.score.team1 : game.score.team2,
                        oppScore: pos % 2 ? game.score.team2 : game.score.team1,
                        currentHandSize: game.currentHand,
                    };
                    let bid = withRng(st.rand, () => st.bot.decideBid(game.getHand(sid), game.trump, game.playerBids, game.currentHand, c));
                    if (!legalBids(game).includes(String(bid))) bid = legalBids(game)[0];
                    gameHandlers.playerBid(st.sock, io, { bid });
                } else if (game.stage === Phase.PLAYING && game.currentTurn === pos) {
                    const legal = legalCards(game, sid);
                    let card = withRng(st.rand, () => st.bot.decideCard(game.getHand(sid), game.playedCards, game.leadCard,
                        game.leadPosition, game.trump, game.isTrumpBroken, game.currentHand, botController.buildPlayContext(game)));
                    if (!legal.some((x) => sameCard(x, card))) card = legal[0];
                    gameHandlers.playCard(st.sock, io, { card });
                }
                await jest.advanceTimersByTimeAsync(0);
                continue;
            }
            await jest.advanceTimersToNextTimerAsync();
        }
        if (endAt === null) throw new Error(`seed ${seed}: game did not end (stage ${game && game.stage})`);
        await Promise.all(pending);
        return { wire, log, game, socks: ctx.socks, specs: ctx.specs, io };
    } finally {
        off();
        Math.random = realRandom;
        for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    }
}

/** Does socket `sid` receive the recorded emit `rec`? */
function reaches(rec, sid) {
    const to = String(rec.to);
    if (to === sid || to === `self:${sid}`) return true;
    if (to.startsWith('game:') || to.startsWith('tournament:') || to === 'mainRoom') return (rec.members || []).includes(sid);
    return false;
}

/** Every recorded emit socket `sid` received, in order. */
function receivedBy(wire, sid) {
    return wire.filter((r) => reaches(r, sid));
}

/** Total wire bytes (JSON of the payload) socket `sid` received. */
function bytesTo(wire, sid) {
    return receivedBy(wire, sid).reduce((a, r) => a + r.bytes, 0);
}

module.exports = { runGame, reaches, receivedBy, bytesTo };
