/**
 * Chat Bubble Component (DOM-based)
 *
 * Creates speech bubbles for chat messages and bid announcements.
 * Uses DOM elements for better text rendering and simpler styling.
 */

/**
 * Base design dimensions for scaling.
 */
const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 953;

/**
 * Active chat bubbles tracking (keyed by position).
 */
const activeChatBubbles = {};

/**
 * Get scale factors based on current screen size.
 * Uses the game container dimensions if available, otherwise window.
 *
 * @returns {Object} Scale factors { x, y, screenWidth, screenHeight }
 */
function getScaleFactors() {
  const gameContainer = document.getElementById('game-container');
  const screenWidth = gameContainer ? gameContainer.clientWidth : window.innerWidth;
  const screenHeight = gameContainer ? gameContainer.clientHeight : window.innerHeight;
  return {
    x: screenWidth / DESIGN_WIDTH,
    y: screenHeight / DESIGN_HEIGHT,
    screenWidth,
    screenHeight,
  };
}

/**
 * Get tail direction based on position key.
 * - me (player): bubble above, tail pointing down
 * - opp1 (left): bubble above, tail pointing down
 * - partner (across/top): bubble to right, tail pointing left
 * - opp2 (right): bubble above, tail pointing down
 *
 * @param {string} positionKey - Position identifier
 * @returns {string} CSS class for tail direction
 */
function getTailClass(positionKey) {
  switch (positionKey) {
    case 'partner':
      return 'tail-left'; // Bubble to the right, tail points left toward avatar
    case 'opp1':
    case 'opp2':
    case 'me':
    default:
      return 'tail-down'; // Bubble above, tail points down toward avatar
  }
}

/**
 * Create and show a chat bubble at a position.
 *
 * @param {string} positionKey - Position identifier ('opp1', 'opp2', 'partner', 'me')
 * @param {number} x - X position in pixels
 * @param {number} y - Y position in pixels
 * @param {string} message - Message text
 * @param {string|null} color - Text color (red for bids, null for chat)
 * @param {number} duration - Display duration in ms (default 6000)
 */
export function showChatBubble(positionKey, x, y, message, color = null, duration = 6000) {
  // Destroy existing bubble for this position if present
  if (activeChatBubbles[positionKey]) {
    clearBubble(positionKey);
  }

  // Create bubble element
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${getTailClass(positionKey)}`;
  if (color === '#FF0000') {
    bubble.classList.add('bid');
  }
  bubble.textContent = message;

  // Position the bubble relative to avatar
  const tailClass = getTailClass(positionKey);
  if (tailClass === 'tail-left') {
    // Partner (across): Bubble appears to the right of avatar
    bubble.style.left = `${x + 50}px`; // Right of avatar
    bubble.style.top = `${y}px`;
    bubble.style.transform = 'translateY(-50%)';
  } else {
    // All others (me, opp1, opp2): Bubble appears above avatar
    bubble.style.left = `${x}px`;
    bubble.style.top = `${y - 50}px`; // Above avatar
    bubble.style.transform = 'translate(-50%, -100%)';
  }

  document.body.appendChild(bubble);

  // Set up fade out and removal
  const fadeTime = 300;
  const timer = setTimeout(() => {
    bubble.classList.add('fade-out');
    setTimeout(() => {
      if (bubble.parentNode) {
        bubble.remove();
      }
      delete activeChatBubbles[positionKey];
    }, fadeTime);
  }, duration - fadeTime);

  // Store reference
  activeChatBubbles[positionKey] = { bubble, timer };
}

/**
 * Clear a specific bubble by position key.
 *
 * @param {string} positionKey - Position identifier
 */
function clearBubble(positionKey) {
  const bubbleData = activeChatBubbles[positionKey];
  if (bubbleData) {
    if (bubbleData.timer) {
      clearTimeout(bubbleData.timer);
    }
    if (bubbleData.bubble && bubbleData.bubble.parentNode) {
      bubbleData.bubble.remove();
    }
    delete activeChatBubbles[positionKey];
  }
}

/**
 * Clear all active chat bubbles.
 */
export function clearChatBubbles() {
  Object.keys(activeChatBubbles).forEach((key) => {
    clearBubble(key);
  });
}

/**
 * Get bubble position based on player position relative to current player.
 * Returns avatar center positions - the bubble offset is handled in showChatBubble.
 *
 * @param {number} playerPosition - Current player's position (1-4)
 * @param {number} messagePosition - Position of message sender (1-4)
 * @returns {Object|null} Position data { positionKey, x, y } or null if invalid
 */
export function getBubblePosition(playerPosition, messagePosition) {
  const { x: scaleX, y: scaleY, screenWidth, screenHeight } = getScaleFactors();

  const centerX = screenWidth / 2;
  const centerY = screenHeight / 2;

  // Avatar center positions (matching OpponentManager positions)
  // opp1/opp2 y is moved up to align bubble above avatar
  // 'me' uses window coordinates since player info box is outside game container
  const positions = {
    opp1: { x: Math.max(130, centerX - 550 * scaleX), y: centerY - 40 },
    opp2: { x: Math.min(screenWidth - 130, centerX + 550 * scaleX), y: centerY - 40 },
    partner: { x: centerX, y: centerY - 400 * scaleY },
    me: { x: window.innerWidth - 405, y: window.innerHeight - 230 },
  };

  // Determine relative position
  let positionKey = null;
  if (messagePosition === playerPosition + 1 || messagePosition === playerPosition - 3) {
    positionKey = 'opp1';
  } else if (messagePosition === playerPosition - 1 || messagePosition === playerPosition + 3) {
    positionKey = 'opp2';
  } else if (messagePosition === playerPosition + 2 || messagePosition === playerPosition - 2) {
    positionKey = 'partner';
  } else if (messagePosition === playerPosition) {
    positionKey = 'me';
  }

  if (!positionKey) return null;

  return {
    positionKey,
    x: positions[positionKey].x,
    y: positions[positionKey].y,
  };
}

/**
 * Get active chat bubbles (for external access).
 *
 * @returns {Object} Map of position key to bubble data
 */
export function getActiveChatBubbles() {
  return activeChatBubbles;
}

/**
 * Reposition all active bubbles (call on window resize).
 *
 * @param {number} playerPosition - Current player's position (1-4)
 */
export function repositionBubbles(playerPosition) {
  Object.keys(activeChatBubbles).forEach((positionKey) => {
    const bubbleData = activeChatBubbles[positionKey];
    if (!bubbleData || !bubbleData.bubble) return;

    const { x: scaleX, y: scaleY, screenWidth, screenHeight } = getScaleFactors();
    const centerX = screenWidth / 2;
    const centerY = screenHeight / 2;

    // Avatar center positions
    // 'me' uses window coordinates since player info box is outside game container
    const positions = {
      opp1: { x: Math.max(130, centerX - 550 * scaleX), y: centerY - 40 },
      opp2: { x: Math.min(screenWidth - 130, centerX + 550 * scaleX), y: centerY - 40 },
      partner: { x: centerX, y: centerY - 400 * scaleY },
      me: { x: window.innerWidth - 405, y: window.innerHeight - 230 },
    };

    const pos = positions[positionKey];
    if (!pos) return;

    const tailClass = getTailClass(positionKey);
    const bubble = bubbleData.bubble;

    if (tailClass === 'tail-left') {
      // Partner: bubble to the right
      bubble.style.left = `${pos.x + 50}px`;
      bubble.style.top = `${pos.y}px`;
    } else {
      // Others: bubble above
      bubble.style.left = `${pos.x}px`;
      bubble.style.top = `${pos.y - 50}px`;
    }
  });
}
