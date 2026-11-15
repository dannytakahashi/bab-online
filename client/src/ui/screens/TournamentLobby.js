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
/** The lobby's socket, for creator controls built after the first render. */
let lobbySocket = null;
/** My username (Begin past the ready deadline needs me ready). */
let lobbyUsername = null;
/** Players as the server last sent them. */
let lobbyPlayers = [];
/**
 * Between rounds, past the server's ready deadline (readyDeadlinePassed):
 * Begin starts with the ready members and the others sit the round out.
 */
let readyDeadlinePassed = false;

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

/** Begin's label for the phase; past the deadline it says who plays. */
function beginLabel(players) {
  if (currentPhase !== 'between_rounds') return 'Begin Tournament';
  return startsWithReadyOnly(players) ? 'Start with ready players' : 'Begin Next Round';
}

/** Past the deadline with someone not ready: Begin leaves them out. */
function startsWithReadyOnly(players) {
  return currentPhase === 'between_rounds' && readyDeadlinePassed && !allConnectedReady(players);
}

/**
 * May I begin (as the server's TournamentState.canBegin): everyone ready,
 * or past the ready deadline with me ready.
 */
function canBegin(players) {
  if (allConnectedReady(players)) return true;
  if (!startsWithReadyOnly(players)) return false;
  const me = (players || []).find((p) => p.username === lobbyUsername);
  return !!me && me.ready === true && me.connected !== false;
}

/** Begin's label and gate from the players. */
function syncBegin(beginBtn, players) {
  if (!beginBtn) return;
  if (currentPhase === 'lobby' || currentPhase === 'between_rounds') beginBtn.textContent = beginLabel(players);
  renderBegin(beginBtn, canBegin(players));
}

/** Begin needs every connected member ready (as the server's allPlayersReady). */
function allConnectedReady(players) {
  // Disconnected members sit out rounds and never ready up — they must not
  // gate the Begin button
  const connectedPlayers = (players || []).filter((p) => p.connected !== false);
  return connectedPlayers.length > 0 && connectedPlayers.every((p) => p.ready);
}

/**
 * Am I the host: the creator the server named (creatorUsername, or
 * tournamentPlayerLeft's newCreator) or my players[] entry's isCreator.
 */
function isHost(players, username, creatorUsername) {
  if (creatorUsername && creatorUsername === username) return true;
  return !!players?.some((p) => p.username === username && p.isCreator);
}

/**
 * The host's Begin Tournament / Begin Next Round and Cancel Tournament,
 * right after the Ready button. Built at first render and when the host
 * role passes to me (the creator left), labelled for the current phase.
 */
function addCreatorControls(readyBtn, socket, players) {
  const beginBtn = createButton({ label: 'Begin Tournament', variant: 'secondary' });
  beginBtn.id = 'tournamentBeginBtn';
  if (currentPhase !== 'lobby' && currentPhase !== 'between_rounds') {
    beginBtn.hidden = true;
  }
  syncBegin(beginBtn, players);

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

  const cancelBtn = createButton({ label: 'Cancel Tournament', variant: 'danger', onClick: () => socket.emit('cancelTournament') });
  cancelBtn.id = 'tournamentCancelBtn';
  readyBtn.after(beginBtn, cancelBtn);
}

/** The idle-host hand-off moved the role away from me: no more controls. */
function removeCreatorControls() {
  document.getElementById('tournamentBeginBtn')?.remove();
  document.getElementById('tournamentCancelBtn')?.remove();
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
  lobbySocket = socket;
  lobbyUsername = username;
  lobbyPlayers = data.players || [];
  currentPhase = data.phase || 'lobby';
  readyDeadlinePassed = data.readyDeadlinePassed === true;
  rounds = { currentRound: data.currentRound || 0, totalRounds: data.totalRounds || 4 };

  const isSpectator = data.isSpectator || false;
  const isCreator = isHost(data.players, username, data.creatorUsername);

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
      appendChatMessage(chatArea, msg.username, msg.message, msg.isSpectator, msg.system === true);
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

    if (isCreator) addCreatorControls(readyBtn, socket, data.players);
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

  // Past the ready deadline a member who is not ready sits the next round out
  const sitting = currentPhase === 'between_rounds' && readyDeadlinePassed;
  players.forEach((player) => {
    const sitsOut = sitting && !player.ready && player.connected !== false;
    container.appendChild(el('div', {
      className: 'seat-row seat-row--compact',
      children: [
        el('span', { className: `seat-row__name${player.isCreator ? ' is-host' : ''}`, text: player.isCreator ? `${player.username} (host)` : player.username }),
        el('span', { className: `seat-row__status${player.ready ? ' is-ready' : ''}`, text: player.ready ? 'Ready' : (sitsOut ? 'Sitting out' : 'Waiting') }),
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
function appendChatMessage(chatArea, username, message, isSpectator, isSystem = false) {
  if (!chatArea) {
    chatArea = document.getElementById('tournamentChatArea');
  }
  if (!chatArea) return;

  // Follows the newest message unless the reader scrolled up
  // A notice is styled by the server's flag, never by the name "System"
  // (a player may hold that name from before it was reserved)
  const line = isSystem
    ? chatLine({ username, message, isSystem: true })
    : chatLine({ username, message, color: colorFor(username), isSpectator: !!isSpectator });
  appendChatLine(chatArea, line);
}

/**
 * Add a chat message to the tournament lobby. isSystem: the line's
 * `system: true` (a server notice).
 */
export function addTournamentChatMessage(username, message, isSpectator, isSystem = false) {
  appendChatMessage(null, username, message, isSpectator, isSystem);
}

/**
 * Update the tournament player list from external event. newCreator is
 * tournamentPlayerLeft's: the host left and the role passed on.
 */
export function updateTournamentPlayers(players, currentUsername, newCreator = null) {
  const container = document.getElementById('tournamentPlayersList');
  const lobbyContainer = document.getElementById('tournamentLobbyContainer');
  let isCreator = lobbyContainer?.dataset?.isCreator === 'true';
  if (players) lobbyPlayers = players;
  // Promoted: only the host's socket may begin or cancel, so without the
  // controls the tournament would be stuck until a reload.
  // Spectators have no Ready button and get no controls.
  const readyBtn = document.getElementById('tournamentReadyBtn');
  if (!isCreator && readyBtn && isHost(players, currentUsername, newCreator)) {
    isCreator = true;
    lobbyContainer.dataset.isCreator = 'true';
    addCreatorControls(readyBtn, lobbySocket, players);
  } else if (isCreator && lobbyContainer && someoneElseHosts(players, currentUsername, newCreator)) {
    // An idle host loses the role while still here (server hand-off,
    // 2026-11-15); a dropped one comes back through a full render
    isCreator = false;
    lobbyContainer.dataset.isCreator = 'false';
    removeCreatorControls();
  }
  updateTournamentPlayersList(container, players, currentUsername, isCreator);
  updateBeginButton(players);
}

/** The server named another host (newCreator, or another isCreator entry). */
function someoneElseHosts(players, username, newCreator) {
  if (newCreator) return newCreator !== username;
  return !!players?.some((p) => p.isCreator && p.username !== username);
}

/**
 * tournamentReadyUpdate / tournamentJoined's readyDeadlinePassed: Begin may
 * start with the ready members (only sent between rounds).
 */
export function setReadyDeadlinePassed(passed) {
  readyDeadlinePassed = passed === true;
  updateTournamentPlayersList(null, lobbyPlayers, lobbyUsername, false);
  updateBeginButton(lobbyPlayers);
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
  syncBegin(beginBtn, players);
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
  // A new between-rounds wait starts its own deadline
  readyDeadlinePassed = false;
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
  lobbySocket = null;
  lobbyUsername = null;
  lobbyPlayers = [];
  readyDeadlinePassed = false;
  tournamentUserColors = {};
  currentPhase = 'lobby';
}

/**
 * Get current tournament ID.
 */
export function getCurrentTournamentId() {
  return currentTournamentId;
}
