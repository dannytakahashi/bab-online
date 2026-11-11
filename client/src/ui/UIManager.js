/**
 * UI Manager
 *
 * Renders and removes the DOM screens. Which screen is current is the
 * client session's (state/ClientSession.js): showScreen() goes through its
 * FSM, whose enter/exit hooks call renderScreen()/cleanupScreen() here, and
 * getCurrentScreen()/isScreen() read it. The username is the session
 * identity in GameState (one source, also read by voice and the lobbies).
 */

import { showSignInScreen } from './screens/SignIn.js';
import { showRegisterScreen } from './screens/Register.js';
import { showMainRoom, removeMainRoom } from './screens/MainRoom.js';
import { showGameLobby, removeGameLobby } from './screens/GameLobby.js';
import { showTournamentLobby, removeTournamentLobby } from './screens/TournamentLobby.js';
import { removePlayerQueue } from './components/PlayerQueue.js';
import { removeFinalScoreOverlay } from './components/ScoreModal.js';
import { removeTournamentResultsOverlay } from './components/TournamentScoreboard.js';
import { getClientSession, SCREEN } from '../state/ClientSession.js';
import { getGameState } from '../state/GameState.js';
import { setTableChrome } from './tableHud.js';

/**
 * Available screen types.
 */
export const SCREENS = {
  NONE: 'none',
  SIGN_IN: 'signIn',
  REGISTER: 'register',
  MAIN_ROOM: 'mainRoom',
  GAME_LOBBY: 'gameLobby',
  TOURNAMENT_LOBBY: 'tournamentLobby',
  GAME: 'game',
};

// UIManager screen -> client session screen (REGISTER is a view of SIGN_IN)
const TO_SESSION = {
  [SCREENS.NONE]: SCREEN.BOOT,
  [SCREENS.SIGN_IN]: SCREEN.SIGN_IN,
  [SCREENS.REGISTER]: SCREEN.SIGN_IN,
  [SCREENS.MAIN_ROOM]: SCREEN.MAIN_ROOM,
  [SCREENS.GAME_LOBBY]: SCREEN.LOBBY,
  [SCREENS.TOURNAMENT_LOBBY]: SCREEN.TOURNAMENT_LOBBY,
  [SCREENS.GAME]: SCREEN.TABLE,
};
const FROM_SESSION = {
  [SCREEN.BOOT]: SCREENS.NONE,
  [SCREEN.SIGN_IN]: SCREENS.SIGN_IN,
  [SCREEN.MAIN_ROOM]: SCREENS.MAIN_ROOM,
  [SCREEN.LOBBY]: SCREENS.GAME_LOBBY,
  [SCREEN.TOURNAMENT_LOBBY]: SCREENS.TOURNAMENT_LOBBY,
  [SCREEN.TABLE]: SCREENS.GAME,
  [SCREEN.GAME_END]: SCREENS.GAME,
};

/** The UIManager name of a client session screen. */
export function uiScreenFor(sessionScreen) {
  return FROM_SESSION[sessionScreen] || SCREENS.NONE;
}

/** The client session screen of a UIManager name. */
export function sessionScreenFor(uiScreen) {
  return TO_SESSION[uiScreen] || null;
}

/**
 * UIManager singleton class.
 */
class UIManager {
  constructor() {
    this._socket = null;

    // Screen cleanup functions
    this._cleanupFunctions = {
      [SCREENS.SIGN_IN]: this._cleanupSignIn.bind(this),
      [SCREENS.REGISTER]: this._cleanupRegister.bind(this),
      [SCREENS.MAIN_ROOM]: this._cleanupMainRoom.bind(this),
      [SCREENS.GAME_LOBBY]: this._cleanupGameLobby.bind(this),
      [SCREENS.TOURNAMENT_LOBBY]: this._cleanupTournamentLobby.bind(this),
      [SCREENS.GAME]: this._cleanupGame.bind(this),
    };
  }

  /**
   * Initialize the UIManager with dependencies.
   *
   * @param {Object} socket - Socket instance
   * @param {string} username - Current user's username
   */
  initialize(socket, username = null) {
    this._socket = socket;
    if (username) this.setUsername(username);
  }

  /**
   * The signed-in username: the session identity in GameState.
   */
  get _username() {
    return getGameState().username;
  }

  /**
   * Set the current username (the session identity).
   *
   * @param {string} username - The username
   */
  setUsername(username) {
    getGameState().username = username;
  }

  /**
   * The current screen, from the client session.
   *
   * @returns {string} Current screen name (SCREENS)
   */
  getCurrentScreen() {
    return uiScreenFor(getClientSession().screen);
  }

  get _currentScreen() {
    return this.getCurrentScreen();
  }

  /**
   * Show a screen: a client session transition (its hooks clean up the
   * previous screen and render this one through renderScreen).
   *
   * @param {string} screenName - Name of screen to show
   * @param {Object} data - Optional data for the screen
   * @returns {boolean} whether the transition was legal
   */
  showScreen(screenName, data = {}) {
    const target = sessionScreenFor(screenName);
    if (!target) {
      console.warn(`UIManager: Unknown screen: ${screenName}`);
      return false;
    }
    return getClientSession().transition(target, data);
  }

  /**
   * Render a screen's DOM (called from the client session's enter hooks).
   *
   * @param {string} screenName - SCREENS
   * @param {Object} data - Optional data for the screen
   */
  renderScreen(screenName, data = {}) {
    switch (screenName) {
      case SCREENS.SIGN_IN:
        this._showSignIn();
        break;
      case SCREENS.REGISTER:
        this._showRegister();
        break;
      case SCREENS.MAIN_ROOM:
        this._showMainRoom(data);
        break;
      case SCREENS.GAME_LOBBY:
        this._showGameLobby(data);
        break;
      case SCREENS.TOURNAMENT_LOBBY:
        this._showTournamentLobby(data);
        break;
      case SCREENS.GAME:
        this._showGame(data);
        break;
      default:
        console.warn(`UIManager: Unknown screen: ${screenName}`);
        break;
    }
  }

  /**
   * Remove a screen's DOM (called from the client session's exit hooks).
   */
  cleanupScreen(screenName) {
    this._cleanupScreen(screenName);
  }

  _cleanupScreen(screenName) {
    const cleanup = this._cleanupFunctions[screenName];
    if (cleanup) {
      cleanup();
    }
  }

  // ============================================
  // Screen Show Methods
  // ============================================

  _showSignIn() {
    showSignInScreen();
  }

  _showRegister() {
    showRegisterScreen();
  }

  _showMainRoom(data) {
    if (!this._socket) {
      console.warn('UIManager: Socket not initialized');
      return;
    }
    showMainRoom(data, this._socket, this._username);
  }

  _showGameLobby(data) {
    if (!this._socket) {
      console.warn('UIManager: Socket not initialized');
      return;
    }
    showGameLobby(data, this._socket, this._username);
  }

  _showTournamentLobby(data) {
    if (!this._socket) {
      console.warn('UIManager: Socket not initialized');
      return;
    }
    showTournamentLobby(data, this._socket, this._username);
  }

  _showGame(data) {
    // Game screen is managed by Phaser, just clean up other UI
    this._cleanupAllOverlays();
  }

  // ============================================
  // Screen Cleanup Methods
  // ============================================

  _cleanupSignIn() {
    // Legacy IDs (camelCase)
    const signInContainer = document.getElementById('signInContainer');
    if (signInContainer) signInContainer.remove();
    const signInVignette = document.getElementById('SignInVignette');
    if (signInVignette) signInVignette.remove();
    // Current IDs (kebab-case)
    const signInContainerNew = document.getElementById('sign-in-container');
    if (signInContainerNew) signInContainerNew.remove();
    const signInVignetteNew = document.getElementById('sign-in-vignette');
    if (signInVignetteNew) signInVignetteNew.remove();
  }

  _cleanupRegister() {
    // Legacy IDs (camelCase)
    const registerContainer = document.getElementById('registerContainer');
    if (registerContainer) registerContainer.remove();
    const registerVignette = document.getElementById('RegisterVignette');
    if (registerVignette) registerVignette.remove();
    // Current IDs (kebab-case)
    const registerContainerNew = document.getElementById('register-container');
    if (registerContainerNew) registerContainerNew.remove();
    const registerVignetteNew = document.getElementById('register-vignette');
    if (registerVignetteNew) registerVignetteNew.remove();
  }

  _cleanupMainRoom() {
    removeMainRoom();
  }

  _cleanupGameLobby() {
    removeGameLobby();
  }

  _cleanupTournamentLobby() {
    removeTournamentLobby();
  }

  _cleanupGame() {
    // Remove game-specific UI elements
    const gameFeed = document.getElementById('gameFeed');
    if (gameFeed) gameFeed.remove();

    const gameChatContainer = document.getElementById('gameChatContainer');
    if (gameChatContainer) gameChatContainer.remove();

    // The log's grid column goes (the canvas takes the width again)
    setTableChrome(false);
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Clean up all overlays without changing screen state.
   */
  _cleanupAllOverlays() {
    removeMainRoom();
    removeGameLobby();
    removeTournamentLobby();
    removePlayerQueue();
    removeFinalScoreOverlay();
    removeTournamentResultsOverlay();

    // Remove vignettes
    document.querySelectorAll('.vignette').forEach((el) => el.remove());
  }

  /**
   * Remove waiting screen elements.
   * This cleans up all pre-game UI to prepare for game start.
   */
  removeWaitingScreen() {
    // Remove waiting container
    const waitingContainer = document.getElementById('waitingContainer');
    if (waitingContainer) waitingContainer.remove();

    // Remove waiting vignette
    const waitingVignette = document.getElementById('waitingVignette');
    if (waitingVignette) waitingVignette.remove();

    // Remove lobby container
    const lobbyContainer = document.getElementById('lobbyContainer');
    if (lobbyContainer) lobbyContainer.remove();

    // Remove all vignettes
    this.removeAllVignettes();

    // Clear UI elements
    this.clearUI();

    // Remove player queue
    removePlayerQueue();

    // Remove game lobby
    removeGameLobby();

    console.log('UIManager: Waiting screen removed, game starting...');
  }

  /**
   * Clean up all pre-game UI when entering a game.
   */
  cleanupForGame() {
    this.removeWaitingScreen();

    // Also clean up auth screens in case they're lingering
    this._cleanupSignIn();
    this._cleanupRegister();
  }

  /**
   * Clear all UI elements.
   */
  clearUI() {
    document.querySelectorAll('.ui-element').forEach((el) => el.remove());
  }

  /**
   * Clear all DOM elements (for complete reset).
   */
  clearAllDomElements() {
    const tagsToRemove = ['div', 'input', 'button', 'textarea', 'img'];

    tagsToRemove.forEach((tag) => {
      document.querySelectorAll(tag).forEach((el) => {
        // Preserve certain elements
        if (
          !el.classList.contains('phaser-vignette') &&
          el !== document.querySelector('canvas') &&
          !el.closest('#game-container')
        ) {
          el.remove();
        }
      });
    });

    console.log('UIManager: DOM elements cleared.');
  }

  /**
   * Remove all vignettes.
   */
  removeAllVignettes() {
    document.querySelectorAll('.vignette').forEach((vignette) => vignette.remove());
    console.log('UIManager: All vignettes removed.');
  }

  /**
   * Check if a screen is currently active.
   *
   * @param {string} screenName - Screen name to check
   * @returns {boolean} True if active
   */
  isScreen(screenName) {
    return this.getCurrentScreen() === screenName;
  }

  /**
   * Remove every screen overlay (the screen itself is the session's).
   */
  reset() {
    this._cleanupAllOverlays();
  }
}

// ============================================
// Singleton Instance
// ============================================

let instance = null;

/**
 * Get the UIManager singleton instance.
 *
 * @returns {UIManager} The singleton instance
 */
export function getUIManager() {
  if (!instance) {
    instance = new UIManager();
  }
  return instance;
}

/**
 * Initialize the UIManager with dependencies.
 *
 * @param {Object} socket - Socket instance
 * @param {string} username - Current user's username
 * @returns {UIManager} The initialized instance
 */
export function initializeUIManager(socket, username = null) {
  const manager = getUIManager();
  manager.initialize(socket, username);
  return manager;
}

/**
 * Reset the UIManager singleton.
 */
export function resetUIManager() {
  if (instance) {
    instance.reset();
  }
  instance = null;
}

// Export the class for type checking
export { UIManager };
