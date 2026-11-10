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
import { getTransitionOverlay, removeTransitionOverlay, transitionGeneration } from './ui/transitionOverlay.js';
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

/**
 * Set the game scene reference (GameScene.create() calls it, through
 * window.ModernUtils, after creating its managers).
 * @param {Phaser.Scene} scene - The active game scene
 */
export function setGameScene(scene) {
  gameSceneRef = scene;

  // Also set window.gameScene for global access
  window.gameScene = scene;

  // Table events that arrived while the scene was restarting (an exit's
  // teardown restarts it; a new table can start right after)
  flushSceneQueue(scene);

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
  console.log('🎮 Game scene reference cleared');
}

// Scene work deferred until the restarted scene registers, tagged with the
// table generation it belongs to (an exit or a new table drops it)
let sceneQueue = [];

/**
 * Run fn(scene) now, or once the restarting scene has registered.
 */
function withScene(fn) {
  const scene = getGameScene();
  if (scene) {
    fn(scene);
    return;
  }
  sceneQueue.push({ fn, generation: session.tableGeneration });
}

function flushSceneQueue(scene) {
  const queued = sceneQueue;
  sceneQueue = [];
  for (const { fn, generation } of queued) {
    if (generation !== session.tableGeneration) continue;
    try {
      fn(scene);
    } catch (err) {
      console.error('Deferred scene work failed:', err);
    }
  }
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

// Bridge for creating game feed - now uses modular GameLog
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
window.addToGameFeedFromLegacy = function(message, playerPosition = null) {
  if (gameLogInstance && gameLogInstance.addGameMessage) {
    gameLogInstance.addGameMessage(message, playerPosition);
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

  // Visible connection state while the socket is down
  installConnectionBanner(socketMgr);

  // Initialize UI manager
  const uiManager = initializeUIManager(socket);

  // Get game state singleton
  const gameState = getGameState();

  // The client session drives the screens; SocketManager's connect resumes it
  session.attach({ socketManager: socketMgr, gameState });

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
   * its teardown hook) and a rebuild in place (a re-spectate after a
   * reconnect, restorePlayerState) use this one list. It never touches the
   * game state or the gameId copies (exitTable resets those after it).
   * inPlace (a rebuild): voice and an open 'Replace with Bot?' offer stay.
   */
  function teardownTableUI({ inPlace = false } = {}) {
    if (!inPlace) stopVoice();
    // A rebuild in place supersedes any earlier rebuild still waiting for
    // the scene (exitTable bumps the generation itself)
    if (inPlace) session.supersedeTableWork();
    removeTransitionOverlay();
    window._readyForGameUI = false;
    window._tricksAnimating = false;
    sceneQueue = [];
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
    if (!inPlace) dismissResignationDialog();
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

  // Shared rejoin/restore logic — used by both onRejoinSuccess and onRestorePlayerState
  function processRejoinOrRestore(data) {
    console.log("🔄 Processing rejoin/restore with data:", data);
    // A later rejoin, re-entry or exit supersedes this one while it waits
    // for the scene (two waits must never both replay the game log)
    const generation = session.tableGeneration;

    // Clear any sign-in/lobby screens first
    uiManager.removeAllVignettes();
    const signInContainer = document.getElementById("signInContainer");
    if (signInContainer) signInContainer.remove();
    const lobbyContainer = document.getElementById("lobbyContainer");
    if (lobbyContainer) lobbyContainer.remove();
    const signInContainer2 = document.getElementById("sign-in-container");
    if (signInContainer2) signInContainer2.remove();

    // Remove any overlays (a rejoin inside the teams fade never gets
    // createUI, which is what normally lifts the black transition overlay)
    uiManager.removeWaitingScreen();
    removeTransitionOverlay();

    // Helper function to process rejoin after scene is ready
    const processRejoinData = () => {
      console.log("🔄 Scene ready, processing rejoin UI...");
      const scene = getGameScene();

      // Clean up draw phase via DrawManager (if present)
      if (scene && scene.drawManager) {
        scene.drawManager.cleanup();
      }

      // Create game UI elements (pass true to indicate reconnection)
      window.createGameFeedFromLegacy(true);

      // Restore game log history from server
      if (data.gameLog && data.gameLog.length > 0) {
        data.gameLog.forEach(entry => {
          window.addToGameFeedFromLegacy(entry.message, entry.playerPosition, entry.timestamp);
        });
      }

      // Calculate player names and update game log score
      const position = gameState.position;
      const playerData = gameState.playerData;
      if (playerData && position) {
        const { teamName, oppName } = getTeamNames(position, playerData);
        window.updateGameLogScoreFromLegacy(
          teamName, oppName,
          gameState.teamScore, gameState.oppScore,
          gameState.teamBids || '-/-', gameState.oppBids || '-/-',
          gameState.teamTricks, gameState.oppTricks
        );
      }

      // Update hand indicator
      if (data.currentHand !== undefined) {
        window.updateHandIndicatorFromLegacy(data.currentHand);
      }

      // Initialize managers with player position for reconnection
      if (scene && gameState.position) {
        if (scene.trickManager) {
          scene.trickManager.setPlayerPosition(gameState.position);
          scene.trickManager.updatePlayPositions();
        }
        if (scene.opponentManager) {
          scene.opponentManager.setPlayerPosition(gameState.position);
        }
        if (scene.effectsManager) {
          scene.effectsManager.setPlayerPosition(gameState.position);
        }
      }

      // Display trump card
      if (scene && data.trump && scene.displayTrumpCard) {
        scene.displayTrumpCard(data.trump);
      }

      // Display player hand via CardManager (skip animation on rejoin)
      if (scene && scene.handleDisplayHand && data.hand) {
        scene.handleDisplayHand(data.hand, true);
      }

      // Display opponent hands via OpponentManager (skip animation on rejoin)
      if (scene && scene.handleDisplayOpponentHands) {
        const cardCount = data.currentHand || data.hand?.length;
        if (cardCount) {
          scene.handleDisplayOpponentHands(
            cardCount,
            data.dealer,
            gameState.playerData,
            true
          );
        }
      }

      // Create DOM backgrounds via LayoutManager
      if (scene && scene.layoutManager) {
        scene.layoutManager.update();
        scene.layoutManager.createDomBackgrounds({ skipHandArea: gameState.isSpectator });
      }

      // Add .in-game class for game log layout
      document.getElementById('game-container')?.classList.add('in-game');

      // Create player info box (own avatar)
      if (scene && scene.createPlayerInfoBox && !scene._playerInfo && !gameState.isSpectator && gameState.playerData && gameState.position) {
        scene.createPlayerInfoBox(gameState.playerData, gameState.position);
      }

      // Restore HSI display
      if (scene && data.hsiValues && scene.updatePlayerHsi && gameState.position && !gameState.isSpectator) {
        scene.updatePlayerHsi(data.hsiValues[gameState.position]);
      }

      // Restore trick backgrounds if bidding is complete
      if (scene && scene.trickManager && data.playerBids && data.playerBids.length > 0 && !gameState.isBidding) {
        const parseBid = (bid) => {
          const bidStr = String(bid);
          return bidStr.includes('B') ? 0 : parseInt(bidStr, 10) || 0;
        };
        const team1Bid = parseBid(data.playerBids[0]) + parseBid(data.playerBids[2]);
        const team2Bid = parseBid(data.playerBids[1]) + parseBid(data.playerBids[3]);
        const isTeam1 = gameState.position === 1 || gameState.position === 3;
        const teamBid = isTeam1 ? team1Bid : team2Bid;
        const oppBid = isTeam1 ? team2Bid : team1Bid;

        scene.trickManager.setBidTotals(teamBid, oppBid);
        scene.trickManager._teamTrickCount = gameState.teamTricks || 0;
        scene.trickManager._oppTrickCount = gameState.oppTricks || 0;
        scene.trickManager.createTrickBackgrounds(false);

        // Restore visual trick stacks (card-back placeholders for won tricks)
        if (gameState.teamTricks > 0 || gameState.oppTricks > 0) {
          // Reset counts before restoreTrickPlaceholders (it increments them)
          scene.trickManager._teamTrickCount = 0;
          scene.trickManager._oppTrickCount = 0;
          scene.trickManager.restoreTrickPlaceholders(gameState.teamTricks, gameState.oppTricks);
        }
      }

      // Restore played cards in current trick via TrickManager
      if (scene && data.playedCards && data.playedCards.length > 0 && scene.trickManager) {
        scene.trickManager.restorePlayedCards(data.playedCards);
      }

      // Update card legality after restoring state
      if (scene && scene.cardManager && !gameState.isSpectator) {
        const canPlay = !gameState.isBidding &&
                        gameState.currentTurn === gameState.position &&
                        !gameState.hasPlayedCard;
        const legalityChecker = (card) => {
          const result = isLegalMove(
            card,
            gameState.myCards,
            gameState.leadCard,
            gameState.playedCardIndex === 0,
            gameState.trump,
            gameState.trumpBroken,
            gameState.position,
            gameState.leadPosition
          );
          return result.legal;
        };
        scene.cardManager.updateCardLegality(legalityChecker, canPlay);
      }

      // Show game log trick indicator on reconnect (persists through entire hand)
      if (gameLogInstance && gameLogInstance.showTrickIndicator) {
        const handSize = data.hand?.length || data.currentHand;
        if (handSize) {
          gameLogInstance.showTrickIndicator(handSize);
        }
      }

      // Re-apply bidding state (scene creation may have reset it)
      if (isBiddingOnRejoin) {
        gameState.isBidding = true;
        gameState.phase = PHASE.BIDDING;
      }

      // Create bid UI via BidManager (only if still in bidding phase)
      if (scene && scene.bidManager && data.hand && isBiddingOnRejoin && !gameState.isSpectator) {
        scene.bidManager.showBidUI(data.hand.length, (bid) => {
          if (window.socket) {
            window.socket.emit('playerBid', { position: gameState.position, bid });
          }
        });
      }

      // Add reconnected message to game feed
      window.addToGameFeedFromLegacy("Reconnected to game!");

      // Handle lazy mode — player is spectating while bot plays their hand
      if (data.isLazy) {
        gameState.isLazy = true;

        // Disable card interaction
        if (scene.cardManager) {
          scene.cardManager.setInteractive(false);
        }

        // Hide bid UI if it was shown
        if (scene.bidManager) {
          scene.bidManager.hideBidUI();
        }

        // Show spectating indicator
        let indicator = document.getElementById('spectating-indicator');
        if (!indicator) {
          indicator = document.createElement('div');
          indicator.id = 'spectating-indicator';
          indicator.style.cssText = `
            position: fixed;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.8);
            color: #4ade80;
            padding: 8px 20px;
            border-radius: 20px;
            font-size: 14px;
            z-index: 500;
            border: 1px solid #4ade80;
          `;
          indicator.textContent = 'Spectating — type /active to take back control';
          document.body.appendChild(indicator);
        }
      }
    };

    // Wait for scene to be ready before processing UI
    const waitForScene = () => {
      // Superseded, or the game ended (score modal) or was left meanwhile
      if (session.tableGeneration !== generation || !session.isAtTable) return;
      const scene = getGameScene();
      if (scene && scene.cardManager) {
        processRejoinData();
      } else {
        setTimeout(waitForScene, 100);
      }
    };

    // Update GameState from rejoin data first (synchronously)
    if (data.position) gameState.position = data.position;
    if (data.hand) gameState.setCards(data.hand);
    if (data.trump) gameState.setTrump(data.trump);
    if (data.dealer !== undefined) gameState.dealer = data.dealer;
    if (data.currentTurn !== undefined) gameState.setCurrentTurn(data.currentTurn);

    const bidding = data.isBidding !== undefined ? data.isBidding : data.bidding;
    const isBiddingOnRejoin = !!bidding;
    if (bidding !== undefined) {
      gameState.isBidding = bidding;
      gameState.phase = bidding ? PHASE.BIDDING : PHASE.PLAYING;
    }

    if (data.playedCards && Array.isArray(data.playedCards)) {
      let playedCount = 0;
      data.playedCards.forEach((card) => {
        if (card) playedCount++;
      });
      gameState.playedCardIndex = playedCount;

      // Use server-provided leadPosition (position-indexed array can't reliably infer lead order)
      if (data.leadPosition !== undefined) {
        gameState.leadPosition = data.leadPosition;
        const leadCard = data.playedCards[data.leadPosition - 1];
        if (leadCard) gameState.leadCard = leadCard;
      } else {
        // Fallback: infer from first non-null card (legacy)
        data.playedCards.forEach((card, index) => {
          if (card && !gameState.leadCard) {
            gameState.leadCard = card;
            gameState.leadPosition = index + 1;
          }
        });
      }
    } else {
      if (data.leadCard) gameState.leadCard = data.leadCard;
      if (data.leadPosition !== undefined) gameState.leadPosition = data.leadPosition;
      if (data.playedCardIndex !== undefined) gameState.playedCardIndex = data.playedCardIndex;
    }

    const trumpBroken = data.trumpBroken !== undefined ? data.trumpBroken : data.isTrumpBroken;
    if (trumpBroken !== undefined) gameState.trumpBroken = trumpBroken;
    gameState.hasPlayedCard = false;

    if (data.score) {
      const position = gameState.position;
      if (position % 2 !== 0) {
        gameState.setGameScores(data.score.team1, data.score.team2);
      } else {
        gameState.setGameScores(data.score.team2, data.score.team1);
      }
    }

    // Restore trick counts from server format (team1/team2 → team/opp)
    if (data.tricks) {
      if (gameState.position % 2 !== 0) {
        gameState.teamTricks = data.tricks.team1;
        gameState.oppTricks = data.tricks.team2;
      } else {
        gameState.teamTricks = data.tricks.team2;
        gameState.oppTricks = data.tricks.team1;
      }
    }

    // Restore position-keyed bids from playerBids array
    // (data.bids is {team1, team2} after bidding completes, but _updateTeamBids needs position keys)
    if (data.playerBids && data.playerBids.length > 0) {
      for (let i = 0; i < data.playerBids.length; i++) {
        if (data.playerBids[i] !== undefined && data.playerBids[i] !== null) {
          gameState.bids[i + 1] = data.playerBids[i];
        }
      }
      gameState._updateTeamBids();
    }

    // Wait for scene to be ready before processing UI
    waitForScene();
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
        try {
        const spectatedGameId = data.gameId || session.takePendingSpectate();
        // A re-spectate after a reconnect rebuilds the table from this state
        if (session.isAtTable) teardownTableUI({ inPlace: true });
        session.routeArrived();
        // Spectators persist spectatingGameId only (a reconnect re-spectates)
        session.enterTable(ROLE.SPECTATOR, spectatedGameId);
        const generation = session.tableGeneration;

        // Mark as spectator in game state
        gameState.isSpectator = true;
        gameState.phase = PHASE.PLAYING;

        // Build player data structure from spectator data
        const positions = data.players.map(p => p.position);
        const sockets = data.players.map(p => p.socketId);
        const usernames = data.players.map(p => ({ username: p.username, socketId: p.socketId }));
        const pics = data.players.map(p => p.pic);

        gameState.setPlayerData({
          position: positions,
          sockets: sockets,
          username: usernames,
          pics: pics
        });

        // Use position 1 as the spectator's "view position" (they see from P1's perspective)
        gameState.position = 1;

        // Set up the game scene for spectating
        const waitForScene = () => {
          // Superseded, or the game ended (score modal) or was left meanwhile
          if (session.tableGeneration !== generation || !session.isAtTable) return;
          const scene = getGameScene();
          if (scene && scene.cardManager) {
            try {
              // Create game UI (game log panel)
              window.createGameFeedFromLegacy(false);

              // Restore game log
              if (data.gameLog && data.gameLog.length > 0) {
                data.gameLog.forEach(entry => {
                  window.addToGameFeedFromLegacy(entry.message, entry.playerPosition, entry.timestamp);
                });
              }

              // Update scores
              gameState.setGameScores(data.score.team1, data.score.team2);

              // Restore trick counts
              if (data.tricks) {
                gameState.teamTricks = data.tricks.team1;
                gameState.oppTricks = data.tricks.team2;
              }

              // Restore bids from playerBids array
              if (data.playerBids && data.playerBids.length > 0) {
                for (let i = 0; i < data.playerBids.length; i++) {
                  if (data.playerBids[i] !== undefined && data.playerBids[i] !== null) {
                    gameState.bids[i + 1] = data.playerBids[i];
                  }
                }
                gameState._updateTeamBids();
              }

              // Update game log score with bids
              const { teamName, oppName } = getTeamNames(1, gameState.playerData);
              window.updateGameLogScoreFromLegacy(
                teamName, oppName,
                data.score.team1, data.score.team2,
                gameState.teamBids || '-/-', gameState.oppBids || '-/-',
                gameState.teamTricks || 0, gameState.oppTricks || 0
              );

              // Update hand indicator
              if (data.currentHand !== undefined) {
                window.updateHandIndicatorFromLegacy(data.currentHand);
              }

              // Set up managers
              if (scene.trickManager) {
                scene.trickManager.setPlayerPosition(1);
                scene.trickManager.setSpectatorMode(true);
                scene.trickManager.updatePlayPositions();
              }
              if (scene.opponentManager) {
                scene.opponentManager.setPlayerPosition(1);
                scene.opponentManager.setSpectatorMode(true);
              }

              // Restore trick backgrounds if bidding is complete
              const isBidding = data.bidding !== undefined ? data.bidding : false;
              if (scene.trickManager && data.playerBids && data.playerBids.length > 0 && !isBidding) {
                const parseBid = (bid) => {
                  const bidStr = String(bid);
                  return bidStr.includes('B') ? 0 : parseInt(bidStr, 10) || 0;
                };
                const team1Bid = parseBid(data.playerBids[0]) + parseBid(data.playerBids[2]);
                const team2Bid = parseBid(data.playerBids[1]) + parseBid(data.playerBids[3]);
                // Spectator views from position 1 (team 1)
                scene.trickManager.setBidTotals(team1Bid, team2Bid);
                scene.trickManager._teamTrickCount = gameState.teamTricks || 0;
                scene.trickManager._oppTrickCount = gameState.oppTricks || 0;
                scene.trickManager.createTrickBackgrounds(false);

                // Create card-back placeholder stacks for already-won tricks
                // (server only sends counts, not actual cards)
                if (gameState.teamTricks > 0 || gameState.oppTricks > 0) {
                  // Reset counts first — restoreTrickPlaceholders increments them
                  scene.trickManager._teamTrickCount = 0;
                  scene.trickManager._oppTrickCount = 0;
                  scene.trickManager.restoreTrickPlaceholders(
                    gameState.teamTricks || 0,
                    gameState.oppTricks || 0
                  );
                }
              }

              // Display trump card
              if (data.trump && scene.displayTrumpCard) {
                scene.displayTrumpCard(data.trump);
              }

              // Display opponent hands (no player hand for spectators)
              if (scene.handleDisplayOpponentHands) {
                scene.handleDisplayOpponentHands(
                  data.currentHand, // approximate card count
                  data.dealer,
                  gameState.playerData,
                  true // skip animation
                );
              }

              if (scene.layoutManager) {
                scene.layoutManager.update();
                scene.layoutManager.createDomBackgrounds({ skipHandArea: true });
              }

              // Restore played cards
              if (data.playedCards && data.playedCards.length > 0 && scene.trickManager) {
                scene.trickManager.restorePlayedCards(data.playedCards);
              }

              // Show spectating indicator
              let indicator = document.getElementById('spectating-indicator');
              if (!indicator) {
                indicator = document.createElement('div');
                indicator.id = 'spectating-indicator';
                indicator.style.cssText = `
                  position: fixed;
                  top: 10px;
                  left: 50%;
                  transform: translateX(-50%);
                  background: rgba(0, 0, 0, 0.8);
                  color: #60a5fa;
                  padding: 8px 20px;
                  border-radius: 20px;
                  font-size: 14px;
                  z-index: 500;
                  border: 1px solid #60a5fa;
                `;
                indicator.textContent = 'Spectating — type /leave to exit';
                document.body.appendChild(indicator);
              }

              // Add game container in-game class
              document.getElementById('game-container')?.classList.add('in-game');

              window.addToGameFeedFromLegacy?.("Joined as spectator!");
            } catch (err) {
              console.error('👁️ Error setting up spectator view:', err);
            }
          } else {
            setTimeout(waitForScene, 100);
          }
        };

        waitForScene();
        } catch (outerErr) {
          console.error('👁️ Error in spectator setup (outer):', outerErr);
        }
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
      // Update modular GameState
      if (data.position) {
        gameState.position = data.position;
        gameState._updatePlayerNames();
      }
      if (data.hand) {
        gameState.setCards(data.hand);
      }
      if (data.trump) {
        gameState.setTrump(data.trump);
      }
      if (data.dealer !== undefined) {
        gameState.dealer = data.dealer;
      }
      gameState.phase = PHASE.BIDDING;
      gameState.isBidding = true;

      // Initialize all managers with player position
      const scene = getGameScene();
      if (!scene) return;

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

      // Update player data if included (reflects bot takeovers)
      if (data.playerInfo) {
        gameState.setPlayerData({
          positions: data.playerInfo.map(p => p.position),
          sockets: data.players,
          usernames: data.playerInfo.map(p => ({ username: p.username })),
          pics: data.playerInfo.map(p => p.pic),
        });
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

      // Display trump card via scene method (show immediately)
      if (data.trump && scene.displayTrumpCard) {
        scene.displayTrumpCard(data.trump);
      }

      // Function to display cards (delayed until fade complete)
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

      // Function to show bid UI (delayed until trump flip complete)
      const showBidUIAfterFlip = () => {
        if (gameState.isLazy || gameState.isSpectator) return;
        if (scene.bidManager && data.hand) {
          scene.bidManager.showBidUI(data.hand.length, (bid) => {
            console.log(`📩 Sending bid: ${bid}`);
            if (window.socket) {
              window.socket.emit('playerBid', { position: gameState.position, bid });
            }
          });
        }
      };

      // Wait for transition to complete before showing cards
      // If no transition overlay exists, wait for tricks to clear (subsequent hands)
      const hasTransition = getTransitionOverlay();
      if (hasTransition) {
        // First hand - wait for fade transition
        if (window._readyForGameUI) {
          showCards();
        } else {
          const gen = transitionGeneration();
          window.addEventListener('gameUIReady', function onReady() {
            window.removeEventListener('gameUIReady', onReady);
            // The overlay was removed by a rejoin/exit since: not this deal's fade
            if (transitionGeneration() !== gen) return;
            showCards();
          });
        }
      } else {
        // Subsequent hands - wait for tricks to clear first
        if (window._tricksAnimating) {
          window.addEventListener('tricksCleared', function onCleared() {
            window.removeEventListener('tricksCleared', onCleared);
            showCards();
          });
        } else {
          showCards();
        }
      }

      // Wait for trump flip to complete before showing bid UI
      window.addEventListener('trumpFlipComplete', function onFlip() {
        window.removeEventListener('trumpFlipComplete', onFlip);
        showBidUIAfterFlip();
      });

      // Update game log score display
      if (data.hand && data.hand.length > 0) {
        const position = gameState.position;
        const playerData = gameState.playerData;
        if (playerData && position) {
          const { teamName, oppName } = getTeamNames(position, playerData);
          // Get scores from data, adjusted for player's team
          const teamScore = position % 2 !== 0 ? (data.score1 || 0) : (data.score2 || 0);
          const oppScore = position % 2 !== 0 ? (data.score2 || 0) : (data.score1 || 0);
          window.updateGameLogScoreFromLegacy(teamName, oppName, teamScore, oppScore);
        }
      }

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
      withScene((scene) => scene.handleStartDraw(data));
    },
    onYouDrew: (data) => {
      withScene((scene) => scene.handleYouDrew(data));
    },
    onPlayerDrew: (data) => {
      withScene((scene) => scene.handlePlayerDrew(data));
    },
    onTeamsAnnounced: (data) => {
      withScene((scene) => scene.handleTeamsAnnounced(data));
    },
    onCreateUI: (data) => {
      console.log('🎨 onCreateUI callback');
      // Remove waiting screen and lobby/main room/tournament UI
      uiManager.removeWaitingScreen();
      removeMainRoom();
      removeGameLobby();
      removeTournamentLobby();

      // Clean up draw phase via DrawManager with fade transition
      const scene = getGameScene();
      if (scene && scene.handleCreateUI) {
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
      }
    },
    // Bidding phase - call GameScene handlers plus legacy code
    onBidReceived: (data) => {
      // Update GameState with bid
      if (data.position !== undefined && data.bid !== undefined) {
        gameState.recordBid(data.position, data.bid);
      }
      const scene = getGameScene();
      if (scene && scene.handleBidReceived) {
        scene.handleBidReceived(data);
      }
      // Update game log trick indicator
      if (gameLogInstance && gameLogInstance.updateTrickIndicator) {
        gameLogInstance.updateTrickIndicator();
      }
      // Note: Legacy code in displayCards() also handles bidReceived for bubbles/impact events
    },
    onDoneBidding: (data) => {
      // Update GameState - transition from bidding to playing
      gameState.phase = PHASE.PLAYING;
      gameState.isBidding = false;
      const scene = getGameScene();
      if (scene && scene.handleDoneBidding) {
        scene.handleDoneBidding(data);
      }

      // Create trick backgrounds now that bidding is complete
      if (scene && scene.trickManager && data.bids) {
        const myPosition = gameState.position;
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
      // Note: Legacy code in displayCards() also handles doneBidding
    },
    onUpdateTurn: (data) => {
      // Update GameState with current turn
      if (data.currentTurn !== undefined) {
        gameState.setCurrentTurn(data.currentTurn);
      }
      const scene = getGameScene();
      if (scene && scene.handleUpdateTurn) {
        scene.handleUpdateTurn(data);
      }
      // Note: Legacy code in displayCards() also handles updateTurn for glow effects
    },
    // Card play & tricks - call GameScene handlers (legacy still runs in displayCards)
    onCardPlayed: (data) => {
      // Update GameState
      if (data.trumpBroken) {
        gameState.breakTrump();
      }
      const scene = getGameScene();
      if (scene && scene.handleCardPlayed) {
        scene.handleCardPlayed(data);
      }
    },
    onTrickComplete: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleTrickComplete) {
        scene.handleTrickComplete(data);
      }
    },
    // Hand & game end - call GameScene handlers
    onHandComplete: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleHandComplete) {
        scene.handleHandComplete(data);
      }
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
      const scene = getGameScene();
      if (scene && scene.handleRainbow) {
        scene.handleRainbow(data);
      }
    },
    onDestroyHands: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleDestroyHands) {
        scene.handleDestroyHands(data);
      }
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
      processRejoinOrRestore(data);
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
      const scene = getGameScene();
      if (scene && scene.handlePlayerLazyMode) {
        scene.handlePlayerLazyMode(data);
      }

      // If it's the local player entering lazy mode, disable card interaction
      if (data.position === gameState.position && !gameState.isSpectator) {
        gameState.isLazy = true;
        session.setRole(ROLE.LAZY);
        if (scene && scene.cardManager) {
          scene.cardManager.setInteractive(false);
        }
        // Hide bid UI if it's showing
        if (scene && scene.bidManager) {
          scene.bidManager.hideBidUI();
        }
        // Show spectating indicator
        let indicator = document.getElementById('spectating-indicator');
        if (!indicator) {
          indicator = document.createElement('div');
          indicator.id = 'spectating-indicator';
          indicator.style.cssText = `
            position: fixed;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.8);
            color: #4ade80;
            padding: 8px 20px;
            border-radius: 20px;
            font-size: 14px;
            z-index: 500;
            border: 1px solid #4ade80;
          `;
          indicator.textContent = 'Spectating — type /active to take back control';
          document.body.appendChild(indicator);
        }
      }

    },
    onPlayerActiveMode: (data) => {
      const scene = getGameScene();
      if (scene && scene.handlePlayerActiveMode) {
        scene.handlePlayerActiveMode(data);
      }

      // If it's the local player returning to active mode, re-enable card interaction
      if (data.position === gameState.position && !gameState.isSpectator) {
        gameState.isLazy = false;
        session.setRole(ROLE.PLAYER);
        if (scene && scene.cardManager) {
          scene.cardManager.setInteractive(true);
        }
        // Lazy mode left every card dimmed and the bid UI hidden: recompute
        // legality for the open turn, and hand the bid back mid-bid
        scene?.refreshControlAfterActive?.((bid) => {
          socket.emit('playerBid', { position: gameState.position, bid });
        });
        // Remove spectating indicator
        const indicator = document.getElementById('spectating-indicator');
        if (indicator) indicator.remove();
      }

    },
    onLeftGame: (data) => {
      // /leave (seat or spectating): out to the tournament for a tournament
      // player, as iOS does, else the main room
      session.exitTable(EXIT.LEFT_GAME);
    },
    onRestorePlayerState: (data) => {
      // Spectator → active player transition (or a resync after a refused
      // play): rebuild the table in place, then reuse the rejoin path
      // Clean up the current table first (voice stays)
      teardownTableUI({ inPlace: true });

      gameState.isSpectator = false;
      gameState.isLazy = false;

      // Rebuild playerData from server's players array
      if (data.players && data.players.length > 0) {
        const positions = data.players.map(p => p.position);
        const sockets = data.players.map(p => p.socketId);
        const usernames = data.players.map(p => ({ username: p.username, socketId: p.socketId }));
        const pics = data.players.map(p => p.pic);
        gameState.setPlayerData({ position: positions, sockets, username: usernames, pics });
      }

      // A seat now: its gameId persists for a reconnect
      session.enterTable(ROLE.PLAYER, data.gameId || session.gameId);

      // Reuse the proven rejoin path — same data format (getClientState)
      processRejoinOrRestore(data);
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
