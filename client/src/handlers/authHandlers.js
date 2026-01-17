/**
 * Authentication-related socket event handlers.
 *
 * Handles: signInResponse, signUpResponse, forceLogout, activeGameFound
 */

import { SERVER_EVENTS } from '../constants/events.js';
import { getGameState } from '../state/GameState.js';

/**
 * Register authentication handlers.
 *
 * @param {SocketManager} socketManager - Socket manager instance
 * @param {Object} callbacks - UI callbacks
 * @param {Function} callbacks.onSignInSuccess - Called on successful sign in
 * @param {Function} callbacks.onSignInError - Called on sign in error
 * @param {Function} callbacks.onSignUpSuccess - Called on successful sign up
 * @param {Function} callbacks.onSignUpError - Called on sign up error
 * @param {Function} callbacks.onForceLogout - Called when force logged out
 * @param {Function} callbacks.onActiveGameFound - Called when user has active game
 */
export function registerAuthHandlers(socketManager, callbacks = {}) {
  const {
    onSignInSuccess,
    onSignInError,
    onSignUpSuccess,
    onSignUpError,
    onForceLogout,
    onActiveGameFound,
  } = callbacks;

  const state = getGameState();

  // Sign in response
  socketManager.on(SERVER_EVENTS.SIGN_IN_RESPONSE, (data) => {
    if (data.success) {
      // Store in sessionStorage for reconnection
      sessionStorage.setItem('username', data.username);

      // Update state
      state.username = data.username;
      state.playerId = socketManager.getId();

      console.log(`✅ Signed in as: ${data.username}`);
      onSignInSuccess?.(data);
    } else {
      console.warn('❌ Sign in failed:', data.message);
      onSignInError?.(data.message || 'Sign in failed');
    }
  });

  // Sign up response
  socketManager.on(SERVER_EVENTS.SIGN_UP_RESPONSE, (data) => {
    if (data.success) {
      // Store in sessionStorage
      sessionStorage.setItem('username', data.username);

      // Update state
      state.username = data.username;

      console.log(`✅ Registered as: ${data.username}`);
      onSignUpSuccess?.(data);
    } else {
      console.warn('❌ Registration failed:', data.message);
      onSignUpError?.(data.message || 'Registration failed');
    }
  });

  // Force logout (another session signed in)
  socketManager.on(SERVER_EVENTS.FORCE_LOGOUT, (data) => {
    console.warn('⚠️ Force logout:', data.reason);

    // Clear stored credentials
    sessionStorage.removeItem('username');
    sessionStorage.removeItem('gameId');

    // Reset state
    state.reset();

    onForceLogout?.(data);
  });

  // Active game found (user has a game in progress)
  socketManager.on(SERVER_EVENTS.ACTIVE_GAME_FOUND, (data) => {
    console.log('🎮 Active game found:', data.gameId);
    onActiveGameFound?.(data);
  });
}
