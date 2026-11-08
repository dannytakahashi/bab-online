/**
 * Failed password sign-in throttle. Counts FAILURES only (unknown user,
 * wrong password), over a sliding 15 min window, on three keys:
 *
 * - (ip, username) pair: 10. One person's typos lock only that person on
 *   that network; a success clears the pair. Skipped when the IP is
 *   unknown (null), so a missing IP never becomes one shared
 *   'unknown|<username>' key for everyone.
 * - ip: 50 (skipped when the IP is unknown). A household behind one NAT has
 *   a lot of room before this applies.
 * - username, across all IPs: 30. Rotating (or spoofed) IPs still stop here.
 *   Skipped for a KNOWN-GOOD pair: an (ip, username) that signed in (or
 *   restored a session) in the last 30 days. Someone guessing from other
 *   IPs can then lock the username for new devices and networks, but never
 *   for the household that already uses it (the pair and IP keys still
 *   apply there).
 *
 * Never counted or limited: restoreSession, rejoinGame, signUp, correct
 * sign-ins, database errors and a busy hash pool. Session tokens are
 * SHA-256 over a uuid v4, so guessing one is infeasible.
 * Accepted cost: someone who knows a username can block its PASSWORD
 * sign-in from new IPs for 15 min; saved sessions and known-good pairs keep
 * working and a restart clears it.
 *
 * Concurrency: signIn reserve()s a failure on the pair and username keys
 * synchronously with check(), before its DB read and hash, so parallel
 * guesses at one account cannot overshoot those limits; the reservation is
 * confirm()ed (and the IP key counted) for a real failure, or released.
 * The IP key counts confirmed failures only, so family members signing in
 * at the same moment from one NAT never block each other.
 *
 * In memory, no timers: entries are pruned lazily on access and in full
 * when a map reaches 5000 keys. A flood never evicts a lockout: only keys
 * below their limit are evicted (fewest failures first), and when every
 * key is at its limit a NEW key is refused (check() fails closed for that
 * attempt) instead of making room.
 */

const WINDOW_MS = 15 * 60 * 1000;
const KNOWN_GOOD_MS = 30 * 24 * 60 * 60 * 1000;
const LIMITS = { pair: 10, ip: 50, user: 30 };
const MAX_KEYS = 5000;
/** Evict down to this many keys, so a flood does not rescan every insert. */
const EVICT_TO = Math.floor(MAX_KEYS * 0.9);
/** Retry hint when a map is full of lockouts (fail closed). */
const SATURATED_RETRY_MS = 60 * 1000;

const maps = { pair: new Map(), ip: new Map(), user: new Map() };
/** `${ip}|${username}` -> last success time; insertion order = oldest first. */
const knownGood = new Map();

function normUser(username) {
    return String(username ?? '').trim();
}

function pairKey(ip, user) {
    return `${ip}|${user}`;
}

/** [kind, key] for the reserved keys: the pair (only with an IP) and username. */
function accountKeys({ ip, username }) {
    const user = normUser(username);
    const keys = [['user', user]];
    if (ip) keys.unshift(['pair', pairKey(ip, user)]);
    return keys;
}

function isKnownGood({ ip, username }, now) {
    if (!ip) return false;
    const key = pairKey(ip, normUser(username));
    const at = knownGood.get(key);
    if (at === undefined) return false;
    if (at <= now - KNOWN_GOOD_MS) {
        knownGood.delete(key);
        return false;
    }
    return true;
}

/** The keys check() enforces for this attempt. */
function checkedKeys(who, now) {
    let keys = accountKeys(who);
    if (isKnownGood(who, now)) keys = keys.filter(([kind]) => kind !== 'user');
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

/**
 * Make room for a new key: drop expired entries, then evict keys below
 * their limit, fewest failures first. Never evicts a key at its limit.
 * @returns {boolean} whether a new key fits
 */
function makeRoom(kind, now) {
    const map = maps[kind];
    if (map.size < MAX_KEYS) return true;
    for (const key of Array.from(map.keys())) live(kind, key, now);
    if (map.size < MAX_KEYS) return true;
    const evictable = [];
    for (const [key, list] of map) {
        if (list.length < LIMITS[kind]) evictable.push([key, list.length]);
    }
    evictable.sort((a, b) => a[1] - b[1]);
    for (const [key] of evictable) {
        if (map.size <= EVICT_TO) break;
        map.delete(key);
    }
    return map.size < MAX_KEYS;
}

function push(kind, key, now) {
    const map = maps[kind];
    const list = live(kind, key, now);
    if (list) {
        list.push(now);
        return;
    }
    if (!makeRoom(kind, now)) return; // full of lockouts; check() refuses new keys
    map.set(key, [now]);
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
    for (const [kind, key] of checkedKeys(who, now)) {
        const list = live(kind, key, now);
        if (list) {
            if (list.length >= LIMITS[kind]) {
                retryAfterMs = Math.max(retryAfterMs, list[0] + WINDOW_MS - now);
            }
        } else if (!makeRoom(kind, now)) {
            // A new key with no room left (every key is a lockout): fail closed
            retryAfterMs = Math.max(retryAfterMs, SATURATED_RETRY_MS);
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

/**
 * This (ip, username) proved it is the account's owner (correct password
 * or a valid saved session): remember the pair for 30 days.
 */
function rememberGood(who) {
    if (!who.ip) return;
    const key = pairKey(who.ip, normUser(who.username));
    knownGood.delete(key); // re-insert so insertion order stays oldest-first
    knownGood.set(key, Date.now());
    while (knownGood.size > MAX_KEYS) knownGood.delete(knownGood.keys().next().value);
}

/** A correct password: drop its reservation (if any), clear the pair, remember it. */
function recordSuccess(who, token) {
    release(who, token);
    if (who.ip) maps.pair.delete(pairKey(who.ip, normUser(who.username)));
    rememberGood(who);
}

function _reset() {
    for (const map of Object.values(maps)) map.clear();
    knownGood.clear();
}

module.exports = {
    check, reserve, confirm, release, recordFailure, recordSuccess, rememberGood, _reset,
    LIMITS, WINDOW_MS, KNOWN_GOOD_MS, MAX_KEYS
};
