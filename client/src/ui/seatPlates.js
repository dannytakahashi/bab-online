/**
 * Seat plates (item 18a, ui-d3): each seat's avatar sits in a ring with its
 * team's color (team A = seats 1 and 3, blue; team B = seats 2 and 4, coral),
 * a bid chip (the seat's bid) and trick pips (the team's tricks won out of
 * its bid). The chip's text comes from data-bid through CSS and the pips are
 * empty elements, so a seat's text stays its name (the plate).
 *
 * The look is table.css (.hud-avatar-ring, .hud-bid-chip, .hud-pips).
 * updateSeatPlates is a projection of GameState: every call redraws all of
 * it, so nothing can go stale.
 */
import { team } from '../utils/positions.js';

const BORES = ['B', '2B', '3B', '4B'];
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

const numeric = (b) => {
  if (b === undefined || b === null) return null;
  const s = String(b).toUpperCase();
  if (BORES.includes(s)) return 0;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
};

/**
 * Project the table's bids and tricks onto every ring under `root`.
 * @param {ParentNode} root - the HUD (or the document)
 * @param {Object} s - GameState (bids by position, isBidding, position, teamTricks, oppTricks)
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
      chip.classList.toggle('is-bore', BORES.includes(label));
    }
    // the pips: the team's tricks won out of its bid, after the bidding
    const pips = ring.querySelector(':scope > .hud-pips');
    if (!pips) continue;
    const need = (numeric(bids[pos]) ?? 0) + (numeric(bids[team(pos)]) ?? 0);
    const won = pos % 2 === me % 2 ? (s.teamTricks || 0) : (s.oppTricks || 0);
    const placed = numeric(bids[pos]) !== null && numeric(bids[team(pos)]) !== null;
    const show = !s.isBidding && placed && need + won > 0;
    const n = show ? Math.min(MAX_PIPS, Math.max(need, won)) : 0;
    pips.dataset.team = teamLetter(pos);
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
    pips.title = show ? `${won} of ${need}` : '';
  }
}
