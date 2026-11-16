/**
 * Spectator voice in casual games (family lobbies, owner 2026-11-16;
 * server/voice/gameVoice.js): who is admitted to a game's voice room, who
 * may signal whom, the "Spectators can talk" switch (coalesced, SDP gate,
 * backstop), and every way a voice spectator leaves it. Signaling between
 * players is unchanged (voiceSignaling.test.js).
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
function casualGame(tags, { capable = true, on = true, casual = true } = {}) {
    const socks = tags.map((t, i) => user(t, { capable: Array.isArray(capable) ? capable[i] : capable }));
    const game = gameManager.createGame(socks.map((s) => s.id));
    socks.forEach((s, i) => game.addPlayer(s.id, nameOf(s), i + 1, 1, false));
    socks.forEach((s) => s.join(game.roomName));
    game.currentHand = 1;
    socks.forEach((s, i) => game.setHand(s.id, [C(String(i + 2), 'hearts')]));
    game.trump = C('A', 'spades');
    game.forcePhase('PLAYING');
    if (casual) gameVoice.initCasualVoice(game, { host: nameOf(socks[0]), spectatorsCanTalk: on, io });
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

describe('who may talk', () => {
    test('an all-legacy table: a main-room spectator listens only (nobody could switch it off); a lobby extra still talks', () => {
        const { game } = casualGame(['a', 'b', 'c', 'd'], { capable: false });
        const x = user('x');
        spectate(game, x);
        expect(last(x, 'voiceSettings')).toMatchObject({ role: 'spectator', canTalk: false });
        expect(gameVoice.mayTalk(game, x.id, io)).toBe(false);
        const extra = user('e');
        spectate(game, extra, { fromLobby: true });
        expect(last(extra, 'voiceSettings')).toMatchObject({ canTalk: true });
    });

    test('the host controls the switch while seated, connected and capable; otherwise any capable player', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        expect(gameVoice.canChange(game, socks[0].id, io)).toBe(true);
        expect(gameVoice.canChange(game, socks[1].id, io)).toBe(false);
        io.sockets.sockets.delete(socks[0].id);
        await queueHandlers.handleDisconnect(socks[0], io);
        expect(gameVoice.canChange(game, socks[1].id, io)).toBe(true);
        // the others hear about it (voiceSettings on the host dropping)
        expect(last(socks[2], 'voiceSettings')).toMatchObject({ role: 'player', canChange: true });
    });

    // Review 2026-11-16: every way a seat owner leaves the voice room
    // recomputes and announces who controls the switch and who may talk
    test('the host /leaves: another capable player gets canChange true', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        chatHandlers.chatMessage(socks[0], io, { message: '/leave' });
        expect(game.seat(1).presence).toBe('gone');
        expect(gameVoice.canChange(game, socks[1].id, io)).toBe(true);
        expect(last(socks[1], 'voiceSettings')).toMatchObject({ role: 'player', canChange: true });
        // with the host gone any connected capable player controls it (Q3)
        expect(last(socks[2], 'voiceSettings')).toMatchObject({ role: 'player', canChange: true });
    });

    test('a lazy host (at its seat) disconnecting: another capable player gets canChange true', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        chatHandlers.chatMessage(socks[0], io, { message: '/lazy' });
        expect(game.seat(1).ownerView).toBe('seat');
        expect(gameVoice.canChange(game, socks[1].id, io)).toBe(false);
        io.sockets.sockets.delete(socks[0].id);
        await queueHandlers.handleDisconnect(socks[0], io);
        expect(gameVoice.canChange(game, socks[1].id, io)).toBe(true);
        expect(last(socks[1], 'voiceSettings')).toMatchObject({ role: 'player', canChange: true });
    });

    test('a lazy host demoted by a newer socket that watches the seat: another capable player gets canChange true', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        chatHandlers.chatMessage(socks[0], io, { message: '/lazy' });
        const host = nameOf(socks[0]);
        const tab = makeSocket(`sv${seq}-tab`, log, io);
        gameManager.registerUser(tab.id, host);
        clientInfo.handle(tab, io, { client: 'web', version: '1', caps: ['casualSpectators'] });
        expect(seatLifecycle.watchSeat(io, game, 1, tab, host, { via: 'spectate' })).toBe(true);
        expect(game.seat(1)).toMatchObject({ ownerSocketId: tab.id, ownerView: 'watch' });
        expect(last(socks[1], 'voiceSettings')).toMatchObject({ role: 'player', canChange: true });
    });

    test('the last capable player /leaves a legacy table: a main-room spectator loses canTalk and the backstop tears its calls down', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd'], { capable: [true, false, false, false] });
        const x = user('x');
        spectate(game, x);
        expect(last(x, 'voiceSettings')).toMatchObject({ role: 'spectator', canTalk: true });
        voice.voiceOffer(x, io, { targetSocketId: socks[1].id, offer: OFFER('sendrecv') });
        expect(relayed('voiceOffer').map((l) => l.to)).toEqual([socks[1].id]);
        chatHandlers.chatMessage(socks[0], io, { message: '/leave' });
        expect(last(x, 'voiceSettings')).toMatchObject({ role: 'spectator', canTalk: false, canChange: false });
        expect(game.voiceSpectators.get(x.id).gateSince).not.toBeNull();
        // a new sendrecv offer is refused now
        const before = relayed('voiceOffer').length;
        voice.voiceOffer(x, io, { targetSocketId: socks[2].id, offer: OFFER('sendrecv') });
        expect(relayed('voiceOffer')).toHaveLength(before);
        const mark = log.length;
        await jest.advanceTimersByTimeAsync(gameVoice.BACKSTOP_MS + 100);
        expect(to(x, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([socks[1].id, socks[2].id, socks[3].id]);
        for (const s of socks.slice(1)) expect(to(s, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([x.id]);
    });
});

describe('the SDP gate', () => {
    test('a spectator who may not talk relays listen-only SDP only; one who may relays anything; players are never gated', () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd'], { on: false });
        const x = user('x');
        spectate(game, x);
        expect(last(x, 'voiceSettings').canTalk).toBe(false);
        voice.voiceOffer(x, io, { targetSocketId: socks[0].id, offer: OFFER('sendrecv') });
        voice.voiceAnswer(x, io, { targetSocketId: socks[0].id, answer: ANSWER('sendonly') });
        expect(relayed('voiceOffer')).toEqual([]);
        expect(relayed('voiceAnswer')).toEqual([]);
        voice.voiceOffer(x, io, { targetSocketId: socks[0].id, offer: OFFER('recvonly') });
        voice.voiceAnswer(x, io, { targetSocketId: socks[1].id, answer: ANSWER('inactive') });
        expect(relayed('voiceOffer')).toHaveLength(1);
        expect(relayed('voiceAnswer')).toHaveLength(1);
        voice.voiceOffer(socks[0], io, { targetSocketId: x.id, offer: OFFER('sendrecv') });
        expect(relayed('voiceOffer')).toHaveLength(2);
        game.casualVoice.spectatorsCanTalk = true;
        voice.voiceOffer(x, io, { targetSocketId: socks[2].id, offer: OFFER('sendrecv') });
        expect(relayed('voiceOffer')).toHaveLength(3);
        expect(gameVoice._gateDrops()).toBeGreaterThanOrEqual(2);
    });
});

describe('the switch in a game', () => {
    test('coalesced: 5 toggles in 2 s apply one change; the re-offers that follow are within the limits', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        const mark = log.length;
        for (const v of [false, true, false, true, false]) {
            voice.setSpectatorsCanTalk(socks[0], io, { spectatorsCanTalk: v });
            await jest.advanceTimersByTimeAsync(400);
        }
        await jest.advanceTimersByTimeAsync(3000);
        expect(game.casualVoice.spectatorsCanTalk).toBe(false);
        const toX = to(x, 'voiceSettings', mark).map((l) => l.data.spectatorsCanTalk);
        expect(toX).toEqual([false]);
        // the spectator re-offers every call listen-only: all relayed
        for (const s of socks) voice.voiceOffer(x, io, { targetSocketId: s.id, offer: OFFER('recvonly') });
        expect(relayed('voiceOffer', mark)).toHaveLength(4);
        // nothing torn down by the backstop: every pair re-offered listen-only
        await jest.advanceTimersByTimeAsync(gameVoice.BACKSTOP_MS + 100);
        expect(relayed('voicePeerLeft', mark)).toEqual([]);
    });

    test('a non-controller is refused; a tournament table refuses it too', () => {
        const { socks } = casualGame(['a', 'b', 'c', 'd']);
        voice.setSpectatorsCanTalk(socks[1], io, { spectatorsCanTalk: false });
        expect(to(socks[1], 'serverError').map((l) => l.data.message)).toEqual(['Only the host can change this']);
        const t = casualGame(['ta', 'tb', 'tc', 'td'], { casual: false });
        voice.setSpectatorsCanTalk(t.socks[0], io, { spectatorsCanTalk: false });
        expect(to(t.socks[0], 'serverError').map((l) => l.data.message)).toEqual(['Spectator talk can only be set in a lobby or a casual game']);
    });

    test('the backstop: 8 s after OFF, a spectator that kept a sendrecv call is torn down both ways and announced again', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        spectate(game, x);
        voice.setSpectatorsCanTalk(socks[0], io, { spectatorsCanTalk: false });
        // x re-offers to seat 1 only
        voice.voiceOffer(x, io, { targetSocketId: socks[0].id, offer: OFFER('recvonly') });
        const mark = log.length;
        await jest.advanceTimersByTimeAsync(gameVoice.BACKSTOP_MS + 100);
        const left = relayed('voicePeerLeft', mark);
        expect(left.filter((l) => l.to === x.id).map((l) => l.data.socketId)).toEqual([socks[1].id, socks[2].id, socks[3].id]);
        for (const s of socks.slice(1)) {
            expect(to(s, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([x.id]);
            expect(to(s, 'voicePeerJoined', mark).map((l) => l.data.socketId)).toEqual([x.id]);
        }
        expect(to(socks[0], 'voicePeerLeft', mark)).toEqual([]);
        expect(to(x, 'voicePeerList', mark).map((l) => l.data.peers[0].socketId)).toEqual([socks[1].id, socks[2].id, socks[3].id]);
    });

    test('spectator pairs: OFF drops them both ways; ON announces the later one the earlier ones', async () => {
        const { game, socks } = casualGame(['a', 'b', 'c', 'd']);
        const x = user('x');
        const y = user('y');
        spectate(game, x);
        spectate(game, y);
        expect(last(y, 'voicePeerList').peers.map((p) => p.socketId)).toContain(x.id);
        let mark = log.length;
        voice.setSpectatorsCanTalk(socks[0], io, { spectatorsCanTalk: false });
        expect(to(x, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([y.id]);
        expect(to(y, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([x.id]);
        await jest.advanceTimersByTimeAsync(gameVoice.COALESCE_MS + 10);
        mark = log.length;
        voice.setSpectatorsCanTalk(socks[0], io, { spectatorsCanTalk: true });
        expect(to(y, 'voicePeerList', mark).pop().data.peers.map((p) => p.socketId)).toEqual([x.id]);
        expect(to(x, 'voicePeerJoined', mark).map((l) => l.data.socketId)).toEqual([y.id]);
        expect(last(x, 'voiceSettings')).toMatchObject({ spectatorsCanTalk: true, canTalk: true });
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

describe('through a real lobby start', () => {
    test('switch OFF, during DRAWING: a main-room spectator lists the 4 entrants and listens only; an entrant leaving tells it', async () => {
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
        // the players were told they are players (capable), host may switch
        expect(last(socks[0], 'voiceSettings')).toMatchObject({ role: 'player', canChange: true, spectatorsCanTalk: false });
        const m = user('m');
        mainRoomHandlers.joinMainRoom(m, io);
        mainRoomHandlers.joinAsSpectator(m, io, { gameId: game.gameId });
        expect(last(m, 'voicePeerList').peers.map((p) => p.socketId).sort()).toEqual(socks.map((s) => s.id).sort());
        expect(last(m, 'voiceSettings')).toMatchObject({ role: 'spectator', canTalk: false, spectatorsCanTalk: false });
        const mark = log.length;
        chatHandlers.chatMessage(socks[3], io, { message: '/leave' });
        expect(to(m, 'voicePeerLeft', mark).map((l) => l.data.socketId)).toEqual([socks[3].id]);
        const draws = socks.slice(0, 3).map((s) => require('../gameHandlers').draw(s, io, { num: 0 }));
        await jest.advanceTimersByTimeAsync(20000);
        await Promise.all([...starting, ...draws]);
    });
});
