/**
 * GameState.restoreFrom / restoreSeats, the restore writers (deploy
 * survival, PR 3): the seat matrix (every legal controller/presence a seat
 * is saved in, and what it comes back as), the refusals (anywhere outside
 * a restore is a reported violation; a bad doc is a CodecError), a
 * rejoin on a restored game re-keying the hand to the owner's socket, and
 * a lobby-born game's voice settings and play-again origin.
 */

const { createMemoryDb } = require('../../../testUtils/memoryDb');

const mockDb = { current: null };
jest.mock('../../../database', () => ({
    getUsersCollection: () => mockDb.current.users,
    getGameRecordsCollection: () => mockDb.current.gameRecords,
    getReportsCollection: () => mockDb.current.reports,
}));

const GameState = require('../../GameState');
const GamePhase = require('../../GamePhase');
const { LEGAL, RECONNECT_GRACE_MS, validateSeats } = require('../../SeatState');
const gameManager = require('../../GameManager');
const { botController } = require('../../bot');
const reconnectHandlers = require('../../../socket/reconnectHandlers');
const { makeIo, makeSocket } = require('../../../testUtils/gameDriver');
const { adoptForTest } = require('../../../testUtils/restoreKit');
const { gameLogger, socketLogger, authLogger, logger } = require('../../../utils/logger');
const codec = require('../gameCodec');

const { Phase } = GamePhase;
const NOW = 1_800_000_000_000;
const GAME_ID = 'g-restore-1';

beforeAll(() => { process.env.BAB_FSM_CHECK = '1'; });
afterAll(() => { delete process.env.BAB_FSM_CHECK; });

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
    botController._resetForTests();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
});

const C = (suit, rank) => ({ suit, rank });
const HANDS = {
    1: [C('spades', 'A'), C('hearts', '2')],
    2: [C('clubs', 'K'), C('hearts', '9')],
    3: [C('diamonds', 'Q'), C('spades', '3')],
    4: [C('joker', 'HI'), C('clubs', '4')],
};
const BOTS = {
    1: { socketId: 'bot:mary:1', username: '🤖 Mary', pic: 11, personality: 'mary' },
    2: { socketId: 'bot:sharon:2', username: '🤖 Sharon', pic: 12, personality: 'sharon' },
    3: { socketId: 'bot:danny:3', username: '🤖 Danny', pic: 13, personality: 'danny' },
    4: { socketId: 'bot:mike:4', username: '🤖 Mike', pic: 14, personality: 'mike' },
};

const nativeSeat = (pos) => ({
    controller: 'bot', presence: 'none', ownerUsername: null, ownerPic: null, bot: { ...BOTS[pos] },
    lastPersonality: BOTS[pos].personality, resignedAt: null, leftAt: null, gone: false,
});

/** A saved seat record of `controller`/`presence` for an owner at `pos`. */
function savedSeat(pos, controller, presence, extra = {}) {
    if (controller === 'bot') return nativeSeat(pos);
    const human = controller === 'human';
    return {
        controller,
        presence,
        ownerUsername: `owner${pos}`,
        ownerPic: 20 + pos,
        bot: human ? null : { ...BOTS[pos] },
        lastPersonality: human ? null : BOTS[pos].personality,
        resignedAt: controller === 'resignBot' ? NOW - 5000 : null,
        leftAt: presence === 'gone' ? NOW - 4000 : null,
        gone: presence === 'gone',
        ...extra,
    };
}

/** A BIDDING doc (2-card hand, first bid to come) with the given seats. */
function bidDoc(seats) {
    const bots = [];
    for (let pos = 1; pos <= 4; pos++) {
        const s = seats[pos];
        if (s.bot) bots.push({ ...s.bot, position: pos, partnerHistory: [] });
    }
    return {
        v: codec.CODEC_V,
        gameId: GAME_ID,
        stage: Phase.BIDDING,
        tournamentId: null,
        state: {
            createdAt: NOW - 600000,
            eventSeq: 140,
            dealSeq: 6,
            currentHand: 2,
            dealer: 1,
            bidder: 2,
            bids: {},
            playerBids: [null, null, null, null],
            team1Mult: 1,
            team2Mult: 1,
            currentTurn: 2,
            leadPosition: 1,
            leadCard: null,
            playedCards: [null, null, null, null],
            playedCardsIndex: 0,
            trump: C('hearts', 'K'),
            isTrumpBroken: false,
            cardIndex: 0,
            tricks: { team1: 0, team2: 0 },
            trickHistory: [],
            score: { team1: 120, team2: -40 },
            rainbows: { team1: 0, team2: 0 },
            handStats: { totalHands: 5, team1Sets: 1, team2Sets: 2 },
            playerStats: {
                1: { totalBids: 9, totalTricks: 8, setsCaused: 0, totalHSI: 40 },
                2: { totalBids: 7, totalTricks: 6, setsCaused: 1, totalHSI: 33 },
                3: { totalBids: 8, totalTricks: 9, setsCaused: 0, totalHSI: 38 },
                4: { totalBids: 6, totalTricks: 5, setsCaused: 1, totalHSI: 29 },
            },
            handTricks: { 1: 0, 2: 0, 3: 0, 4: 0 },
            hsiValues: { 1: 7, 2: 5, 3: 6, 4: 9 },
            hands: JSON.parse(JSON.stringify(HANDS)),
            seats,
            seatOrder: [1, 2, 3, 4],
            casualVoice: null,
            lobbyOrigin: null,
        },
        log: [{ message: 'Game started!', playerPosition: null, type: 'system', timestamp: NOW - 600000 }],
        logTotal: 1,
        bots,
    };
}

function allNative() {
    return { 1: nativeSeat(1), 2: nativeSeat(2), 3: nativeSeat(3), 4: nativeSeat(4) };
}

const expectThrowsViolation = (fn, kind) => {
    expect(fn).toThrow(new RegExp(`FSM ${kind}`));
    expect(GamePhase.getViolations().map((v) => v.kind)).toContain(kind);
    GamePhase.resetViolations();
};

describe('the seat matrix', () => {
    const cases = [];
    for (const [controller, presences] of Object.entries(LEGAL)) {
        for (const presence of presences) cases.push([controller, presence]);
    }
    const restoredAs = (controller, presence) => {
        if (controller === 'human') return 'grace';
        if (controller === 'bot') return 'none';
        return presence === 'gone' ? 'gone' : 'away';
    };

    test.each(cases)('%s/%s at seat 1', async (controller, presence) => {
        const seats = allNative();
        seats[1] = savedSeat(1, controller, presence);
        const doc = bidDoc(seats);
        const expire = jest.fn();
        const { game, bots } = codec.hydrate(JSON.parse(JSON.stringify(doc)), { now: NOW, onGraceExpire: expire });

        const s = game.seat(1);
        expect(s.controller).toBe(controller);
        expect(s.presence).toBe(restoredAs(controller, presence));
        expect(s.ownerSocketId).toBeNull();
        expect(s.ownerView).toBeNull();
        expect(s.resignableAt).toBeNull();
        expect(validateSeats(game)).toEqual([]);
        expect(game.validateGameState().errors).toEqual([]);
        expect(game.stage).toBe(Phase.BIDDING);
        expect(game.eventSeq).toBe(140 + codec.EVENT_SEQ_OFFSET);
        expect(game.entrants).toBeNull();

        if (controller === 'human') {
            const key = GameState.restoredSeatSocketId(GAME_ID, 1);
            expect(s.seatSocketId).toBe(key);
            expect(s.bot).toBeNull();
            expect(s.graceDeadline).toBe(NOW + RECONNECT_GRACE_MS);
            expect(s.absentSince).toBe(NOW);
            expect(game.hasTimer('grace:1')).toBe(true);
            expect(game.hands[key]).toEqual(HANDS[1]);
            expect(game.getPlayerByPosition(1)).toEqual({ socketId: key, username: 'owner1', position: 1, pic: 21 });
        } else {
            expect(s.seatSocketId).toBe(BOTS[1].socketId);
            expect(s.bot).toEqual(BOTS[1]);
            expect(s.graceDeadline).toBeNull();
            expect(game.hasTimer('grace:1')).toBe(false);
            expect(game.hands[BOTS[1].socketId]).toEqual(HANDS[1]);
            expect(game.getPlayerByPosition(1)).toEqual({ socketId: BOTS[1].socketId, username: BOTS[1].username, position: 1, pic: 11 });
            expect(bots.find((b) => b.position === 1)).toEqual({ ...BOTS[1], position: 1, partnerHistory: [] });
        }
        if (controller === 'bot') {
            expect(s.ownerUsername).toBeNull();
            expect(s.absentSince).toBeNull();
        } else {
            expect(s.ownerUsername).toBe('owner1');
            expect(s.ownerPic).toBe(21);
            expect(s.lastPersonality).toBe(controller === 'human' ? null : 'mary');
            expect(s.resignedAt).toBe(controller === 'resignBot' ? NOW - 5000 : null);
            expect(s.leftAt).toBe(presence === 'gone' ? NOW - 4000 : null);
        }

        // It serializes back to what was saved, presence mapped
        const again = codec.serialize(game, { tournamentId: null, getBot: () => null });
        expect(again).toEqual(codec.expectedAfterRestore(doc));

        // A restored human seat's grace runs out like any other
        await jest.advanceTimersByTimeAsync(RECONNECT_GRACE_MS);
        expect(expire).toHaveBeenCalledTimes(controller === 'human' ? 1 : 0);
        if (controller === 'human') expect(expire).toHaveBeenCalledWith(game, 1);
        game._cancelAllTimers();
    });

    test('four humans, one resigned and gone, one lazy: each as the table says', () => {
        const seats = {
            1: savedSeat(1, 'human', 'connected'),
            2: savedSeat(2, 'human', 'resignable'),
            3: savedSeat(3, 'resignBot', 'gone'),
            4: savedSeat(4, 'lazyBot', 'connected'),
        };
        const { game } = codec.hydrate(bidDoc(seats), { now: NOW });
        expect(game.presenceSummary().map((p) => `${p.controller}/${p.presence}`))
            .toEqual(['human/grace', 'human/grace', 'resignBot/gone', 'lazyBot/away']);
        expect(game.hasPresentHuman()).toBe(false);
        expect(game.timerKeys().sort()).toEqual(['grace:1', 'grace:2']);
        expect(game.validateGameState().errors).toEqual([]);
        game._cancelAllTimers();
    });

    test('a custom owner picture is not saved (the adopter warms the current one)', () => {
        const seats = allNative();
        seats[1] = savedSeat(1, 'human', 'connected', { ownerPic: 'data:image/png;base64,AAAA' });
        const { game } = codec.hydrate(bidDoc(seats), { now: NOW });
        expect(game.seat(1).ownerPic).toBe('data:image/png;base64,AAAA');
        const doc = codec.serialize(game, { tournamentId: null, getBot: () => null });
        expect(doc.state.seats[1].ownerPic).toBeNull();
        game._cancelAllTimers();
    });
});

describe('outside a restore', () => {
    test('restoreFrom on a game that already ran is a violation and changes nothing', () => {
        const game = new GameState('g-live');
        game.nextSeq();
        expectThrowsViolation(() => game.restoreFrom(Phase.BIDDING, bidDoc(allNative()).state), 'restore-outside');
        expect(game.stage).toBe(Phase.CREATED);
        expect(game.seatList()).toEqual([]);
    });

    test('a second restoreFrom on a restored game is a violation', () => {
        const { game } = codec.hydrate(bidDoc(allNative()), { now: NOW });
        expectThrowsViolation(() => game.restoreFrom(Phase.BIDDING, bidDoc(allNative()).state), 'restore-outside');
        expect(game.eventSeq).toBe(140 + codec.EVENT_SEQ_OFFSET);
    });

    test('restoreSeats outside restoreFrom is a violation', () => {
        const game = new GameState('g-fresh');
        expectThrowsViolation(() => game.restoreSeats(allNative()), 'restore-outside');
        expect(game.seatList()).toEqual([]);
        const { game: restored } = codec.hydrate(bidDoc(allNative()), { now: NOW });
        expectThrowsViolation(() => restored.restoreSeats(allNative()), 'restore-outside');
    });

    test('restoreFrom into a stage that is never saved is a violation', () => {
        for (const stage of [Phase.CREATED, Phase.DRAWING, Phase.TEAMS_ANNOUNCED, Phase.DEALING, Phase.REDEAL, Phase.ENDED, Phase.ABORTED]) {
            const game = new GameState(`g-${stage}`);
            expectThrowsViolation(() => game.restoreFrom(stage, bidDoc(allNative()).state), 'restore-stage');
            expect(game.stage).toBe(Phase.CREATED);
        }
    });

    test('hydrate refuses another codec version, a bad stage and a malformed doc', () => {
        const doc = bidDoc(allNative());
        expect(() => codec.hydrate({ ...doc, v: codec.CODEC_V + 1 })).toThrow(expect.objectContaining({ reason: 'version' }));
        expect(() => codec.hydrate({ ...doc, stage: Phase.DEALING })).toThrow(expect.objectContaining({ reason: 'stage' }));
        expect(() => codec.hydrate({ ...doc, state: null })).toThrow(expect.objectContaining({ reason: 'state' }));
        expect(() => codec.hydrate(null)).toThrow(expect.objectContaining({ reason: 'no doc' }));
    });

    test('hydrate refuses a doc whose game fails its invariants, and leaves no timer', () => {
        const seats = allNative();
        seats[1] = savedSeat(1, 'human', 'connected');
        const doc = bidDoc(seats);
        doc.state.hands[2].push(C('clubs', '2')); // 3 cards on a 2-card deal
        let err = null;
        try {
            codec.hydrate(doc, { now: NOW });
        } catch (e) {
            err = e;
        }
        expect(err).toMatchObject({ name: 'CodecError' });
        expect(['restore', 'invalid']).toContain(err.reason);
        GamePhase.resetViolations();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a seat record with a bot controller but no bot is refused', () => {
        const seats = allNative();
        seats[2] = { ...seats[2], bot: null };
        expect(() => codec.hydrate(bidDoc(seats), { now: NOW })).toThrow(expect.objectContaining({ name: 'CodecError' }));
        GamePhase.resetViolations();
    });
});

describe('a rejoin on a restored game', () => {
    function adopt(seats) {
        const log = [];
        const io = makeIo(log);
        const game = adoptForTest(bidDoc(seats), { io, now: NOW });
        return { io, log, game };
    }

    test('a human owner rejoins: seated on the new socket, the hand re-keyed to it', async () => {
        const seats = allNative();
        seats[3] = savedSeat(3, 'human', 'connected');
        const { io, log, game } = adopt(seats);
        const key = GameState.restoredSeatSocketId(GAME_ID, 3);
        expect(game.hands[key]).toEqual(HANDS[3]);

        const socket = makeSocket('sock-owner3', log, io);
        gameManager.registerUser(socket.id, 'owner3');
        await reconnectHandlers.rejoinGame(socket, io, { gameId: GAME_ID, username: 'owner3' });

        const s = game.seat(3);
        expect(`${s.controller}/${s.presence}`).toBe('human/connected');
        expect(s.ownerSocketId).toBe('sock-owner3');
        expect(s.seatSocketId).toBe('sock-owner3');
        expect(game.hands['sock-owner3']).toEqual(HANDS[3]);
        expect(game.hands[key]).toBeUndefined();
        expect(game.players.has(key)).toBe(false);
        expect(game.hasTimer('grace:3')).toBe(false);
        expect(gameManager.playerGames.get('sock-owner3')).toBe(GAME_ID);
        const success = log.find((l) => l.to === 'self:sock-owner3' && l.event === 'rejoinSuccess');
        expect(success).toBeDefined();
        expect(success.data.snapshot.hand).toEqual(HANDS[3]);
        expect(success.data.snapshot.viewer).toMatchObject({ role: 'seat', position: 3 });
        // No synthetic id ever reaches the wire
        expect(JSON.stringify(log)).not.toContain('restored:');
        expect(game.validateGameState().errors).toEqual([]);
    });

    test('a lazy owner rejoins: watching the seat its bot still plays', async () => {
        const seats = allNative();
        seats[4] = savedSeat(4, 'lazyBot', 'connected');
        const { io, log, game } = adopt(seats);
        expect(botController.getBot(GAME_ID, BOTS[4].socketId)).toMatchObject({ position: 4, personality: 'mike' });

        const socket = makeSocket('sock-owner4', log, io);
        gameManager.registerUser(socket.id, 'owner4');
        await reconnectHandlers.rejoinGame(socket, io, { gameId: GAME_ID, username: 'owner4' });

        const s = game.seat(4);
        expect(`${s.controller}/${s.presence}`).toBe('lazyBot/connected');
        expect(s.ownerSocketId).toBe('sock-owner4');
        expect(s.seatSocketId).toBe(BOTS[4].socketId);
        const success = log.find((l) => l.to === 'self:sock-owner4' && l.event === 'rejoinSuccess');
        expect(success.data.snapshot.hand).toEqual(HANDS[4]);
        expect(game.validateGameState().errors).toEqual([]);
    });

    test('a gone owner is refused, as on a live game', async () => {
        const seats = allNative();
        seats[2] = savedSeat(2, 'resignBot', 'gone');
        const { io, log } = adopt(seats);
        const socket = makeSocket('sock-owner2', log, io);
        gameManager.registerUser(socket.id, 'owner2');
        await reconnectHandlers.rejoinGame(socket, io, { gameId: GAME_ID, username: 'owner2' });
        expect(log.find((l) => l.to === 'self:sock-owner2' && l.event === 'rejoinFailed')).toBeDefined();
    });
});

describe('a lobby-born casual game (family lobby voice, play again)', () => {
    // Saved before 2026-11-18, with "Spectators can talk" off: it restores on
    function lobbyDoc() {
        const seats = allNative();
        seats[1] = savedSeat(1, 'human', 'connected');
        seats[3] = savedSeat(3, 'human', 'connected');
        const doc = bidDoc(seats);
        doc.state.casualVoice = { host: 'owner1', spectatorsCanTalk: false, lobbyExtras: ['watcher5'] };
        doc.state.lobbyOrigin = {
            lobbyId: 'lobby-1', name: "owner1's Game", createdBy: 'owner1', host: 'owner1',
            settings: { spectatorsCanTalk: false },
            order: ['owner1', BOTS[2].socketId, 'owner3', BOTS[4].socketId, 'watcher5'],
            bots: [[BOTS[2].socketId, 'sharon'], [BOTS[4].socketId, 'mike']],
            playAgainUsers: ['owner1', 'watcher5'], casualUsers: ['owner1', 'owner3', 'watcher5'], extras: ['watcher5'],
        };
        return doc;
    }

    test('hydrate rebuilds the voice settings (spectator talk always on) with an empty voice room and the origin without chat; it saves back the same', () => {
        const doc = lobbyDoc();
        const { game } = codec.hydrate(JSON.parse(JSON.stringify(doc)), { now: NOW });
        try {
            expect(game.casualVoice).toMatchObject({ host: 'owner1', spectatorsCanTalk: true, lastIo: null });
            expect(Array.from(game.casualVoice.lobbyExtras)).toEqual(['watcher5']);
            expect(game.voiceSpectators).toEqual(new Map());
            expect(game.lobbyOrigin.settings).toEqual({ spectatorsCanTalk: true });
            const o = game.lobbyOrigin;
            expect(o).toMatchObject({ lobbyId: 'lobby-1', name: "owner1's Game", createdBy: 'owner1', host: 'owner1', messages: [] });
            expect(o.bots).toEqual(new Map([[BOTS[2].socketId, 'sharon'], [BOTS[4].socketId, 'mike']]));
            expect(o.playAgainUsers).toEqual(new Set(['owner1', 'watcher5']));
            expect(o.casualUsers).toEqual(new Set(['owner1', 'owner3', 'watcher5']));
            expect(o.extras).toEqual(new Set(['watcher5']));
            const again = codec.serialize(game, { tournamentId: null, getBot: () => null });
            expect(again).toEqual(codec.expectedAfterRestore(doc));
            expect(again.state.casualVoice.spectatorsCanTalk).toBe(true);
            expect(again.state.lobbyOrigin.settings).toEqual({ spectatorsCanTalk: true });
        } finally {
            game._cancelAllTimers();
        }
    });

    test('the lobby chat is never saved', () => {
        const { game } = codec.hydrate(lobbyDoc(), { now: NOW });
        try {
            game.lobbyOrigin.messages = [{ username: 'owner1', message: 'see you at the table', timestamp: NOW }];
            const doc = codec.serialize(game, { tournamentId: null, getBot: () => null });
            expect(JSON.stringify(doc)).not.toContain('see you at the table');
        } finally {
            game._cancelAllTimers();
        }
    });

    test('play again reads a restored game as it reads a live one', () => {
        const io = makeIo([]);
        const game = adoptForTest(lobbyDoc(), { io, now: NOW });
        const plan = require('../../../socket/playAgain').plan(game, io);
        expect(plan).toMatchObject({ gameId: GAME_ID, spectatorsCanTalk: true });
        expect(plan.origin).toBe(game.lobbyOrigin);
        expect(plan.owners.map((o) => o.username)).toEqual(['owner1', 'owner3']);
    });
});
