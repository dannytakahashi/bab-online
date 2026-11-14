/**
 * contract/V1_REMOVALS.md #14 (socket ids on the wire, 2026-11-12), checked
 * against what web on main and iOS 1.2.0 read:
 *
 * - gone: playerDrew.socketId (every draw path: the handler, the watchdog's
 *   autoDraw, a bot's draw), positionUpdate.usernames[].socketId and the v1
 *   client states' players[].socketId (rejoinSuccess, restorePlayerState,
 *   the spectator full state);
 * - added: positionUpdate.isBot[] (per seat, in positions order), the same
 *   fact iOS 1.2.0 takes from the seat socket's 'bot:' prefix today;
 * - kept: positionUpdate.sockets (iOS 1.2.0 build 5 reads isBot[] first and
 *   the sockets only as fallbacks; TestFlight builds 3-4 read only the bot:
 *   prefix), the lobby
 *   players' socketId (removeBot) and the voice signaling ids.
 *
 * Real handlers on stub io/sockets (gameDriver, contract guard on), the
 * in-memory DB fake, fake timers.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
    whenReady: () => Promise.resolve(true),
}));

const contract = require('../../../contract');
const baseline = require('../../../contract/v1-baseline.schema.json');
const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const gameLifecycle = require('../gameLifecycle');
const queueHandlers = require('../queueHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const chatHandlers = require('../chatHandlers');
const { botController } = require('../../game/bot');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

let seq = 0;

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
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/** 2 humans + 2 bots in the draw: h1 draws by hand, h2 is left to the 30 s watchdog (autoDraw). */
async function seatedGame() {
    seq++;
    const log = [];
    const io = makeIo(log);
    const ids = [`sid${seq}-h1`, `sid${seq}-h2`];
    const names = ids.map((_, i) => `sidu${seq}_${i + 1}`);
    ids.forEach((id, i) => {
        gameManager.registerUser(id, names[i]);
        mockDb.current.users._insert({ username: names[i] });
    });
    const bots = [botController.createBot('🤖 S0', 'mary'), botController.createBot('🤖 S1', 'sharon')];
    const game = gameManager.createGame([...ids, ...bots.map((b) => b.socketId)]);
    bots.forEach((b) => botController.registerBot(game.gameId, b));
    const sockets = ids.map((id) => makeSocket(id, log, io));
    sockets.forEach((s) => s.join(game.roomName));
    gameLifecycle.beginDraw(io, game);
    const drew = gameHandlers.draw(sockets[0], io, { num: 0 });
    for (let i = 0; i < 120 && game.stage !== Phase.BIDDING; i++) await jest.advanceTimersByTimeAsync(500);
    await drew;
    expect(game.stage).toBe(Phase.BIDDING);
    return { log, io, game, ids, names, sockets, bots };
}

/** Every key in a payload, nested. */
function keysDeep(v, out = new Set()) {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
    return out;
}

describe('#14 socket ids on the wire', () => {
    test('playerDrew carries no socketId on any draw path (handler, watchdog autoDraw, bot)', async () => {
        const t = await seatedGame();
        const drew = events(t.log, 'playerDrew');
        expect(drew).toHaveLength(4);
        expect(drew.map((l) => l.data.username).sort()).toEqual([...t.names, ...t.bots.map((b) => b.username)].sort());
        for (const l of drew) expect(Object.keys(l.data).sort()).toEqual(['card', 'drawOrder', 'seq', 'username']);
    });

    test('positionUpdate: usernames[] without socketId, sockets kept, isBot per seat from the bot: prefix', async () => {
        const t = await seatedGame();
        const [pu] = events(t.log, 'positionUpdate');
        const d = pu.data;
        expect(d.positions).toEqual([1, 2, 3, 4]);
        expect(d.sockets).toHaveLength(4); // kept (V1_REMOVALS #14)
        for (const u of d.usernames) expect(Object.keys(u)).toEqual(['username']);
        expect(d.isBot).toEqual(d.sockets.map((s) => s.startsWith('bot:')));
        expect(d.isBot.filter(Boolean)).toHaveLength(2);
        // isBot lines up with the seats: a human's name is never marked a bot
        d.usernames.forEach((u, i) => expect(d.isBot[i]).toBe(!t.names.includes(u.username)));
    });

    test('rejoinSuccess, restorePlayerState and the spectator full state: players[] without socketId', async () => {
        const t = await seatedGame();
        // a pure spectator gets the full state
        const spec = makeSocket(`sid${seq}-spec`, t.log, t.io);
        gameManager.registerUser(spec.id, `sidwatch${seq}`);
        mainRoomHandlers.joinAsSpectator(spec, t.io, { gameId: t.game.gameId });
        const full = t.log.filter((l) => l.event === 'spectatorJoined' && l.to === `self:${spec.id}`);
        expect(full).toHaveLength(1);
        expect(full[0].data.players).toHaveLength(4);
        expect(keysDeep(full[0].data.players).has('socketId')).toBe(false);

        // h1 drops and rejoins from a new socket
        t.io.sockets.sockets.delete(t.ids[0]);
        for (const members of t.io.rooms.values()) members.delete(t.ids[0]);
        await queueHandlers.handleDisconnect(t.sockets[0], t.io);
        const back = makeSocket(`sid${seq}-back`, t.log, t.io);
        gameManager.registerUser(back.id, t.names[0]);
        await reconnectHandlers.rejoinGame(back, t.io, { gameId: t.game.gameId, username: t.names[0] });
        const rs = t.log.filter((l) => l.event === 'rejoinSuccess' && l.to === `self:${back.id}`);
        expect(rs).toHaveLength(1);
        expect(rs[0].data.players.map((p) => Object.keys(p).sort())).toEqual(Array(4).fill(['pic', 'position', 'username']));

        // getClientState (the legacy state; the carriers are snapshotHandlers.carrierFor since #9) carries none either
        const st = t.game.getClientState(back.id);
        expect(st.players.map((p) => Object.keys(p).sort())).toEqual(Array(4).fill(['pic', 'position', 'username']));
    });

    test('kept: the lobby players\' socketId (removeBot) and the voice peers\' socketId', () => {
        seq++;
        const log = [];
        const io = makeIo(log);
        const id = `sid${seq}-lob`;
        gameManager.registerUser(id, `sidlob${seq}`);
        const sock = makeSocket(id, log, io);
        const lobby = gameManager.createLobby([id]);
        lobbyHandlers.addBot(sock, io);
        expect(lobby.players[1].socketId).toMatch(/^bot:/);
        const wire = log.filter((l) => l.data && Array.isArray(l.data.players)).pop();
        expect(wire.data.players.map((p) => p.socketId)).toEqual([id, lobby.players[1].socketId]);
        lobbyHandlers.removeBot(sock, io, { botSocketId: lobby.players[1].socketId });
        expect(lobby.players).toHaveLength(1);
        expect(contract.schema.$defs.lobbyMember.required).toContain('socketId');
        expect(contract.schema.$defs.voicePeer.required).toContain('socketId');
    });

    test('contract and baseline: the removed keys are gone, isBot is listed as added', () => {
        const pu = contract.schema.s2c.positionUpdate;
        expect(pu.added).toContain('isBot');
        expect(pu.payload.required).toContain('isBot');
        expect(pu.payload.required).toContain('sockets');
        for (const s of [pu.payload, baseline.s2c.positionUpdate.payload]) {
            expect(Object.keys(s.properties.usernames.items.properties)).toEqual(['username']);
        }
        for (const s of [contract.schema.s2c.playerDrew.payload, baseline.s2c.playerDrew.payload]) {
            expect(s.properties).not.toHaveProperty('socketId');
        }
        for (const d of [contract.schema.$defs.playerInfoV1, baseline.$defs.playerInfoV1]) {
            expect(d.properties).not.toHaveProperty('socketId');
        }
    });
});

/**
 * iOS 1.2.0 build 5 (iOSClient/ at main 92d0c75) reads positionUpdate.isBot
 * first and falls back to the seat socket's 'bot:' prefix per seat
 * (TableReducer+Events.swift:252:
 *   isBot = (i < isBot.count ? isBot[i] : nil) ?? sid.hasPrefix("bot:")).
 * With isBot on the wire it must reach the same seat kind the prefix gave
 * for every seat positionUpdate can carry: a connected human, a human
 * seated in reconnect grace (dropped during the draw), a draw-phase leaver's
 * seat (resignBot, shown as the bot persona: what a lazy human's seat looks
 * like) and native bots (lobby, tournament and the ambient all-bot game).
 */
describe('#14 isBot[] agrees with the bot: prefix for every seat kind (iOS 1.2.0 build 5)', () => {
    /** build 5's rule, per seat */
    const build5IsBot = (pu, i) => ((Array.isArray(pu.isBot) && i < pu.isBot.length) ? pu.isBot[i] : null)
        ?? (typeof pu.sockets?.[i] === 'string' && pu.sockets[i].startsWith('bot:'));
    const prefixIsBot = (pu, i) => typeof pu.sockets?.[i] === 'string' && pu.sockets[i].startsWith('bot:');

    async function drop(io, socket) {
        io.sockets.sockets.delete(socket.id);
        for (const members of io.rooms.values()) members.delete(socket.id);
        await queueHandlers.handleDisconnect(socket, io);
    }

    test('human, human in grace, draw-phase leaver (bot persona) and native bot', async () => {
        seq++;
        const log = [];
        const io = makeIo(log);
        const ids = [1, 2, 3].map((n) => `kind${seq}-h${n}`);
        const names = ids.map((_, i) => `kindu${seq}_${i}`);
        ids.forEach((id, i) => {
            gameManager.registerUser(id, names[i]);
            mockDb.current.users._insert({ username: names[i] });
        });
        const bot = botController.createBot('🤖 K0', 'mary');
        const game = gameManager.createGame([...ids, bot.socketId]);
        botController.registerBot(game.gameId, bot);
        const sockets = ids.map((id) => makeSocket(id, log, io));
        sockets.forEach((s) => s.join(game.roomName));
        gameLifecycle.beginDraw(io, game);
        await drop(io, sockets[1]); // seated in grace
        chatHandlers.chatMessage(sockets[2], io, { message: '/leave' }); // seated as a resignBot
        const drew = gameHandlers.draw(sockets[0], io, { num: 0 });
        for (let i = 0; i < 120 && game.stage !== Phase.BIDDING; i++) await jest.advanceTimersByTimeAsync(500);
        await drew;
        expect(game.stage).toBe(Phase.BIDDING);

        const [pu] = events(log, 'positionUpdate').map((l) => l.data);
        const kindOf = (pos) => game.seat(pos).controller;
        const at = (name) => pu.positions.indexOf(game.seatByUsername(name));
        expect(game.seat(game.seatByUsername(names[1]))).toMatchObject({ controller: 'human', presence: 'grace' });
        expect(game.seat(game.seatByUsername(names[2]))).toMatchObject({ controller: 'resignBot', presence: 'gone' });
        // the leaver's seat shows the bot persona, as a lazy human's seat does
        expect(pu.usernames[at(names[2])].username).toMatch(/^🤖 /);
        expect(pu.isBot[at(names[0])]).toBe(false);
        expect(pu.isBot[at(names[1])]).toBe(false);
        expect(pu.isBot[at(names[2])]).toBe(true);
        expect(pu.isBot[pu.usernames.findIndex((u) => u.username === bot.username)]).toBe(true);
        pu.positions.forEach((pos, i) => {
            expect(build5IsBot(pu, i)).toBe(prefixIsBot(pu, i));
            expect(pu.isBot[i]).toBe(kindOf(pos) !== 'human');
        });
    });

    test('an all-bot table (the ambient game\'s shape): every seat a bot', async () => {
        seq++;
        const log = [];
        const io = makeIo(log);
        const bots = ['🤖 A0', '🤖 A1', '🤖 A2', '🤖 A3'].map((n, i) => botController.createBot(n, ['mary', 'sharon', 'mike', 'dan'][i]));
        const game = gameManager.createGame(bots.map((b) => b.socketId));
        bots.forEach((b) => botController.registerBot(game.gameId, b));
        gameLifecycle.beginDraw(io, game);
        for (let i = 0; i < 120 && game.stage !== Phase.BIDDING; i++) await jest.advanceTimersByTimeAsync(500);
        const [pu] = events(log, 'positionUpdate').map((l) => l.data);
        expect(pu.isBot).toEqual([true, true, true, true]);
        pu.positions.forEach((_, i) => expect(build5IsBot(pu, i)).toBe(prefixIsBot(pu, i)));
    });
});
