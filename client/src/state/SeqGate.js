/**
 * The seq gate (contract/README.md R1-R5): room broadcasts carry `seq`,
 * one more than the previous one per gameId. Every sequenced event the page
 * handles passes through admit() (SocketManager wraps its listeners), so the
 * table applies them in order:
 *
 *   seq === last + 1  apply
 *   seq <= last       drop (already reflected)
 *   seq >  last + 1   a gap: buffer it, requestSnapshot (one in flight),
 *                     apply the snapshot, replay the buffered events above S
 *
 * Unsequenced events (private emits) always apply in arrival order. With no
 * baseline yet the first sequenced event sets it. A new game resets the
 * baseline: startDraw (its first broadcast), a gameStart for another
 * gameId, and after gameEnd / abortGame (the next table restarts at 1).
 * No snapshot within GAP_TIMEOUT_MS (or a not_in_game answer): the buffer
 * is applied in order anyway (iOS does the same).
 */

import { classifySeq } from './snapshotV2.js';

export const GAP_TIMEOUT_MS = 5000;

const TERMINAL = new Set(['gameEnd', 'abortGame']);

export class SeqGate {
  /**
   * @param {Object} [deps]
   * @param {Function} [deps.requestSnapshot] - (requestId) => void
   * @param {Function} [deps.setTimer]
   * @param {Function} [deps.clearTimer]
   */
  constructor({ requestSnapshot = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    this._request = requestSnapshot;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._nextRequestNo = 1;
    this.stats = { applied: 0, dropped: 0, gaps: 0, replayed: 0, flushed: 0 };
    this.log = [];
    this.reset();
  }

  configure({ requestSnapshot } = {}) {
    if (requestSnapshot) this._request = requestSnapshot;
  }

  /** Forget the baseline (a new game, an exit). */
  reset(gameId = null) {
    this.gameId = gameId;
    this.lastSeq = null;
    this._buffer = [];
    this.resyncId = null;
    if (this._timer) this._clearTimer(this._timer);
    this._timer = null;
  }

  get buffered() {
    return this._buffer.length;
  }

  _note(entry) {
    this.log.push(entry);
    if (this.log.length > 50) this.log.shift();
  }

  /**
   * @param {string} event
   * @param {*} data
   * @param {Function} apply - runs the event's handler
   */
  admit(event, data, apply) {
    const seq = data && typeof data === 'object' && Number.isInteger(data.seq) ? data.seq : null;
    if (seq === null) {
      apply();
      return 'unsequenced';
    }
    if (event === 'startDraw') this.reset();
    else if (event === 'gameStart' && data.gameId && this.gameId && data.gameId !== this.gameId) this.reset(data.gameId);
    if (event === 'gameStart' && data.gameId) this.gameId = data.gameId;

    if (this.lastSeq === null) {
      this.lastSeq = seq;
      return this._apply(event, apply);
    }
    switch (classifySeq(this.lastSeq, seq)) {
      case 'next':
        this.lastSeq = seq;
        return this._apply(event, apply);
      case 'stale':
        this.stats.dropped++;
        this._note({ event, seq, verdict: 'stale', last: this.lastSeq });
        return 'stale';
      default:
        this._buffer.push({ event, seq, apply });
        this.stats.gaps++;
        this._note({ event, seq, verdict: 'gap', last: this.lastSeq });
        if (!this.resyncId) this._requestResync();
        return 'gap';
    }
  }

  _apply(event, apply) {
    this.stats.applied++;
    try {
      apply();
    } finally {
      if (TERMINAL.has(event)) this.reset();
    }
    return 'applied';
  }

  _requestResync() {
    const id = `gap-${this._nextRequestNo++}`;
    this.resyncId = id;
    if (this._timer) this._clearTimer(this._timer);
    this._timer = this._setTimer(() => {
      this._timer = null;
      if (this.resyncId === id) this.flushBuffer();
    }, GAP_TIMEOUT_MS);
    this._request(id);
  }

  /**
   * A snapshot was applied (any source: R3 says always apply one): it is
   * the new baseline; what was buffered above it replays in order.
   */
  onSnapshot(snapshot) {
    if (!snapshot || !Number.isInteger(snapshot.seq)) return;
    const buffered = this._buffer;
    this._buffer = [];
    this.resyncId = null;
    if (this._timer) this._clearTimer(this._timer);
    this._timer = null;
    this.gameId = snapshot.gameId || this.gameId;
    this.lastSeq = snapshot.seq;
    for (const b of buffered.sort((a, c) => a.seq - c.seq)) {
      if (b.seq <= this.lastSeq) {
        this.stats.dropped++;
        continue;
      }
      this.stats.replayed++;
      this.admit(b.event, { seq: b.seq }, b.apply);
    }
  }

  /** No snapshot is coming: apply what was buffered, in order. */
  flushBuffer() {
    const buffered = this._buffer.sort((a, c) => a.seq - c.seq);
    this._buffer = [];
    this.resyncId = null;
    if (this._timer) this._clearTimer(this._timer);
    this._timer = null;
    for (const b of buffered) {
      if (this.lastSeq !== null && b.seq <= this.lastSeq) {
        this.stats.dropped++;
        continue;
      }
      this.lastSeq = b.seq;
      this.stats.flushed++;
      this._apply(b.event, b.apply);
    }
  }
}

let instance = null;

export function getSeqGate() {
  if (!instance) instance = new SeqGate();
  return instance;
}

/** For tests. */
export function resetSeqGate(options) {
  instance = new SeqGate(options);
  return instance;
}
