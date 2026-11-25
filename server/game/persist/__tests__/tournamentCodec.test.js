/**
 * Tournament codec (deploy survival, PR 3): each phase round-trips through
 * JSON with the same client state (members, creator, phase, rounds, chat,
 * scoreboard, deadline), scoreboard and winners; 'starting' comes back as
 * the phase it started from; a doc that fails a check is refused.
 * Socket ids, ready and connected are not compared: a restored member is
 * disconnected and not ready until it reattaches by username.
 */

const { createMemoryDb } = require('../../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const TournamentState = require('../../TournamentState');
const gameManager = require('../../GameManager');
const { gameLogger, socketLogger, authLogger, logger } = require('../../../utils/logger');
const { setupTournament, playTournament } = require('../../../testUtils/tournamentDriver');
const { mulberry32 } = require('../../../testUtils/gameDriver');
const codec = require('../tournamentCodec');

const NOW = 1_800_000_000_000;

let realRandom;
beforeAll(() => { realRandom = Math.random; });

beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    gameManager._resetForTests();
    require('../../bot').botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const json = (v) => JSON.parse(JSON.stringify(v));

/** getClientState without what a restore re-makes (socket ids, ready, connected). */
function clientState(t) {
    const s = json(t.getClientState());
    delete s.creatorSocketId;
    s.players = s.players.map(({ username, pic, isCreator }) => ({ username, pic, isCreator }));
    return s;
}

function roundTrip(t, opts) {
    const doc = codec.serialize(t, opts);
    expect(doc).not.toBeNull();
    const stored = json(doc);
    expect(stored).toEqual(doc);
    const { tournament, tableScores } = codec.hydrate(stored);
    // Serializing the restored tournament gives the same doc back
    expect(codec.serialize(tournament, { getGame: () => null })).toEqual({
        ...stored, state: { ...stored.state, tableScores: {} },
    });
    return { doc: stored, restored: tournament, tableScores };
}

function expectSame(t, restored) {
    expect(clientState(restored)).toEqual(clientState(t));
    expect(restored.getScoreboard()).toEqual(t.getScoreboard());
    expect(restored.getWinners()).toEqual(t.getWinners());
    expect(restored.getActiveGames()).toEqual(t.getActiveGames());
    for (const p of restored.players.values()) {
        expect(p).toMatchObject({ ready: false, connected: false });
    }
    expect(restored.readyPlayers.size).toBe(0);
    expect(restored.spectators.size).toBe(0);
    expect(restored.timers.size).toBe(0);
    expect(restored.retired).toBe(false);
}

function lobby() {
    const t = new TournamentState('t-1', 'Friday Cup', 'sock-alice', 'alice');
    t.addPlayer('sock-alice', 'alice', null);
    t.addPlayer('sock-bob', 'bob', null);
    t.addPlayer('sock-cy', 'cy', null);
    t.setReady('sock-bob');
    t.addMessage('alice', 'welcome all');
    t.addMessage('watcher', 'good luck!', true);
    t.addMessage('bob', 'thanks');
    return t;
}

/** Round `n` played at one table `gameId`, every member scored. */
function playRound(t, n, gameId, scores) {
    t.startRound(n);
    t.addGameToRound(gameId, Array.from(t.players.values(), (p) => p.username), 4 - t.players.size);
    for (const [username, teamScore] of Object.entries(scores)) {
        t.recordPlayerRoundScore(username, { roundNumber: n, gameId, position: 1, teamScore, oppScore: 0, partner: 'Bot' });
    }
    t.markGameComplete(gameId);
    t.completeRound();
}

/** A live table stub (what tableScores reads from a GameState). */
function liveTable(score, seats) {
    return {
        isTerminal: () => false,
        seatList: () => seats,
        score,
        getOriginalPlayer: (pos) => ({ username: seats[pos - 1].username }),
        seat: (pos) => seats[pos - 1],
    };
}

describe('round trips', () => {
    test('lobby, with player and spectator chat', () => {
        const t = lobby();
        const { doc, restored } = roundTrip(t);
        expect(doc.phase).toBe('lobby');
        expect(doc.state.messages).toEqual([
            { username: 'alice', message: 'welcome all', isSpectator: false, timestamp: NOW },
            { username: 'watcher', message: 'good luck!', isSpectator: true, timestamp: NOW },
            { username: 'bob', message: 'thanks', isSpectator: false, timestamp: NOW },
        ]);
        expect(doc.state.players).toEqual([
            { username: 'alice', pic: null }, { username: 'bob', pic: null }, { username: 'cy', pic: null },
        ]);
        expectSame(t, restored);
        expect(restored.createdAt).toBe(t.createdAt);
        expect(restored.name).toBe('Friday Cup');
        // Each member is keyed restored:<tid>:<username> until it reattaches
        expect(Array.from(restored.players.keys())).toEqual(['restored:t-1:alice', 'restored:t-1:bob', 'restored:t-1:cy']);
        expect(restored.createdBy).toBe('restored:t-1:alice');
        // Members reattach by username; the creator role follows alice
        expect(restored.reattachPlayerByUsername('alice', 'sock-alice-2')).toEqual({ oldSocketId: codec.restoredMemberId('t-1', 'alice') });
        expect(restored.createdBy).toBe('sock-alice-2');
        expect(restored.getClientState().players.find((p) => p.username === 'alice')).toMatchObject({ connected: true, isCreator: true });
    });

    test('between rounds, with a ready deadline and the hand-off already used', () => {
        const t = lobby();
        playRound(t, 1, 'g-1', { alice: 120, bob: -40, cy: 60 });
        expect(t.phase).toBe('between_rounds');
        t.readyDeadlineAt = NOW + 120000;
        t.handedOffThisWait = true;
        t.transferCreator();
        const { doc, restored } = roundTrip(t);
        expect(doc.phase).toBe('between_rounds');
        expect(doc.state.readyDeadlineAt).toBe(NOW + 120000);
        expect(doc.state.handedOffThisWait).toBe(true);
        expectSame(t, restored);
        expect(restored.creatorUsername).toBe('bob');
        expect(restored.readyDeadlinePassed()).toBe(false);
        jest.setSystemTime(NOW + 120000);
        expect(restored.readyDeadlinePassed()).toBe(true);
        expect(clientState(restored)).toEqual(clientState(t));
    });

    test('round active, two tables, one complete: the live one keeps its running score', () => {
        const t = lobby();
        for (const u of ['dee', 'eve', 'fay', 'gus', 'hal']) t.addPlayer(`sock-${u}`, u, null);
        playRound(t, 1, 'g-1', { alice: 10, bob: 20, cy: 30, dee: 40, eve: 50, fay: 60, gus: 70, hal: 80 });
        t.startRound(2);
        t.addGameToRound('g-2a', ['alice', 'bob', 'cy', 'dee'], 0);
        t.addGameToRound('g-2b', ['eve', 'fay', 'gus', 'hal'], 0, [['eve', 'gus'], ['fay', 'hal']]);
        for (const u of ['alice', 'bob', 'cy', 'dee']) {
            t.recordPlayerRoundScore(u, { roundNumber: 2, gameId: 'g-2a', position: 1, teamScore: 55, oppScore: 10, partner: 'x' });
        }
        t.markGameComplete('g-2a');
        const seats = ['eve', 'fay', 'gus', 'hal'].map((username, i) => ({ username, position: i + 1, presence: i === 3 ? 'gone' : 'connected' }));
        const tables = { 'g-2b': liveTable({ team1: 230, team2: -60 }, seats) };
        const { doc, restored, tableScores } = roundTrip(t, { getGame: (id) => tables[id] || null });
        expect(doc.phase).toBe('round_active');
        expect(doc.state.rounds[1]).toEqual({
            roundNumber: 2,
            games: [
                // A table without teams (saved before partner rotation) writes null
                ['g-2a', { humanPlayers: ['alice', 'bob', 'cy', 'dee'], botCount: 0, status: 'complete', teams: null }],
                ['g-2b', { humanPlayers: ['eve', 'fay', 'gus', 'hal'], botCount: 0, status: 'active', teams: [['eve', 'gus'], ['fay', 'hal']] }],
            ],
            completedGames: ['g-2a'],
        });
        // The partner history survives the restore; an older doc without
        // teams restores without them
        expect(restored.partnerHistory()).toEqual(t.partnerHistory());
        expect(restored.partnerHistory().last.get('eve')).toBe('gus');
        expect(restored.rounds[1].games.get('g-2a')).not.toHaveProperty('teams');
        expect(tableScores).toEqual({
            'g-2b': {
                score: { team1: 230, team2: -60 },
                seats: [
                    { username: 'eve', position: 1, gone: false },
                    { username: 'fay', position: 2, gone: false },
                    { username: 'gus', position: 3, gone: false },
                    { username: 'hal', position: 4, gone: true },
                ],
            },
        });
        expectSame(t, restored);
        expect(restored.isRoundComplete()).toBe(false);
        expect(restored.roundOfGame('g-2b').roundNumber).toBe(2);
        // The live table's completion then completes the round, as before
        restored.markGameComplete('g-2b');
        t.markGameComplete('g-2b');
        expect(restored.isRoundComplete()).toBe(true);
        restored.completeRound();
        t.completeRound();
        expect(clientState(restored)).toEqual(clientState(t));
    });

    test('complete: the results window keeps its winners and completedAt', () => {
        const t = lobby();
        playRound(t, 1, 'g-1', { alice: 100, bob: 50, cy: 100 });
        playRound(t, 2, 'g-2', { alice: 10, bob: 90, cy: 10 });
        playRound(t, 3, 'g-3', { alice: -20, bob: 30, cy: -20 });
        jest.setSystemTime(NOW + 5000);
        playRound(t, 4, 'g-4', { alice: 40, bob: -100, cy: 40 });
        expect(t.phase).toBe('complete');
        expect(t.completedAt).toBe(NOW + 5000);
        const { doc, restored } = roundTrip(t);
        expect(doc.state.completedAt).toBe(NOW + 5000);
        expectSame(t, restored);
        expect(restored.getWinners()).toEqual(['alice', 'cy']);
        expect(restored.completedAt).toBe(NOW + 5000);
    });

    test('missed, aborted and left rounds keep their flags', () => {
        const t = lobby();
        t.startRound(1);
        t.addGameToRound('g-1', ['alice', 'bob'], 2);
        t.recordPlayerRoundScore('alice', { roundNumber: 1, gameId: 'g-1', position: 1, teamScore: 30, oppScore: 0, partner: 'Bot', aborted: true });
        t.recordPlayerRoundScore('bob', { roundNumber: 1, gameId: 'g-1', position: 2, teamScore: 0, oppScore: 30, partner: 'Bot', aborted: true, left: true });
        t.markGameComplete('g-1');
        t.completeRound(); // cy missed it: the round's lowest
        const { restored } = roundTrip(t);
        expectSame(t, restored);
        expect(restored.scoreboard.cy.roundDetails[0]).toMatchObject({ missed: true });
        expect(restored.scoreboard.bob.roundDetails[0]).toMatchObject({ aborted: true, left: true });
    });
});

describe("'starting' rolls back", () => {
    test('round 1 starting is saved as the lobby', () => {
        const t = lobby();
        t.beginStart();
        expect(t.phase).toBe('starting');
        const { doc, restored } = roundTrip(t);
        expect(doc.phase).toBe('lobby');
        expect(doc.state.phase).toBe('lobby');
        expect(restored.phase).toBe('lobby');
        expect(restored.currentRound).toBe(0);
        expect(restored.rounds).toEqual([]);
    });

    test('a later round starting is saved as between rounds', () => {
        const t = lobby();
        playRound(t, 1, 'g-1', { alice: 1, bob: 2, cy: 3 });
        t.readyDeadlineAt = NOW + 1000;
        t.beginStart();
        const { doc, restored } = roundTrip(t);
        expect(doc.phase).toBe('between_rounds');
        expect(restored.phase).toBe('between_rounds');
        expect(restored.currentRound).toBe(1);
        expect(restored.readyDeadlineAt).toBe(NOW + 1000);
    });
});

describe('refusals', () => {
    test.each([
        ['a completed game that is not in its round', (t) => { t.rounds[0].completedGames.add('g-x'); }, 'completedGames'],
        ['currentRound not matching the rounds', (t) => { t.currentRound = 3; }, 'rounds'],
        ['a non-finite score', (t) => { t.scoreboard.bob.totalScore = NaN; }, 'scores'],
        ['a non-finite round score', (t) => { t.scoreboard.bob.roundScores[0] = Infinity; }, 'scores'],
        ['a creator who is not a member', (t) => { t.creatorUsername = 'zed'; }, 'creator'],
        ['an unknown phase', (t) => { t.phase = 'paused'; }, 'phase'],
    ])('%s', (_label, breakIt, reason) => {
        const t = lobby();
        playRound(t, 1, 'g-1', { alice: 1, bob: 2, cy: 3 });
        expect(codec.serialize(t)).not.toBeNull();
        breakIt(t);
        expect(codec.refusal(t)).toBe(reason);
        expect(codec.serialize(t)).toBeNull();
    });

    test('a tournament nobody is left in may keep its old creator name', () => {
        const t = lobby();
        for (const sid of Array.from(t.players.keys())) t.removePlayer(sid);
        expect(codec.refusal(t)).toBeNull();
    });

    test('hydrate refuses another version, a malformed doc and a doc that fails the checks', () => {
        const doc = json(codec.serialize(lobby()));
        expect(() => codec.hydrate({ ...doc, v: 99 })).toThrow(expect.objectContaining({ reason: 'version' }));
        expect(() => codec.hydrate({ ...doc, state: null })).toThrow(expect.objectContaining({ reason: 'malformed' }));
        expect(() => codec.hydrate({ ...doc, state: { ...doc.state, phase: 'starting' } })).toThrow(expect.objectContaining({ reason: 'malformed' }));
        expect(() => codec.hydrate({ ...doc, state: { ...doc.state, currentRound: 2 } })).toThrow(expect.objectContaining({ reason: 'invalid' }));
    });

    test('hydrate refuses a member named twice or without a name (ids are per username)', () => {
        const doc = json(codec.serialize(lobby()));
        const players = doc.state.players;
        expect(() => codec.hydrate({ ...doc, state: { ...doc.state, players: [...players, { username: 'bob', pic: null }] } }))
            .toThrow(expect.objectContaining({ reason: 'malformed' }));
        expect(() => codec.hydrate({ ...doc, state: { ...doc.state, players: [...players, { username: '', pic: null }] } }))
            .toThrow(expect.objectContaining({ reason: 'malformed' }));
        expect(() => codec.hydrate({ ...doc, state: { ...doc.state, players: { alice: {} } } }))
            .toThrow(expect.objectContaining({ reason: 'malformed' }));
    });

    test('chat is capped at maxMessages', () => {
        const t = lobby();
        for (let i = 0; i < 150; i++) t.addMessage('bob', `m${i}`);
        const { doc, restored } = roundTrip(t);
        expect(doc.state.messages).toHaveLength(100);
        expect(restored.messages[99].message).toBe('m149');
    });
});

describe('a real tournament, every phase', () => {
    test('6 players over 4 rounds: each round mid-play, between rounds and the results window', async () => {
        Math.random = mulberry32(41);
        const ctx = await setupTournament(6);
        const check = (label) => {
            const { doc, restored, tableScores } = roundTrip(ctx.t);
            expectSame(ctx.t, restored);
            return { label, doc, tableScores };
        };
        check('lobby');
        const seen = [];
        await playTournament(ctx, {
            round: async (round, c, tables) => {
                await jest.advanceTimersByTimeAsync(20000);
                const { doc, tableScores } = check(`round ${round}`);
                expect(doc.phase).toBe('round_active');
                const live = tables.filter((g) => !g.isTerminal() && g.seatList().length === 4);
                expect(Object.keys(tableScores).sort()).toEqual(live.map((g) => g.gameId).sort());
                for (const g of live) {
                    expect(tableScores[g.gameId].score).toEqual({ team1: g.score.team1, team2: g.score.team2 });
                }
                seen.push(round);
            },
        });
        expect(seen).toEqual([1, 2, 3, 4]);
        expect(ctx.t.phase).toBe('complete');
        const { doc } = check('complete');
        expect(doc.state.completedAt).toBe(ctx.t.completedAt);
        expect(doc.state.completedAt).not.toBeNull();
    }, 120000);
});
