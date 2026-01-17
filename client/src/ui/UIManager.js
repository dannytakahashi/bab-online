/**
 * UI Manager
 *
 * Manages screen lifecycle, transitions, and cleanup.
 * Acts as the central orchestrator for UI state.
 */

import { showSignInScreen } from './screens/SignIn.js';
import { showRegisterScreen } from './screens/Register.js';
import { showMainRoom, removeMainRoom } from './screens/MainRoom.js';
import { showGameLobby, removeGameLobby } from './screens/GameLobby.js';
import { removePlayerQueue } from './components/PlayerQueue.js';

/**
 * Available screen types.
 */
export const SCREENS = {
  NONE: 'none',
  SIGN_IN: 'signIn',
  REGISTER: 'register',
  MAIN_ROOM: 'mainRoom',
  GAME_LOBBY: 'gameLobby',
  GAME: 'game',
};

/**
 * UIManager singleton class.
 */
class UIManager {
  constructor() {
    this._currentScreen = SCREENS.NONE;
    this._socket = null;
    this._username = null;

    // Screen cleanup functions
    this._cleanupFunctions = {
      [SCREENS.SIGN_IN]: this._cleanupSignIn.bind(this),
      [SCREENS.REGISTER]: this._cleanupRegister.bind(this),
      [SCREENS.MAIN_ROOM]: this._cleanupMainRoom.bind(this),
      [SCREENS.GAME_LOBBY]: this._cleanupGameLobby.bind(this),
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
    this._username = username;
  }

  /**
   * Set the current username.
   *
   * @param {string} username - The username
   */
  setUsername(username) {
    this._username = username;
  }

  /**
   * Get the current screen.
   *
   * @returns {string} Current screen name
   */
  getCurrentScreen() {
    return this._currentScreen;
  }

  /**
   * Show a screen, cleaning up the previous one.
   *
   * @param {string} screenName - Name of screen to show
   * @param {Object} data - Optional data for the screen
   */
  showScreen(screenName, data = {}) {
    console.log(`UIManager: Transitioning from ${this._currentScreen} to ${screenName}`);

    // Clean up current screen
    if (this._currentScreen !== SCREENS.NONE) {
      this._cleanupScreen(this._currentScreen);
    }

    // Show new screen
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
      case SCREENS.GAME:
        this._showGame(data);
        break;
      default:
        console.warn(`UIManager: Unknown screen: ${screenName}`);
        return;
    }

    this._currentScreen = screenName;
  }

  /**
   * Clean up the current screen.
   */
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
    showMainRoom(data, this._socket);
  }

  _showGameLobby(data) {
    if (!this._socket) {
      console.warn('UIManager: Socket not initialized');
      return;
    }
    showGameLobby(data, this._socket, this._username);
  }

  _showGame(data) {
    // Game screen is managed by Phaser, just clean up other UI
    this._cleanupAllOverlays();
  }

  // ============================================
  // Screen Cleanup Methods
  // ============================================

  _cleanupSignIn() {
    const signInContainer = document.getElementById('signInContainer');
    if (signInContainer) signInContainer.remove();

    const signInVignette = document.getElementById('SignInVignette');
    if (signInVignette) signInVignette.remove();
  }

  _cleanupRegister() {
    const registerContainer = document.getElementById('registerContainer');
    if (registerContainer) registerContainer.remove();

    const registerVignette = document.getElementById('RegisterVignette');
    if (registerVignette) registerVignette.remove();
  }

  _cleanupMainRoom() {
    removeMainRoom();
  }

  _cleanupGameLobby() {
    removeGameLobby();
  }

  _cleanupGame() {
    // Remove game-specific UI elements
    const gameFeed = document.getElementById('gameFeed');
    if (gameFeed) gameFeed.remove();

    const gameChatContainer = document.getElementById('gameChatContainer');
    if (gameChatContainer) gameChatContainer.remove();

    // Remove width restriction from game container
    const gameContainer = document.getElementById('game-container');
    if (gameContainer) {
      gameContainer.classList.remove('in-game');
    }
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
    removePlayerQueue();

    // Remove vignettes
    document.querySelectorAll('.vignette').forEach((el) => el.remove());
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
    return this._currentScreen === screenName;
  }

  /**
   * Reset the UIManager state.
   */
  reset() {
    this._cleanupAllOverlays();
    this._currentScreen = SCREENS.NONE;
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
