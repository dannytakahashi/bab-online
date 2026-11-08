/**
 * Helpers for driving real socket handlers in Jest: a stub io that records
 * every emit (and tracks room membership, so leaving a room is observable),
 * stub sockets, and legal-move pickers for bids and cards.
 */

const { isLegalMove, isTrumpTight, isValidBid } = require('../game/rules');
const { instrument } = require('./contractCheck');

/**
 * Stub Socket.IO server. `log` gets {to, event, data, at} for every emit;
 * `rooms` maps room name -> Set of socket ids joined through stub sockets.
 */
function makeIo(log, rooms = new Map()) {
    // Every emit recorded in `log` is checked against the socket contract
    // (contractCheck.js; contractGuard.js fails the test on a violation)
    instrument(log);
    const io = {
        rooms,
        to: (room) => ({ emit: (event, data) => log.push({ to: room, event, data, at: Date.now() }) }),
        emit: (event, data) => log.push({ to: '*', event, data, at: Date.now() }),
        sockets: { sockets: new Map() },
    };
    return io;
}

/**
 * Stub socket. With `io`, the socket is registered in io.sockets.sockets and
 * join/leave update io.rooms.
 */
function makeSocket(id, log, io = null) {
    instrument(log);
    const socket = {
        id,
        data: {},
        emit: (event, data) => log.push({ to: `self:${id}`, event, data, at: Date.now() }),
        // socket.to(room).emit: everyone in the room but this socket
        to: (room) => ({ emit: (event, data) => log.push({ to: room, except: id, event, data, at: Date.now() }) }),
        join(room) {
            if (!io) return;
            if (!io.rooms.has(room)) io.rooms.set(room, new Set());
            io.rooms.get(room).add(id);
        },
        leave(room) {
            if (!io) return;
            io.rooms.get(room)?.delete(id);
        },
        // Like socket.io: false once the socket is gone from io.sockets
        get connected() {
            return io ? io.sockets.sockets.has(id) : true;
        },
    };
    if (io) io.sockets.sockets.set(id, socket);
    return socket;
}

const events = (log, event) => log.filter((l) => l.event === event);

/** Every card `position` may legally play right now (mirrors playCard). */
function legalCards(game, socketId) {
    const position = game.getPositionBySocketId(socketId);
    const hand = game.getHand(socketId);
    const leading = game.playedCardsIndex === 0;
    return hand.filter((card, i) => {
        const remaining = hand.filter((_, j) => j !== i);
        if (leading) {
            return isLegalMove(card, remaining, card, true, game.trump, game.isTrumpBroken, position, position) ||
                isTrumpTight([card, ...remaining], game.trump);
        }
        return isLegalMove(card, remaining, game.leadCard, false, game.trump, game.isTrumpBroken, position, game.leadPosition);
    });
}

/** Every bid currently valid for the seat on turn. */
function legalBids(game) {
    const all = ['B', '2B', '3B', '4B'];
    for (let n = 0; n <= game.currentHand; n++) all.push(String(n));
    return all.filter((b) => isValidBid(b, game.playerBids, game.currentHand));
}

/** Seeded PRNG (mulberry32). */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function rand() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Register `bot` for seat `pos` and map it to the game (as createSeatBot does). */
function attachBot(game, pos, bot) {
    const { botController } = require('../game/bot');
    const gameManager = require('../game/GameManager');
    bot.position = pos;
    if (bot.pic == null) bot.pic = 1;
    botController.registerBot(game.gameId, bot);
    gameManager.playerGames.set(bot.socketId, game.gameId);
}

/**
 * Fixture: seat `pos` (a human seat) is lazy, played by `bot`. view 'seat'
 * keeps the owner's socket as its owner socket (as /lazy does); 'watch'
 * takes `ownerSocketId`; presence 'away' has no owner socket.
 */
function lazySeat(game, pos, bot, { view = 'seat', ownerSocketId, presence = 'connected' } = {}) {
    const s = game.seat(pos);
    attachBot(game, pos, bot);
    const owner = presence === 'connected' ? (ownerSocketId ?? s.ownerSocketId) : null;
    return game.forceSeat(pos, {
        controller: 'lazyBot', presence, bot,
        ownerSocketId: owner, ownerView: presence === 'connected' ? view : null,
    });
}

/**
 * Fixture: seat `pos` was resigned to `bot` (owner away by default). The
 * owner's old socket is unmapped, as a real resign leaves it.
 */
function resignedSeat(game, pos, bot, { presence = 'away', ownerSocketId = null } = {}) {
    const gameManager = require('../game/GameManager');
    const s = game.seat(pos);
    if (s?.ownerSocketId && gameManager.playerGames.get(s.ownerSocketId) === game.gameId) {
        gameManager.playerGames.delete(s.ownerSocketId);
    }
    attachBot(game, pos, bot);
    return game.forceSeat(pos, {
        controller: 'resignBot', presence, bot,
        ownerSocketId: presence === 'connected' ? ownerSocketId : null,
        ownerView: presence === 'connected' ? 'watch' : null,
    });
}

module.exports = { makeIo, makeSocket, events, legalCards, legalBids, mulberry32, lazySeat, resignedSeat };
