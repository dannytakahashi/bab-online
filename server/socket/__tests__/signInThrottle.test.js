/**
 * Failed-sign-in throttle, unit level (the sign-in flow is covered in
 * authSessions.test.js).
 */

const throttle = require('../signInThrottle');

beforeEach(() => {
    throttle._reset();
    jest.useFakeTimers({ now: new Date('2026-11-08T12:00:00Z') });
});
afterEach(() => jest.useRealTimers());

const fail = (who, n) => { for (let i = 0; i < n; i++) throttle.recordFailure(who); };

test('the pair locks at 10 failures; another IP for the same user is still open', () => {
    const a = { ip: '1.1.1.1', username: 'Alan' };
    fail(a, 9);
    expect(throttle.check(a).ok).toBe(true);
    fail(a, 1);
    expect(throttle.check(a)).toMatchObject({ ok: false });
    expect(throttle.check({ ip: '2.2.2.2', username: 'Alan' }).ok).toBe(true);
});

test('the IP locks at 50 failures across usernames; the window slides', () => {
    for (let i = 0; i < 50; i++) throttle.recordFailure({ ip: '3.3.3.3', username: `u${i % 10}` });
    expect(throttle.check({ ip: '3.3.3.3', username: 'fresh' }).ok).toBe(false);
    const { retryAfterMs } = throttle.check({ ip: '3.3.3.3', username: 'fresh' });
    expect(retryAfterMs).toBe(throttle.WINDOW_MS);
    jest.advanceTimersByTime(throttle.WINDOW_MS + 1);
    expect(throttle.check({ ip: '3.3.3.3', username: 'fresh' }).ok).toBe(true);
});

test('the username locks at 30 failures across IPs', () => {
    for (let i = 0; i < 30; i++) throttle.recordFailure({ ip: `9.9.9.${i}`, username: 'Bea' });
    expect(throttle.check({ ip: '4.4.4.4', username: 'Bea' }).ok).toBe(false);
    expect(throttle.check({ ip: '4.4.4.4', username: 'bea' }).ok).toBe(true); // usernames are case-sensitive accounts
});

test('a null IP skips the IP key but keeps the pair and username keys', () => {
    for (let i = 0; i < 60; i++) throttle.recordFailure({ ip: null, username: `x${i}` });
    expect(throttle.check({ ip: null, username: 'Cy' }).ok).toBe(true);
    fail({ ip: null, username: 'Cy' }, 10);
    expect(throttle.check({ ip: null, username: 'Cy' }).ok).toBe(false);
});

test('success clears the pair; release undoes one reservation', () => {
    const a = { ip: '5.5.5.5', username: 'Dee' };
    fail(a, 9);
    throttle.recordSuccess(a);
    fail(a, 9);
    expect(throttle.check(a).ok).toBe(true);
    const t = throttle.recordFailure(a);
    expect(throttle.check(a).ok).toBe(false);
    throttle.release(a, t);
    expect(throttle.check(a).ok).toBe(true);
});

test('keys stay bounded under a flood', () => {
    for (let i = 0; i < 6000; i++) throttle.recordFailure({ ip: `10.${i >> 8}.${i & 255}.1`, username: `n${i}` });
    // Nothing expired yet, so the oldest keys are evicted beyond 5000
    expect(throttle.check({ ip: '10.0.0.1', username: 'n0' }).ok).toBe(true);
});
