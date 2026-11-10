/**
 * The table's restore path: every snapshot the page receives (rejoinSuccess,
 * restorePlayerState, the spectator full state, actionRejected, a
 * requestSnapshot reply) goes through applyTableSnapshot, in this order:
 *
 *   1. GameState.applySnapshot (the whole table; snapshot v2 when the
 *      payload carries one, else snapshotFromLegacy of the v1 fields)
 *   2. MyAction.reconcile (a pending bid/play is confirmed or rolled back)
 *   3. the caller's render (queued behind the scene if it is not ready)
 *   4. SeqGate.onSnapshot: the snapshot is the seq baseline; buffered
 *      events above it replay now, after the render was queued
 */

import { parseSnapshotV2 } from './snapshotV2.js';
import { snapshotFromLegacy } from './legacySnapshot.js';
import { getGameState } from './GameState.js';
import { getMyAction } from './MyAction.js';
import { getSeqGate } from './SeqGate.js';

/**
 * The snapshot of a payload: its v2 `snapshot` when valid, else one built
 * from the v1 table fields (null when it has neither).
 * @param {Object} payload - a carrier ({snapshot, ...v1}) or a bare v2 snapshot
 * @param {Object} [opts]
 * @param {string} [opts.role] - for the legacy build
 * @returns {Object|null}
 */
export function tableSnapshotOf(payload, { role } = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.v === 2 ? payload : payload.snapshot;
  if (raw) {
    const parsed = parseSnapshotV2(raw);
    if (parsed.ok) return parsed.snapshot;
    console.warn('Snapshot v2 refused, using the v1 fields:', parsed.errors.slice(0, 3));
  }
  if (payload.v === 2) return null;
  if (!payload.players && !payload.hand && !payload.trump) return null;
  return snapshotFromLegacy(payload, { role });
}

/**
 * @param {Object} payload
 * @param {Object} [opts]
 * @param {string} [opts.source] - 'rejoin' | 'restore' | 'spectate' | 'rejected' | 'gap' | 'ack' | 'ping' | 'other'
 * @param {string} [opts.role] - viewer role for a v1-only payload
 * @param {Function} [opts.render] - (snapshot, outcome) => void, between the state and the replay
 * @returns {Object|null} the applied snapshot
 */
export function applyTableSnapshot(payload, { source = 'other', role, render } = {}) {
  const snap = tableSnapshotOf(payload, { role });
  if (!snap) return null;
  getGameState().applySnapshot(snap, { players: Array.isArray(payload.players) ? payload.players : null });
  const outcome = getMyAction().reconcile(snap, source);
  render?.(snap, outcome);
  getSeqGate().onSnapshot(snap);
  return snap;
}

/** The kind of request a stateSnapshot answers (by its requestId prefix). */
export function snapshotSource(requestId) {
  const id = typeof requestId === 'string' ? requestId : '';
  if (id.startsWith('gap-')) return 'gap';
  if (id.startsWith('ack-')) return 'ack';
  if (id.startsWith('ping-')) return 'ping';
  return 'other';
}
