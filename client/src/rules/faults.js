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
  // the deal's size unknown (0 before any deal is seen): every trick of the
  // hand is won by someone, so the two counts add up to it (else a bore
  // would count as 13 and look set on a smaller hand)
  const size = Number.isSafeInteger(handSize) && handSize > 0 ? handSize
    : (Number.isSafeInteger(team1Tricks) && Number.isSafeInteger(team2Tricks) ? team1Tricks + team2Tricks : handSize);
  const faulted = new Map();
  for (const [teamKey, seats] of Object.entries(TEAM_SEATS)) {
    const took = seats.map((p) => at(tricksByPosition, p));
    if (!took.every((n) => Number.isInteger(n) && n >= 0)) continue;
    const reported = teamKey === 'team1' ? team1Tricks : team2Tricks;
    const teamTook = took[0] + took[1];
    // the seats must agree with the team's count (a missed trick: no blame)
    if (Number.isInteger(reported) && reported !== teamTook) continue;
    const teamBid = teamBidTotal(at(bids, seats[0]), at(bids, seats[1]), size);
    if (teamTook >= teamBid) continue; // made
    seats.forEach((p, i) => {
      const bid = personalBid(at(bids, p));
      if (bid > took[i]) faulted.set(p, { position: p, bid, took: took[i] });
    });
  }
  return order.filter((p) => faulted.has(p)).map((p) => faulted.get(p));
}

// ------------------------------------------------- kept through a log replay

/** The server log's hand block starts with this line, then its two team lines (gameHandlers handleHandComplete). */
export const HAND_COMPLETE_LINE = '--- HAND COMPLETE ---';

// This page's fault rows of one game, by hand ({team1, team2} totals after
// it, as the server's team lines end "→ <total>"): a replay of the server's
// log (rejoinSuccess, restorePlayerState incl. /active) puts them back after
// their hand's lines. A reload or a fresh spectate starts with none.
let memory = { gameId: null, hands: [] };

/** A fault row was written after the hand whose totals are `score` ({team1, team2}). */
export function rememberFault(gameId, score, line) {
  if (!line || !score || !Number.isFinite(score.team1) || !Number.isFinite(score.team2)) return;
  if ((gameId || null) !== memory.gameId) memory = { gameId: gameId || null, hands: [] };
  const last = memory.hands[memory.hands.length - 1];
  if (last && last.team1 === score.team1 && last.team2 === score.team2) last.lines.push(line);
  else memory.hands.push({ team1: score.team1, team2: score.team2, lines: [line] });
}

/** The remembered hands of `gameId` (oldest first), or []. */
export function rememberedFaults(gameId) {
  return (gameId || null) === memory.gameId ? memory.hands : [];
}

/** Forget them (tests). */
export function forgetFaults() {
  memory = { gameId: null, hands: [] };
}

/**
 * The replayed log with this page's fault rows put back: after each
 * HAND_COMPLETE_LINE whose two team lines end with a remembered hand's
 * totals (in order; a hand cut from the replay is skipped), its rows as
 * {message, position: null, at (the hand line's), fault: true}.
 * @param {Array<{message: string}>} entries
 * @param {Array<{team1: number, team2: number, lines: string[]}>} hands
 */
export function withFaultRows(entries, hands) {
  if (!Array.isArray(entries) || !hands?.length) return entries;
  const out = [];
  let next = 0;
  for (let i = 0; i < entries.length; i++) {
    out.push(entries[i]);
    if (entries[i]?.message !== HAND_COMPLETE_LINE || next >= hands.length) continue;
    const a = entries[i + 1]?.message;
    const b = entries[i + 2]?.message;
    if (typeof a !== 'string' || typeof b !== 'string') continue;
    const j = hands.findIndex((h, k) => k >= next && a.endsWith(`→ ${h.team1}`) && b.endsWith(`→ ${h.team2}`));
    if (j === -1) continue;
    out.push(entries[i + 1], entries[i + 2]);
    i += 2;
    // stamped with their hand's time (the team line's), not the replay's
    const at = entries[i]?.at ?? entries[i - 2]?.at ?? null;
    for (const line of hands[j].lines) out.push({ message: line, position: null, at, fault: true });
    next = j + 1;
  }
  return out;
}
