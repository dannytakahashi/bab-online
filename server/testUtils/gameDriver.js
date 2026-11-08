/**
 * Helpers for driving real socket handlers in Jest: a stub io that records
 * every emit (and tracks room membership, so leaving a room is observable),
 * stub sockets, and legal-move pickers for bids and cards.
 */

const { isLegalMove, isTrumpTight, isValidBid } = require('../game/rules');

/**
 * Stub Socket.IO server. `log` gets {to, event, data, seq} for every emit;
 * `rooms` maps room name -> Set of socket ids joined through stub sockets.
 */
function makeIo(log, rooms = new Map()) {
    const io = {
        rooms,
        to: (room) => ({ emit: (event, data) => log.push({ to: room, event, data }) }),
        emit: (event, data) => log.push({ to: '*', event, data }),
        sockets: { sockets: new Map() },
    };
    return io;
}

/**
 * Stub socket. With `io`, the socket is registered in io.sockets.sockets and
 * join/leave update io.rooms.
 */
function makeSocket(id, log, io = null) {
    const socket = {
        id,
        data: {},
        emit: (event, data) => log.push({ to: `self:${id}`, event, data }),
        join(room) {
            if (!io) return;
            if (!io.rooms.has(room)) io.rooms.set(room, new Set());
            io.rooms.get(room).add(id);
        },
        leave(room) {
            if (!io) return;
            io.rooms.get(room)?.delete(id);
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

module.exports = { makeIo, makeSocket, events, legalCards, legalBids, mulberry32 };
