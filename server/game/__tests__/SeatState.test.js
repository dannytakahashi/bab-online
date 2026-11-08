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
