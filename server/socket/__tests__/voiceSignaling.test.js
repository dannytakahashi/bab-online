/**
 * Voice signaling authorization (roadmap 30, security part): offers,
 * answers, ICE candidates and the web PCM relay reach only a connected peer
 * of the sender's lobby or game, never a room, a stranger, a blocked user or
 * a socket in another game, and each event is rate limited per socket
 * (dropped silently over the limit). Allowed peers relay exactly as before.
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
const voice = require('../voiceHandlers');
const safety = require('../safetyHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const { rateLimiter } = require('../errorHandler');
const { makeIo, makeSocket } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, logger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
const OFFER = { type: 'offer', sdp: 'v=0' };
const ANSWER = { type: 'answer', sdp: 'v=0' };
const CAND = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host', sdpMLineIndex: 0, sdpMid: '0' };

let seq = 0;
let log;
let io;

beforeEach(() => {
    seq++;
    log = [];
    io = makeIo(log);
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, logger]) for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    gameManager.playerLobbies.clear();
    jest.restoreAllMocks();
});

/** A signed-in socket (registered, in io.sockets, with an empty block list). */
function user(tag) {
    const id = `v${seq}-${tag}`;
    const s = makeSocket(id, log, io);
    gameManager.registerUser(id, `${tag}${seq}`);
    voice.rememberBlockList(s, []);
    mockDb.current.users._insert({ username: `${tag}${seq}`, blockedUsers: [] });
    return s;
}

/** A 4-human game in PLAYING; returns the seat sockets. */
function gameOf(tags) {
    const socks = tags.map(user);
    const game = gameManager.createGame(socks.map((s) => s.id));
    socks.forEach((s, i) => game.addPlayer(s.id, gameManager.getUserBySocketId(s.id).username, i + 1, 1, false));
    socks.forEach((s) => s.join(game.roomName));
    game.currentHand = 1;
    socks.forEach((s, i) => game.setHand(s.id, [C(String(i + 2), 'hearts')]));
    game.trump = C('A', 'spades');
    game.forcePhase('PLAYING');
    return { game, socks };
}

/** Two signed-in sockets in one lobby (the real createLobby / joinLobby). */
function lobbyPair() {
    const a = user('la');
    const b = user('lb');
    mainRoomHandlers.joinMainRoom(a, io);
    mainRoomHandlers.joinMainRoom(b, io);
    mainRoomHandlers.createLobby(a, io, {});
    const lobbyId = gameManager.getPlayerLobby(a.id).id;
    mainRoomHandlers.joinLobby(b, io, { lobbyId });
    expect(gameManager.playerLobbies.get(b.id)).toBe(lobbyId);
    return [a, b];
}

// One relay chunk as the server receives it: the web client's Int16 ArrayBuffer arrives as a Buffer
const PCM = Buffer.alloc(1364);
const relayed = (event) => log.filter((l) => l.event === event);

function sendAll(from, targetSocketId) {
    voice.voiceOffer(from, io, { targetSocketId, offer: OFFER });
    voice.voiceAnswer(from, io, { targetSocketId, answer: ANSWER });
    voice.voiceIceCandidate(from, io, { targetSocketId, candidate: CAND });
    voice.voiceRelayAudio(from, io, { targetSocketId, audio: PCM });
}
const VOICE_EVENTS = ['voiceOffer', 'voiceAnswer', 'voiceIceCandidate', 'voiceRelayAudio'];

describe('allowed peers relay exactly as before', () => {
    test('same lobby: all four events reach the target with the sender id (and the server-side name on offers)', () => {
        const [a, b] = lobbyPair();
        sendAll(a, b.id);
        for (const ev of VOICE_EVENTS) {
            const out = relayed(ev);
            expect(out).toHaveLength(1);
            expect(out[0].to).toBe(b.id);
            expect(out[0].data.fromSocketId).toBe(a.id);
        }
        expect(relayed('voiceOffer')[0].data).toEqual({ fromSocketId: a.id, offer: OFFER, username: gameManager.getUserBySocketId(a.id).username });
        expect(relayed('voiceRelayAudio')[0].data).toEqual({ fromSocketId: a.id, audio: PCM });
    });

    test('same game: seat owners, both ways', () => {
        const { socks: [a, b, c] } = gameOf(['ga', 'gb', 'gc', 'gd']);
        sendAll(a, b.id);
        sendAll(c, a.id);
        for (const ev of VOICE_EVENTS) expect(relayed(ev).map((l) => l.to)).toEqual([b.id, a.id]);
    });

    test('a lazy owner watching its seat is still a game peer', () => {
        const { game, socks: [a, b] } = gameOf(['za', 'zb', 'zc', 'zd']);
        require('../chatHandlers').chatMessage(a, io, { message: '/lazy' });
        expect(game.seat(1).controller).toBe('lazyBot');
        voice.voiceIceCandidate(b, io, { targetSocketId: a.id, candidate: CAND });
        expect(relayed('voiceIceCandidate')).toHaveLength(1);
    });
});

describe('refused (dropped silently: no relay, no error)', () => {
    afterEach(() => {
        expect(log.filter((l) => l.event === 'error')).toHaveLength(0);
    });

    test.each(['mainRoom', 'game:anything', 'tournament:x'])('a room name as target (%s)', (room) => {
        const [a] = lobbyPair();
        sendAll(a, room);
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);
    });

    test("a game's room by its real name", () => {
        const { game, socks: [a] } = gameOf(['ra', 'rb', 'rc', 'rd']);
        sendAll(a, game.roomName);
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);
    });

    test('a stranger (signed in, connected, sharing no lobby or game)', () => {
        const [a] = lobbyPair();
        const stranger = user('st');
        mainRoomHandlers.joinMainRoom(stranger, io);
        sendAll(a, stranger.id);
        sendAll(stranger, a.id);
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);
    });

    test('a socket in another game', () => {
        const { socks: [a] } = gameOf(['xa', 'xb', 'xc', 'xd']);
        const { socks: [other] } = gameOf(['ya', 'yb', 'yc', 'yd']);
        sendAll(a, other.id);
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);
    });

    test('a pure spectator of the same game (neither client runs voice for one)', () => {
        const { game, socks: [a] } = gameOf(['pa', 'pb', 'pc', 'pd']);
        const watcher = user('pw');
        gameManager.addSpectator(io, game, watcher.id, gameManager.getUserBySocketId(watcher.id).username);
        sendAll(a, watcher.id);
        sendAll(watcher, a.id);
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);
    });

    test('an unknown or disconnected socket id, the sender itself, a bad target', () => {
        const [a, b] = lobbyPair();
        io.sockets.sockets.delete(b.id); // b's connection is gone
        sendAll(a, b.id);
        sendAll(a, 'no-such-socket');
        sendAll(a, a.id);
        voice.voiceOffer(a, io, { targetSocketId: { $ne: 1 }, offer: OFFER });
        voice.voiceOffer(a, io, {});
        voice.voiceOffer(a, io, null);
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);
    });

    test('a sender that is not signed in (in io, registered nowhere)', () => {
        const [, b] = lobbyPair();
        const anon = makeSocket(`v${seq}-anon`, log, io);
        sendAll(anon, b.id);
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);
    });

    test('a blocked peer, in either direction, from the moment of the block (blockUser), and again after unblock', async () => {
        const [a, b] = lobbyPair();
        const bName = gameManager.getUserBySocketId(b.id).username;
        await safety.blockUser(a, io, { username: bName });
        expect(a.data.blockedUsers.has(bName)).toBe(true);
        sendAll(a, b.id); // blocker -> blocked
        sendAll(b, a.id); // blocked -> blocker
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);

        await safety.unblockUser(a, io, { username: bName });
        sendAll(b, a.id);
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(1);
    });

    test('a relay chunk over 64 KB', () => {
        const [a, b] = lobbyPair();
        voice.voiceRelayAudio(a, io, { targetSocketId: b.id, audio: new ArrayBuffer(voice.MAX_RELAY_BYTES + 1) });
        expect(relayed('voiceRelayAudio')).toHaveLength(0);
        voice.voiceRelayAudio(a, io, { targetSocketId: b.id, audio: new ArrayBuffer(1364) }); // 4096 frames at 48 kHz -> 8 kHz Int16
        expect(relayed('voiceRelayAudio')).toHaveLength(1);
    });

    test.each([
        ['a numeric string (new Int16Array("400000000") allocates 400M samples)', '400000000'],
        ['a short string', 'AAAA'],
        ['an array-like object (read by its .length)', { length: 4e8 }],
        ['a plain object with a fake byteLength', { byteLength: 8, length: 4e8 }],
        ['an array', [1, 2, 3, 4]],
        ['a number', 400000000],
        ['an empty Buffer', Buffer.alloc(0)],
        ['an odd byte count (not whole Int16 samples)', Buffer.alloc(1365)],
        ['a Buffer over 64 KB', Buffer.alloc(voice.MAX_RELAY_BYTES + 2)],
    ])('relay audio that is not a binary PCM chunk: %s', (_label, audio) => {
        const [a, b] = lobbyPair();
        voice.voiceRelayAudio(a, io, { targetSocketId: b.id, audio });
        expect(relayed('voiceRelayAudio')).toHaveLength(0);
        expect(log.filter((l) => l.event === 'error')).toHaveLength(0);
        voice.voiceRelayAudio(a, io, { targetSocketId: b.id, audio: Buffer.alloc(voice.MAX_RELAY_BYTES) });
        expect(relayed('voiceRelayAudio')).toHaveLength(1);
    });
});

describe('rate limits (per socket, dropped silently)', () => {
    test.each([
        ['voiceOffer', (a, t) => voice.voiceOffer(a, io, { targetSocketId: t, offer: OFFER })],
        ['voiceAnswer', (a, t) => voice.voiceAnswer(a, io, { targetSocketId: t, answer: ANSWER })],
        ['voiceIceCandidate', (a, t) => voice.voiceIceCandidate(a, io, { targetSocketId: t, candidate: CAND })],
        ['voiceRelayAudio', (a, t) => voice.voiceRelayAudio(a, io, { targetSocketId: t, audio: PCM })],
    ])('%s: the limit passes, one more is dropped, a new window passes again', (event, send) => {
        jest.useFakeTimers();
        try {
            const [a, b] = lobbyPair();
            const { max, windowMs } = rateLimiter.limits[event];
            for (let i = 0; i < max + 5; i++) send(a, b.id);
            expect(relayed(event)).toHaveLength(max);
            expect(log.filter((l) => l.event === 'error')).toHaveLength(0);
            jest.advanceTimersByTime(windowMs + 1);
            send(a, b.id);
            expect(relayed(event)).toHaveLength(max + 1);
            rateLimiter.clearSocket(a.id);
        } finally {
            jest.useRealTimers();
        }
    });

    test('generous for a real call: ICE bursts to 3 peers and 48-96 kHz relay to 3 peers fit', () => {
        const L = rateLimiter.limits;
        // A trickle-ICE burst: up to ~30 candidates per peer (host/srflx per interface, IPv4+IPv6, iOS cellular)
        expect(L.voiceIceCandidate.max).toBeGreaterThanOrEqual(3 * 30 * 3);
        // Relay: one 4096-frame chunk per relayed peer per buffer, 96 kHz worst case
        expect(L.voiceRelayAudio.max / (L.voiceRelayAudio.windowMs / 1000)).toBeGreaterThanOrEqual(3 * 96000 / 4096);
        expect(L.voiceOffer.max).toBeGreaterThanOrEqual(3 * 3);
    });
});

describe('block lists on every path that signs a socket in (fail closed)', () => {
    const reconnect = require('../reconnectHandlers');
    const queue = require('../queueHandlers');
    const nameOf = (s) => gameManager.getUserBySocketId(s.id).username;
    const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

    /**
     * Seat 1 of a 4-human game drops and comes back on a fresh socket by
     * rejoinGame alone (session token, no signIn / restoreSession: a web
     * reload). Seat 1's stored block list names seat 2.
     */
    async function rejoinedOnly() {
        const { game, socks } = gameOf(['ja', 'jb', 'jc', 'jd']);
        const doc = mockDb.current.users.docs.find((d) => d.username === nameOf(socks[0]));
        doc.blockedUsers = [nameOf(socks[1])];
        doc.sessionToken = 'tok';
        const name = nameOf(socks[0]);
        await queue.handleDisconnect(socks[0], io);
        expect(game.seat(1).presence).toBe('grace');
        const fresh = makeSocket(`v${seq}-ja-again`, log, io);
        expect(fresh.data.blockedUsers).toBeUndefined();
        await reconnect.rejoinGame(fresh, io, { gameId: game.gameId, username: name, sessionToken: 'tok' });
        expect(game.seat(1).ownerSocketId).toBe(fresh.id);
        expect(gameManager.getUserBySocketId(fresh.id).username).toBe(name);
        return { game, fresh, socks };
    }

    test('rejoinGame by token loads the stored list: the blocked peer is refused both ways, others pass', async () => {
        const { fresh, socks: [, blocked, other] } = await rejoinedOnly();
        expect(fresh.data.blockedUsers).toEqual(new Set([nameOf(blocked)]));
        sendAll(fresh, blocked.id); // sender's own list
        sendAll(blocked, fresh.id); // target's list (blocked has not blocked anyone)
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);
        sendAll(fresh, other.id);
        sendAll(other, fresh.id);
        for (const ev of VOICE_EVENTS) expect(relayed(ev).map((l) => l.to)).toEqual([other.id, fresh.id]);
    });

    test('a signed-in socket with no list loaded is refused both ways (fail closed), then passes once it is loaded', async () => {
        const [a, b] = lobbyPair();
        delete b.data.blockedUsers; // a path that skipped rememberBlockList
        sendAll(a, b.id);
        sendAll(b, a.id);
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);
        await flush();
        expect(b.data.blockedUsers).toEqual(new Set());
        sendAll(a, b.id);
        sendAll(b, a.id);
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(2);
    });

    test('the late load honours the stored list (target blocked the sender)', async () => {
        const [a, b] = lobbyPair();
        mockDb.current.users.docs.find((d) => d.username === nameOf(b)).blockedUsers = [nameOf(a)];
        delete b.data.blockedUsers;
        sendAll(a, b.id);
        await flush();
        expect(b.data.blockedUsers).toEqual(new Set([nameOf(a)]));
        sendAll(a, b.id);
        sendAll(b, a.id);
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);
    });
});

describe('V1_REMOVALS #18: every relay payload passes its Joi schema, else it is dropped silently', () => {
    afterEach(() => {
        expect(log.filter((l) => l.event === 'error')).toHaveLength(0);
    });

    test('the shapes the clients send today are forwarded', () => {
        const [a, b] = lobbyPair();
        // iOS 1.1.0 (VoiceEmitter): username "" when it has none, sdpMid "" for nil
        voice.voiceOffer(a, io, { targetSocketId: b.id, offer: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1' }, username: '' });
        voice.voiceIceCandidate(a, io, { targetSocketId: b.id, candidate: { candidate: CAND.candidate, sdpMLineIndex: 0, sdpMid: '' } });
        // web: RTCSessionDescription / RTCIceCandidate toJSON (nulls, usernameFragment)
        voice.voiceAnswer(b, io, { targetSocketId: a.id, answer: { type: 'answer', sdp: 'v=0' } });
        voice.voiceIceCandidate(b, io, { targetSocketId: a.id, candidate: { ...CAND, usernameFragment: 'abcd' } });
        voice.voiceIceCandidate(b, io, { targetSocketId: a.id, candidate: { candidate: '', sdpMLineIndex: null, sdpMid: null, usernameFragment: null } });
        voice.voiceOffer(b, io, { targetSocketId: a.id, offer: { type: 'offer', sdp: 'v=0' }, username: null });
        expect(relayed('voiceOffer')).toHaveLength(2);
        expect(relayed('voiceAnswer')).toHaveLength(1);
        expect(relayed('voiceIceCandidate')).toHaveLength(3);
        expect(relayed('voiceIceCandidate')[1].data.candidate).toEqual({ ...CAND, usernameFragment: 'abcd' });
    });

    test.each([
        ['voiceOffer', { offer: { type: 'bogus', sdp: 'v=0' } }],
        ['voiceOffer', { offer: { type: 'offer' } }],
        ['voiceOffer', { offer: { type: 'offer', sdp: 'x'.repeat(64 * 1024 + 1) } }],
        ['voiceOffer', { offer: OFFER, username: 'u'.repeat(101) }],
        ['voiceAnswer', { answer: { type: 'answer', sdp: 7 } }],
        ['voiceAnswer', { answer: 'v=0' }],
        ['voiceIceCandidate', { candidate: { sdpMLineIndex: 0 } }],
        ['voiceIceCandidate', { candidate: { candidate: 'c', sdpMLineIndex: -1 } }],
        ['voiceIceCandidate', { candidate: { candidate: 'x'.repeat(4097) } }],
    ])('%s %j', (event, extra) => {
        const [a, b] = lobbyPair();
        voice[event](a, io, { targetSocketId: b.id, ...extra });
        expect(relayed(event)).toHaveLength(0);
    });

    test('an over-long target id is dropped', () => {
        const [a] = lobbyPair();
        sendAll(a, 'x'.repeat(65));
        for (const ev of VOICE_EVENTS) expect(relayed(ev)).toHaveLength(0);
    });
});
