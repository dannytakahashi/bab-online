/**
 * Shared real-handler scenarios for the contract tests (contract.test.js,
 * wireCompat.test.js, contractFixtures.test.js). The calling test must
 * jest.mock('../database') with a memoryDb and use fake timers.
 */

'use strict';

const gameManager = require('../game/GameManager');
const gameHandlers = require('../socket/gameHandlers');
const chatHandlers = require('../socket/chatHandlers');
const queueHandlers = require('../socket/queueHandlers');
const reconnectHandlers = require('../socket/reconnectHandlers');
const mainRoomHandlers = require('../socket/mainRoomHandlers');
const lobbyHandlers = require('../socket/lobbyHandlers');
const Deck = require('../game/Deck');
const { Phase } = require('../game/GamePhase');
const { botController } = require('../game/bot');
const { makeIo, makeSocket, events, legalCards, legalBids, mulberry32 } = require('./gameDriver');
const { advanceUntil } = require('./tournamentDriver');
const contractCheck = require('./contractCheck');

const SNAPSHOT_CARRIERS = new Set(['rejoinSuccess', 'restorePlayerState', 'actionRejected', 'spectatorJoined', 'stateSnapshot']);
const DELTA_EVENTS = new Set(['playerDrew', 'bidReceived', 'doneBidding', 'rainbow', 'cardPlayed', 'trickComplete',
    'handComplete', 'gameStart', 'destroyHands']);

/**
 * Snapshot invariants (contract/README.md R3/R4) over every emit while
 * active: for each snapshot S delivered to socket X, the next DELTA event
 * X receives for that game must not already be reflected in S (no
 * double-apply), every delivered snapshot stays equal to its wire form
 * (the builder never shares live state), and no snapshot string is a
 * socket id or a bot: id. Presence events may already be in S (R3).
 * Returns {stop() -> {checked, delivered, failures}}.
 */
function watchSnapshots(w) {
    const pending = new Map();      // socketId -> wire snapshot
    const delivered = [];           // {live, wire, to}
    const failures = [];
    let checked = 0;
    const recipients = (entry) => {
        const to = String(entry.to);
        if (to.startsWith('self:')) return [to.slice(5)];
        if (to.startsWith('game:') || to.startsWith('tournament:')) {
            const members = entry.members || [...(w.io.rooms.get(to) || [])];
            return members.filter((m) => m !== entry.except);
        }
        return [to];
    };
    const gameIdOf = (entry, wire) => (String(entry.to).startsWith('game:') ? String(entry.to).slice(5) : wire && wire.gameId);
    const rule = (event, d, S) => {
        switch (event) {
            case 'cardPlayed': return !S.trick.cards.some((c) => c.position === d.position);
            case 'bidReceived': return S.bids.byPosition[d.position - 1] === null;
            case 'playerDrew': return !!S.draw && d.drawOrder === S.draw.drawn.length + 1;
            case 'trickComplete': return S.trick.cards.length === 4;
            case 'handComplete': return S.stage === Phase.HAND_RESOLVING;
            case 'gameStart': return ['DEALING', 'TEAMS_ANNOUNCED', 'HAND_RESOLVING', 'REDEAL'].includes(S.stage) ||
                (S.stage === Phase.BIDDING && S.bids.byPosition.every((b) => b === null || b === '0'));
            default: return true;
        }
    };
    const off = contractCheck.onEmit((entry, wire) => {
        const { event } = entry;
        if (SNAPSHOT_CARRIERS.has(event) && wire && wire.snapshot) {
            for (const x of recipients(entry)) pending.set(x, wire.snapshot);
            delivered.push({ live: entry.data.snapshot, wire: wire.snapshot, to: entry.to });
            return;
        }
        if (!DELTA_EVENTS.has(event)) return;
        const gid = gameIdOf(entry, wire);
        for (const x of recipients(entry)) {
            const S = pending.get(x);
            if (!S || S.gameId !== gid) continue;
            pending.delete(x);
            checked++;
            if (!rule(event, wire, S)) {
                failures.push({ to: x, event, data: wire, stage: S.stage, seq: S.seq, trick: S.trick, byPosition: S.bids.byPosition });
            }
        }
    });
    return {
        stop() {
            off();
            const ids = new Set([...w.sockets.keys()]);
            for (const { live, wire, to } of delivered) {
                if (JSON.stringify(live) !== JSON.stringify(wire)) failures.push({ to, why: 'snapshot changed after delivery' });
                const walk = (v) => {
                    if (typeof v === 'string') {
                        if (ids.has(v) || v.startsWith('bot:')) failures.push({ to, why: `socket id in snapshot: ${v}` });
                    } else if (v && typeof v === 'object') {
                        Object.values(v).forEach(walk);
                    }
                };
                walk(wire);
            }
            return { checked, delivered: delivered.length, failures };
        },
    };
}

/** A stub world: emit log, io, sockets by id, registered users. */
function world(tag) {
    const log = [];
    const io = makeIo(log);
    const sockets = new Map();
    const w = {
        log, io, sockets, pending: [],
        socket(id) {
            const s = makeSocket(id, log, io);
            // authHandlers.disconnectPreviousSocket calls socket.disconnect()
            s.disconnect = () => w.kill(s);
            sockets.set(id, s);
            return s;
        },
        user(id, username, { pic = 7, db = true } = {}) {
            gameManager.registerUser(id, username);
            const users = require('../database').getUsersCollection(); // the test's memoryDb mock
            if (db && !users.docs.some((d) => d.username === username)) {
                users._insert({ username, profilePic: pic });
            }
            return w.socket(id);
        },
        kill(s) {
            io.sockets.sockets.delete(s.id);
            for (const members of io.rooms.values()) members.delete(s.id);
            return queueHandlers.handleDisconnect(s, io);
        },
        tag,
    };
    return w;
}

const tick = () => jest.advanceTimersByTimeAsync(0);
const selfEvents = (w, sid, from = 0) => w.log.slice(from).filter((l) => l.to === `self:${sid}`).map((l) => l.event);

/** Where nothing more may be emitted for `game` once it ended. */
function expectSilentAfterTerminal(w, game) {
    const idx = w.log.findIndex((l) => l.to === game.roomName && (l.event === 'gameEnd' || l.event === 'abortGame'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(w.log.slice(idx + 1).filter((l) => l.to === game.roomName).map((l) => l.event)).toEqual([]);
}

/** Card that is not in `hand` (any of the 54). */
function cardNotIn(hand) {
    const deck = new Deck();
    return deck.cards.find((c) => !hand.some((h) => h.suit === c.suit && h.rank === c.rank));
}

/**
 * F1: a full human game through the lobby (playerReady -> countdown -> draw
 * -> 13 hands -> gameEnd) with an all-zero redeal, a bore, /lazy + /active
 * at the seat, /lazy + a watch-view rejoin + /active, rejects ('Card not in
 * hand' and an illegal card), disconnect -> grace -> resign -> rejoin of
 * the resigned owner, a spectator with chat, bot chat, /leave, a refused
 * rejoin during DRAWING and an accepted one during TEAMS_ANNOUNCED.
 * `hooks.onStep(w, game)` runs every loop step (snapshot requests etc.).
 */
async function playF1({ errorLogs = [], hooks = {}, seed = 8 } = {}) {
    Math.random = mulberry32(seed);
    const w = world('f1');
    if (hooks.onWorld) hooks.onWorld(w);
    const names = ['f1_ann', 'f1_bob', 'f1_cat', 'f1_dan'];
    const socks = names.map((n, i) => w.user(`f1-h${i}`, n));
    const owner = (game, pos) => w.sockets.get(game.seat(pos).ownerSocketId);
    let rejoins = 0;
    const rejoinAs = async (game, username, label) => {
        rejoins++;
        const s = w.user(`f1-${label}-${rejoins}`, username, { db: false });
        await reconnectHandlers.rejoinGame(s, w.io, { gameId: game.gameId, username });
        return s;
    };

    // Lobby
    for (const s of socks) mainRoomHandlers.joinMainRoom(s, w.io);
    mainRoomHandlers.createLobby(socks[0], w.io, { name: 'Contract table' });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    lobbyHandlers.lobbyChat(socks[1], w.io, { message: 'ready when you are' });
    await lobbyHandlers.playerReady(socks[3], w.io);
    lobbyHandlers.playerUnready(socks[3], w.io);
    const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    await jest.advanceTimersByTimeAsync(1500);
    const game = gameManager.getPlayerGame(socks[0].id);
    expect(game.stage).toBe(Phase.CREATED);
    await jest.advanceTimersByTimeAsync(2000);
    expect(game.stage).toBe(Phase.DRAWING);

    // A rejoin during the draw is refused (pinned: §8, items 16/23)
    const early = await rejoinAs(game, names[0], 'draw');
    expect(selfEvents(w, early.id)).toEqual(['rejoinFailed']);
    expect(w.log.find((l) => l.to === `self:${early.id}`).data.reason).toBe('Not a player in this game');

    for (const s of socks) w.pending.push(gameHandlers.draw(s, w.io, { num: 0 }));
    await advanceUntil(() => game.stage === Phase.TEAMS_ANNOUNCED, 50);

    // A rejoin during TEAMS_ANNOUNCED is accepted today (renders as a
    // half-state on v1 clients); the payload must still validate
    const firstPos = game.seatByUsername(names[0]);
    const r0 = await rejoinAs(game, names[0], 'teams');
    expect(game.seat(firstPos).ownerSocketId).toBe(r0.id);
    await advanceUntil(() => game.stage === Phase.BIDDING, 50);

    const done = {};
    let spectator = null;
    let bored = false;
    let zeroBids = 0;
    let guard = 0;
    while (!game.isTerminal() && guard++ < 20000) {
        const hands = game.handStats.totalHands;
        const stage = game.stage;

        if (hands === 1 && stage === Phase.BIDDING && !done.lazyActive) {
            done.lazyActive = true;
            const s = owner(game, 1);
            chatHandlers.chatMessage(s, w.io, { message: '/lazy' });
            chatHandlers.chatMessage(s, w.io, { message: '/lazy' }); // 'Already in lazy mode' error
            chatHandlers.chatMessage(s, w.io, { message: '/active' });
            chatHandlers.chatMessage(s, w.io, { message: '/bogus' });
            chatHandlers.chatMessage(s, w.io, { message: 'nice hand' });
        }
        if (hands === 2 && stage === Phase.BIDDING && !done.lazyWatch) {
            done.lazyWatch = true;
            const pos = 2;
            const username = game.seat(pos).ownerUsername;
            chatHandlers.chatMessage(owner(game, pos), w.io, { message: '/lazy' });
            const back = await rejoinAs(game, username, 'watch');
            expect(selfEvents(w, back.id)[0]).toBe('rejoinSuccess');
            await reconnectHandlers.rejoinGame(back, w.io, { gameId: game.gameId, username }); // idempotent
            chatHandlers.chatMessage(back, w.io, { message: '/active' });
            expect(game.seat(pos).controller).toBe('human');
        }
        if (hands === 3 && stage === Phase.PLAYING && !done.rejects) {
            const seat = game.seat(game.currentTurn);
            if (seat.controller === 'human' && seat.presence === 'connected') {
                const s = owner(game, seat.position);
                const hand = game.getHand(s.id);
                const mark = w.log.length;
                await gameHandlers.playCard(s, w.io, { card: cardNotIn(hand) });
                expect(selfEvents(w, s.id, mark)).toEqual(['actionRejected', 'restorePlayerState']);
                const legal = legalCards(game, s.id);
                const illegal = hand.find((c) => !legal.some((l) => l.suit === c.suit && l.rank === c.rank));
                if (illegal) {
                    await gameHandlers.playCard(s, w.io, { card: illegal });
                    done.rejects = true;
                }
                await gameHandlers.playerBid(s, w.io, { bid: '1' }); // not_your_turn (wrong stage)
            }
        }
        if (hands === 4 && stage === Phase.BIDDING && !done.resign) {
            done.resign = true;
            const pos = 3;
            const username = game.seat(pos).ownerUsername;
            await w.kill(owner(game, pos));
            await gameHandlers.forceResign(owner(game, 4), w.io, { position: pos }); // still in grace: error
            await jest.advanceTimersByTimeAsync(61000);
            expect(game.seat(pos).presence).toBe('resignable');
            // A returning socket of another seat gets the offer replayed privately
            const p4name = game.seat(4).ownerUsername;
            await rejoinAs(game, p4name, 'replay');
            await gameHandlers.forceResign(owner(game, 4), w.io, { position: pos });
            expect(game.seat(pos).controller).toBe('resignBot');
            const bot = game.seat(pos).bot;
            botController.sendBotChat(w.io, game, botController.getBot(game.gameId, bot.socketId), 'gg', 0);
            await rejoinAs(game, username, 'resigned');
            expect(game.seat(pos).ownerView).toBe('watch');
        }
        if (hands === 5 && stage === Phase.BIDDING && !spectator) {
            spectator = w.user('f1-spec', 'f1_fan');
            mainRoomHandlers.joinMainRoom(spectator, w.io);
            mainRoomHandlers.joinAsSpectator(spectator, w.io, { gameId: game.gameId });
            chatHandlers.chatMessage(spectator, w.io, { message: 'go team' });
            chatHandlers.chatMessage(spectator, w.io, { message: '/active' }); // an ordinary spectator: ignored
        }
        if (hands === 6 && stage === Phase.BIDDING && !done.spectateOwn) {
            done.spectateOwn = true;
            // The resigned owner opens the game from the lobby list on another
            // device: joinAsSpectator -> watchSeat via 'spectate' (rejoinSuccess
            // without tournamentId); the older watching socket is demoted
            const username = game.seat(3).ownerUsername;
            const older = owner(game, 3);
            const phone = w.user('f1-spectate-own', username, { db: false });
            mainRoomHandlers.joinMainRoom(phone, w.io);
            const mark = w.log.length;
            mainRoomHandlers.joinAsSpectator(phone, w.io, { gameId: game.gameId });
            expect(selfEvents(w, phone.id, mark)[0]).toBe('rejoinSuccess');
            expect('tournamentId' in w.log.slice(mark).find((l) => l.to === `self:${phone.id}`).data).toBe(false);
            expect(game.seat(3).ownerSocketId).toBe(phone.id);
            expect(game.isSpectator(older.id)).toBe(true);
        }
        if (hands === 7 && stage === Phase.BIDDING && !done.leave) {
            done.leave = true;
            // The resigned owner (watch view) leaves for good; so does the spectator
            chatHandlers.chatMessage(owner(game, 3), w.io, { message: '/leave' });
            chatHandlers.chatMessage(spectator, w.io, { message: '/leave' });
        }

        if (hooks.onStep) await hooks.onStep(w, game, { hands, stage, done });
        if (stage === Phase.BIDDING || stage === Phase.PLAYING) {
            const seat = game.seat(game.currentTurn);
            if (seat.controller === 'human' && seat.presence === 'connected') {
                const s = owner(game, seat.position);
                if (stage === Phase.BIDDING) {
                    let bid;
                    if (zeroBids < 4) { bid = '0'; zeroBids++; }
                    else if (!bored && hands >= 1 && legalBids(game).includes('B')) { bid = 'B'; bored = true; }
                    else bid = legalBids(game).includes('1') ? '1' : '0';
                    w.pending.push(gameHandlers.playerBid(s, w.io, { bid }));
                } else {
                    const [card] = legalCards(game, s.id);
                    w.pending.push(gameHandlers.playCard(s, w.io, { card }));
                }
                await tick();
                continue;
            }
        }
        await jest.advanceTimersByTimeAsync(250);
    }
    if (game.stage !== Phase.ENDED) {
        throw new Error('F1 did not finish: ' + JSON.stringify({ stage: game.stage, hands: game.handStats.totalHands, turn: game.currentTurn, seats: game.presenceSummary(), bids: game.playerBids, done, guard }));
    }
    expect(done).toMatchObject({ lazyActive: true, lazyWatch: true, rejects: true, resign: true, spectateOwn: true, leave: true });
    await Promise.all(w.pending);
    await Promise.all(starting);
    await jest.advanceTimersByTimeAsync(5000);
    expectSilentAfterTerminal(w, game);
    expect(events(w.log, 'destroyHands').length).toBeGreaterThan(0);
    expect(errorLogs).toEqual([]);
    return { w, game };
}

module.exports = { world, tick, selfEvents, expectSilentAfterTerminal, cardNotIn, playF1, watchSnapshots };
