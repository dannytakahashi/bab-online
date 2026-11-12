/**
 * The parked tab after the active tab closes (session-quirks verifier,
 * 2026-11-11): with two tabs, tab 1 is parked behind "open in another tab".
 * When tab 2 is CLOSED, nothing told tab 1, the server counted no human
 * until Use here, and at a table the seat's 60 s grace ran out ("All
 * players disconnected"). Now, when the user's live socket disconnects and
 * a parked socket of the same user is still connected, the parked one is
 * told `sessionSuperseded {reason: 'otherClosed'}` after
 * OTHER_CLOSED_DELAY_MS (2 s), unless a socket took the session back by
 * then (a reload of the active tab: no flash). Nothing is taken back by
 * itself; a socket that takes the session later tells the parked ones
 * 'newerConnection' again. Only that user's own parked sockets hear it.
 */

const crypto = require('crypto');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

const gameManager = require('../../game/GameManager');
const authHandlers = require('../authHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const queueHandlers = require('../queueHandlers');
const identity = require('../sessionIdentity');
const { hashToken } = require('../../utils/sessionTokens');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

const secret = () => crypto.randomUUID();
const DELAY = identity.OTHER_CLOSED_DELAY_MS;
let seq = 0;

function quiet() {
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
}

function resetManager() {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const sid of Array.from(gameManager.lobbyGrace.keys())) gameManager._clearLobbyGrace(sid);
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.spectatorGames.clear();
    gameManager.currentUsers = [];
}

function addUser(username) {
    const token = secret();
    const now = new Date();
    mockDb.current.users._insert({
        username, profilePic: 5,
        sessionTokens: [{ hash: hashToken(token), createdAt: now, lastUsedAt: now }],
    });
    return token;
}

describe("the parked tab hears that the other tab closed", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        mockDb.current = createMemoryDb({ users: [] });
        quiet();
    });
    afterEach(() => {
        identity._resetOtherClosedTimers();
        resetManager();
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    function world(io = null, log = null) {
        const id = ++seq;
        const theLog = log || [];
        const theIo = io || makeIo(theLog);
        const name = `pat${id}`;
        const token = addUser(name);
        let n = 0;
        const w = {
            log: theLog, io: theIo, name, token,
            async tab() {
                n++;
                const s = makeSocket(`pc${id}-${n}`, theLog, theIo);
                s.disconnect = () => w.close(s);
                await authHandlers.restoreSession(s, theIo, { username: name, sessionToken: token });
                expect(events(theLog, 'restoreSessionResponse').filter((l) => l.to === `self:${s.id}`).pop().data.success).toBe(true);
                return s;
            },
            // The tab is closed: the transport drops, the server's disconnect handler runs
            close(s) {
                theIo.sockets.sockets.delete(s.id);
                for (const members of theIo.rooms.values()) members.delete(s.id);
                return queueHandlers.handleDisconnect(s, theIo);
            },
            told(sid, from = 0) {
                return theLog.slice(from).filter((l) => (l.to === sid || l.to === `self:${sid}`) && l.event === 'sessionSuperseded').map((l) => l.data);
            },
        };
        return w;
    }

    test('the active tab closes: the parked tab is told after the delay, once; the session is not taken back', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = await w.tab();
        expect(w.told(tab1.id)).toEqual([{ reason: 'newerConnection' }]);
        const from = w.log.length;

        await w.close(tab2);
        jest.advanceTimersByTime(DELAY - 1);
        expect(w.told(tab1.id, from)).toEqual([]);
        jest.advanceTimersByTime(1);
        expect(w.told(tab1.id, from)).toEqual([{ reason: 'otherClosed' }]);

        // still parked: nothing took the session back by itself
        expect(tab1.data.superseded).toMatchObject({ reason: 'otherClosed' });
        expect(gameManager.getUserBySocketId(tab1.id)).toBeUndefined();
        jest.advanceTimersByTime(DELAY * 5);
        expect(w.told(tab1.id, from)).toHaveLength(1);
        expect(w.log.slice(from).filter((l) => l.event === 'error')).toEqual([]);
    });

    test('a refusal while told otherClosed carries that reason (the notice keeps its text)', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = await w.tab();
        await w.close(tab2);
        jest.advanceTimersByTime(DELAY);
        const from = w.log.length;
        const next = jest.fn();
        identity.supersededGate(tab1)(['mainRoomChat', {}], next);
        expect(next).not.toHaveBeenCalled();
        expect(w.told(tab1.id, from)).toEqual([{ reason: 'otherClosed', refused: 'mainRoomChat' }]);
    });

    test('a reload of the active tab (its new socket restores within the delay): nothing is sent, no flash', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = await w.tab();
        const from = w.log.length;
        await w.close(tab2);
        jest.advanceTimersByTime(DELAY / 2);
        const tab2b = await w.tab();
        jest.advanceTimersByTime(DELAY * 3);
        expect(w.told(tab1.id, from)).toEqual([]);
        expect(tab1.data.superseded).toBeDefined();
        expect(gameManager.getUserBySocketId(tab2b.id)?.username).toBe(w.name);
    });

    test('a socket holding the session by another path (a token rejoin registers it, no restore): nothing is sent', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = await w.tab();
        const from = w.log.length;
        await w.close(tab2);
        // the reloaded tab's rejoinGame (token) registers it without a restoreSession
        const tab2b = makeSocket(`pc-rejoin${seq}`, w.log, w.io);
        tab2b.data.username = w.name;
        gameManager.registerUser(tab2b.id, w.name);
        jest.advanceTimersByTime(DELAY);
        expect(w.told(tab1.id, from)).toEqual([]);
        // ...and once that one is gone too, the parked tab is told
        await w.close(tab2b);
        jest.advanceTimersByTime(DELAY);
        expect(w.told(tab1.id, from)).toEqual([{ reason: 'otherClosed' }]);
    });

    test('a slow reload (after the delay): told otherClosed, then newerConnection when the reloaded tab restores', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = await w.tab();
        const from = w.log.length;
        await w.close(tab2);
        jest.advanceTimersByTime(DELAY);
        const tab2b = await w.tab();
        expect(w.told(tab1.id, from)).toEqual([{ reason: 'otherClosed' }, { reason: 'newerConnection' }]);
        expect(tab1.data.superseded).toMatchObject({ by: tab2b.id });
        expect(tab1.data.superseded.reason).toBeUndefined();
        // the reloaded tab is the user, not parked, and was told nothing
        expect(w.told(tab2b.id, from)).toEqual([]);
    });

    test('Use here on the parked tab after otherClosed: it is the user again, nothing more is sent to it', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = await w.tab();
        await w.close(tab2);
        jest.advanceTimersByTime(DELAY);
        const from = w.log.length;
        // Use here = a fresh socket that restores
        const tab1b = await w.tab();
        mainRoomHandlers.joinMainRoom(tab1b, w.io);
        expect(gameManager.getUserBySocketId(tab1b.id)?.username).toBe(w.name);
        // the old parked socket (being replaced by the reconnect) hears newerConnection
        expect(w.told(tab1.id, from)).toEqual([{ reason: 'newerConnection' }]);
        expect(w.told(tab1b.id, from)).toEqual([]);
        expect(gameManager.isInMainRoom(tab1b.id)).toBe(true);
    });

    test('several parked tabs are all told; a parked tab closing tells nobody', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = await w.tab();
        const tab3 = await w.tab();
        const from = w.log.length;
        // a parked tab closing is not the live socket
        await w.close(tab1);
        jest.advanceTimersByTime(DELAY * 2);
        expect(w.told(tab2.id, from)).toEqual([]);
        await w.close(tab3);
        jest.advanceTimersByTime(DELAY);
        expect(w.told(tab2.id, from)).toEqual([{ reason: 'otherClosed' }]);
    });

    test("only the user's own parked sockets: another user's parked tab hears nothing", async () => {
        const log = [];
        const io = makeIo(log);
        const a = world(io, log);
        const b = world(io, log);
        const a1 = await a.tab();
        await a.tab();
        const b1 = await b.tab();
        const b2 = await b.tab();
        const from = log.length;
        await b.close(b2);
        jest.advanceTimersByTime(DELAY);
        expect(b.told(b1.id, from)).toEqual([{ reason: 'otherClosed' }]);
        expect(a.told(a1.id, from)).toEqual([]);
    });

    test('a parked socket that switched accounts since is not told', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = await w.tab();
        tab1.data.username = 'someoneElse';
        const from = w.log.length;
        await w.close(tab2);
        jest.advanceTimersByTime(DELAY);
        expect(w.told(tab1.id, from)).toEqual([]);
    });

    test('the live socket switching accounts (it stays connected) tells nothing; a sign-out everywhere tells nothing', async () => {
        const w = world();
        const tab1 = await w.tab();
        const tab2 = await w.tab();
        const from = w.log.length;
        await identity.releaseIdentity(w.io, tab2, 'other');
        jest.advanceTimersByTime(DELAY);
        expect(w.told(tab1.id, from)).toEqual([]);

        const w2 = world();
        const p1 = await w2.tab();
        const p2 = await w2.tab();
        const from2 = w2.log.length;
        authHandlers.signOutUser(w2.io, w2.name);
        // both sockets were signed out (forceLogout) and closed
        expect(w2.io.sockets.sockets.has(p1.id)).toBe(false);
        expect(w2.io.sockets.sockets.has(p2.id)).toBe(false);
        await w2.close(p2);
        jest.advanceTimersByTime(DELAY);
        expect(w2.told(p1.id, from2)).toEqual([]);
    });

    test('in a game: the parked tab is told while the seat is in its grace, and Use here takes the seat back', async () => {
        const reconnectHandlers = require('../reconnectHandlers');
        const { Phase } = require('../../game/GamePhase');
        const { Presence } = require('../../game/SeatState');
        const C = (rank, suit) => ({ rank, suit });
        const w = world();
        const tab1 = await w.tab();
        const others = [2, 3, 4].map((p) => `seatpc${seq}-${p}`);
        others.forEach((sid, i) => gameManager.registerUser(sid, `otherpc${seq}-${i}`));
        const game = gameManager.createGame([tab1.id, ...others]);
        game.addPlayer(tab1.id, w.name, 1, 1, false);
        others.forEach((sid, i) => game.addPlayer(sid, `otherpc${seq}-${i}`, i + 2, i + 2, false));
        for (let pos = 1; pos <= 4; pos++) game.setHand(game.positions[pos], [C(String(pos + 2), 'hearts')]);
        game.currentHand = 1;
        game.trump = C('A', 'spades');
        game.forcePhase(Phase.BIDDING);
        game.bidder = 1;
        game.currentTurn = 1;
        tab1.join(game.roomName);
        await mockDb.current.users.updateOne({ username: w.name }, { $set: { activeGameId: game.gameId } });

        // a second tab takes the session and the seat
        const tab2 = await w.tab();
        await reconnectHandlers.rejoinGame(tab2, w.io, { gameId: game.gameId, username: w.name, sessionToken: w.token });
        expect(game.seat(1).ownerSocketId).toBe(tab2.id);
        const from = w.log.length;
        // tab 2 is closed: the seat goes to its grace, tab 1 is told
        await w.close(tab2);
        expect(game.seat(1).presence).toBe(Presence.GRACE);
        jest.advanceTimersByTime(DELAY);
        expect(w.told(tab1.id, from)).toEqual([{ reason: 'otherClosed' }]);
        // Use here: a fresh socket restores and rejoins, well inside the grace
        const tab1b = await w.tab();
        await reconnectHandlers.rejoinGame(tab1b, w.io, { gameId: game.gameId, username: w.name, sessionToken: w.token });
        expect(game.seat(1)).toMatchObject({ ownerSocketId: tab1b.id, presence: Presence.CONNECTED });
        expect(events(w.log.slice(from), 'rejoinSuccess').some((l) => l.to === `self:${tab1b.id}`)).toBe(true);
        expect(game.stage).not.toBe(Phase.ABORTED);
        expect(w.log.filter((l) => l.event === 'error')).toEqual([]);
    });
});
