/**
 * Score modal component for displaying hand and game results.
 */

import { team, rotate } from '../../utils/positions.js';

/**
 * Get team names based on position and player data.
 *
 * @param {number} myPosition - Player's position (1-4)
 * @param {Object} playerData - Player data object with positions and usernames
 * @returns {Object} { teamName, oppName }
 */
export function getTeamNames(myPosition, playerData) {
  if (!playerData || !playerData.position || !playerData.username) {
    return { teamName: 'Your Team', oppName: 'Opponents' };
  }

  const getUsername = (pos) => {
    const idx = playerData.position.indexOf(pos);
    if (idx === -1 || !playerData.username[idx]) return `P${pos}`;
    return playerData.username[idx].username || `P${pos}`;
  };

  const partnerPos = team(myPosition);
  const opp1Pos = rotate(myPosition);
  const opp2Pos = rotate(rotate(rotate(myPosition)));

  const teamName = `${getUsername(myPosition)}/${getUsername(partnerPos)}`;
  const oppName = `${getUsername(opp1Pos)}/${getUsername(opp2Pos)}`;

  return { teamName, oppName };
}

/**
 * Format hand complete results for game log.
 *
 * @param {Object} options - Score options
 * @param {number} options.myPosition - Player's position
 * @param {Object} options.playerData - Player data
 * @param {Array} options.bids - Bid array [p1bid, p2bid, p3bid, p4bid]
 * @param {number} options.teamScore - Current team score
 * @param {number} options.oppScore - Current opponent score
 * @param {number} options.teamOldScore - Previous team score
 * @param {number} options.oppOldScore - Previous opponent score
 * @param {number} options.teamTricks - Team tricks won this hand
 * @param {number} options.oppTricks - Opponent tricks won this hand
 * @returns {Array} Array of message strings to add to game log
 */
export function formatHandCompleteMessages(options) {
  const {
    myPosition,
    playerData,
    bids,
    teamScore,
    oppScore,
    teamOldScore,
    oppOldScore,
    teamTricks,
    oppTricks,
  } = options;

  const { teamName, oppName } = getTeamNames(myPosition, playerData);

  // Get bid positions - state.bids uses position (1-4) as keys, not 0-indexed
  const myBidIdx = myPosition;
  const partnerBidIdx = team(myPosition);
  const opp1BidIdx = rotate(myPosition);
  const opp2BidIdx = rotate(rotate(rotate(myPosition)));

  // Calculate score changes
  const teamChange = teamScore - teamOldScore;
  const oppChange = oppScore - oppOldScore;
  const teamChangeStr = teamChange >= 0 ? `+${teamChange}` : teamChange.toString();
  const oppChangeStr = oppChange >= 0 ? `+${oppChange}` : oppChange.toString();

  // Get bids safely
  const getBid = (idx) => (bids && bids[idx] !== undefined ? bids[idx] : '?');

  return [
    '--- HAND COMPLETE ---',
    `${teamName}: Bid ${getBid(myBidIdx)}/${getBid(partnerBidIdx)}, Won ${teamTricks}, ${teamChangeStr} → ${teamScore}`,
    `${oppName}: Bid ${getBid(opp1BidIdx)}/${getBid(opp2BidIdx)}, Won ${oppTricks}, ${oppChangeStr} → ${oppScore}`,
  ];
}

/**
 * Format game end results for game log.
 *
 * @param {Object} options - Score options
 * @param {number} options.myPosition - Player's position
 * @param {Object} options.playerData - Player data
 * @param {number} options.teamScore - Final team score
 * @param {number} options.oppScore - Final opponent score
 * @returns {Array} Array of message strings to add to game log
 */
export function formatGameEndMessages(options) {
  const { myPosition, playerData, teamScore, oppScore } = options;

  const { teamName, oppName } = getTeamNames(myPosition, playerData);

  // Determine winner
  let resultMsg;
  if (teamScore > oppScore) {
    resultMsg = 'VICTORY';
  } else if (teamScore < oppScore) {
    resultMsg = 'DEFEAT';
  } else {
    resultMsg = 'TIE GAME';
  }

  return ['=== GAME OVER ===', `${teamName}: ${teamScore}`, `${oppName}: ${oppScore}`, resultMsg];
}

/**
 * Show final score overlay with return to lobby button.
 *
 * @param {Object} options - Options
 * @param {number} options.teamScore - Final team score
 * @param {number} options.oppScore - Final opponent score
 * @param {Object} options.playerStats - Player stats object { position: { username, totalBids, totalTricks, setsCaused } }
 * @param {Function} options.onReturnToLobby - Called when user clicks return button
 * @returns {Object} { overlay, destroy }
 */
export function showFinalScoreOverlay({ teamScore, oppScore, playerStats, onReturnToLobby }) {
  // Determine winner message
  let resultMsg;
  let resultColor;
  if (teamScore > oppScore) {
    resultMsg = 'VICTORY';
    resultColor = '#4ade80';
  } else if (teamScore < oppScore) {
    resultMsg = 'DEFEAT';
    resultColor = '#ef4444';
  } else {
    resultMsg = 'TIE GAME';
    resultColor = '#fbbf24';
  }

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'finalScoreOverlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    z-index: 2000;
  `;

  // Result message
  const resultDiv = document.createElement('div');
  resultDiv.style.cssText = `
    font-size: 48px;
    font-weight: bold;
    color: ${resultColor};
    margin-bottom: 20px;
    text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
  `;
  resultDiv.textContent = resultMsg;
  overlay.appendChild(resultDiv);

  // Score display
  const scoreDiv = document.createElement('div');
  scoreDiv.style.cssText = `
    font-size: 24px;
    color: white;
    margin-bottom: 30px;
  `;
  scoreDiv.textContent = `Final Score: ${teamScore} - ${oppScore}`;
  overlay.appendChild(scoreDiv);

  // Player stats grid (if available)
  if (playerStats) {
    const statsContainer = document.createElement('div');
    statsContainer.style.cssText = `
      background: rgba(30, 30, 30, 0.9);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 30px;
      min-width: 400px;
    `;

    // Stats header
    const statsHeader = document.createElement('div');
    statsHeader.style.cssText = `
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1fr;
      gap: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid #444;
      margin-bottom: 12px;
      color: #888;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    `;
    statsHeader.innerHTML = `
      <div>Player</div>
      <div style="text-align: center;">Bids</div>
      <div style="text-align: center;">Tricks</div>
      <div style="text-align: center;">Faults</div>
    `;
    statsContainer.appendChild(statsHeader);

    // Player rows - order by position (1, 2, 3, 4)
    for (let pos = 1; pos <= 4; pos++) {
      const stats = playerStats[pos];
      if (!stats) continue;

      // Team color: positions 1,3 = team1 (blue-ish), positions 2,4 = team2 (red-ish)
      const isTeam1 = pos === 1 || pos === 3;
      const teamColor = isTeam1 ? '#63b3ed' : '#fc8181';

      const playerRow = document.createElement('div');
      playerRow.style.cssText = `
        display: grid;
        grid-template-columns: 2fr 1fr 1fr 1fr;
        gap: 12px;
        padding: 8px 0;
        color: white;
        font-size: 14px;
      `;
      playerRow.innerHTML = `
        <div style="color: ${teamColor}; font-weight: 500;">${stats.username}</div>
        <div style="text-align: center;">${stats.totalBids}</div>
        <div style="text-align: center;">${stats.totalTricks}</div>
        <div style="text-align: center; color: ${stats.setsCaused > 0 ? '#ef4444' : 'inherit'};">${stats.setsCaused}</div>
      `;
      statsContainer.appendChild(playerRow);
    }

    overlay.appendChild(statsContainer);
  }

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
  returnBtn.onmouseover = () => {
    returnBtn.style.background = '#b91c1c';
  };
  returnBtn.onmouseout = () => {
    returnBtn.style.background = '#dc2626';
  };
  returnBtn.onclick = () => {
    destroy();
    onReturnToLobby?.();
  };
  overlay.appendChild(returnBtn);

  document.body.appendChild(overlay);

  const destroy = () => {
    overlay.remove();
  };

  return { overlay, destroy };
}

/**
 * Remove final score overlay if it exists.
 */
export function removeFinalScoreOverlay() {
  const overlay = document.getElementById('finalScoreOverlay');
  if (overlay) overlay.remove();

  // Also check for legacy ID
  const legacyOverlay = document.getElementById('finalScore');
  if (legacyOverlay) legacyOverlay.remove();
}
