/**
 * Family lobbies (owner 2026-11-16): a casual lobby holds up to 8 people
 * while every human in it sent the clientHello cap casualSpectators; the
 * first 4 to tap Ready play and the others (the extras) watch the game from
 * its first moment. Any legacy client in the lobby keeps it at 4, and a
 * legacy client never sees more than 4 (players / reconnecting / the list
 * entry stay at most 4; the additive keys go to capable sockets only).
 *
 * Real handlers on the in-memory DB fake, stub io/sockets, fake timers.
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
const clientInfo = require('../clientInfo');
const voice = require('../voiceHandlers');
const pacing = require('../../game/pacing');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

const { LEGACY_LIMIT, TABLE_FULL, LOBBY_SEAT_GRACE_MS } = gameManager.constructor;

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
        /** A signed-in socket in the main room; capable sends casualSpectators. */
        user(name, { capable = true } = {}) {
            n++;
            const id = `fl${seq}-${name}-${n}`;
            const s = makeSocket(id, log, io);
            gameManager.registerUser(id, name);
            voice.rememberBlockList(s, []);
            if (!mockDb.current.users.docs.some((d) => d.username === name)) {
                mockDb.current.users._insert({ username: name, profilePic: 3, blockedUsers: [] });
            }
            clientInfo.handle(s, io, capable
                ? { client: 'web', version: '1', caps: ['avatarUrl', 'casualSpectators'] }
                : { client: 'ios', version: '1.2.2', build: '11', caps: ['avatarUrl'] });
            mainRoomHandlers.joinMainRoom(s, io);
            return s;
        },
        /** A transport disconnect (the lobby seat is held for its grace). */
        kill(s) {
            io.sockets.sockets.delete(s.id);
            for (const members of io.rooms.values()) members.delete(s.id);
            return queueHandlers.handleDisconnect(s, io);
        },
        to(s, event) {
            return log.filter((l) => (l.to === s.id || l.to === `self:${s.id}`) && l.event === event);
        },
        last(s, event) {
            return w.to(s, event).pop()?.data;
        },
    };
    return w;
}

/** `names[0]` creates a lobby, the rest join it. */
function lobbyOf(w, socks) {
    mainRoomHandlers.createLobby(socks[0], w.io, {});
    const lobby = gameManager.getPlayerLobby(socks[0].id);
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId: lobby.id });
    return lobby;
}

const errors = (w, s) => w.to(s, 'serverError').map((l) => l.data.message);
const names = (k) => Array.from({ length: k }, (_, i) => `fam${seq}_${i + 1}`);

describe('capacity: 8 only while every human is capable', () => {
    test('a capable lobby takes 8; the 9th is refused', () => {
        const w = world();
        const socks = names(9).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks.slice(0, 8));
        expect(lobby.players).toHaveLength(8);
        expect(gameManager.lobbyCapacity(lobby)).toBe(8);
        mainRoomHandlers.joinLobby(socks[8], w.io, { lobbyId: lobby.id });
        expect(errors(w, socks[8])).toEqual(['Lobby is full']);
    });

    test('a legacy joiner is refused at 4 or more ("Lobby is full", as before)', () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks);
        const old = w.user(`old${seq}`, { capable: false });
        mainRoomHandlers.joinLobby(old, w.io, { lobbyId: lobby.id });
        expect(errors(w, old)).toEqual(['Lobby is full']);
        expect(lobby.players).toHaveLength(4);
    });

    test('a legacy member keeps the lobby at 4: a capable 5th gets the older-version message', () => {
        const w = world();
        const socks = names(3).map((n) => w.user(n));
        const old = w.user(`old${seq}`, { capable: false });
        const lobby = lobbyOf(w, [...socks, old]);
        expect(gameManager.lobbyCapacity(lobby)).toBe(4);
        const late = w.user(`late${seq}`);
        mainRoomHandlers.joinLobby(late, w.io, { lobbyId: lobby.id });
        expect(errors(w, late)).toEqual([LEGACY_LIMIT]);
        expect(lobby.players).toHaveLength(4);
    });

    test('a legacy takeover of a held seat in a lobby of 5 or more is refused; the seat then expires', async () => {
        const w = world();
        const socks = names(5).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks);
        await w.kill(socks[4]);
        expect(gameManager.reconnectingIn(lobby.id)).toEqual([socks[4] && gameManager.lobbies.get(lobby.id).players[4].username]);
        const back = w.user(lobby.players[4].username, { capable: false });
        mainRoomHandlers.joinLobby(back, w.io, { lobbyId: lobby.id });
        expect(errors(w, back)).toEqual(['Lobby is full']);
        await jest.advanceTimersByTimeAsync(LOBBY_SEAT_GRACE_MS + 10);
        expect(lobby.players).toHaveLength(4);
    });

    test('a capable takeover of a held seat in a lobby of 6 works in place', async () => {
        const w = world();
        const socks = names(6).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks);
        const name = lobby.players[5].username;
        await w.kill(socks[5]);
        const back = w.user(name);
        mainRoomHandlers.joinLobby(back, w.io, { lobbyId: lobby.id });
        expect(errors(w, back)).toEqual([]);
        expect(lobby.players[5].socketId).toBe(back.id);
        expect(gameManager.lobbyCapacity(lobby)).toBe(8);
    });
});

describe('the wire: legacy shape everywhere, additive keys for capable sockets', () => {
    test('a lobby of 4 without the cap is byte-identical to before (no members / host / settings / capacity)', () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n, { capable: false }));
        lobbyOf(w, socks);
        const created = w.last(socks[0], 'lobbyCreated');
        expect(Object.keys(created)).toEqual(['lobbyId', 'players', 'messages', 'name']);
        const joined = w.to(socks[0], 'lobbyPlayerJoined').pop().data;
        expect(Object.keys(joined)).toEqual(['lobbyId', 'players', 'newPlayer']);
        const entry = w.log.filter((l) => l.event === 'lobbiesUpdated').pop().data.lobbies[0];
        expect(Object.keys(entry)).toEqual(['id', 'name', 'playerCount', 'maxPlayers', 'players', 'createdAt']);
        lobbyHandlers.playerReady(socks[1], w.io);
        expect(Object.keys(w.last(socks[0], 'playerReadyUpdate'))).toEqual(['lobbyId', 'players', 'readySocketId']);
    });

    test('players / reconnecting stay at most 4 with 8 members; members carries all 8 and who is held', async () => {
        const w = world();
        const socks = names(8).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks);
        for (const s of socks.slice(2, 7)) await w.kill(s);
        const upd = w.last(socks[0], 'playerReadyUpdate');
        expect(upd.players).toHaveLength(4);
        expect(upd.reconnecting).toHaveLength(4);
        expect(upd.members).toHaveLength(8);
        expect(upd.members.filter((m) => m.reconnecting).map((m) => m.username)).toEqual(lobby.players.slice(2, 7).map((p) => p.username));
        expect(upd).toMatchObject({ host: lobby.players[0].username, settings: { spectatorsCanTalk: true }, capacity: 8 });
    });

    test('the main-room list: playerCount 4 for everyone, memberCount / memberUsernames 6 only for a capable viewer', () => {
        const w = world();
        const viewer = w.user(`viewer${seq}`);
        const legacyViewer = w.user(`legacyviewer${seq}`, { capable: false });
        const socks = names(6).map((n) => w.user(n));
        lobbyOf(w, socks);
        const lists = w.log.filter((l) => l.event === 'lobbiesUpdated');
        const forViewer = lists.filter((l) => l.to === viewer.id).pop().data.lobbies[0];
        const forLegacy = lists.filter((l) => l.to === legacyViewer.id).pop().data.lobbies[0];
        expect(forViewer).toMatchObject({ playerCount: 4, maxPlayers: 4, memberCount: 6, capacity: 8 });
        expect(forViewer.players).toHaveLength(4);
        expect(forViewer.memberUsernames).toHaveLength(6);
        expect(forLegacy).toMatchObject({ playerCount: 4, maxPlayers: 4 });
        expect(forLegacy.players).toHaveLength(4);
        expect('memberCount' in forLegacy).toBe(false);
        expect('memberUsernames' in forLegacy).toBe(false);
    });
});

describe('the table: the first 4 to tap Ready play', () => {
    test('6 capable: the first 4 ready are the table, a 5th Ready is refused, the game gets exactly 4 entrants', async () => {
        const w = world();
        const socks = names(6).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks);
        const order = [socks[3], socks[1], socks[5], socks[0]];
        const starting = order.map((s) => lobbyHandlers.playerReady(s, w.io));
        await lobbyHandlers.playerReady(socks[2], w.io);
        expect(errors(w, socks[2])).toEqual([TABLE_FULL]);
        const resync = w.last(socks[2], 'playerReadyUpdate');
        expect(resync.members.find((m) => m.socketId === socks[2].id)).toMatchObject({ ready: false, playing: false });
        expect(resync.members.filter((m) => m.playing).map((m) => m.socketId).sort()).toEqual(order.map((s) => s.id).sort());
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS + 10);
        const game = gameManager.getPlayerGame(socks[0].id);
        expect(game).toBeTruthy();
        expect([...game.entrants.keys()].sort()).toEqual(order.map((s) => s.id).sort());
        // entrants in lobby (join) order, as a lobby of 4 always started
        expect([...game.entrants.keys()]).toEqual([socks[0].id, socks[1].id, socks[3].id, socks[5].id]);
        expect(gameManager.lobbies.has(lobby.id)).toBe(false);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(starting);
    });

    test('bots: host + 3 bots, then 3 humans join: the 4 humans play and the bots sit out', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        mainRoomHandlers.createLobby(socks[0], w.io, {});
        const lobby = gameManager.getPlayerLobby(socks[0].id);
        for (let i = 0; i < 3; i++) await lobbyHandlers.addBot(socks[0], w.io);
        // Add Bot is refused at 4 members, as before
        await lobbyHandlers.addBot(socks[0], w.io);
        expect(errors(w, socks[0])).toEqual(['Lobby is full']);
        for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId: lobby.id });
        expect(lobby.players).toHaveLength(7);
        expect(gameManager.tableBots(lobby)).toEqual([]);
        const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
        const upd = w.last(socks[0], 'playerReadyUpdate');
        expect(upd.members.filter((m) => m.isBot).every((m) => m.playing === false && m.ready === false)).toBe(true);
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS + 10);
        const game = gameManager.getPlayerGame(socks[0].id);
        expect([...game.entrants.values()].every((e) => !e.isBot)).toBe(true);
        expect(game.entrants.size).toBe(4);
        expect(require('../../game/bot').botController.getGameBots(game.gameId)).toEqual([]);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(starting);
    });

    test('a lobby of 5 with 2 humans + 3 bots: one table bot plays with 3 humans once they are ready', async () => {
        const w = world();
        const socks = names(3).map((n) => w.user(n));
        mainRoomHandlers.createLobby(socks[0], w.io, {});
        const lobby = gameManager.getPlayerLobby(socks[0].id);
        mainRoomHandlers.joinLobby(socks[1], w.io, { lobbyId: lobby.id });
        await lobbyHandlers.addBot(socks[0], w.io);
        await lobbyHandlers.addBot(socks[0], w.io);
        mainRoomHandlers.joinLobby(socks[2], w.io, { lobbyId: lobby.id });
        expect(lobby.players).toHaveLength(5);
        const tableBot = gameManager.tableBots(lobby);
        expect(tableBot).toHaveLength(1);
        const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
        expect(tableBot[0].ready).toBe(true);
        expect(lobby.players.filter((p) => p.isBot && !p.ready)).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS + 10);
        const game = gameManager.getPlayerGame(socks[0].id);
        expect(game.entrants.size).toBe(4);
        expect([...game.entrants.keys()]).toContain(tableBot[0].socketId);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(starting);
    });

    test('the start re-validates: an unready in the window cancels it, and the next Ready takes the seat', async () => {
        const w = world();
        const socks = names(5).map((n) => w.user(n));
        lobbyOf(w, socks);
        const first = socks.slice(0, 4).map((s) => lobbyHandlers.playerReady(s, w.io));
        lobbyHandlers.playerUnready(socks[2], w.io);
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS + 10);
        await Promise.all(first);
        expect(gameManager.getPlayerGame(socks[0].id)).toBeFalsy();
        const second = lobbyHandlers.playerReady(socks[4], w.io);
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS + 10);
        const game = gameManager.getPlayerGame(socks[4].id);
        expect(game).toBeTruthy();
        expect(game.entrants.has(socks[2].id)).toBe(false);
        expect(gameManager.spectatorGames.get(socks[2].id)).toBe(game.gameId);
        await jest.advanceTimersByTimeAsync(5000);
        await second;
    });

    test('a leave in the window cancels the start; in a lobby of more than 4 the others keep their ready flags', async () => {
        const w = world();
        const socks = names(5).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks);
        const first = socks.slice(0, 4).map((s) => lobbyHandlers.playerReady(s, w.io));
        lobbyHandlers.leaveLobby(socks[3], w.io);
        expect(lobby.players.filter((p) => p.ready)).toHaveLength(3);
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS + 10);
        await Promise.all(first);
        expect(gameManager.getPlayerGame(socks[0].id)).toBeFalsy();
    });

    test('a lobby of capacity 4 (a legacy member) still resets every ready flag on a leave', () => {
        const w = world();
        const socks = names(4).map((n, i) => w.user(n, { capable: i !== 2 }));
        const lobby = lobbyOf(w, socks);
        lobbyHandlers.playerReady(socks[0], w.io);
        lobbyHandlers.playerReady(socks[1], w.io);
        lobbyHandlers.leaveLobby(socks[3], w.io);
        expect(lobby.players.some((p) => p.ready)).toBe(false);
    });
});

describe('the start: extras watch the game', () => {
    async function startSix(w, { lobbyOff = false } = {}) {
        const socks = names(6).map((n) => w.user(n));
        const viewer = w.user(`viewer${seq}`);
        const lobby = lobbyOf(w, socks);
        if (lobbyOff) voice.setSpectatorsCanTalk(socks[0], w.io, { spectatorsCanTalk: false });
        const mark = w.log.length;
        const starting = socks.slice(0, 4).map((s) => lobbyHandlers.playerReady(s, w.io));
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS + 10);
        const game = gameManager.getPlayerGame(socks[0].id);
        return { socks, viewer, lobby, game, mark, starting, extras: socks.slice(4) };
    }

    test('extras are pure spectators with a CREATED full state, never allPlayersReady, and no room notice', async () => {
        const w = world();
        const { game, mark, extras, socks, starting } = await startSix(w);
        const since = w.log.slice(mark);
        for (const x of extras) {
            expect(gameManager.spectatorGames.get(x.id)).toBe(game.gameId);
            expect(gameManager.playerLobbies.has(x.id)).toBe(false);
            expect(since.filter((l) => l.to === x.id && l.event === 'allPlayersReady')).toEqual([]);
            const full = since.find((l) => l.to === `self:${x.id}` && l.event === 'spectatorJoined');
            expect(full.data.snapshot).toMatchObject({ stage: 'CREATED', viewer: { role: 'spectator' } });
            expect(game.voiceSpectators.get(x.id)).toMatchObject({ fromLobby: true });
            expect(since.filter((l) => l.to === x.id && l.event === 'voiceSettings').pop().data)
                .toMatchObject({ gameId: game.gameId, role: 'spectator', canTalk: true, spectatorsCanTalk: true, canChange: false });
        }
        expect(since.filter((l) => l.event === 'spectatorJoined' && l.to === game.roomName)).toEqual([]);
        for (const s of socks.slice(0, 4)) {
            expect(since.filter((l) => l.to === s.id && l.event === 'allPlayersReady')).toHaveLength(1);
            expect(since.filter((l) => l.to === s.id && l.event === 'voiceSettings').pop().data).toMatchObject({ role: 'player', canTalk: true });
        }
        // The host is seated: only the host may switch
        const hostSettings = since.filter((l) => l.to === socks[0].id && l.event === 'voiceSettings').pop().data;
        expect(hostSettings).toMatchObject({ canChange: true, host: game.casualVoice.host });
        expect(since.filter((l) => l.to === socks[1].id && l.event === 'voiceSettings').pop().data.canChange).toBe(false);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(starting);
    });

    test('the started lobby leaves the main-room list at the start (lobbiesUpdated)', async () => {
        const w = world();
        const { viewer, lobby, mark, starting } = await startSix(w);
        const update = w.log.slice(mark).filter((l) => l.event === 'lobbiesUpdated' && (l.to === viewer.id || l.to === 'mainRoom')).pop();
        expect(update.data.lobbies.some((l) => l.id === lobby.id)).toBe(false);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(starting);
    });

    test('switch off at the start: extras get canTalk false and drop each other; players keep them', async () => {
        const w = world();
        const { game, mark, extras, starting } = await startSix(w, { lobbyOff: true });
        expect(game.casualVoice.spectatorsCanTalk).toBe(false);
        const since = w.log.slice(mark);
        expect(since.filter((l) => l.to === extras[0].id && l.event === 'voiceSettings').pop().data).toMatchObject({ canTalk: false });
        expect(since.filter((l) => l.event === 'voicePeerLeft' && l.to === extras[0].id).map((l) => l.data.socketId)).toEqual([extras[1].id]);
        expect(since.filter((l) => l.event === 'voicePeerLeft' && l.to === extras[1].id).map((l) => l.data.socketId)).toEqual([extras[0].id]);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(starting);
    });

    test('an extra re-sending joinLobby (a reload during the start) spectates the game; a table member gets "Lobby not found"', async () => {
        const w = world();
        const { game, lobby, extras, socks, starting } = await startSix(w);
        const extraName = gameManager.getUserBySocketId(extras[0].id).username;
        await w.kill(extras[0]);
        const back = w.user(extraName);
        mainRoomHandlers.joinLobby(back, w.io, { lobbyId: lobby.id });
        expect(gameManager.spectatorGames.get(back.id)).toBe(game.gameId);
        expect(game.voiceSpectators.get(back.id)).toMatchObject({ fromLobby: true });
        // A table member (an entrant) is never redirected
        const memberName = gameManager.getUserBySocketId(socks[1].id).username;
        const other = w.user(memberName);
        mainRoomHandlers.joinLobby(other, w.io, { lobbyId: lobby.id });
        expect(errors(w, other)).toEqual(['Lobby not found']);
        expect(gameManager.spectatorGames.has(other.id)).toBe(false);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(starting);
    });

    test('the redirect and the voice state go with the game (abort)', async () => {
        const w = world();
        const { game, lobby, starting } = await startSix(w);
        expect(gameManager.startedLobbies.has(lobby.id)).toBe(true);
        await require('../gameLifecycle').abortGame(w.io, game, 'test');
        expect(gameManager.startedLobbies.has(lobby.id)).toBe(false);
        expect(game.voiceSpectators.size).toBe(0);
        expect(game.voiceOfferDir.size).toBe(0);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(starting);
    });
});

describe('host', () => {
    test('the host passes to the first connected member, skipping held seats', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks);
        const nameOf = (s) => gameManager.getUserBySocketId(s.id).username;
        expect(gameManager.lobbyHost(lobby)).toBe(nameOf(socks[0]));
        await w.kill(socks[1]); // held
        lobbyHandlers.leaveLobby(socks[0], w.io);
        expect(gameManager.lobbyHost(lobby)).toBe(nameOf(socks[2]));
        expect(w.last(socks[3], 'lobbyPlayerLeft')).toMatchObject({ host: nameOf(socks[2]) });
    });

    test('a held host stays host while held', async () => {
        const w = world();
        const socks = names(3).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks);
        const hostName = gameManager.getUserBySocketId(socks[0].id).username;
        await w.kill(socks[0]);
        lobbyHandlers.leaveLobby(socks[2], w.io);
        expect(gameManager.lobbyHost(lobby)).toBe(hostName);
    });

    test('with only held members left the first holds it provisionally; a reconnect chooses again', async () => {
        const w = world();
        const socks = names(3).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks);
        const [, b, c] = socks.map((s) => gameManager.getUserBySocketId(s.id).username);
        await w.kill(socks[1]);
        await w.kill(socks[2]);
        lobbyHandlers.leaveLobby(socks[0], w.io);
        expect(gameManager.lobbyHost(lobby)).toBe(b);
        expect(lobby.hostProvisional).toBe(true);
        const cBack = w.user(c);
        mainRoomHandlers.joinLobby(cBack, w.io, { lobbyId: lobby.id });
        expect(gameManager.lobbyHost(lobby)).toBe(c);
        const bBack = w.user(b);
        mainRoomHandlers.joinLobby(bBack, w.io, { lobbyId: lobby.id });
        expect(gameManager.lobbyHost(lobby)).toBe(c);
        expect(w.last(bBack, 'lobbyCreated').host).toBe(c);
    });

    test('a lobby built by createLobby (no host) falls back to its first human', () => {
        const w = world();
        const a = w.user(`ca${seq}`);
        const b = w.user(`cb${seq}`);
        const lobby = gameManager.createLobby([a.id, b.id]);
        expect(gameManager.lobbyHost(lobby)).toBe(gameManager.getUserBySocketId(a.id).username);
    });

    test('only the host sets "Spectators can talk" in the lobby; every member gets the settings', () => {
        const w = world();
        const socks = names(5).map((n) => w.user(n));
        const lobby = lobbyOf(w, socks);
        voice.setSpectatorsCanTalk(socks[1], w.io, { spectatorsCanTalk: false });
        expect(errors(w, socks[1])).toEqual(['Only the host can change this']);
        expect(lobby.settings.spectatorsCanTalk).toBe(true);
        voice.setSpectatorsCanTalk(socks[0], w.io, { spectatorsCanTalk: false });
        expect(lobby.settings.spectatorsCanTalk).toBe(false);
        for (const s of socks) expect(w.last(s, 'playerReadyUpdate').settings).toEqual({ spectatorsCanTalk: false });
    });

    test('outside a lobby and a casual game the switch is refused', () => {
        const w = world();
        const s = w.user(`solo${seq}`);
        voice.setSpectatorsCanTalk(s, w.io, { spectatorsCanTalk: false });
        expect(errors(w, s)).toEqual(['Spectator talk can only be set in a lobby or a casual game']);
    });
});

describe('spectating is not a membership, but a lobby member spectates nothing', () => {
    test('a spectator creating or joining a lobby leaves spectating and the voice room', async () => {
        const w = world();
        const socks = names(4).map((n) => w.user(n));
        lobbyOf(w, socks);
        const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS + 10);
        const game = gameManager.getPlayerGame(socks[0].id);
        const watcher = w.user(`watch${seq}`);
        const watcher2 = w.user(`watch2${seq}`);
        mainRoomHandlers.joinAsSpectator(watcher, w.io, { gameId: game.gameId });
        mainRoomHandlers.joinAsSpectator(watcher2, w.io, { gameId: game.gameId });
        expect(game.voiceSpectators.has(watcher.id)).toBe(true);
        const mark = w.log.length;
        mainRoomHandlers.createLobby(watcher, w.io, {});
        expect(gameManager.spectatorGames.has(watcher.id)).toBe(false);
        expect(game.voiceSpectators.has(watcher.id)).toBe(false);
        expect(game.isSpectator(watcher.id)).toBe(false);
        // its voice peers were told, privately
        const left = w.log.slice(mark).filter((l) => l.event === 'voicePeerLeft' && l.data.socketId === watcher.id).map((l) => l.to);
        expect(left.sort()).toEqual([...socks.map((s) => s.id), watcher2.id].sort());
        const newLobby = gameManager.getPlayerLobby(watcher.id);
        mainRoomHandlers.joinLobby(watcher2, w.io, { lobbyId: newLobby.id });
        expect(gameManager.spectatorGames.has(watcher2.id)).toBe(false);
        expect(game.voiceSpectators.size).toBe(0);
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all(starting);
    });
});
