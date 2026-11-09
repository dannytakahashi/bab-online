/**
 * Real-handler games recorded for the iOS reducer tests (item 23; dev/test
 * only). Every human action goes through errorHandler.asyncHandler with the
 * exact payloads the iOS app sends (GameEmitter): playCard {card:{suit,rank},
 * position}, playerBid {bid: Int | 'B'..'4B', position}. The caller must
 * jest.mock('../database') with a memoryDb, use fake timers and seed
 * Math.random (iosEventLogs.test.js).
 *
 *   scenarioBots(w, rec, seed)    1 human + 3 lobby bots, 13 hands; a spectator
 *                                 joins in hand 3; in hand 5 the human's
 *                                 socket dies mid-trick and rejoins
 *   scenarioHumans(w, rec, seed)  4 humans: an all-zero redeal, a bore,
 *                                 rejects (out of turn, card not in hand,
 *                                 illegal card, bid in the wrong stage, double
 *                                 play, a Joi-invalid play), a rejoin mid-bid,
 *                                 /lazy -> /active, a resignable seat resigned
 */

'use strict';

const gameManager = require('../game/GameManager');
const gameHandlers = require('../socket/gameHandlers');
const chatHandlers = require('../socket/chatHandlers');
const reconnectHandlers = require('../socket/reconnectHandlers');
const mainRoomHandlers = require('../socket/mainRoomHandlers');
const lobbyHandlers = require('../socket/lobbyHandlers');
const { asyncHandler } = require('../socket/errorHandler');
const { Phase } = require('../game/GamePhase');
const pacing = require('../game/pacing');
const { legalCards, legalBids, mulberry32 } = require('./gameDriver');
const { advanceUntil } = require('./tournamentDriver');
const { cardNotIn } = require('./contractScenarios');

const tick = () => jest.advanceTimersByTimeAsync(0);
const playCardWrapped = asyncHandler('playCard', gameHandlers.playCard);
const playerBidWrapped = asyncHandler('playerBid', gameHandlers.playerBid);
const forceResignWrapped = asyncHandler('forceResign', gameHandlers.forceResign);

/** The iOS client's actions, recorded as c2s entries in the actor's log. */
function iosActions(w, rec) {
    return {
        play(s, card, position) {
            const data = { card: { suit: card.suit, rank: card.rank }, position };
            rec.recordC2S(s.id, 'playCard', data);
            const p = playCardWrapped(s, w.io, data);
            w.pending.push(p);
            return p;
        },
        bid(s, bid, position) {
            // GameEmitter.playerBid sends an Int, playerBidBore the bore string
            const data = { bid: /^\d+$/.test(bid) ? Number(bid) : bid, position };
            rec.recordC2S(s.id, 'playerBid', data);
            const p = playerBidWrapped(s, w.io, data);
            w.pending.push(p);
            return p;
        },
        draw(s) {
            rec.recordC2S(s.id, 'draw', { num: 0 });
            const p = gameHandlers.draw(s, w.io, { num: 0 });
            w.pending.push(p);
            return p;
        },
        chat(s, message) {
            rec.recordC2S(s.id, 'chatMessage', { message });
            chatHandlers.chatMessage(s, w.io, { message });
        },
    };
}

const turnOpen = (game, rec) => (game.stage === Phase.BIDDING || game.stage === Phase.PLAYING) && !rec.awaitingTurn;
const ownerSock = (w, game, pos) => w.sockets.get(game.seat(pos).ownerSocketId);
const humanAt = (game, pos) => game.seat(pos).controller === 'human' && game.seat(pos).presence === 'connected';

/**
 * Checkpoint when `sid`'s seat has an open turn (bid, lead or follow; the
 * moments a client must show exactly the server's table). The recorder adds
 * one after every handComplete. Kept to one seat's turns so the fixtures
 * stay small.
 */
function maybeCheckpoint(rec, game, sid) {
    if (!turnOpen(game, rec) || game.seat(game.currentTurn).ownerSocketId !== sid) return;
    rec.checkpoint(game);
}

/** One ordinary action for the human seat on turn (seeded choice). */
function act(w, act, game, pick, { bidFor } = {}) {
    const pos = game.currentTurn;
    const s = ownerSock(w, game, pos);
    if (game.stage === Phase.BIDDING) {
        const bid = (bidFor && bidFor(game, pos)) || (() => {
            const numeric = legalBids(game).filter((b) => /^\d+$/.test(b) && Number(b) <= 4);
            return numeric[Math.floor(pick() * numeric.length)] || '0';
        })();
        return act.bid(s, bid, pos);
    }
    const legal = legalCards(game, s.id);
    return act.play(s, legal[Math.floor(pick() * legal.length)], pos);
}

async function lobbyStart(w, rec, socks, { bots = 0 } = {}) {
    mainRoomHandlers.createLobby(socks[0], w.io, { name: 'iOS table' });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    for (let i = 0; i < bots; i++) lobbyHandlers.addBot(socks[0], w.io);
    const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    w.pending.push(...starting);
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    const game = gameManager.getPlayerGame(socks[0].id);
    await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
    return game;
}

async function finish(w, rec, game) {
    if (game.stage !== Phase.ENDED) {
        throw new Error('iOS scenario did not finish: ' + JSON.stringify({ stage: game.stage, hands: game.handStats.totalHands, turn: game.currentTurn }));
    }
    await Promise.all(w.pending);
    await jest.advanceTimersByTimeAsync(5000);
    rec.finalize();
}

async function scenarioBots(w, rec, seed) {
    const pick = mulberry32(seed * 7919 + 1);
    const a = iosActions(w, rec);
    const human = w.user('ios-h1', 'ios_ann', { pic: 11 });
    rec.watch('seat1', human.id, 'seat');
    const game = await lobbyStart(w, rec, [human], { bots: 3 });
    a.draw(human);
    await advanceUntil(() => game.stage === Phase.BIDDING, 100);

    const done = {};
    let me = human;
    let guard = 0;
    while (!game.isTerminal() && guard++ < 20000) {
        const hands = game.handStats.totalHands;
        if (hands === 2 && game.stage === Phase.BIDDING && !done.spectator) {
            done.spectator = true;
            const spec = w.user('ios-spec', 'ios_fan', { pic: 12 });
            rec.watch('spectator', spec.id, 'spectator');
            mainRoomHandlers.joinAsSpectator(spec, w.io, { gameId: game.gameId });
        }
        if (hands === 4 && game.stage === Phase.PLAYING && game.playedCardsIndex >= 1 && !done.rejoin) {
            done.rejoin = true;
            rec.close('seat1');
            await w.kill(me);
            me = w.user('ios-h1-r1', 'ios_ann', { db: false });
            rec.watch('seat1-rejoin', me.id, 'rejoin');
            await reconnectHandlers.rejoinGame(me, w.io, { gameId: game.gameId, username: 'ios_ann' });
        }
        maybeCheckpoint(rec, game, me.id);
        if (turnOpen(game, rec) && game.seat(game.currentTurn).ownerSocketId === me.id && humanAt(game, game.currentTurn)) {
            act(w, a, game, pick);
            await tick();
            continue;
        }
        await jest.advanceTimersByTimeAsync(250);
    }
    if (!done.spectator || !done.rejoin) throw new Error('bots scenario: scripted steps missing ' + JSON.stringify(done));
    await finish(w, rec, game);
    return { game, usernames: { [human.id]: 'ios_ann', 'ios-h1-r1': 'ios_ann', 'ios-spec': 'ios_fan' } };
}

async function scenarioHumans(w, rec, seed) {
    const pick = mulberry32(seed * 7919 + 2);
    const a = iosActions(w, rec);
    const names = ['ios_bea', 'ios_cal', 'ios_dee', 'ios_eli'];
    const socks = names.map((n, i) => w.user(`ios-p${i + 1}`, n, { pic: 20 + i }));
    const usernames = {};
    socks.forEach((s, i) => {
        usernames[s.id] = names[i];
        rec.watch(`seat${i + 1}`, s.id, 'seat');
    });
    const labelOf = new Map(socks.map((s, i) => [s.id, `seat${i + 1}`]));
    const game = await lobbyStart(w, rec, socks);
    for (const s of socks) a.draw(s);
    await advanceUntil(() => game.stage === Phase.BIDDING, 100);

    const done = {};
    let zeroBids = 0;
    let guard = 0;
    const bidFor = (g) => {
        if (zeroBids < 4) { zeroBids++; return '0'; }
        if (!done.bore && legalBids(g).includes('B')) { done.bore = true; return 'B'; }
        return null;
    };
    while (!game.isTerminal() && guard++ < 20000) {
        const hands = game.handStats.totalHands;
        const stage = game.stage;

        // Rejects at hand 2, while a human seat is on turn mid-trick
        if (hands === 1 && stage === Phase.PLAYING && turnOpen(game, rec) && !done.rejects && humanAt(game, game.currentTurn)) {
            done.rejects = true;
            const pos = game.currentTurn;
            const s = ownerSock(w, game, pos);
            const other = [1, 2, 3, 4].find((p) => p !== pos && humanAt(game, p));
            const os = ownerSock(w, game, other);
            await a.play(os, game.getHand(os.id)[0], other); // not_your_turn
            await a.play(s, cardNotIn(game.getHand(s.id)), pos); // Card not in hand: actionRejected + restorePlayerState
            const legal = legalCards(game, s.id);
            const illegal = game.getHand(s.id).find((c) => !legal.some((l) => l.suit === c.suit && l.rank === c.rank));
            if (illegal) await a.play(s, illegal, pos);
            await a.bid(s, '1', pos); // a bid while playing
            // A Joi-invalid play: the server answers 'error'
            rec.recordC2S(s.id, 'playCard', { card: { suit: 'stars', rank: 'Z' }, position: pos });
            await playCardWrapped(s, w.io, { card: { suit: 'stars', rank: 'Z' }, position: pos });
            // A double play: the second is refused, the first card stays played
            const [card] = legal;
            a.play(s, card, pos);
            a.play(s, card, pos);
            await tick();
            continue;
        }
        // Rejoin mid-bid at hand 3
        if (hands === 2 && stage === Phase.BIDDING && turnOpen(game, rec) && !done.rejoin && game.playerBids.some((b) => b != null)) {
            done.rejoin = true;
            const old = ownerSock(w, game, 2);
            rec.close(labelOf.get(old.id));
            await w.kill(old);
            const back = w.user('ios-p2-r1', game.seat(2).ownerUsername, { db: false });
            usernames[back.id] = game.seat(2).ownerUsername;
            rec.watch('seat2-rejoin', back.id, 'rejoin');
            await reconnectHandlers.rejoinGame(back, w.io, { gameId: game.gameId, username: game.seat(2).ownerUsername });
            await tick();
            continue;
        }
        // /lazy at hand 4, /active at hand 5 (seat 3, at the seat)
        if (hands === 3 && stage === Phase.BIDDING && !done.lazy) {
            done.lazy = true;
            a.chat(ownerSock(w, game, 3), '/lazy');
            await tick();
            continue;
        }
        if (hands === 4 && stage === Phase.BIDDING && !done.active) {
            done.active = true;
            a.chat(ownerSock(w, game, 3), '/active');
            await tick();
            continue;
        }
        // Hand 6: seat 4 drops, becomes resignable and is resigned by seat 1
        if (hands === 5 && stage === Phase.BIDDING && !done.resign) {
            done.resign = true;
            const s4 = ownerSock(w, game, 4);
            rec.close(labelOf.get(s4.id));
            await w.kill(s4);
            await jest.advanceTimersByTimeAsync(61000);
            const s1 = ownerSock(w, game, 1);
            rec.recordC2S(s1.id, 'forceResign', { position: 4 });
            await forceResignWrapped(s1, w.io, { position: 4 });
            await tick();
            continue;
        }

        maybeCheckpoint(rec, game, socks[0].id);
        if (turnOpen(game, rec) && humanAt(game, game.currentTurn)) {
            act(w, a, game, pick, { bidFor });
            await tick();
            continue;
        }
        await jest.advanceTimersByTimeAsync(250);
    }
    for (const k of ['bore', 'rejects', 'rejoin', 'lazy', 'active', 'resign']) {
        if (!done[k]) throw new Error(`humans scenario: '${k}' never happened ` + JSON.stringify(done));
    }
    await finish(w, rec, game);
    return { game, usernames };
}

module.exports = { scenarioBots, scenarioHumans, iosActions };
