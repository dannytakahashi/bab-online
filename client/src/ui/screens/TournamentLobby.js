/**
 * Tournament Lobby Screen
 *
 * Lobby for tournament players to gather, chat, ready up, and view scoreboard.
 * Supports unbounded player count (unlike the 4-player GameLobby).
 * Kit classes and tokens only (styles/screens.css, item 18b).
 */

import { generateDistinctColor } from '../../utils/colors.js';
import { el, createButton, createPanel, openModal } from '../kit/index.js';
import { createTournamentScoreboard } from '../components/TournamentScoreboard.js';
import { chatLine, chatForm, setButtonVariant, appendChatLine, scrollChatToEnd, followChatOnResize } from './common.js';
import { LOBBY_VOICE_SLOT_ID } from './GameLobby.js';
import { renderPairings } from './tournamentPairings.js';
import { createRoundsPicker, isRoundCount, roundsLabel, DEFAULT_ROUNDS } from '../components/RoundsPicker.js';
import { createCutView } from '../cut/CutForABuck.js';
import { getCutState } from '../cut/cutStore.js';
import { STAGE as CUT_STAGE } from '../../state/cutForABuck.js';
import { createFinalResultsCard } from '../components/FinalResultsCard.js';
import { CHOICE, CHOICE_EVENT, stillOffers, confirmWords, confirmMessage, otherMembers } from './tournamentConfirm.js';

/**
 * Module state
 */
let tournamentUserColors = {};
let currentTournamentId = null;
let isPlayerReady = false;
/** The lobby's socket, for creator controls built after the first render. */
let lobbySocket = null;
/** My username. */
let lobbyUsername = null;
/** Players as the server last sent them. */
let lobbyPlayers = [];
/**
 * Between rounds, past the server's ready deadline (readyDeadlinePassed):
 * Begin starts with the ready members and the others sit the round out.
 */
let readyDeadlinePassed = false;
/** The rounds' pairings as the server last sent them (2026-11-25), and whether I only watch. */
let lobbyPairings = [];
let lobbySpectator = false;
/** The scoreboard as last drawn (the columns follow totalRounds). */
let lobbyScoreboard = [];
/** The host's Rounds picker while it is shown (lobby phase only). */
let roundsPicker = null;
/** Cut for a buck's view while the cut runs (phase 'cut'; ui/cut/CutForABuck.js). */
let cutView = null;
/** The page's hooks (main.js configureTournamentLobby). */
const hooks = { onReturnToMainRoom: null, onViewProfile: null };
/** The intro plays only when at least this much of the gather is left (ms). */
const INTRO_MIN_LEFT_MS = 3000;

/**
 * The page's hooks: Return to Main Room in the final lobby (main.js routes
 * it as the results modal's Return did) and a player's profile.
 */
export function configureTournamentLobby({ onReturnToMainRoom = null, onViewProfile = null } = {}) {
  hooks.onReturnToMainRoom = onReturnToMainRoom;
  hooks.onViewProfile = onViewProfile;
}

/**
 * The header's round line: "Round 2 of 3" once begun, else "Waiting to
 * start · 3 rounds" (the host's pick, 2026-11-25).
 */
function roundLine(currentRound, totalRounds) {
  if (currentPhase === 'cut') return 'Cut for a buck';
  if (currentPhase === 'complete') return 'Final results';
  return currentRound > 0 ? `Round ${currentRound} of ${totalRounds}` : `Waiting to start · ${roundsLabel(totalRounds)}`;
}

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
 * or past the ready deadline (pressing Begin puts me in the round).
 */
function canBegin(players) {
  return allConnectedReady(players) || startsWithReadyOnly(players);
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
 * The host's Begin Tournament / Begin Next Round and End Tournament,
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

  // End Tournament (owner 2026-11-26, iOS's word; the event stays
  // cancelTournament) asks first: openTournamentConfirm
  const cancelBtn = createButton({ label: 'End Tournament', variant: 'danger', onClick: () => openTournamentConfirm(CHOICE.END) });
  cancelBtn.id = 'tournamentCancelBtn';
  readyBtn.after(beginBtn, cancelBtn);
}

/** The idle-host hand-off moved the role away from me: no more controls. */
function removeCreatorControls() {
  document.getElementById('tournamentBeginBtn')?.remove();
  document.getElementById('tournamentCancelBtn')?.remove();
  removeRoundsPicker();
}

/**
 * The host's Rounds picker (1 to 5), right above Begin, in the lobby phase
 * only; it follows host hand-offs like Begin and Cancel. A pick is sent at
 * once (setTournamentRounds) and shown at once; the server's
 * tournamentSettingsUpdated confirms it for everyone.
 */
function addRoundsPicker(socket) {
  if (roundsPicker || currentPhase !== 'lobby') return;
  const buttonRow = document.getElementById('tournamentButtonRow');
  if (!buttonRow) return;
  roundsPicker = createRoundsPicker({
    value: rounds.totalRounds,
    onChange: (n) => {
      socket?.emit('setTournamentRounds', { totalRounds: n });
      setTournamentTotalRounds(n);
    },
  });
  buttonRow.before(roundsPicker.element);
}

function removeRoundsPicker() {
  roundsPicker?.element.remove();
  roundsPicker = null;
}

const VOICE_FULL_ID = 'tournamentVoiceFull';

/**
 * The over-cap notice (2026-11-25; s2c tournamentVoiceStatus): this member
 * waits in line for the tournament's full voice room (`cap` people, the
 * server's TOURNAMENT_VOICE_MAX), shown beside the voice slot; null clears
 * it (let in, or the screen left). A redraw of the lobby keeps it.
 * @param {number|null} cap
 */
export function setTournamentVoiceFull(cap) {
  const end = document.querySelector('#tournamentLobbyContainer .tournament-header-end');
  let note = document.getElementById(VOICE_FULL_ID);
  if (cap === null || cap === undefined || !end) {
    note?.remove();
    return;
  }
  if (!note) {
    note = el('div', { className: 'screen-subtitle tournament-voice-full', attrs: { id: VOICE_FULL_ID, role: 'status' } });
    end.insertBefore(note, end.querySelector(`#${LOBBY_VOICE_SLOT_ID}`));
  }
  note.textContent = Number.isInteger(cap) && cap > 0 ? `Voice is full (${cap} people)` : 'Voice is full';
  note.title = "You'll join voice when someone leaves it.";
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

  // Tournament voice (2026-11-24) runs on across a re-render (every
  // tournamentJoined draws the lobby again): its buttons move to the new header
  const oldLobby = document.getElementById('tournamentLobbyContainer');
  const voiceButtons = oldLobby ? [...(oldLobby.querySelector(`#${LOBBY_VOICE_SLOT_ID}`)?.children || [])] : [];
  // and so does the over-cap notice (still waiting in line)
  const voiceFullNote = oldLobby?.querySelector(`#${VOICE_FULL_ID}`) || null;

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
  rounds = { currentRound: data.currentRound || 0, totalRounds: isRoundCount(data.totalRounds) ? data.totalRounds : DEFAULT_ROUNDS };
  lobbyScoreboard = data.scoreboard || [];

  const isSpectator = data.isSpectator || false;
  const isCreator = isHost(data.players, username, data.creatorUsername);
  lobbySpectator = isSpectator;
  lobbyPairings = Array.isArray(data.pairings) ? data.pairings : [];

  const container = createPanel({ elevation: 3, className: 'screen screen--full screen--tournament' });
  container.id = 'tournamentLobbyContainer';
  container.dataset.isCreator = String(isCreator);

  // Header row
  const roundIndicator = el('div', {
    className: 'screen-subtitle',
    attrs: { id: 'tournamentRoundIndicator' },
    text: roundLine(rounds.currentRound, rounds.totalRounds),
  });
  // The voice slot (VoiceChatUI.js puts the mute and microphone buttons in
  // it while the tournament's voice runs), beside the round, clear of the
  // chat's Send in the window's bottom-right corner (as the game lobby's)
  const voiceSlot = el('div', { className: 'lobby-voice', attrs: { id: LOBBY_VOICE_SLOT_ID, role: 'group', 'aria-label': 'Voice chat' } });
  voiceSlot.append(...voiceButtons);
  container.appendChild(el('header', {
    className: 'screen-header',
    children: [
      el('h1', { className: 'screen-title screen-title--md', text: data.name || 'Tournament' }),
      el('div', { className: 'tournament-header-end', children: [roundIndicator, ...(voiceFullNote ? [voiceFullNote] : []), voiceSlot] }),
    ],
  }));

  // The window's two columns (styles/screens.css .screen--full): the
  // standings and the round's tables on top of the left column with the
  // players and the controls under them, the tournament chat full height on
  // the right (as on iOS). Reading and focus order follow it.
  const mainColumn = el('section', { className: 'screen-main', attrs: { 'aria-label': 'Standings' } });
  mainColumn.appendChild(el('h2', { className: 'section-title section-title--sm', text: 'Scoreboard' }));

  const scoreboardContainer = el('div', { className: 'tournament-scoreboard-wrap', attrs: { id: 'tournamentScoreboardContainer' } });
  scoreboardContainer.appendChild(createTournamentScoreboard(lobbyScoreboard, rounds.currentRound, rounds.totalRounds));
  mainColumn.appendChild(scoreboardContainer);

  // The round's tables (visible during round_active), the players and the
  // pairings side by side: the pairings never take the standings' height
  // (owner 2026-11-25: at 734 x 985 they left one of two scoreboard rows)
  const roster = el('div', { className: 'tournament-roster' });

  const activeGamesContainer = el('div', { className: 'screen-section tournament-games', attrs: { id: 'tournamentActiveGames' } });
  updateActiveGames(activeGamesContainer, data.activeGames || [], socket);
  roster.appendChild(activeGamesContainer);

  // Players list (scrollable)
  const playersDiv = el('div', { className: 'screen-section tournament-players', attrs: { id: 'tournamentPlayersList' } });
  updateTournamentPlayersList(playersDiv, data.players, username, isCreator);
  roster.appendChild(playersDiv);

  // The round's pairings and "Partners so far" (shown openly, owner
  // 2026-11-25; hidden until a table has two members), beside the players
  const pairingsContainer = el('section', { className: 'screen-section tournament-pairings', attrs: { id: 'tournamentPairings', 'aria-label': 'Pairings' } });
  renderPairings(pairingsContainer, { pairings: lobbyPairings, me: username, spectator: isSpectator });
  roster.appendChild(pairingsContainer);
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

  // Leave (players) / Stop Watching (spectators, iOS's word); both ask first
  const leaveChoice = isSpectator ? CHOICE.STOP_WATCHING : CHOICE.LEAVE;
  const leaveBtn = createButton({
    label: isSpectator ? 'Stop Watching' : 'Leave',
    variant: 'secondary',
    onClick: () => openTournamentConfirm(leaveChoice),
  });
  leaveBtn.id = 'tournamentLeaveBtn';
  buttonRow.appendChild(leaveBtn);

  mainColumn.appendChild(buttonRow);
  container.appendChild(chatPanel);
  document.body.appendChild(container);
  if (!isSpectator && isCreator) addRoundsPicker(socket);
  // Open on the newest message and stay there through resizes
  scrollChatToEnd(chatArea);
  followChatOnResize(chatArea);

  // Store phase for begin button logic
  container.dataset.phase = data.phase;

  // Cut for a buck (2026-11-25): the cut in place of the standings, and the
  // complete phase's final results (no results modal on this client)
  if (currentPhase === 'cut' && getCutState()) {
    const st = getCutState();
    enterCut({ intro: st.stage === CUT_STAGE.GATHER && st.endsAt != null && st.endsAt - Date.now() > INTRO_MIN_LEFT_MS });
  } else if (currentPhase === 'complete') {
    showTournamentFinal({ scoreboard: lobbyScoreboard, winners: data.winners, cut: data.cutForABuck ?? null, totalRounds: rounds.totalRounds });
  }
}

/** The lobby's main column. */
function mainColumnOf() {
  return document.querySelector('#tournamentLobbyContainer > .screen-main');
}

/**
 * Cut for a buck starts (or is under way) on this screen: its view takes
 * the main column (the header with voice and the chat stay); the controls
 * go (no Ready, Begin or Cancel during the gather and the cut).
 */
function enterCut({ intro = false } = {}) {
  const main = mainColumnOf();
  const state = getCutState();
  if (!main || !state) return;
  currentPhase = 'cut';
  const container = document.getElementById('tournamentLobbyContainer');
  if (container) container.dataset.phase = 'cut';
  removeRoundsPicker();
  if (!cutView) {
    cutView = createCutView({
      me: lobbyUsername,
      spectator: lobbySpectator,
      socket: lobbySocket,
      players: lobbyPlayers,
      onViewProfile: hooks.onViewProfile,
      // the cut's Leave / Stop Watching asks first, as the lobby's
      onLeave: () => openTournamentConfirm(lobbySpectator ? CHOICE.STOP_WATCHING : CHOICE.LEAVE),
    });
    main.replaceChildren(cutView.element);
    main.classList.add('has-cut');
  }
  updateTournamentRoundIndicator(rounds.currentRound, rounds.totalRounds);
  cutView.update(state, { intro });
  // End is not offered in the cut (Leave is, in the cut's view)
  syncTournamentConfirm();
}

/**
 * A cut event came in (main.js, after cutStore took it): the view follows;
 * the cut's start on this screen brings the view in with its intro.
 * @param {string} type - the store's change ('start', 'round', ...)
 */
export function syncTournamentCut(type) {
  if (!document.getElementById('tournamentLobbyContainer')) return;
  const state = getCutState();
  if (!state) return;
  if (!cutView) enterCut({ intro: type === 'start' });
  else cutView.update(state);
}

/** A voice peer talking (by username): the ring's speaking ring. */
export function setTournamentCutTalking(username, on) {
  cutView?.setTalking(username, on);
}

/**
 * Is the lobby on screen showing a finished tournament (the complete
 * phase's final results)? A host hand-off then changes nothing anyone can
 * do: main.js says nothing about it.
 */
export function isTournamentFinished() {
  return currentPhase === 'complete' && !!document.getElementById('tournamentLobbyContainer');
}

/** Is the cut's view up (sound plays there: main.js). */
export function isTournamentCutShowing() {
  return !!cutView && cutView.element.isConnected;
}

/**
 * The tournament is over (tournamentComplete, or tournamentJoined in the
 * complete phase): the lobby shows the final results in place of the
 * standings: the score winners, the Cut for a buck winner, the players with
 * their chips and the final scoreboard; Ready, Begin and Cancel are gone and
 * Leave reads "Return to Main Room". The chat and voice stay.
 */
export function showTournamentFinal({ scoreboard = lobbyScoreboard, winners = [], cut = null, totalRounds = rounds.totalRounds } = {}) {
  const main = mainColumnOf();
  if (!main) return;
  currentPhase = 'complete';
  const container = document.getElementById('tournamentLobbyContainer');
  if (container) container.dataset.phase = 'complete';
  if (Array.isArray(scoreboard)) lobbyScoreboard = scoreboard;
  cutView?.destroy();
  cutView = null;
  removeRoundsPicker();
  main.classList.remove('has-cut');
  const card = createFinalResultsCard({ scoreboard: lobbyScoreboard, winners, cut, totalRounds, me: lobbyUsername });
  const back = createButton({ label: 'Return to Main Room', variant: 'primary', onClick: () => hooks.onReturnToMainRoom?.() });
  back.id = 'tournamentReturnBtn';
  const actions = el('div', { className: 'screen-actions', attrs: { id: 'tournamentButtonRow' }, children: [back] });
  const note = el('p', { className: 'muted-note final-results__note', text: 'This lobby stays open for about 10 minutes' });
  main.replaceChildren(card, actions, note);
  updateTournamentRoundIndicator(rounds.currentRound, totalRounds);
  // nothing to leave or end once it is over
  syncTournamentConfirm();
}

// Track current phase at module level for begin button handler
let currentPhase = 'lobby';
/** The round the scoreboard shows (an update without one keeps it). */
let rounds = { currentRound: 0, totalRounds: DEFAULT_ROUNDS };

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
    // (the host plays the round their Begin starts)
    const sitsOut = sitting && !player.ready && !player.isCreator && player.connected !== false;
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

  // only the tables still playing: a round's finished tables left an empty
  // "Active Games" box taking a roster column between rounds
  const live = (activeGames || []).filter((game) => game?.status === 'active');
  if (live.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  container.appendChild(el('div', { className: 'section-label', text: 'Active Games' }));

  live.forEach((game) => {
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
  // Spectators are never the host. The flag follows the role even where
  // the controls are gone (the cut's view): Leave's words say so.
  const readyBtn = document.getElementById('tournamentReadyBtn');
  if (!isCreator && lobbyContainer && !lobbySpectator && isHost(players, currentUsername, newCreator)) {
    isCreator = true;
    lobbyContainer.dataset.isCreator = 'true';
    if (readyBtn) {
      addCreatorControls(readyBtn, lobbySocket, players);
      addRoundsPicker(lobbySocket);
    }
  } else if (isCreator && lobbyContainer && someoneElseHosts(players, currentUsername, newCreator)) {
    // An idle host loses the role while still here (server hand-off,
    // 2026-11-15); a dropped one comes back through a full render
    isCreator = false;
    lobbyContainer.dataset.isCreator = 'false';
    removeCreatorControls();
  }
  updateTournamentPlayersList(container, players, currentUsername, isCreator);
  updateBeginButton(players);
  if (players) cutView?.setPlayers(players);
  // a host hand-off drops an open End; a Leave's words follow who is here
  syncTournamentConfirm();
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
  lobbyScoreboard = scoreboard || [];
  const container = document.getElementById('tournamentScoreboardContainer');
  if (!container) return;
  container.replaceChildren(createTournamentScoreboard(scoreboard, currentRound, totalRounds));
}

/**
 * The rounds' pairings from a tournament event (tournamentRoundStart /
 * GameComplete / RoundComplete / Complete `pairings`).
 */
export function updateTournamentPairings(pairings) {
  if (!Array.isArray(pairings)) return;
  lobbyPairings = pairings;
  renderPairings(document.getElementById('tournamentPairings'), { pairings, me: lobbyUsername, spectator: lobbySpectator });
}

/**
 * Update round indicator.
 */
export function updateTournamentRoundIndicator(currentRound, totalRounds) {
  rounds = { currentRound, totalRounds };
  const indicator = document.getElementById('tournamentRoundIndicator');
  if (indicator) {
    indicator.textContent = roundLine(currentRound, totalRounds);
  }
}

/**
 * The host's round count (tournamentSettingsUpdated, or my own pick): the
 * round line, the scoreboard's columns and the picker follow it.
 */
export function setTournamentTotalRounds(totalRounds) {
  if (!isRoundCount(totalRounds)) return;
  updateTournamentRoundIndicator(rounds.currentRound, totalRounds);
  updateTournamentScoreboardUI(lobbyScoreboard, rounds.currentRound, totalRounds);
  roundsPicker?.setValue(totalRounds);
}

/** The round count the lobby shows (the results modal's columns). */
export function getTournamentTotalRounds() {
  return rounds.totalRounds;
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

  // The count is fixed once the tournament begins
  if (phase !== 'lobby') removeRoundsPicker();

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
  syncTournamentConfirm();
}

/**
 * Remove the tournament lobby screen.
 */
export function removeTournamentLobby() {
  cutView?.destroy();
  cutView = null;
  const lobby = document.getElementById('tournamentLobbyContainer');
  if (lobby) lobby.remove();
  // the screen went (the tournament cancelled, left, a table, a redraw):
  // an open confirm goes with it, as if kept
  closeTournamentConfirm();
  currentTournamentId = null;
  isPlayerReady = false;
  lobbySocket = null;
  lobbyUsername = null;
  lobbyPlayers = [];
  readyDeadlinePassed = false;
  lobbyPairings = [];
  lobbySpectator = false;
  lobbyScoreboard = [];
  roundsPicker = null;
  tournamentUserColors = {};
  currentPhase = 'lobby';
}

/**
 * Get current tournament ID.
 */
export function getCurrentTournamentId() {
  return currentTournamentId;
}

/** The confirm on screen: {choice, modal, message, tournamentId, socket}, or null. */
let confirmDialog = null;
const CONFIRM_ID = 'tournamentConfirmDialog';

/** What the lobby offers right now (tournamentConfirm.tournamentChoices' input). */
function choiceState() {
  const container = document.getElementById('tournamentLobbyContainer');
  return {
    phase: currentPhase,
    isHost: !lobbySpectator && container?.dataset.isCreator === 'true',
    isSpectator: lobbySpectator,
  };
}

/** The lobby is up and still offers the choice. */
function offered(choice) {
  return !!document.getElementById('tournamentLobbyContainer') && stillOffers(choice, choiceState());
}

/** The dialog's message for the lobby as it is now. */
function messageNow(choice) {
  return confirmMessage(choice, { ...choiceState(), ...otherMembers(lobbyPlayers, lobbyUsername) });
}

/**
 * The button that opens the choice where it is on screen now, else Leave
 * (End went with a hand-off), else Return to Main Room: focus after a close.
 */
function triggerFor(choice) {
  const leaveId = cutView ? 'cutLeaveBtn' : 'tournamentLeaveBtn';
  const ids = choice === CHOICE.END ? ['tournamentCancelBtn', leaveId] : [leaveId];
  for (const id of [...ids, 'tournamentReturnBtn']) {
    const btn = document.getElementById(id);
    if (btn && !btn.hidden && btn.isConnected) return btn;
  }
  return null;
}

/**
 * Leave, Stop Watching or End Tournament asks first (owner 2026-11-26, iOS's
 * words: tournamentConfirm.js): the kit's modal with the message, a danger
 * confirm and a keep button (initial focus: these are destructive). Escape,
 * the backdrop and the keep button send nothing. The dialog closes by
 * itself, as if kept, once its choice stops applying while it is open (the
 * host role passes on, the cut starts for End, the results show, the screen
 * goes: syncTournamentConfirm / removeTournamentLobby), and its message
 * follows the lobby while it is open (who is still here, the phase), as
 * iOS's menu header is drawn from the live state: the words read are the
 * outcome of a click now. The confirm checks again before it sends.
 * @param {string} choice - CHOICE
 * @returns {Object|null} the modal
 */
export function openTournamentConfirm(choice) {
  closeTournamentConfirm();
  if (!offered(choice)) return null;
  const words = confirmWords(choice);
  const tournamentId = currentTournamentId;
  const socket = lobbySocket;
  const message = el('p', { className: 'dialog-copy', attrs: { id: 'tournamentConfirmMessage' }, text: messageNow(choice) });
  const keep = createButton({ label: words.keep, variant: 'secondary' });
  keep.id = 'tournamentConfirmKeep';
  const ok = createButton({ label: words.confirm, variant: 'danger', attrs: { 'data-confirm': 'yes' } });
  ok.id = 'tournamentConfirmOk';
  let modal = null;
  modal = openModal({
    title: words.title,
    id: CONFIRM_ID,
    className: 'page-modal tournament-confirm',
    body: message,
    actions: [keep, ok],
    initialFocus: keep,
    onClose: () => {
      if (confirmDialog?.modal === modal) confirmDialog = null;
      // the button it came from may have gone (the cut's view took the
      // column): focus goes to where the choice is now, never the page
      if (!document.activeElement || document.activeElement === document.body) triggerFor(choice)?.focus({ preventScroll: true });
    },
  });
  modal.dialog.setAttribute('aria-describedby', 'tournamentConfirmMessage');
  modal.dialog.dataset.choice = choice;
  keep.addEventListener('click', () => modal.close('button'));
  ok.addEventListener('click', () => {
    // checked again: still this tournament, still offered (a late click
    // after a hand-off or the results sends nothing)
    const go = currentTournamentId === tournamentId && lobbySocket === socket && offered(choice);
    modal.close('action');
    if (go) socket?.emit(CHOICE_EVENT[choice]);
  });
  confirmDialog = { choice, modal, message };
  return modal;
}

/** Take the confirm down, nothing sent. */
export function closeTournamentConfirm() {
  const open = confirmDialog;
  confirmDialog = null;
  open?.modal.close('api');
}

/** Is a confirm up (and which choice)? */
export function tournamentConfirmChoice() {
  return confirmDialog?.modal.isOpen() ? confirmDialog.choice : null;
}

/**
 * The lobby changed under an open confirm: dropped when its choice is no
 * longer offered, else its message follows the lobby.
 */
function syncTournamentConfirm() {
  if (!confirmDialog) return;
  if (!confirmDialog.modal.isOpen()) {
    confirmDialog = null;
    return;
  }
  if (!offered(confirmDialog.choice)) {
    closeTournamentConfirm();
    return;
  }
  const text = messageNow(confirmDialog.choice);
  if (confirmDialog.message.textContent !== text) confirmDialog.message.textContent = text;
}
