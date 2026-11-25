/**
 * The /help stats writer (plan section 6; profileHandlers.buildGameEndRecord)
 * and the reader it feeds (applyPendingStats, statsDeltas.bucketByPosition):
 *
 *  - a game nobody used /help in gives the record it gave before /help,
 *    byte for byte (the snapshot below was checked against the builder at
 *    045802c9 for a human game, a bot game, a default assist and a record
 *    belonging to someone else)
 *  - counted uses under the limit: only the evidence (statsDeltas.assist)
 *  - an assisted seat whose team WON (owner 2026-11-21): bucketByPosition
 *    {pos: 'botStats'} for that seat, withBots + empty team bots,
 *    assistedTeams; one that lost or tied stays in the human stats (no
 *    bucketByPosition, withBots or assistedTeams; the evidence stays),
 *    /help and the tutorial alike; in a bot game anyway no
 *    bucketByPosition (still marked although players see no limit there,
 *    owner 2026-11-19); recordGameStats credits the assisted player's
 *    botStats and everyone else's stats
 *  - a real tournament: /help is allowed at the table, counted, and the
 *    game counts as bot-assisted for the player there too
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports
}));

const gameManager = require('../../game/GameManager');
const profile = require('../profileHandlers');
const shutdownMod = require('../../utils/shutdown');
const chatHandlers = require('../chatHandlers');
const gameHandlers = require('../gameHandlers');
const rateLimiter = require('../rateLimiter');
const assistHandlers = require('../assistHandlers');
const { Phase } = require('../../game/GamePhase');
const { defaultAssist } = require('../../game/assistState');
const { legalCards, legalBids } = require('../../testUtils/gameDriver');
const { setupTournament, playTournament, advanceUntil } = require('../../testUtils/tournamentDriver');
const { authLogger, logger, gameLogger, socketLogger } = require('../../utils/logger');

const NOW = 1_800_000_000_000;
const users = () => mockDb.current.users;
const records = () => mockDb.current.gameRecords;
const statsOf = (name, bucket) => users().docs.find((d) => d.username === name)?.[bucket] || {};

/**
 * A finished human game: Ann/Cat (team 1) beat Ben/Dan unless `score` says
 * otherwise; `help` sets counted uses by position, `tutorial` the positions
 * that played with the tutorial (tutorialEver).
 */
function finishedGame({ gameId = 'g-1', bots = [], help = {}, tutorial = [], score = { team1: 420, team2: 150 } } = {}) {
    const humans = { 1: 'Ann', 2: 'Ben', 3: 'Cat', 4: 'Dan' };
    const seats = [1, 2, 3, 4].map((pos) => (bots.includes(pos)
        ? { position: pos, controller: 'bot', ownerUsername: null }
        : { position: pos, controller: 'human', ownerUsername: humans[pos] }));
    const assist = defaultAssist();
    for (const [pos, n] of Object.entries(help)) Object.assign(assist[pos], { user: humans[pos], help: n, lastHelpKey: `k${n}` });
    for (const pos of tutorial) Object.assign(assist[pos], { user: humans[pos], tutorialEver: true });
    return {
        gameId,
        score,
        assist,
        seatList: () => seats,
        seat: (pos) => seats[pos - 1],
        getOriginalPlayer: (pos) => ({ username: bots.includes(pos) ? `🤖 Bot${pos}` : humans[pos] }),
        handStats: { totalHands: 13, team1Sets: 1, team2Sets: 3, team1SetPoints: 20, team2SetPoints: 90 },
        playerStats: {
            1: { totalBids: 5, totalTricks: 6, setsCaused: 0, totalHSI: 300 },
            2: { totalBids: 4, totalTricks: 3, setsCaused: 2, totalHSI: 250 },
            3: { totalBids: 2, totalTricks: 2, setsCaused: 1, totalHSI: 200 },
            4: { totalBids: 3, totalTricks: 2, setsCaused: 1, totalHSI: 150 }
        }
    };
}

beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    gameManager.deletedUsernames.clear();
    shutdownMod._resetShutdownStateForTests();
    profile._resetCachesForTests();
    profile._setStatsRetryDelaysForTests([1, 1, 1, 1, 1]);
    assistHandlers._resetForTests();
    mockDb.current = createMemoryDb({ users: ['Ann', 'Ben', 'Cat', 'Dan'].map((username) => ({ username })) });
    for (const l of [authLogger, logger, gameLogger, socketLogger]) {
        for (const m of ['info', 'debug', 'warn', 'error']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    profile._setStatsRetryDelaysForTests();
    shutdownMod._resetShutdownStateForTests();
});
afterAll(() => rateLimiter.shutdown());

// The record before /help, byte for byte (completedAt is the fake clock),
// plus the superlatives' seat names (statsDeltas.names, 2026-11-20); this
// fake game has no bag counter (no game.seatBags), so no
// statsDeltas.bags, and byPosition is the 12 bucket counters as before
// plus, since badges (2026-11-25), what the game earned (statsDeltas.badges;
// a game that earned nothing has no such key): team 1's 420 points are the
// 400 badge for seats 1 and 3, and Ann's 6 tricks to Cat's 2 in a win are
// Backpack for Ann and Ball and Chain for Cat
const NO_HELP_RECORD = '{"gameId":"g-1","team1Score":420,"team2Score":150,"team1Players":["Ann","Cat"],"team2Players":["Ben","Dan"],"team1Bags":1,"team2Bags":-2,"completedAt":"2027-01-15T08:00:00.000Z","statsDeltas":{"bucket":"stats","byPosition":{"1":{"gamesPlayed":1,"wins":1,"losses":0,"draws":0,"totalPoints":420,"totalTricksBid":5,"totalTricksTaken":6,"totalHands":13,"totalSets":1,"totalSetPoints":20,"totalFaults":0,"totalHSI":300},"2":{"gamesPlayed":1,"wins":0,"losses":1,"draws":0,"totalPoints":150,"totalTricksBid":4,"totalTricksTaken":3,"totalHands":13,"totalSets":3,"totalSetPoints":90,"totalFaults":2,"totalHSI":250},"3":{"gamesPlayed":1,"wins":1,"losses":0,"draws":0,"totalPoints":420,"totalTricksBid":2,"totalTricksTaken":2,"totalHands":13,"totalSets":1,"totalSetPoints":20,"totalFaults":1,"totalHSI":200},"4":{"gamesPlayed":1,"wins":0,"losses":1,"draws":0,"totalPoints":150,"totalTricksBid":3,"totalTricksTaken":2,"totalHands":13,"totalSets":3,"totalSetPoints":90,"totalFaults":1,"totalHSI":150}},"names":{"1":"Ann","2":"Ben","3":"Cat","4":"Dan"},"badges":{"1":["four-hundred","backpack"],"3":["four-hundred","ball-and-chain"]}},"statsPending":[{"position":1,"username":"Ann"},{"position":2,"username":"Ben"},{"position":3,"username":"Cat"},{"position":4,"username":"Dan"}]}';

describe('buildGameEndRecord', () => {
    test('no /help: the record of before, byte for byte (also with a record that belongs to someone else)', () => {
        expect(JSON.stringify(profile.buildGameEndRecord(finishedGame()))).toBe(NO_HELP_RECORD);
        const stale = finishedGame();
        Object.assign(stale.assist[2], { user: 'Zed', help: 9, lastHelpKey: 'x' });   // not Ben's: ignored
        expect(JSON.stringify(profile.buildGameEndRecord(stale))).toBe(NO_HELP_RECORD);
        const noField = finishedGame();
        delete noField.assist;
        expect(JSON.stringify(profile.buildGameEndRecord(noField))).toBe(NO_HELP_RECORD);
    });

    test('uses under the limit: the evidence only (statsDeltas.assist), nothing moves', () => {
        const r = profile.buildGameEndRecord(finishedGame({ help: { 1: 3, 4: 1 } }));
        expect(r.statsDeltas.assist).toEqual({ 1: { help: 3 }, 4: { help: 1 } });
        expect(r.statsDeltas.bucket).toBe('stats');
        expect(r.statsDeltas).not.toHaveProperty('bucketByPosition');
        expect(r).not.toHaveProperty('withBots');
        expect(r).not.toHaveProperty('assistedTeams');
        const { assist, ...deltas } = r.statsDeltas;
        expect(JSON.stringify({ ...r, statsDeltas: deltas })).toBe(NO_HELP_RECORD);
    });

    test('an assisted seat on the winning team: botStats for that seat only, withBots with empty team bots, assistedTeams', () => {
        const r = profile.buildGameEndRecord(finishedGame({ help: { 3: 4, 2: 2 } }));
        expect(r.statsDeltas).toMatchObject({ bucket: 'stats', bucketByPosition: { 3: 'botStats' }, assist: { 2: { help: 2 }, 3: { help: 4 } } });
        expect(r).toMatchObject({ withBots: true, team1Bots: [], team2Bots: [], team1Players: ['Ann', 'Cat'], team2Players: ['Ben', 'Dan'], assistedTeams: [1] });
        expect(Object.keys(r)).toEqual(['gameId', 'team1Score', 'team2Score', 'team1Players', 'team2Players', 'team1Bags', 'team2Bags', 'completedAt',
            'withBots', 'team1Bots', 'team2Bots', 'statsDeltas', 'assistedTeams', 'statsPending']);
        // team 2 winning: its assisted seat moves
        const two = profile.buildGameEndRecord(finishedGame({ help: { 2: 4 }, score: { team1: 150, team2: 420 } }));
        expect(two.statsDeltas.bucketByPosition).toEqual({ 2: 'botStats' });
        expect(two).toMatchObject({ withBots: true, assistedTeams: [2] });
    });

    test('an assisted seat on the losing team (owner 2026-11-21): a plain human game, the evidence kept', () => {
        const r = profile.buildGameEndRecord(finishedGame({ help: { 2: 4, 3: 2 } }));
        expect(r.statsDeltas.bucket).toBe('stats');
        expect(r.statsDeltas).not.toHaveProperty('bucketByPosition');
        expect(r.statsDeltas.assist).toEqual({ 2: { help: 4 }, 3: { help: 2 } });
        expect(r).not.toHaveProperty('withBots');
        expect(r).not.toHaveProperty('team2Bots');
        expect(r).not.toHaveProperty('assistedTeams');
        // apart from the evidence, the record of a game nobody used /help in
        const { assist, ...deltas } = r.statsDeltas;
        expect(JSON.stringify({ ...r, statsDeltas: deltas })).toBe(NO_HELP_RECORD);
    });

    test('a tie: an assisted seat stays in the human stats (neither team won)', () => {
        const r = profile.buildGameEndRecord(finishedGame({ help: { 1: 4, 2: 6 }, tutorial: [4], score: { team1: 300, team2: 300 } }));
        expect(r.statsDeltas.bucket).toBe('stats');
        expect(r.statsDeltas).not.toHaveProperty('bucketByPosition');
        expect(r.statsDeltas.assist).toEqual({ 1: { help: 4 }, 2: { help: 6 }, 4: { help: 0, tutorial: true } });
        expect(r).not.toHaveProperty('withBots');
        expect(r).not.toHaveProperty('assistedTeams');
        expect(r.statsDeltas.byPosition[1]).toMatchObject({ wins: 0, losses: 0, draws: 1 });
    });

    test('both teams assisted: only the winners move', () => {
        const both = profile.buildGameEndRecord(finishedGame({ help: { 1: 5, 2: 4, 4: 9 } }));
        expect(both.statsDeltas.bucketByPosition).toEqual({ 1: 'botStats' });
        expect(both.assistedTeams).toEqual([1]);
        expect(both.withBots).toBe(true);
        expect(both.statsDeltas.assist).toEqual({ 1: { help: 5 }, 2: { help: 4 }, 4: { help: 9 } });
        // the other way round
        const flipped = profile.buildGameEndRecord(finishedGame({ help: { 1: 5, 2: 4, 4: 9 }, score: { team1: 90, team2: 260 } }));
        expect(flipped.statsDeltas.bucketByPosition).toEqual({ 2: 'botStats', 4: 'botStats' });
        expect(flipped.assistedTeams).toEqual([2]);
    });

    test('a tutorial seat follows the same rule: a win moves it, a loss does not', () => {
        const r = profile.buildGameEndRecord(finishedGame({ tutorial: [1, 4] }));
        expect(r.statsDeltas.assist).toEqual({ 1: { help: 0, tutorial: true }, 4: { help: 0, tutorial: true } });
        expect(r.statsDeltas.bucketByPosition).toEqual({ 1: 'botStats' });
        expect(r).toMatchObject({ withBots: true, assistedTeams: [1] });
        const lost = profile.buildGameEndRecord(finishedGame({ tutorial: [4] }));
        expect(lost.statsDeltas.assist).toEqual({ 4: { help: 0, tutorial: true } });
        expect(lost.statsDeltas).not.toHaveProperty('bucketByPosition');
        expect(lost).not.toHaveProperty('withBots');
        expect(lost).not.toHaveProperty('assistedTeams');
    });

    test('a bot game anyway: no bucketByPosition (the whole game is botStats), the evidence and assistedTeams', () => {
        const r = profile.buildGameEndRecord(finishedGame({ bots: [4], help: { 1: 4 } }));
        expect(r.statsDeltas.bucket).toBe('botStats');
        expect(r.statsDeltas).not.toHaveProperty('bucketByPosition');
        expect(r.statsDeltas.assist).toEqual({ 1: { help: 4 } });
        expect(r).toMatchObject({ withBots: true, team2Bots: ['🤖 Bot4'], assistedTeams: [1] });
        // unchanged by the win rule (owner 2026-11-21): a losing assisted
        // seat of a bot game is marked too (its stats are bot-game anyway)
        const lost = profile.buildGameEndRecord(finishedGame({ bots: [4], help: { 1: 4, 2: 5 } }));
        expect(lost.statsDeltas).not.toHaveProperty('bucketByPosition');
        expect(lost.assistedTeams).toEqual([1, 2]);
    });

    test('a bot game where /help is free and unlimited for players (owner 2026-11-19): more than 3 uses is still recorded', () => {
        // Players see no count or limit there (assistState.isFreeHelpGame),
        // but the record still marks the player (owner: "Free UI, still record it")
        const r = profile.buildGameEndRecord(finishedGame({ bots: [3, 4], help: { 1: 9, 2: 2 } }));
        expect(r.statsDeltas.bucket).toBe('botStats');
        expect(r.statsDeltas).not.toHaveProperty('bucketByPosition');
        expect(r.statsDeltas.assist).toEqual({ 1: { help: 9 }, 2: { help: 2 } });
        expect(r.assistedTeams).toEqual([1]);
        // 3 uses (the old free limit) is not assisted, in a bot game too
        const three = profile.buildGameEndRecord(finishedGame({ bots: [4], help: { 2: 3 } }));
        expect(three.statsDeltas.assist).toEqual({ 2: { help: 3 } });
        expect(three).not.toHaveProperty('assistedTeams');
    });
});

test('recordGameStats: the assisted player is credited to botStats, the other three to stats; assistedTeams never in a Records page', async () => {
    await profile.recordGameStats(finishedGame({ help: { 3: 4, 1: 2 } }));
    expect(statsOf('Cat', 'botStats')).toMatchObject({ gamesPlayed: 1, wins: 1 });
    expect(statsOf('Cat', 'stats')).toEqual({});
    for (const n of ['Ann', 'Ben', 'Dan']) {
        expect(statsOf(n, 'stats')).toMatchObject({ gamesPlayed: 1 });
        expect(statsOf(n, 'botStats')).toEqual({});
    }
    const doc = records().docs[0];
    expect(doc).toMatchObject({ withBots: true, assistedTeams: [1], statsDeltas: { bucketByPosition: { 3: 'botStats' }, assist: { 1: { help: 2 }, 3: { help: 4 } } } });
    expect(doc).not.toHaveProperty('statsPending');
    // the Records projections never carry it
    const src = require('fs').readFileSync(require.resolve('../profileHandlers'), 'utf8');
    const projections = src.match(/const RECORDS_PROJECTION = \{[\s\S]*?\};\n[\s\S]*?const RECORDS_PROJECTION_WITH_BOTS[^\n]*/)[0];
    expect(projections).toMatch(/RECORDS_PROJECTION_WITH_BOTS/);
    expect(projections).not.toMatch(/assistedTeams/);
});

test('recordGameStats: an assisted player who lost is credited to the human stats like everyone else (owner 2026-11-21)', async () => {
    await profile.recordGameStats(finishedGame({ help: { 2: 4, 1: 2 }, tutorial: [4] }));
    expect(statsOf('Ben', 'stats')).toMatchObject({ gamesPlayed: 1, wins: 0, losses: 1 });
    expect(statsOf('Dan', 'stats')).toMatchObject({ gamesPlayed: 1, losses: 1 });
    for (const n of ['Ann', 'Ben', 'Cat', 'Dan']) expect(statsOf(n, 'botStats')).toEqual({});
    const doc = records().docs[0];
    expect(doc).not.toHaveProperty('withBots');
    expect(doc).not.toHaveProperty('assistedTeams');
    expect(doc.statsDeltas).not.toHaveProperty('bucketByPosition');
    expect(doc.statsDeltas.assist).toEqual({ 1: { help: 2 }, 2: { help: 4 }, 4: { help: 0, tutorial: true } });
});

// ------------------------------------------------------------ a tournament table

test('tournament: /help is allowed at the table, counted and announced, and the game counts as bot-assisted for that player', async () => {
    jest.useRealTimers();
    jest.useFakeTimers({ now: NOW });
    const ctx = await setupTournament(4);
    const say = (s, message) => chatHandlers.chatMessage(s, ctx.io, { message });
    let table = null;
    let asker = null;
    let askerName = null;
    await playTournament(ctx, {
        round: async (round, c, tables) => {
            if (round !== 1) return;
            table = tables[0];
            const game = table;
            expect(gameManager.tournamentGames.get(game.gameId)).toBe(ctx.t.tournamentId);
            await advanceUntil(() => game.stage === Phase.BIDDING && !game.resume, 100);
            asker = game.currentTurn;
            askerName = game.seat(asker).ownerUsername;
            const owner = (pos) => ctx.sockets.find((s) => s.id === game.seat(pos).ownerSocketId);
            while (game.assist[asker].help < 4) {
                if (game.stage === Phase.BIDDING || game.stage === Phase.PLAYING) {
                    if (game.currentTurn === asker) {
                        rateLimiter.clearSocket(owner(asker).id);
                        say(owner(asker), '?help');
                    }
                    const s = owner(game.currentTurn);
                    if (game.stage === Phase.BIDDING) {
                        const bids = legalBids(game);
                        await gameHandlers.playerBid(s, ctx.io, { bid: bids.includes('1') ? '1' : bids.find((b) => /^\d+$/.test(b)) });
                    } else {
                        await gameHandlers.playCard(s, ctx.io, { card: legalCards(game, s.id)[0] });
                        await advanceUntil(() => !game.resume, 100);
                    }
                } else {
                    await jest.advanceTimersByTimeAsync(500);
                }
            }
        },
    });
    expect(table.stage).toBe(Phase.ENDED);
    const notices = ctx.log.filter((l) => l.event === 'gameLogEntry' && l.to === table.roomName && /used \/help/.test(l.data.message)).map((l) => l.data.message);
    expect(notices).toEqual([
        `${askerName} used /help.`, `${askerName} used /help.`, `${askerName} used /help.`,
        `${askerName} used /help. This game now counts as bot-assisted for ${askerName}.`,
    ]);
    // the round-1 record: the asker's seat in botStats if its team won (owner
    // 2026-11-21), else in the human stats like the others
    await advanceUntil(() => records().docs.some((d) => d.gameId === table.gameId && !d.statsPending), 100);
    const doc = records().docs.find((d) => d.gameId === table.gameId);
    const askerTeam = asker % 2 === 1 ? 1 : 2;
    const won = askerTeam === 1 ? doc.team1Score > doc.team2Score : doc.team2Score > doc.team1Score;
    expect(doc.statsDeltas.bucket).toBe('stats');
    expect(doc.statsDeltas.assist[asker]).toEqual({ help: 4 });
    if (won) {
        expect(doc.statsDeltas.bucketByPosition).toEqual({ [asker]: 'botStats' });
        expect(doc.assistedTeams).toEqual([askerTeam]);
        expect(statsOf(askerName, 'botStats').gamesPlayed).toBeGreaterThanOrEqual(1);
    } else {
        expect(doc.statsDeltas).not.toHaveProperty('bucketByPosition');
        expect(doc).not.toHaveProperty('assistedTeams');
        expect(statsOf(askerName, 'stats').gamesPlayed).toBeGreaterThanOrEqual(1);
    }
    const others = ctx.usernames.filter((u) => u !== askerName);
    for (const u of others) expect(statsOf(u, 'stats').gamesPlayed).toBeGreaterThanOrEqual(1);
}, 120000);
