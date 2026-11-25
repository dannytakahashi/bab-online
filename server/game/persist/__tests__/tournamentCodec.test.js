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
        // The host's pick is 1 to 5 (2026-11-25)
        ['no rounds', (t) => { t.totalRounds = 0; }, 'totalRounds'],
        ['six rounds', (t) => { t.totalRounds = 6; }, 'totalRounds'],
        ['a fractional count', (t) => { t.totalRounds = 2.5; }, 'totalRounds'],
        ['a count as a string', (t) => { t.totalRounds = '3'; }, 'totalRounds'],
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

    test('the host\'s round count (1 to 5) round-trips; a doc without one (saved before the picker) is 4', () => {
        for (const n of [1, 2, 3, 5]) {
            const t = lobby();
            expect(t.setTotalRounds(n)).toBe(true);
            const { doc, restored } = roundTrip(t);
            expect(doc.state.totalRounds).toBe(n);
            expect(restored.totalRounds).toBe(n);
            expectSame(t, restored);
        }
        const doc = json(codec.serialize(lobby()));
        delete doc.state.totalRounds;
        expect(codec.hydrate(doc).tournament.totalRounds).toBe(4);
        expect(() => codec.hydrate({ ...doc, state: { ...doc.state, totalRounds: 7 } })).toThrow(expect.objectContaining({ reason: 'invalid' }));
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

describe('v2: Cut for a buck and the final winners (READ_VERSIONS [1, 2])', () => {
    const { CutEngine, cardKey, fullDecks } = require('../../cutForABuck');

    /** The lobby tournament played to its last round, then into a cut at `stage`. */
    function inCut(stage) {
        const t = lobby();
        t.totalRounds = 1;
        playRound(t, 1, 'g-1', { alice: 100, bob: 50, cy: 100 });
        expect(t.phase).toBe('complete');
        expect(t.finalWinners).toEqual(['alice', 'cy']);
        expect(t.finalMembers).toEqual(['alice', 'bob', 'cy']);
        t.phase = 'cut';
        t.completedAt = null;
        t.cut = { stage: 'gather', candidates: ['alice', 'bob', 'cy'], engine: null, strikes: {}, lastReveal: null, result: null, endsAt: null, restoreLine: false };
        if (stage === 'gather') return t;
        // slots 3, 4, 5: alice, bob, cy (A, then K or 2, then 2): a winner or one out
        const order = fullDecks(1);
        const take = (suit, rank) => order.splice(order.findIndex((x) => x.suit === suit && x.rank === rank), 1)[0];
        const front = [take('spades', 'A'), stage === 'winner' ? take('spades', '2') : take('spades', 'K'), take('hearts', '2')];
        order.splice(3, 0, ...front);
        const e = new CutEngine(['alice', 'bob', 'cy'], { deck: order });
        t.cut.engine = e;
        t.cut.strikes = { cy: 1 };
        e.openRound();
        t.cut.stage = 'drawing';
        e.draw('alice', 3);
        if (stage === 'drawing') return t;
        e.draw('bob', 4);
        e.draw('cy', 5);
        const res = e.resolve();
        t.cut.lastReveal = { round: res.round, draws: res.draws, eliminated: res.eliminated, redraw: res.redraw };
        t.cut.stage = res.winner ? 'winner' : 'reveal';
        if (res.winner) t.cut.result = { winner: res.winner, participants: [...e.participants], rounds: e.round };
        return t;
    }

    test('a v1 doc hydrates: no cut, no final snapshot (the winners fall back to getWinners)', () => {
        const t = lobby();
        t.totalRounds = 1;
        playRound(t, 1, 'g-1', { alice: 100, bob: 50, cy: 100 });
        const doc = json(codec.serialize(t));
        expect(doc.v).toBe(2);
        expect(codec.READ_VERSIONS).toEqual([1, 2]);
        // a v1 doc: none of the v2 keys
        const v1 = { ...doc, v: 1, state: { ...doc.state } };
        for (const k of ['finalWinners', 'finalMembers', 'cut', 'cutResult']) delete v1.state[k];
        const { tournament } = codec.hydrate(v1);
        expect(tournament.phase).toBe('complete');
        expect(tournament.finalWinners).toBeNull();
        expect(tournament.finalMembers).toBeNull();
        expect(tournament.cut).toBeNull();
        expect(tournament.cutResult).toBeNull();
        expect(tournament.winnersFinal()).toEqual(['alice', 'cy']);
        expect(tournament.getClientState().winners).toEqual(['alice', 'cy']);
        expect(() => codec.hydrate({ ...doc, v: 3 })).toThrow(expect.objectContaining({ reason: 'version' }));
    });

    test.each(['gather', 'drawing', 'reveal', 'winner'])('the %s stage round-trips (no pending card saved; an open round redrawn)', (stage) => {
        const t = inCut(stage);
        expect(codec.refusal(t)).toBeNull();
        const doc = json(codec.serialize(t));
        expect(doc.phase).toBe('cut');
        expect(Object.keys(doc.state.cut).sort()).toEqual([...codec.SAVED.cut].sort());
        if (doc.state.cut.engine) expect(Object.keys(doc.state.cut.engine).sort()).toEqual([...codec.SAVED.cutEngine].sort());
        expect(JSON.stringify(doc)).not.toContain('pending');
        expect(doc.state.finalWinners).toEqual(['alice', 'cy']);
        const { tournament: r } = codec.hydrate(doc);
        expect(r.phase).toBe('cut');
        expect(r.cut.stage).toBe(stage);
        expect(r.cut.candidates).toEqual(t.cut.candidates);
        expect(r.cut.strikes).toEqual(t.cut.strikes);
        expect(r.cut.lastReveal).toEqual(json(t.cut.lastReveal));
        expect(r.cut.result).toEqual(t.cut.result);
        expect(r.finalWinners).toEqual(t.finalWinners);
        expect(r.finalMembers).toEqual(t.finalMembers);
        if (stage === 'gather') {
            expect(r.cut.engine).toBeNull();
        } else {
            const e = t.cut.engine;
            r.cut.engine.assertValid();
            expect(r.cut.engine.aliveList()).toEqual(e.aliveList());
            expect([...r.cut.engine.table.entries()]).toEqual([...e.table.entries()]);
            expect(r.cut.engine.pending.size).toBe(0);
            const sorted = (cards) => cards.map(cardKey).sort();
            expect(sorted(r.cut.engine.deck)).toEqual(sorted(e.open ? e.openDeck : e.deck));
            expect(r.cut.engine.round).toBe(e.open ? e.round - 1 : e.round);
        }
        // its wire view never names a socket or a pending card
        expect(r.getClientState({ cutCap: true }).cut.stage).toBe(stage);
        expect(r.getClientState().phase).toBe('round_active');
        expect(r.getClientState().cut).toBeUndefined();
    });

    test('field guard: every key of t.cut and of its engine is in SAVED or DERIVED (cut / cutEngine), none in both', () => {
        for (const stage of ['gather', 'drawing', 'reveal', 'winner']) {
            const t = inCut(stage);
            const known = (kind) => new Set([...codec.SAVED[kind], ...codec.DERIVED[kind]]);
            expect(Object.keys(t.cut).filter((k) => !known('cut').has(k))).toEqual([]);
            if (t.cut.engine) expect(Object.keys(t.cut.engine).filter((k) => !known('cutEngine').has(k))).toEqual([]);
        }
        for (const kind of ['cut', 'cutEngine']) expect(codec.SAVED[kind].filter((k) => codec.DERIVED[kind].includes(k))).toEqual([]);
        // and every this.<x> = in the engine is classified
        const src = require('fs').readFileSync(require('path').join(__dirname, '../../cutForABuck.js'), 'utf8');
        const writes = new Set([...src.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1]));
        const known = new Set([...codec.SAVED.cutEngine, ...codec.DERIVED.cutEngine]);
        expect([...writes].filter((k) => !known.has(k))).toEqual([]);
        expect(writes.size).toBeGreaterThan(8);
    });

    test('the complete phase keeps the cut result', () => {
        const t = inCut('winner');
        const result = t.cut.result;
        t.phase = 'complete';
        t.cut = null;
        t.cutResult = result;
        const { doc, restored } = roundTrip(t);
        expect(doc.state.cutResult).toEqual(result);
        expect(restored.cutResult).toEqual(result);
        expect(restored.getClientState({ cutCap: true }).cutForABuck).toEqual(result);
        expect('cutForABuck' in restored.getClientState()).toBe(false);
    });

    test('refusals: a cut outside phase cut, a cut with no engine past the gather, a broken engine, no final snapshot', () => {
        const t = inCut('drawing');
        expect(codec.refusal(t)).toBeNull();
        const save = { ...t.cut };
        t.cut.stage = 'nope';
        expect(codec.refusal(t)).toBe('cut');
        t.cut = { ...save, engine: null };
        expect(codec.refusal(t)).toBe('cut');
        t.cut = save;
        t.cut.engine.deck.pop();
        expect(codec.refusal(t)).toBe('cut');
        expect(codec.serialize(t)).toBeNull();
        const u = inCut('gather');
        u.finalWinners = null;
        expect(codec.refusal(u)).toBe('finalWinners');
        const w = lobby();
        w.cut = { stage: 'gather' };
        expect(codec.refusal(w)).toBe('cut');
        t.cut = null;
        expect(codec.refusal(t)).toBe('cut');
    });
});
