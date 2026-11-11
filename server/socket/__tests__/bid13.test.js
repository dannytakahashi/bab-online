/**
 * A bid of 13 (owner, 2026-11-11: "technically legal, just very unlikely").
 * Both clients offer 0...hand size, so on the 13-card hand they offer 13:
 * the socket validator takes it, rules.isValidBid refuses it on any smaller
 * hand, and a 13 counts as a plain 1x bid of 13 tricks (not the 2x bore).
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const { validate } = require('../validators');
const rules = require('../../game/rules');
const { Phase } = require('../../game/GamePhase');
const { validateC2S } = require('../../../contract');
const { makeIo, makeSocket, events, legalCards, legalBids } = require('../../testUtils/gameDriver');
const { gameLogger, socketLogger, logger } = require('../../utils/logger');

const C = (rank, suit) => ({ rank, suit });
let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    for (const l of [gameLogger, socketLogger, logger]) {
        jest.spyOn(l, 'info').mockImplementation(() => {});
        jest.spyOn(l, 'debug').mockImplementation(() => {});
        jest.spyOn(l, 'warn').mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const ALL_TRUMP = ['HI', 'LO', 'A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4']
    .map((r) => (r === 'HI' || r === 'LO' ? C(r, 'joker') : C(r, 'spades')));
const SUIT13 = (suit) => ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'].map((r) => C(r, suit));

/**
 * Four human seats in BIDDING with `handSize` cards each, seat 1 to bid.
 * `hands` defaults to: seat 1 every top trump (it takes all 13 tricks),
 * the others one plain suit each.
 */
function setup({ handSize = 13, hands } = {}) {
    seq++;
    const log = [];
    const io = makeIo(log);
    const ids = [1, 2, 3, 4].map((n) => `b13-${seq}-h${n}`);
    const names = ids.map((id) => `u_${id}`);
    ids.forEach((id, i) => {
        gameManager.registerUser(id, names[i]);
        mockDb.current.users._insert({ username: names[i], profilePic: i + 1 });
    });
    const sockets = ids.map((id) => makeSocket(id, log, io));
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, names[i], i + 1, i + 1, false));
    sockets.forEach((s) => s.join(game.roomName));
    game.currentHand = handSize;
    const dealt = hands || [ALL_TRUMP, SUIT13('hearts'), SUIT13('diamonds'), SUIT13('clubs')].map((h) => h.slice(0, handSize));
    ids.forEach((id, i) => game.setHand(id, dealt[i].map((c) => ({ ...c }))));
    game.trump = C('3', 'spades');
    game.forcePhase('BIDDING');
    game.bidder = 1;
    game.currentTurn = 1;
    game.playerBids = [];
    return { log, io, game, ids, names, sockets };
}

/** Bid `bids` (seat 1 first) through the real handler. */
async function bidAll(t, bids) {
    for (let i = 0; i < 4; i++) await gameHandlers.playerBid(t.sockets[i], t.io, { bid: bids[i] });
}

/** Play the hand out with each seat's first legal card, through every resume hold. */
async function playOut(t) {
    for (let guard = 0; guard < 200 && events(t.log, 'handComplete').length === 0; guard++) {
        if (t.game.stage === Phase.PLAYING) {
            const sid = t.game.positions[t.game.currentTurn];
            const socket = t.sockets[t.ids.indexOf(sid)];
            await gameHandlers.playCard(socket, t.io, { card: legalCards(t.game, sid)[0] });
        } else {
            await jest.advanceTimersByTimeAsync(5000);
        }
    }
    const hc = events(t.log, 'handComplete');
    expect(hc).toHaveLength(1);
    return hc[0].data;
}

describe('the socket validator and the contract take 13', () => {
    test.each([['13'], [13]])('playerBid %p passes Joi (string from web, Int from iOS 1.1.0)', (bid) => {
        expect(() => validate('playerBid', { bid, position: 1 })).not.toThrow();
        expect(validateC2S('playerBid', { bid, position: 1 }).ok).toBe(true);
    });

    test.each([['14'], [14], ['5B']])('playerBid %p is still refused', (bid) => {
        expect(() => validate('playerBid', { bid, position: 1 })).toThrow();
        expect(validateC2S('playerBid', { bid, position: 1 }).ok).toBe(false);
    });

    test('the Joi list is the rules list', () => {
        expect(rules.BID_VALUES).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', 'B', '2B', '3B', '4B']);
        expect(rules.BID_RANKS['13']).toBe(13);
    });
});

describe('rules', () => {
    test.each([
        ['13', 13, true],
        ['13', 12, false],
        ['13', 11, false],
        ['13', 1, false],
        ['12', 12, true],
    ])('isValidBid(%s) on %i cards -> %s', (bid, size, ok) => {
        expect(rules.isValidBid(bid, [], size)).toBe(ok);
    });

    test('a bore leads over a numeric 13 whoever bid first; 13 still leads over 12', () => {
        expect(rules.findHighestBidder(1, ['13', 'B', '0', '0'])).toBe(1);
        expect(rules.findHighestBidder(1, ['B', '13', '0', '0'])).toBe(0);
        expect(rules.findHighestBidder(1, ['12', '0', '13', '0'])).toBe(2);
        // existing order unchanged
        expect(rules.findHighestBidder(1, ['3', '3', '0', '0'])).toBe(0);
        expect(rules.findHighestBidder(2, ['3', '3', '0', '0'])).toBe(1);
        expect(rules.findHighestBidder(1, ['12', 'B', '2B', '0'])).toBe(2);
    });

    test('13 is 1x; GameState.validateBid follows the rules', () => {
        expect(rules.calculateMultiplier('13', '0')).toBe(1);
        const t = setup({ handSize: 13 });
        expect(t.game.validateBid(t.ids[0], '13')).toEqual({ valid: true });
        expect(t.game.validateBid(t.ids[0], 13)).toEqual({ valid: true });
        const s = setup({ handSize: 12 });
        expect(s.game.validateBid(s.ids[0], '13').valid).toBe(false);
        expect(s.game.validateBid(s.ids[0], '12')).toEqual({ valid: true });
    });

    test('the test driver offers 13 only on the 13-card hand', () => {
        expect(legalBids(setup({ handSize: 13 }).game)).toContain('13');
        expect(legalBids(setup({ handSize: 12 }).game)).not.toContain('13');
    });
});

describe('the handler', () => {
    test.each([['13'], [13]])('accepts %p on the 13-card hand and broadcasts it', async (bid) => {
        const t = setup();
        await gameHandlers.playerBid(t.sockets[0], t.io, { bid });
        expect(events(t.log, 'actionRejected')).toHaveLength(0);
        expect(t.game.playerBids[0]).toBe('13');
        const br = events(t.log, 'bidReceived')[0].data;
        expect(br.bidArray[0]).toBe('13');
        expect(t.game.gameLog.some((e) => e.message === `${t.names[0]} bid 13.`)).toBe(true);
    });

    test.each([12, 11, 1])('refuses 13 on a %i-card hand with invalid_bid', async (handSize) => {
        const t = setup({ handSize });
        await gameHandlers.playerBid(t.sockets[0], t.io, { bid: '13' });
        expect(t.game.playerBids[0]).toBeUndefined();
        const rej = events(t.log, 'actionRejected');
        expect(rej).toHaveLength(1);
        expect(rej[0].data.reason).toBe('invalid_bid');
        expect(events(t.log, 'bidReceived')).toHaveLength(0);
    });

    test('team totals count 13 tricks at 1x, and the 13 bidder leads', async () => {
        const t = setup();
        await bidAll(t, ['13', '0', '0', '0']);
        const done = events(t.log, 'doneBidding')[0].data;
        expect(done.teamBids).toEqual({ team1: 13, team2: 0 });
        expect(done.mults).toEqual({ team1: 1, team2: 1 });
        expect(done.lead).toBe(1);
        expect(t.game.stage).toBe(Phase.PLAYING);
        expect(t.game.playerStats[1].totalBids).toBe(13);
    });

    test('13 + partner bid is capped at the hand size', async () => {
        const t = setup();
        await bidAll(t, ['13', '0', '2', '0']);
        expect(events(t.log, 'doneBidding')[0].data.teamBids).toEqual({ team1: 13, team2: 0 });
    });

    test('made: 13 bid, 13 tricks -> +130 (a B would be +260)', async () => {
        const t = setup();
        await bidAll(t, ['13', '0', '0', '0']);
        const hc = await playOut(t);
        expect(t.game.tricks).toEqual({ team1: 13, team2: 0 });
        expect(hc.score).toEqual({ team1: 130, team2: 0 });
        expect(t.game.handStats.team1Sets || 0).toBe(0);
    });

    test('set: 13 bid, 12 tricks -> -130 and the bidder caused the set', async () => {
        // seat 1: twelve top trumps and the 2 of hearts; seat 2's hearts win that trick
        const seat1 = [...ALL_TRUMP.slice(0, 12), C('2', 'hearts')];
        const seat2 = SUIT13('hearts').slice(0, 12).concat([C('2', 'clubs')]);
        const t = setup({ hands: [seat1, seat2, SUIT13('diamonds'), [...SUIT13('clubs').slice(0, 12), C('3', 'hearts')]] });
        await bidAll(t, ['13', '0', '0', '0']);
        const hc = await playOut(t);
        expect(t.game.tricks.team1).toBe(12);
        expect(hc.score.team1).toBe(-130);
        expect(t.game.handStats.team1Sets).toBe(1);
        expect(t.game.playerStats[1].setsCaused).toBe(1);
    });
});
