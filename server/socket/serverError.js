/**
 * App-level errors to one socket: `serverError {code, message, handler}`
 * (contract/V1_REMOVALS.md #1). Every server error goes through here (the
 * socket wrappers, the handlers' refusals, chat command errors).
 *
 * Phase A (2026-11-11) sent each one twice, as the v1 `error` and then this
 * twin; phase B (once iOS 1.1.0 was gated) dropped `error`. Web (main.js
 * onServerFailure, adminApi.js) and iOS 1.2.0 (SocketService.swift
 * handleServerError) read serverError. Its name is not `error` because
 * Socket.IO-Client-Swift reserves that one for its own transport errors
 * (`clientEvent: .error`, which 1.2.0 still listens to for those).
 *
 * code (contract $defs.serverErrorCode):
 *   rateLimit   over the event's per-socket limit (asyncHandler/syncHandler)
 *   validation  the payload failed its Joi schema
 *   server      an unexpected exception (no details)
 *   rejected    the handler refused the request ({message} only today:
 *               "Not in a lobby", "Lobby is full", ...)
 * handler: the c2s event the error answers (null when unknown); the
 * wrappers name the registered event itself (errorHandler.js options.event).
 */

const CODES = ['rateLimit', 'validation', 'server', 'rejected'];

/**
 * The serverError payload for an error `{type?, message, handler?}` (type:
 * one of CODES, absent for a refusal). `handler` names the c2s event when
 * the payload does not.
 */
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
 * Send `payload` to `socket` as serverError.
 * @param {Socket} socket
 * @param {{message: string, type?: string, handler?: string}} payload
 * @param {string} [handler] - the c2s event, when the payload does not name it
 */
function emitError(socket, payload, handler) {
    socket.emit('serverError', serverErrorOf(payload, handler));
}

module.exports = { emitError, serverErrorOf, CODES };
