/**
 * App-level errors to one socket: the v1 `error` event and, additively,
 * `serverError {code, message, handler}` (contract/V1_REMOVALS.md #1 phase
 * A, 2026-11-11). Every server error goes through here (the socket
 * wrappers, the handlers' refusals, chat command errors), so a client that
 * listens to serverError never misses one. `error` stays until phase B:
 * iOS 1.1.0 and web read only it (iOS through Socket.IO-Client-Swift's
 * clientEvent .error, the reserved name, which is why the new event has
 * another one).
 *
 * Both copies of one failure carry the same handler: a client reading both
 * channels during phase A (iOS 1.2's ServerErrorDeduper) drops the second
 * copy only when the handlers match. So a refusal's `error` is {message,
 * handler} (variant `rejected`, additive: 1.1.0 and web route only on
 * playCard / playerBid / requestSnapshot, which no refusal names), and the
 * wrappers name the c2s event itself (errorHandler.js options.event).
 *
 * code (contract $defs.serverErrorCode):
 *   rateLimit   over the event's per-socket limit (asyncHandler/syncHandler)
 *   validation  the payload failed its Joi schema
 *   server      an unexpected exception (no details)
 *   rejected    the handler refused the request ({message} only today:
 *               "Not in a lobby", "Lobby is full", ...)
 * handler: the c2s event the error answers (null when unknown).
 */

const CODES = ['rateLimit', 'validation', 'server', 'rejected'];

/** The serverError payload for a v1 `error` payload. */
function serverErrorOf(payload, handler) {
    const p = payload || {};
    const code = CODES.includes(p.type) ? p.type : 'rejected';
    return {
        code,
        message: typeof p.message === 'string' ? p.message : 'Something went wrong',
        handler: handler || (typeof p.handler === 'string' ? p.handler : null),
    };
}

/**
 * The v1 `error` payload: `payload`, plus `handler` when the caller names
 * the event and the payload does not (a refusal), so `error` and its
 * serverError twin carry the same handler.
 */
function errorOf(payload, handler) {
    const p = payload || {};
    return handler && p.handler === undefined ? { ...p, handler } : p;
}

/**
 * Send `payload` as `error` and its serverError twin, both with the handler.
 * @param {Socket} socket
 * @param {{message: string, type?: string, handler?: string}} payload
 * @param {string} [handler] - the c2s event, when the payload does not name it
 */
function emitError(socket, payload, handler) {
    const p = errorOf(payload, handler);
    socket.emit('error', p);
    socket.emit('serverError', serverErrorOf(p));
}

module.exports = { emitError, errorOf, serverErrorOf, CODES };
