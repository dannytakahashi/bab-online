/**
 * Seat plates (item 18a, ui-d3): each seat's avatar sits in a ring with its
 * team's color (team A = seats 1 and 3, blue; team B = seats 2 and 4, coral),
 * a bid chip (the seat's bid) and trick pips: the seat's OWN tricks won out
 * of its own bid (owner, 2026-11-11: per player, not the team's), except a
 * bore seat, whose pips are the whole hand and the team's tricks (seatPips).
 * The chip's text comes from data-bid through CSS and the pips are empty
 * elements, so a seat's text stays its name (the plate).
 *
 * The look is table.css (.hud-avatar-ring, .hud-bid-chip, .hud-pips).
 * updateSeatPlates is a projection of GameState: every call redraws all of
 * it, so nothing can go stale.
 */
import { team } from '../utils/positions.js';
import { isBore, bidTricks, teamBidTotal } from '../rules/bids.js';

const MAX_PIPS = 13;

/** 'a' for seats 1 and 3, 'b' for 2 and 4. */
export const teamLetter = (position) => (Number(position) % 2 === 1 ? 'a' : 'b');

/**
 * Wrap an avatar image in its seat ring (team color, bid chip, pips).
 * @param {HTMLImageElement} img
 * @param {number} [position] - the seat's game position (1-4)
 * @returns {HTMLElement} the ring
 */
export function buildAvatarRing(img, position = null) {
  const ring = document.createElement('div');
  ring.className = 'hud-avatar-ring';
  ring.appendChild(img);
  const chip = document.createElement('span');
  chip.className = 'hud-bid-chip';
  chip.setAttribute('aria-hidden', 'true');
  ring.appendChild(chip);
  const pips = document.createElement('span');
  pips.className = 'hud-pips';
  pips.setAttribute('aria-hidden', 'true');
  ring.appendChild(pips);
  setRingPosition(ring, position);
  return ring;
}

/** Point a ring (and its seat container) at a game position. */
export function setRingPosition(ring, position) {
  if (!ring) return;
  if (position) {
    ring.dataset.position = String(position);
    ring.dataset.team = teamLetter(position);
  } else {
    delete ring.dataset.position;
    delete ring.dataset.team;
  }
}

/**
 * What one seat's pips show:
 * - its own bid as slots and its own tricks won (past the bid: is-over);
 * - a bore seat: the whole hand as slots and the TEAM's tricks (a bore is
 *   the team's bet to win every trick, so either partner's trick counts);
 * - a seat whose own count is not known (GameState tricksByPosition null:
 *   a v1 snapshot that only counted the team's tricks): the team's tricks
 *   out of the team's total, as before per-player pips.
 * @returns {{need: number, won: number, title: string}}
 */
function seatPips(s, pos, me) {
  const bids = s.bids || {};
  const teamWon = pos % 2 === me % 2 ? (s.teamTricks || 0) : (s.oppTricks || 0);
  if (isBore(bids[pos])) {
    const need = bidTricks(bids[pos], s.currentHand);
    return { need, won: teamWon, title: `Team ${teamWon} of ${need} (bore)` };
  }
  const own = s.tricksByPosition?.[pos];
  if (typeof own === 'number') {
    const need = bidTricks(bids[pos], s.currentHand) ?? 0;
    return { need, won: own, title: `${own} of ${need}` };
  }
  const need = teamBidTotal(bids[pos], bids[team(pos)], s.currentHand);
  return { need, won: teamWon, title: `Team ${teamWon} of ${need}` };
}

/**
 * Project the table's bids and tricks onto every ring under `root`.
 * @param {ParentNode} root - the HUD (or the document)
 * @param {Object} s - GameState (bids by position, isBidding, position,
 *   currentHand, tricksByPosition, teamTricks, oppTricks)
 */
export function updateSeatPlates(root, s) {
  if (!root || !s) return;
  const me = s.position || 1;
  const bids = s.bids || {};
  for (const ring of root.querySelectorAll('.hud-avatar-ring[data-position]')) {
    const pos = Number(ring.dataset.position);
    // the chip: this seat's bid, once placed
    const chip = ring.querySelector(':scope > .hud-bid-chip');
    const bid = bids[pos];
    const label = bid === undefined || bid === null ? '' : String(bid).toUpperCase();
    if (chip) {
      chip.dataset.bid = label;
      chip.classList.toggle('is-bore', isBore(label));
    }
    // the pips: the seat's own tricks out of its own bid, after the bidding
    const pips = ring.querySelector(':scope > .hud-pips');
    if (!pips) continue;
    const placed = bidTricks(bids[pos], s.currentHand) !== null && bidTricks(bids[team(pos)], s.currentHand) !== null;
    const { need, won, title } = seatPips(s, pos, me);
    const show = !s.isBidding && placed && need + won > 0;
    const n = show ? Math.min(MAX_PIPS, Math.max(need, won)) : 0;
    pips.dataset.team = teamLetter(pos);
    pips.classList.toggle('is-bore', show && isBore(bid));
    if (pips.childElementCount !== n) {
      pips.replaceChildren(...Array.from({ length: n }, () => {
        const pip = document.createElement('i');
        pip.className = 'hud-pip';
        return pip;
      }));
    }
    [...pips.children].forEach((pip, i) => {
      pip.classList.toggle('is-won', i < won && i < need);
      pip.classList.toggle('is-over', i < won && i >= need);
    });
    pips.title = show ? title : '';
  }
}
