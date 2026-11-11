/**
 * Tournament Scoreboard Component
 *
 * Reusable scoreboard table and final results overlay.
 */
import { el, createButton, openModal } from '../kit/index.js';

/**
 * Create a tournament scoreboard table element.
 *
 * @param {Array} scoreboard - Sorted array of { username, totalScore, roundScores }
 * @param {number} currentRound - Current round number (1-4)
 * @param {number} totalRounds - Total rounds (4)
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
    row.appendChild(el('td', { className: `is-left tsb-name${leader}`, text: entry.username }));
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

/** The results modal on screen. */
let resultsModal = null;

/**
 * Show the tournament results: a kit modal (focus on Return to Lobby, a
 * primary action; not dismissible: Return is the way out).
 *
 * @param {Object} options
 * @param {Array} options.scoreboard - Final sorted scoreboard
 * @param {string} [options.winner] - Winner's username (single-winner fallback)
 * @param {string[]} [options.winners] - All winners (ties produce co-winners)
 * @param {Function} options.onReturn - Called when user clicks return
 */
export function showTournamentResultsOverlay({ scoreboard, winner, winners, onReturn }) {
  removeTournamentResultsOverlay();

  const body = [];
  // Winner(s) — ties are announced as co-winners
  const winnerList = (winners && winners.length > 0) ? winners : (winner ? [winner] : []);
  if (winnerList.length > 0) {
    body.push(el('div', {
      className: 'result-winner',
      text: winnerList.length > 1 ? `Winners (tie): ${winnerList.join(' & ')}` : `Winner: ${winnerList[0]}`,
    }));
  }
  body.push(createTournamentScoreboard(scoreboard, 4, 4));

  const returnBtn = createButton({ label: 'Return to Lobby', variant: 'primary', size: 'lg' });
  const modal = openModal({
    id: 'tournamentResultsOverlay',
    title: 'Tournament Complete!',
    body,
    actions: [returnBtn],
    dismissible: false,
    initialFocus: returnBtn,
    className: 'result-modal is-tournament',
  });
  resultsModal = modal;
  returnBtn.addEventListener('click', () => {
    removeTournamentResultsOverlay();
    onReturn?.();
  });
}

/**
 * Remove tournament results overlay.
 */
export function removeTournamentResultsOverlay() {
  if (resultsModal) {
    const m = resultsModal;
    resultsModal = null;
    m.close('api');
  }
  const overlay = document.getElementById('tournamentResultsOverlay');
  if (overlay) overlay.remove();
}
