/**
 * Chat Bubble Component (DOM-based)
 *
 * Speech bubbles for chat messages and bid announcements. A bubble is a
 * child of its seat's HUD node (ui/tableHud.js), at the seat's bubble
 * anchor from the table layout, so it sits by its avatar at every size and
 * follows it on a relayout (ui-4, webclient-7: the self bubble used to be
 * placed in window coordinates, hundreds of px off).
 *
 * A spectator's chat (owner, 2026-11-11: "a similar chat bubble ... above
 * the eye with the spectators name") is the same bubble by the spectator
 * badge (showSpectatorChatBubble: .hud-spectator-bubble, the layout's
 * spectators.bubble spot), "Zach: hello", tinted. One at a time: a newer
 * spectator message replaces it. Like the seats' bubbles it has no live
 * region or role (the game log carries the line): a screen reader is not
 * told about it a second time.
 */

import { hudSeat, hudSpectatorBubbleSlot } from '../tableHud.js';

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

/** activeChatBubbles' key for the spectator badge's bubble (one for every spectator). */
export const SPECTATOR_BUBBLE_KEY = 'spectators';

/** The bubble's text box: clamped to the layout's line count (the log keeps the whole message). */
function textBox(message, name = null) {
  const text = document.createElement('span');
  text.className = 'chat-bubble-text';
  if (name) {
    const who = document.createElement('span');
    who.className = 'chat-bubble-name';
    who.textContent = `${name}:`;
    text.append(who, ` ${message}`);
  } else {
    text.textContent = message;
  }
  return text;
}

/**
 * Put a bubble up under `key` (replacing that key's bubble) and fade it out
 * after `duration` ms: the one timing every bubble shares.
 */
function mount(key, bubble, parent, duration) {
  if (activeChatBubbles[key]) clearBubble(key);
  parent.appendChild(bubble);
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
      if (activeChatBubbles[key] === entry) {
        delete activeChatBubbles[key];
      }
    }, fadeTime);
  }, duration - fadeTime);
  activeChatBubbles[key] = entry;
  return entry;
}

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
  // In the seat's bubble slot (no table container: on the page)
  const seat = hudSeat(positionKey);

  // The text in its own box, clamped to the layout's line count
  // (BUBBLE.lines) so the bubble never outgrows the rect the layout keeps clear
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${getTailClass(positionKey, seat?.seat)}`;
  bubble.dataset.seat = positionKey;
  if (kind === 'bid') {
    bubble.classList.add('bid');
  }
  bubble.appendChild(textBox(message));
  mount(positionKey, bubble, seat?.bubble || document.body, duration);
}

/**
 * A spectator's chat by the spectator badge: "Name: message", the seats'
 * duration and 3-line cap, tinted (.is-spectator). A newer one replaces it.
 * At the layout's spot even while the badge is still hidden (a spectator
 * who chats before the coalesced spectatorsUpdated lands: the layout keeps
 * the badge's spot and its bubble's clear either way); hidden where the
 * layout has no spot for it (tableHud). Nothing without a table.
 *
 * @param {string} name - the sender (the badge stands for everyone watching)
 * @param {string} message
 * @param {number} [duration=6000] - as a seat's chat bubble
 * @returns {HTMLElement|null} the bubble
 */
export function showSpectatorChatBubble(name, message, duration = 6000) {
  const slot = hudSpectatorBubbleSlot();
  if (!slot) return null;
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble is-spectator tail-${slot.dataset.tail || 'down'}`;
  bubble.dataset.seat = SPECTATOR_BUBBLE_KEY;
  bubble.appendChild(textBox(message, name || 'Spectator'));
  mount(SPECTATOR_BUBBLE_KEY, bubble, slot, duration);
  return bubble;
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
