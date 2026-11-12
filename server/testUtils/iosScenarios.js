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
 *   scenarioHumans(w, rec, seed)  4 humans: a spectator joins mid-draw, an
 *                                 all-zero redeal, a bore, rejects (out of
 *                                 turn, card not in hand, illegal card, bid in
 *                                 the wrong stage, double play, a Joi-invalid
 *                                 play), a rejoin mid-bid, /lazy -> /active, a
 *                                 resignable seat resigned
 *   scenarioPresence(w, rec, seed) 4 humans: two seats resignable at once,
 *                                 then a third player rejoins (replayPresenceTo
 *                                 re-sends playerDisconnected for both), a lazy
 *                                 owner drops, rejoins as lazy watcher and goes
 *                                 /active; both resignable seats are resigned
 *   scenarioTournament(w, rec, seed) 1 human + 3 bots, rounds 1 and 2 of a
 *                                 tournament (tournamentGameAssignment then
 *                                 allPlayersReady, a fresh seq per table, the
 *                                 snapshot's tournament field); a spectator
 *                                 watches round 1 via spectateTournamentGame
 *
 * Checkpoints are dense: every loop step that changed a viewer's log (draw
 * phase, bot turns, trick resolving, presence moments), except between a
 * gameStart and its updateTurn (the recorder skips those).
 *
 * The games use the real BotStrategy, so a change to bot decisions or RNG
 * use (not only to event shapes / game-log text) changes the recordings.
 */

'use strict';

const gameManager = require('../game/GameManager');
const gameHandlers = require('../socket/gameHandlers');
const chatHandlers = require('../socket/chatHandlers');
const reconnectHandlers = require('../socket/reconnectHandlers');
const tournamentHandlers = require('../socket/tournamentHandlers');
const mainRoomHandlers = require('../socket/mainRoomHandlers');
const lobbyHandlers = require('../socket/lobbyHandlers');
const { asyncHandler } = require('../socket/errorHandler');
const { Phase } = require('../game/GamePhase');
const pacing = require('../game/pacing');
const { legalCards, legalBids, mulberry32 } = require('./gameDriver');
const { liveTables } = require('./tournamentDriver');
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

/** Checkpoint every watched viewer whose log grew (not between a gameStart and its updateTurn). */
function dense(rec, game) {
    if (game && !game.isTerminal()) rec.checkpoint(game);
}

/**
 * The play loop's checkpoint: dense inside the scenario's windows (the hands
 * of its scripted steps), elsewhere only on `sid`'s open turns (handComplete
 * is always checkpointed by the recorder). Keeps the fixtures a few MB.
 */
function loopCheckpoint(rec, game, sid, inWindow) {
    if (inWindow) return dense(rec, game);
    if (turnOpen(game, rec) && game.seat(game.currentTurn).ownerSocketId === sid) rec.checkpoint(game);
}

/** Advance in 100 ms steps until `pred`, checkpointing each step. */
async function advanceDense(rec, game, pred, cap = 120000) {
    for (let t = 0; !pred(); t += 100) {
        if (t >= cap) throw new Error('advanceDense: condition never met');
        await jest.advanceTimersByTimeAsync(100);
        dense(rec, game);
    }
}

/** The draw, checkpointed after every draw and pacing step; `afterFirst` runs after the first draw. */
async function playDraw(a, rec, game, drawers, afterFirst) {
    dense(rec, game);
    for (const [i, s] of drawers.entries()) {
        a.draw(s);
        await tick();
        dense(rec, game);
        if (i === 0 && afterFirst) {
            afterFirst();
            await tick();
            dense(rec, game);
        }
    }
    await advanceDense(rec, game, () => game.stage === Phase.BIDDING);
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
    await playDraw(a, rec, game, [human]);

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
        loopCheckpoint(rec, game, me.id, hands === 2 || hands === 4);
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
    await playDraw(a, rec, game, socks, () => {
        const spec = w.user('ios-spec', 'ios_fan', { pic: 12 });
        usernames[spec.id] = 'ios_fan';
        rec.watch('spectator', spec.id, 'spectator');
        mainRoomHandlers.joinAsSpectator(spec, w.io, { gameId: game.gameId });
    });

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
            // A Joi-invalid play: the server answers serverError {code: 'validation'}
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

        // windows: the redeal + rejects, the rejoin mid-bid, the /lazy and /active biddings, the resign
        loopCheckpoint(rec, game, socks[0].id, hands === 1 || hands === 2 || hands === 5 || (hands !== 1 && hands !== 2 && hands <= 4 && stage === Phase.BIDDING));
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

async function scenarioPresence(w, rec, seed) {
    const pick = mulberry32(seed * 7919 + 4);
    const a = iosActions(w, rec);
    const names = ['ios_ada', 'ios_bo', 'ios_cy', 'ios_di'];
    const socks = names.map((n, i) => w.user(`ios-q${i + 1}`, n, { pic: 30 + i }));
    const usernames = {};
    socks.forEach((s, i) => {
        usernames[s.id] = names[i];
        rec.watch(`seat${i + 1}`, s.id, 'seat');
    });
    const game = await lobbyStart(w, rec, socks);
    await playDraw(a, rec, game, socks, () => {
        const spec = w.user('ios-qspec', 'ios_gus', { pic: 40 });
        usernames[spec.id] = 'ios_gus';
        rec.watch('spectator', spec.id, 'spectator');
        mainRoomHandlers.joinAsSpectator(spec, w.io, { gameId: game.gameId });
    });
    await advanceDense(rec, game, () => turnOpen(game, rec));
    const label = new Map(socks.map((s, i) => [s.id, `seat${i + 1}`]));
    const sockAt = (pos) => w.sockets.get(game.seat(pos).ownerSocketId);
    const rejoin = async (pos, id, as) => {
        const username = game.seat(pos).ownerUsername;
        const s = w.user(id, username, { db: false });
        usernames[s.id] = username;
        rec.watch(as, s.id, 'rejoin');
        await reconnectHandlers.rejoinGame(s, w.io, { gameId: game.gameId, username });
        await tick();
        dense(rec, game);
        return s;
    };
    const drop = async (pos) => {
        const s = sockAt(pos);
        rec.close(label.get(s.id));
        await w.kill(s);
        await tick();
        dense(rec, game);
    };

    // Seats 2 and 4 drop and run out of grace: both resignable, one offered
    await drop(2);
    await jest.advanceTimersByTimeAsync(1000);
    await drop(4);
    for (let t = 0; t < 65000; t += 5000) {
        await jest.advanceTimersByTimeAsync(5000);
        dense(rec, game);
    }
    if (game.resignablePositions().length !== 2) throw new Error('presence scenario: expected two resignable seats');
    // Seat 1 drops and rejoins: replayPresenceTo re-sends playerDisconnected for 2 and 4, then one offer
    await drop(1);
    const s1 = await rejoin(1, 'ios-q1-r1', 'seat1-rejoin');
    // Seat 3: /lazy at the seat, drops, rejoins as the lazy watcher, /active
    a.chat(sockAt(3), '/lazy');
    await tick();
    dense(rec, game);
    await drop(3);
    const s3 = await rejoin(3, 'ios-q3-r1', 'seat3-rejoin');
    await jest.advanceTimersByTimeAsync(2000);
    dense(rec, game);
    a.chat(s3, '/active');
    await tick();
    dense(rec, game);
    // Resign both (the offered one first)
    for (let k = 0; k < 2; k++) {
        const left = game.resignablePositions();
        const pos = left.includes(game.offerPos) ? game.offerPos : left[0];
        rec.recordC2S(s1.id, 'forceResign', { position: pos });
        await forceResignWrapped(s1, w.io, { position: pos });
        await tick();
        dense(rec, game);
    }
    if (game.resignablePositions().length !== 0) throw new Error('presence scenario: seats left unresigned');

    let guard = 0;
    while (!game.isTerminal() && guard++ < 20000) {
        loopCheckpoint(rec, game, s1.id, game.handStats.totalHands === 0);  // the hand the presence steps happened in
        if (turnOpen(game, rec) && humanAt(game, game.currentTurn)) {
            act(w, a, game, pick);
            await tick();
            continue;
        }
        await jest.advanceTimersByTimeAsync(250);
    }
    await finish(w, rec, game);
    return { game, usernames };
}

async function scenarioTournament(w, rec, seed) {
    const pick = mulberry32(seed * 7919 + 5);
    const a = iosActions(w, rec);
    const human = w.user('ios-t1', 'ios_tia', { pic: 14 });
    const usernames = { [human.id]: 'ios_tia' };
    rec.watch('seat1', human.id, 'seat');
    tournamentHandlers.createTournament(human, w.io);
    const t = gameManager.getPlayerTournament(human.id);
    tournamentHandlers.tournamentReady(human, w.io);
    let game = null;
    for (let round = 1; round <= 2; round++) {
        if (round === 1) {
            w.pending.push(tournamentHandlers.beginTournament(human, w.io));
        } else {
            if (t.phase !== 'between_rounds') throw new Error(`tournament scenario: phase ${t.phase} after round 1`);
            tournamentHandlers.tournamentReady(human, w.io);
            w.pending.push(tournamentHandlers.beginNextRound(human, w.io));
        }
        for (let ms = 0; !(liveTables(t).length > 0 && liveTables(t)[0].stage === Phase.DRAWING); ms += 100) {
            if (ms > 120000) throw new Error('tournament scenario: no table');
            await jest.advanceTimersByTimeAsync(100);
        }
        game = liveTables(t)[0];
        await playDraw(a, rec, game, [human]);
        let spectated = false;
        let guard = 0;
        while (!game.isTerminal() && guard++ < 20000) {
            if (round === 1 && !spectated && game.handStats.totalHands === 1 && game.stage === Phase.PLAYING) {
                spectated = true;
                const spec = w.user('ios-tspec', 'ios_tom', { pic: 15 });
                usernames[spec.id] = 'ios_tom';
                rec.watch('spectator', spec.id, 'spectator');
                tournamentHandlers.spectateTournament(spec, w.io, { tournamentId: t.tournamentId });
                tournamentHandlers.spectateTournamentGame(spec, w.io, { gameId: game.gameId });
                await tick();
            }
            // windows: round 1's spectated hand and its last hand, round 2's first hand
            const h = game.handStats.totalHands;
            loopCheckpoint(rec, game, human.id, round === 1 ? (h === 1 || h === 12) : h === 0);
            if (turnOpen(game, rec) && game.seat(game.currentTurn).ownerSocketId === human.id && humanAt(game, game.currentTurn)) {
                act(w, a, game, pick);
                await tick();
                continue;
            }
            await jest.advanceTimersByTimeAsync(250);
        }
        if (round === 1) {
            if (!spectated) throw new Error('tournament scenario: no spectator');
            rec.close('spectator'); // its table is over: it watches nothing in round 2
            for (let ms = 0; t.phase !== 'between_rounds'; ms += 100) {
                if (ms > 60000) throw new Error(`tournament scenario: stuck in ${t.phase}`);
                await jest.advanceTimersByTimeAsync(100);
            }
        }
    }
    await finish(w, rec, game);
    return { game, usernames };
}

module.exports = { scenarioBots, scenarioHumans, scenarioPresence, scenarioTournament, iosActions };

