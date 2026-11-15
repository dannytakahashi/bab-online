/**
 * The client's IP for the failed-sign-in throttle (signInThrottle.js) and
 * the per-IP sign-up limit (authHandlers.takeSignUpSlot).
 *
 * Railway: the TCP peer Socket.IO sees (handshake.address) is Railway's
 * edge, an address in 100.0.0.0/8 (staff: CGNAT 100.64/10 today, not a
 * stable contract), never the player. The docs name X-Real-IP as the
 * client's remote IP; staff answers disagree about whether a client's own
 * X-Forwarded-For is stripped or appended to, and no proxy CIDRs are
 * published. So:
 *
 * - peer is public (a direct connection, no proxy in front): the peer, and
 *   the headers are ignored (anyone can send them);
 * - peer is a proxy/private address (127/8, ::1, 10/8, 172.16/12,
 *   192.168/16, 100/8, fc00::/7): X-Real-IP, when it is a valid non-proxy
 *   IP and agrees with X-Forwarded-For (XFF absent, or one of its entries
 *   is the X-Real-IP). The leftmost XFF entry is never used on its own: if
 *   the edge appends, it is whatever the client sent.
 * - otherwise null: the per-IP and pair keys are skipped and only the
 *   username key applies (never one shared key for every user). Logged once
 *   per process with the raw values.
 *
 * Header trust rests on the peer address alone. Off Railway (docker-compose,
 * a LAN host) a client whose peer is private can set X-Real-IP freely and
 * rotate its IP key; the username key still caps guessing per account.
 *
 * After a deploy, the successful-sign-in log line ('Sign-in client
 * address') shows peer, X-Real-IP, XFF and the chosen IP, so a collapse
 * (every family member and network getting the same IP, e.g. a CDN edge
 * address in X-Real-IP) is visible before it matters.
 *
 * The handshake headers come from the first HTTP request, so this is
 * computed once at connection (socket.data.clientIp in socket/index.js).
 */

const net = require('net');
const { authLogger } = require('./logger');

const PROXY_V4 = [
    ['127.0.0.0', 8],
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['100.0.0.0', 8]
];

function v4ToInt(ip) {
    return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

const PROXY_V4_RANGES = PROXY_V4.map(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return { net: (v4ToInt(base) & mask) >>> 0, mask };
});

/** Strip an IPv4-mapped IPv6 prefix and surrounding space; null if not an IP. */
function normalize(value) {
    if (Array.isArray(value)) value = value[0];
    if (typeof value !== 'string') return null;
    let ip = value.trim();
    if (/^::ffff:/i.test(ip) && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
    return net.isIP(ip) ? ip : null;
}

function isProxyPeer(ip) {
    if (net.isIPv4(ip)) {
        const n = v4ToInt(ip);
        return PROXY_V4_RANGES.some(r => ((n & r.mask) >>> 0) === r.net);
    }
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00; // fc00::/7 unique local
}

function headerString(value) {
    if (Array.isArray(value)) return value.join(',');
    return typeof value === 'string' ? value : null;
}

/** Raw address inputs, for logging. */
function describeClientAddress(socket) {
    const handshake = (socket && socket.handshake) || {};
    const headers = handshake.headers || {};
    return {
        peer: handshake.address ?? null,
        xRealIp: headerString(headers['x-real-ip']),
        xForwardedFor: headerString(headers['x-forwarded-for'])
    };
}

const warned = new Set();
function warnOnce(kind, message, details) {
    if (warned.has(kind)) return;
    warned.add(kind);
    authLogger.warn(message, details);
}

/** The eight 16-bit groups of an IPv6 address, as numbers. */
function v6Groups(ip) {
    let s = ip.toLowerCase().split('%')[0];
    if (s.includes('.')) { // an embedded IPv4 tail (e.g. 64:ff9b::192.0.2.1)
        const cut = s.lastIndexOf(':') + 1;
        const n = s.slice(cut).split('.').reduce((acc, o) => ((acc << 8) + Number(o)) >>> 0, 0);
        s = `${s.slice(0, cut)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    }
    const [h, t] = s.split('::');
    const head = h ? h.split(':') : [];
    const tail = t ? t.split(':') : [];
    const groups = t === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
    return groups.map(g => parseInt(g, 16));
}

/**
 * The key a per-client limit counts an address under: an IPv4 address as
 * is, an IPv6 address by its /64 (a home or VPS gets a whole /64, so
 * per-address keys would let one client rotate through billions of
 * buckets). Used by the reset route and the sign-up limit.
 */
function ipBucketKey(ip) {
    if (!net.isIPv6(ip)) return ip;
    return `${v6Groups(ip).slice(0, 4).map(g => g.toString(16)).join(':')}::/64`;
}

/**
 * The /48 an IPv6 address is in (null for IPv4): one customer or VPS
 * allocation is often a /48 or /56, i.e. 256 to 65,536 /64s, so the
 * sign-up limit also counts the /48 (rateLimiter.buckets.signUpNet48).
 */
function ipNet48Key(ip) {
    if (!net.isIPv6(ip)) return null;
    return `${v6Groups(ip).slice(0, 3).map(g => g.toString(16)).join(':')}::/48`;
}

/**
 * @param {Object} socket - a Socket.IO socket
 * @returns {string|null}
 */
function getClientIp(socket) {
    const handshake = socket && socket.handshake;
    const peer = normalize(handshake && handshake.address);
    if (!peer) return null;
    if (!isProxyPeer(peer)) return peer;

    const raw = describeClientAddress(socket);
    const real = normalize(raw.xRealIp);
    if (!real || isProxyPeer(real)) {
        warnOnce('none', 'No usable X-Real-IP behind a proxy peer; per-IP sign-in limit off for such connections', raw);
        return null;
    }
    if (raw.xForwardedFor) {
        const entries = raw.xForwardedFor.split(',').map(normalize).filter(Boolean);
        if (!entries.includes(real)) {
            warnOnce('mismatch', 'X-Real-IP is not in X-Forwarded-For; per-IP sign-in limit off for such connections', raw);
            return null;
        }
    }
    return real;
}

module.exports = {
    getClientIp,
    ipBucketKey,
    ipNet48Key,
    isProxyPeer,
    describeClientAddress,
    _normalize: normalize,
    _resetWarnings: () => warned.clear()
};
