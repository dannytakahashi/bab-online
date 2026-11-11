/**
 * Score modal component for displaying hand and game results.
 */

import { team, rotate } from '../../utils/positions.js';
import { el, createButton, openModal } from '../kit/index.js';

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
  const { myPosition, playerData, teamScore, oppScore, isSpectator } = options;

  const { teamName, oppName } = getTeamNames(myPosition, playerData);

  // Determine winner
  let resultMsg;
  if (isSpectator) {
    if (teamScore > oppScore) {
      resultMsg = `${teamName} wins!`;
    } else if (teamScore < oppScore) {
      resultMsg = `${oppName} wins!`;
    } else {
      resultMsg = 'TIE GAME';
    }
  } else if (teamScore > oppScore) {
    resultMsg = 'VICTORY';
  } else if (teamScore < oppScore) {
    resultMsg = 'DEFEAT';
  } else {
    resultMsg = 'TIE GAME';
  }

  return ['=== GAME OVER ===', `${teamName}: ${teamScore}`, `${oppName}: ${oppScore}`, resultMsg];
}

/** The score modal on screen (closed by removeFinalScoreOverlay). */
let scoreModal = null;

/**
 * Show final score overlay with return to lobby button: a kit modal (focus
 * on Return to Lobby, a primary action; no Escape: leaving the table is the
 * only way out of it, so it is not dismissible).
 *
 * @param {Object} options - Options
 * @param {number} options.teamScore - Final team score
 * @param {number} options.oppScore - Final opponent score
 * @param {Object} options.playerStats - Player stats object { position: { username, totalBids, totalTricks, setsCaused } }
 * @param {Function} options.onReturnToLobby - Called when user clicks return button
 * @returns {Object} { overlay, destroy }
 */
export function showFinalScoreOverlay({ teamScore, oppScore, playerStats, onReturnToLobby, buttonText, isSpectator, teamName, oppName }) {
  removeFinalScoreOverlay();

  // Determine winner message (the title's color is its class: table.css .result-modal)
  let resultMsg;
  let tone;
  if (isSpectator) {
    resultMsg = 'GAME OVER';
    tone = 'is-neutral';
  } else if (teamScore > oppScore) {
    resultMsg = 'VICTORY';
    tone = 'is-victory';
  } else if (teamScore < oppScore) {
    resultMsg = 'DEFEAT';
    tone = 'is-defeat';
  } else {
    resultMsg = 'TIE GAME';
    tone = 'is-tie';
  }

  const body = [];

  // Score display
  const scoreDiv = el('div', { className: 'result-score' });
  if (isSpectator && teamName && oppName) {
    scoreDiv.textContent = `${teamName}: ${teamScore}  —  ${oppName}: ${oppScore}`;
  } else {
    scoreDiv.textContent = `Final Score: ${teamScore} - ${oppScore}`;
  }
  body.push(scoreDiv);

  // Player stats grid (if available)
  if (playerStats) {
    const statsContainer = el('div', { className: 'result-stats' });
    const head = el('div', { className: 'result-stats__row result-stats__head' });
    for (const h of ['Player', 'Bids', 'Tricks', 'Faults', 'Avg HSI']) head.appendChild(el('div', { text: h }));
    statsContainer.appendChild(head);

    // Player rows - order by position (1, 2, 3, 4); team A (seats 1, 3) blue, team B coral
    for (let pos = 1; pos <= 4; pos++) {
      const stats = playerStats[pos];
      if (!stats) continue;
      const row = el('div', { className: 'result-stats__row' });
      // Username via textContent: it is user-controlled
      row.appendChild(el('div', { className: `result-stats__name is-team-${pos % 2 === 1 ? 'a' : 'b'}`, text: stats.username ?? '' }));
      row.appendChild(el('div', { text: stats.totalBids }));
      row.appendChild(el('div', { text: stats.totalTricks }));
      row.appendChild(el('div', { className: stats.setsCaused > 0 ? 'is-fault' : '', text: stats.setsCaused }));
      row.appendChild(el('div', { text: stats.avgHSI }));
      statsContainer.appendChild(row);
    }
    body.push(statsContainer);
  }

  // Return button: the primary action (never red: ui-d2)
  const returnBtn = createButton({ label: buttonText || 'Return to Lobby', variant: 'primary', size: 'lg' });

  const modal = openModal({
    id: 'finalScoreOverlay',
    title: resultMsg,
    body,
    actions: [returnBtn],
    dismissible: false,
    initialFocus: returnBtn,
    className: `result-modal ${tone}`,
  });
  scoreModal = modal;

  const destroy = () => {
    if (scoreModal === modal) scoreModal = null;
    modal.close('api');
  };
  returnBtn.addEventListener('click', () => {
    destroy();
    onReturnToLobby?.();
  });

  return { overlay: modal.backdrop, destroy };
}

/**
 * Remove final score overlay if it exists.
 */
export function removeFinalScoreOverlay() {
  if (scoreModal) {
    const m = scoreModal;
    scoreModal = null;
    m.close('api');
  }
  const overlay = document.getElementById('finalScoreOverlay');
  if (overlay) overlay.remove();

  // Also check for legacy ID
  const legacyOverlay = document.getElementById('finalScore');
  if (legacyOverlay) legacyOverlay.remove();
}
