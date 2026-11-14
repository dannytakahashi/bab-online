/**
 * App-level server errors: `serverError {code, message, handler}`
 * (server/socket/serverError.js, contract/V1_REMOVALS.md #1).
 *
 * Phase A (2026-11-11) sent each failure twice, as the v1 `error` and its
 * `serverError` twin, and the page dropped the twin. Phase B (2026-11-12)
 * dropped `error`: serverError is the only copy, so there is nothing left
 * to dedupe (iOS 1.2.0 keeps its ServerErrorDeduper for older servers).
 */

/**
 * One failure in the shape handleSocketError reads: {type, message,
 * handler}. The code (rateLimit / validation / server / rejected) is the
 * old `type` (a refusal is 'rejected', which falls to the default message);
 * handler is null when the server named none.
 * @param {*} payload - a serverError payload
 */
export function failureOf(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const message = typeof p.message === 'string' ? p.message : undefined;
  const handler = typeof p.handler === 'string' ? p.handler : null;
  return { type: typeof p.code === 'string' ? p.code : undefined, message, handler };
}

/** Errors that answer a table request: the table resyncs on them (iOS SocketService.routeTableError). */
export const TABLE_ERROR_HANDLERS = Object.freeze(['playCard', 'playerBid', 'requestSnapshot']);
