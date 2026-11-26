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
const pacing = require('../../game/pacing');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { legalCards, mulberry32, events } = require('../../testUtils/gameDriver');
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
    delete process.env.BID_CLOCK;
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

// The over-the-shoulder view's payloads, as the watcher got them
// (contract/fixtures/shoulder/events.json; docs/claude/spectators.md
// "Over-the-shoulder view"): one of each, schema-checked
const SHOULDER_DIR = path.join(__dirname, '..', '..', '..', 'contract', 'fixtures', 'shoulder');
let shoulderEvents = null;
// A tournament table's draw for first deal (contract/fixtures/pairings/events.json)
const PAIRINGS_DIR = path.join(__dirname, '..', '..', '..', 'contract', 'fixtures', 'pairings');
let pairingsEvents = null;
// Cut for a buck (contract/fixtures/cut/events.json; kept out of fixtures/v2,
// whose count iOS TableSnapshotDecodingTests pins)
const CUT_DIR = path.join(__dirname, '..', '..', '..', 'contract', 'fixtures', 'cut');
let cutEvents = null;
function captureEvents(wire) {
    const out = [];
    for (const [event, entry] of Object.entries(wire)) {
        if (event === 'watchHand') {
            expect({ event, errors: contract.validateC2S(event, entry).errors }).toEqual({ event, errors: [] });
            out.push({ direction: 'c2s', event, data: entry });
            continue;
        }
        expect({ event, found: !!entry }).toEqual({ event, found: true });
        const data = JSON.parse(JSON.stringify(entry.data));
        expect({ event, errors: contract.validateS2C(event, data).errors }).toEqual({ event, errors: [] });
        out.push({ direction: 's2c', event, to: String(entry.to).startsWith('self:') ? 'self' : 'socket', data });
    }
    shoulderEvents = { description: 'The over-the-shoulder view on the wire (clientHello cap shoulderView), one of each, from a real game: the watcher\'s watchHand, its stateSnapshot reply (reason watchHand), a refusal (own_seat: a seat owner\'s second tab), the watched seat\'s /help answer mirrored (assistHint watched), the wide spectatorsUpdated (shoulder on the entry) and the next deal\'s spectator gameStart (shoulder). Rewrite with npm run contract:fixtures.', events: out };
}

/** requestSnapshot from `s` (custom pictures opted in) and keep the reply. */
function ask(w, s, name, description, data = { customPics: true }) {
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
    await jest.advanceTimersByTimeAsync(pacing().LOBBY_START_MS);
    const game = gameManager.getPlayerGame(socks[0].id);
    return { socks, game, starting };
}

async function toBidding(w, t) {
    await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
    t.draws = t.socks.map((s) => gameHandlers.draw(s, w.io, { num: 0 }));
    await advanceUntil(() => t.game.stage === Phase.BIDDING, 100);
    await jest.advanceTimersByTimeAsync(pacing().FIRST_HAND_TURN_MS + 500);
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
        await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
        expect(t.game.stage).toBe(Phase.DRAWING);
        // Bot entrants are named before they draw: the name playerDrew shows
        const early = snapshotHandlers.snapshotFor(t.game, t.socks[0].id);
        const botEntrant = early.entrants.find((e) => e.isBot);
        expect(botEntrant.username).toMatch(/^🤖 /);
        await gameHandlers.draw(t.socks[1], w.io, { num: 7 });
        await advanceUntil(() => t.game.drawIndex === 2, 50);
        const s = ask(w, t.socks[1], 'draw-in-progress', 'An entrant who drew asks mid-draw: 2 of 4 cards drawn (one by a bot), no seats yet, viewerDrawOrder set.');
        expect(s.draw.drawn).toHaveLength(2);
        expect(s.draw.drawn.some((d) => d.isBot)).toBe(true);
        expect(s.entrants.find((e) => e.isBot).username).toBe(botEntrant.username);
        expect(s.draw.drawn.find((d) => d.isBot).username).toBe(botEntrant.username);
        expect(events(w.log, 'playerDrew').find((l) => l.data.username.startsWith('🤖')).data.username).toBe(botEntrant.username);
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
        await jest.advanceTimersByTimeAsync(pacing().PREDRAW_COUNTDOWN_MS);
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
        expect(lead3.partial).toEqual([]);
        // No snapshot carries a custom picture inline (V1_REMOVALS #19 C): with
        // or without the old customPics opt-in the seat says hasCustomPic and
        // customPic is null (its URL is avatarUrl when the pipeline is on)
        const plainFrom = w.log.length;
        snapshotHandlers.requestSnapshot(owner(w, game, 1), w.io, {});
        const plain = w.log.slice(plainFrom).find((l) => l.event === 'stateSnapshot').data.snapshot;
        expect(plain.partial).toEqual([]);
        const custom = plain.seats.find((x) => x.hasCustomPic);
        expect(custom.customPic).toBeNull();
        expect(lead3.seats.find((x) => x.position === custom.position).customPic).toBeNull();

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
        expect(rej.partial).toEqual(['log']); // never 'customPics' since V1_REMOVALS #19 C

        play(w, game, pending);
        play(w, game, pending);
        await jest.advanceTimersByTimeAsync(0);
        expect(game.stage).toBe(Phase.TRICK_RESOLVING);
        const tr = ask(w, spec, 'trick-resolving', 'A spectator asks while the 4th card is on the table (TRICK_RESOLVING): 4 cards, no turn.');
        expect(tr.trick.cards).toHaveLength(4);
        expect(tr.turn).toBeNull();
        expect(tr.resume).toEqual({ kind: 'trick', inMs: pacing().TRICK_VIEW_MS });
        await jest.advanceTimersByTimeAsync(pacing().TRICK_VIEW_MS);
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
        // Its 61 s wait for a grace to run out sits on a bid turn: the bid
        // clock (bidClock.js) would bid 0 at 40 s, so it is off here
        process.env.BID_CLOCK = 'off';
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
        delete process.env.BID_CLOCK;
    }, 30000);

    test('bid-clock-running', async () => {
        delete process.env.BID_CLOCK;
        Math.random = mulberry32(107);
        const w = world('fx-clock');
        const t = await lobbyTable(w, ['uma', 'vic', 'wes', 'xia']);
        await toBidding(w, t);
        const { game } = t;
        const pos = game.currentTurn;
        const SeatState = require('../../game/SeatState');
        // toBidding ends 500 ms after the first-hand hold (T0); go to T0+25 s:
        // the clock started at T0+10 s, 15 s are left
        await jest.advanceTimersByTimeAsync(SeatState.BID_CLOCK_DELAY_MS + 15000 - 500);
        expect(game.bidClock.endAt - Date.now()).toBe(15000);
        expect(game.bidClock).toMatchObject({ pos, running: true });
        const bc = ask(w, owner(w, game, pos === 1 ? 2 : 1), 'bid-clock-running', 'Another seat asks while the bidder\'s bid clock runs: bidClock {position, inMs (from serverTime), durationMs}; the key is absent otherwise.');
        expect(bc.bidClock).toEqual({ position: pos, inMs: game.bidClock.endAt - Date.now(), durationMs: SeatState.BID_CLOCK_MS });
        expect(bc.turn).toEqual({ position: pos, action: 'bid' });
        await bid(w, game, '1');
        expect(snapshotHandlers.snapshotFor(game, owner(w, game, 1).id)).not.toHaveProperty('bidClock');
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

    test('the over-the-shoulder view (contract/fixtures/shoulder/events.json)', async () => {
        const clientInfo = require('../clientInfo');
        const shoulderView = require('../shoulderView');
        const { SPECTATORS_COALESCE_MS } = require('../../game/spectatorRoster');
        process.env.BID_CLOCK = 'off';
        Math.random = mulberry32(108);
        const w = world('fx-sh');
        const t = await lobbyTable(w, ['ola', 'pia', 'quin', 'rex']);
        await toBidding(w, t);
        const { game } = t;
        const pos = game.currentTurn;
        clientInfo.handle(owner(w, game, pos), w.io, { client: 'web', version: '1.0.0', caps: ['avatarUrl', 'assist'] });
        const fan = w.user('fx-sh-fan', 'sid');
        clientInfo.handle(fan, w.io, { client: 'web', version: '1.0.0', caps: ['avatarUrl', 'shoulderView'] });
        await mainRoomHandlers.joinAsSpectator(fan, w.io, { gameId: game.gameId });
        const tab = w.user('fx-sh-tab', game.seat(1).ownerUsername, { db: false }); // seat 1's own second tab
        clientInfo.handle(tab, w.io, { client: 'web', version: '1.0.0', caps: ['avatarUrl', 'shoulderView'] });
        await mainRoomHandlers.joinAsSpectator(tab, w.io, { gameId: game.gameId });
        await jest.advanceTimersByTimeAsync(SPECTATORS_COALESCE_MS);

        const from = w.log.length;
        shoulderView.watchHand(fan, w.io, { gameId: game.gameId, position: pos, requestId: 'w1' });
        // Not a v2 fixture: the iOS and web suites iterate contract/fixtures/v2
        // (TableSnapshotDecodingTests pins its count), and no client reads
        // the shoulder yet; the snapshot is in shoulder/events.json instead
        const sw = w.log.slice(from).find((l) => l.to === `self:${fan.id}` && l.event === 'stateSnapshot').data.snapshot;
        expect(validate(JSON.parse(JSON.stringify(sw)))).toEqual([]);
        expect(sw.viewer.shoulder.position).toBe(pos);
        shoulderView.watchHand(tab, w.io, { gameId: game.gameId, position: pos === 1 ? 2 : pos });
        chatHandlers.chatMessage(owner(w, game, pos), w.io, { message: '/help' });
        await jest.advanceTimersByTimeAsync(SPECTATORS_COALESCE_MS);
        const dealSeq = game.dealSeq;
        while (game.stage === Phase.BIDDING && game.dealSeq === dealSeq) await bid(w, game, '0');
        await advanceUntil(() => game.dealSeq > dealSeq && game.stage === Phase.BIDDING, 100);
        const mine = (event, pred = () => true) => w.log.slice(from).find((l) => (l.to === fan.id || l.to === `self:${fan.id}`) && l.event === event && pred(l.data));
        const wire = {
            watchHand: { gameId: game.gameId, position: pos, requestId: 'w1' },
            stateSnapshot: mine('stateSnapshot'),
            watchHandRefused: w.log.slice(from).find((l) => l.to === `self:${tab.id}` && l.event === 'watchHandRefused'),
            assistHint: mine('assistHint'),
            spectatorsUpdated: mine('spectatorsUpdated'),
            gameStart: mine('gameStart', (d) => !!d.shoulder),
        };
        captureEvents(wire);
        expect(wire.watchHandRefused.data).toMatchObject({ reason: 'own_seat', ownPosition: 1 });
        expect(wire.assistHint.data.watched).toBe(pos);
        expect(wire.spectatorsUpdated.data.spectators.find((e) => e.username === 'sid').shoulder).toBe(pos);
        expect(wire.gameStart.data.shoulder.position).toBe(pos);
        delete process.env.BID_CLOCK;
        await Promise.all([...t.draws, ...t.starting]);
    }, 30000);

    test('a tournament table\'s draw for first deal (contract/fixtures/pairings/events.json)', async () => {
        const gameHandlers = require('../gameHandlers');
        const CAPS = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'tournamentVoice', 'tournamentPairings'];
        const out = {};
        // One case since the staged draw is gone (every planned table draws
        // honestly; a socket without the cap changes nothing on the wire)
        for (const [mode, seed] of [['honest', 111]]) {
            Math.random = mulberry32(seed);
            const ctx = await setupTournament(4);
            ctx.sockets.forEach((sk) => {
                sk.data.client = { client: 'web', version: '1', build: null, caps: CAPS };
            });
            ctx.starting = tournamentHandlers.beginTournament(ctx.sockets[0], ctx.io);
            await advanceUntil(() => liveTables(ctx.t).length > 0 && liveTables(ctx.t)[0].stage === Phase.DRAWING, 10, 20000);
            const [g] = liveTables(ctx.t);
            const pick = (e) => ({ event: e.event, data: JSON.parse(JSON.stringify(e.data)) });
            const roundStart = ctx.log.find((e) => e.event === 'tournamentRoundStart');
            const startDraw = ctx.log.find((e) => e.event === 'startDraw' && e.to === g.roomName);
            const line = ctx.log.find((e) => e.event === 'gameLogEntry' && e.to === g.roomName);
            gameHandlers.draw(ctx.sockets[0], ctx.io, { num: 3 });
            gameHandlers.draw(ctx.sockets[1], ctx.io, { num: 20 });
            const from = ctx.log.length;
            snapshotHandlers.requestSnapshot(ctx.sockets[2], ctx.io, {});
            const snap = ctx.log.slice(from).find((e) => e.event === 'stateSnapshot').data.snapshot;
            expect(validate(JSON.parse(JSON.stringify(snap)))).toEqual([]);
            expect(snap.draw.teams).toHaveLength(2);
            const events = [pick(roundStart), pick(startDraw), ...(line ? [pick(line)] : []), { event: 'stateSnapshot', data: { snapshot: JSON.parse(JSON.stringify(snap)) } }];
            for (const e of events) expect({ event: e.event, errors: contract.validateS2C(e.event, e.data).errors }).toEqual({ event: e.event, errors: [] });
            out[mode] = events;
            gameHandlers.draw(ctx.sockets[2], ctx.io, { num: 0 });
            gameHandlers.draw(ctx.sockets[3], ctx.io, { num: 0 });
            await advanceUntil(() => g.stage === Phase.BIDDING, 100, 20000);
            await ctx.starting;
            for (const id of Array.from(gameManager.tournaments.keys())) gameManager.deleteTournament(id);
        }
        pairingsEvents = {
            description: 'A 4-member tournament table\'s draw for first deal (2026-11-25, clientHello cap tournamentPairings), from real games: tournamentRoundStart with pairings (the planned round, gameId null), startDraw with teams, and a mid-draw stateSnapshot (two drawn) whose draw carries teams. honest: the room also gets the "Partners this round" system line and each player the card they picked (every planned table; the staged draw for clients without the cap is gone). Rewrite with npm run contract:fixtures.',
            honest: out.honest,
        };
    }, 60000);

    test('Cut for a buck (contract/fixtures/cut/events.json)', async () => {
        const cutForABuck = require('../cutForABuck');
        const { deckOf, drawAll, socketOf } = require('../../testUtils/cutDriver');
        const { playTournament, creatorSocket } = require('../../testUtils/tournamentDriver');
        const CAPS = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'tournamentVoice', 'tournamentPairings', 'cutForABuck'];
        Math.random = mulberry32(131);
        const ctx = await setupTournament(4);
        // the 4th member is iOS 1.2.6 (40): no cutForABuck
        ctx.sockets.forEach((sk, i) => {
            sk.data.client = { client: i === 3 ? 'ios' : 'web', version: '1', build: null, caps: i === 3 ? CAPS.slice(0, 7) : CAPS };
        });
        tournamentHandlers.setTournamentRounds(creatorSocket(ctx), ctx.io, { totalRounds: 2 });
        // 13 redraws (four of a kind, rank by rank; the legacy member is drawn
        // for first, at the lowest free slot), then 2 cards left for 4
        // players: a reshuffle into a deck whose first cards make a tie of
        // two (both out), then the winner
        const quads = [];
        for (const r of ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']) quads.push(`${r}s`, `${r}h`, `${r}d`, `${r}c`);
        const after = deckOf('4s', '4h', 'Ks', 'Js', 'Ah', 'Qd');
        cutForABuck.setEngineOptionsForTests({ deck: deckOf(...quads), shuffle: () => after.map((x) => ({ ...x })), randomInt: () => 0 });
        const from = ctx.log.length;
        await playTournament(ctx);
        expect(ctx.t.phase).toBe('cut');
        const legacy = ctx.sockets[3];
        let joinedMid = null;
        let legacyMid = null;
        for (let i = 0; i < 400 && ctx.t.phase === 'cut'; i++) {
            const e = ctx.t.cut?.engine;
            if (ctx.t.cut?.stage === 'drawing' && e?.open && e.waitingFor().length) {
                // slots in participant order after the legacy member's
                const slots = {};
                e.aliveList().filter((u) => !e.pending.has(u)).forEach((u, k) => { slots[u] = k + 1; });
                const firstWaiting = e.waitingFor()[0];
                cutForABuck.draw(socketOf(ctx, firstWaiting), ctx.io, { round: e.round, slot: slots[firstWaiting] });
                if (e.round === 14 && !joinedMid) {
                    tournamentHandlers.returnToTournament(ctx.sockets[0], ctx.io);
                    joinedMid = ctx.log.filter((l) => l.to === `self:${ctx.sockets[0].id}` && l.event === 'tournamentJoined').at(-1);
                    tournamentHandlers.returnToTournament(legacy, ctx.io);
                    legacyMid = ctx.log.filter((l) => l.to === `self:${legacy.id}` && l.event === 'tournamentJoined').at(-1);
                }
                drawAll(ctx, slots);
            }
            await jest.advanceTimersByTimeAsync(500);
        }
        expect(ctx.t.phase).toBe('complete');
        tournamentHandlers.returnToTournament(ctx.sockets[0], ctx.io);
        const joinedEnd = ctx.log.filter((l) => l.to === `self:${ctx.sockets[0].id}` && l.event === 'tournamentJoined').at(-1);
        const wire = ctx.log.slice(from).filter((l) => (l.event.startsWith('cutForABuck') || l.event === 'tournamentComplete') && l.to === ctx.t.roomName);
        const reveals = wire.filter((l) => l.event === 'cutForABuckReveal').map((l) => l.data);
        expect(reveals.filter((r) => r.redraw)).toHaveLength(13);
        expect(reveals.filter((r) => r.eliminated.length === 2)).toHaveLength(1);
        expect(wire.filter((l) => l.event === 'cutForABuckRound').some((l) => l.data.reshuffled)).toBe(true);
        const summary = ctx.log.slice(from).find((l) => l.event === 'lobbiesUpdated' && (l.data.tournaments || []).some((x) => x.cut));
        const pick = (e, to) => ({ event: e.event, to, data: JSON.parse(JSON.stringify(e.data)) });
        const events = [
            ...wire.map((e) => pick(e, 'tournament')),
            pick(joinedMid, 'self'),
            pick(legacyMid, 'self'),
            pick(joinedEnd, 'self'),
            ...ctx.log.filter((l) => l.to === legacy.id && l.event === 'tournamentMessage').map((e) => pick(e, 'socket')),
            { event: 'lobbiesUpdated', to: 'mainRoom', data: { tournaments: JSON.parse(JSON.stringify(summary.data.tournaments.filter((x) => x.cut))) } },
        ];
        for (const e of events.filter((x) => x.event !== 'lobbiesUpdated')) expect({ event: e.event, errors: contract.validateS2C(e.event, e.data).errors }).toEqual({ event: e.event, errors: [] });
        expect(joinedMid.data.cut.stage).toBe('drawing');
        expect(legacyMid.data.phase).toBe('round_active');
        expect(joinedEnd.data.cutForABuck.winner).toBeTruthy();
        cutEvents = {
            description: 'Cut for a buck on the wire (2026-11-25, clientHello cap cutForABuck), from a seeded 4-member, 2-round tournament (one member is iOS 1.2.6 without the cap: drawn for at every open, its view round_active, the rounds as private system lines): cutForABuckStart, then 13 redraws (four of a kind), a reshuffle (2 cards left for 4 players), a tie of two lowest (both out), the winner and tournamentComplete with cutForABuck; a cap member\'s tournamentJoined mid-round (cut: drawn slots only), the legacy member\'s (phase round_active, no cut) and the complete phase\'s (cutForABuck); the legacy member\'s private lines; the main room summary (phase round_active, cut true). Rewrite with npm run contract:fixtures.',
            events,
        };
        cutForABuck.setEngineOptionsForTests({});
    }, 120000);

    test('the committed fixtures are what the server produces (run npm run contract:fixtures)', () => {
        const names = [...captured.keys()].sort();
        expect(names).toEqual(['action-rejected', 'between-tricks', 'bid-clock-running', 'bidding-mid', 'created-countdown', 'draw-in-progress',
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

    test('contract/fixtures/pairings/events.json is what the server produces (run npm run contract:fixtures)', () => {
        expect(pairingsEvents).not.toBeNull();
        const file = path.join(PAIRINGS_DIR, 'events.json');
        const content = JSON.stringify(pairingsEvents, null, 2) + '\n';
        if (UPDATE) {
            fs.mkdirSync(PAIRINGS_DIR, { recursive: true });
            fs.writeFileSync(file, content);
            return;
        }
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
            throw new Error('contract/fixtures/pairings/events.json is out of date: run npm run contract:fixtures');
        }
    });

    test('contract/fixtures/shoulder/events.json is what the server produces (run npm run contract:fixtures)', () => {
        expect(shoulderEvents).not.toBeNull();
        const file = path.join(SHOULDER_DIR, 'events.json');
        const content = JSON.stringify(shoulderEvents, null, 2) + '\n';
        if (UPDATE) {
            fs.mkdirSync(SHOULDER_DIR, { recursive: true });
            fs.writeFileSync(file, content);
            return;
        }
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
            throw new Error('contract/fixtures/shoulder/events.json is out of date: run npm run contract:fixtures');
        }
    });

    test('contract/fixtures/cut/events.json is what the server produces (run npm run contract:fixtures)', () => {
        expect(cutEvents).not.toBeNull();
        const file = path.join(CUT_DIR, 'events.json');
        const content = JSON.stringify(cutEvents, null, 2) + '\n';
        if (UPDATE) {
            fs.mkdirSync(CUT_DIR, { recursive: true });
            fs.writeFileSync(file, content);
            return;
        }
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
            throw new Error('contract/fixtures/cut/events.json is out of date: run npm run contract:fixtures');
        }
    });
});
