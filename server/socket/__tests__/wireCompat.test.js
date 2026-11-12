/**
 * Wire compatibility goldens for the builders this item touches. A schema
 * cannot see a field that keeps its type but changes its value or meaning,
 * so for every emit of these events during real games this test computes
 * what the cc865b4 server would have sent at that moment (verbatim copies
 * of the cc865b4 builders below) and asserts
 *
 *     omit(JSON(emitted), schema.s2c[event].added ∪ ['seq']) == JSON(legacy)
 *
 * Covered: the spectator full state, doneBidding, chatMessage (both
 * variants), actionRejected, rejoinSuccess (reconnectOwner, watchSeat via
 * rejoin and via spectate, the idempotent rejoin), restorePlayerState
 * (#183 and /active from the watch view), gameStart (seat and spectator).
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const contract = require('../../../contract');
const contractCheck = require('../../testUtils/contractCheck');
const gameManager = require('../../game/GameManager');
const chatHandlers = require('../chatHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const { findHighestBidder } = require('../../game/rules');
const { Phase } = require('../../game/GamePhase');
const { Controller } = require('../../game/SeatState');
const { gameLogger, socketLogger, authLogger, logger } = require('../../utils/logger');
const { playF1 } = require('../../testUtils/contractScenarios');

// ---------- verbatim cc865b4 builders ----------

/** mainRoomHandlers.joinAsSpectator / tournamentHandlers.spectateTournamentGame at cc865b4 */
function legacySpectatorState(game) {
    const playerInfo = [];
    for (let pos = 1; pos <= 4; pos++) {
        const player = game.getPlayerByPosition(pos);
        if (player) {
            playerInfo.push({
                position: pos,
                username: player.username,
                pic: player.pic,
                socketId: player.socketId
            });
        }
    }
    return {
        gameId: game.gameId,
        players: playerInfo,
        trump: game.trump,
        currentHand: game.currentHand,
        dealer: game.dealer,
        phase: game.phase,
        bidding: game.bidding,
        currentTurn: game.currentTurn,
        bids: game.bids,
        playerBids: game.playerBids,
        tricks: game.tricks,
        score: game.score,
        playedCards: game.playedCards,
        isTrumpBroken: game.isTrumpBroken,
        gameLog: game.getGameLog(),
        spectatorCount: game.getSpectators().length
    };
}

/** gameHandlers.handlePostBid at cc865b4: { bids, lead } */
function legacyDoneBidding(game) {
    const bids = game.playerBids;
    const lead = findHighestBidder(game.bidder, bids) + 1;
    return { bids, lead };
}

/** dealHand's playerInfo at cc865b4 */
function legacyPlayerInfo(game) {
    const playerInfo = [];
    for (let pos = 1; pos <= 4; pos++) {
        const p = game.getPlayerByPosition(pos);
        if (p) playerInfo.push({ position: pos, username: p.username, pic: p.pic });
    }
    return playerInfo;
}

/** dealHand's seat gameStart at cc865b4 */
function legacySeatGameStart(game, seat) {
    return {
        gameId: game.gameId,
        players: game.getSocketIds(),
        hand: game.getHand(seat.seatSocketId),
        trump: game.trump,
        score1: game.score.team1,
        score2: game.score.team2,
        dealer: game.dealer,
        position: seat.position,
        currentHand: game.currentHand,
        hsiValues: game.hsiValues,
        playerInfo: legacyPlayerInfo(game)
    };
}

/** dealHand's spectator gameStart at cc865b4 */
function legacySpectatorGameStart(game) {
    return {
        gameId: game.gameId,
        trump: game.trump,
        score1: game.score.team1,
        score2: game.score.team2,
        dealer: game.dealer,
        currentHand: game.currentHand,
        hand: [],
        playerInfo: legacyPlayerInfo(game)
    };
}

/**
 * seatLifecycle.reconnectOwner / watchSeat and the idempotent rejoin at
 * cc865b4. tournamentId is not touched by this item: its presence picks the
 * variant (watchSeat via spectate sends none) and its value is carried over.
 */
function legacyRejoinSuccess(game, sid, wire) {
    const pos = game.seatByOwnerSocket(sid);
    const seat = game.seat(pos);
    const state = seat.controller === Controller.HUMAN
        ? { ...game.getClientState(sid) }
        : { ...game.getClientState(seat.seatSocketId), isLazy: true };
    if ('tournamentId' in wire) state.tournamentId = wire.tournamentId;
    return state;
}

// ---------- the hook ----------

const json = (v) => JSON.parse(JSON.stringify(v));
const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const dropped = (event) => [...(contract.schema.s2c[event].added || []), 'seq'];

function watchLegacy() {
    const seen = {};
    const mismatches = [];
    const note = (kind) => { seen[kind] = (seen[kind] || 0) + 1; };
    const compare = (kind, event, wire, legacy) => {
        note(kind);
        const got = omit(wire, dropped(event));
        const want = json(legacy);
        if (JSON.stringify(Object.keys(got).sort()) !== JSON.stringify(Object.keys(want).sort()) ||
            !require('../../../contract/lib/validate').deepEqual(got, want)) {
            mismatches.push({ kind, event, got, want });
        }
    };
    const off = contractCheck.onEmit((entry, wire) => {
        const to = String(entry.to);
        const self = to.startsWith('self:') ? to.slice(5) : null;
        switch (entry.event) {
            case 'spectatorJoined': {
                if (!self || !wire.players) return; // the room notice is unchanged apart from seq (C12)
                compare('spectatorFullState', 'spectatorJoined', wire, legacySpectatorState(gameManager.getGameById(wire.gameId)));
                return;
            }
            case 'doneBidding':
                compare('doneBidding', 'doneBidding', wire, legacyDoneBidding(gameManager.getGameById(to.slice(5))));
                return;
            case 'chatMessage': {
                // cc865b4: human / spectator chat {position, message, username,
                // isSpectator}; bot chat {position, message, username}. Bots
                // are named '🤖 ...' (a lazy owner speaks under their own name).
                const isBot = String(wire.username).startsWith('🤖');
                const legacyKeys = isBot ? ['message', 'position', 'username'] : ['isSpectator', 'message', 'position', 'username'];
                const got = Object.fromEntries(Object.entries(wire).filter(([k]) => legacyKeys.includes(k)));
                const extra = Object.keys(wire).filter((k) => !legacyKeys.includes(k) && !dropped('chatMessage').includes(k));
                if (extra.length || Object.keys(got).length !== legacyKeys.length) mismatches.push({ kind: 'chatMessage', wire, legacyKeys });
                if (!isBot && wire.isSpectator !== (wire.position === null)) mismatches.push({ kind: 'chatMessage isSpectator', wire });
                note(isBot ? 'chat:bot' : 'chat:humanOrSpectator');
                return;
            }
            case 'actionRejected': {
                note('actionRejected');
                const keys = Object.keys(omit(wire, dropped('actionRejected'))).sort();
                if (JSON.stringify(keys) !== JSON.stringify(['action', 'reason'])) mismatches.push({ kind: 'actionRejected', keys });
                return;
            }
            case 'rejoinSuccess': {
                const game = gameManager.getGameById(wire.gameId);
                compare('tournamentId' in wire ? 'rejoinSuccess:rejoin' : 'rejoinSuccess:spectate', 'rejoinSuccess', wire, legacyRejoinSuccess(game, self, wire));
                return;
            }
            case 'restorePlayerState': {
                const game = gameManager.getGameById(wire.gameId);
                compare('restorePlayerState', 'restorePlayerState', wire, game.getClientState(self));
                return;
            }
            case 'gameStart': {
                const game = gameManager.getGameById(wire.gameId);
                // V1_REMOVALS #6 (executed): the seat variant no longer carries players
                if ('position' in wire) compare('gameStart:seat', 'gameStart', wire, omit(legacySeatGameStart(game, game.seat(wire.position)), ['players']));
                else compare('gameStart:spectator', 'gameStart', wire, legacySpectatorGameStart(game));
                return;
            }
            default:
        }
    });
    return { stop: () => { off(); return { seen, mismatches }; } };
}

let errorLogs;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    errorLogs = [];
    for (const l of [gameLogger, socketLogger, authLogger, logger]) {
        jest.spyOn(l, 'error').mockImplementation((msg, meta) => { errorLogs.push({ msg, meta }); });
        jest.spyOn(l, 'warn').mockImplementation(() => {});
        jest.spyOn(l, 'info').mockImplementation(() => {});
        jest.spyOn(l, 'debug').mockImplementation(() => {});
    }
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    for (const id of Array.from(gameManager.lobbies.keys())) gameManager.lobbies.delete(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

afterAll(() => require('../errorHandler').rateLimiter.shutdown());

test('F1: every touched builder sends what cc865b4 sent, plus only the added keys', async () => {
    const watch = watchLegacy();
    let spectatedLazy = false;
    await playF1({
        errorLogs,
        hooks: {
            async onStep(w, game, { hands, stage }) {
                // watchSeat via joinAsSpectator: a lazy owner's other tab
                if (hands === 6 && stage === Phase.BIDDING && !spectatedLazy) {
                    spectatedLazy = true;
                    const owner = w.sockets.get(game.seat(1).ownerSocketId);
                    chatHandlers.chatMessage(owner, w.io, { message: '/lazy' });
                    const tab = w.user('wc-tab', game.seat(1).ownerUsername, { db: false });
                    mainRoomHandlers.joinAsSpectator(tab, w.io, { gameId: game.gameId });
                    chatHandlers.chatMessage(tab, w.io, { message: '/active' });
                }
            },
        },
    });
    const { seen, mismatches } = watch.stop();
    expect(mismatches).toEqual([]);
    for (const kind of ['spectatorFullState', 'doneBidding', 'chat:bot', 'chat:humanOrSpectator', 'actionRejected',
        'rejoinSuccess:rejoin', 'rejoinSuccess:spectate', 'restorePlayerState', 'gameStart:seat', 'gameStart:spectator']) {
        expect({ kind, n: seen[kind] > 0 }).toEqual({ kind, n: true });
    }
    expect(errorLogs).toEqual([]);
}, 120000);


