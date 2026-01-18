/**
 * Chat Bubble Component
 *
 * Creates speech bubbles for chat messages and bid announcements in Phaser scenes.
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
 *
 * @param {Phaser.Scene} scene - The Phaser scene
 * @returns {Object} Scale factors { x, y, screenWidth, screenHeight }
 */
function getScaleFactors(scene) {
  const screenWidth = scene.scale.width;
  const screenHeight = scene.scale.height;
  return {
    x: screenWidth / DESIGN_WIDTH,
    y: screenHeight / DESIGN_HEIGHT,
    screenWidth,
    screenHeight,
  };
}

/**
 * Create a speech bubble with text.
 *
 * @param {Phaser.Scene} scene - The Phaser scene
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} width - Initial bubble width (will adjust to content)
 * @param {number} height - Initial bubble height (will adjust to content)
 * @param {string} text - Text content
 * @param {string|null} color - Text color (red for bids, black for chat)
 * @param {string} tailDirection - Direction of bubble tail ('down' or 'left')
 * @returns {Phaser.GameObjects.Container} Container with bubble graphics
 */
export function createSpeechBubble(
  scene,
  x,
  y,
  width,
  height,
  text,
  color = null,
  tailDirection = 'down'
) {
  const { x: scaleX, y: scaleY } = getScaleFactors(scene);
  const PADDING = 10;
  const TAIL_SIZE = 20 * scaleX;
  const MAX_W = 350 * scaleX;
  const MAX_H = 200 * scaleY;

  // Style and measure the text
  const style = {
    fontSize: '16px',
    fontFamily: 'Arial',
    color: color === '#FF0000' ? '#FF0000' : '#000000',
    wordWrap: { width: MAX_W - 2 * PADDING },
  };
  const textObj = scene.add.text(0, 0, text, style);

  // Clamp measured size
  const txtW = Math.min(textObj.width, MAX_W - 2 * PADDING);
  const txtH = Math.min(textObj.height, MAX_H - 2 * PADDING);

  // Final bubble dimensions
  const bW = txtW + 2 * PADDING;
  const bH = txtH + 2 * PADDING;

  const bubble = scene.add.graphics();
  bubble.fillStyle(0xffffff, 1);

  let bubbleX, bubbleY;

  if (tailDirection === 'left') {
    // Bubble positioned to the right of x, vertically centered on y
    bubbleX = x + TAIL_SIZE;
    bubbleY = y - bH / 2;

    // Draw bubble background
    bubble.fillRoundedRect(bubbleX, bubbleY, bW, bH, 16);

    // Draw tail pointing left toward the avatar
    bubble.fillTriangle(
      x,
      y, // tail tip (pointing at avatar)
      bubbleX,
      y - TAIL_SIZE / 2, // top corner on bubble edge
      bubbleX,
      y + TAIL_SIZE / 2 // bottom corner on bubble edge
    );

    // Position text inside bubble
    textObj.setPosition(bubbleX + PADDING, bubbleY + PADDING);
  } else {
    // Original 'down' behavior: bubble above y, tail pointing down
    bubbleX = x;
    bubbleY = y - bH;

    // Draw bubble background
    bubble.fillRoundedRect(bubbleX, bubbleY, bW, bH, 16);

    // Draw tail pointing down
    bubble.fillTriangle(
      bubbleX + 20,
      bubbleY + bH, // left corner of bottom edge
      bubbleX - TAIL_SIZE,
      bubbleY + bH, // tail tip farther left
      bubbleX + 10,
      bubbleY + bH - TAIL_SIZE
    );

    // Position text inside bubble
    textObj.setPosition(bubbleX + PADDING, bubbleY + PADDING);
  }

  // Group elements
  const container = scene.add.container(0, 0, [bubble, textObj]);
  container.setDepth(500);
  container.setAlpha(1);

  return container;
}

/**
 * Show a chat bubble at a position, replacing any existing bubble.
 *
 * @param {Phaser.Scene} scene - The Phaser scene
 * @param {string} positionKey - Position identifier ('opp1', 'opp2', 'partner', 'me')
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {string} message - Message text
 * @param {string|null} color - Text color
 * @param {number} duration - Display duration in ms (default 6000)
 */
export function showChatBubble(
  scene,
  positionKey,
  x,
  y,
  message,
  color = null,
  duration = 6000
) {
  // Destroy existing bubble for this position if present
  if (activeChatBubbles[positionKey]) {
    if (activeChatBubbles[positionKey].timer) {
      activeChatBubbles[positionKey].timer.remove(false);
    }
    if (activeChatBubbles[positionKey].bubble) {
      activeChatBubbles[positionKey].bubble.destroy();
    }
    delete activeChatBubbles[positionKey];
  }

  // Determine tail direction based on position
  const tailDirection = positionKey === 'opp1' ? 'left' : 'down';

  // Create new bubble
  const bubble = createSpeechBubble(scene, x, y, 150, 50, message, color, tailDirection);
  const timer = scene.time.delayedCall(duration, () => {
    bubble.destroy();
    delete activeChatBubbles[positionKey];
  });

  // Store reference
  activeChatBubbles[positionKey] = { bubble, timer };
}

/**
 * Clear all active chat bubbles.
 *
 * @param {Phaser.Scene} scene - The Phaser scene (optional, for timer cleanup)
 */
export function clearChatBubbles(scene) {
  Object.keys(activeChatBubbles).forEach((key) => {
    const bubbleData = activeChatBubbles[key];
    if (bubbleData.timer) {
      bubbleData.timer.remove(false);
    }
    if (bubbleData.bubble) {
      bubbleData.bubble.destroy();
    }
    delete activeChatBubbles[key];
  });
}

/**
 * Get bubble position based on player position relative to current player.
 *
 * @param {Phaser.Scene} scene - The Phaser scene
 * @param {number} playerPosition - Current player's position (1-4)
 * @param {number} messagePosition - Position of message sender (1-4)
 * @returns {Object|null} Position data { positionKey, x, y } or null if invalid
 */
export function getBubblePosition(scene, playerPosition, messagePosition) {
  const { x: scaleX, y: scaleY, screenWidth, screenHeight } = getScaleFactors(scene);

  // Calculate positions
  const centerX = screenWidth / 2;
  const centerY = screenHeight / 2;

  // Match legacy game.js positions for chat bubbles
  const positions = {
    opp1: { x: centerX - 480 * scaleX, y: centerY },
    opp2: { x: centerX + 620 * scaleX, y: centerY },
    partner: { x: centerX + 20 * scaleX, y: centerY - 380 * scaleY },
    me: { x: screenWidth - 310 * scaleX, y: screenHeight - 270 * scaleY },
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
