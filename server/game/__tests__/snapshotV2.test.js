/**
 * Snapshot v2 builder (server/game/snapshotV2.js): shape ($defs.snapshotV2)
 * in every stage (forcePhase fixtures and the real flow), viewer roles,
 * trick order, turn hiding, bids, purity and options.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const contract = require('../../../contract');
const { compile } = require('../../../contract/lib/validate');
const Deck = require('../Deck');
const gameManager = require('../GameManager');
const gameHandlers = require('../../socket/gameHandlers');
const mainRoomHandlers = require('../../socket/mainRoomHandlers');
const { Phase } = require('../GamePhase');
const { calculateMultiplier } = require('../rules');
const { makeIo, makeSocket, events, legalCards, lazySeat } = require('../../testUtils/gameDriver');
const { botController } = require('../bot');
const { gameLogger, socketLogger } = require('../../utils/logger');

const validate = compile({ $ref: '#/$defs/snapshotV2' }, contract.schema.$defs);
const C = (rank, suit) => ({ rank, suit });
let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger]) {
        for (const m of ['info', 'debug', 'warn']) jest.spyOn(l, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

function seated() {
    seq++;
    const ids = [1, 2, 3, 4].map((n) => `sv${seq}-h${n}`);
    ids.forEach((id) => gameManager.registerUser(id, `user_${id}`));
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, `user_${id}`, i + 1, i + 1, false));
    return { game, ids };
}

/** No string anywhere equals a socket id or starts with 'bot:'. */
function expectNoSocketIds(snap, ids) {
    const walk = (v) => {
        if (typeof v === 'string') {
            expect(ids.includes(v) || v.startsWith('bot:')).toBe(false);
        } else if (v && typeof v === 'object') {
            Object.values(v).forEach(walk);
        }
    };
    walk(snap);
}

const expectValid = (snap) => expect(validate(snap)).toEqual([]);

describe('every stage (forcePhase fixtures)', () => {
    test.each(Object.keys(Phase))('%s', (stage) => {
        const { game, ids } = seated();
        if (stage === Phase.ENDED) {
            game.forcePhase(Phase.HAND_RESOLVING);
            game.terminate(null, Phase.ENDED);
        } else if (stage === Phase.ABORTED) {
            game.terminate(null, Phase.ABORTED);
        } else if (stage !== Phase.CREATED) {
            game.forcePhase(stage);
        }
        const snap = game.getSnapshotV2(ids[0], { now: 1 });
        expectValid(snap);
        expect(snap.stage).toBe(stage);
        expect(snap.v).toBe(2);
        expect(snap.viewer).toEqual({ role: 'seat', position: 1, ownerView: 'seat', canAct: stage === Phase.BIDDING || stage === Phase.PLAYING });
        expect(snap.turn === null).toBe(stage !== Phase.BIDDING && stage !== Phase.PLAYING);
        expectNoSocketIds(snap, ids);
    });
});

describe('the real flow', () => {
    test('every stage the handlers reach validates; draw names = playerDrew names; mults = game mults', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `svf${seq}-h${n}`);
        ids.forEach((id) => {
            gameManager.registerUser(id, `user_${id}`);
            mockDb.current.users._insert({ username: `user_${id}`, profilePic: 5 });
        });
        const sockets = ids.map((id) => makeSocket(id, log, io));
        const game = gameManager.createGame(ids);
        sockets.forEach((s) => s.join(game.roomName));
        game.deck = new Deck();
        const seen = [];
        const enter = game._enterStage.bind(game);
        game._enterStage = (from, to) => {
            enter(from, to);
            const snap = game.getSnapshotV2(game.positions[1] || ids[0]);
            seen.push(snap);
        };
        game.transition(Phase.CREATED, Phase.DRAWING);
        const pending = [];
        for (const s of sockets.slice(0, 2)) pending.push(gameHandlers.draw(s, io, { num: 0 }));
        const mid = game.getSnapshotV2(ids[1]);
        expect(mid.draw.drawn.map((d) => d.drawOrder)).toEqual([1, 2]);
        expect(mid.draw.viewerDrawOrder).toBe(2);
        expect(mid.entrants.filter((e) => e.hasDrawn)).toHaveLength(2);
        expect(mid.viewer.role).toBe('entrant');
        expect(mid.seats).toEqual([]);
        for (const s of sockets.slice(2)) pending.push(gameHandlers.draw(s, io, { num: 0 }));
        const resolving = game.getSnapshotV2(ids[0]);
        expect(resolving.draw.drawn.map((d) => d.username)).toEqual(events(log, 'playerDrew').map((l) => l.data.username));
        expect(resolving.draw.drawn.every((d) => d.position >= 1)).toBe(true);
        await jest.advanceTimersByTimeAsync(6000);
        expect(game.stage).toBe(Phase.BIDDING);

        const sock = (pos) => sockets[ids.indexOf(game.positions[pos])];
        // Bores: a partial bore shows in mults while bidding
        await gameHandlers.playerBid(sock(game.currentTurn), io, { bid: 'B' });
        const partialMults = game.getSnapshotV2(ids[0]).bids;
        expect(partialMults.teamBids).toBeNull();
        expect(Math.max(partialMults.mults.team1, partialMults.mults.team2)).toBe(2);
        for (let i = 0; i < 3; i++) await gameHandlers.playerBid(sock(game.currentTurn), io, { bid: '1' });
        expect(game.stage).toBe(Phase.PLAYING);
        const after = game.getSnapshotV2(ids[0]).bids;
        expect(after.mults).toEqual({ team1: game.team1Mult, team2: game.team2Mult });
        expect(after.teamBids).toEqual({ team1: game.bids.team1, team2: game.bids.team2 });
        expect(after.byPosition).toEqual(game.playerBids.map(String));

        let guard = 0;
        while (game.currentHand === 12 && guard++ < 500) {
            if (game.stage === Phase.PLAYING) {
                const s = sock(game.currentTurn);
                pending.push(gameHandlers.playCard(s, io, { card: legalCards(game, s.id)[0] }));
                await Promise.resolve();
                const snap = game.getSnapshotV2(s.id);
                expectValid(snap);
                if (game.stage === Phase.PLAYING) {
                    expect(snap.trick.cards.length).toBe(game.playedCardsIndex);
                    if (snap.trick.cards.length) expect(snap.trick.cards[0].position).toBe(game.leadPosition);
                }
            } else {
                await jest.advanceTimersByTimeAsync(500);
            }
        }
        await Promise.all(pending);
        const stages = new Set(seen.map((s) => s.stage));
        for (const st of [Phase.DRAW_RESOLVING, Phase.TEAMS_ANNOUNCED, Phase.DEALING, Phase.BIDDING, Phase.PLAYING,
            Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING]) {
            expect(stages.has(st)).toBe(true);
        }
        for (const snap of seen) {
            expectValid(snap);
            expectNoSocketIds(snap, ids);
            if (snap.stage === Phase.TRICK_RESOLVING || snap.stage === Phase.DEALING || snap.stage === Phase.HAND_RESOLVING) {
                expect(snap.turn).toBeNull();
            }
            if (snap.stage === Phase.TRICK_RESOLVING) expect(snap.trick.cards).toHaveLength(4);
            if (snap.stage === Phase.TEAMS_ANNOUNCED) {
                expect(snap.deal).toBeNull();
                expect(snap.draw.drawn.every((d) => d.position !== null)).toBe(true);
            }
            if (snap.stage === Phase.DEALING) expect(snap.draw).toBeNull();
        }
    });
});

describe('won tricks (trickHistory)', () => {
    test('each counted trick with its winner, lead and cards in play order; compact; reset by the next deal', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `svt${seq}-h${n}`);
        ids.forEach((id) => {
            gameManager.registerUser(id, `user_${id}`);
            mockDb.current.users._insert({ username: `user_${id}`, profilePic: 5 });
        });
        const sockets = ids.map((id) => makeSocket(id, log, io));
        const game = gameManager.createGame(ids);
        sockets.forEach((s) => s.join(game.roomName));
        game.deck = new Deck();
        game.transition(Phase.CREATED, Phase.DRAWING);
        const pending = sockets.map((s) => gameHandlers.draw(s, io, { num: 0 }));
        await jest.advanceTimersByTimeAsync(6000);
        expect(game.stage).toBe(Phase.BIDDING);
        expect(game.getSnapshotV2(ids[0]).trickHistory).toEqual([]);
        const sock = (pos) => sockets[ids.indexOf(game.positions[pos])];
        for (let i = 0; i < 4; i++) await gameHandlers.playerBid(sock(game.currentTurn), io, { bid: '1' });
        expect(game.stage).toBe(Phase.PLAYING);

        // the expected history, from what every client saw: cardPlayed then trickComplete
        const expected = [];
        let cards = [];
        let seen = 0;
        const follow = () => {
            for (; seen < log.length; seen++) {
                const l = log[seen];
                if (l.to !== game.roomName) continue;
                if (l.event === 'cardPlayed') cards.push({ position: l.data.position, card: { suit: l.data.card.suit, rank: l.data.card.rank } });
                if (l.event === 'trickComplete') {
                    expected.push({ winner: l.data.winner, lead: cards[0].position, cards: cards.map((c) => c.card) });
                    cards = [];
                }
            }
        };
        let guard = 0;
        while (game.currentHand === 12 && guard++ < 500) {
            if (game.stage === Phase.PLAYING) {
                const s = sock(game.currentTurn);
                pending.push(gameHandlers.playCard(s, io, { card: legalCards(game, s.id)[0] }));
                await Promise.resolve();
            } else {
                await jest.advanceTimersByTimeAsync(500);
            }
            follow();
            if (game.currentHand !== 12) break;
            for (const viewer of [ids[0], ids[1]]) {
                const snap = game.getSnapshotV2(viewer);
                expectValid(snap);
                expect(snap.trickHistory).toEqual(expected);
                expect(snap.trickHistory).toHaveLength(snap.tricks.team1 + snap.tricks.team2);
            }
        }
        await Promise.all(pending);
        expect(expected).toHaveLength(12);
        for (const t of expected) expect(t.cards).toHaveLength(4);
        // compact: under 160 bytes a trick (13 tricks: about 2 KB at most)
        const bytes = JSON.stringify(expected).length;
        expect(bytes / expected.length).toBeLessThan(160);
        // the next deal starts empty
        expect(game.currentHand).toBe(10);
        expect(game.getSnapshotV2(ids[0]).trickHistory).toEqual([]);
    });
});

describe('viewer roles', () => {
    test('seat, lazyWatcher, spectator, entrant and none', () => {
        const log = [];
        const io = makeIo(log);
        const { game, ids } = seated();
        game.forcePhase(Phase.BIDDING);
        game.currentTurn = 2;
        game.setHand(ids[0], [C('2', 'hearts')]);
        game.hsiValues = { 1: 3.5, 2: 1, 3: 0, 4: 2 };
        expect(game.getSnapshotV2(ids[0]).viewer).toEqual({ role: 'seat', position: 1, ownerView: 'seat', canAct: false });
        expect(game.getSnapshotV2(ids[1]).viewer.canAct).toBe(true);
        expect(game.getSnapshotV2(ids[0]).hand).toEqual([C('2', 'hearts')]);
        expect(game.getSnapshotV2(ids[0]).hsi).toEqual([3.5, 1, 0, 2]);

        const bot = botController.createBot('🤖 Lazy', 'mary');
        lazySeat(game, 1, bot, { view: 'watch', ownerSocketId: ids[0] });
        const lw = game.getSnapshotV2(ids[0]);
        expect(lw.viewer).toEqual({ role: 'lazyWatcher', position: 1, ownerView: 'watch', canAct: false });
        expect(lw.hand).toEqual([C('2', 'hearts')]); // the seat's hand (keyed by the bot now)
        expect(lw.seats[0]).toMatchObject({ controller: 'lazyBot', isBot: true, lazy: true, ownerUsername: `user_${ids[0]}`, username: '🤖 Lazy' });

        const spec = makeSocket(`spec-${seq}`, log, io);
        gameManager.registerUser(spec.id, `watcher_${seq}`);
        mainRoomHandlers.joinAsSpectator(spec, io, { gameId: game.gameId });
        const sv = game.getSnapshotV2(spec.id);
        expect(sv.viewer).toEqual({ role: 'spectator', position: null, ownerView: null, canAct: false });
        expect(sv.hand).toBeNull();
        expect(sv.hsi).toBeNull();
        expect(sv.spectatorCount).toBe(1);

        expect(game.getSnapshotV2('nobody').viewer.role).toBe('none');
        expect(game.getSnapshotV2(null).viewer.role).toBe('none');

        seq++;
        const pre = gameManager.createGame([`pre${seq}-a`, `pre${seq}-b`, `pre${seq}-c`, `pre${seq}-d`]);
        const ent = pre.getSnapshotV2(`pre${seq}-a`);
        expect(ent.viewer.role).toBe('entrant');
        expect(ent.hand).toBeNull();
        expect(ent.entrants).toHaveLength(4);
        expect(ent.draw).toEqual({ deckRemaining: null, drawn: [], viewerDrawOrder: null });
        expectValid(ent);
        [lw, sv].forEach(expectValid);
    });
});

describe('trick and bids', () => {
    test.each([1, 2, 3, 4])('trick cards are in play order when seat %i leads', (lead) => {
        const { game } = seated();
        game.forcePhase(Phase.PLAYING);
        game.trump = C('A', 'spades');
        game.leadPosition = lead;
        const order = [0, 1, 2].map((k) => ((lead - 1 + k) % 4) + 1);
        order.forEach((p, i) => { game.playedCards[p - 1] = C(String(i + 2), 'hearts'); });
        game.playedCardsIndex = 3;
        game.currentTurn = ((lead + 2) % 4) + 1;
        const snap = game.getSnapshotV2(null);
        expect(snap.trick.leadPosition).toBe(lead);
        expect(snap.trick.cards.map((c) => c.position)).toEqual(order);
        expect(snap.trick.number).toBe(1);
        expect(snap.turn).toEqual({ position: game.currentTurn, action: 'play' });
        expectValid(snap);
    });

    test('between tricks: no lead, no cards, turn = the next leader; TRICK_RESOLVING hides the turn', () => {
        const { game } = seated();
        game.forcePhase(Phase.PLAYING);
        game.tricks = { team1: 1, team2: 0 };
        game.leadPosition = 2;
        game.currentTurn = 3;
        const between = game.getSnapshotV2(null);
        expect(between.trick).toEqual({ number: 2, leadPosition: null, cards: [] });
        expect(between.turn).toEqual({ position: 3, action: 'play' });
        game.forcePhase(Phase.TRICK_RESOLVING);
        game.playedCards = [C('2', 'hearts'), C('3', 'hearts'), C('4', 'hearts'), C('5', 'hearts')];
        game.playedCardsIndex = 4;
        const resolving = game.getSnapshotV2(null);
        expect(resolving.turn).toBeNull();
        expect(resolving.trick.cards.map((c) => c.position)).toEqual([2, 3, 4, 1]);
        game.forcePhase(Phase.BIDDING);
        const bidding = game.getSnapshotV2(null);
        expect(bidding.trick).toEqual({ number: null, leadPosition: null, cards: [] });
    });

    test('bids: strings by position, rotated order, partial bore multipliers', () => {
        const { game } = seated();
        game.forcePhase(Phase.BIDDING);
        game.bidder = 3;
        game.playerBids[2] = 'B';
        game.playerBids[3] = 2;  // a numeric bid is shown as a string
        game.bids = { 3: 'B', 4: 2 };
        game.currentTurn = 1;
        const { bids } = game.getSnapshotV2(null);
        expect(bids.byPosition).toEqual([null, null, 'B', '2']);
        expect(bids.order).toEqual([3, 4, 1, 2]);
        expect(bids.teamBids).toBeNull();
        expect(bids.mults).toEqual({ team1: calculateMultiplier(null, 'B'), team2: 1 });
        expect(bids.mults.team1).toBe(2);
    });
});

describe('purity and options', () => {
    test('a deep copy: a JSON round-trip is equal and later play does not change it', () => {
        const { game, ids } = seated();
        game.forcePhase(Phase.PLAYING);
        game.trump = C('A', 'spades');
        game.setHand(ids[0], [C('2', 'hearts'), C('3', 'hearts')]);
        game.leadPosition = 1;
        game.playedCards[0] = C('K', 'clubs');
        game.playedCardsIndex = 1;
        const snap = game.getSnapshotV2(ids[0]);
        const frozen = JSON.parse(JSON.stringify(snap));
        expect(snap).toEqual(frozen);
        game.hands[ids[0]].pop();
        game.playedCards[1] = C('4', 'clubs');
        game.playedCardsIndex = 2;
        game.trump.rank = 'K';
        game.tricks.team1 = 3;
        game.addLogEntry('later', null, 'system');
        expect(snap).toEqual(frozen);
    });

    test('no seat carries an inline picture (V1_REMOVALS #19 C); customPics is ignored; log:false empties the log', () => {
        const { game, ids } = seated();
        const s = game.seat(2);
        s.ownerPic = 'data:image/png;base64,AAAA';
        game._indexSeat(2);
        game.addLogEntry('hello', 2, 'chat');
        const full = game.getSnapshotV2(ids[0]);
        expect(full.partial).toEqual([]);
        expect(full.seats[1]).toMatchObject({ pic: null, hasCustomPic: true, customPic: null });
        expect(full.log).toEqual([{ message: 'hello', type: 'chat', position: 2, at: expect.any(Number) }]);
        // the old opt-in is ignored: still no inline picture, and partial never lists 'customPics'
        expect(game.getSnapshotV2(ids[0], { customPics: true })).toEqual(full);
        const lite = game.getSnapshotV2(ids[0], { customPics: false, log: false });
        expect(lite.partial).toEqual(['log']);
        expect(lite.seats[1]).toMatchObject({ pic: null, hasCustomPic: true, customPic: null });
        expect(lite.log).toEqual([]);
        expect(lite.seats[0]).toMatchObject({ pic: 1, hasCustomPic: false, customPic: null });
        // with a URL resolver the custom seat gets its avatarUrl and nothing inline
        const withUrl = game.getSnapshotV2(ids[0], { avatarResolve: () => ({ url: '/avatar/x?v=0123456789abcdef' }) });
        expect(withUrl.seats[1]).toMatchObject({ customPic: null, avatarUrl: '/avatar/x?v=0123456789abcdef' });
        [full, lite, withUrl].forEach(expectValid);
    });

    test('tournament info comes in through opts; seq is the game eventSeq', () => {
        const { game } = seated();
        game.eventSeq = 41;
        const snap = game.getSnapshotV2(null, { tournament: { tournamentId: 't1', name: 'Cup', roundNumber: 2, totalRounds: 4 }, now: 5 });
        expect(snap.tournament).toEqual({ tournamentId: 't1', name: 'Cup', roundNumber: 2, totalRounds: 4 });
        expect(snap.seq).toBe(41);
        expect(snap.serverTime).toBe(5);
        expectValid(snap);
    });

    test('the key order is fixed', () => {
        const { game } = seated();
        expect(Object.keys(game.getSnapshotV2(null))).toEqual(['v', 'gameId', 'seq', 'serverTime', 'stage', 'partial', 'viewer',
            'hand', 'deal', 'trump', 'trumpBroken', 'turn', 'bids', 'trick', 'tricks', 'tricksByPosition', 'trickHistory', 'score', 'rainbows',
            'hsi', 'seats', 'entrants', 'draw', 'spectatorCount', 'watching', 'tournament', 'log', 'resume']);
    });

    test('the builder requires only rules, GamePhase, SeatState and spectatorWire (itself requiring nothing)', () => {
        const fs = require('fs');
        const src = fs.readFileSync(require.resolve('../snapshotV2'), 'utf8');
        const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
        expect(reqs).toEqual(['./GamePhase', './SeatState', './rules', './spectatorWire']);
        expect(fs.readFileSync(require.resolve('../spectatorWire'), 'utf8')).not.toMatch(/require\(/);
    });
});


