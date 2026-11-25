/**
 * Partner rotation through the real tournament handlers (owner 2026-11-24;
 * game/tournamentPartners.js): every table's draw seats the round's planned
 * teams (positions 1&3 and 2&4), the wire is the ordinary draw, and over the
 * four rounds no member partners the human of their last played round
 * again; a member who drops sits a round out and comes back with their
 * history.
 */

'use strict';

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const tournamentHandlers = require('../tournamentHandlers');
const chatHandlers = require('../chatHandlers');
const gameLifecycle = require('../gameLifecycle');
const pacing = require('../../game/pacing');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { setupTournament, playTournament, kill, newUser, liveTables, advanceUntil } = require('../../testUtils/tournamentDriver');
const { mulberry32 } = require('../../testUtils/gameDriver');

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
    require('../../game/bot').botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

const sortTeams = (teams) => teams.map((t) => [...t].sort()).sort((a, b) => a.join().localeCompare(b.join()));

/** The members seated as partners at a table: [[pos 1 & 3], [pos 2 & 4]], members only. */
function seatedTeams(game, members) {
    const name = (pos) => game.getOriginalPlayer(pos)?.username;
    return [[1, 3], [2, 4]].map((ps) => ps.map(name).filter((u) => members.includes(u)));
}

/** The round entry's planned teams, without the bots. */
function plannedTeams(t, game) {
    return t.roundOfGame(game.gameId).games.get(game.gameId).teams.map((team) => team.filter(Boolean));
}

/** Per round: each member's human partner (null: a bot), from the seats. */
function recordRound(rounds, game, members) {
    const round = rounds[rounds.length - 1];
    for (const team of seatedTeams(game, members)) {
        for (const u of team) round.set(u, team.find((v) => v !== u) ?? null);
    }
}

/** No member partners the human of their last played round. */
function expectNoBackToBack(rounds) {
    const last = new Map();
    for (const round of rounds) {
        for (const [u, partner] of round) {
            if (partner) expect(last.get(u)).not.toBe(partner);
        }
        for (const [u, partner] of round) last.set(u, partner);
    }
}

describe('the draw seats the planned teams', () => {
    test.each([
        [3, 1], [4, 2], [5, 3], [6, 4], [8, 5],
    ])('%i members over 4 rounds (seed %i)', async (n, seed) => {
        Math.random = mulberry32(seed);
        const ctx = await setupTournament(n);
        const rounds = [];
        const startDraws = [];
        await playTournament(ctx, {
            round: async (round, c, tables) => {
                rounds.push(new Map());
                for (const g of tables) {
                    expect(sortTeams(seatedTeams(g, ctx.usernames))).toEqual(sortTeams(plannedTeams(ctx.t, g)));
                    recordRound(rounds, g, ctx.usernames);
                    // The draw on the wire: four playerDrew and one teamsAnnounced
                    const room = ctx.log.filter((e) => e.to === g.roomName);
                    expect(room.filter((e) => e.event === 'playerDrew')).toHaveLength(4);
                    const announced = room.filter((e) => e.event === 'teamsAnnounced');
                    startDraws.push(room.filter((e) => e.event === 'startDraw').length);
                    if (announced.length) {
                        const { team1, team2 } = announced[0].data;
                        expect(team1).toEqual([1, 3].map((p) => g.getPlayerByPosition(p).username));
                        expect(team2).toEqual([2, 4].map((p) => g.getPlayerByPosition(p).username));
                    }
                }
            },
        });
        expect(ctx.t.phase).toBe('complete');
        expect(rounds).toHaveLength(4);
        expect(startDraws.every((k) => k === 1)).toBe(true);
        expectNoBackToBack(rounds);
        // Partnerships repeat only where the field forces it (3: once, 4: twice)
        const counts = ctx.t.partnerHistory().counts;
        const repeats = [...counts.values()].reduce((s, k) => s + (k - 1), 0);
        expect(repeats).toBe({ 3: 1, 4: 2 }[n] ?? 0);
        // Every member played every round
        for (const round of rounds) expect(round.size).toBe(n);
    }, 180000);
});

describe('a member who drops sits a round out and comes back with their history', () => {
    test('5 members: one drops in round 1, misses round 2, returns for rounds 3 and 4', async () => {
        Math.random = mulberry32(77);
        const ctx = await setupTournament(5);
        const dropper = ctx.sockets[1];
        const dropperName = ctx.usernames[1];
        const rounds = [];
        await playTournament(ctx, {
            round: async (round, c, tables) => {
                rounds.push(new Map());
                for (const g of tables) {
                    expect(sortTeams(seatedTeams(g, ctx.usernames))).toEqual(sortTeams(plannedTeams(ctx.t, g)));
                    recordRound(rounds, g, ctx.usernames);
                }
                if (round === 1) {
                    chatHandlers.chatMessage(dropper, ctx.io, { message: '/lazy' });
                    await kill(ctx.io, dropper);
                }
                if (round === 2) {
                    expect(rounds[1].has(dropperName)).toBe(false);
                    const back = newUser(ctx.io, ctx.log, dropperName);
                    await tournamentHandlers.joinTournament(back, ctx.io, { tournamentId: ctx.t.tournamentId });
                    expect(ctx.t.getPlayerByUsername(dropperName).connected).not.toBe(false);
                    ctx.sockets.push(back);
                }
            },
        });
        expect(ctx.t.phase).toBe('complete');
        expect(rounds.map((r) => r.has(dropperName))).toEqual([true, false, true, true]);
        expectNoBackToBack(rounds);
        // With 5 members (one pair a round) no partnership ever repeats
        expect([...ctx.t.partnerHistory().counts.values()].every((k) => k === 1)).toBe(true);
        // Round 3: the dropper's last played round was round 1
        const r1 = rounds[0].get(dropperName);
        if (r1) expect(rounds[2].get(dropperName)).not.toBe(r1);
    }, 180000);
});

describe('a table aborted before its draw adds no partnership', () => {
    // A test that acts inside the countdown needs it (BAB_PACING=zero has none)
    const inWindow = (ms) => (ms > 0 ? test : test.skip);
    inWindow(pacing().TABLE_COUNTDOWN_MS)('7 members: the 3-member table aborts in the countdown; its pair stays unpartnered', async () => {
        Math.random = mulberry32(11);
        const ctx = await setupTournament(7);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await jest.advanceTimersByTimeAsync(2000);
        const tables = liveTables(ctx.t);
        expect(tables).toHaveLength(2);
        const three = tables.find((g) => ctx.t.roundOfGame(g.gameId).games.get(g.gameId).humanPlayers.length === 3);
        const [pair] = plannedTeams(ctx.t, three).filter((team) => team.length === 2);
        expect(three.seatList()).toHaveLength(0);
        await gameLifecycle.abortGame(ctx.io, three, 'test');
        await jest.advanceTimersByTimeAsync(10000);
        await ctx.starting;
        const h = ctx.t.partnerHistory();
        expect(h.counts.has(require('../../game/tournamentPartners').pairKey(...pair))).toBe(false);
        expect(h.last.has(pair[0])).toBe(false);
        // The 4-member table's two pairs count
        expect(h.counts.size).toBe(2);
    }, 60000);
});

// ==================== honest draws (owner 2026-11-25) ====================
// Every human and spectator at a planned table sends the clientHello cap
// tournamentPairings: the teams go out on startDraw, each player gets the
// card they picked, and the draw decides only the seats and the first deal.

const gameHandlers = require('../gameHandlers');
const GameState = require('../../game/GameState');
const contract = require('../../../contract');
const { compile } = require('../../../contract/lib/validate');
const { drawBeats } = require('../../game/rules');
const { Phase } = require('../../game/GamePhase');

const WEB_CAPS = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'tournamentVoice', 'tournamentPairings'];
const OLD_WEB_CAPS = WEB_CAPS.filter((c) => c !== 'tournamentPairings');
const IOS_40_CAPS = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'tournamentVoice'];
const validateSnapshot = compile({ $ref: '#/$defs/snapshotV2' }, contract.schema.$defs);
const inCountdown = (pacing().TABLE_COUNTDOWN_MS > 0 ? test : test.skip);

function hello(socket, caps, client = 'web') {
    if (caps === null) delete socket.data.client;
    else socket.data.client = { client, version: '1', build: null, caps };
}

/** Every recordDraw: who asked for which index and what card was there just then. */
function watchDraws() {
    const draws = [];
    const real = GameState.prototype.recordDraw;
    jest.spyOn(GameState.prototype, 'recordDraw').mockImplementation(function (socketId, index, username) {
        const before = this.deck ? [...this.deck.cards] : [];
        let asked = null;
        if (index != null && before.length) asked = before[Math.max(0, Math.min(before.length - 1, Math.floor(Number(index))))];
        const d = real.call(this, socketId, index, username);
        if (d) draws.push({ gameId: this.gameId, socketId, index, asked, before, card: d.card });
        return d;
    });
    return draws;
}

/** Begin round 1 and stop as soon as every table is drawing (nobody may have drawn yet). */
async function toDraw(ctx) {
    ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
    await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t).every((g) => g.stage !== Phase.CREATED), 10, 20000);
    return liveTables(ctx.t);
}

const roomEvents = (ctx, g, event) => ctx.log.filter((e) => e.to === g.roomName && e.event === event);
const teamNames = (t, g) => t.roundOfGame(g.gameId).games.get(g.gameId).teams;

/** The humans at `g` draw now, each a different index; returns {socketId: index}. */
function humansDraw(ctx, g) {
    const picks = {};
    let num = 7;
    for (const s of ctx.sockets) {
        if (!g.entrant(s.id) || g.drawIDs.includes(s.id)) continue;
        picks[s.id] = num;
        gameHandlers.draw(s, ctx.io, { num });
        num += 11;
    }
    return picks;
}

async function toDeal(ctx, tables) {
    await advanceUntil(() => tables.every((g) => g.isTerminal() || [Phase.BIDDING, Phase.PLAYING].includes(g.stage)), 100, 60000);
    await ctx.starting;
}

describe('honest draw: every member has the cap', () => {
    test.each([[4, 31], [3, 32], [2, 33], [8, 34]])('%i members: the card picked, the plan seated, the highest card deals (seed %i)', async (n, seed) => {
        Math.random = mulberry32(seed);
        const ctx = await setupTournament(n);
        for (const s of ctx.sockets) hello(s, WEB_CAPS);
        const draws = watchDraws();
        const tables = await toDraw(ctx);
        const snapshots = [];
        for (const g of tables) {
            expect(g.drawHonest).toBe(true);
            // startDraw: the teams by name, bots by persona, plan order
            const [start] = roomEvents(ctx, g, 'startDraw');
            const planned = teamNames(ctx.t, g);
            expect(start.data.teams.map((t) => t.map((p) => (p.isBot ? null : p.username)))).toEqual(planned);
            for (const p of start.data.teams.flat()) {
                expect(Object.keys(p).sort()).toEqual(['isBot', 'username']);
                if (p.isBot) expect(p.username).toMatch(/^🤖 /);
            }
            // the system line, stored and broadcast once
            const lines = roomEvents(ctx, g, 'gameLogEntry').filter((e) => /^Partners this round: /.test(e.data.message));
            expect(lines).toHaveLength(1);
            expect(lines[0].data.message).toBe(`Partners this round: ${start.data.teams.map((t) => t.map((p) => p.username).join(' & ')).join(' vs ')}. The draw decides who deals first.`);
            expect(g.gameLog.filter((l) => /^Partners this round: /.test(l.message))).toHaveLength(1);
            expect(lines[0].data.message).not.toMatch(/Team [12]|T[12]\b/);
            const picks = humansDraw(ctx, g);
            for (const [sid, num] of Object.entries(picks)) {
                const d = draws.find((x) => x.gameId === g.gameId && x.socketId === sid);
                expect(d.index).toBe(num);
                expect(d.card).toEqual(d.before[num]);
                const you = ctx.log.filter((e) => e.to === `self:${sid}` && e.event === 'youDrew').pop();
                expect(you.data.card).toEqual(d.before[num]);
                expect(roomEvents(ctx, g, 'playerDrew').find((e) => e.data.drawOrder === you.data.drawOrder).data.card).toEqual(d.before[num]);
            }
            expect(g.drawPlan).toBeNull();
        }
        // bots draw their own index; the snapshot during the reveal
        await advanceUntil(() => tables.every((g) => g.drawIDs.length === 4), 50, 20000);
        for (const g of tables) {
            for (const d of draws.filter((x) => x.gameId === g.gameId)) {
                if (d.index != null) expect(d.card).toEqual(d.asked);
                else expect(d.before).toContainEqual(d.card);
            }
            expect(g.drawPlan).toBeNull();
            const sid = ctx.sockets.find((s) => g.entrant(s.id))?.id;
            snapshots.push({ g, snap: g.getSnapshotV2(sid) });
        }
        await toDeal(ctx, tables);
        for (const { g, snap } of snapshots) {
            expect(validateSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual([]);
            expect(snap.draw.teams).toHaveLength(2);
            for (const t of snap.draw.teams) expect(t).toHaveLength(2);
            // seats from the plan, partners opposite
            expect(sortTeams(seatedTeams(g, ctx.usernames))).toEqual(sortTeams(plannedTeams(ctx.t, g)));
            // seat 1 holds the highest of the four cards, and deals first
            const drawn = roomEvents(ctx, g, 'playerDrew').map((e) => e.data);
            const cards = drawn.map((d) => d.card);
            const top = drawn.find((d) => drawBeats(d.card, cards) === 3);
            expect(g.getOriginalPlayer(1).username).toBe(top.username);
            const first = ctx.log.find((e) => e.event === 'gameStart' && e.data.gameId === g.gameId);
            if (first) expect(first.data.dealer).toBe(1);
            // the snapshot's positions are the seats
            for (const d of snap.draw.drawn) expect(g.getPlayerByPosition(d.position).username).toBe(d.username);
            // the draw state is gone with the deal
            expect([g.drawTeams, g.drawPlan, g.drawTeamsWire, g.drawHonest]).toEqual([null, null, null, false]);
        }
    }, 120000);

    test('the watchdog\'s auto-draw takes a card off the real deck', async () => {
        Math.random = mulberry32(41);
        const ctx = await setupTournament(4);
        for (const s of ctx.sockets) hello(s, WEB_CAPS);
        const draws = watchDraws();
        const [g] = await toDraw(ctx);
        expect(g.drawHonest).toBe(true);
        await advanceUntil(() => g.drawIDs.length === 4, 500, 40000);
        const auto = draws.filter((d) => d.gameId === g.gameId && d.index == null);
        expect(auto).toHaveLength(4);
        for (const d of auto) {
            expect(d.before).toContainEqual(d.card);
            expect(g.drawCards).toContainEqual(d.card);
        }
        expect(g.drawPlan).toBeNull();
        await toDeal(ctx, [g]);
        expect(sortTeams(seatedTeams(g, ctx.usernames))).toEqual(sortTeams(plannedTeams(ctx.t, g)));
    }, 120000);
});

describe('staged draw: someone at the table cannot show a draw for first deal', () => {
    const variants = [
        ['iOS 1.2.6 (40) caps', (s) => hello(s, IOS_40_CAPS, 'ios')],
        ['no clientHello (iOS 1.2.0 era, chaos, recordings)', (s) => hello(s, null)],
        ['an old web tab', (s) => hello(s, OLD_WEB_CAPS)],
    ];
    test.each(variants)('3 cap members + one with %s', async (_label, legacy) => {
        Math.random = mulberry32(51);
        const ctx = await setupTournament(4);
        ctx.sockets.forEach((s, i) => (i === 2 ? legacy(s) : hello(s, WEB_CAPS)));
        const draws = watchDraws();
        const [g] = await toDraw(ctx);
        expect(g.drawHonest).toBe(false);
        // the teams still go out (a cap client shows the first-deal copy), no log line
        expect(roomEvents(ctx, g, 'startDraw')[0].data.teams.map((t) => t.map((p) => p.username))).toEqual(teamNames(ctx.t, g));
        expect(roomEvents(ctx, g, 'gameLogEntry').filter((e) => /^Partners this round/.test(e.data.message))).toEqual([]);
        humansDraw(ctx, g);
        expect(g.drawPlan.size).toBe(4);
        // the planned cards, not the ones asked for
        for (const d of draws.filter((x) => x.gameId === g.gameId)) expect(d.card).toBe(g.drawPlan.get(d.socketId));
        await toDeal(ctx, [g]);
        expect(sortTeams(seatedTeams(g, ctx.usernames))).toEqual(sortTeams(plannedTeams(ctx.t, g)));
    }, 120000);

    inCountdown('a legacy spectator present at beginDraw', async () => {
        Math.random = mulberry32(52);
        const ctx = await setupTournament(4);
        for (const s of ctx.sockets) hello(s, WEB_CAPS);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0, 10, 20000);
        const [g] = liveTables(ctx.t);
        expect(g.stage).toBe(Phase.CREATED);
        const watcher = newUser(ctx.io, ctx.log, `${ctx.usernames[0]}_w`);
        hello(watcher, IOS_40_CAPS, 'ios');
        g.addSpectator(watcher.id, `${ctx.usernames[0]}_w`, 3);
        await advanceUntil(() => g.stage !== Phase.CREATED, 10, 20000);
        expect(g.drawHonest).toBe(false);
        // a cap spectator would not have mattered
        g.removeSpectator?.(watcher.id);
        await toDeal(ctx, [g]);
        expect(sortTeams(seatedTeams(g, ctx.usernames))).toEqual(sortTeams(plannedTeams(ctx.t, g)));
    }, 120000);

    inCountdown('a cap spectator does not stage it', async () => {
        Math.random = mulberry32(53);
        const ctx = await setupTournament(4);
        for (const s of ctx.sockets) hello(s, WEB_CAPS);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0, 10, 20000);
        const [g] = liveTables(ctx.t);
        const watcher = newUser(ctx.io, ctx.log, `${ctx.usernames[0]}_w`);
        hello(watcher, WEB_CAPS);
        g.addSpectator(watcher.id, `${ctx.usernames[0]}_w`, 3);
        await advanceUntil(() => g.stage !== Phase.CREATED, 10, 20000);
        expect(g.drawHonest).toBe(true);
        await toDeal(ctx, [g]);
    }, 120000);

    inCountdown('an entrant disconnected at beginDraw', async () => {
        Math.random = mulberry32(54);
        const ctx = await setupTournament(4);
        for (const s of ctx.sockets) hello(s, WEB_CAPS);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0, 10, 20000);
        const [g] = liveTables(ctx.t);
        await kill(ctx.io, ctx.sockets[3]);
        expect(g.entrant(ctx.sockets[3].id).presence).toBe('disconnected');
        await advanceUntil(() => g.stage !== Phase.CREATED, 10, 20000);
        expect(g.drawHonest).toBe(false);
        expect(g.drawPlan.size).toBe(4); // the dropped entrant was auto-drawn at once, from the plan
        await toDeal(ctx, [g]);
        expect(sortTeams(seatedTeams(g, ctx.usernames))).toEqual(sortTeams(plannedTeams(ctx.t, g)));
    }, 120000);

    test.each(['off', 'false', '0', 'disabled', 'no'])('TOURNAMENT_HONEST_DRAW=%s', async (v) => {
        Math.random = mulberry32(55);
        process.env.TOURNAMENT_HONEST_DRAW = v;
        try {
            const ctx = await setupTournament(4);
            for (const s of ctx.sockets) hello(s, WEB_CAPS);
            const [g] = await toDraw(ctx);
            expect(g.drawHonest).toBe(false);
            expect(roomEvents(ctx, g, 'startDraw')[0].data.teams).toHaveLength(2);
            await toDeal(ctx, [g]);
            expect(sortTeams(seatedTeams(g, ctx.usernames))).toEqual(sortTeams(plannedTeams(ctx.t, g)));
        } finally {
            delete process.env.TOURNAMENT_HONEST_DRAW;
        }
    }, 120000);

    test('drawTeams set without beginDraw\'s decision is staged (the flag defaults to staged)', () => {
        const g = new GameState('direct-api');
        g.initEntrants(IDS4.map((socketId, i) => ({ socketId, username: `u${i}`, isBot: false })));
        g.drawTeams = [[IDS4[0], IDS4[1]], [IDS4[2], IDS4[3]]];
        g.forcePhase('DRAWING');
        g.deck = new (require('../../game/Deck'))();
        g.deck.shuffle();
        for (const id of IDS4) g.recordDraw(id, 0, id);
        expect(g.drawPlan.size).toBe(4);
        for (let i = 0; i < 4; i++) expect(g.drawCards[i]).toBe(g.drawPlan.get(IDS4[i]));
        const pos = g.drawPositions();
        expect([[pos[0], pos[1]].sort().join(), [pos[2], pos[3]].sort().join()].sort()).toEqual(['1,3', '2,4']);
    });
});

const IDS4 = ['s-a', 's-b', 's-c', 's-d'];

describe('tables and games without a plan are unchanged', () => {
    test('a 1-member table: an ordinary draw, no teams, no log line, no pairings', async () => {
        Math.random = mulberry32(61);
        const ctx = await setupTournament(1);
        hello(ctx.sockets[0], WEB_CAPS);
        const [g] = await toDraw(ctx);
        expect(g.drawTeams).toBeNull();
        expect(roomEvents(ctx, g, 'startDraw')[0].data).toEqual({ start: true, seq: expect.any(Number) });
        expect(roomEvents(ctx, g, 'gameLogEntry').filter((e) => /^Partners/.test(e.data.message))).toEqual([]);
        for (const e of ctx.log.filter((x) => /^tournament/.test(x.event))) expect(e.data && 'pairings' in e.data).toBeFalsy();
        await toDeal(ctx, [g]);
    }, 60000);
});

describe('pairings on the tournament events', () => {
    test('round start carries the plan; gameComplete / roundComplete / joined carry the history; the lobby none', async () => {
        Math.random = mulberry32(71);
        const ctx = await setupTournament(5);
        for (const s of ctx.sockets) hello(s, WEB_CAPS);
        // lobby phase: no key
        const lobbyState = ctx.t.getClientState();
        expect('pairings' in lobbyState).toBe(false);
        const rounds = [];
        await playTournament(ctx, {
            round: async (round, c, tables) => {
                const start = ctx.log.filter((e) => e.event === 'tournamentRoundStart').pop().data;
                expect(start.roundNumber).toBe(round);
                const planned = start.pairings.find((r) => r.roundNumber === round);
                expect(planned.tables.every((t) => t.gameId === null)).toBe(true);
                // the plan is what the tables were given
                expect(sortTeams(planned.tables.flatMap((t) => t.teams.map((team) => team.filter(Boolean)))))
                    .toEqual(sortTeams(tables.flatMap((g) => plannedTeams(ctx.t, g))));
                expect(start.pairings.map((r) => r.roundNumber)).toEqual(Array.from({ length: round }, (_, i) => i + 1));
                rounds.push(tables.map((g) => ({ gameId: g.gameId, teams: teamNames(ctx.t, g) })));
            },
        });
        const complete = ctx.log.filter((e) => e.event === 'tournamentComplete').pop().data;
        expect(complete.pairings.map((r) => r.tables)).toEqual(rounds);
        const roundComplete = ctx.log.filter((e) => e.event === 'tournamentRoundComplete');
        expect(roundComplete.length).toBe(3);
        roundComplete.forEach((e, i) => expect(e.data.pairings).toHaveLength(i + 1));
        const gameComplete = ctx.log.filter((e) => e.event === 'tournamentGameComplete');
        expect(gameComplete.length).toBeGreaterThan(0);
        for (const e of gameComplete) expect(Array.isArray(e.data.pairings)).toBe(true);
        expect(ctx.t.getClientState().pairings).toEqual(complete.pairings);
        // a spectator's joined state too
        const watcher = newUser(ctx.io, ctx.log, `${ctx.usernames[0]}_spec`);
        await tournamentHandlers.spectateTournament(watcher, ctx.io, { tournamentId: ctx.t.tournamentId });
        const joined = ctx.log.filter((e) => e.event === 'tournamentJoined' && e.to === `self:${watcher.id}`).pop();
        if (joined) expect(joined.data.pairings).toEqual(complete.pairings);
    }, 240000);

    inCountdown('a member who leaves during the announce is null in tournamentGameComplete; a table aborted in the countdown is absent', async () => {
        Math.random = mulberry32(72);
        const ctx = await setupTournament(7);
        for (const s of ctx.sockets) hello(s, WEB_CAPS);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => ctx.log.some((e) => e.event === 'tournamentRoundStart'), 10, 1000);
        const start = ctx.log.filter((e) => e.event === 'tournamentRoundStart').pop().data;
        const four = start.pairings[0].tables.find((t) => t.teams.flat().every(Boolean));
        const leaver = four.teams[0][0];
        const leaverSocket = ctx.sockets[ctx.usernames.indexOf(leaver)];
        await tournamentHandlers.leaveTournament(leaverSocket, ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length === 2, 10, 20000);
        const tables = liveTables(ctx.t);
        const fourTable = tables.find((g) => teamNames(ctx.t, g).flat().includes(four.teams[1][0]));
        expect(teamNames(ctx.t, fourTable).flat()).toContain(null);
        expect(teamNames(ctx.t, fourTable).flat()).not.toContain(leaver);
        const other = tables.find((g) => g !== fourTable);
        await gameLifecycle.abortGame(ctx.io, other, 'test');
        const gc = ctx.log.filter((e) => e.event === 'tournamentGameComplete').pop().data;
        const r1 = gc.pairings[0];
        expect(r1.tables.map((t) => t.gameId)).toEqual([fourTable.gameId]);
        expect(r1.tables[0].teams.flat()).not.toContain(leaver);
        await jest.advanceTimersByTimeAsync(10000);
        await ctx.starting;
    }, 60000);
});
