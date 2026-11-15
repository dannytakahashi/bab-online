/**
 * A play search that throws: the bot plays its rule card, SEARCH.errors
 * counts it, and the server log gets one rate-limited warning that names the
 * error and the hand size, never a card.
 */

describe('search errors', () => {
    let Strategy, SEARCH, warn;

    beforeEach(() => {
        jest.resetModules();
        warn = jest.fn();
        jest.isolateModules(() => {
            jest.doMock('../../../utils/logger', () => ({ gameLogger: { warn } }));
            jest.doMock('../playSearch', () => {
                const real = jest.requireActual('../playSearch');
                return { ...real, searchCard: () => { throw new TypeError('forced search failure'); } };
            });
            Strategy = require('../BotStrategy');
            SEARCH = require('../playSearch').SEARCH;
        });
    });

    afterEach(() => {
        jest.dontMock('../../../utils/logger');
        jest.dontMock('../playSearch');
        jest.restoreAllMocks();
    });

    const trump = { suit: 'spades', rank: '2' };
    const hand = [{ suit: 'hearts', rank: 'K' }, { suit: 'hearts', rank: '4' }, { suit: 'diamonds', rank: '9' }];
    const none = [undefined, undefined, undefined, undefined];
    const memory = { playedCards: [], trumpPlayed: [], acesPlayed: {}, trickIndex: 0, totalCardsPlayed: 0 };
    const ctx = { playerBids: ['1', '1', '0', '0'], bids: { team1: 1, team2: 1 }, tricks: { team1: 0, team2: 0 }, team1Mult: 1, team2Mult: 1 };
    const play = () => Strategy.selectOptimalCard(hand.slice(), none.slice(), null, null, trump, false, 1, memory, 3, ctx, 'mary');

    test('plays the rule card, counts every error and logs the first one only', () => {
        // The rule card: the same call with the search out of scope
        const maxCards = SEARCH.maxCards;
        SEARCH.maxCards = 1;
        const ruleCard = play();
        SEARCH.maxCards = maxCards;
        expect(warn).not.toHaveBeenCalled();
        expect(SEARCH.errors || 0).toBe(0);

        let now = 1_000_000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);
        expect(play()).toBe(ruleCard);
        expect(SEARCH.errors).toBe(1);
        expect(warn).toHaveBeenCalledTimes(1);
        const [msg, meta] = warn.mock.calls[0];
        expect(msg).toMatch(/search failed/);
        expect(meta).toMatchObject({ error: 'forced search failure', cardsInHand: 3, handSize: 3, errors: 1, heldBack: 0 });
        expect(Object.keys(meta).sort()).toEqual(['cardsInHand', 'error', 'errors', 'handSize', 'heldBack', 'where']);
        // No card in the warning
        const text = JSON.stringify(meta);
        for (const c of hand) expect(text).not.toMatch(new RegExp(`"(suit|rank)"|${c.suit}`));

        // Inside the interval: counted, played, not logged
        now += Strategy.SEARCH_ERROR_LOG.intervalMs - 1;
        expect(play()).toBe(ruleCard);
        expect(play()).toBe(ruleCard);
        expect(SEARCH.errors).toBe(3);
        expect(warn).toHaveBeenCalledTimes(1);

        // After it: the next one is logged with the count held back
        now += 1;
        expect(play()).toBe(ruleCard);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[1][1]).toMatchObject({ errors: 4, heldBack: 2 });
    });

    test('a logger that throws never breaks the play', () => {
        warn.mockImplementation(() => { throw new Error('log down'); });
        const card = play();
        expect(hand).toContain(card);
        expect(SEARCH.errors).toBe(1);
    });
});
