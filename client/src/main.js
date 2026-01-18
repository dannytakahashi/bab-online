/**
 * Main entry point for the modular client.
 *
 * This stub will be expanded as modules are extracted from the monolithic
 * game.js and ui.js files.
 *
 * During the transition, we use a bridge pattern to expose new modules
 * to the existing code via window.ModernUtils.
 */

// Constants
import { CLIENT_EVENTS, SERVER_EVENTS } from './constants/events.js';
import { RANK_VALUES, RANK_ORDER, SUITS, JOKER_SUIT, HAND_PROGRESSION } from './constants/ranks.js';

// Utilities
import { team, rotate, isSameTeam, getTeamNumber, getPlayerName, getRelativePosition } from './utils/positions.js';
import { getCardImageKey, getSuitOrder, sortHand, cardsEqual, isJoker, getCardDisplayName } from './utils/cards.js';
import { hashToHue, generateDistinctColor, getUsernameColor, extractHue } from './utils/colors.js';

// Rules
import { sameSuit, isVoid, isTrumpTight, isHighestTrump, isLegalMove, wouldBreakTrump, getLegalCards } from './rules/legality.js';

// State
import { GameState, PHASE, getGameState, resetGameState } from './state/GameState.js';

// Socket
import { SocketManager, CONNECTION_STATE, getSocketManager, initializeSocketManager, resetSocketManager } from './socket/SocketManager.js';

// UI Components
import { createModal, confirm as confirmDialog, alert as alertDialog } from './ui/components/Modal.js';
import { showToast, showError, showSuccess, showWarning, showInfo } from './ui/components/Toast.js';
import { createSignInScreen, showSignInScreen } from './ui/screens/SignIn.js';
import { createRegisterScreen, showRegisterScreen } from './ui/screens/Register.js';
import { showMainRoom, addMainRoomChatMessage, updateLobbyList, removeMainRoom, updateMainRoomOnlineCount, getMainRoomUserColors } from './ui/screens/MainRoom.js';
import { showGameLobby, updateLobbyPlayersList, addLobbyChatMessage, removeGameLobby, getCurrentLobbyId, getIsPlayerReady, getLobbyUserColors } from './ui/screens/GameLobby.js';
import { UIManager, SCREENS, getUIManager, initializeUIManager, resetUIManager } from './ui/UIManager.js';

// Phaser
import { createGameConfig, CARD_CONFIG, ANIMATION_CONFIG, TABLE_POSITIONS } from './phaser/config.js';
import { CardManager } from './phaser/managers/CardManager.js';
import { OpponentManager } from './phaser/managers/OpponentManager.js';
import { TrickManager } from './phaser/managers/TrickManager.js';
import { EffectsManager } from './phaser/managers/EffectsManager.js';
import { DrawManager } from './phaser/managers/DrawManager.js';
import { BidManager } from './phaser/managers/BidManager.js';
import { LayoutManager } from './phaser/managers/LayoutManager.js';
import { GameScene } from './phaser/scenes/GameScene.js';

// Handlers
import {
  registerAllHandlers,
  registerAuthHandlers,
  registerLobbyHandlers,
  registerGameHandlers,
  registerChatHandlers,
  cleanupGameHandlers,
} from './handlers/index.js';

// ============================================
// Game Scene Access
// ============================================

// Reference to the active Phaser game scene
let gameSceneRef = null;

/**
 * Set the game scene reference (called from game.js when scene is created).
 * Also attaches DrawManager to the scene for draw phase handling.
 * @param {Phaser.Scene} scene - The active game scene
 */
export function setGameScene(scene) {
  gameSceneRef = scene;

  // Attach DrawManager to the scene if not already present
  if (!scene.drawManager) {
    scene.drawManager = new DrawManager(scene);
    console.log('🎮 DrawManager attached to scene');
  }

  // Add handler methods to the scene for draw phase
  if (!scene.handleStartDraw) {
    scene.handleStartDraw = function(data) {
      console.log('🎮 Legacy scene handleStartDraw');
      if (this.drawManager) {
        this.drawManager.showDrawUI();
      }
    };
  }

  if (!scene.handleYouDrew) {
    scene.handleYouDrew = function(data) {
      console.log('🎮 Legacy scene handleYouDrew');
      if (this.drawManager) {
        this.drawManager.handleYouDrew(data);
      }
    };
  }

  if (!scene.handlePlayerDrew) {
    scene.handlePlayerDrew = function(data) {
      console.log('🎮 Legacy scene handlePlayerDrew');
      if (this.drawManager) {
        this.drawManager.handlePlayerDrew(data);
      }
    };
  }

  if (!scene.handleTeamsAnnounced) {
    scene.handleTeamsAnnounced = function(data) {
      console.log('🎮 Legacy scene handleTeamsAnnounced');
      if (this.drawManager) {
        this.drawManager.handleTeamsAnnounced(data);
      }
    };
  }

  if (!scene.handleCreateUI) {
    scene.handleCreateUI = function(data) {
      console.log('🎮 Legacy scene handleCreateUI');
      if (this.drawManager) {
        this.drawManager.cleanup();
      }
    };
  }

  // Attach BidManager to the scene if not already present
  if (!scene.bidManager) {
    scene.bidManager = new BidManager(scene);
    console.log('🎮 BidManager attached to scene');
  }

  // Add handler methods to the scene for bidding phase
  if (!scene.handleBidReceived) {
    scene.handleBidReceived = function(data) {
      console.log('🎮 Legacy scene handleBidReceived');
      // Add to temp bids for bore button state
      const gameState = getGameState();
      gameState.addTempBid(data.bid);
      // Update bore button states
      if (this.bidManager) {
        this.bidManager.updateBoreButtonStates();
      }
      // Also update legacy bore buttons if they exist
      if (window.updateBoreButtons) {
        window.updateBoreButtons();
      }
    };
  }

  if (!scene.handleDoneBidding) {
    scene.handleDoneBidding = function(data) {
      console.log('🎮 Legacy scene handleDoneBidding');
      // Clear temp bids
      const gameState = getGameState();
      gameState.clearTempBids();
      // Hide bid UI
      if (this.bidManager) {
        this.bidManager.hideBidUI();
      }
    };
  }

  if (!scene.handleUpdateTurn) {
    scene.handleUpdateTurn = function(data) {
      console.log('🎮 Legacy scene handleUpdateTurn');
      const gameState = getGameState();
      // Update bid UI visibility during bidding phase
      if (this.bidManager && gameState.isBidding) {
        this.bidManager.updateVisibility();
      }
    };
  }

  // Attach TrickManager to the scene if not already present
  if (!scene.trickManager) {
    scene.trickManager = new TrickManager(scene);
    console.log('🎮 TrickManager attached to scene');
  }

  // Add handler methods to the scene for card play
  if (!scene.handleCardPlayed) {
    scene.handleCardPlayed = function(data) {
      console.log('🎮 Legacy scene handleCardPlayed');
      const gameState = getGameState();
      // Initialize TrickManager position if needed
      if (this.trickManager && gameState.position) {
        this.trickManager.setPlayerPosition(gameState.position);
        this.trickManager.updatePlayPositions();
      }
    };
  }

  if (!scene.handleTrickComplete) {
    scene.handleTrickComplete = function(data) {
      console.log('🎮 Legacy scene handleTrickComplete');
      // Note: Legacy code handles trick collection animation
    };
  }

  // Attach EffectsManager to the scene if not already present
  if (!scene.effectsManager) {
    scene.effectsManager = new EffectsManager(scene);
    console.log('🎮 EffectsManager attached to scene');
  }

  // Add handler methods for hand/game end events
  if (!scene.handleHandComplete) {
    scene.handleHandComplete = function(data) {
      console.log('🎮 Legacy scene handleHandComplete');
      const gameState = getGameState();
      // Reset effects for new hand
      if (this.effectsManager) {
        this.effectsManager.resetForNewHand();
      }
      // Reset trick manager for new hand
      if (this.trickManager) {
        this.trickManager.resetForNewHand();
      }
    };
  }

  if (!scene.handleGameEnd) {
    scene.handleGameEnd = function(data) {
      console.log('🎮 Legacy scene handleGameEnd');
      // Clear effects
      if (this.effectsManager) {
        this.effectsManager.clearAll();
      }
    };
  }

  if (!scene.handleRainbow) {
    scene.handleRainbow = function(data) {
      console.log('🎮 Legacy scene handleRainbow');
      const gameState = getGameState();
      // Set player position in effects manager if needed
      if (this.effectsManager && gameState.position) {
        this.effectsManager.setPlayerPosition(gameState.position);
        this.effectsManager.showRainbow(data.position);
      }
    };
  }

  if (!scene.handleDestroyHands) {
    scene.handleDestroyHands = function(data) {
      console.log('🎮 Legacy scene handleDestroyHands');
      // Clear trick displays
      if (this.trickManager) {
        this.trickManager.clearAll();
      }
    };
  }

  // Add handler methods for reconnection/error events
  if (!scene.handlePlayerDisconnected) {
    scene.handlePlayerDisconnected = function(data) {
      console.log('🎮 Legacy scene handlePlayerDisconnected');
      // Game.js handles this via socket.on listener for now
    };
  }

  if (!scene.handlePlayerReconnected) {
    scene.handlePlayerReconnected = function(data) {
      console.log('🎮 Legacy scene handlePlayerReconnected');
      // Game.js handles this via CustomEvent listener for now
    };
  }

  if (!scene.handleRejoinSuccess) {
    scene.handleRejoinSuccess = function(data) {
      console.log('🎮 Legacy scene handleRejoinSuccess');
      // Game.js handles this via CustomEvent listener calling processRejoin()
    };
  }

  if (!scene.handleRejoinFailed) {
    scene.handleRejoinFailed = function(data) {
      console.log('🎮 Legacy scene handleRejoinFailed');
      // Game.js handles this via CustomEvent listener for now
    };
  }

  if (!scene.handleAbortGame) {
    scene.handleAbortGame = function(data) {
      console.log('🎮 Legacy scene handleAbortGame');
      // Clear all managers
      if (this.effectsManager) {
        this.effectsManager.clearAll();
      }
      if (this.trickManager) {
        this.trickManager.clearAll();
      }
      if (this.drawManager) {
        this.drawManager.cleanup();
      }
      // Game.js socket.on handler does the rest (restart scene, return to main room)
    };
  }

  // Attach LayoutManager to the scene if not already present
  if (!scene.layoutManager) {
    scene.layoutManager = new LayoutManager(scene);
    console.log('🎮 LayoutManager attached to scene');
  }

  // Add resize handler that updates LayoutManager
  if (!scene.handleResize) {
    scene.handleResize = function(width, height) {
      console.log('🎮 Legacy scene handleResize');
      if (this.layoutManager) {
        this.layoutManager.update();
        // Update TrickManager play positions from LayoutManager
        if (this.trickManager) {
          const playPos = this.layoutManager.getPlayPositions();
          this.trickManager.playPositions = playPos;
        }
      }
    };
  }

  console.log('🎮 Game scene reference set with all handlers');
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

// UI Components - Bid & Game Log
import { createBidUI, showBidUI, createBidBubble } from './ui/components/BidUI.js';
import { createGameLog, showGameLog } from './ui/components/GameLog.js';
import { createSpeechBubble, showChatBubble, clearChatBubbles, getBubblePosition, getActiveChatBubbles } from './ui/components/ChatBubble.js';
import { showPlayerQueue, updatePlayerQueue, removePlayerQueue, isPlayerQueueVisible } from './ui/components/PlayerQueue.js';
import { getTeamNames, formatHandCompleteMessages, formatGameEndMessages, showFinalScoreOverlay, removeFinalScoreOverlay } from './ui/components/ScoreModal.js';

// Bridge module - exposes new modules to legacy code
window.ModernUtils = {
  // Scene Access
  setGameScene,
  getGameScene,
  clearGameScene,

  // Constants
  CLIENT_EVENTS,
  SERVER_EVENTS,
  RANK_VALUES,
  RANK_ORDER,
  SUITS,
  JOKER_SUIT,
  HAND_PROGRESSION,

  // Position utilities
  team,
  rotate,
  isSameTeam,
  getTeamNumber,
  getPlayerName,
  getRelativePosition,

  // Card utilities
  getCardImageKey,
  getSuitOrder,
  sortHand,
  cardsEqual,
  isJoker,
  getCardDisplayName,

  // Color utilities
  hashToHue,
  generateDistinctColor,
  getUsernameColor,
  extractHue,

  // Rules
  sameSuit,
  isVoid,
  isTrumpTight,
  isHighestTrump,
  isLegalMove,
  wouldBreakTrump,
  getLegalCards,

  // State
  GameState,
  PHASE,
  getGameState,
  resetGameState,

  // Socket
  SocketManager,
  CONNECTION_STATE,
  getSocketManager,
  initializeSocketManager,
  resetSocketManager,

  // UI Components
  createModal,
  confirmDialog,
  alertDialog,
  showToast,
  showError,
  showSuccess,
  showWarning,
  showInfo,
  createSignInScreen,
  showSignInScreen,
  createRegisterScreen,
  showRegisterScreen,
  showMainRoom,
  addMainRoomChatMessage,
  updateLobbyList,
  removeMainRoom,
  updateMainRoomOnlineCount,
  getMainRoomUserColors,
  showGameLobby,
  updateLobbyPlayersList,
  addLobbyChatMessage,
  removeGameLobby,
  getCurrentLobbyId,
  getIsPlayerReady,
  getLobbyUserColors,
  UIManager,
  SCREENS,
  getUIManager,
  initializeUIManager,
  resetUIManager,

  // Phaser
  createGameConfig,
  CARD_CONFIG,
  ANIMATION_CONFIG,
  TABLE_POSITIONS,
  CardManager,
  OpponentManager,
  TrickManager,
  EffectsManager,
  DrawManager,
  BidManager,
  LayoutManager,
  GameScene,

  // Handlers
  registerAllHandlers,
  registerAuthHandlers,
  registerLobbyHandlers,
  registerGameHandlers,
  registerChatHandlers,
  cleanupGameHandlers,

  // UI Components - Bid & Game Log
  createBidUI,
  showBidUI,
  createBidBubble,
  createGameLog,
  showGameLog,
  createSpeechBubble,
  showChatBubble,
  clearChatBubbles,
  getBubblePosition,
  getActiveChatBubbles,
  showPlayerQueue,
  updatePlayerQueue,
  removePlayerQueue,
  isPlayerQueueVisible,

  // Score Modal
  getTeamNames,
  formatHandCompleteMessages,
  formatGameEndMessages,
  showFinalScoreOverlay,
  removeFinalScoreOverlay,
};

console.log('Modular client initialized - All utilities available via window.ModernUtils');

// ============================================
// Application Initialization
// ============================================

/**
 * Get the socket connection.
 * Socket is created in inline script in index.html before game.js loads.
 * This ensures window.socket is available for legacy code that calls socket.on() at top level.
 */
function getSocket() {
  // Socket is created in index.html inline script
  if (window.socket) {
    return window.socket;
  }
  // Fallback: create socket if not already created (shouldn't happen)
  console.warn('Socket not found on window, creating new socket');
  const serverUrl =
    location.hostname === 'localhost'
      ? 'http://localhost:3000'
      : 'https://bab-online-production.up.railway.app';

  const socket = io(serverUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
  window.socket = socket;
  return socket;
}

// Get socket (created in index.html inline script before game.js loads)
const socket = getSocket();
console.log('Using socket from window.socket');

// ==================== RECONNECTION LOGIC ====================
// (Previously in socketManager.js, needed for game.js to work)

// Track if we've already attempted rejoin this session
let rejoinAttempted = false;
// Track if rejoin was successful (to ignore mainRoomJoined during game)
let rejoinSucceeded = false;

socket.on('connect', () => {
  console.log('Connected to server:', socket.id);

  // Check if we were in a game and should try to rejoin
  const gameId = sessionStorage.getItem('gameId');
  const username = sessionStorage.getItem('username');

  console.log(`Session state: gameId=${gameId}, username=${username}, rejoinAttempted=${rejoinAttempted}`);

  if (gameId && username && !rejoinAttempted) {
    rejoinAttempted = true;
    console.log(`Attempting to rejoin game ${gameId} as ${username}`);
    socket.emit('rejoinGame', { gameId, username });
  } else if (!gameId && !username) {
    console.log('No stored session, will show sign-in screen');
  } else if (!gameId && username) {
    console.log('No active game, will join main room');
  }
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected from server:', reason);
  document.dispatchEvent(new CustomEvent('connectionLost', { detail: { reason } }));
});

socket.on('reconnect_attempt', (attemptNumber) => {
  console.log(`Reconnection attempt ${attemptNumber}/5`);
  document.dispatchEvent(new CustomEvent('reconnecting', { detail: { attempt: attemptNumber } }));
});

socket.on('reconnect_failed', () => {
  console.log('Reconnection failed after all attempts');
  document.dispatchEvent(new CustomEvent('reconnectFailed'));
  sessionStorage.removeItem('gameId');
});

// Forward rejoin events to document for game.js
socket.on('rejoinSuccess', (data) => {
  console.log('Rejoin successful:', data);
  rejoinSucceeded = true;

  // Remove any auth screens that might be showing
  const signInContainer = document.getElementById('sign-in-container');
  if (signInContainer) signInContainer.remove();
  const signInVignette = document.getElementById('sign-in-vignette');
  if (signInVignette) signInVignette.remove();
  const legacySignIn = document.getElementById('signInContainer');
  if (legacySignIn) legacySignIn.remove();
  const legacyVignette = document.getElementById('SignInVignette');
  if (legacyVignette) legacyVignette.remove();
  const registerContainer = document.getElementById('register-container');
  if (registerContainer) registerContainer.remove();
  const registerVignette = document.getElementById('register-vignette');
  if (registerVignette) registerVignette.remove();

  // Also remove main room and lobby if present
  removeMainRoom();
  removeGameLobby();

  document.dispatchEvent(new CustomEvent('rejoinSuccess', { detail: data }));
});

socket.on('rejoinFailed', (data) => {
  console.log('Rejoin failed:', data?.reason || data);
  // Only clear gameId if it's a real failure, not "Already connected"
  // "Already connected" means a previous rejoin attempt succeeded
  const reason = typeof data === 'string' ? data : data?.reason;
  if (reason !== 'Already connected') {
    sessionStorage.removeItem('gameId');
    // Show sign-in screen if rejoin truly failed
    console.log('Rejoin truly failed, showing sign-in screen');
    // Use setTimeout to ensure DOM is ready
    setTimeout(() => {
      // Only show sign-in if we don't already have one visible
      if (!document.getElementById('sign-in-container') && !document.getElementById('signInContainer')) {
        displaySignInScreen();
      }
    }, 100);
  }
  document.dispatchEvent(new CustomEvent('rejoinFailed', { detail: data }));
});

socket.on('playerReconnected', (data) => {
  console.log(`Player at position ${data.position} (${data.username}) reconnected`);
  document.dispatchEvent(new CustomEvent('playerReconnected', { detail: data }));
});

socket.on('playerAssigned', (data) => {
  console.log('📡 Received playerAssigned:', data);
  document.dispatchEvent(new CustomEvent('playerAssigned', { detail: data }));
});

socket.on('gameStart', (data) => {
  console.log('Game Started', data);
  if (data.gameId) {
    sessionStorage.setItem('gameId', data.gameId);
  }
});

socket.on('gameEnd', (data) => {
  console.log('Game ended:', data);
  sessionStorage.removeItem('gameId');
  // Reset rejoin flags so future rejoins work
  rejoinAttempted = false;
  rejoinSucceeded = false;
});

// ==================== END RECONNECTION LOGIC ====================

// Also create a socketManager shim for legacy compatibility
window.socketManager = {
  setGameId: (id) => {
    sessionStorage.setItem('gameId', id);
  },
  clearGameId: () => {
    sessionStorage.removeItem('gameId');
  },
  getGameId: () => sessionStorage.getItem('gameId'),
  getUsername: () => sessionStorage.getItem('username'),
  showErrorToast: (message, duration) => {
    const existing = document.querySelector('.error-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, duration || 5000);
  },
};

/**
 * Show error toast notification (same as legacy socketManager.js).
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

  // Handle race condition where joinMainRoom is called before user is registered
  if (error.message === 'User not registered yet') {
    // Don't retry if we're in a game (have a gameId)
    if (sessionStorage.getItem('gameId')) {
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
      displaySignInScreen();
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
    default:
      message = 'Server error. Please try again.';
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

  // Initialize UI manager
  const uiManager = initializeUIManager(socket);

  // Get game state singleton
  const gameState = getGameState();

  // Set up error handler
  socket.on('error', (error) => {
    console.error('Server error:', error);
    handleSocketError(error, socket);
  });

  // Register all handlers with UI callbacks
  registerAllHandlers(socketMgr, {
    // Auth callbacks
    onSignInSuccess: (data) => {
      console.log('Sign in success, going to main room');
      gameState.username = data.username;
      uiManager.setUsername(data.username);
      // Reset rejoin flags for fresh session
      rejoinAttempted = false;
      rejoinSucceeded = false;

      // Check if user has an active game to rejoin
      if (data.activeGameId) {
        console.log(`Active game found: ${data.activeGameId}, attempting to rejoin...`);
        sessionStorage.setItem('gameId', data.activeGameId);
        socket.emit('rejoinGame', { gameId: data.activeGameId, username: data.username });
      } else {
        // Go to main room
        socket.emit('joinMainRoom');
      }
    },
    onSignInError: (message) => {
      showError(message || 'Sign-in failed! Incorrect username or password.');
    },
    onSignUpSuccess: (data) => {
      if (data.autoLoggedIn) {
        // Auto-login: go straight to main room
        console.log(`Registration & auto-login successful: ${data.username}`);
        gameState.username = data.username;
        uiManager.setUsername(data.username);
        socket.emit('joinMainRoom');
      } else {
        showSuccess('Registration successful! Please sign in.');
      }
    },
    onSignUpError: (message) => {
      showError(`Registration failed: ${message}`);
    },
    onForceLogout: (data) => {
      console.warn('Force logout:', data?.reason || 'Unknown reason');
      sessionStorage.removeItem('username');
      sessionStorage.removeItem('gameId');
      gameState.reset();
      // Show sign-in screen (game.js just does cleanup)
      displaySignInScreen();
    },
    onActiveGameFound: (data) => {
      console.log('Active game found:', data.gameId);
      // The rejoin will be handled by the server's sign-in response
    },

    // Main Room callbacks
    onMainRoomJoined: (data) => {
      // Reset retry counter on success
      joinMainRoomRetries = 0;

      // Don't show main room if we're in a game or rejoin succeeded
      if (sessionStorage.getItem('gameId') || rejoinSucceeded) {
        console.log('Main room joined event ignored - in game (gameId:', sessionStorage.getItem('gameId'), 'rejoinSucceeded:', rejoinSucceeded, ')');
        return;
      }
      console.log('Joined main room, showing UI');
      // Clear modular sign-in/register screens (with dashes)
      const signInContainer = document.getElementById('sign-in-container');
      if (signInContainer) signInContainer.remove();
      const signInVignette = document.getElementById('sign-in-vignette');
      if (signInVignette) signInVignette.remove();
      const registerContainer = document.getElementById('register-container');
      if (registerContainer) registerContainer.remove();
      const registerVignette = document.getElementById('register-vignette');
      if (registerVignette) registerVignette.remove();
      // Also clear legacy screens (camelCase) just in case
      const legacySignIn = document.getElementById('signInContainer');
      if (legacySignIn) legacySignIn.remove();
      const legacySignInVignette = document.getElementById('SignInVignette');
      if (legacySignInVignette) legacySignInVignette.remove();

      showMainRoom(data, socket);
    },
    onMainRoomMessage: (data) => {
      addMainRoomChatMessage(data.username, data.message);
    },
    onLobbiesUpdated: (data) => {
      updateLobbyList(data.lobbies, socket);
    },
    onMainRoomPlayerJoined: (data) => {
      updateMainRoomOnlineCount(data.onlineCount);
    },

    // Lobby callbacks
    onLobbyCreated: (data) => {
      // Don't show lobby if we're in a game (e.g., during rejoin)
      if (sessionStorage.getItem('gameId')) {
        console.log('Lobby created event ignored - in game');
        return;
      }
      console.log('Lobby created, showing lobby UI');
      removeMainRoom();
      showGameLobby(
        { lobbyId: data.lobbyId, players: data.players, messages: data.messages || [] },
        socket,
        gameState.username
      );
    },
    onLobbyJoined: (data) => {
      // Don't show lobby if we're in a game (e.g., during rejoin)
      if (sessionStorage.getItem('gameId')) {
        console.log('Lobby joined event ignored - in game');
        return;
      }
      console.log('Joined lobby, showing lobby UI');
      removeMainRoom();
      showGameLobby(
        { lobbyId: data.lobbyId, players: data.players, messages: data.messages || [] },
        socket,
        gameState.username
      );
    },
    onPlayerReadyUpdate: (data) => {
      updateLobbyPlayersList(null, data.players, gameState.username);
    },
    onLobbyMessage: (data) => {
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
      removeGameLobby();
      socket.emit('joinMainRoom');
    },
    onAllPlayersReady: (data) => {
      console.log('All players ready, game starting soon...');
      // The game will start via positionUpdate/gameStart events
    },

    // Game callbacks - gradually migrating from game.js
    // Position and game setup - update GameState and call legacy processing
    onPositionUpdate: (data) => {
      console.log('📍 onPositionUpdate callback');
      // Update modular GameState with player data
      gameState.setPlayerData(data);
      // Call legacy processing for rendering
      if (window.processPositionUpdateFromLegacy) {
        window.processPositionUpdateFromLegacy(data);
      }
    },
    onGameStart: (data) => {
      console.log('🎮 onGameStart callback');
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
      // Call legacy processing for rendering
      if (window.processGameStartFromLegacy) {
        window.processGameStartFromLegacy(data);
      }
    },
    // Draw phase - handled by DrawManager
    onStartDraw: (data) => {
      console.log('🎴 onStartDraw callback');
      // Remove waiting screen
      uiManager.removeWaitingScreen();

      // Use DrawManager via scene handler
      const scene = getGameScene();
      if (scene && scene.handleStartDraw) {
        scene.handleStartDraw(data);
      }
    },
    onYouDrew: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleYouDrew) {
        scene.handleYouDrew(data);
      }
    },
    onPlayerDrew: (data) => {
      const scene = getGameScene();
      if (scene && scene.handlePlayerDrew) {
        scene.handlePlayerDrew(data);
      }
    },
    onTeamsAnnounced: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleTeamsAnnounced) {
        scene.handleTeamsAnnounced(data);
      }
    },
    onCreateUI: (data) => {
      console.log('🎨 onCreateUI callback');
      // Remove waiting screen and lobby/main room UI
      uiManager.removeWaitingScreen();
      removeMainRoom();
      removeGameLobby();

      // Clean up draw phase via DrawManager
      const scene = getGameScene();
      if (scene && scene.handleCreateUI) {
        scene.handleCreateUI(data);
      }

      // Create game feed (via legacy function)
      if (window.createGameFeedFromLegacy) {
        window.createGameFeedFromLegacy(false);
      }

      // Initialize scene handElements if needed
      if (scene && !scene.handElements) {
        scene.handElements = [];
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
    },
    onGameEnd: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleGameEnd) {
        scene.handleGameEnd(data);
      }
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
      const scene = getGameScene();
      if (scene && scene.handleAbortGame) {
        scene.handleAbortGame(data);
      }
    },
    onRoomFull: (data) => {
      console.log('Room full:', data);
      uiManager.removeWaitingScreen();
    },
    // Reconnection handlers
    onPlayerDisconnected: (data) => {
      const scene = getGameScene();
      if (scene && scene.handlePlayerDisconnected) {
        scene.handlePlayerDisconnected(data);
      }
    },
    onPlayerReconnected: (data) => {
      const scene = getGameScene();
      if (scene && scene.handlePlayerReconnected) {
        scene.handlePlayerReconnected(data);
      }
    },
    onRejoinSuccess: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleRejoinSuccess) {
        scene.handleRejoinSuccess(data);
      }
    },
    onRejoinFailed: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleRejoinFailed) {
        scene.handleRejoinFailed(data);
      }
    },

    // Chat callback - still handled by game.js
    onChatMessage: null,
  });

  // Note: window.socket and window.socketManager are already set at module level above

  console.log('App initialization complete');
}

/**
 * Show the sign-in screen with proper callbacks.
 */
function displaySignInScreen() {
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

/**
 * Handle window load - show sign-in or attempt rejoin.
 */
window.addEventListener('load', () => {
  // Initialize the app
  initializeApp();

  // Check if user is logged in and was in a game
  const username = sessionStorage.getItem('username');
  const gameId = sessionStorage.getItem('gameId');

  console.log(`Window load: username=${username}, gameId=${gameId}`);

  if (!username) {
    // Not logged in - show sign-in screen
    console.log('No username, showing sign-in screen');
    displaySignInScreen();
  } else if (gameId) {
    // Was in a game - the module-level connect handler will attempt rejoin
    // The rejoinSuccess/rejoinFailed handlers will handle the UI
    console.log(`User ${username} has pending game ${gameId}, waiting for rejoin...`);
  } else {
    // Logged in but not in a game - go to main room
    console.log('User logged in but no game, joining main room');

    // Check if socket is already connected
    if (window.socket.connected) {
      console.log('Socket already connected, emitting joinMainRoom');
      window.socket.emit('joinMainRoom');
    } else {
      // Wait for socket to connect, then join main room
      console.log('Socket not connected, waiting for connect event');
      window.socket.once('connect', () => {
        if (!sessionStorage.getItem('gameId')) {
          console.log('Connected, emitting joinMainRoom');
          window.socket.emit('joinMainRoom');
        }
      });
    }
  }
});
