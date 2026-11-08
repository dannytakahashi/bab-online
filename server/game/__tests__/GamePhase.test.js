/**
 * Unit tests for the game phase FSM (GamePhase.js) and the GameState
 * lifecycle API built on it: transitions, terminal states, the wire
 * projections of `phase`/`bidding`, the draw acceptor and the per-stage
 * invariants.
 */

const GameState = require('../GameState');
const Deck = require('../Deck');
const GamePhase = require('../GamePhase');

const { Phase, TRANSITIONS, isLegal, getViolations, resetViolations } = GamePhase;
const ALL = Object.values(Phase);
const NON_TERMINAL = ALL.filter((p) => !GamePhase.isTerminal(p));
const C = (rank, suit) => ({ rank, suit });

afterEach(() => resetViolations());

/** A game sitting in `stage` (terminal stages reached through terminate). */
function gameIn(stage) {
    const g = new GameState(`g-${stage}`);
    if (stage === Phase.ENDED) {
        g.forcePhase(Phase.HAND_RESOLVING);
        g.terminate(null, Phase.ENDED);
    } else if (stage === Phase.ABORTED) {
        g.terminate(null, Phase.ABORTED);
    } else if (stage !== Phase.CREATED) {
        g.forcePhase(stage);
    }
    return g;
}

describe('transition table', () => {
    test('has exactly 23 legal edges (13 forward + 10 aborts) and absorbing terminals', () => {
        const edges = Object.values(TRANSITIONS).reduce((n, tos) => n + tos.length, 0);
        expect(edges).toBe(23);
        expect(TRANSITIONS.ENDED).toEqual([]);
        expect(TRANSITIONS.ABORTED).toEqual([]);
        expect(isLegal(Phase.ENDED, Phase.ABORTED)).toBe(false);
    });

    const legal = [];
    const illegal = [];
    for (const from of ALL) {
        for (const to of ALL) (isLegal(from, to) ? legal : illegal).push([from, to]);
    }

    test('splits the 144 pairs into 23 legal and 121 illegal', () => {
        expect(legal).toHaveLength(23);
        expect(illegal).toHaveLength(121);
    });

    test.each(legal)('%s -> %s succeeds', (from, to) => {
        const g = gameIn(from);
        if (GamePhase.isTerminal(to)) {
            expect(g.terminate(null, to)).toBe(true);
        } else {
            expect(g.transition(from, to)).toBe(true);
        }
        expect(g.stage).toBe(to);
        expect(getViolations()).toEqual([]);
    });

    test.each(illegal)('%s -> %s is reported as illegal-edge', (from, to) => {
        const g = gameIn(from);
        expect(() => g.transition(from, to)).toThrow(/illegal-edge/);
        expect(getViolations().map((v) => v.kind)).toEqual(['illegal-edge']);
        expect(g.stage).toBe(from);
        resetViolations();
    });

    test('a terminal target through transition() is refused (use terminate)', () => {
        const g = gameIn(Phase.BIDDING);
        expect(() => g.transition(Phase.BIDDING, Phase.ABORTED)).toThrow(/use-terminate/);
        expect(g.stage).toBe(Phase.BIDDING);
        resetViolations();
    });

    test('a stale `from` is reported as illegal-from', () => {
        const g = gameIn(Phase.BIDDING);
        expect(() => g.transition(Phase.DRAWING, Phase.DRAW_RESOLVING)).toThrow(/illegal-from/);
        const [v] = getViolations();
        expect(v).toMatchObject({ kind: 'illegal-from', from: 'DRAWING', actual: 'BIDDING', to: 'DRAW_RESOLVING' });
        expect(g.stage).toBe(Phase.BIDDING);
        resetViolations();
    });

    test('production mode logs and fails closed instead of throwing', () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const g = new GameState('prod');
            g._stage = Phase.BIDDING;
            expect(g.transition(Phase.DRAWING, Phase.DRAW_RESOLVING)).toBe(false);
            expect(g.stage).toBe(Phase.BIDDING);
            expect(getViolations()).toHaveLength(1);
        } finally {
            process.env.NODE_ENV = prev;
            resetViolations();
        }
    });

    test('tryTransition on a stage mismatch returns false without a violation', () => {
        const g = gameIn(Phase.DRAW_RESOLVING);
        expect(g.tryTransition(Phase.DRAWING, Phase.DRAW_RESOLVING)).toBe(false);
        expect(getViolations()).toEqual([]);
        expect(g.stage).toBe(Phase.DRAW_RESOLVING);
    });

    test('tryTransition still reports an illegal edge', () => {
        const g = gameIn(Phase.DRAWING);
        expect(() => g.tryTransition(Phase.DRAWING, Phase.BIDDING)).toThrow(/illegal-edge/);
        resetViolations();
    });

    test('canTransition', () => {
        expect(gameIn(Phase.HAND_RESOLVING).canTransition(Phase.ENDED)).toBe(true);
        expect(gameIn(Phase.PLAYING).canTransition(Phase.ENDED)).toBe(false);
        expect(gameIn(Phase.ENDED).canTransition(Phase.ABORTED)).toBe(false);
    });

    test('forcePhase refuses terminal stages', () => {
        expect(() => new GameState('x').forcePhase(Phase.ENDED)).toThrow();
        expect(() => new GameState('x').forcePhase('NOPE')).toThrow();
    });
});

describe('terminate', () => {
    test.each(NON_TERMINAL)('ABORTED is legal from %s', (from) => {
        const g = gameIn(from);
        expect(g.terminate(null, Phase.ABORTED)).toBe(true);
        expect(g.stage).toBe(Phase.ABORTED);
        expect(g.isTerminal()).toBe(true);
    });

    test.each(NON_TERMINAL.filter((p) => p !== Phase.HAND_RESOLVING))('ENDED is refused from %s', (from) => {
        const g = gameIn(from);
        expect(() => g.terminate(null, Phase.ENDED)).toThrow();
        expect(g.stage).toBe(from);
        expect(g.epoch).toBe(0);
        resetViolations();
    });

    test('a second terminate returns false and the epoch moves exactly once', () => {
        const g = gameIn(Phase.HAND_RESOLVING);
        expect(g.terminate(null, Phase.ENDED)).toBe(true);
        expect(g.terminate(null, Phase.ABORTED)).toBe(false);
        expect(g.terminate(null, Phase.ENDED)).toBe(false);
        expect(g.epoch).toBe(1);
        expect(g.stage).toBe(Phase.ENDED);
        expect(getViolations()).toEqual([]);
    });

    function captureIo(game, log) {
        return {
            to: (room) => ({ emit: (event, data) => log.push({ room, event, data, stage: game.stage }) }),
        };
    }

    test('the final event goes out while the game is still live', () => {
        const g = gameIn(Phase.PLAYING);
        const log = [];
        g.terminate(captureIo(g, log), Phase.ABORTED, 'abortGame', { reason: 'x' });
        expect(log).toEqual([{ room: g.roomName, event: 'abortGame', data: { reason: 'x' }, stage: Phase.PLAYING }]);
    });

    test('afterwards broadcast and sendToPlayer emit nothing', () => {
        const g = gameIn(Phase.HAND_RESOLVING);
        g.addPlayer('h1', 'u1', 1, 1, false);
        const log = [];
        const io = captureIo(g, log);
        g.terminate(io, Phase.ENDED, 'gameEnd', {});
        g.broadcast(io, 'updateTurn', { currentTurn: 1 });
        g.sendToPlayer(io, 'h1', 'gameStart', {});
        expect(log.map((l) => l.event)).toEqual(['gameEnd']);
    });
});

describe('pause', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('resolves true when the game stays alive', async () => {
        const g = gameIn(Phase.BIDDING);
        const p = g.pause(1000);
        expect(g.pendingTimerCount).toBe(1);
        await jest.advanceTimersByTimeAsync(1000);
        await expect(p).resolves.toBe(true);
        expect(g.pendingTimerCount).toBe(0);
    });

    test('resolves false immediately when the game terminates mid-pause', async () => {
        const g = gameIn(Phase.BIDDING);
        let result;
        g.pause(5000).then((r) => { result = r; });
        await jest.advanceTimersByTimeAsync(100);
        g.terminate(null, Phase.ABORTED);
        await Promise.resolve();
        expect(result).toBe(false);
        expect(g.pendingTimerCount).toBe(0);
    });

    test('resolves false at once on an already-terminal game', async () => {
        const g = gameIn(Phase.ABORTED);
        await expect(g.pause(1000)).resolves.toBe(false);
        expect(g.pendingTimerCount).toBe(0);
    });

    test('aliveCheck flips when the game terminates', () => {
        const g = gameIn(Phase.DRAW_RESOLVING);
        const alive = g.aliveCheck();
        expect(alive()).toBe(true);
        g.terminate(null, Phase.ABORTED);
        expect(alive()).toBe(false);
    });
});

describe('setTimer', () => {
    const { gameLogger } = require('../../utils/logger');
    let errorSpy;
    beforeEach(() => {
        jest.useFakeTimers();
        errorSpy = jest.spyOn(gameLogger, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        errorSpy.mockRestore();
        jest.useRealTimers();
    });

    test('the same key replaces the earlier timer', async () => {
        const g = gameIn(Phase.PLAYING);
        const calls = [];
        g.setTimer('k', 1000, () => calls.push('first'));
        g.setTimer('k', 1000, () => calls.push('second'));
        expect(g.pendingTimerCount).toBe(1);
        await jest.advanceTimersByTimeAsync(1000);
        expect(calls).toEqual(['second']);
        expect(g.pendingTimerCount).toBe(0);
    });

    test('the callback is skipped after terminate and the timer is cancelled', async () => {
        const g = gameIn(Phase.PLAYING);
        const fn = jest.fn();
        g.setTimer('k', 1000, fn);
        g.terminate(null, Phase.ABORTED);
        expect(g.pendingTimerCount).toBe(0);
        await jest.advanceTimersByTimeAsync(5000);
        expect(fn).not.toHaveBeenCalled();
        expect(g.setTimer('k2', 10, fn)).toBe(false);
        await jest.advanceTimersByTimeAsync(100);
        expect(fn).not.toHaveBeenCalled();
    });

    test('sync and async throws are logged, not thrown', async () => {
        const g = gameIn(Phase.PLAYING);
        g.setTimer('sync', 10, () => { throw new Error('boom-sync'); });
        g.setTimer('async', 10, async () => { throw new Error('boom-async'); });
        await jest.advanceTimersByTimeAsync(10);
        const messages = errorSpy.mock.calls.map(([msg, meta]) => `${msg}:${meta.key}:${meta.error}`);
        expect(messages).toEqual(expect.arrayContaining([
            'Game timer failed:sync:boom-sync',
            'Game timer failed:async:boom-async',
        ]));
    });

    test('clearTimer and hasTimer', async () => {
        const g = gameIn(Phase.PLAYING);
        const fn = jest.fn();
        g.setTimer('k', 1000, fn);
        expect(g.hasTimer('k')).toBe(true);
        g.clearTimer('k');
        g.clearTimer('missing');
        expect(g.hasTimer('k')).toBe(false);
        expect(g.pendingTimerCount).toBe(0);
        await jest.advanceTimersByTimeAsync(2000);
        expect(fn).not.toHaveBeenCalled();
    });
});

describe('wire projections', () => {
    const expected = {
        CREATED: ['waiting', true],
        DRAWING: ['drawing', true],
        DRAW_RESOLVING: ['drawing', true],
        TEAMS_ANNOUNCED: ['drawing', true],
        DEALING: ['bidding', true],
        BIDDING: ['bidding', true],
        REDEAL: ['bidding', false],
        PLAYING: ['bidding', false],
        TRICK_RESOLVING: ['bidding', false],
        HAND_RESOLVING: ['bidding', false],
        ENDED: ['waiting', true],
        ABORTED: ['waiting', true],
    };

    test.each(ALL)('%s projects to the legacy phase/bidding values', (stage) => {
        const g = gameIn(stage);
        expect(GamePhase.wirePhase(stage)).toBe(expected[stage][0]);
        expect(g.phase).toBe(expected[stage][0]);
        expect(g.bidding).toBe(expected[stage][1]);
    });

    test('the wire phase is never "playing"', () => {
        expect(Object.values(GamePhase.WIRE_PHASE)).not.toContain('playing');
    });

    test('writing phase or bidding is a legacy-write violation and is ignored', () => {
        const g = gameIn(Phase.BIDDING);
        expect(() => { g.phase = 'drawing'; }).toThrow(/legacy-write/);
        expect(() => { g.bidding = false; }).toThrow(/legacy-write/);
        expect(g.phase).toBe('bidding');
        expect(g.bidding).toBe(true);
        expect(getViolations().map((v) => v.field)).toEqual(['phase', 'bidding']);
        resetViolations();
    });

    test('turn helpers follow the stage', () => {
        expect(gameIn(Phase.BIDDING).actionTypeForTurn()).toBe('bid');
        expect(gameIn(Phase.PLAYING).actionTypeForTurn()).toBe('play');
        for (const s of [Phase.DEALING, Phase.TRICK_RESOLVING, Phase.HAND_RESOLVING, Phase.TEAMS_ANNOUNCED]) {
            expect(gameIn(s).actionTypeForTurn()).toBeNull();
            expect(gameIn(s).acceptsTurnInput()).toBe(false);
        }
        expect(gameIn(Phase.CREATED).isPreSeating()).toBe(true);
        expect(gameIn(Phase.DRAW_RESOLVING).isPreSeating()).toBe(true);
        expect(gameIn(Phase.TEAMS_ANNOUNCED).isPreSeating()).toBe(false);
    });
});

describe('recordDraw', () => {
    function drawing() {
        const g = new GameState('draw');
        g.deck = new Deck();
        g.transition(Phase.CREATED, Phase.DRAWING);
        return g;
    }

    test('rejects outside DRAWING', () => {
        const g = new GameState('d');
        g.deck = new Deck();
        expect(g.recordDraw('a', 0)).toBeNull();
        g.forcePhase(Phase.DRAW_RESOLVING);
        expect(g.recordDraw('a', 0)).toBeNull();
    });

    test('rejects a duplicate socket and a 5th draw', () => {
        const g = drawing();
        expect(g.recordDraw('a', 0)).not.toBeNull();
        expect(g.recordDraw('a', 0)).toBeNull();
        expect(g.recordDraw('b', 0)).not.toBeNull();
        expect(g.recordDraw('c', 0)).not.toBeNull();
        expect(g.recordDraw('d', 0)).not.toBeNull();
        expect(g.recordDraw('e', 0)).toBeNull();
        expect(g.drawIDs).toEqual(['a', 'b', 'c', 'd']);
        expect(g.drawCards).toHaveLength(4);
        expect(g.drawIndex).toBe(4);
    });

    test('rejects an empty or missing deck', () => {
        const g = drawing();
        g.deck.cards = [];
        expect(g.recordDraw('a', 0)).toBeNull();
        g.deck = null;
        expect(g.recordDraw('a', 0)).toBeNull();
    });

    test('clamps negative, NaN and too-large indexes', () => {
        const g = drawing();
        const first = g.deck.cards[0];
        expect(g.recordDraw('a', -5).card).toEqual(first);
        const nextFirst = g.deck.cards[0];
        expect(g.recordDraw('b', 'abc').card).toEqual(nextFirst);
        const last = g.deck.cards[g.deck.cards.length - 1];
        expect(g.recordDraw('c', 9999).card).toEqual(last);
        expect(g.recordDraw('d', null).card).toBeTruthy(); // random
        expect(g.deck.cards).toHaveLength(54 - 4);
    });

    test('drawOrder runs 1..4', () => {
        const g = drawing();
        expect(['a', 'b', 'c', 'd'].map((id) => g.recordDraw(id, 3).drawOrder)).toEqual([1, 2, 3, 4]);
    });
});

describe('validateGameState', () => {
    const IDS = ['s1', 's2', 's3', 's4'];
    function seated(stage) {
        const g = new GameState(`v-${stage}`);
        IDS.forEach((id, i) => g.addPlayer(id, `u${i + 1}`, i + 1, 1, false));
        g.forcePhase(stage);
        return g;
    }
    const hearts = (n, from = 2) => Array.from({ length: n }, (_, i) => C(String(from + i), 'hearts'));

    const fixtures = {
        CREATED: () => [new GameState('c'), null],
        DRAWING: () => {
            const g = new GameState('d');
            g.deck = new Deck();
            g.forcePhase(Phase.DRAWING);
            g.recordDraw('a', 0);
            g.recordDraw('b', 0);
            return [g, () => { g.drawIDs.push('a'); g.drawCards.push(C('2', 'clubs')); g.drawIndex++; }];
        },
        DRAW_RESOLVING: () => {
            const g = new GameState('dr');
            g.deck = new Deck();
            g.forcePhase(Phase.DRAWING);
            ['a', 'b', 'c', 'd'].forEach((id) => g.recordDraw(id, 0));
            g.forcePhase(Phase.DRAW_RESOLVING);
            return [g, () => { g.drawIDs.pop(); g.drawCards.pop(); g.drawIndex--; }];
        },
        TEAMS_ANNOUNCED: () => {
            const g = seated(Phase.TEAMS_ANNOUNCED);
            return [g, () => g.removePlayer('s4')];
        },
        DEALING: () => {
            const g = seated(Phase.DEALING);
            return [g, () => { g.currentTurn = 0; }];
        },
        BIDDING: () => {
            const g = seated(Phase.BIDDING);
            g.currentHand = 2;
            g.trump = C('A', 'spades');
            IDS.forEach((id, i) => g.setHand(id, hearts(2, 2 + i * 2)));
            g.recordBid(2, '1');
            g.currentTurn = 3;
            return [g, () => { g.currentTurn = 4; }];
        },
        REDEAL: () => {
            const g = seated(Phase.REDEAL);
            g.trump = C('A', 'spades');
            g.bids = { team1: 0, team2: 0 };
            return [g, () => { g.bids = { 1: '0' }; }];
        },
        PLAYING: () => {
            const g = seated(Phase.PLAYING);
            g.currentHand = 2;
            g.trump = C('A', 'spades');
            g.bids = { team1: 1, team2: 1 };
            IDS.forEach((id, i) => g.setHand(id, hearts(i === 0 ? 1 : 2, 2 + i * 2)));
            g.playedCards[0] = C('K', 'hearts');
            g.playedCardsIndex = 1;
            g.cardIndex = 1;
            g.leadPosition = 1;
            g.currentTurn = 2;
            return [g, () => { g.currentTurn = 3; }];
        },
        TRICK_RESOLVING: () => {
            const g = seated(Phase.TRICK_RESOLVING);
            g.currentHand = 1;
            g.trump = C('A', 'spades');
            g.playedCards = hearts(4);
            g.playedCardsIndex = 4;
            return [g, () => { g.playedCards[2] = null; }];
        },
        HAND_RESOLVING: () => {
            const g = seated(Phase.HAND_RESOLVING);
            g.currentHand = 1;
            g.trump = C('A', 'spades');
            IDS.forEach((id) => g.setHand(id, []));
            g.tricks = { team1: 1, team2: 0 };
            return [g, () => { g.tricks = { team1: 0, team2: 0 }; }];
        },
    };

    test.each(Object.keys(fixtures))('%s: a consistent fixture passes and a broken one fails', (stage) => {
        const [g, breakIt] = fixtures[stage]();
        expect(g.validateGameState()).toEqual({ valid: true, errors: [] });
        if (breakIt) {
            breakIt();
            const result = g.validateGameState();
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        }
    });

    test('terminal stages require no pending timers', () => {
        const g = gameIn(Phase.ABORTED);
        expect(g.validateGameState().valid).toBe(true);
        g._timers.set('leak', setTimeout(() => {}, 0));
        expect(g.validateGameState().valid).toBe(false);
        clearTimeout(g._timers.get('leak'));
    });

    test('BAB_FSM_CHECK=1 reports invariant violations on transition', () => {
        process.env.BAB_FSM_CHECK = '1';
        try {
            const g = seated(Phase.TEAMS_ANNOUNCED);
            g.removePlayer('s4');
            g.forcePhase(Phase.DRAW_RESOLVING);
            g.drawIndex = 4; g.drawIDs = ['a', 'b', 'c', 'd']; g.drawCards = hearts(4);
            expect(() => g.transition(Phase.DRAW_RESOLVING, Phase.TEAMS_ANNOUNCED)).toThrow(/invariant/);
            expect(getViolations()[0].kind).toBe('invariant');
        } finally {
            delete process.env.BAB_FSM_CHECK;
            resetViolations();
        }
    });
});
