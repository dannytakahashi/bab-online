/**
 * Cut for a buck test kit (needs the calling test to jest.mock('../database')
 * with a memoryDb and to use fake timers, like tournamentDriver.js).
 *
 *   giveCap(socket[, caps])     the clientHello caps on a stub socket
 *   setupCut(n, {capable, rounds})  n members (the first `capable` with the
 *                               cap cutForABuck; all by default), every
 *                               member ready, `rounds` rounds (1 default)
 *   playToCut(ctx)              play every round (bots, /lazy) until the
 *                               tournament leaves round_active
 *   toStage(ctx, stage)         advance fake time until t.cut.stage is it
 *   deckOf('9h', '3s', ...)     a first deck: those cards, then the rest of
 *                               one full deck in Deck order
 *   socketOf(ctx, username)     the member's stub socket
 */

'use strict';

const { fullDecks, cardKey } = require('../game/cutForABuck');
const cutForABuck = require('../socket/cutForABuck');
const tournamentHandlers = require('../socket/tournamentHandlers');
const { setupTournament, playTournament, advanceUntil, creatorSocket } = require('./tournamentDriver');

function giveCap(socket, caps = ['cutForABuck']) {
    socket.data.client = { client: 'web', version: 'test', build: null, caps: [...caps] };
}

const SUIT = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
function card(code) {
    if (code === 'HI' || code === 'LO') return { suit: 'joker', rank: code };
    const suit = SUIT[code.slice(-1)];
    let rank = code.slice(0, -1);
    if (rank === 'T') rank = '10';
    return { suit, rank };
}

function deckOf(...codes) {
    const head = codes.map(card);
    const used = new Map();
    for (const x of head) used.set(cardKey(x), (used.get(cardKey(x)) || 0) + 1);
    const rest = [];
    for (const x of fullDecks(1)) {
        const k = cardKey(x);
        if (used.get(k)) used.set(k, used.get(k) - 1);
        else rest.push(x);
    }
    return [...head, ...rest];
}

async function setupCut(n, { capable = n, rounds = 1, extraCaps = [] } = {}) {
    const ctx = await setupTournament(n);
    ctx.sockets.forEach((s, i) => { if (i < capable) giveCap(s, ['cutForABuck', ...extraCaps]); });
    if (rounds !== ctx.t.totalRounds) tournamentHandlers.setTournamentRounds(creatorSocket(ctx), ctx.io, { totalRounds: rounds });
    return ctx;
}

async function playToCut(ctx, hooks) {
    await playTournament(ctx, hooks);
    return ctx;
}

async function toStage(ctx, stage, cap = 120000) {
    await advanceUntil(() => ctx.t.cut?.stage === stage || ctx.t.phase !== 'cut', 50, cap);
}

const socketOf = (ctx, username) => ctx.sockets[ctx.usernames.indexOf(username)];

/** Each alive member with a socket draws (slot null unless given). */
function drawAll(ctx, slots = {}) {
    const e = ctx.t.cut.engine;
    for (const u of e.aliveList()) {
        if (e.pending.has(u)) continue;
        const s = socketOf(ctx, u);
        if (s) cutForABuck.draw(s, ctx.io, { round: e.round, slot: slots[u] ?? null });
    }
}

module.exports = { giveCap, card, deckOf, setupCut, playToCut, toStage, socketOf, drawAll };
