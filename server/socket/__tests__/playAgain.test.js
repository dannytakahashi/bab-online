/**
 * Play again (owner 2026-11-16: an automatic return; server/socket/playAgain.js):
 * at the end of a casual game a lobby started, everyone still at the table
 * whose socket sent the clientHello cap `playAgain` is moved into a
 * recreated copy of the lobby (lobbyReturn after gameEnd); people not at the
 * table keep a place (holds, legacy reservations); legacy clients keep
 * today's flow.
 *
 * Real handlers on the in-memory DB fake, stub io/sockets, fake timers; the
 * games are played to their end through playAgainDriver (real draw, then
 * the first hand, played by lazy bots, counts as the last).
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
const queueHandlers = require('../queueHandlers');
const chatHandlers = require('../chatHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const gameLifecycle = require('../gameLifecycle');
const authHandlers = require('../authHandlers');
const sessionIdentity = require('../sessionIdentity');
const safetyHandlers = require('../safetyHandlers');
const clientInfo = require('../clientInfo');
const voice = require('../voiceHandlers');
const playAgain = require('../playAgain');
const { botController } = require('../../game/bot');
const { makeIo, makeSocket, mulberry32 } = require('../../testUtils/gameDriver');
const { playLobbyGame, startLobbyGame, toBidding, advanceUntil } = require('../../testUtils/playAgainDriver');
const { Controller } = require('../../game/SeatState');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const CAPS = {
    full: ['avatarUrl', 'casualSpectators', 'playAgain'],
    casual: ['avatarUrl', 'casualSpectators'],
    legacy: ['avatarUrl'],
    // playAgain without casualSpectators: moved, but the lobby stays at 4
    paonly: ['avatarUrl', 'playAgain'],
};

let seq = 0;
let errorLogs;
const savedEnv = { PLAY_AGAIN: process.env.PLAY_AGAIN, PLAY_AGAIN_HOLD_MS: process.env.PLAY_AGAIN_HOLD_MS };

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    errorLogs = [];
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
    }
    delete process.env.PLAY_AGAIN;
    delete process.env.PLAY_AGAIN_HOLD_MS;
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const sid of Array.from(gameManager.lobbyGrace.keys())) gameManager._clearLobbyGrace(sid);
    for (const lobby of gameManager.lobbies.values()) playAgain.onLobbyStart(lobby);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.spectatorGames.clear();
    gameManager.startedLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.currentUsers = [];
    gameManager.mergeLocks.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    // a play-again step that threw (playAgain.guarded) would only log
    expect(errorLogs).toEqual([]);
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
});

/**
 * A room emit records who was in the room at that moment (`members`) and
 * its wire form (`json`, taken at emit time: payloads hold live state), so
 * `received` can rebuild every socket's own stream, room broadcasts
 * included.
 */
function trackRooms(io, log) {
    const entry = (to, event, data, except) => ({
        to, event, data, at: Date.now(),
        members: io.rooms.has(to) ? [...io.rooms.get(to)] : null,
        json: data === undefined ? 'u' : JSON.stringify(data),
        ...(except ? { except } : {}),
    });
    io.to = (room) => ({ emit: (event, data) => log.push(entry(room, event, data)) });
    io.emit = (event, data) => log.push(entry('*', event, data));
    return (s) => {
        s.to = (room) => ({ emit: (event, data) => log.push(entry(room, event, data, s.id)) });
        s.emit = (event, data) => log.push(entry(`self:${s.id}`, event, data));
        return s;
    };
}

function world() {
    seq++;
    const log = [];
    const io = makeIo(log);
    const tracked = trackRooms(io, log);
    let n = 0;
    const w = {
        log, io,
        /** A signed-in socket in the main room. kind: full | casual | legacy. */
        user(name, kind = 'full', { join = true } = {}) {
            n++;
            const id = `pa${seq}-${name}-${n}`;
            const s = tracked(makeSocket(id, log, io));
            gameManager.registerUser(id, name);
            s.data.username = name;
            voice.rememberBlockList(s, []);
            if (!mockDb.current.users.docs.some((d) => d.username === name)) {
                mockDb.current.users._insert({ username: name, profilePic: 3, blockedUsers: [] });
            }
            clientInfo.handle(s, io, kind === 'legacy'
                ? { client: 'ios', version: '1.2.2', build: '11', caps: CAPS.legacy }
                : { client: 'web', version: '1', caps: CAPS[kind] });
            if (join) mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
        /** A transport disconnect. */
        kill(s) {
            io.sockets.sockets.delete(s.id);
            for (const members of io.rooms.values()) members.delete(s.id);
            return queueHandlers.handleDisconnect(s, io);
        },
        to(s, event, from = 0) {
            return log.slice(from).filter((l) => (l.to === s.id || l.to === `self:${s.id}`) && l.event === event);
        },
        last(s, event) {
            return w.to(s, event).pop()?.data;
        },
        /** Event names `s` received from log index `from` on (room emits by membership are not tracked). */
        names(s, from = 0) {
            return log.slice(from).filter((l) => l.to === s.id || l.to === `self:${s.id}`).map((l) => l.event);
        },
        errors(s) {
            return w.to(s, 'serverError').map((l) => l.data.message);
        },
        /**
         * Everything socket `s` received from log index `from` on: its own
         * emits and every room broadcast it was a member of at the time
         * (minus socket.to's sender), as {event, json}.
         */
        received(s, from = 0) {
            return log.slice(from).filter((l) =>
                l.to === s.id || l.to === `self:${s.id}` || l.to === '*' ||
                (l.except !== s.id && Array.isArray(l.members) && l.members.includes(s.id)))
                .map((l) => ({ event: l.event, json: l.json }));
        },
    };
    return w;
}

/**
 * A stream with this run's identities replaced by placeholders: socket ids
 * (S<i>) and usernames (U<i>) of `socks` in order, then every uuid (game,
 * lobby, bot ids) by order of first appearance, so two runs compare byte
 * for byte.
 */
function normalized(stream, socks) {
    const subs = [
        ...socks.map((s, i) => [s.id, `S${i}`]),
        ...socks.map((s, i) => [s.data.username, `U${i}`]),
    ].sort((a, b) => b[0].length - a[0].length);
    const uuids = new Map();
    return stream.map(({ event, json }) => {
        let j = json;
        for (const [from, to] of subs) j = j.split(from).join(to);
        j = j.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
            if (!uuids.has(u)) uuids.set(u, `ID${uuids.size}`);
            return uuids.get(u);
        });
        return `${event} ${j}`;
    });
}

/** socks[0] creates a lobby (name), the rest join; then `bots` bots. */
function lobbyOf(w, socks, { name = 'Family', bots = 0 } = {}) {
    mainRoomHandlers.createLobby(socks[0], w.io, { name });
    const lobby = gameManager.getPlayerLobby(socks[0].id);
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId: lobby.id });
    for (let i = 0; i < bots; i++) lobbyHandlers.addBot(socks[0], w.io);
    return lobby;
}

const names = (k, tag = 'p') => Array.from({ length: k }, (_, i) => `${tag}${seq + 1}_${i + 1}`);
const gameEndIndex = (w) => w.log.findIndex((l) => l.event === 'gameEnd');
const returnedLobby = (w, s) => gameManager.getPlayerLobby(s.id);

describe('at gameEnd: the capable players are back in the same lobby', () => {
    test('4 capable connected owners: a new lobby (fresh id, same name / host / settings / chat), 4 mapped rows not ready, lobbyReturn after gameEnd, listed', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks, { name: 'The Smiths' });
        lobbyHandlers.lobbyChat(socks[1], w.io, { message: 'ready?' });
        lobbyHandlers.setLobbySpectatorsCanTalk(socks[0], w.io, false);
        const oldId = lobby.id;
        const game = await playLobbyGame(w.io, socks);
        // The ordinary end: one seat still played by its human (it bid and
        // played the last hand through the real handlers), three lazy
        const human = game.seatList().filter((s) => s.controller === Controller.HUMAN);
        expect(human).toHaveLength(1);
        expect(game.seatList().filter((s) => s.controller === Controller.LAZY_BOT)).toHaveLength(3);
        expect(w.log.some((l) => l.event === 'bidReceived' && l.data.position === human[0].position)).toBe(true);
        expect(w.log.some((l) => l.event === 'cardPlayed' && l.data.position === human[0].position)).toBe(true);

        const back = returnedLobby(w, socks[0]);
        expect(back).toBeTruthy();
        expect(back.id).not.toBe(oldId);
        expect(back.name).toBe('The Smiths');
        expect(gameManager.lobbyHost(back)).toBe(socks[0].data.username);
        expect(back.settings).toEqual({ spectatorsCanTalk: false });
        expect(back.messages.map((m) => m.message)).toEqual(['ready?']);
        expect(back.players.map((p) => p.socketId)).toEqual(socks.map((s) => s.id));
        expect(back.players.every((p) => !p.ready)).toBe(true);
        for (const s of socks) expect(gameManager.playerLobbies.get(s.id)).toBe(back.id);

        const end = gameEndIndex(w);
        for (const s of socks) {
            const ret = w.to(s, 'lobbyReturn');
            expect(ret).toHaveLength(1);
            expect(w.log.indexOf(ret[0])).toBeGreaterThan(end);
            expect(ret[0].data).toMatchObject({
                lobbyId: back.id, name: 'The Smiths', host: socks[0].data.username,
                settings: { spectatorsCanTalk: false }, capacity: 8,
                lastGame: { gameId: game.gameId, position: game.seatByUsername(s.data.username) },
            });
            expect(ret[0].data.lastGame.playerStats).toEqual(w.log[end].data.playerStats);
            expect(ret[0].data.lastGame.score).toEqual({ team1: game.score.team1, team2: game.score.team2 });
            expect(ret[0].data.members.every((m) => !m.ready && !m.returning)).toBe(true);
        }
        const listed = w.log.slice(end).filter((l) => l.event === 'lobbiesUpdated').map((l) => l.data.lobbies.map((x) => x.id));
        expect(listed.some((ids) => ids.includes(back.id))).toBe(true);
        expect(errorLogs).toEqual([]);
    });

    test('voice: r_i gets {r_j : j < i}, each r_j a voicePeerJoined; pairs within R never get voicePeerLeft', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const end = gameEndIndex(w);
        expect(w.to(socks[0], 'voicePeerList', end)).toEqual([]);
        for (let i = 1; i < 4; i++) {
            expect(w.to(socks[i], 'voicePeerList', end).map((l) => l.data.peers.map((p) => p.socketId))).toEqual([socks.slice(0, i).map((s) => s.id)]);
            const ret = w.log.indexOf(w.to(socks[i], 'lobbyReturn')[0]);
            expect(w.log.indexOf(w.to(socks[i], 'voicePeerList', end)[0])).toBeGreaterThan(ret);
        }
        for (let j = 0; j < 4; j++) {
            expect(w.to(socks[j], 'voicePeerJoined', end).map((l) => l.data.socketId)).toEqual(socks.slice(j + 1).map((s) => s.id));
            expect(w.to(socks[j], 'voicePeerLeft', end)).toEqual([]);
        }
    });

    test('a lazy owner watching is moved; a gone owner (/leave) is not', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks, {
            before: async () => {
                await chatHandlers.chatMessage(socks[1], w.io, { message: '/lazy' });
                await chatHandlers.chatMessage(socks[2], w.io, { message: '/leave' });
            },
        });
        const back = returnedLobby(w, socks[0]);
        expect(back.players.map((p) => p.username)).toEqual([socks[0], socks[1], socks[3]].map((s) => s.data.username));
        expect(w.to(socks[1], 'lobbyReturn')).toHaveLength(1);
        expect(w.to(socks[2], 'lobbyReturn')).toEqual([]);
        expect(gameManager.playerLobbies.has(socks[2].id)).toBe(false);
    });

    test('native lobby bots come back with the same personalities and generic names; a lazy bot does not', async () => {
        const w = world();
        const socks = names(2).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks, { bots: 2 });
        const personalities = lobby.players.filter((p) => p.isBot).map((p) => lobby.botPersonalities.get(p.socketId));
        await playLobbyGame(w.io, socks, {
            before: async () => { await chatHandlers.chatMessage(socks[1], w.io, { message: '/lazy' }); },
        });
        const back = returnedLobby(w, socks[0]);
        const bots = back.players.filter((p) => p.isBot);
        expect(bots.map((b) => b.username)).toEqual(['🤖 Bot', '🤖 Bot 2']);
        expect(bots.map((b) => back.botPersonalities.get(b.socketId))).toEqual(personalities);
        expect(bots.every((b) => !b.ready && !lobby.players.some((p) => p.socketId === b.socketId))).toBe(true);
        expect(back.players.filter((p) => !p.isBot).map((p) => p.socketId)).toEqual(socks.map((s) => s.id));
        // Ready from both humans starts the next game (a lobby of 4: bots readied)
        const again = await startLobbyGame(w.io, socks);
        expect(again.game.gameId).not.toBe(undefined);
        expect(again.game.lobbyOrigin.bots.size).toBe(2);
    });

    test('a family of 6: both extras watching are moved (position null); a second play-again chains', async () => {
        const w = world();
        const socks = names(6).map((n) => w.user(n));
        lobbyOf(w, socks);
        const game = await playLobbyGame(w.io, socks.slice(0, 4));
        expect(game.lobbyOrigin.extras.size).toBe(2);
        const back = returnedLobby(w, socks[0]);
        expect(back.players).toHaveLength(6);
        for (const s of socks.slice(4)) {
            expect(w.last(s, 'lobbyReturn').lastGame.position).toBeNull();
            expect(gameManager.spectatorGames.has(s.id)).toBe(false);
        }
        expect(w.last(socks[5], 'lobbyReturn').capacity).toBe(8);
        // Next game: the first 4 to tap Ready play (extras 0 and 1 this time);
        // the other two left their results for the lobby (Return to Lobby)
        for (const s of socks.slice(2, 4)) playAgain.lobbyReturnSeen(s);
        const order = [socks[4], socks[5], socks[0], socks[1]];
        const g2 = await playLobbyGame(w.io, order);
        expect(g2.gameId).not.toBe(game.gameId);
        const back2 = returnedLobby(w, socks[4]);
        expect(back2.id).not.toBe(back.id);
        expect(back2.players).toHaveLength(6);
        expect(errorLogs).toEqual([]);
    });
});

describe('legacy clients keep today\'s flow', () => {
    /** One game; returns the normalized events each socket got from gameEnd on, plus the world. */
    async function run(kinds, { off = false } = {}) {
        if (off) process.env.PLAY_AGAIN = 'off'; else delete process.env.PLAY_AGAIN;
        const w = world();
        const socks = kinds.map((k, i) => w.user(`lg${i}_${off ? 'off' : 'on'}${seq}`, k));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const end = gameEndIndex(w);
        return { w, socks, end };
    }

    test('an all-legacy game opens no lobby; the stream after gameEnd matches PLAY_AGAIN=off event for event', async () => {
        const on = await run(['legacy', 'legacy', 'legacy', 'legacy']);
        expect(gameManager.lobbies.size).toBe(0);
        expect(on.w.log.some((l) => l.event === 'lobbyReturn')).toBe(false);
        const onTail = on.w.log.slice(on.end).map((l) => l.event);
        const off = await run(['legacy', 'legacy', 'legacy', 'legacy'], { off: true });
        const offTail = off.w.log.slice(off.end).map((l) => l.event);
        expect(onTail).toEqual(offTail);
    });

    test('2 capable + 2 legacy: 2 moved, 2 reservations; strangers and Add Bot refused; a legacy join works; the legacy sockets get only voicePeerLeft extra', async () => {
        const off = await run(['full', 'full', 'legacy', 'legacy'], { off: true });
        const offLegacy = off.w.names(off.socks[2], off.end);
        const { w, socks, end } = await run(['full', 'full', 'legacy', 'legacy']);
        const back = returnedLobby(w, socks[0]);
        expect(back.players.map((p) => p.socketId)).toEqual([socks[0].id, socks[1].id]);
        expect([...back.afterGame.reserved.keys()]).toEqual([socks[2].data.username, socks[3].data.username]);
        expect(w.last(socks[0], 'lobbyReturn').expected).toEqual([socks[2].data.username, socks[3].data.username]);
        // The legacy socket on its score screen: nothing new (lingering calls)
        expect(w.names(socks[2], end)).toEqual(offLegacy);
        expect(w.to(socks[2], 'lobbyReturn')).toEqual([]);
        expect(w.to(socks[2], 'lobbyCreated', end)).toEqual([]);
        expect(back.afterGame.lingering.has(socks[2].id)).toBe(true);

        // A stranger: refused (capable: the reservation message; legacy: Lobby is full)
        const stranger = w.user(`stranger${seq}`);
        mainRoomHandlers.joinLobby(stranger, w.io, { lobbyId: back.id });
        expect(w.errors(stranger)).toEqual([playAgain.RESERVED_MESSAGE]);
        const oldStranger = w.user(`oldstranger${seq}`, 'legacy');
        mainRoomHandlers.joinLobby(oldStranger, w.io, { lobbyId: back.id });
        expect(w.errors(oldStranger)).toEqual(['Lobby is full']);
        await lobbyHandlers.addBot(socks[0], w.io);
        expect(w.errors(socks[0])).toEqual(['Lobby is full']);
        expect(back.players).toHaveLength(2);

        // The legacy player taps Return (joinMainRoom): voicePeerLeft both ways, then Join
        const mark = w.log.length;
        mainRoomHandlers.joinMainRoom(socks[2], w.io);
        expect(w.to(socks[2], 'voicePeerLeft', mark).map((l) => l.data.socketId).sort()).toEqual([socks[0].id, socks[1].id].sort());
        for (const s of socks.slice(0, 2)) expect(w.to(s, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([socks[2].id]);
        expect(w.to(socks[2], 'mainRoomJoined', mark)).toHaveLength(1);
        const card = w.to(socks[2], 'mainRoomJoined', mark)[0].data.lobbies.find((l) => l.id === back.id);
        expect(card).toMatchObject({ name: 'Family', playerCount: 2, maxPlayers: 4 });
        expect(Object.keys(card)).toEqual(['id', 'name', 'playerCount', 'maxPlayers', 'players', 'createdAt']);
        mainRoomHandlers.joinLobby(socks[2], w.io, { lobbyId: back.id });
        expect(w.errors(socks[2])).toEqual([]);
        expect(Object.keys(w.last(socks[2], 'lobbyCreated'))).toEqual(['lobbyId', 'players', 'messages', 'name']);
        expect([...back.afterGame.reserved.keys()]).toEqual([socks[3].data.username]);
        expect(w.last(socks[0], 'lobbyPlayerJoined').expected).toEqual([socks[3].data.username]);
        expect(gameManager.lobbyCapacity(back)).toBe(4);
    });

    test('a casualSpectators-only client (web before the play-again release) is a legacy owner: reserved, never moved', async () => {
        const { w, socks } = await run(['full', 'casual', 'full', 'full']);
        const back = returnedLobby(w, socks[0]);
        expect(back.players.map((p) => p.socketId)).toEqual([socks[0].id, socks[2].id, socks[3].id]);
        expect(w.to(socks[1], 'lobbyReturn')).toEqual([]);
        expect(back.afterGame.reserved.has(socks[1].data.username)).toBe(true);
    });
});

describe('voice at the return', () => {
    test('a main-room voice spectator drops its calls with the returners both ways; it is not moved', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        const spec = w.user(`watcher${seq}`);
        let game;
        await playLobbyGame(w.io, socks, {
            before: async (g) => {
                game = g;
                mainRoomHandlers.joinAsSpectator(spec, w.io, { gameId: g.gameId });
                expect(g.voiceSpectators.has(spec.id)).toBe(true);
            },
        });
        const end = gameEndIndex(w);
        expect(w.to(spec, 'voicePeerLeft', end).map((l) => l.data.socketId).sort()).toEqual(socks.map((s) => s.id).sort());
        for (const s of socks) expect(w.to(s, 'voicePeerLeft', end).map((l) => l.data.socketId)).toEqual([spec.id]);
        expect(w.to(spec, 'lobbyReturn')).toEqual([]);
        expect(gameManager.playerLobbies.has(spec.id)).toBe(false);
        expect(game.isTerminal()).toBe(true);
    });

    test('lingering ends on a disconnect, on the next start and when the lobby goes', async () => {
        // disconnect
        let w = world();
        let socks = [w.user(`a${seq}`), w.user(`b${seq}`), w.user(`c${seq}`, 'legacy'), w.user(`d${seq}`, 'legacy')];
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        let back = returnedLobby(w, socks[0]);
        let mark = w.log.length;
        await w.kill(socks[2]);
        expect(w.to(socks[0], 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([socks[2].id]);
        expect(back.afterGame.lingering.has(socks[2].id)).toBe(false);
        expect(back.afterGame.lingering.has(socks[3].id)).toBe(true);
        // (its reservation stays: a disconnect ends only the call)
        expect(back.afterGame.reserved.has(socks[2].data.username)).toBe(true);

        // the next start

        w = world();
        socks = [w.user(`e${seq}`), w.user(`f${seq}`), w.user(`g${seq}`), w.user(`h${seq}`, 'legacy')];
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        back = returnedLobby(w, socks[0]);
        expect(back.afterGame.lingering.has(socks[3].id)).toBe(true);
        // Don't wait for the legacy player, add a bot, everyone ready: start
        await playAgain.releaseLobbyHold(socks[0], w.io, { username: socks[3].data.username });
        await lobbyHandlers.addBot(socks[0], w.io);
        mark = w.log.length;
        const started = await startLobbyGame(w.io, socks.slice(0, 3));
        expect(w.to(socks[3], 'voicePeerLeft', mark).map((l) => l.data.socketId).sort()).toEqual(socks.slice(0, 3).map((s) => s.id).sort());
        expect(back.afterGame).toBeUndefined();
        expect(started.game.lobbyOrigin.name).toBe('Family');

        // the lobby going (everyone leaves)
        w = world();
        socks = [w.user(`i${seq}`), w.user(`j${seq}`, 'legacy'), w.user(`k${seq}`, 'legacy'), w.user(`l${seq}`, 'legacy')];
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        back = returnedLobby(w, socks[0]);
        expect(back.afterGame.lingering.size).toBe(3);
        mark = w.log.length;
        lobbyHandlers.leaveLobby(socks[0], w.io);
        expect(gameManager.lobbies.has(back.id)).toBe(false);
        for (const s of socks.slice(1)) expect(w.to(s, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([socks[0].id]);
    });
});

describe('holds', () => {
    /** 4 capable owners; owner 3 goes /lazy and drops before the end (an offline hold). */
    async function offlineHold(w, { otherTab = false, kinds = ['full', 'full', 'full', 'full'] } = {}) {
        const socks = names(4).map((n, i) => w.user(n, kinds[i]));
        lobbyOf(w, socks);
        let tab = null;
        await playLobbyGame(w.io, socks, {
            before: async () => {
                await chatHandlers.chatMessage(socks[3], w.io, { message: '/lazy' });
                await w.kill(socks[3]);
                if (otherTab) tab = w.user(socks[3].data.username);
            },
        });
        return { socks, back: returnedLobby(w, socks[0]), tab };
    }

    test('a lazy owner who dropped gets an offline hold: a row with no socket, returning in members, reconnecting for legacy readers', async () => {
        const w = world();
        const { socks, back } = await offlineHold(w);
        const row = back.players[3];
        expect(row.username).toBe(socks[3].data.username);
        expect(playAgain.isHold(row.socketId)).toBe(true);
        expect(gameManager.lobbyGrace.get(row.socketId)).toMatchObject({ kind: 'afterGame', offline: true, lobbyId: back.id });
        const ret = w.last(socks[0], 'lobbyReturn');
        expect(ret.members[3]).toMatchObject({ username: row.username, returning: true, reconnecting: true });
        expect(ret.reconnecting).toEqual([row.username]);
        expect(w.to(socks[3], 'lobbyReturn')).toEqual([]);
        // a hold counts as a human: no bot takes its place; capacity 8 (it was capable)
        expect(gameManager.tableBots(back)).toEqual([]);
        expect(gameManager.lobbyCapacity(back)).toBe(8);
    });

    test('auto-claim on joinMainRoom from a capable socket: lobbyCreated, no mainRoomJoined, peers mapped only', async () => {
        const w = world();
        const { socks, back } = await offlineHold(w);
        const again = w.user(socks[3].data.username, 'full', { join: false });
        const mark = w.log.length;
        mainRoomHandlers.joinMainRoom(again, w.io);
        expect(w.to(again, 'mainRoomJoined', mark)).toEqual([]);
        expect(w.last(again, 'lobbyCreated').lobbyId).toBe(back.id);
        expect(back.players[3].socketId).toBe(again.id);
        expect(w.last(again, 'voicePeerList').peers.map((p) => p.socketId)).toEqual(socks.slice(0, 3).map((s) => s.id));
        expect(w.to(socks[0], 'leftLobby', mark)).toEqual([]);
        expect(w.log.slice(mark).some((l) => String(l.to).startsWith('away:'))).toBe(false);
    });

    test('no auto-claim for a legacy socket (it joins from the card) or for an away hold', async () => {
        let w = world();
        let r = await offlineHold(w);
        const old = w.user(r.socks[3].data.username, 'legacy', { join: false });
        let mark = w.log.length;
        mainRoomHandlers.joinMainRoom(old, w.io);
        expect(w.to(old, 'mainRoomJoined', mark)).toHaveLength(1);
        mainRoomHandlers.joinLobby(old, w.io, { lobbyId: r.back.id });
        expect(r.back.players[3].socketId).toBe(old.id);
        expect(Object.keys(w.last(old, 'lobbyCreated'))).toEqual(['lobbyId', 'players', 'messages', 'name']);
        expect(gameManager.lobbyCapacity(r.back)).toBe(4);

        w = world();
        r = await offlineHold(w, { otherTab: true });
        const awayRow = r.back.players[3];
        expect(gameManager.lobbyGrace.get(awayRow.socketId).offline).toBe(false);
        const tab2 = w.user(r.socks[3].data.username, 'full', { join: false });
        mark = w.log.length;
        mainRoomHandlers.joinMainRoom(tab2, w.io);
        expect(w.to(tab2, 'mainRoomJoined', mark)).toHaveLength(1);
        // memberUsernames shows the place (Rejoin), and joinLobby claims it
        expect(w.to(tab2, 'mainRoomJoined', mark)[0].data.lobbies.find((l) => l.id === r.back.id).memberUsernames).toContain(awayRow.username);
        mainRoomHandlers.joinLobby(tab2, w.io, { lobbyId: r.back.id });
        expect(r.back.players[3].socketId).toBe(tab2.id);
    });

    test('expiry keeps the others\' ready flags; the last expiry with nobody present deletes the lobby', async () => {
        process.env.PLAY_AGAIN_HOLD_MS = '30000';
        const w = world();
        // a lobby of capacity 4 (a member without casualSpectators), where a
        // leave would reset everyone's ready flags
        const { socks, back } = await offlineHold(w, { kinds: ['full', 'paonly', 'full', 'full'] });
        expect(gameManager.lobbyCapacity(back)).toBe(4);
        await lobbyHandlers.playerReady(socks[1], w.io);
        expect(back.players[1].ready).toBe(true);
        await jest.advanceTimersByTimeAsync(30010);
        expect(back.players.map((p) => p.username)).toEqual(socks.slice(0, 3).map((s) => s.data.username));
        expect(back.players[1].ready).toBe(true);
        expect(back.readyPlayers.has(socks[1].id)).toBe(true);
        expect(w.last(socks[0], 'lobbyPlayerLeft').leftUsername).toBe(socks[3].data.username);

        // a lobby where only holds are left goes once they expire
        const w2 = world();
        const r2 = await offlineHold(w2);
        for (const s of r2.socks.slice(0, 3)) lobbyHandlers.leaveLobby(s, w2.io);
        expect(gameManager.lobbies.has(r2.back.id)).toBe(true);
        await jest.advanceTimersByTimeAsync(30010);
        expect(gameManager.lobbies.has(r2.back.id)).toBe(false);
    });

    test('PLAY_AGAIN_HOLD_MS=0: no holds and no reservations, the moved still return', async () => {
        process.env.PLAY_AGAIN_HOLD_MS = '0';
        const w = world();
        const { socks, back } = await offlineHold(w);
        expect(back.players.map((p) => p.socketId)).toEqual(socks.slice(0, 3).map((s) => s.id));
    });

    test('releaseLobbyHold: the host only; any present member while the host is held', async () => {
        const w = world();
        const { socks, back } = await offlineHold(w);
        const held = socks[3].data.username;
        await playAgain.releaseLobbyHold(socks[1], w.io, { username: held });
        expect(w.errors(socks[1])).toEqual(['Only the host can do this']);
        await playAgain.releaseLobbyHold(socks[0], w.io, { username: 'nobody' });
        expect(w.errors(socks[0])).toEqual(['Nobody by that name is coming back']);
        await playAgain.releaseLobbyHold(socks[0], w.io, { username: held });
        expect(back.players.some((p) => p.username === held)).toBe(false);

        // the host held: another member may release
        const w2 = world();
        const s2 = names(4, 'q').map((n) => w2.user(n));
        lobbyOf(w2, s2);
        await playLobbyGame(w2.io, s2, {
            before: async () => {
                for (const s of [s2[0], s2[3]]) await chatHandlers.chatMessage(s, w2.io, { message: '/lazy' });
                for (const s of [s2[0], s2[3]]) await w2.kill(s);
            },
        });
        const back2 = returnedLobby(w2, s2[1]);
        expect(gameManager.lobbyHost(back2)).toBe(s2[0].data.username);
        await playAgain.releaseLobbyHold(s2[2], w2.io, { username: s2[3].data.username });
        expect(w2.errors(s2[2])).toEqual([]);
        expect(back2.players.map((p) => p.username)).toEqual(s2.slice(0, 3).map((s) => s.data.username));
    });

    test('creating another lobby, joining a tournament, or signing out gives the hold up; releaseIdentity does not', async () => {
        let w = world();
        let r = await offlineHold(w);
        const fresh = w.user(r.socks[3].data.username, 'full', { join: false });
        mainRoomHandlers.createLobby(fresh, w.io, { name: 'Elsewhere' });
        expect(r.back.players.some((p) => p.username === r.socks[3].data.username)).toBe(false);

        w = world();
        r = await offlineHold(w);
        const t = w.user(`host${seq}`);
        tournamentHandlers.createTournament(t, w.io, { name: 'Cup' });
        const tid = gameManager.getPlayerTournament(t.id).tournamentId;
        const joiner = w.user(r.socks[3].data.username, 'full', { join: false });
        await tournamentHandlers.joinTournament(joiner, w.io, { tournamentId: tid });
        expect(r.back.players.some((p) => p.username === r.socks[3].data.username)).toBe(false);

        w = world();
        r = await offlineHold(w);
        const tab = w.user(`other${seq}`);
        await sessionIdentity.releaseIdentity(w.io, tab, 'someone');
        expect(r.back.players).toHaveLength(4);
        authHandlers.signOutUser(w.io, r.socks[3].data.username);
        expect(r.back.players).toHaveLength(3);
    });

    test('a username busy elsewhere at gameEnd (its other tab in another lobby) gets nothing; one username never holds two lobbies', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks, {
            before: async () => {
                await chatHandlers.chatMessage(socks[3], w.io, { message: '/lazy' });
                await w.kill(socks[3]);
                const tab = w.user(socks[3].data.username);
                mainRoomHandlers.createLobby(tab, w.io, { name: 'Mine' });
            },
        });
        const back = returnedLobby(w, socks[0]);
        expect(back.players.map((p) => p.username)).toEqual(socks.slice(0, 3).map((s) => s.data.username));
        const rows = [...gameManager.lobbies.values()].flatMap((l) => l.players.filter((p) => p.username === socks[3].data.username));
        expect(rows).toHaveLength(1);
    });

    test('a legacy takeover of a hold in a lobby of more than 4 is refused', async () => {
        const w = world();
        const socks = names(6).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks.slice(0, 4), {
            before: async () => { await w.kill(socks[5]); },
        });
        const back = returnedLobby(w, socks[0]);
        expect(back.players).toHaveLength(6);
        expect(playAgain.isHold(back.players[5].socketId)).toBe(true);
        const old = w.user(socks[5].data.username, 'legacy');
        mainRoomHandlers.joinLobby(old, w.io, { lobbyId: back.id });
        expect(w.errors(old)).toEqual(['Lobby is full']);
    });
});

describe('the host', () => {
    test('with the host gone (/leave), the first moved member hosts', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks, {
            before: async () => { await chatHandlers.chatMessage(socks[0], w.io, { message: '/leave' }); },
        });
        const back = returnedLobby(w, socks[1]);
        expect(gameManager.lobbyHost(back)).toBe(socks[1].data.username);
        expect(w.last(socks[1], 'lobbyReturn').host).toBe(socks[1].data.username);
    });
});

describe('no lobby', () => {
    test('PLAY_AGAIN=off', async () => {
        process.env.PLAY_AGAIN = 'off';
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        expect(gameManager.lobbies.size).toBe(0);
        expect(w.log.some((l) => l.event === 'lobbyReturn')).toBe(false);
    });

    test('an aborted lobby game', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        const { game } = await startLobbyGame(w.io, socks);
        await toBidding(w.io, game, socks);
        await gameLifecycle.abortGame(w.io, game, 'test');
        expect(gameManager.lobbies.size).toBe(0);
        expect(w.log.some((l) => l.event === 'lobbyReturn')).toBe(false);
    });

    test('a game without lobbyOrigin (tournament table, ambient demo, createGame)', () => {
        const io = makeIo([]);
        const game = gameManager.createGame(['bot:x:1', 'bot:x:2', 'bot:x:3', 'bot:x:4']);
        expect(playAgain.plan(game, io, {})).toBeNull();
        expect(playAgain.open(io, null)).toBeNull();
    });
});

describe('stats and activeGameId', () => {
    test('clearActiveGameForAll still runs for the ended game, the lobby reopened before it', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        const clear = jest.spyOn(gameManager, 'clearActiveGameForAll');
        const game = await playLobbyGame(w.io, socks);
        expect(clear).toHaveBeenCalledWith(game.gameId, game);
        expect(returnedLobby(w, socks[0])).toBeTruthy();
    });
});

describe('joinLobby voice lists mapped members only (regression for every lobby)', () => {
    test('a reload-held seat\'s dead socket is not listed, nor told', async () => {
        const w = world();
        const socks = names(3, 'r').map((n) => w.user(n, 'legacy'));
        const lobby = lobbyOf(w, socks.slice(0, 2));
        await w.kill(socks[1]);
        expect(gameManager.reconnectingIn(lobby.id)).toEqual([socks[1].data.username]);
        const mark = w.log.length;
        mainRoomHandlers.joinLobby(socks[2], w.io, { lobbyId: lobby.id });
        expect(w.last(socks[2], 'voicePeerList').peers.map((p) => p.socketId)).toEqual([socks[0].id]);
        expect(w.to(socks[1], 'voicePeerJoined', mark)).toEqual([]);
    });
});

describe('blocks', () => {
    test('a block ends a lingering call', async () => {
        const w = world();
        const socks = [w.user(`m${seq}`), w.user(`n${seq}`), w.user(`o${seq}`), w.user(`v${seq}`, 'legacy')];
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const mark = w.log.length;
        await safetyHandlers.blockUser(socks[0], w.io, { username: socks[3].data.username });
        expect(w.to(socks[3], 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([socks[0].id]);
        expect(w.to(socks[0], 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([socks[3].id]);
    });
});

// Review 2026-11-16 (finding 1): the owner keeps the score screen up until
// the person taps Return to Lobby, so a moved member's phone can lock there.
// A restore off the score screen sends joinMainRoom on both clients (iOS
// RestoreRoute .game -> .mainRoom, web TABLE_LOST), not joinLobby.
describe('a moved member who drops while still on the score screen', () => {
    test('a drop before acting in the lobby is held for PLAY_AGAIN_HOLD_MS, not the 30 s reload grace; the next capable joinMainRoom takes the seat back in place', async () => {
        const w = world();
        // capacity 4 (one member without casualSpectators): a leave there resets ready flags
        const socks = names(4).map((n, i) => w.user(n, i === 1 ? 'paonly' : 'full'));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const back = returnedLobby(w, socks[0]);
        expect(gameManager.lobbyCapacity(back)).toBe(4);
        await lobbyHandlers.playerReady(socks[1], w.io);
        expect(back.players[1].ready).toBe(true);

        await w.kill(socks[2]);
        expect(gameManager.lobbyGrace.get(socks[2].id)).toMatchObject({ kind: 'afterGame', offline: true, lobbyId: back.id });
        expect(gameManager.lobbyExtrasWire(back).members[2]).toMatchObject({ returning: true, reconnecting: true });
        // past the 30 s reload grace: still there, the others' flags untouched
        await jest.advanceTimersByTimeAsync(gameManager.constructor.LOBBY_SEAT_GRACE_MS + 1000);
        expect(back.players.map((p) => p.socketId)).toEqual(socks.map((s) => s.id));
        expect(back.players[1].ready).toBe(true);

        const again = w.user(socks[2].data.username, 'full', { join: false });
        const mark = w.log.length;
        mainRoomHandlers.joinMainRoom(again, w.io);
        expect(w.to(again, 'mainRoomJoined', mark)).toEqual([]);
        expect(w.last(again, 'lobbyCreated').lobbyId).toBe(back.id);
        expect(back.players[2].socketId).toBe(again.id);
        expect(gameManager.lobbyGrace.has(socks[2].id)).toBe(false);
        expect(back.players[1].ready).toBe(true);

        // Nobody comes back for the next one: it goes at PLAY_AGAIN_HOLD_MS,
        // as a leave that keeps the others' ready flags
        await w.kill(socks[3]);
        await jest.advanceTimersByTimeAsync(playAgain.DEFAULT_HOLD_MS + 10);
        expect(back.players.map((p) => p.username)).toEqual(socks.slice(0, 3).map((s) => s.data.username));
        expect(back.players[1].ready).toBe(true);
        expect(back.readyPlayers.has(socks[1].id)).toBe(true);
        expect(w.last(socks[0], 'lobbyPlayerLeft').leftUsername).toBe(socks[3].data.username);
    });

    test('a half-open old socket: the new socket\'s joinMainRoom takes the seat over (leftLobby to the old one, voicePeerLeft for it)', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const back = returnedLobby(w, socks[0]);
        const again = w.user(socks[3].data.username, 'full', { join: false });
        const mark = w.log.length;
        mainRoomHandlers.joinMainRoom(again, w.io);
        expect(w.to(again, 'mainRoomJoined', mark)).toEqual([]);
        expect(back.players[3].socketId).toBe(again.id);
        expect(w.to(socks[3], 'leftLobby', mark)).toHaveLength(1);
        for (const s of socks.slice(0, 3)) expect(w.to(s, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([socks[3].id]);
        // the old socket's eventual disconnect changes nothing
        await w.kill(socks[3]);
        expect(back.players[3].socketId).toBe(again.id);
        expect(gameManager.lobbyGrace.size).toBe(0);
    });

    test('a member who acted in the lobby (chat, Ready) is on the lobby screen: an ordinary 30 s reload grace, and joinMainRoom is the main room', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const back = returnedLobby(w, socks[0]);
        lobbyHandlers.lobbyChat(socks[1], w.io, { message: 'again?' });
        await w.kill(socks[1]);
        expect(gameManager.lobbyGrace.get(socks[1].id).kind).toBeUndefined();
        const again = w.user(socks[1].data.username, 'full', { join: false });
        const mark = w.log.length;
        mainRoomHandlers.joinMainRoom(again, w.io);
        expect(w.to(again, 'mainRoomJoined', mark)).toHaveLength(1);
        expect(gameManager.playerLobbies.has(again.id)).toBe(false);
        await jest.advanceTimersByTimeAsync(gameManager.constructor.LOBBY_SEAT_GRACE_MS + 10);
        expect(back.players.some((p) => p.username === socks[1].data.username)).toBe(false);
    });

    test('never for a legacy socket or a merge-locked user; PLAY_AGAIN_HOLD_MS=0 keeps the ordinary grace', async () => {
        let w = world();
        let socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        let back = returnedLobby(w, socks[0]);
        await w.kill(socks[2]);
        const old = w.user(socks[2].data.username, 'legacy', { join: false });
        let mark = w.log.length;
        mainRoomHandlers.joinMainRoom(old, w.io);
        expect(w.to(old, 'mainRoomJoined', mark)).toHaveLength(1);
        expect(back.players[2].socketId).toBe(socks[2].id);
        gameManager.mergeLocks.add(socks[2].data.username);
        const locked = w.user(socks[2].data.username, 'full', { join: false });
        mark = w.log.length;
        mainRoomHandlers.joinMainRoom(locked, w.io);
        expect(w.to(locked, 'lobbyCreated', mark)).toEqual([]);
        expect(back.players[2].socketId).toBe(socks[2].id);
        gameManager.mergeLocks.clear();

        process.env.PLAY_AGAIN_HOLD_MS = '0';
        w = world();
        socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        back = returnedLobby(w, socks[0]);
        await w.kill(socks[2]);
        expect(gameManager.lobbyGrace.get(socks[2].id).kind).toBeUndefined();
    });
});

// Review 2026-11-16 (finding 3): only the bots that played come back
describe('bots that sat the game out do not come back', () => {
    test('4 casual humans + 2 benched bots, two of the humans legacy for play again: the bots stay out, so the two moved players cannot start without the reserved ones', async () => {
        const w = world();
        const [a, b, c, d] = names(4).map((n, i) => w.user(n, i < 2 ? 'casual' : 'full'));
        mainRoomHandlers.createLobby(a, w.io, { name: 'Eight' });
        const lobby = gameManager.getPlayerLobby(a.id);
        await lobbyHandlers.addBot(a, w.io);
        await lobbyHandlers.addBot(a, w.io);
        for (const s of [b, c, d]) mainRoomHandlers.joinLobby(s, w.io, { lobbyId: lobby.id });
        expect(gameManager.lobbyCapacity(lobby)).toBe(8);
        expect(gameManager.tableBots(lobby)).toEqual([]);
        const game = await playLobbyGame(w.io, [a, b, c, d]);
        expect(game.lobbyOrigin.bots.size).toBe(0);

        const back = returnedLobby(w, c);
        expect(back.players.map((p) => p.socketId)).toEqual([c.id, d.id]);
        expect([...back.afterGame.reserved.keys()]).toEqual([a.data.username, b.data.username]);
        await lobbyHandlers.playerReady(c, w.io);
        await lobbyHandlers.playerReady(d, w.io);
        await jest.advanceTimersByTimeAsync(10000);
        expect(gameManager.getPlayerGame(c.id)).toBeFalsy();
        expect(gameManager.playerLobbies.get(c.id)).toBe(back.id);
        // A reserved player comes back with Join and readies: 3 of 4, still waiting
        mainRoomHandlers.joinMainRoom(a, w.io);
        mainRoomHandlers.joinLobby(a, w.io, { lobbyId: back.id });
        expect(w.errors(a)).toEqual([]);
        await lobbyHandlers.playerReady(a, w.io);
        await jest.advanceTimersByTimeAsync(10000);
        expect(gameManager.getPlayerGame(c.id)).toBeFalsy();
    });
});

// Review 2026-11-16 (finding 2): the reservation and lingering exits
describe('reservations and lingering calls end on every exit', () => {
    async function mixed(w) {
        const socks = [w.user(`ra${seq}`), w.user(`rb${seq}`), w.user(`rc${seq}`, 'legacy'), w.user(`rd${seq}`, 'legacy')];
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        return { socks, back: returnedLobby(w, socks[0]) };
    }

    test('signOutUser ends that user\'s reservation and lingering call (voicePeerLeft both ways; capable members get the new expected)', async () => {
        const w = world();
        const { socks, back } = await mixed(w);
        const mark = w.log.length;
        socks[2].disconnect = () => { w.io.sockets.sockets.delete(socks[2].id); };
        expect(authHandlers.signOutUser(w.io, socks[2].data.username)).toBe(1);
        expect(w.to(socks[2], 'forceLogout', mark)).toHaveLength(1);
        expect(back.afterGame.reserved.has(socks[2].data.username)).toBe(false);
        expect(back.afterGame.reserved.has(socks[3].data.username)).toBe(true);
        expect(back.afterGame.lingering.has(socks[2].id)).toBe(false);
        expect(w.to(socks[2], 'voicePeerLeft', mark).map((l) => l.data.socketId).sort()).toEqual([socks[0].id, socks[1].id].sort());
        for (const s of socks.slice(0, 2)) {
            expect(w.to(s, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([socks[2].id]);
            expect(w.last(s, 'playerReadyUpdate').expected).toEqual([socks[3].data.username]);
        }
    });

    test('creating a lobby or a tournament, or joining a tournament, ends the reservation', async () => {
        let w = world();
        let r = await mixed(w);
        mainRoomHandlers.joinMainRoom(r.socks[2], w.io);
        mainRoomHandlers.createLobby(r.socks[2], w.io, { name: 'Mine' });
        expect(gameManager.getPlayerLobby(r.socks[2].id).name).toBe('Mine');
        expect([...r.back.afterGame.reserved.keys()]).toEqual([r.socks[3].data.username]);

        w = world();
        r = await mixed(w);
        mainRoomHandlers.joinMainRoom(r.socks[2], w.io);
        tournamentHandlers.createTournament(r.socks[2], w.io);
        const tid = gameManager.getPlayerTournament(r.socks[2].id).tournamentId;
        expect(r.back.afterGame.reserved.has(r.socks[2].data.username)).toBe(false);
        mainRoomHandlers.joinMainRoom(r.socks[3], w.io);
        await tournamentHandlers.joinTournament(r.socks[3], w.io, { tournamentId: tid });
        expect(gameManager.getPlayerTournament(r.socks[3].id).tournamentId).toBe(tid);
        expect(r.back.afterGame.reserved.size).toBe(0);
        // Nothing is reserved any more: strangers and bots may take the places
        expect(playAgain.reservationBlocks(r.back)).toBe(false);
    });
});

// Review 2026-11-16 (finding 4): spec 1.3's "second golden" for a mixed game,
// payload by payload, room broadcasts included
describe('a mixed game: the legacy player\'s wire', () => {
    /** One seeded game of 2 capable + 2 legacy players; the legacy player socks[2] then taps Return and Join. */
    async function run(off) {
        if (off) process.env.PLAY_AGAIN = 'off'; else delete process.env.PLAY_AGAIN;
        const random = jest.spyOn(Math, 'random').mockImplementation(mulberry32(4242));
        jest.setSystemTime(Date.UTC(2026, 10, 16, 12));
        // The bots' table quips roll from the game id (a fresh uuid per run):
        // the same id for both runs, so they say the same things at the
        // same plays and the two wires stay comparable byte for byte
        const realRoll = botController.chatRoll;
        botController.chatRoll = (game, salt) => realRoll(Object.create(game, { gameId: { value: 'mixed-game' } }), salt);
        const w = world();
        const tag = off ? 'x' : 'y';
        const socks = ['full', 'full', 'legacy', 'legacy'].map((k, i) => w.user(`mx${i}${tag}${seq}`, k));
        lobbyOf(w, socks);
        try {
            await playLobbyGame(w.io, socks);
        } finally {
            botController.chatRoll = realRoll;
        }
        random.mockRestore();
        const end = gameEndIndex(w);
        const ret = w.log.length;
        mainRoomHandlers.joinMainRoom(socks[2], w.io);
        const joined = w.log.length;
        const back = returnedLobby(w, socks[0]);
        if (back) mainRoomHandlers.joinLobby(socks[2], w.io, { lobbyId: back.id });
        const slice = (a, b) => w.received(socks[2], a).slice(0, w.received(socks[2], a).length - w.received(socks[2], b).length);
        // This run's people go offline, so the next run's main room is the same
        gameManager.currentUsers = [];
        gameManager.mainRoomSocketIds.clear();
        return {
            socks, back,
            atTable: normalized(slice(end, ret), socks),
            onReturn: slice(ret, joined),
            onJoin: w.received(socks[2], joined),
        };
    }

    test('from gameEnd to its Return, byte-identical to PLAY_AGAIN=off; on Return only the private voicePeerLeft and the lobby card differ; Join is the legacy lobbyCreated', async () => {
        const off = await run(true);
        const on = await run(false);
        expect(on.back).toBeTruthy();
        expect(off.back).toBeFalsy();
        // Room broadcasts are in the comparison (gameEnd is one)
        expect(on.atTable[0]).toMatch(/^gameEnd /);
        expect(on.atTable).toEqual(off.atTable);

        // Return: voicePeerLeft for each moved player (private, no seq),
        // then mainRoomJoined with the reopened lobby's card added
        const leftOn = on.onReturn.filter((x) => x.event === 'voicePeerLeft');
        expect(leftOn.map((x) => JSON.parse(x.json))).toEqual([{ socketId: on.socks[0].id }, { socketId: on.socks[1].id }]);
        const rest = (r) => r.onReturn.filter((x) => x.event !== 'voicePeerLeft');
        const withoutCard = rest(on).map((x) => {
            if (x.event !== 'mainRoomJoined') return x;
            const d = JSON.parse(x.json);
            const card = d.lobbies.find((l) => l.id === on.back.id);
            expect(Object.keys(card)).toEqual(['id', 'name', 'playerCount', 'maxPlayers', 'players', 'createdAt']);
            expect(card).toMatchObject({ name: 'Family', playerCount: 2, maxPlayers: 4 });
            d.lobbies = d.lobbies.filter((l) => l.id !== on.back.id);
            return { event: x.event, json: JSON.stringify(d) };
        });
        expect(normalized(withoutCard, on.socks)).toEqual(normalized(rest(off), off.socks));

        // Join: today's lobbyCreated keys, no play-again field anywhere
        const created = on.onJoin.filter((x) => x.event === 'lobbyCreated').map((x) => JSON.parse(x.json));
        expect(created).toHaveLength(1);
        expect(Object.keys(created[0])).toEqual(['lobbyId', 'players', 'messages', 'name']);
        for (const x of on.onJoin) expect(x.json).not.toMatch(/"(returning|expected|members|lastGame|onResults)"/);
    });
});

// Review 2026-11-16 (PR F): the results stay up until Return to Lobby, so
// the client says when it leaves them (c2s lobbyReturnSeen)
describe('lobbyReturnSeen: the person left the results for the lobby', () => {
    test('a drop after it is the ordinary 30 s reload grace (no "Not back yet"), and another device\'s joinMainRoom is the main room', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const back = returnedLobby(w, socks[0]);
        expect(back.afterGame.unsettled.has(socks[1].id)).toBe(true);
        const mark = w.log.length;
        playAgain.lobbyReturnSeen(socks[1]);
        expect(back.afterGame.unsettled.has(socks[1].id)).toBe(false);
        expect(w.names(socks[1], mark)).toEqual([]);
        // the same user on a second device: its joinMainRoom leaves the seat alone
        const ipad = w.user(socks[1].data.username, 'full', { join: false });
        const at = w.log.length;
        mainRoomHandlers.joinMainRoom(ipad, w.io);
        expect(w.to(ipad, 'mainRoomJoined', at)).toHaveLength(1);
        expect(w.to(socks[1], 'leftLobby', at)).toEqual([]);
        expect(back.players[1].socketId).toBe(socks[1].id);
        // and a drop is a reload: 30 s, no returning row
        await w.kill(socks[1]);
        expect(gameManager.lobbyGrace.get(socks[1].id).kind).toBeUndefined();
        expect(gameManager.lobbyExtrasWire(back).members[1].returning).toBeUndefined();
        // still unsettled: a drop is a play-again hold
        await w.kill(socks[2]);
        expect(gameManager.lobbyGrace.get(socks[2].id).kind).toBe('afterGame');
    });

    test('off a lobby, or twice, it changes nothing', async () => {
        const w = world();
        const s = w.user(names(1)[0]);
        const mark = w.log.length;
        playAgain.lobbyReturnSeen(s);
        playAgain.lobbyReturnSeen(s);
        expect(w.names(s, mark)).toEqual([]);
        expect(gameManager.playerLobbies.has(s.id)).toBe(false);
    });
});

describe('the next start while someone still reads the last results', () => {
    test('a family of 6: the 4 others start; the one still on its results gets leftLobby (no spectatorJoined), its calls end both ways; a settled member is an extra', async () => {
        const w = world();
        const socks = names(6).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks.slice(0, 4));
        const back = returnedLobby(w, socks[0]);
        expect(back.players).toHaveLength(6);
        // socks[4] left its results for the lobby; socks[5] still reads them
        playAgain.lobbyReturnSeen(socks[4]);
        const mark = w.log.length;
        // (the handlers' promises settle only as the game goes on: not awaited)
        const { game: g2 } = await startLobbyGame(w.io, socks.slice(0, 4));
        await toBidding(w.io, g2, socks.slice(0, 4));

        const reader = socks[5];
        expect(w.to(reader, 'spectatorJoined', mark)).toEqual([]);
        expect(w.to(reader, 'leftLobby', mark)).toHaveLength(1);
        expect(w.to(reader, 'mainRoomJoined', mark)).toEqual([]);
        expect(gameManager.spectatorGames.has(reader.id)).toBe(false);
        expect(gameManager.playerLobbies.has(reader.id)).toBe(false);
        expect(g2.voiceSpectators?.has(reader.id) ?? false).toBe(false);
        expect(g2.lobbyOrigin.extras.has(reader.data.username)).toBe(false);
        expect(gameManager.startedLobbyRedirect(back.id, reader.data.username)).toBeFalsy();
        // its calls with the table and the extra end, both ways
        const others = socks.slice(0, 5).map((s) => s.id).sort();
        expect(w.to(reader, 'voicePeerLeft', mark).map((l) => l.data.socketId).sort()).toEqual(others);
        for (const s of socks.slice(0, 5)) {
            expect(w.to(s, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toContain(reader.id);
        }
        // the settled one is an extra, as before
        expect(w.to(socks[4], 'spectatorJoined', mark)).toHaveLength(1);
        expect(w.to(socks[4], 'leftLobby', mark)).toEqual([]);
        expect(g2.lobbyOrigin.extras.has(socks[4].data.username)).toBe(true);
        // its Return to Lobby then sends joinMainRoom: the main room, the new game listed
        const at = w.log.length;
        mainRoomHandlers.joinMainRoom(reader, w.io);
        expect(w.to(reader, 'mainRoomJoined', at)).toHaveLength(1);
        expect(w.last(reader, 'mainRoomJoined').inProgressGames.some((g) => g.gameId === g2.gameId)).toBe(true);
    });

    test('a lobby of 4 never leaves anyone out (an unsettled member cannot be off a full table)', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const mark = w.log.length;
        const { game: g2 } = await startLobbyGame(w.io, socks);
        await toBidding(w.io, g2, socks);
        for (const s of socks) expect(w.to(s, 'leftLobby', mark)).toEqual([]);
    });
});

// docs/BACKLOG.md (web review of PR E, finding 5): someone still reading the
// last results looked like any member who is not ready
describe('members[].onResults: "Still on the results"', () => {
    const flagged = (data) => (data?.members || []).filter((m) => m.onResults).map((m) => m.socketId);
    const plainUpdates = (w, s, from) => w.to(s, 'playerReadyUpdate', from)
        .filter((l) => !('readySocketId' in l.data) && !('unreadySocketId' in l.data));

    test('set at the return for every moved member (lobbyReturn, the wire), only in members', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const back = returnedLobby(w, socks[0]);
        const ids = socks.map((s) => s.id);
        for (const s of socks) expect(flagged(w.last(s, 'lobbyReturn'))).toEqual(ids);
        const wire = gameManager.lobbyWire(back, {}, { to: socks[0].id });
        expect(flagged(wire)).toEqual(ids);
        // players (the frozen 4) never carries it
        for (const p of wire.players) expect(p.onResults).toBeUndefined();
        // a socket that is not a capable member gets no members at all
        expect(gameManager.lobbyWire(back, {}, { to: 'someone-else' }).members).toBeUndefined();
    });

    test('lobbyReturnSeen clears it; the other capable members get one plain playerReadyUpdate without it, the settler nothing', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const mark = w.log.length;
        playAgain.lobbyReturnSeen(socks[1], w.io);
        expect(w.names(socks[1], mark)).toEqual([]);
        for (const s of [socks[0], socks[2], socks[3]]) {
            const got = w.to(s, 'playerReadyUpdate', mark);
            expect(got).toHaveLength(1);
            expect(Object.keys(got[0].data)).not.toContain('readySocketId');
            expect(flagged(got[0].data)).toEqual([socks[0].id, socks[2].id, socks[3].id]);
        }
        // twice: nothing more
        const again = w.log.length;
        playAgain.lobbyReturnSeen(socks[1], w.io);
        expect(w.log.slice(again).filter((l) => l.event === 'playerReadyUpdate')).toEqual([]);
    });

    test('an act in the lobby clears it: chat announces it; Ready and Unready carry it in their own update (no extra one); a refused act announces it', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        let mark = w.log.length;
        lobbyHandlers.lobbyChat(socks[1], w.io, { message: 'again?' });
        expect(plainUpdates(w, socks[0], mark)).toHaveLength(1);
        expect(flagged(w.last(socks[0], 'playerReadyUpdate'))).toEqual([socks[0].id, socks[2].id, socks[3].id]);

        mark = w.log.length;
        await lobbyHandlers.playerReady(socks[2], w.io);
        const ready = w.to(socks[0], 'playerReadyUpdate', mark);
        expect(ready).toHaveLength(1);
        expect(ready[0].data.readySocketId).toBe(socks[2].id);
        expect(flagged(ready[0].data)).toEqual([socks[0].id, socks[3].id]);

        mark = w.log.length;
        lobbyHandlers.playerUnready(socks[2], w.io);
        expect(w.to(socks[0], 'playerReadyUpdate', mark)).toHaveLength(1);

        // socks[3]: a refused talk-setting change (not the host) sends no list of its own
        mark = w.log.length;
        lobbyHandlers.setLobbySpectatorsCanTalk(socks[3], w.io, false);
        expect(w.errors(socks[3])).toEqual(['Only the host can change this']);
        expect(plainUpdates(w, socks[0], mark)).toHaveLength(1);
        expect(flagged(w.last(socks[0], 'playerReadyUpdate'))).toEqual([socks[0].id]);
        expect(w.to(socks[3], 'playerReadyUpdate', mark)).toEqual([]);
        // an act from a settled member announces nothing
        mark = w.log.length;
        lobbyHandlers.lobbyChat(socks[3], w.io, { message: 'hi' });
        expect(w.log.slice(mark).filter((l) => l.event === 'playerReadyUpdate')).toEqual([]);
    });

    test('a leave clears it (lobbyPlayerLeft\'s list; a later join is not on the results); a drop shows the hold, never onResults', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const back = returnedLobby(w, socks[0]);
        let mark = w.log.length;
        lobbyHandlers.leaveLobby(socks[3], w.io);
        expect(back.afterGame.unsettled.has(socks[3].id)).toBe(false);
        const left = w.to(socks[0], 'lobbyPlayerLeft', mark);
        expect(left).toHaveLength(1);
        expect(flagged(left[0].data)).toEqual([socks[0].id, socks[1].id, socks[2].id]);
        // the same socket joins again from the main room: on the lobby screen
        mainRoomHandlers.joinMainRoom(socks[3], w.io);
        mainRoomHandlers.joinLobby(socks[3], w.io, { lobbyId: back.id });
        expect(gameManager.getPlayerLobby(socks[3].id)).toBe(back);
        expect(flagged(w.last(socks[0], 'lobbyPlayerJoined'))).toEqual([socks[0].id, socks[1].id, socks[2].id]);

        // socks[2] drops while still on its results: a hold ("Not back yet")
        mark = w.log.length;
        await w.kill(socks[2]);
        expect(gameManager.lobbyGrace.get(socks[2].id).kind).toBe('afterGame');
        const update = w.to(socks[0], 'playerReadyUpdate', mark).pop().data;
        const row = update.members.find((m) => m.socketId === socks[2].id);
        expect(row).toMatchObject({ returning: true, reconnecting: true });
        expect(row.onResults).toBeUndefined();
        expect(flagged(update)).toEqual([socks[0].id, socks[1].id]);
    });

    test('a reload-held seat (PLAY_AGAIN_HOLD_MS=0) is reconnecting, never onResults; the same socket back in place, never off its results, is again', async () => {
        process.env.PLAY_AGAIN_HOLD_MS = '0';
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const back = returnedLobby(w, socks[0]);
        await w.kill(socks[1]);
        const row = gameManager.lobbyExtrasWire(back).members[1];
        expect(row.reconnecting).toBe(true);
        expect(row.onResults).toBeUndefined();
        expect(row.returning).toBeUndefined();
        // a parked socket takes the session back (resumeHeldLobbySeat)
        expect(gameManager.resumeHeldLobbySeat(socks[1].id, socks[1].data.username)).toBeTruthy();
        expect(gameManager.lobbyExtrasWire(back).members[1].onResults).toBe(true);
    });

    test('legacy members never get it: their lobby events are the old payloads; only the capable ones are told', async () => {
        const w = world();
        const socks = ['full', 'full', 'legacy', 'legacy'].map((k, i) => w.user(`or${i}_${seq}`, k));
        lobbyOf(w, socks);
        await playLobbyGame(w.io, socks);
        const back = returnedLobby(w, socks[0]);
        // the legacy player taps Return and Join (the card)
        mainRoomHandlers.joinMainRoom(socks[2], w.io);
        const mark = w.log.length;
        mainRoomHandlers.joinLobby(socks[2], w.io, { lobbyId: back.id });
        expect(flagged(w.last(socks[0], 'lobbyPlayerJoined'))).toEqual([socks[0].id, socks[1].id]);
        playAgain.lobbyReturnSeen(socks[1], w.io);
        lobbyHandlers.lobbyChat(socks[0], w.io, { message: 'ok' });
        await lobbyHandlers.playerReady(socks[2], w.io);
        // the plain announcements went to the capable members only
        const plain = w.log.slice(mark).filter((l) => l.event === 'playerReadyUpdate' &&
            !('readySocketId' in l.data) && !('unreadySocketId' in l.data));
        expect(plain.map((l) => l.to).sort()).toEqual([socks[0].id, socks[1].id].sort());
        expect(flagged(plain.find((l) => l.to === socks[0].id).data)).toEqual([socks[0].id]);
        // socks[2] (legacy) got its old events only
        expect(w.received(socks[2], mark).length).toBeGreaterThan(0);
        for (const x of w.received(socks[2], mark)) expect(x.json).not.toMatch(/"(onResults|members|returning|expected)"/);
    });
});
