/**
 * A snapshot's log respects the viewer's block list (deploy survival PR 2).
 *
 * Both clients hide a blocked sender's live chatMessage by username, but a
 * snapshot's log used to replay every chat line, so a rejoin, a restore, a
 * spectator join or a requestSnapshot brought the blocked player's chat
 * back. Now:
 *   - a chat log entry carries its sender as an internal `from` (chat
 *     handler: the username the broadcast names; bots: the bot's name),
 *     and GameState.logTotal counts every line ever added;
 *   - buildSnapshotV2 {hideChatFrom} drops 'chat' entries whose `from` is
 *     listed; snapshotHandlers.carrierFor and requestSnapshot pass the
 *     receiving socket's socket.data.blockedUsers;
 *   - system lines are kept, and a log entry on the wire is still exactly
 *     {message, type, position, at} (`from` never leaves the server);
 *   - an admin rename or merge re-points `from` (renameChatSender), as it
 *     re-points the blockers' lists (adminPanel.test.js drives the panel).
 * Main's later chat paths ride the same two writers: the "they sent a boy"
 * quip goes through sendBotChat, and a family game's lobby extras and
 * voice spectators chat as spectators and get their full state through
 * carrierFor (also on a startedLobbyRedirect). Lobby chat is never in a
 * game log (lobbyReturn carries the lobby's own messages, as joinLobby's
 * lobbyCreated always has).
 * Real handlers, stub io (contract-checked).
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const { botController } = require('../../game/bot');
const chatHandlers = require('../chatHandlers');
const gameHandlers = require('../gameHandlers');
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const safetyHandlers = require('../safetyHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const { rememberBlockList } = require('../voiceHandlers');
const { buildSnapshotV2 } = require('../../game/snapshotV2');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let n = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn', 'error']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager.spectatorGames.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/** Seated 4-human game in BIDDING (seat 3 on turn), every seat an account. */
function table() {
    n++;
    const log = [];
    const io = makeIo(log);
    const sids = {};
    const sockets = {};
    const names = {};
    for (let pos = 1; pos <= 4; pos++) {
        sids[pos] = `bc${n}-p${pos}`;
        names[pos] = `bc${n}u${pos}`;
        gameManager.registerUser(sids[pos], names[pos]);
        mockDb.current.users.insertOne({ username: names[pos], blockedUsers: [] });
    }
    const game = gameManager.createGame([1, 2, 3, 4].map((p) => sids[p]));
    for (let pos = 1; pos <= 4; pos++) {
        game.addPlayer(sids[pos], names[pos], pos, pos, false);
        sockets[pos] = makeSocket(sids[pos], log, io);
        sockets[pos].join(game.roomName);
    }
    for (let pos = 1; pos <= 4; pos++) game.setHand(game.positions[pos], [C(String(pos + 2), 'hearts'), C(String(pos + 6), 'clubs')]);
    game.currentHand = 2;
    game.trump = C('A', 'spades');
    game.forcePhase(Phase.BIDDING);
    game.bidder = 3;
    game.currentTurn = 3;
    return { log, io, game, sids, sockets, names };
}

async function drop(t, socket) {
    t.io.sockets.sockets.delete(socket.id);
    for (const members of t.io.rooms.values()) members.delete(socket.id);
    await queueHandlers.handleDisconnect(socket, t.io);
}

function newSocket(t, username) {
    n++;
    const s = makeSocket(`bc-s${n}`, t.log, t.io);
    gameManager.registerUser(s.id, username);
    return s;
}

const say = (t, socket, message) => chatHandlers.chatMessage(socket, t.io, { message });
const mine = (t, s, event) => t.log.filter((l) => l.to === `self:${s.id}` && l.event === event).map((l) => l.data);
const messages = (snapshot) => snapshot.log.map((e) => e.message);

/**
 * Chat from seat 2 and seat 3 plus a system line in between: seat 2's
 * line is the one a viewer blocks.
 */
function chatter(t) {
    say(t, t.sockets[2], 'hello from two');
    t.game.addLogEntry('A system line.', null, 'system');
    say(t, t.sockets[3], 'hello from three');
    const lines = {
        two: `${t.names[2]}: hello from two`,
        three: `${t.names[3]}: hello from three`,
        system: 'A system line.',
    };
    // All three are in the game's log, so a missing line below is the filter
    expect(t.game.gameLog.map((e) => e.message)).toEqual(expect.arrayContaining(Object.values(lines)));
    return lines;
}

/** The log a viewer that blocked seat 2 gets, against everyone else's. */
function expectHidesTwo(snapshot, lines) {
    const got = messages(snapshot);
    expect(got).not.toContain(lines.two);
    expect(got).toEqual(expect.arrayContaining([lines.three, lines.system]));
}

function expectWireEntries(snapshot) {
    for (const e of snapshot.log) expect(Object.keys(e)).toEqual(['message', 'type', 'position', 'at']);
}

describe('the chat sender on the log entry', () => {
    test('seat, spectator and bot chat carry `from`; system lines do not; logTotal counts every line', () => {
        const t = table();
        const before = t.game.logTotal;
        chatter(t);
        const fanName = `bc${n}fan`;
        const fan = newSocket(t, fanName);
        mainRoomHandlers.joinAsSpectator(fan, t.io, { gameId: t.game.gameId });
        say(t, fan, 'go team');

        // A lazy seat 4 (not on turn): its bot's quip is logged with the bot's name
        say(t, t.sockets[4], '/lazy');
        const bot = botController.getGameBots(t.game.gameId).find((b) => b.position === 4);
        botController.sendBotChat(t.io, t.game, bot, 'nice hand', 0);
        jest.advanceTimersByTime(1);

        const chat = t.game.gameLog.filter((e) => e.type === 'chat');
        expect(chat.map((e) => [e.message, e.from])).toEqual([
            [`${t.names[2]}: hello from two`, t.names[2]],
            [`${t.names[3]}: hello from three`, t.names[3]],
            [`${fanName}: go team`, fanName],
            [`${bot.username}: nice hand`, bot.username],
        ]);
        for (const e of t.game.gameLog.filter((x) => x.type !== 'chat')) expect('from' in e).toBe(false);
        expect(t.game.logTotal - before).toBe(t.game.gameLog.length);

        // The live chatMessage is unchanged: no `from` on the wire
        for (const l of events(t.log, 'chatMessage')) {
            expect(Object.keys(l.data).sort()).toEqual(['isSpectator', 'message', 'position', 'seq', 'username']);
        }
    });

    test('logTotal keeps counting past the 500-line cap', () => {
        const t = table();
        const before = t.game.logTotal;
        for (let i = 0; i < 520; i++) t.game.addLogEntry(`line ${i}`, null, 'system');
        expect(t.game.gameLog).toHaveLength(500);
        expect(t.game.logTotal).toBe(before + 520);
    });
});

describe('buildSnapshotV2 {hideChatFrom}', () => {
    test('drops only chat entries whose `from` is listed (Set or array); everything else stays', () => {
        const t = table();
        const lines = chatter(t);
        // A non-chat line that names the blocked player stays
        t.game.addLogEntry(`${t.names[2]} bid 3`, 2, 'bid');
        // A chat entry with no `from` (none is written any more) stays
        t.game.gameLog.push({ message: 'legacy: hi', playerPosition: 1, type: 'chat', timestamp: 1 });

        const full = buildSnapshotV2(t.game, t.sids[1], { now: 1 });
        for (const hide of [new Set([t.names[2]]), [t.names[2]]]) {
            const snap = buildSnapshotV2(t.game, t.sids[1], { now: 1, hideChatFrom: hide });
            expect(snap.log).toEqual(full.log.filter((e) => e.message !== lines.two));
            expect(messages(snap)).toEqual(expect.arrayContaining([`${t.names[2]} bid 3`, 'legacy: hi', lines.system]));
            expectWireEntries(snap);
        }
        // Nothing to hide: the same log
        for (const hide of [null, undefined, new Set(), [], new Set(['nobody'])]) {
            expect(buildSnapshotV2(t.game, t.sids[1], { now: 1, hideChatFrom: hide }).log).toEqual(full.log);
        }
        // log:false still sends no log, and says so
        const lite = buildSnapshotV2(t.game, t.sids[1], { now: 1, log: false, hideChatFrom: [t.names[2]] });
        expect(lite.log).toEqual([]);
        expect(lite.partial).toContain('log');
        // Pure: the game's own log is untouched
        expect(t.game.gameLog.some((e) => e.message === lines.two)).toBe(true);
    });
});

describe('every snapshot sent to a socket that blocked the sender leaves the chat out', () => {
    test('stateSnapshot (requestSnapshot): the blocker misses the line, everyone else gets it', () => {
        const t = table();
        const lines = chatter(t);
        rememberBlockList(t.sockets[1], [t.names[2]]);

        snapshotHandlers.requestSnapshot(t.sockets[1], t.io, { requestId: 7 });
        snapshotHandlers.requestSnapshot(t.sockets[4], t.io, {});
        const [blocker] = mine(t, t.sockets[1], 'stateSnapshot');
        const [other] = mine(t, t.sockets[4], 'stateSnapshot');
        expect(blocker.requestId).toBe(7);
        expectHidesTwo(blocker.snapshot, lines);
        expect(messages(other.snapshot)).toEqual(expect.arrayContaining([lines.two, lines.three, lines.system]));
        expectWireEntries(blocker.snapshot);
    });

    test('rejoinSuccess (reconnectOwner)', async () => {
        const t = table();
        const lines = chatter(t);
        await drop(t, t.sockets[1]);
        const s = newSocket(t, t.names[1]);
        rememberBlockList(s, [t.names[2]]);
        await reconnectHandlers.rejoinGame(s, t.io, { gameId: t.game.gameId, username: t.names[1] });
        const [ok] = mine(t, s, 'rejoinSuccess');
        expect(ok.snapshot.viewer).toMatchObject({ role: 'seat', position: 1 });
        expectHidesTwo(ok.snapshot, lines);
        expectWireEntries(ok.snapshot);
    });

    test('rejoinSuccess (watchSeat) and restorePlayerState (/active)', async () => {
        const t = table();
        say(t, t.sockets[1], '/lazy');
        const lines = chatter(t);
        await drop(t, t.sockets[1]);
        const s = newSocket(t, t.names[1]);
        rememberBlockList(s, [t.names[2]]);
        await reconnectHandlers.rejoinGame(s, t.io, { gameId: t.game.gameId, username: t.names[1] });
        const [ok] = mine(t, s, 'rejoinSuccess');
        expect(ok.snapshot.viewer).toMatchObject({ role: 'lazyWatcher', position: 1 });
        expectHidesTwo(ok.snapshot, lines);

        say(t, s, '/active');
        const [restore] = mine(t, s, 'restorePlayerState');
        expect(restore.snapshot.viewer).toMatchObject({ role: 'seat', position: 1 });
        expectHidesTwo(restore.snapshot, lines);
    });

    test('restorePlayerState after a card not in the hand', async () => {
        const t = table();
        const lines = chatter(t);
        for (const pos of [1, 2, 3, 4]) rememberBlockList(t.sockets[pos], [t.names[2]]);
        for (const pos of [3, 4, 1, 2]) await gameHandlers.playerBid(t.sockets[pos], t.io, { bid: '1', position: pos });
        expect(t.game.stage).toBe(Phase.PLAYING);
        const lead = t.game.currentTurn;
        await gameHandlers.playCard(t.sockets[lead], t.io, { card: C('HI', 'joker'), position: lead });
        const [restore] = mine(t, t.sockets[lead], 'restorePlayerState');
        expectHidesTwo(restore.snapshot, lines);
    });

    test('spectatorJoined full state', () => {
        const t = table();
        const lines = chatter(t);
        const fan = newSocket(t, `bc${n}fan`);
        rememberBlockList(fan, [t.names[2]]);
        mainRoomHandlers.joinAsSpectator(fan, t.io, { gameId: t.game.gameId });
        const [full] = mine(t, fan, 'spectatorJoined');
        expect(full.snapshot.viewer.role).toBe('spectator');
        expectHidesTwo(full.snapshot, lines);
        expectWireEntries(full.snapshot);
    });

    test('blocked spectator chat is hidden from a seat that blocked the spectator', () => {
        const t = table();
        const fanName = `bc${n}fan`;
        const fan = newSocket(t, fanName);
        mainRoomHandlers.joinAsSpectator(fan, t.io, { gameId: t.game.gameId });
        say(t, fan, 'boo');
        expect(t.game.gameLog.some((e) => e.message === `${fanName}: boo`)).toBe(true);
        rememberBlockList(t.sockets[1], [fanName]);
        snapshotHandlers.requestSnapshot(t.sockets[1], t.io, {});
        snapshotHandlers.requestSnapshot(t.sockets[2], t.io, {});
        const [reply] = mine(t, t.sockets[1], 'stateSnapshot');
        expect(messages(reply.snapshot)).not.toContain(`${fanName}: boo`);
        expect(messages(mine(t, t.sockets[2], 'stateSnapshot')[0].snapshot)).toContain(`${fanName}: boo`);
    });

    test('a blocked bot persona: its quips leave the log, its system lines stay', () => {
        const t = table();
        say(t, t.sockets[4], '/lazy');
        const bot = botController.getGameBots(t.game.gameId).find((b) => b.position === 4);
        botController.sendBotChat(t.io, t.game, bot, 'nice hand', 0);
        jest.advanceTimersByTime(1);
        rememberBlockList(t.sockets[1], [bot.username]);
        snapshotHandlers.requestSnapshot(t.sockets[1], t.io, {});
        const [reply] = mine(t, t.sockets[1], 'stateSnapshot');
        const got = messages(reply.snapshot);
        expect(got).not.toContain(`${bot.username}: nice hand`);
        // "<owner> entered lazy mode. <bot> is playing." names the bot and stays
        expect(got.some((m) => m.includes(bot.username) && m.includes('lazy mode'))).toBe(true);
    });

    test('the "they sent a boy" quip: `from` is the bot persona, hidden from its blocker', () => {
        const t = table();
        say(t, t.sockets[4], '/lazy');
        const bot = botController.getGameBots(t.game.gameId).find((b) => b.position === 4);
        // Seat 1 leads a heart, seat 3 ruffs with the 2 of trump (spades):
        // the cheap ruff an opposing bot (seat 4) remarks on
        t.game.leadCard = C('5', 'hearts');
        t.game.playedCards = [C('5', 'hearts'), null, C('2', 'spades'), null];
        t.game.playedCardsIndex = 2;
        const realRoll = botController.chatRoll;
        botController.chatRoll = () => 0;
        try {
            botController.handleCardPlayedChat(t.io, t.game, C('2', 'spades'), 3);
        } finally {
            botController.chatRoll = realRoll;
        }
        jest.advanceTimersByTime(10000);
        const line = `${bot.username}: they sent a boy`;
        expect(t.game.gameLog.find((e) => e.message === line)).toMatchObject({ type: 'chat', from: bot.username });
        rememberBlockList(t.sockets[1], [bot.username]);
        snapshotHandlers.requestSnapshot(t.sockets[1], t.io, {});
        snapshotHandlers.requestSnapshot(t.sockets[2], t.io, {});
        expect(messages(mine(t, t.sockets[1], 'stateSnapshot')[0].snapshot)).not.toContain(line);
        expect(messages(mine(t, t.sockets[2], 'stateSnapshot')[0].snapshot)).toContain(line);
    });

    test('a family game\'s voice spectator: its table chat is hidden from a blocker, and its own full state hides whom it blocked', () => {
        const clientInfo = require('../clientInfo');
        const gameVoice = require('../../voice/gameVoice');
        const t = table();
        gameVoice.initCasualVoice(t.game, { host: t.names[1], io: t.io });
        const lines = chatter(t);
        const extraName = `bc${n}extra`;
        const extra = newSocket(t, extraName);
        clientInfo.handle(extra, t.io, { client: 'web', version: '1', caps: ['avatarUrl', 'casualSpectators'] });
        rememberBlockList(extra, [t.names[2]]);
        // A lobby extra re-sending joinLobby lands here too (startedLobbyRedirect)
        mainRoomHandlers.joinAsSpectator(extra, t.io, { gameId: t.game.gameId }, { fromLobby: true });
        expect(t.game.voiceSpectators.has(extra.id)).toBe(true);
        const [full] = mine(t, extra, 'spectatorJoined');
        expectHidesTwo(full.snapshot, lines);
        expectWireEntries(full.snapshot);

        say(t, extra, 'watching from the lobby');
        const line = `${extraName}: watching from the lobby`;
        expect(t.game.gameLog.find((e) => e.message === line)).toMatchObject({ type: 'chat', from: extraName });
        rememberBlockList(t.sockets[1], [extraName]);
        snapshotHandlers.requestSnapshot(t.sockets[1], t.io, {});
        snapshotHandlers.requestSnapshot(t.sockets[3], t.io, {});
        expect(messages(mine(t, t.sockets[1], 'stateSnapshot')[0].snapshot)).not.toContain(line);
        expect(messages(mine(t, t.sockets[3], 'stateSnapshot')[0].snapshot)).toContain(line);
    });

    test('blockUser / unblockUser take effect at the next snapshot', async () => {
        const t = table();
        const lines = chatter(t);
        await safetyHandlers.blockUser(t.sockets[1], t.io, { username: t.names[2] });
        expect(mine(t, t.sockets[1], 'blockListUpdated')[0]).toMatchObject({ success: true, blockedUsers: [t.names[2]] });
        snapshotHandlers.requestSnapshot(t.sockets[1], t.io, {});
        expectHidesTwo(mine(t, t.sockets[1], 'stateSnapshot')[0].snapshot, lines);

        await safetyHandlers.unblockUser(t.sockets[1], t.io, { username: t.names[2] });
        snapshotHandlers.requestSnapshot(t.sockets[1], t.io, {});
        expect(messages(mine(t, t.sockets[1], 'stateSnapshot')[1].snapshot)).toContain(lines.two);
    });

    test('a socket with no block list loaded gets the whole log', () => {
        const t = table();
        const lines = chatter(t);
        delete t.sockets[1].data.blockedUsers;
        snapshotHandlers.requestSnapshot(t.sockets[1], t.io, {});
        expect(messages(mine(t, t.sockets[1], 'stateSnapshot')[0].snapshot)).toEqual(expect.arrayContaining([lines.two, lines.three, lines.system]));
    });
});

describe('an admin rename or merge re-points `from` (renameChatSender)', () => {
    test('GameState: only chat lines sent under the old name move; the visible text, other lines and legacy entries stay', () => {
        const t = table();
        const lines = chatter(t);
        t.game.addLogEntry(`${t.names[2]} bid 3`, 2, 'bid');
        t.game.gameLog.push({ message: 'legacy: hi', playerPosition: 2, type: 'chat', timestamp: 1 });
        const before = t.game.gameLog.map((e) => ({ ...e }));

        expect(t.game.renameChatSender(t.names[2], 'Renamed2')).toBe(1);
        expect(t.game.gameLog.map((e) => e.message)).toEqual(before.map((e) => e.message));
        expect(t.game.gameLog.map((e) => e.from)).toEqual(before.map((e) => (e.from === t.names[2] ? 'Renamed2' : e.from)));
        expect(t.game.gameLog.find((e) => e.message === lines.two).from).toBe('Renamed2');
        // Again: nothing left under the old name
        expect(t.game.renameChatSender(t.names[2], 'Renamed2')).toBe(0);

        // A blocker whose list now names the new name still misses the line
        rememberBlockList(t.sockets[1], ['Renamed2']);
        snapshotHandlers.requestSnapshot(t.sockets[1], t.io, {});
        const snap = mine(t, t.sockets[1], 'stateSnapshot')[0].snapshot;
        expectHidesTwo(snap, lines);
        expectWireEntries(snap);
        // ...and the old name no longer matches it
        rememberBlockList(t.sockets[1], [t.names[2]]);
        snapshotHandlers.requestSnapshot(t.sockets[1], t.io, {});
        expect(messages(mine(t, t.sockets[1], 'stateSnapshot')[1].snapshot)).toContain(lines.two);
    });

    test('GameManager: every live game', () => {
        const a = table();
        const b = table();
        const fan = 'bcFanAcrossGames';
        for (const t of [a, b]) t.game.addLogEntry(`${fan}: hi`, null, 'chat', { from: fan });
        expect(gameManager.renameChatSender(fan, 'bcFanNew')).toBe(2);
        for (const t of [a, b]) expect(t.game.gameLog.filter((e) => e.from === 'bcFanNew')).toHaveLength(1);
    });
});
