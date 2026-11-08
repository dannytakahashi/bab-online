/**
 * Snapshot v2 fixtures (contract/fixtures/v2/*.json): produced from real
 * handler-driven games, exactly as a client received them
 * (stateSnapshot.snapshot, rejoinSuccess.snapshot, spectatorJoined.snapshot,
 * actionRejected.snapshot). Deterministic: counter uuids, a fixed clock,
 * seeded Math.random per scenario.
 *
 *   npm run contract:fixtures   (UPDATE_CONTRACT_FIXTURES=1) rewrites them
 *   otherwise                   the regenerated snapshots must equal the
 *                               committed files
 *
 * Consumers: client/src/state/snapshotV2.test.js (web parser) today; the
 * iOS XCTest decoder later (contract/README.md).
 */

const fs = require('fs');
const path = require('path');
const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));
jest.mock('uuid', () => {
    let n = 0;
    return {
        v4: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
        __reset: () => { n = 0; },
    };
});

const contract = require('../../../contract');
const { compile } = require('../../../contract/lib/validate');
const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const lobbyHandlers = require('../lobbyHandlers');
const tournamentHandlers = require('../tournamentHandlers');
const snapshotHandlers = require('../snapshotHandlers');
const { Phase } = require('../../game/GamePhase');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { legalCards, mulberry32 } = require('../../testUtils/gameDriver');
const { world } = require('../../testUtils/contractScenarios');
const { advanceUntil, setupTournament, liveTables } = require('../../testUtils/tournamentDriver');

const DIR = path.join(__dirname, '..', '..', '..', 'contract', 'fixtures', 'v2');
const UPDATE = process.env.UPDATE_CONTRACT_FIXTURES === '1';
const CUSTOM_PIC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const validate = compile({ $ref: '#/$defs/snapshotV2' }, contract.schema.$defs);

const captured = new Map(); // name -> fixture

beforeEach(() => {
    require('uuid').__reset();
    jest.useFakeTimers();
    jest.setSystemTime(Date.UTC(2026, 0, 1, 12));
    mockDb.current = createMemoryDb({ users: [] });
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        for (const m of ['error', 'warn', 'info', 'debug']) jest.spyOn(l, m).mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

const realRandom = Math.random;
afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    Math.random = realRandom;
});

afterAll(() => require('../errorHandler').rateLimiter.shutdown());

/** Record a fixture from the snapshot `event` carried to socket `sid`. */
function keep(w, name, description, sid, from, event = 'stateSnapshot') {
    const entry = w.log.slice(from).find((l) => l.to === `self:${sid}` && l.event === event && l.data && l.data.snapshot);
    expect({ name, found: !!entry }).toEqual({ name, found: true });
    const snapshot = JSON.parse(JSON.stringify(entry.data.snapshot));
    expect({ name, errors: validate(snapshot) }).toEqual({ name, errors: [] });
    captured.set(name, { name, description, capturedFrom: event, viewerRole: snapshot.viewer.role, snapshot });
    return snapshot;
}

/** requestSnapshot from `s` and keep the reply. */
function ask(w, s, name, description, data = {}) {
    const from = w.log.length;
    snapshotHandlers.requestSnapshot(s, w.io, data);
    return keep(w, name, description, s.id, from);
}

/** Four (or fewer + bots) players through the real lobby to the open draw. */
async function lobbyTable(w, names, { bots = 0, customPicUser = null } = {}) {
    const socks = names.map((n, i) => w.user(`${w.tag}-h${i + 1}`, n, { pic: 10 + i }));
    if (customPicUser) {
        mockDb.current.users.docs.find((d) => d.username === customPicUser).customProfilePic = CUSTOM_PIC;
    }
    mainRoomHandlers.createLobby(socks[0], w.io, { name: `${w.tag} table` });
    const lobbyId = gameManager.getPlayerLobby(socks[0].id).id;
    for (const s of socks.slice(1)) mainRoomHandlers.joinLobby(s, w.io, { lobbyId });
    for (let i = 0; i < bots; i++) lobbyHandlers.addBot(socks[0], w.io);
    const starting = socks.map((s) => lobbyHandlers.playerReady(s, w.io));
    await jest.advanceTimersByTimeAsync(1500);
    const game = gameManager.getPlayerGame(socks[0].id);
    return { socks, game, starting };
}

async function toBidding(w, t) {
    await jest.advanceTimersByTimeAsync(2000);
    t.draws = t.socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
    await advanceUntil(() => t.game.stage === Phase.BIDDING, 100);
    await jest.advanceTimersByTimeAsync(1500);
}

const owner = (w, game, pos) => w.sockets.get(game.seat(pos).ownerSocketId);

/** The owner of the seat on turn bids `bid`. */
async function bid(w, game, value) {
    const s = owner(w, game, game.currentTurn);
    await gameHandlers.playerBid(s, w.io, { bid: value });
}

/** The seat on turn plays its first legal card (not awaited: tricks pause). */
function play(w, game, pending) {
    const s = owner(w, game, game.currentTurn);
    pending.push(gameHandlers.playCard(s, w.io, { card: legalCards(game, s.id)[0] }));
}

describe('snapshot v2 fixtures from real games', () => {
    test('created-countdown', async () => {
        Math.random = mulberry32(101);
        const w = world('fx-lobby');
        const t = await lobbyTable(w, ['ann', 'bob', 'cat', 'dan']);
        expect(t.game.stage).toBe(Phase.CREATED);
        const s = ask(w, t.socks[2], 'created-countdown', 'An entrant asks during the pre-draw countdown (CREATED): no seats yet, entrants listed, empty draw.');
        expect(s).toMatchObject({ stage: 'CREATED', viewer: { role: 'entrant' }, seats: [], deal: null });
        await jest.advanceTimersByTimeAsync(2500);
        await Promise.all(t.starting);
    });

    test('draw-in-progress', async () => {
        Math.random = mulberry32(102);
        const w = world('fx-draw');
        const t = await lobbyTable(w, ['eve', 'fay', 'gus'], { bots: 1 });
        await jest.advanceTimersByTimeAsync(2000);
        expect(t.game.stage).toBe(Phase.DRAWING);
        await gameHandlers.draw(t.socks[1], w.io, { num: 7 });
        await advanceUntil(() => t.game.drawIndex === 2, 50);
        const s = ask(w, t.socks[1], 'draw-in-progress', 'An entrant who drew asks mid-draw: 2 of 4 cards drawn (one by a bot), no seats yet, viewerDrawOrder set.');
        expect(s.draw.drawn).toHaveLength(2);
        expect(s.draw.drawn.some((d) => d.isBot)).toBe(true);
        expect(s.seats).toEqual([]);
        expect(s.draw.viewerDrawOrder).toBe(1);
        const rest = [t.socks[0], t.socks[2]].map((x) => gameHandlers.draw(x, w.io, { num: 0 }));
        await advanceUntil(() => t.game.stage === Phase.BIDDING, 100);
        await jest.advanceTimersByTimeAsync(2000);
        await Promise.all([...t.starting, ...rest]);
    });

    test('one hand: teams-announced, trick-mid-lead3, spectator-mid-hand, trick-resolving, between-tricks, action-rejected, hand-resolving', async () => {
        Math.random = mulberry32(103);
        const w = world('fx-hand');
        const t = await lobbyTable(w, ['hal', 'ivy', 'jon', 'kim'], { customPicUser: 'kim' });
        const { game } = t;
        await jest.advanceTimersByTimeAsync(2000);
        t.draws = t.socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
        await advanceUntil(() => game.stage === Phase.TEAMS_ANNOUNCED, 50);
        const who = game.seat(2).ownerUsername;
        const back = w.user('fx-hand-r1', who, { db: false });
        const from = w.log.length;
        await reconnectHandlers.rejoinGame(back, w.io, { gameId: game.gameId, username: who });
        const ta = keep(w, 'teams-announced', 'rejoinSuccess.snapshot of a rejoin during TEAMS_ANNOUNCED (v1 renders this window as a half-state; v2 has stage): draw positions filled, no deal yet.', back.id, from, 'rejoinSuccess');
        expect(ta).toMatchObject({ stage: 'TEAMS_ANNOUNCED', deal: null });
        expect(ta.draw.drawn.every((d) => d.position !== null)).toBe(true);
        await advanceUntil(() => game.stage === Phase.BIDDING, 100);
        await jest.advanceTimersByTimeAsync(1500);

        // Bidder is seat 2; seat 3 bids highest and leads
        expect(game.currentTurn).toBe(2);
        await bid(w, game, '1');
        await bid(w, game, '4');
        await bid(w, game, '1');
        await bid(w, game, '2');
        expect(game.stage).toBe(Phase.PLAYING);
        expect(game.currentTurn).toBe(3);
        const pending = [];
        play(w, game, pending);
        play(w, game, pending);
        await jest.advanceTimersByTimeAsync(0);
        const lead3 = ask(w, owner(w, game, 1), 'trick-mid-lead3', 'Seat 1 asks mid-trick: seat 3 led, seat 4 followed; cards in play order.');
        expect(lead3.trick).toMatchObject({ number: 1, leadPosition: 3 });
        expect(lead3.trick.cards.map((c) => c.position)).toEqual([3, 4]);

        const spec = w.user('fx-hand-spec', 'lou');
        const sfrom = w.log.length;
        mainRoomHandlers.joinAsSpectator(spec, w.io, { gameId: game.gameId });
        const sp = keep(w, 'spectator-mid-hand', 'spectatorJoined (full state).snapshot of a spectator joining mid-hand: no hand, no HSI.', spec.id, sfrom, 'spectatorJoined');
        expect(sp).toMatchObject({ viewer: { role: 'spectator' }, hand: null, hsi: null });

        // A play out of turn: actionRejected carries a snapshot without the log and custom pictures
        const notOnTurn = owner(w, game, 2 === game.currentTurn ? 3 : 2);
        const rfrom = w.log.length;
        await gameHandlers.playCard(notOnTurn, w.io, { card: game.getHand(notOnTurn.id)[0] });
        const rej = keep(w, 'action-rejected', 'actionRejected.snapshot after a play out of turn: partial (no log, no custom pictures).', notOnTurn.id, rfrom, 'actionRejected');
        expect(rej.partial).toEqual(expect.arrayContaining(['log', 'customPics']));

        play(w, game, pending);
        play(w, game, pending);
        await jest.advanceTimersByTimeAsync(0);
        expect(game.stage).toBe(Phase.TRICK_RESOLVING);
        const tr = ask(w, spec, 'trick-resolving', 'A spectator asks while the 4th card is on the table (TRICK_RESOLVING): 4 cards, no turn.');
        expect(tr.trick.cards).toHaveLength(4);
        expect(tr.turn).toBeNull();
        await jest.advanceTimersByTimeAsync(2000);
        expect(game.stage).toBe(Phase.PLAYING);
        const bt = ask(w, owner(w, game, 1), 'between-tricks', 'Seat 1 asks between tricks: no card down, no lead; turn = the last trick winner.');
        expect(bt.trick).toMatchObject({ cards: [], leadPosition: null });
        expect(bt.turn.position).toBe(game.currentTurn);

        let guard = 0;
        while (game.stage !== Phase.HAND_RESOLVING && guard++ < 400) {
            if (game.stage === Phase.PLAYING) {
                play(w, game, pending);
                await jest.advanceTimersByTimeAsync(0);
            } else {
                await jest.advanceTimersByTimeAsync(100);
            }
        }
        expect(game.stage).toBe(Phase.HAND_RESOLVING);
        const hr = ask(w, owner(w, game, 4), 'hand-resolving', 'Seat 4 asks after the last trick of the hand (HAND_RESOLVING): no turn, hand empty.');
        expect(hr.turn).toBeNull();
        await jest.advanceTimersByTimeAsync(5000);
        await Promise.all([...pending, ...t.draws, ...t.starting]);
    }, 30000);

    test('bids and lazy: bidding-mid, lazy-at-seat, lazy-watcher', async () => {
        Math.random = mulberry32(104);
        const w = world('fx-bids');
        const t = await lobbyTable(w, ['max', 'ned', 'ora', 'pat']);
        await toBidding(w, t);
        const { game } = t;
        await bid(w, game, 'B');
        await bid(w, game, '1');
        const bm = ask(w, owner(w, game, game.currentTurn), 'bidding-mid', 'The seat on turn asks with 2 bids in (one a bore): multipliers so far, no team bids yet.');
        expect(bm.bids.byPosition.filter((b) => b !== null)).toHaveLength(2);
        expect(Math.max(bm.bids.mults.team1, bm.bids.mults.team2)).toBe(2);
        expect(bm.bids.teamBids).toBeNull();
        expect(bm.turn.action).toBe('bid');

        const lazyPos = game.currentTurn === 1 ? 2 : 1;
        chatHandlers.chatMessage(owner(w, game, lazyPos), w.io, { message: '/lazy' });
        const la = ask(w, owner(w, game, lazyPos), 'lazy-at-seat', 'A /lazy owner still at the seat asks: lazyWatcher in seat view, hand shown.');
        expect(la.viewer).toMatchObject({ role: 'lazyWatcher', ownerView: 'seat' });

        const watchPos = [1, 2, 3, 4].find((p) => p !== lazyPos && game.seat(p).controller === 'human');
        chatHandlers.chatMessage(owner(w, game, watchPos), w.io, { message: '/lazy' });
        const who = game.seat(watchPos).ownerUsername;
        const back = w.user('fx-bids-r1', who, { db: false });
        const from = w.log.length;
        await reconnectHandlers.rejoinGame(back, w.io, { gameId: game.gameId, username: who });
        const lw = keep(w, 'lazy-watcher', 'rejoinSuccess.snapshot of a /lazy owner rejoining from another socket: lazyWatcher in watch view with the seat hand.', back.id, from, 'rejoinSuccess');
        expect(lw.viewer).toMatchObject({ role: 'lazyWatcher', ownerView: 'watch' });
        expect(lw.hand.length).toBeGreaterThan(0);
        await jest.advanceTimersByTimeAsync(3000);
        await Promise.all([...t.draws, ...t.starting]);
    }, 30000);

    test('presence-mixed', async () => {
        Math.random = mulberry32(105);
        const w = world('fx-pres');
        const t = await lobbyTable(w, ['quin', 'rae', 'sid', 'tess']);
        await toBidding(w, t);
        const { game } = t;
        const asker = owner(w, game, 4);
        await w.kill(owner(w, game, 1));
        await jest.advanceTimersByTimeAsync(61000);
        expect(game.seat(1).presence).toBe('resignable');
        await w.kill(owner(w, game, 2));
        chatHandlers.chatMessage(owner(w, game, 3), w.io, { message: '/lazy' });
        const pm = ask(w, asker, 'presence-mixed', 'Seat 4 asks with seat 1 resignable (offered), seat 2 in reconnect grace and seat 3 lazy.');
        expect(pm.seats.map((s) => [s.presence, s.controller, s.offered, s.lazy])).toEqual([
            ['resignable', 'human', true, false],
            ['grace', 'human', false, false],
            ['connected', 'lazyBot', false, true],
            ['connected', 'human', false, false],
        ]);
        await jest.advanceTimersByTimeAsync(1000);
        await Promise.all([...t.draws, ...t.starting]);
    }, 30000);

    test('tournament-game', async () => {
        Math.random = mulberry32(106);
        const ctx = await setupTournament(1);
        ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
        await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t)[0].stage === Phase.BIDDING, 100, 60000);
        await ctx.starting;
        const w = { log: ctx.log, io: ctx.io };
        const from = ctx.log.length;
        snapshotHandlers.requestSnapshot(ctx.sockets[0], ctx.io, {});
        const tg = keep(w, 'tournament-game', 'The human at a round-1 tournament table asks during bidding: tournament info filled in.', ctx.sockets[0].id, from);
        expect(tg.tournament).toMatchObject({ roundNumber: 1, totalRounds: 4 });
        expect(tg.stage).toBe('BIDDING');
    }, 30000);

    test('the committed fixtures are what the server produces (run npm run contract:fixtures)', () => {
        const names = [...captured.keys()].sort();
        expect(names).toEqual(['action-rejected', 'between-tricks', 'bidding-mid', 'created-countdown', 'draw-in-progress',
            'hand-resolving', 'lazy-at-seat', 'lazy-watcher', 'presence-mixed', 'spectator-mid-hand', 'teams-announced',
            'tournament-game', 'trick-mid-lead3', 'trick-resolving']);
        const index = names.map((n) => {
            const f = captured.get(n);
            return { name: n, file: `${n}.json`, description: f.description, capturedFrom: f.capturedFrom, viewerRole: f.viewerRole, stage: f.snapshot.stage };
        });
        const files = { 'index.json': JSON.stringify({ snapshotVersion: 2, fixtures: index }, null, 2) + '\n' };
        for (const n of names) files[`${n}.json`] = JSON.stringify(captured.get(n), null, 2) + '\n';
        if (UPDATE) {
            fs.mkdirSync(DIR, { recursive: true });
            for (const f of fs.readdirSync(DIR)) if (!files[f]) fs.unlinkSync(path.join(DIR, f));
            for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(DIR, f), content);
            return;
        }
        const stale = Object.entries(files).filter(([f, content]) => {
            const p = path.join(DIR, f);
            return !fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== content;
        }).map(([f]) => f);
        const extra = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => !files[f]) : [];
        if (stale.length || extra.length) {
            throw new Error(`contract/fixtures/v2 is out of date (${[...stale, ...extra].join(', ')}): run npm run contract:fixtures`);
        }
    });
});
