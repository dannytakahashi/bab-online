/**
 * Main Room Screen
 *
 * Displays the main lobby with global chat and game lobby browser.
 */

import { generateDistinctColor, getUsernameColor } from '../../utils/colors.js';

/**
 * Module state - tracks user colors for consistent display.
 */
let mainRoomUserColors = {};

/**
 * Create a chat message element.
 *
 * @param {string} username - Message author
 * @param {string} message - Message content
 * @returns {HTMLElement} Message div element
 */
function createChatMessageElement(username, message) {
  const msgDiv = document.createElement('div');
  msgDiv.style.marginBottom = '8px';
  msgDiv.style.wordWrap = 'break-word';

  const nameSpan = document.createElement('span');
  nameSpan.innerText = username + ': ';
  nameSpan.style.fontWeight = 'bold';
  nameSpan.style.color = mainRoomUserColors[username] || getUsernameColor(username);
  msgDiv.appendChild(nameSpan);

  const textSpan = document.createElement('span');
  textSpan.innerText = message;
  textSpan.style.color = '#e5e7eb';
  msgDiv.appendChild(textSpan);

  return msgDiv;
}

/**
 * Update lobby list content in container.
 *
 * @param {HTMLElement} container - Container element
 * @param {Array} lobbies - Array of lobby data
 * @param {Object} socket - Socket instance for join events
 */
function updateLobbyListContent(container, lobbies, socket) {
  container.innerHTML = '';

  if (!lobbies || lobbies.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.innerText = 'No active lobbies. Create one!';
    emptyMsg.style.color = '#9ca3af';
    emptyMsg.style.fontStyle = 'italic';
    emptyMsg.style.textAlign = 'center';
    emptyMsg.style.padding = '20px';
    container.appendChild(emptyMsg);
    return;
  }

  lobbies.forEach((lobby) => {
    const lobbyCard = document.createElement('div');
    lobbyCard.style.background = 'rgba(0, 0, 0, 0.4)';
    lobbyCard.style.borderRadius = '6px';
    lobbyCard.style.padding = '12px';
    lobbyCard.style.border = '1px solid #4a5568';

    // Lobby info row
    const infoRow = document.createElement('div');
    infoRow.style.display = 'flex';
    infoRow.style.justifyContent = 'space-between';
    infoRow.style.alignItems = 'center';
    infoRow.style.marginBottom = '8px';

    const lobbyName = document.createElement('span');
    lobbyName.innerText = lobby.name || `Lobby ${lobby.id.slice(0, 6)}`;
    lobbyName.style.fontWeight = 'bold';
    lobbyName.style.color = '#fff';
    infoRow.appendChild(lobbyName);

    const playerCount = document.createElement('span');
    playerCount.innerText = `${lobby.playerCount}/4`;
    playerCount.style.color = lobby.playerCount >= 4 ? '#f87171' : '#4ade80';
    playerCount.style.fontSize = '14px';
    infoRow.appendChild(playerCount);

    lobbyCard.appendChild(infoRow);

    // Player names
    const playerNames = document.createElement('div');
    playerNames.style.fontSize = '12px';
    playerNames.style.color = '#9ca3af';
    playerNames.style.marginBottom = '8px';
    playerNames.innerText = lobby.players.map((p) => p.username).join(', ');
    lobbyCard.appendChild(playerNames);

    // Join button
    const joinBtn = document.createElement('button');
    if (lobby.playerCount >= 4) {
      joinBtn.innerText = 'Full';
      joinBtn.disabled = true;
      joinBtn.style.background = '#6b7280';
      joinBtn.style.cursor = 'not-allowed';
    } else {
      joinBtn.innerText = 'Join';
      joinBtn.style.background = '#3b82f6';
      joinBtn.style.cursor = 'pointer';
      joinBtn.addEventListener('click', () => {
        socket.emit('joinLobby', { lobbyId: lobby.id });
      });
      joinBtn.addEventListener('mouseenter', () => {
        if (!joinBtn.disabled) joinBtn.style.background = '#2563eb';
      });
      joinBtn.addEventListener('mouseleave', () => {
        if (!joinBtn.disabled) joinBtn.style.background = '#3b82f6';
      });
    }
    joinBtn.style.width = '100%';
    joinBtn.style.padding = '8px';
    joinBtn.style.borderRadius = '4px';
    joinBtn.style.border = 'none';
    joinBtn.style.color = '#fff';
    joinBtn.style.fontSize = '14px';
    joinBtn.style.fontWeight = 'bold';
    lobbyCard.appendChild(joinBtn);

    container.appendChild(lobbyCard);
  });
}

/**
 * Show the main room screen.
 *
 * @param {Object} data - Main room data (onlineCount, messages, lobbies)
 * @param {Object} socket - Socket instance
 */
export function showMainRoom(data, socket) {
  console.log('Showing main room...', data);

  // Remove any existing UI
  removeMainRoom();

  // Fresh color assignments for new main room session
  mainRoomUserColors = {};

  // Create main container
  const container = document.createElement('div');
  container.id = 'mainRoomContainer';
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
  container.style.width = '800px';
  container.style.maxWidth = '95vw';
  container.style.height = '600px';
  container.style.maxHeight = '90vh';
  container.style.boxSizing = 'border-box';
  container.style.fontFamily = 'Arial, sans-serif';
  container.style.zIndex = '1000';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';

  // Header row
  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.marginBottom = '20px';

  const header = document.createElement('div');
  header.innerText = 'BAB Online';
  header.style.fontSize = '28px';
  header.style.fontWeight = 'bold';
  header.style.color = '#4ade80';
  headerRow.appendChild(header);

  // Right side container for profile button and online count
  const rightContainer = document.createElement('div');
  rightContainer.style.display = 'flex';
  rightContainer.style.alignItems = 'center';
  rightContainer.style.gap = '15px';

  // Profile button
  const profileBtn = document.createElement('button');
  profileBtn.innerText = 'Profile';
  profileBtn.style.padding = '8px 16px';
  profileBtn.style.borderRadius = '6px';
  profileBtn.style.border = 'none';
  profileBtn.style.background = '#6366f1';
  profileBtn.style.color = '#fff';
  profileBtn.style.fontSize = '14px';
  profileBtn.style.fontWeight = 'bold';
  profileBtn.style.cursor = 'pointer';
  profileBtn.addEventListener('click', () => {
    socket.emit('getProfile');
  });
  profileBtn.addEventListener('mouseenter', () => {
    profileBtn.style.background = '#4f46e5';
  });
  profileBtn.addEventListener('mouseleave', () => {
    profileBtn.style.background = '#6366f1';
  });
  rightContainer.appendChild(profileBtn);

  const onlineCount = document.createElement('div');
  onlineCount.id = 'mainRoomOnlineCount';
  onlineCount.innerText = `${data.onlineCount || 0} players online`;
  onlineCount.style.fontSize = '14px';
  onlineCount.style.color = '#9ca3af';
  rightContainer.appendChild(onlineCount);

  headerRow.appendChild(rightContainer);
  container.appendChild(headerRow);

  // Main content area (two panels)
  const contentArea = document.createElement('div');
  contentArea.style.display = 'flex';
  contentArea.style.gap = '20px';
  contentArea.style.flex = '1';
  contentArea.style.minHeight = '0';
  contentArea.style.overflow = 'hidden';

  // Left panel - Global Chat (60%)
  const chatPanel = document.createElement('div');
  chatPanel.style.flex = '1.4';
  chatPanel.style.display = 'flex';
  chatPanel.style.flexDirection = 'column';
  chatPanel.style.background = 'rgba(0, 0, 0, 0.3)';
  chatPanel.style.borderRadius = '8px';
  chatPanel.style.padding = '15px';
  chatPanel.style.minHeight = '0';

  const chatHeader = document.createElement('div');
  chatHeader.innerText = 'Global Chat';
  chatHeader.style.fontSize = '18px';
  chatHeader.style.fontWeight = 'bold';
  chatHeader.style.marginBottom = '10px';
  chatHeader.style.color = '#60a5fa';
  chatPanel.appendChild(chatHeader);

  const chatMessages = document.createElement('div');
  chatMessages.id = 'mainRoomChatMessages';
  chatMessages.style.flex = '1';
  chatMessages.style.overflowY = 'auto';
  chatMessages.style.overflowX = 'hidden';
  chatMessages.style.background = 'rgba(0, 0, 0, 0.4)';
  chatMessages.style.borderRadius = '6px';
  chatMessages.style.padding = '10px';
  chatMessages.style.marginBottom = '10px';
  chatMessages.style.fontSize = '14px';
  chatMessages.style.wordBreak = 'break-word';

  // Add existing messages
  if (data.messages && data.messages.length > 0) {
    // Pre-populate colors for historical message authors
    data.messages.forEach((msg) => {
      if (!mainRoomUserColors[msg.username]) {
        mainRoomUserColors[msg.username] = generateDistinctColor(
          msg.username,
          Object.values(mainRoomUserColors)
        );
      }
    });
    data.messages.forEach((msg) => {
      const msgDiv = createChatMessageElement(msg.username, msg.message);
      chatMessages.appendChild(msgDiv);
    });
    setTimeout(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 0);
  }
  chatPanel.appendChild(chatMessages);

  // Chat input row
  const chatInputRow = document.createElement('div');
  chatInputRow.style.display = 'flex';
  chatInputRow.style.gap = '10px';

  const chatInput = document.createElement('input');
  chatInput.id = 'mainRoomChatInput';
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
      socket.emit('mainRoomChat', { message: chatInput.value.trim() });
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
      socket.emit('mainRoomChat', { message: chatInput.value.trim() });
      chatInput.value = '';
    }
  });
  chatInputRow.appendChild(sendBtn);
  chatPanel.appendChild(chatInputRow);

  contentArea.appendChild(chatPanel);

  // Right panel - Lobby Browser (40%)
  const lobbyPanel = document.createElement('div');
  lobbyPanel.style.flex = '1';
  lobbyPanel.style.display = 'flex';
  lobbyPanel.style.flexDirection = 'column';
  lobbyPanel.style.background = 'rgba(0, 0, 0, 0.3)';
  lobbyPanel.style.borderRadius = '8px';
  lobbyPanel.style.padding = '15px';
  lobbyPanel.style.minHeight = '0';

  const lobbyHeader = document.createElement('div');
  lobbyHeader.innerText = 'Game Lobbies';
  lobbyHeader.style.fontSize = '18px';
  lobbyHeader.style.fontWeight = 'bold';
  lobbyHeader.style.marginBottom = '10px';
  lobbyHeader.style.color = '#4ade80';
  lobbyPanel.appendChild(lobbyHeader);

  // Create Game button
  const createGameBtn = document.createElement('button');
  createGameBtn.innerText = '+ Create Game';
  createGameBtn.style.width = '100%';
  createGameBtn.style.padding = '12px';
  createGameBtn.style.marginBottom = '15px';
  createGameBtn.style.borderRadius = '6px';
  createGameBtn.style.border = 'none';
  createGameBtn.style.background = '#4ade80';
  createGameBtn.style.color = '#000';
  createGameBtn.style.fontSize = '16px';
  createGameBtn.style.fontWeight = 'bold';
  createGameBtn.style.cursor = 'pointer';
  createGameBtn.addEventListener('click', () => {
    socket.emit('createLobby', {});
  });
  createGameBtn.addEventListener('mouseenter', () => {
    createGameBtn.style.background = '#22c55e';
  });
  createGameBtn.addEventListener('mouseleave', () => {
    createGameBtn.style.background = '#4ade80';
  });
  lobbyPanel.appendChild(createGameBtn);

  // Lobby list container
  const lobbyList = document.createElement('div');
  lobbyList.id = 'mainRoomLobbyList';
  lobbyList.style.flex = '1';
  lobbyList.style.overflowY = 'auto';
  lobbyList.style.display = 'flex';
  lobbyList.style.flexDirection = 'column';
  lobbyList.style.gap = '10px';

  // Populate with existing lobbies
  updateLobbyListContent(lobbyList, data.lobbies || [], socket);

  lobbyPanel.appendChild(lobbyList);
  contentArea.appendChild(lobbyPanel);

  container.appendChild(contentArea);
  document.body.appendChild(container);
}

/**
 * Add a chat message to the main room.
 *
 * @param {string} username - Message author
 * @param {string} message - Message content
 */
export function addMainRoomChatMessage(username, message) {
  const chatMessages = document.getElementById('mainRoomChatMessages');
  if (!chatMessages) return;

  // Assign distinct color if new user
  if (!mainRoomUserColors[username]) {
    mainRoomUserColors[username] = generateDistinctColor(
      username,
      Object.values(mainRoomUserColors)
    );
  }

  const msgDiv = createChatMessageElement(username, message);
  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Update the lobby list.
 *
 * @param {Array} lobbies - Array of lobby data
 * @param {Object} socket - Socket instance
 */
export function updateLobbyList(lobbies, socket) {
  const lobbyList = document.getElementById('mainRoomLobbyList');
  if (!lobbyList) return;

  updateLobbyListContent(lobbyList, lobbies, socket);
}

/**
 * Remove the main room screen.
 */
export function removeMainRoom() {
  const mainRoom = document.getElementById('mainRoomContainer');
  if (mainRoom) mainRoom.remove();
  mainRoomUserColors = {};
}

/**
 * Update the online player count display.
 *
 * @param {number} count - Number of online players
 */
export function updateMainRoomOnlineCount(count) {
  const countEl = document.getElementById('mainRoomOnlineCount');
  if (countEl) {
    countEl.innerText = `${count} players online`;
  }
}

/**
 * Get the current user colors map (for external access).
 *
 * @returns {Object} Map of username to color
 */
export function getMainRoomUserColors() {
  return mainRoomUserColors;
}
