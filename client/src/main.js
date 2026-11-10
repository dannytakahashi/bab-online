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
import { adoptSavedSession, forgetSession, clearAllSessionData } from './utils/sessionPersistence.js';
import { installAvatarSupport } from './utils/avatar.js';

// Rules
import { isLegalMove } from './rules/legality.js';

// State
import { PHASE, getGameState } from './state/GameState.js';
import { getClientSession, SCREEN, ROLE, EXIT } from './state/ClientSession.js';

// Socket
import { getSocketManager, initializeSocketManager } from './socket/SocketManager.js';
import { createSocket } from './socket/createSocket.js';
import { installConnectionBanner } from './ui/components/ConnectionBanner.js';
import { removeTransitionOverlay } from './ui/transitionOverlay.js';
import { getTableDirector } from './phaser/TableDirector.js';
import { getSeqGate } from './state/SeqGate.js';
import { getMyAction } from './state/MyAction.js';
import { applyTableSnapshot, snapshotSource } from './state/tableSync.js';
import { speakingSlotFor } from './voice/speakingSlot.js';

// UI Components
import { showError, showSuccess, showWarning, showInfo } from './ui/components/Toast.js';
import { showSignInScreen } from './ui/screens/SignIn.js';
import { showRegisterScreen } from './ui/screens/Register.js';
import { showMainRoom, addMainRoomChatMessage, updateLobbyList, removeMainRoom, updateMainRoomOnlineCount } from './ui/screens/MainRoom.js';
import { showGameLobby, updateLobbyPlayersList, addLobbyChatMessage, removeGameLobby } from './ui/screens/GameLobby.js';
import { showProfilePage, updateProfilePicDisplay, updateCustomProfilePicDisplay, showPlayerProfilePage, showDeleteAccountError } from './ui/screens/ProfilePage.js';
import { showLeaderboardPage } from './ui/screens/LeaderboardPage.js';
import { showRecordsPage } from './ui/screens/RecordsPage.js';
import { updatePlayerSearchResults } from './ui/screens/PlayerSearchPage.js';
import { removeTournamentLobby, addTournamentChatMessage, updateTournamentPlayers, updateTournamentScoreboardUI, updateTournamentRoundIndicator, updateTournamentActiveGames, setTournamentPhase } from './ui/screens/TournamentLobby.js';
import { showTournamentResultsOverlay } from './ui/components/TournamentScoreboard.js';
import { SCREENS, initializeUIManager } from './ui/UIManager.js';

// Phaser
import { createPhaserGame } from './phaser/PhaserGame.js';

// Handlers
import { registerAllHandlers } from './handlers/index.js';

// Voice Chat
import { getVoiceChatManager } from './voice/VoiceChatManager.js';
import { createMuteButton, removeMuteButton, showVoiceOverlay, removeVoiceOverlay } from './ui/components/VoiceChatUI.js';

// ============================================
// Game Scene Access
// ============================================

// Reference to the active Phaser game scene
let gameSceneRef = null;

// Reference to the modular game log instance
let gameLogInstance = null;

// The table's timed work, scene readiness and fast-forward (TableDirector)
const director = getTableDirector();

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

  // Handle tab visibility change - reposition elements when tab becomes visible
  // This fixes card positioning issues on background tabs during game start
  if (!scene._visibilityHandlerAdded) {
    scene._visibilityHandlerAdded = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && gameSceneRef) {
        console.log('🎮 Tab became visible, repositioning game elements');
        // Use requestAnimationFrame to ensure dimensions are updated
        requestAnimationFrame(() => {
          if (gameSceneRef.cardManager) {
            gameSceneRef.cardManager.repositionHand();
          }
          if (gameSceneRef.opponentManager) {
            gameSceneRef.opponentManager.reposition();
          }
        });
      }
    });
  }

  console.log('🎮 Game scene reference set');
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
import { clearChatBubbles } from './ui/components/ChatBubble.js';
import { getTeamNames, formatHandCompleteMessages, formatGameEndMessages, showFinalScoreOverlay, removeFinalScoreOverlay } from './ui/components/ScoreModal.js';

// Bridge for GameScene (phaser/scenes/GameScene.js), its only reader: it
// registers itself through setGameScene and reads the rest from here
window.ModernUtils = {
  setGameScene,
  RANK_VALUES,
  getPlayerName,
  isLegalMove,
  getTeamNames,
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
      onChatSubmit: (message) => {
        if (window.socket) {
          window.socket.emit('chatMessage', { message });
        }
      },
    });

    // Add .in-game class to restrict game container width
    document.getElementById('game-container')?.classList.add('in-game');

    // Force Phaser resize
    requestAnimationFrame(() => {
      const container = document.getElementById('game-container');
      if (container && gameSceneRef?.game?.scale) {
        const newWidth = container.clientWidth;
        const newHeight = container.clientHeight;
        gameSceneRef.game.scale.resize(newWidth, newHeight);
      }
    });

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

/**
 * Get the socket connection (socket/createSocket.js). A page cached before
 * the client was bundled still runs socket-init.js, which created
 * window.socket already; reuse it there.
 */
function getSocket() {
  if (window.socket) {
    return window.socket;
  }
  const socket = createSocket();
  window.socket = socket;
  return socket;
}

const socket = getSocket();

// Avatars over HTTP (docs/avatars.md): clientHello caps ['avatarUrl'] on
// every connect (and right now: buffered ahead of any later emit while
// disconnected), and avatarUrls folded into the pic fields as each message
// arrives. Lives here, not in socket-init.js (cached separately, it could
// pair with a stale bundle). Registered before the connect handler below.
/* global __APP_VERSION__, __APP_BUILD__ */
installAvatarSupport(socket, {
  version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0',
  build: typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 'dev',
});

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
  sessionStorage.removeItem('username');
  sessionStorage.removeItem('sessionToken');
  session.clearIdentity();
  displaySignInScreen(EXIT.RECONNECT_FAILED);
  alert("Connection lost. Please sign in again.");
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
    showInfo('Block list updated');
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

// Account deletion (in-app, required by App Store Guideline 5.1.1(v))
socket.on('deleteAccountResponse', (data) => {
  if (data.success) {
    clearAllSessionData();
    window.location.reload();
  } else {
    showDeleteAccountError(data.message || 'Account deletion failed');
  }
});

socket.on('playerAssigned', (data) => {
  console.log('📡 Received playerAssigned:', data);
  const state = getGameState();
  if (data.playerId) {
    state.playerId = data.playerId;
  }
  if (data.position) {
    state.position = data.position;
  }
});

// ==================== END SESSION / RECONNECTION ====================

/**
 * Show error toast notification.
 */
function showErrorToast(message, duration = 5000) {
  // Remove existing toast
  const existing = document.querySelector('.error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Track retry attempts for joinMainRoom
let joinMainRoomRetries = 0;
const MAX_JOIN_RETRIES = 5;

/**
 * Handle socket error based on type.
 */
function handleSocketError(error, socket) {
  let message = 'Something went wrong';

  // Re-spectating after a reconnect: the watched game ended meanwhile
  if (error.message === 'Game not found' && (session.pendingSpectate || session.isSpectator)) {
    console.log('Spectated game no longer exists, returning to main room');
    session.takePendingSpectate();
    session.exitTable(EXIT.SPECTATE_FAILED);
    return;
  }

  // Re-entering a lobby after a reconnect: it closed (or filled) meanwhile
  if (session.takePendingLobbyRejoin()) {
    console.log('Lobby re-entry failed:', error.message);
    // 'Lobby is full' too: the seat may still be held by this player's
    // previous socket until the server notices it dropped
    showErrorToast(error.message === 'Lobby not found'
      ? 'The lobby closed while you were offline'
      : "Couldn't get back into the lobby");
    session.transition(SCREEN.MAIN_ROOM);
    session.requestMainRoom();
    return;
  }

  // Re-entering a tournament after a reload or reconnect: it is gone
  const pendingTournament = session.takePendingTournamentRejoin();
  if (pendingTournament) {
    console.log('Tournament re-entry failed:', error.message);
    getGameState().tournamentId = null;
    showErrorToast('The tournament is no longer available');
    if (!session.hasTable) session.transition(SCREEN.MAIN_ROOM);
    // The server follows a failed joinTournament with the main room, except
    // for 'Already in a tournament'; a failed spectateTournament with nothing
    if (pendingTournament.spectator || error.message === 'Already in a tournament') session.requestMainRoom();
    return;
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
  });

  // Visible connection state while the socket is down
  installConnectionBanner(socketMgr);

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

  async function startVoice() {
    if (voiceManager.active) return;
    try {
      await voiceManager.initialize(socketMgr);
      createMuteButton();
      // Register speaking indicator callback
      voiceManager.onSpeakingChange((id, isSpeaking) => {
        if (id === 'self') {
          const el = document.getElementById('player-avatar-container');
          if (el) el.classList.toggle('voice-speaking', isSpeaking);
        } else {
          // Peer → seat by username (socket ids change on reconnect)
          const slotId = speakingSlotFor({
            username: voiceManager.peers.get(id)?.username || null,
            socketId: id,
            playerData: gameState.playerData,
            myPosition: gameState.position,
          });
          if (slotId) {
            const el = document.getElementById(`opponent-avatar-${slotId}`);
            if (el) el.classList.toggle('voice-speaking', isSpeaking);
          }
        }
      });
    } catch (err) {
      console.warn('Voice chat unavailable:', err.message);
      showWarning('Microphone access denied. Voice chat unavailable.');
    }
  }

  /**
   * Take the whole table UI down: every exit (session.exitTable runs it as
   * its teardown hook). A rebuild of the same table (rejoin, re-spectate,
   * restorePlayerState, a resync) is a render instead (renderTable): the
   * scene draws the snapshot over whatever was there. It never touches the
   * game state or the gameId copies (exitTable resets those after it).
   */
  function teardownTableUI() {
    stopVoice();
    removeTransitionOverlay();
    // Nothing queued, owned or pending of this table may run later
    director.clearQueue();
    director.reset();
    seqGate.reset();
    myAction.reset();
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

    // Fallbacks for DOM a scene manager would normally own
    document.querySelectorAll('.opponent-avatar-container, .dealer-button').forEach((el) => el.remove());
    document.getElementById('player-avatar-container')?.remove();
    document.getElementById('bidContainer')?.remove();

    document.getElementById('game-container')?.classList.remove('in-game');
    clearGameScene();

    if (scene) {
      scene.children?.removeAll?.(true);
      scene.scene?.restart?.();
    }
  }

  function dismissResignationDialog(position = null) {
    const dialog = document.getElementById('resignation-dialog');
    if (dialog && (position === null || dialog.dataset.position === String(position))) {
      dialog.remove();
      if (window._resignationModal === dialog) window._resignationModal = null;
    }
    if (position === null) window._resignationModal = null;
  }

  function clearAuthScreens() {
    ['sign-in-container', 'sign-in-vignette', 'signInContainer', 'SignInVignette',
      'register-container', 'register-vignette', 'registerContainer', 'RegisterVignette',
    ].forEach((id) => document.getElementById(id)?.remove());
  }

  // Screen enter/exit hooks (the session runs exit(from) then enter(to))
  session.setHooks({
    teardownTable: () => teardownTableUI(),
    screens: {
      [SCREEN.SIGN_IN]: {
        enter: () => renderSignIn(),
        exit: () => clearAuthScreens(),
      },
      [SCREEN.MAIN_ROOM]: {
        // The DOM comes with mainRoomJoined; an exit lands here first
        enter: (data) => {
          if (data) showMainRoom(data, socket);
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
    voiceManager.shutdown();
    removeMuteButton();
    removeVoiceOverlay();
    // Clean up speaking indicator classes
    document.querySelectorAll('.voice-speaking').forEach(el => {
      el.classList.remove('voice-speaking');
    });
  }

  // Tab key: hold to show voice overlay
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && voiceManager.active) {
      e.preventDefault();
      if (!document.getElementById('voice-overlay')) {
        showVoiceOverlay();
      }
    }
    // M key: toggle mute
    if (e.key === 'm' && voiceManager.active && !e.ctrlKey && !e.metaKey) {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
      const muted = voiceManager.toggleSelfMute();
      const btn = document.getElementById('voice-mute-btn');
      if (btn) {
        btn.innerHTML = '';
        // Re-trigger by removing and re-creating the button content
        const svgContainer = document.createElement('span');
        svgContainer.innerHTML = muted
          ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`
          : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`;
        btn.appendChild(svgContainer);
        btn.style.background = muted ? 'rgba(220, 38, 38, 0.8)' : 'rgba(30, 30, 50, 0.8)';
      }
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Tab') {
      removeVoiceOverlay();
    }
  });

  // Set up error handler
  socket.on('error', (error) => {
    console.error('Server error:', error);
    handleSocketError(error, socket);
  });

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
    const color = kind === 'lazy' ? '#4ade80' : '#60a5fa';
    const text = kind === 'lazy' ? 'Spectating — type /active to take back control' : 'Spectating — type /leave to exit';
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'spectating-indicator';
      document.body.appendChild(indicator);
    }
    indicator.style.cssText = `
      position: fixed;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      color: ${color};
      padding: 8px 20px;
      border-radius: 20px;
      font-size: 14px;
      z-index: 500;
      border: 1px solid ${color};
    `;
    indicator.dataset.kind = kind;
    indicator.textContent = text;
  }

  /** The game log, created if missing (no local 'Game started!': a replay brings the server's). */
  function ensureGameLog() {
    window.createGameFeedFromLegacy(true);
    document.getElementById('game-container')?.classList.add('in-game');
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
      // Signed in on this socket: no restoreSession needed for it
      session.noteSignedIn(data.username);
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
      if (data.autoLoggedIn) {
        // Auto-login: go straight to main room
        console.log(`Registration & auto-login successful: ${data.username}`);
        session.noteSignedIn(data.username);
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
    onForceLogout: (data) => {
      console.warn('Force logout:', data?.reason || 'Unknown reason');
      // authHandlers cleared the tab's credentials; the server disconnects
      // this socket next, so nothing it showed will be finished (createUI
      // never comes to lift a transition overlay): exitTable takes it all down
      session.clearIdentity();
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
      session.transition(SCREEN.LOBBY, {
        lobbyId: data.lobbyId,
        players: data.players,
        messages: (data.messages || []).filter(m => !isUserBlocked(m.username))
      });
      session.noteLobby(data.lobbyId);
      // Start voice chat when entering a lobby
      startVoice();
    },
    onLobbyJoined: (data) => {
      // Don't show lobby if we're at a table (e.g., during rejoin)
      if (session.hasTable) {
        console.log('Lobby joined event ignored - at the table');
        return;
      }
      console.log('Joined lobby, showing lobby UI');
      session.transition(SCREEN.LOBBY, {
        lobbyId: data.lobbyId,
        players: data.players,
        messages: (data.messages || []).filter(m => !isUserBlocked(m.username))
      });
      session.noteLobby(data.lobbyId);
    },
    onPlayerReadyUpdate: (data) => {
      updateLobbyPlayersList(null, data.players, gameState.username);
    },
    onLobbyMessage: (data) => {
      if (isUserBlocked(data.username)) return;
      addLobbyChatMessage(data.username, data.message);
    },
    onLobbyPlayerLeft: (data) => {
      updateLobbyPlayersList(null, data.players, gameState.username);
    },
    onLobbyPlayerJoined: (data) => {
      updateLobbyPlayersList(null, data.players, gameState.username);
    },
    onLeftLobby: () => {
      console.log('Left lobby, returning to main room');
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
      // If this is the full game state (not just a notification about another spectator)
      if (data.players && data.trump) {
        const spectatedGameId = data.gameId || data.snapshot?.gameId || session.takePendingSpectate();
        session.routeArrived();
        // Spectators persist spectatingGameId only (a reconnect re-spectates)
        session.enterTable(ROLE.SPECTATOR, spectatedGameId);
        // A re-spectate after a reconnect supersedes one still waiting for the scene
        session.supersedeTableWork();
        // The snapshot is the table (cli-20: names, turn glow, trump face up,
        // each opponent's cards); the log is the server's (one 'Game started!')
        rebuildTable(data, { source: 'spectate', role: 'spectator', suffix: 'Joined as spectator!' });
      } else if (data.username) {
        // Notification that another spectator joined — show in game log
        window.addToGameFeedFromLegacy?.(`${data.username} joined as a spectator.`, null);
      }
    },

    // Game callbacks - update GameState and trigger scene handlers
    onPositionUpdate: (data) => {
      console.log('📍 onPositionUpdate callback');
      // Update modular GameState with player data
      gameState.setPlayerData(data);
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

        // Display trump card face down; it flips after the deal
        if (data.trump && scene.displayTrumpCard) {
          scene.displayTrumpCard(data.trump, { onFlipped: showBidUIAfterFlip });
        }

        // Deal the cards once the first hand's fade or the previous hand's
        // trick whisk is over (director.afterTransition)
        const showCards = () => {
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
      // A new table while the previous one's score modal is still up (the
      // next tournament round): that table goes first
      if (session.screen === SCREEN.GAME_END) {
        session.exitTable(EXIT.NEW_TABLE, { route: false });
        gameState.setPhase(PHASE.DRAW);
        gameState.setHasDrawn(false);
      }
      if (!session.isAtTable) session.enterTable(ROLE.PLAYER, null);
      // Remove waiting screen and tournament lobby
      uiManager.removeWaitingScreen();
      removeTournamentLobby();

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
              onChatSubmit: (message) => {
                const socket = getSocketManager()?.socket;
                if (socket) {
                  socket.emit('chatMessage', { message });
                }
              },
            });

            // Add .in-game class to restrict game container width for game log
            document.getElementById('game-container')?.classList.add('in-game');

            // Force Phaser to resize after container width change
            requestAnimationFrame(() => {
              const container = document.getElementById('game-container');
              if (container && scene?.game?.scale) {
                const newWidth = container.clientWidth;
                const newHeight = container.clientHeight;
                scene.game.scale.resize(newWidth, newHeight);
                if (scene.game.renderer?.resize) {
                  scene.game.renderer.resize(newWidth, newHeight);
                }
              }
            });

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
          const myPosition = gameState.position || 1;
          // Bids array is indexed by position-1 (so position 1 is index 0)
          // Team 1 is positions 1 & 3, Team 2 is positions 2 & 4
          const parseBid = (bid) => {
            const bidStr = String(bid);
            return bidStr.includes('B') ? 0 : parseInt(bidStr, 10) || 0;
          };
          const team1Bid = parseBid(data.bids[0]) + parseBid(data.bids[2]); // positions 1 & 3
          const team2Bid = parseBid(data.bids[1]) + parseBid(data.bids[3]); // positions 2 & 4

          // Determine which team is mine based on position parity
          const isTeam1 = myPosition === 1 || myPosition === 3;
          const teamBid = isTeam1 ? team1Bid : team2Bid;
          const oppBid = isTeam1 ? team2Bid : team1Bid;

          scene.trickManager.setBidTotals(teamBid, oppBid);
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

      // Update game log score display
      const { teamName, oppName } = getTeamNames(position, playerData);
      window.updateGameLogScoreFromLegacy(teamName, oppName, teamScore, oppScore);

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
        onReturnToLobby: () => {
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
    onRoomFull: (data) => {
      console.log('Room full:', data);
      uiManager.removeWaitingScreen();
      // Return to main room (this shouldn't happen with lobby system)
      session.requestMainRoom();
    },
    // Reconnection handlers
    onRejoinSuccess: (data) => {
      // One rejoinGame per socket; the server still answers a repeated lazy
      // rejoin, and processing it twice would replay the game log twice
      if (!session.noteRejoinSuccess(data.gameId)) {
        console.log('Duplicate rejoinSuccess on this socket ignored');
        return;
      }
      session.enterTable(data.isLazy ? ROLE.LAZY : ROLE.PLAYER, data.gameId);
      // Restore tournament context (server includes it when the rejoined game
      // belongs to a tournament) so the game-end screen offers 'Return to Tournament'
      if (data.tournamentId !== undefined) {
        gameState.tournamentId = data.tournamentId;
      }
      // The snapshot is the table: a rejoin onto a live scene draws exactly
      // what a fresh page would (cli-4)
      rebuildTable(data, { source: 'rejoin', role: data.isLazy ? 'lazyWatcher' : 'seat', suffix: 'Reconnected to game!' });
      // Re-establish voice on reconnect
      if (!voiceManager.active) {
        startVoice();
      }
    },
    onRejoinFailed: (data) => {
      // 'Already connected': this socket's seat is live, keep it
      const reason = typeof data === 'string' ? data : data?.reason;
      if (reason === 'Already connected') return;
      // The game is gone (or was left): take any table down, route out
      session.exitTable(EXIT.REJOIN_FAILED);
    },
    onPlayerReconnected: (data) => {
      console.log(`Player at position ${data.position} (${data.username}) reconnected`);
      // Their 'Replace with Bot?' offer is moot now
      dismissResignationDialog(data.position);
    },

    // Resignation & Lazy Mode callbacks
    onResignationAvailable: (data) => {
      // Remove any existing resignation dialog
      const existing = document.getElementById('resignation-dialog');
      if (existing) existing.remove();

      // Build inline confirmation dialog (same pattern as bid UI)
      const backdrop = document.createElement('div');
      backdrop.id = 'resignation-dialog';
      backdrop.dataset.position = String(data.position);
      backdrop.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(0, 0, 0, 0.7); display: flex;
        justify-content: center; align-items: center; z-index: 1000;
      `;

      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: #1a1a2e; border-radius: 12px; padding: 24px;
        min-width: 300px; max-width: 90vw;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      `;
      dialog.innerHTML = `
        <h3 style="margin: 0 0 16px 0; color: #fff;">Player Disconnected</h3>
        <p id="resign-message" style="margin: 0 0 24px 0; color: #ccc;"></p>
        <div style="display: flex; gap: 12px; justify-content: flex-end;">
          <button id="resign-cancel-btn" style="padding: 8px 16px; border: none; border-radius: 6px; background: #444; color: #fff; cursor: pointer;">Wait</button>
          <button id="resign-confirm-btn" style="padding: 8px 16px; border: none; border-radius: 6px; background: #23782d; color: #fff; cursor: pointer;">Replace with Bot</button>
        </div>
      `;
      // Username via textContent: it is user-controlled
      dialog.querySelector('#resign-message').textContent =
        `${data.username} did not reconnect. Replace with a bot?`;
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);

      dialog.querySelector('#resign-cancel-btn').onclick = () => backdrop.remove();
      dialog.querySelector('#resign-confirm-btn').onclick = () => {
        backdrop.remove();
        socket.emit('forceResign', { position: data.position });
      };

      window._resignationModal = backdrop;
    },
    onPlayerResigned: (data) => {
      // Dismiss any open resignation modal (another player may have already clicked resign)
      if (window._resignationModal) {
        window._resignationModal.remove();
        window._resignationModal = null;
      }

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

      // Show chat bubble at appropriate position
      if (scene && scene.handleShowChatBubble && state.position) {
        scene.handleShowChatBubble(state.position, data.position, data.message);
      }
    },

    // Profile callbacks
    onProfileReceived: (profile) => {
      showProfilePage(profile, socket);
    },
    onProfileError: (message) => {
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
    onSearchPlayersResult: (players) => {
      updatePlayerSearchResults(players);
    },
    onPlayerProfileReceived: (profile) => {
      showPlayerProfilePage(profile, socket, { isBlocked: isUserBlocked(profile.username) });
    },
    // Leaderboard callbacks
    onLeaderboardReceived: (leaderboard) => {
      showLeaderboardPage(leaderboard, socket);
    },
    onLeaderboardError: (message) => {
      showError(message || 'Failed to load leaderboard');
    },
    // Records callbacks
    onRecordsReceived: (records, totalGames) => {
      showRecordsPage(records, totalGames);
    },
    onRecordsError: (message) => {
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
    },

    onTournamentPlayerLeft: (data) => {
      updateTournamentPlayers(data.players, gameState.username);
      if (data.newCreator) {
        showInfo(`${data.newCreator} is now the tournament host`);
      }
    },

    onTournamentReadyUpdate: (data) => {
      updateTournamentPlayers(data.players, gameState.username);
    },

    onTournamentMessage: (data) => {
      if (isUserBlocked(data.username)) return;
      addTournamentChatMessage(data.username, data.message, data.isSpectator);
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

    onActiveTournamentFound: (data) => {
      gameState.tournamentId = data.tournamentId;
      if (session.hasTable) return;
      uiManager.showScreen(SCREENS.TOURNAMENT_LOBBY, data);
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
  const storedUsername = sessionStorage.getItem('username') || '';

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

// restoreSessionResponse: sent for session.resume() (every connect of a
// signed-in tab, once per socket)
socket.on('restoreSessionResponse', (data) => {
  if (data.success) {
    console.log('Session restored successfully');
    setBlockedUsers(data.blockedUsers);
    // Then rejoin, re-spectate, or re-enter the current screen
    const action = session.onSessionRestored(data);
    console.log(`Session restored: ${action}`);
  } else {
    console.log('Session restore failed:', data.message);
    // Clear invalid session data (and the device's saved copy of it)
    forgetSession(sessionStorage.getItem('sessionToken'));
    sessionStorage.removeItem('username');
    sessionStorage.removeItem('sessionToken');
    session.clearIdentity();
    displaySignInScreen(EXIT.SIGN_OUT);
  }
});

/**
 * Handle window load - show sign-in or attempt rejoin.
 */
window.addEventListener('load', () => {
  // Initialize the app
  initializeApp();

  // Create the Phaser game - GameScene.create() will call setGameScene
  createPhaserGame('game-container');

  // A fresh tab (or a reopened browser) resumes this device's saved session
  if (adoptSavedSession()) {
    console.log('Resuming saved session from this device');
  }

  const username = sessionStorage.getItem('username');
  console.log(`Window load: username=${username}, sessionToken=${session.credentials() ? 'present' : 'none'}, gameId=${session.persistedGameId}, spectating=${session.persistedSpectateId}`);

  if (!session.credentials()) {
    // Not signed in (or a legacy tab without a token): the sign-in screen
    displaySignInScreen();
  }
  // Handlers are registered: every connect from now on restores the session
  // first (now, if the socket is up), then rejoins / re-spectates / re-enters
  session.start();
});
