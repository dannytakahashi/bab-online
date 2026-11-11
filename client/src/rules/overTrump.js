/**
 * The over-trump ("OT") effect's rule (owner 2026-11-11). The card just
 * played over-trumps when:
 *
 *   - it is a trump or a joker,
 *   - the trick's LEAD is not trump (a joker lead counts as trump),
 *   - before it, the trick was won by an OPPONENT of its player (team A is
 *     seats 1 and 3, team B seats 2 and 4) with a trump or a joker,
 *   - and it now wins the trick.
 *
 * Beating a partner's trump, beating an under-trump while the partner's
 * trump still wins, or playing a higher trump on a trump lead is not an
 * over-trump. The winner is the server's (server/game/rules.js
 * determineWinner), so jokers (HI > LO > A) and the no-trump hand (a
 * flipped joker: only the jokers are trump) follow the rules' comparison.
 * The iOS mirror is TrickRules.isOverTrump (TableTypes.swift).
 */

import { RANK_VALUES, JOKER_SUIT } from '../constants/ranks.js';

/** A trump-suit card or a joker. */
export function isTrumpCard(card, trump) {
  return !!card && !!trump && (card.suit === JOKER_SUIT || card.suit === trump.suit);
}

/**
 * Index (in play order) of the card winning a partial or full trick, the
 * server's determineWinner over the cards played so far.
 * @param {Array<{card, position}>} trick - play order, the lead first
 * @param {Object} trump - the trump card
 * @returns {number} index into `trick`, -1 when empty
 */
export function trickWinnerIndex(trick, trump) {
  if (!Array.isArray(trick) || trick.length === 0 || !trump) return -1;
  const suitOf = (c) => (c.suit === JOKER_SUIT ? trump.suit : c.suit);
  const leadSuit = suitOf(trick[0].card);
  let winner = 0;
  for (let i = 1; i < trick.length; i++) {
    const current = trick[i].card;
    const winning = trick[winner].card;
    const currentIsTrump = isTrumpCard(current, trump);
    const winningIsTrump = isTrumpCard(winning, trump);
    if (currentIsTrump && !winningIsTrump) {
      winner = i;
    } else if (currentIsTrump && winningIsTrump) {
      if (RANK_VALUES[current.rank] > RANK_VALUES[winning.rank]) winner = i;
    } else if (suitOf(current) === leadSuit && suitOf(winning) === leadSuit) {
      if (RANK_VALUES[current.rank] > RANK_VALUES[winning.rank]) winner = i;
    }
  }
  return winner;
}

/**
 * Is the LAST card of `trick` an over-trump?
 * @param {Array<{card, position}>} trick - play order, the lead first
 * @param {Object} trump - the trump card
 * @returns {boolean}
 */
export function isOverTrump(trick, trump) {
  if (!Array.isArray(trick) || trick.length < 3 || !trump) return false;
  if (isTrumpCard(trick[0].card, trump)) return false;
  const last = trick[trick.length - 1];
  if (!isTrumpCard(last.card, trump)) return false;
  const before = trick[trickWinnerIndex(trick.slice(0, -1), trump)];
  if (!isTrumpCard(before.card, trump)) return false;
  if (before.position % 2 === last.position % 2) return false;
  return trickWinnerIndex(trick, trump) === trick.length - 1;
}
