/**
 * Player Queue Component
 *
 * Displays a waiting queue showing players who are waiting to join a game.
 */

/**
 * Show the player queue overlay.
 *
 * @param {Array} currentUsers - Array of user objects with username property
 */
export function showPlayerQueue(currentUsers) {
  console.log('Showing player queue, currentUsers:', currentUsers);

  // Remove any existing queue container
  let oldContainer = document.getElementById('queueContainer');
  if (oldContainer) oldContainer.remove();

  // Validate input
  if (!currentUsers || !Array.isArray(currentUsers)) {
    console.warn('showPlayerQueue: Invalid currentUsers array');
    return;
  }

  // Create container
  const container = document.createElement('div');
  container.id = 'queueContainer';
  container.style.position = 'absolute';
  container.style.top = '50%';
  container.style.left = '50%';
  container.style.transform = 'translate(-50%, -50%)';
  container.style.background = 'rgba(34, 34, 34, 0.9)';
  container.style.color = '#fff';
  container.style.padding = '30px';
  container.style.borderRadius = '10px';
  container.style.border = '3px solid #888';
  container.style.fontSize = '20px';
  container.style.fontFamily = 'Arial, sans-serif';
  container.style.minWidth = '16vw';
  container.style.textAlign = 'center';
  container.style.zIndex = '1000';

  // Add heading
  const heading = document.createElement('div');
  heading.innerText = 'Waiting for players...';
  heading.style.fontSize = '24px';
  heading.style.marginBottom = '20px';
  container.appendChild(heading);

  // Add usernames
  for (let i = 0; i < currentUsers.length; i++) {
    const user = currentUsers[i];
    const username = typeof user === 'string' ? user : user?.username || `Player ${i + 1}`;

    const nameLine = document.createElement('div');
    nameLine.innerText = `${i + 1}. ${username}`;
    nameLine.style.marginBottom = '10px';
    container.appendChild(nameLine);
  }

  // Add remaining slots indicator
  const remainingSlots = 4 - currentUsers.length;
  if (remainingSlots > 0) {
    const slotsRemaining = document.createElement('div');
    slotsRemaining.innerText = `${remainingSlots} more ${remainingSlots === 1 ? 'player' : 'players'} needed`;
    slotsRemaining.style.marginTop = '15px';
    slotsRemaining.style.fontSize = '14px';
    slotsRemaining.style.color = '#9ca3af';
    slotsRemaining.style.fontStyle = 'italic';
    container.appendChild(slotsRemaining);
  }

  // Add to body
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
  container.innerHTML = '';

  // Re-add heading
  const heading = document.createElement('div');
  heading.innerText = 'Waiting for players...';
  heading.style.fontSize = '24px';
  heading.style.marginBottom = '20px';
  container.appendChild(heading);

  // Re-add usernames
  for (let i = 0; i < currentUsers.length; i++) {
    const user = currentUsers[i];
    const username = typeof user === 'string' ? user : user?.username || `Player ${i + 1}`;

    const nameLine = document.createElement('div');
    nameLine.innerText = `${i + 1}. ${username}`;
    nameLine.style.marginBottom = '10px';
    container.appendChild(nameLine);
  }

  // Add remaining slots indicator
  const remainingSlots = 4 - currentUsers.length;
  if (remainingSlots > 0) {
    const slotsRemaining = document.createElement('div');
    slotsRemaining.innerText = `${remainingSlots} more ${remainingSlots === 1 ? 'player' : 'players'} needed`;
    slotsRemaining.style.marginTop = '15px';
    slotsRemaining.style.fontSize = '14px';
    slotsRemaining.style.color = '#9ca3af';
    slotsRemaining.style.fontStyle = 'italic';
    container.appendChild(slotsRemaining);
  }
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
