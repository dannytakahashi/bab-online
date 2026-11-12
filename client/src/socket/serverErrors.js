/**
 * App-level server errors on two channels (contract/V1_REMOVALS.md #1).
 *
 * Phase A (2026-11-11): every server error is sent as the v1 `error`
 * ({message, type?, handler?}) and right after it as its twin `serverError`
 * {code, message, handler} (server/socket/serverError.js emitError), both
 * with the same handler. Phase B drops `error`. The page listens to both,
 * so it keeps working through phase B with no change, and handles one
 * failure once: the second copy is dropped here, the way iOS 1.2's
 * ServerErrorDeduper (iOSClient/BABOnline/Networking/SocketService.swift)
 * does it.
 */

/** A twin arrives right after its first copy (same socket, same tick); this is generous. */
export const DEDUPE_WINDOW_MS = 1500;

export const CHANNEL = Object.freeze({ ERROR: 'error', SERVER_ERROR: 'serverError' });

/**
 * One failure in the shape handleSocketError reads, from either channel:
 * {type, message, handler}. A serverError's code (rateLimit / validation /
 * server / rejected) is the v1 type (a refusal had none: 'rejected' falls
 * to the same default); handler is null when the server named none.
 * @param {string} channel - CHANNEL.ERROR | CHANNEL.SERVER_ERROR
 * @param {*} payload
 */
export function failureOf(channel, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const message = typeof p.message === 'string' ? p.message : undefined;
  const handler = typeof p.handler === 'string' ? p.handler : null;
  const type = channel === CHANNEL.SERVER_ERROR ? p.code : p.type;
  return { type: typeof type === 'string' ? type : undefined, message, handler };
}

/**
 * Drops the other channel's copy of the failure just handled: a copy on
 * the other channel within DEDUPE_WINDOW_MS with an equal handler (both
 * null: an equal message too, since the two may word it differently). One
 * twin per failure: once matched, a third copy counts as a new failure.
 */
export class ServerErrorDeduper {
  constructor({ now = () => Date.now(), windowMs = DEDUPE_WINDOW_MS } = {}) {
    this._now = now;
    this._windowMs = windowMs;
    this._last = null; // {channel, message, handler, at}
  }

  /**
   * @param {string} channel
   * @param {{message?: string, handler?: string|null}} failure
   * @returns {boolean} true: handle it; false: the twin of the one just handled
   */
  accept(channel, { message, handler = null } = {}) {
    const at = this._now();
    const l = this._last;
    if (l && l.channel !== channel && at - l.at < this._windowMs &&
        l.handler === handler && (handler !== null || l.message === message)) {
      this._last = null;
      return false;
    }
    this._last = { channel, message, handler, at };
    return true;
  }
}

/** Errors that answer a table request: the table resyncs on them (iOS SocketService.routeTableError). */
export const TABLE_ERROR_HANDLERS = Object.freeze(['playCard', 'playerBid', 'requestSnapshot']);
