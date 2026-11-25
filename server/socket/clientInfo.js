/**
 * Client capabilities (c2s clientHello; contract/README.md "Client
 * capabilities").
 *
 * A client that can render avatar URLs (`avatarUrl` / `avatarUrls` payload
 * fields, GET /avatar/:username) says so on every connect:
 *   clientHello {client, version, build?, caps: ['avatarUrl']}
 * The server keeps it on `socket.data.client`, which dies with the socket
 * (no map, nothing to clean up on disconnect). Sockets that never say hello
 * (both iOS App Store builds, 1.0.0 and 1.1.0, and web bundles cached before
 * this change) get exactly the legacy payload shapes. The iOS build number
 * comes from the handshake User-Agent instead (upgradeGate.js,
 * socket.data.appBuild). The last hello wins: one without
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

/**
 * Capabilities this server acts on ($defs.clientCap and
 * $defs.clientCapCasualSpectators in contract/src/defs.js):
 *   avatarUrl         renders avatar URLs (above)
 *   casualSpectators  family lobbies of up to 8 (more than 4 only while
 *                     every human in it says so), voiceSettings and
 *                     spectator voice (GameManager.lobbyCapacity,
 *                     server/voice/gameVoice.js)
 *   playAgain         at the end of a lobby-born casual game the socket is
 *                     moved back into that lobby (lobbyReturn), a place is
 *                     held if it is away, its offline hold is claimed on
 *                     joinMainRoom (server/socket/playAgain.js)
 *   assist            renders the private s2c assistHint (/help answers);
 *                     without it the answer comes as private system lines
 *                     (server/socket/assistHandlers.js)
 *   tutorial          renders the tutorial's tips (assistHint kind tip,
 *                     tipId, actions Keep / Turn off) and s2c assistState;
 *                     only such a socket gets the tutorial's auto-start in
 *                     a new account's first game (assistHandlers.autoStart);
 *                     without it tips come as private "Tip: ..." lines
 *   shoulderView      the over-the-shoulder view (owner 2026-11-21): a pure
 *                     spectator may watch one seat's hand (c2s watchHand,
 *                     s2c watchHandRefused, gameStart / snapshot `shoulder`,
 *                     mirrored assistHint `watched`, `shoulder` on the
 *                     spectator list's entries); a socket without it gets
 *                     none of that (server/socket/shoulderView.js). A hello
 *                     that drops it ends the socket's watch
 *   tournamentVoice   tournament voice (2026-11-24): the client starts voice
 *                     on its tournament lobby screen, so it may be put in
 *                     the tournament's voice room (tournament:<id>) and
 *                     listed there, and it starts voice at a tournament
 *                     table, so it is announced at seating; a socket
 *                     without it is never a tournament-room peer (shipped
 *                     iOS 1.2.5 (39) and older start no voice on that
 *                     screen); at a table casualSpectators from a client
 *                     that is not the web also counts
 *                     (server/voice/tournamentVoice.js)
 */
const KNOWN_CAPS = ['avatarUrl', 'casualSpectators', 'playAgain', 'assist', 'tutorial', 'shoulderView', 'tournamentVoice'];

/** clientHello (Joi-validated by syncHandler('clientHello')). */
function handle(socket, io, data) {
    if (!rateLimiter.check(socket.id, 'clientHello')) return;
    const caps = [...new Set((data.caps || []).filter((c) => KNOWN_CAPS.includes(c)))];
    const info = { client: data.client, version: data.version, build: data.build || null, caps };
    if (socket.data) socket.data.client = info;
    socketLogger.info('clientHello', { socketId: socket.id, ...info });
    // lazy: shoulderView requires this module
    if (!caps.includes('shoulderView')) require('./shoulderView').capDropped(io, socket);
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
