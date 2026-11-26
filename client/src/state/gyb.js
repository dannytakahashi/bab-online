/**
 * Get Your Bid (owner 2026-11-24; server/game/gameMode.js): the words and
 * projections the web table needs for a three-seat, no-teams game. Pure:
 * imports only the position helpers, reads the state it is given.
 *
 * The rules themselves are the server's (rules.js gybHandScore: exactly the
 * bid scores 10 + the bid, an exact 0 scores 5, anything else nothing, 1
 * point for the last bidder who takes exactly their Forbidden Bid); the
 * page shows what handComplete.gyb / gameEnd.gyb say and computes no score.
 *
 * Names (owner rule 2026-11-25, people by player names): every line, row
 * and tally here names a seat by its owner (teamPlayerDataOf: a lazy or
 * resigned seat's owner, never the bot playing it), as the server's stored
 * hand and game-over lines do (gameHandlers.seatName), so a reload or a
 * spectator replaying the log reads the same names as the live table.
 */

import { seatsAround, seatLetter } from '../utils/positions.js';
import { teamPlayerDataOf } from './teamPlayerData.js';

export const GYB_MODE = 'gyb';
export const GYB_SEATS = 3;
/** The mode's name, as every screen shows it. */
export const GYB_NAME = 'Get Your Bid';
/** One line for the lobby and the create dialog. */
export const GYB_BLURB = '3 players, no teams. Score only by taking exactly what you bid.';
/** clientHello cap: this client can show a Get Your Bid lobby and table. */
export const GYB_CAP = 'getYourBid';

/** A seat's username in playerData ({position[], username[]}), else P<seat>. */
export function soloName(playerData, pos) {
  const i = Array.isArray(playerData?.position) ? playerData.position.indexOf(pos) : -1;
  const entry = i === -1 ? null : playerData.username?.[i];
  const name = typeof entry === 'string' ? entry : entry?.username;
  return typeof name === 'string' && name ? name : `P${pos}`;
}

/**
 * The three seats in the order the page lists them: the viewer's own first,
 * then the next in turn and the one after (a pure spectator views from
 * seat 1: 1, 2, 3).
 * @param {number|null} me - the viewer's seat
 * @returns {number[]}
 */
export function soloOrder(me) {
  const mine = [1, 2, 3].includes(Number(me)) ? Number(me) : 1;
  const { opp1, opp2 } = seatsAround(mine, GYB_SEATS);
  return [mine, opp1, opp2];
}

/**
 * The game log's score header at a Get Your Bid table: one row per seat
 * (soloOrder), each its name (the seat's owner), score, bid ('-' until placed) and tricks.
 * @param {Object} state - GameState
 * @param {Object} [opts]
 * @param {boolean} [opts.spectator] - the viewer has no seat (seat 1 first, no row is "mine")
 * @returns {Array<{position, name, score, bid, tricks, letter, mine}>}
 */
export function soloHeaderRows(state, { spectator = false } = {}) {
  const me = spectator ? 1 : (state.position || 1);
  const known = Array.isArray(state.playerData?.position);
  const names = known ? teamPlayerDataOf(state) : null;
  return soloOrder(me).map((pos) => ({
    position: pos,
    name: known ? soloName(names, pos) : '',
    score: state.gyb?.scores?.[pos - 1] ?? 0,
    bid: state.bids?.[pos] ?? '-',
    tricks: state.tricksByPosition?.[pos] ?? 0,
    letter: seatLetter(pos, GYB_SEATS),
    mine: !spectator && pos === me,
  }));
}

/**
 * A finished hand's log lines (the server's own wording, so a replayed
 * snapshot log reads the same): one per seat, seats 1 to 3.
 * @param {Object} hand - handComplete.gyb {scores, seats: [{position, bid, took, points, forbiddenHit}]}
 * @param {Object} playerData - teamPlayerDataOf(state): the seats by their owners
 * @returns {string[]}
 */
export function formatSoloHandMessages(hand, playerData) {
  const seats = Array.isArray(hand?.seats) ? [...hand.seats].sort((a, b) => a.position - b.position) : [];
  return [
    '--- HAND COMPLETE ---',
    ...seats.map((s) => `${soloName(playerData, s.position)}: Bid ${s.bid}, Won ${s.took}${s.forbiddenHit ? ' (Forbidden Bid)' : ''}, +${s.points} → ${hand.scores?.[s.position - 1] ?? 0}`),
  ];
}

/** "ann", "ann and bob", "ann, bob and cat". */
function listNames(names) {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * How a Get Your Bid game ended for the viewer.
 * @param {Object} end - gameEnd.gyb {scores, winners}
 * @param {number|null} me - the viewer's seat (null: a spectator)
 * @returns {'victory'|'defeat'|'tie'|'neutral'} tie: the viewer shares the win
 */
export function soloOutcome(end, me) {
  const winners = Array.isArray(end?.winners) ? end.winners : [];
  if (!me) return 'neutral';
  if (!winners.includes(me)) return 'defeat';
  return winners.length > 1 ? 'tie' : 'victory';
}

/** The result in words: "ann wins!", "ann and bob tie!". */
export function soloWinnerLine(end, playerData) {
  const winners = Array.isArray(end?.winners) ? end.winners : [];
  if (!winners.length) return '';
  const names = winners.map((p) => soloName(playerData, p));
  return winners.length > 1 ? `${listNames(names)} tie!` : `${names[0]} wins!`;
}

/**
 * The game-over log lines: each seat's final score (seats 1 to 3, the
 * server's lines), then the result (VICTORY / DEFEAT / TIE GAME for a seat,
 * the winner by name for a spectator).
 * @param {Object} end - gameEnd.gyb
 * @param {Object} playerData
 * @param {Object} [opts]
 * @param {number|null} [opts.myPosition]
 * @param {boolean} [opts.isSpectator]
 * @returns {string[]}
 */
export function formatSoloGameEndMessages(end, playerData, { myPosition = null, isSpectator = false } = {}) {
  const scores = Array.isArray(end?.scores) ? end.scores : [];
  const lines = ['=== GAME OVER ===', ...scores.map((s, i) => `${soloName(playerData, i + 1)}: ${s}`)];
  const outcome = soloOutcome(end, isSpectator ? null : myPosition);
  const word = { victory: 'VICTORY', defeat: 'DEFEAT', tie: 'TIE GAME' }[outcome];
  const said = word ? [word] : [];
  // the winner by name where "VICTORY" alone would not say it
  const by = soloWinnerLine(end, playerData);
  if (by && outcome !== 'victory') said.push(by);
  return [...lines, ...said];
}

/**
 * The score modal's rows, best score first (ties in seat order).
 * @returns {Array<{position, name, score, made, hands, winner, mine, letter}>}
 */
export function soloResultRows(end, playerData, { myPosition = null } = {}) {
  const scores = Array.isArray(end?.scores) ? end.scores : [];
  const winners = Array.isArray(end?.winners) ? end.winners : [];
  return scores
    .map((score, i) => ({
      position: i + 1,
      name: soloName(playerData, i + 1),
      score,
      made: end?.made?.[i] ?? 0,
      hands: end?.hands ?? 0,
      winner: winners.includes(i + 1),
      mine: myPosition === i + 1,
      letter: seatLetter(i + 1, GYB_SEATS),
    }))
    .sort((a, b) => b.score - a.score || a.position - b.position);
}

/** The announcer's tally: "Tricks: ann 2, bob 1, cat 0." (viewer first). */
export function soloTally(label, state, valuesByPosition, { spectator = false } = {}) {
  if (!Array.isArray(state.playerData?.position)) return '';
  const order = soloOrder(spectator ? 1 : state.position);
  const names = teamPlayerDataOf(state);
  return `${label} ${order.map((p) => `${soloName(names, p)} ${valuesByPosition[p] ?? 0}`).join(', ')}.`;
}
