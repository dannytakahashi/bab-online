/**
 * Fault lines (owner 2026-11-19): who left a set team short this hand.
 *
 * The rule is the server's setsCaused stat (server/socket/gameHandlers.js
 * handleHandComplete, "Track set responsibility per player"): a team is SET
 * when it took fewer tricks than its combined bid (the team total, a bore
 * counting as the whole hand, capped at the hand size: rules/bids.js
 * teamBidTotal = the server's game.bids.teamN), and on a set team each player
 * who took fewer tricks than they personally bid is at fault, a bore counting
 * as 0 for that player (the server's getBidValue). A team that made its bid
 * has no faults. An all-zero redeal never gets here (no handComplete; every
 * bid 0 can never be set).
 *
 * Per-player tricks are not in handComplete (team counts only): they are
 * GameState.tricksByPosition, counted from each trickComplete's winner and
 * taken from a snapshot's tricksByPosition on a rejoin or resync. A team whose
 * two seats are not known (null) or do not add up to its trick count is left
 * out: no line rather than a wrong name.
 */

import { teamBidTotal } from './bids.js';

const TEAM_SEATS = Object.freeze({ team1: [1, 3], team2: [2, 4] });

/** A player's own bid as the tricks it blames them for: a bore 0, else its number (server getBidValue). */
export function personalBid(bid) {
  if (bid === undefined || bid === null) return 0;
  const s = String(bid).toUpperCase();
  return s.includes('B') ? 0 : parseInt(s, 10) || 0;
}

const at = (byPos, p) => (Array.isArray(byPos) ? byPos[p - 1] : byPos?.[p]);

/**
 * The hand's faults, in `order` (the viewer's log order: the hand lines'
 * me, partner, opp1, opp2; a spectator's seats from 1).
 *
 * @param {Object} hand
 * @param {Object|Array} hand.bids - by position ({1: '3', ...}) or an array (index = position - 1)
 * @param {Object|Array|null} hand.tricksByPosition - tricks each seat won this hand (null entries: not known)
 * @param {number} [hand.team1Tricks] - handComplete's count (else the seats' sum)
 * @param {number} [hand.team2Tricks]
 * @param {number} hand.handSize - the deal's size
 * @param {number[]} [hand.order] - seat order of the result
 * @returns {{position: number, bid: number, took: number}[]}
 */
export function handFaults({ bids, tricksByPosition, team1Tricks, team2Tricks, handSize, order = [1, 3, 2, 4] } = {}) {
  if (!bids || !tricksByPosition) return [];
  const faulted = new Map();
  for (const [teamKey, seats] of Object.entries(TEAM_SEATS)) {
    const took = seats.map((p) => at(tricksByPosition, p));
    if (!took.every((n) => Number.isInteger(n) && n >= 0)) continue;
    const reported = teamKey === 'team1' ? team1Tricks : team2Tricks;
    const teamTook = took[0] + took[1];
    // the seats must agree with the team's count (a missed trick: no blame)
    if (Number.isInteger(reported) && reported !== teamTook) continue;
    const teamBid = teamBidTotal(at(bids, seats[0]), at(bids, seats[1]), handSize);
    if (teamTook >= teamBid) continue; // made
    seats.forEach((p, i) => {
      const bid = personalBid(at(bids, p));
      if (bid > took[i]) faulted.set(p, { position: p, bid, took: took[i] });
    });
  }
  return order.filter((p) => faulted.has(p)).map((p) => faulted.get(p));
}
