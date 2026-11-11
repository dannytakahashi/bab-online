/**
 * Bids as trick counts (mirrors the server): the ONE place the web client
 * turns a bid into a number of tricks.
 *
 * A bore (B / 2B / 3B / 4B) is the team's bet to win every trick, so it
 * counts as the whole hand; a team's total is capped at the hand size
 * (server/game/rules.js BID_RANKS: "bores count as 13 and are capped at the
 * hand size"; gameHandlers.js caps game.bids.team1/team2 at currentHand).
 * Used by the seat pips (ui/seatPlates.js), the trick piles' safe / danger
 * border (TrickManager.setBidTotals, from main.js doneBidding and
 * GameScene.render) and the bid chips rows (BidManager, GameLog).
 */

export const BORES = Object.freeze(['B', '2B', '3B', '4B']);
/** The largest hand (the last deal). */
export const MAX_HAND_SIZE = 13;

const norm = (bid) => (bid === undefined || bid === null || bid === '' ? null : String(bid).toUpperCase());

/** The deal's hand size, or 13 when it is not known. */
const handOf = (handSize) => (Number.isInteger(handSize) && handSize > 0 ? Math.min(handSize, MAX_HAND_SIZE) : MAX_HAND_SIZE);

/** Whether a bid is a bore (B, 2B, 3B, 4B). */
export function isBore(bid) {
  const b = norm(bid);
  return b !== null && BORES.includes(b);
}

/**
 * The tricks one bid counts for: its number, the hand size for a bore, null
 * when it is not placed (or not a bid).
 * @param {string|number|null|undefined} bid
 * @param {number} [handSize]
 * @returns {number|null}
 */
export function bidTricks(bid, handSize) {
  const b = norm(bid);
  if (b === null) return null;
  if (BORES.includes(b)) return handOf(handSize);
  if (!/^\d+$/.test(b)) return null;
  return Math.min(Number(b), handOf(handSize));
}

/**
 * A team's bid total: min(hand size, the two bids' tricks), a bore counting
 * as the whole hand; a bid not placed yet counts 0.
 * @param {*} bidA
 * @param {*} bidB
 * @param {number} [handSize]
 * @returns {number}
 */
export function teamBidTotal(bidA, bidB, handSize) {
  return Math.min(handOf(handSize), (bidTricks(bidA, handSize) ?? 0) + (bidTricks(bidB, handSize) ?? 0));
}

/**
 * Both teams' totals from a viewer's seat: {team, opp}.
 * @param {Object|Array} bids - by position ({1: '3', ...}), or doneBidding's array (index = position - 1)
 * @param {number} position - the viewer's seat (a spectator views from 1)
 * @param {number} [handSize]
 */
export function bidTotalsFor(bids, position, handSize) {
  const at = (p) => (Array.isArray(bids) ? bids[p - 1] : bids?.[p]);
  const team1 = teamBidTotal(at(1), at(3), handSize);
  const team2 = teamBidTotal(at(2), at(4), handSize);
  const mineIsOne = (position || 1) % 2 === 1;
  return mineIsOne ? { team: team1, opp: team2 } : { team: team2, opp: team1 };
}
