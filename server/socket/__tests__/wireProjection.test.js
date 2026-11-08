/**
 * Golden wire projection: the internal stage FSM must not change what
 * clients see. For every stage, getClientState / spectatorJoined carry the
 * same field set and the legacy `phase` / `bidding` / `bids` / `currentTurn`
 * values the App Store iOS client and the web client read.
 */

const { createMemoryDb } = require('../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const Deck = require('../../game/Deck');
const gameManager = require('../../game/GameManager');
const gameHandlers = require('../gameHandlers');
const mainRoomHandlers = require('../mainRoomHandlers');
const { Phase } = require('../../game/GamePhase');
const { makeIo, makeSocket, events, legalCards } = require('../../testUtils/gameDriver');

// getClientState fields at 518308c (before the FSM)
const LEGACY_CLIENT_STATE_KEYS = [
    'gameId', 'position', 'hand', 'trump', 'currentHand', 'dealer', 'phase', 'bidding',
    'currentTurn', 'bids', 'playerBids', 'tricks', 'score', 'playedCards', 'leadPosition',
    'isTrumpBroken', 'players', 'gameLog', 'hsiValues', 'resignedPositions', 'lazyPositions', 'isLazy'
].sort();

// spectatorJoined (to the joining socket) fields at 518308c
const LEGACY_SPECTATOR_KEYS = [
    'gameId', 'players', 'trump', 'currentHand', 'dealer', 'phase', 'bidding', 'currentTurn',
    'bids', 'playerBids', 'tricks', 'score', 'playedCards', 'isTrumpBroken', 'gameLog', 'spectatorCount'
].sort();

// CHANGED (snapshot v2, additive): the full state gains `snapshot` (read by
// neither shipped client) and leadPosition / trumpBroken / teamTricks /
// oppTricks (the shipped iOS restoreFromSpectator already reads them; web
// reads none). The legacy keys above are unchanged.
const ADDITIVE_SPECTATOR_KEYS = ['snapshot', 'leadPosition', 'trumpBroken', 'teamTricks', 'oppTricks'];

const GOLDEN = {
    CREATED: { phase: 'waiting', bidding: true },
    DRAWING: { phase: 'drawing', bidding: true },
    DRAW_RESOLVING: { phase: 'drawing', bidding: true },
    TEAMS_ANNOUNCED: { phase: 'drawing', bidding: true },
    DEALING: { phase: 'bidding', bidding: true },
    BIDDING: { phase: 'bidding', bidding: true },
    REDEAL: { phase: 'bidding', bidding: false },
    PLAYING: { phase: 'bidding', bidding: false },
    TRICK_RESOLVING: { phase: 'bidding', bidding: false },
    HAND_RESOLVING: { phase: 'bidding', bidding: false },
    ENDED: { phase: 'waiting', bidding: true },
    ABORTED: { phase: 'waiting', bidding: true },
};

const isTeamShaped = (b) => typeof b.team1 === 'number' && typeof b.team2 === 'number';

let seq = 0;

beforeEach(() => {
    jest.useFakeTimers();
    mockDb.current = createMemoryDb({ users: [] });
});

afterEach(() => {
    for (const id of Array.from(gameManager.games.keys())) gameManager.abortGame(id);
    jest.clearAllTimers();
    jest.useRealTimers();
});

function seatedGame() {
    seq++;
    const ids = [1, 2, 3, 4].map((n) => `wp${seq}-h${n}`);
    ids.forEach((id) => gameManager.registerUser(id, `user_${id}`));
    const game = gameManager.createGame(ids);
    ids.forEach((id, i) => game.addPlayer(id, `user_${id}`, i + 1, 1, false));
    return { game, ids };
}

describe('getClientState golden table (forcePhase fixtures)', () => {
    test.each(Object.keys(GOLDEN))('%s', (stage) => {
        const { game, ids } = seatedGame();
        if (stage === Phase.ENDED) {
            game.forcePhase(Phase.HAND_RESOLVING);
            game.terminate(null, Phase.ENDED);
        } else if (stage === Phase.ABORTED) {
            game.terminate(null, Phase.ABORTED);
        } else if (stage !== Phase.CREATED) {
            game.forcePhase(stage);
        }
        const state = game.getClientState(ids[0]);
        expect(Object.keys(state).sort()).toEqual(LEGACY_CLIENT_STATE_KEYS);
        expect(state.phase).toBe(GOLDEN[stage].phase);
        expect(typeof state.bidding).toBe('boolean');
        expect(state.bidding).toBe(GOLDEN[stage].bidding);
        expect(typeof state.currentTurn).toBe('number');
        expect(state).not.toHaveProperty('stage');
        expect(state).not.toHaveProperty('epoch');
    });

    test('spectatorJoined carries the legacy field set', () => {
        const log = [];
        const io = makeIo(log);
        const { game } = seatedGame();
        game.forcePhase(Phase.PLAYING);
        const spec = makeSocket(`spec-${seq}`, log, io);
        gameManager.registerUser(spec.id, `watcher_${seq}`);

        mainRoomHandlers.joinAsSpectator(spec, io, { gameId: game.gameId });

        const joined = log.find((l) => l.to === `self:${spec.id}` && l.event === 'spectatorJoined');
        expect(Object.keys(joined.data).sort()).toEqual([...LEGACY_SPECTATOR_KEYS, ...ADDITIVE_SPECTATOR_KEYS].sort());
        expect(joined.data.phase).toBe('bidding');
        expect(joined.data.bidding).toBe(false);
        // The additive keys the shipped iOS spectator restore reads
        expect(joined.data).toMatchObject({
            leadPosition: game.leadPosition,
            trumpBroken: game.isTrumpBroken,
            teamTricks: game.tricks.team1,
            oppTricks: game.tricks.team2,
        });
    });
});

describe('real game flow projections', () => {
    test('every stage reached by the real handlers projects the legacy values', async () => {
        const log = [];
        const io = makeIo(log);
        seq++;
        const ids = [1, 2, 3, 4].map((n) => `wf${seq}-h${n}`);
        ids.forEach((id) => {
            gameManager.registerUser(id, `user_${id}`);
            mockDb.current.users._insert({ username: `user_${id}`, profilePic: 5 });
        });
        const sockets = ids.map((id) => makeSocket(id, log, io));
        const game = gameManager.createGame(ids);
        game.deck = new Deck();

        const seen = [];
        const enter = game._enterStage.bind(game);
        game._enterStage = (from, to) => {
            enter(from, to);
            const state = game.getClientState(game.positions[1] || ids[0]);
            seen.push({ stage: to, state: JSON.parse(JSON.stringify(state)) });
        };

        game.transition(Phase.CREATED, Phase.DRAWING);
        const pending = sockets.map((s) => gameHandlers.draw(s, io, { num: 0 }));
        await jest.advanceTimersByTimeAsync(6000);
        expect(game.stage).toBe(Phase.BIDDING);

        const sock = (pos) => sockets[ids.indexOf(game.positions[pos])];
        // Hand 1: everyone bids 0 -> redeal
        for (let i = 0; i < 4; i++) await gameHandlers.playerBid(sock(game.currentTurn), io, { bid: '0' });
        expect(events(log, 'doneBidding')).toHaveLength(0);
        expect(game.stage).toBe(Phase.BIDDING);

        // Then a real hand: bid 1 each, play legal cards until the next deal
        for (let i = 0; i < 4; i++) await gameHandlers.playerBid(sock(game.currentTurn), io, { bid: '1' });
        let guard = 0;
        while (game.currentHand === 12 && guard++ < 500) {
            if (game.stage === Phase.PLAYING) {
                const s = sock(game.currentTurn);
                const [card] = legalCards(game, s.id);
                pending.push(gameHandlers.playCard(s, io, { card }));
                await Promise.resolve();
            } else {
                await jest.advanceTimersByTimeAsync(500);
            }
        }
        expect(game.currentHand).toBe(10);
        await Promise.all(pending);

        const stagesSeen = new Set(seen.map((s) => s.stage));
        for (const st of [Phase.DRAW_RESOLVING, Phase.TEAMS_ANNOUNCED, Phase.DEALING, Phase.BIDDING, Phase.REDEAL,
            Phase.PLAYING, Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING]) {
            expect(stagesSeen.has(st)).toBe(true);
        }
        for (const { stage, state } of seen) {
            expect(Object.keys(state).sort()).toEqual(LEGACY_CLIENT_STATE_KEYS);
            expect(state.phase).toBe(GOLDEN[stage].phase);
            expect(state.bidding).toBe(GOLDEN[stage].bidding);
            expect(typeof state.currentTurn).toBe('number');
            if (stage === Phase.BIDDING) expect(isTeamShaped(state.bids)).toBe(false);
            if ([Phase.REDEAL, Phase.PLAYING, Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING].includes(stage)) {
                expect(isTeamShaped(state.bids)).toBe(true);
            }
            if (stage === Phase.TRICK_RESOLVING) {
                expect(state.playedCards.filter(Boolean)).toHaveLength(4);
            }
            if (stage === Phase.BIDDING) {
                expect(Array.isArray(state.playerBids)).toBe(true);
            }
        }
    });
});
