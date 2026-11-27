/**
 * The SFU voice requests (docs/claude/voice.md, "SFU voice (server)", the
 * client protocol): every sfu* emit carries a requestId and is answered by
 * exactly one private sfuReply with it. A reply that has not come within
 * REPLY_TIMEOUT_MS counts as a retryable timeout (the server answers within
 * about 11 s: 3 s waiting behind earlier calls plus one 8 s Cloudflare call),
 * and a reply that comes after that is ignored by its requestId (the server
 * closes anything a late pull opened for a session the client gave up).
 *
 * Nothing here ever rejects: every request resolves to the reply, or to a
 * reply-shaped refusal made here ({ok: false, error: {code, retryable}}):
 * `client_timeout` (no reply in time), `disconnected` (the socket is not
 * connected: socket.io would buffer the emit and send it on the NEXT socket,
 * which holds no session), `cancelled` (the transport stopped).
 */

/** How long a request waits for its sfuReply. */
export const REPLY_TIMEOUT_MS = 12000;

/** A refusal made on this side (never from the server). */
export function localError(code, { retryable = true } = {}) {
  return { ok: false, error: { code, retryable, retryAfterMs: null, status: null, cfCode: null } };
}

/**
 * @param {Object} o
 * @param {(event: string, data: Object) => void} o.emit
 * @param {() => boolean} o.isConnected
 * @param {number} [o.timeoutMs]
 * @param {Function} [o.setTimer]
 * @param {Function} [o.clearTimer]
 */
export function createSfuRequester({
  emit,
  isConnected,
  timeoutMs = REPLY_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
}) {
  const open = new Map(); // requestId -> {resolve, timer}
  const prefix = `sfu-${Math.random().toString(36).slice(2, 8)}-`;
  let seq = 0;

  function settle(requestId, value) {
    const w = open.get(requestId);
    if (!w) return false;
    open.delete(requestId);
    clearTimer(w.timer);
    w.resolve(value);
    return true;
  }

  return {
    /**
     * Send one sfu* request.
     * @returns {Promise<Object>} the sfuReply, or a local refusal
     */
    request(event, payload = {}) {
      if (!isConnected()) return Promise.resolve(localError('disconnected'));
      const requestId = `${prefix}${++seq}`;
      return new Promise((resolve) => {
        const timer = setTimer(() => settle(requestId, localError('client_timeout')), timeoutMs);
        open.set(requestId, { resolve, timer });
        try {
          emit(event, { requestId, ...payload });
        } catch (err) {
          settle(requestId, localError('disconnected'));
        }
      });
    },

    /** An sfuReply from the server: true when it answered an open request (a late one is ignored). */
    onReply(data) {
      if (!data || typeof data.requestId !== 'string') return false;
      return settle(data.requestId, data);
    },

    /** Every open request resolves `cancelled` now (their replies are ignored later). */
    cancelAll() {
      for (const id of [...open.keys()]) settle(id, localError('cancelled', { retryable: false }));
    },

    /**
     * Every open request resolves `code` now (retryable): the socket
     * dropped, so their replies went with it (a reply is sent on the
     * asking socket only). The loop goes on at once instead of waiting out
     * the 12 s timeout, so a resume on the next socket is sent at once.
     */
    failAll(code = 'disconnected') {
      for (const id of [...open.keys()]) settle(id, localError(code));
    },

    get openCount() {
      return open.size;
    },
  };
}

/**
 * One serial queue (a session's: Cloudflare wants every mutation of a
 * session serialized, and so does a PeerConnection's negotiation). `drop`
 * ends it: work not started never runs (it resolves `superseded`), and the
 * job running now sees `dropped` true after each await.
 */
export class SerialQueue {
  constructor() {
    this._tail = Promise.resolve();
    this.dropped = false;
    this.pending = 0;
  }

  /**
   * @param {() => Promise<any>} job
   * @returns {Promise<any>} the job's result, or {superseded: true} when dropped first
   */
  run(job) {
    this.pending++;
    const out = this._tail.then(async () => {
      this.pending--;
      if (this.dropped) return { superseded: true };
      return job();
    });
    this._tail = out.catch(() => {});
    return out;
  }

  drop() {
    this.dropped = true;
  }
}
