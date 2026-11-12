/**
 * Tournament Lobby Screen
 *
 * Lobby for tournament players to gather, chat, ready up, and view scoreboard.
 * Supports unbounded player count (unlike the 4-player GameLobby).
 * Kit classes and tokens only (styles/screens.css, item 18b).
 */

import { generateDistinctColor } from '../../utils/colors.js';
import { el, createButton, createPanel } from '../kit/index.js';
import { createTournamentScoreboard } from '../components/TournamentScoreboard.js';
import { chatLine, chatForm, setButtonVariant, appendChatLine, scrollChatToEnd, followChatOnResize } from './common.js';

/**
 * Module state
 */
let tournamentUserColors = {};
let currentTournamentId = null;
let isPlayerReady = false;

/** Ready / Ready! on the tournament's Ready button. */
function renderReady(readyBtn) {
  if (!readyBtn) return;
  readyBtn.textContent = isPlayerReady ? 'Ready!' : 'Ready';
  setButtonVariant(readyBtn, isPlayerReady ? 'secondary' : 'primary');
  readyBtn.classList.toggle('is-on', isPlayerReady);
  readyBtn.setAttribute('aria-pressed', String(isPlayerReady));
}

/** Begin (enabled: primary; disabled until everyone is ready). */
function renderBegin(beginBtn, enabled) {
  if (!beginBtn) return;
  beginBtn.disabled = !enabled;
  setButtonVariant(beginBtn, enabled ? 'primary' : 'secondary');
}

/**
 * Show the tournament lobby screen.
 *
 * @param {Object} data - Tournament state from server
 * @param {Object} socket - Socket instance
 * @param {string} username - Current player's username
 */
export function showTournamentLobby(data, socket, username) {
  console.log('Showing tournament lobby...', data);

  // Remove any existing tournament lobby (this resets module state, so the
  // server-provided phase must be applied afterwards — otherwise the Begin
  // button emits beginTournament instead of beginNextRound after round 1)
  removeTournamentLobby();

  currentTournamentId = data.tournamentId;
  isPlayerReady = false;
  currentPhase = data.phase || 'lobby';
  rounds = { currentRound: data.currentRound || 0, totalRounds: data.totalRounds || 4 };

  const isSpectator = data.isSpectator || false;
  const isCreator = data.creatorUsername === username;

  const container = createPanel({ elevation: 3, className: 'screen screen--full screen--tournament' });
  container.id = 'tournamentLobbyContainer';
  container.dataset.isCreator = String(isCreator);

  // Header row
  const roundIndicator = el('div', {
    className: 'screen-subtitle',
    attrs: { id: 'tournamentRoundIndicator' },
    text: data.currentRound > 0 ? `Round ${data.currentRound} of ${data.totalRounds}` : 'Waiting to start',
  });
  container.appendChild(el('header', {
    className: 'screen-header',
    children: [el('h1', { className: 'screen-title screen-title--md', text: data.name || 'Tournament' }), roundIndicator],
  }));

  // The window's two columns (styles/screens.css .screen--full): the
  // standings and the round's tables on top of the left column with the
  // players and the controls under them, the tournament chat full height on
  // the right (as on iOS). Reading and focus order follow it.
  const mainColumn = el('section', { className: 'screen-main', attrs: { 'aria-label': 'Standings' } });
  mainColumn.appendChild(el('h2', { className: 'section-title section-title--sm', text: 'Scoreboard' }));

  const scoreboardContainer = el('div', { className: 'tournament-scoreboard-wrap', attrs: { id: 'tournamentScoreboardContainer' } });
  scoreboardContainer.appendChild(createTournamentScoreboard(data.scoreboard || [], data.currentRound, data.totalRounds));
  mainColumn.appendChild(scoreboardContainer);

  // The round's tables (visible during round_active) beside the players
  const roster = el('div', { className: 'tournament-roster' });

  const activeGamesContainer = el('div', { className: 'screen-section tournament-games', attrs: { id: 'tournamentActiveGames' } });
  updateActiveGames(activeGamesContainer, data.activeGames || [], socket);
  roster.appendChild(activeGamesContainer);

  // Players list (scrollable)
  const playersDiv = el('div', { className: 'screen-section tournament-players', attrs: { id: 'tournamentPlayersList' } });
  updateTournamentPlayersList(playersDiv, data.players, username, isCreator);
  roster.appendChild(playersDiv);
  mainColumn.appendChild(roster);
  container.appendChild(mainColumn);

  // Right column - the tournament chat
  const chatPanel = el('section', { className: 'screen-chat screen-section', attrs: { 'aria-label': 'Tournament chat' } });
  chatPanel.appendChild(el('h2', { className: 'section-title', text: 'Tournament Chat' }));
  const chatArea = el('div', { className: 'chat-log', attrs: { id: 'tournamentChatArea', role: 'log', 'aria-live': 'polite' } });

  // Add existing messages
  if (data.messages) {
    data.messages.forEach((msg) => colorFor(msg.username));
    data.messages.forEach((msg) => {
      appendChatMessage(chatArea, msg.username, msg.message, msg.isSpectator);
    });
  }
  chatPanel.appendChild(chatArea);

  const { row: chatInputRow } = chatForm({
    inputId: 'tournamentChatInput',
    label: 'Message the tournament',
    onSend: (message) => socket.emit('tournamentChat', { message }),
  });
  chatPanel.appendChild(chatInputRow);

  // Button row
  const buttonRow = el('div', { className: 'screen-actions', attrs: { id: 'tournamentButtonRow' } });

  if (!isSpectator) {
    // Ready button
    const readyBtn = createButton({ label: 'Ready', variant: 'primary' });
    readyBtn.id = 'tournamentReadyBtn';

    // Sync with server state
    const myPlayer = data.players?.find((p) => p.username === username);
    if (myPlayer?.ready) isPlayerReady = true;
    renderReady(readyBtn);

    // Hide ready button during active rounds and once the tournament is over
    if (data.phase === 'round_active' || data.phase === 'complete') {
      readyBtn.hidden = true;
    }

    readyBtn.addEventListener('click', () => {
      if (!isPlayerReady) {
        socket.emit('tournamentReady');
        isPlayerReady = true;
      } else {
        socket.emit('tournamentUnready');
        isPlayerReady = false;
      }
      renderReady(readyBtn);
    });
    buttonRow.appendChild(readyBtn);

    // Begin Tournament / Begin Next Round (creator only)
    if (isCreator) {
      const beginBtn = createButton({ label: 'Begin Tournament', variant: 'secondary' });
      beginBtn.id = 'tournamentBeginBtn';
      renderBegin(beginBtn, false);

      if (data.phase === 'lobby') {
        beginBtn.textContent = 'Begin Tournament';
      } else if (data.phase === 'between_rounds') {
        beginBtn.textContent = 'Begin Next Round';
      } else {
        beginBtn.hidden = true;
      }

      beginBtn.addEventListener('click', () => {
        if (beginBtn.disabled) return;
        // currentPhase tracks the latest server state (set on lobby render
        // and by setTournamentPhase) — round 1 starts from 'lobby', later
        // rounds from 'between_rounds'
        if (currentPhase === 'between_rounds') {
          socket.emit('beginNextRound');
        } else {
          socket.emit('beginTournament');
        }
        renderBegin(beginBtn, false);
      });
      buttonRow.appendChild(beginBtn);

      // Cancel Tournament button (creator only)
      const cancelBtn = createButton({ label: 'Cancel Tournament', variant: 'danger', onClick: () => socket.emit('cancelTournament') });
      cancelBtn.id = 'tournamentCancelBtn';
      buttonRow.appendChild(cancelBtn);
    }
  }

  // Leave (players and spectators)
  buttonRow.appendChild(createButton({
    label: 'Leave',
    variant: 'secondary',
    onClick: () => socket.emit('leaveTournament'),
  }));

  mainColumn.appendChild(buttonRow);
  container.appendChild(chatPanel);
  document.body.appendChild(container);
  // Open on the newest message and stay there through resizes
  scrollChatToEnd(chatArea);
  followChatOnResize(chatArea);

  // Store phase for begin button logic
  container.dataset.phase = data.phase;
}

// Track current phase at module level for begin button handler
let currentPhase = 'lobby';
/** The round the scoreboard shows (an update without one keeps it). */
let rounds = { currentRound: 0, totalRounds: 4 };

function colorFor(username) {
  if (!tournamentUserColors[username]) {
    tournamentUserColors[username] = generateDistinctColor(username, Object.values(tournamentUserColors));
  }
  return tournamentUserColors[username];
}

/**
 * Update the players list in the tournament lobby.
 */
function updateTournamentPlayersList(container, players, _currentUsername, _isCreator) {
  if (!container) {
    container = document.getElementById('tournamentPlayersList');
  }
  if (!container) return;
  container.replaceChildren();

  container.appendChild(el('div', { className: 'section-label', text: `Players (${players?.length || 0}):` }));

  if (!players || players.length === 0) return;

  players.forEach((player) => {
    container.appendChild(el('div', {
      className: 'seat-row seat-row--compact',
      children: [
        el('span', { className: `seat-row__name${player.isCreator ? ' is-host' : ''}`, text: player.isCreator ? `${player.username} (host)` : player.username }),
        el('span', { className: `seat-row__status${player.ready ? ' is-ready' : ''}`, text: player.ready ? 'Ready' : 'Waiting' }),
      ],
    }));
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
  container.replaceChildren();

  if (!activeGames || activeGames.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  container.appendChild(el('div', { className: 'section-label', text: 'Active Games' }));

  activeGames.forEach((game) => {
    if (game.status !== 'active') return;

    const bots = game.botCount > 0 ? ` +${game.botCount} bot${game.botCount > 1 ? 's' : ''}` : '';
    container.appendChild(el('div', {
      className: 'game-row',
      children: [
        el('span', { className: 'game-row__info', text: `${game.humanPlayers.join(', ')}${bots}` }),
        createButton({
          label: 'Watch',
          variant: 'secondary',
          size: 'sm',
          onClick: () => socket.emit('spectateTournamentGame', { gameId: game.gameId }),
        }),
      ],
    }));
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

  // Follows the newest message unless the reader scrolled up
  appendChatLine(chatArea, chatLine({ username, message, color: colorFor(username), isSpectator: !!isSpectator }));
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
export function updateTournamentScoreboardUI(scoreboard, currentRound = rounds.currentRound, totalRounds = rounds.totalRounds) {
  rounds = { currentRound, totalRounds };
  const container = document.getElementById('tournamentScoreboardContainer');
  if (!container) return;
  container.replaceChildren(createTournamentScoreboard(scoreboard, currentRound, totalRounds));
}

/**
 * Update round indicator.
 */
export function updateTournamentRoundIndicator(currentRound, totalRounds) {
  rounds = { currentRound, totalRounds };
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

  // Disconnected members sit out rounds and never ready up — they must not
  // gate the Begin button (the server's allPlayersReady ignores them too)
  const connectedPlayers = (players || []).filter((p) => p.connected !== false);
  const allReady = connectedPlayers.length > 0 && connectedPlayers.every((p) => p.ready);
  renderBegin(beginBtn, allReady);
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
    if (readyBtn) readyBtn.hidden = true;
    if (beginBtn) beginBtn.hidden = true;
  } else if (phase === 'between_rounds') {
    if (readyBtn) {
      readyBtn.hidden = false;
      isPlayerReady = false;
      renderReady(readyBtn);
    }
    if (beginBtn) {
      beginBtn.hidden = false;
      beginBtn.textContent = 'Begin Next Round';
      renderBegin(beginBtn, false);
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
