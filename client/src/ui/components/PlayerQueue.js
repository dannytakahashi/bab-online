/**
 * Player Queue Component
 *
 * Displays a waiting queue showing players who are waiting to join a game.
 * Kit classes and tokens (styles/screens.css .screen--queue, item 18b);
 * usernames as text.
 */
import { el, createPanel } from '../kit/index.js';

/** The queue's content: heading, numbered names, seats still needed. */
function queueContent(currentUsers) {
  const nodes = [el('h2', { className: 'section-title', text: 'Waiting for players...' })];

  currentUsers.forEach((user, i) => {
    const username = typeof user === 'string' ? user : user?.username || `Player ${i + 1}`;
    nodes.push(el('div', { className: 'queue-line', text: `${i + 1}. ${username}` }));
  });

  const remainingSlots = 4 - currentUsers.length;
  if (remainingSlots > 0) {
    nodes.push(el('div', {
      className: 'muted-note queue-remaining',
      text: `${remainingSlots} more ${remainingSlots === 1 ? 'player' : 'players'} needed`,
    }));
  }
  return nodes;
}

/**
 * Show the player queue overlay.
 *
 * @param {Array} currentUsers - Array of user objects with username property
 */
export function showPlayerQueue(currentUsers) {
  console.log('Showing player queue, currentUsers:', currentUsers);

  // Remove any existing queue container
  const oldContainer = document.getElementById('queueContainer');
  if (oldContainer) oldContainer.remove();

  // Validate input
  if (!currentUsers || !Array.isArray(currentUsers)) {
    console.warn('showPlayerQueue: Invalid currentUsers array');
    return;
  }

  const container = createPanel({ elevation: 3, className: 'screen screen--queue', children: queueContent(currentUsers) });
  container.id = 'queueContainer';
  container.setAttribute('role', 'status');
  document.body.appendChild(container);
}

/**
 * Update the player queue with new users.
 *
 * @param {Array} currentUsers - Array of user objects with username property
 */
export function updatePlayerQueue(currentUsers) {
  const container = document.getElementById('queueContainer');
  if (!container) {
    // Queue not visible, create it
    showPlayerQueue(currentUsers);
    return;
  }

  // Clear and rebuild the content
  container.replaceChildren(...queueContent(currentUsers || []));
}

/**
 * Remove the player queue overlay.
 */
export function removePlayerQueue() {
  const queueContainer = document.getElementById('queueContainer');
  if (queueContainer) {
    queueContainer.remove();
    console.log('Player queue removed.');
  }
}

/**
 * Check if the player queue is currently visible.
 *
 * @returns {boolean} True if visible
 */
export function isPlayerQueueVisible() {
  return !!document.getElementById('queueContainer');
}
