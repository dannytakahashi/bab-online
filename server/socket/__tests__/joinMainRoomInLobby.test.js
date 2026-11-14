/**
 * joinMainRoom from a socket that sits in a lobby leaves the lobby as the
 * Leave button does: leftLobby before mainRoomJoined to that socket,
 * lobbyPlayerLeft (and voicePeerLeft) to the others.
 *
 * Why (owner, 2026-11-12, iOS buttons dead after a long background): the app
 * reconnects, restores its session and then sends joinMainRoom; a tap on New
 * Game in that window reaches the server first. GameManager.joinMainRoom
 * dropped the new lobby seat without a word, the app opened the lobby screen
 * (lobbyCreated) and every Leave after that got "error" (not in a lobby).
 * Seen live on the repro (R-resume runs, 2026-11-12).
 *
 * Real handlers on the in-memory DB fake, stub io/sockets from gameDriver.
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
const authHandlers = require('../authHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const { hashToken } = require('../../utils/sessionTokens');
const { makeIo, makeSocket, events } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, authLogger } = require('../../utils/logger');

let seq = 0;

beforeEach(() => {
    mockDb.current = createMemoryDb({ users: [] });
    require('../signInThrottle')._reset();
    for (const m of ['log', 'warn']) jest.spyOn(console, m).mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, authLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    gameManager.lobbies.clear();
    gameManager.playerLobbies.clear();
    gameManager.mainRoomSocketIds.clear();
    gameManager.currentUsers = [];
    jest.restoreAllMocks();
});

async function signedIn(log, io, username) {
    seq++;
    const token = `tok-${seq}-${username}`;
    const now = new Date();
    mockDb.current.users._insert({
        username, profilePic: 3,
        sessionTokens: [{ hash: hashToken(token), createdAt: now, lastUsedAt: now }],
    });
    const s = makeSocket(`jm${seq}-${username}`, log, io);
    await authHandlers.restoreSession(s, io, { username, sessionToken: token });
    expect(events(log, 'restoreSessionResponse').filter((l) => l.to === `self:${s.id}`).pop().data.success).toBe(true);
    mainRoomHandlers.joinMainRoom(s, io);
    return s;
}

const to = (log, sid, from) => log.slice(from).filter((l) => l.to === sid || l.to === `self:${sid}`);

describe('joinMainRoom while in a lobby', () => {
    test('the lobby I just created: leftLobby, then mainRoomJoined; no lobby left behind', async () => {
        const log = [];
        const io = makeIo(log);
        const ann = await signedIn(log, io, `ann${seq}`);
        // The tap's createLobby reaches the server before the restore's joinMainRoom
        mainRoomHandlers.createLobby(ann, io, {});
        const lobbyId = gameManager.getPlayerLobby(ann.id).id;

        const from = log.length;
        mainRoomHandlers.joinMainRoom(ann, io);

        const got = to(log, ann.id, from).map((l) => l.event);
        expect(got).toContain('leftLobby');
        expect(got).toContain('mainRoomJoined');
        expect(got.indexOf('leftLobby')).toBeLessThan(got.indexOf('mainRoomJoined'));
        expect(got).not.toContain('serverError'); // no refusal (the server's only failure event since #1 phase B)
        expect(gameManager.playerLobbies.has(ann.id)).toBe(false);
        expect(gameManager.getLobbyById(lobbyId)).toBeFalsy();
        expect(gameManager.isInMainRoom(ann.id)).toBe(true);

        // The Leave the app then shows is not refused: it is already in the main room
        const after = log.length;
        mainRoomHandlers.joinMainRoom(ann, io);
        expect(to(log, ann.id, after).map((l) => l.event)).toEqual(expect.arrayContaining(['mainRoomJoined']));
        expect(to(log, ann.id, after).map((l) => l.event)).not.toContain('leftLobby');
        expect(to(log, ann.id, after).map((l) => l.event)).not.toContain('serverError');
    });

    test('a shared lobby: the others are told I left', async () => {
        const log = [];
        const io = makeIo(log);
        const annName = `ann${seq}`;
        const ann = await signedIn(log, io, annName);
        const bob = await signedIn(log, io, `bob${seq}`);
        mainRoomHandlers.createLobby(ann, io, {});
        const lobbyId = gameManager.getPlayerLobby(ann.id).id;
        mainRoomHandlers.joinLobby(bob, io, { lobbyId });

        const from = log.length;
        mainRoomHandlers.joinMainRoom(bob, io);

        expect(to(log, bob.id, from).map((l) => l.event)).toEqual(expect.arrayContaining(['leftLobby', 'mainRoomJoined']));
        expect(to(log, bob.id, from).map((l) => l.event)).not.toContain('serverError');
        const annGot = to(log, ann.id, from);
        const left = annGot.find((l) => l.event === 'lobbyPlayerLeft');
        expect(left).toBeTruthy();
        expect(left.data.players.map((p) => p.username)).toEqual([annName]);
        expect(annGot.find((l) => l.event === 'voicePeerLeft').data).toEqual({ socketId: bob.id });
        expect(gameManager.getLobbyById(lobbyId).players.map((p) => p.username)).toEqual([annName]);
    });
});
