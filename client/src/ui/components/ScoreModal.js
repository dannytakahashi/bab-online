/**
 * Score modal component for displaying hand and game results.
 */

import { team, rotate } from '../../utils/positions.js';
import { el, createButton, openModal } from '../kit/index.js';

/**
 * The names getTeamNames gives before the teams exist (the draw for deal: no
 * seats yet), for the game-end lines and the score modal. A seat's are
 * "Your Team" / "Opponents"; a spectator has no team, so theirs are the
 * teams' own neutral names, "Team 1" (seats 1 and 3, which a spectator's
 * side shows) / "Team 2", as the teams panel names them (ui/tableHud.js).
 * The game log's score header never shows these (scoreHeaderNames).
 *
 * @param {boolean} spectator - the viewer has no seat
 * @returns {Object} { teamName, oppName }
 */
export function placeholderTeamNames(spectator = false) {
  return spectator
    ? { teamName: 'Team 1', oppName: 'Team 2' }
    : { teamName: 'Your Team', oppName: 'Opponents' };
}

/** A seat's username in playerData, or null (not seated / not known yet). */
function seatUsername(playerData, pos) {
  if (!playerData || !Array.isArray(playerData.position) || !Array.isArray(playerData.username)) return null;
  const idx = playerData.position.indexOf(pos);
  if (idx === -1) return null;
  const entry = playerData.username[idx];
  const name = typeof entry === 'string' ? entry : entry?.username;
  return typeof name === 'string' && name ? name : null;
}

/**
 * The game log score header's names: player names only, never a
 * placeholder (owner 2026-11-17). A seat's are "me/partner" and
 * "opp1/opp2" (opp1 the next seat clockwise); a spectator's, seats 1/3 and
 * 2/4, as getTeamNames. A side whose two names are not both known yet is
 * '' (the draw, before the seats exist; a seat whose own position is not
 * known yet has no side): the header keeps the line's height empty
 * (table.css) until they are.
 *
 * @param {number|null} myPosition - my seat (1-4), null for a spectator or not yet seated
 * @param {Object|null} playerData - { position: [], username: [{username}] }
 * @param {Object} [opts]
 * @param {boolean} [opts.spectator] - the viewer has no seat
 * @returns {{teamName: string, oppName: string}}
 */
export function scoreHeaderNames(myPosition, playerData, { spectator = false } = {}) {
  const me = spectator ? 1 : Number(myPosition);
  if (![1, 2, 3, 4].includes(me)) return { teamName: '', oppName: '' };
  const pair = (a, b) => {
    const first = seatUsername(playerData, a);
    const second = seatUsername(playerData, b);
    return first && second ? `${first}/${second}` : '';
  };
  return {
    teamName: pair(me, team(me)),
    oppName: pair(rotate(me), rotate(rotate(rotate(me)))),
  };
}

/**
 * Get team names based on position and player data.
 *
 * @param {number} myPosition - Player's position (1-4)
 * @param {Object} playerData - Player data object with positions and usernames
 * @param {Object} [opts]
 * @param {boolean} [opts.spectator] - the viewer has no seat (a spectator)
 * @returns {Object} { teamName, oppName }
 */
export function getTeamNames(myPosition, playerData, { spectator = false } = {}) {
  if (!playerData || !playerData.position || !playerData.username) {
    return placeholderTeamNames(spectator);
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

  const { teamName, oppName } = getTeamNames(myPosition, playerData, { spectator: !!isSpectator });

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
