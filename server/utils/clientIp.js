/**
 * The client's IP for the failed-sign-in throttle (signInThrottle.js).
 *
 * Railway: the TCP peer Socket.IO sees (handshake.address) is Railway's
 * edge, an address in 100.64.0.0/10 (CGNAT), never the player. The docs
 * name X-Real-IP as the client's remote IP; staff answers disagree about how
 * X-Forwarded-For is built and no proxy CIDRs are published. So:
 *
 * - peer is public (a direct connection, no proxy in front): the peer, and
 *   the headers are ignored (anyone can send them);
 * - peer is a proxy/private address (127/8, ::1, 10/8, 172.16/12,
 *   192.168/16, 100.64/10, fc00::/7): X-Real-IP, else the leftmost
 *   X-Forwarded-For entry, whichever is a valid IP first;
 * - otherwise null: the per-IP key is skipped (never one shared key for
 *   every user). Logged once per process.
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
    ['100.64.0.0', 10]
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

let warnedNull = false;

/**
 * @param {Object} socket - a Socket.IO socket
 * @returns {string|null}
 */
function getClientIp(socket) {
    const handshake = socket && socket.handshake;
    const peer = normalize(handshake && handshake.address);
    if (!peer) return null;
    if (!isProxyPeer(peer)) return peer;

    const headers = (handshake && handshake.headers) || {};
    const real = normalize(headers['x-real-ip']);
    if (real) return real;
    const xff = headers['x-forwarded-for'];
    const first = typeof xff === 'string' ? xff.split(',')[0] : Array.isArray(xff) ? String(xff[0]).split(',')[0] : null;
    const forwarded = normalize(first);
    if (forwarded) return forwarded;

    if (!warnedNull) {
        warnedNull = true;
        authLogger.warn('No client IP behind a proxy peer; per-IP sign-in limit disabled', { peer });
    }
    return null;
}

module.exports = { getClientIp, isProxyPeer, _normalize: normalize };
