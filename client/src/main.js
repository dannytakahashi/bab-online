/**
 * Main entry point for the modular client.
 *
 * Wires the socket, the handler modules (handlers/) and the DOM screens
 * together; the table itself is drawn by GameScene and its managers.
 */

// Phaser global: must stay the FIRST import (see vendor.js)
import './vendor.js';

// Constants
import { RANK_VALUES } from './constants/ranks.js';

// Utilities
import { getPlayerName } from './utils/positions.js';
import { adoptSavedSession, forgetSession, clearAllSessionData, isDeviceSignedOut, SAVED_SESSION_KEY } from './utils/sessionPersistence.js';
import { safeSessionStorage } from './utils/safeStorage.js';
import { createVoiceLifecycle } from './voice/voiceLifecycle.js';
import { installContextLossHandling } from './phaser/webglContext.js';
import { installAvatarSupport } from './utils/avatar.js';
import { getClientErrorReporter } from './telemetry/clientErrors.js';

// Rules
import { isLegalMove } from './rules/legality.js';
import { bidTotalsFor } from './rules/bids.js';

// State
import { PHASE, getGameState } from './state/GameState.js';
import { getClientSession, SCREEN, ROLE, EXIT } from './state/ClientSession.js';

// Socket
import { getSocketManager, initializeSocketManager, CHAT_EVENTS, REFUSAL } from './socket/SocketManager.js';
import { createSocket } from './socket/createSocket.js';
import { failureOf, TABLE_ERROR_HANDLERS } from './socket/serverErrors.js';
import { installConnectionBanner } from './ui/components/ConnectionBanner.js';
import { showSupersededNotice, hideSupersededNotice, isSupersededNoticeShown, setSupersededNoticeVariant, NOTICE_VARIANT } from './ui/components/SupersededNotice.js';
import { removeTransitionOverlay } from './ui/transitionOverlay.js';
import { getTableDirector } from './phaser/TableDirector.js';
import { getSeqGate } from './state/SeqGate.js';
import { getMyAction } from './state/MyAction.js';
import { applyTableSnapshot, snapshotSource } from './state/tableSync.js';
import { getRestartNotice, LOSS } from './state/restartNotice.js';
import { speakingSlotFor } from './voice/speakingSlot.js';
import { installVoiceHotkeys } from './voice/voiceHotkeys.js';

// UI Components
import { showError, showSuccess, showWarning, showInfo } from './ui/components/Toast.js';
import { showSignInScreen } from './ui/screens/SignIn.js';
import { showRegisterScreen } from './ui/screens/Register.js';
import { showMainRoom, addMainRoomChatMessage, updateLobbyList, removeMainRoom, updateMainRoomOnlineCount } from './ui/screens/MainRoom.js';
import { showGameLobby, updateLobbyPlayersList, addLobbyChatMessage, removeGameLobby, focusLobbyStart, isLobbyTableFullForMe } from './ui/screens/GameLobby.js';
import {
  showProfilePage, updateProfilePicDisplay, updateCustomProfilePicDisplay, showPlayerProfilePage, showDeleteAccountError,
  updateProfileStats, updatePlayerProfileStats, profileStatsRequestFailed, showChangePasswordResult,
} from './ui/screens/ProfilePage.js';
import { passwordResetNoticeText } from './utils/accountNotices.js';
import { showLeaderboardPage, updateLeaderboardPage, leaderboardRequestFailed } from './ui/screens/LeaderboardPage.js';
import { showRecordsPage, updateRecordsPage, recordsRequestFailed } from './ui/screens/RecordsPage.js';
import { isStaleScopeReply, getStatsScope } from './state/statsScope.js';
import { updatePlayerSearchResults } from './ui/screens/PlayerSearchPage.js';
import { setIsAdmin } from './admin/adminApi.js';
import { removeTournamentLobby, addTournamentChatMessage, updateTournamentPlayers, updateTournamentScoreboardUI, updateTournamentRoundIndicator, updateTournamentActiveGames, setTournamentPhase, setReadyDeadlinePassed } from './ui/screens/TournamentLobby.js';
import { showTournamentResultsOverlay } from './ui/components/TournamentScoreboard.js';
import { showResignationDialog, dismissResignationDialog } from './ui/components/ResignationDialog.js';
import { SCREENS, initializeUIManager } from './ui/UIManager.js';

// Phaser
import { createPhaserGame, getPhaserGame } from './phaser/PhaserGame.js';
import { installLoopControl, LOOP_SCREENS } from './phaser/loopControl.js';
import { applyBackingStore, onDprChange } from './phaser/backingStore.js';
import { loadCardFont } from './phaser/cards/cardFont.js';

// Handlers
import { registerAllHandlers } from './handlers/index.js';

// Voice Chat
import { getVoiceChatManager } from './voice/VoiceChatManager.js';
import { createMuteButton, removeMuteButton, showVoiceOverlay, removeVoiceOverlay, setMuteButtonState, setVoiceTalkView, resetVoiceTalkView } from './ui/components/VoiceChatUI.js';
import { setTableChrome, clearHud, hudRoot } from './ui/tableHud.js';
import { renderSpectatorBadge, removeSpectatorBadge, setSpeaking as setWatcherSpeaking } from './ui/components/SpectatorBadge.js';

// Sound effects
import { getSoundManager } from './audio/SoundManager.js';
import { getTableSounds } from './audio/tableSounds.js';

// ============================================
// Game Scene Access
// ============================================

// Reference to the active Phaser game scene
let gameSceneRef = null;

// Reference to the modular game log instance
let gameLogInstance = null;

// The table's timed work, scene readiness and fast-forward (TableDirector)
const director = getTableDirector();

// The Phaser loop's sleep off the table (phaser/loopControl.js)
let loopControl = null;

/**
 * Set the game scene reference (GameScene.create() calls it, through
 * window.ModernUtils, after creating its managers).
 * @param {Phaser.Scene} scene - The active game scene
 */
export function setGameScene(scene) {
  gameSceneRef = scene;

  // Also set window.gameScene for global access
  window.gameScene = scene;

  // Table events that arrived while the scene was missing or restarting
  // (before create(), or an exit's teardown) run now (webclient-2)
  director.attach(scene);

  // The canvas follows its grid column
  observeContainer();

  // Off the table, the loop sleeps once the scene is up (the first frame drawn)
  loopControl?.sync();

  // Handle tab visibility change - lay the table out again when the tab
  // becomes visible (the window may have changed size while it was hidden)
  if (!scene._visibilityHandlerAdded) {
    scene._visibilityHandlerAdded = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && gameSceneRef) {
        // Use requestAnimationFrame to ensure dimensions are updated
        requestAnimationFrame(() => gameSceneRef?.relayout?.());
      }
    });
  }

  console.log('🎮 Game scene reference set');
}

/**
 * Phaser's canvas follows #game-container, the grid's first column (the
 * log column comes and goes with the table chrome), at the device pixel
 * ratio (item 18a): the backing store is the container's CSS size times the
 * ratio (phaser/backingStore.js); a change emits Phaser's 'resize'
 * (GameScene.relayout).
 */
function syncCanvasSize(scene = gameSceneRef) {
  const game = scene?.game;
  const container = document.getElementById('game-container');
  if (!game?.scale || !container) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (!w || !h) return;
  applyBackingStore(game, w, h);
}

let containerObserver = null;

/**
 * Any change of the container's size (grid column, window) resizes the
 * canvas, and so does a change of the device pixel ratio (the window moved
 * to another display).
 */
function observeContainer() {
  if (containerObserver || typeof ResizeObserver === 'undefined') return;
  const container = document.getElementById('game-container');
  if (!container) return;
  containerObserver = new ResizeObserver(() => syncCanvasSize());
  containerObserver.observe(container);
  onDprChange(() => syncCanvasSize());
}

/**
 * Get the current game scene (for use in callbacks).
 * @returns {Phaser.Scene|null} The active game scene or null
 */
export function getGameScene() {
  return gameSceneRef;
}

/**
 * Clear the game scene reference (called on game cleanup).
 */
export function clearGameScene() {
  gameSceneRef = null;
  // Nothing the old scene owned may run; new work waits for the next one
  director.detach();
  console.log('🎮 Game scene reference cleared');
}

/**
 * Run fn(scene) now, or once the scene is ready (TableDirector.run: events
 * are buffered in order, tagged with the table generation; an exit or a
 * newer rebuild drops them). kind 'draw': replayed as is; 'table': a late
 * flush ends with one render of the model.
 */
function withScene(fn, kind = 'table') {
  director.run(fn, { kind });
}

// UI Components - Game Log
import { showGameLog } from './ui/components/GameLog.js';
import { clearChatBubbles, showSpectatorChatBubble } from './ui/components/ChatBubble.js';
import { getTeamNames, scoreHeaderNames, formatHandCompleteMessages, formatGameEndMessages, showFinalScoreOverlay, removeFinalScoreOverlay } from './ui/components/ScoreModal.js';

// Bridge for GameScene (phaser/scenes/GameScene.js), its only reader: it
// registers itself through setGameScene and reads the rest from here
window.ModernUtils = {
  setGameScene,
  RANK_VALUES,
  getPlayerName,
  isLegalMove,
  formatHandCompleteMessages,
};

// ============================================
// Game Log Bridges (window functions for external access)
// ============================================

// Bridge for creating game feed - now uses modular GameLog. A replay of the
// server's log brings its own 'Game started!' (pass true)
window.createGameFeedFromLegacy = function(isReconnection = false) {
  // The log is a .ui-element, so uiManager.clearUI() (removeWaitingScreen,
  // which every rejoin runs) removes its element without forgetting the
  // instance: a detached log counts as none, or a rejoin leaves the game
  // with no log for the rest of the game
  if (gameLogInstance && !gameLogInstance.container?.isConnected) {
    gameLogInstance = null;
  }
  if (!gameLogInstance) {
    gameLogInstance = showGameLog({
      // false (the emit gate refused it, offline): the log keeps the draft
      onChatSubmit: (message) => (window.socket ? window.socket.emit('chatMessage', { message }) : false),
    });

    // The log's grid column (--log-w) comes on
    setTableChrome(true);

    // The canvas takes the narrower column (Phaser then relayouts the table)
    requestAnimationFrame(() => syncCanvasSize());

    if (!isReconnection) {
      gameLogInstance.addGameMessage('Game started!');
    }
  }
};

// Bridge for adding messages to game feed
window.addToGameFeedFromLegacy = function(message, playerPosition = null, at = null) {
  if (gameLogInstance && gameLogInstance.addGameMessage) {
    gameLogInstance.addGameMessage(message, playerPosition, at);
  } else {
    console.warn('Game log not initialized, message dropped:', message);
  }
};

// Bridge for updating game log score display
window.updateGameLogScoreFromLegacy = function(teamNames, oppNames, teamScore, oppScore, teamBids = '-/-', oppBids = '-/-', teamTricks = 0, oppTricks = 0) {
  if (gameLogInstance && gameLogInstance.updateFullScore) {
    gameLogInstance.updateFullScore(teamNames, oppNames, teamScore, oppScore, teamBids, oppBids, teamTricks, oppTricks);
  } else {
    console.warn('Game log not initialized, score update dropped');
  }
};

// Bridge for updating game log hand indicator
window.updateHandIndicatorFromLegacy = function(handSize) {
  if (gameLogInstance && gameLogInstance.updateHandIndicator) {
    gameLogInstance.updateHandIndicator(handSize);
  }
};

// ============================================
// Application Initialization
// ============================================

// The page's one socket (socket/createSocket.js); window.socket is how the
// scene reaches it
const socket = createSocket();
window.socket = socket;

// Avatars over HTTP (docs/avatars.md): clientHello caps ['avatarUrl'] on
// every connect (and right now: buffered ahead of any later emit while
// disconnected), and avatarUrls folded into the pic fields as each message
// arrives. Registered before the connect handler below.
/* global __APP_VERSION__, __APP_BUILD__ */
installAvatarSupport(socket, {
  version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0',
  build: typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 'dev',
});

// Client error reports (telemetry/clientErrors.js): uncaught errors and
// unhandled rejections from here on, plus the table's own counters (SeqGate
// gaps, TableDirector failures, illegal screen moves), once per kind per page
// load, sent as clientError while connected. Never throws
const errorReporter = getClientErrorReporter();
errorReporter.configure({
  build: typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 'dev',
  page: () => getClientSession().screen,
});
errorReporter.attach(socket);
errorReporter.installWindowHooks(window);

// ==================== SESSION / RECONNECTION ====================

// The client session (state/ClientSession.js) is the one place that knows
// the current screen, the table role and every gameId copy. On every connect
// of a signed-in tab it restores the session first (once per socket id),
// and restoreSessionResponse then rejoins (one rejoinGame per socket),
// re-spectates or re-enters the current screen. The table is entered only
// through session.enterTable and left only through session.exitTable.
const session = getClientSession();

socket.on('connect', () => {
  console.log('Connected to server:', socket.id);
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected from server:', reason);
  document.dispatchEvent(new CustomEvent('connectionLost', { detail: { reason } }));
});

// Socket.IO v3+ emits reconnection events on the Manager (socket.io), not on
// the Socket, so these must be registered on socket.io to ever fire
socket.io.on('reconnect_attempt', (attemptNumber) => {
  console.log(`Reconnection attempt ${attemptNumber}`);
  document.dispatchEvent(new CustomEvent('reconnecting', { detail: { attempt: attemptNumber } }));
});

socket.io.on('reconnect', (attemptNumber) => {
  console.log(`Reconnected after ${attemptNumber} attempt(s)`);
});

socket.io.on('reconnect_failed', () => {
  console.log('Reconnection failed after all attempts');
  // The tab's credentials go; the device's saved session stays
  safeSessionStorage().removeItem('username');
  safeSessionStorage().removeItem('sessionToken');
  session.clearIdentity();
  setIsAdmin(false);
  displaySignInScreen(EXIT.RECONNECT_FAILED);
  showError('Connection lost. Please sign in again.');
});

// Blocked users — chat from these usernames is hidden locally. Populated from
// signInResponse/restoreSessionResponse and kept in sync via blockListUpdated.
const blockedUsers = new Set();

export function isUserBlocked(username) {
  return blockedUsers.has(username);
}

export function setBlockedUsers(list) {
  blockedUsers.clear();
  (list || []).forEach(u => blockedUsers.add(u));
}

socket.on('blockListUpdated', (data) => {
  if (data.success) {
    setBlockedUsers(data.blockedUsers);
    // silent: pushed by the server after an admin renamed someone on the
    // list (the player did nothing, so no toast)
    if (!data.silent) showInfo('Block list updated');
  } else {
    showError(data.message || 'Failed to update block list');
  }
});

socket.on('reportUserResponse', (data) => {
  if (data.success) {
    showSuccess('Report submitted. Thank you — we review all reports.');
  } else {
    showError(data.message || 'Failed to submit report');
  }
});

// Change password (profile page): the form shows the answer; this device
// stays signed in, the server signed out every other one
socket.on('changePasswordResponse', (data) => {
  showChangePasswordResult(data || {});
});

/**
 * The one-time notice after a password reset (signInResponse /
 * restoreSessionResponse passwordReset {by, at}, additive 2026-11-15): one
 * info line, a little longer than a plain toast.
 */
const PASSWORD_RESET_TOAST_MS = 10000;
function notePasswordReset(data) {
  const text = passwordResetNoticeText(data?.passwordReset);
  if (text) showInfo(text, PASSWORD_RESET_TOAST_MS);
}

// Account deletion (in-app, required by App Store Guideline 5.1.1(v))
socket.on('deleteAccountResponse', (data) => {
  if (data.success) {
    clearAllSessionData();
    window.location.reload();
  } else {
    showDeleteAccountError(data.message || 'Account deletion failed');
  }
});

// No playerAssigned listener (V1_REMOVALS #7): my seat comes from
// positionUpdate (my username's position, handlers/gameHandlers.js), then
// every seat gameStart (`position`) and every snapshot (`viewer.position`)

// ==================== END SESSION / RECONNECTION ====================

/**
 * Show an error toast (the page's one toast queue: ui/kit/toast.js).
 */
function showErrorToast(message, duration = 5000) {
  showError(message, duration);
}

// Track retry attempts for joinMainRoom
let joinMainRoomRetries = 0;
const MAX_JOIN_RETRIES = 5;
// joinTournament refusals the server answers with no main room (it leaves
// the socket where it is: server tournamentHandlers STAYS_PUT)
const STAYS_PUT_REFUSALS = new Set(['Already in a tournament', 'Already in a lobby', 'Already in game']);

// ==================== SERVER RESTART ====================

// What a server restart took away (state/restartNotice.js): recorded on
// serverShutdown, told once by the first restore path that finds it gone
const restartNotice = getRestartNotice();
// The message stays up a little longer than an ordinary toast
const RESTART_LOSS_TOAST_MS = 10000;

/**
 * Where this tab is when serverShutdown comes: what the restart will take.
 * Nothing for the main room, the sign-in screen, a finished casual game's
 * score screen (it was recorded) or a tab paused behind another one.
 */
function restartLossKind() {
  if (session.isParked) return null;
  const tournamentId = session.tournamentId || session.persistedTournamentId;
  const watchingTournament = !!tournamentId && session.isTournamentSpectator(tournamentId);
  switch (session.screen) {
    case SCREEN.TABLE:
      if (session.role === ROLE.SPECTATOR) return session.watchedTournamentId ? LOSS.TOURNAMENT_SPECTATOR : LOSS.SPECTATOR;
      return session.tournamentId && !watchingTournament ? LOSS.TOURNAMENT : LOSS.SEAT;
    case SCREEN.GAME_END:
      // The game ended (and counted); a tournament between rounds is lost,
      // and so is the lobby a casual game reopened (play again)
      if (!session.tournamentId) return session.lobbyReturn ? LOSS.LOBBY : null;
      return watchingTournament ? LOSS.TOURNAMENT_SPECTATOR : LOSS.TOURNAMENT;
    case SCREEN.LOBBY:
      return LOSS.LOBBY;
    case SCREEN.TOURNAMENT_LOBBY:
      return watchingTournament ? LOSS.TOURNAMENT_SPECTATOR : LOSS.TOURNAMENT;
    default:
      return null;
  }
}

/**
 * A restore path found its game / lobby / tournament gone. After a server
 * restart, say so once (an info toast, announced politely).
 * @returns {boolean} true when the restart explains it (shown now or
 *   already): the caller's own message is left out
 */
function explainRestartLoss() {
  const text = restartNotice.take();
  if (text) {
    showInfo(text, RESTART_LOSS_TOAST_MS);
    return true;
  }
  return restartNotice.shown;
}

/**
 * Handle socket error based on type.
 * @returns {boolean} true for an expected refusal of a restore (the watched
 *   game, the lobby or the tournament is gone): nothing went wrong
 */
function handleSocketError(error, socket) {
  let message = 'Something went wrong';

  // Re-spectating after a reconnect: the watched game ended meanwhile
  if (error.message === 'Game not found' && (session.pendingSpectate || session.isSpectator)) {
    console.log('Spectated game no longer exists, returning to main room');
    session.takePendingSpectate();
    session.exitTable(EXIT.SPECTATE_FAILED);
    explainRestartLoss();
    return true;
  }

  // Re-entering a lobby after a reconnect: it closed (or filled) meanwhile.
  // Or the score modal's Return to Lobby after a game whose lobby reopened
  // (play again): the lobby closed, or its next game ended, meanwhile
  const afterGame = session.lobbyRejoinAfterGame;
  if (session.takePendingLobbyRejoin()) {
    console.log('Lobby re-entry failed:', error.message);
    // 'Lobby is full' too: the seat may still be held by this player's
    // previous socket until the server notices it dropped
    if (!explainRestartLoss()) {
      const gone = error.message === 'Lobby not found';
      showErrorToast(afterGame
        ? (gone ? 'That lobby has closed' : "Couldn't get back into the lobby")
        : (gone ? 'The lobby closed while you were offline' : "Couldn't get back into the lobby"));
    }
    session.transition(SCREEN.MAIN_ROOM);
    session.requestMainRoom();
    return true;
  }

  // Re-entering a tournament after a reload or reconnect: it is gone
  const pendingTournament = session.takePendingTournamentRejoin();
  if (pendingTournament) {
    console.log('Tournament re-entry failed:', error.message);
    getGameState().tournamentId = null;
    if (!explainRestartLoss()) showErrorToast('The tournament is no longer available');
    if (!session.hasTable) session.transition(SCREEN.MAIN_ROOM);
    // The server follows a failed joinTournament with the main room, except
    // when the socket belongs elsewhere ('Already in a tournament' / 'Already
    // in a lobby' / 'Already in game': joinMainRoom also leaves a lobby seat);
    // a failed spectateTournament with nothing
    if (pendingTournament.spectator || STAYS_PUT_REFUSALS.has(error.message)) session.requestMainRoom();
    return true;
  }

  // Handle race condition where joinMainRoom is called before user is registered
  if (error.message === 'User not registered yet') {
    // Don't retry if we're in a game (have a gameId)
    if (session.isAtTable || session.persistedGameId) {
      console.log('User not registered yet, but have gameId - waiting for rejoin instead');
      return;
    }

    joinMainRoomRetries++;
    if (joinMainRoomRetries <= MAX_JOIN_RETRIES) {
      console.log(`User not registered yet, retrying joinMainRoom (${joinMainRoomRetries}/${MAX_JOIN_RETRIES})...`);
      setTimeout(() => {
        socket.emit('joinMainRoom');
      }, 100);
      return; // Don't show error toast for this
    } else {
      console.log('Max joinMainRoom retries reached, showing sign-in screen');
      joinMainRoomRetries = 0;
      displaySignInScreen(EXIT.SIGN_OUT);
      return;
    }
  }

  switch (error.type) {
    case 'VALIDATION_ERROR':
    case 'validation':
      message = error.message || 'Invalid input';
      break;
    case 'AUTH_ERROR':
      message = 'Please sign in again';
      break;
    case 'RATE_LIMIT_ERROR':
    case 'rateLimit':
      message = 'Too many requests. Please slow down.';
      break;
    case 'GAME_STATE_ERROR':
      message = error.message || 'Game error occurred';
      break;
    case 'server':
      message = 'Server error. Please try again.';
      break;
    default:
      // Most handler errors are untyped ({ message: 'Lobby is full' }) and
      // their text is meant for the player
      message = error.message || 'Server error. Please try again.';
      break;
  }

  showErrorToast(message);
}

/**
 * Initialize the application.
 * This is the main entry point that wires everything together.
 * Note: socket is already created at module load time (see above)
 */
function initializeApp() {
  console.log('Initializing BAB Online...');

  // Socket already created at module level as window.socket
  // Initialize socket manager with the existing socket
  const socketMgr = initializeSocketManager(socket);

  // Sequenced events reach their handlers in seq order (contract R1-R5): a
  // gap asks for a snapshot (log and custom pictures left out). Set before
  // the handler modules register: SocketManager wraps them as they do
  const seqGate = getSeqGate();
  const requestSnapshot = (requestId) => socket.emit('requestSnapshot', { requestId, log: false, customPics: false });
  seqGate.configure({ requestSnapshot });
  socketMgr.setGate(seqGate);

  // My bid / play: pending until its echo, rolled back by actionRejected,
  // reconciled from a snapshot after an unanswered 5 s (MyAction)
  const myAction = getMyAction();
  myAction.configure({
    emit: (event, payload) => socket.emit(event, payload),
    requestSnapshot,
    forceReconnect: () => socketMgr.forceReconnect(),
    connectionId: () => (socket.connected ? socket.id || 'connected' : null),
    // The emit gate's rule (SocketManager._send): no bid or play before the restore
    canSend: (event) => socketMgr.canSend(event),
    onRefused: () => showInfo('Reconnecting. Try again in a moment.'),
  });

  // The emit gate's notices: a refusal (offline; a chat form keeps the
  // draft), and what was held too long to send after the reconnect
  socketMgr.setEmitNotices({
    refused: (event, reason) => showWarning(reason === REFUSAL.FULL
      ? (CHAT_EVENTS.has(event)
        ? "Still reconnecting. Your message wasn't sent; try again in a moment."
        : 'Still reconnecting. Try again in a moment.')
      : (CHAT_EVENTS.has(event)
        ? "You're offline. Your message wasn't sent."
        : "You're offline. Try again once you're back online.")),
    dropped: (events) => showWarning(events.some((e) => CHAT_EVENTS.has(e))
      ? "A message from while you were reconnecting wasn't sent."
      : "An action from while you were reconnecting wasn't sent."),
  });

  // Visible connection state while the socket is down (and the restart
  // notice: serverShutdown)
  const connectionBanner = installConnectionBanner(socketMgr);
  connectionBannerRef = connectionBanner;

  // A parked tab whose socket reconnected (a deploy, a network blip): a
  // parked tab never restores, so the server no longer knows the new
  // socket as this player's parked one and tells it nothing ('otherClosed'
  // cannot reach it): the notice no longer claims where the session is
  socketMgr.onStateChange((event, data) => {
    if (event === 'stateChanged' && data?.newState === 'connected' && session.isParked) {
      setSupersededNoticeVariant(NOTICE_VARIANT.RECONNECTED);
    }
  });

  // Signed out in another tab of this browser (it clears the saved
  // session): a parked tab signs out at once
  window.addEventListener('storage', (e) => {
    if (!session.isParked || e.newValue != null) return;
    if (e.key !== null && e.key !== SAVED_SESSION_KEY) return;
    if (isDeviceSignedOut()) signOutParkedTab();
  });

  // Initialize UI manager
  const uiManager = initializeUIManager(socket);

  // Get game state singleton
  const gameState = getGameState();

  // The client session drives the screens; SocketManager's connect resumes it
  session.attach({ socketManager: socketMgr, gameState });

  // The director buffers scene work by table generation and, after a hidden
  // tab or a late scene, renders the current model (no log replay)
  director.configure({
    generation: () => session.tableGeneration,
    isLive: () => session.isAtTable && gameState.renderModel().live,
    render: (scene) => renderTable(scene, {}),
  });

  // Voice chat lifecycle helpers
  const voiceManager = getVoiceChatManager();

  // Start / stop across the mic prompt: a stop while it is up ends the
  // start, so a late answer draws no dead mute button (voiceLifecycle.js)
  const voiceLifecycle = createVoiceLifecycle({
    manager: voiceManager,
    // opts.talk false: listen-only, no microphone prompt (a spectator)
    connect: (opts) => voiceManager.initialize(socketMgr, opts),
    onStarted: () => showVoiceControls(),
    onUnavailable: (err) => {
      // A refused microphone is listen-only now (the session still hears):
      // this is the rest (no WebRTC at all)
      console.warn('Voice chat unavailable:', err?.message);
      showWarning('Voice chat is unavailable in this browser.');
    },
    teardown: () => teardownVoice(),
    // a voiceSettings during the microphone prompt: the start reads it
    setMode: (talk) => voiceManager.setTalk(talk),
  });

  function startVoice(opts) {
    return voiceLifecycle.start(opts);
  }

  // ---------- Spectator voice (voiceSettings; docs/claude/voice.md) ----------
  // The last voiceSettings of this table (a casual game started from a
  // lobby; null elsewhere), whether this spectator wants its microphone (a
  // lobby extra came with it; a main-room spectator once it taps to talk),
  // whether it came from the lobby (keeps wanting it across an off / on),
  // "voice is full", and the in-game switch change waiting for its echo
  let voiceSettings = null;
  let voiceWantsMic = false;
  let voiceFromLobby = false;
  let voiceFull = false;
  let voiceSwitchPending = null;
  // Play again: whether Return to Lobby hands this tab its microphone back,
  // decided when lobbyReturn dropped the table's voice settings (null: not
  // decided; carryVoiceIntoLobby reads the settings then)
  let voiceMicAfterGame = null;

  /** A watcher (a pure spectator of this table), not a seat's owner: "(watching)", the badge's speaking ring, the forced mute. */
  function isWatcher(username) {
    if (!username) return false;
    const owners = Object.values(gameState.seatOwners || {});
    if (owners.includes(username)) return false;
    return (gameState.watching?.spectators || []).some((s) => s.username === username);
  }

  /** A player's backstop while spectators may not talk: watchers' audio plays at 0. */
  function applyForcedMute() {
    const s = voiceSettings;
    const force = !!s && s.role === 'player' && !s.spectatorsCanTalk;
    voiceManager.setForcedMute?.(force ? (_sid, username) => isWatcher(username) : null);
  }

  /** The voice controls' view of the talk mode (VoiceChatUI). */
  function refreshTalkView() {
    const s = voiceSettings;
    const switchView = s && s.role === 'player' && s.canChange
      ? {
        checked: voiceSwitchPending ? voiceSwitchPending.value : !!s.spectatorsCanTalk,
        pending: !!voiceSwitchPending,
        onChange: (next) => requestGameSpectatorsCanTalk(next),
      }
      : null;
    setVoiceTalkView({
      listenOnly: !!voiceManager.isListenOnly?.(),
      mayTalk: !s || s.role !== 'spectator' || !!s.canTalk,
      micDenied: !!voiceManager.micDenied,
      onListenOnly: (o) => onListenOnlyAction(o),
      isWatcher,
      spectatorsCanTalk: s ? !!s.spectatorsCanTalk : true,
      switchView,
    });
  }

  /** The in-game "Spectators can talk" switch (a player voiceSettings.canChange allows). */
  function requestGameSpectatorsCanTalk(next) {
    if (voiceSwitchPending) return;
    voiceSwitchPending = {
      value: !!next,
      timer: setTimeout(() => {
        // no echo (refused, coalesced away): show what the server last said
        voiceSwitchPending = null;
        refreshTalkView();
      }, 5000),
    };
    socket.emit('setSpectatorsCanTalk', { spectatorsCanTalk: !!next });
    refreshTalkView();
  }

  function clearVoiceSwitchPending() {
    if (voiceSwitchPending?.timer) clearTimeout(voiceSwitchPending.timer);
    voiceSwitchPending = null;
  }

  /**
   * The mic button (and M) while listen-only: "Tap to talk" asks for the
   * microphone when talking is allowed (a player whose microphone was
   * refused too); otherwise it says why (and the button opens the overlay,
   * where per-person volume and mute are).
   */
  function onListenOnlyAction({ source = 'button' } = {}) {
    const s = voiceSettings;
    const mayTalk = !s || s.role !== 'spectator' || !!s.canTalk;
    if (mayTalk) {
      voiceWantsMic = true;
      Promise.resolve(voiceManager.setTalk(true)).then((talking) => {
        if (!talking && voiceManager.active) showWarning('Microphone access denied. You can still listen.');
        refreshTalkView();
        refreshSpectatingIndicator();
      });
      return;
    }
    showInfo(s.spectatorsCanTalk
      ? 'Listening only: nobody at this table can let spectators talk.'
      : 'The host turned off spectator talk — you can still listen.');
    if (source === 'button') showVoiceOverlay({ byClick: true });
  }

  /** Apply the stored voiceSettings: the forced mute, the spectator's mode (starting voice), the controls. */
  function applyVoiceSettings() {
    const s = voiceSettings;
    applyForcedMute();
    if (s && s.role === 'spectator') {
      const talk = !!s.canTalk && voiceWantsMic;
      // running: change the mode (re-offers); starting: the start reads it
      if (voiceManager.active) voiceManager.setTalk(talk);
      else startVoice({ talk });
    }
    refreshTalkView();
    refreshSpectatingIndicator();
  }

  /**
   * voiceSettings (a casual game's voice; private, to this capable tab only):
   * role player (forced mute while spectators may not talk; the switch
   * when canChange), spectator (voice listen-only unless allowed and
   * wanted: a lobby extra keeps its microphone, a main-room spectator taps
   * to talk) or none (voice is full: watch and chat only).
   */
  function onVoiceSettings(data) {
    // a late one for a table this tab left
    if (data.gameId && gameState.gameId && data.gameId !== gameState.gameId) return;
    // the score modal: that game is over (a reopened lobby's next game
    // admitting this socket as a watcher: onSpectatorJoined stops that)
    if (session.screen === SCREEN.GAME_END) return;
    let prev = voiceSettings;
    if (data.role === 'none' && session.isSpectator && (voiceManager.active || voiceLifecycle.starting)) {
      // a watcher with no voice place: no voice session (it would hear
      // nobody). First: the stop resets this table's voice state
      stopVoice();
    }
    if (prev && prev.gameId !== data.gameId) {
      prev = null;
      voiceWantsMic = false;
      voiceFromLobby = false;
    }
    voiceSettings = { ...data };
    if (voiceSwitchPending && voiceSwitchPending.value === !!data.spectatorsCanTalk) clearVoiceSwitchPending();
    voiceFull = data.role === 'none';
    if (data.role === 'spectator' && prev?.role !== 'spectator') {
      // A lobby extra arrives with its microphone (or its prompt) live
      voiceFromLobby = !!voiceManager.isTalking?.() || (voiceLifecycle.starting && voiceManager.wantsTalk !== false);
      voiceWantsMic = voiceFromLobby;
    }
    if (data.role === 'spectator' && prev?.role === 'spectator' && prev.spectatorsCanTalk !== data.spectatorsCanTalk) {
      if (!data.spectatorsCanTalk) {
        // main-room spectators tap again once it is back on
        if (!voiceFromLobby) voiceWantsMic = false;
        showInfo('The host turned off spectator talk — you can still listen.');
      } else {
        showInfo(voiceWantsMic && data.canTalk ? 'Spectators can talk again.' : 'Spectators can talk again — tap the mic to talk.');
      }
    }
    if (data.role === 'none' && prev?.role !== 'none') showInfo('Voice is full (8 people). You can still watch and chat.');
    applyVoiceSettings();
  }

  function showVoiceControls() {
    createMuteButton();
    // The talk mode (listen-only, a refused microphone) on the controls
    voiceManager.onModeChange?.(() => {
      refreshTalkView();
      refreshSpectatingIndicator();
    });
    // A browser that blocks audio without a gesture: the next click plays it
    voiceManager.onAutoplayBlocked?.(() => showInfo('Click anywhere to hear voice chat.'));
    if (voiceManager.micDenied) showWarning('Microphone access denied. You can still listen to voice chat.');
    applyForcedMute();
    refreshTalkView();
    refreshSpectatingIndicator();
    // Register speaking indicator callback
    voiceManager.onSpeakingChange((id, isSpeaking) => {
      if (id === 'self') {
        // a watcher's ring is the spectator badge's (no seat of its own)
        if (session.isSpectator) {
          setWatcherSpeaking(gameState.username, isSpeaking);
          return;
        }
        const el = document.getElementById('player-avatar-container');
        if (el) el.classList.toggle('voice-speaking', isSpeaking);
      } else {
        const username = voiceManager.peers.get(id)?.username || null;
        // A stop always clears the badge's ring for that name: the watcher
        // may be gone from the list already (it left; its call ends after)
        if (!isSpeaking) setWatcherSpeaking(username, false);
        if (session.hasTable && isWatcher(username)) {
          setWatcherSpeaking(username, isSpeaking);
          return;
        }
        // Peer → seat by username: the seat's owner, then the name it
        // shows; the socket id only as a fallback (V1_REMOVALS #6 / #14).
        // A spectator views from seat 1, whose player sits at the bottom
        const slotId = speakingSlotFor({
          username,
          socketId: id,
          playerData: gameState.playerData,
          myPosition: gameState.position,
          owners: gameState.seatOwners,
          spectator: session.isSpectator,
        });
        if (slotId) {
          const el = document.getElementById(`opponent-avatar-${slotId}`);
          if (el) el.classList.toggle('voice-speaking', isSpeaking);
        }
      }
    });
  }

  /**
   * Take the whole table UI down: every exit (session.exitTable runs it as
   * its teardown hook). A rebuild of the same table (rejoin, re-spectate,
   * restorePlayerState, a resync) is a render instead (renderTable): the
   * scene draws the snapshot over whatever was there. It never touches the
   * game state or the gameId copies (exitTable resets those after it).
   */
  function teardownTableUI(reason = null) {
    // Play again: the lobby's calls are the game's (the server kept them),
    // so a Return to Lobby keeps voice running (carryVoiceIntoLobby)
    if (reason !== EXIT.LOBBY_RETURN) stopVoice();
    removeTransitionOverlay();
    // Nothing queued, owned or pending of this table may run later
    director.clearQueue();
    director.reset();
    seqGate.reset();
    myAction.reset();
    getTableSounds().reset();
    const scene = getGameScene();

    if (scene) {
      // Cards, opponents, tricks, effects, the draw and the trump card
      scene.cleanup();
      scene.clearPlayerInfo();
      scene.layoutManager?.cleanupDomBackgrounds();
      scene.opponentManager?.clearAll();
    }

    // Game-owned DOM outside the scene (a rebuild in place keeps the
    // table's open 'Replace with Bot?' offer: the server does not resend it)
    document.getElementById('spectating-indicator')?.remove();
    dismissResignationDialog();
    clearChatBubbles();
    document.querySelectorAll('.chat-bubble').forEach((el) => el.remove());
    removeFinalScoreOverlay();
    uiManager.clearUI();

    document.getElementById('gameFeed')?.remove();
    gameLogInstance = null;

    // The HUD (seats, frog, bubbles, bid sheet, status, voice slot, who is
    // watching), and fallbacks for DOM a scene manager would normally own
    removeSpectatorBadge();
    clearHud();
    document.querySelectorAll('.opponent-avatar-container, .dealer-button').forEach((el) => el.remove());
    document.getElementById('player-avatar-container')?.remove();
    document.getElementById('bidContainer')?.remove();

    setTableChrome(false);
    clearGameScene();

    if (scene) {
      scene.children?.removeAll?.(true);
      scene.scene?.restart?.();
    }
  }

  function clearAuthScreens() {
    ['sign-in-container', 'sign-in-vignette', 'signInContainer', 'SignInVignette',
      'register-container', 'register-vignette', 'registerContainer', 'RegisterVignette',
    ].forEach((id) => document.getElementById(id)?.remove());
  }

  // The table's look (the felt: table.css #game-container.at-table) follows
  // the screen: at the table and on its score modal only
  const syncTableScreen = (screen) => {
    const atTable = screen === SCREEN.TABLE || screen === SCREEN.GAME_END;
    document.getElementById('game-container')?.classList.toggle('at-table', atTable);
    // sound plays only at a table: elsewhere its context is suspended
    getSoundManager().setActive(atTable);
  };
  session.onScreenChange((screen) => syncTableScreen(screen));
  syncTableScreen(session.screen);

  // Screen enter/exit hooks (the session runs exit(from) then enter(to))
  session.setHooks({
    teardownTable: (reason) => teardownTableUI(reason),
    screens: {
      [SCREEN.SIGN_IN]: {
        enter: () => renderSignIn(),
        exit: () => clearAuthScreens(),
      },
      [SCREEN.MAIN_ROOM]: {
        // The DOM comes with mainRoomJoined; an exit lands here first
        enter: (data) => {
          if (data) showMainRoom(data, socket, gameState.username);
        },
        exit: () => removeMainRoom(),
      },
      [SCREEN.LOBBY]: {
        enter: (data) => {
          removeMainRoom();
          if (data) showGameLobby(data, socket, gameState.username);
        },
        exit: (_data, ctx) => {
          removeGameLobby();
          // Lobby voice carries on into its game
          if (ctx.to !== SCREEN.TABLE) stopVoice();
        },
      },
      [SCREEN.TOURNAMENT_LOBBY]: {
        enter: (data) => {
          removeMainRoom();
          if (data && data.tournamentId) uiManager.renderScreen(SCREENS.TOURNAMENT_LOBBY, data);
        },
        exit: () => removeTournamentLobby(),
      },
      [SCREEN.TABLE]: {
        enter: (_data, ctx) => {
          if (ctx.reenter) return;
          clearAuthScreens();
          removeMainRoom();
          removeGameLobby();
        },
      },
      [SCREEN.GAME_END]: {
        // The game is over: /active and 'Replace with Bot?' mean nothing now
        enter: () => {
          document.getElementById('spectating-indicator')?.remove();
          dismissResignationDialog();
        },
      },
    },
  });

  function stopVoice() {
    voiceLifecycle.stop();
  }

  /**
   * Play again: Return to Lobby kept voice running (teardownTableUI skips
   * the stop for EXIT.LOBBY_RETURN). In the lobby everyone may talk: the
   * table's voice settings go (no forced mute, no switch), a spectator who
   * came with its microphone (a lobby extra) gets it back, and the controls
   * are drawn again in the lobby's slot (voiceLifecycle.start returns at
   * once while the manager is active and would draw nothing).
   * @returns {boolean} voice is running or starting (else the caller starts it)
   */
  function carryVoiceIntoLobby() {
    const s = voiceSettings;
    const wantsMic = voiceMicAfterGame ?? (!s || s.role !== 'spectator' || voiceWantsMic || voiceFromLobby);
    voiceMicAfterGame = null;
    voiceSettings = null;
    voiceWantsMic = false;
    voiceFromLobby = false;
    voiceFull = false;
    clearVoiceSwitchPending();
    voiceManager.setForcedMute?.(null);
    if (!voiceManager.active) return voiceLifecycle.starting;
    createMuteButton();
    if (wantsMic && voiceManager.isListenOnly?.() && !voiceManager.micDenied) {
      Promise.resolve(voiceManager.setTalk(true)).then(() => refreshTalkView());
    }
    refreshTalkView();
    return true;
  }

  /**
   * Play again: lobbyReturn while the finished game's table or score modal
   * is up. The server moved this socket into the lobby, where everyone may
   * talk, and voice keeps running (owner 2026-11-16), so the table's voice
   * rules end now, not at Return: no forced mute (a lobby extra already
   * back in the lobby talking is heard at full volume from the modal) and
   * no in-game switch. Nothing on screen changes but the voice controls'
   * talk view. Whether Return hands the microphone back is decided here,
   * from the settings that go (a lobby extra that came listen-only stays so).
   */
  function endTableVoiceRules() {
    const s = voiceSettings;
    if (!s) return;
    voiceMicAfterGame = s.role !== 'spectator' || voiceWantsMic || voiceFromLobby;
    voiceSettings = null;
    voiceFull = false;
    clearVoiceSwitchPending();
    voiceManager.setForcedMute?.(null);
    refreshTalkView();
  }

  /** The LOBBY screen's data from a lobby payload (lobbyCreated / lobbyReturn). */
  function lobbyScreenData(data) {
    return {
      lobbyId: data.lobbyId,
      players: data.players,
      reconnecting: data.reconnecting,
      // a family lobby (up to 8): everyone, the host, its settings, its size
      members: data.members,
      host: data.host,
      settings: data.settings,
      capacity: data.capacity,
      // play again: the last game's older-app players whose place is saved
      expected: data.expected,
      messages: (data.messages || []).filter(m => !isUserBlocked(m.username))
    };
  }

  /**
   * The score modal's Return to Lobby after a casual game whose lobby
   * reopened (play again, owner 2026-11-16): into that lobby, voice kept
   * (ClientSession sends lobbyReturnSeen, then joinLobby).
   * @returns {boolean} false: no lobby return (the main room, as before)
   */
  function returnToReopenedLobby() {
    const r = session.lobbyReturn;
    if (!r) return false;
    const name = r.data.name;
    const landed = session.returnToReopenedLobby(lobbyScreenData(r.data));
    if (landed === SCREEN.LOBBY) {
      if (!carryVoiceIntoLobby()) startVoice();
      // The modal's button had focus and went with the table: the lobby's
      // Ready (or its chat while Ready is disabled) takes it
      focusLobbyStart();
      const back = name ? `Back in “${name}”.` : 'Back in your lobby.';
      // The others filled the table meanwhile (a family lobby): Ready is
      // disabled, "Table full — you'll watch"
      showInfo(isLobbyTableFullForMe() ? `${back} The table is full; you'll watch this one.` : `${back} Tap Ready to play again.`);
      return true;
    }
    // The lobby started its next game meanwhile: the main room until the
    // answer (that game to watch, or 'Lobby not found')
    return landed !== null;
  }

  /**
   * A lobby event while the score modal is up and its lobby reopened: the
   * remembered lobby follows it, so Return shows the lobby as it is.
   */
  function followReturnedLobby(data, { message = null } = {}) {
    const r = session.screen === SCREEN.GAME_END ? session.lobbyReturn : null;
    if (!r) return;
    if (message) {
      if (isUserBlocked(message.username)) return;
      r.data.messages = [...(r.data.messages || []), { username: message.username, message: message.message, timestamp: message.timestamp }];
      return;
    }
    if (!data || (data.lobbyId && data.lobbyId !== r.data.lobbyId)) return;
    for (const key of ['players', 'reconnecting', 'members', 'host', 'settings', 'capacity', 'expected']) {
      if (key in data) r.data[key] = data[key];
      // present only while one stands: absent means none
      else if (key === 'reconnecting' || key === 'expected') delete r.data[key];
    }
  }

  function teardownVoice() {
    voiceManager.shutdown();
    removeMuteButton();
    removeVoiceOverlay();
    // This table's voice settings go with it (a new table sends its own)
    voiceSettings = null;
    voiceMicAfterGame = null;
    voiceWantsMic = false;
    voiceFromLobby = false;
    voiceFull = false;
    clearVoiceSwitchPending();
    resetVoiceTalkView();
    // Clean up speaking indicator classes
    document.querySelectorAll('.voice-speaking').forEach(el => {
      el.classList.remove('voice-speaking');
    });
  }

  // Hold ` for the voice overlay, M toggles mute (voice/voiceHotkeys.js; Tab stays focus)
  installVoiceHotkeys({
    isActive: () => voiceManager.active,
    show: showVoiceOverlay,
    hide: removeVoiceOverlay,
    // the button shows it (VoiceChatUI: icon, aria-pressed; the red look is
    // CSS). Listen-only: what the mic button does (tap to talk, or why not)
    toggleMute: () => {
      if (voiceManager.isListenOnly?.()) onListenOnlyAction({ source: 'key' });
      else setMuteButtonState(voiceManager.toggleSelfMute());
    },
  });

  // App-level server errors: `serverError {code, message, handler}`, one per
  // failure (V1_REMOVALS #1; the v1 `error` twin is gone since phase B)
  const onServerFailure = (payload) => {
    const failure = failureOf(payload);
    routeTableError(failure);
    // A restore finding its place gone (e.g. after a server restart) is
    // expected: logged, not reported as an error
    if (handleSocketError(failure, socket)) console.log('Restore refused:', failure.message);
    else console.error('Server error:', failure);
  };
  socket.on('serverError', onServerFailure);

  /**
   * A refused table request resyncs the table at once instead of waiting
   * for a timeout (iOS SocketService.routeTableError): my refused play /
   * bid asks for its snapshot now (MyAction), a refused requestSnapshot
   * applies what the seq gate holds (no snapshot is coming for it).
   */
  function routeTableError({ handler }) {
    if (!TABLE_ERROR_HANDLERS.includes(handler)) return;
    if (handler === 'requestSnapshot') {
      if (seqGate.buffered || seqGate.resyncId) seqGate.flushBuffer();
      return;
    }
    myAction.transportError(handler === 'playCard' ? 'play' : 'bid');
  }

  /**
   * The spectating pill: 'lazy' (my seat is played by a bot), 'spectator',
   * or null (none).
   */
  function setSpectatingIndicator(kind) {
    let indicator = document.getElementById('spectating-indicator');
    if (!kind) {
      indicator?.remove();
      return;
    }
    const text = (kind === 'lazy' ? 'Spectating — type /active to take back control' : 'Spectating — type /leave to exit') + spectatorVoiceNote(kind);
    // The HUD's status slot (top centre of the table, from the layout:
    // ui-18), else the top of the page
    const root = hudRoot();
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'spectating-indicator';
    }
    if (indicator.parentElement !== root) root.appendChild(indicator);
    // its color is the kind's (table.css #spectating-indicator.is-lazy / .is-spectating)
    indicator.classList.toggle('is-lazy', kind === 'lazy');
    indicator.classList.toggle('is-spectating', kind !== 'lazy');
    indicator.setAttribute('role', 'status');
    indicator.dataset.kind = kind;
    indicator.textContent = text;
  }

  /** A watcher's voice state on the pill: "(listening only)" or "Voice is full (8 people)". */
  function spectatorVoiceNote(kind) {
    if (kind !== 'spectator') return '';
    if (voiceFull) return ' · Voice is full (8 people)';
    if (voiceSettings?.role === 'spectator' && voiceManager.isListenOnly?.()) return ' (listening only)';
    return '';
  }

  /** Redraw the pill's text (the voice state changed). */
  function refreshSpectatingIndicator() {
    const kind = document.getElementById('spectating-indicator')?.dataset.kind;
    if (kind) setSpectatingIndicator(kind);
  }

  /** The game log, created if missing (no local 'Game started!': a replay brings the server's). */
  function ensureGameLog() {
    window.createGameFeedFromLegacy(true);
    setTableChrome(true);
    return gameLogInstance;
  }

  /**
   * Draw the whole table from GameState (scene.render) plus what lives in
   * the DOM around it: the game log (replaced by `log`, the snapshot's
   * server log, when given; then one `suffix` line), the score header, the
   * hand and trick indicators and the spectating pill. Idempotent: a
   * rebuild on a live scene equals a fresh render of the same snapshot.
   * @param {Phaser.Scene} scene
   * @param {Object} [opts]
   * @param {Array|null} [opts.log] - snapshot.log entries to replay (null: keep the log)
   * @param {string|null} [opts.suffix] - a line after the replay ('Reconnected to game!')
   */
  function renderTable(scene, { log = null, suffix = null } = {}) {
    const model = gameState.renderModel({ pendingCard: myAction.pendingCard, pendingBid: myAction.isPending('bid') });
    scene.render(model);
    const feed = ensureGameLog();
    if (log && feed?.replaceMessages) {
      feed.replaceMessages(log.map((e) => ({ message: e.message, position: e.position ?? null, at: e.at ?? null })));
    }
    if (suffix) window.addToGameFeedFromLegacy(suffix);
    if (model.live && model.handSize) {
      window.updateHandIndicatorFromLegacy(model.handSize);
      feed?.showTrickIndicator?.(model.handSize);
    } else {
      feed?.hideTrickIndicator?.();
    }
    scene.renderScoreHeader?.();
    const role = model.viewer?.role;
    setSpectatingIndicator(role === 'lazyWatcher' ? 'lazy' : (role === 'spectator' ? 'spectator' : null));
    renderSpectatorBadge(model.watching, { me: gameState.username });
    return model;
  }

  /**
   * Render once the scene is ready (now if it is), unless the table was left
   * or rebuilt again meanwhile (the director drops queued work of an older
   * table generation; a gameEnd first means no rebuild under the score modal).
   */
  function scheduleRender(opts) {
    withScene((scene) => {
      if (!session.isAtTable) return;
      renderTable(scene, opts);
    }, 'render');
  }

  /** The server log to replay from a snapshot, or null when it was left out (R5: keep ours). */
  const logOf = (snap) => (snap && !snap.partial?.includes('log') ? snap.log || [] : null);

  /**
   * A rebuild from a snapshot carrier (rejoinSuccess, restorePlayerState,
   * the spectator full state): the snapshot is the table; the scene is
   * drawn once it is ready.
   */
  function rebuildTable(data, { source, role, suffix }) {
    // Sign-in / lobby screens and overlays go (a rejoin inside the teams
    // fade never gets createUI, which is what lifts the black overlay)
    uiManager.removeAllVignettes();
    ['signInContainer', 'lobbyContainer', 'sign-in-container'].forEach((id) => document.getElementById(id)?.remove());
    uiManager.removeWaitingScreen();
    removeTransitionOverlay();
    // Whatever was in flight belongs to the table being replaced
    director.reset();
    return applyTableSnapshot(data, {
      source,
      role,
      render: (snap) => scheduleRender({ log: logOf(snap), suffix }),
    });
  }

  // Register all handlers with UI callbacks
  registerAllHandlers(socketMgr, {
    // Auth callbacks
    onSignInSuccess: (data) => {
      console.log('Sign in success, going to main room');
      leaveParked();
      // Signed in on this socket: no restoreSession needed for it
      session.noteSignedIn(data.username);
      stopRestoreRetry();
      notePasswordReset(data);
      // The main room's Admin entry (display only; the server checks)
      setIsAdmin(data.isAdmin === true);
      setBlockedUsers(data.blockedUsers);

      // Check if user has an active game to rejoin
      if (data.activeGameId) {
        console.log(`Active game found: ${data.activeGameId}, attempting to rejoin...`);
        // A failed rejoin then routes back to the tournament
        if (data.activeTournamentId) gameState.tournamentId = data.activeTournamentId;
        session.rejoin(data.activeGameId);
      } else if (data.activeTournamentId) {
        console.log(`Active tournament found: ${data.activeTournamentId}, rejoining...`);
        session.onSessionRestored({ username: data.username, activeTournamentId: data.activeTournamentId });
      } else {
        // Go to main room
        session.requestMainRoom();
      }
    },
    onSignInError: (message) => {
      showError(message || 'Sign-in failed! Incorrect username or password.');
    },
    onSignUpSuccess: (data) => {
      // A pending restore retry belongs to the identity this tab just left
      stopRestoreRetry();
      if (data.autoLoggedIn) {
        // Auto-login: go straight to main room
        console.log(`Registration & auto-login successful: ${data.username}`);
        session.noteSignedIn(data.username);
        setIsAdmin(false);
        // Fresh account, fresh block list (don't inherit a prior session's)
        setBlockedUsers([]);
        session.requestMainRoom();
      } else {
        showSuccess('Registration successful! Please sign in.');
      }
    },
    onSignUpError: (message) => {
      showError(`Registration failed: ${message}`);
    },
    onSessionSuperseded: (data) => {
      // 'otherClosed': the tab that had the session was closed and none
      // took it since (the server waits ~2 s, so a reload of that tab says
      // nothing). Only the notice's text changes, focus stays on Use here;
      // it never parks a live tab nor takes the session back by itself
      const closed = data?.reason === NOTICE_VARIANT.CLOSED;
      if (closed) {
        if (!session.isParked) return;
        // The other tab signed out (Profile Sign Out): no "continue" for
        // the next person at this computer, this tab signs out too
        if (isDeviceSignedOut()) signOutParkedTab();
        else setSupersededNoticeVariant(NOTICE_VARIANT.CLOSED);
        return;
      }
      // Another tab of this browser has the session now: pause here (no
      // reconnect or ping takes it back by itself) until Use here. Told
      // again after an 'otherClosed' (that tab reloaded, or another took
      // it): the notice says so again. A refusal never changes the text
      if (session.isParked && isSupersededNoticeShown()) {
        if (!data?.refused) setSupersededNoticeVariant(NOTICE_VARIANT.NEWER);
        return;
      }
      session.park();
      socketMgr.setParked(true);
      // This tab's microphone and peer connections go (the active tab has its own)
      stopVoice();
      showSupersededNotice({
        onUseHere: () => {
          // Signed out on this device meanwhile: the sign-in screen, never
          // the signed-out player's session from this tab's own copy
          if (isDeviceSignedOut()) {
            signOutParkedTab();
            return;
          }
          // A fresh socket: it restores the session (which parks the other
          // tab) and re-enters this tab's screen (rejoin, lobby, main room)
          session.unpark();
          socketMgr.setParked(false);
          socketMgr.forceReconnect();
        },
      });
    },
    onServerShutdown: () => {
      // A deploy: the server closes every socket in about a second and
      // comes back without any game, lobby or tournament. The banner says
      // so until the socket is back; what this tab is in is remembered
      // (sessionStorage, ~2 min) for the restore to explain
      connectionBanner.noteServerRestart();
      restartNotice.note(restartLossKind());
    },
    onForceLogout: (data) => {
      console.warn('Force logout:', data?.reason || 'Unknown reason');
      restartNotice.clear();
      leaveParked();
      // authHandlers cleared the tab's credentials; the server disconnects
      // this socket next, so nothing it showed will be finished (createUI
      // never comes to lift a transition overlay): exitTable takes it all down
      session.clearIdentity();
      setIsAdmin(false);
      setBlockedUsers([]);
      displaySignInScreen(EXIT.FORCE_LOGOUT);
    },
    onActiveGameFound: (data) => {
      console.log('Active game found:', data.gameId);
      // The rejoin will be handled by the server's sign-in response
    },

    // Main Room callbacks
    onMainRoomJoined: (data) => {
      // Reset retry counter on success
      joinMainRoomRetries = 0;
      session.routeArrived();
      // The restore that explained a restart has landed: the record goes
      // (later refusals are ordinary ones again)
      if (restartNotice.shown) restartNotice.clear();

      // A late reply while at a table (the session left it before asking)
      if (session.hasTable) {
        console.log('Main room joined event ignored - at the table:', session.screen);
        return;
      }
      console.log('Joined main room, showing UI');
      // Hide replayed chat history from blocked users
      if (data.messages) {
        data.messages = data.messages.filter(m => !isUserBlocked(m.username));
      }
      session.transition(SCREEN.MAIN_ROOM, data);
    },
    onMainRoomMessage: (data) => {
      if (isUserBlocked(data.username)) return;
      addMainRoomChatMessage(data.username, data.message, data.timestamp);
    },
    onLobbiesUpdated: (data) => {
      updateLobbyList(data.lobbies, socket, data.inProgressGames, data.tournaments);
    },
    onMainRoomPlayerJoined: (data) => {
      updateMainRoomOnlineCount(data.onlineCount, data.onlineUsers);
    },

    // Lobby callbacks
    onLobbyCreated: (data) => {
      // Don't show lobby if we're at a table (e.g., during rejoin)
      if (session.hasTable) {
        console.log('Lobby created event ignored - at the table');
        return;
      }
      console.log('Lobby created, showing lobby UI');
      session.transition(SCREEN.LOBBY, lobbyScreenData(data));
      session.noteLobby(data.lobbyId);
      restartNotice.clear();
      // Start voice chat when entering a lobby
      startVoice();
    },
    onLobbyReturn: (data) => {
      // Play again (owner 2026-11-16): the server moved this socket back
      // into the lobby the game came from. The score modal stays exactly as
      // it is for as long as the player likes; its Return to Lobby lands
      // there (returnToReopenedLobby). The lobby is only remembered here
      if (session.noteLobbyReturn(data)) {
        // Voice keeps running through the results: the table's voice
        // rules (forced mute, switch) end with its game
        endTableVoiceRules();
        return;
      }
      if (session.screen === SCREEN.MAIN_ROOM) {
        // Left the table just before it ended: the joinMainRoom in flight
        // takes the server out of that lobby (else one goes now)
        if (session.routeInFlight !== 'mainRoom') session.requestMainRoom();
        return;
      }
      // Anywhere else (no compliant server sends it there): the server's
      // membership goes, so it matches what this tab shows
      console.warn('lobbyReturn with no table of that game on screen; leaving that lobby');
      socket.emit('leaveLobby');
    },
    onPlayerReadyUpdate: (data) => {
      followReturnedLobby(data);
      // Every playerReadyUpdate names the held seats while there are any
      updateLobbyPlayersList(null, data.players, gameState.username, { reconnecting: data.reconnecting || [], lobby: data });
    },
    onLobbyMessage: (data) => {
      followReturnedLobby(null, { message: data });
      if (isUserBlocked(data.username)) return;
      addLobbyChatMessage(data.username, data.message);
    },
    onLobbyPlayerLeft: (data) => {
      followReturnedLobby(data);
      updateLobbyPlayersList(null, data.players, gameState.username, { lobby: data });
    },
    onLobbyPlayerJoined: (data) => {
      followReturnedLobby(data);
      updateLobbyPlayersList(null, data.players, gameState.username, { returned: data.newPlayer?.username, lobby: data });
    },
    onLeftLobby: () => {
      console.log('Left lobby, returning to main room');
      // The score modal's lobby is not this socket's any more (another tab
      // took the seat, or the lobby started its next game while this player
      // was still on the results: playAgain.leftOnResults): its Return goes
      // to the main room, as before
      session.forgetLobbyReturn();
      // The lobby's exit hook stops voice and removes it (a late reply at a
      // table changes nothing)
      if (session.hasTable) return;
      if (session.screen === SCREEN.LOBBY) session.transition(SCREEN.MAIN_ROOM);
      else removeGameLobby();
      session.requestMainRoom();
    },
    onAllPlayersReady: (data) => {
      console.log('All players ready, game starting soon...');
      // The game will start via positionUpdate/gameStart events
    },

    // Spectator callback
    onSpectatorJoined: (data) => {
      // The full game state (not just a notice that someone else joined):
      // the v1 keys or the snapshot (V1_REMOVALS #8 / #9: a snapshot-only
      // carrier), both only once the trump is dealt, as before; or a v2
      // snapshot of the draw for deal (the draw so far: render draws it, as
      // iOS shows a spectator the draws). CREATED too: a family lobby's
      // extras watch from the game's first tick, before its startDraw
      const drawing = ['CREATED', 'DRAWING', 'DRAW_RESOLVING'].includes(data.snapshot?.stage) && !!data.snapshot?.draw;
      const full = drawing || (!!(data.trump || data.snapshot?.trump) && !!(data.players || data.snapshot?.seats));
      const startedGameId = data.gameId || data.snapshot?.gameId || null;
      if (full && session.screen === SCREEN.GAME_END && session.lobbyReturn && startedGameId && startedGameId !== session.endedGameId) {
        // Play again: the reopened lobby started its next game while this
        // player was still on the score modal and the server made it an
        // extra (today's server never does: Return's lobbyReturnSeen has not
        // come, so it sends leftLobby instead, playAgain.leftOnResults, and
        // onLeftLobby forgets the return). The modal stays (owner 2026-11-16);
        // this socket stops watching (joinMainRoom: no table events reach
        // the modal) and Return asks for the lobby, which the server
        // answers with that game to watch while it lasts
        console.log('The lobby started its next game; the score modal stays');
        session.noteLobbyStarted(startedGameId);
        stopVoice();
        session.requestMainRoom();
        // Voice stopped with it: say so (a toast; the results stay as they are)
        showInfo('Your lobby started its next game, so voice chat ended. Return to Lobby to watch it.');
        return;
      }
      if (full) {
        const spectatedGameId = data.gameId || data.snapshot?.gameId || session.takePendingSpectate();
        session.routeArrived();
        // A joinLobby re-sent for a lobby that started meanwhile (a reload
        // during its start) is answered by this: nothing is pending any more.
        // Play again: the score modal's Return found its lobby playing
        const fromReturn = session.lobbyRejoinAfterGame;
        session.takePendingLobbyRejoin();
        restartNotice.clear();
        // Spectators persist spectatingGameId only (a reconnect re-spectates)
        session.enterTable(ROLE.SPECTATOR, spectatedGameId);
        // A re-spectate after a reconnect supersedes one still waiting for the scene
        session.supersedeTableWork();
        // The snapshot is the table (cli-20: names, turn glow, trump face up,
        // each opponent's cards); the log is the server's (one 'Game started!')
        rebuildTable(data, { source: 'spectate', role: 'spectator', suffix: 'Joined as spectator!' });
        if (fromReturn) showInfo("Your lobby started its next game. You're watching it.");
      } else if (data.username) {
        // Notification that another spectator joined — show in game log
        window.addToGameFeedFromLegacy?.(`${data.username} joined as a spectator.`, null);
      }
    },

    // Game callbacks - update GameState and trigger scene handlers
    onPositionUpdate: (data) => {
      console.log('📍 onPositionUpdate callback');
      // GameState applied the seating (handlers/gameHandlers.js). A log
      // already up (a spectator's draw) names the teams now, not at the deal
      if (gameLogInstance?.container?.isConnected) {
        const { teamName, oppName } = scoreHeaderNames(gameState.position, gameState.playerData, { spectator: !!gameState.isSpectator });
        gameLogInstance.updateNames(teamName, oppName);
      }
      // Player info box creation deferred to handleDisplayOpponentHands
      // so it appears at the same time as other players' avatars
    },
    onGameStart: (data) => {
      console.log('🎮 onGameStart callback');
      // A seat's deal always finds the table entered (startDraw/rejoin);
      // a stray one enters it
      if (!session.hasTable && data.position) session.enterTable(ROLE.PLAYER, data.gameId);
      // GameState applied the deal (handlers/gameHandlers.js); the scene
      // shows it, now or once it is ready
      withScene((scene) => {
        // Initialize managers with player position
        if (gameState.position) {
          if (scene.trickManager) {
            scene.trickManager.setPlayerPosition(gameState.position);
            scene.trickManager.updatePlayPositions();
            // Note: trick backgrounds are created after bidding completes (in onDoneBidding)
          }
          if (scene.opponentManager) {
            scene.opponentManager.setPlayerPosition(gameState.position);
          }
          if (scene.effectsManager) {
            scene.effectsManager.setPlayerPosition(gameState.position);
          }
        }

        // Display avatars and dealer button immediately
        if (scene.opponentManager) {
          scene.opponentManager.displayDealerButton(data.dealer);
          if (gameState.playerData) {
            scene.opponentManager.displayAvatars(gameState.playerData);
          }
        }

        // Create player info box (own avatar) immediately
        if (scene.createPlayerInfoBox && !scene._playerInfo && !gameState.isSpectator) {
          if (gameState.position && gameState.playerData) {
            scene.createPlayerInfoBox(gameState.playerData, gameState.position);
          }
        }

        // Update player's HSI display (only shown for self, not opponents)
        if (data.hsiValues && scene.updatePlayerHsi && gameState.position) {
          scene.updatePlayerHsi(data.hsiValues[gameState.position]);
        }

        // Create DOM backgrounds via LayoutManager (show immediately)
        if (scene.layoutManager) {
          scene.layoutManager.update();
          scene.layoutManager.createDomBackgrounds({ skipHandArea: gameState.isSpectator });
        }

        // Show the bid panel once the trump is face up (this deal only: the
        // flip is the director's, keyed to the deal; cli-19, ui-22)
        const showBidUIAfterFlip = () => {
          if (gameState.isLazy || gameState.isSpectator) return;
          if (gameState.bids[gameState.position] !== undefined) return;
          if (scene.bidManager && data.hand) {
            scene.bidManager.showBidUI(data.hand.length, (bid) => scene.submitBid(bid));
          }
        };

        // Display trump card face down; it flips after the deal. My bid
        // turn's cue waits for the flip, as the bid panel does
        if (data.trump && scene.displayTrumpCard) {
          scene.displayTrumpCard(data.trump, {
            onFlipped: () => {
              getTableSounds().trumpShown();
              showBidUIAfterFlip();
            },
          });
        } else {
          getTableSounds().trumpShown();
        }

        // Deal the cards once the first hand's fade or the previous hand's
        // trick whisk is over (director.afterTransition)
        const showCards = () => {
          // The trump takes this hand's back (it kept the finished hand's
          // through the whisk)
          scene.dealTrumpBack?.();

          // The deal's sound, as the cards go down (live deals only)
          getTableSounds().dealShown();

          // Display player hand via CardManager
          if (scene.handleDisplayHand && data.hand) {
            scene.handleDisplayHand(data.hand, false);
          }

          // In lazy mode, disable card interaction after dealing
          if (gameState.isLazy && scene.cardManager) {
            scene.cardManager.setInteractive(false);
          }

          // Display opponent card backs (skip avatars since already shown)
          if (scene.opponentManager) {
            const cardCount = data.currentHand || data.hand?.length;
            if (cardCount) {
              scene.opponentManager.displayOpponentCards(cardCount);
            }
          }

          // Show game log trick indicator as cards are dealt
          if (gameLogInstance && gameLogInstance.showTrickIndicator && data.hand) {
            gameLogInstance.showTrickIndicator(data.hand.length);
          }
        };
        director.afterTransition(showCards);

        // Update game log score display (projected from GameState)
        scene.renderScoreHeader?.();
      }, 'deal');

      // Update hand indicator
      if (data.currentHand !== undefined) {
        window.updateHandIndicatorFromLegacy(data.currentHand);
      }
    },
    // Draw phase - handled by DrawManager
    onStartDraw: (data) => {
      console.log('🎴 onStartDraw callback');
      // The score modal of a casual game whose lobby reopened (play again)
      // stays: a startDraw there is the reopened lobby's next game, sent
      // before this socket stopped watching it (onSpectatorJoined)
      if (session.screen === SCREEN.GAME_END && session.lobbyReturn) {
        console.log('startDraw ignored: the score modal of a game whose lobby reopened');
        return;
      }
      // A new table while the previous one's score modal is still up (the
      // next tournament round): that table goes first
      if (session.screen === SCREEN.GAME_END) {
        session.exitTable(EXIT.NEW_TABLE, { route: false });
        gameState.setPhase(PHASE.DRAW);
        gameState.stage = 'DRAWING';
        gameState.beginDraw();
      }
      // A watcher (a family lobby's extra, at the table since CREATED) or a
      // spectate on its way never becomes a player from the room's startDraw
      if (!session.isAtTable && !session.pendingSpectate) session.enterTable(ROLE.PLAYER, null);
      // Remove waiting screen and tournament lobby (its clearUI also takes
      // down a watcher's log from the CREATED join: the draw has none, as a
      // seat's; createUI brings it back)
      uiManager.removeWaitingScreen();
      removeTournamentLobby();
      // ...and the log's column goes with the log: never an empty dark
      // column beside the draw
      if (!gameLogInstance?.container?.isConnected) setTableChrome(false);

      // Use DrawManager via scene handler (the scene may be restarting)
      withScene((scene) => scene.handleStartDraw(data), 'draw');
    },
    onYouDrew: (data) => {
      withScene((scene) => scene.handleYouDrew(data), 'draw');
    },
    onPlayerDrew: (data) => {
      withScene((scene) => scene.handlePlayerDrew(data), 'draw');
    },
    onTeamsAnnounced: (data) => {
      withScene((scene) => scene.handleTeamsAnnounced(data), 'draw');
    },
    onCreateUI: (data) => {
      console.log('🎨 onCreateUI callback');
      // Remove waiting screen and lobby/main room/tournament UI
      uiManager.removeWaitingScreen();
      removeMainRoom();
      removeGameLobby();
      removeTournamentLobby();

      // Clean up draw phase via DrawManager with fade transition (once the
      // scene is ready: before create() it is buffered, never dropped)
      withScene((scene) => {
        // Pass UI creation as callback - it will be called after fade to black
        scene.handleCreateUI(data, () => {
          // Create game feed using modular GameLog (a detached one, e.g.
          // left over from a sign-out, counts as none)
          if (gameLogInstance && !gameLogInstance.container?.isConnected) {
            gameLogInstance = null;
          }
          if (!gameLogInstance) {
            gameLogInstance = showGameLog({
              // false (the emit gate refused it, offline): the log keeps the draft
              onChatSubmit: (message) => getSocketManager()?.socket?.emit('chatMessage', { message }) ?? false,
            });

            // The log's grid column (--log-w) comes on
            setTableChrome(true);

            // The canvas takes the narrower column (Phaser then relayouts the table)
            requestAnimationFrame(() => syncCanvasSize(scene));

            // Add initial message
            gameLogInstance.addGameMessage('Game started!');

            // Update hand indicator from current game state
            if (gameState.currentHand !== undefined) {
              window.updateHandIndicatorFromLegacy(gameState.currentHand);
            }
          }
        });
      }, 'draw');
    },
    // Bidding and play: GameState applied the event (handlers/gameHandlers.js);
    // the scene animates it, now or once it is ready
    onBidReceived: (data) => {
      withScene((scene) => {
        scene.handleBidReceived(data);
        // Update game log trick indicator
        gameLogInstance?.updateTrickIndicator?.();
      });
    },
    onDoneBidding: (data) => {
      withScene((scene) => {
        // A deal still waiting for its fade / whisk is put down first
        director.settleDeal();
        scene.handleDoneBidding(data);

        // Create trick backgrounds now that bidding is complete
        if (scene.trickManager && data.bids) {
          // Bids array is indexed by position-1; a bore counts as the whole
          // hand and each total is capped at the hand size (rules/bids.js)
          const totals = bidTotalsFor(data.bids, gameState.position || 1, gameState.currentHand);
          scene.trickManager.setBidTotals(totals.team, totals.opp);
          scene.trickManager.createTrickBackgrounds();
        }
      });
    },
    onUpdateTurn: (data) => {
      withScene((scene) => scene.handleUpdateTurn(data));
    },
    onCardPlayed: (data) => {
      withScene((scene) => {
        // The card must come from a dealt hand: a deal still waiting goes down now
        director.settleDeal();
        scene.handleCardPlayed(data);
      });
    },
    onTrickComplete: (data) => {
      withScene((scene) => {
        director.settleDeal();
        scene.handleTrickComplete(data);
      });
    },
    // Hand & game end - call GameScene handlers
    onHandComplete: (data) => {
      // The hand's bids, for its log lines (GameState resets them next)
      const bids = { ...gameState.bids };
      withScene((scene) => {
        director.settleDeal();
        scene.handleHandComplete(data, { bids });
      });
      // Hide game log trick indicator at end of hand
      if (gameLogInstance && gameLogInstance.hideTrickIndicator) {
        gameLogInstance.hideTrickIndicator();
      }
    },
    onGameEnd: (data) => {
      const scene = getGameScene();
      if (gameLogInstance && gameLogInstance.hideTrickIndicator) {
        gameLogInstance.hideTrickIndicator();
      }
      // Nobody's turn any more: the turn ring stops (its animation with it)
      scene?.opponentManager?.removeTurnGlow?.();
      scene?.cardManager?.removeTurnGlow?.();

      // Determine which team the player is on (positions 1,3 = Team 1, positions 2,4 = Team 2)
      // Spectators view from position 1 but aren't on either team
      const position = gameState.position;
      const isSpectator = gameState.isSpectator;
      let teamScore, oppScore;
      if (position % 2 !== 0) {
        teamScore = data.score.team1;
        oppScore = data.score.team2;
      } else {
        teamScore = data.score.team2;
        oppScore = data.score.team1;
      }

      // Add game end messages to game log
      const playerData = gameState.playerData;
      const messages = formatGameEndMessages({
        myPosition: position,
        playerData: playerData,
        teamScore: teamScore,
        oppScore: oppScore,
        isSpectator: isSpectator,
      });
      messages.forEach(msg => window.addToGameFeedFromLegacy(msg));

      // Update game log score display (player names only: the header
      // never shows a placeholder; the score modal's getTeamNames gives the
      // same names, never a placeholder either)
      const header = scoreHeaderNames(position, playerData, { spectator: !!isSpectator });
      window.updateGameLogScoreFromLegacy(header.teamName, header.oppName, teamScore, oppScore);
      const { teamName, oppName } = getTeamNames(position, playerData, { spectator: !!isSpectator });

      // Determine return flow: tournament game returns to tournament, normal game to main room.
      // The server always includes tournamentId in gameEnd (null for casual
      // games), so prefer it — a stale local tournamentId from a previous
      // tournament must not hijack a casual game's end screen.
      if (data.tournamentId !== undefined) {
        gameState.tournamentId = data.tournamentId || null;
      }
      const isTournamentGame = !!gameState.tournamentId;

      // The table stays up under the score modal; nothing to rejoin now
      session.endGame();

      // Show final score overlay
      showFinalScoreOverlay({
        teamScore: teamScore,
        oppScore: oppScore,
        playerStats: data.playerStats,
        buttonText: isTournamentGame ? 'Return to Tournament' : undefined,
        isSpectator: isSpectator,
        teamName: teamName,
        oppName: oppName,
        // exitTable routes by the tournament at click time (a cancel
        // meanwhile already sent this player to the main room)
        // Play again: a casual game whose lobby reopened goes back there
        // (the button keeps its label: owner 2026-11-16)
        onReturnToLobby: () => {
          if (returnToReopenedLobby()) return;
          session.exitTable(EXIT.GAME_END_RETURN);
        }
      });
    },
    onRainbow: (data) => {
      withScene((scene) => scene.handleRainbow(data));
    },
    onDestroyHands: (data) => {
      withScene((scene) => {
        director.settleDeal();
        scene.handleDestroyHands(data);
      });
    },
    // Error & connection handlers
    onAbortGame: (data) => {
      console.log("Handling abortGame");
      const scene = getGameScene();
      if (scene) scene.handleAbortGame(data);
      // From the table (or a lobby/tournament lobby whose game was about to
      // start): out to the tournament for a tournament player, as iOS does,
      // else the main room. Nothing is routed from the main room or sign-in
      const route = session.screen !== SCREEN.MAIN_ROOM && session.screen !== SCREEN.SIGN_IN;
      session.exitTable(EXIT.ABORT, { route });
    },
    // Reconnection handlers
    onRejoinSuccess: (data) => {
      // One rejoinGame per socket; the server still answers a repeated lazy
      // rejoin, and processing it twice would replay the game log twice
      // The game and my role from the v1 keys, else the snapshot (V1_REMOVALS
      // #9: the carrier may come down to {snapshot, tournamentId})
      const gameId = data.gameId || data.snapshot?.gameId;
      const lazy = data.isLazy !== undefined ? !!data.isLazy : data.snapshot?.viewer?.role === 'lazyWatcher';
      if (!session.noteRejoinSuccess(gameId)) {
        console.log('Duplicate rejoinSuccess on this socket ignored');
        return;
      }
      session.enterTable(lazy ? ROLE.LAZY : ROLE.PLAYER, gameId);
      // The game survived: nothing to explain
      restartNotice.clear();
      // Restore tournament context (server includes it when the rejoined game
      // belongs to a tournament) so the game-end screen offers 'Return to Tournament'
      if (data.tournamentId !== undefined) {
        gameState.tournamentId = data.tournamentId;
      }
      // The snapshot is the table: a rejoin onto a live scene draws exactly
      // what a fresh page would (cli-4)
      rebuildTable(data, { source: 'rejoin', role: lazy ? 'lazyWatcher' : 'seat', suffix: 'Reconnected to game!' });
      // Re-establish voice on reconnect
      if (!voiceManager.active) {
        startVoice();
      }
    },
    onRejoinFailed: (data) => {
      // 'Already connected': this socket's seat is live, keep it
      const reason = typeof data === 'string' ? data : data?.reason;
      // The emit gate waited for this answer (ClientSession.onSessionRestored)
      session.noteRejoinFailed(reason);
      if (reason === 'Already connected') return;
      // The game is gone (or was left): take any table down, route out
      session.exitTable(EXIT.REJOIN_FAILED);
      // After a server restart: say what ended
      explainRestartLoss();
    },
    onPlayerReconnected: (data) => {
      console.log(`Player at position ${data.position} (${data.username}) reconnected`);
      // Their 'Replace with Bot?' offer is moot now
      dismissResignationDialog(data.position);
    },

    // Resignation & Lazy Mode callbacks
    onResignationAvailable: (data) => {
      // One offer at a time: a kit Modal (ui/components/ResignationDialog.js;
      // the username goes in as text)
      showResignationDialog({
        position: data.position,
        username: data.username,
        // an idle (connected) player at a tournament table, not a disconnect
        idle: data.idle === true,
        onConfirm: () => socket.emit('forceResign', { position: data.position }),
      });
    },
    onPlayerResigned: (data) => {
      // Dismiss any open resignation modal (another player may have already clicked resign)
      dismissResignationDialog();

      // Update opponent avatar via scene
      const scene = getGameScene();
      if (scene && scene.handlePlayerResigned) {
        scene.handlePlayerResigned(data);
      }

      // Add system message to game log
      window.addToGameFeedFromLegacy?.(`${data.oldUsername} has been resigned. ${data.botUsername} is taking over.`, null);
    },
    onPlayerLazyMode: (data) => {
      // GameState marked my seat lazy (handlers/gameHandlers.js)
      const mine = data.position === gameState.position && !gameState.isSpectator;
      if (mine) {
        session.setRole(ROLE.LAZY);
        setSpectatingIndicator('lazy');
      }
      withScene((scene) => {
        scene.handlePlayerLazyMode(data);
        // My cards and bid panel are the bot's now
        if (mine) {
          scene.cardManager?.setInteractive(false);
          scene.bidManager?.hideBidUI();
        }
      });
    },
    onPlayerActiveMode: (data) => {
      const mine = data.position === gameState.position && !gameState.isSpectator;
      if (mine) {
        session.setRole(ROLE.PLAYER);
        setSpectatingIndicator(null);
      }
      withScene((scene) => {
        scene.handlePlayerActiveMode(data);
        // The seat is mine again: lazy mode had dimmed every card and hidden
        // the bid UI; recompute legality for the open turn, and hand the bid
        // back mid-bid (cli-1)
        if (mine) {
          scene.cardManager?.setInteractive(true);
          scene.refreshControlAfterActive?.((bid) => scene.submitBid(bid));
        }
      });
    },
    onLeftGame: (data) => {
      // /leave (seat or spectating): out to the tournament for a tournament
      // player, as iOS does, else the main room
      session.exitTable(EXIT.LEFT_GAME);
    },
    onRestorePlayerState: (data) => {
      // Spectator → active player (/active from the watch view), or the
      // resync after a refused play: the snapshot is the table, drawn over
      // the live scene (voice and an open offer stay)
      // A seat now: its gameId persists for a reconnect
      session.enterTable(ROLE.PLAYER, data.gameId || data.snapshot?.gameId || session.gameId);
      session.supersedeTableWork();
      rebuildTable(data, { source: 'restore', role: 'seat', suffix: 'Reconnected to game!' });
    },
    // My bid or play was refused: the card returns to the hand (its snapshot
    // has it; the log is kept: partial 'log')
    onActionRejected: (data) => {
      if (!session.isAtTable) return;
      const applied = applyTableSnapshot(data, {
        source: 'rejected',
        render: (snap) => scheduleRender({ log: logOf(snap) }),
      });
      // No snapshot: GameState never lost the card; draw it back from the state
      if (!applied) scheduleRender({});
      const reasons = {
        not_your_turn: 'Not your turn',
        illegal_card: "That card can't be played now",
        invalid_play: "That card can't be played",
        already_played: 'You already played this trick',
        already_bid: 'You already bid',
        invalid_bid: "That bid isn't allowed",
      };
      showWarning(reasons[data.reason] || 'Action not accepted');
    },
    // Who is watching changed (GameState has applied it): the badge only,
    // at the table (a render draws it from the same state)
    onSpectatorsUpdated: (watching) => {
      if (!session.isAtTable) return;
      renderSpectatorBadge(watching, { me: gameState.username });
      // who counts as a watcher changed: the forced mute follows
      applyForcedMute();
    },
    // A casual game's voice settings (spectator voice)
    onVoiceSettings: (data) => onVoiceSettings(data),
    // The reply to requestSnapshot: a seq gap, an ack timeout, the liveness
    // ping. Any snapshot of this table is applied (R3); not_in_game applies
    // what the gap buffer holds (no snapshot is coming)
    onStateSnapshot: (data) => {
      const source = snapshotSource(data.requestId);
      if (!data.snapshot) {
        if (seqGate.buffered > 0) seqGate.flushBuffer();
        return;
      }
      if (!session.isAtTable) return;
      if (gameState.gameId && data.snapshot.gameId && data.snapshot.gameId !== gameState.gameId) return;
      applyTableSnapshot(data, {
        source,
        render: (snap) => {
          const live = !!snap.deal && !['ENDED', 'ABORTED'].includes(snap.stage);
          // Before the deal the draw / teams screens stay as they are
          if (live) scheduleRender({ log: logOf(snap) });
        },
      });
    },
    onGameLogEntry: (data) => {
      if (data.type === 'system') {
        window.addToGameFeedFromLegacy?.(data.message, null);
      } else if (data.playerPosition !== undefined) {
        window.addToGameFeedFromLegacy?.(data.message, data.playerPosition);
      }
    },

    // Chat callback - add to game feed and show bubble
    onChatMessage: (data) => {
      if (data.username && isUserBlocked(data.username)) return;

      const scene = getGameScene();
      const state = getGameState();

      // Get sender name from player data or fall back to username in data
      const senderName = data.username || getPlayerName(data.position, state.playerData);

      // Add to game feed with player position for color coding
      const chatPosition = data.isSpectator ? 'spectator' : data.position;
      if (scene && scene.handleAddToGameFeed) {
        scene.handleAddToGameFeed(`${senderName}: ${data.message}`, chatPosition);
      } else if (window.addToGameFeedFromLegacy) {
        window.addToGameFeedFromLegacy(`${senderName}: ${data.message}`, chatPosition);
      }

      // A spectator's message (also a watching seat owner's: the server
      // sends both without a position) goes by the spectator badge with
      // the sender's name, the badge standing for everyone watching; a
      // player's over its seat
      if (data.isSpectator) {
        if (session.isAtTable) showSpectatorChatBubble(senderName, data.message);
      } else if (scene && scene.handleShowChatBubble && state.position) {
        scene.handleShowChatBubble(state.position, data.position, data.message);
      }
    },

    // Profile callbacks. Stats replies carry the scope they were asked
    // for (state/statsScope.js): one for an older choice (a fast switch) is
    // dropped; one for an open page updates it in place (focus stays on
    // the scope control)
    onProfileReceived: (profile, scope) => {
      if (isStaleScopeReply(scope)) return;
      if (updateProfileStats(profile, scope)) return;
      showProfilePage(profile, socket, scope ?? getStatsScope());
    },
    onProfileError: (message) => {
      profileStatsRequestFailed();
      showError(message || 'Failed to load profile');
    },
    onProfilePicUpdated: (newPic) => {
      updateProfilePicDisplay(newPic);
      showSuccess('Profile picture updated!');
    },
    onProfilePicUpdateError: (message) => {
      showError(message || 'Failed to update profile picture');
    },
    onCustomProfilePicUploaded: (customPic) => {
      updateCustomProfilePicDisplay(customPic);
      showSuccess('Profile picture uploaded!');
    },
    onCustomProfilePicUploadError: (message) => {
      showError(message || 'Failed to upload profile picture');
    },
    onSearchPlayersResult: (players, query) => {
      updatePlayerSearchResults(players, query);
    },
    onPlayerProfileReceived: (profile, scope) => {
      if (isStaleScopeReply(scope)) return;
      if (updatePlayerProfileStats(profile, scope)) return;
      showPlayerProfilePage(profile, socket, { isBlocked: isUserBlocked(profile.username), scope: scope ?? getStatsScope() });
    },
    onPlayerProfileError: () => {
      profileStatsRequestFailed();
    },
    // Leaderboard callbacks
    onLeaderboardReceived: (leaderboard, scope) => {
      if (isStaleScopeReply(scope)) return;
      if (updateLeaderboardPage(leaderboard, scope)) return;
      showLeaderboardPage(leaderboard, socket, scope ?? getStatsScope());
    },
    onLeaderboardError: (message, scope) => {
      if (isStaleScopeReply(scope)) return;
      leaderboardRequestFailed();
      showError(message || 'Failed to load leaderboard');
    },
    // Records callbacks
    onRecordsReceived: (records, totalGames, scope, periodGames) => {
      if (isStaleScopeReply(scope)) return;
      if (updateRecordsPage(records, totalGames, scope, periodGames)) return;
      showRecordsPage(records, totalGames, socket, scope ?? getStatsScope(), periodGames);
    },
    onRecordsError: (message, scope) => {
      if (isStaleScopeReply(scope)) return;
      recordsRequestFailed();
      showError(message || 'Failed to load records');
    },

    // Tournament callbacks
    onTournamentCreated: (data) => {
      gameState.tournamentId = data.tournamentId;
      session.routeArrived();
      if (session.hasTable) return;
      uiManager.showScreen(SCREENS.TOURNAMENT_LOBBY, data);
    },

    onTournamentJoined: (data) => {
      gameState.tournamentId = data.tournamentId;
      // A tab that only watches this tournament: the server's reply to
      // returnToTournament (after watching one of its tables) carries no
      // isSpectator flag, and a spectator gets no player controls
      if (!data.isSpectator && session.isTournamentSpectator(data.tournamentId)) {
        data = { ...data, isSpectator: true };
      }
      if (data.messages) {
        data.messages = data.messages.filter(m => !isUserBlocked(m.username));
      }
      session.routeArrived();
      restartNotice.clear();
      if (session.hasTable) {
        console.log('Tournament joined event ignored - at the table');
        return;
      }
      uiManager.showScreen(SCREENS.TOURNAMENT_LOBBY, data);

      // Returning to a finished tournament (e.g. from the game-end screen):
      // show the final results on top of the lobby
      if (data.phase === 'complete') {
        const pending = gameState.pendingTournamentResults;
        const scoreboard = data.scoreboard || pending?.scoreboard || [];
        // Fresh server data first (getClientState now includes winners for
        // completed tournaments); pending is only a same-session fallback
        let winners = data.winners;
        if (!winners || winners.length === 0) winners = pending?.winners;
        if (!winners || winners.length === 0) {
          const top = scoreboard.length > 0 ? scoreboard[0].totalScore : null;
          winners = top === null ? [] : scoreboard.filter(e => e.totalScore === top).map(e => e.username);
        }
        showTournamentResultsOverlay({
          scoreboard,
          winners,
          onReturn: () => {
            gameState.tournamentId = null;
            gameState.pendingTournamentResults = null;
            session.transition(SCREEN.MAIN_ROOM);
            session.requestMainRoom();
          }
        });
      }
    },

    onTournamentPlayerJoined: (data) => {
      updateTournamentPlayers(data.players, gameState.username);
      // the joiner's scoreboard row (servers since 2026-11-11 send it)
      if (Array.isArray(data.scoreboard)) updateTournamentScoreboardUI(data.scoreboard);
    },

    onTournamentPlayerLeft: (data) => {
      // The host left: the role passed on (to me: the Begin / Cancel
      // controls appear in place)
      updateTournamentPlayers(data.players, gameState.username, data.newCreator);
      if (data.newCreator) {
        showInfo(data.newCreator === gameState.username ? 'You are now the tournament host' : `${data.newCreator} is now the tournament host`);
      }
    },

    onTournamentReadyUpdate: (data) => {
      updateTournamentPlayers(data.players, gameState.username);
      // between rounds only (servers since 2026-11-15): past the ready deadline
      if (typeof data.readyDeadlinePassed === 'boolean') setReadyDeadlinePassed(data.readyDeadlinePassed);
    },

    onTournamentMessage: (data) => {
      const isSystem = data.system === true;
      // a server notice is nobody's line, so blocking a player named "System" cannot hide it
      if (!isSystem && isUserBlocked(data.username)) return;
      addTournamentChatMessage(data.username, data.message, data.isSpectator, isSystem);
    },

    onTournamentRoundStart: (data) => {
      updateTournamentRoundIndicator(data.roundNumber, data.totalRounds);
      setTournamentPhase('round_active');
    },

    onTournamentGameAssignment: (data) => {
      // Store tournament context for game end flow
      gameState.tournamentId = data.tournamentId;
      console.log(`Assigned to tournament game: ${data.gameId} (round ${data.roundNumber})`);
    },

    onTournamentGameComplete: (data) => {
      // Update active games in tournament lobby (if visible)
      if (data.activeGames) {
        updateTournamentActiveGames(data.activeGames, socket);
      }
      if (data.scoreboard) {
        updateTournamentScoreboardUI(data.scoreboard, data.currentRound, data.totalRounds);
      }
    },

    onTournamentRoundComplete: (data) => {
      setTournamentPhase('between_rounds');
      if (data.scoreboard) {
        updateTournamentScoreboardUI(data.scoreboard, data.currentRound, data.totalRounds);
      }
      updateTournamentRoundIndicator(data.currentRound, data.totalRounds);
    },

    onTournamentComplete: (data) => {
      const winners = data.winners && data.winners.length > 0
        ? data.winners
        : (data.scoreboard && data.scoreboard.length > 0 ? [data.scoreboard[0].username] : []);

      // If the player is still on the game-end screen, don't stack the results
      // on top of the score modal — they'll see them after clicking 'Return to
      // Tournament' (the server keeps the tournament alive for this)
      if (document.getElementById('finalScoreOverlay')) {
        gameState.pendingTournamentResults = { scoreboard: data.scoreboard, winners };
        return;
      }

      showTournamentResultsOverlay({
        scoreboard: data.scoreboard,
        winners,
        onReturn: () => {
          gameState.tournamentId = null;
          gameState.pendingTournamentResults = null;
          if (!session.hasTable) session.transition(SCREEN.MAIN_ROOM);
          session.requestMainRoom();
        }
      });
    },

    onTournamentLeft: () => {
      // Back from a tournament's score screen after a restart: it is gone
      const lost = restartNotice.pending;
      if (lost === LOSS.TOURNAMENT || lost === LOSS.TOURNAMENT_SPECTATOR) explainRestartLoss();
      gameState.tournamentId = null;
      gameState.pendingTournamentResults = null;
      // The server sends mainRoomJoined next
      if (session.screen === SCREEN.TOURNAMENT_LOBBY) session.transition(SCREEN.MAIN_ROOM);
      else removeTournamentLobby();
    },

    onTournamentCancelled: () => {
      gameState.tournamentId = null;
      gameState.pendingTournamentResults = null;
      showInfo('Tournament has been cancelled by the host');
      // The server aborted every live table first (abortGame already sent
      // this player out, its returnToTournament lands in the main room):
      // one route request at a time, so no second joinMainRoom here
      if (session.hasTable) {
        session.exitTable(EXIT.TOURNAMENT_CANCELLED, { to: SCREEN.MAIN_ROOM });
      } else if (session.screen === SCREEN.TOURNAMENT_LOBBY) {
        session.transition(SCREEN.MAIN_ROOM);
        session.requestMainRoom();
      } else {
        removeTournamentLobby();
      }
    },
  });

  // Note: window.socket is already set at module level above

  console.log('App initialization complete');
}

/**
 * Go to the sign-in screen. With a reason (forceLogout, a failed restore or
 * reconnect) or from a table, it is an exit: session.exitTable tears the
 * table down and clears every gameId copy first.
 * @param {string} [reason] - EXIT.*
 */
function displaySignInScreen(reason = null) {
  // Signed out (forceLogout, sign out, a failed restore): nothing to restore
  stopRestoreRetry();
  if (reason || session.hasTable) {
    session.exitTable(reason || EXIT.SIGN_OUT, { to: SCREEN.SIGN_IN });
  } else {
    session.transition(SCREEN.SIGN_IN);
  }
}

/**
 * Render the sign-in screen (the SIGN_IN enter hook).
 */
function renderSignIn() {
  // Pre-fill username if we have it stored (e.g., after failed rejoin)
  const storedUsername = safeSessionStorage().getItem('username') || '';

  showSignInScreen({
    onSignIn: ({ username, password }) => {
      console.log('Signing in as:', username);
      socket.emit('signIn', { username, password });
    },
    onCreateAccount: ({ username, password }) => {
      console.log('Creating account, showing register screen');
      // Remove sign-in screen
      const signInContainer = document.getElementById('sign-in-container');
      if (signInContainer) signInContainer.remove();
      const signInVignette = document.getElementById('sign-in-vignette');
      if (signInVignette) signInVignette.remove();
      // Show register screen
      displayRegisterScreen(username, password);
    },
    prefill: {
      username: storedUsername,
    },
  });
}

/**
 * Show the register screen with proper callbacks.
 */
function displayRegisterScreen(prefillUsername = '', prefillPassword = '') {
  showRegisterScreen({
    onRegister: ({ username, password }) => {
      console.log('Registering as:', username);
      socket.emit('signUp', { username, password });
    },
    onBackToSignIn: () => {
      // Remove register screen
      const registerContainer = document.getElementById('register-container');
      if (registerContainer) registerContainer.remove();
      const registerVignette = document.getElementById('register-vignette');
      if (registerVignette) registerVignette.remove();
      // Show sign-in screen
      displaySignInScreen();
    },
    prefill: {
      username: prefillUsername,
      password: prefillPassword,
    },
  });
}

/**
 * This tab is live again (its own restore or sign-in answered, or it was
 * signed out): the "open in another tab" notice and the parking go.
 */
function leaveParked() {
  if (!session.isParked && !isSupersededNoticeShown()) return;
  session.unpark();
  getSocketManager().setParked(false);
  hideSupersededNotice();
}

/**
 * This tab is parked and this device was signed out in another tab
 * (Profile Sign Out clears the saved session; review 2026-11-12): this tab
 * signs out as well, on a fresh anonymous socket, so its own copy of the
 * session cannot be continued with one click on Use here by the next
 * person at a shared computer.
 */
function signOutParkedTab() {
  if (!session.isParked && !isSupersededNoticeShown()) return;
  console.log('Signed out in another tab: this paused tab signs out too');
  clearAllSessionData();
  restartNotice.clear();
  leaveParked();
  session.clearIdentity();
  setIsAdmin(false);
  setBlockedUsers([]);
  displaySignInScreen(EXIT.SIGN_OUT);
  // The parked socket still claims the player on the server
  getSocketManager().forceReconnect();
}

/** restoreSessionResponse failures that need no explanation (sign in again). */
const ROUTINE_RESTORE_FAILURES = new Set(['Invalid session token', 'User not found']);

// A restore failure marked retryable (a database error, a name an admin
// action holds for a moment; additive 2026-11-15): the saved token is kept
// and restoreSession goes out again on the same socket after 1 s, doubling
// to 30 s (the server allows 10 a minute per socket), with the banner's
// 'Reconnecting…'. A new socket restores by itself (and starts over); a
// success, a sign-in, a sign-up, the sign-in screen or any other failure
// stops it.
export const RESTORE_RETRY_MIN_MS = 1000;
export const RESTORE_RETRY_MAX_MS = 30000;
let connectionBannerRef = null;
const restoreRetry = { attempt: 0, socketId: null, timer: null };

function stopRestoreRetry() {
  clearTimeout(restoreRetry.timer);
  restoreRetry.timer = null;
  restoreRetry.attempt = 0;
  restoreRetry.socketId = null;
  connectionBannerRef?.noteRestoring(false);
}

function scheduleRestoreRetry() {
  const id = socket.id;
  if (restoreRetry.socketId !== id) {
    restoreRetry.socketId = id;
    restoreRetry.attempt = 0;
  }
  const delay = Math.min(RESTORE_RETRY_MAX_MS, RESTORE_RETRY_MIN_MS * 2 ** restoreRetry.attempt);
  restoreRetry.attempt++;
  clearTimeout(restoreRetry.timer);
  connectionBannerRef?.noteRestoring(true);
  restoreRetry.timer = setTimeout(() => {
    restoreRetry.timer = null;
    // Another socket by now: its own connect restored (or will)
    if (socket.id !== id || !socket.connected || !session.credentials()) return;
    session.retryResume();
  }, delay);
}

// restoreSessionResponse: sent for session.resume() (every connect of a
// signed-in tab, once per socket)
socket.on('restoreSessionResponse', (data) => {
  // Whatever the answer, this tab is no longer paused behind another one
  leaveParked();
  if (data.success) {
    console.log('Session restored successfully');
    stopRestoreRetry();
    notePasswordReset(data);
    setBlockedUsers(data.blockedUsers);
    setIsAdmin(data.isAdmin === true);
    // Then rejoin, re-spectate, or re-enter the current screen
    const action = session.onSessionRestored(data);
    console.log(`Session restored: ${action}`);
  } else if (data.retryable === true && session.credentials()) {
    // Passing: keep the token (and the screen) and ask again
    console.log('Session restore failed, retrying:', data.message);
    scheduleRestoreRetry();
  } else {
    console.log('Session restore failed:', data.message);
    stopRestoreRetry();
    // Clear invalid session data (and the device's saved copy of it)
    forgetSession(safeSessionStorage().getItem('sessionToken'));
    safeSessionStorage().removeItem('username');
    safeSessionStorage().removeItem('sessionToken');
    session.clearIdentity();
    restartNotice.clear();
    setIsAdmin(false);
    displaySignInScreen(EXIT.SIGN_OUT);
    // Say why when the server said something a player can act on ("This
    // account is now called X. Sign in as X.", a merged account's redirect,
    // "being updated", a database error); an expired or revoked saved
    // session just shows the sign-in screen
    if (data.message && !ROUTINE_RESTORE_FAILURES.has(data.message)) showInfo(data.message);
  }
});

/**
 * Start the page: show sign-in or attempt rejoin. Runs once, on the window
 * load event, or from the boot module (src/boot/boot.js) when this chunk
 * arrives after load (it is imported by the entry, not a page script).
 */
let appStarted = false;
export function startApp() {
  if (appStarted) return;
  appStarted = true;

  // The card index font (cards/cardFont.js): fetched now so it is ready
  // long before a table; the card atlas redraws if it lands later
  loadCardFont();

  // Sound effects start on the first click or key (browsers allow audio
  // only after a gesture)
  getSoundManager().installUnlock(window);

  // Initialize the app
  initializeApp();

  // Create the Phaser game - GameScene.create() will call setGameScene
  createPhaserGame('game-container');
  // A lost WebGL context takes every texture with it (Phaser 3.55 restores
  // no textures): reload once, with a message, on the table's screens;
  // elsewhere when the table next shows (phaser/webglContext.js)
  installContextLossHandling({
    game: getPhaserGame(),
    notify: (kind, text) => (kind === 'stuck' ? showWarning(text, 60000) : showInfo(text)),
    isTableShowing: () => LOOP_SCREENS.includes(session.screen),
    onScreenChange: (fn) => session.onScreenChange(fn),
  });
  // The loop runs only on the table's screens (cli-23, webclient-10)
  loopControl = installLoopControl({ session, getGame: () => getPhaserGame() });

  // A fresh tab (or a reopened browser) resumes this device's saved session
  if (adoptSavedSession()) {
    console.log('Resuming saved session from this device');
  }

  const username = safeSessionStorage().getItem('username');
  console.log(`Window load: username=${username}, sessionToken=${session.credentials() ? 'present' : 'none'}, gameId=${session.persistedGameId}, spectating=${session.persistedSpectateId}`);

  if (!session.credentials()) {
    // Not signed in (or a legacy tab without a token): the sign-in screen
    displaySignInScreen();
  }
  // Handlers are registered: every connect from now on restores the session
  // first (now, if the socket is up), then rejoins / re-spectates / re-enters
  session.start();
}

// No load listener of its own: boot (src/boot/boot.js startApp) runs it
// after the load event, inside the promise whose failure reloads once
