/**
 * Position and team utilities for the 4-player game.
 *
 * Teams: Positions 1 & 3 vs Positions 2 & 4
 * Rotation: Clockwise 1 -> 2 -> 3 -> 4 -> 1
 *
 * A Get Your Bid table (state/GameState.js `seatCount` 3) has three seats
 * and no teams: `rotate`, `seatsAround` and `slotOf` take the seat count
 * (default 4: the base game, unchanged).
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
 * @param {number} [seats=4] - seats at the table (3 at a Get Your Bid table)
 * @returns {number} Next position
 */
export function rotate(position, seats = 4) {
  return (position % seats) + 1;
}

/**
 * The other seats as `me` sees them: opp1 the next in turn (drawn on my
 * left), opp2 the one before me (on my right), partner the one across; at
 * a three-seat table there is no partner and opp2 is the seat after opp1.
 * @param {number} me - the viewer's position
 * @param {number} [seats=4]
 * @returns {{partner: number|null, opp1: number, opp2: number}}
 */
export function seatsAround(me, seats = 4) {
  if (seats === 3) return { partner: null, opp1: rotate(me, 3), opp2: rotate(rotate(me, 3), 3) };
  return { partner: team(me), opp1: rotate(me), opp2: rotate(rotate(rotate(me))) };
}

/**
 * Which of the viewer's slots a seat is: 'self', 'partner', 'opp1', 'opp2'
 * (null: not a seat of this table).
 * @param {number} position
 * @param {number} me - the viewer's position
 * @param {number} [seats=4]
 */
export function slotOf(position, me, seats = 4) {
  if (!me || !position || position > seats) return null;
  if (position === me) return 'self';
  const around = seatsAround(me, seats);
  if (position === around.partner) return 'partner';
  if (position === around.opp1) return 'opp1';
  if (position === around.opp2) return 'opp2';
  return null;
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
 * A seat's colour class letter (table.css .is-team-a / -b / -c, data-team):
 * team A (seats 1 and 3) or B (2 and 4); at a three-seat table (Get Your
 * Bid: no teams) each seat has its own, a / b / c.
 * @param {number} position
 * @param {number} [seats=4]
 * @returns {'a'|'b'|'c'}
 */
export function seatLetter(position, seats = 4) {
  if (seats === 3) return ['a', 'b', 'c'][(Number(position) || 1) - 1] || 'a';
  return Number(position) % 2 === 1 ? 'a' : 'b';
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
