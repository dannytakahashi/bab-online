/**
 * Spectator chat on the wire (owner, 2026-11-11: the web shows a
 * spectator's message by the spectator badge, "Zach: hello"). Real
 * handlers, stub io/sockets (gameDriver: every emit is contract-checked),
 * fake timers. Pins what the web client keys the bubble on:
 *
 *   - a pure spectator's chat: {position: null, isSpectator: true, type:
 *     'spectator'} to the room, the spectator's own socket included; one
 *     who chats as it joins is heard before the coalesced spectatorsUpdated
 *     lists it (the badge may still be hidden: the web anchors the bubble
 *     at the layout's spot);
 *   - a seat-view lazy owner and a player: {position, isSpectator: false}
 *     (over the seat, unchanged);
 *   - a watching owner (rejoined while its bot plays): spectator-shaped, but
 *     never on the spectator list (the badge does not count it).
 *
 * The room's chatMessage / spectatorsUpdated sequence is recorded in
 * contract/fixtures/web/spectator-chat.json, which the web replays through
 * the real page (client/src/table/spectatorChatReplay.test.js). The test
 * fails when the recording is stale: UPDATE_WEB_FIXTURES=1 rewrites it.
 */

const fs = require('fs');
const path = require('path');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const chatHandlers = require('../chatHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const { Phase } = require('../../game/GamePhase');
const { SPECTATORS_COALESCE_MS } = require('../../game/spectatorRoster');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

const FIXTURE = path.resolve(__dirname, '../../../contract/fixtures/web/spectator-chat.json');
const UPDATE = process.env.UPDATE_WEB_FIXTURES === '1';
const C = (rank, suit) => ({ rank, suit });

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager.spectatorGames.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/** Seated 4-human game in BIDDING (one card each). */
function table() {
    const log = [];
    const io = makeIo(log);
    const sids = {};
    const sockets = {};
    for (let pos = 1; pos <= 4; pos++) {
        sids[pos] = `sc-p${pos}`;
        gameManager.registerUser(sids[pos], `user${pos}`);
        mockDb.current.users._insert({ username: `user${pos}`, profilePic: pos });
    }
    const game = gameManager.createGame([1, 2, 3, 4].map((p) => sids[p]));
    for (let pos = 1; pos <= 4; pos++) {
        game.addPlayer(sids[pos], `user${pos}`, pos, pos, false);
        sockets[pos] = makeSocket(sids[pos], log, io);
        io.sockets.sockets.set(sids[pos], sockets[pos]);
        sockets[pos].join(game.roomName);
    }
    for (let pos = 1; pos <= 4; pos++) game.setHand(game.positions[pos], [C(String(pos + 2), 'hearts')]);
    game.currentHand = 1;
    game.trump = C('A', 'spades');
    game.forcePhase(Phase.BIDDING);
    game.bidder = 3;
    game.currentTurn = 3;
    return { log, io, game, sockets };
}

function signedIn(t, id, username, pic) {
    const s = makeSocket(id, t.log, t.io);
    t.io.sockets.sockets.set(id, s);
    gameManager.registerUser(id, username);
    if (pic != null) mockDb.current.users._insert({ username, profilePic: pic });
    return s;
}

const say = (t, socket, message) => chatHandlers.chatMessage(socket, t.io, { message });
async function settle() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    jest.advanceTimersByTime(SPECTATORS_COALESCE_MS);
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** The room's chatMessage and spectatorsUpdated, in order (gameId and seq left to the replay). */
function roomSequence(t) {
    return t.log
        .filter((l) => l.to === t.game.roomName && (l.event === 'chatMessage' || l.event === 'spectatorsUpdated'))
        .map(({ event, data }) => {
            const { seq, gameId, ...rest } = data;
            return { event, data: rest };
        });
}

test('spectator chat: shapes, the early chat before the list, the watching owner, the recording', async () => {
    const t = table();

    // a fan joins and chats in the same breath: heard before the list lands
    const fan = signedIn(t, 'sc-fan', 'fan', 12);
    mainRoomHandlers.joinAsSpectator(fan, t.io, { gameId: t.game.gameId });
    say(t, fan, 'hello');
    const early = events(t.log, 'chatMessage');
    expect(early.map((l) => l.to)).toEqual([t.game.roomName]);
    expect(early[0].data).toEqual({ position: null, message: 'hello', username: 'fan', isSpectator: true, type: 'spectator', seq: expect.any(Number) });
    expect(events(t.log, 'spectatorsUpdated')).toEqual([]);
    // the fan's own socket is in the room: it hears its own message
    expect(t.io.rooms.get(t.game.roomName).has(fan.id)).toBe(true);
    await settle();
    expect(events(t.log, 'spectatorsUpdated').map((l) => l.data.spectators.map((s) => s.username))).toEqual([['fan']]);

    // a second spectator, after the list
    const kim = signedIn(t, 'sc-kim', 'kim', 4);
    mainRoomHandlers.joinAsSpectator(kim, t.io, { gameId: t.game.gameId });
    await settle();
    say(t, kim, 'me too');

    // a player at its seat, and a seat-view lazy owner: from the seat
    say(t, t.sockets[1], 'gl');
    say(t, t.sockets[2], '/lazy');
    say(t, t.sockets[2], 'brb');

    // a watching owner: /lazy, then back from another tab (watch view)
    say(t, t.sockets[4], '/lazy');
    const tab = signedIn(t, 'sc-p4-tab', 'user4', null);
    await reconnectHandlers.rejoinGame(tab, t.io, { gameId: t.game.gameId, username: 'user4' });
    expect(t.game.seat(4).ownerView).toBe('watch');
    say(t, tab, 'watching my bot');
    await settle();
    // never on the spectator list (the badge does not count it)
    expect(t.game.spectatorList().map((s) => s.username)).toEqual(['fan', 'kim']);

    const chats = events(t.log, 'chatMessage').filter((l) => l.to === t.game.roomName).map((l) => {
        const { seq, ...rest } = l.data;
        return rest;
    });
    expect(chats).toEqual([
        { position: null, message: 'hello', username: 'fan', isSpectator: true, type: 'spectator' },
        { position: null, message: 'me too', username: 'kim', isSpectator: true, type: 'spectator' },
        { position: 1, message: 'gl', username: 'user1', isSpectator: false, type: 'player' },
        { position: 2, message: 'brb', username: 'user2', isSpectator: false, type: 'player' },
        { position: null, message: 'watching my bot', username: 'user4', isSpectator: true, type: 'spectator' },
    ]);

    const recording = { note: 'server/socket/__tests__/spectatorChat.test.js (UPDATE_WEB_FIXTURES=1 rewrites it)', room: roomSequence(t) };
    const text = `${JSON.stringify(recording, null, 1)}\n`;
    if (UPDATE) {
        fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
        fs.writeFileSync(FIXTURE, text);
    }
    expect(fs.existsSync(FIXTURE)).toBe(true);
    expect(fs.readFileSync(FIXTURE, 'utf8')).toBe(text);
});
