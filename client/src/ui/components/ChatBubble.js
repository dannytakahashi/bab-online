/**
 * Chat Bubble Component (DOM-based)
 *
 * Speech bubbles for chat messages and bid announcements. A bubble is a
 * child of its seat's HUD node (ui/tableHud.js), at the seat's bubble
 * anchor from the table layout, so it sits by its avatar at every size and
 * follows it on a relayout (ui-4, webclient-7: the self bubble used to be
 * placed in window coordinates, hundreds of px off).
 */

import { hudSeat } from '../tableHud.js';

/**
 * Active chat bubbles tracking (keyed by position).
 */
const activeChatBubbles = {};

/**
 * Get tail direction based on position key.
 * - partner (across/top): bubble to the right, tail pointing left
 * - everyone else: bubble above, tail pointing down
 *
 * @param {string} positionKey - Position identifier
 * @returns {string} CSS class for tail direction
 */
function getTailClass(positionKey) {
  return positionKey === 'partner' ? 'tail-left' : 'tail-down';
}

/**
 * Create and show a chat bubble on a seat.
 *
 * @param {string} positionKey - 'opp1', 'opp2', 'partner', 'me' (or a spectator's 'bottom')
 * @param {string} message - Message text
 * @param {string|null} color - Text color (red for bids, null for chat)
 * @param {number} duration - Display duration in ms (default 6000)
 */
export function showChatBubble(positionKey, message, color = null, duration = 6000) {
  // Destroy existing bubble for this position if present
  if (activeChatBubbles[positionKey]) {
    clearBubble(positionKey);
  }

  // Create bubble element
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${getTailClass(positionKey)}`;
  bubble.dataset.seat = positionKey;
  if (color === '#FF0000') {
    bubble.classList.add('bid');
  }
  bubble.textContent = message;

  // In the seat's bubble slot (no table container: on the page)
  const seat = hudSeat(positionKey);
  (seat?.bubble || document.body).appendChild(bubble);

  // Set up fade out and removal
  const fadeTime = 300;
  const entry = { bubble, timer: null };
  entry.timer = setTimeout(() => {
    bubble.classList.add('fade-out');
    entry.timer = setTimeout(() => {
      if (bubble.parentNode) {
        bubble.remove();
      }
      // A newer bubble may own this slot by now (a message that arrived
      // during the fade): only forget our own
      if (activeChatBubbles[positionKey] === entry) {
        delete activeChatBubbles[positionKey];
      }
    }, fadeTime);
  }, duration - fadeTime);

  // Store reference
  activeChatBubbles[positionKey] = entry;
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
 * Get active chat bubbles (for external access).
 *
 * @returns {Object} Map of position key to bubble data
 */
export function getActiveChatBubbles() {
  return activeChatBubbles;
}
