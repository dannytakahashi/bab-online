/**
 * Game Lobby Screen
 *
 * Pre-game lobby where 4 players gather, chat, and ready up before starting.
 * Kit classes and tokens only (styles/screens.css, item 18b).
 */

import { generateDistinctColor } from '../../utils/colors.js';
import { el, createButton, createIconButton, createPanel } from '../kit/index.js';
import { chatLine, chatForm, setButtonVariant } from './common.js';

/**
 * Module state.
 */
let lobbyUserColors = {};
let currentLobbyId = null;
let isPlayerReady = false;

const REMOVE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>';

function colorFor(username) {
  if (!lobbyUserColors[username]) {
    lobbyUserColors[username] = generateDistinctColor(username, Object.values(lobbyUserColors));
  }
  return lobbyUserColors[username];
}

/** The Ready button's look for its state (waiting / ready / not ready). */
function renderReadyButton(readyBtn, playerCount) {
  if (!readyBtn) return;
  if (playerCount < 4) {
    // Not enough players - disable button
    readyBtn.disabled = true;
    setButtonVariant(readyBtn, 'secondary');
    readyBtn.classList.remove('is-on');
    readyBtn.textContent = `Waiting for ${4 - playerCount} more...`;
  } else if (isPlayerReady) {
    readyBtn.disabled = false;
    setButtonVariant(readyBtn, 'secondary');
    readyBtn.classList.add('is-on');
    readyBtn.textContent = 'Ready!';
  } else {
    readyBtn.disabled = false;
    setButtonVariant(readyBtn, 'primary');
    readyBtn.classList.remove('is-on');
    readyBtn.textContent = 'Ready';
  }
  readyBtn.setAttribute('aria-pressed', String(playerCount >= 4 && isPlayerReady));
}

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

  container.replaceChildren();

  // Assign colors to new players - existing players keep their color for the session
  players.forEach((player) => colorFor(player.username));

  // Header with player count
  container.appendChild(el('div', { className: 'section-label', text: `Players (${players.length}/4):` }));

  // Show existing players
  players.forEach((player) => {
    const row = el('div', { className: 'seat-row' });
    row.appendChild(el('span', { className: `seat-row__name${player.isBot ? ' is-bot' : ''}`, text: player.username }));

    const side = el('span', { className: 'seat-row__side' });
    side.appendChild(el('span', {
      className: `seat-row__status${player.ready ? ' is-ready' : ''}`,
      text: player.ready ? '✓ Ready' : 'Waiting...',
    }));

    // Add remove button for bot players, or invisible spacer for alignment
    if (!player.ready) {
      if (player.isBot) {
        const removeBtn = createIconButton({ icon: REMOVE_ICON, label: `Remove ${player.username}`, className: 'seat-remove' });
        removeBtn.title = 'Remove bot';
        removeBtn.dataset.botSocketId = player.socketId;
        side.appendChild(removeBtn);
      } else {
        side.appendChild(el('span', { className: 'seat-remove-spacer', attrs: { 'aria-hidden': 'true' } }));
      }
    }

    row.appendChild(side);
    container.appendChild(row);
  });

  // Show empty slots
  for (let i = players.length; i < 4; i++) {
    container.appendChild(el('div', {
      className: 'seat-row seat-row--empty',
      children: [el('span', { className: 'seat-row__name', text: '— Empty Slot —' })],
    }));
  }

  // Sync local ready state with server data
  const myPlayer = players.find((p) => p.username === currentUsername);
  if (myPlayer) {
    isPlayerReady = myPlayer.ready;
  }

  // Update Ready button state
  renderReadyButton(document.getElementById('lobbyReadyBtn'), players.length);

  // Update Add Bot button visibility
  const addBotBtn = document.getElementById('lobbyAddBotBtn');
  if (addBotBtn) addBotBtn.hidden = players.length >= 4;
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
  const oldGameLobby = document.getElementById('gameLobbyContainer');
  if (oldGameLobby) oldGameLobby.remove();

  const container = createPanel({ elevation: 3, className: 'screen screen--lobby' });
  container.id = 'gameLobbyContainer';

  container.appendChild(el('header', {
    className: 'screen-header',
    children: [el('h1', { className: 'screen-title screen-title--brand', text: 'Game Lobby' })],
  }));

  // Players list
  const playersDiv = el('div', { className: 'screen-section seat-list', attrs: { id: 'lobbyPlayersList' } });
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
  const chatArea = el('div', { className: 'chat-log chat-log--short', attrs: { id: 'lobbyChatArea', role: 'log', 'aria-live': 'polite' } });

  // Add any existing messages
  if (lobbyData.messages) {
    // Pre-populate colors for historical message authors
    lobbyData.messages.forEach((msg) => colorFor(msg.username));
    lobbyData.messages.forEach((msg) => {
      chatArea.appendChild(chatLine({ username: msg.username, message: msg.message, color: lobbyUserColors[msg.username] }));
    });
  }
  container.appendChild(chatArea);

  const { row: chatInputRow } = chatForm({
    inputId: 'lobbyChatInput',
    label: 'Message the lobby',
    onSend: (message) => socket.emit('lobbyChat', { message }),
  });
  container.appendChild(chatInputRow);

  // Button row
  const buttonRow = el('div', { className: 'screen-actions' });

  const readyBtn = createButton({ label: 'Ready', variant: 'primary', size: 'lg' });
  readyBtn.id = 'lobbyReadyBtn';

  // Set initial state based on player count
  const playerCount = lobbyData.players ? lobbyData.players.length : 0;
  renderReadyButton(readyBtn, playerCount);

  readyBtn.addEventListener('click', () => {
    if (readyBtn.disabled) return;

    if (!isPlayerReady) {
      socket.emit('playerReady');
      isPlayerReady = true;
    } else {
      socket.emit('playerUnready');
      isPlayerReady = false;
    }
    renderReadyButton(readyBtn, 4);
  });
  buttonRow.appendChild(readyBtn);

  // Add Bot button (hidden once the lobby is full)
  const addBotBtn = createButton({ label: '+ Add Bot', variant: 'secondary', size: 'lg', onClick: () => socket.emit('addBot') });
  addBotBtn.id = 'lobbyAddBotBtn';
  addBotBtn.hidden = playerCount >= 4;
  buttonRow.appendChild(addBotBtn);

  buttonRow.appendChild(createButton({ label: 'Leave', variant: 'secondary', size: 'lg', onClick: () => socket.emit('leaveLobby') }));
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
  colorFor(username);

  chatArea.appendChild(chatLine({ username, message, color: lobbyUserColors[username] }));
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
