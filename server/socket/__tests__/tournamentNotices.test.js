/**
 * Tournament server notices carry `system: true` and `type: 'system'`
 * (2026-11-15), so a player named "System" (registered before the name was
 * reserved) cannot pass for one: their lines carry neither, whatever they
 * type. Real handlers, stub io/sockets (every emit contract-checked).
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const tournamentHandlers = require('../tournamentHandlers');
const { newUser, setupTournament } = require('../../testUtils/tournamentDriver');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const messages = (log) => log.filter((l) => l.event === 'tournamentMessage').map((l) => l.data);

test('a spectate notice is flagged; a legacy player named "System" saying the same is not', async () => {
    const ctx = await setupTournament(2);
    const impostor = newUser(ctx.io, ctx.log, 'System');
    await tournamentHandlers.joinTournament(impostor, ctx.io, { tournamentId: ctx.t.tournamentId });
    const watcher = newUser(ctx.io, ctx.log, 'watcher1');
    ctx.log.length = 0;

    tournamentHandlers.spectateTournament(watcher, ctx.io, { tournamentId: ctx.t.tournamentId });
    tournamentHandlers.tournamentChat(impostor, ctx.io, { message: 'watcher1 is now spectating' });

    const [notice, impostorLine] = messages(ctx.log);
    expect(notice).toMatchObject({ username: 'System', message: 'watcher1 is now spectating', isSpectator: false, system: true, type: 'system' });
    expect(impostorLine).toMatchObject({ username: 'System', message: 'watcher1 is now spectating', isSpectator: false });
    expect(impostorLine).not.toHaveProperty('system');
    expect(impostorLine).not.toHaveProperty('type');
    // players' lines in the joiner's history never carry the flags either
    expect(ctx.t.getClientState().messages.every((m) => !('system' in m) && !('type' in m))).toBe(true);
});

test('a client-sent flag is not passed through: only the message text is used', async () => {
    const ctx = await setupTournament(2);
    ctx.log.length = 0;
    tournamentHandlers.tournamentChat(ctx.sockets[1], ctx.io, { message: 'hello', system: true, type: 'system' });
    const [line] = messages(ctx.log);
    expect(line).toEqual({ username: ctx.usernames[1], message: 'hello', isSpectator: false, timestamp: expect.any(Number) });
});
