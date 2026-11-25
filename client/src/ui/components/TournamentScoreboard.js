/**
 * Tournament Scoreboard Component
 *
 * Reusable scoreboard table (the lobby's, and the final results card's:
 * FinalResultsCard.js, which replaced the results modal with Cut for a buck).
 */
import { el } from '../kit/index.js';

/**
 * Create a tournament scoreboard table element.
 *
 * @param {Array} scoreboard - Sorted array of { username, totalScore, roundScores }
 * @param {number} currentRound - Current round number (0 before round 1)
 * @param {number} totalRounds - Total rounds (1 to 5, the host's pick; default 4)
 * @returns {HTMLElement} Scoreboard container div
 */
export function createTournamentScoreboard(scoreboard, currentRound, totalRounds) {
  // Its look is table.css (.tournament-scoreboard, .tsb-*): tokens, tabular numerals
  const container = el('div', { className: 'tournament-scoreboard' });

  if (!scoreboard || scoreboard.length === 0) {
    container.appendChild(el('div', { className: 'tsb-empty', text: 'No scores yet' }));
    return container;
  }

  const table = el('table', { className: 'tsb-table' });

  // Header
  const thead = el('thead');
  const headerRow = el('tr');
  const headers = ['#', 'Player'];
  for (let r = 1; r <= totalRounds; r++) headers.push(`R${r}`);
  headers.push('Total');
  headers.forEach((text, i) => headerRow.appendChild(el('th', { className: i <= 1 ? 'is-left' : '', text })));
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = el('tbody');
  scoreboard.forEach((entry, index) => {
    const leader = index === 0 && currentRound > 0 ? ' is-leader' : '';
    const row = el('tr');
    row.appendChild(el('td', { className: `is-left tsb-rank${leader}`, text: index + 1 }));
    row.appendChild(el('td', { className: `is-left tsb-name${leader}`, attrs: { title: entry.username }, children: [el('span', { className: 'tsb-name__text', text: entry.username })] }));
    for (let r = 0; r < totalRounds; r++) {
      const has = entry.roundScores && typeof entry.roundScores[r] === 'number';
      row.appendChild(el('td', { className: has ? '' : 'tsb-none', text: has ? entry.roundScores[r] : '-' }));
    }
    row.appendChild(el('td', { className: 'tsb-total', text: entry.totalScore }));
    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  container.appendChild(table);
  return container;
}

/**
 * The rounds a final scoreboard covers: every member has a score for every
 * round played (TournamentState.scoreMissedRound), so the longest
 * roundScores; 4 when there is nothing to read.
 */
export function roundsOfScoreboard(scoreboard) {
  const most = Math.max(0, ...(scoreboard || []).map((e) => (Array.isArray(e?.roundScores) ? e.roundScores.length : 0)));
  return most > 0 ? most : 4;
}
