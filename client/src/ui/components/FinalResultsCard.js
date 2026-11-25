/**
 * A finished tournament's results (Cut for a buck, 2026-11-25; spec section
 * 6 "Final lobby"): the tournament lobby's inline card in the complete
 * phase, in place of the old results modal. The score winner(s) ("kim wins
 * the tournament!"), the Cut for a buck winner when a cut ran ("dan won Cut
 * for a buck"), the players with their chips ("Winner", "Won the cut") and
 * the final scoreboard (R1..RN).
 */
import { el, createChip } from '../kit/index.js';
import { createTournamentScoreboard, roundsOfScoreboard } from './TournamentScoreboard.js';
import { tournamentWinnerLine, cutWonLine } from '../../state/cutForABuck.js';

const BUCK = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M12 5.5v13M15.2 8.4c-.6-.9-1.8-1.4-3.2-1.4-1.9 0-3.2 1-3.2 2.4 0 3.4 6.6 1.8 6.6 5.1 0 1.5-1.4 2.5-3.4 2.5-1.6 0-2.9-.6-3.5-1.6" fill="none" stroke="var(--surface-0)" stroke-width="1.9" stroke-linecap="round"/></svg>';

/**
 * The winners when the server sent none: the top total (as the server's
 * getWinners, a same-session fallback only).
 */
export function winnersOf(scoreboard, winners) {
  if (Array.isArray(winners) && winners.length) return winners;
  const rows = Array.isArray(scoreboard) ? scoreboard : [];
  if (!rows.length) return [];
  const top = Math.max(...rows.map((r) => r.totalScore));
  return rows.filter((r) => r.totalScore === top).map((r) => r.username);
}

/**
 * @param {Object} o
 * @param {Array} o.scoreboard - the final sorted scoreboard
 * @param {string[]} [o.winners] - tournamentComplete / the complete state's winners
 * @param {Object|null} [o.cut] - {winner, participants, rounds} when a cut ran
 * @param {number} [o.totalRounds]
 * @param {string} [o.me]
 * @returns {HTMLElement}
 */
export function createFinalResultsCard({ scoreboard = [], winners = [], cut = null, totalRounds = null, me = null } = {}) {
  const w = winnersOf(scoreboard, winners);
  const card = el('section', { className: 'final-results kit-panel kit-elev-2', attrs: { id: 'tournamentFinalResults', 'aria-label': 'Final results' } });
  card.appendChild(el('h2', { className: 'final-results__title', attrs: { id: 'tournamentFinalTitle' }, text: tournamentWinnerLine(w, me) }));
  if (cut?.winner) {
    const line = el('p', { className: 'final-results__cut', attrs: { id: 'tournamentFinalCut' } });
    const glyph = el('span', { className: 'final-results__buck', attrs: { 'aria-hidden': 'true' } });
    glyph.innerHTML = BUCK;
    line.append(glyph, document.createTextNode(cutWonLine(cut, me)));
    card.appendChild(line);
  }

  // the players by final standing, with their chips
  const players = el('ul', { className: 'final-results__players', attrs: { 'aria-label': 'Players' } });
  for (const row of scoreboard || []) {
    const chips = [];
    if (w.includes(row.username)) chips.push(createChip({ label: 'Winner', tone: 'gold' }));
    if (cut?.winner === row.username) chips.push(createChip({ label: 'Won the cut', tone: 'success' }));
    players.appendChild(el('li', {
      className: `final-results__player${row.username === me ? ' is-me' : ''}`,
      dataset: { username: row.username },
      children: [el('span', { className: 'final-results__name', text: row.username === me ? `${row.username} (you)` : row.username }), ...chips],
    }));
  }
  card.appendChild(players);

  const rounds = Number.isInteger(totalRounds) && totalRounds > 0 ? totalRounds : roundsOfScoreboard(scoreboard);
  const board = el('div', { className: 'tournament-scoreboard-wrap final-results__board' });
  board.appendChild(createTournamentScoreboard(scoreboard, rounds, rounds));
  card.appendChild(board);
  return card;
}
