/**
 * Game Lobby Screen
 *
 * Pre-game lobby where 4 players gather, chat, and ready up before starting.
 * Kit classes and tokens only (styles/screens.css, item 18b).
 */

import { generateDistinctColor } from '../../utils/colors.js';
import { el, createButton, createIconButton, createPanel } from '../kit/index.js';
import { chatLine, chatForm, setButtonVariant, appendChatLine, scrollChatToEnd, followChatOnResize } from './common.js';

/** The lobby header's voice slot (VoiceChatUI.js places the voice buttons in it). */
export const LOBBY_VOICE_SLOT_ID = 'lobbyVoiceSlot';

/**
 * Module state.
 */
let lobbyUserColors = {};
let currentLobbyId = null;
let isPlayerReady = false;
// Players whose seat the server holds while they reconnect (a reload or a
// short drop: GameManager.LOBBY_SEAT_GRACE_MS). playerReadyUpdate and
// lobbyCreated carry the list while one is held (absent: none);
// lobbyPlayerJoined / lobbyPlayerLeft drop the player who came back or left
let reconnecting = new Set();

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
 * @param {Object} [held] - the seats held for a reconnect
 * @param {string[]} [held.reconnecting] - the event's list (replaces the one kept)
 * @param {string} [held.returned] - a player back in their held seat
 */
export function updateLobbyPlayersList(container, players, currentUsername, { reconnecting: list, returned } = {}) {
  if (Array.isArray(list)) reconnecting = new Set(list);
  if (returned) reconnecting.delete(returned);
  const present = new Set(players.map((p) => p.username));
  for (const name of [...reconnecting]) if (!present.has(name)) reconnecting.delete(name);

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
    row.appendChild(el('span', { className: `seat-row__name${player.isBot ? ' is-bot' : ''}`, text: player.username, attrs: { title: player.username } }));

    const side = el('span', { className: 'seat-row__side' });
    const away = !player.ready && !player.isBot && reconnecting.has(player.username);
    side.appendChild(el('span', {
      className: `seat-row__status${player.ready ? ' is-ready' : ''}${away ? ' is-reconnecting' : ''}`,
      text: player.ready ? '✓ Ready' : away ? 'Reconnecting…' : 'Waiting...',
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

  // Remove any existing game lobby (a re-render: a reconnect's lobbyJoined
  // keeps the voice running, so its buttons move to the new header)
  const oldGameLobby = document.getElementById('gameLobbyContainer');
  const voiceButtons = oldGameLobby ? [...(oldGameLobby.querySelector(`#${LOBBY_VOICE_SLOT_ID}`)?.children || [])] : [];
  if (oldGameLobby) oldGameLobby.remove();

  const container = createPanel({ elevation: 3, className: 'screen screen--full screen--lobby' });
  container.id = 'gameLobbyContainer';

  // The voice slot (VoiceChatUI.js puts the mute and microphone buttons in
  // it while voice runs): in the header, clear of the chat's Send in the
  // window's bottom-right corner
  const voiceSlot = el('div', { className: 'lobby-voice', attrs: { id: LOBBY_VOICE_SLOT_ID, role: 'group', 'aria-label': 'Voice chat' } });
  voiceSlot.append(...voiceButtons);
  container.appendChild(el('header', {
    className: 'screen-header',
    children: [el('h1', { className: 'screen-title screen-title--brand', text: 'Game Lobby' }), voiceSlot],
  }));

  // The window's two columns (styles/screens.css .screen--full): the seats
  // and Ready / Add Bot / Leave on the left, the lobby chat full height on
  // the right (as on iOS). Reading and focus order follow it.
  const mainColumn = el('section', { className: 'screen-main', attrs: { 'aria-label': 'Seats' } });
  container.appendChild(mainColumn);

  // Players list
  const playersDiv = el('div', { className: 'screen-section seat-list', attrs: { id: 'lobbyPlayersList' } });
  updateLobbyPlayersList(playersDiv, lobbyData.players, username, { reconnecting: lobbyData.reconnecting || [] });
  // Delegated click handler for bot remove buttons
  playersDiv.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-bot-socket-id]');
    if (removeBtn) {
      socket.emit('removeBot', { botSocketId: removeBtn.dataset.botSocketId });
    }
  });
  mainColumn.appendChild(playersDiv);

  // Right column - the lobby chat
  const chatPanel = el('section', { className: 'screen-chat screen-section', attrs: { 'aria-label': 'Lobby chat' } });
  chatPanel.appendChild(el('h2', { className: 'section-title', text: 'Lobby Chat' }));
  const chatArea = el('div', { className: 'chat-log', attrs: { id: 'lobbyChatArea', role: 'log', 'aria-live': 'polite' } });

  // Add any existing messages
  if (lobbyData.messages) {
    // Pre-populate colors for historical message authors
    lobbyData.messages.forEach((msg) => colorFor(msg.username));
    lobbyData.messages.forEach((msg) => {
      chatArea.appendChild(chatLine({ username: msg.username, message: msg.message, color: lobbyUserColors[msg.username] }));
    });
  }
  chatPanel.appendChild(chatArea);

  const { row: chatInputRow } = chatForm({
    inputId: 'lobbyChatInput',
    label: 'Message the lobby',
    onSend: (message) => socket.emit('lobbyChat', { message }),
  });
  chatPanel.appendChild(chatInputRow);

  // Button row (under the seats)
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
  mainColumn.appendChild(buttonRow);
  container.appendChild(chatPanel);

  document.body.appendChild(container);
  // Open on the newest message and stay there through resizes
  scrollChatToEnd(chatArea);
  followChatOnResize(chatArea);
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

  // Follows the newest message unless the reader scrolled up
  appendChatLine(chatArea, chatLine({ username, message, color: lobbyUserColors[username] }));
}

/**
 * Remove the game lobby screen.
 */
export function removeGameLobby() {
  const gameLobby = document.getElementById('gameLobbyContainer');
  if (gameLobby) {
    // Lobby voice carries on into its game: its buttons outlive the lobby
    // (back to the page, until the table's HUD slot takes them, or stopVoice
    // removes them)
    const voiceSlot = gameLobby.querySelector(`#${LOBBY_VOICE_SLOT_ID}`);
    if (voiceSlot) {
      for (const btn of [...voiceSlot.children]) {
        btn.dataset.place = 'page';
        document.body.appendChild(btn);
      }
    }
    gameLobby.remove();
  }
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
