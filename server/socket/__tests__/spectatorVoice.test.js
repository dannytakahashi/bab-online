/**
 * Spectator voice in casual games (family lobbies, owner 2026-11-16;
 * server/voice/gameVoice.js): who is admitted to a game's voice room, who
 * may signal whom, spectators always talking (owner 2026-11-18: no
 * "Spectators can talk" switch; setSpectatorsCanTalk from shipped iOS
 * 12-15 and cached web tabs is ignored), and every way a voice spectator
 * leaves it. Signaling between players is unchanged (voiceSignaling.test.js).
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
const gameVoice = require('../../voice/gameVoice');
const voice = require('../voiceHandlers');
const safety = require('../safetyHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const queueHandlers = require('../queueHandlers');
const chatHandlers = require('../chatHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const seatLifecycle = require('../seatLifecycle');
const clientInfo = require('../clientInfo');
const turn = require('../../voice/turnCredentials');
const pacing = require('../../game/pacing');
const { Phase } = require('../../game/GamePhase');
const { rateLimiter } = require('../errorHandler');
const { makeIo, makeSocket, lazySeat } = require('../../testUtils/gameDriver');
const { BotPlayer } = require('../../game/bot');
const { gameLogger, socketLogger, logger, authLogger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
// SDP bodies built from obviously fake parts (never secret-shaped)
const sdp = (dir) => ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', `a=${dir}`, 'a=mid:0', ''].join('\r\n');
const OFFER = (dir) => ({ type: 'offer', sdp: sdp(dir) });
const ANSWER = (dir) => ({ type: 'answer', sdp: sdp(dir) });

let seq = 0;
let log;
let io;

beforeEach(() => {
    seq++;
    jest.useFakeTimers();
    log = [];
    io = makeIo(log);
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, logger, authLogger]) for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
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
    for (const s of io.sockets.sockets.keys()) rateLimiter.clearSocket(s);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

/** A signed-in socket; capable sends casualSpectators; blocked: its loaded block list (null: none loaded). */
function user(tag, { capable = true, blocked = [] } = {}) {
    const id = `sv${seq}-${tag}`;
    const s = makeSocket(id, log, io);
    const username = `${tag}${seq}`;
    gameManager.registerUser(id, username);
    if (blocked !== null) voice.rememberBlockList(s, blocked);
    mockDb.current.users._insert({ username, profilePic: 3, blockedUsers: blocked || [] });
    clientInfo.handle(s, io, capable
        ? { client: 'web', version: '1', caps: ['avatarUrl', 'casualSpectators'] }
        : { client: 'ios', version: '1.2.2', build: '11', caps: ['avatarUrl'] });
    return s;
}
const nameOf = (s) => gameManager.getUserBySocketId(s.id).username;

/** A seated casual game in PLAYING (4 human seats); returns the seat sockets. capable: one flag, or one per seat. */
function casualGame(tags, { capable = true, casual = true } = {}) {
    const socks = tags.map((t, i) => user(t, { capable: Array.isArray(capable) ? capable[i] : capable }));
    const game = gameManager.createGame(socks.map((s) => s.id));
    socks.forEach((s, i) => game.addPlayer(s.id, nameOf(s), i + 1, 1, false));
    socks.forEach((s) => s.join(game.roomName));
    game.currentHand = 1;
    socks.forEach((s, i) => game.setHand(s.id, [C(String(i + 2), 'hearts')]));
    game.trump = C('A', 'spades');
    game.forcePhase('PLAYING');
    if (casual) gameVoice.initCasualVoice(game, { host: nameOf(socks[0]), io });
    return { game, socks };
}

/** `s` spectates `game` and asks for its voice room (joinAsSpectator's two steps). */
function spectate(game, s, opts = {}) {
    gameManager.addSpectator(io, game, s.id, nameOf(s), 1);
    return gameVoice.admitVoiceSpectator(io, game, s.id, { announce: true, ...opts });
}

const to = (s, event, from = 0) => log.slice(from).filter((l) => (l.to === s.id || l.to === `self:${s.id}`) && l.event === event);
const last = (s, event) => to(s, event).pop()?.data;
const relayed = (event, from = 0) => log.slice(from).filter((l) => l.event === event);

describe('admission', () => {
    test('a capable spectator of a casual game is admitted: it lists the players, they are told, it gets voiceSettings', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        expect(spectate(game, x)).toBe(true);
        expect(last(x, 'voicePeerList').peers.map((p) => p.socketId)).toEqual(socks.map((s) => s.id));
        for (const s of socks) expect(last(s, 'voicePeerJoined')).toEqual({ socketId: x.id, username: nameOf(x) });
        expect(last(x, 'voiceSettings')).toEqual({ gameId: game.gameId, host: nameOf(socks[0]), spectatorsCanTalk: true, role: 'spectator', canTalk: true, canChange: false });
        expect(gameVoice.voiceRoomOf(x.id)).toBe(`game:${game.gameId}`);
    });

    test('a capable spectator may signal the players (and back) and gets TURN', async () => {
        const { socks, game } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        voice.voiceOffer(x, io, { targetSocketId: socks[1].id, offer: OFFER('sendrecv') });
        voice.voiceAnswer(socks[1], io, { targetSocketId: x.id, answer: ANSWER('sendrecv') });
        voice.voiceIceCandidate(x, io, { targetSocketId: socks[1].id, candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
        expect(relayed('voiceOffer').map((l) => l.to)).toEqual([socks[1].id]);
        expect(relayed('voiceAnswer').map((l) => l.to)).toEqual([x.id]);
        expect(relayed('voiceIceCandidate').map((l) => l.to)).toEqual([socks[1].id]);
        const spy = jest.spyOn(turn, 'getIceServers').mockResolvedValue({ iceServers: [{ urls: ['turn:turn.invalid:3478'], username: 'u', credential: 'c' }], turn: true, expiresInSec: 100 });
        await voice.getVoiceIceServers(x, io, {});
        expect(spy).toHaveBeenCalledWith(nameOf(x));
        expect(last(x, 'voiceIceServers').turn).toBe(true);
    });

    test('refused: a legacy spectator (no voice event at all), a tournament / non-casual game, a seated player\'s other tab', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const old = user('old', { capable: false });
        expect(spectate(game, old)).toBe(false);
        expect(to(old, 'voiceSettings')).toEqual([]);
        expect(to(old, 'voicePeerList')).toEqual([]);
        voice.voiceOffer(old, io, { targetSocketId: socks[0].id, offer: OFFER('recvonly') });
        expect(relayed('voiceOffer')).toEqual([]);

        const t = casualGame(['ta', 'tb', 'tc', 'td'], { casual: false });
        const y = user('y');
        expect(spectate(t.game, y)).toBe(false);
        expect(to(y, 'voiceSettings')).toEqual([]);

        // another tab of a seated player
        const seated = nameOf(socks[2]);
        const tab = makeSocket(`sv${seq}-tab`, log, io);
        gameManager.registerUser(tab.id, seated);
        clientInfo.handle(tab, io, { client: 'web', version: '1', caps: ['casualSpectators'] });
        gameManager.addSpectator(io, game, tab.id, seated, 1);
        expect(gameVoice.admitVoiceSpectator(io, game, tab.id)).toBe(false);
    });

    test('8 people at most: the 9th gets role none; a seat in grace keeps its slot', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const xs = ['w1', 'w2', 'w3', 'w4'].map((t) => user(t));
        for (const x of xs) expect(spectate(game, x)).toBe(true);
        const ninth = user('w5');
        expect(spectate(game, ninth)).toBe(false);
        expect(last(ninth, 'voiceSettings')).toMatchObject({ role: 'none', canTalk: false });
        // a spectator leaves, a player drops into grace: still no room for a 9th
        gameManager.leaveSpectating(io, xs[0].id);
        io.sockets.sockets.delete(socks[3].id);
        await queueHandlers.handleDisconnect(socks[3], io);
        expect(game.seat(4).presence).toBe('grace');
        expect(spectate(game, user('w6'))).toBe(true);
        expect(spectate(game, user('w7'))).toBe(false);
    });

    test('a newer socket of the same user replaces the old entry (a reload)', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        const xName = nameOf(x);
        const again = makeSocket(`sv${seq}-x2`, log, io);
        gameManager.registerUser(again.id, xName);
        clientInfo.handle(again, io, { client: 'web', version: '1', caps: ['casualSpectators'] });
        const mark = log.length;
        gameManager.addSpectator(io, game, again.id, xName, 1);
        gameVoice.admitVoiceSpectator(io, game, again.id);
        expect([...game.voiceSpectators.keys()]).toEqual([again.id]);
        for (const s of socks) expect(to(s, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([x.id]);
    });

    test('a lobby member, a socket in a tournament or a game is never admitted (activityOf)', () => {
        const { game } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        gameManager.addSpectator(io, game, x.id, nameOf(x), 1);
        gameManager.playerLobbies.set(x.id, 'some-lobby');
        expect(gameVoice.admitVoiceSpectator(io, game, x.id)).toBe(false);
        gameManager.playerLobbies.delete(x.id);
    });

    test('loaded block lists leave a pair out of the peer list; a list not loaded yet never does', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x', { blocked: [nameOf(socks[1])] });
        const y = user('y', { blocked: null });
        spectate(game, x);
        expect(last(x, 'voicePeerList').peers.map((p) => p.socketId)).toEqual([socks[0].id, socks[2].id, socks[3].id]);
        expect(to(socks[1], 'voicePeerJoined').map((l) => l.data.socketId)).not.toContain(x.id);
        spectate(game, y);
        expect(last(y, 'voicePeerList').peers.map((p) => p.socketId)).toEqual([...socks.map((s) => s.id), x.id]);
    });
});

const SETTINGS_ON = { spectatorsCanTalk: true, canChange: false };

describe('spectators always may talk (owner 2026-11-18)', () => {
    test('an all-legacy table: a main-room spectator talks too; a lobby extra talks', () => {
        const { game } = casualGame(['a', 'b', 'c', 'd'], { capable: false });
        const x = user('x');
        spectate(game, x);
        expect(last(x, 'voiceSettings')).toMatchObject({ role: 'spectator', canTalk: true, ...SETTINGS_ON });
        expect(gameVoice.mayTalk(game, x.id)).toBe(true);
        const extra = user('e');
        spectate(game, extra, { fromLobby: true });
        expect(last(extra, 'voiceSettings')).toMatchObject({ role: 'spectator', canTalk: true, ...SETTINGS_ON });
    });

    test('nobody controls a switch: every player gets canChange false, the host included', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        gameVoice.refreshVoice(io, game);
        for (const s of socks) expect(last(s, 'voiceSettings')).toEqual({ gameId: game.gameId, host: nameOf(socks[0]), role: 'player', canTalk: true, ...SETTINGS_ON });
        expect(game.casualVoice.spectatorsCanTalk).toBe(true);
    });

    test('no SDP gate: a spectator\'s sendrecv / sendonly offers and answers are relayed', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        voice.voiceOffer(x, io, { targetSocketId: socks[0].id, offer: OFFER('sendrecv') });
        voice.voiceAnswer(x, io, { targetSocketId: socks[1].id, answer: ANSWER('sendonly') });
        voice.voiceOffer(x, io, { targetSocketId: socks[2].id, offer: OFFER('recvonly') });
        expect(relayed('voiceOffer').map((l) => l.to)).toEqual([socks[0].id, socks[2].id]);
        expect(relayed('voiceAnswer').map((l) => l.to)).toEqual([socks[1].id]);
    });

    test('spectators hear each other: the later one lists the earlier one', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        const y = user('y');
        spectate(game, x);
        spectate(game, y);
        expect(last(y, 'voicePeerList').peers.map((p) => p.socketId)).toEqual([...socks.map((s) => s.id), x.id]);
        expect(last(x, 'voicePeerJoined')).toEqual({ socketId: y.id, username: nameOf(y) });
    });

    // Review 2026-11-16: every way a seat owner leaves the voice room
    // re-sends voiceSettings; with no switch nothing in them changes and no
    // spectator call is ever torn down
    test('the only capable player /leaves a legacy table: a main-room spectator keeps canTalk true, its calls are never torn down', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd'], { capable: [true, false, false, false] });
        const x = user('x');
        spectate(game, x);
        voice.voiceOffer(x, io, { targetSocketId: socks[1].id, offer: OFFER('sendrecv') });
        const mark = log.length;
        // the only capable player /leaves a legacy table
        chatHandlers.chatMessage(socks[0], io, { message: '/leave' });
        expect(last(x, 'voiceSettings')).toMatchObject({ role: 'spectator', canTalk: true, ...SETTINGS_ON });
        voice.voiceOffer(x, io, { targetSocketId: socks[2].id, offer: OFFER('sendrecv') });
        expect(relayed('voiceOffer', mark).map((l) => l.to)).toEqual([socks[2].id]);
        await jest.advanceTimersByTimeAsync(20000);
        expect(to(x, 'voicePeerLeft', mark).map((l) => l.data.socketId).filter((id) => id !== socks[0].id)).toEqual([]);
        for (const s of socks.slice(1)) expect(to(s, 'voicePeerLeft', mark).map((l) => l.data.socketId)).not.toContain(x.id);
    });

    test('a lazy host demoted by a newer socket, or dropping: the others\' voiceSettings stay canChange false', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        chatHandlers.chatMessage(socks[0], io, { message: '/lazy' });
        const host = nameOf(socks[0]);
        const tab = makeSocket(`sv${seq}-tab`, log, io);
        gameManager.registerUser(tab.id, host);
        clientInfo.handle(tab, io, { client: 'web', version: '1', caps: ['casualSpectators'] });
        const mark = log.length;
        expect(seatLifecycle.watchSeat(io, game, 1, tab, host, { via: 'spectate' })).toBe(true);
        expect(to(socks[1], 'voiceSettings', mark).length).toBeGreaterThan(0);
        expect(last(socks[1], 'voiceSettings')).toMatchObject({ role: 'player', canTalk: true, ...SETTINGS_ON });
        io.sockets.sockets.delete(socks[2].id);
        await queueHandlers.handleDisconnect(socks[2], io);
        expect(last(socks[3], 'voiceSettings')).toMatchObject({ role: 'player', canTalk: true, ...SETTINGS_ON });
    });
});

describe('setSpectatorsCanTalk is accepted and ignored (shipped iOS 12-15, cached web tabs)', () => {
    test('in a game, from the host, another player or a spectator: the sender alone gets its unchanged voiceSettings, never an error', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        for (const [sender, role] of [[socks[0], 'player'], [socks[1], 'player'], [x, 'spectator']]) {
            const mark = log.length;
            voice.setSpectatorsCanTalk(sender, io, { spectatorsCanTalk: false });
            expect(to(sender, 'voiceSettings', mark).map((l) => l.data)).toEqual([
                { gameId: game.gameId, host: nameOf(socks[0]), role, canTalk: true, ...SETTINGS_ON },
            ]);
            expect(relayed('serverError', mark)).toEqual([]);
            // nobody else is told anything, no call is dropped, later either
            expect(log.slice(mark).filter((l) => l.to !== sender.id && l.to !== `self:${sender.id}`)).toEqual([]);
            await jest.advanceTimersByTimeAsync(10000);
            expect(relayed('voicePeerLeft', mark)).toEqual([]);
        }
        expect(game.casualVoice.spectatorsCanTalk).toBe(true);
        expect(gameVoice.mayTalk(game, x.id)).toBe(true);
    });

    test('5 toggles in 2 s change nothing; the wrapper limit (4 / 30 s) is unchanged', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const mark = log.length;
        for (const v of [false, true, false, true, false]) {
            voice.setSpectatorsCanTalk(socks[0], io, { spectatorsCanTalk: v });
            await jest.advanceTimersByTimeAsync(400);
        }
        expect(game.casualVoice.spectatorsCanTalk).toBe(true);
        expect(to(socks[0], 'voiceSettings', mark).map((l) => l.data.spectatorsCanTalk)).toEqual([true, true, true, true, true]);
        expect(rateLimiter.limits.setSpectatorsCanTalk).toEqual({ max: 4, windowMs: 30000 });
    });

    test('a tournament / non-casual table or the main room: nothing at all (no error toast)', () => {
        const t = casualGame(['ta', 'tb', 'tc', 'td'], { casual: false });
        const mark = log.length;
        voice.setSpectatorsCanTalk(t.socks[0], io, { spectatorsCanTalk: false });
        const loner = user('loner');
        mainRoomHandlers.joinMainRoom(loner, io);
        const mark2 = log.length;
        voice.setSpectatorsCanTalk(loner, io, { spectatorsCanTalk: true });
        expect(to(t.socks[0], 'serverError', mark)).toEqual([]);
        expect(to(t.socks[0], 'voiceSettings', mark)).toEqual([]);
        expect(log.slice(mark2)).toEqual([]);
    });
});

describe('leaving the voice room', () => {
    test('every leaveSpectating path tells the voice peers privately, never the room', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const peersOf = (sid, mark) => log.slice(mark).filter((l) => l.event === 'voicePeerLeft' && l.data.socketId === sid);

        // joinMainRoom
        const a = user('x1');
        spectate(game, a);
        let mark = log.length;
        mainRoomHandlers.joinMainRoom(a, io);
        expect(peersOf(a.id, mark).map((l) => l.to).sort()).toEqual(socks.map((s) => s.id).sort());

        // /leave from the spectator
        const b = user('x2');
        spectate(game, b);
        mark = log.length;
        chatHandlers.chatMessage(b, io, { message: '/leave' });
        expect(peersOf(b.id, mark)).toHaveLength(4);

        // a disconnect (GameManager.handleDisconnect: no io, the voice room's last one)
        const c = user('x3');
        spectate(game, c);
        mark = log.length;
        io.sockets.sockets.delete(c.id);
        await queueHandlers.handleDisconnect(c, io);
        expect(peersOf(c.id, mark)).toHaveLength(4);

        // io null directly (sessionIdentity supersede / seatLifecycle.goActive's defensive call)
        const d = user('x4');
        spectate(game, d);
        mark = log.length;
        gameManager.leaveSpectating(null, d.id);
        expect(peersOf(d.id, mark)).toHaveLength(4);
        expect(log.slice(mark).filter((l) => l.event === 'voicePeerLeft' && l.to === game.roomName)).toEqual([]);
        expect(game.voiceSpectators.size).toBe(0);
    });

    test('a voice spectator becoming the owner again (reconnectOwner): peers dropped both ways, then the owner list', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        const owner = nameOf(socks[1]);
        io.sockets.sockets.delete(socks[1].id);
        await queueHandlers.handleDisconnect(socks[1], io);
        // the owner's new tab spectated meanwhile (a voice spectator under its name)
        const back = makeSocket(`sv${seq}-back`, log, io);
        gameManager.registerUser(back.id, owner);
        voice.rememberBlockList(back, []);
        clientInfo.handle(back, io, { client: 'web', version: '1', caps: ['casualSpectators'] });
        gameManager.addSpectator(io, game, back.id, owner, 1);
        expect(gameVoice.admitVoiceSpectator(io, game, back.id)).toBe(true);
        const mark = log.length;
        seatLifecycle.reconnectOwner(io, game, 2, back, owner);
        expect(game.voiceSpectators.has(back.id)).toBe(false);
        const leftToBack = to(back, 'voicePeerLeft', mark).map((l) => l.data.socketId).sort();
        expect(leftToBack).toEqual([socks[0].id, socks[2].id, socks[3].id, x.id].sort());
        const list = to(back, 'voicePeerList', mark).pop().data.peers.map((p) => p.socketId);
        expect(list).toEqual([socks[0].id, socks[2].id, socks[3].id, x.id]);
        expect(to(x, 'voicePeerJoined', mark).map((l) => l.data.socketId)).toEqual([back.id]);
        expect(last(back, 'voiceSettings')).toMatchObject({ role: 'player' });
    });

    test('reclaimSeat (/active from a spectating socket of the owner): the owner peer list, voice spectators included', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        const owner = nameOf(socks[2]);
        const bot = new BotPlayer('🤖 Mary', 'mary');
        lazySeat(game, 3, bot, { presence: 'away' });
        gameManager.playerGames.delete(socks[2].id);
        const tab = makeSocket(`sv${seq}-tab`, log, io);
        gameManager.registerUser(tab.id, owner);
        voice.rememberBlockList(tab, []);
        clientInfo.handle(tab, io, { client: 'web', version: '1', caps: ['casualSpectators'] });
        gameManager.addSpectator(io, game, tab.id, owner, 1);
        const mark = log.length;
        chatHandlers.chatMessage(tab, io, { message: '/active' });
        expect(game.seat(3)).toMatchObject({ controller: 'human', ownerSocketId: tab.id });
        const list = to(tab, 'voicePeerList', mark).pop().data.peers.map((p) => p.socketId);
        expect(list).toEqual([socks[0].id, socks[1].id, socks[3].id, x.id]);
    });

    test('/leave from a human seat with a voice spectator present: a private voicePeerLeft to the other seats and the spectator, none to the room', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        const mark = log.length;
        chatHandlers.chatMessage(socks[1], io, { message: '/leave' });
        expect(game.seat(2).presence).toBe('gone');
        const left = log.slice(mark).filter((l) => l.event === 'voicePeerLeft');
        expect(left.map((l) => l.data.socketId)).toEqual(left.map(() => socks[1].id));
        expect(left.map((l) => l.to).sort()).toEqual([socks[0].id, socks[2].id, socks[3].id, x.id].sort());
        expect(gameVoice.gameVoiceMembers(game).map((m) => m.socketId)).not.toContain(socks[1].id);
        // voiceSettings again to the rest (playerLeftVoice -> refreshVoice)
        expect(to(x, 'voiceSettings', mark)).not.toHaveLength(0);
    });

    test('/leave from a lazy owner at its seat tells its voice peers; from a watching owner (no voice member) nothing', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        expect(seatLifecycle.goLazy(io, game, 2, { reason: 'afk' })).toBe(true);
        expect(game.seat(2)).toMatchObject({ controller: 'lazyBot', ownerView: 'seat' });
        let mark = log.length;
        chatHandlers.chatMessage(socks[1], io, { message: '/leave' });
        expect(log.slice(mark).filter((l) => l.event === 'voicePeerLeft' && l.data.socketId === socks[1].id).map((l) => l.to).sort())
            .toEqual([socks[0].id, socks[2].id, socks[3].id, x.id].sort());

        // seat 3's owner drops and rejoins watching (not in voice), then /leave
        const owner = nameOf(socks[2]);
        expect(seatLifecycle.goLazy(io, game, 3, { reason: 'afk' })).toBe(true);
        io.sockets.sockets.delete(socks[2].id);
        await queueHandlers.handleDisconnect(socks[2], io);
        const w = makeSocket(`sv${seq}-w`, log, io);
        gameManager.registerUser(w.id, owner);
        voice.rememberBlockList(w, []);
        clientInfo.handle(w, io, { client: 'ios', version: '1.2.2', build: '13', caps: ['avatarUrl', 'casualSpectators', 'playAgain'] });
        await reconnectHandlers.rejoinGame(w, io, { gameId: game.gameId, username: owner });
        expect(game.seat(3)).toMatchObject({ ownerSocketId: w.id, ownerView: 'watch' });
        mark = log.length;
        chatHandlers.chatMessage(w, io, { message: '/leave' });
        expect(game.seat(3).presence).toBe('gone');
        expect(log.slice(mark).filter((l) => l.event === 'voicePeerLeft')).toEqual([]);
    });

    test('a block ends a live call both ways (spectator and player)', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        const mark = log.length;
        await safety.blockUser(socks[0], io, { username: nameOf(x) });
        expect(to(socks[0], 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([x.id]);
        expect(to(x, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([socks[0].id]);
        voice.voiceOffer(x, io, { targetSocketId: socks[0].id, offer: OFFER('recvonly') });
        expect(relayed('voiceOffer', mark)).toEqual([]);
    });

    test('a block in a lobby ends the call too; a block of someone elsewhere sends nothing', async () => {
        const a = user('la');
        const b = user('lb');
        const c = user('lc');
        mainRoomHandlers.joinMainRoom(a, io);
        mainRoomHandlers.joinMainRoom(b, io);
        mainRoomHandlers.joinMainRoom(c, io);
        mainRoomHandlers.createLobby(a, io, {});
        mainRoomHandlers.joinLobby(b, io, { lobbyId: gameManager.getPlayerLobby(a.id).id });
        const mark = log.length;
        await safety.blockUser(a, io, { username: nameOf(b) });
        await safety.blockUser(a, io, { username: nameOf(c) });
        expect(to(a, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([b.id]);
        expect(to(b, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([a.id]);
        expect(to(c, 'voicePeerLeft', mark)).toEqual([]);
    });
});

/**
 * Play test 2026-11-19 (production log 03:35-03:45 UTC): a player's seat went
 * to the AFK bot (lazy at its seat: a voice member), his old socket dropped,
 * he signed in on iOS 1.2.2 (13) and rejoined (watchSeat via 'rejoin': a
 * watching owner is no voice member), typed /active and got his seat back,
 * but nobody was told: goActive from the watch view sent only voiceSettings,
 * so he heard nobody and nobody heard him until a later reconnect. Now
 * /active from the watch view is a returning owner's voice (announceOwnerVoice).
 */
describe('/active after a rejoin onto a lazy seat (iOS 1.2.2 (13))', () => {
    const B13 = { client: 'ios', version: '1.2.2', build: '13', caps: ['avatarUrl', 'casualSpectators', 'playAgain'] };

    /** The owner of seat 2 is idle (the AFK takeover), drops, and rejoins from build 13. */
    async function rejoinedWatcher() {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const owner = nameOf(socks[1]);
        expect(seatLifecycle.goLazy(io, game, 2, { reason: 'afk' })).toBe(true);
        expect(game.seat(2)).toMatchObject({ controller: 'lazyBot', ownerView: 'seat' });
        // still a voice member at its seat
        expect(gameVoice.gameVoiceMembers(game).map((m) => m.socketId)).toContain(socks[1].id);
        let mark = log.length;
        io.sockets.sockets.delete(socks[1].id);
        await queueHandlers.handleDisconnect(socks[1], io);
        expect(game.seat(2).presence).toBe('away');
        // its peers drop the dead call privately (never the room)
        expect(log.slice(mark).filter((l) => l.event === 'voicePeerLeft' && l.data.socketId === socks[1].id).map((l) => l.to).sort())
            .toEqual([socks[0].id, socks[2].id, socks[3].id].sort());
        const ios = makeSocket(`sv${seq}-ios`, log, io);
        gameManager.registerUser(ios.id, owner);
        voice.rememberBlockList(ios, []);
        clientInfo.handle(ios, io, B13);
        mark = log.length;
        await reconnectHandlers.rejoinGame(ios, io, { gameId: game.gameId, username: owner });
        expect(to(ios, 'rejoinSuccess', mark).pop().data.isLazy).toBe(true);
        expect(game.seat(2)).toMatchObject({ ownerSocketId: ios.id, ownerView: 'watch' });
        // a watching owner is not in voice: nobody lists it, it lists nobody
        expect(to(ios, 'voicePeerList', mark)).toEqual([]);
        expect(gameVoice.gameVoiceMembers(game).map((m) => m.socketId)).not.toContain(ios.id);
        return { game, socks, owner, ios, others: [socks[0], socks[2], socks[3]] };
    }

    test('/active from the watch view: the owner peer list (players and voice spectators), voicePeerJoined to each, voiceSettings role player', async () => {
        const { game, owner, ios, others } = await rejoinedWatcher();
        // a main-room spectator joined meanwhile (admitted to voice: the players minus the watcher)
        const x = user('x');
        expect(spectate(game, x)).toBe(true);
        expect(last(x, 'voicePeerList').peers.map((p) => p.socketId)).toEqual(others.map((s) => s.id));
        const mark = log.length;
        chatHandlers.chatMessage(ios, io, { message: '/active' });
        expect(game.seat(2)).toMatchObject({ controller: 'human', ownerSocketId: ios.id });
        expect(to(ios, 'restorePlayerState', mark)).toHaveLength(1);
        // build 13's voicePeerList handler connects to each listed peer (it offers)
        const lists = to(ios, 'voicePeerList', mark);
        expect(lists).toHaveLength(1);
        expect(lists[0].data.peers).toEqual([...others.map((s) => ({ socketId: s.id, username: nameOf(s) })), { socketId: x.id, username: nameOf(x) }]);
        for (const s of [...others, x]) {
            expect(to(s, 'voicePeerJoined', mark).map((l) => l.data)).toEqual([{ socketId: ios.id, username: owner }]);
        }
        // nothing to drop: it held no call as a watcher
        expect(to(ios, 'voicePeerLeft', mark)).toEqual([]);
        expect(last(ios, 'voiceSettings')).toMatchObject({ gameId: game.gameId, role: 'player', canTalk: true });
        expect(last(x, 'voiceSettings')).toMatchObject({ role: 'spectator' });
        // and the calls go through: its offer reaches a player, the answer comes back
        voice.voiceOffer(ios, io, { targetSocketId: others[0].id, offer: OFFER('sendrecv') });
        voice.voiceAnswer(others[0], io, { targetSocketId: ios.id, answer: ANSWER('sendrecv') });
        voice.voiceOffer(ios, io, { targetSocketId: x.id, offer: OFFER('sendrecv') });
        expect(relayed('voiceOffer', mark).map((l) => l.to)).toEqual([others[0].id, x.id]);
        expect(relayed('voiceAnswer', mark).map((l) => l.to)).toEqual([ios.id]);
        // a later spectator lists it as a player
        const y = user('y');
        spectate(game, y);
        expect(last(y, 'voicePeerList').peers.map((p) => p.socketId)).toContain(ios.id);
    });

    test('/active in a tournament-like game (no casual voice): the peer list still goes out, no voiceSettings', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd'], { casual: false });
        const owner = nameOf(socks[1]);
        seatLifecycle.goLazy(io, game, 2, { reason: 'afk' });
        io.sockets.sockets.delete(socks[1].id);
        await queueHandlers.handleDisconnect(socks[1], io);
        const back = makeSocket(`sv${seq}-back`, log, io);
        gameManager.registerUser(back.id, owner);
        voice.rememberBlockList(back, []);
        clientInfo.handle(back, io, B13);
        await reconnectHandlers.rejoinGame(back, io, { gameId: game.gameId, username: owner });
        const mark = log.length;
        chatHandlers.chatMessage(back, io, { message: '/active' });
        expect(to(back, 'voicePeerList', mark).pop().data.peers.map((p) => p.socketId)).toEqual([socks[0].id, socks[2].id, socks[3].id]);
        for (const s of [socks[0], socks[2], socks[3]]) expect(to(s, 'voicePeerJoined', mark)).toHaveLength(1);
        expect(relayed('voiceSettings', mark)).toEqual([]);
    });

    test('/active at the seat (lazy at its seat, still a voice member) announces nothing new', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        seatLifecycle.goLazy(io, game, 2, { reason: 'afk' });
        const mark = log.length;
        chatHandlers.chatMessage(socks[1], io, { message: '/active' });
        expect(game.seat(2).controller).toBe('human');
        expect(relayed('voicePeerList', mark)).toEqual([]);
        expect(relayed('voicePeerJoined', mark)).toEqual([]);
    });

    test('reclaimSeat from a build-13 voice spectator of the owner: spectator calls dropped both ways, then the owner list, each told, role player', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        const owner = nameOf(socks[2]);
        lazySeat(game, 3, new BotPlayer('🤖 Mary', 'mary'), { presence: 'away' });
        gameManager.playerGames.delete(socks[2].id);
        const tab = makeSocket(`sv${seq}-tab`, log, io);
        gameManager.registerUser(tab.id, owner);
        voice.rememberBlockList(tab, []);
        clientInfo.handle(tab, io, B13);
        gameManager.addSpectator(io, game, tab.id, owner, 1);
        // admitted: the owner's seat is away, so its name is in voice nowhere else
        expect(gameVoice.admitVoiceSpectator(io, game, tab.id)).toBe(true);
        const mark = log.length;
        chatHandlers.chatMessage(tab, io, { message: '/active' });
        expect(game.seat(3)).toMatchObject({ controller: 'human', ownerSocketId: tab.id });
        expect(game.voiceSpectators.has(tab.id)).toBe(false);
        const peers = [socks[0].id, socks[1].id, socks[3].id, x.id];
        expect(to(tab, 'voicePeerLeft', mark).map((l) => l.data.socketId).sort()).toEqual([...peers].sort());
        for (const sid of peers) expect(log.slice(mark).some((l) => l.to === sid && l.event === 'voicePeerLeft' && l.data.socketId === tab.id)).toBe(true);
        // the list comes after the drops
        const leftAt = log.findIndex((l, i) => i >= mark && l.event === 'voicePeerLeft');
        const listAt = log.findIndex((l, i) => i >= mark && l.event === 'voicePeerList' && (l.to === tab.id || l.to === `self:${tab.id}`));
        expect(listAt).toBeGreaterThan(leftAt);
        expect(log[listAt].data.peers.map((p) => p.socketId)).toEqual(peers);
        for (const sid of peers) expect(log.slice(mark).filter((l) => l.to === sid && l.event === 'voicePeerJoined').map((l) => l.data.socketId)).toEqual([tab.id]);
        expect(last(tab, 'voiceSettings')).toMatchObject({ role: 'player' });
    });
});

describe('through a real lobby start', () => {
    test('the host\'s old switch sent OFF in the lobby changes nothing; during DRAWING a main-room spectator lists the 4 entrants and may talk; an entrant leaving tells it', async () => {
        const socks = ['a', 'b', 'c', 'd'].map((t) => user(t));
        for (const s of socks) mainRoomHandlers.joinMainRoom(s, io);
        mainRoomHandlers.createLobby(socks[0], io, {});
        const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
        for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, io, { lobbyId });
        voice.setSpectatorsCanTalk(socks[0], io, { spectatorsCanTalk: false });
        const starting = socks.map((s) => lobbyHandlers.playerReady(s, io));
        await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS + pacing().PREDRAW_COUNTDOWN_MS + 10);
        const game = gameManager.getPlayerGame(socks[0].id);
        expect(game.stage).toBe(Phase.DRAWING);
        // the players were told they are players (capable); nobody may switch
        expect(last(socks[0], 'voiceSettings')).toMatchObject({ role: 'player', canTalk: true, ...SETTINGS_ON });
        const m = user('m');
        mainRoomHandlers.joinMainRoom(m, io);
        mainRoomHandlers.joinAsSpectator(m, io, { gameId: game.gameId });
        expect(last(m, 'voicePeerList').peers.map((p) => p.socketId).sort()).toEqual(socks.map((s) => s.id).sort());
        expect(last(m, 'voiceSettings')).toMatchObject({ role: 'spectator', canTalk: true, ...SETTINGS_ON });
        const mark = log.length;
        chatHandlers.chatMessage(socks[3], io, { message: '/leave' });
        expect(to(m, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([socks[3].id]);
        const draws = socks.slice(0, 3).map((s) => require('../gameHandlers').draw(s, io, { num: 0 }));
        await jest.advanceTimersByTimeAsync(20000);
        await Promise.all([...starting, ...draws]);
    });
});
