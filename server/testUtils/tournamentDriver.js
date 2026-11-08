/**
 * Tournament test driver, moved verbatim out of tournamentLifecycle.test.js
 * (so contract.test.js can play a real tournament too). Needs the calling
 * test to jest.mock('../database') with a memoryDb (server/testUtils/memoryDb.js)
 * and to use fake timers.
 */

'use strict';

const gameManager = require('../game/GameManager');
const tournamentHandlers = require('../socket/tournamentHandlers');
const chatHandlers = require('../socket/chatHandlers');
const queueHandlers = require('../socket/queueHandlers');
const { makeIo, makeSocket } = require('./gameDriver');

let seq = 0;
const currentSeq = () => seq;

/** Stub io whose room emits record who was in the room at that moment. */
function newIo() {
    const log = [];
    const io = makeIo(log);
    io.to = (room) => ({
        emit: (event, data) => log.push({ to: room, members: [...(io.rooms.get(room) || [])], event, data, at: Date.now() }),
    });
    return { io, log };
}

/** Disconnect a socket the way socket.io does: gone from the server, then the handler. */
function kill(io, socket) {
    io.sockets.sockets.delete(socket.id);
    for (const members of io.rooms.values()) members.delete(socket.id);
    return queueHandlers.handleDisconnect(socket, io);
}

function newUser(io, log, username) {
    seq++;
    const id = `sock${seq}`;
    gameManager.registerUser(id, username);
    const users = require('../database').getUsersCollection(); // the test's jest.mock memoryDb
    if (!users.docs.some((d) => d.username === username)) {
        users._insert({ username, profilePic: 3 });
    }
    return makeSocket(id, log, io);
}

/** n humans in one tournament, all ready (the first one created it). */
async function setupTournament(n, opts = {}) {
    const { io, log } = opts.io ? opts : newIo();
    seq++;
    const tag = `T${seq}`;
    const sockets = Array.from({ length: n }, (_, i) => newUser(io, log, `${tag}_u${i + 1}`));
    tournamentHandlers.createTournament(sockets[0], io);
    const t = gameManager.getPlayerTournament(sockets[0].id);
    for (const s of sockets.slice(1)) await tournamentHandlers.joinTournament(s, io, { tournamentId: t.tournamentId });
    for (const s of sockets) tournamentHandlers.tournamentReady(s, io);
    expect(t.allPlayersReady()).toBe(true);
    return { io, log, t, sockets, usernames: sockets.map((s) => gameManager.getUserBySocketId(s.id).username) };
}

const liveTables = (t) => gameManager.getTournamentLiveGames(t.tournamentId);
const creatorSocket = (ctx) => ctx.sockets.find((s) => s.id === ctx.t.createdBy);

async function advanceUntil(pred, step = 100, cap = 60000) {
    let elapsed = 0;
    while (!pred() && elapsed < cap) {
        await jest.advanceTimersByTimeAsync(step);
        elapsed += step;
    }
    if (!pred()) throw new Error('advanceUntil: condition never met');
}

/**
 * Drive a whole tournament: every round, every table with its humans going
 * /lazy as soon as they are seated (the bots play everything), until
 * tournamentComplete. `hooks.round(r, ctx)` runs once per round while the
 * tables play.
 */
async function playTournament(ctx, hooks = {}) {
    const resolved = [];
    const real = gameManager.handleTournamentGameEnd.bind(gameManager);
    jest.spyOn(gameManager, 'handleTournamentGameEnd').mockImplementation((gameId) => {
        resolved.push(gameId);
        return real(gameId);
    });
    const allTables = [];
    for (let round = 1; round <= 4; round++) {
        if (round === 1) {
            ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        } else {
            expect(ctx.t.phase).toBe('between_rounds');
            for (const s of ctx.sockets) {
                if (gameManager.getPlayerTournament(s.id) === ctx.t) tournamentHandlers.tournamentReady(s, ctx.io);
            }
            ctx.starting = tournamentHandlers.beginNextRound(creatorSocket(ctx), ctx.io);
        }
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.entrants === null), 100, 120000);
        await ctx.starting;
        const tables = liveTables(ctx.t);
        allTables.push(...tables);
        expect(tables.every((g) => ctx.t.roundOfGame(g.gameId).roundNumber === round)).toBe(true);
        // The hook runs first, while every human still holds a human seat
        if (hooks.round) await hooks.round(round, ctx, tables);
        for (let step = 0; step < 800 && ctx.t.phase === 'round_active'; step++) {
            for (const g of tables) {
                if (g.isTerminal()) continue;
                for (const seat of g.seatList()) {
                    if (seat.controller !== 'human' || seat.presence !== 'connected') continue;
                    const s = ctx.sockets.find((x) => x.id === seat.ownerSocketId);
                    if (s) chatHandlers.chatMessage(s, ctx.io, { message: '/lazy' });
                }
            }
            await jest.advanceTimersByTimeAsync(5000);
        }
        expect(ctx.t.phase).not.toBe('round_active');
    }
    return { resolved, allTables };
}

module.exports = {
    newIo, kill, newUser, setupTournament, liveTables, creatorSocket, advanceUntil, playTournament, currentSeq,
};
