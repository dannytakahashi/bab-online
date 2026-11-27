/**
 * Seats that lose their human (leave or disconnect during the draw, resign
 * then /active back) must end up played by someone, and the redeal / queue
 * broadcasts must not mislead clients. Drives the real handlers against a
 * real GameState with stub sockets and fake timers (the draw completion and
 * reconnect grace period run on setTimeout).
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const Deck = require('../../game/Deck');
const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const { botController } = require('../../game/bot');
const { lazySeat, resignedSeat } = require('../../testUtils/gameDriver');
// Every emit here is contract-checked like the gameDriver suites
const { instrument } = require('../../testUtils/contractCheck');

const C = (rank, suit) => ({ rank, suit });

function makeIo(log) {
    instrument(log);
    return {
        to: (room) => ({ emit: (event, data) => log.push({ to: room, event, data }) }),
        emit: (event, data) => log.push({ to: '*', event, data }),
        sockets: { sockets: new Map() },
    };
}

function makeSocket(id, log) {
    instrument(log);
    return { id, data: {}, emit: (event, data) => log.push({ to: `self:${id}`, event, data }), join() {}, leave() {} };
}

const events = (log, event) => log.filter((l) => l.event === event);

let seq = 0;
let updateSpy;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    updateSpy = jest.spyOn(mockDb.current.users, 'updateOne');
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
});

/** A game in the draw phase; `humans` socket ids are registered users. */
function drawingGame(ids, humans = ids) {
    humans.forEach((id) => {
        gameManager.registerUser(id, `user_${id}`);
        mockDb.current.users._insert({ username: `user_${id}`, profilePic: 5 });
    });
    const game = gameManager.createGame(ids);
    game.deck = new Deck();
    game.transition('CREATED', 'DRAWING');
    return game;
}

describe('draw-phase leave and disconnect', () => {
    test('a leaver becomes a resign bot and a disconnect gets the grace timer', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `d${seq}-h${n}`);
        const game = drawingGame(ids);
        const [leaver, , , dropper] = ids;
        const s = ids.map((id) => makeSocket(id, log));

        chatHandlers.chatMessage(s[0], io, { message: '/leave' });
        await gameHandlers.draw(s[1], io, { num: 0 });
        await gameHandlers.draw(s[2], io, { num: 0 });
        await queueHandlers.handleDisconnect(s[3], io); // auto-draws the 4th card
        await jest.advanceTimersByTimeAsync(7000); // positions, teams, deal

        const leaverPos = game.seatByUsername(`user_${leaver}`);
        expect(leaverPos).toBeTruthy();
        expect(game.seat(leaverPos)).toMatchObject({ controller: 'resignBot', presence: 'gone' });
        const seat = game.getPlayerByPosition(leaverPos);
        expect(game.isBot(seat.socketId)).toBe(true);
        expect(botController.getBot(game.gameId, seat.socketId)).toBeDefined();
        // The leaver is in the main room: no seat assignment, no activeGameId
        expect(log.some((l) => (l.to === leaver || l.to === `self:${leaver}`) && l.event === 'gameStart')).toBe(false);
        const sets = updateSpy.mock.calls.filter(([, u]) => u.$set && 'activeGameId' in u.$set);
        expect(sets.some(([f]) => f.username === `user_${leaver}`)).toBe(false);
        expect(sets).toHaveLength(3);
        // Bots have no user documents: no writes for them
        expect(updateSpy.mock.calls.every(([f]) => f.username.startsWith('user_'))).toBe(true);

        const dropperPos = game.getPositionBySocketId(dropper);
        expect(game.seatPresence(dropperPos)).toBe('grace');
        expect(events(log, 'playerDisconnected').some((l) => l.data.position === dropperPos)).toBe(true);
        expect(events(log, 'resignationAvailable')).toHaveLength(0);

        await jest.advanceTimersByTimeAsync(60000);
        const offers = events(log, 'resignationAvailable');
        expect(offers.map((l) => l.data.position)).toEqual([dropperPos]);

        // The offer is actionable: a remaining player replaces the seat
        const requester = s[ids.indexOf(ids.find((id) => id !== leaver && id !== dropper))];
        await gameHandlers.forceResign(requester, io, { position: dropperPos });
        expect(game.seat(dropperPos).controller).toBe('resignBot');
    });

    test('positionUpdate.owners names each seat\'s owner: the leaver for its resign bot, null for a native bot', async () => {
        // 2026-11-26: usernames[] names who the seat shows (a leaver's resign
        // bot), so the clients present at seating named the seat by the bot
        // while a snapshot (seats[].ownerUsername) named the leaver
        const log = [];
        const io = makeIo(log);
        seq++;
        const humans = [1, 2, 3].map((n) => `w${seq}-h${n}`);
        const botId = `bot:own${seq}`;
        const game = drawingGame([...humans, botId], humans);
        const s = humans.map((id) => makeSocket(id, log));

        chatHandlers.chatMessage(s[0], io, { message: '/leave' }); // the leaver (auto-drawn)
        gameHandlers.autoDraw(io, game, botId, 'Bot');
        await queueHandlers.handleDisconnect(s[2], io); // a draw-phase disconnect (grace)
        gameHandlers.draw(s[1], io, { num: 0 }); // the 4th card: runs on through the seating
        await jest.advanceTimersByTimeAsync(7000);

        const pu = events(log, 'positionUpdate').at(-1).data;
        const at = (pos) => pu.positions.indexOf(pos);
        const leaverPos = game.seatByUsername(`user_${humans[0]}`);
        const botPos = pu.positions.find((p) => game.seat(p).controller === 'bot');
        expect(game.seat(leaverPos)).toMatchObject({ controller: 'resignBot', ownerUsername: `user_${humans[0]}` });
        // the seat SHOWS the bot, its owner is the leaver
        expect(pu.usernames[at(leaverPos)].username).not.toBe(`user_${humans[0]}`);
        expect(pu.owners[at(leaverPos)]).toBe(`user_${humans[0]}`);
        expect(pu.owners[at(botPos)]).toBeNull();
        expect(pu.owners[at(game.seatByUsername(`user_${humans[1]}`))]).toBe(`user_${humans[1]}`);
        expect(pu.owners[at(game.seatByUsername(`user_${humans[2]}`))]).toBe(`user_${humans[2]}`); // in grace
        expect(pu.owners).toHaveLength(pu.positions.length);
        // the same owners a snapshot gives
        const { buildSnapshotV2 } = require('../../game/snapshotV2');
        const snap = buildSnapshotV2(game, humans[1]);
        for (const seat of snap.seats) {
            expect(pu.owners[at(seat.position)]).toBe(seat.controller === 'bot' ? null : seat.ownerUsername);
        }
    });

    test('a draw-phase disconnect sends no position:null event', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `n${seq}-h${n}`);
        drawingGame(ids);
        await queueHandlers.handleDisconnect(makeSocket(ids[0], log), io);
        expect(events(log, 'playerDisconnected')).toHaveLength(0);
        expect(events(log, 'gameLogEntry').some((l) => /disconnected during card draw/.test(l.data.message))).toBe(true);
    });

    test('a draw-phase disconnecter who rejoins before positionUpdate gets no stale playerDisconnected', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `j${seq}-h${n}`);
        const game = drawingGame(ids);
        const s = ids.map((id) => makeSocket(id, log));

        for (let i = 0; i < 3; i++) await gameHandlers.draw(s[i], io, { num: 0 });
        await queueHandlers.handleDisconnect(s[3], io); // auto-draws the 4th card
        await jest.advanceTimersByTimeAsync(300); // seats assigned, inside delay(1000)
        expect(game.getPositionBySocketId(ids[3])).toBeTruthy();

        const fresh = makeSocket(`${ids[3]}-again`, log);
        gameManager.registerUser(fresh.id, `user_${ids[3]}`);
        await reconnectHandlers.rejoinGame(fresh, io, { gameId: game.gameId, username: `user_${ids[3]}` });
        await jest.advanceTimersByTimeAsync(7000);

        expect(events(log, 'playerReconnected')).toHaveLength(1);
        expect(events(log, 'playerDisconnected')).toHaveLength(0);
        await jest.advanceTimersByTimeAsync(60000);
        expect(events(log, 'resignationAvailable')).toHaveLength(0);
    });

    test('a draw-phase disconnecter back on a new socket before the draw ends is seated as a connected player', async () => {
        // A reload during the draw for first deal (owner live check
        // 2026-11-26: the player used to land in the main room, rejoinGame
        // answered 'Not a player in this game', and could only spectate)
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `r${seq}-h${n}`);
        const game = drawingGame(ids);
        const s = ids.map((id) => makeSocket(id, log));

        await gameHandlers.draw(s[0], io, { num: 0 });
        await queueHandlers.handleDisconnect(s[3], io); // auto-draws its card
        expect(game.entrant(ids[3])).toMatchObject({ presence: 'disconnected' });
        expect(game.drawIDs).toContain(ids[3]);

        const fresh = makeSocket(`${ids[3]}-again`, log);
        gameManager.registerUser(fresh.id, `user_${ids[3]}`);
        await reconnectHandlers.rejoinGame(fresh, io, { gameId: game.gameId, username: `user_${ids[3]}` });

        // The entrant record, its drawn card and the mapping moved to the new socket
        expect(events(log, 'rejoinFailed')).toHaveLength(0);
        const ok = log.filter((l) => l.to === `self:${fresh.id}` && l.event === 'rejoinSuccess');
        expect(ok).toHaveLength(1);
        expect(ok[0].data.snapshot.viewer.role).toBe('entrant');
        expect(ok[0].data.snapshot.draw.viewerDrawOrder).toBe(2);
        expect(game.entrant(ids[3])).toBeNull();
        expect(game.entrant(fresh.id)).toMatchObject({ username: `user_${ids[3]}`, presence: 'connected', socketId: fresh.id });
        expect(game.drawIDs).toEqual([ids[0], fresh.id]);
        expect(gameManager.playerGames.get(fresh.id)).toBe(game.gameId);
        expect(gameManager.playerGames.has(ids[3])).toBe(false);
        expect(events(log, 'gameLogEntry').some((l) => l.data.message === `user_${ids[3]} reconnected.`)).toBe(true);
        // Entrant order is kept (the draw's seat for each entrant follows it)
        expect(Array.from(game.entrants.keys())).toEqual([ids[0], ids[1], ids[2], fresh.id]);

        // It cannot draw a second card
        await gameHandlers.draw(fresh, io, { num: 3 });
        expect(game.drawIDs).toEqual([ids[0], fresh.id]);

        await gameHandlers.draw(s[1], io, { num: 0 });
        gameHandlers.draw(s[2], io, { num: 0 }); // the 4th card: runs on through the seating
        await jest.advanceTimersByTimeAsync(7000); // positions, teams, deal

        const pos = game.seatByUsername(`user_${ids[3]}`);
        expect(game.seat(pos)).toMatchObject({ controller: 'human', presence: 'connected', ownerSocketId: fresh.id });
        expect(events(log, 'playerDisconnected')).toHaveLength(0);
        expect(log.some((l) => l.to === fresh.id && l.event === 'gameStart')).toBe(true);
        await jest.advanceTimersByTimeAsync(60000);
        expect(events(log, 'resignationAvailable')).toHaveLength(0);
    });

    test('a new socket takes over an entrant whose old socket is still attached (newest socket wins)', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `w${seq}-h${n}`);
        const game = drawingGame(ids);
        const s = ids.map((id) => makeSocket(id, log));

        const fresh = makeSocket(`${ids[1]}-again`, log);
        gameManager.registerUser(fresh.id, `user_${ids[1]}`);
        await reconnectHandlers.rejoinGame(fresh, io, { gameId: game.gameId, username: `user_${ids[1]}` });
        expect(game.entrant(fresh.id)).toMatchObject({ presence: 'connected' });
        expect(game.entrant(ids[1])).toBeNull();
        expect(gameManager.playerGames.has(ids[1])).toBe(false);

        // The old socket's late disconnect finds nothing to do
        await queueHandlers.handleDisconnect(s[1], io);
        expect(game.entrant(fresh.id)).toMatchObject({ presence: 'connected' });
        expect(events(log, 'gameLogEntry').some((l) => /disconnected during card draw/.test(l.data.message))).toBe(false);

        // Asking again on the same socket is answered again, never refused
        await reconnectHandlers.rejoinGame(fresh, io, { gameId: game.gameId, username: `user_${ids[1]}` });
        expect(log.filter((l) => l.to === `self:${fresh.id}` && l.event === 'rejoinSuccess')).toHaveLength(2);
        expect(events(log, 'rejoinFailed')).toHaveLength(0);
        // ...quietly: one room line for the takeover, none for the repeat
        expect(events(log, 'gameLogEntry').filter((l) => l.data.message === `user_${ids[1]} reconnected.`)).toHaveLength(1);
        // its voice peers dropped the old socket's call (newest wins)
        for (const peer of [ids[0], ids[2], ids[3]]) {
            expect(log.some((l) => l.to === peer && l.event === 'voicePeerLeft' && l.data.socketId === ids[1])).toBe(true);
        }

        for (const sock of [s[0], fresh, s[2]]) await gameHandlers.draw(sock, io, { num: 0 });
        gameHandlers.draw(s[3], io, { num: 0 }); // the 4th card: runs on through the seating
        await jest.advanceTimersByTimeAsync(7000);
        const pos = game.seatByUsername(`user_${ids[1]}`);
        expect(game.seat(pos)).toMatchObject({ controller: 'human', presence: 'connected', ownerSocketId: fresh.id });
    });

    test('an entrant who left during the draw, a bot and a stranger are still refused before seating', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `x${seq}-h${n}`);
        const game = drawingGame(ids);
        const s = ids.map((id) => makeSocket(id, log));
        chatHandlers.chatMessage(s[0], io, { message: '/leave' });

        const back = makeSocket(`${ids[0]}-again`, log);
        gameManager.registerUser(back.id, `user_${ids[0]}`);
        await reconnectHandlers.rejoinGame(back, io, { gameId: game.gameId, username: `user_${ids[0]}` });
        const stranger = makeSocket(`x${seq}-out`, log);
        gameManager.registerUser(stranger.id, `outsider${seq}`);
        await reconnectHandlers.rejoinGame(stranger, io, { gameId: game.gameId, username: `outsider${seq}` });

        expect(events(log, 'rejoinFailed').map((l) => l.data)).toEqual([
            { reason: 'Not a player in this game' },
            { reason: 'Not a player in this game' },
        ]);
        expect(game.entrant(back.id)).toBeNull();
        expect(game.entrant(ids[0])).toMatchObject({ presence: 'left' });
        expect(gameManager.playerGames.has(back.id)).toBe(false);
    });

    test('a refused takeover changes nothing: the dead entrant stays disconnected and is seated in grace', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `z${seq}-h${n}`);
        const game = drawingGame(ids);
        const s = ids.map((id) => makeSocket(id, log));
        await queueHandlers.handleDisconnect(s[3], io);
        expect(game.entrant(ids[3])).toMatchObject({ presence: 'disconnected' });
        // onto a socket that is another entrant: refused before any change
        expect(game.reattachEntrant(`user_${ids[3]}`, ids[0])).toBeNull();
        expect(game.entrant(ids[3])).toMatchObject({ presence: 'disconnected', socketId: ids[3] });
        expect(game.entrant(ids[0])).toMatchObject({ username: `user_${ids[0]}` });
        for (const sock of s.slice(0, 2)) await gameHandlers.draw(sock, io, { num: 0 });
        gameHandlers.draw(s[2], io, { num: 0 });
        await jest.advanceTimersByTimeAsync(7000);
        const pos = game.seatByUsername(`user_${ids[3]}`);
        expect(game.seatPresence(pos)).toBe('grace');
        expect(events(log, 'playerDisconnected').some((l) => l.data.position === pos)).toBe(true);
    });

    test('voice: the returning entrant gets the table\'s voice peers and they get it', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `v${seq}-h${n}`);
        const game = drawingGame(ids);
        const s = ids.map((id) => makeSocket(id, log));
        await queueHandlers.handleDisconnect(s[2], io);
        const fresh = makeSocket(`${ids[2]}-again`, log);
        gameManager.registerUser(fresh.id, `user_${ids[2]}`);
        await reconnectHandlers.rejoinGame(fresh, io, { gameId: game.gameId, username: `user_${ids[2]}` });
        const list = log.find((l) => l.to === `self:${fresh.id}` && l.event === 'voicePeerList');
        expect(list.data.peers.map((p) => p.socketId).sort()).toEqual([ids[0], ids[1], ids[3]].sort());
        for (const peer of [ids[0], ids[1], ids[3]]) {
            expect(log.some((l) => l.to === peer && l.event === 'voicePeerJoined' && l.data.socketId === fresh.id)).toBe(true);
        }
        // after rejoinSuccess, which starts the client's voice
        const order = log.filter((l) => l.to === `self:${fresh.id}`).map((l) => l.event);
        expect(order.indexOf('rejoinSuccess')).toBeLessThan(order.indexOf('voicePeerList'));
    });

    test('a socket watching another table stops watching it before it takes its entrant over', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `o${seq}-h${n}`);
        const game = drawingGame(ids);
        const other = drawingGame([1, 2, 3, 4].map((n) => `o${seq}-x${n}`));
        const s = ids.map((id) => makeSocket(id, log));
        await queueHandlers.handleDisconnect(s[1], io);
        const fresh = makeSocket(`${ids[1]}-again`, log);
        gameManager.registerUser(fresh.id, `user_${ids[1]}`);
        gameManager.addSpectator(io, other, fresh.id, `user_${ids[1]}`, null);
        expect(gameManager.spectatorGames.get(fresh.id)).toBe(other.gameId);
        await reconnectHandlers.rejoinGame(fresh, io, { gameId: game.gameId, username: `user_${ids[1]}` });
        expect(game.entrant(fresh.id)).toMatchObject({ presence: 'connected' });
        expect(gameManager.spectatorGames.has(fresh.id)).toBe(false);
        expect(other.spectators.has(fresh.id)).toBe(false);
        expect(gameManager.playerGames.get(fresh.id)).toBe(game.gameId);
    });

    test('a planned tournament table keeps its teams through the takeover', () => {
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `p${seq}-h${n}`);
        const game = drawingGame(ids);
        game.drawTeams = [[ids[0], ids[2]], [ids[1], ids[3]]];
        game.markEntrantDisconnected(ids[2]);

        expect(game.reattachEntrant(`user_${ids[2]}`, 'p-new')).toBe(ids[2]);
        expect(game.drawTeams).toEqual([[ids[0], 'p-new'], [ids[1], ids[3]]]);
        // Nobody else's name, and never onto a socket that is another entrant
        expect(game.reattachEntrant('nobody', 'p-x')).toBeNull();
        expect(game.reattachEntrant(`user_${ids[1]}`, ids[0])).toBeNull();
        expect(game.entrant(ids[1])).toMatchObject({ socketId: ids[1] });
    });

    test('a /leave from someone who already drew does not run the draw completion twice', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `w${seq}-h${n}`);
        const game = drawingGame(ids);
        const s = ids.map((id) => makeSocket(id, log));

        for (let i = 0; i < 3; i++) await gameHandlers.draw(s[i], io, { num: 0 });
        const completing = gameHandlers.draw(s[3], io, { num: 0 }); // starts handleDrawComplete
        chatHandlers.chatMessage(s[0], io, { message: '/leave' }); // before seats exist
        await jest.advanceTimersByTimeAsync(7000);
        await completing;

        expect(events(log, 'positionUpdate')).toHaveLength(1);
        expect(events(log, 'teamsAnnounced')).toHaveLength(1);
        // ...and the leaver's seat still goes to a bot
        expect(game.seatList().filter((st) => st.controller === 'resignBot').map((st) => st.ownerUsername)).toEqual([`user_${ids[0]}`]);
    });

    test('a /leave while positions are being announced does not re-arm activeGameId', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `v${seq}-h${n}`);
        const game = drawingGame(ids);
        const s = ids.map((id) => makeSocket(id, log));

        for (let i = 0; i < 3; i++) await gameHandlers.draw(s[i], io, { num: 0 });
        const completing = gameHandlers.draw(s[3], io, { num: 0 });
        await jest.advanceTimersByTimeAsync(300); // seats assigned, inside delay(1000)
        expect(game.getPositionBySocketId(ids[0])).toBeTruthy();
        chatHandlers.chatMessage(s[0], io, { message: '/leave' });
        await jest.advanceTimersByTimeAsync(7000);
        await completing;

        const sets = updateSpy.mock.calls.filter(([, u]) => u.$set && 'activeGameId' in u.$set);
        expect(sets.map(([f]) => f.username).sort()).toEqual(ids.slice(1).map((id) => `user_${id}`).sort());
    });

    test('the game aborts when every human left during the draw', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const bots = [1, 2, 3].map((n) => botController.createBot(`🤖 B${n}`, 'mary'));
        const human = `a${seq}-h1`;
        const game = drawingGame([human, ...bots.map((b) => b.socketId)], [human]);
        bots.forEach((b) => botController.registerBot(game.gameId, b));

        chatHandlers.chatMessage(makeSocket(human, log), io, { message: '/leave' });
        for (const b of bots) await gameHandlers.draw(makeSocket(b.socketId, log), io, { num: 0 });
        await jest.advanceTimersByTimeAsync(1000);

        expect(events(log, 'abortGame')).toHaveLength(1);
        expect(gameManager.getGameById(game.gameId)).toBeFalsy();
    });
});

describe('/active over a resigned seat', () => {
    function biddingGame() {
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `r${seq}-h${n}`);
        ids.forEach((id) => gameManager.registerUser(id, `user_${id}`));
        const game = gameManager.createGame(ids);
        ids.forEach((id, i) => game.addPlayer(id, `user_${id}`, i + 1, 1, false));
        ids.forEach((id, i) => game.setHand(id, [C(String(i + 2), 'hearts')]));
        game.currentHand = 1;
        game.trump = C('A', 'spades');
        game.forcePhase('BIDDING');
        game.currentTurn = 1;
        game.playerBids = [];
        return { game, ids };
    }

    test('the human gets the seat back for real and the resign bot never acts for them', async () => {
        const log = [];
        const io = makeIo(log);
        const { game, ids } = biddingGame();
        const s = ids.map((id) => makeSocket(id, log));

        await queueHandlers.handleDisconnect(s[0], io);
        await jest.advanceTimersByTimeAsync(60000); // grace runs out
        await gameHandlers.forceResign(s[1], io, { position: 1 }); // schedules the bot's bid
        const botSocketId = game.positions[1];

        // Rejoin on a fresh socket: the owner watches the resign bot
        const fresh = makeSocket(`${ids[0]}-again`, log);
        gameManager.registerUser(fresh.id, `user_${ids[0]}`);
        await reconnectHandlers.rejoinGame(fresh, io, { gameId: game.gameId, username: `user_${ids[0]}` });
        expect(game.seat(1)).toMatchObject({ controller: 'resignBot', presence: 'connected', ownerSocketId: fresh.id, ownerView: 'watch' });

        chatHandlers.chatMessage(fresh, io, { message: '/active' });

        const seat = game.getPlayerByPosition(1);
        expect(seat.socketId).toBe(fresh.id);
        expect(game.seat(1)).toMatchObject({ controller: 'human', presence: 'connected', bot: null });
        expect(game.getClientState(fresh.id)).toMatchObject({ resignedPositions: [], lazyPositions: [], isLazy: false });
        expect(botController.getBot(game.gameId, botSocketId)).toBeFalsy();
        expect(gameManager.playerGames.has(botSocketId)).toBe(false);
        const restored = events(log, 'restorePlayerState').find((l) => l.to === `self:${fresh.id}`);
        expect(restored.data.snapshot.viewer).toMatchObject({ role: 'seat', position: 1 });
        expect(restored.data.snapshot.hand).toEqual([C('2', 'hearts')]);

        // The resign bot's pending bid must not fire for the human
        await jest.advanceTimersByTimeAsync(10000);
        expect(game.playerBids[0]).toBeUndefined();

        // Private events (e.g. next hand's cards) reach the seat again
        const before = log.length;
        game.sendToPlayer(io, fresh.id, '__privateProbe', {}); // a test marker (not contract-checked)
        expect(log.length).toBe(before + 1);

        // And the human can act on their turn
        await gameHandlers.playerBid(fresh, io, { bid: '1' });
        expect(game.playerBids[0]).toBe('1');
    });

    test('/active re-sends updateTurn so the returning player can act on their turn', () => {
        const log = [];
        const io = makeIo(log);
        const { game, ids } = biddingGame();
        const s0 = makeSocket(ids[0], log);

        chatHandlers.chatMessage(s0, io, { message: '/lazy' });
        log.length = 0;
        chatHandlers.chatMessage(s0, io, { message: '/active' });

        const turn = log.find((l) => l.to === ids[0] && l.event === 'updateTurn');
        expect(turn.data).toEqual({ currentTurn: 1 });
        expect(game.seatController(1)).toBe('human');
    });

    test('/active during trick resolution sends no updateTurn (the post-trick one follows)', () => {
        const log = [];
        const io = makeIo(log);
        const { game, ids } = biddingGame();
        const s0 = makeSocket(ids[0], log);

        chatHandlers.chatMessage(s0, io, { message: '/lazy' });
        game.forcePhase('TRICK_RESOLVING');
        log.length = 0;
        chatHandlers.chatMessage(s0, io, { message: '/active' });

        expect(log.some((l) => l.event === 'updateTurn')).toBe(false);
        expect(game.seatController(1)).toBe('human');
    });
});

describe('zero-bid redeal', () => {
    test('all-zero bids redeal without a doneBidding first', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `z${seq}-h${n}`);
        ids.forEach((id) => gameManager.registerUser(id, `user_${id}`));
        const game = gameManager.createGame(ids);
        ids.forEach((id, i) => game.addPlayer(id, `user_${id}`, i + 1, 1, false));
        ids.forEach((id, i) => game.setHand(id, [C(String(i + 2), 'hearts')]));
        game.currentHand = 1;
        game.trump = C('A', 'spades');
        game.forcePhase('BIDDING');
        game.currentTurn = 1;
        game.playerBids = [];

        for (const id of ids) await gameHandlers.playerBid(makeSocket(id, log), io, { bid: '0' });

        const names = log.map((l) => l.event);
        expect(names).not.toContain('doneBidding');
        expect(names.indexOf('destroyHands')).toBeGreaterThan(-1);
        expect(names.indexOf('gameStart')).toBeGreaterThan(names.indexOf('destroyHands'));
        expect(events(log, 'gameLogEntry').some((l) => /zero/i.test(l.data.message))).toBe(true);
        expect(game.bidding).toBe(true);
        expect(game.playerBids).toEqual([]);
    });
});

describe('disconnect broadcasts', () => {
    test('a disconnect sends no global queueUpdate', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        await queueHandlers.handleDisconnect(makeSocket(`q${seq}`, log), io);
        expect(log.some((l) => l.event === 'queueUpdate')).toBe(false);
    });
});

describe('active-game DB writes skip bots', () => {
    test('clearActiveGameForAll clears the humans behind lazy/resigned seats and skips bots', async () => {
        seq++;
        const ids = [1, 2, 3].map((n) => `c${seq}-h${n}`);
        const bot = botController.createBot('🤖 Pat', 'mary');
        const game = gameManager.createGame([...ids, bot.socketId]);
        game.addPlayer(ids[0], 'alice', 1, 1, false);
        game.addPlayer(ids[1], 'bob', 2, 1, false);
        game.addPlayer(ids[2], 'carol', 3, 1, false);
        game.addPlayer(bot.socketId, bot.username, 4, 1, true);
        lazySeat(game, 2, botController.createBot('🤖 Lazy', 'sharon'));
        resignedSeat(game, 3, botController.createBot('🤖 Res', 'danny'));

        await gameManager.clearActiveGameForAll(game.gameId);

        expect(updateSpy.mock.calls.map(([f]) => f.username).sort()).toEqual(['alice', 'bob', 'carol']);
    });

    test('a game ending does not clear the activeGameId of a leaver who is now in another game', async () => {
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `g${seq}-h${n}`);
        ids.forEach((id) => {
            gameManager.registerUser(id, `user_${id}`);
            mockDb.current.users._insert({ username: `user_${id}` });
        });
        const game = gameManager.createGame(ids);
        ids.forEach((id, i) => game.addPlayer(id, `user_${id}`, i + 1, 1, false));
        for (const id of ids) await gameManager.setActiveGame(`user_${id}`, game.gameId);

        chatHandlers.chatMessage(makeSocket(ids[0], []), makeIo([]), { message: '/leave' });
        await gameManager.setActiveGame(`user_${ids[0]}`, 'OTHER-GAME');
        await gameManager.clearActiveGameForAll(game.gameId);

        const doc = (u) => mockDb.current.users.docs.find((d) => d.username === u);
        expect(doc(`user_${ids[0]}`).activeGameId).toBe('OTHER-GAME');
        expect(doc(`user_${ids[1]}`).activeGameId).toBeUndefined();
    });
});
