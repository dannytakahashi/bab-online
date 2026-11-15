/**
 * ALLOWED_ORIGINS (server/config/index.js) reaches Socket.IO's `cors`
 * option: polling responses carry Access-Control-Allow-Origin for a listed
 * origin only. It never refuses a connection: a client with no Origin
 * (native, like iOS 1.2.0's polling), the web page's websocket from
 * babonline.io, an Origin the Swift websocket library makes up from the
 * server URL, and a foreign one all connect. Real Socket.IO server, real
 * clients.
 */

const http = require('http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { socketServerOptions } = require('../serverOptions');
const config = require('../../config');

const { DEFAULT_ALLOWED_ORIGINS, parseAllowedOrigins } = config;
// Hosts on the reserved .invalid TLD (no real site)
const FOREIGN = `https://${['elsewhere', 'invalid'].join('.')}`;

describe('parseAllowedOrigins', () => {
    test('defaults to production + local dev; a list replaces it; * allows any', () => {
        expect(parseAllowedOrigins(undefined)).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
        expect(parseAllowedOrigins(' ')).toEqual([...DEFAULT_ALLOWED_ORIGINS]);
        expect(DEFAULT_ALLOWED_ORIGINS).toEqual(expect.arrayContaining([
            'https://babonline.io', 'https://www.babonline.io', 'https://bab-online-production.up.railway.app', 'http://localhost:5173',
        ]));
        expect(parseAllowedOrigins(`${FOREIGN}, https://babonline.io`)).toEqual([FOREIGN, 'https://babonline.io']);
        expect(parseAllowedOrigins('*')).toBe('*');
    });
});

describe('Socket.IO with the default origins', () => {
    let httpServer, io, port;

    beforeAll(async () => {
        httpServer = http.createServer();
        io = new Server(httpServer, socketServerOptions({ allowedOrigins: parseAllowedOrigins(undefined) }));
        io.on('connection', (s) => s.on('ping2', (cb) => cb('pong')));
        await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
        port = httpServer.address().port;
    });

    afterAll(async () => {
        io.close();
        await new Promise((resolve) => httpServer.close(resolve));
    });

    /** A polling handshake with (or without) an Origin header. */
    function handshake(origin) {
        return new Promise((resolve, reject) => {
            const headers = origin ? { Origin: origin } : {};
            http.get({ host: '127.0.0.1', port, path: '/socket.io/?EIO=4&transport=polling', headers }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, acao: res.headers['access-control-allow-origin'], body }));
            }).on('error', reject);
        });
    }

    test('polling: a listed origin gets ACAO; no Origin and a foreign one are answered without it, never refused', async () => {
        const listed = await handshake('https://babonline.io');
        expect(listed).toMatchObject({ status: 200, acao: 'https://babonline.io' });
        expect(listed.body).toMatch(/"sid"/);
        const none = await handshake(null);
        expect(none.status).toBe(200);
        expect(none.acao).toBeUndefined();
        expect(none.body).toMatch(/"sid"/);
        const foreign = await handshake(FOREIGN);
        expect(foreign.status).toBe(200);
        expect(foreign.acao).toBeUndefined();
    });

    test.each([
        ['an iOS-like client: polling, then the websocket upgrade, no Origin', { transports: ['polling', 'websocket'] }],
        ['the web page: websocket only, from babonline.io', { transports: ['websocket'], extraHeaders: { Origin: 'https://babonline.io' } }],
        ['a websocket Origin made from the server URL (Starscream)', { transports: ['websocket'], extraHeaders: { Origin: 'wss://bab-online-production.up.railway.app' } }],
        ['a foreign websocket Origin (not refused: no cookies, so no CSWSH)', { transports: ['websocket'], extraHeaders: { Origin: FOREIGN } }],
    ])('%s connects and talks', async (_label, opts) => {
        const c = ioClient(`http://127.0.0.1:${port}`, { reconnection: false, ...opts });
        try {
            await new Promise((resolve, reject) => { c.once('connect', resolve); c.once('connect_error', reject); });
            expect(await c.timeout(2000).emitWithAck('ping2')).toBe('pong');
        } finally {
            c.close();
        }
    });
});
