/**
 * Seat state machine: the edge table, and (on GameState) every transition,
 * its re-keying, timers, wire projection and invariants.
 */

const SeatState = require('../SeatState');

const { checkEdge, LEGAL, EDGES } = SeatState;

const ALL_STATES = Object.entries(LEGAL).flatMap(([controller, list]) => list.map((presence) => ({ controller, presence })));

// The full edge table, written out independently of EDGES
const EXPECTED = {
    disconnect: { 'human/connected': 'human/grace', 'lazyBot/connected': 'lazyBot/away', 'resignBot/connected': 'resignBot/away' },
    graceExpired: { 'human/grace': 'human/resignable' },
    reconnect: { 'human/grace': 'human/connected', 'human/resignable': 'human/connected', 'human/connected': 'human/connected' },
    watch: {
        'lazyBot/connected': 'lazyBot/connected', 'lazyBot/away': 'lazyBot/connected',
        'resignBot/connected': 'resignBot/connected', 'resignBot/away': 'resignBot/connected',
    },
    goLazy: { 'human/connected': 'lazyBot/connected' },
    goActive: { 'lazyBot/connected': 'human/connected', 'resignBot/connected': 'human/connected' },
    resign: { 'human/resignable': 'resignBot/away' },
    leave: {
        'lazyBot/connected': 'lazyBot/gone', 'lazyBot/away': 'lazyBot/gone',
        'resignBot/connected': 'resignBot/gone', 'resignBot/away': 'resignBot/gone',
    },
};

describe('SeatState edge table', () => {
    test('every event is in the expected table', () => {
        expect(Object.keys(EDGES).sort()).toEqual(Object.keys(EXPECTED).sort());
    });

    for (const event of Object.keys(EXPECTED)) {
        test.each(ALL_STATES.map((s) => [`${s.controller}/${s.presence}`, s]))(`${event} from %s`, (key, s) => {
            const r = checkEdge(s, event);
            const want = EXPECTED[event][key];
            if (want) {
                expect(r.ok).toBe(true);
                expect(`${r.to.controller}/${r.to.presence}`).toBe(want);
                // never into an illegal pair
                expect(LEGAL[r.to.controller]).toContain(r.to.presence);
            } else {
                expect(r.ok).toBe(false);
            }
        });
    }

    test("'gone' and 'none' are absorbing", () => {
        for (const event of Object.keys(EDGES)) {
            for (const c of ['lazyBot', 'resignBot']) expect(checkEdge({ controller: c, presence: 'gone' }, event).ok).toBe(false);
            expect(checkEdge({ controller: 'bot', presence: 'none' }, event).ok).toBe(false);
        }
    });

    test('no seat -> illegal', () => {
        expect(checkEdge(null, 'disconnect').ok).toBe(false);
    });

    test('create states', () => {
        expect(SeatState.isLegalCreate('human', 'connected')).toBe(true);
        expect(SeatState.isLegalCreate('human', 'grace')).toBe(true);
        expect(SeatState.isLegalCreate('bot', 'none')).toBe(true);
        expect(SeatState.isLegalCreate('resignBot', 'gone')).toBe(true);
        expect(SeatState.isLegalCreate('human', 'resignable')).toBe(false);
        expect(SeatState.isLegalCreate('lazyBot', 'connected')).toBe(false);
    });
});

// ==================== GameState seat transitions ====================

const GameState = require('../GameState');
const GamePhase = require('../GamePhase');

const C = (rank, suit) => ({ rank, suit });
const bot = (name, personality = 'mike') => ({ socketId: `bot:${name}:x`, username: `🤖 ${name}`, pic: 7, personality });

/** Four connected human seats h1..h4 holding one card each, in BIDDING. */
function fourHumans() {
    const g = new GameState('seat-test');
    for (let p = 1; p <= 4; p++) {
        g.addPlayer(`h${p}`, `u${p}`, p, p, false);
        g.setHand(`h${p}`, [C(String(p + 2), 'hearts')]);
    }
    g.forcePhase(GamePhase.Phase.BIDDING);
    return g;
}

/** Expect `fn` to report a seat-illegal violation and leave the seat as it was. */
function expectIllegal(g, pos, fn) {
    const before = JSON.stringify(g.seat(pos));
    const index = JSON.stringify([...g.players.entries()]);
    expect(fn).toThrow(/seat-illegal/);
    expect(JSON.stringify(g.seat(pos))).toBe(before);
    expect(JSON.stringify([...g.players.entries()])).toBe(index);
    GamePhase.resetViolations();
}

describe('GameState seat transitions', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

    test('addPlayer seats a connected human / a native bot; the 4th seat clears entrants', () => {
        const g = new GameState('a');
        g.initEntrants([{ socketId: 'h1' }, { socketId: 'bot:b:1', isBot: true }]);
        g.addPlayer('h1', 'u1', 1, 3, false);
        g.addPlayer('bot:b:1', '🤖 B', 2, 4, true);
        expect(g.seat(1)).toMatchObject({ controller: 'human', presence: 'connected', ownerUsername: 'u1', ownerSocketId: 'h1', seatSocketId: 'h1' });
        expect(g.seat(2)).toMatchObject({ controller: 'bot', presence: 'none', ownerUsername: null, ownerSocketId: null, seatSocketId: 'bot:b:1' });
        expect(g.entrants).not.toBeNull();
        g.addPlayer('h3', 'u3', 3, 1, false);
        g.addPlayer('h4', 'u4', 4, 1, false);
        expect(g.entrants).toBeNull();
        expect(g.players.get('bot:b:1')).toEqual({ username: '🤖 B', position: 2, pic: 4 });
        expect(SeatState.validateSeats(g)).toEqual([]);
    });

    test('goLazy re-keys the seat to the bot (hand, index, display) and goActive gives it back', () => {
        const g = fourHumans();
        const b = bot('Mike');
        expect(g.seatGoLazy(1, b)).toBe('h1');
        expect(g.positions[1]).toBe(b.socketId);
        expect(g.getHand(b.socketId)).toEqual([C('3', 'hearts')]);
        expect(g.hands.h1).toBeUndefined();
        expect(g.players.has('h1')).toBe(false);
        expect(g.players.get(b.socketId)).toEqual({ username: '🤖 Mike', position: 1, pic: 7 });
        expect(g.seat(1)).toMatchObject({ controller: 'lazyBot', presence: 'connected', ownerSocketId: 'h1', ownerView: 'seat', lastPersonality: 'mike' });
        expect(g.seatBySocket('h1')).toBeNull();
        expect(g.seatByOwnerSocket('h1')).toBe(1);
        expect(SeatState.validateSeats(g)).toEqual([]);

        const released = g.seatGoActive(1, 'h1');
        expect(released.bot.socketId).toBe(b.socketId);
        expect(released.ownerView).toBe('seat');
        expect(g.positions[1]).toBe('h1');
        expect(g.getHand('h1')).toEqual([C('3', 'hearts')]);
        expect(g.players.get('h1')).toEqual({ username: 'u1', position: 1, pic: 1 });
        expect(g.seat(1)).toMatchObject({ controller: 'human', presence: 'connected', bot: null, ownerView: null, lastPersonality: 'mike' });
        expect(SeatState.validateSeats(g)).toEqual([]);
    });

    test('disconnect -> grace (timer) -> resignable -> resign -> watch -> active', () => {
        const g = fourHumans();
        expect(g.seatDisconnect(1, 'stale')).toBeNull(); // not the owner socket: no-op
        expect(g.seat(1).presence).toBe('connected');

        expect(g.seatDisconnect(1, 'h1', { onGraceExpire: () => {} })).toBe('grace');
        expect(g.hasTimer('grace:1')).toBe(true);
        expect(g.seat(1)).toMatchObject({ ownerSocketId: null, seatSocketId: 'h1' });
        expect(g.seat(1).graceDeadline - g.seat(1).absentSince).toBe(SeatState.RECONNECT_GRACE_MS);
        expect(g.seatDisconnect(1, 'h1')).toBeNull(); // second call: no-op
        expect(SeatState.validateSeats(g)).toEqual([]);

        expect(g.seatGraceExpired(1)).toBe(true);
        expect(g.hasTimer('grace:1')).toBe(false);
        expect(g.resignablePositions()).toEqual([1]);

        const b = bot('Zach', 'zach');
        expect(g.seatResign(1, b)).toBe('h1');
        expect(g.seat(1)).toMatchObject({ controller: 'resignBot', presence: 'away', ownerUsername: 'u1' });
        expect(g.getHand(b.socketId)).toEqual([C('3', 'hearts')]);
        expect(g.getClientState('h2')).toMatchObject({ resignedPositions: [1], lazyPositions: [], isLazy: false });
        expect(g.getOriginalPlayer(1)).toEqual({ username: 'u1', pic: 1 });

        expect(g.seatWatch(1, 'w1')).toBeNull();
        expect(g.seat(1)).toMatchObject({ presence: 'connected', ownerSocketId: 'w1', ownerView: 'watch' });
        // A watching resigned owner shows as lazy on the wire
        expect(g.getClientState(b.socketId)).toMatchObject({ position: 1, resignedPositions: [1], lazyPositions: [1], isLazy: true });
        expect(g.seatWatch(1, 'w2')).toBe('w1'); // newest socket owns it; the caller demotes w1

        g.seatGoActive(1, 'w2');
        expect(g.seat(1)).toMatchObject({ controller: 'human', presence: 'connected', seatSocketId: 'w2', resignedAt: null });
        expect(g.getClientState('w2')).toMatchObject({ position: 1, hand: [C('3', 'hearts')], resignedPositions: [], lazyPositions: [], isLazy: false });
        expect(SeatState.validateSeats(g)).toEqual([]);
    });

    test('reconnect clears its own grace timer only; from connected only with another socket', () => {
        const g = fourHumans();
        g.seatDisconnect(1, 'h1');
        g.seatDisconnect(2, 'h2');
        expect(g.seatReconnect(1, 'n1')).toBe('h1');
        expect(g.hasTimer('grace:1')).toBe(false);
        expect(g.hasTimer('grace:2')).toBe(true);
        expect(g.positions[1]).toBe('n1');
        expect(g.getHand('n1')).toEqual([C('3', 'hearts')]);
        expect(g.seatReconnect(1, 'n1b')).toBe('n1'); // a newer socket takes over
        expectIllegal(g, 1, () => g.seatReconnect(1, 'n1b'));
    });

    test('leave: lazy/resigned -> gone, which is absorbing', () => {
        const g = fourHumans();
        g.seatGoLazy(2, bot('Mike'));
        expect(g.seatLeave(2)).toBe(true);
        expect(g.seat(2)).toMatchObject({ controller: 'lazyBot', presence: 'gone', ownerSocketId: null, ownerView: null });
        expect(g.isReturnable(2)).toBe(false);
        expect(g.getClientState('h1').lazyPositions).toEqual([2]);
        for (const fn of [() => g.seatWatch(2, 'x'), () => g.seatLeave(2), () => g.seatGoActive(2, null)]) {
            expectIllegal(g, 2, fn);
        }
    });

    test('illegal edges are reported and change nothing', () => {
        const g = fourHumans();
        expectIllegal(g, 1, () => g.seatGoActive(1, 'h1'));        // not lazy
        expectIllegal(g, 1, () => g.seatResign(1, bot('X')));      // not resignable
        expectIllegal(g, 1, () => g.seatWatch(1, 'x'));            // human seat
        expectIllegal(g, 1, () => g.seatLeave(1));                 // human seat
        g.seatDisconnect(1, 'h1');
        expectIllegal(g, 1, () => g.seatResign(1, bot('X')));      // still in grace
        expectIllegal(g, 1, () => g.seatGoLazy(1, bot('X')));
        g.seatGoLazy(2, bot('Mike'));
        expectIllegal(g, 2, () => g.seatGoActive(2, 'someone-else')); // only the owner socket
        expectIllegal(g, 2, () => g.seatReconnect(2, 'x'));       // reconnect into a bot seat
        expectIllegal(g, 3, () => g.createSeat(3, { controller: 'human', ownerSocketId: 'y' })); // occupied
    });

    test('wire projection for each seat state keeps the legacy values', () => {
        const g = fourHumans();
        g.seatGoLazy(1, bot('Mike'));                     // lazyBot/connected
        g.seatGoLazy(2, bot('Zach', 'zach'));
        g.seatDisconnect(2, 'h2');                        // lazyBot/away
        g.seatDisconnect(3, 'h3');
        g.seatGraceExpired(3);
        g.seatResign(3, bot('Dan', 'danny'));             // resignBot/away
        const st = g.getClientState('h4');
        expect(st.position).toBe(4);
        expect(st.resignedPositions).toEqual([3]);
        expect(st.lazyPositions).toEqual([1, 2]);
        expect(st.isLazy).toBe(false);
        expect(st.players.map((p) => p.username)).toEqual(['🤖 Mike', '🤖 Zach', '🤖 Dan', 'u4']);
        expect(st.players[0].socketId).toBe('bot:Mike:x');
        expect(SeatState.validateSeats(g)).toEqual([]);
    });

    test('validateSeats catches broken invariants', () => {
        const cases = [
            (g) => { g.seats[1].presence = 'away'; },                          // illegal pair
            (g) => { g.seats[1].ownerUsername = null; },                       // human without owner
            (g) => { g.positions[2] = 'nobody'; },                             // index drift
            (g) => { g.players.set('ghost', { username: 'g', position: 3, pic: 1 }); },
            (g) => { g.seats[1].ownerSocketId = null; },                       // connected without socket
            (g) => { g.seats[2].ownerSocketId = 'h1'; },                       // one socket, two seats
            (g) => { g.spectators.set('h1', { username: 'u1' }); },            // owner is a spectator
            (g) => { g.seats[1].presence = 'grace'; g.seats[1].ownerSocketId = null; }, // grace without timer
            (g) => { g.setTimer('abandon', 1000, () => {}); },                 // abandon with a human here
            (g) => { g.setTimer('draw:watchdog', 1000, () => {}); },           // watchdog outside DRAWING
            (g) => { g.setTimer('reconnectGrace', 1000, () => {}); },          // legacy key
            (g) => { g.entrants = new Map(); },                                // entrants after seating
        ];
        for (const breakIt of cases) {
            const g = fourHumans();
            expect(SeatState.validateSeats(g)).toEqual([]);
            breakIt(g);
            expect(SeatState.validateSeats(g).length).toBeGreaterThan(0);
            g._cancelAllTimers();
        }
        // Two lazy/resign bots with one name
        const g = fourHumans();
        g.seatGoLazy(1, bot('Mike'));
        g.seatGoLazy(2, { ...bot('Mike'), socketId: 'bot:mike:2' });
        expect(SeatState.validateSeats(g).some((e) => /share bot name/.test(e))).toBe(true);
    });

    test('under BAB_FSM_CHECK=1 a transition that leaves an invariant broken is reported', () => {
        process.env.BAB_FSM_CHECK = '1';
        try {
            const g = fourHumans();
            g.spectators.set('h1', { username: 'u1' });
            expect(() => g.seatGoLazy(2, bot('Mike'))).toThrow(/seat-invariant/);
        } finally {
            delete process.env.BAB_FSM_CHECK;
            GamePhase.resetViolations();
        }
    });

    test('forceSeat is test-only', () => {
        const g = fourHumans();
        const env = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            expect(() => g.forceSeat(1, { controller: 'lazyBot', bot: bot('Mike') })).toThrow(/test-only/);
        } finally {
            process.env.NODE_ENV = env;
        }
    });
});
