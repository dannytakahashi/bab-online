/**
 * Color utilities for username-based colors and chat display.
 */

/**
 * Hash a username to a hue value (0-359).
 * Uses djb2 hash algorithm.
 *
 * @param {string} username - Username to hash
 * @returns {number} Hue value 0-359
 */
export function hashToHue(username) {
  let hash = 5381;
  for (let i = 0; i < username.length; i++) {
    hash = ((hash << 5) + hash) ^ username.charCodeAt(i);
  }
  return Math.abs(hash) % 360;
}

/**
 * Generate a color that's visually distinct from existing colors.
 * Adjusts hue if too close to existing ones.
 *
 * @param {string} username - Username to generate color for
 * @param {Array<string>} existingColors - Array of existing HSL color strings
 * @returns {string} HSL color string
 */
export function generateDistinctColor(username, existingColors = []) {
  let hue = hashToHue(username);

  // Extract hues from existing colors
  const existingHues = existingColors
    .map((color) => {
      const match = color.match(/hsl\((\d+)/);
      return match ? parseInt(match[1], 10) : null;
    })
    .filter((h) => h !== null);

  // Adjust hue if too close to existing ones (within 50 degrees)
  const minDistance = 50;
  let attempts = 0;

  while (attempts < 360 && existingHues.length > 0) {
    const tooClose = existingHues.some((existingHue) => {
      const diff = Math.abs(hue - existingHue);
      return Math.min(diff, 360 - diff) < minDistance;
    });

    if (!tooClose) break;

    // Prime number for better distribution
    hue = (hue + 67) % 360;
    attempts++;
  }

  return `hsl(${hue}, 70%, 60%)`;
}

/**
 * Get a simple color for a username without collision avoidance.
 *
 * @param {string} username - Username to get color for
 * @returns {string} HSL color string
 */
export function getUsernameColor(username) {
  return `hsl(${hashToHue(username)}, 70%, 60%)`;
}

/**
 * Parse an HSL string to extract hue value.
 *
 * @param {string} hslString - HSL color string like "hsl(180, 70%, 60%)"
 * @returns {number|null} Hue value or null if parsing failed
 */
export function extractHue(hslString) {
  const match = hslString.match(/hsl\((\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
