/**
 * Tournament Scoreboard Component
 *
 * Reusable scoreboard table and final results overlay.
 */

/**
 * Create a tournament scoreboard table element.
 *
 * @param {Array} scoreboard - Sorted array of { username, totalScore, roundScores }
 * @param {number} currentRound - Current round number (1-4)
 * @param {number} totalRounds - Total rounds (4)
 * @returns {HTMLElement} Scoreboard container div
 */
export function createTournamentScoreboard(scoreboard, currentRound, totalRounds) {
  const container = document.createElement('div');
  container.className = 'tournament-scoreboard';
  container.style.cssText = `
    background: rgba(0, 0, 0, 0.4);
    border-radius: 8px;
    padding: 15px;
    overflow-x: auto;
  `;

  if (!scoreboard || scoreboard.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.color = '#9ca3af';
    emptyMsg.style.textAlign = 'center';
    emptyMsg.style.padding = '10px';
    emptyMsg.textContent = 'No scores yet';
    container.appendChild(emptyMsg);
    return container;
  }

  const table = document.createElement('table');
  table.style.cssText = `
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  `;

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headerRow.style.borderBottom = '1px solid #4a5568';

  const headers = ['#', 'Player'];
  for (let r = 1; r <= totalRounds; r++) {
    headers.push(`R${r}`);
  }
  headers.push('Total');

  headers.forEach((text, i) => {
    const th = document.createElement('th');
    th.textContent = text;
    th.style.cssText = `
      padding: 8px 6px;
      text-align: ${i <= 1 ? 'left' : 'center'};
      color: #9ca3af;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: normal;
    `;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  scoreboard.forEach((entry, index) => {
    const row = document.createElement('tr');
    row.style.borderBottom = '1px solid #374151';

    // Rank
    const rankTd = document.createElement('td');
    rankTd.textContent = index + 1;
    rankTd.style.cssText = 'padding: 8px 6px; color: #9ca3af;';
    if (index === 0 && currentRound > 0) {
      rankTd.style.color = '#fbbf24';
      rankTd.style.fontWeight = 'bold';
    }
    row.appendChild(rankTd);

    // Player name
    const nameTd = document.createElement('td');
    nameTd.textContent = entry.username;
    nameTd.style.cssText = 'padding: 8px 6px; color: #fff; font-weight: 500;';
    if (index === 0 && currentRound > 0) {
      nameTd.style.color = '#fbbf24';
    }
    row.appendChild(nameTd);

    // Round scores
    for (let r = 0; r < totalRounds; r++) {
      const td = document.createElement('td');
      td.style.cssText = 'padding: 8px 6px; text-align: center; color: #e5e7eb;';
      if (entry.roundScores && entry.roundScores[r] !== undefined) {
        td.textContent = entry.roundScores[r];
      } else {
        td.textContent = '-';
        td.style.color = '#6b7280';
      }
      row.appendChild(td);
    }

    // Total
    const totalTd = document.createElement('td');
    totalTd.textContent = entry.totalScore;
    totalTd.style.cssText = 'padding: 8px 6px; text-align: center; color: #4ade80; font-weight: bold;';
    row.appendChild(totalTd);

    tbody.appendChild(row);
  });

  table.appendChild(tbody);
  container.appendChild(table);
  return container;
}

/**
 * Show full-screen tournament results overlay.
 *
 * @param {Object} options
 * @param {Array} options.scoreboard - Final sorted scoreboard
 * @param {string} options.winner - Winner's username
 * @param {Function} options.onReturn - Called when user clicks return
 */
export function showTournamentResultsOverlay({ scoreboard, winner, onReturn }) {
  removeTournamentResultsOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'tournamentResultsOverlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.9);
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    z-index: 2000;
  `;

  // Title
  const title = document.createElement('div');
  title.textContent = 'Tournament Complete!';
  title.style.cssText = `
    font-size: 36px;
    font-weight: bold;
    color: #fbbf24;
    margin-bottom: 10px;
    text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
  `;
  overlay.appendChild(title);

  // Winner
  if (winner) {
    const winnerDiv = document.createElement('div');
    winnerDiv.textContent = `Winner: ${winner}`;
    winnerDiv.style.cssText = `
      font-size: 24px;
      color: #4ade80;
      margin-bottom: 30px;
    `;
    overlay.appendChild(winnerDiv);
  }

  // Scoreboard
  const scoreboardEl = createTournamentScoreboard(scoreboard, 4, 4);
  scoreboardEl.style.maxWidth = '600px';
  scoreboardEl.style.width = '90vw';
  scoreboardEl.style.marginBottom = '30px';
  overlay.appendChild(scoreboardEl);

  // Return button
  const returnBtn = document.createElement('button');
  returnBtn.textContent = 'Return to Lobby';
  returnBtn.style.cssText = `
    padding: 16px 32px;
    font-size: 18px;
    font-weight: bold;
    background: #dc2626;
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.2s;
  `;
  returnBtn.onmouseover = () => { returnBtn.style.background = '#b91c1c'; };
  returnBtn.onmouseout = () => { returnBtn.style.background = '#dc2626'; };
  returnBtn.onclick = () => {
    removeTournamentResultsOverlay();
    onReturn?.();
  };
  overlay.appendChild(returnBtn);

  document.body.appendChild(overlay);
}

/**
 * Remove tournament results overlay.
 */
export function removeTournamentResultsOverlay() {
  const overlay = document.getElementById('tournamentResultsOverlay');
  if (overlay) overlay.remove();
}
