/**
 * Regression tests for server hardening: races and trust gaps at the socket
 * boundary that could crash the process, wedge a game, or hand a seat to an
 * unauthenticated socket. Each test drives the real handlers against a real
 * GameState with stub sockets.
 */

const mockUsers = {};
jest.mock('../../database', () => {
    const actual = jest.requireActual('../../database');
    return {
        ...actual,
        getUsersCollection: () => ({
            findOne: async ({ username }) => mockUsers[username] || null,
            updateOne: async () => ({}),
        }),
    };
});

const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const chatHandlers = require('../chatHandlers');
const reconnectHandlers = require('../reconnectHandlers');
const { isValidBid } = require('../../game/rules');

const C = (rank, suit) => ({ rank, suit });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeIo(log) {
    return {
        to: (room) => ({ emit: (event, data) => log.push({ to: room, event, data }) }),
        emit: () => {},
        sockets: { sockets: new Map() },
    };
}

function makeSocket(id, log) {
    return { id, emit: (event, data) => log.push({ to: `self:${id}`, event, data }), join() {}, leave() {} };
}

let seq = 0;
function setupGame(handSize, hands) {
    seq++;
    const ids = [1, 2, 3, 4].map((n) => `t${seq}-h${n}`);
    ids.forEach((id) => gameManager.registerUser(id, `user_${id}`));
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, `user_${id}`, i + 1, 1, false));
    game.currentHand = handSize;
    if (hands) ids.forEach((id, i) => game.setHand(id, hands[i]));
    return { game, ids };
}

describe('pre-hand window (positions assigned, no hand dealt yet)', () => {
    test('/leave during team announcement does not crash a bot timer or record a phantom bid', async () => {
        const log = [];
        const io = makeIo(log);
        const { game, ids } = setupGame(12, null);
        game.forcePhase('TEAMS_ANNOUNCED'); // handleDrawComplete window: trump still null

        chatHandlers.chatMessage(makeSocket(ids[0], log), io, { message: '/leave' });
        await sleep(2600); // past the lazy/bot action delay

        expect(game.playerBids.filter((b) => b != null)).toEqual([]);
        expect(log.some((l) => l.event === 'bidReceived')).toBe(false);
        gameManager.abortGame(game.gameId);
    });

    test('bids and plays are rejected before the hand is dealt', async () => {
        const log = [];
        const io = makeIo(log);
        const { game, ids } = setupGame(12, null);
        game.forcePhase('TEAMS_ANNOUNCED');

        await gameHandlers.playerBid(makeSocket(ids[0], log), io, { bid: '3' });
        await gameHandlers.playCard(makeSocket(ids[0], log), io, { card: C('2', 'hearts') });

        expect(game.playerBids.filter((b) => b != null)).toEqual([]);
        expect(game.playedCardsIndex).toBe(0);
        const rejected = log.filter((l) => l.event === 'actionRejected').map((l) => l.data.action);
        expect(rejected).toEqual(['bid', 'play']);
        gameManager.abortGame(game.gameId);
    });
});

describe('playCard validation', () => {
    function playingGame() {
        const { game, ids } = setupGame(2, [
            [C('2', 'hearts'), C('3', 'hearts')],
            [C('4', 'hearts'), C('5', 'hearts')],
            [C('6', 'hearts'), C('7', 'hearts')],
            [C('8', 'hearts'), C('9', 'hearts')],
        ]);
        game.trump = C('A', 'spades');
        game.forcePhase('PLAYING');
        game.currentTurn = 1;
        game.bids = { team1: 1, team2: 1 };
        game.playerBids = ['1', '0', '0', '1'];
        return { game, ids };
    }

    test('a second play during the trick-resolution pause is rejected and the trick still resolves', async () => {
        const log = [];
        const io = makeIo(log);
        const { game, ids } = playingGame();
        const s = ids.map((id) => makeSocket(id, log));

        await gameHandlers.playCard(s[0], io, { card: C('2', 'hearts') });
        await gameHandlers.playCard(s[1], io, { card: C('4', 'hearts') });
        await gameHandlers.playCard(s[2], io, { card: C('6', 'hearts') });
        const fourth = gameHandlers.playCard(s[3], io, { card: C('8', 'hearts') }); // 2s resolution pause
        await sleep(100);
        await gameHandlers.playCard(s[0], io, { card: C('3', 'hearts') }); // leader again, mid-pause
        await fourth;

        expect(log.some((l) => l.event === 'trickComplete')).toBe(true);
        expect(game.tricks.team1 + game.tricks.team2).toBe(1);
        expect(log.some((l) => l.to === `self:${ids[0]}` && l.event === 'actionRejected')).toBe(true);
        gameManager.abortGame(game.gameId);
    }, 10000);

    test('a card not in the hand is rejected and never injected', async () => {
        const log = [];
        const io = makeIo(log);
        const { game, ids } = playingGame();

        await gameHandlers.playCard(makeSocket(ids[0], log), io, { card: C('HI', 'joker') });

        expect(game.playedCardsIndex).toBe(0);
        expect(game.getHand(ids[0])).toEqual([C('2', 'hearts'), C('3', 'hearts')]);
        expect(log.find((l) => l.event === 'actionRejected').data.reason).toBe('invalid_play');
        gameManager.abortGame(game.gameId);
    });

    test('a card not in the hand resyncs the sender with its true seat state', async () => {
        // iOS builds before the fix kept cards the lazy bot played after /active
        const log = [];
        const io = makeIo(log);
        const { game, ids } = playingGame();

        await gameHandlers.playCard(makeSocket(ids[0], log), io, { card: C('HI', 'joker') });

        const mine = log.filter((l) => l.to === `self:${ids[0]}`).map((l) => l.event);
        expect(mine).toEqual(['actionRejected', 'restorePlayerState']);
        const restore = log.find((l) => l.event === 'restorePlayerState').data;
        expect(restore.hand).toEqual([C('2', 'hearts'), C('3', 'hearts')]);
        expect(restore.position).toBe(1);

        // Other refusals (wrong turn) do not resync
        const before = log.length;
        await gameHandlers.playCard(makeSocket(ids[1], log), io, { card: C('4', 'hearts') });
        expect(log.slice(before).map((l) => l.event)).toEqual(['actionRejected']);
        gameManager.abortGame(game.gameId);
    });
});

describe('playerBid validation', () => {
    function biddingGame() {
        const { game, ids } = setupGame(2, [[C('2', 'hearts')], [C('4', 'hearts')], [C('6', 'hearts')], [C('8', 'hearts')]]);
        game.trump = C('A', 'spades');
        game.forcePhase('BIDDING');
        game.currentTurn = 1;
        game.playerBids = [];
        return { game, ids };
    }

    test('a bid larger than the hand is rejected', async () => {
        const log = [];
        const { game, ids } = biddingGame();
        await gameHandlers.playerBid(makeSocket(ids[0], log), makeIo(log), { bid: '5' });
        expect(game.playerBids[0]).toBeUndefined();
        expect(log.find((l) => l.event === 'actionRejected').data.reason).toBe('invalid_bid');
        gameManager.abortGame(game.gameId);
    });

    test('a skipped bore level is rejected', async () => {
        const log = [];
        const { game, ids } = biddingGame();
        await gameHandlers.playerBid(makeSocket(ids[0], log), makeIo(log), { bid: '2B' });
        expect(game.playerBids[0]).toBeUndefined();
        gameManager.abortGame(game.gameId);
    });
});

describe('isValidBid', () => {
    test.each([
        ['0', [], 1, true],
        ['2', [], 2, true],
        ['3', [], 2, false],
        ['B', [], 2, true],
        ['2B', [], 2, false],
        ['2B', ['B'], 2, true],
        ['3B', ['B'], 2, false],
        ['3B', ['B', '2B'], 2, true],
        ['4B', ['B', '2B', '3B'], 2, true],
        ['X', [], 2, false],
    ])('%s with %j on %i cards -> %s', (bid, bids, size, ok) => {
        expect(isValidBid(bid, bids, size)).toBe(ok);
    });
});

describe('rejoinGame authentication', () => {
    function gameWithVictim() {
        const { game, ids } = setupGame(2, [[C('2', 'hearts')], [C('4', 'hearts')], [C('6', 'hearts')], [C('8', 'hearts')]]);
        const victim = `user_${ids[1]}`;
        mockUsers[victim] = { username: victim, sessionToken: 'good-token' };
        return { game, ids, victim };
    }

    test('an unauthenticated socket cannot take a seat by naming its user', async () => {
        const log = [];
        const { game, ids, victim } = gameWithVictim();
        const attacker = makeSocket(`attacker-${seq}`, log);

        await reconnectHandlers.rejoinGame(attacker, makeIo(log), { gameId: game.gameId, username: victim });

        expect(log.some((l) => l.event === 'rejoinSuccess')).toBe(false);
        expect(log.find((l) => l.event === 'rejoinFailed').data.reason).toBe('Not authenticated');
        expect(game.getPlayerByPosition(2).socketId).toBe(ids[1]);
        expect(gameManager.getUserBySocketId(attacker.id)).toBeUndefined();
        gameManager.abortGame(game.gameId);
    });

    test('a wrong session token is refused', async () => {
        const log = [];
        const { game, victim } = gameWithVictim();
        await reconnectHandlers.rejoinGame(makeSocket(`attacker2-${seq}`, log), makeIo(log), {
            gameId: game.gameId, username: victim, sessionToken: 'guess',
        });
        expect(log.some((l) => l.event === 'rejoinSuccess')).toBe(false);
        gameManager.abortGame(game.gameId);
    });

    test('the real user rejoins with their session token', async () => {
        const log = [];
        const { game, victim } = gameWithVictim();
        const fresh = makeSocket(`reconnect-${seq}`, log);

        await reconnectHandlers.rejoinGame(fresh, makeIo(log), { gameId: game.gameId, username: victim, sessionToken: 'good-token' });

        expect(log.some((l) => l.event === 'rejoinSuccess')).toBe(true);
        expect(game.getPlayerByPosition(2).socketId).toBe(fresh.id);
        gameManager.abortGame(game.gameId);
    });

    // Per-device tokens (server/utils/sessionTokens.js): the user document
    // holds only hashes in sessionTokens, one per signed-in device
    function gameWithDeviceSessions() {
        const { issueSession } = require('../../utils/sessionTokens');
        const { game, ids, victim } = gameWithVictim();
        const phone = issueSession(null);
        const laptop = issueSession({ sessionTokens: phone.update.$set.sessionTokens });
        mockUsers[victim] = { username: victim, sessionTokens: laptop.update.$set.sessionTokens };
        return { game, ids, victim, phoneToken: phone.token, laptopToken: laptop.token };
    }

    test('a per-device session token rejoins (any of the user\'s devices)', async () => {
        const log = [];
        const { game, victim, phoneToken } = gameWithDeviceSessions();
        const fresh = makeSocket(`device-${seq}`, log);

        await reconnectHandlers.rejoinGame(fresh, makeIo(log), { gameId: game.gameId, username: victim, sessionToken: phoneToken });

        expect(log.some((l) => l.event === 'rejoinSuccess')).toBe(true);
        expect(game.getPlayerByPosition(2).socketId).toBe(fresh.id);
        gameManager.abortGame(game.gameId);
    });

    test('a wrong token is refused when the user has per-device sessions', async () => {
        const log = [];
        const { game, ids, victim } = gameWithDeviceSessions();

        await reconnectHandlers.rejoinGame(makeSocket(`attacker3-${seq}`, log), makeIo(log), {
            gameId: game.gameId, username: victim, sessionToken: '44444444-4444-4444-8444-444444444444',
        });

        expect(log.some((l) => l.event === 'rejoinSuccess')).toBe(false);
        expect(log.find((l) => l.event === 'rejoinFailed').data.reason).toBe('Not authenticated');
        expect(game.getPlayerByPosition(2).socketId).toBe(ids[1]);
        gameManager.abortGame(game.gameId);
    });

    test('a merged (retired) account cannot rejoin with an old token', async () => {
        const log = [];
        const { game, victim, phoneToken } = gameWithDeviceSessions();
        mockUsers[victim] = { username: victim, mergedInto: 'Someone' };

        await reconnectHandlers.rejoinGame(makeSocket(`retired-${seq}`, log), makeIo(log), {
            gameId: game.gameId, username: victim, sessionToken: phoneToken,
        });

        expect(log.some((l) => l.event === 'rejoinSuccess')).toBe(false);
        gameManager.abortGame(game.gameId);
    });

    test('a socket already signed in as the user rejoins without a token', async () => {
        const log = [];
        const { game, victim } = gameWithVictim();
        const fresh = makeSocket(`signedin-${seq}`, log);
        gameManager.registerUser(fresh.id, victim);

        await reconnectHandlers.rejoinGame(fresh, makeIo(log), { gameId: game.gameId, username: victim });

        expect(log.some((l) => l.event === 'rejoinSuccess')).toBe(true);
        gameManager.abortGame(game.gameId);
    });
});
