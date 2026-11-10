/**
 * MyAction: the local seat's one outstanding bid or play (cli-18,
 * webclient-19, ui-11). An explicit FSM, mirroring the iOS ActionCoordinator
 * (docs/ios-table-store.md):
 *
 *   idle --submit--> pending --own cardPlayed / bidReceived--> confirmed (idle)
 *                     |  \---actionRejected (its snapshot)---> rolledBack (idle)
 *                     \--a snapshot shows it taken / not taken--> confirmed / rolledBack
 *
 * The hand in GameState is never edited by a submission: the render model
 * hides the pending card and shows it at my trick slot, so a rollback is
 * just dropping `pending` and rendering the snapshot (the card is back in
 * the hand).
 *
 * Ack timeout (ACK_TIMEOUT_MS, network liveness, not pacing): ask for a
 * snapshot and reconcile from it; never roll back blindly, the server may
 * have accepted the play (the 4th card of a trick is acknowledged at once;
 * only its resolution waits on the server's hold). After MAX_RESYNCS
 * unanswered requests the socket is forced to reconnect: the rejoin's
 * snapshot reconciles.
 *
 * The timer knows the connection (deps.connectionId: the socket id while
 * connected, else null). Silence counts only against the connection the
 * action, or its resync, went out on: while the socket is down, or once it
 * has reconnected (a new id, its restoreSession / rejoin may still be in
 * flight), the timer just re-arms and the count starts over on the new
 * connection, so it never forces a reconnect onto a fresh socket the
 * transport already replaced. The rejoin's snapshot reconciles.
 *
 * Correlation is by action kind (one outstanding action per seat), so the
 * wire is unchanged.
 */

export const ACK_TIMEOUT_MS = 5000;
export const MAX_RESYNCS = 1;

export const OUTCOME = Object.freeze({
  CONFIRMED: 'confirmed',
  ROLLED_BACK: 'rolledBack',
  KEPT: 'kept',
});

/** Snapshot replies whose request may predate the action (see reconcile). */
const UNORDERED_SOURCES = new Set(['gap', 'ping']);

const sameCard = (a, b) => !!a && !!b && a.suit === b.suit && a.rank === b.rank;

export class MyAction {
  /**
   * @param {Object} [deps]
   * @param {Function} [deps.emit] - (event, payload) => void
   * @param {Function} [deps.requestSnapshot] - (requestId) => void
   * @param {Function} [deps.forceReconnect] - () => void
   * @param {Function} [deps.connectionId] - () => the connected socket's id, or null while down
   * @param {Function} [deps.setTimer]
   * @param {Function} [deps.clearTimer]
   */
  constructor({ emit = (event, data) => globalThis.window?.socket?.emit?.(event, data), requestSnapshot = () => {}, forceReconnect = () => {},
    connectionId = () => 'connected', setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    this._emit = emit;
    this._requestSnapshot = requestSnapshot;
    this._forceReconnect = forceReconnect;
    this._connectionId = connectionId;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._reqId = 0;
    this._timer = null;
    this.pending = null;
    this.history = [];
  }

  configure({ emit, requestSnapshot, forceReconnect, connectionId } = {}) {
    if (emit) this._emit = emit;
    if (requestSnapshot) this._requestSnapshot = requestSnapshot;
    if (forceReconnect) this._forceReconnect = forceReconnect;
    if (connectionId) this._connectionId = connectionId;
  }

  _conn() {
    return this._connectionId() ?? null;
  }

  get state() {
    return this.pending ? 'pending' : 'idle';
  }

  isPending(kind = null) {
    return !!this.pending && (kind === null || this.pending.kind === kind);
  }

  /** The card of a pending play, else null. */
  get pendingCard() {
    return this.pending?.kind === 'play' ? this.pending.card : null;
  }

  _note(outcome, extra = {}) {
    this.history.push({ outcome, kind: this.pending?.kind || null, reqId: this.pending?.reqId || null, ...extra });
    if (this.history.length > 50) this.history.shift();
  }

  /** @returns {boolean} whether the play went out (one outstanding action at a time) */
  submitPlay(card, position) {
    if (this.pending || !card || !position) return false;
    this._reqId++;
    this.pending = { kind: 'play', card: { suit: card.suit, rank: card.rank }, position, reqId: this._reqId, attempt: 0, conn: this._conn() };
    this._emit('playCard', { card, position });
    this._arm();
    return true;
  }

  submitBid(bid, position) {
    if (this.pending || bid === undefined || bid === null || !position) return false;
    this._reqId++;
    this.pending = { kind: 'bid', bid: String(bid).toUpperCase(), position, reqId: this._reqId, attempt: 0, conn: this._conn() };
    this._emit('playerBid', { position, bid });
    this._arm();
    return true;
  }

  _arm() {
    this._disarm();
    const id = this.pending?.reqId;
    this._timer = this._setTimer(() => this._onTimeout(id), ACK_TIMEOUT_MS);
  }

  _disarm() {
    if (this._timer !== null && this._timer !== undefined) this._clearTimer(this._timer);
    this._timer = null;
  }

  _onTimeout(id) {
    this._timer = null;
    const p = this.pending;
    if (!p || p.reqId !== id) return;
    const conn = this._conn();
    if (conn === null || conn !== p.conn) {
      // Down, or already on a new connection whose rejoin reconciles: wait,
      // and count silence afresh on the connection we end up on
      this._note('awaitConnection', { connected: conn !== null });
      p.conn = conn;
      p.attempt = 0;
      this._arm();
      return;
    }
    if (p.attempt < MAX_RESYNCS) {
      p.attempt++;
      this._note('ackTimeout', { attempt: p.attempt });
      this._requestSnapshot(`ack-${p.reqId}`);
      this._arm();
      return;
    }
    // No answer at all: a fresh connection's rejoin snapshot decides
    this._note('reconnect');
    this._forceReconnect();
  }

  _finish(outcome, extra) {
    this._note(outcome, extra);
    this._disarm();
    this.pending = null;
    return outcome;
  }

  /** My own cardPlayed / bidReceived. */
  confirm(kind, data = {}) {
    if (!this.pending || this.pending.kind !== kind) return null;
    return this._finish(OUTCOME.CONFIRMED, { via: 'event' });
  }

  /** actionRejected {action, reason}: its snapshot is the truth (applied by the caller). */
  reject(data = {}) {
    if (!this.pending || (data.action && data.action !== this.pending.kind)) return null;
    return this._finish(OUTCOME.ROLLED_BACK, { via: 'rejected', reason: data.reason || null });
  }

  /**
   * Any snapshot settles a pending action: taken (the card left my hand /
   * my bid is recorded) confirms it, otherwise it is rolled back, except a
   * reply to a request that may have gone out before the action (a gap
   * resync, the background liveness ping) that still shows my turn: the
   * server may not have seen the action yet. The ack timer stays armed,
   * so its own request (always sent after the action) decides.
   * @param {Object} snapshot - parsed v2 snapshot
   * @param {string} source - 'gap' | 'ping' | 'ack' | 'rejected' | 'rejoin' | 'restore' | 'spectate' | 'other'
   * @returns {string|null} the outcome, or null when nothing was pending
   */
  reconcile(snapshot, source = 'other') {
    const p = this.pending;
    if (!p || !snapshot) return null;
    let taken;
    if (p.kind === 'play') {
      const inHand = (snapshot.hand || []).some((c) => sameCard(c, p.card));
      taken = !inHand;
    } else {
      const bid = snapshot.bids?.byPosition?.[p.position - 1];
      taken = bid !== null && bid !== undefined;
    }
    if (taken) return this._finish(OUTCOME.CONFIRMED, { via: source });
    if (UNORDERED_SOURCES.has(source) && snapshot.viewer?.canAct) {
      this._note(OUTCOME.KEPT, { via: source });
      return OUTCOME.KEPT;
    }
    return this._finish(OUTCOME.ROLLED_BACK, { via: source });
  }

  /** The table went away (exit, new game). */
  reset() {
    this._disarm();
    this.pending = null;
  }
}

let instance = null;

export function getMyAction() {
  if (!instance) instance = new MyAction();
  return instance;
}

/** For tests. */
export function resetMyAction(options) {
  instance?.reset();
  instance = new MyAction(options);
  return instance;
}
