/**
 * Game Lobby Screen
 *
 * Pre-game lobby where 4 players gather, chat, and ready up before starting.
 */

import { generateDistinctColor, getUsernameColor } from '../../utils/colors.js';

/**
 * Module state.
 */
let lobbyUserColors = {};
let currentLobbyId = null;
let isPlayerReady = false;

/**
 * Update the players list in the lobby.
 *
 * @param {HTMLElement|null} container - Container element (or null to find by ID)
 * @param {Array} players - Array of player objects with username and ready status
 * @param {string} currentUsername - The current player's username
 */
export function updateLobbyPlayersList(container, players, currentUsername) {
  if (!container) {
    container = document.getElementById('lobbyPlayersList');
  }
  if (!container) return;

  container.innerHTML = '';

  // Assign colors to new players - existing players keep their color for the session
  players.forEach((player) => {
    if (!lobbyUserColors[player.username]) {
      lobbyUserColors[player.username] = generateDistinctColor(
        player.username,
        Object.values(lobbyUserColors)
      );
    }
  });

  // Header with player count
  const header = document.createElement('div');
  header.innerText = `Players (${players.length}/4):`;
  header.style.fontWeight = 'bold';
  header.style.marginBottom = '10px';
  header.style.color = '#9ca3af';
  container.appendChild(header);

  // Show existing players
  players.forEach((player) => {
    const playerRow = document.createElement('div');
    playerRow.style.display = 'flex';
    playerRow.style.justifyContent = 'space-between';
    playerRow.style.alignItems = 'center';
    playerRow.style.padding = '8px 0';
    playerRow.style.borderBottom = '1px solid #374151';

    const nameContainer = document.createElement('span');
    nameContainer.style.display = 'flex';
    nameContainer.style.alignItems = 'center';
    nameContainer.style.gap = '6px';

    const nameSpan = document.createElement('span');
    nameSpan.innerText = player.username;
    nameSpan.style.fontSize = '16px';
    if (player.isBot) {
      nameSpan.style.color = '#a78bfa'; // Purple for bots
    }
    nameContainer.appendChild(nameSpan);
    playerRow.appendChild(nameContainer);

    const rightSide = document.createElement('span');
    rightSide.style.display = 'flex';
    rightSide.style.alignItems = 'center';
    rightSide.style.gap = '8px';

    const statusSpan = document.createElement('span');
    if (player.ready) {
      statusSpan.innerText = '✓ Ready';
      statusSpan.style.color = '#4ade80';
    } else {
      statusSpan.innerText = 'Waiting...';
      statusSpan.style.color = '#9ca3af';
    }
    statusSpan.style.fontSize = '14px';
    rightSide.appendChild(statusSpan);

    // Add remove button for bot players (hide once ready)
    if (player.isBot && !player.ready) {
      const removeBtn = document.createElement('button');
      removeBtn.innerText = '✕';
      removeBtn.title = 'Remove bot';
      removeBtn.style.background = 'none';
      removeBtn.style.border = 'none';
      removeBtn.style.color = '#ef4444';
      removeBtn.style.cursor = 'pointer';
      removeBtn.style.fontSize = '16px';
      removeBtn.style.fontWeight = 'bold';
      removeBtn.style.padding = '0 4px';
      removeBtn.style.lineHeight = '1';
      removeBtn.dataset.botSocketId = player.socketId;
      rightSide.appendChild(removeBtn);
    }

    playerRow.appendChild(rightSide);

    container.appendChild(playerRow);
  });

  // Show empty slots
  for (let i = players.length; i < 4; i++) {
    const emptyRow = document.createElement('div');
    emptyRow.style.display = 'flex';
    emptyRow.style.justifyContent = 'space-between';
    emptyRow.style.alignItems = 'center';
    emptyRow.style.padding = '8px 0';
    emptyRow.style.borderBottom = i < 3 ? '1px solid #374151' : 'none';

    const emptySpan = document.createElement('span');
    emptySpan.innerText = '— Empty Slot —';
    emptySpan.style.fontSize = '16px';
    emptySpan.style.color = '#6b7280';
    emptySpan.style.fontStyle = 'italic';
    emptyRow.appendChild(emptySpan);

    container.appendChild(emptyRow);
  }

  // Sync local ready state with server data
  const myPlayer = players.find((p) => p.username === currentUsername);
  if (myPlayer) {
    isPlayerReady = myPlayer.ready;
  }

  // Update Ready button state
  const readyBtn = document.getElementById('lobbyReadyBtn');
  if (readyBtn) {
    if (players.length < 4) {
      // Not enough players - disable button
      readyBtn.disabled = true;
      readyBtn.style.background = '#6b7280';
      readyBtn.style.cursor = 'not-allowed';
      readyBtn.innerText = `Waiting for ${4 - players.length} more...`;
    } else if (isPlayerReady) {
      // Player is ready - show ready state
      readyBtn.disabled = false;
      readyBtn.innerText = 'Ready!';
      readyBtn.style.background = '#22c55e';
      readyBtn.style.cursor = 'pointer';
    } else {
      // Player is not ready - show ready button
      readyBtn.disabled = false;
      readyBtn.style.background = '#4ade80';
      readyBtn.style.cursor = 'pointer';
      readyBtn.innerText = 'Ready';
    }
  }

  // Update Add Bot button visibility
  const addBotBtn = document.getElementById('lobbyAddBotBtn');
  if (addBotBtn) {
    if (players.length >= 4) {
      addBotBtn.style.display = 'none';
    } else {
      addBotBtn.style.display = 'inline-block';
    }
  }
}

/**
 * Show the game lobby screen.
 *
 * @param {Object} lobbyData - Lobby data (lobbyId, players, messages)
 * @param {Object} socket - Socket instance
 * @param {string} username - Current player's username
 */
export function showGameLobby(lobbyData, socket, username) {
  console.log('Showing game lobby...', lobbyData);
  currentLobbyId = lobbyData.lobbyId;
  isPlayerReady = false;

  // Remove any existing game lobby
  let oldGameLobby = document.getElementById('gameLobbyContainer');
  if (oldGameLobby) oldGameLobby.remove();

  // Create container
  const container = document.createElement('div');
  container.id = 'gameLobbyContainer';
  container.style.position = 'fixed';
  container.style.top = '50%';
  container.style.left = '50%';
  container.style.transform = 'translate(-50%, -50%)';
  container.style.background = 'rgba(26, 26, 46, 0.95)';
  container.style.color = '#fff';
  container.style.padding = '30px';
  container.style.borderRadius = '12px';
  container.style.border = '2px solid #4a5568';
  container.style.fontSize = '16px';
  container.style.width = '400px';
  container.style.maxWidth = '90vw';
  container.style.boxSizing = 'border-box';
  container.style.overflow = 'hidden';
  container.style.fontFamily = 'Arial, sans-serif';
  container.style.textAlign = 'center';
  container.style.zIndex = '1000';

  // Header
  const header = document.createElement('div');
  header.innerText = 'Game Lobby';
  header.style.fontSize = '28px';
  header.style.fontWeight = 'bold';
  header.style.marginBottom = '20px';
  header.style.color = '#4ade80';
  container.appendChild(header);

  // Players list
  const playersDiv = document.createElement('div');
  playersDiv.id = 'lobbyPlayersList';
  playersDiv.style.marginBottom = '20px';
  playersDiv.style.textAlign = 'left';
  playersDiv.style.padding = '15px';
  playersDiv.style.background = 'rgba(0, 0, 0, 0.3)';
  playersDiv.style.borderRadius = '8px';
  updateLobbyPlayersList(playersDiv, lobbyData.players, username);
  // Delegated click handler for bot remove buttons
  playersDiv.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-bot-socket-id]');
    if (removeBtn) {
      socket.emit('removeBot', { botSocketId: removeBtn.dataset.botSocketId });
    }
  });
  container.appendChild(playersDiv);

  // Chat area
  const chatArea = document.createElement('div');
  chatArea.id = 'lobbyChatArea';
  chatArea.style.height = '150px';
  chatArea.style.overflowY = 'auto';
  chatArea.style.overflowX = 'hidden';
  chatArea.style.background = 'rgba(0, 0, 0, 0.4)';
  chatArea.style.borderRadius = '8px';
  chatArea.style.padding = '10px';
  chatArea.style.marginBottom = '15px';
  chatArea.style.textAlign = 'left';
  chatArea.style.fontSize = '14px';
  chatArea.style.wordBreak = 'break-word';
  chatArea.style.overflowWrap = 'break-word';

  // Add any existing messages
  if (lobbyData.messages) {
    // Pre-populate colors for historical message authors
    lobbyData.messages.forEach((msg) => {
      if (!lobbyUserColors[msg.username]) {
        lobbyUserColors[msg.username] = generateDistinctColor(
          msg.username,
          Object.values(lobbyUserColors)
        );
      }
    });
    lobbyData.messages.forEach((msg) => {
      const msgDiv = document.createElement('div');
      msgDiv.style.marginBottom = '8px';
      msgDiv.style.wordWrap = 'break-word';

      const nameSpan = document.createElement('span');
      nameSpan.innerText = msg.username + ': ';
      nameSpan.style.fontWeight = 'bold';
      nameSpan.style.color = lobbyUserColors[msg.username] || getUsernameColor(msg.username);
      msgDiv.appendChild(nameSpan);

      const textSpan = document.createElement('span');
      textSpan.innerText = msg.message;
      textSpan.style.color = '#e5e7eb';
      msgDiv.appendChild(textSpan);

      chatArea.appendChild(msgDiv);
    });
  }
  container.appendChild(chatArea);

  // Chat input row
  const chatInputRow = document.createElement('div');
  chatInputRow.style.display = 'flex';
  chatInputRow.style.gap = '10px';
  chatInputRow.style.marginBottom = '20px';

  const chatInput = document.createElement('input');
  chatInput.id = 'lobbyChatInput';
  chatInput.type = 'text';
  chatInput.placeholder = 'Type a message...';
  chatInput.style.flex = '1';
  chatInput.style.padding = '10px';
  chatInput.style.borderRadius = '6px';
  chatInput.style.border = '1px solid #4a5568';
  chatInput.style.background = '#2d3748';
  chatInput.style.color = '#fff';
  chatInput.style.fontSize = '14px';
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && chatInput.value.trim()) {
      socket.emit('lobbyChat', { message: chatInput.value.trim() });
      chatInput.value = '';
    }
  });
  chatInputRow.appendChild(chatInput);

  const sendBtn = document.createElement('button');
  sendBtn.innerText = 'Send';
  sendBtn.style.padding = '10px 20px';
  sendBtn.style.borderRadius = '6px';
  sendBtn.style.border = 'none';
  sendBtn.style.background = '#3b82f6';
  sendBtn.style.color = '#fff';
  sendBtn.style.cursor = 'pointer';
  sendBtn.addEventListener('click', () => {
    if (chatInput.value.trim()) {
      socket.emit('lobbyChat', { message: chatInput.value.trim() });
      chatInput.value = '';
    }
  });
  chatInputRow.appendChild(sendBtn);
  container.appendChild(chatInputRow);

  // Button row
  const buttonRow = document.createElement('div');
  buttonRow.style.display = 'flex';
  buttonRow.style.gap = '15px';
  buttonRow.style.justifyContent = 'center';
  buttonRow.style.flexWrap = 'wrap';

  const readyBtn = document.createElement('button');
  readyBtn.id = 'lobbyReadyBtn';
  readyBtn.style.padding = '15px 40px';
  readyBtn.style.fontSize = '18px';
  readyBtn.style.fontWeight = 'bold';
  readyBtn.style.borderRadius = '8px';
  readyBtn.style.border = 'none';
  readyBtn.style.color = '#000';

  // Set initial state based on player count
  const playerCount = lobbyData.players ? lobbyData.players.length : 0;
  if (playerCount < 4) {
    readyBtn.innerText = `Waiting for ${4 - playerCount} more...`;
    readyBtn.style.background = '#6b7280';
    readyBtn.style.cursor = 'not-allowed';
    readyBtn.disabled = true;
  } else {
    readyBtn.innerText = 'Ready';
    readyBtn.style.background = '#4ade80';
    readyBtn.style.cursor = 'pointer';
    readyBtn.disabled = false;
  }

  readyBtn.addEventListener('click', () => {
    if (readyBtn.disabled) return;

    if (!isPlayerReady) {
      socket.emit('playerReady');
      readyBtn.innerText = 'Ready!';
      readyBtn.style.background = '#22c55e';
      readyBtn.style.cursor = 'pointer';
      isPlayerReady = true;
    } else {
      socket.emit('playerUnready');
      readyBtn.innerText = 'Ready';
      readyBtn.style.background = '#4ade80';
      readyBtn.style.cursor = 'pointer';
      isPlayerReady = false;
    }
  });
  buttonRow.appendChild(readyBtn);

  // Add Bot button
  const addBotBtn = document.createElement('button');
  addBotBtn.id = 'lobbyAddBotBtn';
  addBotBtn.innerText = '+ Add Bot';
  addBotBtn.style.padding = '15px 25px';
  addBotBtn.style.fontSize = '16px';
  addBotBtn.style.borderRadius = '8px';
  addBotBtn.style.border = 'none';
  addBotBtn.style.background = '#6366f1';
  addBotBtn.style.color = '#fff';
  addBotBtn.style.cursor = 'pointer';
  addBotBtn.style.fontWeight = 'bold';

  // Hide if lobby is full
  if (playerCount >= 4) {
    addBotBtn.style.display = 'none';
  }

  addBotBtn.addEventListener('click', () => {
    socket.emit('addBot');
  });
  buttonRow.appendChild(addBotBtn);

  const leaveBtn = document.createElement('button');
  leaveBtn.innerText = 'Leave';
  leaveBtn.style.padding = '15px 30px';
  leaveBtn.style.fontSize = '18px';
  leaveBtn.style.borderRadius = '8px';
  leaveBtn.style.border = 'none';
  leaveBtn.style.background = '#dc2626';
  leaveBtn.style.color = '#fff';
  leaveBtn.style.cursor = 'pointer';
  leaveBtn.style.flexShrink = '0';
  leaveBtn.style.textAlign = 'center';
  leaveBtn.addEventListener('click', () => {
    socket.emit('leaveLobby');
  });
  buttonRow.appendChild(leaveBtn);
  container.appendChild(buttonRow);

  document.body.appendChild(container);
}

/**
 * Add a chat message to the lobby.
 *
 * @param {string} username - Message author
 * @param {string} message - Message content
 */
export function addLobbyChatMessage(username, message) {
  const chatArea = document.getElementById('lobbyChatArea');
  if (!chatArea) return;

  // Assign distinct color if new user
  if (!lobbyUserColors[username]) {
    lobbyUserColors[username] = generateDistinctColor(
      username,
      Object.values(lobbyUserColors)
    );
  }

  const msgDiv = document.createElement('div');
  msgDiv.style.marginBottom = '8px';
  msgDiv.style.wordWrap = 'break-word';

  const nameSpan = document.createElement('span');
  nameSpan.innerText = username + ': ';
  nameSpan.style.fontWeight = 'bold';
  nameSpan.style.color = lobbyUserColors[username] || getUsernameColor(username);
  msgDiv.appendChild(nameSpan);

  const textSpan = document.createElement('span');
  textSpan.innerText = message;
  textSpan.style.color = '#e5e7eb';
  msgDiv.appendChild(textSpan);

  chatArea.appendChild(msgDiv);
  chatArea.scrollTop = chatArea.scrollHeight;
}

/**
 * Remove the game lobby screen.
 */
export function removeGameLobby() {
  const gameLobby = document.getElementById('gameLobbyContainer');
  if (gameLobby) gameLobby.remove();
  currentLobbyId = null;
  isPlayerReady = false;
  lobbyUserColors = {};
}

/**
 * Get the current lobby ID.
 *
 * @returns {string|null} Current lobby ID
 */
export function getCurrentLobbyId() {
  return currentLobbyId;
}

/**
 * Check if the player is ready.
 *
 * @returns {boolean} Ready status
 */
export function getIsPlayerReady() {
  return isPlayerReady;
}

/**
 * Get the lobby user colors map (for external access).
 *
 * @returns {Object} Map of username to color
 */
export function getLobbyUserColors() {
  return lobbyUserColors;
}
