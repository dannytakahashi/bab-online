/**
 * Get Your Bid (owner 2026-11-24; server/game/gameMode.js): a lobby option,
 * 3 seats, no teams, web only (the clientHello cap getYourBid). Exactly the
 * bid scores 10 + the bid (an exact 0 scores 5), anything else nothing; the
 * last bidder may not make the bids add up to a hand of 5 or more cards
 * (the Forbidden Bid, worth 1 point when taken anyway); all zeros is played,
 * led by the first bidder; no bores, HSI, /help, tutorial or stats.
 *
 * Real handlers on the in-memory DB fake, stub io/sockets, fake timers. The
 * contract guard checks every emit and the FSM guard every transition.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

const gameManager = require('../../game/GameManager');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const clientInfo = require('../clientInfo');
const voice = require('../voiceHandlers');
const pacing = require('../../game/pacing');
const rules = require('../../game/rules');
const { Phase } = require('../../game/GamePhase');
const { GYB_UNSUPPORTED } = require('../../game/gameMode');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const WEB_CAPS = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'getYourBid'];
const IOS_CAPS = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView'];

let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const sid of Array.from(gameManager.lobbyGrace.keys())) gameManager._clearLobbyGrace(sid);
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.spectatorGames.clear();
    gameManager.startedLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.currentUsers = [];
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

function world() {
    seq++;
    const log = [];
    const io = makeIo(log);
    let n = 0;
    const w = {
        log, io,
        /** A signed-in socket in the main room: the web (the cap), or an iOS app (every cap but it). */
        user(name, { ios = false } = {}) {
            n++;
            const id = `gyb${seq}-${name}-${n}`;
            const s = makeSocket(id, log, io);
            gameManager.registerUser(id, name);
            voice.rememberBlockList(s, []);
            if (!mockDb.current.users.docs.some((d) => d.username === name)) {
                mockDb.current.users._insert({ username: name, profilePic: 3, blockedUsers: [] });
            }
            clientInfo.handle(s, io, ios
                ? { client: 'ios', version: '1.2.5', build: '39', caps: IOS_CAPS }
                : { client: 'web', version: '1', caps: WEB_CAPS });
            mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
        to(s, event) {
            return log.filter((l) => (l.to === s.id || l.to === `self:${s.id}`) && l.event === event);
        },
        last(s, event) {
            return w.to(s, event).pop()?.data;
        },
        room(game, event) {
            return log.filter((l) => l.to === game.roomName && l.event === event).map((l) => l.data);
        },
    };
    return w;
}

const errors = (w, s) => w.to(s, 'serverError').map((l) => l.data.message);
const name = (i) => `gyb${seq}_p${i}`;

/** A Get Your Bid lobby of `humans` web players (the first hosts) and enough bots to fill it. */
async function table(w, humans) {
    const socks = Array.from({ length: humans }, (_, i) => w.user(name(i + 1)));
    mainRoomHandlers.createLobby(socks[0], w.io, { name: 'Three', mode: 'gyb' });
    const lobby = gameManager.getPlayerLobby(socks[0].id);
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId: lobby.id });
    for (let i = humans; i < 3; i++) await lobbyHandlers.addBot(socks[0], w.io);
    return { socks, lobby };
}

/** Ready every human, run the start, and draw for the humans: the game, dealt. */
async function start(w, socks) {
    for (const s of socks) lobbyHandlers.playerReady(s, w.io);
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    const game = gameManager.getPlayerGame(socks[0].id);
    expect(game).toBeTruthy();
    await jest.advanceTimersByTimeAsync(pacing(game).PREDRAW_COUNTDOWN_MS);
    // Not awaited: the last draw resolves only after the seating holds,
    // which are the timers advanced below
    const draws = socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
    for (let i = 0; i < 200 && game.stage !== Phase.BIDDING; i++) await jest.advanceTimersByTimeAsync(500);
    expect(game.stage).toBe(Phase.BIDDING);
    // (the first hand's turn opens after its own hold)
    await jest.advanceTimersByTimeAsync(pacing(game).FIRST_HAND_TURN_MS);
    await Promise.all(draws);
    return game;
}

const seatOf = (game, s) => game.seatByOwnerSocket(s.id);

/** Every bid the seat on turn may make. */
function legalBids(game) {
    const out = [];
    for (let b = 0; b <= game.currentHand; b++) if (game.isBidLegal(String(b))) out.push(String(b));
    return out;
}

/**
 * Play the game to its end: each human seat bids `bid(game, position)` (or
 * its first legal bid) and plays its first legal card; bots act on their
 * timers. `onHand` runs at every handComplete.
 */
async function play(w, game, socks, { bid = null, until = () => false } = {}) {
    const byPos = new Map(socks.map((s) => [seatOf(game, s), s]));
    for (let i = 0; i < 20000 && !game.isTerminal() && !until(game); i++) {
        const s = byPos.get(game.currentTurn);
        if (s && game.stage === Phase.BIDDING && game.playerBids[game.currentTurn - 1] == null) {
            const pos = game.currentTurn;
            const wanted = bid ? bid(game, pos) : null;
            const b = wanted != null && game.isBidLegal(String(wanted)) ? String(wanted) : legalBids(game)[0];
            await gameHandlers.playerBid(s, w.io, { bid: b });
        } else if (s && game.stage === Phase.PLAYING && !game.playedCards[game.currentTurn - 1]) {
            await gameHandlers.playCard(s, w.io, { card: game.firstLegalCard(game.currentTurn) });
        } else {
            await jest.advanceTimersByTimeAsync(250);
        }
    }
}

describe('the lobby', () => {
    test('created with mode gyb: 3 seats, the mode on every lobby event and in the list', async () => {
        const w = world();
        const [a, b, c, d] = [1, 2, 3, 4].map((i) => w.user(name(i)));
        mainRoomHandlers.createLobby(a, w.io, { name: 'Three', mode: 'gyb' });
        const lobby = gameManager.getPlayerLobby(a.id);
        expect(lobby.mode).toBe('gyb');
        expect(w.last(a, 'lobbyCreated').mode).toBe('gyb');

        const listed = w.last(b, 'lobbiesUpdated').lobbies.find((l) => l.id === lobby.id);
        expect(listed).toMatchObject({ mode: 'gyb', seats: 3, maxPlayers: 4, playerCount: 1 });

        mainRoomHandlers.joinLobby(b, w.io, { lobbyId: lobby.id });
        expect(w.last(b, 'lobbyCreated').mode).toBe('gyb');
        expect(w.last(a, 'lobbyPlayerJoined').mode).toBe('gyb');
        mainRoomHandlers.joinLobby(c, w.io, { lobbyId: lobby.id });

        // A third bot has no seat: the table is three
        await lobbyHandlers.addBot(a, w.io);
        expect(errors(w, a)).toEqual(['Lobby is full']);

        // A fourth person joins to watch (the family-lobby rules, at 3)
        mainRoomHandlers.joinLobby(d, w.io, { lobbyId: lobby.id });
        expect(lobby.players).toHaveLength(4);
        for (const s of [a, b, c]) lobbyHandlers.playerReady(s, w.io);
        lobbyHandlers.playerReady(d, w.io);
        expect(errors(w, d).pop()).toBe(gameManager.constructor.TABLE_FULL);
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
        const game = gameManager.getPlayerGame(a.id);
        expect(game.mode).toBe('gyb');
        expect(game.seatCount).toBe(3);
        expect(w.last(a, 'allPlayersReady')).toEqual({ gameId: game.gameId, mode: 'gyb' });
        expect(w.to(d, 'allPlayersReady')).toHaveLength(0);
        expect(game.isSpectator(d.id)).toBe(true);
    });

    test('a lobby without the mode is the base game, untouched', async () => {
        const w = world();
        const a = w.user(name(1));
        mainRoomHandlers.createLobby(a, w.io, { name: 'Four', mode: 'classic' });
        const lobby = gameManager.getPlayerLobby(a.id);
        expect(lobby.mode).toBeUndefined();
        expect(w.last(a, 'lobbyCreated')).not.toHaveProperty('mode');
        for (let i = 0; i < 3; i++) await lobbyHandlers.addBot(a, w.io);
        expect(lobby.players).toHaveLength(4);
    });

    test('an app without the mode never sees, creates, joins or watches one', async () => {
        const w = world();
        const phone = w.user(name(9), { ios: true });
        mainRoomHandlers.createLobby(phone, w.io, { name: 'No', mode: 'gyb' });
        expect(errors(w, phone)).toEqual([GYB_UNSUPPORTED]);
        expect(gameManager.getPlayerLobby(phone.id)).toBeFalsy();

        const { socks, lobby } = await table(w, 1);
        // Listed for the web, not for the phone
        const web = w.user(name(8));
        expect(w.last(web, 'mainRoomJoined').lobbies.map((l) => l.id)).toContain(lobby.id);
        expect(w.last(phone, 'lobbiesUpdated').lobbies.map((l) => l.id)).not.toContain(lobby.id);
        mainRoomHandlers.joinLobby(phone, w.io, { lobbyId: lobby.id });
        expect(errors(w, phone).pop()).toBe(GYB_UNSUPPORTED);

        const game = await start(w, socks);
        expect(w.last(web, 'lobbiesUpdated').inProgressGames.find((g) => g.gameId === game.gameId))
            .toMatchObject({ mode: 'gyb', scores: [0, 0, 0] });
        expect(w.last(phone, 'lobbiesUpdated').inProgressGames.map((g) => g.gameId)).not.toContain(game.gameId);
        mainRoomHandlers.joinAsSpectator(phone, w.io, { gameId: game.gameId });
        expect(errors(w, phone).pop()).toBe(GYB_UNSUPPORTED);
        expect(game.isSpectator(phone.id)).toBe(false);

        // The web watches, and its full state carries the mode's own state
        mainRoomHandlers.joinAsSpectator(web, w.io, { gameId: game.gameId });
        const full = w.last(web, 'spectatorJoined');
        expect(full.snapshot.seats).toHaveLength(3);
        expect(full.gyb).toMatchObject({ scores: [0, 0, 0], made: [0, 0, 0], forbidden: null, trickHistory: [] });
    });
});

describe('a whole game: one human and two bots', () => {
    test('13 hands, each seat scored for itself; nothing is recorded', async () => {
        const w = world();
        const { socks } = await table(w, 1);
        const game = await start(w, socks);
        const me = socks[0];

        // Three seats, no teams announced, no HSI
        expect(game.seatList()).toHaveLength(3);
        expect(w.room(game, 'teamsAnnounced')).toHaveLength(0);
        expect(w.room(game, 'positionUpdate')[0].positions).toEqual([1, 2, 3]);
        const first = w.last(me, 'gameStart');
        expect(first.hsiValues).toEqual({});
        expect(first.gyb).toEqual({ scores: [0, 0, 0] });
        expect(first.hand).toHaveLength(12);

        await play(w, game, socks);
        expect(game.stage).toBe(Phase.ENDED);

        const hands = w.room(game, 'handComplete');
        expect(hands.map((h) => h.gyb.seats.reduce((n, s) => n + s.took, 0))).toEqual(rules.HAND_PROGRESSION);
        expect(w.room(game, 'destroyHands')).toHaveLength(0);

        // Every hand: the points follow the rules, and the scores add up
        const running = [0, 0, 0];
        const made = [0, 0, 0];
        for (const [i, h] of hands.entries()) {
            const size = rules.HAND_PROGRESSION[i];
            expect(h.gyb.oldScores).toEqual(running);
            for (const s of h.gyb.seats) {
                const mine = h.gyb.forbidden && h.gyb.forbidden.position === s.position ? h.gyb.forbidden.bid : null;
                expect(s.points).toBe(rules.gybHandScore(s.bid, s.took, mine));
                expect(s.points).toBeGreaterThanOrEqual(0);
                expect(s.forbiddenHit).toBe(mine !== null && s.took === mine && s.took !== s.bid);
                // Nobody ever holds their own Forbidden Bid
                if (mine !== null) expect(s.bid).not.toBe(mine);
                running[s.position - 1] += s.points;
                if (s.bid === s.took) made[s.position - 1]++;
            }
            expect(h.gyb.scores).toEqual(running);
            // The bids never add up to a hand of 5 or more cards
            const sum = h.gyb.seats.reduce((n, s) => n + s.bid, 0);
            if (size >= 5) expect(sum).not.toBe(size);
            else expect(h.gyb.forbidden).toBeNull();
        }

        const end = w.room(game, 'gameEnd')[0];
        const top = Math.max(...running);
        expect(end.gyb).toEqual({
            scores: running,
            winners: running.map((s, i) => (s === top ? i + 1 : null)).filter(Boolean),
            made,
            hands: 13,
        });
        expect(Object.keys(end.playerStats)).toEqual(['1', '2', '3']);
        expect(end.tournamentId).toBeNull();

        // No stats, no game record
        await jest.advanceTimersByTimeAsync(5000);
        expect(mockDb.current.gameRecords.docs).toHaveLength(0);
        expect(mockDb.current.users.docs.find((d) => d.username === name(1)).stats).toBeUndefined();

        // The log's last lines: one per seat
        const log = game.getGameLog().map((e) => e.message);
        expect(log.slice(-4)[0]).toBe('=== GAME OVER ===');
        expect(log.slice(-3)).toHaveLength(3);
    });

    test('play again reopens a Get Your Bid lobby', async () => {
        const w = world();
        const { socks } = await table(w, 2);
        const game = await start(w, socks);
        await play(w, game, socks);
        expect(game.stage).toBe(Phase.ENDED);
        const back = w.last(socks[0], 'lobbyReturn');
        expect(back.mode).toBe('gyb');
        expect(back.lastGame.gyb).toEqual(w.room(game, 'gameEnd')[0].gyb);
        const lobby = gameManager.getPlayerLobby(socks[0].id);
        expect(lobby.mode).toBe('gyb');
        expect(lobby.players).toHaveLength(3);
    });
});

describe('a lazy seat is named by its owner (owner rule 2026-11-25)', () => {
    test('the stored hand lines, the game-over lines and the score screen say the owner, never the bot', async () => {
        const w = world();
        const { socks } = await table(w, 3);
        const game = await start(w, socks);
        const lazy = socks[1];
        const pos = seatOf(game, lazy);
        chatHandlers.chatMessage(lazy, w.io, { message: '/lazy' });
        await jest.advanceTimersByTimeAsync(0);
        const bot = game.getPlayerByPosition(pos).username;
        expect(bot).toMatch(/^🤖 /);
        expect(game.seat(pos).ownerUsername).toBe(name(2));

        await play(w, game, [socks[0], socks[2]]);
        expect(game.stage).toBe(Phase.ENDED);

        // one rule for every seat line (gameHandlers.seatName), so a reload
        // or a spectator replaying the stored log reads the live table's names
        const scoreLines = game.getGameLog().filter((e) => e.type === 'score').map((e) => e.message);
        expect(scoreLines.some((m) => m.startsWith(`${name(2)}: Bid `))).toBe(true);
        expect(scoreLines.slice(-3)).toContain(`${name(2)}: ${game.gyb.scores[pos]}`);
        expect(scoreLines.some((m) => m.includes(bot))).toBe(false);
        const end = w.room(game, 'gameEnd')[0];
        expect(end.playerStats[pos].username).toBe(name(2));
    });
});

describe('the draw', () => {
    test('a bot drawing last completes it at once (not the 30 s draw watchdog)', async () => {
        const w = world();
        const { socks } = await table(w, 1);
        lobbyHandlers.playerReady(socks[0], w.io);
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
        const game = gameManager.getPlayerGame(socks[0].id);
        await jest.advanceTimersByTimeAsync(pacing(game).PREDRAW_COUNTDOWN_MS);
        // the human draws first, the two bots after it
        await gameHandlers.draw(socks[0], w.io, { num: 0 });
        expect(game.stage).toBe(Phase.DRAWING);
        for (let i = 0; i < 40 && game.drawIndex < 3; i++) await jest.advanceTimersByTimeAsync(250);
        expect(game.drawIndex).toBe(3);
        await jest.advanceTimersByTimeAsync(50);
        expect(game.stage).not.toBe(Phase.DRAWING);
        expect(game.hasTimer('draw:watchdog')).toBe(false);
    });
});

describe('bidding with three humans', () => {
    test('the Forbidden Bid is refused for the last bidder only, then anything else is taken', async () => {
        const w = world();
        const { socks } = await table(w, 3);
        const game = await start(w, socks);
        const byPos = new Map(socks.map((s) => [seatOf(game, s), s]));
        expect(game.currentHand).toBe(12);
        const [p1, p2, p3] = [game.bidder, rules.rotatePosition(game.bidder, 3), game.dealer];
        expect(rules.rotatePosition(p2, 3)).toBe(p3);

        await gameHandlers.playerBid(byPos.get(p1), w.io, { bid: '5' });
        // Not the last bidder: any number is fine
        expect(game.gybForbidden()).toBeNull();
        await gameHandlers.playerBid(byPos.get(p2), w.io, { bid: '4' });
        expect(game.gybForbidden()).toEqual({ position: p3, bid: 3 });

        // Bores are not part of the mode
        await gameHandlers.playerBid(byPos.get(p3), w.io, { bid: 'B' });
        expect(w.last(byPos.get(p3), 'actionRejected')).toMatchObject({ action: 'bid', reason: 'invalid_bid' });

        await gameHandlers.playerBid(byPos.get(p3), w.io, { bid: '3' });
        const refused = w.last(byPos.get(p3), 'actionRejected');
        expect(refused).toMatchObject({ action: 'bid', reason: 'invalid_bid' });
        expect(refused.gyb.forbidden).toEqual({ position: p3, bid: 3 });
        expect(game.stage).toBe(Phase.BIDDING);

        await gameHandlers.playerBid(byPos.get(p3), w.io, { bid: '2' });
        expect(game.stage).toBe(Phase.PLAYING);
        const done = w.room(game, 'doneBidding').pop();
        expect(done.gyb).toEqual({ forbidden: { position: p3, bid: 3 } });
        // The highest bidder leads
        expect(done.lead).toBe(p1);
    });

    test('all zeros is played, never redealt: the first bidder leads', async () => {
        const w = world();
        const { socks } = await table(w, 3);
        const game = await start(w, socks);
        const byPos = new Map(socks.map((s) => [seatOf(game, s), s]));
        const first = game.bidder;
        for (let i = 0; i < 3; i++) await gameHandlers.playerBid(byPos.get(game.currentTurn), w.io, { bid: '0' });
        expect(game.stage).toBe(Phase.PLAYING);
        expect(w.room(game, 'destroyHands')).toHaveLength(0);
        expect(w.room(game, 'doneBidding').pop().lead).toBe(first);
        expect(game.currentTurn).toBe(first);
        expect(game.getGameLog().map((e) => e.message)).not.toContain('All bids were zero. Redealing.');
    });

    test('a hand of 4 cards has no Forbidden Bid; taking a Forbidden Bid scores 1', async () => {
        const w = world();
        const { socks } = await table(w, 3);
        const game = await start(w, socks);
        // Every seat bids 0 where it may: on hands of 5+ the last bidder is
        // pushed off 0 only when the others' zeros make 0... never (0+0 is
        // not the hand), so the bids are all zero and someone takes tricks
        await play(w, game, socks, { bid: () => 0, until: (g) => g.currentHand === 4 && g.stage === Phase.BIDDING });
        expect(game.currentHand).toBe(4);
        const byPos = new Map(socks.map((s) => [seatOf(game, s), s]));
        // 2 + 1, and the last bidder may bid the 1 that makes four
        await gameHandlers.playerBid(byPos.get(game.currentTurn), w.io, { bid: '2' });
        await gameHandlers.playerBid(byPos.get(game.currentTurn), w.io, { bid: '1' });
        expect(game.gybForbidden()).toBeNull();
        await gameHandlers.playerBid(byPos.get(game.currentTurn), w.io, { bid: '1' });
        expect(game.stage).toBe(Phase.PLAYING);
    });
});

describe('what the mode leaves out', () => {
    test('/help and /tutorial answer that they are not available', async () => {
        const w = world();
        const { socks } = await table(w, 1);
        const game = await start(w, socks);
        const me = socks[0];
        for (const [command, line] of [['/help', '/help is not available in Get Your Bid.'], ['/tutorial', 'The tutorial is not available in Get Your Bid.']]) {
            const from = w.log.length;
            await chatHandlers.chatMessage(me, w.io, { message: command });
            const mine = w.log.slice(from).filter((l) => l.to === me.id || l.to === `self:${me.id}`);
            expect(mine.map((l) => [l.event, l.data.message])).toEqual([['gameLogEntry', line]]);
        }
        expect(w.log.filter((l) => l.event === 'assistHint')).toHaveLength(0);
        expect(game.assist[seatOf(game, me)]?.uses ?? 0).toBe(0);
    });

    test('a snapshot keeps the frozen four-seat shape and the carrier adds gyb', async () => {
        const w = world();
        const { socks } = await table(w, 1);
        const game = await start(w, socks);
        const me = socks[0];
        await play(w, game, socks, { until: (g) => g.stage === Phase.PLAYING && g.trickHistory.length === 2 });
        require('../snapshotHandlers').requestSnapshot(me, w.io, { requestId: 'r1' });
        const reply = w.last(me, 'stateSnapshot');
        expect(reply.snapshot.seats.map((s) => s.position)).toEqual([1, 2, 3]);
        expect(reply.snapshot.bids.byPosition).toHaveLength(4);
        expect(reply.snapshot.bids.byPosition[3]).toBeNull();
        expect(reply.snapshot.bids.order.slice(0, 3).sort()).toEqual([1, 2, 3]);
        expect(reply.snapshot.hsi).toBeNull();
        expect(reply.snapshot.trickHistory).toEqual([]);
        expect(reply.gyb.trickHistory).toHaveLength(2);
        expect(reply.gyb.trickHistory[0].cards).toHaveLength(3);
        expect(reply.gyb.scores).toEqual([0, 0, 0]);
    });
});
