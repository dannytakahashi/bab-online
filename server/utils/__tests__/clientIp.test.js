/**
 * getClientIp: Railway's edge is a CGNAT (100.64/10) peer that sets
 * X-Real-IP; a public peer is a direct connection whose headers anyone can
 * forge; behind a proxy without headers there is no IP (null, never a
 * shared key).
 */

const { getClientIp, isProxyPeer } = require('../clientIp');
const { authLogger } = require('../logger');

const sock = (address, headers = {}) => ({ handshake: { address, headers } });

test('CGNAT peer + X-Real-IP -> the X-Real-IP', () => {
    expect(getClientIp(sock('::ffff:100.64.3.7', { 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
});

test('CGNAT peer + X-Forwarded-For -> the leftmost entry', () => {
    expect(getClientIp(sock('::ffff:100.64.3.7', { 'x-forwarded-for': '198.51.100.2, 100.64.0.1' }))).toBe('198.51.100.2');
});

test('X-Real-IP wins over X-Forwarded-For', () => {
    expect(getClientIp(sock('100.64.0.9', { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.2' }))).toBe('203.0.113.9');
});

test('a public peer is a direct connection: spoofed headers are ignored', () => {
    expect(getClientIp(sock('::ffff:198.51.100.77', { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }))).toBe('198.51.100.77');
    expect(getClientIp(sock('2001:db8::5', { 'x-forwarded-for': '5.6.7.8' }))).toBe('2001:db8::5');
});

test('a proxy peer with no usable header -> null (warned once)', () => {
    const warn = jest.spyOn(authLogger, 'warn').mockImplementation(() => {});
    expect(getClientIp(sock('127.0.0.1'))).toBeNull();
    expect(getClientIp(sock('10.1.2.3'))).toBeNull();
    expect(warn.mock.calls.filter(c => /per-IP sign-in limit disabled/.test(c[0])).length).toBeLessThanOrEqual(1);
    warn.mockRestore();
});

test('no handshake (or no address) -> null', () => {
    expect(getClientIp({})).toBeNull();
    expect(getClientIp(null)).toBeNull();
    expect(getClientIp({ handshake: { headers: { 'x-real-ip': '1.2.3.4' } } })).toBeNull();
});

test('garbage headers are ignored', () => {
    expect(getClientIp(sock('100.64.0.1', { 'x-real-ip': 'not-an-ip', 'x-forwarded-for': 'evil, 198.51.100.2' }))).toBeNull();
    expect(getClientIp(sock('100.64.0.1', { 'x-real-ip': '999.1.1.1', 'x-forwarded-for': '  203.0.113.4 , x' }))).toBe('203.0.113.4');
    expect(getClientIp(sock('100.64.0.1', { 'x-real-ip': ['203.0.113.5'] }))).toBe('203.0.113.5');
});

test('proxy-peer ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.255', '::1', 'fd12::1', 'fc00::1']) {
        expect({ ip, proxy: isProxyPeer(ip) }).toEqual({ ip, proxy: true });
    }
    for (const ip of ['172.32.0.1', '100.128.0.1', '8.8.8.8', '203.0.113.9', '2001:db8::1', 'fe80::1']) {
        expect({ ip, proxy: isProxyPeer(ip) }).toEqual({ ip, proxy: false });
    }
});
