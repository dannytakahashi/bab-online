/**
 * Tournament Lobby Screen
 *
 * Lobby for tournament players to gather, chat, ready up, and view scoreboard.
 * Supports unbounded player count (unlike the 4-player GameLobby).
 */

import { generateDistinctColor, getUsernameColor } from '../../utils/colors.js';
import { createTournamentScoreboard } from '../components/TournamentScoreboard.js';

/**
 * Module state
 */
let tournamentUserColors = {};
let currentTournamentId = null;
let isPlayerReady = false;

/**
 * Show the tournament lobby screen.
 *
 * @param {Object} data - Tournament state from server
 * @param {Object} socket - Socket instance
 * @param {string} username - Current player's username
 */
export function showTournamentLobby(data, socket, username) {
  console.log('Showing tournament lobby...', data);
  currentTournamentId = data.tournamentId;
  isPlayerReady = false;

  // Remove any existing tournament lobby
  removeTournamentLobby();

  const isSpectator = data.isSpectator || false;
  const isCreator = data.creatorUsername === username;

  // Create container
  const container = document.createElement('div');
  container.id = 'tournamentLobbyContainer';
  container.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(26, 26, 46, 0.95);
    color: #fff;
    padding: 25px;
    border-radius: 12px;
    border: 2px solid #fbbf24;
    font-size: 16px;
    width: 800px;
    max-width: 95vw;
    height: 650px;
    max-height: 90vh;
    box-sizing: border-box;
    font-family: Arial, sans-serif;
    z-index: 1000;
    display: flex;
    flex-direction: column;
  `;

  // Header row
  const headerRow = document.createElement('div');
  headerRow.style.cssText = `
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 15px;
    flex-shrink: 0;
  `;

  const header = document.createElement('div');
  header.style.cssText = 'font-size: 24px; font-weight: bold; color: #fbbf24;';
  header.textContent = data.name || 'Tournament';
  headerRow.appendChild(header);

  // Round indicator
  const roundIndicator = document.createElement('div');
  roundIndicator.id = 'tournamentRoundIndicator';
  roundIndicator.style.cssText = 'font-size: 14px; color: #9ca3af;';
  if (data.currentRound > 0) {
    roundIndicator.textContent = `Round ${data.currentRound} of ${data.totalRounds}`;
  } else {
    roundIndicator.textContent = 'Waiting to start';
  }
  headerRow.appendChild(roundIndicator);

  container.appendChild(headerRow);

  // Main content area (two panels)
  const contentArea = document.createElement('div');
  contentArea.style.cssText = `
    display: flex;
    gap: 15px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  `;

  // Left panel — Players + Chat
  const leftPanel = document.createElement('div');
  leftPanel.style.cssText = `
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  `;

  // Players list (scrollable)
  const playersDiv = document.createElement('div');
  playersDiv.id = 'tournamentPlayersList';
  playersDiv.style.cssText = `
    max-height: 180px;
    overflow-y: auto;
    margin-bottom: 10px;
    text-align: left;
    padding: 10px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 8px;
    flex-shrink: 0;
  `;
  updateTournamentPlayersList(playersDiv, data.players, username, isCreator);
  leftPanel.appendChild(playersDiv);

  // Chat area
  const chatArea = document.createElement('div');
  chatArea.id = 'tournamentChatArea';
  chatArea.style.cssText = `
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 10px;
    text-align: left;
    font-size: 14px;
    word-break: break-word;
    min-height: 0;
  `;

  // Add existing messages
  if (data.messages) {
    data.messages.forEach(msg => {
      if (!tournamentUserColors[msg.username]) {
        tournamentUserColors[msg.username] = generateDistinctColor(
          msg.username, Object.values(tournamentUserColors)
        );
      }
    });
    data.messages.forEach(msg => {
      appendChatMessage(chatArea, msg.username, msg.message, msg.isSpectator);
    });
  }
  leftPanel.appendChild(chatArea);

  // Chat input
  const chatInputRow = document.createElement('div');
  chatInputRow.style.cssText = 'display: flex; gap: 8px; flex-shrink: 0;';

  const chatInput = document.createElement('input');
  chatInput.id = 'tournamentChatInput';
  chatInput.type = 'text';
  chatInput.placeholder = 'Type a message...';
  chatInput.style.cssText = `
    flex: 1;
    padding: 8px;
    border-radius: 6px;
    border: 1px solid #4a5568;
    background: #2d3748;
    color: #fff;
    font-size: 14px;
  `;
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && chatInput.value.trim()) {
      socket.emit('tournamentChat', { message: chatInput.value.trim() });
      chatInput.value = '';
    }
  });
  chatInputRow.appendChild(chatInput);

  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send';
  sendBtn.style.cssText = `
    padding: 8px 16px;
    border-radius: 6px;
    border: none;
    background: #3b82f6;
    color: #fff;
    cursor: pointer;
    font-size: 14px;
  `;
  sendBtn.addEventListener('click', () => {
    if (chatInput.value.trim()) {
      socket.emit('tournamentChat', { message: chatInput.value.trim() });
      chatInput.value = '';
    }
  });
  chatInputRow.appendChild(sendBtn);
  leftPanel.appendChild(chatInputRow);

  contentArea.appendChild(leftPanel);

  // Right panel — Scoreboard + Active Games
  const rightPanel = document.createElement('div');
  rightPanel.style.cssText = `
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  `;

  // Scoreboard section
  const scoreboardHeader = document.createElement('div');
  scoreboardHeader.style.cssText = 'font-size: 16px; font-weight: bold; color: #fbbf24; margin-bottom: 8px;';
  scoreboardHeader.textContent = 'Scoreboard';
  rightPanel.appendChild(scoreboardHeader);

  const scoreboardContainer = document.createElement('div');
  scoreboardContainer.id = 'tournamentScoreboardContainer';
  scoreboardContainer.style.cssText = 'flex: 1; overflow-y: auto; margin-bottom: 10px; min-height: 0;';

  const scoreboardEl = createTournamentScoreboard(
    data.scoreboard || [],
    data.currentRound,
    data.totalRounds
  );
  scoreboardContainer.appendChild(scoreboardEl);
  rightPanel.appendChild(scoreboardContainer);

  // Active games section (visible during round_active)
  const activeGamesContainer = document.createElement('div');
  activeGamesContainer.id = 'tournamentActiveGames';
  activeGamesContainer.style.cssText = `
    max-height: 150px;
    overflow-y: auto;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 8px;
    padding: 10px;
    flex-shrink: 0;
  `;
  updateActiveGames(activeGamesContainer, data.activeGames || [], socket);
  rightPanel.appendChild(activeGamesContainer);

  contentArea.appendChild(rightPanel);
  container.appendChild(contentArea);

  // Button row
  const buttonRow = document.createElement('div');
  buttonRow.id = 'tournamentButtonRow';
  buttonRow.style.cssText = `
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 15px;
    flex-shrink: 0;
  `;

  if (!isSpectator) {
    // Ready button
    const readyBtn = document.createElement('button');
    readyBtn.id = 'tournamentReadyBtn';
    readyBtn.style.cssText = `
      padding: 12px 30px;
      font-size: 16px;
      font-weight: bold;
      border-radius: 8px;
      border: none;
      color: #000;
      background: #4ade80;
      cursor: pointer;
    `;
    readyBtn.textContent = 'Ready';

    // Sync with server state
    const myPlayer = data.players?.find(p => p.username === username);
    if (myPlayer?.ready) {
      isPlayerReady = true;
      readyBtn.textContent = 'Ready!';
      readyBtn.style.background = '#22c55e';
    }

    // Hide ready button during active rounds
    if (data.phase === 'round_active') {
      readyBtn.style.display = 'none';
    }

    readyBtn.addEventListener('click', () => {
      if (!isPlayerReady) {
        socket.emit('tournamentReady');
        readyBtn.textContent = 'Ready!';
        readyBtn.style.background = '#22c55e';
        isPlayerReady = true;
      } else {
        socket.emit('tournamentUnready');
        readyBtn.textContent = 'Ready';
        readyBtn.style.background = '#4ade80';
        isPlayerReady = false;
      }
    });
    buttonRow.appendChild(readyBtn);

    // Begin Tournament / Begin Next Round (creator only)
    if (isCreator) {
      const beginBtn = document.createElement('button');
      beginBtn.id = 'tournamentBeginBtn';
      beginBtn.style.cssText = `
        padding: 12px 30px;
        font-size: 16px;
        font-weight: bold;
        border-radius: 8px;
        border: none;
        color: #fff;
        background: #6b7280;
        cursor: not-allowed;
      `;

      if (data.phase === 'lobby') {
        beginBtn.textContent = 'Begin Tournament';
        beginBtn.disabled = true;
      } else if (data.phase === 'between_rounds') {
        beginBtn.textContent = 'Begin Next Round';
        beginBtn.disabled = true;
      } else {
        beginBtn.style.display = 'none';
      }

      beginBtn.addEventListener('click', () => {
        if (beginBtn.disabled) return;
        if (data.phase === 'lobby' || currentPhase === 'lobby') {
          socket.emit('beginTournament');
        } else {
          socket.emit('beginNextRound');
        }
        beginBtn.disabled = true;
        beginBtn.style.background = '#6b7280';
        beginBtn.style.cursor = 'not-allowed';
      });
      buttonRow.appendChild(beginBtn);
    }

    // Leave button
    const leaveBtn = document.createElement('button');
    leaveBtn.textContent = 'Leave';
    leaveBtn.style.cssText = `
      padding: 12px 24px;
      font-size: 16px;
      border-radius: 8px;
      border: none;
      background: #dc2626;
      color: #fff;
      cursor: pointer;
    `;
    leaveBtn.addEventListener('click', () => {
      socket.emit('leaveTournament');
    });
    buttonRow.appendChild(leaveBtn);
  } else {
    // Spectator — just a leave button
    const leaveBtn = document.createElement('button');
    leaveBtn.textContent = 'Leave';
    leaveBtn.style.cssText = `
      padding: 12px 24px;
      font-size: 16px;
      border-radius: 8px;
      border: none;
      background: #dc2626;
      color: #fff;
      cursor: pointer;
    `;
    leaveBtn.addEventListener('click', () => {
      socket.emit('leaveTournament');
    });
    buttonRow.appendChild(leaveBtn);
  }

  container.appendChild(buttonRow);
  document.body.appendChild(container);

  // Store phase for begin button logic
  container.dataset.phase = data.phase;
}

// Track current phase at module level for begin button handler
let currentPhase = 'lobby';

/**
 * Update the players list in the tournament lobby.
 */
function updateTournamentPlayersList(container, players, currentUsername, isCreator) {
  if (!container) {
    container = document.getElementById('tournamentPlayersList');
  }
  if (!container) return;
  container.innerHTML = '';

  const header = document.createElement('div');
  header.textContent = `Players (${players?.length || 0}):`;
  header.style.cssText = 'font-weight: bold; margin-bottom: 8px; color: #9ca3af;';
  container.appendChild(header);

  if (!players || players.length === 0) return;

  players.forEach(player => {
    const row = document.createElement('div');
    row.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 0;
      border-bottom: 1px solid #374151;
    `;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = player.username;
    nameSpan.style.fontSize = '14px';
    if (player.isCreator) {
      nameSpan.style.color = '#fbbf24';
      nameSpan.textContent += ' (host)';
    }
    row.appendChild(nameSpan);

    const statusSpan = document.createElement('span');
    statusSpan.style.fontSize = '13px';
    if (player.ready) {
      statusSpan.textContent = 'Ready';
      statusSpan.style.color = '#4ade80';
    } else {
      statusSpan.textContent = 'Waiting';
      statusSpan.style.color = '#9ca3af';
    }
    row.appendChild(statusSpan);

    container.appendChild(row);
  });
}

/**
 * Update the active games panel.
 */
function updateActiveGames(container, activeGames, socket) {
  if (!container) {
    container = document.getElementById('tournamentActiveGames');
  }
  if (!container) return;
  container.innerHTML = '';

  if (!activeGames || activeGames.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';

  const header = document.createElement('div');
  header.textContent = 'Active Games';
  header.style.cssText = 'font-weight: bold; color: #60a5fa; margin-bottom: 8px; font-size: 14px;';
  container.appendChild(header);

  activeGames.forEach(game => {
    if (game.status !== 'active') return;

    const gameRow = document.createElement('div');
    gameRow.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid #374151;
    `;

    const info = document.createElement('span');
    info.textContent = `${game.humanPlayers.join(', ')}${game.botCount > 0 ? ` +${game.botCount} bot${game.botCount > 1 ? 's' : ''}` : ''}`;
    info.style.cssText = 'font-size: 13px; color: #e5e7eb;';
    gameRow.appendChild(info);

    const spectateBtn = document.createElement('button');
    spectateBtn.textContent = 'Watch';
    spectateBtn.style.cssText = `
      padding: 4px 12px;
      border-radius: 4px;
      border: none;
      background: #60a5fa;
      color: #fff;
      font-size: 12px;
      cursor: pointer;
    `;
    spectateBtn.addEventListener('click', () => {
      socket.emit('spectateTournamentGame', { gameId: game.gameId });
    });
    gameRow.appendChild(spectateBtn);

    container.appendChild(gameRow);
  });
}

/**
 * Append a chat message to the chat area.
 */
function appendChatMessage(chatArea, username, message, isSpectator) {
  if (!chatArea) {
    chatArea = document.getElementById('tournamentChatArea');
  }
  if (!chatArea) return;

  if (!tournamentUserColors[username]) {
    tournamentUserColors[username] = generateDistinctColor(
      username, Object.values(tournamentUserColors)
    );
  }

  const msgDiv = document.createElement('div');
  msgDiv.style.cssText = 'margin-bottom: 6px; word-wrap: break-word;';

  const nameSpan = document.createElement('span');
  nameSpan.textContent = username + ': ';
  nameSpan.style.fontWeight = 'bold';
  nameSpan.style.color = tournamentUserColors[username] || getUsernameColor(username);
  if (isSpectator) {
    nameSpan.style.opacity = '0.7';
  }
  msgDiv.appendChild(nameSpan);

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  textSpan.style.color = '#e5e7eb';
  msgDiv.appendChild(textSpan);

  chatArea.appendChild(msgDiv);
  chatArea.scrollTop = chatArea.scrollHeight;
}

/**
 * Add a chat message to the tournament lobby.
 */
export function addTournamentChatMessage(username, message, isSpectator) {
  appendChatMessage(null, username, message, isSpectator);
}

/**
 * Update the tournament player list from external event.
 */
export function updateTournamentPlayers(players, currentUsername) {
  const container = document.getElementById('tournamentPlayersList');
  const lobbyContainer = document.getElementById('tournamentLobbyContainer');
  const isCreator = lobbyContainer?.dataset?.isCreator === 'true';
  updateTournamentPlayersList(container, players, currentUsername, isCreator);
  updateBeginButton(players);
}

/**
 * Update scoreboard from external event.
 */
export function updateTournamentScoreboardUI(scoreboard, currentRound, totalRounds) {
  const container = document.getElementById('tournamentScoreboardContainer');
  if (!container) return;
  container.innerHTML = '';
  const scoreboardEl = createTournamentScoreboard(scoreboard, currentRound, totalRounds);
  container.appendChild(scoreboardEl);
}

/**
 * Update round indicator.
 */
export function updateTournamentRoundIndicator(currentRound, totalRounds) {
  const indicator = document.getElementById('tournamentRoundIndicator');
  if (indicator) {
    indicator.textContent = `Round ${currentRound} of ${totalRounds}`;
  }
}

/**
 * Update the begin button state.
 */
function updateBeginButton(players) {
  const beginBtn = document.getElementById('tournamentBeginBtn');
  if (!beginBtn) return;

  const allReady = players && players.length > 0 && players.every(p => p.ready);

  if (allReady) {
    beginBtn.disabled = false;
    beginBtn.style.background = '#fbbf24';
    beginBtn.style.color = '#000';
    beginBtn.style.cursor = 'pointer';
  } else {
    beginBtn.disabled = true;
    beginBtn.style.background = '#6b7280';
    beginBtn.style.color = '#fff';
    beginBtn.style.cursor = 'not-allowed';
  }
}

/**
 * Update active games list from external event.
 */
export function updateTournamentActiveGames(activeGames, socket) {
  updateActiveGames(null, activeGames, socket);
}

/**
 * Set the phase state (used for begin button logic).
 */
export function setTournamentPhase(phase) {
  currentPhase = phase;
  const lobbyContainer = document.getElementById('tournamentLobbyContainer');
  if (lobbyContainer) {
    lobbyContainer.dataset.phase = phase;
  }

  const readyBtn = document.getElementById('tournamentReadyBtn');
  const beginBtn = document.getElementById('tournamentBeginBtn');

  if (phase === 'round_active') {
    if (readyBtn) readyBtn.style.display = 'none';
    if (beginBtn) beginBtn.style.display = 'none';
  } else if (phase === 'between_rounds') {
    if (readyBtn) {
      readyBtn.style.display = '';
      readyBtn.textContent = 'Ready';
      readyBtn.style.background = '#4ade80';
      isPlayerReady = false;
    }
    if (beginBtn) {
      beginBtn.style.display = '';
      beginBtn.textContent = 'Begin Next Round';
      beginBtn.disabled = true;
      beginBtn.style.background = '#6b7280';
    }
  }
}

/**
 * Remove the tournament lobby screen.
 */
export function removeTournamentLobby() {
  const lobby = document.getElementById('tournamentLobbyContainer');
  if (lobby) lobby.remove();
  currentTournamentId = null;
  isPlayerReady = false;
  tournamentUserColors = {};
  currentPhase = 'lobby';
}

/**
 * Get current tournament ID.
 */
export function getCurrentTournamentId() {
  return currentTournamentId;
}
