/**
 * A player joining a tournament lobby: the members already there get the
 * scoreboard with the joiner's row in tournamentPlayerJoined (additive), so
 * the host's lobby lists them at once instead of from round 1 on.
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
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { newIo, newUser } = require('../../testUtils/tournamentDriver');

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

test('tournamentPlayerJoined carries the scoreboard with the joiner\'s row, to the host', async () => {
    const { io, log } = newIo();
    const host = newUser(io, log, 'sb_host');
    const joiner = newUser(io, log, 'sb_joiner');
    tournamentHandlers.createTournament(host, io);
    const t = gameManager.getPlayerTournament(host.id);

    await tournamentHandlers.joinTournament(joiner, io, { tournamentId: t.tournamentId });

    const joined = log.filter((l) => l.event === 'tournamentPlayerJoined');
    expect(joined).toHaveLength(1);
    expect(joined[0].to).toBe(t.roomName);
    expect(joined[0].members).toContain(host.id);
    expect(joined[0].data.players.map((p) => p.username).sort()).toEqual(['sb_host', 'sb_joiner']);
    expect(joined[0].data.scoreboard).toEqual(t.getScoreboard());
    expect(joined[0].data.scoreboard.map((r) => r.username).sort()).toEqual(['sb_host', 'sb_joiner']);
    for (const row of joined[0].data.scoreboard) expect(row).toMatchObject({ totalScore: 0, roundScores: [] });
});
