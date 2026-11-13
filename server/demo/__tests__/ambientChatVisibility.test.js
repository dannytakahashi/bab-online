/**
 * Ambient bot main-room chatter is seen only by the AMBIENT_CHAT_USERS
 * accounts (owner, 2026-11-12: "only show the bot chats when the test1 user
 * logs in"): default test1, `*` everyone, `none` nobody. Everyone else's main
 * room is humans only, live and in the mainRoomJoined replay, and keeps its
 * full 50-line human history however much the bots post.
 */

const { ambientChatAudience, seesAmbientChat } = require('../../utils/ambientChatUsers');
// Required once, before any resetModules, so its emits reach the same
// contractCheck instance the contract guard (setupFilesAfterEnv) reads
const driver = require('../../testUtils/gameDriver');

let ambient;
let gameManager;
let mainRoomHandlers;
let lobbyHandlers;
let log;
let io;
const savedEnv = process.env.AMBIENT_CHAT_USERS;

beforeEach(() => {
    jest.resetModules();
    ambient = require('../ambientBots');
    gameManager = require('../../game/GameManager');
    mainRoomHandlers = require('../../socket/mainRoomHandlers');
    lobbyHandlers = require('../../socket/lobbyHandlers');
    log = [];
    io = driver.makeIo(log);
    delete process.env.AMBIENT_CHAT_USERS;
    const { socketLogger, logger } = require('../../utils/logger');
    for (const l of [socketLogger, logger]) for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
});

afterEach(() => {
    ambient.stopAmbientActivity();
    if (savedEnv === undefined) delete process.env.AMBIENT_CHAT_USERS;
    else process.env.AMBIENT_CHAT_USERS = savedEnv;
    jest.restoreAllMocks();
});

/** A signed-in socket in the main room. */
function enter(id, username) {
    const socket = driver.makeSocket(id, log, io);
    gameManager.registerUser(id, username);
    mainRoomHandlers.joinMainRoom(socket, io);
    return socket;
}

const isBot = (m) => m.username.startsWith('🤖');
const lastJoined = (id) => log.filter((l) => l.event === 'mainRoomJoined' && l.to === `self:${id}`).pop().data;
const botLinesTo = (to) => log.filter((l) => l.event === 'mainRoomMessage' && l.to === to && isBot(l.data));

describe('AMBIENT_CHAT_USERS parsing', () => {
    test('unset or blank: test1 only, ignoring case', () => {
        for (const env of [{}, { AMBIENT_CHAT_USERS: '' }, { AMBIENT_CHAT_USERS: '  ' }]) {
            expect(ambientChatAudience(env)).toEqual({ all: false, names: new Set(['test1']) });
            expect(seesAmbientChat('test1', env)).toBe(true);
            expect(seesAmbientChat('TEST1', env)).toBe(true);
            expect(seesAmbientChat('alice', env)).toBe(false);
            expect(seesAmbientChat(undefined, env)).toBe(false);
        }
    });

    test('a comma list, trimmed, case-insensitive', () => {
        const env = { AMBIENT_CHAT_USERS: ' Reviewer , alice,,' };
        expect(ambientChatAudience(env)).toEqual({ all: false, names: new Set(['reviewer', 'alice']) });
        expect(seesAmbientChat('REVIEWER', env)).toBe(true);
        expect(seesAmbientChat('Alice', env)).toBe(true);
        expect(seesAmbientChat('test1', env)).toBe(false);
    });

    test('* is everyone; none is nobody', () => {
        expect(ambientChatAudience({ AMBIENT_CHAT_USERS: '*' })).toEqual({ all: true });
        expect(ambientChatAudience({ AMBIENT_CHAT_USERS: 'test1,*' })).toEqual({ all: true });
        expect(seesAmbientChat('anyone', { AMBIENT_CHAT_USERS: '*' })).toBe(true);
        for (const v of ['none', 'NONE', ' None ']) {
            expect(seesAmbientChat('test1', { AMBIENT_CHAT_USERS: v })).toBe(false);
            expect(seesAmbientChat('none', { AMBIENT_CHAT_USERS: v })).toBe(false);
        }
    });
});

describe('default audience (test1)', () => {
    test('the mainRoomJoined replay: test1 gets the bot lines merged in time order, others humans only', () => {
        ambient.seedMainRoomChat();
        const alice = enter('s-alice', 'alice');
        // (the recorder keeps the payload by reference; the wire is a copy)
        const aliceFirst = [...lastJoined('s-alice').messages];
        mainRoomHandlers.mainRoomChat(alice, io, { message: 'hi all' });
        enter('s-review', 'Test1'); // the name's case does not matter

        const reviewer = lastJoined('s-review').messages;
        expect(reviewer.filter(isBot).length).toBeGreaterThanOrEqual(3);
        expect(reviewer.map((m) => m.message)).toContain('hi all');
        for (let i = 1; i < reviewer.length; i++) expect(reviewer[i].timestamp).toBeGreaterThanOrEqual(reviewer[i - 1].timestamp);
        // The human line came after the back-dated seeds
        expect(reviewer[reviewer.length - 1].message).toBe('hi all');

        enter('s-bob', 'bob');
        expect(lastJoined('s-bob').messages).toEqual([expect.objectContaining({ username: 'alice', message: 'hi all' })]);
        expect(aliceFirst).toEqual([]);
    });

    test('live: a bot line goes to test1\'s main-room socket only, never to the room', () => {
        enter('s-alice', 'alice');
        enter('s-review', 'test1');
        enter('s-bob', 'bob');

        expect(ambient.maybePostChat(io)).toBe(true);
        ambient.announceGameVisible(io);

        expect(botLinesTo('s-review')).toHaveLength(2);
        expect(botLinesTo('mainRoom')).toHaveLength(0);
        expect(botLinesTo('s-alice')).toHaveLength(0);
        expect(botLinesTo('s-bob')).toHaveLength(0);
        expect(log.filter((l) => l.event === 'mainRoomMessage' && l.to !== 's-review')).toHaveLength(0);
    });

    test('test1 at a table gets nothing live, and the lines on returning to the main room', () => {
        const reviewer = enter('s-review', 'test1');
        mainRoomHandlers.createLobby(reviewer, io, {});
        expect(gameManager.isInMainRoom('s-review')).toBe(false);
        ambient.maybePostChat(io);
        expect(botLinesTo('s-review')).toHaveLength(0);

        lobbyHandlers.leaveLobby(reviewer, io);
        expect(lastJoined('s-review').messages.filter(isBot)).toHaveLength(1);
    });

    test('every join point filters: leaving a lobby back to the main room shows alice no bot line', () => {
        ambient.seedMainRoomChat();
        const alice = enter('s-alice', 'alice');
        mainRoomHandlers.createLobby(alice, io, {});
        lobbyHandlers.leaveLobby(alice, io);
        expect(lastJoined('s-alice').messages.filter(isBot)).toHaveLength(0);
    });

    test('human lines are unchanged: one broadcast to the main room, in everyone\'s replay', () => {
        const alice = enter('s-alice', 'alice');
        enter('s-review', 'test1');
        mainRoomHandlers.mainRoomChat(alice, io, { message: 'gg' });
        const live = log.filter((l) => l.event === 'mainRoomMessage');
        expect(live).toEqual([expect.objectContaining({ to: 'mainRoom', data: expect.objectContaining({ username: 'alice', message: 'gg' }) })]);
        enter('s-bob', 'bob');
        expect(lastJoined('s-bob').messages.map((m) => m.message)).toEqual(['gg']);
    });
});

describe('history cap (MAX_MAIN_ROOM_MESSAGES 50)', () => {
    test('bot chatter never pushes a human line out for others; test1 gets the newest 50 of both', () => {
        const alice = enter('s-alice', 'alice');
        for (let i = 0; i < 50; i++) {
            gameManager.mainRoomMessages.push({ username: 'alice', message: `h${i}`, timestamp: Date.now() - 100000 + i });
        }
        // 60 bot lines after them (the old shared ring would keep only these)
        for (let i = 0; i < 60; i++) {
            ambient.postAmbientChat(io, { username: '🤖 Mary', message: `b${i}`, timestamp: Date.now() - 1000 + i });
        }
        expect(gameManager.ambientMainRoomMessages).toHaveLength(50);
        mainRoomHandlers.joinMainRoom(alice, io);
        expect(lastJoined('s-alice').messages.map((m) => m.message)).toEqual(Array.from({ length: 50 }, (_, i) => `h${i}`));

        enter('s-review', 'test1');
        const reviewer = lastJoined('s-review').messages;
        expect(reviewer).toHaveLength(50);
        expect(reviewer.map((m) => m.message)).toEqual(Array.from({ length: 50 }, (_, i) => `b${i + 10}`));
    });
});

describe('CHAT_IDLE_MS (30 min)', () => {
    test('a recent human line or a recent bot line keeps the bots quiet; 30 quiet minutes post', () => {
        jest.useFakeTimers();
        try {
            enter('s-review', 'test1');
            const alice = enter('s-alice', 'alice');
            mainRoomHandlers.mainRoomChat(alice, io, { message: 'here' });
            expect(ambient.maybePostChat(io)).toBe(false);
            jest.advanceTimersByTime(30 * 60 * 1000);
            expect(ambient.maybePostChat(io)).toBe(true);
            // The bot line itself resets the clock
            expect(ambient.maybePostChat(io)).toBe(false);
            jest.advanceTimersByTime(29 * 60 * 1000);
            expect(ambient.maybePostChat(io)).toBe(false);
            jest.advanceTimersByTime(60 * 1000);
            expect(ambient.maybePostChat(io)).toBe(true);
            expect(botLinesTo('s-review')).toHaveLength(2);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('AMBIENT_CHAT_USERS=* and none', () => {
    test('*: one room broadcast and everyone\'s replay, as before', () => {
        process.env.AMBIENT_CHAT_USERS = '*';
        ambient.seedMainRoomChat();
        enter('s-alice', 'alice');
        expect(lastJoined('s-alice').messages.filter(isBot).length).toBeGreaterThanOrEqual(3);
        ambient.announceGameVisible(io);
        expect(botLinesTo('mainRoom')).toHaveLength(1);
        expect(botLinesTo('s-alice')).toHaveLength(0);
    });

    test('none: nobody, test1 included', () => {
        process.env.AMBIENT_CHAT_USERS = 'none';
        ambient.seedMainRoomChat();
        enter('s-review', 'test1');
        expect(lastJoined('s-review').messages).toEqual([]);
        const stored = gameManager.ambientMainRoomMessages.length;
        ambient.announceGameVisible(io);
        expect(gameManager.ambientMainRoomMessages).toHaveLength(stored + 1); // stored, sent to nobody
        expect(log.filter((l) => l.event === 'mainRoomMessage')).toHaveLength(0);
    });

    test('a listed name: that account only, read on every call', () => {
        process.env.AMBIENT_CHAT_USERS = 'Reviewer2';
        enter('s-review', 'test1');
        enter('s-r2', 'reviewer2');
        ambient.maybePostChat(io);
        expect(botLinesTo('s-r2')).toHaveLength(1);
        expect(botLinesTo('s-review')).toHaveLength(0);
    });
});
