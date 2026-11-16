/**
 * Drive a lobby-born casual game to its gameEnd quickly, through the real
 * handlers (play again tests: server/socket/__tests__/playAgain.test.js,
 * contract.test.js). The lobby starts through playerReady (LOBBY_START_MS,
 * countdown, draw), the humans draw, and at BIDDING of the first hand the
 * humans go /lazy and that hand becomes the last one (finishGame). Fake
 * timers and a mocked database required.
 * The handlers' promises (ready, draw, play) settle only while timers run,
 * so they are collected and awaited at the end, never in between.
 */

'use strict';

const gameManager = require('../game/GameManager');
const gameHandlers = require('../socket/gameHandlers');
const lobbyHandlers = require('../socket/lobbyHandlers');
const chatHandlers = require('../socket/chatHandlers');
const { Phase } = require('../game/GamePhase');
const { Controller, Presence } = require('../game/SeatState');

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

/**
 * From BIDDING of the first hand: every human still at a human seat goes
 * /lazy (a lazy owner at its seat stays a connected seat owner, in voice),
 * and the hand is relabelled the last one (currentHand 13: the next hand
 * size after it is 0; cardIndex moved on by the 4 cards it lacks), so the bots play this hand out and handleHandComplete
 * takes its real game-over path. No forcePhase: test:contract also runs
 * with NODE_ENV=production. Resolves once the game has ended (gameEnd
 * sent, retired) with the chat promises.
 */
async function finishGame(io, game) {
    const chats = [];
    for (const s of game.seatList()) {
        if (s.controller !== Controller.HUMAN || s.presence !== Presence.CONNECTED) continue;
        const sock = io.sockets.sockets.get(s.ownerSocketId);
        if (sock) chats.push(chatHandlers.chatMessage(sock, io, { message: '/lazy' }));
    }
    // A hand ends when cardIndex reaches currentHand * 4 (handleTrickComplete):
    // the 12 cards dealt then count as the 13-card hand's last 12
    game.currentHand = 13;
    game.cardIndex += 4;
    await advanceUntil(() => game.isTerminal(), 500, 600000);
    await jest.advanceTimersByTimeAsync(100);
    return chats;
}

/**
 * startLobbyGame + toBidding + (before) + finishGame, then every handler
 * promise. @returns {Promise<GameState>}
 */
async function playLobbyGame(io, table, { before = null } = {}) {
    const { game, pending } = await startLobbyGame(io, table);
    const draws = await toBidding(io, game, table);
    if (before) await before(game);
    const plays = await finishGame(io, game);
    await Promise.all([...pending, ...draws, ...plays]);
    return game;
}

module.exports = { advanceUntil, startLobbyGame, toBidding, finishGame, playLobbyGame };
