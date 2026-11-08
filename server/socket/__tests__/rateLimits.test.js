/**
 * Game-action rate limits stay far above real play at the retuned pacing:
 * an over-limit play is answered with `error` and no actionRejected, which
 * loses the card on the shipped iOS app.
 */

const rateLimiter = require('../rateLimiter');

afterAll(() => rateLimiter.shutdown());

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('30 plays and 20 bids within 60 s are allowed', () => {
    const sid = 'rl-sock';
    for (let i = 0; i < 30; i++) {
        expect(rateLimiter.check(sid, 'playCard')).toBe(true);
        jest.advanceTimersByTime(1900); // faster than any real trick
    }
    for (let i = 0; i < 20; i++) expect(rateLimiter.check(sid, 'playerBid')).toBe(true);
});

test('the limits are 90 plays and 30 bids per minute', () => {
    expect(rateLimiter.limits.playCard).toEqual({ max: 90, windowMs: 60000 });
    expect(rateLimiter.limits.playerBid).toEqual({ max: 30, windowMs: 60000 });
});
