/**
 * Position and team utilities for the 4-player game.
 *
 * Teams: Positions 1 & 3 vs Positions 2 & 4
 * Rotation: Clockwise 1 -> 2 -> 3 -> 4 -> 1
 */

/**
 * Get partner position for a given position.
 * Teams: 1 & 3, 2 & 4
 *
 * @param {number} position - Player position (1-4)
 * @returns {number} Partner's position
 */
export function team(position) {
  if (position === 1) return 3;
  if (position === 2) return 4;
  if (position === 3) return 1;
  if (position === 4) return 2;
  return null;
}

/**
 * Rotate to next position clockwise.
 * 1 -> 2 -> 3 -> 4 -> 1
 *
 * @param {number} position - Current position (1-4)
 * @returns {number} Next position
 */
export function rotate(position) {
  return (position % 4) + 1;
}

/**
 * Check if two positions are on the same team.
 *
 * @param {number} pos1 - First position
 * @param {number} pos2 - Second position
 * @returns {boolean} True if same team
 */
export function isSameTeam(pos1, pos2) {
  return team(pos1) === pos2;
}

/**
 * Get team number for a position.
 * Team 1: Positions 1 & 3
 * Team 2: Positions 2 & 4
 *
 * @param {number} position - Player position (1-4)
 * @returns {number} Team number (1 or 2)
 */
export function getTeamNumber(position) {
  return position === 1 || position === 3 ? 1 : 2;
}

/**
 * Get player username from position using player data.
 * Returns fallback if playerData is not available.
 *
 * @param {number} pos - Target position
 * @param {Object} playerData - Object with username and position arrays
 * @returns {string} Player username or fallback
 */
export function getPlayerName(pos, playerData) {
  if (!playerData || !playerData.username || !playerData.position) {
    console.warn('playerData not initialized when getting name for position:', pos);
    return `Player ${pos}`;
  }

  const index = playerData.position.indexOf(pos);
  if (index === -1) {
    console.warn('Position not found in playerData:', pos);
    return `Player ${pos}`;
  }

  const player = playerData.username[index];
  if (!player || !player.username) {
    console.warn('No username at index:', index);
    return `Player ${pos}`;
  }

  return player.username;
}

/**
 * Get relative position from viewer's perspective.
 * Maps absolute positions to: 'bottom' (me), 'left', 'top', 'right'
 *
 * @param {number} targetPos - Target player's position
 * @param {number} myPos - Viewer's position
 * @returns {string} Relative position name
 */
export function getRelativePosition(targetPos, myPos) {
  const offset = (targetPos - myPos + 4) % 4;
  const positions = ['bottom', 'left', 'top', 'right'];
  return positions[offset];
}
