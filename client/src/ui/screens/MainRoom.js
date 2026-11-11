/**
 * Main Room Screen
 *
 * Displays the main lobby with global chat and game lobby browser.
 * Kit classes and tokens only (styles/screens.css, item 18b); every user
 * string (names, chat, lobby and tournament names) goes in as text.
 */

import { generateDistinctColor } from '../../utils/colors.js';
import { el, createButton, createPanel } from '../kit/index.js';
import { chatLine, chatForm } from './common.js';
import { showPlayerSearchPage } from './PlayerSearchPage.js';

/**
 * Module state - tracks user colors for consistent display.
 */
let mainRoomUserColors = {};
let currentOnlineUsers = [];

function colorFor(username) {
  if (!mainRoomUserColors[username]) {
    mainRoomUserColors[username] = generateDistinctColor(username, Object.values(mainRoomUserColors));
  }
  return mainRoomUserColors[username];
}

/**
 * Create a chat message element.
 *
 * @param {string} username - Message author
 * @param {string} message - Message content
 * @returns {HTMLElement} Message div element
 */
function createChatMessageElement(username, message, timestamp) {
  return chatLine({ username, message, timestamp, color: mainRoomUserColors[username] || null });
}

function sectionHeading(text) {
  return el('div', { className: 'room-list__heading', text });
}

function roomCard(className = '') {
  return el('div', { className: ['room-card', className].filter(Boolean).join(' ') });
}

function cardHead(name, side) {
  return el('div', { className: 'room-card__head', children: [el('span', { className: 'room-card__name', text: name }), side] });
}

/** The lobby card's button: Join (open seat), else a disabled Full. */
function lobbyActionButton(lobby, socket) {
  if (lobby.playerCount >= 4) {
    return createButton({ label: 'Full', variant: 'secondary', size: 'sm', className: 'is-block', attrs: { disabled: true } });
  }
  return createButton({
    label: 'Join',
    variant: 'primary',
    size: 'sm',
    className: 'is-block',
    onClick: () => socket.emit('joinLobby', { lobbyId: lobby.id }),
  });
}

/**
 * Update lobby list content in container.
 *
 * @param {HTMLElement} container - Container element
 * @param {Array} lobbies - Array of lobby data
 * @param {Object} socket - Socket instance for join events
 * @param {Array} inProgressGames - Array of in-progress game data for spectating
 */
function updateLobbyListContent(container, lobbies, socket, inProgressGames = [], tournaments = []) {
  container.replaceChildren();

  const hasContent = (lobbies && lobbies.length > 0) || (inProgressGames && inProgressGames.length > 0) || (tournaments && tournaments.length > 0);

  if (!hasContent) {
    container.appendChild(el('div', { className: 'muted-note', text: 'No active lobbies. Create one!' }));
    return;
  }

  // Render lobbies (waiting for players)
  if (lobbies && lobbies.length > 0) {
    lobbies.forEach((lobby) => {
      const card = roomCard();
      card.dataset.lobbyId = lobby.id;
      const full = lobby.playerCount >= 4;
      const count = el('span', { className: `room-card__count ${full ? 'is-full' : 'is-open'}`, text: `${lobby.playerCount}/4` });
      card.appendChild(cardHead(lobby.name || `Lobby ${lobby.id.slice(0, 6)}`, count));
      card.appendChild(el('div', { className: 'room-card__meta', text: (lobby.players || []).map((p) => p.username).join(', ') }));
      card.appendChild(lobbyActionButton(lobby, socket));
      container.appendChild(card);
    });
  }

  // Render in-progress games (spectatable)
  if (inProgressGames && inProgressGames.length > 0) {
    container.appendChild(sectionHeading('In-Progress Games'));

    inProgressGames.forEach((game) => {
      const card = roomCard();
      const name = game.players.map((p) => p.username).slice(0, 2).join(' vs ');
      card.appendChild(cardHead(name, el('span', { className: 'room-card__count', text: `Hand: ${game.currentHand}` })));

      // Score + player names, in the team colors (positions 1 & 3 vs 2 & 4)
      const t1Players = game.players.filter((p) => p.position === 1 || p.position === 3).map((p) => p.username).join('/');
      const t2Players = game.players.filter((p) => p.position === 2 || p.position === 4).map((p) => p.username).join('/');
      const detail = el('div', {
        className: 'room-card__meta',
        children: [
          el('span', { className: 'team-a', text: `${t1Players}: ${game.score.team1}` }),
          document.createTextNode(' | '),
          el('span', { className: 'team-b', text: `${t2Players}: ${game.score.team2}` }),
        ],
      });
      if (game.spectatorCount > 0) detail.appendChild(document.createTextNode(` | ${game.spectatorCount} watching`));
      card.appendChild(detail);

      card.appendChild(createButton({
        label: 'Spectate',
        variant: 'secondary',
        size: 'sm',
        className: 'is-block',
        onClick: () => socket.emit('joinAsSpectator', { gameId: game.gameId }),
      }));
      container.appendChild(card);
    });
  }

  // Render tournaments
  if (tournaments && tournaments.length > 0) {
    container.appendChild(sectionHeading('Tournaments'));

    tournaments.forEach((tournament) => {
      const card = roomCard();
      card.appendChild(cardHead(tournament.name || 'Tournament', el('span', { className: 'room-card__count', text: `${tournament.playerCount} players` })));

      let detail;
      if (tournament.phase === 'lobby') {
        detail = 'Waiting for players';
      } else if (tournament.phase === 'between_rounds') {
        detail = `Between rounds (${tournament.currentRound}/${tournament.totalRounds})`;
      } else if (tournament.phase === 'round_active') {
        detail = `Round ${tournament.currentRound} of ${tournament.totalRounds} in progress`;
      } else {
        detail = 'Complete';
      }
      card.appendChild(el('div', { className: 'room-card__meta', text: detail }));

      let btn;
      if (tournament.phase === 'lobby') {
        // New entrants can only join before the tournament starts; returning
        // members are re-attached automatically at sign-in
        btn = createButton({
          label: 'Join', variant: 'primary', size: 'sm', className: 'is-block',
          onClick: () => socket.emit('joinTournament', { tournamentId: tournament.id }),
        });
      } else if (tournament.phase === 'round_active' || tournament.phase === 'between_rounds') {
        btn = createButton({
          label: 'Spectate', variant: 'secondary', size: 'sm', className: 'is-block',
          onClick: () => socket.emit('spectateTournament', { tournamentId: tournament.id }),
        });
      } else {
        btn = createButton({ label: 'Finished', variant: 'secondary', size: 'sm', className: 'is-block', attrs: { disabled: true } });
      }
      card.appendChild(btn);
      container.appendChild(card);
    });
  }
}

function renderOnlinePopover(popover) {
  if (!popover) return;
  popover.replaceChildren(...currentOnlineUsers.map((username) => el('div', { className: 'online-popover__row', text: username })));
}

/**
 * Show the main room screen.
 *
 * @param {Object} data - Main room data (onlineCount, messages, lobbies)
 * @param {Object} socket - Socket instance
 */
export function showMainRoom(data, socket) {
  console.log('Showing main room...', data);

  // Defensively clean up sign-in/register screens that may still be in the DOM
  ['sign-in-container', 'sign-in-vignette', 'signInContainer', 'SignInVignette',
    'register-container', 'register-vignette', 'registerContainer', 'RegisterVignette',
  ].forEach((id) => {
    const node = document.getElementById(id);
    if (node) node.remove();
  });

  // Remove any existing UI
  removeMainRoom();

  // Fresh color assignments for new main room session
  mainRoomUserColors = {};

  const container = createPanel({ elevation: 3, className: 'screen screen--main-room' });
  container.id = 'mainRoomContainer';

  // Header row: title, page buttons, online count
  const nav = el('nav', { className: 'screen-nav', attrs: { 'aria-label': 'Main room' } });
  const navButton = (label, onClick) => nav.appendChild(createButton({ label, variant: 'secondary', size: 'sm', onClick }));
  navButton('Leaderboard', () => socket.emit('getLeaderboard'));
  navButton('Records', () => socket.emit('getRecords'));
  navButton('Players', () => showPlayerSearchPage(socket));
  navButton('Profile', () => socket.emit('getProfile'));

  // Store online users from initial data
  currentOnlineUsers = data.onlineUsers || [];

  // The count is a button so the player list opens on focus as well as hover
  const onlineWrap = el('div', { className: 'online-count' });
  const onlineCount = el('button', {
    className: 'kit-btn kit-btn--ghost kit-btn--sm online-count__btn',
    attrs: { type: 'button', id: 'mainRoomOnlineCount', 'aria-describedby': 'onlinePlayersTooltip' },
    text: `${data.onlineCount || 0} players online`,
  });
  const popover = el('div', { className: 'online-popover', attrs: { id: 'onlinePlayersTooltip', role: 'tooltip' } });
  renderOnlinePopover(popover);
  onlineWrap.appendChild(onlineCount);
  onlineWrap.appendChild(popover);
  nav.appendChild(onlineWrap);

  container.appendChild(el('header', {
    className: 'screen-header',
    children: [el('h1', { className: 'screen-title screen-title--brand', text: 'BAB Online' }), nav],
  }));

  // Main content area (two panels)
  const contentArea = el('div', { className: 'screen-columns' });

  // Left panel - Global Chat
  const chatPanel = el('section', { className: 'screen-column screen-column--wide screen-section', attrs: { 'aria-label': 'Global chat' } });
  chatPanel.appendChild(el('h2', { className: 'section-title', text: 'Global Chat' }));

  const chatMessages = el('div', { className: 'chat-log', attrs: { id: 'mainRoomChatMessages', role: 'log', 'aria-live': 'polite' } });

  // Add existing messages
  if (data.messages && data.messages.length > 0) {
    // Pre-populate colors for historical message authors
    data.messages.forEach((msg) => colorFor(msg.username));
    data.messages.forEach((msg) => {
      chatMessages.appendChild(createChatMessageElement(msg.username, msg.message, msg.timestamp));
    });
    setTimeout(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }, 0);
  }
  chatPanel.appendChild(chatMessages);

  const { row: chatInputRow } = chatForm({
    inputId: 'mainRoomChatInput',
    label: 'Message the main room',
    onSend: (message) => socket.emit('mainRoomChat', { message }),
  });
  chatPanel.appendChild(chatInputRow);
  contentArea.appendChild(chatPanel);

  // Right panel - Lobby Browser
  const lobbyPanel = el('section', { className: 'screen-column screen-section', attrs: { 'aria-label': 'Game lobbies' } });
  lobbyPanel.appendChild(el('h2', { className: 'section-title', text: 'Game Lobbies' }));

  lobbyPanel.appendChild(el('div', {
    className: 'room-create',
    children: [
      createButton({ label: '+ Create Game', variant: 'primary', className: 'is-block', onClick: () => socket.emit('createLobby', {}) }),
      createButton({ label: '+ Create Tournament', variant: 'secondary', className: 'is-block', onClick: () => socket.emit('createTournament') }),
    ],
  }));

  // Lobby list container
  const lobbyList = el('div', { className: 'room-list', attrs: { id: 'mainRoomLobbyList' } });

  // Populate with existing lobbies, in-progress games, and tournaments
  updateLobbyListContent(lobbyList, data.lobbies || [], socket, data.inProgressGames || [], data.tournaments || []);

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
export function addMainRoomChatMessage(username, message, timestamp) {
  const chatMessages = document.getElementById('mainRoomChatMessages');
  if (!chatMessages) return;

  // Assign distinct color if new user
  colorFor(username);

  chatMessages.appendChild(createChatMessageElement(username, message, timestamp));
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Update the lobby list.
 *
 * @param {Array} lobbies - Array of lobby data
 * @param {Object} socket - Socket instance
 * @param {Array} inProgressGames - Array of in-progress game data
 */
export function updateLobbyList(lobbies, socket, inProgressGames = [], tournaments = []) {
  const lobbyList = document.getElementById('mainRoomLobbyList');
  if (!lobbyList) return;

  updateLobbyListContent(lobbyList, lobbies, socket, inProgressGames, tournaments);
}

/**
 * Remove the main room screen.
 */
export function removeMainRoom() {
  const mainRoom = document.getElementById('mainRoomContainer');
  if (mainRoom) mainRoom.remove();
  mainRoomUserColors = {};
  currentOnlineUsers = [];
}

/**
 * Update the online player count display.
 *
 * @param {number} count - Number of online players
 * @param {Array} onlineUsers - Array of online usernames
 */
export function updateMainRoomOnlineCount(count, onlineUsers) {
  if (onlineUsers) {
    currentOnlineUsers = onlineUsers;
    renderOnlinePopover(document.getElementById('onlinePlayersTooltip'));
  }
  const countEl = document.getElementById('mainRoomOnlineCount');
  if (countEl) {
    countEl.textContent = `${count} players online`;
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
