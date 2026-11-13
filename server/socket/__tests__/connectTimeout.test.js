/**
 * An engine.io connection that never joins the namespace is closed after
 * CONNECT_TIMEOUT_MS (10 s), not Socket.IO's default 45 s, while a client
 * that joined stays connected (server/socket/serverOptions.js: the iOS app
 * stuck after a long background until the server dropped such a connection).
 * Real Socket.IO server on an ephemeral port, real clients.
 */

const http = require('http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');
const { Socket: EngineSocket } = require('engine.io-client');
const { CONNECT_TIMEOUT_MS, socketServerOptions } = require('../serverOptions');

describe('Socket.IO connectTimeout', () => {
    let httpServer, io, port;

    beforeAll(async () => {
        httpServer = http.createServer();
        io = new Server(httpServer, socketServerOptions({ allowedOrigins: ['*'] }));
        await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
        port = httpServer.address().port;
    });

    afterAll(async () => {
        io.close();
        await new Promise((resolve) => httpServer.close(resolve));
    });

    test('is 10 s, well under the 45 s default', () => {
        expect(CONNECT_TIMEOUT_MS).toBe(10000);
        expect(socketServerOptions({ allowedOrigins: ['*'] }).connectTimeout).toBe(CONNECT_TIMEOUT_MS);
    });

    test('closes an engine that never joins the namespace; a joined client stays', async () => {
        const joined = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
        await new Promise((resolve, reject) => { joined.once('connect', resolve); joined.once('connect_error', reject); });

        const started = Date.now();
        const engine = new EngineSocket(`ws://127.0.0.1:${port}`, { path: '/socket.io/', transports: ['websocket'] });
        await new Promise((resolve) => engine.once('open', resolve));
        const closedAfter = await new Promise((resolve) => engine.once('close', () => resolve(Date.now() - started)));

        expect(closedAfter).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS - 200);
        expect(closedAfter).toBeLessThan(CONNECT_TIMEOUT_MS + 2000);
        expect(joined.connected).toBe(true);
        joined.close();
    }, CONNECT_TIMEOUT_MS + 5000);
});
