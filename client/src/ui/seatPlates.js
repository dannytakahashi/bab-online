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
 *
 * The over-the-shoulder view (2026-11-21, state/shoulder.js): a seat whose
 * hand someone watches carries an eye chip on the ring's top left
 * (.hud-watch-chip, with the count past one; its title and label "Zach is
 * watching Alice's hand"), for players and spectators alike, from the
 * spectator entries' `shoulder` (GameState.watching). A watcher sees the eye
 * on the seat they watch only while someone else watches it too
 * (shoulder.js seatEyeNames).
 *
 * The avatar badges (owner 2026-11-23; rules in state/seatBadges.js): the
 * gold lightbulb while a seat asked for /help on its open turn, the
 * graduation cap in the Tutorial button's on green while its owner's
 * tutorial is on; one small dark round chip (.hud-seat-badge, data-badge
 * help | tutorial) in the ring's top left corner, the eye's corner
 * (.hud-ring-corner holds both, the eye first: a watched seat's badge sits
 * just right of its eye), never on the viewer's own seat. Its title and
 * label are the seat's name and what it shows ("ann, asked for help this
 * turn"). updateSeatBadges draws them (updateSeatPlates too); `pop` names
 * the seats whose badge just came from a live event: one short pop
 * (a fade under reduced motion), never for a snapshot.
 */
import { team } from '../utils/positions.js';
import { isBore, bidTricks, teamBidTotal } from '../rules/bids.js';
import { watchersBySeat, watchTitle, seatEyeNames } from '../state/shoulder.js';
import { EYE_ICON } from './components/SpectatorBadge.js';
import { lightbulbIcon } from './components/AssistCard.js';
import { CAP_ICON } from './components/TutorialButton.js';
import { seatBadgeOf, seatBadgeLabel } from '../state/seatBadges.js';
import { prefersReducedMotion } from './motion.js';

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
  // the top left corner: the eye, then the seat's badge
  const corner = document.createElement('span');
  corner.className = 'hud-ring-corner';
  const eye = document.createElement('span');
  eye.className = 'hud-watch-chip';
  eye.innerHTML = EYE_ICON;
  eye.appendChild(document.createElement('b'));
  corner.appendChild(eye);
  const badge = document.createElement('span');
  badge.className = 'hud-seat-badge';
  badge.appendChild(lightbulbIcon('hud-seat-badge__bulb'));
  badge.insertAdjacentHTML('beforeend', CAP_ICON); // a fixed icon, never user text
  badge.lastElementChild.setAttribute('class', 'hud-seat-badge__cap');
  corner.appendChild(badge);
  ring.appendChild(corner);
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

/** One ring's eye chip: who watches this seat's hand (none: hidden). */
function updateWatchChip(ring, names, s, pos) {
  const eye = ring.querySelector(':scope > .hud-ring-corner > .hud-watch-chip');
  if (!eye) return;
  const on = names.length > 0;
  eye.classList.toggle('is-on', on);
  const count = eye.querySelector('b');
  if (count) count.textContent = names.length > 1 ? String(names.length) : '';
  if (!on) {
    eye.removeAttribute('title');
    eye.removeAttribute('aria-label');
    eye.removeAttribute('role');
    return;
  }
  const player = s.getPlayerNameByPosition ? s.getPlayerNameByPosition(pos) : `P${pos}`;
  const text = watchTitle(names, player, { me: s.username || null, mine: !s.isSpectator && pos === s.position });
  eye.title = text;
  eye.setAttribute('role', 'img');
  eye.setAttribute('aria-label', text);
}

/**
 * The badge's pop, in ms (owner spec: "~250 ms"; between MOTION.base 200
 * and MOTION.slow 350, no token of its own): the scale pop, or the fade
 * under reduced motion.
 */
export const SEAT_BADGE_POP_MS = 250;

// The pop: up a little and settle (reduced motion: a fade, no scale)
const POP = [
  { transform: 'scale(0.6)', opacity: 0 },
  { transform: 'scale(1.18)', opacity: 1, offset: 0.6 },
  { transform: 'scale(1)', opacity: 1 },
];
const FADE = [{ opacity: 0 }, { opacity: 1 }];

/** One short pop of a badge that just came (a live event; never a snapshot). */
function popBadge(badge) {
  if (typeof badge.animate !== 'function') return;
  const reduced = prefersReducedMotion();
  badge.getAnimations?.().forEach((a) => a.cancel());
  badge.animate(reduced ? FADE : POP, { duration: SEAT_BADGE_POP_MS, easing: 'ease-out' });
}

/**
 * Every ring's badge (state/seatBadges.js): the lightbulb, the cap or none.
 * @param {ParentNode} root - the HUD (or the document)
 * @param {Object} s - GameState (helpAsked, tutorialSeats, isSpectator, position)
 * @param {Object} [o]
 * @param {number[]} [o.pop] - seats whose badge a live event just set: one pop
 */
export function updateSeatBadges(root, s, { pop = [] } = {}) {
  if (!root || !s) return;
  for (const ring of root.querySelectorAll('.hud-avatar-ring[data-position]')) {
    const badge = ring.querySelector(':scope > .hud-ring-corner > .hud-seat-badge');
    if (!badge) continue;
    const pos = Number(ring.dataset.position);
    const kind = seatBadgeOf(s, pos);
    const was = badge.dataset.badge || '';
    if (!kind) {
      if (was) {
        delete badge.dataset.badge;
        badge.removeAttribute('title');
        badge.removeAttribute('aria-label');
        badge.removeAttribute('role');
      }
      continue;
    }
    const name = s.getPlayerNameByPosition ? s.getPlayerNameByPosition(pos) : `P${pos}`;
    const text = seatBadgeLabel(kind, name);
    badge.dataset.badge = kind;
    if (badge.title !== text) badge.title = text;
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', text);
    if (pop.includes(pos)) popBadge(badge);
  }
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
  const watched = watchersBySeat(s.watching);
  for (const ring of root.querySelectorAll('.hud-avatar-ring[data-position]')) {
    const pos = Number(ring.dataset.position);
    updateWatchChip(ring, seatEyeNames(s, pos, watched[pos]), s, pos);
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
  updateSeatBadges(root, s);
}
