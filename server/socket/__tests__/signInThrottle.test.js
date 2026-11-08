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

test('a null IP skips the IP and pair keys: only the username key (30) applies', () => {
    for (let i = 0; i < 60; i++) throttle.recordFailure({ ip: null, username: `x${i}` });
    expect(throttle.check({ ip: null, username: 'Cy' }).ok).toBe(true);
    // Not a shared 'unknown|Cy' key with a limit of 10
    fail({ ip: null, username: 'Cy' }, 29);
    expect(throttle.check({ ip: null, username: 'Cy' }).ok).toBe(true);
    fail({ ip: null, username: 'Cy' }, 1);
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

test('keys stay bounded under a flood, and the flood never evicts a lockout', () => {
    // Regression: insertion-order eviction dropped the oldest key, which was
    // the account under attack, so 5000 junk failures reopened it
    for (let i = 0; i < 30; i++) throttle.recordFailure({ ip: `9.9.${i}.1`, username: 'Alan' });
    // Near the limit (29 of 30) is kept too
    for (let i = 0; i < 29; i++) throttle.recordFailure({ ip: `9.8.${i}.1`, username: 'Bea' });
    for (let i = 0; i < 6000; i++) throttle.recordFailure({ ip: `10.${i >> 8}.${i & 255}.1`, username: `n${i}` });
    expect(throttle.check({ ip: '4.4.4.4', username: 'Alan' }).ok).toBe(false);
    throttle.recordFailure({ ip: '4.4.4.5', username: 'Bea' });
    expect(throttle.check({ ip: '4.4.4.4', username: 'Bea' }).ok).toBe(false);
    // Junk keys with one failure each were evicted to make room
    expect(throttle.check({ ip: '10.0.0.1', username: 'n0' }).ok).toBe(true);
});

test('a map full of lockouts refuses new keys instead of evicting one', () => {
    const { MAX_KEYS, LIMITS } = throttle;
    // Fill the username map with keys at their limit (each from fresh IPs)
    let n = 0;
    for (let u = 0; u < MAX_KEYS; u++) {
        for (let k = 0; k < LIMITS.user; k++) throttle.recordFailure({ ip: `ip${n++ % 40000}`, username: `full${u}` });
    }
    expect(throttle.check({ ip: '4.4.4.4', username: 'full0' }).ok).toBe(false);
    // A brand-new username cannot get a key: fail closed (and not stored)
    const gate = throttle.check({ ip: '4.4.4.4', username: 'newcomer' });
    expect(gate.ok).toBe(false);
    expect(gate.retryAfterMs).toBeGreaterThan(0);
    // Once the window passes everything expires and sign-in reopens
    jest.advanceTimersByTime(throttle.WINDOW_MS + 1);
    expect(throttle.check({ ip: '4.4.4.4', username: 'newcomer' }).ok).toBe(true);
    expect(throttle.check({ ip: '4.4.4.4', username: 'full0' }).ok).toBe(true);
});

test('a known-good pair still signs in when the pair map is full of lockouts', () => {
    const { MAX_KEYS, LIMITS } = throttle;
    const home = { ip: '5.5.5.5', username: 'Mom' };
    throttle.recordSuccess(home); // signed in before; its pair key is cleared
    // 1000 IPs x 5 junk usernames x 10 failures: every pair key at its limit
    for (let i = 0; i < MAX_KEYS / 5; i++) {
        for (let u = 0; u < 5; u++) fail({ ip: `198.18.${i >> 8}.${i & 255}`, username: `junk${u}` }, LIMITS.pair);
    }
    expect(throttle.check({ ip: '6.6.6.6', username: 'Dad' }).ok).toBe(false); // fail closed
    expect(throttle.check(home).ok).toBe(true); // known-good goes through
    // ...uncounted (no key stored), so its typos cannot add a lockout either
    throttle.recordFailure(home);
    expect(throttle.check(home).ok).toBe(true);
});

test('a known-good pair skips the username key; the pair and IP keys still apply', () => {
    const home = { ip: '203.0.113.10', username: 'Mom' };
    throttle.recordSuccess(home);
    // An outsider locks the username from other IPs
    for (let i = 0; i < 30; i++) throttle.recordFailure({ ip: `192.0.2.${i}`, username: 'Mom' });
    expect(throttle.check({ ip: '198.51.100.1', username: 'Mom' }).ok).toBe(false);
    // The household network still signs in
    expect(throttle.check(home).ok).toBe(true);
    // ...but its own typos still lock its pair
    fail(home, 10);
    expect(throttle.check(home).ok).toBe(false);
});

test('rememberGood (a restored session) marks the pair; it expires after 30 days; null IP never counts', () => {
    throttle.rememberGood({ ip: '203.0.113.11', username: 'Dad' });
    throttle.rememberGood({ ip: null, username: 'Dad' });
    for (let i = 0; i < 30; i++) throttle.recordFailure({ ip: `192.0.2.${i}`, username: 'Dad' });
    expect(throttle.check({ ip: '203.0.113.11', username: 'Dad' }).ok).toBe(true);
    expect(throttle.check({ ip: null, username: 'Dad' }).ok).toBe(false);
    jest.advanceTimersByTime(throttle.KNOWN_GOOD_MS + 1);
    for (let i = 0; i < 30; i++) throttle.recordFailure({ ip: `192.0.3.${i}`, username: 'Dad' });
    expect(throttle.check({ ip: '203.0.113.11', username: 'Dad' }).ok).toBe(false);
});
