/**
 * Options for the Socket.IO server (server/index.js).
 *
 * connectTimeout: how long an engine.io connection may stay open without
 * joining the namespace before the server closes it. Socket.IO's default is
 * 45 s. Every client joins at once (web: socket.io-client; iOS: the
 * namespace connect right after the handshake), so a connection that has not
 * joined after 10 s never will.
 *
 * Why it matters (owner, 2026-11-12, "buttons aren't responsive ... after it
 * supposedly is reconnected"): the iOS app (1.1.0 and 1.2.0) could end a
 * foreground after a long background with two handshakes in flight
 * (Socket.IO-Client-Swift's own reconnect and the app's forceReconnect); the
 * namespace connect of the engine it kept was lost, so it never got
 * `.connect`, never restored its session and dropped every tap, until this
 * timeout closed that engine and the library reconnected cleanly. 10 s
 * bounds that for the builds shipped before it. iOS 1.2.0 (build 5 on; the
 * App Store build since 2026-11-13) replaces the connection on the foreground instead (SocketService.forceReconnect),
 * but the library's own reconnects can still overlap two handshakes on a
 * slow link (one over ~1.5 s), which this timeout also bounds.
 */

const CONNECT_TIMEOUT_MS = 10000;

function socketServerOptions(config) {
    return {
        cors: {
            origin: config.allowedOrigins,
            methods: ['GET', 'POST']
        },
        connectTimeout: CONNECT_TIMEOUT_MS
    };
}

module.exports = { CONNECT_TIMEOUT_MS, socketServerOptions };
