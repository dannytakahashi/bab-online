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
import { createVoiceGate, lobbyOthers as lobbyOthersOf } from './voice/voiceCompany.js';
import { installContextLossHandling } from './phaser/webglContext.js';
import { installAvatarSupport } from './utils/avatar.js';
import { getClientErrorReporter } from './telemetry/clientErrors.js';

// Rules
import { isLegalMove } from './rules/legality.js';
import { bidTotalsFor } from './rules/bids.js';
import { soloHeaderRows, formatSoloGameEndMessages } from './state/gyb.js';

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
import { speakingSlotFor, spectatorSpeakerFor } from './voice/speakingSlot.js';
import { installVoiceHotkeys } from './voice/voiceHotkeys.js';
import { forgetSessionMute } from './voice/voiceSessionMute.js';

// UI Components
import { showToast, showError, showSuccess, showWarning, showInfo, showNotice, TOAST_SHORT } from './ui/components/Toast.js';
import { NOTICE, serverErrorNotice } from './state/noticeText.js';
import { showSignInScreen } from './ui/screens/SignIn.js';
import { showRegisterScreen } from './ui/screens/Register.js';
import { showMainRoom, addMainRoomChatMessage, updateLobbyList, removeMainRoom, updateMainRoomOnlineCount } from './ui/screens/MainRoom.js';
import { showGameLobby, updateLobbyPlayersList, addLobbyChatMessage, removeGameLobby, focusLobbyStart, isLobbyTableFullForMe } from './ui/screens/GameLobby.js';
import {
  showProfilePage, updateProfilePicDisplay, updateCustomProfilePicDisplay, showPlayerProfilePage, showDeleteAccountError,
  updateProfileStats, updatePlayerProfileStats, profileStatsRequestFailed, showChangePasswordResult,
} from './ui/screens/ProfilePage.js';
import { badgesEarnedText, badgesEarnedArt } from './ui/components/Badges.js';
import { passwordResetNoticeText } from './utils/accountNotices.js';
import { showLeaderboardPage, updateLeaderboardPage, leaderboardRequestFailed } from './ui/screens/LeaderboardPage.js';
import { showRecordsPage, updateRecordsPage, recordsRequestFailed } from './ui/screens/RecordsPage.js';
import { isStaleScopeReply, getStatsScope, scopePayload } from './state/statsScope.js';
import { setIsAdmin } from './admin/adminApi.js';
import { removeTournamentLobby, addTournamentChatMessage, updateTournamentPlayers, updateTournamentScoreboardUI, updateTournamentRoundIndicator, updateTournamentActiveGames, setTournamentPhase, setReadyDeadlinePassed, updateTournamentPairings, setTournamentTotalRounds, configureTournamentLobby, syncTournamentCut, showTournamentFinal, setTournamentCutTalking, isTournamentCutShowing, setTournamentVoiceFull, isTournamentFinished } from './ui/screens/TournamentLobby.js';
import { applyCutEvent, restoreCut, clearCut, getCutState, getCutTournamentId } from './ui/cut/cutStore.js';
import { STAGE as CUT_STAGE, winnerLine as cutWinnerLine } from './state/cutForABuck.js';
import { updatePlayerSearchResults } from './ui/screens/PlayerSearchPage.js';
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
import { createMuteButton, removeMuteButton, showVoiceOverlay, removeVoiceOverlay, setMuteButtonState, setVoiceTalkView, resetVoiceTalkView, setMicSpeaking } from './ui/components/VoiceChatUI.js';
import { setTableChrome, clearHud, hudRoot } from './ui/tableHud.js';
import { renderSpectatorBadge as drawSpectatorBadge, removeSpectatorBadge, setSpeaking as setWatcherSpeaking, setUnnamedSpeaking as setUnnamedWatcherSpeaking, clearSpeaking as clearWatcherSpeaking } from './ui/components/SpectatorBadge.js';
import { getShoulderWatch, isShoulder, watchingPillText, TABLE_VIEW_LABEL } from './state/shoulder.js';
import { syncShoulderHud } from './ui/components/ShoulderHud.js';

// Sound effects
import { getSoundManager } from './audio/SoundManager.js';
import { getTableSounds, installTableSoundSync } from './audio/tableSounds.js';

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
import { resetAssistUses, forgetAssistUses, noteAssistUses, assistHintRoute, assistLogLine } from './state/assistHint.js';
import { resetTutorial, forgetTutorial, noteTutorialState, resetTutorialRows, tutorialFeedRow } from './state/tutorial.js';
import { clearChatBubbles, showSpectatorChatBubble } from './ui/components/ChatBubble.js';
import { getTeamNames, scoreHeaderNames, formatHandCompleteMessages, formatGameEndMessages, showFinalScoreOverlay, removeFinalScoreOverlay, setScoreModalCut } from './ui/components/ScoreModal.js';

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
    // a new log: its first tutorial row says "(only you see this)" again
    resetTutorialRows();

    // The log's grid column (--log-w) comes on
    setTableChrome(true);

    // The canvas takes the narrower column (Phaser then relayouts the table)
    requestAnimationFrame(() => syncCanvasSize());

    if (!isReconnection) {
      gameLogInstance.addGameMessage('Game started!');
      flushEarlyLogLines();
    }
    // the Tutorial button in my row (a rejoin's snapshot may have come first)
    getGameScene()?.syncTutorial?.();
  }
  earlyLogLines = null;
};

// Lines that came between createUI and the log it creates after its fade
// (the server's room lines right after createUI, e.g. the tutorial's
// auto-start notice "<name> is playing with the tutorial."): kept and
// written after the log's 'Game started!' (flushEarlyLogLines), never
// dropped. Only while a createUI is pending; a replay of the server's log
// (a rejoin) brings them itself, so they are forgotten there. A line keeps
// its kind ('help': the /help notice's gold, 'tutorial': the cap's green),
// so the auto-start notice is drawn like a later tutorial line
const EARLY_LOG_MAX = 20;
let earlyLogLines = null;
function flushEarlyLogLines() {
  const lines = earlyLogLines || [];
  earlyLogLines = null;
  for (const [message, playerPosition, at, kind] of lines) {
    if (kind === 'help' && gameLogInstance?.addHelpMessage) gameLogInstance.addHelpMessage(message, at);
    else if (kind === 'tutorial' && gameLogInstance?.addTutorialMessage) gameLogInstance.addTutorialMessage(message, at);
    else gameLogInstance?.addGameMessage?.(message, playerPosition, at);
  }
}

// Bridge for adding messages to game feed (`kind`: an early line's row
// style, kept for flushEarlyLogLines; the help / tutorial bridges pass it)
window.addToGameFeedFromLegacy = function(message, playerPosition = null, at = null, kind = null) {
  if (gameLogInstance && gameLogInstance.addGameMessage && gameLogInstance.container?.isConnected !== false) {
    gameLogInstance.addGameMessage(message, playerPosition, at);
  } else if (earlyLogLines && earlyLogLines.length < EARLY_LOG_MAX) {
    earlyLogLines.push([message, playerPosition, at, kind]);
  } else {
    console.warn('Game log not initialized, message dropped:', message);
  }
};

// The /help reply row only this page shows (never sent or stored;
// GameScene.handleAssistHint); a tutorial row keeps "(only you see this)"
// only as the log's first (tutorialFeedRow)
window.addPrivateToGameFeed = function(message) {
  if (message && gameLogInstance?.addPrivateMessage) gameLogInstance.addPrivateMessage(tutorialFeedRow(message));
};

// A set hand's red fault row: the server's stored gameLogEntry with
// `fault` (gameHandlers.handleHandComplete; onGameLogEntry). A replay of
// the snapshot log draws it again from the entry's fault (renderTable)
window.addFaultToGameFeed = function(message) {
  if (message) gameLogInstance?.addFaultMessage?.(message);
};

// The /help room notice ("ann used /help."): the server's stored
// gameLogEntry with `help` (assistHandlers; onGameLogEntry), drawn gold.
// A replay of the snapshot log draws it again from the entry's help (renderTable)
window.addHelpToGameFeed = function(message) {
  if (!message) return;
  if (gameLogInstance?.addHelpMessage && gameLogInstance.container?.isConnected !== false) {
    gameLogInstance.addHelpMessage(message);
  } else {
    window.addToGameFeedFromLegacy(message, null, null, 'help'); // no log yet: buffered, drawn gold once it is up
  }
};

// The tutorial's room lines ("ann turned on the tutorial."): the server's
// gameLogEntry with `tutorial` (assistHandlers; onGameLogEntry), drawn like
// the /help notice in the cap's green. A replay draws it again from the
// entry's tutorial (renderTable)
window.addTutorialToGameFeed = function(message) {
  if (!message) return;
  if (gameLogInstance?.addTutorialMessage && gameLogInstance.container?.isConnected !== false) {
    gameLogInstance.addTutorialMessage(message);
  } else {
    window.addToGameFeedFromLegacy(message, null, null, 'tutorial'); // no log yet: buffered, drawn green once it is up
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

// The same for a three-seat table (Get Your Bid): one row per player
// (state/gyb.js soloHeaderRows; GameLog.updateSoloScore)
window.updateGameLogSoloScore = function(rows) {
  if (gameLogInstance && gameLogInstance.updateSoloScore) gameLogInstance.updateSoloScore(rows);
  else console.warn('Game log not initialized, score update dropped');
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
  // The tab's credentials go; the device's saved session stays. So does
  // this tab's voice unmute (whoever signs in next starts muted)
  safeSessionStorage().removeItem('username');
  safeSessionStorage().removeItem('sessionToken');
  forgetSessionMute();
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
// A badge is rare news: its toast stays longer than the usual 5 s
const BADGE_TOAST_MS = 8000;
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

// Track retry attempts for joinMainRoom
let joinMainRoomRetries = 0;
const MAX_JOIN_RETRIES = 5;
// joinTournament refusals the server answers with no main room (it leaves
// the socket where it is: server tournamentHandlers STAYS_PUT)
const STAYS_PUT_REFUSALS = new Set(['Already in a tournament', 'Already in a lobby', 'Already in game']);
// A refused tournament re-entry, in the player's words (iOS RestoreRoute.swift)
const TOURNAMENT_REENTRY_TEXT = Object.freeze({
  'Tournament not found': 'The tournament closed while you were offline',
  'Tournament is not accepting players': 'The tournament started without you',
});

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
  // Re-spectating after a reconnect: the watched game ended meanwhile
  if (error.message === 'Game not found' && (session.pendingSpectate || session.isSpectator)) {
    console.log('Spectated game no longer exists, returning to main room');
    const restoring = !!session.takePendingSpectate();
    session.exitTable(EXIT.SPECTATE_FAILED);
    // a restore's re-spectate (iOS's words): unless a restart notice says why
    if (!explainRestartLoss() && restoring) showInfo('The game ended while you were offline');
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
      showWarning(afterGame
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
    // iOS RestoreRoute's words: closed, started without me, or anything else
    if (!explainRestartLoss()) {
      showWarning(TOURNAMENT_REENTRY_TEXT[error.message] || "Couldn't get back into the tournament");
    }
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
      showError("Couldn't finish signing in. Try again.");
      return;
    }
  }

  // Severity (owner 2026-11-19): amber for a refusal, teal for information,
  // red only for a real failure; Joi's text is never shown (logged only)
  if (error.type === 'validation' || error.type === 'VALIDATION_ERROR') console.warn('Validation refused:', error.handler, error.message);
  const notice = serverErrorNotice(error);
  showToast(notice.message, { type: notice.type });
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
    // the card click's own offline check says the same (GameScene)
    onRefused: () => showNotice(NOTICE.RECONNECTING),
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
    // My socket dropped: the bid clock's tune and countdown stop at once
    // (the server may bid for me unheard); the rejoin snapshot restarts
    // them if the clock still runs (critic C4)
    if (event === 'disconnect') {
      getGameState().clearBidClock();
      getTableSounds().disconnected();
      getGameScene()?.bidManager?.syncClock?.();
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
    // no microphone prompt at a start: muted, or unmuted with the microphone
    // already allowed once the person unmuted by hand in this tab
    // (voice/voiceSessionMute.js); the first unmute asks
    connect: (opts) => voiceManager.initialize(socketMgr, opts),
    onStarted: () => showVoiceControls(),
    onUnavailable: (err) => {
      // A refused microphone is listen-only now (the session still hears):
      // this is the rest (no WebRTC at all)
      console.warn('Voice chat unavailable:', err?.message);
      showWarning('Voice chat is unavailable in this browser.');
    },
    teardown: () => teardownVoice(),
  });

  // ---------- No voice alone (owner 2026-11-19; voice/voiceCompany.js) ----------
  // Voice runs only while another human shares my room: a lobby member
  // (lobbyOthers, from every lobby payload), a seat owner not gone or a
  // spectator at the table (GameState.otherHumans). Alone with bots it is
  // never started; the last other human leaving stops it 30 s later
  let lobbyOthers = new Set();
  // The casual game whose voice room this tab was told of (any voiceSettings
  // for it). Only such a table admits spectators into voice (a lobby-born
  // casual game, server/voice/gameVoice.js), so only there do its watchers
  // count: a tournament table's watchers can never be a peer. Kept through
  // a stop or suspend (teardownVoice clears voiceSettings), compared with
  // the table's gameId
  let casualVoiceGameId = null;

  /** A lobby payload of my lobby (or the reopened one, play again): who else is in it. */
  function noteLobbyCompany(data) {
    lobbyOthers = lobbyOthersOf(data, gameState.username);
    voiceGate.update();
  }

  /** Not in a lobby any more (the main room, a lobby left): no lobby company. */
  function forgetLobbyCompany() {
    lobbyOthers = new Set();
    voiceGate.update();
  }

  // ---------- Tournament voice (owner 2026-11-24; docs/claude/voice.md) ----------
  // The tournament lobby screen (the lobby phase, between rounds, sitting a
  // round out, back from a finished table) is a voice room on the server
  // (tournament:<id>, server/voice/tournamentVoice.js): the members on it
  // whose page can talk there, at most the server's cap (8 by default, up
  // to 20), a blocked pair never listed. Its
  // company is exactly who the server announced to this socket there
  // (voicePeerList / voicePeerJoined, gone again on voicePeerLeft): a member
  // on another screen (at a table, watching one), an app that cannot talk
  // there (shipped iOS) or a blocked one is no company, so voice never runs
  // with nobody to answer. Every tournamentJoined starts the list afresh (the
  // server lists this socket again right after it)
  let tournamentVoicePeers = new Map();

  /** voicePeerList / voicePeerJoined / voicePeerLeft, after the voice manager handled it. */
  function onVoicePeers(kind, data) {
    if (kind === 'left') {
      if (data?.socketId && tournamentVoicePeers.delete(data.socketId)) voiceGate.update();
      return;
    }
    if (session.screen !== SCREEN.TOURNAMENT_LOBBY) return;
    const peers = kind === 'list' ? (Array.isArray(data?.peers) ? data.peers : []) : [data];
    for (const p of peers) {
      if (p && typeof p.socketId === 'string') tournamentVoicePeers.set(p.socketId, p.username ?? null);
    }
    voiceGate.update();
  }

  /**
   * The over-cap notice (2026-11-25; s2c tournamentVoiceStatus, this page's
   * clientHello cap tournamentVoiceStatus): past the room's cap this socket
   * waits in line unlisted, so voice never starts (no company); the lobby's
   * voice slot says "Voice is full (N people)" until the server lets it in
   * (admitted true, its voicePeerList right behind) or the screen goes.
   */
  function onTournamentVoiceStatus(data) {
    if (session.screen !== SCREEN.TOURNAMENT_LOBBY) return;
    setTournamentVoiceFull(data.admitted ? null : data.cap);
  }

  function hasVoiceCompany() {
    const screen = session.screen;
    if (screen === SCREEN.LOBBY) return lobbyOthers.size > 0;
    if (screen === SCREEN.TOURNAMENT_LOBBY) return tournamentVoicePeers.size > 0;
    // the score modal of a lobby-born game: the server moved me into the
    // reopened lobby, whose members are my voice room now (play again)
    if (screen === SCREEN.GAME_END && session.lobbyReturn) return lobbyOthers.size > 0;
    if (session.hasTable) {
      const spectatorsInVoice = !!casualVoiceGameId && casualVoiceGameId === gameState.gameId;
      const { known, names } = gameState.otherHumans({ spectators: spectatorsInVoice });
      if (names.size > 0) return true;
      // a lobby's table before its seating (no positionUpdate or snapshot
      // yet): the lobby's people came along
      return !known && lobbyOthers.size > 0;
    }
    return false;
  }

  const voiceGate = createVoiceGate({
    hasCompany: () => hasVoiceCompany(),
    isRunning: () => voiceManager.active || voiceLifecycle.starting,
    start: () => { voiceLifecycle.start(); },
    suspend: () => suspendVoice(),
    stop: () => voiceLifecycle.stop(),
  });
  gameState.onCompanyChange(() => voiceGate.update());
  session.onScreenChange(() => voiceGate.update());

  /** This screen wants voice (muted at the tab's first start): it runs while another human is here. */
  function startVoice() {
    voiceGate.want();
  }

  /**
   * The last other human left 30 s ago: voice stops (no audio context, no
   * calls, no controls) but this table's voice role stays, so the next
   * human's arrival starts it again (muted).
   */
  function suspendVoice() {
    const settings = voiceSettings;
    const full = voiceFull;
    voiceLifecycle.stop();
    voiceSettings = settings;
    voiceFull = full;
    refreshTalkView();
    refreshSpectatingIndicator();
  }

  // ---------- Voice: muted at the start, spectator voice (docs/claude/voice.md) ----------
  // The last voiceSettings of this table (a casual game started from a
  // lobby; null elsewhere) and "voice is full". Spectators always may talk
  // (owner 2026-11-18: no "Spectators can talk" switch), so the settings
  // only say who is a watcher and whether there was room
  let voiceSettings = null;
  let voiceFull = false;

  /** A watcher (a pure spectator of this table), not a seat's owner: the overlay's "(watching)". */
  function isWatcher(username) {
    if (!username) return false;
    const owners = Object.values(gameState.seatOwners || {});
    if (owners.includes(username)) return false;
    return (gameState.watching?.spectators || []).some((s) => s.username === username);
  }

  /** The voice controls' view (VoiceChatUI): a refused microphone, the mute action, who watches. */
  function refreshTalkView() {
    setVoiceTalkView({
      micDenied: !!voiceManager.micDenied,
      onToggleMute: () => onMicToggle(),
      isWatcher,
    });
  }

  /**
   * The mic button, M and the overlay's own row: mute / unmute. Everyone
   * joins voice muted (owner 2026-11-18: "by default the mic should be
   * muted and you can click to unmute / activate mic"); the first unmute
   * asks for the microphone, and a refusal stays muted (listen only) with
   * the denied toast. While the browser's prompt is up the button shows
   * the choice made (unmuted), so a second click visibly mutes, and that
   * mute wins when the prompt is answered.
   * @returns {Promise<boolean>} muted afterwards
   */
  function onMicToggle() {
    const wasMuted = voiceManager.isMuted();
    const run = voiceManager.toggleSelfMute();
    if (voiceManager.micRequestInFlight) setMuteButtonState(!!voiceManager.selfMuted);
    return Promise.resolve(run).then((muted) => {
      // a later click while the prompt is still up decides the button
      if (voiceManager.micRequestInFlight) return voiceManager.selfMuted !== false;
      if (wasMuted && muted && voiceManager.active && voiceManager.micDenied) {
        showWarning('Microphone access denied. You can still listen.');
      }
      setMuteButtonState(muted);
      refreshTalkView();
      refreshSpectatingIndicator();
      return muted;
    });
  }

  /** Apply the stored voiceSettings: a watcher's voice starts (muted, no prompt); the controls. */
  function applyVoiceSettings() {
    const s = voiceSettings;
    if (s && s.role === 'spectator' && !voiceManager.active) startVoice();
    refreshTalkView();
    refreshSpectatingIndicator();
  }

  /**
   * voiceSettings (a casual game's voice; private, to this capable tab only):
   * role player, spectator (voice starts when not running, muted unless
   * unmuted by hand earlier in this tab: a lobby
   * extra's lobby session just carries on with its mute as it was) or none
   * (voice is full: watch and chat only). spectatorsCanTalk / canTalk /
   * canChange are always true / true / false now and not read.
   */
  function onVoiceSettings(data) {
    // a late one for a table this tab left
    if (data.gameId && gameState.gameId && data.gameId !== gameState.gameId) return;
    // the score modal: that game is over (a reopened lobby's next game
    // admitting this socket as a watcher: onSpectatorJoined stops that)
    if (session.screen === SCREEN.GAME_END) return;
    const prev = voiceSettings?.gameId === data.gameId ? voiceSettings : null;
    if (data.role === 'none' && session.isSpectator && (voiceGate.wanted || voiceManager.active || voiceLifecycle.starting)) {
      // a watcher with no voice place: no voice session (it would hear
      // nobody), and no wish for one either (a watcher waiting for company
      // or suspended alone would start at the next arrival). First: the
      // stop resets this table's voice state
      stopVoice();
    }
    if (data.gameId) casualVoiceGameId = data.gameId;
    voiceSettings = { ...data };
    voiceFull = data.role === 'none';
    if (data.role === 'none' && prev?.role !== 'none') showInfo('Voice is full (8 people). You can still watch and chat.');
    applyVoiceSettings();
    // this table's watchers count from now on (a player alone with bots
    // and a watcher)
    voiceGate.update();
  }

  function showVoiceControls() {
    createMuteButton();
    // The microphone coming or going (a refusal) on the controls
    voiceManager.onModeChange?.(() => {
      setMuteButtonState(voiceManager.isMuted());
      refreshTalkView();
      refreshSpectatingIndicator();
    });
    // A browser that blocks audio without a gesture: the next click plays it
    voiceManager.onAutoplayBlocked?.(() => showInfo('Click anywhere to hear voice chat.'));
    if (voiceManager.micDenied) showWarning('Microphone access denied. You can still listen to voice chat.');
    refreshTalkView();
    refreshSpectatingIndicator();
    // Register speaking indicator callback
    voiceManager.onSpeakingChange((id, isSpeaking) => {
      // Cut for a buck's ring (the tournament lobby's voice room)
      if (session.screen === SCREEN.TOURNAMENT_LOBBY) {
        setTournamentCutTalking(id === 'self' ? gameState.username : voiceManager.peers.get(id)?.username || null, isSpeaking);
      }
      if (id === 'self') {
        // a watcher has no seat of its own: my mic button rings (never the
        // spectator badge, which is the other watchers'; owner 2026-11-22).
        // In the over-the-shoulder view the own box is the watched player's
        if (session.isSpectator) {
          setMicSpeaking(isSpeaking);
          return;
        }
        setMicSpeaking(false);
        const el = document.getElementById('player-avatar-container');
        if (el) el.classList.toggle('voice-speaking', isSpeaking);
      } else {
        const username = voiceManager.peers.get(id)?.username || null;
        // A stop always clears the badge's ring for that peer: the watcher
        // may be gone from the list already (it left; its call ends after)
        if (!isSpeaking) {
          setWatcherSpeaking(username, false);
          setUnnamedWatcherSpeaking(id, false);
        }
        // A spectator other than me talking lights the badge (the eye),
        // never a seat (voice/speakingSlot.js spectatorSpeakerFor)
        const watcher = session.hasTable ? spectatorSpeakerFor({
          username,
          socketId: id,
          me: gameState.username,
          owners: gameState.seatOwners,
          playerData: gameState.playerData,
          watching: gameState.watching,
        }) : null;
        if (watcher) {
          if (watcher.username) setWatcherSpeaking(watcher.username, isSpeaking);
          else setUnnamedWatcherSpeaking(watcher.peerId, isSpeaking);
          return;
        }
        // Peer → seat by username: the seat's owner, then the name it
        // shows; the socket id only as a fallback (V1_REMOVALS #6 / #14).
        // A spectator views from seat 1, whose player sits at the bottom;
        // a watcher (the over-the-shoulder view) from the watched seat,
        // whose player is drawn in the own box (#player-avatar-container)
        const slotId = speakingSlotFor({
          username,
          socketId: id,
          playerData: gameState.playerData,
          myPosition: gameState.position,
          owners: gameState.seatOwners,
          spectator: session.isSpectator,
          seats: gameState.seatCount,
        });
        if (slotId) {
          const el = slotId === 'bottom' && isShoulder(gameState)
            ? document.getElementById('player-avatar-container')
            : document.getElementById(`opponent-avatar-${slotId}`);
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
    // this game's /help count is unknown from here (a rejoin learns it again),
    // and the tutorial off (a rejoin's assistState / snapshot says again)
    forgetAssistUses();
    forgetTutorial();
    // the over-the-shoulder view's selection goes with the table
    getShoulderWatch().leave();
    earlyLogLines = null;
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
    // sound plays only at a table and during Cut for a buck (the
    // tournament lobby's cut view): elsewhere its context is suspended
    getSoundManager().setActive(atTable || (screen === SCREEN.TOURNAMENT_LOBBY && isTournamentCutShowing()));
  };
  session.onScreenChange((screen) => syncTableScreen(screen));
  syncTableScreen(session.screen);

  // ---------- Cut for a buck around the lobby (2026-11-25) ----------
  // The final lobby's Return to Main Room routes as the results modal's
  // Return did (the tournament lingers ~10 min for the others); a ring
  // avatar's View Profile asks for that profile
  configureTournamentLobby({
    onReturnToMainRoom: () => {
      gameState.tournamentId = null;
      clearCut();
      session.transition(SCREEN.MAIN_ROOM);
      session.requestMainRoom();
    },
    onViewProfile: (username) => socket.emit('getPlayerProfile', scopePayload({ username })),
  });

  // The last table's score screen (spec section 3.3): it stays as long as
  // the player wants, with a strip saying the cut is on and its button
  // reading "Join cut for a buck" (the same returnToTournament)
  let scoreCutTimer = null;
  function syncScoreCutStrip() {
    const tid = gameState.tournamentId;
    const st = session.screen === SCREEN.GAME_END && tid && getCutTournamentId() === tid ? getCutState() : null;
    const join = session.isSpectator ? 'Watch cut for a buck' : 'Join cut for a buck';
    let info = null;
    if (st?.stage === CUT_STAGE.GATHER) {
      const secs = st.endsAt == null ? 0 : Math.max(0, Math.ceil((st.endsAt - Date.now()) / 1000));
      info = { text: `Cut for a buck starts in ${secs}`, buttonLabel: join };
    } else if (st?.stage === CUT_STAGE.WINNER && st.winner) {
      info = { text: cutWinnerLine(st.winner, gameState.username) };
    } else if (st) {
      info = { text: session.isSpectator ? 'Cut for a buck has started.' : "Cut for a buck has started. We'll draw for you until you join.", buttonLabel: join };
    }
    setScoreModalCut(info);
    const ticking = st?.stage === CUT_STAGE.GATHER;
    if (ticking && !scoreCutTimer) scoreCutTimer = setInterval(syncScoreCutStrip, 500);
    if (!ticking && scoreCutTimer) {
      clearInterval(scoreCutTimer);
      scoreCutTimer = null;
    }
  }

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
        enter: (data, ctx) => {
          removeMainRoom();
          if (data && data.tournamentId) uiManager.renderScreen(SCREENS.TOURNAMENT_LOBBY, data);
          // Tournament voice: this screen is the tournament's voice room. Each
          // entry (a tournamentJoined, the way back from a table) waits for
          // the server's list of who is here; a lobby's people are not
          if (!ctx?.reenter) lobbyOthers = new Set();
          tournamentVoicePeers = new Map();
          startVoice();
        },
        exit: (_data, ctx) => {
          removeTournamentLobby();
          // Out of the tournament (not to one of its tables): its cut goes
          if (ctx?.to === SCREEN.MAIN_ROOM || ctx?.to === SCREEN.SIGN_IN) clearCut();
          // The room's calls end here: a table's voice is its own (the
          // server announces the table at its seating), and so is a game watched
          tournamentVoicePeers = new Map();
          stopVoice();
        },
      },
      [SCREEN.TABLE]: {
        enter: (_data, ctx) => {
          if (ctx.reenter) return;
          clearAuthScreens();
          removeMainRoom();
          removeGameLobby();
          // Who is watching, from the state: a family lobby's extras are
          // listed (spectatorsUpdated) while the seats are still on the
          // lobby screen, ~1.75 s before startDraw, and nothing re-sends
          // it; a seat's live entry never runs a full render, so without
          // this the eye stayed away until a reload (owner, 2026-11-17)
          renderSpectatorBadge(gameState.renderModel().watching);
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
    voiceGate.release();
  }

  /**
   * Play again: Return to Lobby kept voice running (teardownTableUI skips
   * the stop for EXIT.LOBBY_RETURN). The table's voice settings go, and
   * the controls are drawn again in the lobby's slot (voiceLifecycle.start
   * returns at once while the manager is active and would draw nothing).
   * The same call carries on with the person's mute as it was (owner
   * 2026-11-19: "once you unmute in a session it should stay unmuted";
   * until then Return to Lobby muted again). The microphone is kept.
   * @returns {boolean} voice is running or starting (else the caller starts it)
   */
  function carryVoiceIntoLobby() {
    voiceSettings = null;
    voiceFull = false;
    if (!voiceManager.active) return voiceLifecycle.starting;
    createMuteButton();
    setMuteButtonState(voiceManager.isMuted());
    refreshTalkView();
    return true;
  }

  /**
   * Play again: lobbyReturn while the finished game's table or score modal
   * is up. The server moved this socket into the lobby and voice keeps
   * running (owner 2026-11-16), so the table's voice settings end now, not
   * at Return. Nothing on screen changes.
   */
  function endTableVoiceRules() {
    if (!voiceSettings) return;
    voiceSettings = null;
    voiceFull = false;
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
      // the lobby's game mode ('gyb': Get Your Bid, three seats; absent: the base game)
      mode: data.mode,
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
      noteLobbyCompany(r.data);
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
    voiceFull = false;
    resetVoiceTalkView();
    // Clean up speaking indicator classes (and the badge's talkers: a
    // shutdown says no stop for my own voice, and the badge outlives voice)
    setMicSpeaking(false);
    clearWatcherSpeaking();
    document.querySelectorAll('.voice-speaking').forEach(el => {
      el.classList.remove('voice-speaking');
    });
  }

  // Hold ` for the voice overlay, M toggles mute (voice/voiceHotkeys.js; Tab stays focus)
  installVoiceHotkeys({
    isActive: () => voiceManager.active,
    show: showVoiceOverlay,
    hide: removeVoiceOverlay,
    // what the mic button does (the first unmute asks for the microphone);
    // the button shows it (VoiceChatUI: icon, aria-pressed; the red look is CSS)
    toggleMute: () => { onMicToggle(); },
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
    // a spectator watching a seat's hand (the over-the-shoulder view): whose,
    // and the way back to the plain table view
    if (kind === 'spectator' && isShoulder(gameState)) kind = 'watching';
    else if (kind === 'watching' && !isShoulder(gameState)) kind = 'spectator';
    const text = kind === 'watching'
      ? watchingPillText(gameState.getSeatOwnerName(gameState.shoulder.position), { paused: !!gameState.shoulder.paused }) + spectatorVoiceNote('spectator')
      : (kind === 'lazy' ? 'Spectating — type /active to take back control' : 'Spectating — type /leave to exit') + spectatorVoiceNote(kind);
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
    indicator.classList.toggle('is-watching', kind === 'watching');
    indicator.setAttribute('role', 'status');
    indicator.dataset.kind = kind;
    if (kind !== 'watching') {
      indicator.textContent = text;
      return;
    }
    const label = document.createElement('span');
    label.className = 'spectating-indicator__text';
    label.textContent = text;
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'spectating-indicator__action';
    back.textContent = TABLE_VIEW_LABEL;
    back.setAttribute('aria-label', 'Stop watching: back to the table view');
    back.addEventListener('click', () => getShoulderWatch().stop());
    indicator.replaceChildren(label, back);
  }

  /** Who is watching (the badge), each watcher's row naming the hand it watches. */
  function renderSpectatorBadge(watching) {
    return drawSpectatorBadge(watching, { me: gameState.username, seatName: (p) => gameState.getSeatOwnerName(p) });
  }

  /** A watcher's voice state on the pill: "(listening only)" (a refused microphone) or "Voice is full (8 people)". */
  function spectatorVoiceNote(kind) {
    if (kind !== 'spectator') return '';
    if (voiceFull) return ' · Voice is full (8 people)';
    if (voiceSettings?.role === 'spectator' && voiceManager.micDenied && voiceManager.isListenOnly?.()) return ' (listening only)';
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
      // a hand's fault line (server-stored, optional `fault`) is drawn red,
      // the /help room notice (optional `help`) gold and the tutorial's
      // lines (optional `tutorial`) in the cap's green; a replayed tag only
      // styles its line (the snapshot's seats[] carry the badges)
      feed.replaceMessages(log.map((e) => ({ message: e.message, position: e.position ?? null, at: e.at ?? null, fault: !!e.fault, help: !!e.help, tutorial: !!e.tutorial })));
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
    renderSpectatorBadge(model.watching);
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

  // The over-the-shoulder view (state/shoulder.js): what this spectator
  // asks to watch; a local change (Table view, a pause) redraws the table
  getShoulderWatch().configure({
    getState: () => gameState,
    emit: (event, payload) => socket.emit(event, payload),
    onView: () => {
      if (session.isAtTable) scheduleRender({});
    },
  });

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
      // A deploy (or a crash): the server closes every socket within a few
      // seconds. Lobbies, pre-deal tables and (until deploy survival PR 6)
      // tournaments never come back; with LIVE_PERSIST on a dealt casual
      // game may (the new instance adopts it, and the table's game log
      // says which: "...will continue in a few seconds" or "...won't
      // count"). The banner says it is a restart until the socket is back;
      // what this tab is in is remembered (sessionStorage, ~2 min) and the
      // restore decides: rejoinSuccess / the re-spectate clears it (no
      // toast), a refusal explains it once (state/restartNotice.js). A
      // restore the new instance parks ends in a plain transport close and
      // the next socket restores again, so nothing here waits on it
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
      forgetLobbyCompany();
      casualVoiceGameId = null;
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
    onMainRoomPlayerLeft: (data) => {
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
      // Voice in the lobby: it runs once another human is in it
      noteLobbyCompany(data);
      startVoice();
    },
    onLobbyReturn: (data) => {
      // Play again (owner 2026-11-16): the server moved this socket back
      // into the lobby the game came from. The score modal stays exactly as
      // it is for as long as the player likes; its Return to Lobby lands
      // there (returnToReopenedLobby). The lobby is only remembered here
      if (session.noteLobbyReturn(data)) {
        // Voice keeps running through the results: the table's voice
        // rules (forced mute, switch) end with its game. My voice room is
        // the reopened lobby's people now
        endTableVoiceRules();
        noteLobbyCompany(data);
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
      noteLobbyCompany(data);
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
      noteLobbyCompany(data);
      updateLobbyPlayersList(null, data.players, gameState.username, { lobby: data });
    },
    onLobbyPlayerJoined: (data) => {
      followReturnedLobby(data);
      noteLobbyCompany(data);
      updateLobbyPlayersList(null, data.players, gameState.username, { returned: data.newPlayer?.username, lobby: data });
    },
    onLeftLobby: () => {
      console.log('Left lobby, returning to main room');
      // The score modal's lobby is not this socket's any more (another tab
      // took the seat, or the lobby started its next game while this player
      // was still on the results: playAgain.leftOnResults): its Return goes
      // to the main room, as before
      session.forgetLobbyReturn();
      forgetLobbyCompany();
      // The lobby's exit hook stops voice and removes it (a late reply at a
      // table changes nothing)
      if (session.hasTable) return;
      if (session.screen === SCREEN.LOBBY) session.transition(SCREEN.MAIN_ROOM);
      else removeGameLobby();
      session.requestMainRoom();
    },
    onAllPlayersReady: (data) => {
      console.log('All players ready, game starting soon...');
      // A reload before the deal rejoins this table (sessionStorage gameId)
      session.noteTableGame(data?.gameId);
      // The game's mode before its draw (Get Your Bid: three seats); the
      // game itself starts via positionUpdate/gameStart events
      gameState.setMode(data?.mode);
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
        const snap = rebuildTable(data, { source: 'spectate', role: 'spectator', suffix: 'Joined as spectator!' });
        // the re-send rule: watch the seat wanted (the default, or my pick for this game)
        if (snap) getShoulderWatch().afterFullState(snap);
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
      if (gameLogInstance?.container?.isConnected && gameState.isSolo) {
        gameLogInstance.updateSoloScore?.(soloHeaderRows(gameState, { spectator: !!gameState.isSpectator }));
      } else if (gameLogInstance?.container?.isConnected) {
        const { teamName, oppName } = scoreHeaderNames(gameState.position, gameState.teamPlayerData, { spectator: !!gameState.isSpectator });
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
        if (scene.createPlayerInfoBox && !scene._playerInfo && (!gameState.isSpectator || isShoulder(gameState))) {
          if (gameState.position && gameState.playerData) {
            scene.createPlayerInfoBox(gameState.playerData, gameState.position);
          }
        }

        // Reset the HSI display; the new hand's value shows with its cards
        scene.clearPlayerHsi?.();
        // a new deal: no lightbulb (the caps stay)
        scene.updateSeatBadges?.();

        // Create DOM backgrounds via LayoutManager (show immediately)
        if (scene.layoutManager) {
          scene.layoutManager.update();
          scene.layoutManager.createDomBackgrounds({ skipHandArea: gameState.isSpectator && !isShoulder(gameState) });
        }

        // Show the bid panel once the trump is face up (this deal only: the
        // flip is the director's, keyed to the deal; cli-19, ui-22)
        const showBidUIAfterFlip = () => {
          // a watcher: the watched seat's read-only sheet (the over-the-shoulder view)
          if (isShoulder(gameState)) {
            if (gameState.bids[gameState.position] === undefined && data.hand?.length) scene.showWatchedBidSheet?.(data.hand.length);
            return;
          }
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

          // Update player's HSI display (only shown for self, not
          // opponents), a beat after the cards land
          if (data.hsiValues && scene.updatePlayerHsi && gameState.position) {
            director.delay(1000, () => scene.updatePlayerHsi(data.hsiValues[gameState.position]), { scope: 'deal' });
          }

          // In lazy mode, disable card interaction after dealing (a
          // watched seat's hand is read-only: CardManager.setReadOnly)
          if (gameState.isLazy && scene.cardManager) {
            scene.cardManager.setInteractive(false);
          }
          if (isShoulder(gameState)) scene.cardManager?.setReadOnly?.(true);

          // Display opponent card backs (skip avatars since already shown)
          if (scene.opponentManager) {
            const cardCount = data.currentHand || data.hand?.length;
            if (cardCount) {
              scene.opponentManager.displayOpponentCards(cardCount);
            }
          }

          // The game log's bid chips row, as the cards are dealt: for every
          // role by the deal's size (a spectator's deal has no hand: its
          // row used to come only with a refresh, owner 2026-11-19)
          gameLogInstance?.showTrickIndicator?.(data.currentHand || data.hand?.length || gameState.currentHand);
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
      // A tournament seat has voice at its table (owner 2026-11-24): wanted
      // now, started (muted) once positionUpdate shows another human, with
      // the peers the server lists right after it (no voice alone with bots)
      if (gameState.tournamentId && session.role === ROLE.PLAYER) startVoice();
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
      // a new game: no /help used yet (the autocomplete's count), the
      // tutorial off until the server says (an auto-start's assistState
      // comes right after this createUI)
      resetAssistUses();
      resetTutorial();
      // room lines before the log is up again are kept (flushEarlyLogLines)
      earlyLogLines = [];
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
            // a new log: its first tutorial row says "(only you see this)" again
            resetTutorialRows();

            // The log's grid column (--log-w) comes on
            setTableChrome(true);

            // The canvas takes the narrower column (Phaser then relayouts the table)
            requestAnimationFrame(() => syncCanvasSize(scene));

            // Add initial message, then the lines that came before the log
            gameLogInstance.addGameMessage('Game started!');
            flushEarlyLogLines();

            // Update hand indicator from current game state
            if (gameState.currentHand !== undefined) {
              window.updateHandIndicatorFromLegacy(gameState.currentHand);
            }
          }
          // (a log kept up: nothing was held, the buffer just closes)
          flushEarlyLogLines();
          // the Tutorial button in my row (disabled until the deal)
          scene.syncTutorial?.();
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
          const totals = bidTotalsFor(data.bids, gameState.position || 1, gameState.currentHand, gameState.seatCount);
          // (a Get Your Bid table: my own pile and one per opponent)
          if (gameState.isSolo) scene.trickManager.setBidTotals(totals.team, totals.opp1, totals.opp2);
          else scene.trickManager.setBidTotals(totals.team, totals.opp);
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
      // (and no lightbulb)
      scene?.updateSeatBadges?.();
      // the tutorial's tips go with the game (T.done is its log row)
      scene?.clearTips?.({ all: true });
      scene?.syncTutorial?.();
      // the over-the-shoulder view's selection ends with the game
      getShoulderWatch().ended();

      // Determine which team the player is on (positions 1,3 = Team 1, positions 2,4 = Team 2)
      // Spectators view from position 1 but aren't on either team
      const position = gameState.position;
      const isSpectator = gameState.isSpectator;
      if (data.gyb) {
        // Get Your Bid: three players, each for themselves (named by the
        // seat's owner: a lazy seat's bot plays for them)
        const pd = gameState.teamPlayerData;
        formatSoloGameEndMessages(data.gyb, pd, { myPosition: position, isSpectator }).forEach((msg) => window.addToGameFeedFromLegacy(msg));
        window.updateGameLogSoloScore(soloHeaderRows(gameState, { spectator: !!isSpectator }));
        session.endGame();
        showFinalScoreOverlay({
          solo: { end: data.gyb, playerData: pd, myPosition: isSpectator ? null : position },
          isSpectator,
          onReturnToLobby: () => {
            if (returnToReopenedLobby()) return;
            session.exitTable(EXIT.GAME_END_RETURN);
          },
        });
        return;
      }
      let teamScore, oppScore;
      if (position % 2 !== 0) {
        teamScore = data.score.team1;
        oppScore = data.score.team2;
      } else {
        teamScore = data.score.team2;
        oppScore = data.score.team1;
      }

      // Add game end messages to game log (the teams by their players:
      // a lazy or resigned seat's owner, never the bot playing it)
      const playerData = gameState.teamPlayerData;
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
      // Cut for a buck may already be gathering (it starts a moment after
      // the last table's result)
      if (isTournamentGame) syncScoreCutStrip();
    },
    onRainbow: (data) => {
      withScene((scene) => {
        scene.handleRainbow(data);
        // The log line a rejoin replays from the server's game log
        window.addToGameFeedFromLegacy?.(`${getPlayerName(data.position, gameState.playerData)} has a rainbow!`, data.position);
      });
    },
    onDestroyHands: (data) => {
      withScene((scene) => {
        director.settleDeal();
        scene.handleDestroyHands(data);
      });
      // the all-zero redeal: its bids are gone (the redeal's gameStart redraws the row)
      gameLogInstance?.updateTrickIndicator?.();
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
      const inTournament = !!session.tournamentId;
      session.exitTable(EXIT.REJOIN_FAILED);
      // After a server restart: say what ended. Not for a tournament table:
      // the tournament goes on (deploy survival PR 6: a table the restart
      // did not keep is scored or its round restarts), and the tournament
      // route says what ended if the tournament did
      if (!inTournament) explainRestartLoss();
    },
    onPlayerReconnected: (data) => {
      console.log(`Player at position ${data.position} (${data.username}) reconnected`);
      // Their 'Replace with Bot?' offer is moot now
      dismissResignationDialog(data.position);
    },

    // Resignation & Lazy Mode callbacks
    onResignationAvailable: (data) => {
      // Only a seat owner (seated or lazy) gets the offer: the room-wide
      // broadcast reaches spectators too, and the server refuses their
      // forceResign ("Not a player in this game"). iOS: resignationOffer
      // is nil unless the viewer holdsSeat
      if (session.isSpectator) return;
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
      showNotice(reasons[data.reason] || 'Action not accepted');
    },
    // Who is watching changed (GameState has applied it): the badge only,
    // at the table (a render draws it from the same state)
    onSpectatorsUpdated: (watching) => {
      if (!session.isAtTable) return;
      renderSpectatorBadge(watching);
      // the eye on a watched seat's avatar (the over-the-shoulder view)
      getGameScene()?.updateSeatPlates?.();
    },
    // The bid clock changed (GameState and the tune have it): the bidder's
    // countdown on the bid sheet (BidManager reads the state's clock)
    onBidClock: () => {
      getGameScene()?.bidManager?.syncClock?.();
      // (a watched seat's countdown is its read-only sheet's; the paused area follows the state)
      if (session.isAtTable) syncShoulderHud(gameState);
    },
    // My tutorial's state (private, unsequenced; the clientHello cap
    // tutorial): on / off and my /help count, at once (it may come between
    // createUI and the first deal, while gameState.gameId is still the last
    // game's: so it binds to no game id); the Tutorial button and tips follow
    onAssistState: (data) => {
      noteTutorialState(data, null);
      if (!(gameState.isSpectator && !gameState.isLazy)) noteAssistUses(data, null);
      if (session.isAtTable) getGameScene()?.syncTutorial?.();
    },
    // My /help answer (private): the card above my hand, in table order
    onAssistHint: (data) => {
      const route = assistHintRoute(session, data);
      if (route === 'scene') withScene((scene) => scene.handleAssistHint(data));
      // the game-end screen: a status reply is its private row (the log is up)
      else if (route === 'row') window.addPrivateToGameFeed(assistLogLine(data));
    },
    // My own seat ran out of time: the server bid 0 for me
    onBidTimedOut: () => {
      if (session.isAtTable) showInfo('Time ran out: you bid 0', TOAST_SHORT);
    },
    // A casual game's voice settings (spectator voice)
    onVoiceSettings: (data) => onVoiceSettings(data),
    onVoicePeers: (kind, data) => onVoicePeers(kind, data),
    onTournamentVoiceStatus: (data) => onTournamentVoiceStatus(data),
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
      const reply = data.reason === 'watchHand';
      const snap = applyTableSnapshot(data, {
        source,
        render: (snap) => {
          const live = !!snap.deal && !['ENDED', 'ABORTED'].includes(snap.stage);
          // Before the deal the draw / teams screens stay as they are
          if (live) scheduleRender({ log: logOf(snap) });
        },
      });
      // the over-the-shoulder view: my watchHand's answer, or a full state
      // after which the watch is sent again when it is not what is served
      if (snap && reply) getShoulderWatch().afterReply(snap);
      else if (snap) getShoulderWatch().afterFullState(snap);
    },
    // The over-the-shoulder view: a refused watchHand (ShoulderWatch has
    // decided: the own seat, paused, a tournament table); a deal that changed
    // what the table is drawn from
    onWatchHandRefused: (data, outcome) => {
      console.log(`watchHand refused: ${data.reason} (${outcome})`);
    },
    onShoulderViewChanged: () => {
      if (session.isAtTable) scheduleRender({});
    },
    onGameLogEntry: (data, { badge = null } = {}) => {
      // The help notice or the tutorial's tag changed that seat's avatar
      // badge (GameState has it): drawn with one pop when it comes on (the
      // cap going off just goes, as on iOS), in order behind the scene work
      // queued before it (a log row's kind: nothing to settle)
      if (badge) {
        const pop = data.tutorial && data.tutorial.on !== true ? [] : [badge];
        withScene((scene) => scene.updateSeatBadges?.({ pop }), 'draw');
      }
      // A hand's fault line (the server's, after handComplete): red, and
      // queued behind the scene like handComplete, so it lands after that
      // hand's lines even while the scene is not ready yet ('draw': a log
      // row only, nothing to settle the table on)
      if (data.fault) {
        withScene(() => window.addFaultToGameFeed?.(data.message), 'draw');
        return;
      }
      if (data.type === 'system') {
        // the /help room notice: gold, so the table notices it; the
        // tutorial's lines in the cap's green (parity)
        if (data.help) window.addHelpToGameFeed?.(data.message);
        else if (data.tutorial) window.addTutorialToGameFeed?.(data.message);
        else window.addToGameFeedFromLegacy?.(data.message, null);
        // the paused rule (the over-the-shoulder view): keep the watched seat, re-send after the resume
        getShoulderWatch().onLogLine(data.message);
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
    onProfileReceived: (profile, scope, badges) => {
      if (isStaleScopeReply(scope)) return;
      if (updateProfileStats(profile, scope)) return;
      showProfilePage(profile, socket, scope ?? getStatsScope(), badges);
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
    onPlayerProfileReceived: (profile, scope, badges) => {
      if (isStaleScopeReply(scope)) return;
      if (updatePlayerProfileStats(profile, scope)) return;
      showPlayerProfilePage(profile, socket, { isBlocked: isUserBlocked(profile.username), scope: scope ?? getStatsScope(), badges });
    },
    // Badges just earned (after a game's stats are written, so over the
    // score screen): one toast with their pictures and names; the profile
    // lists them
    onBadgesAwarded: (badges) => {
      const text = badgesEarnedText(badges);
      if (text) showToast(text, { type: 'success', duration: BADGE_TOAST_MS, art: badgesEarnedArt(badges) });
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
      // Cut for a buck as it stands (phase 'cut'; the cap cutForABuck), for
      // the lobby to draw; any other phase has none
      restoreCut(data.tournamentId, data.phase === 'cut' ? data.cut : null);
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
      // the complete phase shows its final results in the lobby itself
      // (TournamentLobby.showTournamentFinal; no results modal)
      uiManager.showScreen(SCREENS.TOURNAMENT_LOBBY, data);
      syncTableScreen(session.screen);
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
      // Only for a tournament this tab is in, and not once it is finished:
      // nothing is left to host then (in its final lobby, or after Return to
      // Main Room, which forgets it while the server still lists the member
      // for the results window; iOS guards on its tournamentId the same way)
      if (data.newCreator && gameState.tournamentId && !isTournamentFinished()) {
        showInfo(data.newCreator === gameState.username ? 'You are now the tournament host' : `${data.newCreator} is now the tournament host`);
      }
    },

    // The host changed the number of rounds in the lobby (2026-11-25)
    onTournamentSettingsUpdated: (data) => {
      setTournamentTotalRounds(data.totalRounds);
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
      // the round's pairings, shown before its draw (servers since 2026-11-25)
      if (Array.isArray(data.pairings)) updateTournamentPairings(data.pairings);
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
      if (Array.isArray(data.pairings)) updateTournamentPairings(data.pairings);
    },

    onTournamentRoundComplete: (data) => {
      setTournamentPhase('between_rounds');
      if (data.scoreboard) {
        updateTournamentScoreboardUI(data.scoreboard, data.currentRound, data.totalRounds);
      }
      updateTournamentRoundIndicator(data.currentRound, data.totalRounds);
      if (Array.isArray(data.pairings)) updateTournamentPairings(data.pairings);
    },

    onTournamentComplete: (data) => {
      if (Array.isArray(data.pairings)) updateTournamentPairings(data.pairings);
      // On the tournament lobby: the final results there, with the chat and
      // voice (the cut's view gives way to them). At a table or on its score
      // screen nothing changes: Return to Tournament lands on the same
      // final lobby (tournamentJoined in the complete phase)
      clearCut();
      syncScoreCutStrip();
      if (session.screen === SCREEN.TOURNAMENT_LOBBY) {
        showTournamentFinal({ scoreboard: data.scoreboard, winners: data.winners, cut: data.cutForABuck ?? null });
      }
      syncTableScreen(session.screen);
    },

    // Cut for a buck (2026-11-25): every event through the one store; the
    // lobby's view and the score screen's strip follow it
    onCutForABuck: (type, data) => {
      applyCutEvent(type, data, { tournament: gameState.tournamentId });
      if (session.screen === SCREEN.TOURNAMENT_LOBBY) {
        if (type === 'start') setTournamentPhase('cut');
        syncTournamentCut(type);
        syncTableScreen(session.screen);
      }
      syncScoreCutStrip();
    },

    onTournamentLeft: () => {
      // Back from a tournament's score screen after a restart: it is gone
      const lost = restartNotice.pending;
      if (lost === LOSS.TOURNAMENT || lost === LOSS.TOURNAMENT_SPECTATOR) explainRestartLoss();
      gameState.tournamentId = null;
      clearCut();
      // The server sends mainRoomJoined next
      if (session.screen === SCREEN.TOURNAMENT_LOBBY) session.transition(SCREEN.MAIN_ROOM);
      else removeTournamentLobby();
    },

    onTournamentCancelled: () => {
      gameState.tournamentId = null;
      clearCut();
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
    forgetSessionMute();
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
  // the bid clock's tune follows sound coming back (unmute, files decoded, the tab visible)
  installTableSoundSync();

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
