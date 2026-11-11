/**
 * Test helpers for the owner's bore sequence (2026-11-11) in the recorded
 * events-presence-s21 game, viewer 'seat3-rejoin' (ios_di at seat 3): bot
 * seat 4 bids B, seat 1 (the partner) 1, bot seat 2 2B, then seat 3's turn.
 * Read-only use of the recording (testing/replay.js).
 */

const VIEWER = 'seat3-rejoin';
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Index of the updateTurn to seat 3 right after the 2B. */
export function ownerTurnIndex(rec) {
  const log = rec.logs[VIEWER];
  return log.findIndex((e, i) => e.event === 'updateTurn' && e.data.currentTurn === 3 &&
    log[i - 1]?.event === 'bidReceived' && log[i - 1].data.bid === '2B');
}

/**
 * The server's table at that turn: the recording's last bidding checkpoint
 * (after the B) plus seat 1's 1 and seat 2's 2B, at the turn's seq.
 */
export function snapshotAtOwnerTurn(rec) {
  const at = ownerTurnIndex(rec);
  const cp = rec.checkpoints.filter((c) => c.viewer === VIEWER && c.afterIndex <= at && c.snapshot.stage === 'BIDDING').pop();
  if (JSON.stringify(cp?.snapshot.bids.byPosition) !== JSON.stringify([null, null, null, 'B'])) {
    throw new Error('events-presence-s21 changed: re-pick the owner bore checkpoint');
  }
  const snap = clone(cp.snapshot);
  snap.bids.byPosition = ['1', '2B', null, 'B'];
  snap.bids.mults = { team1: 1, team2: 4 };
  snap.turn = { position: 3, action: 'bid' };
  snap.seq = rec.logs[VIEWER][at].data.seq;
  return snap;
}

/** The bid sheet's bore buttons: {open, B, 2B, 3B, 4B: 'on'|'off'}, null without a sheet. */
export function boreStates(scene) {
  const bm = scene.bidManager;
  if (!bm?.bidContainer) return null;
  const out = { open: bm.bidContainer.classList.contains('is-open') };
  for (const b of ['B', '2B', '3B', '4B']) {
    const btn = bm.boreButtons[b];
    out[b] = !btn || !btn.isConnected ? 'missing' : btn.disabled ? 'off' : 'on';
  }
  out.sheets = document.querySelectorAll('#bidContainer').length;
  return out;
}

/** The owner's expectation: only 3B on, the sheet open, one sheet. */
export const OWNER_BORES = { open: true, B: 'off', '2B': 'off', '3B': 'on', '4B': 'off', sheets: 1 };
