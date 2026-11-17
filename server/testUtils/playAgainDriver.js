/**
 * Drive a lobby-born casual game to its gameEnd quickly, through the real
 * handlers (play again tests: server/socket/__tests__/playAgain.test.js,
 * contract.test.js). The lobby starts through playerReady (LOBBY_START_MS,
 * countdown, draw), the humans draw, and at BIDDING of the first hand that
 * hand becomes the last one (finishGame). One human seat (by default the
 * first one still human and connected) bids and plays it out through
 * gameHandlers.playerBid / playCard, so the game ends with that seat
 * human-controlled (the ordinary end); the other humans go /lazy. Fake
 * timers and a mocked database required.
 * The handlers' promises (ready, draw, chat, bid, play) settle only while
 * timers run, so they are collected and awaited at the end, never in
 * between.
 */

'use strict';

const gameManager = require('../game/GameManager');
const gameHandlers = require('../socket/gameHandlers');
const lobbyHandlers = require('../socket/lobbyHandlers');
const chatHandlers = require('../socket/chatHandlers');
const { Phase } = require('../game/GamePhase');
const { Controller, Presence } = require('../game/SeatState');
const { legalCards, legalBids } = require('./gameDriver');

async function advanceUntil(pred, step = 100, cap = 60000) {
    let elapsed = 0;
    while (!pred() && elapsed < cap) {
        await jest.advanceTimersByTimeAsync(step);
        elapsed += step;
    }
    if (!pred()) throw new Error('advanceUntil: condition never met');
}

/**
 * The `table` sockets tap Ready in order; resolves with the game once the
 * lobby has become one (`pending`: the handlers' promises).
 */
async function startLobbyGame(io, table) {
    const pending = table.map((s) => lobbyHandlers.playerReady(s, io));
    let game = null;
    await advanceUntil(() => !!(game = gameManager.getPlayerGame(table[0].id)));
    return { game, pending };
}

/** The humans in `table` draw; resolves at BIDDING with the draw promises. */
async function toBidding(io, game, table) {
    await advanceUntil(() => game.stage === Phase.DRAWING);
    const draws = table.filter((s) => gameManager.getPlayerGame(s.id) === game).map((s) => gameHandlers.draw(s, io, { num: 0 }));
    await advanceUntil(() => game.stage === Phase.BIDDING);
    return draws;
}

const humanConnected = (s) => !!s && s.controller === Controller.HUMAN && s.presence === Presence.CONNECTED;

/**
 * From BIDDING of the first hand: the hand is relabelled the last one
 * (currentHand 13: the next hand size after it is 0; cardIndex moved on by
 * the 4 cards it lacks), so handleHandComplete takes its real game-over
 * path. The seat of `keep` (a socket; default: the first seat still human
 * and connected; null: none) stays human and bids ('1') and plays (its
 * first legal card) on each of its turns through the real handlers; every
 * other human still at a human seat goes /lazy (a lazy owner at its seat
 * stays a connected seat owner, in voice) and the bots play. No
 * forcePhase: test:contract also runs with NODE_ENV=production. Resolves
 * once the game has ended (gameEnd sent, retired) with the chat / bid /
 * play promises.
 */
async function finishGame(io, game, { keep } = {}) {
    const promises = [];
    const seats = game.seatList().filter(humanConnected);
    const kept = keep === undefined ? (seats[0] || null) : (keep && seats.find((s) => s.ownerSocketId === keep.id)) || null;
    for (const s of seats) {
        if (s === kept) continue;
        const sock = io.sockets.sockets.get(s.ownerSocketId);
        if (sock) promises.push(chatHandlers.chatMessage(sock, io, { message: '/lazy' }));
    }
    // A hand ends when cardIndex reaches currentHand * 4 (handleTrickComplete):
    // the 12 cards dealt then count as the 13-card hand's last 12
    game.currentHand = 13;
    game.cardIndex += 4;
    const pos = kept ? kept.position : null;
    let acted = null;
    const act = () => {
        if (pos == null || game.currentTurn !== pos) return;
        const seat = game.seatList().find((s) => s.position === pos);
        if (!humanConnected(seat)) return;
        const key = game.turnKey();
        if (key === acted) return;
        const sock = io.sockets.sockets.get(seat.ownerSocketId);
        if (!sock) return;
        if (game.stage === Phase.BIDDING) {
            acted = key;
            const legal = legalBids(game);
            promises.push(gameHandlers.playerBid(sock, io, { bid: legal.includes('1') ? '1' : legal[legal.length - 1] }));
        } else if (game.stage === Phase.PLAYING) {
            acted = key;
            promises.push(gameHandlers.playCard(sock, io, { card: legalCards(game, sock.id)[0] }));
        }
    };
    let elapsed = 0;
    while (!game.isTerminal() && elapsed < 600000) {
        act();
        await jest.advanceTimersByTimeAsync(100);
        elapsed += 100;
    }
    if (!game.isTerminal()) throw new Error('finishGame: the game never ended');
    await jest.advanceTimersByTimeAsync(100);
    return promises;
}

/**
 * startLobbyGame + toBidding + (before) + finishGame, then every handler
 * promise. `keep`: finishGame's (whose seat plays the last hand out).
 * @returns {Promise<GameState>}
 */
async function playLobbyGame(io, table, { before = null, keep } = {}) {
    const { game, pending } = await startLobbyGame(io, table);
    const draws = await toBidding(io, game, table);
    if (before) await before(game);
    const plays = await finishGame(io, game, { keep });
    await Promise.all([...pending, ...draws, ...plays]);
    return game;
}

module.exports = { advanceUntil, startLobbyGame, toBidding, finishGame, playLobbyGame, humanConnected };
