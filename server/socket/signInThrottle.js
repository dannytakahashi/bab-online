/**
 * Failed password sign-in throttle. Counts FAILURES only (unknown user,
 * wrong password), over a sliding 15 min window, on three keys:
 *
 * - (ip, username) pair: 10. One person's typos lock only that person on
 *   that network; a success clears the pair.
 * - ip: 50 (skipped when the IP is unknown). A household behind one NAT has
 *   a lot of room before this applies.
 * - username, across all IPs: 30. Rotating (or spoofed) IPs still stop here.
 *
 * Never counted or limited: restoreSession, rejoinGame, signUp, correct
 * sign-ins, database errors and a busy hash pool. Session tokens are
 * SHA-256 over a uuid v4, so guessing one is infeasible.
 * Accepted cost: someone who knows a username can block its PASSWORD
 * sign-in for 15 min; saved sessions keep working and a restart clears it.
 *
 * Concurrency: signIn reserve()s a failure on the pair and username keys
 * synchronously with check(), before its DB read and hash, so parallel
 * guesses at one account cannot overshoot those limits; the reservation is
 * confirm()ed (and the IP key counted) for a real failure, or released.
 * The IP key counts confirmed failures only, so family members signing in
 * at the same moment from one NAT never block each other.
 *
 * In memory, no timers: entries are pruned lazily on access and in full
 * when a map grows past 5000 keys (then the oldest keys are evicted).
 */

const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { pair: 10, ip: 50, user: 30 };
const MAX_KEYS = 5000;

const maps = { pair: new Map(), ip: new Map(), user: new Map() };

function normUser(username) {
    return String(username ?? '').trim();
}

/** [kind, key] for the pair and username keys (always present). */
function accountKeys({ ip, username }) {
    const user = normUser(username);
    return [['pair', `${ip || 'unknown'}|${user}`], ['user', user]];
}

function allKeys(who) {
    const keys = accountKeys(who);
    if (who.ip) keys.push(['ip', who.ip]);
    return keys;
}

/** Live timestamps for a key (expired ones dropped). */
function live(kind, key, now) {
    const map = maps[kind];
    const list = map.get(key);
    if (!list) return null;
    while (list.length && list[0] <= now - WINDOW_MS) list.shift();
    if (!list.length) {
        map.delete(key);
        return null;
    }
    return list;
}

function pruneAll(kind, now) {
    const map = maps[kind];
    for (const key of Array.from(map.keys())) live(kind, key, now);
    // Still too many (a flood): evict the oldest keys
    for (const key of map.keys()) {
        if (map.size <= MAX_KEYS) break;
        map.delete(key);
    }
}

function push(kind, key, now) {
    const list = live(kind, key, now) || [];
    list.push(now);
    maps[kind].set(key, list);
    if (maps[kind].size > MAX_KEYS) pruneAll(kind, now);
}

function remove(kind, key, at) {
    const list = maps[kind].get(key);
    if (!list) return;
    const i = list.indexOf(at);
    if (i !== -1) list.splice(i, 1);
    if (!list.length) maps[kind].delete(key);
}

/**
 * @returns {{ok: boolean, retryAfterMs: number}}
 */
function check(who) {
    const now = Date.now();
    let retryAfterMs = 0;
    for (const [kind, key] of allKeys(who)) {
        const list = live(kind, key, now);
        if (list && list.length >= LIMITS[kind]) {
            retryAfterMs = Math.max(retryAfterMs, list[0] + WINDOW_MS - now);
        }
    }
    return { ok: retryAfterMs === 0, retryAfterMs };
}

/** Provisionally count an attempt on the pair and username keys. */
function reserve(who) {
    const now = Date.now();
    for (const [kind, key] of accountKeys(who)) push(kind, key, now);
    return { at: now };
}

/** The reserved attempt was a real failure: keep it and count the IP. */
function confirm(who) {
    if (who.ip) push('ip', who.ip, Date.now());
}

/** The reserved attempt does not count (merged account, DB error, busy). */
function release(who, token) {
    if (!token) return;
    for (const [kind, key] of accountKeys(who)) remove(kind, key, token.at);
}

/** One failure on every key (reserve + confirm). */
function recordFailure(who) {
    const token = reserve(who);
    confirm(who);
    return token;
}

/** A correct password: drop its reservation (if any) and clear the pair. */
function recordSuccess(who, token) {
    release(who, token);
    maps.pair.delete(accountKeys(who)[0][1]);
}

function _reset() {
    for (const map of Object.values(maps)) map.clear();
}

module.exports = { check, reserve, confirm, release, recordFailure, recordSuccess, _reset, LIMITS, WINDOW_MS };
