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
 * The tail's CSS class. On the HUD the seat's direction comes from the
 * layout (the seat node's data-tail: 'down' above the avatar, 'left' right
 * of it, 'right' left of it, chosen so the bubble never covers the trump,
 * the hand, the trick or the histories); off the HUD the partner's bubble
 * points left and everyone else's down.
 *
 * @param {string} positionKey - Position identifier
 * @param {HTMLElement|null} seatNode - the seat's HUD node
 * @returns {string} CSS class for tail direction
 */
function getTailClass(positionKey, seatNode = null) {
  const tail = seatNode?.dataset?.tail;
  if (tail) return `tail-${tail}`;
  return positionKey === 'partner' ? 'tail-left' : 'tail-down';
}

const TAIL_CLASSES = ['tail-down', 'tail-left', 'tail-right'];

/** Point a bubble's tail the seat's way (a relayout may turn it). */
export function setBubbleTail(bubble, tail) {
  if (!bubble || !tail) return;
  bubble.classList.remove(...TAIL_CLASSES);
  bubble.classList.add(`tail-${tail}`);
}

/**
 * Create and show a chat bubble on a seat.
 *
 * @param {string} positionKey - 'opp1', 'opp2', 'partner', 'me' (or a spectator's 'bottom')
 * @param {string} message - Message text
 * @param {string|null} kind - 'bid' for a bid bubble (table.css .chat-bubble.bid), null for chat
 * @param {number} duration - Display duration in ms (default 6000)
 */
export function showChatBubble(positionKey, message, kind = null, duration = 6000) {
  // Destroy existing bubble for this position if present
  if (activeChatBubbles[positionKey]) {
    clearBubble(positionKey);
  }

  // In the seat's bubble slot (no table container: on the page)
  const seat = hudSeat(positionKey);

  // Create bubble element: the text in its own box, clamped to the
  // layout's line count (BUBBLE.lines) so the bubble never outgrows the
  // rect the layout keeps clear (the log keeps the whole message)
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${getTailClass(positionKey, seat?.seat)}`;
  bubble.dataset.seat = positionKey;
  if (kind === 'bid') {
    bubble.classList.add('bid');
  }
  const text = document.createElement('span');
  text.className = 'chat-bubble-text';
  text.textContent = message;
  bubble.appendChild(text);

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
