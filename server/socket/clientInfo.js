/**
 * Client capabilities (c2s clientHello; contract/README.md "Client
 * capabilities").
 *
 * A client that can render avatar URLs (`avatarUrl` / `avatarUrls` payload
 * fields, GET /avatar/:username) says so on every connect:
 *   clientHello {client, version, build?, caps: ['avatarUrl']}
 * The server keeps it on `socket.data.client`, which dies with the socket
 * (no map, nothing to clean up on disconnect). Sockets that never say hello
 * (the App Store iOS build cc9059f, web bundles cached before this change)
 * get exactly the legacy payload shapes. The last hello wins: one without
 * 'avatarUrl' downgrades the socket again. Unknown caps are dropped.
 *
 * Over its rate limit (rateLimiter.limits.clientHello) a hello is dropped
 * silently; there is never a reply. The log line is the V1_REMOVALS step-0
 * telemetry (how many sockets still lack the cap, which app versions are
 * out there); nothing acts on the version yet.
 */

'use strict';

const rateLimiter = require('./rateLimiter');
const { socketLogger } = require('../utils/logger');

/** Capabilities this server acts on ($defs.clientCap in contract/src/defs.js). */
const KNOWN_CAPS = ['avatarUrl'];

/** clientHello (Joi-validated by syncHandler('clientHello')). */
function handle(socket, io, data) {
    if (!rateLimiter.check(socket.id, 'clientHello')) return;
    const caps = [...new Set((data.caps || []).filter((c) => KNOWN_CAPS.includes(c)))];
    const info = { client: data.client, version: data.version, build: data.build || null, caps };
    if (socket.data) socket.data.client = info;
    socketLogger.info('clientHello', { socketId: socket.id, ...info });
}

/** Has `socket` announced `cap`? */
function hasCap(socket, cap) {
    return socket?.data?.client?.caps?.includes(cap) === true;
}

/** Has the live socket `socketId` announced `cap`? Bots, null and unknown ids: false. */
function socketHasCap(io, socketId, cap) {
    if (!socketId || typeof socketId !== 'string' || socketId.startsWith('bot:')) return false;
    return hasCap(io?.sockets?.sockets?.get(socketId), cap);
}

module.exports = { KNOWN_CAPS, handle, hasCap, socketHasCap };
