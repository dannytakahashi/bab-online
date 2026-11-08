/**
 * Characterization transcripts of the seat / presence wire protocol. Each
 * scripted flow records, in order, every emit the real handlers make as
 * `target:event{sorted payload keys}@position`, so a refactor of the server's
 * seat bookkeeping cannot silently change what the App Store iOS client and
 * the web client receive.
 *
 * The expected transcripts were recorded on main at 5b1408e (before seat
 * records). Any later change is annotated inline with the reason (see the
 * `CHANGED:` comments) and must be one of the deliberate wire diffs listed in
 * the seat-record spec (§5).
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
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, mulberry32 } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;
let realRandom;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    realRandom = Math.random;
    Math.random = mulberry32(42);
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

/**
 * Every room line and every gameStart carries an integer seq; per game it
 * strictly increases over room lines, and each deal's gameStarts share one
 * value above the room line before them.
 */
function expectSeqStamped(log) {
    const last = new Map();
    for (const l of log) {
        const room = String(l.to).startsWith('game:');
        if (!room && l.event !== 'gameStart') continue;
        const gid = room ? l.to.slice(5) : l.data.gameId;
        expect({ event: l.event, seq: Number.isInteger(l.data?.seq) }).toEqual({ event: l.event, seq: true });
        const prev = last.get(gid);
        if (prev) {
            const sameDeal = l.event === 'gameStart' && prev.event === 'gameStart';
            if (sameDeal) expect(l.data.seq).toBe(prev.seq);
            else expect(l.data.seq).toBeGreaterThan(prev.seq);
        }
        last.set(gid, { event: l.event, seq: l.data.seq });
    }
}

/** Socket ids are replaced by labels so transcripts are stable. */
function recorder(log) {
    const labels = new Map();
    const label = (sid) => {
        if (typeof sid !== 'string') return String(sid);
        if (sid.startsWith('bot:')) return 'bot';
        return labels.get(sid) || sid;
    };
    const target = (to) => {
        if (to.startsWith('game:')) return 'room';
        if (to.startsWith('self:')) return `self(${label(to.slice(5))})`;
        return label(to);
    };
    return {
        name: (sid, l) => labels.set(sid, l),
        take(from = 0) {
            expectSeqStamped(log);
            return log.slice(from)
                .filter((l) => l.to !== 'mainRoom' && l.event !== 'lobbiesUpdated')
                .map((l) => {
                    // seq: v2 additive; pinned by contract schema + additiveOnly
                    // (checked separately by expectSeqStamped)
                    const keys = l.data && typeof l.data === 'object' ? Object.keys(l.data).filter((k) => k !== 'seq').sort().join(',') : '';
                    const pos = l.data && typeof l.data === 'object' && 'position' in l.data ? `@${l.data.position}` : '';
                    return `${target(l.to)}:${l.event}{${keys}}${pos}`;
                });
        },
    };
}

/** 4 humans seated 1-4, one card each, BIDDING with seat 3 on turn. */
function seated() {
    seq++;
    const log = [];
    const io = makeIo(log);
    const rec = recorder(log);
    const ids = [1, 2, 3, 4].map((n) => `tr${seq}-h${n}`);
    ids.forEach((id, i) => {
        gameManager.registerUser(id, `user${i + 1}`);
        rec.name(id, `h${i + 1}`);
    });
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, `user${i + 1}`, i + 1, 1, false));
    const sockets = ids.map((id) => makeSocket(id, log, io));
    sockets.forEach((s) => s.join(game.roomName));
    ids.forEach((id, i) => game.setHand(id, [C(String(i + 2), 'hearts')]));
    game.currentHand = 1;
    game.trump = C('A', 'spades');
    game.forcePhase(Phase.BIDDING);
    game.bidder = 3;
    game.currentTurn = 3;
    return { log, io, rec, ids, game, sockets };
}

function drop(io, socket) {
    io.sockets.sockets.delete(socket.id);
    for (const members of io.rooms.values()) members.delete(socket.id);
    return queueHandlers.handleDisconnect(socket, io);
}

async function rejoin(t, i, label) {
    const s = makeSocket(`${t.ids[i]}-${label}`, t.log, t.io);
    t.rec.name(s.id, label);
    gameManager.registerUser(s.id, `user${i + 1}`);
    await reconnectHandlers.rejoinGame(s, t.io, { gameId: t.game.gameId, username: `user${i + 1}` });
    return s;
}

const chat = (t, s, message) => chatHandlers.chatMessage(s, t.io, { message });

describe('seat transcripts (wire characterization)', () => {
    test('T1 drop and rejoin', async () => {
        const t = seated();
        await drop(t.io, t.sockets[0]);
        await jest.advanceTimersByTimeAsync(10000);
        await rejoin(t, 0, 'r1');
        expect(t.rec.take()).toEqual([
            'room:playerDisconnected{position,username}@1',
            'room:voicePeerLeft{socketId}',
            'room:gameLogEntry{message,type}',
            // CHANGED (snapshot v2, additive): +snapshot
            'self(r1):rejoinSuccess{bidding,bids,currentHand,currentTurn,dealer,gameId,gameLog,hand,hsiValues,isLazy,isTrumpBroken,lazyPositions,leadPosition,phase,playedCards,playerBids,players,position,resignedPositions,score,snapshot,tournamentId,tricks,trump}@1',
            'room:playerReconnected{position,username}@1',
            'h2:voicePeerJoined{socketId,username}',
            'h3:voicePeerJoined{socketId,username}',
            'h4:voicePeerJoined{socketId,username}',
            'self(r1):voicePeerList{peers}',
            'room:gameLogEntry{message,type}',
        ]);
    });

    test('T2 /lazy then /active at the seat', async () => {
        const t = seated();
        chat(t, t.sockets[0], '/lazy');
        chat(t, t.sockets[0], '/active');
        expect(t.rec.take()).toEqual([
            'room:playerLazyMode{botPic,botUsername,originalUsername,position}@1',
            'room:gameLogEntry{message,type}',
            'room:playerActiveMode{pic,position,username}@1',
            'room:gameLogEntry{message,type}',
            'h1:updateTurn{currentTurn}',
        ]);
    });

    test('T3 /lazy, rejoin from a new socket, /active from it', async () => {
        const t = seated();
        chat(t, t.sockets[0], '/lazy');
        const mark = t.log.length;
        const s = await rejoin(t, 0, 'r1');
        chat(t, s, '/active');
        expect(t.rec.take(mark)).toEqual([
            // CHANGED (snapshot v2, additive): +snapshot
            'self(r1):rejoinSuccess{bidding,bids,currentHand,currentTurn,dealer,gameId,gameLog,hand,hsiValues,isLazy,isTrumpBroken,lazyPositions,leadPosition,phase,playedCards,playerBids,players,position,resignedPositions,score,snapshot,tournamentId,tricks,trump}@1',
            'room:playerReconnected{position,username}@1',
            'room:gameLogEntry{message,type}',
            'room:playerActiveMode{pic,position,username}@1',
            'room:gameLogEntry{message,type}',
            // CHANGED (snapshot v2, additive): +snapshot
            'self(r1):restorePlayerState{bidding,bids,currentHand,currentTurn,dealer,gameId,gameLog,hand,hsiValues,isLazy,isTrumpBroken,lazyPositions,leadPosition,phase,playedCards,playerBids,players,position,resignedPositions,score,snapshot,tricks,trump}@1',
        ]);
    });

    test('T4 grace expiry and forceResign', async () => {
        const t = seated();
        await drop(t.io, t.sockets[0]);
        await jest.advanceTimersByTimeAsync(60000);
        await gameHandlers.forceResign(t.sockets[1], t.io, { position: 1 });
        expect(t.rec.take()).toEqual([
            'room:playerDisconnected{position,username}@1',
            'room:voicePeerLeft{socketId}',
            'room:gameLogEntry{message,type}',
            'room:resignationAvailable{position,username}@1',
            'room:gameLogEntry{message,type}',
            'room:playerResigned{botPic,botUsername,oldUsername,position}@1',
            'room:gameLogEntry{message,type}',
        ]);
    });

    test('T5 /leave from a human seat', () => {
        const t = seated();
        chat(t, t.sockets[0], '/leave');
        expect(t.rec.take()).toEqual([
            'room:playerLazyMode{botPic,botUsername,originalUsername,position}@1',
            'room:gameLogEntry{message,type}',
            'self(h1):leftGame{}',
        ]);
        expect(gameManager.playerGames.has(t.ids[0])).toBe(false);
    });

    test('T6 /leave from a lazy rejoin shadow', async () => {
        const t = seated();
        chat(t, t.sockets[0], '/lazy');
        const s = await rejoin(t, 0, 'r1');
        const mark = t.log.length;
        chat(t, s, '/leave');
        expect(t.rec.take(mark)).toEqual([
            'self(r1):leftGame{}',
            'self(r1):joinMainRoom{}',
        ]);
    });

    test('T7 draw-phase leave and draw-phase disconnect', async () => {
        seq++;
        const log = [];
        const io = makeIo(log);
        const rec = recorder(log);
        const ids = [1, 2, 3, 4].map((n) => `td${seq}-h${n}`);
        ids.forEach((id, i) => {
            gameManager.registerUser(id, `user${i + 1}`);
            mockDb.current.users._insert({ username: `user${i + 1}`, profilePic: i + 10 });
            rec.name(id, `h${i + 1}`);
        });
        const game = gameManager.createGame(ids);
        const sockets = ids.map((id) => makeSocket(id, log, io));
        sockets.forEach((s) => s.join(game.roomName));
        game.deck = new Deck();
        game.transition(Phase.CREATED, Phase.DRAWING);

        chatHandlers.chatMessage(sockets[0], io, { message: '/leave' });
        await gameHandlers.draw(sockets[1], io, { num: 0 });
        await gameHandlers.draw(sockets[2], io, { num: 0 });
        await drop(io, sockets[3]);
        await jest.advanceTimersByTimeAsync(6000);
        expect(game.stage).toBe(Phase.BIDDING);
        const pos4 = game.getPositionBySocketId(ids[3]);
        // Seats are random; compare with positions masked
        const masked = rec.take().map((l) => l.replace(/@\d/, '@p'))
            .filter((l) => !/:(updateTurn)/.test(l));
        // gameStart goes out in seat order (random here): compare as a set
        const starts = masked.filter((l) => l.includes(':gameStart')).sort();
        let k = 0;
        for (let i = 0; i < masked.length; i++) if (masked[i].includes(':gameStart')) masked[i] = starts[k++];
        expect(pos4).toBeTruthy();
        expect(masked).toEqual([
            'room:playerDrew{card,drawOrder,socketId,username}',
            'room:gameLogEntry{message,type}',
            'self(h1):leftGame{}',
            'self(h2):youDrew{card,drawOrder}',
            'room:playerDrew{card,drawOrder,socketId,username}',
            'self(h3):youDrew{card,drawOrder}',
            'room:playerDrew{card,drawOrder,socketId,username}',
            'room:playerDrew{card,drawOrder,socketId,username}',
            'room:gameLogEntry{message,type}',
            'h2:playerAssigned{playerId,position}@p',
            'h3:playerAssigned{playerId,position}@p',
            // CHANGED (seat records): no playerAssigned to the dead socket of a
            // draw-phase disconnect (it is seated in reconnect grace)
            'room:gameLogEntry{message,type}',
            'room:positionUpdate{pics,positions,sockets,usernames}',
            'room:playerDisconnected{position,username}@p',
            'room:teamsAnnounced{team1,team2}',
            'room:createUI{}',
            'h2:gameStart{currentHand,dealer,gameId,hand,hsiValues,playerInfo,players,position,score1,score2,trump}@p',
            'h3:gameStart{currentHand,dealer,gameId,hand,hsiValues,playerInfo,players,position,score1,score2,trump}@p',
            // CHANGED (seat records): gameStart goes to connected owners only,
            // not to the dead socket of a seat in grace
        ]);
    });

    test('T8 two staggered drops', async () => {
        const t = seated();
        await drop(t.io, t.sockets[0]);
        await jest.advanceTimersByTimeAsync(30000);
        await drop(t.io, t.sockets[1]);
        await jest.advanceTimersByTimeAsync(30000);
        const at60 = t.rec.take();
        await jest.advanceTimersByTimeAsync(30000);
        const at90 = t.rec.take(0);
        // CHANGED (seat records): each seat has its own 60s grace. On main
        // the second drop restarted one game-wide timer, so both offers went
        // out together at t=90s; now seat 1 is offered at t=60s, seat 2 at 90s.
        expect(at60).toEqual([
            'room:playerDisconnected{position,username}@1',
            'room:voicePeerLeft{socketId}',
            'room:gameLogEntry{message,type}',
            'room:playerDisconnected{position,username}@2',
            'room:voicePeerLeft{socketId}',
            'room:gameLogEntry{message,type}',
            'room:resignationAvailable{position,username}@1',
            'room:gameLogEntry{message,type}',
        ]);
        expect(at90.slice(at60.length)).toEqual([
            'room:resignationAvailable{position,username}@2',
            'room:gameLogEntry{message,type}',
        ]);
    });

    test('T9 forceResign, then the resigned player rejoins and /actives', async () => {
        const t = seated();
        await drop(t.io, t.sockets[0]);
        await jest.advanceTimersByTimeAsync(60000);
        await gameHandlers.forceResign(t.sockets[1], t.io, { position: 1 });
        const mark = t.log.length;
        const s = await rejoin(t, 0, 'r1');
        chat(t, s, '/active');
        expect(t.rec.take(mark)).toEqual([
            // CHANGED (snapshot v2, additive): +snapshot
            'self(r1):rejoinSuccess{bidding,bids,currentHand,currentTurn,dealer,gameId,gameLog,hand,hsiValues,isLazy,isTrumpBroken,lazyPositions,leadPosition,phase,playedCards,playerBids,players,position,resignedPositions,score,snapshot,tournamentId,tricks,trump}@1',
            'room:playerReconnected{position,username}@1',
            'room:gameLogEntry{message,type}',
            'room:playerActiveMode{pic,position,username}@1',
            'room:gameLogEntry{message,type}',
            // CHANGED (snapshot v2, additive): +snapshot
            'self(r1):restorePlayerState{bidding,bids,currentHand,currentTurn,dealer,gameId,gameLog,hand,hsiValues,isLazy,isTrumpBroken,lazyPositions,leadPosition,phase,playedCards,playerBids,players,position,resignedPositions,score,snapshot,tricks,trump}@1',
        ]);
        expect(t.game.getClientState(s.id).resignedPositions).toEqual([]);
    });

    test('T10 a lazy seat socket disconnects', async () => {
        const t = seated();
        chat(t, t.sockets[0], '/lazy');
        const mark = t.log.length;
        await drop(t.io, t.sockets[0]);
        expect(t.rec.take(mark)).toEqual([
            'room:gameLogEntry{message,type}',
        ]);
    });
});

afterAll(() => botController.clearAll());
